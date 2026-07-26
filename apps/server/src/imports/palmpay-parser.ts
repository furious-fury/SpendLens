import { normalizeSourceTimestamp, parseMoneyToMinorUnits } from "@spendlens/db";
import {
  type BankStatementParser,
  type NormalizedBankStatement,
  type NormalizedStatementTransaction,
  type PositionedPdfDocument,
  type PositionedPdfPage,
  type PositionedText,
  StatementParserError,
} from "./parser-types.js";

const DATE_TIME_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2}) (AM|PM)$/;
const PERIOD_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2})\/(\d{2})\/(\d{4})$/;
const SOURCE_TIMEZONE = "Africa/Lagos";

export class PalmPayStatementParser implements BankStatementParser {
  readonly key = "palmpay-ng-pdf";
  readonly version = "1.0.0";

  detect(document: PositionedPdfDocument): number {
    const text = document.pages
      .slice(0, 2)
      .flatMap((page) => page.items.map((item) => item.text))
      .join("\n");
    const signals = [
      /Account Statement/i.test(text),
      /Transaction Date/i.test(text),
      /Money In \(NGN\)/i.test(text),
      /Money Out \(NGN\)/i.test(text),
      /Transaction ID/i.test(text),
      /palmpay\.com/i.test(text),
    ];
    return signals.filter(Boolean).length / signals.length;
  }

  parse(document: PositionedPdfDocument): NormalizedBankStatement {
    const firstPage = document.pages[0];
    if (!firstPage) {
      throw new StatementParserError("PALMPAY_HEADER_INVALID", "The statement has no pages.");
    }

    const declaredInflowMinor = headerMoney(firstPage, "Total Money In");
    const declaredOutflowMinor = headerMoney(firstPage, "Total Money Out");
    const period = headerValue(firstPage, "Statement Period");
    const periodMatch = PERIOD_PATTERN.exec(period);
    if (!periodMatch) {
      throw new StatementParserError(
        "PALMPAY_HEADER_INVALID",
        "The PalmPay statement period could not be read.",
      );
    }
    const [
      ,
      startMonth = "",
      startDay = "",
      startYear = "",
      endMonth = "",
      endDay = "",
      endYear = "",
    ] = periodMatch;
    const statementStart = isoDate(startYear, startMonth, startDay);
    const statementEnd = isoDate(endYear, endMonth, endDay);
    const accountNumber = optionalHeaderValue(firstPage, "Account Number");

    const transactions = document.pages.flatMap((page) => parsePageRows(page));
    if (transactions.length === 0) {
      throw new StatementParserError(
        "PALMPAY_ROW_INVALID",
        "No PalmPay transaction rows were found.",
      );
    }
    const ids = new Set<string>();
    for (const transaction of transactions) {
      if (ids.has(transaction.sourceTransactionId)) {
        throw new StatementParserError(
          "PALMPAY_DUPLICATE_TRANSACTION_ID",
          "The statement contains a repeated PalmPay transaction ID.",
        );
      }
      ids.add(transaction.sourceTransactionId);
    }

    const parsedInflowMinor = sumDirection(transactions, "credit");
    const parsedOutflowMinor = sumDirection(transactions, "debit");
    const reconciliationStatus =
      parsedInflowMinor === declaredInflowMinor && parsedOutflowMinor === declaredOutflowMinor
        ? "matched"
        : "mismatched";

    return {
      institutionName: "PalmPay",
      maskedAccountNumber: accountNumber ? maskAccountNumber(accountNumber) : null,
      statementStart,
      statementEnd,
      sourceTimezone: SOURCE_TIMEZONE,
      declaredInflowMinor,
      declaredOutflowMinor,
      transactions: transactions.map((transaction, sourceRowIndex) => ({
        ...transaction,
        sourceRowIndex,
      })),
      reconciliation: {
        status: reconciliationStatus,
        declaredInflowMinor,
        declaredOutflowMinor,
        parsedInflowMinor,
        parsedOutflowMinor,
        currency: "NGN",
      },
    };
  }
}

function parsePageRows(
  page: PositionedPdfPage,
): Omit<NormalizedStatementTransaction, "sourceRowIndex">[] {
  const anchors = page.items
    .filter((item) => item.x < 125 && DATE_TIME_PATTERN.test(item.text.trim()))
    .sort((left, right) => right.y - left.y);

  return anchors.map((anchor, index) => {
    const upper =
      index === 0
        ? anchor.y + Math.max(20, (anchor.y - (anchors[index + 1]?.y ?? anchor.y - 40)) / 2)
        : ((anchors[index - 1]?.y ?? anchor.y + 40) + anchor.y) / 2;
    const lower =
      index === anchors.length - 1
        ? anchor.y - Math.max(20, ((anchors[index - 1]?.y ?? anchor.y + 40) - anchor.y) / 2)
        : (anchor.y + (anchors[index + 1]?.y ?? anchor.y - 40)) / 2;
    const rowItems = page.items.filter((item) => item.y <= upper && item.y > lower);
    const narration = joinColumn(rowItems, 125, 245, " ");
    const inflow = joinColumn(rowItems, 245, 360, "");
    const outflow = joinColumn(rowItems, 360, 460, "");
    const sourceTransactionId = joinColumn(rowItems, 460, 585, "");

    if (!narration || !sourceTransactionId || Boolean(inflow) === Boolean(outflow)) {
      throw new StatementParserError(
        "PALMPAY_ROW_INVALID",
        `A transaction row on page ${page.pageNumber} could not be reconstructed.`,
      );
    }
    const amountText = inflow || outflow;
    const amountMinor = Math.abs(parseMoneyToMinorUnits(amountText, "NGN"));
    if (amountMinor === 0) {
      throw new StatementParserError(
        "PALMPAY_ROW_INVALID",
        `A transaction row on page ${page.pageNumber} has a zero amount.`,
      );
    }
    const sourceTimestamp = normalizePalmPayTimestamp(anchor.text.trim());
    return {
      sourceTransactionId,
      sourceTimestamp,
      occurredAtUtc: normalizeSourceTimestamp(sourceTimestamp, SOURCE_TIMEZONE),
      direction: inflow ? "credit" : "debit",
      amountMinor,
      currency: "NGN",
      narration,
      pageNumber: page.pageNumber,
    };
  });
}

function headerMoney(page: PositionedPdfPage, label: string): number {
  const value = headerValue(page, label).replace("₦", "");
  try {
    return Math.abs(parseMoneyToMinorUnits(value, "NGN"));
  } catch {
    throw new StatementParserError(
      "PALMPAY_HEADER_INVALID",
      `The PalmPay ${label.toLowerCase()} value could not be read.`,
    );
  }
}

function headerValue(page: PositionedPdfPage, label: string): string {
  const value = optionalHeaderValue(page, label);
  if (!value) {
    throw new StatementParserError(
      "PALMPAY_HEADER_INVALID",
      `The PalmPay ${label.toLowerCase()} field is missing.`,
    );
  }
  return value;
}

function optionalHeaderValue(page: PositionedPdfPage, label: string): string | null {
  const labelItem = page.items.find((item) => item.text.trim() === label);
  if (!labelItem) return null;
  const sameLine = page.items
    .filter(
      (item) =>
        item !== labelItem &&
        Math.abs(item.y - labelItem.y) <= 2 &&
        item.x > labelItem.x + labelItem.width,
    )
    .sort((left, right) => left.x - right.x)
    .map((item) => item.text.trim())
    .find(Boolean);
  return sameLine || null;
}

function joinColumn(
  items: PositionedText[],
  minimumX: number,
  maximumX: number,
  separator: string,
): string {
  return items
    .filter((item) => item.x >= minimumX && item.x < maximumX && item.text.trim())
    .sort((left, right) => {
      const lineDifference = right.y - left.y;
      return Math.abs(lineDifference) > 1 ? lineDifference : left.x - right.x;
    })
    .map((item) => item.text.trim())
    .join(separator)
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePalmPayTimestamp(value: string): string {
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) {
    throw new StatementParserError(
      "PALMPAY_ROW_INVALID",
      "A PalmPay transaction timestamp could not be read.",
    );
  }
  let hour = Number(match[4]);
  if (match[7] === "AM" && hour === 12) hour = 0;
  if (match[7] === "PM" && hour !== 12) hour += 12;
  return `${match[3]}-${match[1]}-${match[2]} ${String(hour).padStart(2, "0")}:${match[5]}:${match[6]}`;
}

function isoDate(year: string, month: string, day: string): string {
  return `${year}-${month}-${day}`;
}

function maskAccountNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "••••";
}

function sumDirection(
  transactions: readonly Omit<NormalizedStatementTransaction, "sourceRowIndex">[],
  direction: "debit" | "credit",
): number {
  return transactions
    .filter((transaction) => transaction.direction === direction)
    .reduce((total, transaction) => total + transaction.amountMinor, 0);
}

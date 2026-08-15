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

const DATE_TIME_PATTERN = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/;
const VALUE_DATE_PATTERN = /^\d{2} [A-Z][a-z]{2} \d{4}$/;
const PERIOD_PATTERN = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})\s*-\s*(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/;
const SOURCE_TIMEZONE = "Africa/Lagos";
const MONTHS: Record<string, string> = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

type ParsedTransaction = Omit<NormalizedStatementTransaction, "sourceRowIndex">;

export class OPayStatementParser implements BankStatementParser {
  readonly key = "opay-ng-pdf";
  readonly version = "1.0.0";

  detect(document: PositionedPdfDocument): number {
    const text = document.pages
      .slice(0, 2)
      .flatMap((page) => page.items.map((item) => item.text))
      .join("\n");
    const signals = [
      /OPay/i.test(text),
      /Account Statement/i.test(text),
      /Wallet Account/i.test(text),
      /Value Date/i.test(text),
      /Balance After/i.test(text),
      /Transaction Reference/i.test(text),
    ];
    return signals.filter(Boolean).length / signals.length;
  }

  parse(document: PositionedPdfDocument): NormalizedBankStatement {
    const firstPage = document.pages[0];
    if (!firstPage) throw headerError("The statement has no pages.");

    const declaredOutflowMinor = headerMoney(firstPage, "Total Debit");
    const declaredInflowMinor = headerMoney(firstPage, "Total Credit");
    const { statementStart, statementEnd } = parsePeriod(sameLineValue(firstPage, "Period:"));
    const accountNumber = belowLabelValue(firstPage, "Account Number");
    const transactions = deduplicateExactTransactions(walletTransactions(document));
    if (transactions.length === 0) {
      throw rowError("No OPay transaction rows were found.");
    }

    const parsedInflowMinor = sumDirection(transactions, "credit");
    const parsedOutflowMinor = sumDirection(transactions, "debit");
    const status =
      parsedInflowMinor === declaredInflowMinor && parsedOutflowMinor === declaredOutflowMinor
        ? "matched"
        : "mismatched";

    return {
      institutionName: "OPay",
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
        status,
        declaredInflowMinor,
        declaredOutflowMinor,
        parsedInflowMinor,
        parsedOutflowMinor,
        currency: "NGN",
      },
    };
  }
}

function walletTransactions(document: PositionedPdfDocument): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];
  for (const page of document.pages) {
    const savingsHeader = page.items.find((item) => item.text.trim() === "Savings Account");
    transactions.push(...parsePageRows(page, savingsHeader?.y));
    if (savingsHeader) break;
  }
  return transactions;
}

function parsePageRows(
  page: PositionedPdfPage,
  minimumY = Number.NEGATIVE_INFINITY,
): ParsedTransaction[] {
  const anchors = page.items
    .filter(
      (item) =>
        item.y > minimumY &&
        item.x >= 60 &&
        item.x < 125 &&
        DATE_TIME_PATTERN.test(item.text.trim()),
    )
    .sort((left, right) => right.y - left.y);

  return anchors.map((anchor) => {
    const rowItems = page.items.filter((item) => Math.abs(item.y - anchor.y) <= 15);
    const compact = rowItems.some(
      (item) => item.x >= 138 && item.x < 170 && VALUE_DATE_PATTERN.test(item.text.trim()),
    );
    const columns = compact
      ? {
          narration: [170, 250] as const,
          debit: [250, 285] as const,
          credit: [285, 330] as const,
          reference: [445, page.width] as const,
        }
      : {
          narration: [170, 290] as const,
          debit: [290, 330] as const,
          credit: [330, 370] as const,
          reference: [470, page.width] as const,
        };
    const narration = joinColumn(rowItems, columns.narration[0], columns.narration[1], " ");
    const debit = moneyCell(
      joinColumn(rowItems, columns.debit[0], columns.debit[1], ""),
      page.pageNumber,
    );
    const credit = moneyCell(
      joinColumn(rowItems, columns.credit[0], columns.credit[1], ""),
      page.pageNumber,
    );
    const sourceTransactionId = joinColumn(
      rowItems,
      columns.reference[0],
      columns.reference[1],
      "",
    ).replace(/\s+/g, "");

    if (!narration || !sourceTransactionId || (debit === null) === (credit === null)) {
      throw rowError(`A transaction row on page ${page.pageNumber} could not be reconstructed.`);
    }
    const sourceTimestamp = normalizeOPayTimestamp(anchor.text.trim());
    return {
      sourceTransactionId,
      sourceTimestamp,
      occurredAtUtc: normalizeSourceTimestamp(sourceTimestamp, SOURCE_TIMEZONE),
      direction: debit !== null ? "debit" : "credit",
      amountMinor: debit ?? credit ?? 0,
      currency: "NGN",
      narration,
      pageNumber: page.pageNumber,
    };
  });
}

function moneyCell(value: string, pageNumber: number): number | null {
  const normalized = value.trim();
  if (!normalized || /^-+$/.test(normalized)) return null;
  try {
    const amount = Math.abs(parseMoneyToMinorUnits(normalized.replace(/[^\d.,+-]/g, ""), "NGN"));
    if (amount === 0) throw new Error("zero amount");
    return amount;
  } catch {
    throw rowError(`A transaction amount on page ${pageNumber} could not be read.`);
  }
}

function parsePeriod(value: string): { statementStart: string; statementEnd: string } {
  const match = PERIOD_PATTERN.exec(value);
  if (!match) throw headerError("The OPay statement period could not be read.");
  const startMonth = monthNumber(match[2] ?? "");
  const endMonth = monthNumber(match[5] ?? "");
  return {
    statementStart: `${match[3]}-${startMonth}-${match[1]}`,
    statementEnd: `${match[6]}-${endMonth}-${match[4]}`,
  };
}

function normalizeOPayTimestamp(value: string): string {
  const match = DATE_TIME_PATTERN.exec(value);
  if (!match) throw rowError("An OPay transaction timestamp could not be read.");
  return `${match[3]}-${monthNumber(match[2] ?? "")}-${match[1]} ${match[4]}:${match[5]}:${match[6]}`;
}

function monthNumber(value: string): string {
  const month = MONTHS[value];
  if (!month) throw headerError("An OPay statement month could not be read.");
  return month;
}

function headerMoney(page: PositionedPdfPage, label: string): number {
  const value = belowLabelValue(page, label);
  try {
    return Math.abs(parseMoneyToMinorUnits(value.replace(/[^\d.,+-]/g, ""), "NGN"));
  } catch {
    throw headerError(`The OPay ${label.toLowerCase()} value could not be read.`);
  }
}

function belowLabelValue(page: PositionedPdfPage, label: string): string {
  const labelItem = page.items.find((item) => item.text.trim() === label);
  if (!labelItem) throw headerError(`The OPay ${label.toLowerCase()} field is missing.`);
  const candidates = page.items
    .filter(
      (item) =>
        item !== labelItem &&
        item.y < labelItem.y &&
        labelItem.y - item.y <= 18 &&
        item.x >= labelItem.x - 4 &&
        item.x < labelItem.x + 125,
    )
    .sort((left, right) => right.y - left.y || left.x - right.x);
  const valueLineY = candidates[0]?.y;
  const value = candidates
    .filter((item) => valueLineY !== undefined && Math.abs(item.y - valueLineY) <= 2)
    .sort((left, right) => left.x - right.x)
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("");
  if (!value) throw headerError(`The OPay ${label.toLowerCase()} value is missing.`);
  return value;
}

function sameLineValue(page: PositionedPdfPage, label: string): string {
  const labelItem = page.items.find(
    (item) => item.text.trim() === label || item.text.trim().startsWith(`${label} `),
  );
  if (!labelItem) throw headerError(`The OPay ${label.toLowerCase()} field is missing.`);
  const inlineValue = labelItem.text.trim().slice(label.length).trim();
  if (inlineValue) return inlineValue;
  const value = page.items
    .filter(
      (item) =>
        item !== labelItem &&
        Math.abs(item.y - labelItem.y) <= 2 &&
        item.x > labelItem.x + labelItem.width,
    )
    .sort((left, right) => left.x - right.x)
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join(" ");
  if (!value) throw headerError(`The OPay ${label.toLowerCase()} value is missing.`);
  return value;
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

function deduplicateExactTransactions(transactions: ParsedTransaction[]): ParsedTransaction[] {
  const seen = new Set<string>();
  return transactions.filter((transaction) => {
    const identity = JSON.stringify([
      transaction.sourceTransactionId,
      transaction.sourceTimestamp,
      transaction.direction,
      transaction.amountMinor,
      transaction.currency,
      transaction.narration,
    ]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function maskAccountNumber(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "••••";
}

function sumDirection(
  transactions: readonly ParsedTransaction[],
  direction: "debit" | "credit",
): number {
  return transactions
    .filter((transaction) => transaction.direction === direction)
    .reduce((total, transaction) => total + transaction.amountMinor, 0);
}

function headerError(message: string): StatementParserError {
  return new StatementParserError("OPAY_HEADER_INVALID", message);
}

function rowError(message: string): StatementParserError {
  return new StatementParserError("OPAY_ROW_INVALID", message);
}

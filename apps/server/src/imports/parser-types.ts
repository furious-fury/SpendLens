export interface PositionedText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PositionedPdfPage {
  pageNumber: number;
  width: number;
  height: number;
  items: PositionedText[];
}

export interface PositionedPdfDocument {
  pageCount: number;
  pages: PositionedPdfPage[];
}

export interface NormalizedStatementTransaction {
  sourceRowIndex: number;
  sourceTransactionId: string;
  sourceTimestamp: string;
  occurredAtUtc: Date;
  direction: "debit" | "credit";
  amountMinor: number;
  currency: "NGN";
  narration: string;
  pageNumber: number;
}

export interface StatementReconciliation {
  status: "matched" | "mismatched";
  declaredInflowMinor: number;
  declaredOutflowMinor: number;
  parsedInflowMinor: number;
  parsedOutflowMinor: number;
  currency: "NGN";
}

export interface NormalizedBankStatement {
  institutionName: string;
  maskedAccountNumber: string | null;
  statementStart: string;
  statementEnd: string;
  sourceTimezone: string;
  declaredInflowMinor: number;
  declaredOutflowMinor: number;
  transactions: NormalizedStatementTransaction[];
  reconciliation: StatementReconciliation;
}

export interface BankStatementParser {
  readonly key: string;
  readonly version: string;
  detect(document: PositionedPdfDocument): number;
  parse(document: PositionedPdfDocument): NormalizedBankStatement;
}

export class StatementParserError extends Error {
  constructor(
    readonly code:
      | "PDF_INVALID_SIGNATURE"
      | "PDF_TOO_LARGE"
      | "PDF_TOO_MANY_PAGES"
      | "PDF_ENCRYPTED"
      | "PDF_MALFORMED"
      | "PDF_SCANNED"
      | "PARSER_UNSUPPORTED"
      | "PALMPAY_HEADER_INVALID"
      | "PALMPAY_ROW_INVALID"
      | "PALMPAY_DUPLICATE_TRANSACTION_ID",
    message: string,
  ) {
    super(message);
    this.name = "StatementParserError";
  }
}

export function selectParser(
  document: PositionedPdfDocument,
  parsers: readonly BankStatementParser[],
): BankStatementParser {
  const detected = parsers
    .map((parser) => ({ parser, confidence: parser.detect(document) }))
    .sort((left, right) => right.confidence - left.confidence)[0];
  if (!detected || detected.confidence < 0.8) {
    const textItemCount = document.pages.reduce((count, page) => count + page.items.length, 0);
    throw new StatementParserError(
      textItemCount < 10 ? "PDF_SCANNED" : "PARSER_UNSUPPORTED",
      textItemCount < 10
        ? "This PDF appears to be scanned. Upload a searchable bank statement."
        : "SpendLens does not support this bank statement format yet.",
    );
  }
  return detected.parser;
}

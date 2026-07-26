import type { AiPayloadPolicy, AiPayloadPreview, Transaction } from "@spendlens/contracts";
import type { TransactionRecord } from "@spendlens/db";

export const AI_PROMPT_VERSION = "spendlens-classification-v1";

export interface AiTransactionPayload {
  transactionKey: string;
  data: Record<string, unknown>;
}

export interface LocalParsedSourceContext {
  sourceRowIndex: number;
  sourceTransactionId: string | null;
  sourceReference: string | null;
  sourceTimestamp: string;
  sourceTimezone: string;
  direction: "debit" | "credit";
  amountMinor: number;
  currency: string;
  balanceAfterMinor: number | null;
  rawNarration: string | null;
  senderOrRecipientName: string | null;
  institutionName: string | null;
  maskedAccountNumber: string | null;
  rawFields: Record<string, unknown>;
}

const REMOTE_OMITTED_FIELDS = [
  "account identifiers and display names",
  "transaction and source references",
  "balances",
  "user notes",
  "raw import identifiers",
];

export function buildAiTransactionPayload(
  transaction: Transaction | TransactionRecord,
  policy: AiPayloadPolicy,
  ordinal = 1,
  localParsedSources: LocalParsedSourceContext[] = [],
): AiTransactionPayload {
  const occurredAt =
    transaction.occurredAt instanceof Date
      ? transaction.occurredAt.toISOString()
      : transaction.occurredAt;
  if (policy === "local_full") {
    return {
      transactionKey: transaction.id,
      data: {
        transactionId: transaction.id,
        occurredAt,
        sourceTimestamp: transaction.sourceTimestamp,
        sourceTimezone: transaction.sourceTimezone,
        account: transaction.account,
        direction: transaction.direction,
        transactionType: transaction.transactionType,
        amountMinor: transaction.amountMinor,
        currency: transaction.currency,
        normalizedNarration: transaction.normalizedNarration,
        rawNarration: transaction.source.rawNarration,
        sourceReference: transaction.sourceReference,
        category: transaction.category,
        counterparty: transaction.counterparty,
        scope: transaction.scope,
        note: transaction.note,
        sourceImportIds: transaction.source.importIds,
        parsedSources: localParsedSources,
      },
    };
  }

  return {
    transactionKey: `transaction-${ordinal}`,
    data: {
      occurredDate: occurredAt.slice(0, 10),
      direction: transaction.direction,
      transactionType: transaction.transactionType,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      narration: redactRemoteNarration(
        transaction.normalizedNarration ?? transaction.source.rawNarration ?? "",
      ),
      currentCategory: transaction.category?.name ?? null,
      currentCounterparty: transaction.counterparty
        ? redactRemoteNarration(transaction.counterparty.displayName)
        : null,
      scope: transaction.scope,
    },
  };
}

export function payloadPreview(
  transaction: Transaction | TransactionRecord | null,
  policy: AiPayloadPolicy,
  localModel: boolean,
): AiPayloadPreview {
  const sample = transaction
    ? buildAiTransactionPayload(transaction, policy).data
    : policy === "local_full"
      ? {
          transactionId: "local-transaction-id",
          amountMinor: 125000,
          currency: "NGN",
          direction: "debit",
          normalizedNarration: "Transfer to example counterparty",
          sourceReference: "local-source-reference",
          note: "A local user note may be included.",
        }
      : {
          occurredDate: "2026-06-15",
          amountMinor: 125000,
          currency: "NGN",
          direction: "debit",
          narration: "Transfer to [REDACTED_NUMBER]",
          currentCategory: null,
          currentCounterparty: null,
          scope: "personal",
        };
  return {
    policy,
    localModel,
    omittedFields: policy === "remote_redacted" ? REMOTE_OMITTED_FIELDS : [],
    sample,
  };
}

export function redactRemoteNarration(value: string): string {
  return value
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "[REDACTED_REFERENCE]")
    .replace(
      /\b(?=[A-Z0-9-]{12,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)+\b/gi,
      "[REDACTED_REFERENCE]",
    )
    .replace(/\b[A-Z0-9]{14,}\b/gi, "[REDACTED_REFERENCE]")
    .replace(/\b\d{6,}\b/g, "[REDACTED_NUMBER]")
    .replace(
      /\b(account|acct|a\/c|reference|ref|transaction id|session id)\s*[:#-]?\s*\S+/gi,
      "$1 [REDACTED]",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export function classificationSystemPrompt(categories: string[]): string {
  return [
    "You classify financial transactions for SpendLens.",
    "Return only one JSON object matching the requested schema.",
    `Allowed categories and subcategories: ${categories.join(", ")}.`,
    "Use only evidence present in the supplied transaction.",
    "Do not invent a counterparty. Use null when it is not supported by the evidence.",
  ].join(" ");
}

export function classificationUserPrompt(payload: AiTransactionPayload): string {
  return JSON.stringify({
    promptVersion: AI_PROMPT_VERSION,
    transactionKey: payload.transactionKey,
    transaction: payload.data,
    output: {
      category: "allowed category name",
      subcategory: "allowed child category name or null",
      counterparty: "supported counterparty name or null",
      transactionType:
        "expense | income | transfer | refund | fee | cash_withdrawal | debt | unclassified",
      scope: "personal | business (optional)",
      confidence: "low | medium | high",
      reasonCodes: ["short.machine_readable_code"],
      explanation: "short evidence-based explanation",
      evidence: ["short evidence item"],
    },
  });
}

import { createHash } from "node:crypto";

export interface FallbackIdentityInput {
  occurredAtUtc: Date | number;
  currency: string;
  direction: "debit" | "credit";
  amountMinor: number;
  narration: string | null;
}

export function normalizeNarration(value: string | null): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function fallbackTransactionFingerprint(input: FallbackIdentityInput): string {
  const timestamp =
    input.occurredAtUtc instanceof Date ? input.occurredAtUtc.getTime() : input.occurredAtUtc;
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(input.amountMinor)) {
    throw new Error("Fallback transaction identity requires safe integer values.");
  }
  return createHash("sha256")
    .update(
      [
        timestamp,
        input.currency.toUpperCase(),
        input.direction,
        input.amountMinor,
        normalizeNarration(input.narration),
      ].join("\u001f"),
    )
    .digest("hex");
}

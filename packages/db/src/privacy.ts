const SENSITIVE_KEY =
  /(^key$|^iv$|account.?number|auth.?tag|authorization|ciphertext|cookie|credential|crypto|database.?key|encryption.?key|narration|password|private.?key|raw.?fields|recovery.?code|secret|statement.?content|token)/i;

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;
const MAX_STRING_LENGTH = 2_000;

export function sanitizePrivateData(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (typeof value === "function" || typeof value === "symbol") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePrivateData(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? REDACTED : sanitizePrivateData(item, depth + 1),
      ]),
    );
  }
  return String(value);
}

export function safeJson(value: unknown): string {
  return JSON.stringify(sanitizePrivateData(value));
}

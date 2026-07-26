import type { ErrorFamily } from "@spendlens/contracts";

export type AppErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503;

export class AppError extends Error {
  constructor(
    readonly family: ErrorFamily,
    readonly code: string,
    message: string,
    readonly status: AppErrorStatus,
    readonly options: {
      details?: Record<string, unknown>;
      fields?: Record<string, string[]>;
      retryAfterSeconds?: number;
      retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "AppError";
  }

  static validation(
    code: "INVALID_REQUEST" | "VALIDATION_FAILED",
    message: string,
    fields?: Record<string, string[]>,
  ): AppError {
    return new AppError("validation", code, message, 400, {
      ...(fields ? { fields } : {}),
    });
  }
}

export const errorFamilies = {
  validation: ["INVALID_REQUEST", "VALIDATION_FAILED"],
  setup: ["SETUP_REQUIRED", "SETUP_NOT_STARTED", "SETUP_ALREADY_COMPLETE"],
  authentication: [
    "AUTHENTICATION_REQUIRED",
    "INVALID_CREDENTIALS",
    "SESSION_INVALID",
    "CSRF_VALIDATION_FAILED",
  ],
  import: ["IMPORT_NOT_FOUND", "IMPORT_FAILED"],
  parser: ["PARSER_UNSUPPORTED", "PARSER_FAILED"],
  duplicate: ["DUPLICATE_IMPORT", "DUPLICATE_TRANSACTION"],
  classification: ["CLASSIFICATION_FAILED", "CLASSIFICATION_PROVIDER_REQUIRED"],
  provider: ["PROVIDER_UNAVAILABLE", "PROVIDER_RATE_LIMITED"],
  backup: ["BACKUP_FAILED", "RESTORE_FAILED"],
  database: ["DATABASE_UNAVAILABLE", "DATABASE_OPERATION_FAILED"],
  internal: ["INTERNAL_ERROR", "JOB_HANDLER_MISSING"],
} as const satisfies Record<ErrorFamily, readonly string[]>;

export function familyForCode(code: string): ErrorFamily {
  for (const [family, codes] of Object.entries(errorFamilies)) {
    if ((codes as readonly string[]).includes(code)) return family as ErrorFamily;
  }
  if (code.startsWith("SETUP_") || code === "INVALID_SETUP_TOKEN") return "setup";
  if (
    code.startsWith("AUTH_") ||
    code.startsWith("SESSION_") ||
    code.startsWith("LOGIN_") ||
    code.startsWith("CSRF_") ||
    code === "INVALID_CREDENTIALS" ||
    code === "CROSS_ORIGIN_REQUEST_BLOCKED" ||
    code === "INVALID_ORIGIN"
  ) {
    return "authentication";
  }
  if (code.startsWith("DATABASE_")) return "database";
  return "internal";
}

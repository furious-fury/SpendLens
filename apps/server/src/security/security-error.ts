import { AppError, familyForCode } from "../api/app-error.js";

export class SecurityError extends AppError {
  constructor(
    code: string,
    message: string,
    status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    retryAfterSeconds?: number,
    fields?: Record<string, string[]>,
  ) {
    super(familyForCode(code), code, message, status, {
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      ...(fields ? { fields } : {}),
    });
    this.name = "SecurityError";
  }
}

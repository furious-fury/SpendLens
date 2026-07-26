export class SecurityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    readonly retryAfterSeconds?: number,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "SecurityError";
  }
}

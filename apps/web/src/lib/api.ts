import {
  AccountListSchema,
  AccountSchema,
  BulkTransactionResultSchema,
  CategoryListSchema,
  CategorySchema,
  type ChangePasswordRequest,
  CounterpartyListSchema,
  CounterpartySchema,
  type BulkTransactionEdit,
  type CreateAccount,
  type CreateCategory,
  type CreateCounterparty,
  RekeyResponseSchema,
  type ReplaceTransactionSplits,
  SecurityErrorSchema,
  SecuritySessionSchema,
  SecurityStateSchema,
  ServiceHealthSchema,
  type ServiceHealth,
  SetupPreparedSchema,
  type SetupRequest,
  type TransactionEdit,
  type TransactionListQuery,
  TransactionListSchema,
  TransactionSchema,
  type UpdateAccount,
  type UpdateCategory,
  type UpdateCounterparty,
  apiPaths,
} from "@spendlens/contracts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  parse: (value: unknown) => T,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase())) {
    const csrfToken = readCookie("spendlens_csrf");
    if (csrfToken) {
      headers.set("x-csrf-token", csrfToken);
    }
  }

  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  if (!response.ok) {
    const result = SecurityErrorSchema.safeParse(await readJson(response));
    if (result.success) {
      throw new ApiError(
        result.data.error.message,
        result.data.error.code,
        response.status,
        result.data.error.retryAfterSeconds,
        result.data.error.fields,
      );
    }
    throw new ApiError(
      `SpendLens request failed with status ${response.status}.`,
      "REQUEST_FAILED",
      response.status,
    );
  }

  return parse(await readJson(response));
}

async function mutate<T>(
  path: string,
  body: unknown,
  parse: (value: unknown) => T,
  method = "POST",
) {
  return request(path, parse, {
    method,
    body: JSON.stringify(body),
  });
}

export const api = {
  readiness(): Promise<ServiceHealth> {
    return request(apiPaths.ready, (value) => ServiceHealthSchema.parse(value));
  },
  securityState() {
    return request(apiPaths.securityState, (value) => SecurityStateSchema.parse(value));
  },
  setup(input: SetupRequest) {
    return mutate(apiPaths.setup, input, (value) => SetupPreparedSchema.parse(value));
  },
  completeSetup(setupToken: string) {
    return mutate(apiPaths.setupComplete, { setupToken, recoveryConfirmed: true }, (value) =>
      SecuritySessionSchema.parse(value),
    );
  },
  login(password: string) {
    return mutate(apiPaths.login, { password }, (value) => SecuritySessionSchema.parse(value));
  },
  async logout() {
    await request(apiPaths.logout, () => undefined, { method: "POST" });
  },
  async logoutAll() {
    await request(apiPaths.logoutAll, () => undefined, { method: "POST" });
  },
  changePassword(input: ChangePasswordRequest) {
    return mutate(
      apiPaths.changePassword,
      input,
      (value) => SecuritySessionSchema.parse(value),
      "PUT",
    );
  },
  rekey(password: string) {
    return mutate(
      apiPaths.rekey,
      { password },
      (value) => RekeyResponseSchema.parse(value).recoveryKit,
    );
  },
  transactions(query: Partial<TransactionListQuery> = {}) {
    return request(withQuery(apiPaths.transactions, query), (value) =>
      TransactionListSchema.parse(value),
    );
  },
  transaction(transactionId: string) {
    return request(apiPaths.transaction(transactionId), (value) => TransactionSchema.parse(value));
  },
  updateTransaction(transactionId: string, changes: TransactionEdit) {
    return mutate(
      apiPaths.transaction(transactionId),
      changes,
      (value) => TransactionSchema.parse(value),
      "PATCH",
    );
  },
  replaceTransactionSplits(transactionId: string, input: ReplaceTransactionSplits) {
    return mutate(
      apiPaths.transactionSplits(transactionId),
      input,
      (value) => TransactionSchema.parse(value),
      "PUT",
    );
  },
  bulkUpdateTransactions(input: BulkTransactionEdit) {
    return mutate(
      apiPaths.bulkTransactions,
      input,
      (value) => BulkTransactionResultSchema.parse(value),
      "PATCH",
    );
  },
  confirmTransfer(transactionId: string, pairedTransactionId: string) {
    return mutate(apiPaths.transactionTransfer(transactionId), { pairedTransactionId }, (value) =>
      TransactionSchema.parse(value),
    );
  },
  accounts() {
    return request(apiPaths.accounts, (value) => AccountListSchema.parse(value));
  },
  createAccount(input: CreateAccount) {
    return mutate(apiPaths.accounts, input, (value) => AccountSchema.parse(value));
  },
  updateAccount(accountId: string, input: UpdateAccount) {
    return mutate(
      apiPaths.account(accountId),
      input,
      (value) => AccountSchema.parse(value),
      "PATCH",
    );
  },
  registerOwnedAccount(
    accountId: string,
    input: { institutionCode: string; accountNumber: string },
  ) {
    return mutate(apiPaths.accountIdentifier(accountId), input, (value) =>
      AccountSchema.parse(value),
    );
  },
  categories() {
    return request(apiPaths.categories, (value) => CategoryListSchema.parse(value));
  },
  createCategory(input: CreateCategory) {
    return mutate(apiPaths.categories, input, (value) => CategorySchema.parse(value));
  },
  updateCategory(categoryId: string, input: UpdateCategory) {
    return mutate(
      apiPaths.category(categoryId),
      input,
      (value) => CategorySchema.parse(value),
      "PATCH",
    );
  },
  mergeCategory(categoryId: string, targetCategoryId: string) {
    return mutate(apiPaths.mergeCategory(categoryId), { targetCategoryId }, (value) =>
      CategorySchema.parse(value),
    );
  },
  counterparties() {
    return request(apiPaths.counterparties, (value) => CounterpartyListSchema.parse(value));
  },
  createCounterparty(input: CreateCounterparty) {
    return mutate(apiPaths.counterparties, input, (value) => CounterpartySchema.parse(value));
  },
  updateCounterparty(counterpartyId: string, input: UpdateCounterparty) {
    return mutate(
      apiPaths.counterparty(counterpartyId),
      input,
      (value) => CounterpartySchema.parse(value),
      "PATCH",
    );
  },
};

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return undefined;
  }
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }
  const prefix = `${name}=`;
  const cookie = document.cookie.split("; ").find((entry) => entry.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : undefined;
}

function withQuery(path: string, values: object): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  }
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

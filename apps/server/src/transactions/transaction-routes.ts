import {
  AccountListSchema,
  AccountSchema,
  ApiErrorSchema,
  BulkTransactionEditSchema,
  BulkTransactionResultSchema,
  CategoryListSchema,
  CategorySchema,
  ConfirmTransferSchema,
  CounterpartyListSchema,
  CounterpartySchema,
  CreateAccountSchema,
  CreateCategorySchema,
  CreateCounterpartySchema,
  MergeCategorySchema,
  RegisterOwnedAccountSchema,
  ReplaceTransactionSplitsSchema,
  TransactionEditSchema,
  TransactionListQuerySchema,
  TransactionListSchema,
  TransactionSchema,
  UpdateAccountSchema,
  UpdateCategorySchema,
  UpdateCounterpartySchema,
} from "@spendlens/contracts";
import {
  type AuditLog,
  TransactionWorkspaceError,
  type TransactionWorkspace,
  type WorkspaceManagement,
  type WorkspaceMutation,
} from "@spendlens/db";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { AppError } from "../api/app-error.js";
import type { AppEnv } from "../api/request-context.js";

export interface TransactionRoutesOptions {
  transactions: TransactionWorkspace;
  management: WorkspaceManagement;
  audit: AuditLog;
}

const TransactionParamsSchema = z.object({
  transactionId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "transactionId", in: "path" },
    }),
});

const AccountParamsSchema = z.object({
  accountId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "accountId", in: "path" },
    }),
});

const CategoryParamsSchema = z.object({
  categoryId: z
    .string()
    .min(1)
    .max(200)
    .openapi({
      param: { name: "categoryId", in: "path" },
    }),
});

const CounterpartyParamsSchema = z.object({
  counterpartyId: z
    .string()
    .uuid()
    .openapi({
      param: { name: "counterpartyId", in: "path" },
    }),
});

const errorResponse = {
  content: { "application/json": { schema: ApiErrorSchema } },
  description: "Structured API error",
} as const;

const protectedErrors = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  500: errorResponse,
} as const;

const listTransactionsRoute = createRoute({
  method: "get",
  path: "/api/transactions",
  tags: ["Transactions"],
  security: [{ sessionCookie: [] }],
  request: { query: TransactionListQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: TransactionListSchema } },
      description: "Cursor-paginated transaction list",
    },
    ...protectedErrors,
  },
});

const getTransactionRoute = createRoute({
  method: "get",
  path: "/api/transactions/{transactionId}",
  tags: ["Transactions"],
  security: [{ sessionCookie: [] }],
  request: { params: TransactionParamsSchema },
  responses: {
    200: {
      content: { "application/json": { schema: TransactionSchema } },
      description: "Transaction detail with preserved source values",
    },
    ...protectedErrors,
  },
});

const updateTransactionRoute = createRoute({
  method: "patch",
  path: "/api/transactions/{transactionId}",
  tags: ["Transactions"],
  security: [{ sessionCookie: [] }],
  request: {
    params: TransactionParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: TransactionEditSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TransactionSchema } },
      description: "Updated transaction",
    },
    ...protectedErrors,
  },
});

const replaceSplitsRoute = createRoute({
  method: "put",
  path: "/api/transactions/{transactionId}/splits",
  tags: ["Transactions"],
  security: [{ sessionCookie: [] }],
  request: {
    params: TransactionParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: ReplaceTransactionSplitsSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TransactionSchema } },
      description: "Transaction with replaced active splits",
    },
    ...protectedErrors,
  },
});

const bulkUpdateRoute = createRoute({
  method: "patch",
  path: "/api/transactions/bulk",
  tags: ["Transactions"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: BulkTransactionEditSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: BulkTransactionResultSchema } },
      description: "Safe bulk edit result",
    },
    ...protectedErrors,
  },
});

const confirmTransferRoute = createRoute({
  method: "post",
  path: "/api/transactions/{transactionId}/transfer",
  tags: ["Transactions"],
  security: [{ sessionCookie: [] }],
  request: {
    params: TransactionParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: ConfirmTransferSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: TransactionSchema } },
      description: "Confirmed internal transfer",
    },
    ...protectedErrors,
  },
});

const listAccountsRoute = createRoute({
  method: "get",
  path: "/api/accounts",
  tags: ["Accounts"],
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: AccountListSchema } },
      description: "Workspace accounts",
    },
    ...protectedErrors,
  },
});

const createAccountRoute = createRoute({
  method: "post",
  path: "/api/accounts",
  tags: ["Accounts"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateAccountSchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: AccountSchema } },
      description: "Created account",
    },
    ...protectedErrors,
  },
});

const updateAccountRoute = createRoute({
  method: "patch",
  path: "/api/accounts/{accountId}",
  tags: ["Accounts"],
  security: [{ sessionCookie: [] }],
  request: {
    params: AccountParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateAccountSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AccountSchema } },
      description: "Updated account",
    },
    ...protectedErrors,
  },
});

const registerOwnedAccountRoute = createRoute({
  method: "post",
  path: "/api/accounts/{accountId}/identifiers",
  tags: ["Accounts"],
  security: [{ sessionCookie: [] }],
  request: {
    params: AccountParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: RegisterOwnedAccountSchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AccountSchema } },
      description: "Account with registered owned identifier",
    },
    ...protectedErrors,
  },
});

const listCategoriesRoute = createRoute({
  method: "get",
  path: "/api/categories",
  tags: ["Categories"],
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: CategoryListSchema } },
      description: "Workspace categories",
    },
    ...protectedErrors,
  },
});

const createCategoryRoute = createRoute({
  method: "post",
  path: "/api/categories",
  tags: ["Categories"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateCategorySchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CategorySchema } },
      description: "Created category",
    },
    ...protectedErrors,
  },
});

const updateCategoryRoute = createRoute({
  method: "patch",
  path: "/api/categories/{categoryId}",
  tags: ["Categories"],
  security: [{ sessionCookie: [] }],
  request: {
    params: CategoryParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateCategorySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CategorySchema } },
      description: "Updated, nested, promoted, or archived category",
    },
    ...protectedErrors,
  },
});

const mergeCategoryRoute = createRoute({
  method: "post",
  path: "/api/categories/{categoryId}/merge",
  tags: ["Categories"],
  security: [{ sessionCookie: [] }],
  request: {
    params: CategoryParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: MergeCategorySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CategorySchema } },
      description: "Target category after merge",
    },
    ...protectedErrors,
  },
});

const listCounterpartiesRoute = createRoute({
  method: "get",
  path: "/api/counterparties",
  tags: ["Counterparties"],
  security: [{ sessionCookie: [] }],
  responses: {
    200: {
      content: { "application/json": { schema: CounterpartyListSchema } },
      description: "Workspace counterparties",
    },
    ...protectedErrors,
  },
});

const createCounterpartyRoute = createRoute({
  method: "post",
  path: "/api/counterparties",
  tags: ["Counterparties"],
  security: [{ sessionCookie: [] }],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateCounterpartySchema } },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: CounterpartySchema } },
      description: "Created counterparty",
    },
    ...protectedErrors,
  },
});

const updateCounterpartyRoute = createRoute({
  method: "patch",
  path: "/api/counterparties/{counterpartyId}",
  tags: ["Counterparties"],
  security: [{ sessionCookie: [] }],
  request: {
    params: CounterpartyParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: UpdateCounterpartySchema } },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: CounterpartySchema } },
      description: "Updated counterparty",
    },
    ...protectedErrors,
  },
});

export function createTransactionRoutes(options: TransactionRoutesOptions): OpenAPIHono<AppEnv> {
  const routes = new OpenAPIHono<AppEnv>();

  routes.openapi(listTransactionsRoute, (context) => {
    const session = context.get("session");
    try {
      const result = options.transactions.listTransactions(
        session.workspaceId,
        context.req.valid("query"),
      );
      return context.json(
        {
          ...result,
          items: result.items.map(transactionResponse),
        },
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(getTransactionRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        transactionResponse(
          options.transactions.getTransaction(
            session.workspaceId,
            context.req.valid("param").transactionId,
          ),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(bulkUpdateRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.transactions.bulkUpdate(
          {
            workspaceId: session.workspaceId,
            actorUserId: session.user.id,
            edit: context.req.valid("json"),
          },
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(updateTransactionRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        transactionResponse(
          options.transactions.updateTransaction(
            {
              workspaceId: session.workspaceId,
              transactionId: context.req.valid("param").transactionId,
              actorUserId: session.user.id,
              changes: context.req.valid("json"),
            },
            auditMutation(options.audit, context),
          ),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(replaceSplitsRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        transactionResponse(
          options.transactions.replaceSplits(
            {
              workspaceId: session.workspaceId,
              transactionId: context.req.valid("param").transactionId,
              actorUserId: session.user.id,
              splits: context.req.valid("json").splits,
            },
            auditMutation(options.audit, context),
          ),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(confirmTransferRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        transactionResponse(
          options.transactions.confirmTransfer(
            {
              workspaceId: session.workspaceId,
              transactionId: context.req.valid("param").transactionId,
              pairedTransactionId: context.req.valid("json").pairedTransactionId,
              actorUserId: session.user.id,
            },
            auditMutation(options.audit, context),
          ),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(listAccountsRoute, (context) =>
    context.json(
      {
        items: options.management.listAccounts(context.get("session").workspaceId),
      },
      200,
    ),
  );

  routes.openapi(createAccountRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.management.createAccount(
          { workspaceId: session.workspaceId, ...context.req.valid("json") },
          auditMutation(options.audit, context),
        ),
        201,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(updateAccountRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.management.updateAccount(
          {
            workspaceId: session.workspaceId,
            accountId: context.req.valid("param").accountId,
            changes: context.req.valid("json"),
          },
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(registerOwnedAccountRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.management.registerOwnedAccount(
          {
            workspaceId: session.workspaceId,
            accountId: context.req.valid("param").accountId,
            ...context.req.valid("json"),
          },
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(listCategoriesRoute, (context) =>
    context.json(
      {
        items: options.management.listCategories(context.get("session").workspaceId),
      },
      200,
    ),
  );

  routes.openapi(createCategoryRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.management.createCategory(
          { workspaceId: session.workspaceId, ...context.req.valid("json") },
          auditMutation(options.audit, context),
        ),
        201,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(updateCategoryRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.management.updateCategory(
          {
            workspaceId: session.workspaceId,
            categoryId: context.req.valid("param").categoryId,
            changes: context.req.valid("json"),
          },
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(mergeCategoryRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.management.mergeCategory(
          {
            workspaceId: session.workspaceId,
            sourceCategoryId: context.req.valid("param").categoryId,
            targetCategoryId: context.req.valid("json").targetCategoryId,
            actorUserId: session.user.id,
          },
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(listCounterpartiesRoute, (context) =>
    context.json(
      {
        items: options.management.listCounterparties(context.get("session").workspaceId),
      },
      200,
    ),
  );

  routes.openapi(createCounterpartyRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.management.createCounterparty(
          { workspaceId: session.workspaceId, ...context.req.valid("json") },
          auditMutation(options.audit, context),
        ),
        201,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  routes.openapi(updateCounterpartyRoute, (context) => {
    const session = context.get("session");
    try {
      return context.json(
        options.management.updateCounterparty(
          {
            workspaceId: session.workspaceId,
            counterpartyId: context.req.valid("param").counterpartyId,
            changes: context.req.valid("json"),
          },
          auditMutation(options.audit, context),
        ),
        200,
      );
    } catch (error) {
      throw mapWorkspaceError(error);
    }
  });

  return routes;
}

function transactionResponse(transaction: ReturnType<TransactionWorkspace["getTransaction"]>) {
  return {
    ...transaction,
    occurredAt: transaction.occurredAt.toISOString(),
    updatedAt: transaction.updatedAt.toISOString(),
  };
}

function auditMutation(audit: AuditLog, context: Context<AppEnv>) {
  const session = context.get("session");
  return (mutation: WorkspaceMutation) => {
    audit.record({
      workspaceId: session.workspaceId,
      actorUserId: session.user.id,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      action: mutation.action,
      ...(mutation.beforeState === undefined ? {} : { beforeState: mutation.beforeState }),
      ...(mutation.afterState === undefined ? {} : { afterState: mutation.afterState }),
      ...(mutation.relatedRuleId === undefined ? {} : { relatedRuleId: mutation.relatedRuleId }),
      requestId: context.get("requestId"),
    });
  };
}

function mapWorkspaceError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof TransactionWorkspaceError) {
    const notFound = [
      "TRANSACTION_NOT_FOUND",
      "ACCOUNT_NOT_FOUND",
      "CATEGORY_NOT_FOUND",
      "COUNTERPARTY_NOT_FOUND",
    ].includes(error.code);
    const conflict = [
      "ACCOUNT_IDENTIFIER_EXISTS",
      "CATEGORY_IN_USE",
      "TRANSFER_PAIR_CONFLICT",
    ].includes(error.code);
    return new AppError(
      conflict ? "duplicate" : "validation",
      error.code,
      error.message,
      notFound ? 404 : conflict ? 409 : 400,
    );
  }
  return new AppError(
    "database",
    "DATABASE_OPERATION_FAILED",
    "The transaction workspace operation could not be completed.",
    500,
  );
}

import { z } from "zod";

export const ServiceHealthSchema = z.object({
  service: z.literal("spendlens"),
  status: z.enum(["ok", "ready"]),
  timestamp: z.string().datetime(),
  version: z.string(),
});

export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

export const PasswordSchema = z
  .string()
  .min(12, "Use at least 12 characters.")
  .max(128, "Use no more than 128 characters.");

export const SetupRequestSchema = z
  .object({
    setupToken: z.string().min(32).max(128),
    workspaceName: z.string().trim().min(1).max(80),
    displayName: z.string().trim().min(1).max(80),
    password: PasswordSchema,
    confirmPassword: z.string(),
    timezone: z.string().trim().min(1).max(100),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type SetupRequest = z.infer<typeof SetupRequestSchema>;

export const RecoveryFileSchema = z.object({
  type: z.literal("spendlens-recovery-key"),
  version: z.literal(1),
  workspaceId: z.string().uuid(),
  createdAt: z.string().datetime(),
  kdf: z.object({
    algorithm: z.literal("argon2id"),
    salt: z.string().min(1),
    memoryCost: z.number().int().positive(),
    timeCost: z.number().int().positive(),
    parallelism: z.number().int().positive(),
    hashLength: z.literal(32),
  }),
  wrap: z.object({
    algorithm: z.literal("aes-256-gcm"),
    iv: z.string().min(1),
    ciphertext: z.string().min(1),
    authTag: z.string().min(1),
  }),
});

export type RecoveryFile = z.infer<typeof RecoveryFileSchema>;

export const RecoveryKitSchema = z.object({
  recoveryCode: z.string(),
  recoveryFile: RecoveryFileSchema,
});

export type RecoveryKit = z.infer<typeof RecoveryKitSchema>;

export const SetupPreparedSchema = z.object({
  status: z.literal("recovery-required"),
  recoveryKit: RecoveryKitSchema,
});

export type SetupPrepared = z.infer<typeof SetupPreparedSchema>;

export const SetupCompleteRequestSchema = z.object({
  setupToken: z.string().min(32).max(128),
  recoveryConfirmed: z.literal(true),
});

export type SetupCompleteRequest = z.infer<typeof SetupCompleteRequestSchema>;

export const LoginRequestSchema = z.object({
  password: z.string().min(1).max(128),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    password: PasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const RekeyRequestSchema = z.object({
  password: z.string().min(1).max(128),
});

export type RekeyRequest = z.infer<typeof RekeyRequestSchema>;

export const RekeyResponseSchema = z.object({
  recoveryKit: RecoveryKitSchema,
});

export type RekeyResponse = z.infer<typeof RekeyResponseSchema>;

export const AuthenticatedUserSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  username: z.string(),
});

export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;

export const SecurityStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("setup-required"),
    setupPhase: z.enum(["new", "recovery-confirmation"]),
    keyMode: z.enum(["keyring", "secret-file"]),
  }),
  z.object({
    status: z.literal("unauthenticated"),
  }),
  z.object({
    status: z.literal("authenticated"),
    user: AuthenticatedUserSchema,
    sessionExpiresAt: z.string().datetime(),
  }),
]);

export type SecurityState = z.infer<typeof SecurityStateSchema>;

export const SecuritySessionSchema = z.object({
  user: AuthenticatedUserSchema,
  sessionExpiresAt: z.string().datetime(),
});

export type SecuritySession = z.infer<typeof SecuritySessionSchema>;

export const ErrorFamilySchema = z.enum([
  "validation",
  "setup",
  "authentication",
  "import",
  "parser",
  "duplicate",
  "classification",
  "provider",
  "backup",
  "database",
  "internal",
]);

export type ErrorFamily = z.infer<typeof ErrorFamilySchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    family: ErrorFamilySchema,
    requestId: z.string().min(8).max(100),
    details: z.record(z.string(), z.unknown()).optional(),
    retryAfterSeconds: z.number().int().positive().optional(),
    fields: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export const SecurityErrorSchema = ApiErrorSchema;
export type SecurityError = ApiError;

export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "Use a three-letter uppercase currency code.");

export const PaginationQuerySchema = z.object({
  cursor: z.string().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const SortQuerySchema = z.object({
  sort: z.string().min(1).max(80).optional(),
  direction: z.enum(["asc", "desc"]).default("desc"),
});

export const FilterQuerySchema = z.object({
  search: z.string().trim().min(1).max(200).optional(),
  accountId: z.string().min(1).max(200).optional(),
  categoryId: z.string().min(1).max(200).optional(),
  counterpartyId: z.string().min(1).max(200).optional(),
  scope: z.enum(["personal", "business"]).optional(),
  reviewState: z.enum(["unreviewed", "needs_review", "reviewed"]).optional(),
  direction: z.enum(["debit", "credit"]).optional(),
});

export const DateRangeQuerySchema = z
  .object({
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    timezone: z.string().min(1).max(100).optional(),
  })
  .refine(({ startDate, endDate }) => !startDate || !endDate || startDate <= endDate, {
    message: "startDate must not be after endDate.",
    path: ["endDate"],
  });

export const StandardListQuerySchema = PaginationQuerySchema.extend({
  sort: SortQuerySchema.shape.sort,
  direction: SortQuerySchema.shape.direction,
  startDate: z.iso.date().optional(),
  endDate: z.iso.date().optional(),
  timezone: z.string().min(1).max(100).optional(),
  currency: CurrencyCodeSchema.optional(),
  search: FilterQuerySchema.shape.search,
  accountId: FilterQuerySchema.shape.accountId,
  categoryId: FilterQuerySchema.shape.categoryId,
  counterpartyId: FilterQuerySchema.shape.counterpartyId,
  scope: FilterQuerySchema.shape.scope,
  reviewState: FilterQuerySchema.shape.reviewState,
  transactionDirection: FilterQuerySchema.shape.direction,
}).refine(({ startDate, endDate }) => !startDate || !endDate || startDate <= endDate, {
  message: "startDate must not be after endDate.",
  path: ["endDate"],
});

export type StandardListQuery = z.infer<typeof StandardListQuerySchema>;

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);

export const JobSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  status: JobStatusSchema,
  progressBasisPoints: z.number().int().min(0).max(10_000),
  progressMessage: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  availableAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .nullable(),
  result: z.unknown().nullable(),
  relatedImportBatchId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Job = z.infer<typeof JobSchema>;

export const ImportProgressSchema = z.object({
  importId: z.string().uuid(),
  status: z.enum(["pending", "previewed", "committed", "failed"]),
  jobs: z.array(JobSchema),
});

export type ImportProgress = z.infer<typeof ImportProgressSchema>;

export const ImportReconciliationSchema = z.object({
  status: z.enum(["matched", "mismatched"]),
  declaredInflowMinor: z.number().int().nonnegative(),
  declaredOutflowMinor: z.number().int().nonnegative(),
  parsedInflowMinor: z.number().int().nonnegative(),
  parsedOutflowMinor: z.number().int().nonnegative(),
  currency: CurrencyCodeSchema,
});

export const ImportPreviewSchema = z.object({
  id: z.string().uuid(),
  status: z.literal("previewed"),
  institution: z.string(),
  maskedAccountNumber: z.string().nullable(),
  statementPeriod: z.object({
    start: z.iso.date(),
    end: z.iso.date(),
  }),
  totals: z.object({
    inflowMinor: z.number().int().nonnegative(),
    outflowMinor: z.number().int().nonnegative(),
    currency: CurrencyCodeSchema,
  }),
  transactionCount: z.number().int().nonnegative(),
  reconciliation: ImportReconciliationSchema,
  parser: z.object({
    key: z.string(),
    version: z.string(),
  }),
  requiresConfirmation: z.boolean(),
  createdAt: z.string().datetime(),
});

export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

export const ImportMatchClassificationSchema = z.enum([
  "new",
  "duplicate",
  "possible_duplicate",
  "conflict",
]);

export const ImportMatchDecisionSchema = z.enum(["pending", "confirmed", "rejected", "skipped"]);

export const ImportTransactionSnapshotSchema = z.object({
  transactionId: z.string().uuid().nullable(),
  sourceTransactionId: z.string().nullable(),
  occurredAt: z.string().datetime(),
  direction: z.enum(["debit", "credit"]),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  narration: z.string(),
});

export const ImportAttentionItemSchema = z.object({
  decisionId: z.string().uuid(),
  classification: z.enum(["possible_duplicate", "conflict"]),
  decision: ImportMatchDecisionSchema,
  reasonCode: z.string(),
  source: ImportTransactionSnapshotSchema,
  candidate: ImportTransactionSnapshotSchema,
});

export const ImportDeduplicationCountsSchema = z.object({
  new: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  possibleDuplicate: z.number().int().nonnegative(),
  conflict: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});

export const ImportDeduplicationSummarySchema = z.object({
  importId: z.string().uuid(),
  status: z.enum(["analyzed", "committed"]),
  accountId: z.string().uuid().nullable(),
  willCreateAccount: z.boolean(),
  counts: ImportDeduplicationCountsSchema,
  pendingDecisionCount: z.number().int().nonnegative(),
  attentionItems: z.array(ImportAttentionItemSchema),
  commitResult: z
    .object({
      canonicalTransactionsCreated: z.number().int().nonnegative(),
      duplicateSourcesLinked: z.number().int().nonnegative(),
      skippedSources: z.number().int().nonnegative(),
      committedAt: z.string().datetime(),
    })
    .nullable(),
});

export type ImportDeduplicationSummary = z.infer<typeof ImportDeduplicationSummarySchema>;

export const AnalyzeImportRequestSchema = z.object({
  accountId: z.string().uuid().optional(),
});

export const ImportDecisionRequestSchema = z.object({
  decisions: z
    .array(
      z.object({
        decisionId: z.string().uuid(),
        action: z.enum(["confirm_duplicate", "keep_separate", "skip"]),
      }),
    )
    .min(1)
    .max(500),
});

export const CommitImportRequestSchema = z.object({
  confirmUnreconciled: z.boolean().default(false),
});

export const TransactionDirectionSchema = z.enum(["debit", "credit"]);
export type TransactionDirection = z.infer<typeof TransactionDirectionSchema>;
export const TransactionScopeSchema = z.enum(["personal", "business"]);
export type TransactionScope = z.infer<typeof TransactionScopeSchema>;
export const TransactionReviewStateSchema = z.enum(["unreviewed", "needs_review", "reviewed"]);
export type TransactionReviewState = z.infer<typeof TransactionReviewStateSchema>;
export const TransactionConfidenceSchema = z.enum([
  "unknown",
  "low",
  "medium",
  "high",
  "confirmed",
]);
export type TransactionConfidence = z.infer<typeof TransactionConfidenceSchema>;
export const TransactionTypeSchema = z.enum([
  "expense",
  "income",
  "transfer",
  "refund",
  "fee",
  "cash_withdrawal",
  "debt",
  "unclassified",
]);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;
export const CategoryIdSchema = z.string().min(1).max(200);

export const TransactionListQuerySchema = z
  .object({
    cursor: z.string().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    sort: z.enum(["occurredAt", "amount", "createdAt"]).default("occurredAt"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    search: z.string().trim().min(1).max(200).optional(),
    startDate: z.iso.date().optional(),
    endDate: z.iso.date().optional(),
    accountId: z.string().uuid().optional(),
    minimumAmountMinor: z.coerce.number().int().positive().optional(),
    maximumAmountMinor: z.coerce.number().int().positive().optional(),
    transactionDirection: TransactionDirectionSchema.optional(),
    currency: CurrencyCodeSchema.optional(),
    scope: TransactionScopeSchema.optional(),
    categoryId: CategoryIdSchema.optional(),
    counterpartyId: z.string().uuid().optional(),
    confidence: TransactionConfidenceSchema.optional(),
    reviewState: TransactionReviewStateSchema.optional(),
  })
  .refine(({ startDate, endDate }) => !startDate || !endDate || startDate <= endDate, {
    message: "startDate must not be after endDate.",
    path: ["endDate"],
  })
  .refine(
    ({ minimumAmountMinor, maximumAmountMinor }) =>
      !minimumAmountMinor || !maximumAmountMinor || minimumAmountMinor <= maximumAmountMinor,
    {
      message: "minimumAmountMinor must not exceed maximumAmountMinor.",
      path: ["maximumAmountMinor"],
    },
  );

export type TransactionListQuery = z.infer<typeof TransactionListQuerySchema>;

const TransactionAccountSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  institutionName: z.string(),
});

const TransactionCategorySummarySchema = z.object({
  id: CategoryIdSchema,
  name: z.string(),
  parentName: z.string().nullable(),
});

const TransactionCounterpartySummarySchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
});

export const TransactionSplitSchema = z.object({
  id: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  category: TransactionCategorySummarySchema,
  scope: TransactionScopeSchema,
  note: z.string().nullable(),
});

export const TransactionSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
  sourceTimestamp: z.string(),
  sourceTimezone: z.string(),
  account: TransactionAccountSchema,
  direction: TransactionDirectionSchema,
  transactionType: TransactionTypeSchema,
  amountMinor: z.number().int().positive(),
  currency: CurrencyCodeSchema,
  normalizedNarration: z.string().nullable(),
  sourceReference: z.string().nullable(),
  category: TransactionCategorySummarySchema.nullable(),
  counterparty: TransactionCounterpartySummarySchema.nullable(),
  scope: TransactionScopeSchema,
  classificationSource: z.enum([
    "unclassified",
    "manual",
    "rule",
    "history",
    "deterministic",
    "ai",
  ]),
  confidence: TransactionConfidenceSchema,
  confidenceBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  classificationExplanation: z.string().nullable(),
  reviewState: TransactionReviewStateSchema,
  note: z.string().nullable(),
  splits: z.array(TransactionSplitSchema),
  transfer: z.object({
    status: z.enum(["none", "suggested", "confirmed", "rejected"]),
    pairedTransactionId: z.string().uuid().nullable(),
  }),
  source: z.object({
    rawNarration: z.string().nullable(),
    sourceTimestamp: z.string(),
    importIds: z.array(z.string().uuid()),
  }),
  updatedAt: z.string().datetime(),
});

export type Transaction = z.infer<typeof TransactionSchema>;

export const TransactionListSchema = z.object({
  items: z.array(TransactionSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});

export type TransactionList = z.infer<typeof TransactionListSchema>;

export const TransactionEditSchema = z
  .object({
    normalizedNarration: z.string().trim().min(1).max(500).nullable().optional(),
    scope: TransactionScopeSchema.optional(),
    categoryId: CategoryIdSchema.nullable().optional(),
    counterpartyId: z.string().uuid().nullable().optional(),
    transactionType: TransactionTypeSchema.optional(),
    reviewState: TransactionReviewStateSchema.optional(),
    note: z.string().trim().max(2_000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one field to update.");

export type TransactionEdit = z.infer<typeof TransactionEditSchema>;

export const TransactionSplitInputSchema = z.object({
  amountMinor: z.number().int().positive(),
  categoryId: CategoryIdSchema,
  scope: TransactionScopeSchema,
  note: z.string().trim().max(500).nullable().optional(),
});

export const ReplaceTransactionSplitsSchema = z.object({
  splits: z.array(TransactionSplitInputSchema).min(2).max(50),
});

export type ReplaceTransactionSplits = z.infer<typeof ReplaceTransactionSplitsSchema>;

export const BulkTransactionEditSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(100),
  changes: z
    .object({
      scope: TransactionScopeSchema.optional(),
      categoryId: CategoryIdSchema.nullable().optional(),
      transactionType: TransactionTypeSchema.optional(),
      reviewState: TransactionReviewStateSchema.optional(),
    })
    .refine((value) => Object.keys(value).length > 0, "Provide at least one bulk change."),
});
export type BulkTransactionEdit = z.infer<typeof BulkTransactionEditSchema>;

export const BulkTransactionResultSchema = z.object({
  updatedCount: z.number().int().nonnegative(),
  transactionIds: z.array(z.string().uuid()),
});

export const AccountTypeSchema = z.enum([
  "wallet",
  "current",
  "savings",
  "business",
  "loan",
  "cash",
  "other",
]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const AccountSchema = z.object({
  id: z.string().uuid(),
  institutionName: z.string(),
  institutionCode: z.string().nullable(),
  displayName: z.string(),
  accountType: AccountTypeSchema,
  baseCurrency: CurrencyCodeSchema,
  maskedAccountNumber: z.string().nullable(),
  isOwned: z.boolean(),
  archivedAt: z.string().datetime().nullable(),
  transactionCount: z.number().int().nonnegative(),
});
export type Account = z.infer<typeof AccountSchema>;

export const AccountListSchema = z.object({ items: z.array(AccountSchema) });

export const CreateAccountSchema = z.object({
  institutionName: z.string().trim().min(1).max(120),
  institutionCode: z.string().trim().min(1).max(80).nullable().optional(),
  displayName: z.string().trim().min(1).max(120),
  accountType: AccountTypeSchema.default("other"),
  baseCurrency: CurrencyCodeSchema,
  isOwned: z.boolean().default(true),
});
export type CreateAccount = z.infer<typeof CreateAccountSchema>;

export const UpdateAccountSchema = z
  .object({
    institutionName: z.string().trim().min(1).max(120).optional(),
    institutionCode: z.string().trim().min(1).max(80).nullable().optional(),
    displayName: z.string().trim().min(1).max(120).optional(),
    accountType: AccountTypeSchema.optional(),
    isOwned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one account change.");
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>;

export const RegisterOwnedAccountSchema = z.object({
  institutionCode: z.string().trim().min(1).max(80),
  accountNumber: z.string().trim().min(4).max(64),
});

export const CategoryFlagsSchema = z.object({
  isIncome: z.boolean().default(false),
  isExpense: z.boolean().default(false),
  isTransfer: z.boolean().default(false),
  isEssential: z.boolean().default(false),
  isDiscretionary: z.boolean().default(false),
  isSavings: z.boolean().default(false),
  isRefund: z.boolean().default(false),
  isFee: z.boolean().default(false),
  isCashWithdrawal: z.boolean().default(false),
});

export const CategorySchema = z.object({
  id: CategoryIdSchema,
  parentId: CategoryIdSchema.nullable(),
  systemKey: z.string().nullable(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  archivedAt: z.string().datetime().nullable(),
  transactionCount: z.number().int().nonnegative(),
  flags: CategoryFlagsSchema,
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoryListSchema = z.object({ items: z.array(CategorySchema) });

export const CreateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).nullable().optional(),
    parentId: CategoryIdSchema.nullable().optional(),
    flags: CategoryFlagsSchema.partial().optional(),
  })
  .refine(
    ({ flags }) => !(flags?.isEssential && flags?.isDiscretionary),
    "A category cannot be both essential and discretionary.",
  );
export type CreateCategory = z.infer<typeof CreateCategorySchema>;

export const UpdateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    parentId: CategoryIdSchema.nullable().optional(),
    archived: z.boolean().optional(),
    flags: CategoryFlagsSchema.partial().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one category change.")
  .refine(
    ({ flags }) => !(flags?.isEssential && flags?.isDiscretionary),
    "A category cannot be both essential and discretionary.",
  );
export type UpdateCategory = z.infer<typeof UpdateCategorySchema>;

export const MergeCategorySchema = z.object({
  targetCategoryId: CategoryIdSchema,
});

export const CounterpartyKindSchema = z.enum([
  "person",
  "business",
  "merchant",
  "bank",
  "government",
  "unknown",
]);

export const CounterpartySchema = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  kind: CounterpartyKindSchema,
  institutionName: z.string().nullable(),
  maskedAccountNumber: z.string().nullable(),
  transactionCount: z.number().int().nonnegative(),
});
export type Counterparty = z.infer<typeof CounterpartySchema>;

export const CounterpartyListSchema = z.object({ items: z.array(CounterpartySchema) });

export const CreateCounterpartySchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  kind: CounterpartyKindSchema.default("unknown"),
  institutionName: z.string().trim().max(120).nullable().optional(),
});
export type CreateCounterparty = z.infer<typeof CreateCounterpartySchema>;

export const UpdateCounterpartySchema = z
  .object({
    displayName: z.string().trim().min(1).max(160).optional(),
    kind: CounterpartyKindSchema.optional(),
    institutionName: z.string().trim().max(120).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Provide at least one counterparty change.");
export type UpdateCounterparty = z.infer<typeof UpdateCounterpartySchema>;

export const ConfirmTransferSchema = z.object({
  pairedTransactionId: z.string().uuid(),
});

export const apiPaths = {
  live: "/health/live",
  ready: "/health/ready",
  securityState: "/api/security/state",
  setup: "/api/security/setup",
  setupComplete: "/api/security/setup/complete",
  login: "/api/security/login",
  logout: "/api/security/logout",
  logoutAll: "/api/security/sessions/revoke",
  changePassword: "/api/security/password",
  rekey: "/api/security/database/rekey",
  openApi: "/api/openapi.json",
  job: (jobId: string) => `/api/jobs/${jobId}`,
  cancelJob: (jobId: string) => `/api/jobs/${jobId}/cancel`,
  importPreviews: "/api/imports/previews",
  importPreview: (importId: string) => `/api/imports/previews/${importId}`,
  analyzeImport: (importId: string) => `/api/imports/previews/${importId}/reconcile`,
  importDecisions: (importId: string) => `/api/imports/previews/${importId}/decisions`,
  commitImport: (importId: string) => `/api/imports/previews/${importId}/commit`,
  deleteImport: (importId: string) => `/api/imports/${importId}`,
  importProgress: (importId: string) => `/api/imports/${importId}/progress`,
  transactions: "/api/transactions",
  transaction: (transactionId: string) => `/api/transactions/${transactionId}`,
  transactionSplits: (transactionId: string) => `/api/transactions/${transactionId}/splits`,
  transactionTransfer: (transactionId: string) => `/api/transactions/${transactionId}/transfer`,
  bulkTransactions: "/api/transactions/bulk",
  accounts: "/api/accounts",
  account: (accountId: string) => `/api/accounts/${accountId}`,
  accountIdentifier: (accountId: string) => `/api/accounts/${accountId}/identifiers`,
  categories: "/api/categories",
  category: (categoryId: string) => `/api/categories/${categoryId}`,
  mergeCategory: (categoryId: string) => `/api/categories/${categoryId}/merge`,
  counterparties: "/api/counterparties",
  counterparty: (counterpartyId: string) => `/api/counterparties/${counterpartyId}`,
} as const;

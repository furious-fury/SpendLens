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
  importProgress: (importId: string) => `/api/imports/${importId}/progress`,
} as const;

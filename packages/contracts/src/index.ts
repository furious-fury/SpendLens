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

export const SecurityErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryAfterSeconds: z.number().int().positive().optional(),
    fields: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

export type SecurityError = z.infer<typeof SecurityErrorSchema>;

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
} as const;

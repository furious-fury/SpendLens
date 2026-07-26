import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type {
  AuthenticatedUser,
  ChangePasswordRequest,
  RecoveryKit,
  SecurityState,
  SetupRequest,
} from "@spendlens/contracts";
import {
  type DatabaseKeyProvider,
  databaseExists,
  type EncryptedDatabase,
  type EncryptedDatabaseOptions,
  createEncryptedDatabase,
  openEncryptedDatabase,
  securityEvents,
  sessions,
  users,
  workspaces,
} from "@spendlens/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  createRecoveryKit,
  hashPassword,
  hashSecret,
  randomToken,
  safeEqual,
  verifyPassword,
} from "./crypto.js";
import { LoginRateLimiter } from "./rate-limiter.js";
import { SecurityError } from "./security-error.js";
import { SetupTokenManager } from "./setup-token.js";

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface SecurityServiceOptions extends EncryptedDatabaseOptions {
  setupTokenPath: string;
  clock?: () => number;
  rateLimiter?: LoginRateLimiter;
}

export interface SessionCredentials {
  sessionToken: string;
  csrfToken: string;
  user: AuthenticatedUser;
  sessionExpiresAt: Date;
}

interface ValidSession {
  id: string;
  csrfTokenHash: string;
  expiresAt: Date;
  user: AuthenticatedUser;
}

export class SecurityService {
  readonly #databaseOptions: EncryptedDatabaseOptions;
  readonly #setupToken: SetupTokenManager;
  readonly #clock: () => number;
  readonly #rateLimiter: LoginRateLimiter;
  #database: EncryptedDatabase | null = null;

  private constructor(options: SecurityServiceOptions) {
    this.#databaseOptions = {
      filePath: options.filePath,
      keyProvider: options.keyProvider,
    };
    this.#setupToken = new SetupTokenManager(options.setupTokenPath);
    this.#clock = options.clock ?? Date.now;
    this.#rateLimiter = options.rateLimiter ?? new LoginRateLimiter(this.#clock);
  }

  static async create(options: SecurityServiceOptions): Promise<SecurityService> {
    const service = new SecurityService(options);
    if (await databaseExists(options.filePath)) {
      service.#database = await openEncryptedDatabase(service.#databaseOptions);
      if (!service.#workspace()?.setupCompletedAt) {
        await service.#setupToken.ensure();
      }
    } else {
      await service.#setupToken.ensure();
    }
    return service;
  }

  get keyProviderKind(): "keyring" | "secret-file" {
    const kind = this.#databaseOptions.keyProvider.kind;
    if (kind === "memory") {
      return "keyring";
    }
    return kind;
  }

  async state(sessionToken?: string): Promise<SecurityState> {
    if (!this.#database) {
      return {
        status: "setup-required",
        setupPhase: "new",
        keyMode: this.keyProviderKind,
      };
    }

    if (!this.#workspace()?.setupCompletedAt) {
      return {
        status: "setup-required",
        setupPhase: "recovery-confirmation",
        keyMode: this.keyProviderKind,
      };
    }

    const session = sessionToken ? this.#findSession(sessionToken) : null;
    if (!session) {
      return { status: "unauthenticated" };
    }

    return {
      status: "authenticated",
      user: session.user,
      sessionExpiresAt: session.expiresAt.toISOString(),
    };
  }

  async prepareSetup(input: SetupRequest, remoteAddress: string): Promise<RecoveryKit> {
    if (!(await this.#setupToken.verify(input.setupToken))) {
      throw new SecurityError("INVALID_SETUP_TOKEN", "The setup token is incorrect.", 403);
    }
    if (this.#workspace()?.setupCompletedAt) {
      throw new SecurityError("SETUP_ALREADY_COMPLETE", "Workspace setup is complete.", 409);
    }
    if (this.#database) {
      await this.#resetIncompleteSetup();
    }

    const passwordHash = await hashPassword(input.password);
    const database = await createEncryptedDatabase(this.#databaseOptions);
    const workspaceId = randomUUID();
    const userId = randomUUID();
    const now = new Date(this.#clock());

    try {
      database.sqlite.transaction(() => {
        database.db
          .insert(workspaces)
          .values({
            id: workspaceId,
            name: input.workspaceName,
            timezone: input.timezone,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        database.db
          .insert(users)
          .values({
            id: userId,
            workspaceId,
            username: "owner",
            displayName: input.displayName,
            passwordHash,
            passwordChangedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      })();
      this.#database = database;
      this.#recordEvent("workspace.setup_prepared", "success", remoteAddress, workspaceId, userId);
      return createRecoveryKit(workspaceId, database.key);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  async completeSetup(
    setupToken: string,
    recoveryConfirmed: boolean,
    remoteAddress: string,
    userAgent?: string,
  ): Promise<SessionCredentials> {
    if (!this.#database || !this.#workspace()) {
      throw new SecurityError("SETUP_NOT_STARTED", "Start workspace setup first.", 409);
    }
    if (this.#workspace()?.setupCompletedAt) {
      throw new SecurityError("SETUP_ALREADY_COMPLETE", "Workspace setup is complete.", 409);
    }
    if (!recoveryConfirmed) {
      throw new SecurityError(
        "RECOVERY_NOT_CONFIRMED",
        "Save the recovery file and recovery code before continuing.",
        400,
      );
    }
    if (!(await this.#setupToken.verify(setupToken))) {
      throw new SecurityError("INVALID_SETUP_TOKEN", "The setup token is incorrect.", 403);
    }

    const now = new Date(this.#clock());
    const workspace = this.#workspace();
    const user = this.#owner();
    if (!workspace || !user) {
      throw new SecurityError("SETUP_INVALID", "Workspace setup data is incomplete.", 500);
    }

    this.#database.db
      .update(workspaces)
      .set({ setupCompletedAt: now, updatedAt: now })
      .where(eq(workspaces.id, workspace.id))
      .run();
    await this.#setupToken.consume();
    this.#recordEvent("workspace.setup_completed", "success", remoteAddress, workspace.id, user.id);
    return this.#createSession(user, remoteAddress, userAgent);
  }

  async login(
    password: string,
    remoteAddress: string,
    userAgent?: string,
  ): Promise<SessionCredentials> {
    const database = this.#readyDatabase();
    const rateKey = hashSecret(`login:${remoteAddress}`);
    const rateLimit = this.#rateLimiter.check(rateKey);
    if (!rateLimit.allowed) {
      this.#recordEvent("auth.login", "failure", remoteAddress);
      throw new SecurityError(
        "LOGIN_RATE_LIMITED",
        "Too many login attempts. Try again later.",
        429,
        rateLimit.retryAfterSeconds,
      );
    }

    const user = database.db.select().from(users).limit(1).get();
    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      const failureLimit = this.#rateLimiter.recordFailure(rateKey);
      this.#recordEvent("auth.login", "failure", remoteAddress, user?.workspaceId, user?.id);
      if (!failureLimit.allowed) {
        throw new SecurityError(
          "LOGIN_RATE_LIMITED",
          "Too many login attempts. Try again later.",
          429,
          failureLimit.retryAfterSeconds,
        );
      }
      throw new SecurityError("INVALID_CREDENTIALS", "The password is incorrect.", 401);
    }

    this.#rateLimiter.reset(rateKey);
    this.#recordEvent("auth.login", "success", remoteAddress, user.workspaceId, user.id);
    return this.#createSession(user, remoteAddress, userAgent);
  }

  authenticate(sessionToken?: string): ValidSession {
    if (!sessionToken) {
      throw new SecurityError("AUTHENTICATION_REQUIRED", "Sign in to continue.", 401);
    }
    const session = this.#findSession(sessionToken);
    if (!session) {
      throw new SecurityError("SESSION_INVALID", "Your session has expired. Sign in again.", 401);
    }
    return session;
  }

  verifyCsrf(session: ValidSession, cookieToken?: string, headerToken?: string): void {
    if (
      !cookieToken ||
      !headerToken ||
      !safeEqual(cookieToken, headerToken) ||
      !safeEqual(hashSecret(headerToken), session.csrfTokenHash)
    ) {
      throw new SecurityError(
        "CSRF_VALIDATION_FAILED",
        "The security token for this request is invalid.",
        403,
      );
    }
  }

  logout(session: ValidSession, remoteAddress: string): void {
    const database = this.#readyDatabase();
    database.db
      .update(sessions)
      .set({ revokedAt: new Date(this.#clock()) })
      .where(eq(sessions.id, session.id))
      .run();
    this.#recordEvent("auth.logout", "success", remoteAddress, undefined, session.user.id);
  }

  revokeAllSessions(session: ValidSession, remoteAddress: string): void {
    const database = this.#readyDatabase();
    database.db
      .update(sessions)
      .set({ revokedAt: new Date(this.#clock()) })
      .where(and(eq(sessions.userId, session.user.id), isNull(sessions.revokedAt)))
      .run();
    this.#recordEvent(
      "auth.sessions_revoked",
      "success",
      remoteAddress,
      undefined,
      session.user.id,
    );
  }

  async changePassword(
    session: ValidSession,
    input: ChangePasswordRequest,
    remoteAddress: string,
    userAgent?: string,
  ): Promise<SessionCredentials> {
    const database = this.#readyDatabase();
    const user = database.db.select().from(users).where(eq(users.id, session.user.id)).get();
    if (!user || !(await verifyPassword(user.passwordHash, input.currentPassword))) {
      this.#recordEvent(
        "auth.password_change",
        "failure",
        remoteAddress,
        user?.workspaceId,
        user?.id,
      );
      throw new SecurityError("INVALID_CREDENTIALS", "The current password is incorrect.", 401);
    }

    const now = new Date(this.#clock());
    const passwordHash = await hashPassword(input.password);
    database.sqlite.transaction(() => {
      database.db
        .update(users)
        .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
        .where(eq(users.id, user.id))
        .run();
      database.db
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
        .run();
    })();
    this.#recordEvent("auth.password_change", "success", remoteAddress, user.workspaceId, user.id);
    return this.#createSession(user, remoteAddress, userAgent);
  }

  async rekeyDatabase(
    session: ValidSession,
    password: string,
    remoteAddress: string,
  ): Promise<RecoveryKit> {
    const database = this.#readyDatabase();
    const user = database.db.select().from(users).where(eq(users.id, session.user.id)).get();
    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      this.#recordEvent("database.rekey", "failure", remoteAddress, user?.workspaceId, user?.id);
      throw new SecurityError("INVALID_CREDENTIALS", "The password is incorrect.", 401);
    }

    await database.rekey();
    this.#recordEvent("database.rekey", "success", remoteAddress, user.workspaceId, user.id);
    return createRecoveryKit(user.workspaceId, database.key);
  }

  close(): void {
    this.#database?.close();
    this.#database = null;
  }

  async #resetIncompleteSetup(): Promise<void> {
    this.#database?.close();
    this.#database = null;
    await Promise.all([
      rm(this.#databaseOptions.filePath, { force: true }),
      rm(`${this.#databaseOptions.filePath}-wal`, { force: true }),
      rm(`${this.#databaseOptions.filePath}-shm`, { force: true }),
    ]);
    if (this.#databaseOptions.keyProvider.kind !== "secret-file") {
      await this.#databaseOptions.keyProvider.remove();
    }
  }

  #readyDatabase(): EncryptedDatabase {
    const workspace = this.#workspace();
    if (!this.#database || !workspace?.setupCompletedAt) {
      throw new SecurityError("SETUP_REQUIRED", "Complete workspace setup first.", 409);
    }
    return this.#database;
  }

  #workspace() {
    return this.#database?.db.select().from(workspaces).limit(1).get() ?? null;
  }

  #owner() {
    return this.#database?.db.select().from(users).limit(1).get() ?? null;
  }

  #findSession(token: string): ValidSession | null {
    const database = this.#readyDatabase();
    const now = new Date(this.#clock());
    const result = database.db
      .select({
        id: sessions.id,
        csrfTokenHash: sessions.csrfTokenHash,
        expiresAt: sessions.expiresAt,
        userId: users.id,
        displayName: users.displayName,
        username: users.username,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(
        and(
          eq(sessions.tokenHash, hashSecret(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
        ),
      )
      .get();

    if (!result) {
      return null;
    }

    database.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, result.id)).run();

    return {
      id: result.id,
      csrfTokenHash: result.csrfTokenHash,
      expiresAt: result.expiresAt,
      user: {
        id: result.userId,
        displayName: result.displayName,
        username: result.username,
      },
    };
  }

  #createSession(
    user: {
      id: string;
      displayName: string;
      username: string;
    },
    remoteAddress: string,
    userAgent?: string,
  ): SessionCredentials {
    const database = this.#readyDatabase();
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const now = new Date(this.#clock());
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    database.db
      .insert(sessions)
      .values({
        id: randomUUID(),
        userId: user.id,
        tokenHash: hashSecret(sessionToken),
        csrfTokenHash: hashSecret(csrfToken),
        ipHash: hashSecret(`ip:${remoteAddress}`),
        userAgentHash: userAgent ? hashSecret(`ua:${userAgent}`) : null,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
      })
      .run();

    return {
      sessionToken,
      csrfToken,
      user: {
        id: user.id,
        displayName: user.displayName,
        username: user.username,
      },
      sessionExpiresAt: expiresAt,
    };
  }

  #recordEvent(
    eventType: string,
    outcome: "success" | "failure",
    remoteAddress: string,
    workspaceId?: string,
    userId?: string,
  ): void {
    this.#database?.db
      .insert(securityEvents)
      .values({
        id: randomUUID(),
        workspaceId,
        userId,
        eventType,
        outcome,
        remoteAddressHash: hashSecret(`event-ip:${remoteAddress}`),
        createdAt: new Date(this.#clock()),
      })
      .run();
  }
}

export function keyProviderForTests(provider: DatabaseKeyProvider): DatabaseKeyProvider {
  return provider;
}

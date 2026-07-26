import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { apiPaths, RecoveryFileSchema } from "@spendlens/contracts";
import { AiProviderStore, MemoryKeyProvider, openEncryptedDatabase } from "@spendlens/db";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createRecoveryKit, unwrapDatabaseKey } from "../src/security/crypto.js";
import { recoverWorkspace } from "../src/security/maintenance-recovery.js";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from "../src/security/security-routes.js";
import { SecurityService } from "../src/security/security-service.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("security setup and authentication", () => {
  it("requires recovery confirmation and creates a persistent login-protected workspace", async () => {
    const fixture = await createFixture();
    const setupToken = await readFile(fixture.setupTokenPath, "utf8");

    expect(await requestJson(fixture.app, apiPaths.securityState)).toMatchObject({
      status: 200,
      body: { status: "setup-required", setupPhase: "new" },
    });

    const prepared = await requestJson(fixture.app, apiPaths.setup, {
      method: "POST",
      body: setupBody(setupToken),
    });
    expect(prepared.status).toBe(201);
    expect(prepared.body).toMatchObject({
      status: "recovery-required",
      recoveryKit: {
        recoveryCode: expect.any(String),
        recoveryFile: { type: "spendlens-recovery-key" },
      },
    });

    const rejected = await requestJson(fixture.app, apiPaths.setupComplete, {
      method: "POST",
      body: { setupToken, recoveryConfirmed: false },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: { code: "VALIDATION_FAILED" } });

    const completed = await rawJsonRequest(fixture.app, apiPaths.setupComplete, {
      method: "POST",
      body: { setupToken, recoveryConfirmed: true },
    });
    expect(completed.response.status).toBe(200);
    const setCookies = completed.response.headers.getSetCookie();
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${SESSION_COOKIE}=`) &&
          cookie.includes("HttpOnly") &&
          cookie.includes("SameSite=Strict"),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${CSRF_COOKIE}=`) &&
          !cookie.includes("HttpOnly") &&
          cookie.includes("SameSite=Strict"),
      ),
    ).toBe(true);
    const cookies = cookieJar(completed.response);
    expect(cookies[SESSION_COOKIE]).toBeTruthy();
    expect(cookies[CSRF_COOKIE]).toBeTruthy();

    const authenticated = await requestJson(fixture.app, apiPaths.securityState, {
      cookie: cookieHeader(cookies),
    });
    expect(authenticated.body).toMatchObject({
      status: "authenticated",
      user: { displayName: "Fury", username: "owner" },
    });

    fixture.security.close();
    const restarted = await SecurityService.create({
      filePath: fixture.databasePath,
      keyProvider: fixture.keyProvider,
      setupTokenPath: fixture.setupTokenPath,
    });
    expect(await restarted.state()).toEqual({ status: "unauthenticated" });
    restarted.close();
  });

  it("requires authentication and a matching CSRF token for protected mutations", async () => {
    const fixture = await initializedFixture();
    const unauthenticated = await requestJson(fixture.app, apiPaths.logoutAll, {
      method: "POST",
    });
    expect(unauthenticated.status).toBe(401);

    const login = await rawJsonRequest(fixture.app, apiPaths.login, {
      method: "POST",
      body: { password: "correct horse battery staple" },
    });
    const cookies = cookieJar(login.response);

    const missingCsrf = await requestJson(fixture.app, apiPaths.logoutAll, {
      method: "POST",
      cookie: cookieHeader(cookies),
    });
    expect(missingCsrf.status).toBe(403);
    expect(missingCsrf.body).toMatchObject({ error: { code: "CSRF_VALIDATION_FAILED" } });

    const revoked = await requestJson(fixture.app, apiPaths.logoutAll, {
      method: "POST",
      cookie: cookieHeader(cookies),
      csrf: requiredCookie(cookies, CSRF_COOKIE),
    });
    expect(revoked.status).toBe(204);

    const staleSession = await requestJson(fixture.app, apiPaths.securityState, {
      cookie: cookieHeader(cookies),
    });
    expect(staleSession.body).toEqual({ status: "unauthenticated" });
    fixture.security.close();
  });

  it("can safely restart an unconfirmed setup and issue fresh recovery material", async () => {
    const fixture = await createFixture();
    const setupToken = await readFile(fixture.setupTokenPath, "utf8");
    const firstKit = await fixture.security.prepareSetup(setupBody(setupToken), "local");
    fixture.security.close();

    const restarted = await SecurityService.create({
      filePath: fixture.databasePath,
      keyProvider: fixture.keyProvider,
      setupTokenPath: fixture.setupTokenPath,
    });
    expect(await restarted.state()).toMatchObject({
      status: "setup-required",
      setupPhase: "recovery-confirmation",
    });

    const replacementKit = await restarted.prepareSetup(setupBody(setupToken), "local");
    expect(replacementKit.recoveryCode).not.toBe(firstKit.recoveryCode);
    await expect(restarted.completeSetup(setupToken, true, "local")).resolves.toMatchObject({
      user: { username: "owner" },
    });
    restarted.close();
  });

  it("rate limits repeated wrong passwords without exposing account details", async () => {
    const fixture = await initializedFixture();
    const responses = [];

    for (let attempt = 0; attempt < 5; attempt += 1) {
      responses.push(
        await requestJson(fixture.app, apiPaths.login, {
          method: "POST",
          body: { password: "definitely wrong" },
        }),
      );
    }

    expect(responses.slice(0, 4).every((response) => response.status === 401)).toBe(true);
    expect(responses[4]).toMatchObject({
      status: 429,
      body: { error: { code: "LOGIN_RATE_LIMITED" } },
    });
    expect(responses[4]?.headers.get("retry-after")).toBeTruthy();
    fixture.security.close();
  });

  it("changes the password and revokes the prior session", async () => {
    const fixture = await initializedFixture();
    const login = await rawJsonRequest(fixture.app, apiPaths.login, {
      method: "POST",
      body: { password: "correct horse battery staple" },
    });
    const oldCookies = cookieJar(login.response);

    const changed = await rawJsonRequest(fixture.app, apiPaths.changePassword, {
      method: "PUT",
      body: {
        currentPassword: "correct horse battery staple",
        password: "a different secure passphrase",
        confirmPassword: "a different secure passphrase",
      },
      cookie: cookieHeader(oldCookies),
      csrf: requiredCookie(oldCookies, CSRF_COOKIE),
    });
    expect(changed.response.status).toBe(200);

    const stale = await requestJson(fixture.app, apiPaths.securityState, {
      cookie: cookieHeader(oldCookies),
    });
    expect(stale.body).toEqual({ status: "unauthenticated" });

    const oldLogin = await requestJson(fixture.app, apiPaths.login, {
      method: "POST",
      body: { password: "correct horse battery staple" },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await requestJson(fixture.app, apiPaths.login, {
      method: "POST",
      body: { password: "a different secure passphrase" },
    });
    expect(newLogin.status).toBe(200);
    fixture.security.close();
  });

  it("re-encrypts self-hosted provider credentials during database key rotation", async () => {
    const fixture = await initializedFixture();
    const login = await rawJsonRequest(fixture.app, apiPaths.login, {
      method: "POST",
      body: { password: "correct horse battery staple" },
    });
    const cookies = cookieJar(login.response);
    const sqlite = fixture.security.sqlite;
    if (!sqlite) throw new Error("Expected an initialized database.");
    const workspace = sqlite.prepare("SELECT id FROM workspaces LIMIT 1").get() as {
      id: string;
    };
    const providers = new AiProviderStore({
      sqlite,
      credentialStorage: "encrypted_database",
      encryptionKey: () => fixture.security.aiCredentialKey(),
    });
    const provider = await providers.create(workspace.id, {
      name: "Remote",
      provider: "openai_compatible",
      endpoint: "https://provider.example/v1",
      model: "model",
      timeoutMs: 30_000,
      enabled: true,
      localModel: false,
      payloadPolicy: "remote_redacted",
      apiKey: "rotation-secret",
      acknowledgeRemotePayload: true,
    });
    fixture.security.registerDatabaseRekeyHook((previousKey, nextKey) =>
      providers.rotateEncryptionKey(previousKey, nextKey),
    );
    const before = sqlite
      .prepare("SELECT credential_ciphertext AS ciphertext FROM ai_provider_settings WHERE id = ?")
      .get(provider.id) as { ciphertext: string };

    const response = await requestJson(fixture.app, apiPaths.rekey, {
      method: "POST",
      body: { password: "correct horse battery staple" },
      cookie: cookieHeader(cookies),
      csrf: requiredCookie(cookies, CSRF_COOKIE),
    });
    expect(response.status).toBe(200);
    const after = sqlite
      .prepare("SELECT credential_ciphertext AS ciphertext FROM ai_provider_settings WHERE id = ?")
      .get(provider.id) as { ciphertext: string };
    expect(after.ciphertext).not.toBe(before.ciphertext);
    await expect(providers.credential(workspace.id, provider.id)).resolves.toBe("rotation-secret");
    fixture.security.close();
  });
});

describe("recovery material", () => {
  it("requires both the recovery file and separate code to unwrap the database key", async () => {
    const databaseKey = Buffer.alloc(32, 42);
    const kit = await createRecoveryKit(crypto.randomUUID(), databaseKey);
    const parsedFile = RecoveryFileSchema.parse(JSON.parse(JSON.stringify(kit.recoveryFile)));

    await expect(unwrapDatabaseKey(parsedFile, kit.recoveryCode)).resolves.toEqual(databaseKey);
    await expect(unwrapDatabaseKey(parsedFile, "WRONG-CODE")).rejects.toThrow(
      "recovery file or recovery code is incorrect",
    );
    expect(JSON.stringify(parsedFile)).not.toContain(databaseKey.toString("hex"));
  });

  it("restores a clean machine and snapshots the encrypted database before changing access", async () => {
    const source = await createFixture();
    const setupToken = await readFile(source.setupTokenPath, "utf8");
    const recoveryKit = await source.security.prepareSetup(setupBody(setupToken), "local");
    await source.security.completeSetup(setupToken, true, "local");
    source.security.close();

    const restoredDatabasePath = join(
      process.env.TMPDIR ?? "/tmp",
      `spendlens-restored-${crypto.randomUUID()}.db`,
    );
    const safetyBackupPath = `${restoredDatabasePath}.before-password-change`;
    temporaryPaths.push(restoredDatabasePath, safetyBackupPath);
    await copyFile(source.databasePath, restoredDatabasePath);

    const cleanMachineKeyring = new MemoryKeyProvider();
    const result = await recoverWorkspace({
      databasePath: restoredDatabasePath,
      recoveryFile: recoveryKit.recoveryFile,
      recoveryCode: recoveryKit.recoveryCode,
      newPassword: "replacement recovery password",
      keyProvider: cleanMachineKeyring,
      backupPath: safetyBackupPath,
    });
    expect(result.backupPath).toBe(safetyBackupPath);
    await expect(stat(safetyBackupPath)).resolves.toMatchObject({ size: expect.any(Number) });

    await expect(
      openEncryptedDatabase({
        filePath: safetyBackupPath,
        keyProvider: new MemoryKeyProvider(),
      }),
    ).rejects.toThrow("key is unavailable");

    const restoredSecurity = await SecurityService.create({
      filePath: restoredDatabasePath,
      keyProvider: cleanMachineKeyring,
      setupTokenPath: `${restoredDatabasePath}.setup-token`,
    });
    await expect(restoredSecurity.login("replacement recovery password", "local")).resolves.toEqual(
      expect.objectContaining({ user: expect.objectContaining({ username: "owner" }) }),
    );
    await expect(restoredSecurity.login("correct horse battery staple", "local")).rejects.toThrow(
      "password is incorrect",
    );
    restoredSecurity.close();

    await expect(
      recoverWorkspace({
        databasePath: `${restoredDatabasePath}.missing`,
        recoveryFile: recoveryKit.recoveryFile,
        recoveryCode: recoveryKit.recoveryCode,
        newPassword: "replacement recovery password",
        keyProvider: new MemoryKeyProvider(),
      }),
    ).rejects.toThrow("database backup does not exist");
  });
});

async function initializedFixture() {
  const fixture = await createFixture();
  const setupToken = await readFile(fixture.setupTokenPath, "utf8");
  await requestJson(fixture.app, apiPaths.setup, {
    method: "POST",
    body: setupBody(setupToken),
  });
  await requestJson(fixture.app, apiPaths.setupComplete, {
    method: "POST",
    body: { setupToken, recoveryConfirmed: true },
  });
  return fixture;
}

async function createFixture() {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    `spendlens-security-test-${crypto.randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  temporaryPaths.push(directory);
  const databasePath = join(directory, "spendlens.db");
  const setupTokenPath = join(directory, "setup-token");
  const keyProvider = new MemoryKeyProvider();
  const security = await SecurityService.create({
    filePath: databasePath,
    keyProvider,
    setupTokenPath,
  });
  return {
    app: createApp({ security }),
    security,
    databasePath,
    setupTokenPath,
    keyProvider,
  };
}

function setupBody(setupToken: string) {
  return {
    setupToken,
    workspaceName: "My SpendLens",
    displayName: "Fury",
    password: "correct horse battery staple",
    confirmPassword: "correct horse battery staple",
    timezone: "Africa/Lagos",
  };
}

async function requestJson(
  app: ReturnType<typeof createApp>,
  path: string,
  options: RequestOptions = {},
) {
  const result = await rawJsonRequest(app, path, options);
  return {
    status: result.response.status,
    headers: result.response.headers,
    body:
      result.response.status === 204
        ? null
        : ((await result.response.json()) as Record<string, unknown>),
  };
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  cookie?: string;
  csrf?: string;
}

async function rawJsonRequest(
  app: ReturnType<typeof createApp>,
  path: string,
  options: RequestOptions = {},
) {
  const headers = new Headers();
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.cookie) {
    headers.set("cookie", options.cookie);
  }
  if (options.csrf) {
    headers.set(CSRF_HEADER, options.csrf);
  }

  const response = await app.request(path, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { response };
}

function cookieJar(response: Response): Record<string, string> {
  return Object.fromEntries(
    response.headers.getSetCookie().map((cookie) => {
      const [pair] = cookie.split(";", 1);
      const [name, ...value] = pair?.split("=") ?? [];
      return [name ?? "", decodeURIComponent(value.join("="))];
    }),
  );
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

function requiredCookie(cookies: Record<string, string>, name: string): string {
  const value = cookies[name];
  if (!value) {
    throw new Error(`Expected the ${name} cookie.`);
  }
  return value;
}

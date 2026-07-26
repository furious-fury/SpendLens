import { randomUUID } from "node:crypto";
import type { AiProviderInput } from "@spendlens/contracts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AiProviderStore,
  applyMigrations,
  type CredentialEntry,
  deriveAiCredentialKey,
} from "../src/index.js";

const WORKSPACE_ID = randomUUID();

describe("AI provider credential storage", () => {
  it("stores desktop credentials in the OS credential entry without database plaintext", async () => {
    const sqlite = fixture();
    const credentials = new Map<string, string>();
    const store = new AiProviderStore({
      sqlite,
      credentialStorage: "keyring",
      credentialEntry: (_workspaceId, settingId) => mapEntry(credentials, settingId),
    });
    const setting = await store.create(WORKSPACE_ID, remoteInput("desktop-secret"));

    expect(await store.credential(WORKSPACE_ID, setting.id)).toBe("desktop-secret");
    expect(credentials.get(setting.id)).toBe("desktop-secret");
    expect(
      sqlite
        .prepare(
          `SELECT credential_ciphertext AS ciphertext,
                  credential_nonce AS nonce,
                  credential_auth_tag AS authTag
           FROM ai_provider_settings WHERE id = ?`,
        )
        .get(setting.id),
    ).toEqual({ ciphertext: null, nonce: null, authTag: null });
    expect(
      JSON.stringify(sqlite.prepare("SELECT * FROM ai_provider_settings").all()),
    ).not.toContain("desktop-secret");
    sqlite.close();
  });

  it("encrypts self-hosted credentials with a derived key and survives key rotation", async () => {
    const sqlite = fixture();
    let encryptionKey = deriveAiCredentialKey(Buffer.alloc(32, 7));
    const store = new AiProviderStore({
      sqlite,
      credentialStorage: "encrypted_database",
      encryptionKey: () => encryptionKey,
    });
    const setting = await store.create(WORKSPACE_ID, remoteInput("server-secret"));
    const before = sqlite
      .prepare(
        `SELECT credential_ciphertext AS ciphertext
         FROM ai_provider_settings WHERE id = ?`,
      )
      .get(setting.id) as { ciphertext: string };

    expect(before.ciphertext).not.toContain("server-secret");
    expect(await store.credential(WORKSPACE_ID, setting.id)).toBe("server-secret");
    const nextKey = deriveAiCredentialKey(Buffer.alloc(32, 9));
    store.rotateEncryptionKey(encryptionKey, nextKey);
    encryptionKey = nextKey;

    const after = sqlite
      .prepare(
        `SELECT credential_ciphertext AS ciphertext
         FROM ai_provider_settings WHERE id = ?`,
      )
      .get(setting.id) as { ciphertext: string };
    expect(after.ciphertext).not.toBe(before.ciphertext);
    expect(await store.credential(WORKSPACE_ID, setting.id)).toBe("server-secret");
    expect(
      JSON.stringify(sqlite.prepare("SELECT * FROM ai_provider_settings").all()),
    ).not.toContain("server-secret");
    sqlite.close();
  });
});

function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      `INSERT INTO workspaces (id, name, timezone, setup_completed_at, created_at, updated_at)
       VALUES (?, 'SpendLens', 'Africa/Lagos', 1, 1, 1)`,
    )
    .run(WORKSPACE_ID);
  return sqlite;
}

function remoteInput(apiKey: string): AiProviderInput {
  return {
    name: "OpenAI",
    provider: "openai_compatible",
    endpoint: "https://api.openai.com/v1",
    model: "model",
    timeoutMs: 30_000,
    enabled: true,
    localModel: false,
    payloadPolicy: "remote_redacted",
    apiKey,
    acknowledgeRemotePayload: true,
  };
}

function mapEntry(values: Map<string, string>, key: string): CredentialEntry {
  return {
    getPassword: () => values.get(key) ?? null,
    setPassword: (password) => values.set(key, password),
    deletePassword: () => {
      values.delete(key);
    },
  };
}

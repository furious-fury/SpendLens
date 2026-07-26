import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { Entry } from "@napi-rs/keyring";
import type {
  AiProviderInput,
  AiProviderKind,
  AiProviderSetting,
  AiProviderUpdate,
} from "@spendlens/contracts";
import { AiProviderInputSchema } from "@spendlens/contracts";
import type Database from "better-sqlite3";

const CREDENTIAL_KEY_INFO = "spendlens/ai-provider-credentials/v1";
const CREDENTIAL_KEYRING_SERVICE = "SpendLens AI providers";

export interface CredentialEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): void;
}

export interface AiProviderStoreOptions {
  sqlite: Database.Database | (() => Database.Database);
  credentialStorage: "keyring" | "encrypted_database";
  encryptionKey?: () => Buffer;
  credentialEntry?: (workspaceId: string, settingId: string) => CredentialEntry;
  clock?: () => number;
}

interface SettingRow {
  id: string;
  workspace_id: string;
  name: string;
  provider: AiProviderKind;
  endpoint: string;
  model: string;
  timeout_ms: number;
  enabled: number;
  local_model: number;
  payload_policy: "remote_redacted" | "local_full";
  credential_storage: "keyring" | "encrypted_database";
  credential_ciphertext: string | null;
  credential_nonce: string | null;
  credential_auth_tag: string | null;
  has_credential: number;
  remote_payload_acknowledged_at: number | null;
  created_at: number;
  updated_at: number;
}

export type AiProviderStoreErrorCode =
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_PROVIDER_DUPLICATE"
  | "AI_PROVIDER_CREDENTIAL_REQUIRED"
  | "AI_PROVIDER_CREDENTIAL_UNAVAILABLE"
  | "AI_PROVIDER_INVALID";

export class AiProviderStoreError extends Error {
  constructor(
    readonly code: AiProviderStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiProviderStoreError";
  }
}

export function deriveAiCredentialKey(databaseKey: Buffer): Buffer {
  if (databaseKey.length !== 32) {
    throw new Error("The database key must contain exactly 32 bytes.");
  }
  return Buffer.from(
    hkdfSync("sha256", databaseKey, Buffer.from("SpendLens"), CREDENTIAL_KEY_INFO, 32),
  );
}

export class AiProviderStore {
  readonly #sqlite: () => Database.Database;
  readonly #credentialStorage: "keyring" | "encrypted_database";
  readonly #encryptionKey: (() => Buffer) | undefined;
  readonly #credentialEntry: (workspaceId: string, settingId: string) => CredentialEntry;
  readonly #clock: () => number;

  constructor(options: AiProviderStoreOptions) {
    const sqlite = options.sqlite;
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#credentialStorage = options.credentialStorage;
    this.#encryptionKey = options.encryptionKey;
    this.#credentialEntry =
      options.credentialEntry ??
      ((workspaceId, settingId) =>
        new Entry(CREDENTIAL_KEYRING_SERVICE, `${workspaceId}:${settingId}`));
    this.#clock = options.clock ?? Date.now;
    if (this.#credentialStorage === "encrypted_database" && !this.#encryptionKey) {
      throw new Error("Encrypted provider credentials require a database-derived subkey.");
    }
  }

  list(workspaceId: string): AiProviderSetting[] {
    return (
      this.#sqlite()
        .prepare(
          `SELECT * FROM ai_provider_settings
           WHERE workspace_id = ?
           ORDER BY provider, name, id`,
        )
        .all(workspaceId) as SettingRow[]
    ).map(toPublicSetting);
  }

  get(workspaceId: string, settingId: string): AiProviderSetting | null {
    const row = this.#row(workspaceId, settingId);
    return row ? toPublicSetting(row) : null;
  }

  async create(workspaceId: string, rawInput: AiProviderInput): Promise<AiProviderSetting> {
    const input = AiProviderInputSchema.parse(rawInput);
    const sqlite = this.#sqlite();
    if (
      sqlite
        .prepare("SELECT 1 FROM ai_provider_settings WHERE workspace_id = ? AND provider = ?")
        .get(workspaceId, input.provider)
    ) {
      throw new AiProviderStoreError(
        "AI_PROVIDER_DUPLICATE",
        "A configuration for this provider already exists.",
      );
    }
    if (input.enabled && !input.localModel && !input.apiKey) {
      throw new AiProviderStoreError(
        "AI_PROVIDER_CREDENTIAL_REQUIRED",
        "Add an API key before enabling a remote provider.",
      );
    }
    const id = randomUUID();
    const now = this.#clock();
    sqlite
      .prepare(
        `INSERT INTO ai_provider_settings (
          id, workspace_id, name, provider, endpoint, model, timeout_ms, enabled,
          local_model, payload_policy, credential_storage, has_credential,
          remote_payload_acknowledged_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        input.name,
        input.provider,
        normalizedEndpoint(input.endpoint),
        input.model,
        input.timeoutMs,
        input.enabled ? 1 : 0,
        input.localModel ? 1 : 0,
        input.payloadPolicy,
        this.#credentialStorage,
        !input.localModel && input.acknowledgeRemotePayload ? now : null,
        now,
        now,
      );
    try {
      if (input.apiKey) await this.#saveCredential(workspaceId, id, input.apiKey);
    } catch (error) {
      sqlite.prepare("DELETE FROM ai_provider_settings WHERE id = ?").run(id);
      throw error;
    }
    return this.#required(workspaceId, id);
  }

  async update(
    workspaceId: string,
    settingId: string,
    changes: AiProviderUpdate,
  ): Promise<AiProviderSetting> {
    const existing = this.#row(workspaceId, settingId);
    if (!existing) {
      throw new AiProviderStoreError("AI_PROVIDER_NOT_FOUND", "The AI provider was not found.");
    }
    if (changes.apiKey && changes.clearApiKey) {
      throw new AiProviderStoreError(
        "AI_PROVIDER_INVALID",
        "Choose either a replacement API key or clearing the existing key.",
      );
    }
    if (
      changes.provider &&
      changes.provider !== existing.provider &&
      this.#sqlite()
        .prepare(
          `SELECT 1 FROM ai_provider_settings
           WHERE workspace_id = ? AND provider = ? AND id <> ?`,
        )
        .get(workspaceId, changes.provider, settingId)
    ) {
      throw new AiProviderStoreError(
        "AI_PROVIDER_DUPLICATE",
        "A configuration for this provider already exists.",
      );
    }
    const acknowledged =
      changes.acknowledgeRemotePayload ?? existing.remote_payload_acknowledged_at !== null;
    const merged = AiProviderInputSchema.parse({
      name: changes.name ?? existing.name,
      provider: changes.provider ?? existing.provider,
      endpoint: changes.endpoint ?? existing.endpoint,
      model: changes.model ?? existing.model,
      timeoutMs: changes.timeoutMs ?? existing.timeout_ms,
      enabled: changes.enabled ?? Boolean(existing.enabled),
      localModel: changes.localModel ?? Boolean(existing.local_model),
      payloadPolicy: changes.payloadPolicy ?? existing.payload_policy,
      acknowledgeRemotePayload: acknowledged,
      ...(changes.apiKey ? { apiKey: changes.apiKey } : {}),
    });
    const willHaveCredential = changes.clearApiKey
      ? false
      : Boolean(changes.apiKey) || Boolean(existing.has_credential);
    if (merged.enabled && !merged.localModel && !willHaveCredential) {
      throw new AiProviderStoreError(
        "AI_PROVIDER_CREDENTIAL_REQUIRED",
        "Add an API key before enabling a remote provider.",
      );
    }
    const now = this.#clock();
    this.#sqlite()
      .prepare(
        `UPDATE ai_provider_settings SET
          name = ?, provider = ?, endpoint = ?, model = ?, timeout_ms = ?,
          enabled = ?, local_model = ?, payload_policy = ?,
          remote_payload_acknowledged_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        merged.name,
        merged.provider,
        normalizedEndpoint(merged.endpoint),
        merged.model,
        merged.timeoutMs,
        merged.enabled ? 1 : 0,
        merged.localModel ? 1 : 0,
        merged.payloadPolicy,
        !merged.localModel && acknowledged
          ? (existing.remote_payload_acknowledged_at ?? now)
          : null,
        now,
        workspaceId,
        settingId,
      );
    if (changes.clearApiKey) await this.#removeCredential(workspaceId, settingId);
    if (changes.apiKey) await this.#saveCredential(workspaceId, settingId, changes.apiKey);
    return this.#required(workspaceId, settingId);
  }

  async delete(workspaceId: string, settingId: string): Promise<AiProviderSetting> {
    const setting = this.#required(workspaceId, settingId);
    await this.#removeCredential(workspaceId, settingId);
    this.#sqlite()
      .prepare("DELETE FROM ai_provider_settings WHERE workspace_id = ? AND id = ?")
      .run(workspaceId, settingId);
    return setting;
  }

  async credential(workspaceId: string, settingId: string): Promise<string | null> {
    const row = this.#row(workspaceId, settingId);
    if (!row) {
      throw new AiProviderStoreError("AI_PROVIDER_NOT_FOUND", "The AI provider was not found.");
    }
    if (!row.has_credential) return null;
    if (row.credential_storage === "keyring") {
      try {
        return this.#credentialEntry(workspaceId, settingId).getPassword();
      } catch {
        throw new AiProviderStoreError(
          "AI_PROVIDER_CREDENTIAL_UNAVAILABLE",
          "The provider credential is unavailable from the operating-system credential store.",
        );
      }
    }
    if (!row.credential_ciphertext || !row.credential_nonce || !row.credential_auth_tag) {
      throw new AiProviderStoreError(
        "AI_PROVIDER_CREDENTIAL_UNAVAILABLE",
        "The encrypted provider credential is incomplete.",
      );
    }
    const key = this.#requiredEncryptionKey();
    try {
      return decryptCredential(
        {
          ciphertext: row.credential_ciphertext,
          nonce: row.credential_nonce,
          authTag: row.credential_auth_tag,
        },
        key,
        credentialAad(workspaceId, settingId),
      );
    } catch {
      throw new AiProviderStoreError(
        "AI_PROVIDER_CREDENTIAL_UNAVAILABLE",
        "The encrypted provider credential could not be opened.",
      );
    } finally {
      key.fill(0);
    }
  }

  rotateEncryptionKey(previousKey: Buffer, nextKey: Buffer): void {
    if (this.#credentialStorage !== "encrypted_database") return;
    const sqlite = this.#sqlite();
    sqlite.transaction(() => {
      const rows = sqlite
        .prepare(
          `SELECT * FROM ai_provider_settings
           WHERE credential_storage = 'encrypted_database' AND has_credential = 1`,
        )
        .all() as SettingRow[];
      const update = sqlite.prepare(
        `UPDATE ai_provider_settings SET
          credential_ciphertext = ?, credential_nonce = ?, credential_auth_tag = ?,
          updated_at = ?
         WHERE id = ?`,
      );
      for (const row of rows) {
        if (!row.credential_ciphertext || !row.credential_nonce || !row.credential_auth_tag) {
          throw new Error("An encrypted provider credential is incomplete.");
        }
        const aad = credentialAad(row.workspace_id, row.id);
        const secret = decryptCredential(
          {
            ciphertext: row.credential_ciphertext,
            nonce: row.credential_nonce,
            authTag: row.credential_auth_tag,
          },
          previousKey,
          aad,
        );
        const encrypted = encryptCredential(secret, nextKey, aad);
        update.run(encrypted.ciphertext, encrypted.nonce, encrypted.authTag, this.#clock(), row.id);
      }
    })();
  }

  async #saveCredential(workspaceId: string, settingId: string, secret: string): Promise<void> {
    if (this.#credentialStorage === "keyring") {
      this.#credentialEntry(workspaceId, settingId).setPassword(secret);
      this.#sqlite()
        .prepare(
          `UPDATE ai_provider_settings SET
            has_credential = 1, credential_ciphertext = NULL,
            credential_nonce = NULL, credential_auth_tag = NULL, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(this.#clock(), workspaceId, settingId);
      return;
    }
    const key = this.#requiredEncryptionKey();
    let encrypted: ReturnType<typeof encryptCredential>;
    try {
      encrypted = encryptCredential(secret, key, credentialAad(workspaceId, settingId));
    } finally {
      key.fill(0);
    }
    this.#sqlite()
      .prepare(
        `UPDATE ai_provider_settings SET
          has_credential = 1, credential_ciphertext = ?,
          credential_nonce = ?, credential_auth_tag = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        this.#clock(),
        workspaceId,
        settingId,
      );
  }

  async #removeCredential(workspaceId: string, settingId: string): Promise<void> {
    const row = this.#row(workspaceId, settingId);
    if (!row?.has_credential) return;
    if (row.credential_storage === "keyring") {
      try {
        this.#credentialEntry(workspaceId, settingId).deletePassword();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.toLowerCase().includes("no entry")) {
          throw error;
        }
      }
    }
    this.#sqlite()
      .prepare(
        `UPDATE ai_provider_settings SET
          has_credential = 0, credential_ciphertext = NULL,
          credential_nonce = NULL, credential_auth_tag = NULL, updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(this.#clock(), workspaceId, settingId);
  }

  #row(workspaceId: string, settingId: string): SettingRow | null {
    return (
      (this.#sqlite()
        .prepare("SELECT * FROM ai_provider_settings WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, settingId) as SettingRow | undefined) ?? null
    );
  }

  #required(workspaceId: string, settingId: string): AiProviderSetting {
    const row = this.#row(workspaceId, settingId);
    if (!row) {
      throw new AiProviderStoreError("AI_PROVIDER_NOT_FOUND", "The AI provider was not found.");
    }
    return toPublicSetting(row);
  }

  #requiredEncryptionKey(): Buffer {
    const key = this.#encryptionKey?.();
    if (key?.length !== 32) {
      throw new AiProviderStoreError(
        "AI_PROVIDER_CREDENTIAL_UNAVAILABLE",
        "The provider credential encryption key is unavailable.",
      );
    }
    return Buffer.from(key);
  }
}

function toPublicSetting(row: SettingRow): AiProviderSetting {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    endpoint: row.endpoint,
    model: row.model,
    timeoutMs: row.timeout_ms,
    enabled: Boolean(row.enabled),
    localModel: Boolean(row.local_model),
    payloadPolicy: row.payload_policy,
    hasCredential: Boolean(row.has_credential),
    credentialStorage: row.credential_storage,
    remotePayloadAcknowledgedAt: row.remote_payload_acknowledged_at
      ? new Date(row.remote_payload_acknowledged_at).toISOString()
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function normalizedEndpoint(value: string): string {
  return value.replace(/\/+$/, "");
}

function credentialAad(workspaceId: string, settingId: string): Buffer {
  return Buffer.from(`${CREDENTIAL_KEY_INFO}:${workspaceId}:${settingId}`);
}

function encryptCredential(secret: string, key: Buffer, aad: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptCredential(
  encrypted: { ciphertext: string; nonce: string; authTag: string },
  key: Buffer,
  aad: Buffer,
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce, "base64"));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

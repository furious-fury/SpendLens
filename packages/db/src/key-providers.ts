import { readFile, stat } from "node:fs/promises";
import { Entry } from "@napi-rs/keyring";

const DATABASE_KEY_BYTES = 32;
const DATABASE_KEY_HEX_LENGTH = DATABASE_KEY_BYTES * 2;

export interface DatabaseKeyProvider {
  readonly kind: "keyring" | "secret-file" | "memory";
  load(): Promise<Buffer | null>;
  save(key: Buffer): Promise<void>;
  remove(): Promise<void>;
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): void;
}

export function parseDatabaseKey(value: string): Buffer {
  const normalized = value.trim();
  if (!new RegExp(`^[a-fA-F0-9]{${DATABASE_KEY_HEX_LENGTH}}$`).test(normalized)) {
    throw new Error("The database key must be exactly 32 bytes encoded as hexadecimal.");
  }

  return Buffer.from(normalized, "hex");
}

export function serializeDatabaseKey(key: Buffer): string {
  assertDatabaseKey(key);
  return key.toString("hex");
}

export function assertDatabaseKey(key: Buffer): void {
  if (key.length !== DATABASE_KEY_BYTES) {
    throw new Error("The database key must contain exactly 32 bytes.");
  }
}

export class OsKeyringProvider implements DatabaseKeyProvider {
  readonly kind = "keyring" as const;
  readonly #entry: KeyringEntry;

  constructor(service = "SpendLens", account = "default-workspace-database", entry?: KeyringEntry) {
    this.#entry = entry ?? new Entry(service, account);
  }

  async load(): Promise<Buffer | null> {
    const value = this.#entry.getPassword();
    return value ? parseDatabaseKey(value) : null;
  }

  async save(key: Buffer): Promise<void> {
    this.#entry.setPassword(serializeDatabaseKey(key));
  }

  async remove(): Promise<void> {
    try {
      this.#entry.deletePassword();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.toLowerCase().includes("no entry")) {
        throw error;
      }
    }
  }
}

export class SecretFileKeyProvider implements DatabaseKeyProvider {
  readonly kind = "secret-file" as const;

  constructor(readonly path: string) {}

  async load(): Promise<Buffer | null> {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(this.path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }

    if (!fileStat.isFile()) {
      throw new Error("The configured database secret path is not a regular file.");
    }

    if (process.platform !== "win32" && (fileStat.mode & 0o077) !== 0) {
      throw new Error("The database secret file must not be accessible by group or other users.");
    }

    return parseDatabaseKey(await readFile(this.path, "utf8"));
  }

  async save(): Promise<void> {
    throw new Error(
      "Mounted secret files are read-only. Generate and mount a 32-byte hexadecimal key first.",
    );
  }

  async remove(): Promise<void> {
    throw new Error("SpendLens never deletes a mounted secret file.");
  }
}

export class MemoryKeyProvider implements DatabaseKeyProvider {
  readonly kind = "memory" as const;
  #key: Buffer | null;

  constructor(key: Buffer | null = null) {
    this.#key = key ? Buffer.from(key) : null;
  }

  async load(): Promise<Buffer | null> {
    return this.#key ? Buffer.from(this.#key) : null;
  }

  async save(key: Buffer): Promise<void> {
    assertDatabaseKey(key);
    this.#key = Buffer.from(key);
  }

  async remove(): Promise<void> {
    this.#key = null;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

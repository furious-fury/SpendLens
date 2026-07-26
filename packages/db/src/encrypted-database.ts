import { randomBytes } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { DatabaseKeyProvider } from "./key-providers.js";
import { assertDatabaseKey, serializeDatabaseKey } from "./key-providers.js";
import { applyMigrations } from "./migrations.js";
import { securitySchema } from "./schema.js";

export interface EncryptedDatabaseOptions {
  filePath: string;
  keyProvider: DatabaseKeyProvider;
}

export interface EncryptedDatabase {
  filePath: string;
  keyProvider: DatabaseKeyProvider;
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof securitySchema>>;
  key: Buffer;
  close(): void;
  rekey(nextKey?: Buffer): Promise<Buffer>;
}

export async function databaseExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function createEncryptedDatabase(
  options: EncryptedDatabaseOptions,
): Promise<EncryptedDatabase> {
  if (await databaseExists(options.filePath)) {
    throw new Error("A SpendLens database already exists at the configured path.");
  }

  await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
  const existingKey = await options.keyProvider.load();
  const key = existingKey ?? randomBytes(32);

  if (!existingKey && options.keyProvider.kind === "secret-file") {
    throw new Error(
      "The mounted database secret file is missing. Create it before setting up SpendLens.",
    );
  }

  if (!existingKey) {
    await options.keyProvider.save(key);
  }

  let sqlite: Database.Database | undefined;
  try {
    sqlite = openDriver(options.filePath, key);
    applyMigrations(sqlite);
    return buildDatabase(options, sqlite, key);
  } catch (error) {
    sqlite?.close();
    await unlink(options.filePath).catch(() => undefined);
    if (!existingKey) {
      await options.keyProvider.remove().catch(() => undefined);
    }
    throw error;
  }
}

export async function openEncryptedDatabase(
  options: EncryptedDatabaseOptions,
): Promise<EncryptedDatabase> {
  if (!(await databaseExists(options.filePath))) {
    throw new Error("No SpendLens database exists at the configured path.");
  }

  const key = await options.keyProvider.load();
  if (!key) {
    throw new Error("The database key is unavailable from the configured key provider.");
  }

  let sqlite: Database.Database | undefined;
  try {
    sqlite = openDriver(options.filePath, key);
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
    applyMigrations(sqlite);
    return buildDatabase(options, sqlite, key);
  } catch (error) {
    sqlite?.close();
    throw new Error("The encrypted database could not be opened with the available key.", {
      cause: error,
    });
  }
}

export async function openOrCreateEncryptedDatabase(
  options: EncryptedDatabaseOptions,
): Promise<EncryptedDatabase> {
  return (await databaseExists(options.filePath))
    ? openEncryptedDatabase(options)
    : createEncryptedDatabase(options);
}

export function generateDatabaseKey(): Buffer {
  return randomBytes(32);
}

function openDriver(filePath: string, key: Buffer): Database.Database {
  assertDatabaseKey(key);
  const sqlite = new Database(filePath);
  sqlite.pragma("cipher='sqlcipher'");
  sqlite.pragma("legacy=4");
  sqlite.pragma(`key="x'${serializeDatabaseKey(key)}'"`);
  sqlite.pragma("foreign_keys=ON");
  sqlite.pragma("journal_mode=WAL");
  sqlite.pragma("synchronous=FULL");
  return sqlite;
}

function buildDatabase(
  options: EncryptedDatabaseOptions,
  sqlite: Database.Database,
  key: Buffer,
): EncryptedDatabase {
  const database = {
    filePath: options.filePath,
    keyProvider: options.keyProvider,
    sqlite,
    db: drizzle(sqlite, { schema: securitySchema }),
    key: Buffer.from(key),
    close() {
      sqlite.close();
      database.key.fill(0);
    },
    async rekey(nextKey = randomBytes(32)) {
      assertDatabaseKey(nextKey);
      const previousKey = Buffer.from(database.key);
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
      sqlite.pragma("journal_mode=DELETE");

      try {
        sqlite.pragma(`rekey="x'${serializeDatabaseKey(nextKey)}'"`);
        await options.keyProvider.save(nextKey);
      } catch (error) {
        sqlite.pragma(`rekey="x'${serializeDatabaseKey(previousKey)}'"`);
        sqlite.pragma("journal_mode=WAL");
        previousKey.fill(0);
        throw error;
      }

      sqlite.pragma("journal_mode=WAL");
      database.key.fill(0);
      database.key = Buffer.from(nextKey);
      previousKey.fill(0);
      return Buffer.from(nextKey);
    },
  };

  return database;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

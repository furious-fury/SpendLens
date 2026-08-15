import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RecoveryFile } from "@spendlens/contracts";
import {
  applyMigrations,
  type DatabaseKeyProvider,
  databaseExists,
  latestMigrationId,
  MemoryKeyProvider,
  openEncryptedDatabase,
} from "@spendlens/db";
import { unwrapDatabaseKey } from "../security/crypto.js";
import { SPENDLENS_VERSION } from "../version.js";
import { BackupService, validateBackupArtifact } from "./backup-service.js";
import { extractBackupPayload, verifyBackupContainer } from "./backup-container.js";
import type { MaintenanceCoordinator } from "./maintenance-coordinator.js";

interface RestoreJournal {
  version: 1;
  databasePath: string;
  rollbackPath: string | null;
  interruptedPath: string;
  phase: "prepared" | "database-swapped" | "key-saved";
}

export interface VerifyPortableBackupOptions {
  backupPath: string;
  recoveryFile: RecoveryFile;
  recoveryCode: string;
  workDirectory: string;
}

export interface RestorePortableBackupOptions extends VerifyPortableBackupOptions {
  databasePath: string;
  dataDirectory: string;
  keyProvider: DatabaseKeyProvider;
  replaceExisting: boolean;
  confirmedWorkspaceId?: string;
  coordinator: MaintenanceCoordinator;
  availableBytes?: bigint;
}

export async function verifyPortableBackup(options: VerifyPortableBackupOptions) {
  assertBackupPath(options.backupPath);
  await mkdir(options.workDirectory, { recursive: true, mode: 0o700 });
  const key = await unwrapDatabaseKey(options.recoveryFile, options.recoveryCode);
  const extractionPath = join(options.workDirectory, `.verify-${randomUUID()}.db`);
  try {
    const parsed = await verifyBackupContainer(options.backupPath, key);
    if (parsed.manifest.workspaceId !== options.recoveryFile.workspaceId) {
      throw new Error("BACKUP_WORKSPACE_MISMATCH");
    }
    assertSupportedBackup(parsed.manifest.applicationVersion, parsed.manifest.latestMigrationId);
    await validateBackupArtifact(options.backupPath, extractionPath, key);
    const database = await openEncryptedDatabase({
      filePath: extractionPath,
      keyProvider: new MemoryKeyProvider(key),
      migrate: false,
    });
    try {
      const owner = database.sqlite.prepare("SELECT id FROM users LIMIT 1").get();
      if (!owner) throw new Error("BACKUP_OWNER_MISSING");
    } finally {
      database.close();
    }
    return parsed.manifest;
  } finally {
    key.fill(0);
    await removeDatabaseFiles(extractionPath);
  }
}

export async function restorePortableBackup(options: RestorePortableBackupOptions) {
  return options.coordinator.run("restore", async () => {
    assertBackupPath(options.backupPath);
    const key = await unwrapDatabaseKey(options.recoveryFile, options.recoveryCode);
    const operationId = randomUUID();
    const stagingPath = join(options.dataDirectory, `.restore-${operationId}.db`);
    const rollbackPath = join(options.dataDirectory, `.restore-rollback-${operationId}.db`);
    const interruptedPath = join(options.dataDirectory, `.restore-interrupted-${operationId}.db`);
    const journalPath = join(options.dataDirectory, "restore-journal.json");
    let currentKey: Buffer | null = null;
    let currentDatabase: Awaited<ReturnType<typeof openEncryptedDatabase>> | null = null;
    let existing = false;
    try {
      await mkdir(options.dataDirectory, { recursive: true, mode: 0o700 });
      await ensureRestoreSpace(options.backupPath, options.dataDirectory, options.availableBytes);
      const parsed = await verifyBackupContainer(options.backupPath, key);
      if (parsed.manifest.workspaceId !== options.recoveryFile.workspaceId) {
        throw new Error("BACKUP_WORKSPACE_MISMATCH");
      }
      assertSupportedBackup(parsed.manifest.applicationVersion, parsed.manifest.latestMigrationId);
      const interrupted = await readJournalIfPresent(journalPath);
      if (interrupted && (await canOpen(interrupted.databasePath, key))) {
        const providerKey = await options.keyProvider.load();
        if (options.keyProvider.kind === "secret-file") {
          if (!providerKey?.equals(key)) throw new Error("RESTORE_SECRET_FILE_MISMATCH");
        } else {
          await options.keyProvider.save(key);
        }
        providerKey?.fill(0);
        await removeDatabaseFiles(interrupted.rollbackPath);
        await rm(journalPath, { force: true });
        return parsed.manifest;
      }
      await extractBackupPayload(options.backupPath, stagingPath, parsed.payloadOffset);
      await validateExtractedDatabase(stagingPath, key, parsed.manifest.workspaceId);

      existing = await databaseExists(options.databasePath);
      if (existing) {
        if (!options.replaceExisting) throw new Error("RESTORE_REPLACE_CONFIRMATION_REQUIRED");
        currentKey = await options.keyProvider.load();
        if (!currentKey) throw new Error("RESTORE_CURRENT_KEY_UNAVAILABLE");
        currentDatabase = await openEncryptedDatabase({
          filePath: options.databasePath,
          keyProvider: new MemoryKeyProvider(currentKey),
          migrate: false,
        });
        const workspace = currentDatabase.sqlite
          .prepare("SELECT id FROM workspaces LIMIT 1")
          .get() as { id: string } | undefined;
        if (!workspace || workspace.id !== options.confirmedWorkspaceId) {
          throw new Error("RESTORE_WORKSPACE_CONFIRMATION_MISMATCH");
        }
        const databaseBeforeRestore = currentDatabase;
        const safety = new BackupService({
          database: () => databaseBeforeRestore,
          dataDirectory: options.dataDirectory,
          applicationVersion: SPENDLENS_VERSION,
          coordinator: options.coordinator,
        });
        await safety.createSafetyWithinMaintenance("pre_restore");
        currentDatabase.sqlite.pragma("wal_checkpoint(TRUNCATE)");
        currentDatabase.close();
        currentDatabase = null;
      }

      const journal: RestoreJournal = {
        version: 1,
        databasePath: resolve(options.databasePath),
        rollbackPath: existing ? rollbackPath : null,
        interruptedPath,
        phase: "prepared",
      };
      await writeJournal(journalPath, journal);
      if (existing) await rename(options.databasePath, rollbackPath);
      await rename(stagingPath, options.databasePath);
      journal.phase = "database-swapped";
      await writeJournal(journalPath, journal);

      const providerKey = await options.keyProvider.load();
      if (options.keyProvider.kind === "secret-file") {
        if (!providerKey?.equals(key)) throw new Error("RESTORE_SECRET_FILE_MISMATCH");
      } else {
        await options.keyProvider.save(key);
      }
      providerKey?.fill(0);
      journal.phase = "key-saved";
      await writeJournal(journalPath, journal);

      const restored = await openEncryptedDatabase({
        filePath: options.databasePath,
        keyProvider: options.keyProvider,
        migrate: false,
      });
      try {
        const pendingBeforeMigration = parsed.manifest.latestMigrationId !== latestMigrationId();
        if (pendingBeforeMigration) {
          const safety = new BackupService({
            database: () => restored,
            dataDirectory: options.dataDirectory,
            applicationVersion: SPENDLENS_VERSION,
            coordinator: options.coordinator,
          });
          await safety.createSafetyWithinMaintenance("pre_upgrade");
        }
        applyMigrations(restored.sqlite);
        if (restored.sqlite.pragma("integrity_check", { simple: true }) !== "ok") {
          throw new Error("RESTORE_DATABASE_CORRUPT");
        }
      } finally {
        restored.close();
      }
      await removeDatabaseFiles(rollbackPath);
      await rm(journalPath, { force: true });
      return parsed.manifest;
    } catch (error) {
      currentDatabase?.close();
      await rollbackRestore({
        databasePath: options.databasePath,
        rollbackPath: existing ? rollbackPath : null,
        interruptedPath,
        keyProvider: options.keyProvider,
        previousKey: currentKey,
      });
      await rm(journalPath, { force: true });
      throw error;
    } finally {
      key.fill(0);
      currentKey?.fill(0);
      await removeDatabaseFiles(stagingPath);
    }
  });
}

export async function recoverInterruptedRestore(options: {
  dataDirectory: string;
  keyProvider: DatabaseKeyProvider;
}): Promise<"none" | "finalized" | "rolled-back"> {
  const journalPath = join(options.dataDirectory, "restore-journal.json");
  let journal: RestoreJournal;
  try {
    journal = JSON.parse(await readFile(journalPath, "utf8")) as RestoreJournal;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "none";
    throw new Error("RESTORE_INTERRUPTED");
  }
  const key = await options.keyProvider.load();
  if (!key) throw new Error("RESTORE_INTERRUPTED");
  try {
    if (await canOpen(journal.databasePath, key)) {
      await removeDatabaseFiles(journal.rollbackPath);
      await rm(journalPath, { force: true });
      return "finalized";
    }
    if (journal.rollbackPath && (await canOpen(journal.rollbackPath, key))) {
      if (await databaseExists(journal.databasePath)) {
        await rename(journal.databasePath, journal.interruptedPath);
      }
      await rename(journal.rollbackPath, journal.databasePath);
      await rm(journalPath, { force: true });
      return "rolled-back";
    }
    throw new Error("RESTORE_INTERRUPTED");
  } finally {
    key.fill(0);
  }
}

async function validateExtractedDatabase(path: string, key: Buffer, workspaceId: string) {
  const database = await openEncryptedDatabase({
    filePath: path,
    keyProvider: new MemoryKeyProvider(key),
    migrate: false,
  });
  try {
    if (database.sqlite.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new Error("BACKUP_DATABASE_CORRUPT");
    }
    const workspace = database.sqlite.prepare("SELECT id FROM workspaces LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (workspace?.id !== workspaceId) throw new Error("BACKUP_WORKSPACE_MISMATCH");
    if (!database.sqlite.prepare("SELECT id FROM users LIMIT 1").get()) {
      throw new Error("BACKUP_OWNER_MISSING");
    }
  } finally {
    database.close();
  }
}

async function rollbackRestore(options: {
  databasePath: string;
  rollbackPath: string | null;
  interruptedPath: string;
  keyProvider: DatabaseKeyProvider;
  previousKey: Buffer | null;
}) {
  if (options.rollbackPath && (await databaseExists(options.rollbackPath))) {
    if (await databaseExists(options.databasePath)) {
      await rename(options.databasePath, options.interruptedPath).catch(() => undefined);
    }
    await rename(options.rollbackPath, options.databasePath).catch(() => undefined);
  }
  if (options.previousKey && options.keyProvider.kind !== "secret-file") {
    await options.keyProvider.save(options.previousKey).catch(() => undefined);
  }
}

async function canOpen(path: string, key: Buffer): Promise<boolean> {
  if (!(await databaseExists(path))) return false;
  try {
    const database = await openEncryptedDatabase({
      filePath: path,
      keyProvider: new MemoryKeyProvider(key),
      migrate: false,
    });
    database.close();
    return true;
  } catch {
    return false;
  }
}

function assertSupportedBackup(applicationVersion: string, schemaVersion: string): void {
  if (
    schemaVersion > latestMigrationId() ||
    compareVersions(applicationVersion, SPENDLENS_VERSION) > 0
  ) {
    throw new Error("BACKUP_UNSUPPORTED_SCHEMA");
  }
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertBackupPath(path: string): void {
  if (!path.endsWith(".slbackup")) throw new Error("BACKUP_UNSAFE_PATH");
}

async function ensureRestoreSpace(backupPath: string, directory: string, availableBytes?: bigint) {
  const backup = await stat(backupPath);
  const free =
    availableBytes ??
    (await import("node:fs/promises").then(async ({ statfs }) => {
      const filesystem = await statfs(directory, { bigint: true });
      return filesystem.bavail * filesystem.bsize;
    }));
  if (free === undefined) throw new Error("BACKUP_SPACE_CHECK_FAILED");
  const required = BigInt(Math.max(backup.size * 3, backup.size + 64 * 1024 * 1024));
  if (free < required) throw new Error("BACKUP_INSUFFICIENT_SPACE");
}

async function writeJournal(path: string, journal: RestoreJournal) {
  const temporary = `${path}.partial`;
  await writeFile(temporary, JSON.stringify(journal), { flag: "w", mode: 0o600 });
  await rename(temporary, path);
}

async function readJournalIfPresent(path: string): Promise<RestoreJournal | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as RestoreJournal;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw new Error("RESTORE_INTERRUPTED");
  }
}

async function removeDatabaseFiles(path: string | null): Promise<void> {
  if (!path) return;
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

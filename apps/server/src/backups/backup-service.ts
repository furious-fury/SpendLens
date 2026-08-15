import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, parse } from "node:path";
import type { BackupKind, BackupRecord, BackupStatus } from "@spendlens/contracts";
import {
  backupRecords,
  createEncryptedSnapshot,
  type EncryptedDatabase,
  latestMigrationId,
  MemoryKeyProvider,
  openEncryptedDatabase,
} from "@spendlens/db";
import { and, desc, eq } from "drizzle-orm";
import {
  extractBackupPayload,
  verifyBackupContainer,
  writeBackupContainer,
} from "./backup-container.js";
import type { MaintenanceCoordinator } from "./maintenance-coordinator.js";

export const BACKUP_MIME_TYPE = "application/vnd.spendlens.backup";
export const BACKUP_RETENTION = { daily: 7, weekly: 4, monthly: 12 } as const;
export const BACKUP_EXCLUSIONS = [
  "sessions",
  "jobs",
  "analytics_metric_cache",
  "metric_invalidations",
  "unfinished_import_previews",
  "backup_history",
] as const;

export interface BackupServiceOptions {
  database: () => EncryptedDatabase;
  dataDirectory: string;
  configuredBackupDirectory?: string;
  applicationVersion: string;
  coordinator: MaintenanceCoordinator;
  clock?: () => number;
}

export interface CreatedBackup {
  record: BackupRecord;
  path: string;
  filename: string;
}

export class BackupService {
  readonly #database: () => EncryptedDatabase;
  readonly #dataDirectory: string;
  readonly #configuredBackupDirectory: string | undefined;
  readonly #applicationVersion: string;
  readonly #coordinator: MaintenanceCoordinator;
  readonly #clock: () => number;

  constructor(options: BackupServiceOptions) {
    this.#database = options.database;
    this.#dataDirectory = options.dataDirectory;
    this.#configuredBackupDirectory = options.configuredBackupDirectory;
    this.#applicationVersion = options.applicationVersion;
    this.#coordinator = options.coordinator;
    this.#clock = options.clock ?? Date.now;
  }

  async status(nextScheduledAt: Date | null = null): Promise<BackupStatus> {
    const rows = this.#database()
      .db.select()
      .from(backupRecords)
      .orderBy(desc(backupRecords.createdAt))
      .limit(20)
      .all();
    const lastSuccessful = rows.find((row) => row.validation === "valid");
    return {
      scheduleEnabled: Boolean(this.#configuredBackupDirectory),
      backupDirectoryConfigured: Boolean(this.#configuredBackupDirectory),
      sameVolumeWarning: this.#configuredBackupDirectory
        ? await sameVolume(this.#database().filePath, this.#configuredBackupDirectory)
        : false,
      recoveryStorageVerified: false,
      lastSuccessfulAt: lastSuccessful?.completedAt?.toISOString() ?? null,
      nextScheduledAt: nextScheduledAt?.toISOString() ?? null,
      retention: BACKUP_RETENTION,
      items: rows.map((row) => toBackupRecord(row)),
    };
  }

  async list(): Promise<BackupRecord[]> {
    return (await this.status()).items;
  }

  latestScheduledAt(): Date | null {
    const row = this.#database()
      .db.select({ createdAt: backupRecords.createdAt })
      .from(backupRecords)
      .where(and(eq(backupRecords.kind, "scheduled"), eq(backupRecords.validation, "valid")))
      .orderBy(desc(backupRecords.createdAt))
      .limit(1)
      .get();
    return row?.createdAt ?? null;
  }

  async createManual(): Promise<CreatedBackup> {
    const directory = join(this.#dataDirectory, "backup-work");
    return this.create("manual", directory);
  }

  async createScheduled(): Promise<CreatedBackup> {
    if (!this.#configuredBackupDirectory) {
      throw new Error("BACKUP_DIRECTORY_NOT_CONFIGURED");
    }
    const created = await this.create("scheduled", this.#configuredBackupDirectory);
    await this.applyRetention();
    return created;
  }

  async createSafety(kind: "safety" | "pre_restore" | "pre_rekey" | "pre_upgrade") {
    return this.create(kind, join(this.#dataDirectory, "safety-backups"));
  }

  async createSafetyWithinMaintenance(
    kind: "safety" | "pre_restore" | "pre_rekey" | "pre_upgrade",
  ) {
    return this.#createLocked(kind, join(this.#dataDirectory, "safety-backups"));
  }

  async create(kind: BackupKind, directory: string): Promise<CreatedBackup> {
    return this.#coordinator.run("backup", () => this.#createLocked(kind, directory));
  }

  async #createLocked(kind: BackupKind, directory: string): Promise<CreatedBackup> {
    const database = this.#database();
    const workspace = database.sqlite.prepare("SELECT id FROM workspaces LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (!workspace) throw new Error("BACKUP_WORKSPACE_MISSING");
    const id = randomUUID();
    const now = new Date(this.#clock());
    const schemaVersion = currentSchemaVersion(database);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await ensureFreeSpace(directory, database.filePath, 2);
    const filename = backupFilename(workspace.id, now, id);
    const outputPath = join(directory, filename);
    const payloadPath = join(directory, `.${id}.payload.db`);
    const validationPath = join(directory, `.${id}.validation.db`);

    database.db
      .insert(backupRecords)
      .values({
        id,
        workspaceId: workspace.id,
        kind,
        storagePath: outputPath,
        applicationVersion: this.#applicationVersion,
        schemaVersion,
        validation: "pending",
        createdAt: now,
      })
      .run();

    try {
      await createEncryptedSnapshot(database, payloadPath);
      const payload = await openEncryptedDatabase({
        filePath: payloadPath,
        keyProvider: new MemoryKeyProvider(database.key),
        migrate: false,
      });
      let durableWorkspaceDigest: string;
      try {
        scrubPortableSnapshot(payload);
        durableWorkspaceDigest = durableDigest(payload);
        payload.sqlite.pragma("wal_checkpoint(TRUNCATE)");
        payload.sqlite.pragma("journal_mode=DELETE");
        payload.sqlite.exec("VACUUM");
      } finally {
        payload.close();
      }
      const manifest = await writeBackupContainer(outputPath, payloadPath, database.key, {
        workspaceId: workspace.id,
        createdAt: now.toISOString(),
        applicationVersion: this.#applicationVersion,
        schemaVersion,
        latestMigrationId: schemaVersion,
        kind,
        durableWorkspaceDigest,
        exclusions: [...BACKUP_EXCLUSIONS],
      });
      await validateBackupArtifact(outputPath, validationPath, database.key);
      const completedAt = new Date(this.#clock());
      database.db
        .update(backupRecords)
        .set({
          payloadSha256: manifest.payloadSha256,
          durableWorkspaceDigest,
          sizeBytes: (await stat(outputPath)).size,
          validation: "valid",
          completedAt,
        })
        .where(eq(backupRecords.id, id))
        .run();
      const completed = database.db
        .select()
        .from(backupRecords)
        .where(eq(backupRecords.id, id))
        .get();
      if (!completed) throw new Error("BACKUP_RECORD_MISSING");
      return {
        record: toBackupRecord(completed),
        path: outputPath,
        filename,
      };
    } catch (error) {
      database.db
        .update(backupRecords)
        .set({
          validation: "failed",
          errorCode: backupErrorCode(error),
          completedAt: new Date(this.#clock()),
        })
        .where(eq(backupRecords.id, id))
        .run();
      await rm(outputPath, { force: true });
      await rm(`${outputPath}.partial`, { force: true });
      throw error;
    } finally {
      await rm(payloadPath, { force: true });
      await rm(`${payloadPath}-wal`, { force: true });
      await rm(`${payloadPath}-shm`, { force: true });
      await rm(validationPath, { force: true });
      await rm(`${validationPath}-wal`, { force: true });
      await rm(`${validationPath}-shm`, { force: true });
    }
  }

  async resolveDownload(id: string): Promise<{ path: string; filename: string }> {
    const row = this.#database()
      .db.select()
      .from(backupRecords)
      .where(eq(backupRecords.id, id))
      .get();
    if (row?.validation !== "valid" || !row.storagePath) {
      throw new Error("BACKUP_NOT_FOUND");
    }
    const storagePath = row.storagePath;
    const allowed = [
      join(this.#dataDirectory, "backup-work"),
      ...(this.#configuredBackupDirectory ? [this.#configuredBackupDirectory] : []),
    ];
    if (!allowed.some((directory) => isWithin(storagePath, directory))) {
      throw new Error("BACKUP_UNSAFE_PATH");
    }
    await stat(storagePath);
    return { path: storagePath, filename: basename(storagePath) };
  }

  async consumeManual(id: string): Promise<void> {
    const row = this.#database()
      .db.select()
      .from(backupRecords)
      .where(eq(backupRecords.id, id))
      .get();
    if (row?.kind === "manual" && row.storagePath) {
      await rm(row.storagePath, { force: true });
      this.#database()
        .db.update(backupRecords)
        .set({ storagePath: null })
        .where(eq(backupRecords.id, id))
        .run();
    }
  }

  async applyRetention(): Promise<void> {
    if (!this.#configuredBackupDirectory) return;
    const rows = this.#database()
      .db.select()
      .from(backupRecords)
      .where(eq(backupRecords.kind, "scheduled"))
      .orderBy(desc(backupRecords.createdAt))
      .all()
      .filter((row) => row.validation === "valid" && row.storagePath);
    const keep = retainedBackupIds(rows.map((row) => ({ id: row.id, createdAt: row.createdAt })));
    if (keep.size === 0 && rows[0]) keep.add(rows[0].id);
    for (const row of rows) {
      if (keep.has(row.id) || !row.storagePath) continue;
      await rm(row.storagePath, { force: true });
      this.#database().db.delete(backupRecords).where(eq(backupRecords.id, row.id)).run();
    }
  }
}

export async function validateBackupArtifact(
  backupPath: string,
  extractionPath: string,
  databaseKey: Buffer,
) {
  const parsed = await verifyBackupContainer(backupPath, databaseKey);
  await extractBackupPayload(backupPath, extractionPath, parsed.payloadOffset);
  const database = await openEncryptedDatabase({
    filePath: extractionPath,
    keyProvider: new MemoryKeyProvider(databaseKey),
    migrate: false,
  });
  try {
    const integrity = database.sqlite.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error("BACKUP_DATABASE_CORRUPT");
    const workspace = database.sqlite.prepare("SELECT id FROM workspaces LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (workspace?.id !== parsed.manifest.workspaceId) throw new Error("BACKUP_WORKSPACE_MISMATCH");
    if (durableDigest(database) !== parsed.manifest.durableWorkspaceDigest) {
      throw new Error("BACKUP_DIGEST_MISMATCH");
    }
  } finally {
    database.close();
  }
  return parsed;
}

export async function createUntrackedSafetyBackup(options: {
  database: EncryptedDatabase;
  directory: string;
  applicationVersion: string;
  kind: "pre_upgrade";
  clock?: () => number;
}): Promise<string> {
  const now = new Date((options.clock ?? Date.now)());
  const workspace = options.database.sqlite.prepare("SELECT id FROM workspaces LIMIT 1").get() as
    | { id: string }
    | undefined;
  if (!workspace) throw new Error("BACKUP_WORKSPACE_MISSING");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  await ensureFreeSpace(options.directory, options.database.filePath, 2);
  const id = randomUUID();
  const payloadPath = join(options.directory, `.${id}.payload.db`);
  const validationPath = join(options.directory, `.${id}.validation.db`);
  const outputPath = join(options.directory, backupFilename(workspace.id, now, id));
  try {
    await createEncryptedSnapshot(options.database, payloadPath);
    const payload = await openEncryptedDatabase({
      filePath: payloadPath,
      keyProvider: new MemoryKeyProvider(options.database.key),
      migrate: false,
    });
    let digest: string;
    try {
      digest = durableDigest(payload);
      payload.sqlite.pragma("journal_mode=DELETE");
    } finally {
      payload.close();
    }
    const schemaVersion = currentSchemaVersion(options.database);
    await writeBackupContainer(outputPath, payloadPath, options.database.key, {
      workspaceId: workspace.id,
      createdAt: now.toISOString(),
      applicationVersion: options.applicationVersion,
      schemaVersion,
      latestMigrationId: schemaVersion,
      kind: options.kind,
      durableWorkspaceDigest: digest,
      exclusions: [],
    });
    await validateBackupArtifact(outputPath, validationPath, options.database.key);
    return outputPath;
  } catch (error) {
    await rm(outputPath, { force: true });
    await rm(`${outputPath}.partial`, { force: true });
    throw error;
  } finally {
    await removeSnapshotFiles(payloadPath);
    await removeSnapshotFiles(validationPath);
  }
}

export function durableDigest(database: EncryptedDatabase): string {
  const excluded = new Set([
    "_spendlens_migrations",
    "sessions",
    "jobs",
    "analytics_metric_cache",
    "metric_invalidations",
    "backup_records",
    "release_state",
  ]);
  const tables = database.sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  const hash = createHash("sha256");
  for (const { name } of tables) {
    if (excluded.has(name)) continue;
    const quoted = quoteIdentifier(name);
    const columns = database.sqlite.pragma(`table_info(${quoted})`) as Array<{
      name: string;
      pk: number;
    }>;
    const orderColumns = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    const order = (orderColumns.length ? orderColumns : columns)
      .map((column) => quoteIdentifier(column.name))
      .join(", ");
    const rows = database.sqlite
      .prepare(`SELECT * FROM ${quoted} ORDER BY ${order}`)
      .all() as Array<Record<string, unknown>>;
    hash.update(`${name}\n${columns.map((column) => column.name).join("\0")}\n`);
    for (const row of rows)
      hash.update(
        `${stableRow(
          row,
          columns.map((column) => column.name),
        )}\n`,
      );
  }
  return hash.digest("hex");
}

export function retainedBackupIds(
  backups: Array<{ id: string; createdAt: Date }>,
  now = new Date(),
): Set<string> {
  const sorted = [...backups].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const keep = new Set<string>();
  const daily = new Set<string>();
  const weekly = new Set<string>();
  const monthly = new Set<string>();
  for (const backup of sorted) {
    const ageDays = Math.floor(
      (dayStart(now).getTime() - dayStart(backup.createdAt).getTime()) / 86_400_000,
    );
    if (ageDays >= 0 && ageDays < BACKUP_RETENTION.daily) {
      const key = backup.createdAt.toISOString().slice(0, 10);
      if (!daily.has(key)) {
        daily.add(key);
        keep.add(backup.id);
      }
    }
  }
  for (const backup of sorted) {
    const ageDays = Math.floor(
      (dayStart(now).getTime() - dayStart(backup.createdAt).getTime()) / 86_400_000,
    );
    if (ageDays < BACKUP_RETENTION.daily) continue;
    const week = isoWeekKey(backup.createdAt);
    if (weekly.size < BACKUP_RETENTION.weekly && !weekly.has(week)) {
      weekly.add(week);
      keep.add(backup.id);
    }
  }
  for (const backup of sorted) {
    const month = backup.createdAt.toISOString().slice(0, 7);
    if (monthly.size < BACKUP_RETENTION.monthly && !monthly.has(month)) {
      monthly.add(month);
      keep.add(backup.id);
    }
  }
  if (sorted[0]) keep.add(sorted[0].id);
  return keep;
}

function scrubPortableSnapshot(database: EncryptedDatabase): void {
  database.sqlite.transaction(() => {
    database.sqlite.exec(
      "DELETE FROM sessions; DELETE FROM jobs; DELETE FROM analytics_metric_cache; DELETE FROM metric_invalidations; DELETE FROM backup_records;",
    );
    database.sqlite.exec("DELETE FROM import_batches WHERE status <> 'committed';");
    database.sqlite.exec(
      "UPDATE ai_provider_settings SET has_credential = 0 WHERE credential_storage = 'keyring';",
    );
  })();
}

function currentSchemaVersion(database: EncryptedDatabase): string {
  const row = database.sqlite
    .prepare("SELECT id FROM _spendlens_migrations ORDER BY id DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return row?.id ?? latestMigrationId();
}

function backupFilename(workspaceId: string, date: Date, id: string): string {
  const stamp = date.toISOString().replaceAll(":", "").replaceAll("-", "").replace(".000", "");
  return `spendlens-${workspaceId.slice(0, 8)}-${stamp}-${id.slice(0, 8)}.slbackup`;
}

function toBackupRecord(row: typeof backupRecords.$inferSelect): BackupRecord {
  return {
    id: row.id,
    kind: row.kind,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    applicationVersion: row.applicationVersion,
    schemaVersion: row.schemaVersion,
    sizeBytes: row.sizeBytes,
    validation: row.validation,
    availableForDownload: Boolean(
      row.storagePath &&
        row.validation === "valid" &&
        (row.kind === "manual" || row.kind === "scheduled"),
    ),
    errorCode: row.errorCode,
  };
}

async function ensureFreeSpace(directory: string, databasePath: string, multiplier: number) {
  const [space, database] = await Promise.all([statFilesystem(directory), stat(databasePath)]);
  const required = BigInt(Math.max(database.size * multiplier, database.size + 64 * 1024 * 1024));
  if (space !== null && space < required) throw new Error("BACKUP_INSUFFICIENT_SPACE");
}

async function statFilesystem(path: string): Promise<bigint | null> {
  try {
    const { statfs } = await import("node:fs/promises");
    const value = await statfs(path, { bigint: true });
    return value.bavail * value.bsize;
  } catch {
    return null;
  }
}

async function sameVolume(left: string, right: string): Promise<boolean> {
  if (process.platform === "win32")
    return parse(left).root.toLowerCase() === parse(right).root.toLowerCase();
  try {
    return (await stat(dirname(left))).dev === (await stat(right)).dev;
  } catch {
    return true;
  }
}

function isWithin(path: string, directory: string): boolean {
  const relative = path.startsWith(`${directory}/`) || path.startsWith(`${directory}\\`);
  return relative && !basename(path).includes("..") && path.endsWith(".slbackup");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function stableRow(row: Record<string, unknown>, columns: string[]): string {
  return JSON.stringify(
    columns.map((column) => {
      const value = row[column];
      if (Buffer.isBuffer(value)) return { buffer: value.toString("hex") };
      if (typeof value === "bigint") return { bigint: value.toString() };
      return value;
    }),
  );
}

function dayStart(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function isoWeekKey(value: Date): string {
  const date = dayStart(value);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-${week.toString().padStart(2, "0")}`;
}

function backupErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)) return error.message;
  return "BACKUP_FAILED";
}

async function removeSnapshotFiles(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true }),
  ]);
}

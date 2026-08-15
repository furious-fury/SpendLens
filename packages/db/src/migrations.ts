import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { aiProviderMigrationSql } from "./ai-provider-migration.js";
import { analyticsMigrationSql } from "./analytics-migration.js";
import { apiInfrastructureMigrationSql } from "./api-infrastructure-migration.js";
import { backupUpgradeMigrationSql } from "./backup-upgrade-migration.js";
import { classificationMigrationSql } from "./classification-migration.js";
import { financialDomainMigrationSql } from "./financial-domain-migration.js";
import { importPreviewMigrationSql } from "./import-preview-migration.js";
import { importReconciliationMigrationSql } from "./import-reconciliation-migration.js";
import { seedStarterTaxonomy } from "./taxonomy.js";
import { transactionWorkspaceMigrationSql } from "./transaction-workspace-migration.js";

export type MigrationCompatibility = "backward-compatible" | "restore-required";
export type MigrationPhase = "expand" | "copy" | "switch" | "contract";

export interface Migration {
  id: string;
  sql: string;
  applicationVersion: string;
  compatibility: MigrationCompatibility;
  phase: MigrationPhase;
  after?: (sqlite: Database.Database) => void;
}

const legacyMigration = (
  migration: Omit<Migration, "applicationVersion" | "compatibility" | "phase">,
): Migration => ({
  ...migration,
  applicationVersion: "0.1.0",
  compatibility: "backward-compatible",
  phase: "expand",
});

export const migrations: Migration[] = [
  legacyMigration({
    id: "0000_security_foundation",
    sql: `
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        setup_completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE users (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_changed_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX users_workspace_unique ON users(workspace_id);
      CREATE UNIQUE INDEX users_username_unique ON users(username);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        csrf_token_hash TEXT NOT NULL,
        ip_hash TEXT,
        user_agent_hash TEXT,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX sessions_token_hash_unique ON sessions(token_hash);
      CREATE INDEX sessions_user_id_idx ON sessions(user_id);
      CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

      CREATE TABLE security_events (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
        remote_address_hash TEXT,
        details TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX security_events_workspace_idx ON security_events(workspace_id);
      CREATE INDEX security_events_created_at_idx ON security_events(created_at);
    `,
  }),
  legacyMigration({
    id: "0001_financial_domain",
    sql: financialDomainMigrationSql,
    after(sqlite) {
      const workspaces = sqlite.prepare("SELECT id FROM workspaces").all() as Array<{
        id: string;
      }>;
      for (const workspace of workspaces) {
        seedStarterTaxonomy(sqlite, workspace.id);
      }
    },
  }),
  legacyMigration({
    id: "0002_api_jobs_audit",
    sql: apiInfrastructureMigrationSql,
  }),
  legacyMigration({
    id: "0003_import_previews",
    sql: importPreviewMigrationSql,
  }),
  legacyMigration({
    id: "0004_import_reconciliation",
    sql: importReconciliationMigrationSql,
  }),
  legacyMigration({
    id: "0005_transaction_workspace",
    sql: transactionWorkspaceMigrationSql,
  }),
  legacyMigration({
    id: "0006_classification_rules_review",
    sql: classificationMigrationSql,
  }),
  legacyMigration({
    id: "0007_ai_providers_privacy",
    sql: aiProviderMigrationSql,
  }),
  legacyMigration({
    id: "0008_analytics_metric_engine",
    sql: analyticsMigrationSql,
  }),
  {
    id: "0009_backup_restore_upgrades",
    sql: backupUpgradeMigrationSql,
    applicationVersion: "0.1.0",
    compatibility: "backward-compatible",
    phase: "expand",
  },
];

export function migrationChecksum(migration: Migration): string {
  return createHash("sha256")
    .update(`${migration.id}\0${migration.sql}\0${migration.applicationVersion}\0${migration.compatibility}\0${migration.phase}`)
    .digest("hex");
}

export function latestMigrationId(): string {
  const latest = migrations.at(-1);
  if (!latest) throw new Error("SpendLens has no registered migrations.");
  return latest.id;
}

export function pendingMigrations(sqlite: Database.Database): Migration[] {
  const exists = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_spendlens_migrations'")
    .get();
  if (!exists) return [...migrations];
  const applied = new Set(
    (sqlite.prepare("SELECT id FROM _spendlens_migrations").all() as Array<{ id: string }>).map(
      (row) => row.id,
    ),
  );
  return migrations.filter((migration) => !applied.has(migration.id));
}

export function migrationChecksums(): Record<string, string> {
  return Object.fromEntries(
    migrations.map((migration) => [migration.id, migrationChecksum(migration)]),
  );
}

export function validateMigrationEvolution(): void {
  const phases = new Map<string, Set<MigrationPhase>>();
  for (const migration of migrations) {
    const release = phases.get(migration.applicationVersion) ?? new Set<MigrationPhase>();
    release.add(migration.phase);
    phases.set(migration.applicationVersion, release);
  }
  for (const [release, releasePhases] of phases) {
    if (releasePhases.has("contract") && [...releasePhases].some((phase) => phase !== "contract")) {
      throw new Error(
        `Release ${release} cannot contract a schema while expanding or switching it.`,
      );
    }
  }
}

export function applyMigrations(sqlite: Database.Database, throughId?: string): void {
  validateMigrationEvolution();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _spendlens_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const hasMigration = sqlite.prepare("SELECT 1 FROM _spendlens_migrations WHERE id = ?");
  const recordMigration = sqlite.prepare(
    "INSERT INTO _spendlens_migrations (id, applied_at) VALUES (?, ?)",
  );

  const pending = migrations.filter(
    (migration) => (!throughId || migration.id <= throughId) && !hasMigration.get(migration.id),
  );
  const migrateAll = sqlite.transaction(() => {
    for (const migration of pending) {
      sqlite.exec(migration.sql);
      migration.after?.(sqlite);
      recordMigration.run(migration.id, Date.now());
    }
  });
  migrateAll();
}

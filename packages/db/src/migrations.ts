import type Database from "better-sqlite3";
import { apiInfrastructureMigrationSql } from "./api-infrastructure-migration.js";
import { financialDomainMigrationSql } from "./financial-domain-migration.js";
import { seedStarterTaxonomy } from "./taxonomy.js";

interface Migration {
  id: string;
  sql: string;
  after?: (sqlite: Database.Database) => void;
}

const migrations: Migration[] = [
  {
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
  },
  {
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
  },
  {
    id: "0002_api_jobs_audit",
    sql: apiInfrastructureMigrationSql,
  },
];

export function applyMigrations(sqlite: Database.Database, throughId?: string): void {
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

  const migrate = sqlite.transaction((migration: Migration) => {
    sqlite.exec(migration.sql);
    migration.after?.(sqlite);
    recordMigration.run(migration.id, Date.now());
  });

  for (const migration of migrations) {
    if (throughId && migration.id > throughId) break;
    if (!hasMigration.get(migration.id)) {
      migrate(migration);
    }
  }
}

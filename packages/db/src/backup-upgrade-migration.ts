export const backupUpgradeMigrationSql = `
  CREATE TABLE backup_records (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('manual','scheduled','safety','pre_restore','pre_rekey','pre_upgrade')),
    storage_path TEXT,
    application_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    payload_sha256 TEXT,
    durable_workspace_digest TEXT,
    size_bytes INTEGER,
    validation TEXT NOT NULL DEFAULT 'pending' CHECK (validation IN ('pending','valid','failed')),
    error_code TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE INDEX backup_records_workspace_time_idx
    ON backup_records(workspace_id, created_at DESC);
  CREATE INDEX backup_records_retention_idx
    ON backup_records(kind, validation, created_at DESC);

  CREATE TABLE release_state (
    workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    application_version TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    last_migration_id TEXT NOT NULL,
    last_migration_compatibility TEXT NOT NULL CHECK (last_migration_compatibility IN ('backward-compatible','restore-required')),
    last_migration_phase TEXT NOT NULL CHECK (last_migration_phase IN ('expand','copy','switch','contract')),
    migration_checksums TEXT NOT NULL CHECK (json_valid(migration_checksums)),
    pre_upgrade_backup_id TEXT REFERENCES backup_records(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL
  );
`;

export const apiInfrastructureMigrationSql = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    job_type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    progress_basis_points INTEGER NOT NULL DEFAULT 0
      CHECK (progress_basis_points BETWEEN 0 AND 10000),
    progress_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    available_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    cancelled_at INTEGER,
    error_code TEXT,
    error_message TEXT,
    related_import_batch_id TEXT REFERENCES import_batches(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (status IN ('succeeded','failed','cancelled') AND completed_at IS NOT NULL)
      OR (status IN ('queued','running') AND completed_at IS NULL)
    )
  );
  CREATE UNIQUE INDEX jobs_idempotency_unique
    ON jobs(workspace_id, job_type, idempotency_key);
  CREATE INDEX jobs_claim_idx ON jobs(status, available_at, created_at);
  CREATE INDEX jobs_workspace_idx ON jobs(workspace_id, created_at);
  CREATE INDEX jobs_import_idx ON jobs(related_import_batch_id);
  CREATE INDEX jobs_lease_idx ON jobs(status, lease_expires_at);

  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    before_state TEXT CHECK (before_state IS NULL OR json_valid(before_state)),
    after_state TEXT CHECK (after_state IS NULL OR json_valid(after_state)),
    related_import_batch_id TEXT REFERENCES import_batches(id) ON DELETE SET NULL,
    related_rule_id TEXT,
    related_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    request_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX audit_events_workspace_time_idx
    ON audit_events(workspace_id, created_at);
  CREATE INDEX audit_events_entity_idx
    ON audit_events(entity_type, entity_id, created_at);
  CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, created_at);
  CREATE INDEX audit_events_import_idx ON audit_events(related_import_batch_id);
  CREATE INDEX audit_events_job_idx ON audit_events(related_job_id);
`;

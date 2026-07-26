export const transactionWorkspaceMigrationSql = `
  ALTER TABLE transaction_splits
    ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'
    CHECK (scope IN ('personal', 'business'));

  CREATE INDEX transactions_workspace_amount_idx
    ON transactions(workspace_id, amount_minor, id);
  CREATE INDEX transactions_workspace_created_idx
    ON transactions(workspace_id, created_at, id);
  CREATE INDEX transactions_workspace_confidence_idx
    ON transactions(workspace_id, confidence_level, occurred_at_utc, id);
  CREATE INDEX transactions_workspace_scope_idx
    ON transactions(workspace_id, scope, occurred_at_utc, id);

  CREATE TABLE metric_invalidations (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
    start_at INTEGER,
    end_at INTEGER,
    created_at INTEGER NOT NULL,
    consumed_at INTEGER,
    CHECK (
      (start_at IS NULL AND end_at IS NULL)
      OR (start_at IS NOT NULL AND end_at IS NOT NULL AND start_at <= end_at)
    )
  );

  CREATE INDEX metric_invalidations_pending_idx
    ON metric_invalidations(workspace_id, consumed_at, created_at);
  CREATE INDEX metric_invalidations_transaction_idx
    ON metric_invalidations(transaction_id);
`;

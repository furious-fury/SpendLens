export const analyticsMigrationSql = `
  CREATE TABLE analytics_metric_cache (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    query_hash TEXT NOT NULL,
    start_at INTEGER NOT NULL,
    end_at INTEGER NOT NULL,
    currency TEXT NOT NULL,
    account_ids TEXT NOT NULL CHECK (json_valid(account_ids)),
    scopes TEXT NOT NULL CHECK (json_valid(scopes)),
    response TEXT NOT NULL CHECK (json_valid(response)),
    calculated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (workspace_id, query_hash),
    CHECK (start_at < end_at),
    CHECK (length(query_hash) = 64 AND query_hash NOT GLOB '*[^0-9a-f]*'),
    CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]')
  );

  CREATE INDEX analytics_metric_cache_workspace_range_idx
    ON analytics_metric_cache(workspace_id, start_at, end_at);
`;

export const aiProviderMigrationSql = `
  CREATE TABLE ai_provider_settings (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN (
      'openai_compatible','anthropic','gemini','ollama'
    )),
    endpoint TEXT NOT NULL,
    model TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 120000),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    local_model INTEGER NOT NULL DEFAULT 0 CHECK (local_model IN (0, 1)),
    payload_policy TEXT NOT NULL CHECK (payload_policy IN (
      'remote_redacted','local_full'
    )),
    credential_storage TEXT NOT NULL CHECK (credential_storage IN (
      'keyring','encrypted_database'
    )),
    credential_ciphertext TEXT,
    credential_nonce TEXT,
    credential_auth_tag TEXT,
    has_credential INTEGER NOT NULL DEFAULT 0 CHECK (has_credential IN (0, 1)),
    remote_payload_acknowledged_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (local_model = 1 AND payload_policy = 'local_full')
      OR (local_model = 0 AND payload_policy = 'remote_redacted')
    ),
    CHECK (
      credential_storage = 'keyring'
      OR has_credential = 0
      OR (
        credential_ciphertext IS NOT NULL
        AND credential_nonce IS NOT NULL
        AND credential_auth_tag IS NOT NULL
      )
    )
  );

  CREATE UNIQUE INDEX ai_provider_settings_workspace_provider_unique
    ON ai_provider_settings(workspace_id, provider);
  CREATE INDEX ai_provider_settings_enabled_idx
    ON ai_provider_settings(workspace_id, enabled);

  CREATE TABLE ai_classification_runs (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    provider_setting_id TEXT REFERENCES ai_provider_settings(id) ON DELETE SET NULL,
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    prompt_version TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN (
      'openai_compatible','anthropic','gemini','ollama'
    )),
    model TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')),
    result TEXT CHECK (result IS NULL OR json_valid(result)),
    error_code TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE INDEX ai_classification_runs_workspace_idx
    ON ai_classification_runs(workspace_id, created_at DESC);
  CREATE INDEX ai_classification_runs_job_idx ON ai_classification_runs(job_id);

  CREATE TABLE ai_classification_suggestions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES ai_classification_runs(id) ON DELETE CASCADE,
    suggestion TEXT NOT NULL CHECK (json_valid(suggestion)),
    confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
    reason_codes TEXT NOT NULL CHECK (json_valid(reason_codes)),
    explanation TEXT NOT NULL,
    evidence TEXT NOT NULL CHECK (json_valid(evidence)),
    input_updated_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX ai_classification_suggestions_transaction_idx
    ON ai_classification_suggestions(workspace_id, transaction_id, created_at DESC);
  CREATE INDEX ai_classification_suggestions_run_idx
    ON ai_classification_suggestions(run_id);
`;

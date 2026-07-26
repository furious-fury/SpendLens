export const importReconciliationMigrationSql = `
  ALTER TABLE parsed_source_rows ADD COLUMN fallback_fingerprint TEXT
    CHECK (fallback_fingerprint IS NULL OR (
      length(fallback_fingerprint) = 64
      AND fallback_fingerprint NOT GLOB '*[^0-9a-f]*'
    ));
  CREATE INDEX parsed_source_rows_fallback_idx
    ON parsed_source_rows(fallback_fingerprint);

  ALTER TABLE transactions ADD COLUMN fallback_fingerprint TEXT
    CHECK (fallback_fingerprint IS NULL OR (
      length(fallback_fingerprint) = 64
      AND fallback_fingerprint NOT GLOB '*[^0-9a-f]*'
    ));
  CREATE INDEX transactions_account_reference_idx
    ON transactions(account_id, source_reference);
  CREATE INDEX transactions_account_fallback_idx
    ON transactions(account_id, fallback_fingerprint);

  CREATE TABLE import_reconciliations (
    import_batch_id TEXT PRIMARY KEY NOT NULL
      REFERENCES import_batches(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
    create_account INTEGER NOT NULL DEFAULT 0 CHECK (create_account IN (0,1)),
    new_count INTEGER NOT NULL CHECK (new_count >= 0),
    duplicate_count INTEGER NOT NULL CHECK (duplicate_count >= 0),
    possible_duplicate_count INTEGER NOT NULL CHECK (possible_duplicate_count >= 0),
    conflict_count INTEGER NOT NULL CHECK (conflict_count >= 0),
    skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
    canonical_created_count INTEGER CHECK (
      canonical_created_count IS NULL OR canonical_created_count >= 0
    ),
    duplicate_linked_count INTEGER CHECK (
      duplicate_linked_count IS NULL OR duplicate_linked_count >= 0
    ),
    analyzed_at INTEGER NOT NULL,
    committed_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX import_reconciliations_account_idx
    ON import_reconciliations(account_id);

  CREATE TABLE import_match_decisions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    parsed_source_row_id TEXT NOT NULL,
    candidate_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    classification TEXT NOT NULL CHECK (
      classification IN ('new','duplicate','possible_duplicate','conflict')
    ),
    decision TEXT NOT NULL CHECK (
      decision IN ('pending','confirmed','rejected','skipped')
    ),
    match_basis TEXT NOT NULL CHECK (
      match_basis IN ('none','strong_id','fallback')
    ),
    reason_code TEXT NOT NULL,
    decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    decided_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (parsed_source_row_id, import_batch_id)
      REFERENCES parsed_source_rows(id, import_batch_id) ON DELETE CASCADE,
    CHECK (
      (classification = 'new' AND candidate_transaction_id IS NULL)
      OR (classification <> 'new' AND (
        candidate_transaction_id IS NOT NULL OR decision IN ('rejected','skipped')
      ))
    ),
    CHECK (
      classification IN ('possible_duplicate','conflict')
      OR decision = 'confirmed'
    )
  );
  CREATE UNIQUE INDEX import_match_decisions_source_unique
    ON import_match_decisions(parsed_source_row_id);
  CREATE INDEX import_match_decisions_import_idx
    ON import_match_decisions(import_batch_id);
  CREATE INDEX import_match_decisions_candidate_idx
    ON import_match_decisions(candidate_transaction_id);
  CREATE INDEX import_match_decisions_pending_idx
    ON import_match_decisions(workspace_id, decision)
    WHERE decision = 'pending';
`;

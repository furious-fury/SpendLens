export const financialDomainMigrationSql = `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    institution_name TEXT NOT NULL,
    institution_code TEXT,
    display_name TEXT NOT NULL,
    account_type TEXT NOT NULL DEFAULT 'other'
      CHECK (account_type IN ('wallet','current','savings','business','loan','cash','other')),
    base_currency TEXT NOT NULL
      CHECK (length(base_currency) = 3 AND base_currency GLOB '[A-Z][A-Z][A-Z]'),
    masked_account_number TEXT,
    is_owned INTEGER NOT NULL DEFAULT 1 CHECK (is_owned IN (0,1)),
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX accounts_workspace_idx ON accounts(workspace_id);

  CREATE TABLE owned_account_identifiers (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    institution_code TEXT NOT NULL,
    account_number_fingerprint TEXT NOT NULL
      CHECK (length(account_number_fingerprint) = 64
        AND account_number_fingerprint NOT GLOB '*[^0-9a-f]*'),
    masked_account_number TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX owned_account_identifiers_fingerprint_unique
    ON owned_account_identifiers(workspace_id, institution_code, account_number_fingerprint);
  CREATE INDEX owned_account_identifiers_account_idx
    ON owned_account_identifiers(account_id);

  CREATE TABLE import_batches (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
    source_type TEXT NOT NULL CHECK (source_type IN ('pdf','csv','xlsx','manual')),
    adapter_key TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    source_filename TEXT NOT NULL,
    file_fingerprint TEXT NOT NULL
      CHECK (length(file_fingerprint) = 64
        AND file_fingerprint NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','previewed','committed','failed')),
    statement_start_source TEXT,
    statement_end_source TEXT,
    source_timezone TEXT NOT NULL,
    opening_balance_minor INTEGER,
    closing_balance_minor INTEGER,
    balance_currency TEXT,
    committed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (opening_balance_minor IS NULL AND closing_balance_minor IS NULL
        AND balance_currency IS NULL)
      OR (balance_currency IS NOT NULL AND length(balance_currency) = 3
        AND balance_currency GLOB '[A-Z][A-Z][A-Z]')
    )
  );
  CREATE INDEX import_batches_workspace_idx ON import_batches(workspace_id);
  CREATE INDEX import_batches_account_idx ON import_batches(account_id);
  CREATE INDEX import_batches_fingerprint_idx
    ON import_batches(workspace_id, file_fingerprint);

  CREATE TABLE parsed_source_rows (
    id TEXT PRIMARY KEY NOT NULL,
    import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    source_row_index INTEGER NOT NULL CHECK (source_row_index >= 0),
    source_transaction_id TEXT,
    source_reference TEXT,
    source_timestamp TEXT NOT NULL,
    source_timezone TEXT NOT NULL,
    occurred_at_utc INTEGER NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
    amount_minor INTEGER NOT NULL
      CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
    currency TEXT NOT NULL
      CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
    balance_after_minor INTEGER,
    raw_narration TEXT,
    sender_or_recipient_name TEXT,
    institution_name TEXT,
    masked_account_number TEXT,
    row_fingerprint TEXT NOT NULL
      CHECK (length(row_fingerprint) = 64
        AND row_fingerprint NOT GLOB '*[^0-9a-f]*'),
    raw_fields TEXT NOT NULL CHECK (json_valid(raw_fields)),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX parsed_source_rows_batch_row_unique
    ON parsed_source_rows(import_batch_id, source_row_index);
  CREATE UNIQUE INDEX parsed_source_rows_id_batch_unique
    ON parsed_source_rows(id, import_batch_id);
  CREATE INDEX parsed_source_rows_batch_idx ON parsed_source_rows(import_batch_id);
  CREATE INDEX parsed_source_rows_occurred_at_idx ON parsed_source_rows(occurred_at_utc);
  CREATE INDEX parsed_source_rows_reference_idx ON parsed_source_rows(source_reference);

  CREATE TABLE counterparties (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'unknown'
      CHECK (kind IN ('person','business','merchant','bank','government','unknown')),
    institution_name TEXT,
    account_number_fingerprint TEXT
      CHECK (account_number_fingerprint IS NULL
        OR (length(account_number_fingerprint) = 64
          AND account_number_fingerprint NOT GLOB '*[^0-9a-f]*')),
    masked_account_number TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX counterparties_workspace_idx ON counterparties(workspace_id);
  CREATE INDEX counterparties_normalized_name_idx
    ON counterparties(workspace_id, normalized_name);

  CREATE TABLE categories (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    system_key TEXT,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_income INTEGER NOT NULL DEFAULT 0 CHECK (is_income IN (0,1)),
    is_expense INTEGER NOT NULL DEFAULT 0 CHECK (is_expense IN (0,1)),
    is_transfer INTEGER NOT NULL DEFAULT 0 CHECK (is_transfer IN (0,1)),
    is_essential INTEGER NOT NULL DEFAULT 0 CHECK (is_essential IN (0,1)),
    is_discretionary INTEGER NOT NULL DEFAULT 0 CHECK (is_discretionary IN (0,1)),
    is_savings INTEGER NOT NULL DEFAULT 0 CHECK (is_savings IN (0,1)),
    is_refund INTEGER NOT NULL DEFAULT 0 CHECK (is_refund IN (0,1)),
    is_fee INTEGER NOT NULL DEFAULT 0 CHECK (is_fee IN (0,1)),
    is_cash_withdrawal INTEGER NOT NULL DEFAULT 0 CHECK (is_cash_withdrawal IN (0,1)),
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK (NOT (is_essential = 1 AND is_discretionary = 1))
  );
  CREATE UNIQUE INDEX categories_workspace_slug_unique
    ON categories(workspace_id, slug);
  CREATE UNIQUE INDEX categories_workspace_system_key_unique
    ON categories(workspace_id, system_key);
  CREATE INDEX categories_parent_idx ON categories(parent_id);

  CREATE TABLE transactions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    occurred_at_utc INTEGER NOT NULL,
    source_timestamp TEXT NOT NULL,
    source_timezone TEXT NOT NULL,
    value_at_utc INTEGER,
    direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
    transaction_type TEXT NOT NULL DEFAULT 'unclassified'
      CHECK (transaction_type IN (
        'expense','income','transfer','refund','fee','cash_withdrawal','debt','unclassified'
      )),
    amount_minor INTEGER NOT NULL
      CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0
        AND amount_minor <= 9007199254740991),
    currency TEXT NOT NULL
      CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
    normalized_narration TEXT,
    source_reference TEXT,
    counterparty_id TEXT REFERENCES counterparties(id) ON DELETE SET NULL,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','business')),
    classification_source TEXT NOT NULL DEFAULT 'unclassified'
      CHECK (classification_source IN (
        'unclassified','manual','rule','history','deterministic','ai'
      )),
    confidence_level TEXT NOT NULL DEFAULT 'unknown'
      CHECK (confidence_level IN ('unknown','low','medium','high','confirmed')),
    confidence_basis_points INTEGER
      CHECK (confidence_basis_points IS NULL OR confidence_basis_points BETWEEN 0 AND 10000),
    classification_explanation TEXT,
    review_state TEXT NOT NULL DEFAULT 'unreviewed'
      CHECK (review_state IN ('unreviewed','needs_review','reviewed')),
    paired_transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
    transfer_pairing_status TEXT NOT NULL DEFAULT 'none'
      CHECK (transfer_pairing_status IN ('none','suggested','confirmed','rejected')),
    transfer_pairing_confidence_basis_points INTEGER
      CHECK (transfer_pairing_confidence_basis_points IS NULL
        OR transfer_pairing_confidence_basis_points BETWEEN 0 AND 10000),
    transfer_pairing_source TEXT
      CHECK (transfer_pairing_source IS NULL
        OR transfer_pairing_source IN ('automatic','manual')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (paired_transaction_id IS NULL OR paired_transaction_id <> id),
    CHECK (transfer_pairing_status <> 'confirmed'
      OR (paired_transaction_id IS NOT NULL AND transaction_type = 'transfer'))
  );
  CREATE INDEX transactions_workspace_date_idx
    ON transactions(workspace_id, occurred_at_utc);
  CREATE INDEX transactions_account_idx ON transactions(account_id);
  CREATE INDEX transactions_category_idx ON transactions(category_id);
  CREATE INDEX transactions_counterparty_idx ON transactions(counterparty_id);
  CREATE INDEX transactions_review_state_idx
    ON transactions(workspace_id, review_state);
  CREATE INDEX transactions_pair_idx ON transactions(paired_transaction_id);

  CREATE TABLE transaction_sources (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    parsed_source_row_id TEXT NOT NULL,
    import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    link_type TEXT NOT NULL CHECK (link_type IN ('original','duplicate')),
    match_confidence TEXT NOT NULL CHECK (match_confidence IN ('strong','medium','weak','manual')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (transaction_id, parsed_source_row_id),
    UNIQUE (parsed_source_row_id),
    FOREIGN KEY (parsed_source_row_id, import_batch_id)
      REFERENCES parsed_source_rows(id, import_batch_id) ON DELETE CASCADE
  );
  CREATE INDEX transaction_sources_transaction_idx
    ON transaction_sources(transaction_id);
  CREATE INDEX transaction_sources_import_batch_idx
    ON transaction_sources(import_batch_id);

  CREATE TABLE transaction_split_sets (
    id TEXT PRIMARY KEY NOT NULL,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','active','superseded')),
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    activated_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX transaction_split_sets_active_unique
    ON transaction_split_sets(transaction_id) WHERE status = 'active';
  CREATE INDEX transaction_split_sets_transaction_idx
    ON transaction_split_sets(transaction_id);

  CREATE TABLE transaction_splits (
    id TEXT PRIMARY KEY NOT NULL,
    split_set_id TEXT NOT NULL REFERENCES transaction_split_sets(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL
      CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
    currency TEXT NOT NULL
      CHECK (length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
    note TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX transaction_splits_set_idx ON transaction_splits(split_set_id);
  CREATE INDEX transaction_splits_category_idx ON transaction_splits(category_id);

  CREATE TABLE transaction_notes (
    id TEXT PRIMARY KEY NOT NULL,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX transaction_notes_transaction_idx ON transaction_notes(transaction_id);

  CREATE TABLE tags (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX tags_workspace_slug_unique ON tags(workspace_id, slug);
  CREATE INDEX tags_workspace_idx ON tags(workspace_id);

  CREATE TABLE transaction_tags (
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (transaction_id, tag_id)
  );

  CREATE TABLE transaction_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    source TEXT NOT NULL CHECK (source IN ('manual','rule','system','import')),
    before_values TEXT NOT NULL CHECK (json_valid(before_values)),
    after_values TEXT NOT NULL CHECK (json_valid(after_values)),
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX transaction_revisions_number_unique
    ON transaction_revisions(transaction_id, revision_number);
  CREATE INDEX transaction_revisions_transaction_idx
    ON transaction_revisions(transaction_id);

  CREATE TRIGGER transaction_split_sets_validate_active_insert
  BEFORE INSERT ON transaction_split_sets
  WHEN NEW.status = 'active'
  BEGIN
    SELECT RAISE(ABORT, 'split sets must be created as drafts before activation');
  END;

  CREATE TRIGGER transaction_split_sets_validate_activation
  BEFORE UPDATE OF status ON transaction_split_sets
  WHEN NEW.status = 'active' AND OLD.status <> 'active'
  BEGIN
    SELECT CASE WHEN (
      SELECT count(*) FROM transaction_splits WHERE split_set_id = NEW.id
    ) < 2 THEN RAISE(ABORT, 'an active split set requires at least two splits') END;
    SELECT CASE WHEN (
      SELECT coalesce(sum(amount_minor), 0) FROM transaction_splits WHERE split_set_id = NEW.id
    ) <> (
      SELECT amount_minor FROM transactions WHERE id = NEW.transaction_id
    ) THEN RAISE(ABORT, 'split amounts must equal the parent transaction amount') END;
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM transaction_splits AS split
      JOIN transactions AS parent ON parent.id = NEW.transaction_id
      WHERE split.split_set_id = NEW.id AND split.currency <> parent.currency
    ) THEN RAISE(ABORT, 'split currencies must match the parent transaction') END;
  END;

  CREATE TRIGGER transaction_splits_active_insert_guard
  BEFORE INSERT ON transaction_splits
  WHEN (SELECT status FROM transaction_split_sets WHERE id = NEW.split_set_id) = 'active'
  BEGIN
    SELECT RAISE(ABORT, 'active split sets are immutable');
  END;

  CREATE TRIGGER transaction_splits_active_update_guard
  BEFORE UPDATE ON transaction_splits
  WHEN (SELECT status FROM transaction_split_sets WHERE id = OLD.split_set_id) = 'active'
    OR (SELECT status FROM transaction_split_sets WHERE id = NEW.split_set_id) = 'active'
  BEGIN
    SELECT RAISE(ABORT, 'active split sets are immutable');
  END;

  CREATE TRIGGER transaction_splits_active_delete_guard
  BEFORE DELETE ON transaction_splits
  WHEN (SELECT status FROM transaction_split_sets WHERE id = OLD.split_set_id) = 'active'
  BEGIN
    SELECT RAISE(ABORT, 'active split sets are immutable');
  END;

  CREATE TRIGGER transactions_active_split_guard
  BEFORE UPDATE OF amount_minor, currency ON transactions
  WHEN EXISTS (
    SELECT 1 FROM transaction_split_sets
    WHERE transaction_id = OLD.id AND status = 'active'
  )
  BEGIN
    SELECT CASE WHEN NEW.amount_minor <> OLD.amount_minor OR NEW.currency <> OLD.currency
      THEN RAISE(ABORT, 'deactivate the split set before changing amount or currency') END;
  END;

  CREATE TRIGGER categories_workspace_parent_insert_guard
  BEFORE INSERT ON categories
  WHEN NEW.parent_id IS NOT NULL
    AND (SELECT workspace_id FROM categories WHERE id = NEW.parent_id) <> NEW.workspace_id
  BEGIN
    SELECT RAISE(ABORT, 'a category parent must belong to the same workspace');
  END;

  CREATE TRIGGER categories_workspace_parent_update_guard
  BEFORE UPDATE OF parent_id, workspace_id ON categories
  WHEN NEW.parent_id IS NOT NULL
    AND (SELECT workspace_id FROM categories WHERE id = NEW.parent_id) <> NEW.workspace_id
  BEGIN
    SELECT RAISE(ABORT, 'a category parent must belong to the same workspace');
  END;
`;

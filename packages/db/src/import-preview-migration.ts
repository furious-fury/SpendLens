export const importPreviewMigrationSql = `
  ALTER TABLE import_batches ADD COLUMN institution_name TEXT;
  ALTER TABLE import_batches ADD COLUMN masked_account_number TEXT;
  ALTER TABLE import_batches ADD COLUMN declared_inflow_minor INTEGER
    CHECK (declared_inflow_minor IS NULL OR
      (typeof(declared_inflow_minor) = 'integer' AND declared_inflow_minor >= 0));
  ALTER TABLE import_batches ADD COLUMN declared_outflow_minor INTEGER
    CHECK (declared_outflow_minor IS NULL OR
      (typeof(declared_outflow_minor) = 'integer' AND declared_outflow_minor >= 0));
  ALTER TABLE import_batches ADD COLUMN parsed_inflow_minor INTEGER
    CHECK (parsed_inflow_minor IS NULL OR
      (typeof(parsed_inflow_minor) = 'integer' AND parsed_inflow_minor >= 0));
  ALTER TABLE import_batches ADD COLUMN parsed_outflow_minor INTEGER
    CHECK (parsed_outflow_minor IS NULL OR
      (typeof(parsed_outflow_minor) = 'integer' AND parsed_outflow_minor >= 0));
  ALTER TABLE import_batches ADD COLUMN transaction_count INTEGER
    CHECK (transaction_count IS NULL OR
      (typeof(transaction_count) = 'integer' AND transaction_count >= 0));
  ALTER TABLE import_batches ADD COLUMN reconciliation_status TEXT
    CHECK (reconciliation_status IS NULL OR reconciliation_status IN ('matched','mismatched'));
`;

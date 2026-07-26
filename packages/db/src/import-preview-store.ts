import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ParsedImportRowInput {
  sourceRowIndex: number;
  sourceTransactionId: string;
  sourceTimestamp: string;
  occurredAtUtc: Date;
  direction: "debit" | "credit";
  amountMinor: number;
  currency: string;
  narration: string;
  rowFingerprint: string;
  rawFields: Record<string, unknown>;
}

export interface SaveImportPreviewInput {
  id?: string;
  workspaceId: string;
  sourceFilename: string;
  fileFingerprint: string;
  adapterKey: string;
  adapterVersion: string;
  institutionName: string;
  maskedAccountNumber: string | null;
  statementStartSource: string;
  statementEndSource: string;
  sourceTimezone: string;
  declaredInflowMinor: number;
  declaredOutflowMinor: number;
  parsedInflowMinor: number;
  parsedOutflowMinor: number;
  reconciliationStatus: "matched" | "mismatched";
  rows: ParsedImportRowInput[];
}

export interface StoredImportPreview {
  id: string;
  workspaceId: string;
  status: "previewed";
  adapterKey: string;
  adapterVersion: string;
  institutionName: string;
  maskedAccountNumber: string | null;
  statementStartSource: string;
  statementEndSource: string;
  sourceTimezone: string;
  declaredInflowMinor: number;
  declaredOutflowMinor: number;
  parsedInflowMinor: number;
  parsedOutflowMinor: number;
  transactionCount: number;
  reconciliationStatus: "matched" | "mismatched";
  createdAt: Date;
}

export interface ExistingImport {
  id: string;
  status: "pending" | "previewed" | "committed";
}

export class ImportPreviewStore {
  readonly #sqlite: () => Database.Database;
  readonly #clock: () => number;

  constructor(sqlite: Database.Database | (() => Database.Database), clock = Date.now) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#clock = clock;
  }

  findByFingerprint(workspaceId: string, fingerprint: string): ExistingImport | null {
    const row = this.#sqlite()
      .prepare(
        `SELECT id, status FROM import_batches
         WHERE workspace_id = ? AND file_fingerprint = ?
           AND status IN ('pending','previewed','committed')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(workspaceId, fingerprint) as ExistingImport | undefined;
    return row ?? null;
  }

  get(workspaceId: string, importId: string): StoredImportPreview | null {
    const row = this.#sqlite()
      .prepare(
        `SELECT * FROM import_batches
         WHERE workspace_id = ? AND id = ? AND status = 'previewed'`,
      )
      .get(workspaceId, importId) as ImportPreviewRow | undefined;
    return row ? mapPreview(row) : null;
  }

  save(input: SaveImportPreviewInput, afterSave?: (importId: string) => void): StoredImportPreview {
    const sqlite = this.#sqlite();
    const now = this.#clock();
    const importId = input.id ?? randomUUID();
    sqlite.transaction(() => {
      sqlite
        .prepare(
          `INSERT INTO import_batches (
            id, workspace_id, source_type, adapter_key, adapter_version,
            source_filename, file_fingerprint, status, statement_start_source,
            statement_end_source, source_timezone, balance_currency,
            institution_name, masked_account_number, declared_inflow_minor,
            declared_outflow_minor, parsed_inflow_minor, parsed_outflow_minor,
            transaction_count, reconciliation_status, created_at, updated_at
          ) VALUES (
            ?, ?, 'pdf', ?, ?, ?, ?, 'previewed', ?, ?, ?, 'NGN',
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          )`,
        )
        .run(
          importId,
          input.workspaceId,
          input.adapterKey,
          input.adapterVersion,
          input.sourceFilename,
          input.fileFingerprint,
          input.statementStartSource,
          input.statementEndSource,
          input.sourceTimezone,
          input.institutionName,
          input.maskedAccountNumber,
          input.declaredInflowMinor,
          input.declaredOutflowMinor,
          input.parsedInflowMinor,
          input.parsedOutflowMinor,
          input.rows.length,
          input.reconciliationStatus,
          now,
          now,
        );

      const insertRow = sqlite.prepare(
        `INSERT INTO parsed_source_rows (
          id, import_batch_id, source_row_index, source_transaction_id,
          source_reference, source_timestamp, source_timezone, occurred_at_utc,
          direction, amount_minor, currency, raw_narration, row_fingerprint,
          raw_fields, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of input.rows) {
        insertRow.run(
          randomUUID(),
          importId,
          row.sourceRowIndex,
          row.sourceTransactionId,
          row.sourceTransactionId,
          row.sourceTimestamp,
          input.sourceTimezone,
          row.occurredAtUtc.getTime(),
          row.direction,
          row.amountMinor,
          row.currency,
          row.narration,
          row.rowFingerprint,
          JSON.stringify(row.rawFields),
          now,
        );
      }
      afterSave?.(importId);
    })();

    const preview = this.get(input.workspaceId, importId);
    if (!preview) throw new Error("The saved import preview could not be read.");
    return preview;
  }
}

interface ImportPreviewRow {
  id: string;
  workspace_id: string;
  status: string;
  adapter_key: string;
  adapter_version: string;
  institution_name: string | null;
  masked_account_number: string | null;
  statement_start_source: string | null;
  statement_end_source: string | null;
  source_timezone: string;
  declared_inflow_minor: number | null;
  declared_outflow_minor: number | null;
  parsed_inflow_minor: number | null;
  parsed_outflow_minor: number | null;
  transaction_count: number | null;
  reconciliation_status: string | null;
  created_at: number;
}

function mapPreview(row: ImportPreviewRow): StoredImportPreview {
  if (
    !row.institution_name ||
    !row.statement_start_source ||
    !row.statement_end_source ||
    row.declared_inflow_minor === null ||
    row.declared_outflow_minor === null ||
    row.parsed_inflow_minor === null ||
    row.parsed_outflow_minor === null ||
    row.transaction_count === null ||
    !isReconciliationStatus(row.reconciliation_status)
  ) {
    throw new Error("The import preview record is incomplete.");
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: "previewed",
    adapterKey: row.adapter_key,
    adapterVersion: row.adapter_version,
    institutionName: row.institution_name,
    maskedAccountNumber: row.masked_account_number,
    statementStartSource: row.statement_start_source,
    statementEndSource: row.statement_end_source,
    sourceTimezone: row.source_timezone,
    declaredInflowMinor: row.declared_inflow_minor,
    declaredOutflowMinor: row.declared_outflow_minor,
    parsedInflowMinor: row.parsed_inflow_minor,
    parsedOutflowMinor: row.parsed_outflow_minor,
    transactionCount: row.transaction_count,
    reconciliationStatus: row.reconciliation_status,
    createdAt: new Date(row.created_at),
  };
}

function isReconciliationStatus(value: string | null): value is "matched" | "mismatched" {
  return value === "matched" || value === "mismatched";
}

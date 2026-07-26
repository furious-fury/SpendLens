import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { fallbackTransactionFingerprint, normalizeNarration } from "./transaction-identity.js";

export type ImportMatchClassification = "new" | "duplicate" | "possible_duplicate" | "conflict";
export type ImportMatchDecision = "pending" | "confirmed" | "rejected" | "skipped";
export type ImportDecisionAction = "confirm_duplicate" | "keep_separate" | "skip";

export interface TransactionMatchSnapshot {
  transactionId: string | null;
  sourceTransactionId: string | null;
  occurredAt: Date;
  direction: "debit" | "credit";
  amountMinor: number;
  currency: string;
  narration: string;
}

export interface ImportAttentionItem {
  decisionId: string;
  classification: "possible_duplicate" | "conflict";
  decision: ImportMatchDecision;
  reasonCode: string;
  source: TransactionMatchSnapshot;
  candidate: TransactionMatchSnapshot;
}

export interface ImportDeduplicationSummary {
  importId: string;
  status: "analyzed" | "committed";
  accountId: string | null;
  willCreateAccount: boolean;
  counts: {
    new: number;
    duplicate: number;
    possibleDuplicate: number;
    conflict: number;
    skipped: number;
  };
  pendingDecisionCount: number;
  attentionItems: ImportAttentionItem[];
  commitResult: {
    canonicalTransactionsCreated: number;
    duplicateSourcesLinked: number;
    skippedSources: number;
    committedAt: Date;
  } | null;
}

export interface AnalyzeImportInput {
  workspaceId: string;
  importId: string;
  accountId?: string;
}

export interface ApplyImportDecisionsInput {
  workspaceId: string;
  importId: string;
  actorUserId: string;
  decisions: Array<{
    decisionId: string;
    action: ImportDecisionAction;
  }>;
}

export interface CommitImportInput {
  workspaceId: string;
  importId: string;
  confirmUnreconciled: boolean;
}

export class ImportReconciliationError extends Error {
  constructor(
    readonly code:
      | "IMPORT_NOT_FOUND"
      | "ACCOUNT_NOT_FOUND"
      | "ACCOUNT_AMBIGUOUS"
      | "IMPORT_RECONCILIATION_REQUIRED"
      | "IMPORT_DECISIONS_REQUIRED"
      | "IMPORT_DECISION_NOT_FOUND"
      | "IMPORT_DECISION_INVALID"
      | "IMPORT_UNRECONCILED_CONFIRMATION_REQUIRED"
      | "IMPORT_DELETE_BLOCKED",
    message: string,
  ) {
    super(message);
    this.name = "ImportReconciliationError";
  }
}

export class ImportReconciliationStore {
  readonly #sqlite: () => Database.Database;
  readonly #clock: () => number;

  constructor(sqlite: Database.Database | (() => Database.Database), clock = Date.now) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#clock = clock;
  }

  analyze(
    input: AnalyzeImportInput,
    afterAnalyze?: (summary: ImportDeduplicationSummary) => void,
  ): ImportDeduplicationSummary {
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const batch = this.#batch(input.workspaceId, input.importId);
      if (batch.status === "committed") return this.#summary(batch);
      const account = this.#resolveAccount(batch, input.accountId);
      const existing = this.#existingTransactions(account?.id ?? null);
      const rows = this.#sourceRows(batch.id);
      if (rows.length === 0) {
        throw new ImportReconciliationError(
          "IMPORT_RECONCILIATION_REQUIRED",
          "The import preview does not contain parsed transactions.",
        );
      }

      this.#backfillExistingFallbacks(existing);
      this.#backfillSourceFallbacks(rows);
      const matches = matchSourceRows(rows, existing);
      const now = this.#clock();

      sqlite.prepare("DELETE FROM import_match_decisions WHERE import_batch_id = ?").run(batch.id);
      sqlite.prepare("DELETE FROM import_reconciliations WHERE import_batch_id = ?").run(batch.id);
      const insert = sqlite.prepare(
        `INSERT INTO import_match_decisions (
          id, workspace_id, import_batch_id, parsed_source_row_id,
          candidate_transaction_id, classification, decision, match_basis,
          reason_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const match of matches) {
        insert.run(
          randomUUID(),
          input.workspaceId,
          batch.id,
          match.source.id,
          match.candidate?.id ?? null,
          match.classification,
          match.classification === "new" || match.classification === "duplicate"
            ? "confirmed"
            : "pending",
          match.basis,
          match.reasonCode,
          now,
          now,
        );
      }

      const counts = countMatches(matches);
      sqlite
        .prepare(
          `INSERT INTO import_reconciliations (
            import_batch_id, account_id, create_account, new_count,
            duplicate_count, possible_duplicate_count, conflict_count,
            skipped_count, analyzed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          batch.id,
          account?.id ?? null,
          account ? 0 : 1,
          counts.new,
          counts.duplicate,
          counts.possibleDuplicate,
          counts.conflict,
          now,
          now,
        );
      if (account) {
        sqlite
          .prepare("UPDATE import_batches SET account_id = ?, updated_at = ? WHERE id = ?")
          .run(account.id, now, batch.id);
      }

      const summary = this.#summary(batch);
      afterAnalyze?.(summary);
      return summary;
    })();
  }

  get(workspaceId: string, importId: string): ImportDeduplicationSummary {
    return this.#summary(this.#batch(workspaceId, importId));
  }

  applyDecisions(
    input: ApplyImportDecisionsInput,
    afterDecision?: (summary: ImportDeduplicationSummary) => void,
  ): ImportDeduplicationSummary {
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const batch = this.#batch(input.workspaceId, input.importId);
      if (batch.status === "committed") return this.#summary(batch);
      this.#reconciliation(batch.id);
      const now = this.#clock();
      const read = sqlite.prepare(
        `SELECT id, classification FROM import_match_decisions
         WHERE id = ? AND workspace_id = ? AND import_batch_id = ?`,
      );
      const update = sqlite.prepare(
        `UPDATE import_match_decisions SET
          decision = ?, decided_by_user_id = ?, decided_at = ?, updated_at = ?
         WHERE id = ?`,
      );
      const seen = new Set<string>();
      for (const choice of input.decisions) {
        if (seen.has(choice.decisionId)) {
          throw new ImportReconciliationError(
            "IMPORT_DECISION_INVALID",
            "Each match decision can be submitted only once per request.",
          );
        }
        seen.add(choice.decisionId);
        const decision = read.get(choice.decisionId, input.workspaceId, input.importId) as
          | DecisionIdentityRow
          | undefined;
        if (!decision) {
          throw new ImportReconciliationError(
            "IMPORT_DECISION_NOT_FOUND",
            "A requested import match decision was not found.",
          );
        }
        if (
          decision.classification !== "possible_duplicate" &&
          decision.classification !== "conflict"
        ) {
          throw new ImportReconciliationError(
            "IMPORT_DECISION_INVALID",
            "Automatic new and duplicate matches cannot be manually changed.",
          );
        }
        update.run(decisionForAction(choice.action), input.actorUserId, now, now, decision.id);
      }
      const skipped = sqlite
        .prepare(
          `SELECT count(*) AS count FROM import_match_decisions
           WHERE import_batch_id = ? AND decision = 'skipped'`,
        )
        .get(batch.id) as CountRow;
      sqlite
        .prepare(
          `UPDATE import_reconciliations
           SET skipped_count = ?, updated_at = ? WHERE import_batch_id = ?`,
        )
        .run(skipped.count, now, batch.id);
      const summary = this.#summary(batch);
      afterDecision?.(summary);
      return summary;
    })();
  }

  commit(
    input: CommitImportInput,
    afterCommit?: (summary: ImportDeduplicationSummary) => void,
  ): ImportDeduplicationSummary {
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const batch = this.#batch(input.workspaceId, input.importId);
      if (batch.status === "committed") return this.#summary(batch);
      const reconciliation = this.#reconciliation(batch.id);
      if (batch.reconciliation_status === "mismatched" && !input.confirmUnreconciled) {
        throw new ImportReconciliationError(
          "IMPORT_UNRECONCILED_CONFIRMATION_REQUIRED",
          "Confirm the statement total mismatch before committing this import.",
        );
      }
      const pending = sqlite
        .prepare(
          `SELECT count(*) AS count FROM import_match_decisions
           WHERE import_batch_id = ? AND decision = 'pending'`,
        )
        .get(batch.id) as CountRow;
      if (pending.count > 0) {
        throw new ImportReconciliationError(
          "IMPORT_DECISIONS_REQUIRED",
          "Resolve every possible duplicate and conflict before committing the import.",
        );
      }

      const now = this.#clock();
      const accountId =
        reconciliation.account_id ??
        this.#resolveAccount(batch)?.id ??
        this.#createAccountForImport(batch, input.workspaceId, now);
      const decisions = sqlite
        .prepare(
          `SELECT
            d.id, d.classification, d.decision, d.match_basis,
            d.candidate_transaction_id,
            r.id AS source_id, r.source_transaction_id, r.source_timestamp,
            r.source_timezone, r.occurred_at_utc, r.direction, r.amount_minor,
            r.currency, r.raw_narration, r.fallback_fingerprint
           FROM import_match_decisions d
           JOIN parsed_source_rows r ON r.id = d.parsed_source_row_id
           WHERE d.import_batch_id = ?
           ORDER BY r.source_row_index ASC`,
        )
        .all(batch.id) as CommitDecisionRow[];

      let created = 0;
      let linked = 0;
      let skipped = 0;
      const insertTransaction = sqlite.prepare(
        `INSERT INTO transactions (
          id, workspace_id, account_id, occurred_at_utc, source_timestamp,
          source_timezone, direction, amount_minor, currency,
          normalized_narration, source_reference, fallback_fingerprint,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertSource = sqlite.prepare(
        `INSERT INTO transaction_sources (
          transaction_id, parsed_source_row_id, import_batch_id,
          link_type, match_confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      );

      for (const decision of decisions) {
        if (decision.decision === "skipped") {
          skipped += 1;
          continue;
        }
        const shouldLink =
          decision.classification === "duplicate" || decision.decision === "confirmed";
        if (shouldLink && decision.candidate_transaction_id) {
          insertSource.run(
            decision.candidate_transaction_id,
            decision.source_id,
            batch.id,
            "duplicate",
            decision.classification === "duplicate" ? "strong" : "manual",
            now,
          );
          linked += 1;
          continue;
        }

        const transactionId = randomUUID();
        const fallback =
          decision.fallback_fingerprint ??
          fallbackTransactionFingerprint({
            occurredAtUtc: decision.occurred_at_utc,
            currency: decision.currency,
            direction: decision.direction,
            amountMinor: decision.amount_minor,
            narration: decision.raw_narration,
          });
        insertTransaction.run(
          transactionId,
          input.workspaceId,
          accountId,
          decision.occurred_at_utc,
          decision.source_timestamp,
          decision.source_timezone,
          decision.direction,
          decision.amount_minor,
          decision.currency,
          cleanNarration(decision.raw_narration),
          decision.source_transaction_id,
          fallback,
          now,
          now,
        );
        insertSource.run(
          transactionId,
          decision.source_id,
          batch.id,
          "original",
          decision.source_transaction_id ? "strong" : "medium",
          now,
        );
        created += 1;
      }

      sqlite
        .prepare(
          `UPDATE import_batches SET
            account_id = ?, status = 'committed', committed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'previewed'`,
        )
        .run(accountId, now, now, batch.id);
      sqlite
        .prepare(
          `UPDATE import_reconciliations SET
            account_id = ?, create_account = 0, canonical_created_count = ?,
            duplicate_linked_count = ?, skipped_count = ?, committed_at = ?,
            updated_at = ?
           WHERE import_batch_id = ?`,
        )
        .run(accountId, created, linked, skipped, now, now, batch.id);

      const committedBatch = this.#batch(input.workspaceId, input.importId);
      const summary = this.#summary(committedBatch);
      afterCommit?.(summary);
      return summary;
    })();
  }

  deleteImport(
    workspaceId: string,
    importId: string,
    afterDelete?: (result: { orphanedTransactionsDeleted: number }) => void,
  ): { orphanedTransactionsDeleted: number } {
    const sqlite = this.#sqlite();
    try {
      return sqlite.transaction(() => {
        this.#batch(workspaceId, importId);
        const linked = sqlite
          .prepare(
            `SELECT DISTINCT transaction_id AS transactionId
             FROM transaction_sources WHERE import_batch_id = ?`,
          )
          .all(importId) as Array<{ transactionId: string }>;
        sqlite
          .prepare("DELETE FROM import_batches WHERE id = ? AND workspace_id = ?")
          .run(importId, workspaceId);
        let deleted = 0;
        const deleteOrphan = sqlite.prepare(
          `DELETE FROM transactions
           WHERE id = ?
             AND workspace_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM transaction_sources WHERE transaction_id = transactions.id
             )`,
        );
        for (const transaction of linked) {
          deleted += deleteOrphan.run(transaction.transactionId, workspaceId).changes;
        }
        const result = { orphanedTransactionsDeleted: deleted };
        afterDelete?.(result);
        return result;
      })();
    } catch (error) {
      if (error instanceof ImportReconciliationError) throw error;
      throw new ImportReconciliationError(
        "IMPORT_DELETE_BLOCKED",
        "This import cannot be deleted while another pending review depends on it.",
      );
    }
  }

  #batch(workspaceId: string, importId: string): ImportBatchRow {
    const batch = this.#sqlite()
      .prepare("SELECT * FROM import_batches WHERE id = ? AND workspace_id = ?")
      .get(importId, workspaceId) as ImportBatchRow | undefined;
    if (!batch) {
      throw new ImportReconciliationError(
        "IMPORT_NOT_FOUND",
        "The requested import was not found.",
      );
    }
    return batch;
  }

  #reconciliation(importId: string): ReconciliationRow {
    const row = this.#sqlite()
      .prepare("SELECT * FROM import_reconciliations WHERE import_batch_id = ?")
      .get(importId) as ReconciliationRow | undefined;
    if (!row) {
      throw new ImportReconciliationError(
        "IMPORT_RECONCILIATION_REQUIRED",
        "Analyze this import for duplicates before committing it.",
      );
    }
    return row;
  }

  #resolveAccount(batch: ImportBatchRow, requestedId?: string): AccountRow | null {
    const sqlite = this.#sqlite();
    if (requestedId) {
      const account = sqlite
        .prepare(
          `SELECT id, institution_name, masked_account_number
           FROM accounts WHERE id = ? AND workspace_id = ? AND archived_at IS NULL`,
        )
        .get(requestedId, batch.workspace_id) as AccountRow | undefined;
      if (!account) {
        throw new ImportReconciliationError(
          "ACCOUNT_NOT_FOUND",
          "The selected account was not found.",
        );
      }
      return account;
    }

    const accounts = (
      batch.masked_account_number
        ? sqlite
            .prepare(
              `SELECT id, institution_name, masked_account_number
               FROM accounts
               WHERE workspace_id = ? AND institution_name = ?
                 AND masked_account_number = ? AND archived_at IS NULL`,
            )
            .all(batch.workspace_id, batch.institution_name ?? "", batch.masked_account_number)
        : sqlite
            .prepare(
              `SELECT id, institution_name, masked_account_number
               FROM accounts
               WHERE workspace_id = ? AND institution_name = ?
                 AND archived_at IS NULL`,
            )
            .all(batch.workspace_id, batch.institution_name ?? "")
    ) as AccountRow[];
    if (accounts.length > 1) {
      throw new ImportReconciliationError(
        "ACCOUNT_AMBIGUOUS",
        "Choose which account this statement belongs to.",
      );
    }
    return accounts[0] ?? null;
  }

  #sourceRows(importId: string): SourceRow[] {
    return this.#sqlite()
      .prepare(
        `SELECT * FROM parsed_source_rows
         WHERE import_batch_id = ? ORDER BY source_row_index ASC`,
      )
      .all(importId) as SourceRow[];
  }

  #existingTransactions(accountId: string | null): ExistingTransactionRow[] {
    if (!accountId) return [];
    return this.#sqlite()
      .prepare(
        `SELECT * FROM transactions
         WHERE account_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(accountId) as ExistingTransactionRow[];
  }

  #backfillExistingFallbacks(rows: ExistingTransactionRow[]): void {
    const update = this.#sqlite().prepare(
      "UPDATE transactions SET fallback_fingerprint = ? WHERE id = ?",
    );
    for (const row of rows) {
      if (row.fallback_fingerprint) continue;
      row.fallback_fingerprint = fallbackTransactionFingerprint({
        occurredAtUtc: row.occurred_at_utc,
        currency: row.currency,
        direction: row.direction,
        amountMinor: row.amount_minor,
        narration: row.normalized_narration,
      });
      update.run(row.fallback_fingerprint, row.id);
    }
  }

  #backfillSourceFallbacks(rows: SourceRow[]): void {
    const update = this.#sqlite().prepare(
      "UPDATE parsed_source_rows SET fallback_fingerprint = ? WHERE id = ?",
    );
    for (const row of rows) {
      if (row.fallback_fingerprint) continue;
      row.fallback_fingerprint = fallbackTransactionFingerprint({
        occurredAtUtc: row.occurred_at_utc,
        currency: row.currency,
        direction: row.direction,
        amountMinor: row.amount_minor,
        narration: row.raw_narration,
      });
      update.run(row.fallback_fingerprint, row.id);
    }
  }

  #createAccountForImport(batch: ImportBatchRow, workspaceId: string, now: number): string {
    const id = randomUUID();
    const institution = batch.institution_name ?? "Imported account";
    const displayName = batch.masked_account_number
      ? `${institution} ${batch.masked_account_number}`
      : institution;
    this.#sqlite()
      .prepare(
        `INSERT INTO accounts (
          id, workspace_id, institution_name, institution_code, display_name,
          account_type, base_currency, masked_account_number, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        institution,
        batch.adapter_key.startsWith("palmpay") ? "palmpay" : null,
        displayName,
        batch.adapter_key.startsWith("palmpay") ? "wallet" : "other",
        batch.balance_currency ?? "NGN",
        batch.masked_account_number,
        now,
        now,
      );
    return id;
  }

  #summary(batch: ImportBatchRow): ImportDeduplicationSummary {
    const reconciliation = this.#reconciliation(batch.id);
    const attentionRows = this.#sqlite()
      .prepare(
        `SELECT
          d.id, d.classification, d.decision, d.reason_code,
          r.source_transaction_id, r.occurred_at_utc, r.direction,
          r.amount_minor, r.currency, r.raw_narration,
          t.id AS candidate_id, t.source_reference AS candidate_source_reference,
          t.occurred_at_utc AS candidate_occurred_at_utc,
          t.direction AS candidate_direction, t.amount_minor AS candidate_amount_minor,
          t.currency AS candidate_currency,
          t.normalized_narration AS candidate_narration
         FROM import_match_decisions d
         JOIN parsed_source_rows r ON r.id = d.parsed_source_row_id
         JOIN transactions t ON t.id = d.candidate_transaction_id
         WHERE d.import_batch_id = ?
           AND d.classification IN ('possible_duplicate','conflict')
         ORDER BY r.source_row_index ASC`,
      )
      .all(batch.id) as AttentionRow[];
    const pendingDecisionCount = attentionRows.filter((row) => row.decision === "pending").length;
    return {
      importId: batch.id,
      status: batch.status === "committed" ? "committed" : "analyzed",
      accountId: reconciliation.account_id,
      willCreateAccount: batch.status !== "committed" && reconciliation.create_account === 1,
      counts: {
        new: reconciliation.new_count,
        duplicate: reconciliation.duplicate_count,
        possibleDuplicate: reconciliation.possible_duplicate_count,
        conflict: reconciliation.conflict_count,
        skipped: reconciliation.skipped_count,
      },
      pendingDecisionCount,
      attentionItems: attentionRows.map((row) => ({
        decisionId: row.id,
        classification: row.classification,
        decision: row.decision,
        reasonCode: row.reason_code,
        source: {
          transactionId: null,
          sourceTransactionId: row.source_transaction_id,
          occurredAt: new Date(row.occurred_at_utc),
          direction: row.direction,
          amountMinor: row.amount_minor,
          currency: row.currency,
          narration: cleanNarration(row.raw_narration),
        },
        candidate: {
          transactionId: row.candidate_id,
          sourceTransactionId: row.candidate_source_reference,
          occurredAt: new Date(row.candidate_occurred_at_utc),
          direction: row.candidate_direction,
          amountMinor: row.candidate_amount_minor,
          currency: row.candidate_currency,
          narration: cleanNarration(row.candidate_narration),
        },
      })),
      commitResult:
        reconciliation.committed_at === null ||
        reconciliation.canonical_created_count === null ||
        reconciliation.duplicate_linked_count === null
          ? null
          : {
              canonicalTransactionsCreated: reconciliation.canonical_created_count,
              duplicateSourcesLinked: reconciliation.duplicate_linked_count,
              skippedSources: reconciliation.skipped_count,
              committedAt: new Date(reconciliation.committed_at),
            },
    };
  }
}

interface Match {
  source: SourceRow;
  candidate: ExistingTransactionRow | null;
  classification: ImportMatchClassification;
  basis: "none" | "strong_id" | "fallback";
  reasonCode:
    | "NEW_TRANSACTION"
    | "STRONG_ID_EXACT_MATCH"
    | "STRONG_ID_CONFLICT"
    | "FALLBACK_EXACT_MATCH";
}

function matchSourceRows(sources: SourceRow[], existing: ExistingTransactionRow[]): Match[] {
  const byStrong = groupBy(existing, (row) => row.source_reference);
  const byFallback = groupBy(existing, (row) => row.fallback_fingerprint);
  const consumed = new Set<string>();
  const matches = new Map<string, Match>();

  for (const source of sources) {
    if (!source.source_transaction_id) continue;
    const candidates = byStrong.get(source.source_transaction_id) ?? [];
    if (candidates.length === 0) continue;
    const exact = candidates.find(
      (candidate) => candidate.fallback_fingerprint === source.fallback_fingerprint,
    );
    const candidate = exact ?? candidates[0] ?? null;
    if (!candidate) continue;
    consumed.add(candidate.id);
    matches.set(source.id, {
      source,
      candidate,
      classification: exact ? "duplicate" : "conflict",
      basis: "strong_id",
      reasonCode: exact ? "STRONG_ID_EXACT_MATCH" : "STRONG_ID_CONFLICT",
    });
  }

  for (const source of sources) {
    if (matches.has(source.id)) continue;
    const fingerprint = source.fallback_fingerprint;
    if (!fingerprint) throw new Error("A source row is missing its fallback fingerprint.");
    const candidates = byFallback.get(fingerprint) ?? [];
    const candidate = candidates.find((item) => !consumed.has(item.id)) ?? null;
    if (candidate) {
      consumed.add(candidate.id);
      matches.set(source.id, {
        source,
        candidate,
        classification: "possible_duplicate",
        basis: "fallback",
        reasonCode: "FALLBACK_EXACT_MATCH",
      });
    } else {
      matches.set(source.id, {
        source,
        candidate: null,
        classification: "new",
        basis: "none",
        reasonCode: "NEW_TRANSACTION",
      });
    }
  }
  return sources.map((source) => {
    const match = matches.get(source.id);
    if (!match) throw new Error("A parsed source row was not matched.");
    return match;
  });
}

function groupBy<T>(rows: T[], keyFor: (row: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function countMatches(matches: Match[]) {
  return {
    new: matches.filter((match) => match.classification === "new").length,
    duplicate: matches.filter((match) => match.classification === "duplicate").length,
    possibleDuplicate: matches.filter((match) => match.classification === "possible_duplicate")
      .length,
    conflict: matches.filter((match) => match.classification === "conflict").length,
  };
}

function decisionForAction(action: ImportDecisionAction): Exclude<ImportMatchDecision, "pending"> {
  if (action === "confirm_duplicate") return "confirmed";
  if (action === "keep_separate") return "rejected";
  return "skipped";
}

function cleanNarration(value: string | null): string {
  const cleaned = (value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
  return cleaned || normalizeNarration(value);
}

interface ImportBatchRow {
  id: string;
  workspace_id: string;
  account_id: string | null;
  adapter_key: string;
  status: "pending" | "previewed" | "committed" | "failed";
  balance_currency: string | null;
  institution_name: string | null;
  masked_account_number: string | null;
  reconciliation_status: "matched" | "mismatched" | null;
}

interface AccountRow {
  id: string;
  institution_name: string;
  masked_account_number: string | null;
}

interface SourceRow {
  id: string;
  source_row_index: number;
  source_transaction_id: string | null;
  source_timestamp: string;
  source_timezone: string;
  occurred_at_utc: number;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: string;
  raw_narration: string | null;
  fallback_fingerprint: string | null;
}

interface ExistingTransactionRow {
  id: string;
  occurred_at_utc: number;
  source_timestamp: string;
  source_timezone: string;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: string;
  normalized_narration: string | null;
  source_reference: string | null;
  fallback_fingerprint: string | null;
  created_at: number;
}

interface ReconciliationRow {
  import_batch_id: string;
  account_id: string | null;
  create_account: number;
  new_count: number;
  duplicate_count: number;
  possible_duplicate_count: number;
  conflict_count: number;
  skipped_count: number;
  canonical_created_count: number | null;
  duplicate_linked_count: number | null;
  analyzed_at: number;
  committed_at: number | null;
  updated_at: number;
}

interface DecisionIdentityRow {
  id: string;
  classification: ImportMatchClassification;
}

interface CommitDecisionRow {
  id: string;
  classification: ImportMatchClassification;
  decision: ImportMatchDecision;
  match_basis: "none" | "strong_id" | "fallback";
  candidate_transaction_id: string | null;
  source_id: string;
  source_transaction_id: string | null;
  source_timestamp: string;
  source_timezone: string;
  occurred_at_utc: number;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: string;
  raw_narration: string | null;
  fallback_fingerprint: string | null;
}

interface AttentionRow {
  id: string;
  classification: "possible_duplicate" | "conflict";
  decision: ImportMatchDecision;
  reason_code: string;
  source_transaction_id: string | null;
  occurred_at_utc: number;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: string;
  raw_narration: string | null;
  candidate_id: string;
  candidate_source_reference: string | null;
  candidate_occurred_at_utc: number;
  candidate_direction: "debit" | "credit";
  candidate_amount_minor: number;
  candidate_currency: string;
  candidate_narration: string | null;
}

interface CountRow {
  count: number;
}

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { validateSplitTotal } from "./splits.js";
import { localDateRangeToUtc } from "./time.js";
import {
  invalidateMetrics,
  TransactionWorkspaceError,
  type WorkspaceMutationHook,
} from "./workspace-domain.js";

export type TransactionDirection = "debit" | "credit";
export type TransactionScope = "personal" | "business";
export type TransactionReviewState = "unreviewed" | "needs_review" | "reviewed";
export type TransactionConfidence = "unknown" | "low" | "medium" | "high" | "confirmed";
export type TransactionType =
  | "expense"
  | "income"
  | "transfer"
  | "refund"
  | "fee"
  | "cash_withdrawal"
  | "debt"
  | "unclassified";

export interface TransactionListInput {
  cursor?: string | undefined;
  limit: number;
  sort: "occurredAt" | "amount" | "createdAt";
  direction: "asc" | "desc";
  search?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  accountId?: string | undefined;
  minimumAmountMinor?: number | undefined;
  maximumAmountMinor?: number | undefined;
  transactionDirection?: TransactionDirection | undefined;
  currency?: string | undefined;
  scope?: TransactionScope | undefined;
  categoryId?: string | undefined;
  counterpartyId?: string | undefined;
  confidence?: TransactionConfidence | undefined;
  reviewState?: TransactionReviewState | undefined;
}

export interface TransactionRecord {
  id: string;
  occurredAt: Date;
  sourceTimestamp: string;
  sourceTimezone: string;
  account: {
    id: string;
    displayName: string;
    institutionName: string;
  };
  direction: TransactionDirection;
  transactionType: TransactionType;
  amountMinor: number;
  currency: string;
  normalizedNarration: string | null;
  sourceReference: string | null;
  category: {
    id: string;
    name: string;
    parentName: string | null;
  } | null;
  counterparty: {
    id: string;
    displayName: string;
  } | null;
  scope: TransactionScope;
  classificationSource: "unclassified" | "manual" | "rule" | "history" | "deterministic" | "ai";
  confidence: TransactionConfidence;
  confidenceBasisPoints: number | null;
  classificationExplanation: string | null;
  classificationDecision: {
    winnerRule: { id: string; name: string } | null;
    matchedRules: Array<{ id: string; name: string }>;
    suppressedRules: Array<{ id: string; name: string }>;
    conflictRules: Array<{ id: string; name: string }>;
    evidence: Array<{
      code: string;
      label: string;
      source:
        | "manual"
        | "transfer"
        | "rule"
        | "counterparty"
        | "bank"
        | "history"
        | "ai"
        | "fallback";
      ruleId?: string | null | undefined;
    }>;
  } | null;
  reviewState: TransactionReviewState;
  note: string | null;
  splits: Array<{
    id: string;
    amountMinor: number;
    currency: string;
    category: {
      id: string;
      name: string;
      parentName: string | null;
    };
    scope: TransactionScope;
    note: string | null;
  }>;
  transfer: {
    status: "none" | "suggested" | "confirmed" | "rejected";
    pairedTransactionId: string | null;
  };
  source: {
    rawNarration: string | null;
    sourceTimestamp: string;
    importIds: string[];
  };
  updatedAt: Date;
}

export interface TransactionListResult {
  items: TransactionRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TransactionEditInput {
  normalizedNarration?: string | null | undefined;
  scope?: TransactionScope | undefined;
  categoryId?: string | null | undefined;
  counterpartyId?: string | null | undefined;
  transactionType?: TransactionType | undefined;
  reviewState?: TransactionReviewState | undefined;
  note?: string | null | undefined;
}

export interface TransactionSplitInput {
  amountMinor: number;
  categoryId: string;
  scope: TransactionScope;
  note?: string | null | undefined;
}

export interface BulkTransactionEditInput {
  transactionIds: string[];
  changes: {
    scope?: TransactionScope | undefined;
    categoryId?: string | null | undefined;
    transactionType?: TransactionType | undefined;
    reviewState?: TransactionReviewState | undefined;
  };
}

interface TransactionRow {
  id: string;
  occurred_at_utc: number;
  source_timestamp: string;
  source_timezone: string;
  account_id: string;
  account_display_name: string;
  institution_name: string;
  direction: TransactionDirection;
  transaction_type: TransactionType;
  amount_minor: number;
  currency: string;
  normalized_narration: string | null;
  source_reference: string | null;
  category_id: string | null;
  category_name: string | null;
  parent_category_name: string | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  scope: TransactionScope;
  classification_source: TransactionRecord["classificationSource"];
  confidence_level: TransactionConfidence;
  confidence_basis_points: number | null;
  classification_explanation: string | null;
  review_state: TransactionReviewState;
  paired_transaction_id: string | null;
  transfer_pairing_status: TransactionRecord["transfer"]["status"];
  created_at: number;
  updated_at: number;
  sort_value?: number;
}

interface CursorValue {
  version: 1;
  sort: TransactionListInput["sort"];
  direction: TransactionListInput["direction"];
  value: number;
  id: string;
}

interface ClassificationDecisionRow {
  winner_rule_id: string | null;
  matched_rule_ids: string;
  suppressed_rule_ids: string;
  conflict_rule_ids: string;
  evidence: string;
}

const SORT_COLUMNS: Record<TransactionListInput["sort"], string> = {
  occurredAt: "t.occurred_at_utc",
  amount: "t.amount_minor",
  createdAt: "t.created_at",
};

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseClassificationEvidence(
  value: string,
): NonNullable<TransactionRecord["classificationDecision"]>["evidence"] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (
        item,
      ): item is NonNullable<TransactionRecord["classificationDecision"]>["evidence"][number] =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { code?: unknown }).code === "string" &&
        typeof (item as { label?: unknown }).label === "string" &&
        [
          "manual",
          "transfer",
          "rule",
          "counterparty",
          "bank",
          "history",
          "ai",
          "fallback",
        ].includes(String((item as { source?: unknown }).source)),
    );
  } catch {
    return [];
  }
}

const baseSelect = `
  SELECT
    t.*,
    a.display_name AS account_display_name,
    a.institution_name,
    c.name AS category_name,
    pc.name AS parent_category_name,
    cp.display_name AS counterparty_name
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN categories pc ON pc.id = c.parent_id
  LEFT JOIN counterparties cp ON cp.id = t.counterparty_id
`;

export class TransactionWorkspace {
  readonly #sqlite: () => Database.Database;
  readonly #clock: () => number;

  constructor(sqlite: Database.Database | (() => Database.Database), clock = Date.now) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#clock = clock;
  }

  listTransactions(workspaceId: string, input: TransactionListInput): TransactionListResult {
    const sqlite = this.#sqlite();
    const clauses = ["t.workspace_id = ?"];
    const values: Array<string | number> = [workspaceId];
    const sortColumn = SORT_COLUMNS[input.sort];
    const cursor = input.cursor ? decodeCursor(input.cursor, input.sort, input.direction) : null;

    if (input.search) {
      const pattern = `%${escapeLike(input.search.toLocaleLowerCase("en-NG"))}%`;
      clauses.push(`(
        lower(coalesce(t.normalized_narration, '')) LIKE ? ESCAPE '\\'
        OR lower(coalesce(t.source_reference, '')) LIKE ? ESCAPE '\\'
        OR lower(coalesce(cp.display_name, '')) LIKE ? ESCAPE '\\'
        OR lower(coalesce(c.name, '')) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1
          FROM transaction_sources search_ts
          JOIN parsed_source_rows search_psr
            ON search_psr.id = search_ts.parsed_source_row_id
          WHERE search_ts.transaction_id = t.id
            AND lower(coalesce(search_psr.raw_narration, '')) LIKE ? ESCAPE '\\'
        )
      )`);
      values.push(pattern, pattern, pattern, pattern, pattern);
    }

    if (input.startDate || input.endDate) {
      const timezone = this.#workspaceTimezone(workspaceId);
      if (input.startDate) {
        const { startUtc } = localDateRangeToUtc(input.startDate, input.startDate, timezone);
        clauses.push("t.occurred_at_utc >= ?");
        values.push(startUtc.getTime());
      }
      if (input.endDate) {
        const { endUtcExclusive } = localDateRangeToUtc(input.endDate, input.endDate, timezone);
        clauses.push("t.occurred_at_utc < ?");
        values.push(endUtcExclusive.getTime());
      }
    }

    addEqualFilter(clauses, values, "t.account_id", input.accountId);
    addEqualFilter(clauses, values, "t.direction", input.transactionDirection);
    addEqualFilter(clauses, values, "t.currency", input.currency);
    addEqualFilter(clauses, values, "t.scope", input.scope);
    addEqualFilter(clauses, values, "t.category_id", input.categoryId);
    addEqualFilter(clauses, values, "t.counterparty_id", input.counterpartyId);
    addEqualFilter(clauses, values, "t.confidence_level", input.confidence);
    addEqualFilter(clauses, values, "t.review_state", input.reviewState);

    if (input.minimumAmountMinor !== undefined) {
      clauses.push("t.amount_minor >= ?");
      values.push(input.minimumAmountMinor);
    }
    if (input.maximumAmountMinor !== undefined) {
      clauses.push("t.amount_minor <= ?");
      values.push(input.maximumAmountMinor);
    }
    if (cursor) {
      const operator = input.direction === "desc" ? "<" : ">";
      clauses.push(`(${sortColumn} ${operator} ? OR (${sortColumn} = ? AND t.id ${operator} ?))`);
      values.push(cursor.value, cursor.value, cursor.id);
    }

    const rows = sqlite
      .prepare(
        `${baseSelect}
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${sortColumn} ${input.direction.toUpperCase()}, t.id ${input.direction.toUpperCase()}
         LIMIT ?`,
      )
      .all(...values, input.limit + 1) as TransactionRow[];
    const hasMore = rows.length > input.limit;
    const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
    const items = pageRows.map((row) => this.#hydrate(row));
    const last = pageRows.at(-1);

    return {
      items,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              version: 1,
              sort: input.sort,
              direction: input.direction,
              value: sortValue(last, input.sort),
              id: last.id,
            })
          : null,
    };
  }

  getTransaction(workspaceId: string, transactionId: string): TransactionRecord {
    const row = this.#findRow(workspaceId, transactionId);
    if (!row) {
      throw new TransactionWorkspaceError(
        "TRANSACTION_NOT_FOUND",
        "The transaction was not found.",
      );
    }
    return this.#hydrate(row);
  }

  updateTransaction(
    input: {
      workspaceId: string;
      transactionId: string;
      actorUserId: string;
      changes: TransactionEditInput;
    },
    onMutation?: WorkspaceMutationHook,
  ): TransactionRecord {
    const sqlite = this.#sqlite();
    const update = sqlite.transaction(() => {
      const before = this.getTransaction(input.workspaceId, input.transactionId);
      this.#validateReferences(input.workspaceId, input.changes);
      if (
        before.transfer.status === "confirmed" &&
        input.changes.transactionType !== undefined &&
        input.changes.transactionType !== "transfer"
      ) {
        throw new TransactionWorkspaceError(
          "TRANSACTION_EDIT_INVALID",
          "A confirmed transfer must remain a transfer.",
        );
      }

      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      const fieldMap: Array<[keyof TransactionEditInput, string]> = [
        ["normalizedNarration", "normalized_narration"],
        ["scope", "scope"],
        ["categoryId", "category_id"],
        ["counterpartyId", "counterparty_id"],
        ["transactionType", "transaction_type"],
        ["reviewState", "review_state"],
      ];
      for (const [field, column] of fieldMap) {
        if (Object.hasOwn(input.changes, field)) {
          assignments.push(`${column} = ?`);
          values.push(input.changes[field] ?? null);
        }
      }

      const classificationChanged = ["categoryId", "counterpartyId", "transactionType"].some(
        (field) => Object.hasOwn(input.changes, field),
      );
      if (classificationChanged) {
        assignments.push(
          "classification_source = 'manual'",
          "confidence_level = 'confirmed'",
          "confidence_basis_points = 10000",
          "classification_explanation = 'Confirmed by the user.'",
        );
      }
      assignments.push("updated_at = ?");
      values.push(this.#clock());
      sqlite
        .prepare(
          `UPDATE transactions SET ${assignments.join(", ")}
           WHERE id = ? AND workspace_id = ?`,
        )
        .run(...values, input.transactionId, input.workspaceId);

      if (Object.hasOwn(input.changes, "note")) {
        sqlite
          .prepare("DELETE FROM transaction_notes WHERE transaction_id = ?")
          .run(input.transactionId);
        const note = input.changes.note?.trim();
        if (note) {
          const now = this.#clock();
          sqlite
            .prepare(
              `INSERT INTO transaction_notes (
                id, transaction_id, author_user_id, body, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(randomUUID(), input.transactionId, input.actorUserId, note, now, now);
        }
      }

      const after = this.getTransaction(input.workspaceId, input.transactionId);
      this.#recordRevision(input.transactionId, input.actorUserId, before, after);
      invalidateMetrics(
        sqlite,
        {
          workspaceId: input.workspaceId,
          transactionId: input.transactionId,
          occurredAt: after.occurredAt.getTime(),
          reason: "transaction.updated",
        },
        this.#clock,
      );
      onMutation?.({
        entityType: "transaction",
        entityId: input.transactionId,
        action: "transaction.updated",
        beforeState: editableSnapshot(before),
        afterState: editableSnapshot(after),
      });
      return after;
    });
    return update();
  }

  replaceSplits(
    input: {
      workspaceId: string;
      transactionId: string;
      actorUserId: string;
      splits: TransactionSplitInput[];
    },
    onMutation?: WorkspaceMutationHook,
  ): TransactionRecord {
    const sqlite = this.#sqlite();
    const replace = sqlite.transaction(() => {
      const before = this.getTransaction(input.workspaceId, input.transactionId);
      try {
        validateSplitTotal(
          before.amountMinor,
          before.currency,
          input.splits.map((split) => ({
            amountMinor: split.amountMinor,
            currency: before.currency,
          })),
        );
      } catch (error) {
        throw new TransactionWorkspaceError(
          "SPLIT_INVALID",
          error instanceof Error ? error.message : "The transaction split is invalid.",
        );
      }
      const uniqueCategoryIds = [...new Set(input.splits.map((split) => split.categoryId))];
      this.#requireCategories(input.workspaceId, uniqueCategoryIds);
      const now = this.#clock();

      sqlite
        .prepare(
          `UPDATE transaction_split_sets
           SET status = 'superseded'
           WHERE transaction_id = ? AND status = 'active'`,
        )
        .run(input.transactionId);
      const splitSetId = randomUUID();
      sqlite
        .prepare(
          `INSERT INTO transaction_split_sets (
            id, transaction_id, status, created_by_user_id, created_at
          ) VALUES (?, ?, 'draft', ?, ?)`,
        )
        .run(splitSetId, input.transactionId, input.actorUserId, now);
      const insertSplit = sqlite.prepare(
        `INSERT INTO transaction_splits (
          id, split_set_id, category_id, amount_minor, currency, scope, note, sort_order, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      input.splits.forEach((split, index) => {
        insertSplit.run(
          randomUUID(),
          splitSetId,
          split.categoryId,
          split.amountMinor,
          before.currency,
          split.scope,
          split.note?.trim() || null,
          index,
          now,
        );
      });
      sqlite
        .prepare(
          `UPDATE transaction_split_sets
           SET status = 'active', activated_at = ?
           WHERE id = ?`,
        )
        .run(now, splitSetId);
      sqlite
        .prepare(
          `UPDATE transactions SET
            classification_source = 'manual',
            confidence_level = 'confirmed',
            confidence_basis_points = 10000,
            classification_explanation = 'Split confirmed by the user.',
            review_state = 'reviewed',
            updated_at = ?
           WHERE id = ?`,
        )
        .run(now, input.transactionId);

      const after = this.getTransaction(input.workspaceId, input.transactionId);
      this.#recordRevision(input.transactionId, input.actorUserId, before, after);
      invalidateMetrics(
        sqlite,
        {
          workspaceId: input.workspaceId,
          transactionId: input.transactionId,
          occurredAt: after.occurredAt.getTime(),
          reason: "transaction.splits_replaced",
        },
        this.#clock,
      );
      onMutation?.({
        entityType: "transaction",
        entityId: input.transactionId,
        action: "transaction.splits_replaced",
        beforeState: { splits: before.splits },
        afterState: { splits: after.splits },
      });
      return after;
    });
    return replace();
  }

  bulkUpdate(
    input: {
      workspaceId: string;
      actorUserId: string;
      edit: BulkTransactionEditInput;
    },
    onMutation?: WorkspaceMutationHook,
  ): { updatedCount: number; transactionIds: string[] } {
    const sqlite = this.#sqlite();
    const apply = sqlite.transaction(() => {
      const ids = [...new Set(input.edit.transactionIds)];
      const before = ids.map((id) => this.getTransaction(input.workspaceId, id));
      this.#validateReferences(input.workspaceId, input.edit.changes);
      if (
        input.edit.changes.transactionType !== undefined &&
        input.edit.changes.transactionType !== "transfer" &&
        before.some((transaction) => transaction.transfer.status === "confirmed")
      ) {
        throw new TransactionWorkspaceError(
          "TRANSACTION_EDIT_INVALID",
          "Confirmed transfers cannot be changed to another transaction type in bulk.",
        );
      }

      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      const fieldMap: Array<[keyof BulkTransactionEditInput["changes"], string]> = [
        ["scope", "scope"],
        ["categoryId", "category_id"],
        ["transactionType", "transaction_type"],
        ["reviewState", "review_state"],
      ];
      for (const [field, column] of fieldMap) {
        if (Object.hasOwn(input.edit.changes, field)) {
          assignments.push(`${column} = ?`);
          values.push(input.edit.changes[field] ?? null);
        }
      }
      if (
        Object.hasOwn(input.edit.changes, "categoryId") ||
        Object.hasOwn(input.edit.changes, "transactionType")
      ) {
        assignments.push(
          "classification_source = 'manual'",
          "confidence_level = 'confirmed'",
          "confidence_basis_points = 10000",
          "classification_explanation = 'Confirmed by the user in a bulk edit.'",
        );
      }
      assignments.push("updated_at = ?");
      values.push(this.#clock());
      const placeholders = ids.map(() => "?").join(", ");
      const result = sqlite
        .prepare(
          `UPDATE transactions SET ${assignments.join(", ")}
           WHERE workspace_id = ? AND id IN (${placeholders})`,
        )
        .run(...values, input.workspaceId, ...ids);
      if (result.changes !== ids.length) {
        throw new TransactionWorkspaceError(
          "TRANSACTION_NOT_FOUND",
          "One or more selected transactions were not found.",
        );
      }

      const after = ids.map((id) => this.getTransaction(input.workspaceId, id));
      after.forEach((transaction, index) => {
        this.#recordRevision(
          transaction.id,
          input.actorUserId,
          before[index] as TransactionRecord,
          transaction,
        );
        invalidateMetrics(
          sqlite,
          {
            workspaceId: input.workspaceId,
            transactionId: transaction.id,
            occurredAt: transaction.occurredAt.getTime(),
            reason: "transaction.bulk_updated",
          },
          this.#clock,
        );
      });
      onMutation?.({
        entityType: "transaction_bulk",
        entityId: input.workspaceId,
        action: "transaction.bulk_updated",
        beforeState: { transactionIds: ids },
        afterState: { transactionIds: ids, changes: input.edit.changes },
      });
      return { updatedCount: result.changes, transactionIds: ids };
    });
    return apply();
  }

  confirmTransfer(
    input: {
      workspaceId: string;
      transactionId: string;
      pairedTransactionId: string;
      actorUserId: string;
    },
    onMutation?: WorkspaceMutationHook,
  ): TransactionRecord {
    const sqlite = this.#sqlite();
    const confirm = sqlite.transaction(() => {
      if (input.transactionId === input.pairedTransactionId) {
        throw new TransactionWorkspaceError(
          "TRANSFER_PAIR_INVALID",
          "A transaction cannot be paired with itself.",
        );
      }
      const left = this.getTransaction(input.workspaceId, input.transactionId);
      const right = this.getTransaction(input.workspaceId, input.pairedTransactionId);
      if (
        left.direction === right.direction ||
        left.amountMinor !== right.amountMinor ||
        left.currency !== right.currency ||
        left.account.id === right.account.id
      ) {
        throw new TransactionWorkspaceError(
          "TRANSFER_PAIR_INVALID",
          "Internal transfers require opposite directions, equal amounts and currencies, and different accounts.",
        );
      }
      const ownedCount = (
        sqlite
          .prepare(
            `SELECT count(*) AS count FROM accounts
             WHERE workspace_id = ? AND is_owned = 1 AND id IN (?, ?)`,
          )
          .get(input.workspaceId, left.account.id, right.account.id) as { count: number }
      ).count;
      if (ownedCount !== 2) {
        throw new TransactionWorkspaceError(
          "TRANSFER_PAIR_INVALID",
          "Both sides of an internal transfer must belong to owned accounts.",
        );
      }
      if (
        (left.transfer.status === "confirmed" && left.transfer.pairedTransactionId !== right.id) ||
        (right.transfer.status === "confirmed" && right.transfer.pairedTransactionId !== left.id)
      ) {
        throw new TransactionWorkspaceError(
          "TRANSFER_PAIR_CONFLICT",
          "One of these transactions is already paired with another transfer.",
        );
      }

      const now = this.#clock();
      const update = sqlite.prepare(
        `UPDATE transactions SET
          transaction_type = 'transfer',
          paired_transaction_id = ?,
          transfer_pairing_status = 'confirmed',
          transfer_pairing_confidence_basis_points = 10000,
          transfer_pairing_source = 'manual',
          classification_source = 'manual',
          confidence_level = 'confirmed',
          confidence_basis_points = 10000,
          classification_explanation = 'Internal transfer confirmed by the user.',
          review_state = 'reviewed',
          updated_at = ?
         WHERE id = ? AND workspace_id = ?`,
      );
      update.run(right.id, now, left.id, input.workspaceId);
      update.run(left.id, now, right.id, input.workspaceId);

      const afterLeft = this.getTransaction(input.workspaceId, left.id);
      const afterRight = this.getTransaction(input.workspaceId, right.id);
      this.#recordRevision(left.id, input.actorUserId, left, afterLeft);
      this.#recordRevision(right.id, input.actorUserId, right, afterRight);
      for (const transaction of [afterLeft, afterRight]) {
        invalidateMetrics(
          sqlite,
          {
            workspaceId: input.workspaceId,
            transactionId: transaction.id,
            occurredAt: transaction.occurredAt.getTime(),
            reason: "transaction.transfer_confirmed",
          },
          this.#clock,
        );
      }
      onMutation?.({
        entityType: "transaction_pair",
        entityId: [left.id, right.id].sort().join(":"),
        action: "transaction.transfer_confirmed",
        beforeState: { transactionIds: [left.id, right.id] },
        afterState: {
          transactionIds: [left.id, right.id],
          status: "confirmed",
        },
      });
      return afterLeft;
    });
    return confirm();
  }

  #findRow(workspaceId: string, transactionId: string): TransactionRow | null {
    return (
      (this.#sqlite()
        .prepare(`${baseSelect} WHERE t.workspace_id = ? AND t.id = ?`)
        .get(workspaceId, transactionId) as TransactionRow | undefined) ?? null
    );
  }

  #hydrate(row: TransactionRow): TransactionRecord {
    const sqlite = this.#sqlite();
    const note =
      (
        sqlite
          .prepare(
            `SELECT body FROM transaction_notes
             WHERE transaction_id = ?
             ORDER BY updated_at DESC, id DESC LIMIT 1`,
          )
          .get(row.id) as { body: string } | undefined
      )?.body ?? null;
    const splitRows = sqlite
      .prepare(
        `SELECT
          s.id,
          s.amount_minor,
          s.currency,
          s.scope,
          s.note,
          c.id AS category_id,
          c.name AS category_name,
          pc.name AS parent_category_name
         FROM transaction_split_sets ss
         JOIN transaction_splits s ON s.split_set_id = ss.id
         JOIN categories c ON c.id = s.category_id
         LEFT JOIN categories pc ON pc.id = c.parent_id
         WHERE ss.transaction_id = ? AND ss.status = 'active'
         ORDER BY s.sort_order ASC, s.id ASC`,
      )
      .all(row.id) as SplitRow[];
    const sourceRows = sqlite
      .prepare(
        `SELECT
          psr.raw_narration,
          psr.source_timestamp,
          ts.import_batch_id,
          ts.link_type,
          ts.created_at
         FROM transaction_sources ts
         JOIN parsed_source_rows psr ON psr.id = ts.parsed_source_row_id
         WHERE ts.transaction_id = ?
         ORDER BY CASE ts.link_type WHEN 'original' THEN 0 ELSE 1 END,
                  ts.created_at ASC,
                  ts.import_batch_id ASC`,
      )
      .all(row.id) as SourceRow[];
    const primarySource = sourceRows[0];
    const decision = sqlite
      .prepare(
        `SELECT winner_rule_id, matched_rule_ids, suppressed_rule_ids, conflict_rule_ids, evidence
         FROM classification_decisions
         WHERE transaction_id = ?`,
      )
      .get(row.id) as ClassificationDecisionRow | undefined;
    const decisionRuleIds = decision
      ? [
          ...new Set([
            ...parseStringArray(decision.matched_rule_ids),
            ...parseStringArray(decision.suppressed_rule_ids),
            ...parseStringArray(decision.conflict_rule_ids),
            ...(decision.winner_rule_id ? [decision.winner_rule_id] : []),
          ]),
        ]
      : [];
    const decisionRuleNames =
      decisionRuleIds.length > 0
        ? new Map(
            (
              sqlite
                .prepare(
                  `SELECT id, name FROM classification_rules
                   WHERE id IN (${decisionRuleIds.map(() => "?").join(", ")})`,
                )
                .all(...decisionRuleIds) as Array<{ id: string; name: string }>
            ).map((rule) => [rule.id, rule.name]),
          )
        : new Map<string, string>();
    const summarizeRules = (ids: string[]) =>
      ids.map((id) => ({ id, name: decisionRuleNames.get(id) ?? "Deleted rule" }));

    return {
      id: row.id,
      occurredAt: new Date(row.occurred_at_utc),
      sourceTimestamp: row.source_timestamp,
      sourceTimezone: row.source_timezone,
      account: {
        id: row.account_id,
        displayName: row.account_display_name,
        institutionName: row.institution_name,
      },
      direction: row.direction,
      transactionType: row.transaction_type,
      amountMinor: row.amount_minor,
      currency: row.currency,
      normalizedNarration: row.normalized_narration,
      sourceReference: row.source_reference,
      category:
        row.category_id && row.category_name
          ? {
              id: row.category_id,
              name: row.category_name,
              parentName: row.parent_category_name,
            }
          : null,
      counterparty:
        row.counterparty_id && row.counterparty_name
          ? { id: row.counterparty_id, displayName: row.counterparty_name }
          : null,
      scope: row.scope,
      classificationSource: row.classification_source,
      confidence: row.confidence_level,
      confidenceBasisPoints: row.confidence_basis_points,
      classificationExplanation: row.classification_explanation,
      classificationDecision: decision
        ? {
            winnerRule: decision.winner_rule_id
              ? (summarizeRules([decision.winner_rule_id])[0] ?? null)
              : null,
            matchedRules: summarizeRules(parseStringArray(decision.matched_rule_ids)),
            suppressedRules: summarizeRules(parseStringArray(decision.suppressed_rule_ids)),
            conflictRules: summarizeRules(parseStringArray(decision.conflict_rule_ids)),
            evidence: parseClassificationEvidence(decision.evidence),
          }
        : null,
      reviewState: row.review_state,
      note,
      splits: splitRows.map((split) => ({
        id: split.id,
        amountMinor: split.amount_minor,
        currency: split.currency,
        category: {
          id: split.category_id,
          name: split.category_name,
          parentName: split.parent_category_name,
        },
        scope: split.scope,
        note: split.note,
      })),
      transfer: {
        status: row.transfer_pairing_status,
        pairedTransactionId: row.paired_transaction_id,
      },
      source: {
        rawNarration: primarySource?.raw_narration ?? null,
        sourceTimestamp: primarySource?.source_timestamp ?? row.source_timestamp,
        importIds: [...new Set(sourceRows.map((source) => source.import_batch_id))],
      },
      updatedAt: new Date(row.updated_at),
    };
  }

  #workspaceTimezone(workspaceId: string): string {
    const workspace = this.#sqlite()
      .prepare("SELECT timezone FROM workspaces WHERE id = ?")
      .get(workspaceId) as { timezone: string } | undefined;
    if (!workspace) {
      throw new TransactionWorkspaceError("TRANSACTION_NOT_FOUND", "The workspace was not found.");
    }
    return workspace.timezone;
  }

  #validateReferences(
    workspaceId: string,
    changes: Pick<TransactionEditInput, "categoryId" | "counterpartyId">,
  ): void {
    if (changes.categoryId) {
      this.#requireCategories(workspaceId, [changes.categoryId]);
    }
    if (changes.counterpartyId) {
      const exists = this.#sqlite()
        .prepare("SELECT 1 FROM counterparties WHERE id = ? AND workspace_id = ?")
        .get(changes.counterpartyId, workspaceId);
      if (!exists) {
        throw new TransactionWorkspaceError(
          "COUNTERPARTY_NOT_FOUND",
          "The counterparty was not found.",
        );
      }
    }
  }

  #requireCategories(workspaceId: string, categoryIds: string[]): void {
    if (categoryIds.length === 0) return;
    const placeholders = categoryIds.map(() => "?").join(", ");
    const result = this.#sqlite()
      .prepare(
        `SELECT count(*) AS count FROM categories
         WHERE workspace_id = ? AND archived_at IS NULL AND id IN (${placeholders})`,
      )
      .get(workspaceId, ...categoryIds) as { count: number };
    if (result.count !== categoryIds.length) {
      throw new TransactionWorkspaceError(
        "CATEGORY_NOT_FOUND",
        "One or more categories were not found or are archived.",
      );
    }
  }

  #recordRevision(
    transactionId: string,
    actorUserId: string,
    before: TransactionRecord,
    after: TransactionRecord,
  ): void {
    const sqlite = this.#sqlite();
    const revisionNumber = (
      sqlite
        .prepare(
          `SELECT coalesce(max(revision_number), 0) + 1 AS revision
           FROM transaction_revisions WHERE transaction_id = ?`,
        )
        .get(transactionId) as { revision: number }
    ).revision;
    sqlite
      .prepare(
        `INSERT INTO transaction_revisions (
          id, transaction_id, revision_number, actor_user_id, source,
          before_values, after_values, created_at
        ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        transactionId,
        revisionNumber,
        actorUserId,
        JSON.stringify(editableSnapshot(before)),
        JSON.stringify(editableSnapshot(after)),
        this.#clock(),
      );
  }
}

interface SplitRow {
  id: string;
  amount_minor: number;
  currency: string;
  scope: TransactionScope;
  note: string | null;
  category_id: string;
  category_name: string;
  parent_category_name: string | null;
}

interface SourceRow {
  raw_narration: string | null;
  source_timestamp: string;
  import_batch_id: string;
  link_type: "original" | "duplicate";
  created_at: number;
}

function editableSnapshot(transaction: TransactionRecord) {
  return {
    normalizedNarration: transaction.normalizedNarration,
    scope: transaction.scope,
    categoryId: transaction.category?.id ?? null,
    counterpartyId: transaction.counterparty?.id ?? null,
    transactionType: transaction.transactionType,
    reviewState: transaction.reviewState,
    note: transaction.note,
    splits: transaction.splits.map((split) => ({
      amountMinor: split.amountMinor,
      categoryId: split.category.id,
      scope: split.scope,
      note: split.note,
    })),
    transfer: transaction.transfer,
  };
}

function addEqualFilter(
  clauses: string[],
  values: Array<string | number>,
  column: string,
  value: string | undefined,
) {
  if (value !== undefined) {
    clauses.push(`${column} = ?`);
    values.push(value);
  }
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function sortValue(row: TransactionRow, sort: TransactionListInput["sort"]): number {
  if (sort === "amount") return row.amount_minor;
  if (sort === "createdAt") return row.created_at;
  return row.occurred_at_utc;
}

function encodeCursor(cursor: CursorValue): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(
  value: string,
  sort: TransactionListInput["sort"],
  direction: TransactionListInput["direction"],
): CursorValue {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<CursorValue>;
    if (
      parsed.version !== 1 ||
      parsed.sort !== sort ||
      parsed.direction !== direction ||
      !Number.isSafeInteger(parsed.value) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      throw new Error("Invalid cursor fields.");
    }
    return parsed as CursorValue;
  } catch {
    throw new TransactionWorkspaceError(
      "TRANSACTION_CURSOR_INVALID",
      "The transaction cursor is invalid for the selected sort.",
    );
  }
}

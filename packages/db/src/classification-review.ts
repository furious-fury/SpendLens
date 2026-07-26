import { createHash, randomUUID } from "node:crypto";
import type {
  ApplyReviewDecision,
  ClassificationAction,
  ClassificationEvidence,
  ClassificationRule,
  ClassificationSuggestion,
  ReviewDecisionResult,
  ReviewGroup,
  UndoReviewDecisionResult,
} from "@spendlens/contracts";
import {
  ClassificationActionSchema,
  ClassificationEvidenceSchema,
  ClassificationSuggestionSchema,
} from "@spendlens/contracts";
import type Database from "better-sqlite3";
import {
  ClassificationEngine,
  ClassificationError,
  classificationNarrationKey,
  classificationNarrationSimilarity,
} from "./classification-engine.js";
import type { WorkspaceMutationHook } from "./workspace-domain.js";
import { invalidateMetrics } from "./workspace-domain.js";

interface ReviewRow {
  id: string;
  occurred_at_utc: number;
  normalized_narration: string | null;
  amount_minor: number;
  currency: string;
  direction: "debit" | "credit";
  account_name: string;
  category_name: string | null;
  counterparty_id: string | null;
  counterparty_name: string | null;
  review_state: "unreviewed" | "needs_review" | "reviewed";
  confidence: ReviewGroup["confidence"];
  suggestion: string | null;
  conflict_rule_ids: string;
  evidence: string;
}

interface MutableGroup {
  key: string;
  anchorNarration: string;
  basis: ReviewGroup["basis"];
  label: string;
  rows: ReviewRow[];
}

interface TransactionSnapshot {
  id: string;
  transaction: {
    categoryId: string | null;
    counterpartyId: string | null;
    transactionType: string;
    scope: string;
    classificationSource: string;
    confidenceLevel: string;
    confidenceBasisPoints: number | null;
    classificationExplanation: string | null;
    reviewState: string;
  };
  decision: {
    source: string;
    confidence: string;
    suggestion: string | null;
    winnerRuleId: string | null;
    matchedRuleIds: string;
    suppressedRuleIds: string;
    conflictRuleIds: string;
    evidence: string;
    needsReview: number;
    evaluatedAt: number;
  } | null;
}

interface ReviewActionRow {
  id: string;
  workspace_id: string;
  group_key: string;
  transaction_ids: string;
  before_values: string;
  created_rule_id: string | null;
  undone_at: number | null;
}

export type ClassificationReviewErrorCode =
  | "REVIEW_GROUP_NOT_FOUND"
  | "REVIEW_SELECTION_INVALID"
  | "REVIEW_SUGGESTION_UNAVAILABLE"
  | "REVIEW_ACTION_NOT_FOUND"
  | "REVIEW_ACTION_ALREADY_UNDONE";

export class ClassificationReviewError extends Error {
  constructor(
    readonly code: ClassificationReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClassificationReviewError";
  }
}

export class ClassificationReview {
  readonly #sqlite: () => Database.Database;
  readonly #engine: ClassificationEngine;
  readonly #clock: () => number;

  constructor(
    sqlite: Database.Database | (() => Database.Database),
    engine?: ClassificationEngine,
    clock = Date.now,
  ) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#engine = engine ?? new ClassificationEngine(this.#sqlite, clock);
    this.#clock = clock;
  }

  listGroups(workspaceId: string): {
    items: ReviewGroup[];
    totalTransactions: number;
  } {
    this.#refreshStale(workspaceId);
    const rows = this.#reviewRows(workspaceId);
    const mutable: MutableGroup[] = [];
    for (const row of rows) {
      const conflictIds = parseStringArray(row.conflict_rule_ids);
      const narrationKey = classificationNarrationKey(row.normalized_narration);
      let group: MutableGroup | undefined;
      if (conflictIds.length > 0) {
        const key = `conflict:${hashKey(conflictIds.sort().join(":"))}`;
        group = mutable.find((candidate) => candidate.key === key);
        if (!group) {
          group = {
            key,
            anchorNarration: narrationKey,
            basis: "conflict",
            label: "Conflicting rules",
            rows: [],
          };
          mutable.push(group);
        }
      } else if (row.counterparty_id) {
        const key = `counterparty:${row.counterparty_id}`;
        group = mutable.find((candidate) => candidate.key === key);
        if (!group) {
          group = {
            key,
            anchorNarration: narrationKey,
            basis: "counterparty",
            label: row.counterparty_name ?? displayNarration(row),
            rows: [],
          };
          mutable.push(group);
        }
      } else if (narrationKey) {
        group = mutable.find(
          (candidate) =>
            candidate.basis === "narration" &&
            classificationNarrationSimilarity(candidate.anchorNarration, narrationKey) >= 0.72,
        );
        if (!group) {
          group = {
            key: `narration:${hashKey(narrationKey)}`,
            anchorNarration: narrationKey,
            basis: "narration",
            label: displayNarration(row),
            rows: [],
          };
          mutable.push(group);
        }
      } else {
        group = {
          key: `unclassified:${row.id}`,
          anchorNarration: "",
          basis: "unclassified",
          label: "No description",
          rows: [],
        };
        mutable.push(group);
      }
      group.rows.push(row);
    }
    const items = mutable
      .map(toReviewGroup)
      .sort(
        (left, right) =>
          Number(right.hasConflict) - Number(left.hasConflict) ||
          confidenceRank(left.confidence) - confidenceRank(right.confidence) ||
          right.transactionCount - left.transactionCount ||
          left.label.localeCompare(right.label),
      );
    return {
      items,
      totalTransactions: rows.length,
    };
  }

  applyDecision(
    input: {
      workspaceId: string;
      actorUserId: string;
      decision: ApplyReviewDecision;
    },
    onMutation?: WorkspaceMutationHook,
  ): ReviewDecisionResult {
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const group = this.listGroups(input.workspaceId).items.find(
        ({ key }) => key === input.decision.groupKey,
      );
      if (!group) {
        throw new ClassificationReviewError(
          "REVIEW_GROUP_NOT_FOUND",
          "The review group no longer exists. Refresh the queue and try again.",
        );
      }
      const groupIds = group.transactions.map(({ id }) => id);
      const transactionIds =
        input.decision.applyScope === "selected"
          ? [...new Set(input.decision.transactionIds ?? [])].filter((id) => groupIds.includes(id))
          : groupIds;
      if (
        transactionIds.length === 0 ||
        (input.decision.applyScope === "selected" &&
          transactionIds.length !== new Set(input.decision.transactionIds).size)
      ) {
        throw new ClassificationReviewError(
          "REVIEW_SELECTION_INVALID",
          "The selected transactions must belong to the current review group.",
        );
      }

      const action =
        input.decision.decision === "change"
          ? ClassificationActionSchema.parse(input.decision.action)
          : group.suggestion;
      if (input.decision.decision !== "ignore" && !action) {
        throw new ClassificationReviewError(
          "REVIEW_SUGGESTION_UNAVAILABLE",
          "This group has no single suggestion to accept. Choose a classification first.",
        );
      }
      const validatedAction = action ? classificationActionFromSuggestion(action) : null;
      if (validatedAction) this.#validateAction(input.workspaceId, validatedAction);

      const before = transactionIds.map((id) => this.#snapshot(input.workspaceId, id));
      let createdRule: ClassificationRule | null = null;
      if (
        input.decision.applyScope === "future_matches" &&
        input.decision.rememberForFuture &&
        validatedAction
      ) {
        createdRule = this.#engine.createRule(
          {
            workspaceId: input.workspaceId,
            actorUserId: input.actorUserId,
            draft: this.#rememberedRule(group, validatedAction, input.decision.ruleName),
          },
          onMutation,
        );
      }

      const now = this.#clock();
      for (const transactionId of transactionIds) {
        const transactionAction =
          input.decision.decision === "accept"
            ? this.#suggestionFor(transactionId)
            : input.decision.decision === "change"
              ? validatedAction
              : null;
        if (input.decision.decision !== "ignore" && !transactionAction) {
          throw new ClassificationReviewError(
            "REVIEW_SUGGESTION_UNAVAILABLE",
            "One of the selected transactions no longer has a suggestion.",
          );
        }
        this.#applyTransactionDecision(
          input.workspaceId,
          input.actorUserId,
          transactionId,
          transactionAction,
          input.decision.decision,
          now,
        );
      }
      const after = transactionIds.map((id) => this.#snapshot(input.workspaceId, id));
      const actionId = randomUUID();
      sqlite
        .prepare(
          `INSERT INTO classification_review_actions (
            id, workspace_id, actor_user_id, group_key, decision, apply_scope,
            transaction_ids, before_values, after_values, created_rule_id,
            undone_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          actionId,
          input.workspaceId,
          input.actorUserId,
          input.decision.groupKey,
          input.decision.decision,
          input.decision.applyScope,
          JSON.stringify(transactionIds),
          JSON.stringify(before),
          JSON.stringify(after),
          createdRule?.id ?? null,
          now,
        );
      onMutation?.({
        entityType: "classification_review_action",
        entityId: actionId,
        action: "classification_review.applied",
        beforeState: { transactionCount: transactionIds.length },
        afterState: {
          decision: input.decision.decision,
          applyScope: input.decision.applyScope,
          transactionCount: transactionIds.length,
          createdRuleId: createdRule?.id ?? null,
        },
        ...(createdRule ? { relatedRuleId: createdRule.id } : {}),
      });
      invalidateMetrics(sqlite, {
        workspaceId: input.workspaceId,
        reason: "classification_review.applied",
      });
      return {
        actionId,
        affectedCount: transactionIds.length,
        createdRule,
      };
    })();
  }

  undoDecision(
    workspaceId: string,
    actionId: string,
    onMutation?: WorkspaceMutationHook,
  ): UndoReviewDecisionResult {
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const row = sqlite
        .prepare(
          `SELECT id, workspace_id, group_key, transaction_ids, before_values,
                  created_rule_id, undone_at
           FROM classification_review_actions
           WHERE workspace_id = ? AND id = ?`,
        )
        .get(workspaceId, actionId) as ReviewActionRow | undefined;
      if (!row) {
        throw new ClassificationReviewError(
          "REVIEW_ACTION_NOT_FOUND",
          "The review action was not found.",
        );
      }
      if (row.undone_at !== null) {
        throw new ClassificationReviewError(
          "REVIEW_ACTION_ALREADY_UNDONE",
          "This review action has already been undone.",
        );
      }
      const snapshots = JSON.parse(row.before_values) as TransactionSnapshot[];
      const currentSnapshots = new Map(
        snapshots.map((snapshot) => [snapshot.id, this.#snapshot(workspaceId, snapshot.id)]),
      );
      if (row.created_rule_id) {
        // Remove the confirmed history before re-evaluating transactions that the remembered
        // rule touched, otherwise that history would immediately recreate the undone result.
        for (const snapshot of snapshots) this.#restoreSnapshot(workspaceId, snapshot);
        try {
          this.#engine.deleteRule(workspaceId, row.created_rule_id);
        } catch (error) {
          if (
            !(error instanceof ClassificationError) ||
            error.code !== "CLASSIFICATION_RULE_NOT_FOUND"
          ) {
            throw error;
          }
        }
      }
      const now = this.#clock();
      for (const snapshot of snapshots) {
        const current = currentSnapshots.get(snapshot.id);
        if (!current) continue;
        this.#restoreSnapshot(workspaceId, snapshot);
        this.#recordRevision(
          snapshot.id,
          current.transaction,
          snapshot.transaction,
          null,
          "manual",
          now,
        );
      }
      sqlite
        .prepare(
          "UPDATE classification_review_actions SET undone_at = ? WHERE workspace_id = ? AND id = ?",
        )
        .run(now, workspaceId, actionId);
      onMutation?.({
        entityType: "classification_review_action",
        entityId: actionId,
        action: "classification_review.undone",
        beforeState: { undone: false, transactionCount: snapshots.length },
        afterState: { undone: true, transactionCount: snapshots.length },
      });
      invalidateMetrics(sqlite, {
        workspaceId,
        reason: "classification_review.undone",
      });
      return { actionId, restoredCount: snapshots.length };
    })();
  }

  #refreshStale(workspaceId: string): void {
    const ids = this.#sqlite()
      .prepare(
        `SELECT t.id
         FROM transactions t
         LEFT JOIN classification_decisions decision ON decision.transaction_id = t.id
         WHERE t.workspace_id = ?
           AND (decision.transaction_id IS NULL OR decision.evaluated_at < t.updated_at)
         ORDER BY t.occurred_at_utc, t.id`,
      )
      .all(workspaceId)
      .map((row) => (row as { id: string }).id);
    this.#engine.classifyTransactions(workspaceId, ids);
  }

  #reviewRows(workspaceId: string): ReviewRow[] {
    return this.#sqlite()
      .prepare(
        `SELECT
          t.id,
          t.occurred_at_utc,
          t.normalized_narration,
          t.amount_minor,
          t.currency,
          t.direction,
          account.display_name AS account_name,
          category.name AS category_name,
          t.counterparty_id,
          counterparty.display_name AS counterparty_name,
          t.review_state,
          decision.confidence,
          decision.suggestion,
          decision.conflict_rule_ids,
          decision.evidence
        FROM transactions t
        JOIN accounts account ON account.id = t.account_id
        JOIN classification_decisions decision ON decision.transaction_id = t.id
        LEFT JOIN categories category ON category.id = t.category_id
        LEFT JOIN counterparties counterparty ON counterparty.id = t.counterparty_id
        WHERE t.workspace_id = ?
          AND (
            t.review_state = 'needs_review'
            OR (decision.needs_review = 1 AND t.review_state <> 'reviewed')
          )
        ORDER BY t.occurred_at_utc ASC, t.id ASC`,
      )
      .all(workspaceId) as ReviewRow[];
  }

  #suggestionFor(transactionId: string): ClassificationSuggestion | null {
    const row = this.#sqlite()
      .prepare("SELECT suggestion FROM classification_decisions WHERE transaction_id = ?")
      .get(transactionId) as { suggestion: string | null } | undefined;
    return row?.suggestion
      ? ClassificationSuggestionSchema.parse(JSON.parse(row.suggestion))
      : null;
  }

  #applyTransactionDecision(
    workspaceId: string,
    actorUserId: string,
    transactionId: string,
    action: ClassificationSuggestion | null,
    decision: "accept" | "change" | "ignore",
    now: number,
  ): void {
    const before = this.#snapshot(workspaceId, transactionId);
    if (action?.categoryId) {
      const split = this.#sqlite()
        .prepare(
          `SELECT 1 FROM transaction_split_sets
           WHERE transaction_id = ? AND status = 'active'`,
        )
        .get(transactionId);
      if (split) {
        throw new ClassificationReviewError(
          "REVIEW_SELECTION_INVALID",
          "Edit categories on the active transaction split instead.",
        );
      }
    }
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (action) {
      const fields: Array<[keyof ClassificationSuggestion, string]> = [
        ["categoryId", "category_id"],
        ["counterpartyId", "counterparty_id"],
        ["transactionType", "transaction_type"],
        ["scope", "scope"],
      ];
      for (const [field, column] of fields) {
        if (Object.hasOwn(action, field)) {
          assignments.push(`${column} = ?`);
          values.push(action[field] ?? null);
        }
      }
      assignments.push(
        "classification_source = 'manual'",
        "confidence_level = 'confirmed'",
        "confidence_basis_points = 10000",
        "classification_explanation = ?",
      );
      values.push(
        decision === "accept"
          ? "Accepted by the user from the review queue."
          : "Changed by the user from the review queue.",
      );
    }
    assignments.push("review_state = 'reviewed'", "updated_at = ?");
    values.push(now);
    this.#sqlite()
      .prepare(
        `UPDATE transactions SET ${assignments.join(", ")}
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(...values, workspaceId, transactionId);

    const evidence = [
      {
        code: decision === "ignore" ? "review.ignored" : "review.confirmed",
        label:
          decision === "ignore"
            ? "Ignored by the user in the review queue."
            : "Confirmed by the user in the review queue.",
        source: "manual",
      },
    ];
    this.#sqlite()
      .prepare(
        `INSERT INTO classification_decisions (
          transaction_id, workspace_id, source, confidence, suggestion, winner_rule_id,
          matched_rule_ids, suppressed_rule_ids, conflict_rule_ids, evidence,
          needs_review, evaluated_at
        ) VALUES (?, ?, 'manual', 'confirmed', ?, NULL, '[]', '[]', '[]', ?, 0, ?)
        ON CONFLICT(transaction_id) DO UPDATE SET
          source = 'manual',
          confidence = 'confirmed',
          suggestion = excluded.suggestion,
          winner_rule_id = NULL,
          matched_rule_ids = '[]',
          suppressed_rule_ids = '[]',
          conflict_rule_ids = '[]',
          evidence = excluded.evidence,
          needs_review = 0,
          evaluated_at = excluded.evaluated_at`,
      )
      .run(
        transactionId,
        workspaceId,
        action ? JSON.stringify(action) : before.decision?.suggestion,
        JSON.stringify(evidence),
        now,
      );
    const after = this.#snapshot(workspaceId, transactionId);
    this.#recordRevision(
      transactionId,
      before.transaction,
      after.transaction,
      actorUserId,
      "manual",
      now,
    );
    invalidateMetrics(this.#sqlite(), {
      workspaceId,
      reason: `classification_review.${decision}`,
      transactionId,
    });
  }

  #snapshot(workspaceId: string, transactionId: string): TransactionSnapshot {
    const transaction = this.#sqlite()
      .prepare(
        `SELECT
          id,
          category_id AS categoryId,
          counterparty_id AS counterpartyId,
          transaction_type AS transactionType,
          scope,
          classification_source AS classificationSource,
          confidence_level AS confidenceLevel,
          confidence_basis_points AS confidenceBasisPoints,
          classification_explanation AS classificationExplanation,
          review_state AS reviewState
         FROM transactions WHERE workspace_id = ? AND id = ?`,
      )
      .get(workspaceId, transactionId) as TransactionSnapshot["transaction"] & {
      id: string;
    };
    if (!transaction) {
      throw new ClassificationReviewError(
        "REVIEW_SELECTION_INVALID",
        "A selected transaction no longer exists.",
      );
    }
    const decision = this.#sqlite()
      .prepare(
        `SELECT
          source,
          confidence,
          suggestion,
          winner_rule_id AS winnerRuleId,
          matched_rule_ids AS matchedRuleIds,
          suppressed_rule_ids AS suppressedRuleIds,
          conflict_rule_ids AS conflictRuleIds,
          evidence,
          needs_review AS needsReview,
          evaluated_at AS evaluatedAt
         FROM classification_decisions WHERE transaction_id = ?`,
      )
      .get(transactionId) as TransactionSnapshot["decision"];
    const { id, ...values } = transaction;
    return { id, transaction: values, decision: decision ?? null };
  }

  #restoreSnapshot(workspaceId: string, snapshot: TransactionSnapshot): void {
    const transaction = snapshot.transaction;
    this.#sqlite()
      .prepare(
        `UPDATE transactions SET
          category_id = ?,
          counterparty_id = ?,
          transaction_type = ?,
          scope = ?,
          classification_source = ?,
          confidence_level = ?,
          confidence_basis_points = ?,
          classification_explanation = ?,
          review_state = ?,
          updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .run(
        transaction.categoryId,
        transaction.counterpartyId,
        transaction.transactionType,
        transaction.scope,
        transaction.classificationSource,
        transaction.confidenceLevel,
        transaction.confidenceBasisPoints,
        transaction.classificationExplanation,
        transaction.reviewState,
        this.#clock(),
        workspaceId,
        snapshot.id,
      );
    if (!snapshot.decision) {
      this.#sqlite()
        .prepare("DELETE FROM classification_decisions WHERE transaction_id = ?")
        .run(snapshot.id);
      return;
    }
    const decision = snapshot.decision;
    this.#sqlite()
      .prepare(
        `INSERT INTO classification_decisions (
          transaction_id, workspace_id, source, confidence, suggestion, winner_rule_id,
          matched_rule_ids, suppressed_rule_ids, conflict_rule_ids, evidence,
          needs_review, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(transaction_id) DO UPDATE SET
          source = excluded.source,
          confidence = excluded.confidence,
          suggestion = excluded.suggestion,
          winner_rule_id = excluded.winner_rule_id,
          matched_rule_ids = excluded.matched_rule_ids,
          suppressed_rule_ids = excluded.suppressed_rule_ids,
          conflict_rule_ids = excluded.conflict_rule_ids,
          evidence = excluded.evidence,
          needs_review = excluded.needs_review,
          evaluated_at = excluded.evaluated_at`,
      )
      .run(
        snapshot.id,
        workspaceId,
        decision.source,
        decision.confidence,
        decision.suggestion,
        decision.winnerRuleId,
        decision.matchedRuleIds,
        decision.suppressedRuleIds,
        decision.conflictRuleIds,
        decision.evidence,
        decision.needsReview,
        decision.evaluatedAt,
      );
  }

  #recordRevision(
    transactionId: string,
    beforeValues: unknown,
    afterValues: unknown,
    actorUserId: string | null,
    source: "manual" | "rule",
    now: number,
  ): void {
    const next = this.#sqlite()
      .prepare(
        `SELECT COALESCE(MAX(revision_number), 0) + 1 AS number
         FROM transaction_revisions WHERE transaction_id = ?`,
      )
      .get(transactionId) as { number: number };
    this.#sqlite()
      .prepare(
        `INSERT INTO transaction_revisions (
          id, transaction_id, revision_number, actor_user_id, source,
          before_values, after_values, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        transactionId,
        next.number,
        actorUserId,
        source,
        JSON.stringify(beforeValues),
        JSON.stringify(afterValues),
        now,
      );
  }

  #validateAction(workspaceId: string, action: ClassificationAction): void {
    ClassificationActionSchema.parse(action);
    if (
      action.categoryId &&
      !this.#sqlite()
        .prepare(
          "SELECT 1 FROM categories WHERE workspace_id = ? AND id = ? AND archived_at IS NULL",
        )
        .get(workspaceId, action.categoryId)
    ) {
      throw new ClassificationReviewError(
        "REVIEW_SELECTION_INVALID",
        "The selected category was not found or is archived.",
      );
    }
    if (
      action.counterpartyId &&
      !this.#sqlite()
        .prepare("SELECT 1 FROM counterparties WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, action.counterpartyId)
    ) {
      throw new ClassificationReviewError(
        "REVIEW_SELECTION_INVALID",
        "The selected counterparty was not found.",
      );
    }
  }

  #rememberedRule(
    group: ReviewGroup,
    action: ClassificationAction,
    name?: string,
  ): {
    name: string;
    kind: "exact" | "pattern" | "counterparty";
    conditions: Array<{
      field: "counterparty_id" | "narration";
      operator: "equals" | "pattern";
      value: string;
    }>;
    action: ClassificationAction;
    priority: number;
    enabled: boolean;
  } {
    const first = group.transactions[0];
    if (!first) {
      throw new ClassificationReviewError("REVIEW_GROUP_NOT_FOUND", "The review group is empty.");
    }
    const row = this.#sqlite()
      .prepare("SELECT counterparty_id, normalized_narration FROM transactions WHERE id = ?")
      .get(first.id) as {
      counterparty_id: string | null;
      normalized_narration: string | null;
    };
    if (group.basis === "counterparty" && row.counterparty_id) {
      return {
        name: name ?? `Remember ${group.label}`,
        kind: "counterparty",
        conditions: [
          {
            field: "counterparty_id",
            operator: "equals",
            value: row.counterparty_id,
          },
        ],
        action,
        priority: 0,
        enabled: true,
      };
    }
    const narrations = group.transactions.map(({ id }) => {
      const value = this.#sqlite()
        .prepare("SELECT normalized_narration FROM transactions WHERE id = ?")
        .get(id) as { normalized_narration: string | null };
      return value.normalized_narration?.trim() ?? "";
    });
    const commonPattern = commonNarrationPattern(narrations);
    return {
      name: name ?? `Remember ${group.label}`,
      kind: commonPattern.includes("*") ? "pattern" : "exact",
      conditions: [
        {
          field: "narration",
          operator: commonPattern.includes("*") ? "pattern" : "equals",
          value: commonPattern,
        },
      ],
      action,
      priority: 0,
      enabled: true,
    };
  }
}

function toReviewGroup(group: MutableGroup): ReviewGroup {
  const suggestions = group.rows
    .map(({ suggestion }) => {
      if (!suggestion) return null;
      const parsed = ClassificationSuggestionSchema.parse(JSON.parse(suggestion));
      return Object.keys(parsed).length > 0 ? parsed : null;
    })
    .filter((suggestion): suggestion is ClassificationSuggestion => suggestion !== null);
  const suggestion =
    suggestions.length === group.rows.length &&
    suggestions.every((candidate) => sameSuggestion(candidate, suggestions[0] ?? {}))
      ? (suggestions[0] ?? null)
      : null;
  const evidenceByCode = new Map<string, ClassificationEvidence>();
  for (const row of group.rows) {
    const evidence = ClassificationEvidenceSchema.array().parse(JSON.parse(row.evidence));
    for (const item of evidence) evidenceByCode.set(`${item.code}:${item.ruleId ?? ""}`, item);
  }
  const totals = new Map<string, { currency: string; debitMinor: number; creditMinor: number }>();
  for (const row of group.rows) {
    const total = totals.get(row.currency) ?? {
      currency: row.currency,
      debitMinor: 0,
      creditMinor: 0,
    };
    if (row.direction === "debit") total.debitMinor += row.amount_minor;
    else total.creditMinor += row.amount_minor;
    totals.set(row.currency, total);
  }
  return {
    key: group.key,
    label: group.label,
    basis: group.basis,
    transactionCount: group.rows.length,
    totals: [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency)),
    confidence: group.rows.reduce(
      (lowest, row) =>
        confidenceRank(row.confidence) < confidenceRank(lowest) ? row.confidence : lowest,
      group.rows[0]?.confidence ?? "unknown",
    ),
    suggestion,
    evidence: [...evidenceByCode.values()],
    hasConflict: group.rows.some(
      ({ conflict_rule_ids }) => parseStringArray(conflict_rule_ids).length,
    ),
    transactions: group.rows.map((row) => ({
      id: row.id,
      occurredAt: new Date(row.occurred_at_utc).toISOString(),
      narration: displayNarration(row),
      amountMinor: row.amount_minor,
      currency: row.currency,
      direction: row.direction,
      accountName: row.account_name,
      categoryName: row.category_name,
      reviewState: row.review_state,
    })),
  };
}

function displayNarration(row: Pick<ReviewRow, "normalized_narration">): string {
  return row.normalized_narration?.trim() || "No description";
}

function hashKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function confidenceRank(confidence: ReviewGroup["confidence"]): number {
  return { unknown: 0, low: 1, medium: 2, high: 3, confirmed: 4 }[confidence];
}

function sameSuggestion(left: ClassificationSuggestion, right: ClassificationSuggestion): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(
    (key) =>
      left[key as keyof ClassificationSuggestion] === right[key as keyof ClassificationSuggestion],
  );
}

function classificationActionFromSuggestion(
  suggestion: ClassificationSuggestion,
): ClassificationAction {
  const compact = Object.fromEntries(
    Object.entries(suggestion).filter(([, value]) => value !== null && value !== undefined),
  );
  return ClassificationActionSchema.parse(compact);
}

function commonNarrationPattern(narrations: string[]): string {
  const nonempty = narrations.filter(Boolean);
  if (nonempty.length === 0) return "*";
  if (nonempty.every((value) => value === nonempty[0])) return nonempty[0] ?? "*";
  const tokenLists = nonempty.map((value) => classificationNarrationKey(value).split(" "));
  const common = (tokenLists[0] ?? []).filter((token) =>
    tokenLists.slice(1).every((tokens) => tokens.includes(token)),
  );
  return common.length > 0 ? `*${common.join("*")}*` : (nonempty[0] ?? "*");
}

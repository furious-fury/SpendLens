import { randomUUID } from "node:crypto";
import type {
  ClassificationAction,
  ClassificationCondition,
  ClassificationEvaluation,
  ClassificationEvidence,
  ClassificationPreview,
  ClassificationPreviewRequest,
  ClassificationRule,
  ClassificationRuleDraft,
  ClassificationRuleKind,
  ClassificationSuggestion,
  TransactionConfidence,
  TransactionType,
  UpdateClassificationRule,
} from "@spendlens/contracts";
import {
  ClassificationActionSchema,
  ClassificationConditionSchema,
  ClassificationRuleDraftSchema,
} from "@spendlens/contracts";
import type Database from "better-sqlite3";
import type { WorkspaceMutationHook } from "./workspace-domain.js";
import { invalidateMetrics } from "./workspace-domain.js";

export type ClassificationErrorCode =
  | "CLASSIFICATION_RULE_NOT_FOUND"
  | "CLASSIFICATION_RULE_INVALID"
  | "CLASSIFICATION_TRANSACTION_NOT_FOUND";

export class ClassificationError extends Error {
  constructor(
    readonly code: ClassificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClassificationError";
  }
}

interface RuleRow {
  id: string;
  workspace_id: string;
  name: string;
  kind: ClassificationRuleKind;
  conditions: string;
  action: string;
  priority: number;
  specificity: number;
  enabled: number;
  created_by_user_id: string | null;
  created_at: number;
  updated_at: number;
}

interface EngineRule {
  id: string;
  workspaceId: string;
  name: string;
  kind: ClassificationRuleKind;
  conditions: ClassificationCondition[];
  action: ClassificationAction;
  priority: number;
  specificity: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface TransactionCandidate {
  id: string;
  workspace_id: string;
  account_id: string;
  account_name: string;
  institution_name: string;
  occurred_at_utc: number;
  direction: "debit" | "credit";
  transaction_type: TransactionType;
  amount_minor: number;
  currency: string;
  normalized_narration: string | null;
  counterparty_id: string | null;
  category_id: string | null;
  scope: "personal" | "business";
  classification_source: "unclassified" | "manual" | "rule" | "history" | "deterministic" | "ai";
  confidence_level: TransactionConfidence;
  confidence_basis_points: number | null;
  classification_explanation: string | null;
  review_state: "unreviewed" | "needs_review" | "reviewed";
  transfer_pairing_status: "none" | "suggested" | "confirmed" | "rejected";
  active_split_count: number;
}

interface EvaluationResult extends ClassificationEvaluation {
  suggestion: ClassificationSuggestion | null;
}

interface HistoricalRow {
  id: string;
  normalized_narration: string | null;
  counterparty_id: string | null;
  category_id: string | null;
  transaction_type: TransactionType;
  scope: "personal" | "business";
}

const candidateSelect = `
  SELECT
    t.id,
    t.workspace_id,
    t.account_id,
    a.display_name AS account_name,
    a.institution_name,
    t.occurred_at_utc,
    t.direction,
    t.transaction_type,
    t.amount_minor,
    t.currency,
    t.normalized_narration,
    t.counterparty_id,
    t.category_id,
    t.scope,
    t.classification_source,
    t.confidence_level,
    t.confidence_basis_points,
    t.classification_explanation,
    t.review_state,
    t.transfer_pairing_status,
    (
      SELECT COUNT(*)
      FROM transaction_split_sets split_set
      WHERE split_set.transaction_id = t.id AND split_set.status = 'active'
    ) AS active_split_count
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
`;

export class ClassificationEngine {
  readonly #sqlite: () => Database.Database;
  readonly #clock: () => number;

  constructor(sqlite: Database.Database | (() => Database.Database), clock = Date.now) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#clock = clock;
  }

  listRules(workspaceId: string): ClassificationRule[] {
    return this.#loadRules(workspaceId, false).map((rule) => this.#publicRule(rule));
  }

  getRule(workspaceId: string, ruleId: string): ClassificationRule {
    const rule = this.#loadRule(workspaceId, ruleId);
    if (!rule) {
      throw new ClassificationError(
        "CLASSIFICATION_RULE_NOT_FOUND",
        "The classification rule was not found.",
      );
    }
    return this.#publicRule(rule);
  }

  previewRule(workspaceId: string, input: ClassificationPreviewRequest): ClassificationPreview {
    const draft = ClassificationRuleDraftSchema.parse(input);
    this.#validateActionReferences(workspaceId, draft.action);
    const existing = input.ruleId ? this.#loadRule(workspaceId, input.ruleId) : null;
    if (input.ruleId && !existing) {
      throw new ClassificationError(
        "CLASSIFICATION_RULE_NOT_FOUND",
        "The classification rule was not found.",
      );
    }
    const candidateRule = this.#engineRule(
      input.ruleId ?? randomUUID(),
      workspaceId,
      draft,
      existing?.createdAt ?? this.#clock(),
      this.#clock(),
    );
    const rules = this.#loadRules(workspaceId, true)
      .filter(({ id }) => id !== input.ruleId)
      .concat(candidateRule)
      .sort(compareRules);
    const items = this.#candidates(workspaceId)
      .filter((transaction) => matchesRule(transaction, candidateRule))
      .map((transaction) => {
        const evaluation = this.#evaluateCandidate(transaction, rules);
        const proposed = evaluation.suggestion ?? {};
        const current = currentSuggestion(transaction);
        return {
          transactionId: transaction.id,
          narration: displayNarration(transaction),
          occurredAt: new Date(transaction.occurred_at_utc).toISOString(),
          amountMinor: transaction.amount_minor,
          currency: transaction.currency,
          direction: transaction.direction,
          current,
          proposed,
          wouldChange: !sameAction(current, proposed),
        };
      });
    return {
      matchCount: items.length,
      changeCount: items.filter(({ wouldChange }) => wouldChange).length,
      items: items.slice(0, 200),
    };
  }

  createRule(
    input: {
      workspaceId: string;
      actorUserId: string;
      draft: ClassificationRuleDraft;
    },
    onMutation?: WorkspaceMutationHook,
  ): ClassificationRule {
    const draft = ClassificationRuleDraftSchema.parse(input.draft);
    this.#validateActionReferences(input.workspaceId, draft.action);
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const id = randomUUID();
      const now = this.#clock();
      const rule = this.#engineRule(id, input.workspaceId, draft, now, now);
      sqlite
        .prepare(
          `INSERT INTO classification_rules (
            id, workspace_id, name, kind, conditions, action, priority, specificity,
            enabled, created_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          rule.name,
          rule.kind,
          JSON.stringify(rule.conditions),
          JSON.stringify(rule.action),
          rule.priority,
          rule.specificity,
          rule.enabled ? 1 : 0,
          input.actorUserId,
          now,
          now,
        );
      const affectedIds = this.#matchingTransactionIds(input.workspaceId, rule);
      if (rule.enabled) this.classifyTransactions(input.workspaceId, affectedIds);
      const created = this.#publicRule(rule);
      onMutation?.({
        entityType: "classification_rule",
        entityId: id,
        action: "classification_rule.created",
        afterState: created,
        relatedRuleId: id,
      });
      invalidateMetrics(sqlite, {
        workspaceId: input.workspaceId,
        reason: "classification_rule.created",
      });
      return created;
    })();
  }

  updateRule(
    input: {
      workspaceId: string;
      ruleId: string;
      changes: UpdateClassificationRule;
    },
    onMutation?: WorkspaceMutationHook,
  ): ClassificationRule {
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const existing = this.#loadRule(input.workspaceId, input.ruleId);
      if (!existing) {
        throw new ClassificationError(
          "CLASSIFICATION_RULE_NOT_FOUND",
          "The classification rule was not found.",
        );
      }
      const merged = ClassificationRuleDraftSchema.parse({
        name: input.changes.name ?? existing.name,
        kind: input.changes.kind ?? existing.kind,
        conditions: input.changes.conditions ?? existing.conditions,
        action: input.changes.action ?? existing.action,
        priority: input.changes.priority ?? existing.priority,
        enabled: input.changes.enabled ?? existing.enabled,
      });
      this.#validateActionReferences(input.workspaceId, merged.action);
      const updated = this.#engineRule(
        existing.id,
        existing.workspaceId,
        merged,
        existing.createdAt,
        this.#clock(),
      );
      const affected = new Set([
        ...this.#matchingTransactionIds(input.workspaceId, existing),
        ...this.#matchingTransactionIds(input.workspaceId, updated),
      ]);
      sqlite
        .prepare(
          `UPDATE classification_rules
           SET name = ?, kind = ?, conditions = ?, action = ?, priority = ?,
               specificity = ?, enabled = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        )
        .run(
          updated.name,
          updated.kind,
          JSON.stringify(updated.conditions),
          JSON.stringify(updated.action),
          updated.priority,
          updated.specificity,
          updated.enabled ? 1 : 0,
          updated.updatedAt,
          updated.id,
          updated.workspaceId,
        );
      this.classifyTransactions(input.workspaceId, [...affected]);
      const before = this.#publicRule(existing);
      const after = this.#publicRule(updated);
      onMutation?.({
        entityType: "classification_rule",
        entityId: updated.id,
        action: "classification_rule.updated",
        beforeState: before,
        afterState: after,
        relatedRuleId: updated.id,
      });
      invalidateMetrics(sqlite, {
        workspaceId: input.workspaceId,
        reason: "classification_rule.updated",
      });
      return after;
    })();
  }

  deleteRule(
    workspaceId: string,
    ruleId: string,
    onMutation?: WorkspaceMutationHook,
  ): ClassificationRule {
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const existing = this.#loadRule(workspaceId, ruleId);
      if (!existing) {
        throw new ClassificationError(
          "CLASSIFICATION_RULE_NOT_FOUND",
          "The classification rule was not found.",
        );
      }
      const affectedIds = this.#matchingTransactionIds(workspaceId, existing);
      sqlite
        .prepare("DELETE FROM classification_rules WHERE id = ? AND workspace_id = ?")
        .run(ruleId, workspaceId);
      this.classifyTransactions(workspaceId, affectedIds);
      const before = this.#publicRule(existing);
      onMutation?.({
        entityType: "classification_rule",
        entityId: ruleId,
        action: "classification_rule.deleted",
        beforeState: before,
        relatedRuleId: ruleId,
      });
      invalidateMetrics(sqlite, {
        workspaceId,
        reason: "classification_rule.deleted",
      });
      return before;
    })();
  }

  reorderRules(
    workspaceId: string,
    orderedRuleIds: string[],
    onMutation?: WorkspaceMutationHook,
  ): ClassificationRule[] {
    const current = this.#loadRules(workspaceId, false);
    if (
      orderedRuleIds.length !== current.length ||
      new Set(orderedRuleIds).size !== current.length ||
      current.some(({ id }) => !orderedRuleIds.includes(id))
    ) {
      throw new ClassificationError(
        "CLASSIFICATION_RULE_INVALID",
        "The reordered list must contain every classification rule exactly once.",
      );
    }
    const sqlite = this.#sqlite();
    return sqlite.transaction(() => {
      const update = sqlite.prepare(
        "UPDATE classification_rules SET priority = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      );
      const now = this.#clock();
      orderedRuleIds.forEach((id, index) => {
        update.run((orderedRuleIds.length - index) * 10, now, id, workspaceId);
      });
      this.classifyTransactions(workspaceId, this.#candidateIds(workspaceId));
      const after = this.listRules(workspaceId);
      onMutation?.({
        entityType: "classification_rules",
        entityId: workspaceId,
        action: "classification_rules.reordered",
        beforeState: current.map(({ id }) => id),
        afterState: orderedRuleIds,
      });
      invalidateMetrics(sqlite, {
        workspaceId,
        reason: "classification_rules.reordered",
      });
      return after;
    })();
  }

  classifyWorkspace(workspaceId: string, onlyUnclassified = false): ClassificationEvaluation[] {
    const ids = this.#sqlite()
      .prepare(
        `SELECT id FROM transactions
         WHERE workspace_id = ?
           ${onlyUnclassified ? "AND classification_source = 'unclassified'" : ""}
         ORDER BY occurred_at_utc, id`,
      )
      .all(workspaceId)
      .map((row) => (row as { id: string }).id);
    return this.classifyTransactions(workspaceId, ids);
  }

  classifyTransactions(workspaceId: string, transactionIds: string[]): ClassificationEvaluation[] {
    if (transactionIds.length === 0) return [];
    const rules = this.#loadRules(workspaceId, true);
    const evaluations: ClassificationEvaluation[] = [];
    for (const transactionId of [...new Set(transactionIds)].sort()) {
      const transaction = this.#candidate(workspaceId, transactionId);
      if (!transaction) continue;
      const evaluation = this.#evaluateCandidate(transaction, rules);
      this.#persistEvaluation(transaction, evaluation);
      evaluations.push(evaluation);
    }
    return evaluations;
  }

  evaluateTransaction(workspaceId: string, transactionId: string): ClassificationEvaluation {
    const transaction = this.#candidate(workspaceId, transactionId);
    if (!transaction) {
      throw new ClassificationError(
        "CLASSIFICATION_TRANSACTION_NOT_FOUND",
        "The transaction was not found.",
      );
    }
    return this.#evaluateCandidate(transaction, this.#loadRules(workspaceId, true));
  }

  #evaluateCandidate(transaction: TransactionCandidate, rules: EngineRule[]): EvaluationResult {
    if (
      transaction.classification_source === "manual" &&
      transaction.confidence_level === "confirmed"
    ) {
      return {
        transactionId: transaction.id,
        source: "manual",
        confidence: "confirmed",
        suggestion: currentSuggestion(transaction),
        winnerRuleId: null,
        matchedRuleIds: [],
        suppressedRuleIds: [],
        conflictRuleIds: [],
        evidence: [evidence("manual.override", "Kept your confirmed classification.", "manual")],
        needsReview: false,
      };
    }

    if (transaction.transfer_pairing_status === "confirmed") {
      return {
        transactionId: transaction.id,
        source: "transfer",
        confidence: "confirmed",
        suggestion: {
          transactionType: "transfer",
          categoryId: this.#categoryId(transaction.workspace_id, "owned-account-transfers"),
        },
        winnerRuleId: null,
        matchedRuleIds: [],
        suppressedRuleIds: [],
        conflictRuleIds: [],
        evidence: [
          evidence(
            "transfer.confirmed_pair",
            "Matched a confirmed transfer between owned accounts.",
            "transfer",
          ),
        ],
        needsReview: false,
      };
    }

    const matched = rules.filter((rule) => matchesRule(transaction, rule)).sort(compareRules);
    if (matched.length > 0) {
      const first = matched[0];
      if (!first) throw new Error("Expected a matching classification rule.");
      const top = matched.filter(
        (rule) => rule.priority === first.priority && rule.specificity === first.specificity,
      );
      const conflicts = conflictingRules(top);
      if (conflicts.length > 0) {
        return {
          transactionId: transaction.id,
          source: "rule",
          confidence: "low",
          suggestion: null,
          winnerRuleId: null,
          matchedRuleIds: matched.map(({ id }) => id),
          suppressedRuleIds: matched.filter((rule) => !top.includes(rule)).map(({ id }) => id),
          conflictRuleIds: conflicts.map(({ id }) => id),
          evidence: [
            evidence(
              "rule.conflict",
              `${conflicts.length} equally ranked rules disagree; no classification was applied.`,
              "rule",
            ),
          ],
          needsReview: true,
        };
      }
      const suggestion = mergeActions(top.map(({ action }) => action));
      const confidence = confidenceForRule(first);
      return {
        transactionId: transaction.id,
        source: sourceForRule(first),
        confidence,
        suggestion: this.#withoutSplitCategory(transaction, suggestion),
        winnerRuleId: first.id,
        matchedRuleIds: matched.map(({ id }) => id),
        suppressedRuleIds: matched.filter((rule) => !top.includes(rule)).map(({ id }) => id),
        conflictRuleIds: [],
        evidence: [
          evidence(
            `rule.${first.kind}`,
            `Matched “${first.name}” using ${describeConditions(first.conditions)}.`,
            sourceForRule(first),
            first.id,
          ),
          ...(matched.length > top.length
            ? [
                evidence(
                  "rule.suppressed",
                  `${matched.length - top.length} lower-ranked rule${matched.length - top.length === 1 ? " was" : "s were"} suppressed.`,
                  "rule" as const,
                ),
              ]
            : []),
        ],
        needsReview: confidence !== "high",
      };
    }

    const bank = this.#bankSuggestion(transaction);
    if (bank) return bank;

    const historical = this.#historicalSuggestion(transaction);
    if (historical) return historical;

    return {
      transactionId: transaction.id,
      source: "unclassified",
      confidence: "unknown",
      suggestion: null,
      winnerRuleId: null,
      matchedRuleIds: [],
      suppressedRuleIds: [],
      conflictRuleIds: [],
      evidence: [
        evidence(
          "fallback.unclassified",
          "No reliable rule or confirmed history matched.",
          "fallback",
        ),
      ],
      needsReview: true,
    };
  }

  #bankSuggestion(transaction: TransactionCandidate): EvaluationResult | null {
    const narration = normalizeText(transaction.normalized_narration ?? "");
    let suggestion: ClassificationSuggestion | null = null;
    let code = "";
    let label = "";
    if (
      transaction.direction === "debit" &&
      /\b(fee|charge|levy|commission|stamp duty)\b/u.test(narration)
    ) {
      suggestion = {
        categoryId: this.#categoryId(transaction.workspace_id, "bank-fees-and-charges"),
        transactionType: "fee",
      };
      code = "bank.fee";
      label = `${transaction.institution_name} narration indicates a bank fee or charge.`;
    } else if (
      transaction.direction === "debit" &&
      /\b(atm|cash withdrawal|withdrawal)\b/u.test(narration)
    ) {
      suggestion = {
        categoryId: this.#categoryId(transaction.workspace_id, "cash-withdrawal"),
        transactionType: "cash_withdrawal",
      };
      code = "bank.cash_withdrawal";
      label = `${transaction.institution_name} narration indicates a cash withdrawal.`;
    } else if (
      transaction.direction === "credit" &&
      /\b(refund|reversal|reversed)\b/u.test(narration)
    ) {
      suggestion = {
        categoryId: this.#categoryId(transaction.workspace_id, "refunds-and-reversals"),
        transactionType: "refund",
      };
      code = "bank.refund";
      label = `${transaction.institution_name} narration indicates a refund or reversal.`;
    }
    if (!suggestion) return null;
    return {
      transactionId: transaction.id,
      source: "bank",
      confidence: "medium",
      suggestion: this.#withoutSplitCategory(transaction, suggestion),
      winnerRuleId: null,
      matchedRuleIds: [],
      suppressedRuleIds: [],
      conflictRuleIds: [],
      evidence: [evidence(code, label, "bank")],
      needsReview: true,
    };
  }

  #historicalSuggestion(transaction: TransactionCandidate): EvaluationResult | null {
    const history = this.#sqlite()
      .prepare(
        `SELECT id, normalized_narration, counterparty_id, category_id, transaction_type, scope
         FROM transactions
         WHERE workspace_id = ?
           AND id <> ?
           AND classification_source = 'manual'
           AND confidence_level = 'confirmed'
         ORDER BY occurred_at_utc DESC, id DESC
         LIMIT 500`,
      )
      .all(transaction.workspace_id, transaction.id) as HistoricalRow[];

    if (transaction.counterparty_id) {
      const sameCounterparty = history.filter(
        ({ counterparty_id }) => counterparty_id === transaction.counterparty_id,
      );
      const action = consistentHistoricalAction(sameCounterparty);
      if (action) {
        return historicalEvaluation(
          transaction,
          this.#withoutSplitCategory(transaction, action),
          "counterparty",
          "high",
          "history.counterparty",
          `Reused a classification you confirmed for this counterparty.`,
        );
      }
    }

    const narration = classificationNarrationKey(transaction.normalized_narration);
    if (!narration) return null;
    const exact = history.filter(
      (row) => classificationNarrationKey(row.normalized_narration) === narration,
    );
    const exactAction = consistentHistoricalAction(exact);
    if (exactAction) {
      return historicalEvaluation(
        transaction,
        this.#withoutSplitCategory(transaction, exactAction),
        "history",
        "medium",
        "history.exact_narration",
        "Matched narration from a transaction you previously confirmed.",
      );
    }

    const similar = history.filter(
      (row) =>
        classificationNarrationSimilarity(
          narration,
          classificationNarrationKey(row.normalized_narration),
        ) >= 0.82,
    );
    const similarAction = consistentHistoricalAction(similar);
    if (!similarAction) return null;
    return historicalEvaluation(
      transaction,
      this.#withoutSplitCategory(transaction, similarAction),
      "history",
      "low",
      "history.similar_narration",
      "Found a similar narration among transactions you previously confirmed.",
    );
  }

  #persistEvaluation(transaction: TransactionCandidate, evaluation: EvaluationResult): void {
    const sqlite = this.#sqlite();
    const now = this.#clock();
    const before = transactionSnapshot(transaction);
    const suggestion = evaluation.suggestion;
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (evaluation.source !== "manual") {
      const baseline = this.#automaticBaseline(transaction);
      const columns: Array<
        [
          keyof ClassificationSuggestion,
          string,
          keyof Pick<
            ReturnType<typeof transactionSnapshot>,
            "categoryId" | "counterpartyId" | "transactionType" | "scope"
          >,
        ]
      > = [
        ["categoryId", "category_id", "categoryId"],
        ["counterpartyId", "counterparty_id", "counterpartyId"],
        ["transactionType", "transaction_type", "transactionType"],
        ["scope", "scope", "scope"],
      ];
      for (const [field, column, baselineField] of columns) {
        assignments.push(`${column} = ?`);
        const value =
          suggestion && Object.hasOwn(suggestion, field)
            ? (suggestion[field] ?? null)
            : (baseline[baselineField] ?? null);
        values.push(value as string | number | null);
      }
    }
    assignments.push(
      "classification_source = ?",
      "confidence_level = ?",
      "confidence_basis_points = ?",
      "classification_explanation = ?",
      "review_state = ?",
      "updated_at = ?",
    );
    values.push(
      databaseSource(evaluation.source),
      evaluation.confidence,
      confidenceBasisPoints(evaluation.confidence),
      evaluation.evidence.map(({ label }) => label).join(" "),
      evaluation.needsReview ? "needs_review" : transaction.review_state,
      now,
    );
    sqlite
      .prepare(
        `UPDATE transactions SET ${assignments.join(", ")}
         WHERE id = ? AND workspace_id = ?`,
      )
      .run(...values, transaction.id, transaction.workspace_id);

    sqlite
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
        transaction.id,
        transaction.workspace_id,
        evaluation.source,
        evaluation.confidence,
        suggestion ? JSON.stringify(suggestion) : null,
        evaluation.winnerRuleId,
        JSON.stringify(evaluation.matchedRuleIds),
        JSON.stringify(evaluation.suppressedRuleIds),
        JSON.stringify(evaluation.conflictRuleIds),
        JSON.stringify(evaluation.evidence),
        evaluation.needsReview ? 1 : 0,
        now,
      );

    const refreshed = this.#candidate(transaction.workspace_id, transaction.id);
    if (!refreshed) return;
    const after = transactionSnapshot(refreshed);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.#recordRevision(transaction.id, before, after, now);
      invalidateMetrics(sqlite, {
        workspaceId: transaction.workspace_id,
        reason: "classification.applied",
        transactionId: transaction.id,
      });
    }
  }

  #recordRevision(
    transactionId: string,
    beforeValues: Record<string, unknown>,
    afterValues: Record<string, unknown>,
    now: number,
  ): void {
    const revision = this.#sqlite()
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
        ) VALUES (?, ?, ?, NULL, 'rule', ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        transactionId,
        revision.number,
        JSON.stringify(beforeValues),
        JSON.stringify(afterValues),
        now,
      );
  }

  #automaticBaseline(transaction: TransactionCandidate): ReturnType<typeof transactionSnapshot> {
    const baseline = transactionSnapshot(transaction);
    const revisions = this.#sqlite()
      .prepare(
        `SELECT source, before_values
         FROM transaction_revisions
         WHERE transaction_id = ?
         ORDER BY revision_number DESC`,
      )
      .all(transaction.id) as Array<{ source: string; before_values: string }>;
    for (const revision of revisions) {
      if (revision.source !== "rule") break;
      const before = JSON.parse(revision.before_values) as Record<string, unknown>;
      for (const key of ["categoryId", "counterpartyId", "transactionType", "scope"] as const) {
        if (Object.hasOwn(before, key)) {
          baseline[key] = before[key] as never;
        }
      }
    }
    return baseline;
  }

  #loadRules(workspaceId: string, enabledOnly: boolean): EngineRule[] {
    return (
      this.#sqlite()
        .prepare(
          `SELECT * FROM classification_rules
           WHERE workspace_id = ? ${enabledOnly ? "AND enabled = 1" : ""}
           ORDER BY priority DESC, specificity DESC, created_at ASC, id ASC`,
        )
        .all(workspaceId) as RuleRow[]
    ).map(parseRuleRow);
  }

  #loadRule(workspaceId: string, ruleId: string): EngineRule | null {
    const row = this.#sqlite()
      .prepare("SELECT * FROM classification_rules WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, ruleId) as RuleRow | undefined;
    return row ? parseRuleRow(row) : null;
  }

  #publicRule(rule: EngineRule): ClassificationRule {
    return {
      id: rule.id,
      name: rule.name,
      kind: rule.kind,
      conditions: rule.conditions,
      action: rule.action,
      priority: rule.priority,
      specificity: rule.specificity,
      enabled: rule.enabled,
      matchCount: this.#matchingTransactionIds(rule.workspaceId, rule).length,
      createdAt: new Date(rule.createdAt).toISOString(),
      updatedAt: new Date(rule.updatedAt).toISOString(),
    };
  }

  #engineRule(
    id: string,
    workspaceId: string,
    draft: ClassificationRuleDraft,
    createdAt: number,
    updatedAt: number,
  ): EngineRule {
    return {
      id,
      workspaceId,
      name: draft.name,
      kind: draft.kind,
      conditions: draft.conditions,
      action: draft.action,
      priority: draft.priority,
      specificity: ruleSpecificity(draft.kind, draft.conditions),
      enabled: draft.enabled,
      createdAt,
      updatedAt,
    };
  }

  #matchingTransactionIds(workspaceId: string, rule: EngineRule): string[] {
    return this.#candidates(workspaceId)
      .filter((transaction) => matchesRule(transaction, rule))
      .map(({ id }) => id);
  }

  #candidateIds(workspaceId: string): string[] {
    return this.#sqlite()
      .prepare("SELECT id FROM transactions WHERE workspace_id = ? ORDER BY id")
      .all(workspaceId)
      .map((row) => (row as { id: string }).id);
  }

  #candidates(workspaceId: string): TransactionCandidate[] {
    return this.#sqlite()
      .prepare(`${candidateSelect} WHERE t.workspace_id = ? ORDER BY t.occurred_at_utc, t.id`)
      .all(workspaceId) as TransactionCandidate[];
  }

  #candidate(workspaceId: string, transactionId: string): TransactionCandidate | null {
    return (
      (this.#sqlite()
        .prepare(`${candidateSelect} WHERE t.workspace_id = ? AND t.id = ?`)
        .get(workspaceId, transactionId) as TransactionCandidate | undefined) ?? null
    );
  }

  #validateActionReferences(workspaceId: string, action: ClassificationAction): void {
    ClassificationActionSchema.parse(action);
    if (action.categoryId) {
      const category = this.#sqlite()
        .prepare(
          "SELECT 1 FROM categories WHERE workspace_id = ? AND id = ? AND archived_at IS NULL",
        )
        .get(workspaceId, action.categoryId);
      if (!category) {
        throw new ClassificationError(
          "CLASSIFICATION_RULE_INVALID",
          "The selected category was not found or is archived.",
        );
      }
    }
    if (action.counterpartyId) {
      const counterparty = this.#sqlite()
        .prepare("SELECT 1 FROM counterparties WHERE workspace_id = ? AND id = ?")
        .get(workspaceId, action.counterpartyId);
      if (!counterparty) {
        throw new ClassificationError(
          "CLASSIFICATION_RULE_INVALID",
          "The selected counterparty was not found.",
        );
      }
    }
  }

  #categoryId(workspaceId: string, systemKey: string): string | undefined {
    return (
      this.#sqlite()
        .prepare("SELECT id FROM categories WHERE workspace_id = ? AND system_key = ?")
        .get(workspaceId, systemKey) as { id: string } | undefined
    )?.id;
  }

  #withoutSplitCategory(
    transaction: TransactionCandidate,
    suggestion: ClassificationSuggestion,
  ): ClassificationSuggestion {
    if (transaction.active_split_count === 0 || !Object.hasOwn(suggestion, "categoryId")) {
      return suggestion;
    }
    const { categoryId: _categoryId, ...remaining } = suggestion;
    return remaining;
  }
}

function parseRuleRow(row: RuleRow): EngineRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    conditions: ClassificationConditionSchema.array().parse(JSON.parse(row.conditions)),
    action: ClassificationActionSchema.parse(JSON.parse(row.action)),
    priority: row.priority,
    specificity: row.specificity,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compareRules(left: EngineRule, right: EngineRule): number {
  return (
    right.priority - left.priority ||
    right.specificity - left.specificity ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  );
}

function matchesRule(transaction: TransactionCandidate, rule: EngineRule): boolean {
  return (
    rule.enabled && rule.conditions.every((condition) => matchesCondition(transaction, condition))
  );
}

function matchesCondition(
  transaction: TransactionCandidate,
  condition: ClassificationCondition,
): boolean {
  const raw = fieldValue(transaction, condition.field);
  if (condition.operator === "amount_range") {
    const amount = Number(raw);
    return (
      (condition.minimum === undefined || amount >= condition.minimum) &&
      (condition.maximum === undefined || amount <= condition.maximum)
    );
  }
  if (
    condition.operator === "greater_than" ||
    condition.operator === "greater_than_or_equal" ||
    condition.operator === "less_than" ||
    condition.operator === "less_than_or_equal"
  ) {
    const value = Number(raw);
    if (condition.operator === "greater_than") return value > condition.value;
    if (condition.operator === "greater_than_or_equal") return value >= condition.value;
    if (condition.operator === "less_than") return value < condition.value;
    return value <= condition.value;
  }
  if (condition.operator === "one_of") {
    return condition.values.some((value) => scalarEqual(raw, value));
  }
  const actual = normalizeText(String(raw ?? ""));
  const expected = normalizeText(String(condition.value));
  if (condition.operator === "equals") return actual === expected;
  if (condition.operator === "contains") return actual.includes(expected);
  if (condition.operator === "starts_with") return actual.startsWith(expected);
  if (condition.operator === "ends_with") return actual.endsWith(expected);
  return wildcardPattern(String(condition.value)).test(String(raw ?? ""));
}

function fieldValue(transaction: TransactionCandidate, field: ClassificationCondition["field"]) {
  const values = {
    narration: transaction.normalized_narration ?? "",
    direction: transaction.direction,
    amount_minor: transaction.amount_minor,
    currency: transaction.currency,
    account_id: transaction.account_id,
    institution_name: transaction.institution_name,
    counterparty_id: transaction.counterparty_id ?? "",
    transaction_type: transaction.transaction_type,
    scope: transaction.scope,
  } satisfies Record<ClassificationCondition["field"], string | number>;
  return values[field];
}

function scalarEqual(left: string | number, right: string | number): boolean {
  if (typeof left === "number" || typeof right === "number") return Number(left) === Number(right);
  return normalizeText(left) === normalizeText(right);
}

function wildcardPattern(value: string): RegExp {
  const escaped = value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const pattern = escaped.replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${pattern}$`, "iu");
}

function ruleSpecificity(
  kind: ClassificationRuleKind,
  conditions: ClassificationCondition[],
): number {
  const kindScore = { exact: 400, counterparty: 350, bank: 250, pattern: 150 }[kind];
  const conditionScore = conditions.reduce((total, condition) => {
    const score = {
      equals: 100,
      one_of: 80,
      starts_with: 65,
      ends_with: 65,
      contains: 55,
      amount_range: 45,
      greater_than: 35,
      greater_than_or_equal: 35,
      less_than: 35,
      less_than_or_equal: 35,
      pattern: 25,
    }[condition.operator];
    return total + score;
  }, 0);
  return kindScore + conditionScore + conditions.length * 10;
}

function conflictingRules(rules: EngineRule[]): EngineRule[] {
  if (rules.length < 2) return [];
  const conflicts = new Set<EngineRule>();
  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const left = rules[leftIndex];
      const right = rules[rightIndex];
      if (!left || !right) continue;
      if (actionsConflict(left.action, right.action)) {
        conflicts.add(left);
        conflicts.add(right);
      }
    }
  }
  return [...conflicts];
}

function actionsConflict(left: ClassificationAction, right: ClassificationAction): boolean {
  return (Object.keys(left) as Array<keyof ClassificationAction>).some(
    (field) =>
      Object.hasOwn(right, field) &&
      left[field] !== undefined &&
      right[field] !== undefined &&
      left[field] !== right[field],
  );
}

function mergeActions(actions: ClassificationAction[]): ClassificationSuggestion {
  return Object.assign({}, ...actions) as ClassificationSuggestion;
}

function confidenceForRule(rule: EngineRule): TransactionConfidence {
  if (rule.kind === "exact" || rule.kind === "counterparty") return "high";
  if (rule.kind === "bank") return "medium";
  return "low";
}

function sourceForRule(
  rule: EngineRule,
): Extract<ClassificationEvidence["source"], "rule" | "counterparty" | "bank"> {
  if (rule.kind === "counterparty") return "counterparty";
  if (rule.kind === "bank") return "bank";
  return "rule";
}

function evidence(
  code: string,
  label: string,
  source: ClassificationEvidence["source"],
  ruleId?: string,
): ClassificationEvidence {
  return { code, label, source, ...(ruleId ? { ruleId } : {}) };
}

function describeConditions(conditions: ClassificationCondition[]): string {
  return conditions
    .slice(0, 3)
    .map(({ field, operator }) => `${field.replaceAll("_", " ")} ${operator.replaceAll("_", " ")}`)
    .join(" and ");
}

function historicalEvaluation(
  transaction: TransactionCandidate,
  suggestion: ClassificationSuggestion,
  source: "counterparty" | "history",
  confidence: "low" | "medium" | "high",
  code: string,
  label: string,
): EvaluationResult {
  return {
    transactionId: transaction.id,
    source,
    confidence,
    suggestion,
    winnerRuleId: null,
    matchedRuleIds: [],
    suppressedRuleIds: [],
    conflictRuleIds: [],
    evidence: [evidence(code, label, source === "counterparty" ? "counterparty" : "history")],
    needsReview: confidence !== "high",
  };
}

function consistentHistoricalAction(rows: HistoricalRow[]): ClassificationSuggestion | null {
  if (rows.length === 0) return null;
  const actions = rows.map((row) => ({
    ...(row.category_id ? { categoryId: row.category_id } : {}),
    ...(row.counterparty_id ? { counterpartyId: row.counterparty_id } : {}),
    transactionType: row.transaction_type,
    scope: row.scope,
  }));
  const first = actions[0];
  if (!first || actions.some((action) => !sameAction(first, action))) return null;
  return first;
}

function currentSuggestion(transaction: TransactionCandidate): ClassificationSuggestion {
  return {
    ...(transaction.category_id ? { categoryId: transaction.category_id } : {}),
    ...(transaction.counterparty_id ? { counterpartyId: transaction.counterparty_id } : {}),
    transactionType: transaction.transaction_type,
    scope: transaction.scope,
  };
}

function sameAction(left: ClassificationSuggestion, right: ClassificationSuggestion): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(
    (key) =>
      left[key as keyof ClassificationSuggestion] === right[key as keyof ClassificationSuggestion],
  );
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function classificationNarrationKey(value: string | null): string {
  return normalizeText(value ?? "")
    .replace(/\b(?:ref|reference|session|txn|transaction)\b[:\s-]*[a-z0-9-]+/giu, " ")
    .replace(/\d{4,}/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function classificationNarrationSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function displayNarration(transaction: TransactionCandidate): string {
  return transaction.normalized_narration?.trim() || "No description";
}

function transactionSnapshot(transaction: TransactionCandidate): Record<string, unknown> {
  return {
    categoryId: transaction.category_id,
    counterpartyId: transaction.counterparty_id,
    transactionType: transaction.transaction_type,
    scope: transaction.scope,
    classificationSource: transaction.classification_source,
    confidenceLevel: transaction.confidence_level,
    confidenceBasisPoints: transaction.confidence_basis_points,
    classificationExplanation: transaction.classification_explanation,
    reviewState: transaction.review_state,
  };
}

function databaseSource(source: ClassificationEvaluation["source"]) {
  if (source === "rule") return "rule";
  if (source === "counterparty" || source === "history") return "history";
  if (source === "bank" || source === "transfer") return "deterministic";
  if (source === "manual") return "manual";
  return "unclassified";
}

function confidenceBasisPoints(confidence: TransactionConfidence): number | null {
  return {
    unknown: null,
    low: 3500,
    medium: 6500,
    high: 9000,
    confirmed: 10000,
  }[confidence];
}

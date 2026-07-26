import { randomUUID } from "node:crypto";
import type { ClassificationCondition, ClassificationRuleDraft } from "@spendlens/contracts";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  AuditLog,
  ClassificationEngine,
  ClassificationReview,
  seedStarterTaxonomy,
  starterCategoryId,
  type WorkspaceMutation,
} from "../src/index.js";

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const ACCOUNT_ID = randomUUID();

describe("classification rules", () => {
  it("orders matches by priority, specificity, creation time, and stable ID", () => {
    const fixture = databaseFixture();
    const first = insertTransaction(fixture.sqlite, "NETFLIX MONTHLY");
    const engine = new ClassificationEngine(fixture.sqlite, fixture.clock);
    const food = starterCategoryId(WORKSPACE_ID, "food-and-dining");
    const subscriptions = starterCategoryId(WORKSPACE_ID, "subscriptions");

    engine.createRule({
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      draft: rule(
        "Broad entertainment",
        "pattern",
        [{ field: "narration", operator: "contains", value: "netflix" }],
        { categoryId: food },
        5,
      ),
    });
    const winner = engine.createRule({
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      draft: rule(
        "Exact Netflix",
        "exact",
        [{ field: "narration", operator: "equals", value: "NETFLIX MONTHLY" }],
        { categoryId: subscriptions },
        10,
      ),
    });

    expect(engine.evaluateTransaction(WORKSPACE_ID, first)).toMatchObject({
      winnerRuleId: winner.id,
      conflictRuleIds: [],
      suppressedRuleIds: expect.any(Array),
      suggestion: { categoryId: subscriptions },
      confidence: "high",
    });
    expect(transaction(fixture.sqlite, first)).toMatchObject({
      category_id: subscriptions,
      classification_source: "rule",
    });
    fixture.sqlite.close();
  });

  it("exposes equally ranked conflicting final actions without silently choosing one", () => {
    const fixture = databaseFixture();
    const transactionId = insertTransaction(fixture.sqlite, "BOLT RIDE");
    const engine = new ClassificationEngine(fixture.sqlite, () => 100);
    const transport = starterCategoryId(WORKSPACE_ID, "transport");
    const travel = starterCategoryId(WORKSPACE_ID, "travel");
    const condition: ClassificationCondition = {
      field: "narration",
      operator: "equals",
      value: "BOLT RIDE",
    };
    const left = engine.createRule({
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      draft: rule("Bolt is transport", "exact", [condition], { categoryId: transport }),
    });
    const right = engine.createRule({
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      draft: rule("Bolt is travel", "exact", [condition], { categoryId: travel }),
    });

    const evaluation = engine.evaluateTransaction(WORKSPACE_ID, transactionId);
    expect(evaluation.winnerRuleId).toBeNull();
    expect(evaluation.conflictRuleIds.sort()).toEqual([left.id, right.id].sort());
    expect(evaluation.needsReview).toBe(true);
    expect(transaction(fixture.sqlite, transactionId).review_state).toBe("needs_review");
    fixture.sqlite.close();
  });

  it.each([
    {
      name: "equals",
      condition: { field: "currency", operator: "equals", value: "NGN" },
    },
    {
      name: "contains",
      condition: { field: "narration", operator: "contains", value: "market" },
    },
    {
      name: "starts with",
      condition: { field: "narration", operator: "starts_with", value: "Wuse" },
    },
    {
      name: "ends with",
      condition: { field: "narration", operator: "ends_with", value: "Market" },
    },
    {
      name: "one of",
      condition: { field: "direction", operator: "one_of", values: ["debit", "credit"] },
    },
    {
      name: "safe wildcard pattern",
      condition: { field: "narration", operator: "pattern", value: "Wuse*Market" },
    },
    {
      name: "comparison",
      condition: { field: "amount_minor", operator: "greater_than", value: 1000 },
    },
    {
      name: "amount range",
      condition: {
        field: "amount_minor",
        operator: "amount_range",
        minimum: 1000,
        maximum: 5000,
      },
    },
  ] as const)("supports the $name operator", ({ condition }) => {
    const fixture = databaseFixture();
    insertTransaction(fixture.sqlite, "Wuse Central Market", 2500);
    const engine = new ClassificationEngine(fixture.sqlite);
    const draft = rule(
      "Operator check",
      condition.operator === "pattern" ? "pattern" : "exact",
      [condition],
      { categoryId: starterCategoryId(WORKSPACE_ID, "shopping") },
    );
    expect(engine.previewRule(WORKSPACE_ID, draft).matchCount).toBe(1);
    fixture.sqlite.close();
  });

  it("keeps previewed changes equal to the changes produced after creation", () => {
    const fixture = databaseFixture();
    const transactionId = insertTransaction(fixture.sqlite, "SHOPRITE LEKKI");
    const engine = new ClassificationEngine(fixture.sqlite, fixture.clock);
    const groceries = starterCategoryId(WORKSPACE_ID, "groceries");
    const draft = rule(
      "Shoprite groceries",
      "exact",
      [{ field: "narration", operator: "equals", value: "SHOPRITE LEKKI" }],
      { categoryId: groceries, transactionType: "expense" },
    );
    const preview = engine.previewRule(WORKSPACE_ID, draft);

    engine.createRule({ workspaceId: WORKSPACE_ID, actorUserId: USER_ID, draft });

    expect(preview).toMatchObject({ matchCount: 1, changeCount: 1 });
    expect(preview.items[0]?.transactionId).toBe(transactionId);
    expect(transaction(fixture.sqlite, transactionId)).toMatchObject({
      category_id: groceries,
      transaction_type: "expense",
    });
    fixture.sqlite.close();
  });

  it("never lets rules or fuzzy history override a confirmed manual decision", () => {
    const fixture = databaseFixture();
    const transactionId = insertTransaction(fixture.sqlite, "Lunch with Tola");
    const food = starterCategoryId(WORKSPACE_ID, "food-and-dining");
    const shopping = starterCategoryId(WORKSPACE_ID, "shopping");
    fixture.sqlite
      .prepare(
        `UPDATE transactions SET
          category_id = ?,
          classification_source = 'manual',
          confidence_level = 'confirmed',
          confidence_basis_points = 10000,
          review_state = 'reviewed'
         WHERE id = ?`,
      )
      .run(food, transactionId);
    const engine = new ClassificationEngine(fixture.sqlite, fixture.clock);
    engine.createRule({
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      draft: rule(
        "Everything with lunch",
        "pattern",
        [{ field: "narration", operator: "contains", value: "lunch" }],
        { categoryId: shopping },
        100,
      ),
    });

    expect(engine.evaluateTransaction(WORKSPACE_ID, transactionId)).toMatchObject({
      source: "manual",
      confidence: "confirmed",
      suggestion: { categoryId: food },
    });
    expect(transaction(fixture.sqlite, transactionId).category_id).toBe(food);
    fixture.sqlite.close();
  });

  it("re-evaluates only transactions matched by a changed rule", () => {
    const fixture = databaseFixture();
    const matched = insertTransaction(fixture.sqlite, "DSTV MONTHLY");
    const unrelated = insertTransaction(fixture.sqlite, "WUSE MARKET");
    const engine = new ClassificationEngine(fixture.sqlite, fixture.clock);
    engine.classifyWorkspace(WORKSPACE_ID);
    const before = fixture.sqlite
      .prepare(
        "SELECT evaluated_at AS evaluatedAt FROM classification_decisions WHERE transaction_id = ?",
      )
      .get(unrelated) as { evaluatedAt: number };
    const created = engine.createRule({
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      draft: rule(
        "DSTV subscription",
        "exact",
        [{ field: "narration", operator: "equals", value: "DSTV MONTHLY" }],
        { categoryId: starterCategoryId(WORKSPACE_ID, "subscriptions") },
      ),
    });

    engine.updateRule({
      workspaceId: WORKSPACE_ID,
      ruleId: created.id,
      changes: { action: { categoryId: starterCategoryId(WORKSPACE_ID, "utilities") } },
    });

    expect(transaction(fixture.sqlite, matched).category_id).toBe(
      starterCategoryId(WORKSPACE_ID, "utilities"),
    );
    expect(
      fixture.sqlite
        .prepare(
          "SELECT evaluated_at AS evaluatedAt FROM classification_decisions WHERE transaction_id = ?",
        )
        .get(unrelated),
    ).toEqual(before);
    fixture.sqlite.close();
  });
});

describe("grouped classification review", () => {
  it("groups similar narrations, remembers future matches, audits the action, and undoes it", () => {
    const fixture = databaseFixture();
    const first = insertTransaction(fixture.sqlite, "Transfer to Chidi 123456");
    const second = insertTransaction(fixture.sqlite, "Transfer to Chidi 987654");
    const engine = new ClassificationEngine(fixture.sqlite, fixture.clock);
    const review = new ClassificationReview(fixture.sqlite, engine, fixture.clock);
    const audit = new AuditLog(fixture.sqlite, fixture.clock);
    const mutation = (event: WorkspaceMutation) =>
      audit.record({
        workspaceId: WORKSPACE_ID,
        actorUserId: USER_ID,
        entityType: event.entityType,
        entityId: event.entityId,
        action: event.action,
        beforeState: event.beforeState,
        afterState: event.afterState,
        relatedRuleId: event.relatedRuleId,
      });

    const groups = review.listGroups(WORKSPACE_ID);
    expect(groups).toMatchObject({
      totalTransactions: 2,
      items: [{ basis: "narration", transactionCount: 2 }],
    });
    const group = groups.items[0];
    if (!group) throw new Error("Expected a review group.");
    const family = starterCategoryId(WORKSPACE_ID, "family-and-support");
    const result = review.applyDecision(
      {
        workspaceId: WORKSPACE_ID,
        actorUserId: USER_ID,
        decision: {
          groupKey: group.key,
          decision: "change",
          applyScope: "future_matches",
          action: { categoryId: family, transactionType: "expense" },
          rememberForFuture: true,
          ruleName: "Transfers to Chidi",
        },
      },
      mutation,
    );
    expect(result).toMatchObject({ affectedCount: 2, createdRule: { enabled: true } });
    expect([first, second].map((id) => transaction(fixture.sqlite, id).category_id)).toEqual([
      family,
      family,
    ]);

    const later = insertTransaction(fixture.sqlite, "Transfer to Chidi 555555");
    engine.classifyWorkspace(WORKSPACE_ID, true);
    expect(transaction(fixture.sqlite, later).category_id).toBe(family);
    expect(
      fixture.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE workspace_id = ? AND action LIKE 'classification_%'",
        )
        .get(WORKSPACE_ID),
    ).toEqual({ count: 2 });

    expect(review.undoDecision(WORKSPACE_ID, result.actionId, mutation)).toEqual({
      actionId: result.actionId,
      restoredCount: 2,
    });
    expect(engine.listRules(WORKSPACE_ID)).toEqual([]);
    expect([first, second].map((id) => transaction(fixture.sqlite, id).category_id)).toEqual([
      null,
      null,
    ]);
    expect(transaction(fixture.sqlite, later).category_id).toBeNull();
    fixture.sqlite.close();
  });
});

function databaseFixture() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  applyMigrations(sqlite);
  let now = 1_800_000_000_000;
  const clock = () => ++now;
  sqlite
    .prepare(
      `INSERT INTO workspaces (
        id, name, timezone, setup_completed_at, created_at, updated_at
      ) VALUES (?, 'SpendLens', 'Africa/Lagos', ?, ?, ?)`,
    )
    .run(WORKSPACE_ID, clock(), clock(), clock());
  sqlite
    .prepare(
      `INSERT INTO users (
        id, workspace_id, username, display_name, password_hash,
        password_changed_at, created_at, updated_at
      ) VALUES (?, ?, 'owner', 'Owner', 'hash', ?, ?, ?)`,
    )
    .run(USER_ID, WORKSPACE_ID, clock(), clock(), clock());
  seedStarterTaxonomy(sqlite, WORKSPACE_ID, clock);
  sqlite
    .prepare(
      `INSERT INTO accounts (
        id, workspace_id, institution_name, institution_code, display_name,
        account_type, base_currency, is_owned, created_at, updated_at
      ) VALUES (?, ?, 'PalmPay', 'palmpay', 'PalmPay', 'wallet', 'NGN', 1, ?, ?)`,
    )
    .run(ACCOUNT_ID, WORKSPACE_ID, clock(), clock());
  return { sqlite, clock };
}

function insertTransaction(
  sqlite: Database.Database,
  narration: string,
  amountMinor = 2500,
): string {
  const id = randomUUID();
  const now = Date.now();
  sqlite
    .prepare(
      `INSERT INTO transactions (
        id, workspace_id, account_id, occurred_at_utc, source_timestamp,
        source_timezone, direction, transaction_type, amount_minor, currency,
        normalized_narration, scope, classification_source, confidence_level,
        review_state, transfer_pairing_status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, '2026-06-01 12:00:00', 'Africa/Lagos', 'debit',
        'unclassified', ?, 'NGN', ?, 'personal', 'unclassified', 'unknown',
        'unreviewed', 'none', ?, ?
      )`,
    )
    .run(id, WORKSPACE_ID, ACCOUNT_ID, now, amountMinor, narration, now, now);
  return id;
}

function rule(
  name: string,
  kind: ClassificationRuleDraft["kind"],
  conditions: ClassificationCondition[],
  action: ClassificationRuleDraft["action"],
  priority = 0,
): ClassificationRuleDraft {
  return { name, kind, conditions, action, priority, enabled: true };
}

function transaction(sqlite: Database.Database, id: string) {
  return sqlite
    .prepare(
      `SELECT category_id, transaction_type, classification_source,
              confidence_level, review_state
       FROM transactions WHERE id = ?`,
    )
    .get(id) as {
    category_id: string | null;
    transaction_type: string;
    classification_source: string;
    confidence_level: string;
    review_state: string;
  };
}

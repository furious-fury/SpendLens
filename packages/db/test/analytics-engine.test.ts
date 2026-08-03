import { randomUUID } from "node:crypto";
import type { AnalyticsMetricId, AnalyticsQuery } from "@spendlens/contracts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AnalyticsEngine,
  analyticsMetricRegistry,
  applyMigrations,
  invalidateMetrics,
  seedStarterTaxonomy,
  starterCategoryId,
} from "../src/index.js";

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const ACCOUNT_ONE = randomUUID();
const ACCOUNT_TWO = randomUUID();
const IMPORT_ID = randomUUID();
const STORE = randomUUID();
const LEISURE = randomUUID();
const SHOP = randomUUID();
const STREAMING = randomUUID();
const EMPLOYER = randomUUID();
const CLIENT = randomUUID();

const EXPECTED_METRICS = {
  "cashflow.total_inflow": {
    value: 245_000,
    reason:
      "Credits include income, refunds, reversals, and an external transfer; owned transfer is excluded.",
  },
  "cashflow.total_outflow": {
    value: 166_000,
    reason: "Debits include ordinary movement and split allocations; owned transfer is excluded.",
  },
  "cashflow.net": { value: 79_000, reason: "245,000 inflow less 166,000 outflow." },
  "cashflow.average_inflow": {
    value: 35_000,
    reason: "Seven included credit transactions total 245,000.",
  },
  "cashflow.average_outflow": {
    value: 18_444,
    reason: "Nine included debit transactions total 166,000, rounded to minor units.",
  },
  "cashflow.median_transaction": {
    value: 7_500,
    reason: "The middle two of sixteen cash movements are 5,000 and 10,000.",
  },
  "cashflow.largest_inflow": { value: 200_000, reason: "Salary is the largest credit." },
  "cashflow.largest_outflow": {
    value: 100_000,
    reason: "Shopping is the largest non-transfer debit.",
  },
  "cashflow.inflow_outflow_ratio": {
    value: 245_000 / 166_000,
    reason: "Included inflow divided by included outflow.",
  },
  "cashflow.cumulative": {
    value: 79_000,
    reason: "The final daily cumulative movement equals net cash flow.",
  },
  "cashflow.by_day": {
    value: 79_000,
    reason: "Daily signed movements sum to the same 79,000 net cash flow.",
  },
  "cashflow.by_account": {
    value: 79_000,
    reason: "Signed movement grouped by account preserves the overall net cash flow.",
  },
  "cashflow.transaction_count": {
    value: 16,
    reason: "Eighteen NGN transactions less the two sides of the owned transfer.",
  },
  "spending.by_category": {
    value: 166_000,
    reason: "All ordinary debits, with the 20,000 parent replaced by 12,000 and 8,000 splits.",
  },
  "spending.by_counterparty": { value: 166_000, reason: "The same spending grouped by recipient." },
  "spending.fees": { value: 1_000, reason: "One bank-fee debit." },
  "spending.cash_withdrawals": { value: 5_000, reason: "One cash-withdrawal debit." },
  "spending.recurring": {
    value: 6_000,
    reason: "Three 2,000 subscription debits occur seven days apart.",
  },
  "spending.by_weekday": { value: 166_000, reason: "All spending grouped by local weekday." },
  "spending.by_day": { value: 166_000, reason: "All spending grouped by local calendar day." },
  "spending.concentration": {
    value: 9_036,
    reason: "The top three counterparties contribute 150,000 of 166,000 spending.",
  },
  "spending.unusual": {
    value: 130_000,
    reason: "The 30,000 grocery and 100,000 shopping rows exceed the fixture's Tukey fence.",
  },
  "spending.variable": {
    value: 160_000,
    reason: "Total spending less the three detected recurring subscription payments.",
  },
  "income.by_source": {
    value: 230_000,
    reason: "Salary and weekly client income; refunds and transfers remain separate.",
  },
  "income.recurring": {
    value: 30_000,
    reason: "Three 10,000 client credits occur seven days apart.",
  },
  "income.by_weekday": { value: 230_000, reason: "Classified income grouped by local weekday." },
  "income.by_day": { value: 230_000, reason: "Classified income grouped by local calendar day." },
  "income.concentration": {
    value: 10_000,
    reason: "The only two income sources account for all income.",
  },
  "income.variability": {
    value: 0,
    reason: "The fixture has one active income month, so monthly variation is zero.",
  },
  "income.irregular": {
    value: 200_000,
    reason: "Salary remains after excluding the three detected recurring client payments.",
  },
  "savings.estimated_rate": {
    value: 2_783,
    reason: "Income less spending is 64,000, or 27.83% of classified income.",
  },
  "spending.essential": {
    value: 42_000,
    reason: "30,000 groceries plus the 12,000 essential side of the split.",
  },
  "spending.discretionary": {
    value: 114_000,
    reason: "8,000 entertainment, 100,000 shopping, and 6,000 subscriptions.",
  },
  "behaviour.no_spend_days": {
    value: 21,
    reason: "Nine of the thirty June days contain spending.",
  },
  "behaviour.activity_by_weekday": {
    value: 18,
    reason: "All distinct NGN transactions, including transfer and adjustment activity.",
  },
  "behaviour.activity_by_day": {
    value: 18,
    reason: "All distinct NGN transactions are grouped by local calendar day.",
  },
  "behaviour.average_daily_activity": {
    value: 0.6,
    reason: "Eighteen distinct transactions across the thirty selected calendar days.",
  },
  "behaviour.account_usage": {
    value: 18,
    reason: "All distinct NGN transactions are grouped by their source account.",
  },
  "behaviour.weekend_share": {
    value: 1_111,
    reason: "Two of eighteen NGN transactions occur on Saturday or Sunday.",
  },
  "behaviour.change": {
    value: 166_000,
    reason: "Current spending is compared with the prior period.",
  },
  "behaviour.expense_income_ratio": {
    value: 7_217,
    reason: "166,000 classified spending is 72.17% of 230,000 confirmed income.",
  },
  "behaviour.savings_transfers": {
    value: 0,
    reason: "The fixture has no transactions assigned to a savings category.",
  },
  "quality.classification_coverage": {
    value: 9_444,
    reason: "Seventeen of eighteen transactions are classified.",
  },
  "quality.confidence_distribution": {
    value: 18,
    reason: "Every distinct NGN transaction contributes to one confidence bucket.",
  },
  "quality.review_queue": { value: 1, reason: "Only the unclassified debit needs review." },
  "quality.reconciliation": {
    value: 18,
    reason: "One sourced transaction is matched and seventeen have unknown source reconciliation.",
  },
  "quality.duplicate_sources": {
    value: 1,
    reason: "One extra statement row is linked to the canonical grocery transaction.",
  },
  "adjustments.refunds": {
    value: 3_000,
    reason: "The merchant refund is separated from ordinary income and reversals.",
  },
  "adjustments.reversals": {
    value: 2_000,
    reason: "The refund-classified row explicitly says reversal.",
  },
  "transfers.internal": {
    value: 50_000,
    reason: "The confirmed owned transfer is counted once on its debit side.",
  },
  "transfers.external": {
    value: 10_000,
    reason: "One transfer credit is not paired to an owned account.",
  },
  "balance.opening": {
    value: null,
    reason: "PalmPay fixture rows do not provide running balances.",
  },
  "balance.closing": {
    value: null,
    reason: "PalmPay fixture rows do not provide running balances.",
  },
  "balance.lowest": {
    value: null,
    reason: "PalmPay fixture rows do not provide running balances.",
  },
  "balance.highest": {
    value: null,
    reason: "PalmPay fixture rows do not provide running balances.",
  },
} satisfies Record<AnalyticsMetricId, { value: number | null; reason: string }>;

let sqlite: Database.Database;
let engine: AnalyticsEngine;
let fixture: ReturnType<typeof seedMetricFixture>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      `INSERT INTO workspaces (
        id, name, timezone, setup_completed_at, created_at, updated_at
      ) VALUES (?, 'Analytics fixture', 'Africa/Lagos', 1, 1, 1)`,
    )
    .run(WORKSPACE_ID);
  sqlite
    .prepare(
      `INSERT INTO users (
        id, workspace_id, username, display_name, password_hash,
        password_changed_at, created_at, updated_at
      ) VALUES (?, ?, 'owner', 'Owner', 'hash', 1, 1, 1)`,
    )
    .run(USER_ID, WORKSPACE_ID);
  seedStarterTaxonomy(sqlite, WORKSPACE_ID);
  insertAccount(ACCOUNT_ONE, "PalmPay");
  insertAccount(ACCOUNT_TWO, "Savings");
  for (const [id, name] of [
    [STORE, "Corner Store"],
    [LEISURE, "Cinema"],
    [SHOP, "Device Shop"],
    [STREAMING, "Streaming Service"],
    [EMPLOYER, "Employer"],
    [CLIENT, "Weekly Client"],
  ] as const) {
    insertCounterparty(id, name);
  }
  fixture = seedMetricFixture();
  engine = new AnalyticsEngine(sqlite, () => Date.UTC(2026, 6, 1));
});

afterEach(() => sqlite.close());

describe("analytics metric registry", () => {
  it("registers every public metric exactly once with calculation metadata", () => {
    expect(analyticsMetricRegistry).toHaveLength(55);
    expect(new Set(analyticsMetricRegistry.map(({ id }) => id)).size).toBe(55);
    for (const item of analyticsMetricRegistry) {
      expect(item.title).not.toBe("");
      expect(item.definition).not.toBe("");
      expect(item.requiredFields.length).toBeGreaterThan(0);
      expect(item.supportedDimensions.length).toBeGreaterThan(0);
      expect(EXPECTED_METRICS[item.id].reason).not.toBe("");
    }
  });
});

describe("traceable financial calculations", () => {
  it("matches the manually documented fixture for every registered metric", () => {
    const result = engine.query(WORKSPACE_ID, query());

    expect(result.metrics).toHaveLength(55);
    for (const metric of result.metrics) {
      const expected = EXPECTED_METRICS[metric.id];
      if (metric.id === "cashflow.inflow_outflow_ratio") {
        expect(metric.value).toBeCloseTo(expected.value as number, 10);
      } else {
        expect(metric.value, `${metric.id}: ${expected.reason}`).toBe(expected.value);
      }
      expect(metric.status).toBe(expected.value === null ? "unavailable" : "available");
      expect(new Set(metric.transactionIds).size).toBe(metric.transactionIds.length);
      for (const item of metric.breakdown) {
        expect(new Set(item.transactionIds).size).toBe(item.transactionIds.length);
        expect(item.transactionIds.every((id) => fixture.ngnIds.has(id))).toBe(true);
      }
    }
  });

  it("uses split allocations and preserves exact drill-down provenance", () => {
    const result = engine.query(WORKSPACE_ID, query(["spending.by_category"]));
    const metric = result.metrics[0];
    const groceries = metric?.breakdown.find(
      ({ key }) => key === starterCategoryId(WORKSPACE_ID, "groceries"),
    );
    const entertainment = metric?.breakdown.find(
      ({ key }) => key === starterCategoryId(WORKSPACE_ID, "entertainment"),
    );
    const unclassified = metric?.breakdown.find(({ key }) => key === "unclassified");

    expect(groceries).toMatchObject({ value: 42_000 });
    expect(groceries?.transactionIds.sort()).toEqual([fixture.groceryId, fixture.splitId].sort());
    expect(entertainment).toMatchObject({
      value: 8_000,
      transactionIds: [fixture.splitId],
    });
    expect(unclassified).toMatchObject({
      value: 4_000,
      transactionIds: [fixture.unclassifiedId],
    });
    expect(metric?.transactionIds.filter((id) => id === fixture.splitId)).toHaveLength(1);
  });

  it("excludes owned transfers by default and separates refunds, reversals, and external transfers", () => {
    const result = engine.query(
      WORKSPACE_ID,
      query([
        "cashflow.total_inflow",
        "cashflow.total_outflow",
        "income.by_source",
        "adjustments.refunds",
        "adjustments.reversals",
        "transfers.internal",
        "transfers.external",
      ]),
    );
    const byId = new Map(result.metrics.map((metric) => [metric.id, metric]));

    expect(byId.get("cashflow.total_inflow")?.transactionIds).not.toContain(
      fixture.internalCreditId,
    );
    expect(byId.get("cashflow.total_outflow")?.transactionIds).not.toContain(
      fixture.internalDebitId,
    );
    expect(byId.get("income.by_source")?.transactionIds).not.toContain(fixture.refundId);
    expect(byId.get("income.by_source")?.transactionIds).not.toContain(fixture.externalTransferId);
    expect(byId.get("adjustments.refunds")?.transactionIds).toEqual([fixture.refundId]);
    expect(byId.get("adjustments.reversals")?.transactionIds).toEqual([fixture.reversalId]);
    expect(byId.get("transfers.internal")?.transactionIds).toEqual([fixture.internalDebitId]);
    expect(byId.get("transfers.external")?.transactionIds).toEqual([fixture.externalTransferId]);
  });

  it("keeps currencies separate and applies split scope filters", () => {
    const ngn = engine.query(WORKSPACE_ID, query(["cashflow.total_inflow"]));
    const usd = engine.query(WORKSPACE_ID, {
      ...query(["cashflow.total_inflow"]),
      currency: "USD",
      comparison: { mode: "none" },
    });
    const business = engine.query(WORKSPACE_ID, {
      ...query(["cashflow.total_outflow"]),
      scopes: ["business"],
      comparison: { mode: "none" },
    });

    expect(ngn.metrics[0]).toMatchObject({ value: 245_000 });
    expect(ngn.metrics[0]?.transactionIds).not.toContain(fixture.usdId);
    expect(usd.metrics[0]).toMatchObject({
      value: 999_999,
      transactionIds: [fixture.usdId],
    });
    expect(business.metrics[0]).toMatchObject({
      value: 8_000,
      transactionIds: [fixture.splitId],
    });
  });

  it("returns unavailable for PalmPay balances and avoids invalid comparison percentages", () => {
    const result = engine.query(
      WORKSPACE_ID,
      query(["balance.closing", "spending.fees", "cashflow.net"]),
    );
    const byId = new Map(result.metrics.map((metric) => [metric.id, metric]));

    expect(byId.get("balance.closing")).toMatchObject({
      status: "unavailable",
      value: null,
      transactionIds: [],
    });
    expect(byId.get("balance.closing")?.unavailableReason).toContain("running balances");
    expect(byId.get("spending.fees")?.comparison).toMatchObject({
      value: 0,
      percentageChange: null,
    });
    expect(byId.get("cashflow.net")?.comparison).toMatchObject({
      value: 60_000,
      absoluteChange: 19_000,
      percentageChange: 31.67,
    });
  });
});

describe("analytics cache invalidation", () => {
  it("returns identical cached and uncached metrics and only evicts affected ranges", () => {
    const juneQuery = query(["cashflow.net"]);
    const julyQuery = {
      ...query(["cashflow.net"]),
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      comparison: { mode: "none" as const },
    };
    const first = engine.query(WORKSPACE_ID, juneQuery);
    const cached = engine.query(WORKSPACE_ID, juneQuery);
    const uncached = engine.query(WORKSPACE_ID, { ...juneQuery, useCache: false });
    engine.query(WORKSPACE_ID, julyQuery);
    expect(engine.query(WORKSPACE_ID, julyQuery).cache.hit).toBe(true);

    expect(first.cache.hit).toBe(false);
    expect(cached.cache.hit).toBe(true);
    expect(cached.metrics).toEqual(first.metrics);
    expect(uncached.metrics).toEqual(first.metrics);

    sqlite
      .prepare("UPDATE transactions SET amount_minor = 31000 WHERE id = ?")
      .run(fixture.groceryId);
    invalidateMetrics(sqlite, {
      workspaceId: WORKSPACE_ID,
      reason: "transaction.updated",
      transactionId: fixture.groceryId,
      occurredAt: Date.UTC(2026, 5, 2, 12),
    });

    const recalculated = engine.query(WORKSPACE_ID, juneQuery);
    expect(recalculated.cache.hit).toBe(false);
    expect(recalculated.metrics[0]?.value).toBe(78_000);
    expect(engine.query(WORKSPACE_ID, julyQuery).cache.hit).toBe(true);
  });
});

describe("dashboard query performance", () => {
  it("calculates several years of personal transactions within an interactive budget", () => {
    const categoryId = starterCategoryId(WORKSPACE_ID, "groceries");
    sqlite.transaction(() => {
      for (let index = 0; index < 6_000; index += 1) {
        const timestamp = Date.UTC(2020, 0, 1) + index * 9 * 60 * 60 * 1_000;
        const date = new Date(timestamp).toISOString().slice(0, 10);
        insertTransaction({
          date,
          direction: index % 5 === 0 ? "credit" : "debit",
          amountMinor: 1_000 + (index % 200) * 100,
          transactionType: index % 5 === 0 ? "income" : "expense",
          categoryId,
          counterpartyId: index % 5 === 0 ? EMPLOYER : STORE,
        });
      }
    })();

    const startedAt = performance.now();
    const result = engine.query(WORKSPACE_ID, {
      startDate: "2020-01-01",
      endDate: "2026-12-31",
      currency: "NGN",
      accountIds: [ACCOUNT_ONE, ACCOUNT_TWO],
      scopes: ["personal", "business"],
      metricIds: [
        "cashflow.total_inflow",
        "cashflow.total_outflow",
        "cashflow.net",
        "cashflow.cumulative",
        "cashflow.transaction_count",
        "cashflow.largest_outflow",
        "balance.closing",
        "spending.by_category",
        "spending.unusual",
        "spending.recurring",
        "quality.classification_coverage",
        "quality.review_queue",
        "quality.duplicate_sources",
      ],
      comparison: { mode: "none" },
      excludeInternalTransfers: true,
      useCache: false,
    });
    const durationMs = performance.now() - startedAt;

    expect(result.metrics).toHaveLength(13);
    expect(result.metrics.find(({ id }) => id === "cashflow.transaction_count")?.value).toBe(6_018);
    expect(durationMs).toBeLessThan(3_000);
  });
});

function query(metricIds?: AnalyticsMetricId[]): AnalyticsQuery {
  return {
    startDate: "2026-06-01",
    endDate: "2026-06-30",
    currency: "NGN",
    accountIds: [ACCOUNT_ONE, ACCOUNT_TWO],
    scopes: ["personal", "business"],
    ...(metricIds ? { metricIds } : {}),
    comparison: { mode: "previous_period" },
    excludeInternalTransfers: true,
    useCache: true,
  };
}

function insertAccount(id: string, displayName: string): void {
  sqlite
    .prepare(
      `INSERT INTO accounts (
        id, workspace_id, institution_name, display_name, account_type,
        base_currency, is_owned, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'wallet', 'NGN', 1, 1, 1)`,
    )
    .run(id, WORKSPACE_ID, displayName, displayName);
}

function insertCounterparty(id: string, displayName: string): void {
  sqlite
    .prepare(
      `INSERT INTO counterparties (
        id, workspace_id, display_name, normalized_name, kind, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'business', 1, 1)`,
    )
    .run(id, WORKSPACE_ID, displayName, displayName.toLowerCase());
}

function insertTransaction(input: {
  date: string;
  direction: "debit" | "credit";
  amountMinor: number;
  transactionType?: string;
  accountId?: string;
  currency?: string;
  categoryId?: string | null;
  counterpartyId?: string | null;
  narration?: string;
  confidence?: string;
  reviewState?: string;
  scope?: "personal" | "business";
}): string {
  const id = randomUUID();
  const occurredAt = Date.parse(`${input.date}T12:00:00.000Z`);
  sqlite
    .prepare(
      `INSERT INTO transactions (
        id, workspace_id, account_id, occurred_at_utc, source_timestamp,
        source_timezone, direction, transaction_type, amount_minor, currency,
        normalized_narration, counterparty_id, category_id, scope,
        classification_source, confidence_level, review_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'Africa/Lagos', ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, 1, 1)`,
    )
    .run(
      id,
      WORKSPACE_ID,
      input.accountId ?? ACCOUNT_ONE,
      occurredAt,
      `${input.date} 13:00:00`,
      input.direction,
      input.transactionType ?? "unclassified",
      input.amountMinor,
      input.currency ?? "NGN",
      input.narration ?? "Fixture transaction",
      input.counterpartyId ?? null,
      input.categoryId ?? null,
      input.scope ?? "personal",
      input.transactionType && input.transactionType !== "unclassified" ? "manual" : "unclassified",
      input.confidence ?? (input.transactionType === "unclassified" ? "low" : "high"),
      input.reviewState ?? (input.transactionType === "unclassified" ? "needs_review" : "reviewed"),
    );
  return id;
}

function seedMetricFixture() {
  const salary = starterCategoryId(WORKSPACE_ID, "salary-and-wages");
  const groceries = starterCategoryId(WORKSPACE_ID, "groceries");
  const entertainment = starterCategoryId(WORKSPACE_ID, "entertainment");
  const shopping = starterCategoryId(WORKSPACE_ID, "shopping");
  const subscriptions = starterCategoryId(WORKSPACE_ID, "subscriptions");
  const fees = starterCategoryId(WORKSPACE_ID, "bank-fees-and-charges");
  const cash = starterCategoryId(WORKSPACE_ID, "cash-withdrawal");
  const refund = starterCategoryId(WORKSPACE_ID, "refunds-and-reversals");
  const transfer = starterCategoryId(WORKSPACE_ID, "owned-account-transfers");

  insertTransaction({
    date: "2026-05-02",
    direction: "credit",
    amountMinor: 100_000,
    transactionType: "income",
    categoryId: salary,
    counterpartyId: EMPLOYER,
  });
  insertTransaction({
    date: "2026-05-05",
    direction: "debit",
    amountMinor: 40_000,
    transactionType: "expense",
    categoryId: groceries,
    counterpartyId: STORE,
  });

  const salaryId = insertTransaction({
    date: "2026-06-01",
    direction: "credit",
    amountMinor: 200_000,
    transactionType: "income",
    categoryId: salary,
    counterpartyId: EMPLOYER,
    narration: "Monthly salary",
  });
  const groceryId = insertTransaction({
    date: "2026-06-02",
    direction: "debit",
    amountMinor: 30_000,
    transactionType: "expense",
    categoryId: groceries,
    counterpartyId: STORE,
    narration: "Groceries",
  });
  const splitId = insertTransaction({
    date: "2026-06-03",
    direction: "debit",
    amountMinor: 20_000,
    transactionType: "expense",
    categoryId: entertainment,
    counterpartyId: LEISURE,
    narration: "Mixed purchase",
  });
  createSplit(splitId, [
    { amountMinor: 12_000, categoryId: groceries, scope: "personal" },
    { amountMinor: 8_000, categoryId: entertainment, scope: "business" },
  ]);
  const feeId = insertTransaction({
    date: "2026-06-04",
    direction: "debit",
    amountMinor: 1_000,
    transactionType: "fee",
    categoryId: fees,
    narration: "Bank fee",
  });
  const withdrawalId = insertTransaction({
    date: "2026-06-05",
    direction: "debit",
    amountMinor: 5_000,
    transactionType: "cash_withdrawal",
    categoryId: cash,
    narration: "ATM withdrawal",
  });
  const unclassifiedId = insertTransaction({
    date: "2026-06-06",
    direction: "debit",
    amountMinor: 4_000,
    transactionType: "unclassified",
    narration: "Unknown transfer",
  });
  const unusualId = insertTransaction({
    date: "2026-06-07",
    direction: "debit",
    amountMinor: 100_000,
    transactionType: "expense",
    categoryId: shopping,
    counterpartyId: SHOP,
    narration: "New device",
  });

  const subscriptionIds = ["2026-06-01", "2026-06-08", "2026-06-15"].map((date) =>
    insertTransaction({
      date,
      direction: "debit",
      amountMinor: 2_000,
      transactionType: "expense",
      categoryId: subscriptions,
      counterpartyId: STREAMING,
      narration: "Weekly streaming",
    }),
  );
  const recurringIncomeIds = ["2026-06-01", "2026-06-08", "2026-06-15"].map((date) =>
    insertTransaction({
      date,
      direction: "credit",
      amountMinor: 10_000,
      transactionType: "income",
      categoryId: salary,
      counterpartyId: CLIENT,
      narration: "Weekly client",
    }),
  );

  const internalDebitId = insertTransaction({
    date: "2026-06-09",
    direction: "debit",
    amountMinor: 50_000,
    transactionType: "transfer",
    categoryId: transfer,
    accountId: ACCOUNT_ONE,
    narration: "Move to savings",
  });
  const internalCreditId = insertTransaction({
    date: "2026-06-09",
    direction: "credit",
    amountMinor: 50_000,
    transactionType: "transfer",
    categoryId: transfer,
    accountId: ACCOUNT_TWO,
    narration: "Move from PalmPay",
  });
  sqlite
    .prepare(
      `UPDATE transactions
          SET paired_transaction_id = ?, transfer_pairing_status = 'confirmed'
        WHERE id = ?`,
    )
    .run(internalCreditId, internalDebitId);
  sqlite
    .prepare(
      `UPDATE transactions
          SET paired_transaction_id = ?, transfer_pairing_status = 'confirmed'
        WHERE id = ?`,
    )
    .run(internalDebitId, internalCreditId);

  const externalTransferId = insertTransaction({
    date: "2026-06-10",
    direction: "credit",
    amountMinor: 10_000,
    transactionType: "transfer",
    categoryId: transfer,
    narration: "External transfer",
  });
  const refundId = insertTransaction({
    date: "2026-06-11",
    direction: "credit",
    amountMinor: 3_000,
    transactionType: "refund",
    categoryId: refund,
    narration: "Merchant refund",
  });
  const reversalId = insertTransaction({
    date: "2026-06-12",
    direction: "credit",
    amountMinor: 2_000,
    transactionType: "refund",
    categoryId: refund,
    narration: "Transfer reversal",
  });
  const usdId = insertTransaction({
    date: "2026-06-20",
    direction: "credit",
    amountMinor: 999_999,
    transactionType: "income",
    categoryId: salary,
    counterpartyId: EMPLOYER,
    currency: "USD",
    narration: "USD income",
  });

  linkMatchedDuplicateSources(groceryId);

  const ngnIds = new Set([
    salaryId,
    groceryId,
    splitId,
    feeId,
    withdrawalId,
    unclassifiedId,
    unusualId,
    ...subscriptionIds,
    ...recurringIncomeIds,
    internalDebitId,
    internalCreditId,
    externalTransferId,
    refundId,
    reversalId,
  ]);
  return {
    ngnIds,
    groceryId,
    splitId,
    unclassifiedId,
    internalDebitId,
    internalCreditId,
    externalTransferId,
    refundId,
    reversalId,
    usdId,
  };
}

function createSplit(
  transactionId: string,
  parts: Array<{ amountMinor: number; categoryId: string; scope: "personal" | "business" }>,
): void {
  const splitSetId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO transaction_split_sets (
        id, transaction_id, status, created_by_user_id, created_at
      ) VALUES (?, ?, 'draft', ?, 1)`,
    )
    .run(splitSetId, transactionId, USER_ID);
  const insert = sqlite.prepare(
    `INSERT INTO transaction_splits (
      id, split_set_id, category_id, amount_minor, currency, scope, sort_order, created_at
    ) VALUES (?, ?, ?, ?, 'NGN', ?, ?, 1)`,
  );
  parts.forEach((part, index) => {
    insert.run(randomUUID(), splitSetId, part.categoryId, part.amountMinor, part.scope, index);
  });
  sqlite
    .prepare(
      `UPDATE transaction_split_sets
          SET status = 'active', activated_at = 1
        WHERE id = ?`,
    )
    .run(splitSetId);
}

function linkMatchedDuplicateSources(transactionId: string): void {
  sqlite
    .prepare(
      `INSERT INTO import_batches (
        id, workspace_id, account_id, source_type, adapter_key, adapter_version,
        source_filename, file_fingerprint, status, source_timezone,
        reconciliation_status, committed_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pdf', 'palmpay', '1', 'june.pdf', ?, 'committed',
                'Africa/Lagos', 'matched', 1, 1, 1)`,
    )
    .run(IMPORT_ID, WORKSPACE_ID, ACCOUNT_ONE, "a".repeat(64));
  const insertRow = sqlite.prepare(
    `INSERT INTO parsed_source_rows (
      id, import_batch_id, source_row_index, source_timestamp, source_timezone,
      occurred_at_utc, direction, amount_minor, currency, row_fingerprint,
      raw_fields, created_at
    ) VALUES (?, ?, ?, '2026-06-02 13:00:00', 'Africa/Lagos', ?, 'debit',
              30000, 'NGN', ?, '{}', 1)`,
  );
  const original = randomUUID();
  const duplicate = randomUUID();
  insertRow.run(original, IMPORT_ID, 0, Date.UTC(2026, 5, 2, 12), "b".repeat(64));
  insertRow.run(duplicate, IMPORT_ID, 1, Date.UTC(2026, 5, 2, 12), "c".repeat(64));
  const link = sqlite.prepare(
    `INSERT INTO transaction_sources (
      transaction_id, parsed_source_row_id, import_batch_id,
      link_type, match_confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, 1)`,
  );
  link.run(transactionId, original, IMPORT_ID, "original", "strong");
  link.run(transactionId, duplicate, IMPORT_ID, "duplicate", "strong");
}

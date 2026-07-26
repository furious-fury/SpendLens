import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  seedStarterTaxonomy,
  starterCategoryId,
  TransactionWorkspace,
  TransactionWorkspaceError,
  WorkspaceManagement,
  type WorkspaceMutation,
} from "../src/index.js";

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const ACCOUNT_ONE = randomUUID();
const ACCOUNT_TWO = randomUUID();
const IMPORT_ID = randomUUID();

let sqlite: Database.Database;
let transactions: TransactionWorkspace;
let management: WorkspaceManagement;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      `INSERT INTO workspaces (
        id, name, timezone, setup_completed_at, created_at, updated_at
      ) VALUES (?, 'My finances', 'Africa/Lagos', 1, 1, 1)`,
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
  sqlite
    .prepare(
      `INSERT INTO import_batches (
        id, workspace_id, account_id, source_type, adapter_key, adapter_version,
        source_filename, file_fingerprint, status, source_timezone, created_at, updated_at
      ) VALUES (?, ?, ?, 'pdf', 'palmpay', '1', 'statement.pdf', ?, 'committed',
                'Africa/Lagos', 1, 1)`,
    )
    .run(IMPORT_ID, WORKSPACE_ID, ACCOUNT_ONE, "a".repeat(64));
  transactions = new TransactionWorkspace(sqlite, () => 2_000_000_000_000);
  management = new WorkspaceManagement(sqlite, () => 2_000_000_000_000);
});

afterEach(() => sqlite.close());

describe("transaction browsing", () => {
  it("uses stable keyset cursors and applies combined server filters", () => {
    const categoryId = starterCategoryId(WORKSPACE_ID, "food-and-dining");
    for (let index = 0; index < 125; index += 1) {
      insertTransaction({
        occurredAt: Date.UTC(2026, 5, 1) + index * 60_000,
        amountMinor: (index + 1) * 100,
        accountId: index % 2 === 0 ? ACCOUNT_ONE : ACCOUNT_TWO,
        direction: index % 3 === 0 ? "credit" : "debit",
        scope: index % 4 === 0 ? "business" : "personal",
        categoryId: index % 5 === 0 ? categoryId : null,
        confidence: index % 5 === 0 ? "high" : "unknown",
        reviewState: index % 5 === 0 ? "reviewed" : "unreviewed",
        narration: `Fixture transaction ${index}`,
      });
    }

    const first = transactions.listTransactions(WORKSPACE_ID, {
      limit: 20,
      sort: "occurredAt",
      direction: "desc",
    });
    const second = transactions.listTransactions(WORKSPACE_ID, {
      limit: 20,
      sort: "occurredAt",
      direction: "desc",
      cursor: first.nextCursor as string,
    });

    expect(first.hasMore).toBe(true);
    expect(first.items).toHaveLength(20);
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(40);
    expect(first.items.at(-1)?.occurredAt.getTime()).toBeGreaterThan(
      second.items[0]?.occurredAt.getTime() ?? 0,
    );

    const filtered = transactions.listTransactions(WORKSPACE_ID, {
      limit: 100,
      sort: "amount",
      direction: "asc",
      accountId: ACCOUNT_ONE,
      transactionDirection: "debit",
      scope: "personal",
      categoryId,
      confidence: "high",
      reviewState: "reviewed",
      currency: "NGN",
      minimumAmountMinor: 1_000,
      maximumAmountMinor: 12_500,
      startDate: "2026-06-01",
      endDate: "2026-06-01",
    });
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(
      filtered.items.every(
        (item) =>
          item.account.id === ACCOUNT_ONE &&
          item.direction === "debit" &&
          item.scope === "personal" &&
          item.category?.id === categoryId &&
          item.confidence === "high" &&
          item.reviewState === "reviewed" &&
          item.amountMinor >= 1_000 &&
          item.amountMinor <= 12_500,
      ),
    ).toBe(true);
  });

  it("searches preserved raw narration without returning unstable duplicates", () => {
    const transactionId = insertTransaction({ narration: "Normalized label" });
    linkRawSource(transactionId, "Private raw transfer marker");

    const result = transactions.listTransactions(WORKSPACE_ID, {
      limit: 25,
      sort: "occurredAt",
      direction: "desc",
      search: "raw transfer",
    });

    expect(result.items.map(({ id }) => id)).toEqual([transactionId]);
    expect(result.items[0]?.source.rawNarration).toBe("Private raw transfer marker");
  });

  it("rejects cursors created for a different sort", () => {
    insertTransaction({});
    insertTransaction({ occurredAt: Date.UTC(2026, 5, 16) });
    const page = transactions.listTransactions(WORKSPACE_ID, {
      limit: 1,
      sort: "occurredAt",
      direction: "desc",
    });
    expect(() =>
      transactions.listTransactions(WORKSPACE_ID, {
        limit: 1,
        sort: "amount",
        direction: "desc",
        cursor: page.nextCursor ?? "invalid",
      }),
    ).toThrow(TransactionWorkspaceError);
  });
});

describe("transaction correction and organization", () => {
  it("edits normalized values while preserving raw rows and recording revisions", () => {
    const transactionId = insertTransaction({ narration: "Original normalized narration" });
    linkRawSource(transactionId, "Do not overwrite this raw narration");
    const categoryId = starterCategoryId(WORKSPACE_ID, "transport");
    const counterparty = management.createCounterparty({
      workspaceId: WORKSPACE_ID,
      displayName: "Lagos Transit",
      kind: "business",
    });
    const mutations: WorkspaceMutation[] = [];

    const updated = transactions.updateTransaction(
      {
        workspaceId: WORKSPACE_ID,
        transactionId,
        actorUserId: USER_ID,
        changes: {
          normalizedNarration: "Bus fare",
          scope: "business",
          categoryId,
          counterpartyId: counterparty.id,
          reviewState: "reviewed",
          note: "Client meeting",
        },
      },
      (mutation) => mutations.push(mutation),
    );

    expect(updated).toMatchObject({
      normalizedNarration: "Bus fare",
      scope: "business",
      category: { id: categoryId },
      counterparty: { id: counterparty.id },
      reviewState: "reviewed",
      note: "Client meeting",
      confidence: "confirmed",
      classificationSource: "manual",
    });
    expect(
      sqlite.prepare("SELECT raw_narration AS narration FROM parsed_source_rows").get(),
    ).toEqual({ narration: "Do not overwrite this raw narration" });
    expect(sqlite.prepare("SELECT count(*) AS count FROM transaction_revisions").get()).toEqual({
      count: 1,
    });
    expect(sqlite.prepare("SELECT count(*) AS count FROM metric_invalidations").get()).toEqual({
      count: 1,
    });
    expect(mutations.map(({ action }) => action)).toEqual(["transaction.updated"]);
  });

  it("requires exactly balanced splits and stores category and scope per part", () => {
    const transactionId = insertTransaction({ amountMinor: 10_000 });
    const food = starterCategoryId(WORKSPACE_ID, "food-and-dining");
    const transport = starterCategoryId(WORKSPACE_ID, "transport");

    expect(() =>
      transactions.replaceSplits({
        workspaceId: WORKSPACE_ID,
        transactionId,
        actorUserId: USER_ID,
        splits: [
          { amountMinor: 6_000, categoryId: food, scope: "personal" },
          { amountMinor: 3_999, categoryId: transport, scope: "business" },
        ],
      }),
    ).toThrow("Split amounts must equal");

    const updated = transactions.replaceSplits({
      workspaceId: WORKSPACE_ID,
      transactionId,
      actorUserId: USER_ID,
      splits: [
        { amountMinor: 6_000, categoryId: food, scope: "personal" },
        {
          amountMinor: 4_000,
          categoryId: transport,
          scope: "business",
          note: "Client travel",
        },
      ],
    });
    expect(updated.splits).toMatchObject([
      { amountMinor: 6_000, scope: "personal", category: { id: food } },
      {
        amountMinor: 4_000,
        scope: "business",
        category: { id: transport },
        note: "Client travel",
      },
    ]);
  });

  it("applies bulk edits atomically and refuses a missing selection", () => {
    const firstId = insertTransaction({});
    const secondId = insertTransaction({});
    const categoryId = starterCategoryId(WORKSPACE_ID, "bank-fees-and-charges");

    expect(() =>
      transactions.bulkUpdate({
        workspaceId: WORKSPACE_ID,
        actorUserId: USER_ID,
        edit: {
          transactionIds: [firstId, randomUUID()],
          changes: { categoryId },
        },
      }),
    ).toThrow("not found");
    expect(transactions.getTransaction(WORKSPACE_ID, firstId).category).toBeNull();

    const result = transactions.bulkUpdate({
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      edit: {
        transactionIds: [firstId, secondId],
        changes: { categoryId, scope: "business", reviewState: "reviewed" },
      },
    });
    expect(result.updatedCount).toBe(2);
    expect(
      [firstId, secondId].map((id) => transactions.getTransaction(WORKSPACE_ID, id).scope),
    ).toEqual(["business", "business"]);
  });
});

describe("account, category, and transfer management", () => {
  it("stores only a fingerprint and last four digits for owned accounts", () => {
    const accountNumber = "8123456789";
    const updated = management.registerOwnedAccount({
      workspaceId: WORKSPACE_ID,
      accountId: ACCOUNT_ONE,
      institutionCode: "palmpay",
      accountNumber,
    });
    const stored = sqlite
      .prepare(
        `SELECT account_number_fingerprint AS fingerprint,
                masked_account_number AS masked
         FROM owned_account_identifiers`,
      )
      .get() as { fingerprint: string; masked: string };

    expect(updated.isOwned).toBe(true);
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.fingerprint).not.toContain(accountNumber);
    expect(stored.masked).toBe("•••• 6789");
    expect(() =>
      management.registerOwnedAccount({
        workspaceId: WORKSPACE_ID,
        accountId: ACCOUNT_TWO,
        institutionCode: "palmpay",
        accountNumber,
      }),
    ).toThrow("already registered");
  });

  it("creates, nests, promotes, merges, and archives categories with active splits", () => {
    const target = management.createCategory({
      workspaceId: WORKSPACE_ID,
      name: "Client costs",
      flags: { isExpense: true },
    });
    const source = management.createCategory({
      workspaceId: WORKSPACE_ID,
      name: "Old client costs",
      parentId: target.id,
      flags: { isExpense: true },
    });
    const child = management.createCategory({
      workspaceId: WORKSPACE_ID,
      name: "Field work",
      parentId: source.id,
    });
    const promoted = management.updateCategory({
      workspaceId: WORKSPACE_ID,
      categoryId: source.id,
      changes: { parentId: null, name: "Legacy client costs" },
    });
    expect(promoted.parentId).toBeNull();

    const transactionId = insertTransaction({ categoryId: source.id, amountMinor: 10_000 });
    transactions.replaceSplits({
      workspaceId: WORKSPACE_ID,
      transactionId,
      actorUserId: USER_ID,
      splits: [
        { amountMinor: 6_000, categoryId: source.id, scope: "business" },
        { amountMinor: 4_000, categoryId: child.id, scope: "personal" },
      ],
    });

    const merged = management.mergeCategory({
      workspaceId: WORKSPACE_ID,
      sourceCategoryId: source.id,
      targetCategoryId: target.id,
      actorUserId: USER_ID,
    });
    expect(merged.id).toBe(target.id);
    expect(transactions.getTransaction(WORKSPACE_ID, transactionId)).toMatchObject({
      category: { id: target.id },
      splits: [
        { category: { id: target.id }, scope: "business" },
        { category: { id: child.id }, scope: "personal" },
      ],
    });
    expect(
      management.listCategories(WORKSPACE_ID).find(({ id }) => id === source.id)?.archivedAt,
    ).not.toBeNull();
    expect(
      management.listCategories(WORKSPACE_ID).find(({ id }) => id === child.id)?.parentId,
    ).toBe(target.id);
  });

  it("confirms both sides of a valid owned-account transfer atomically", () => {
    const debitId = insertTransaction({
      accountId: ACCOUNT_ONE,
      direction: "debit",
      amountMinor: 25_000,
    });
    const creditId = insertTransaction({
      accountId: ACCOUNT_TWO,
      direction: "credit",
      amountMinor: 25_000,
    });

    const confirmed = transactions.confirmTransfer({
      workspaceId: WORKSPACE_ID,
      transactionId: debitId,
      pairedTransactionId: creditId,
      actorUserId: USER_ID,
    });

    expect(confirmed).toMatchObject({
      transactionType: "transfer",
      transfer: { status: "confirmed", pairedTransactionId: creditId },
    });
    expect(transactions.getTransaction(WORKSPACE_ID, creditId)).toMatchObject({
      transactionType: "transfer",
      transfer: { status: "confirmed", pairedTransactionId: debitId },
    });
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS count FROM metric_invalidations WHERE reason = 'transaction.transfer_confirmed'",
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  it("rejects transfer pairs with mismatched amounts without changing either side", () => {
    const debitId = insertTransaction({
      accountId: ACCOUNT_ONE,
      direction: "debit",
      amountMinor: 25_000,
    });
    const creditId = insertTransaction({
      accountId: ACCOUNT_TWO,
      direction: "credit",
      amountMinor: 24_999,
    });
    expect(() =>
      transactions.confirmTransfer({
        workspaceId: WORKSPACE_ID,
        transactionId: debitId,
        pairedTransactionId: creditId,
        actorUserId: USER_ID,
      }),
    ).toThrow("equal amounts");
    expect(transactions.getTransaction(WORKSPACE_ID, debitId).transfer.status).toBe("none");
    expect(transactions.getTransaction(WORKSPACE_ID, creditId).transfer.status).toBe("none");
  });
});

function insertAccount(id: string, displayName: string) {
  sqlite
    .prepare(
      `INSERT INTO accounts (
        id, workspace_id, institution_name, institution_code, display_name,
        account_type, base_currency, is_owned, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'wallet', 'NGN', 1, 1, 1)`,
    )
    .run(id, WORKSPACE_ID, displayName, displayName.toLocaleLowerCase(), displayName);
}

function insertTransaction(input: {
  occurredAt?: number;
  amountMinor?: number;
  accountId?: string;
  direction?: "debit" | "credit";
  scope?: "personal" | "business";
  categoryId?: string | null;
  confidence?: "unknown" | "high";
  reviewState?: "unreviewed" | "reviewed";
  narration?: string;
}) {
  const id = randomUUID();
  const occurredAt = input.occurredAt ?? Date.UTC(2026, 5, 15, 12);
  sqlite
    .prepare(
      `INSERT INTO transactions (
        id, workspace_id, account_id, occurred_at_utc, source_timestamp,
        source_timezone, direction, transaction_type, amount_minor, currency,
        normalized_narration, category_id, scope, confidence_level, review_state,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, '2026-06-15 13:00:00', 'Africa/Lagos', ?,
                'unclassified', ?, 'NGN', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      WORKSPACE_ID,
      input.accountId ?? ACCOUNT_ONE,
      occurredAt,
      input.direction ?? "debit",
      input.amountMinor ?? 10_000,
      input.narration ?? "Fixture transaction",
      input.categoryId ?? null,
      input.scope ?? "personal",
      input.confidence ?? "unknown",
      input.reviewState ?? "unreviewed",
      occurredAt,
      occurredAt,
    );
  return id;
}

function linkRawSource(transactionId: string, rawNarration: string) {
  const sourceRowId = randomUUID();
  const sourceRowIndex = (
    sqlite.prepare("SELECT count(*) AS count FROM parsed_source_rows").get() as {
      count: number;
    }
  ).count;
  sqlite
    .prepare(
      `INSERT INTO parsed_source_rows (
        id, import_batch_id, source_row_index, source_timestamp, source_timezone,
        occurred_at_utc, direction, amount_minor, currency, raw_narration,
        row_fingerprint, raw_fields, created_at
      ) VALUES (?, ?, ?, '2026-06-15 13:00:00', 'Africa/Lagos', ?, 'debit',
                10000, 'NGN', ?, ?, '{}', 1)`,
    )
    .run(
      sourceRowId,
      IMPORT_ID,
      sourceRowIndex,
      Date.UTC(2026, 5, 15, 12),
      rawNarration,
      randomUUID().replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    );
  sqlite
    .prepare(
      `INSERT INTO transaction_sources (
        transaction_id, parsed_source_row_id, import_batch_id,
        link_type, match_confidence, created_at
      ) VALUES (?, ?, ?, 'original', 'strong', 1)`,
    )
    .run(transactionId, sourceRowId, IMPORT_ID);
}

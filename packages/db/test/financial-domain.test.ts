import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  allocateByWeights,
  applyMigrations,
  createEncryptedDatabase,
  formatMoney,
  localDateRangeToUtc,
  MemoryKeyProvider,
  normalizeSourceTimestamp,
  parseMoneyToMinorUnits,
  seedStarterTaxonomy,
  starterCategoryId,
  starterTaxonomy,
  sumMoney,
  validateSplitTotal,
} from "../src/index.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("financial domain migration", () => {
  it("rolls a Section 2 database forward and seeds every existing workspace", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys=ON");
    applyMigrations(sqlite, "0000_security_foundation");
    sqlite
      .prepare(
        `INSERT INTO workspaces
          (id, name, timezone, created_at, updated_at)
         VALUES ('workspace', 'My finances', 'Africa/Lagos', 1, 1)`,
      )
      .run();

    applyMigrations(sqlite);

    expect(sqlite.prepare("SELECT count(*) AS count FROM categories").get()).toEqual({
      count: starterTaxonomy.length,
    });
    expect(
      sqlite
        .prepare(
          `SELECT parent_id AS parentId
           FROM categories WHERE system_key = 'groceries'`,
        )
        .get(),
    ).toEqual({ parentId: starterCategoryId("workspace", "food-and-dining") });
    expect(sqlite.prepare("SELECT id FROM _spendlens_migrations ORDER BY id").all()).toEqual([
      { id: "0000_security_foundation" },
      { id: "0001_financial_domain" },
      { id: "0002_api_jobs_audit" },
      { id: "0003_import_previews" },
      { id: "0004_import_reconciliation" },
      { id: "0005_transaction_workspace" },
      { id: "0006_classification_rules_review" },
    ]);
    sqlite.close();
  });

  it("creates an encrypted financial database with enforced source and transaction fields", async () => {
    const fixture = await financialFixture();
    expect(
      fixture.sqlite
        .prepare("SELECT scope, classification_source AS source FROM transactions WHERE id = ?")
        .get("transaction-1"),
    ).toEqual({ scope: "personal", source: "unclassified" });

    expect(() =>
      fixture.sqlite
        .prepare(
          `INSERT INTO parsed_source_rows (
            id, import_batch_id, source_row_index, source_timestamp, source_timezone,
            occurred_at_utc, direction, amount_minor, currency, row_fingerprint,
            raw_fields, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "bad-row",
          "import-1",
          1,
          "2026-06-02 10:00:00",
          "Africa/Lagos",
          1,
          "sideways",
          100,
          "ngn",
          "b".repeat(64),
          "not json",
          1,
        ),
    ).toThrow();

    fixture.close();
  });

  it("keeps a canonical transaction when one overlapping import is deleted", async () => {
    const fixture = await financialFixture();
    insertImport(fixture.sqlite, "import-2", "2".repeat(64));
    insertSourceRow(fixture.sqlite, "row-2", "import-2", 0, "b".repeat(64));
    fixture.sqlite
      .prepare(
        `INSERT INTO transaction_sources
          (transaction_id, parsed_source_row_id, import_batch_id, link_type,
           match_confidence, created_at)
         VALUES ('transaction-1', 'row-2', 'import-2', 'duplicate', 'strong', 1)`,
      )
      .run();

    fixture.sqlite.prepare("DELETE FROM import_batches WHERE id = 'import-1'").run();

    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM transactions").get()).toEqual({
      count: 1,
    });
    expect(
      fixture.sqlite.prepare("SELECT count(*) AS count FROM transaction_sources").get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.sqlite
        .prepare("SELECT import_batch_id AS importBatchId FROM transaction_sources")
        .get(),
    ).toEqual({ importBatchId: "import-2" });
    fixture.close();
  });

  it("only activates balanced same-currency splits and freezes them afterward", async () => {
    const fixture = await financialFixture();
    fixture.sqlite
      .prepare(
        `INSERT INTO transaction_split_sets
          (id, transaction_id, status, created_at)
         VALUES ('split-set', 'transaction-1', 'draft', 1)`,
      )
      .run();
    const insertSplit = fixture.sqlite.prepare(
      `INSERT INTO transaction_splits
        (id, split_set_id, category_id, amount_minor, currency, created_at)
       VALUES (?, 'split-set', ?, ?, ?, 1)`,
    );
    insertSplit.run("split-1", starterCategoryId("workspace", "food-and-dining"), 6_000, "NGN");
    insertSplit.run("split-2", starterCategoryId("workspace", "groceries"), 3_000, "NGN");

    expect(() =>
      fixture.sqlite
        .prepare("UPDATE transaction_split_sets SET status = 'active' WHERE id = 'split-set'")
        .run(),
    ).toThrow("split amounts must equal");

    fixture.sqlite
      .prepare("UPDATE transaction_splits SET amount_minor = 4000 WHERE id = 'split-2'")
      .run();
    fixture.sqlite
      .prepare(
        "UPDATE transaction_split_sets SET status = 'active', activated_at = 1 WHERE id = 'split-set'",
      )
      .run();

    expect(() =>
      fixture.sqlite
        .prepare("UPDATE transaction_splits SET amount_minor = 3999 WHERE id = 'split-2'")
        .run(),
    ).toThrow("immutable");
    expect(() =>
      fixture.sqlite
        .prepare("UPDATE transactions SET amount_minor = 9999 WHERE id = 'transaction-1'")
        .run(),
    ).toThrow("deactivate");
    fixture.close();
  });
});

describe("financial value helpers", () => {
  it("round-trips naira exactly in integer minor units", () => {
    expect(parseMoneyToMinorUnits("1,250.00", "NGN")).toBe(125_000);
    expect(formatMoney(125_000, "NGN")).toBe("₦1,250.00");
  });

  it("requires a currency filter before aggregating mixed currencies", () => {
    const amounts = [
      { amountMinor: 100_00, currency: "NGN" },
      { amountMinor: 25_00, currency: "USD" },
      { amountMinor: 50_00, currency: "NGN" },
    ];
    expect(() => sumMoney(amounts)).toThrow("Mixed currencies");
    expect(sumMoney(amounts, "NGN")).toBe(150_00);
  });

  it("allocates every minor unit deterministically and validates split totals", () => {
    const allocation = allocateByWeights(10_000, [1, 1, 1]);
    expect(allocation).toEqual([3_334, 3_333, 3_333]);
    expect(() =>
      validateSplitTotal(
        10_000,
        "NGN",
        allocation.map((amountMinor) => ({ amountMinor, currency: "NGN" })),
      ),
    ).not.toThrow();
  });

  it("normalizes source times and local reporting boundaries to UTC", () => {
    expect(normalizeSourceTimestamp("2026-06-01 00:00:00", "Africa/Lagos").toISOString()).toBe(
      "2026-05-31T23:00:00.000Z",
    );
    const range = localDateRangeToUtc("2026-06-01", "2026-06-30", "Africa/Lagos");
    expect(range.startUtc.toISOString()).toBe("2026-05-31T23:00:00.000Z");
    expect(range.endUtcExclusive.toISOString()).toBe("2026-06-30T23:00:00.000Z");
  });
});

async function financialFixture() {
  const directory = join("/tmp", `spendlens-domain-test-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryPaths.push(directory);
  const database = await createEncryptedDatabase({
    filePath: join(directory, "spendlens.db"),
    keyProvider: new MemoryKeyProvider(),
  });
  const sqlite = database.sqlite;
  sqlite
    .prepare(
      `INSERT INTO workspaces
        (id, name, timezone, created_at, updated_at)
       VALUES ('workspace', 'My finances', 'Africa/Lagos', 1, 1)`,
    )
    .run();
  seedStarterTaxonomy(sqlite, "workspace");
  sqlite
    .prepare(
      `INSERT INTO accounts (
        id, workspace_id, institution_name, institution_code, display_name,
        account_type, base_currency, created_at, updated_at
      ) VALUES (
        'account', 'workspace', 'PalmPay', 'palmpay', 'PalmPay wallet',
        'wallet', 'NGN', 1, 1
      )`,
    )
    .run();
  insertImport(sqlite, "import-1", "1".repeat(64));
  insertSourceRow(sqlite, "row-1", "import-1", 0, "a".repeat(64));
  sqlite
    .prepare(
      `INSERT INTO transactions (
        id, workspace_id, account_id, occurred_at_utc, source_timestamp,
        source_timezone, direction, amount_minor, currency, created_at, updated_at
      ) VALUES (
        'transaction-1', 'workspace', 'account', 1, '2026-06-01 10:00:00',
        'Africa/Lagos', 'debit', 10000, 'NGN', 1, 1
      )`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO transaction_sources (
        transaction_id, parsed_source_row_id, import_batch_id, link_type,
        match_confidence, created_at
      ) VALUES (
        'transaction-1', 'row-1', 'import-1', 'original', 'strong', 1
      )`,
    )
    .run();
  return database;
}

function insertImport(sqlite: Database.Database, id: string, fingerprint: string): void {
  sqlite
    .prepare(
      `INSERT INTO import_batches (
        id, workspace_id, account_id, source_type, adapter_key, adapter_version,
        source_filename, file_fingerprint, source_timezone, created_at, updated_at
      ) VALUES (?, 'workspace', 'account', 'pdf', 'palmpay', '1',
        ?, ?, 'Africa/Lagos', 1, 1)`,
    )
    .run(id, `${id}.pdf`, fingerprint);
}

function insertSourceRow(
  sqlite: Database.Database,
  id: string,
  importBatchId: string,
  sourceRowIndex: number,
  fingerprint: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO parsed_source_rows (
        id, import_batch_id, source_row_index, source_timestamp, source_timezone,
        occurred_at_utc, direction, amount_minor, currency, row_fingerprint,
        raw_fields, created_at
      ) VALUES (?, ?, ?, '2026-06-01 10:00:00', 'Africa/Lagos',
        1, 'debit', 10000, 'NGN', ?, '{}', 1)`,
    )
    .run(id, importBatchId, sourceRowIndex, fingerprint);
}

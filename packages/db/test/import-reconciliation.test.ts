import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  applyMigrations,
  fallbackTransactionFingerprint,
  ImportReconciliationStore,
} from "../src/index.js";

describe("overlapping import reconciliation", () => {
  it("adds only new overlap rows and keeps different recipients and repeated payments distinct", () => {
    const fixture = reconciliationFixture();
    insertImport(fixture.sqlite, "import-1", [
      row("source-a", "palmpay-a", 1, 10_000, "Send to Recipient Alpha"),
      row("source-b", "palmpay-b", 1, 10_000, "Send to Recipient Beta"),
      row("source-c", "palmpay-c", 2, 5_000, "Buy lunch"),
      row("source-d", "palmpay-d", 2, 5_000, "Buy lunch"),
    ]);
    expect(
      fixture.reconciler.analyze({
        workspaceId: "workspace",
        importId: "import-1",
        accountId: "account",
      }),
    ).toMatchObject({
      counts: { new: 4, duplicate: 0, possibleDuplicate: 0, conflict: 0 },
      pendingDecisionCount: 0,
    });
    expect(
      fixture.reconciler.commit({
        workspaceId: "workspace",
        importId: "import-1",
        confirmUnreconciled: false,
      }).commitResult,
    ).toMatchObject({
      canonicalTransactionsCreated: 4,
      duplicateSourcesLinked: 0,
    });
    fixture.sqlite.prepare("UPDATE transactions SET fallback_fingerprint = NULL").run();

    insertImport(fixture.sqlite, "import-2", [
      row("source-a2", "palmpay-a", 1, 10_000, "Send to Recipient Alpha"),
      row("source-c2", "palmpay-c", 2, 5_000, "Buy lunch"),
      row("source-e", "palmpay-e", 3, 7_500, "Electricity"),
    ]);
    fixture.sqlite
      .prepare(
        "UPDATE parsed_source_rows SET fallback_fingerprint = NULL WHERE import_batch_id = 'import-2'",
      )
      .run();
    expect(
      fixture.reconciler.analyze({
        workspaceId: "workspace",
        importId: "import-2",
        accountId: "account",
      }),
    ).toMatchObject({
      counts: { new: 1, duplicate: 2, possibleDuplicate: 0, conflict: 0 },
    });
    const overlap = fixture.reconciler.commit({
      workspaceId: "workspace",
      importId: "import-2",
      confirmUnreconciled: false,
    });
    expect(overlap.commitResult).toMatchObject({
      canonicalTransactionsCreated: 1,
      duplicateSourcesLinked: 2,
    });
    expect(count(fixture.sqlite, "transactions")).toBe(5);
    expect(
      fixture.sqlite
        .prepare(
          `SELECT count(*) AS count FROM transactions
           WHERE occurred_at_utc = ? AND amount_minor = 10000`,
        )
        .get(timestamp(1)),
    ).toEqual({ count: 2 });
    expect(
      fixture.sqlite
        .prepare(
          `SELECT count(*) AS count FROM transactions
           WHERE occurred_at_utc = ? AND amount_minor = 5000
             AND normalized_narration = 'Buy lunch'`,
        )
        .get(timestamp(2)),
    ).toEqual({ count: 2 });
    fixture.sqlite.close();
  });

  it("matches fallback occurrences one-to-one and records confirmed, rejected, and skipped choices", () => {
    const fixture = reconciliationFixture();
    insertImport(fixture.sqlite, "base", [
      row("base-1", "id-1", 4, 3_000, "Identical payment"),
      row("base-2", "id-2", 4, 3_000, "Identical payment"),
    ]);
    analyzeAndCommit(fixture, "base");

    insertImport(fixture.sqlite, "fallback", [
      row("fallback-1", null, 4, 3_000, "Identical payment"),
      row("fallback-2", null, 4, 3_000, "Identical payment"),
      row("fallback-3", null, 4, 3_000, "Identical payment"),
    ]);
    const analyzed = fixture.reconciler.analyze({
      workspaceId: "workspace",
      importId: "fallback",
      accountId: "account",
    });
    expect(analyzed).toMatchObject({
      counts: { new: 1, duplicate: 0, possibleDuplicate: 2, conflict: 0 },
      pendingDecisionCount: 2,
    });
    expect(analyzed.attentionItems.map((item) => item.candidate.transactionId)).toHaveLength(2);
    expect(new Set(analyzed.attentionItems.map((item) => item.candidate.transactionId)).size).toBe(
      2,
    );

    const decided = fixture.reconciler.applyDecisions({
      workspaceId: "workspace",
      importId: "fallback",
      actorUserId: "user",
      decisions: [
        {
          decisionId: analyzed.attentionItems[0]?.decisionId ?? "",
          action: "confirm_duplicate",
        },
        {
          decisionId: analyzed.attentionItems[1]?.decisionId ?? "",
          action: "keep_separate",
        },
      ],
    });
    expect(decided.pendingDecisionCount).toBe(0);
    const committed = fixture.reconciler.commit({
      workspaceId: "workspace",
      importId: "fallback",
      confirmUnreconciled: false,
    });
    expect(committed.commitResult).toMatchObject({
      canonicalTransactionsCreated: 2,
      duplicateSourcesLinked: 1,
      skippedSources: 0,
    });
    expect(count(fixture.sqlite, "transactions")).toBe(4);

    insertImport(fixture.sqlite, "skip", [row("skip-1", null, 4, 3_000, "Identical payment")]);
    const skipAnalysis = fixture.reconciler.analyze({
      workspaceId: "workspace",
      importId: "skip",
      accountId: "account",
    });
    fixture.reconciler.applyDecisions({
      workspaceId: "workspace",
      importId: "skip",
      actorUserId: "user",
      decisions: [
        {
          decisionId: skipAnalysis.attentionItems[0]?.decisionId ?? "",
          action: "skip",
        },
      ],
    });
    const skipped = fixture.reconciler.commit({
      workspaceId: "workspace",
      importId: "skip",
      confirmUnreconciled: false,
    });
    expect(skipped.commitResult?.skippedSources).toBe(1);
    expect(
      fixture.sqlite
        .prepare(
          `SELECT decision FROM import_match_decisions
           WHERE import_batch_id = 'skip'`,
        )
        .get(),
    ).toEqual({ decision: "skipped" });
    expect(
      fixture.sqlite
        .prepare(
          `SELECT count(*) AS count
             FROM metric_invalidations
            WHERE reason = 'import.committed'`,
        )
        .get(),
    ).toEqual({ count: 2 });
    fixture.sqlite.close();
  });

  it("never silently merges a reused strong ID with conflicting values", () => {
    const fixture = reconciliationFixture();
    insertImport(fixture.sqlite, "original", [
      row("original-row", "reused-id", 5, 8_000, "Original value"),
    ]);
    analyzeAndCommit(fixture, "original");
    insertImport(fixture.sqlite, "conflict", [
      row("conflict-row", "reused-id", 5, 9_000, "Changed value"),
    ]);
    const analysis = fixture.reconciler.analyze({
      workspaceId: "workspace",
      importId: "conflict",
      accountId: "account",
    });
    expect(analysis).toMatchObject({
      counts: { conflict: 1 },
      pendingDecisionCount: 1,
    });
    expect(() =>
      fixture.reconciler.commit({
        workspaceId: "workspace",
        importId: "conflict",
        confirmUnreconciled: false,
      }),
    ).toThrow("Resolve every possible duplicate and conflict");

    fixture.reconciler.applyDecisions({
      workspaceId: "workspace",
      importId: "conflict",
      actorUserId: "user",
      decisions: [
        {
          decisionId: analysis.attentionItems[0]?.decisionId ?? "",
          action: "keep_separate",
        },
      ],
    });
    fixture.reconciler.commit({
      workspaceId: "workspace",
      importId: "conflict",
      confirmUnreconciled: false,
    });
    expect(
      fixture.sqlite
        .prepare(
          `SELECT count(*) AS count FROM transactions
           WHERE source_reference = 'reused-id'`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      fixture.sqlite
        .prepare(
          `SELECT classification, decision FROM import_match_decisions
           WHERE import_batch_id = 'conflict'`,
        )
        .get(),
    ).toEqual({ classification: "conflict", decision: "rejected" });
    fixture.sqlite.close();
  });

  it("rolls back a failed commit, retries idempotently, and preserves multiply sourced transactions", () => {
    const fixture = reconciliationFixture();
    insertImport(fixture.sqlite, "first", [
      row("first-row", "shared-id", 6, 12_000, "Shared transaction"),
      row("first-only", "first-only-id", 7, 2_000, "First only"),
    ]);
    fixture.reconciler.analyze({
      workspaceId: "workspace",
      importId: "first",
      accountId: "account",
    });
    expect(() =>
      fixture.reconciler.commit(
        {
          workspaceId: "workspace",
          importId: "first",
          confirmUnreconciled: false,
        },
        () => {
          throw new Error("simulated audit failure");
        },
      ),
    ).toThrow("simulated audit failure");
    expect(count(fixture.sqlite, "transactions")).toBe(0);
    expect(
      fixture.sqlite.prepare("SELECT status FROM import_batches WHERE id = 'first'").get(),
    ).toEqual({ status: "previewed" });

    const committed = fixture.reconciler.commit({
      workspaceId: "workspace",
      importId: "first",
      confirmUnreconciled: false,
    });
    const repeated = fixture.reconciler.commit({
      workspaceId: "workspace",
      importId: "first",
      confirmUnreconciled: false,
    });
    expect(repeated.commitResult).toEqual(committed.commitResult);
    expect(count(fixture.sqlite, "transactions")).toBe(2);

    insertImport(fixture.sqlite, "second", [
      row("second-row", "shared-id", 6, 12_000, "Shared transaction"),
    ]);
    analyzeAndCommit(fixture, "second");
    fixture.reconciler.deleteImport("workspace", "first");
    expect(count(fixture.sqlite, "transactions")).toBe(1);
    expect(
      fixture.sqlite
        .prepare(
          `SELECT count(*) AS count FROM transaction_sources
           WHERE import_batch_id = 'second'`,
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      fixture.sqlite.prepare("SELECT source_reference AS reference FROM transactions").get(),
    ).toEqual({ reference: "shared-id" });
    fixture.sqlite.close();
  });

  it("requires explicit confirmation before committing unreconciled statement totals", () => {
    const fixture = reconciliationFixture();
    insertImport(
      fixture.sqlite,
      "mismatch",
      [row("mismatch-row", "mismatch-id", 8, 1_000, "Mismatch")],
      "mismatched",
    );
    fixture.reconciler.analyze({
      workspaceId: "workspace",
      importId: "mismatch",
      accountId: "account",
    });
    expect(() =>
      fixture.reconciler.commit({
        workspaceId: "workspace",
        importId: "mismatch",
        confirmUnreconciled: false,
      }),
    ).toThrow("Confirm the statement total mismatch");
    expect(
      fixture.reconciler.commit({
        workspaceId: "workspace",
        importId: "mismatch",
        confirmUnreconciled: true,
      }).status,
    ).toBe("committed");
    fixture.sqlite.close();
  });
});

function reconciliationFixture() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      `INSERT INTO workspaces
        (id, name, timezone, created_at, updated_at)
       VALUES ('workspace', 'Reconciliation fixture', 'Africa/Lagos', 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO users (
        id, workspace_id, username, display_name, password_hash,
        password_changed_at, created_at, updated_at
      ) VALUES ('user', 'workspace', 'owner', 'Owner', 'hash', 1, 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO accounts (
        id, workspace_id, institution_name, institution_code, display_name,
        account_type, base_currency, masked_account_number, created_at, updated_at
      ) VALUES (
        'account', 'workspace', 'PalmPay', 'palmpay', 'PalmPay 4321',
        'wallet', 'NGN', '•••• 4321', 1, 1
      )`,
    )
    .run();
  return {
    sqlite,
    reconciler: new ImportReconciliationStore(sqlite),
  };
}

function insertImport(
  sqlite: Database.Database,
  id: string,
  rows: TestRow[],
  reconciliationStatus: "matched" | "mismatched" = "matched",
): void {
  sqlite
    .prepare(
      `INSERT INTO import_batches (
        id, workspace_id, source_type, adapter_key, adapter_version,
        source_filename, file_fingerprint, status, source_timezone,
        balance_currency, institution_name, masked_account_number,
        transaction_count, reconciliation_status, created_at, updated_at
      ) VALUES (
        ?, 'workspace', 'pdf', 'palmpay-ng-pdf', '1.0.0',
        ?, ?, 'previewed', 'Africa/Lagos', 'NGN', 'PalmPay', '•••• 4321',
        ?, ?, 1, 1
      )`,
    )
    .run(
      id,
      `${id}.pdf`,
      createHash("sha256").update(id).digest("hex"),
      rows.length,
      reconciliationStatus,
    );
  const insert = sqlite.prepare(
    `INSERT INTO parsed_source_rows (
      id, import_batch_id, source_row_index, source_transaction_id,
      source_reference, source_timestamp, source_timezone, occurred_at_utc,
      direction, amount_minor, currency, raw_narration, row_fingerprint,
      fallback_fingerprint, raw_fields, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Africa/Lagos', ?, 'debit', ?, 'NGN', ?, ?, ?, '{}', 1)`,
  );
  rows.forEach((item, index) => {
    const fallback = fallbackTransactionFingerprint({
      occurredAtUtc: item.occurredAt,
      currency: "NGN",
      direction: "debit",
      amountMinor: item.amountMinor,
      narration: item.narration,
    });
    insert.run(
      item.id,
      id,
      index,
      item.sourceTransactionId,
      item.sourceTransactionId,
      new Date(item.occurredAt).toISOString().slice(0, 19).replace("T", " "),
      item.occurredAt,
      item.amountMinor,
      item.narration,
      createHash("sha256").update(`${id}:${item.id}`).digest("hex"),
      fallback,
    );
  });
}

function analyzeAndCommit(
  fixture: ReturnType<typeof reconciliationFixture>,
  importId: string,
): void {
  fixture.reconciler.analyze({
    workspaceId: "workspace",
    importId,
    accountId: "account",
  });
  fixture.reconciler.commit({
    workspaceId: "workspace",
    importId,
    confirmUnreconciled: false,
  });
}

function row(
  id: string,
  sourceTransactionId: string | null,
  day: number,
  amountMinor: number,
  narration: string,
): TestRow {
  return {
    id,
    sourceTransactionId,
    occurredAt: timestamp(day),
    amountMinor,
    narration,
  };
}

function timestamp(day: number): number {
  return Date.UTC(2026, 5, day, 12, 0, 0);
}

function count(sqlite: Database.Database, table: "transactions"): number {
  return (sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

interface TestRow {
  id: string;
  sourceTransactionId: string | null;
  occurredAt: number;
  amountMinor: number;
  narration: string;
}

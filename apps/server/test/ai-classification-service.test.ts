import { randomUUID } from "node:crypto";
import type { AiClassificationOutput } from "@spendlens/contracts";
import {
  AiProviderStore,
  applyMigrations,
  ClassificationEngine,
  ClassificationReview,
  JobQueue,
  seedStarterTaxonomy,
  starterCategoryId,
  TransactionWorkspace,
} from "@spendlens/db";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AiClassificationService,
  AiClassificationServiceError,
} from "../src/ai/ai-classification-service.js";
import type { AiProviderAdapter } from "../src/ai/provider-adapters.js";
import { createProviderAdapters } from "../src/ai/provider-adapters.js";
import type { JobContext } from "../src/jobs/job-worker.js";

const WORKSPACE_ID = randomUUID();
const USER_ID = randomUUID();
const ACCOUNT_ID = randomUUID();

describe("AI classification orchestration", () => {
  it("stores validated suggestions in Review without changing transaction data", async () => {
    const fixture = await serviceFixture(validOutput());
    const before = transactionRow(fixture.sqlite, fixture.transactionId);
    const result = await fixture.service.runClassificationJob(
      {
        providerSettingId: fixture.settingId,
        transactionIds: [fixture.transactionId],
      },
      fixture.context,
    );

    expect(result).toMatchObject({
      provider: "ollama",
      model: "test-local-model",
      suggestionCount: 1,
      reviewRequired: true,
    });
    expect(transactionRow(fixture.sqlite, fixture.transactionId)).toEqual(before);
    expect(
      fixture.sqlite
        .prepare(
          "SELECT raw_fields AS rawFields FROM parsed_source_rows WHERE id = 'ai-source-row'",
        )
        .get(),
    ).toEqual({ rawFields: '{"privateParserField":"unchanged"}' });
    const review = new ClassificationReview(
      fixture.sqlite,
      new ClassificationEngine(fixture.sqlite),
    );
    const groups = review.listGroups(WORKSPACE_ID);
    expect(groups).toMatchObject({
      totalTransactions: 1,
      items: [
        {
          confidence: "high",
          suggestion: {
            categoryId: starterCategoryId(WORKSPACE_ID, "food-and-dining"),
            transactionType: "expense",
          },
          evidence: expect.arrayContaining([
            expect.objectContaining({ source: "ai", code: "ai.explanation" }),
            expect.objectContaining({ source: "ai", code: "narration.meal" }),
          ]),
        },
      ],
    });

    const group = groups.items[0];
    if (!group) throw new Error("Expected an AI review group.");
    const applied = review.applyDecision({
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      decision: {
        groupKey: group.key,
        decision: "accept",
        applyScope: "existing_matches",
        rememberForFuture: false,
      },
    });
    expect(transactionRow(fixture.sqlite, fixture.transactionId)).toMatchObject({
      category_id: starterCategoryId(WORKSPACE_ID, "food-and-dining"),
      classification_source: "manual",
      confidence_level: "confirmed",
      source_reference: "PRIVATE-SOURCE-REFERENCE",
    });
    const actionSnapshot = fixture.sqlite
      .prepare(
        "SELECT before_values AS beforeValues FROM classification_review_actions WHERE id = ?",
      )
      .get(applied.actionId) as { beforeValues: string };
    expect(JSON.parse(actionSnapshot.beforeValues)).toEqual([
      expect.objectContaining({ aiSuggestionId: expect.any(String) }),
    ]);
    review.undoDecision(WORKSPACE_ID, applied.actionId);
    expect(transactionRow(fixture.sqlite, fixture.transactionId)).toEqual(before);
    const restoredTimes = fixture.sqlite
      .prepare(
        `SELECT
            transaction_row.updated_at AS transactionUpdatedAt,
            suggestion.input_updated_at AS suggestionUpdatedAt,
            decision.evaluated_at AS decisionEvaluatedAt
           FROM transactions transaction_row
           JOIN ai_classification_suggestions suggestion
             ON suggestion.transaction_id = transaction_row.id
           JOIN classification_decisions decision
             ON decision.transaction_id = transaction_row.id
         WHERE transaction_row.id = ?`,
      )
      .get(fixture.transactionId) as {
      transactionUpdatedAt: number;
      suggestionUpdatedAt: number;
      decisionEvaluatedAt: number;
    };
    expect(restoredTimes.suggestionUpdatedAt).toBe(restoredTimes.transactionUpdatedAt);
    expect(restoredTimes.decisionEvaluatedAt).toBe(restoredTimes.transactionUpdatedAt);
    expect(review.listGroups(WORKSPACE_ID).items[0]?.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "ai" })]),
    );
    expect(
      fixture.sqlite
        .prepare(
          `SELECT prompt_version AS promptVersion, provider, model, payload_hash AS payloadHash,
                  status, result
           FROM ai_classification_runs`,
        )
        .get(),
    ).toMatchObject({
      promptVersion: "spendlens-classification-v1",
      provider: "ollama",
      model: "test-local-model",
      payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "succeeded",
      result: expect.any(String),
    });
    fixture.sqlite.close();
  });

  it("rejects unknown categories and leaves no pending suggestion", async () => {
    const fixture = await serviceFixture({
      ...validOutput(),
      category: "Invented category",
    });

    await expect(
      fixture.service.runClassificationJob(
        {
          providerSettingId: fixture.settingId,
          transactionIds: [fixture.transactionId],
        },
        fixture.context,
      ),
    ).rejects.toMatchObject({
      code: "AI_CLASSIFICATION_CATEGORY_UNKNOWN",
      retryable: false,
    });
    expect(
      fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM ai_classification_suggestions").get(),
    ).toEqual({ count: 0 });
    expect(transactionRow(fixture.sqlite, fixture.transactionId).category_id).toBeNull();
    fixture.sqlite.close();
  });

  it("cannot classify a confirmed manual transaction", async () => {
    const fixture = await serviceFixture(validOutput());
    fixture.sqlite
      .prepare(
        `UPDATE transactions SET
          classification_source = 'manual', confidence_level = 'confirmed',
          review_state = 'reviewed'
         WHERE id = ?`,
      )
      .run(fixture.transactionId);

    await expect(
      fixture.service.runClassificationJob(
        {
          providerSettingId: fixture.settingId,
          transactionIds: [fixture.transactionId],
        },
        fixture.context,
      ),
    ).rejects.toBeInstanceOf(AiClassificationServiceError);
    expect(
      fixture.sqlite.prepare("SELECT COUNT(*) AS count FROM ai_classification_runs").get(),
    ).toEqual({ count: 0 });
    fixture.sqlite.close();
  });
});

async function serviceFixture(output: AiClassificationOutput) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  applyMigrations(sqlite);
  sqlite
    .prepare(
      `INSERT INTO workspaces (
        id, name, timezone, setup_completed_at, created_at, updated_at
      ) VALUES (?, 'SpendLens', 'Africa/Lagos', 1, 1, 1)`,
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
  sqlite
    .prepare(
      `INSERT INTO accounts (
        id, workspace_id, institution_name, display_name, account_type,
        base_currency, is_owned, created_at, updated_at
      ) VALUES (?, ?, 'PalmPay', 'PalmPay', 'wallet', 'NGN', 1, 1, 1)`,
    )
    .run(ACCOUNT_ID, WORKSPACE_ID);
  const transactionId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO transactions (
        id, workspace_id, account_id, occurred_at_utc, source_timestamp,
        source_timezone, direction, transaction_type, amount_minor, currency,
        normalized_narration, source_reference, scope, classification_source,
        confidence_level, review_state, transfer_pairing_status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, 1781524800000, '2026-06-15 13:00:00', 'Africa/Lagos',
        'debit', 'unclassified', 250000, 'NGN', 'Lunch at cafe 1234567890',
        'PRIVATE-SOURCE-REFERENCE', 'personal', 'unclassified', 'unknown',
        'needs_review', 'none', 1, 1
      )`,
    )
    .run(transactionId, WORKSPACE_ID, ACCOUNT_ID);
  const importId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO import_batches (
        id, workspace_id, account_id, source_type, adapter_key, adapter_version,
        source_filename, file_fingerprint, status, source_timezone, created_at, updated_at
      ) VALUES (?, ?, ?, 'pdf', 'fixture', '1', 'fixture.pdf', ?,
                'committed', 'Africa/Lagos', 1, 1)`,
    )
    .run(importId, WORKSPACE_ID, ACCOUNT_ID, "a".repeat(64));
  sqlite
    .prepare(
      `INSERT INTO parsed_source_rows (
        id, import_batch_id, source_row_index, source_transaction_id,
        source_reference, source_timestamp, source_timezone, occurred_at_utc,
        direction, amount_minor, currency, balance_after_minor, raw_narration,
        sender_or_recipient_name, institution_name, masked_account_number,
        row_fingerprint, raw_fields, created_at
      ) VALUES (
        'ai-source-row', ?, 0, 'PRIVATE-SOURCE-ID', 'PRIVATE-SOURCE-REFERENCE',
        '2026-06-15 13:00:00', 'Africa/Lagos', 1781524800000, 'debit',
        250000, 'NGN', 500000, 'Raw lunch transfer', 'Private cafe',
        'PalmPay', '****7890', ?, '{"privateParserField":"unchanged"}', 1
      )`,
    )
    .run(importId, "b".repeat(64));
  sqlite
    .prepare(
      `INSERT INTO transaction_sources (
        transaction_id, parsed_source_row_id, import_batch_id,
        link_type, match_confidence, created_at
      ) VALUES (?, 'ai-source-row', ?, 'original', 'strong', 1)`,
    )
    .run(transactionId, importId);

  const providers = new AiProviderStore({ sqlite, credentialStorage: "keyring" });
  const setting = await providers.create(WORKSPACE_ID, {
    name: "Local Ollama",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "test-local-model",
    timeoutMs: 30_000,
    enabled: true,
    localModel: true,
    payloadPolicy: "local_full",
    acknowledgeRemotePayload: true,
  });
  const adapter: AiProviderAdapter = {
    kind: "ollama",
    listModels: async () => ["test-local-model"],
    testConnection: async () => ({
      ok: true,
      latencyMs: 1,
      models: ["test-local-model"],
      message: "Connected.",
    }),
    classify: async () => output,
  };
  const adapters = createProviderAdapters(async () => {
    throw new Error("Unexpected HTTP request.");
  });
  adapters.ollama = adapter;
  const transactions = new TransactionWorkspace(sqlite);
  const service = new AiClassificationService({
    sqlite,
    providers,
    transactions,
    adapters,
  });
  const queue = new JobQueue(sqlite);
  const job = queue.enqueue({
    workspaceId: WORKSPACE_ID,
    jobType: "classification.ai",
    idempotencyKey: randomUUID(),
    payload: { providerSettingId: setting.id, transactionIds: [transactionId] },
  });
  const context: JobContext = {
    job,
    reportProgress: () => undefined,
    heartbeat: () => undefined,
    assertActive: () => undefined,
  };
  return { sqlite, service, settingId: setting.id, transactionId, context };
}

function validOutput(): AiClassificationOutput {
  return {
    category: "Food & Dining",
    subcategory: null,
    counterparty: null,
    transactionType: "expense",
    scope: "personal",
    confidence: "high",
    reasonCodes: ["narration.meal"],
    explanation: "The narration describes a meal.",
    evidence: ["Narration contains Lunch."],
  };
}

function transactionRow(sqlite: Database.Database, transactionId: string) {
  return sqlite
    .prepare(
      `SELECT category_id, transaction_type, classification_source,
              confidence_level, review_state, source_reference
       FROM transactions WHERE id = ?`,
    )
    .get(transactionId) as {
    category_id: string | null;
    transaction_type: string;
    classification_source: string;
    confidence_level: string;
    review_state: string;
    source_reference: string | null;
  };
}

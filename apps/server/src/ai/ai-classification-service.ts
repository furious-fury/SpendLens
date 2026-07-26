import { createHash, randomUUID } from "node:crypto";
import type {
  AiClassificationJobRequest,
  AiClassificationOutput,
  AiConnectionTest,
  AiPayloadPreview,
  AiProviderSetting,
  ClassificationEvidence,
  ClassificationSuggestion,
} from "@spendlens/contracts";
import { AiClassificationJobRequestSchema } from "@spendlens/contracts";
import {
  type AiProviderStore,
  ClassificationEngine,
  type EncryptedDatabase,
  type TransactionRecord,
  type TransactionWorkspace,
} from "@spendlens/db";
import type { JobContext, JobHandler } from "../jobs/job-worker.js";
import {
  AI_PROMPT_VERSION,
  type AiTransactionPayload,
  buildAiTransactionPayload,
  type LocalParsedSourceContext,
  payloadPreview,
} from "./ai-payload.js";
import {
  type AiProviderAdapter,
  AiProviderError,
  createProviderAdapters,
} from "./provider-adapters.js";

interface CategoryRow {
  id: string;
  name: string;
  parent_name: string | null;
}

interface PendingResult {
  transaction: TransactionRecord;
  payload: AiTransactionPayload;
  output: AiClassificationOutput;
  suggestion: ClassificationSuggestion;
  evidence: ClassificationEvidence[];
}

export type AiClassificationServiceErrorCode =
  | "AI_PROVIDER_NOT_FOUND"
  | "AI_PROVIDER_DISABLED"
  | "AI_PROVIDER_CREDENTIAL_REQUIRED"
  | "AI_CLASSIFICATION_SELECTION_INVALID"
  | "AI_CLASSIFICATION_CATEGORY_UNKNOWN"
  | "AI_CLASSIFICATION_COUNTERPARTY_UNKNOWN";

export class AiClassificationServiceError extends Error {
  readonly retryable = false;

  constructor(
    readonly code: AiClassificationServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AiClassificationServiceError";
  }
}

export interface AiClassificationServiceOptions {
  sqlite: EncryptedDatabase["sqlite"] | (() => EncryptedDatabase["sqlite"]);
  providers: AiProviderStore;
  transactions: TransactionWorkspace;
  classification?: ClassificationEngine;
  adapters?: Record<AiProviderSetting["provider"], AiProviderAdapter>;
  clock?: () => number;
}

export class AiClassificationService {
  readonly #sqlite: () => EncryptedDatabase["sqlite"];
  readonly #providers: AiProviderStore;
  readonly #transactions: TransactionWorkspace;
  readonly #classification: ClassificationEngine;
  readonly #adapters: Record<AiProviderSetting["provider"], AiProviderAdapter>;
  readonly #clock: () => number;

  constructor(options: AiClassificationServiceOptions) {
    const sqlite = options.sqlite;
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#providers = options.providers;
    this.#transactions = options.transactions;
    this.#classification = options.classification ?? new ClassificationEngine(this.#sqlite);
    this.#adapters = options.adapters ?? createProviderAdapters();
    this.#clock = options.clock ?? Date.now;
  }

  async listModels(workspaceId: string, settingId: string): Promise<string[]> {
    const setting = this.#requiredSetting(workspaceId, settingId);
    const credential = await this.#credential(workspaceId, setting);
    return this.#adapters[setting.provider].listModels({ setting, credential });
  }

  async testConnection(workspaceId: string, settingId: string): Promise<AiConnectionTest> {
    const setting = this.#requiredSetting(workspaceId, settingId);
    const credential = await this.#credential(workspaceId, setting);
    return this.#adapters[setting.provider].testConnection({ setting, credential });
  }

  payloadPreview(workspaceId: string, settingId: string): AiPayloadPreview {
    const setting = this.#requiredSetting(workspaceId, settingId);
    const first = this.#sqlite()
      .prepare(
        `SELECT id FROM transactions
         WHERE workspace_id = ?
         ORDER BY occurred_at_utc DESC, id DESC LIMIT 1`,
      )
      .get(workspaceId) as { id: string } | undefined;
    const transaction = first ? this.#transactions.getTransaction(workspaceId, first.id) : null;
    const preview = payloadPreview(transaction, setting.payloadPolicy, setting.localModel);
    if (transaction && setting.payloadPolicy === "local_full") {
      preview.sample = buildAiTransactionPayload(
        transaction,
        setting.payloadPolicy,
        1,
        this.#localParsedContext(transaction.id),
      ).data;
    }
    return preview;
  }

  jobHandler(): JobHandler {
    return (payload, context) => this.runClassificationJob(payload, context);
  }

  async runClassificationJob(payload: unknown, context: JobContext): Promise<unknown> {
    const input = AiClassificationJobRequestSchema.parse(payload);
    const workspaceId = context.job.workspaceId;
    const setting = this.#requiredSetting(workspaceId, input.providerSettingId);
    if (!setting.enabled) {
      throw new AiClassificationServiceError(
        "AI_PROVIDER_DISABLED",
        "Enable the AI provider before starting classification.",
      );
    }
    this.#refreshClassifications(workspaceId, input.transactionIds);
    const credential = await this.#credential(workspaceId, setting);
    const transactions = this.#selectedTransactions(workspaceId, input);
    const categories = this.#categoryPrompt(workspaceId);
    const payloads = transactions.map((transaction, index) =>
      buildAiTransactionPayload(
        transaction,
        setting.payloadPolicy,
        index + 1,
        setting.payloadPolicy === "local_full" ? this.#localParsedContext(transaction.id) : [],
      ),
    );
    const runId = randomUUID();
    const now = this.#clock();
    const payloadHash = hashPayload(payloads);
    this.#sqlite()
      .prepare(
        `INSERT INTO ai_classification_runs (
          id, workspace_id, provider_setting_id, job_id, prompt_version, provider,
          model, payload_hash, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        runId,
        workspaceId,
        setting.id,
        context.job.id,
        AI_PROMPT_VERSION,
        setting.provider,
        setting.model,
        payloadHash,
        now,
      );

    try {
      const results: PendingResult[] = [];
      for (const [index, transaction] of transactions.entries()) {
        context.assertActive();
        context.reportProgress(
          Math.floor((index / transactions.length) * 9_000),
          `Classifying ${index + 1} of ${transactions.length}`,
        );
        const output = await this.#adapters[setting.provider].classify({
          setting,
          credential,
          categories,
          payload: payloads[index] as AiTransactionPayload,
        });
        context.assertActive();
        const suggestion = this.#resolveSuggestion(workspaceId, output);
        const evidence: ClassificationEvidence[] = [
          {
            code: "ai.explanation",
            label: output.explanation,
            source: "ai",
          },
          ...output.evidence.map((label, evidenceIndex) => ({
            code: output.reasonCodes[evidenceIndex] ?? `ai.evidence.${evidenceIndex + 1}`,
            label,
            source: "ai" as const,
          })),
        ];
        if (output.counterparty) {
          evidence.push({
            code: "ai.counterparty",
            label: `Suggested counterparty: ${output.counterparty}`,
            source: "ai",
          });
        }
        results.push({
          transaction,
          payload: payloads[index] as AiTransactionPayload,
          output,
          suggestion,
          evidence,
        });
      }
      context.assertActive();
      this.#persistResults(workspaceId, runId, results);
      context.reportProgress(9_800, "Suggestions added to Review");
      return {
        runId,
        promptVersion: AI_PROMPT_VERSION,
        provider: setting.provider,
        model: setting.model,
        payloadHash,
        suggestionCount: results.length,
        reviewRequired: true,
      };
    } catch (error) {
      const status =
        error instanceof Error && error.name === "JobLeaseLostError" ? "cancelled" : "failed";
      const code =
        error instanceof AiProviderError || error instanceof AiClassificationServiceError
          ? error.code
          : "AI_CLASSIFICATION_FAILED";
      this.#sqlite()
        .prepare(
          `UPDATE ai_classification_runs
           SET status = ?, error_code = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(status, code, this.#clock(), runId);
      throw error;
    }
  }

  #persistResults(workspaceId: string, runId: string, results: PendingResult[]): void {
    const sqlite = this.#sqlite();
    sqlite.transaction(() => {
      const insert = sqlite.prepare(
        `INSERT INTO ai_classification_suggestions (
          id, workspace_id, transaction_id, run_id, suggestion, confidence,
          reason_codes, explanation, evidence, input_updated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = this.#clock();
      for (const result of results) {
        insert.run(
          randomUUID(),
          workspaceId,
          result.transaction.id,
          runId,
          JSON.stringify(result.suggestion),
          result.output.confidence,
          JSON.stringify(result.output.reasonCodes),
          result.output.explanation,
          JSON.stringify(result.evidence),
          result.transaction.updatedAt.getTime(),
          now,
        );
      }
      sqlite
        .prepare(
          `UPDATE ai_classification_runs
           SET status = 'succeeded', result = ?, completed_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(
            results.map(({ transaction, output }) => ({
              transactionId: transaction.id,
              output,
            })),
          ),
          now,
          runId,
        );
    })();
  }

  #selectedTransactions(
    workspaceId: string,
    input: AiClassificationJobRequest,
  ): TransactionRecord[] {
    const ids = [...new Set(input.transactionIds)];
    if (ids.length !== input.transactionIds.length) {
      throw new AiClassificationServiceError(
        "AI_CLASSIFICATION_SELECTION_INVALID",
        "Each selected transaction must appear only once.",
      );
    }
    const transactions = ids.map((id) => {
      try {
        return this.#transactions.getTransaction(workspaceId, id);
      } catch {
        throw new AiClassificationServiceError(
          "AI_CLASSIFICATION_SELECTION_INVALID",
          "Every selected transaction must belong to the current workspace.",
        );
      }
    });
    if (
      transactions.some(
        (transaction) =>
          transaction.classificationSource === "manual" ||
          transaction.confidence === "confirmed" ||
          transaction.reviewState === "reviewed",
      )
    ) {
      throw new AiClassificationServiceError(
        "AI_CLASSIFICATION_SELECTION_INVALID",
        "AI can only suggest classifications for unresolved transactions.",
      );
    }
    return transactions;
  }

  #refreshClassifications(workspaceId: string, transactionIds: string[]): void {
    const uniqueIds = [...new Set(transactionIds)];
    if (uniqueIds.length === 0) return;
    const staleIds = (
      this.#sqlite()
        .prepare(
          `SELECT transaction_row.id
           FROM transactions transaction_row
           LEFT JOIN classification_decisions decision
             ON decision.transaction_id = transaction_row.id
           WHERE transaction_row.workspace_id = ?
             AND transaction_row.id IN (${uniqueIds.map(() => "?").join(", ")})
             AND (
               decision.transaction_id IS NULL
               OR decision.evaluated_at < transaction_row.updated_at
             )`,
        )
        .all(workspaceId, ...uniqueIds) as Array<{ id: string }>
    ).map(({ id }) => id);
    this.#classification.classifyTransactions(workspaceId, staleIds);
  }

  #resolveSuggestion(
    workspaceId: string,
    output: AiClassificationOutput,
  ): ClassificationSuggestion {
    const category = output.subcategory
      ? (this.#sqlite()
          .prepare(
            `SELECT child.id, child.name, parent.name AS parent_name
             FROM categories child
             JOIN categories parent ON parent.id = child.parent_id
             WHERE child.workspace_id = ?
               AND lower(child.name) = lower(?)
               AND lower(parent.name) = lower(?)
               AND child.archived_at IS NULL
             LIMIT 1`,
          )
          .get(workspaceId, output.subcategory, output.category) as CategoryRow | undefined)
      : (this.#sqlite()
          .prepare(
            `SELECT category.id, category.name, parent.name AS parent_name
             FROM categories category
             LEFT JOIN categories parent ON parent.id = category.parent_id
             WHERE category.workspace_id = ?
               AND lower(category.name) = lower(?)
               AND category.archived_at IS NULL
             ORDER BY category.parent_id IS NULL DESC
             LIMIT 1`,
          )
          .get(workspaceId, output.category) as CategoryRow | undefined);
    if (!category) {
      throw new AiClassificationServiceError(
        "AI_CLASSIFICATION_CATEGORY_UNKNOWN",
        "The provider suggested a category that does not exist in this workspace.",
      );
    }
    const counterparty = output.counterparty
      ? (this.#sqlite()
          .prepare(
            `SELECT id FROM counterparties
             WHERE workspace_id = ? AND lower(display_name) = lower(?)
             LIMIT 1`,
          )
          .get(workspaceId, output.counterparty) as { id: string } | undefined)
      : undefined;
    return {
      categoryId: category.id,
      transactionType: output.transactionType,
      ...(output.scope ? { scope: output.scope } : {}),
      ...(counterparty ? { counterpartyId: counterparty.id } : {}),
    };
  }

  #categoryPrompt(workspaceId: string): string[] {
    return (
      this.#sqlite()
        .prepare(
          `SELECT category.name, parent.name AS parent_name
           FROM categories category
           LEFT JOIN categories parent ON parent.id = category.parent_id
           WHERE category.workspace_id = ? AND category.archived_at IS NULL
           ORDER BY coalesce(parent.name, category.name), parent.name IS NULL DESC, category.name`,
        )
        .all(workspaceId) as Array<{ name: string; parent_name: string | null }>
    ).map((category) =>
      category.parent_name ? `${category.parent_name} > ${category.name}` : category.name,
    );
  }

  #localParsedContext(transactionId: string): LocalParsedSourceContext[] {
    const rows = this.#sqlite()
      .prepare(
        `SELECT
          source.source_row_index AS sourceRowIndex,
          source.source_transaction_id AS sourceTransactionId,
          source.source_reference AS sourceReference,
          source.source_timestamp AS sourceTimestamp,
          source.source_timezone AS sourceTimezone,
          source.direction,
          source.amount_minor AS amountMinor,
          source.currency,
          source.balance_after_minor AS balanceAfterMinor,
          source.raw_narration AS rawNarration,
          source.sender_or_recipient_name AS senderOrRecipientName,
          source.institution_name AS institutionName,
          source.masked_account_number AS maskedAccountNumber,
          source.raw_fields AS rawFields
         FROM transaction_sources link
         JOIN parsed_source_rows source ON source.id = link.parsed_source_row_id
         WHERE link.transaction_id = ?
         ORDER BY CASE link.link_type WHEN 'original' THEN 0 ELSE 1 END,
                  link.created_at, source.source_row_index`,
      )
      .all(transactionId) as Array<
      Omit<LocalParsedSourceContext, "rawFields"> & {
        rawFields: string;
      }
    >;
    return rows.map((row) => ({
      ...row,
      rawFields: safeJsonObject(row.rawFields),
    }));
  }

  async #credential(workspaceId: string, setting: AiProviderSetting): Promise<string | null> {
    const credential = await this.#providers.credential(workspaceId, setting.id);
    if (!setting.localModel && !credential) {
      throw new AiClassificationServiceError(
        "AI_PROVIDER_CREDENTIAL_REQUIRED",
        "This remote provider requires an API key.",
      );
    }
    return credential;
  }

  #requiredSetting(workspaceId: string, settingId: string): AiProviderSetting {
    const setting = this.#providers.get(workspaceId, settingId);
    if (!setting) {
      throw new AiClassificationServiceError(
        "AI_PROVIDER_NOT_FOUND",
        "The AI provider was not found.",
      );
    }
    return setting;
  }
}

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

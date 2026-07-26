import { randomUUID } from "node:crypto";
import type {
  AiClassificationOutput,
  AiProviderKind,
  AiProviderSetting,
} from "@spendlens/contracts";
import type { TransactionRecord } from "@spendlens/db";
import { describe, expect, it, vi } from "vitest";
import { buildAiTransactionPayload, redactRemoteNarration } from "../src/ai/ai-payload.js";
import {
  type AiProviderAdapter,
  AiProviderError,
  createProviderAdapters,
} from "../src/ai/provider-adapters.js";

const kinds: AiProviderKind[] = ["openai_compatible", "anthropic", "gemini", "ollama"];

describe("AI provider adapter contracts", () => {
  it.each(kinds)("%s supports model listing and structured classification", async (kind) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return jsonResponse(
        isModelUrl(kind, url) ? modelEnvelope(kind) : outputEnvelope(kind, validOutput()),
      );
    }) as unknown as typeof fetch;
    const adapter = adapterFor(kind, fetcher);

    await expect(adapter.listModels(providerRequest(kind))).resolves.toEqual(["test-model"]);
    await expect(adapter.classify(classificationRequest(kind))).resolves.toEqual(validOutput());
  });

  it.each(kinds)("%s rejects malformed structured output", async (kind) => {
    const fetcher = vi.fn(async () =>
      jsonResponse(outputEnvelope(kind, "not-json")),
    ) as unknown as typeof fetch;

    await expect(
      adapterFor(kind, fetcher).classify(classificationRequest(kind)),
    ).rejects.toMatchObject({ code: "AI_PROVIDER_RESPONSE_INVALID", retryable: false });
  });

  it.each(kinds)("%s bounds and reports timeouts", async (kind) => {
    const fetcher = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ) as unknown as typeof fetch;

    await expect(
      adapterFor(kind, fetcher).classify(classificationRequest(kind, 1)),
    ).rejects.toMatchObject({ code: "AI_PROVIDER_TIMEOUT", retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(kinds)("%s bounds and reports rate limits", async (kind) => {
    const fetcher = vi.fn(
      async () => new Response("rate limited", { status: 429 }),
    ) as unknown as typeof fetch;

    await expect(
      adapterFor(kind, fetcher).classify(classificationRequest(kind)),
    ).rejects.toMatchObject({ code: "AI_PROVIDER_RATE_LIMITED", retryable: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(kinds)(
    "%s reports non-retryable provider failures without response leakage",
    async (kind) => {
      const fetcher = vi.fn(
        async () => new Response("provider echoed super-secret-key", { status: 400 }),
      ) as unknown as typeof fetch;

      const error = await adapterFor(kind, fetcher)
        .classify(classificationRequest(kind))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiProviderError);
      expect(error).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", retryable: false });
      expect(String(error)).not.toContain("super-secret-key");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});

describe("remote AI payload privacy", () => {
  it("omits restricted fields and redacts account-like narration tokens", () => {
    const transaction = privateTransaction();
    const payload = buildAiTransactionPayload(transaction, "remote_redacted");
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("1234567890");
    expect(serialized).not.toContain("REFERENCE-PRIVATE-123456");
    expect(serialized).not.toContain("private user note");
    expect(serialized).not.toContain("PalmPay 1234567890");
    expect(serialized).not.toContain(transaction.id);
    expect(payload.data.narration).toContain("[REDACTED");
  });

  it("permits full parsed context only under the explicit local policy", () => {
    const transaction = privateTransaction();
    const local = JSON.stringify(
      buildAiTransactionPayload(transaction, "local_full", 1, [
        {
          sourceRowIndex: 4,
          sourceTransactionId: "LOCAL-SOURCE-ID",
          sourceReference: "REFERENCE-PRIVATE-123456",
          sourceTimestamp: transaction.sourceTimestamp,
          sourceTimezone: transaction.sourceTimezone,
          direction: transaction.direction,
          amountMinor: transaction.amountMinor,
          currency: transaction.currency,
          balanceAfterMinor: 987654,
          rawNarration: transaction.source.rawNarration,
          senderOrRecipientName: "Private recipient",
          institutionName: "PalmPay",
          maskedAccountNumber: "****7890",
          rawFields: { privateParserField: "local only" },
        },
      ]),
    );

    expect(local).toContain("REFERENCE-PRIVATE-123456");
    expect(local).toContain("private user note");
    expect(local).toContain(transaction.id);
    expect(local).toContain("987654");
    expect(local).toContain("privateParserField");
  });

  it("redacts long numeric and alphanumeric identifiers", () => {
    expect(
      redactRemoteNarration(
        "Transfer account: 1234567890 ref ABCDEF1234567890 transaction id 998877665544",
      ),
    ).not.toMatch(/1234567890|ABCDEF1234567890|998877665544/);
  });
});

function adapterFor(kind: AiProviderKind, fetcher: typeof fetch): AiProviderAdapter {
  return createProviderAdapters(fetcher, async () => undefined)[kind];
}

function providerRequest(kind: AiProviderKind) {
  return { setting: setting(kind), credential: "test-secret" };
}

function classificationRequest(kind: AiProviderKind, timeoutMs = 20) {
  return {
    ...providerRequest(kind),
    setting: setting(kind, timeoutMs),
    categories: ["Food & Dining > Restaurants"],
    payload: {
      transactionKey: "transaction-1",
      data: { narration: "Lunch", amountMinor: 250000, currency: "NGN" },
    },
  };
}

function setting(kind: AiProviderKind, timeoutMs = 20): AiProviderSetting {
  return {
    id: randomUUID(),
    name: kind,
    provider: kind,
    endpoint:
      kind === "ollama"
        ? "http://127.0.0.1:11434"
        : kind === "gemini"
          ? "https://generativelanguage.googleapis.com"
          : "https://provider.example/v1",
    model: "test-model",
    timeoutMs,
    enabled: true,
    localModel: kind === "ollama",
    payloadPolicy: kind === "ollama" ? "local_full" : "remote_redacted",
    hasCredential: kind !== "ollama",
    credentialStorage: "keyring",
    remotePayloadAcknowledgedAt: kind === "ollama" ? null : new Date("2026-01-01").toISOString(),
    createdAt: new Date("2026-01-01").toISOString(),
    updatedAt: new Date("2026-01-01").toISOString(),
  };
}

function validOutput(): AiClassificationOutput {
  return {
    category: "Food & Dining",
    subcategory: "Restaurants",
    counterparty: null,
    transactionType: "expense",
    scope: "personal",
    confidence: "high",
    reasonCodes: ["narration.meal"],
    explanation: "The narration identifies a meal.",
    evidence: ["Narration contains Lunch."],
  };
}

function outputEnvelope(kind: AiProviderKind, output: AiClassificationOutput | string) {
  const content = typeof output === "string" ? output : JSON.stringify(output);
  switch (kind) {
    case "openai_compatible":
      return { choices: [{ message: { content } }] };
    case "anthropic":
      return { content: [{ type: "text", text: content }] };
    case "gemini":
      return { candidates: [{ content: { parts: [{ text: content }] } }] };
    case "ollama":
      return { message: { content } };
  }
}

function modelEnvelope(kind: AiProviderKind) {
  switch (kind) {
    case "openai_compatible":
    case "anthropic":
      return { data: [{ id: "test-model" }] };
    case "gemini":
      return { models: [{ name: "models/test-model" }] };
    case "ollama":
      return { models: [{ name: "test-model" }] };
  }
}

function isModelUrl(kind: AiProviderKind, url: string): boolean {
  if (kind === "ollama") return url.endsWith("/api/tags");
  if (kind === "gemini") return url.includes("/v1beta/models") && !url.includes(":generateContent");
  return url.endsWith("/models");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function privateTransaction(): TransactionRecord {
  const id = randomUUID();
  return {
    id,
    occurredAt: new Date("2026-06-15T12:00:00.000Z"),
    sourceTimestamp: "2026-06-15 13:00:00",
    sourceTimezone: "Africa/Lagos",
    account: {
      id: randomUUID(),
      displayName: "PalmPay 1234567890",
      institutionName: "PalmPay",
    },
    direction: "debit",
    transactionType: "unclassified",
    amountMinor: 125000,
    currency: "NGN",
    normalizedNarration:
      "Transfer account: 1234567890 ref ABCDEF1234567890 REFERENCE-PRIVATE-123456",
    sourceReference: "REFERENCE-PRIVATE-123456",
    category: null,
    counterparty: null,
    scope: "personal",
    classificationSource: "unclassified",
    confidence: "unknown",
    confidenceBasisPoints: null,
    classificationExplanation: null,
    classificationDecision: null,
    reviewState: "needs_review",
    note: "private user note",
    splits: [],
    transfer: { status: "none", pairedTransactionId: null },
    source: {
      rawNarration: "Raw transfer to 1234567890",
      sourceTimestamp: "2026-06-15 13:00:00",
      importIds: [randomUUID()],
    },
    updatedAt: new Date("2026-06-15T12:00:00.000Z"),
  };
}

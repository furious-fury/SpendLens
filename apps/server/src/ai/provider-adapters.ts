import type {
  AiClassificationOutput,
  AiConnectionTest,
  AiProviderKind,
  AiProviderSetting,
} from "@spendlens/contracts";
import { AiClassificationOutputSchema } from "@spendlens/contracts";
import {
  type AiTransactionPayload,
  classificationSystemPrompt,
  classificationUserPrompt,
} from "./ai-payload.js";

export interface ProviderRequest {
  setting: AiProviderSetting;
  credential: string | null;
}

export interface ClassificationProviderRequest extends ProviderRequest {
  categories: string[];
  payload: AiTransactionPayload;
}

export interface AiProviderAdapter {
  readonly kind: AiProviderKind;
  listModels(request: ProviderRequest): Promise<string[]>;
  testConnection(request: ProviderRequest): Promise<AiConnectionTest>;
  classify(request: ClassificationProviderRequest): Promise<AiClassificationOutput>;
}

export type Fetcher = typeof fetch;

export type AiProviderErrorCode =
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_RATE_LIMITED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_RESPONSE_INVALID";

export class AiProviderError extends Error {
  constructor(
    readonly code: AiProviderErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

abstract class HttpAdapter implements AiProviderAdapter {
  abstract readonly kind: AiProviderKind;
  readonly #fetcher: Fetcher;
  readonly #delay: (milliseconds: number) => Promise<void>;

  constructor(
    fetcher: Fetcher = fetch,
    delay = (milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.#fetcher = fetcher;
    this.#delay = delay;
  }

  abstract listModels(request: ProviderRequest): Promise<string[]>;
  abstract classify(request: ClassificationProviderRequest): Promise<AiClassificationOutput>;

  async testConnection(request: ProviderRequest): Promise<AiConnectionTest> {
    const startedAt = Date.now();
    const models = await this.listModels(request);
    return {
      ok: true,
      latencyMs: Math.max(0, Date.now() - startedAt),
      models,
      message: models.length > 0 ? "Connected and models are available." : "Connected.",
    };
  }

  protected async json(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    maxAttempts = 3,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.#fetcher(url, { ...init, signal: controller.signal });
        if (response.ok) return await response.json();
        const retryable =
          response.status === 408 || response.status === 429 || response.status >= 500;
        const error =
          response.status === 429
            ? new AiProviderError(
                "AI_PROVIDER_RATE_LIMITED",
                "The provider rate limit was reached.",
                true,
              )
            : new AiProviderError(
                "AI_PROVIDER_UNAVAILABLE",
                `The provider returned HTTP ${response.status}.`,
                retryable,
              );
        if (!retryable || attempt === maxAttempts) throw error;
        lastError = error;
      } catch (error) {
        const normalized =
          error instanceof AiProviderError
            ? error
            : isAbortError(error)
              ? new AiProviderError("AI_PROVIDER_TIMEOUT", "The provider request timed out.", true)
              : new AiProviderError(
                  "AI_PROVIDER_UNAVAILABLE",
                  "The provider could not be reached.",
                  true,
                );
        if (!normalized.retryable || attempt === maxAttempts) throw normalized;
        lastError = normalized;
      } finally {
        clearTimeout(timer);
      }
      await this.#delay(Math.min(2_000, 250 * 2 ** (attempt - 1)));
    }
    throw (
      lastError ??
      new AiProviderError("AI_PROVIDER_UNAVAILABLE", "The provider request failed.", false)
    );
  }
}

export class OpenAiCompatibleAdapter extends HttpAdapter {
  readonly kind = "openai_compatible" as const;

  async listModels(request: ProviderRequest): Promise<string[]> {
    const body = await this.json(
      `${request.setting.endpoint}/models`,
      { headers: bearerHeaders(request.credential) },
      request.setting.timeoutMs,
    );
    return arrayAt(body, "data")
      .map((item) => stringAt(item, "id"))
      .filter(isString);
  }

  async classify(request: ClassificationProviderRequest): Promise<AiClassificationOutput> {
    const body = await this.json(
      `${request.setting.endpoint}/chat/completions`,
      {
        method: "POST",
        headers: jsonHeaders(bearerHeaders(request.credential)),
        body: JSON.stringify({
          model: request.setting.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: classificationSystemPrompt(request.categories) },
            { role: "user", content: classificationUserPrompt(request.payload) },
          ],
        }),
      },
      request.setting.timeoutMs,
    );
    const choices = arrayAt(body, "choices");
    return parseOutput(nestedString(choices[0], ["message", "content"]));
  }
}

export class AnthropicAdapter extends HttpAdapter {
  readonly kind = "anthropic" as const;

  async listModels(request: ProviderRequest): Promise<string[]> {
    const body = await this.json(
      `${request.setting.endpoint}/models`,
      { headers: anthropicHeaders(request.credential) },
      request.setting.timeoutMs,
    );
    return arrayAt(body, "data")
      .map((item) => stringAt(item, "id"))
      .filter(isString);
  }

  async classify(request: ClassificationProviderRequest): Promise<AiClassificationOutput> {
    const body = await this.json(
      `${request.setting.endpoint}/messages`,
      {
        method: "POST",
        headers: jsonHeaders(anthropicHeaders(request.credential)),
        body: JSON.stringify({
          model: request.setting.model,
          max_tokens: 1_024,
          temperature: 0,
          system: classificationSystemPrompt(request.categories),
          messages: [{ role: "user", content: classificationUserPrompt(request.payload) }],
        }),
      },
      request.setting.timeoutMs,
    );
    const text = arrayAt(body, "content")
      .map((item) => (stringAt(item, "type") === "text" ? stringAt(item, "text") : null))
      .find(isString);
    return parseOutput(text);
  }
}

export class GeminiAdapter extends HttpAdapter {
  readonly kind = "gemini" as const;

  async listModels(request: ProviderRequest): Promise<string[]> {
    const body = await this.json(
      withGeminiKey(`${request.setting.endpoint}/v1beta/models`, request.credential),
      {},
      request.setting.timeoutMs,
    );
    return arrayAt(body, "models")
      .map((item) => stringAt(item, "name")?.replace(/^models\//, ""))
      .filter(isString);
  }

  async classify(request: ClassificationProviderRequest): Promise<AiClassificationOutput> {
    const url = withGeminiKey(
      `${request.setting.endpoint}/v1beta/models/${encodeURIComponent(
        request.setting.model,
      )}:generateContent`,
      request.credential,
    );
    const body = await this.json(
      url,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: classificationSystemPrompt(request.categories) }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: classificationUserPrompt(request.payload) }],
            },
          ],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      },
      request.setting.timeoutMs,
    );
    const candidates = arrayAt(body, "candidates");
    const parts = nestedArray(candidates[0], ["content", "parts"]);
    return parseOutput(parts.map((part) => stringAt(part, "text")).find(isString));
  }
}

export class OllamaAdapter extends HttpAdapter {
  readonly kind = "ollama" as const;

  async listModels(request: ProviderRequest): Promise<string[]> {
    const body = await this.json(
      `${request.setting.endpoint}/api/tags`,
      {},
      request.setting.timeoutMs,
    );
    return arrayAt(body, "models")
      .map((item) => stringAt(item, "name") ?? stringAt(item, "model"))
      .filter(isString);
  }

  async classify(request: ClassificationProviderRequest): Promise<AiClassificationOutput> {
    const body = await this.json(
      `${request.setting.endpoint}/api/chat`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          model: request.setting.model,
          stream: false,
          format: "json",
          options: { temperature: 0 },
          messages: [
            { role: "system", content: classificationSystemPrompt(request.categories) },
            { role: "user", content: classificationUserPrompt(request.payload) },
          ],
        }),
      },
      request.setting.timeoutMs,
    );
    return parseOutput(nestedString(body, ["message", "content"]));
  }
}

export function createProviderAdapters(
  fetcher: Fetcher = fetch,
  delay?: (milliseconds: number) => Promise<void>,
): Record<AiProviderKind, AiProviderAdapter> {
  return {
    openai_compatible: new OpenAiCompatibleAdapter(fetcher, delay),
    anthropic: new AnthropicAdapter(fetcher, delay),
    gemini: new GeminiAdapter(fetcher, delay),
    ollama: new OllamaAdapter(fetcher, delay),
  };
}

function parseOutput(value: string | null | undefined): AiClassificationOutput {
  if (!value) {
    throw new AiProviderError(
      "AI_PROVIDER_RESPONSE_INVALID",
      "The provider response did not contain structured output.",
      false,
    );
  }
  try {
    const normalized = value
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "");
    return AiClassificationOutputSchema.parse(JSON.parse(normalized));
  } catch {
    throw new AiProviderError(
      "AI_PROVIDER_RESPONSE_INVALID",
      "The provider returned malformed classification output.",
      false,
    );
  }
}

function bearerHeaders(credential: string | null): Record<string, string> {
  return credential ? { Authorization: `Bearer ${credential}` } : {};
}

function anthropicHeaders(credential: string | null): Record<string, string> {
  return {
    "anthropic-version": "2023-06-01",
    ...(credential ? { "x-api-key": credential } : {}),
  };
}

function jsonHeaders(existing: Record<string, string> = {}): Record<string, string> {
  return { ...existing, "content-type": "application/json" };
}

function withGeminiKey(url: string, credential: string | null): string {
  if (!credential) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("key", credential);
  return parsed.toString();
}

function arrayAt(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function nestedArray(value: unknown, path: string[]): unknown[] {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return [];
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function stringAt(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function nestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === "string" ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: string | null | undefined): value is string {
  return typeof value === "string";
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"))
  );
}

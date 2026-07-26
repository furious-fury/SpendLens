import { describe, expect, it } from "vitest";
import { AiProviderInputSchema, AiProviderUpdateSchema } from "../src/index.js";

describe("AI provider contracts", () => {
  it("keeps omitted PATCH fields omitted", () => {
    expect(AiProviderUpdateSchema.parse({ enabled: true })).toEqual({ enabled: true });
  });

  it("requires acknowledgement before a remote provider can be enabled", () => {
    const result = AiProviderInputSchema.safeParse({
      name: "Remote",
      provider: "openai_compatible",
      endpoint: "https://provider.example/v1",
      model: "model",
      enabled: true,
      localModel: false,
      payloadPolicy: "remote_redacted",
      acknowledgeRemotePayload: false,
    });
    expect(result.success).toBe(false);
  });

  it("requires HTTPS for remote providers but permits local HTTP endpoints", () => {
    const remote = AiProviderInputSchema.safeParse({
      name: "Remote",
      provider: "openai_compatible",
      endpoint: "http://provider.example/v1",
      model: "model",
      localModel: false,
      payloadPolicy: "remote_redacted",
    });
    const local = AiProviderInputSchema.safeParse({
      name: "Ollama",
      provider: "ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "model",
      localModel: true,
      payloadPolicy: "local_full",
    });
    expect(remote.success).toBe(false);
    expect(local.success).toBe(true);
  });
});

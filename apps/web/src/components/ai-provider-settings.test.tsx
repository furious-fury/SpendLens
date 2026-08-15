import { describe, expect, it } from "vitest";
import { getModelOptions, getProviderEnableGuidance } from "./ai-provider-settings";

describe("AI provider editor", () => {
  it("keeps the current model available and sorts fetched models", () => {
    expect(getModelOptions("gpt-4.1-mini", ["o3", "gpt-4.1", "gpt-4.1-mini", "o3"])).toEqual([
      "gpt-4.1",
      "gpt-4.1-mini",
      "o3",
    ]);
  });

  it("keeps a manually entered model available when listing returns no names", () => {
    expect(getModelOptions("custom-model", [])).toEqual(["custom-model"]);
  });

  it("explains what unlocks a remote provider before it is enabled", () => {
    expect(
      getProviderEnableGuidance({
        enabled: false,
        localModel: false,
        acknowledgeRemotePayload: false,
      }),
    ).toEqual({
      blocked: true,
      message: "Review and confirm the redacted payload above to unlock this provider.",
    });
  });

  it("removes the enable warning after the remote payload is acknowledged", () => {
    expect(
      getProviderEnableGuidance({
        enabled: true,
        localModel: false,
        acknowledgeRemotePayload: true,
      }),
    ).toEqual({
      blocked: false,
      message: "Enabled. Transactions are only sent when you choose them from Review.",
    });
  });
});

import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("service health", () => {
  it("reports liveness", async () => {
    const response = await createApp().request("/health/live");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      service: "spendlens",
      status: "ok",
      version: "0.1.0",
    });
  });

  it("reports readiness", async () => {
    const response = await createApp().request("/health/ready");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      service: "spendlens",
      status: "ready",
      version: "0.1.0",
    });
  });
});

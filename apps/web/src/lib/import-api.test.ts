import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const preview = {
  id: "29f9b931-1d81-7d63-aaf7-3f784a06877c",
  status: "previewed" as const,
  institution: "PalmPay",
  maskedAccountNumber: "**** 1234",
  statementPeriod: { start: "2026-06-01", end: "2026-06-30" },
  totals: { inflowMinor: 100_000, outflowMinor: 25_000, currency: "NGN" },
  transactionCount: 2,
  reconciliation: {
    status: "matched" as const,
    declaredInflowMinor: 100_000,
    declaredOutflowMinor: 25_000,
    parsedInflowMinor: 100_000,
    parsedOutflowMinor: 25_000,
    currency: "NGN",
  },
  parser: { key: "palmpay", version: "1" },
  requiresConfirmation: false,
  createdAt: "2026-08-15T12:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("statement import API", () => {
  it("uploads the PDF body without replacing its content type with JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(preview), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["%PDF-1.7"], "june-statement.pdf", {
      type: "application/pdf",
    });

    await expect(api.createImportPreview(file)).resolves.toEqual(preview);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(path).toBe("/api/imports/previews");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);
    expect(headers.get("content-type")).toBe("application/pdf");
    expect(headers.get("x-spendlens-filename")).toBe("june-statement.pdf");
  });
});

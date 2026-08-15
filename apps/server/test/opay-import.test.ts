import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OPayStatementParser } from "../src/imports/opay-parser.js";
import { PalmPayStatementParser } from "../src/imports/palmpay-parser.js";
import { selectParser } from "../src/imports/parser-types.js";
import { readPositionedPdf } from "../src/imports/pdf-document.js";
import { createSanitizedOPayPdf } from "./opay-fixture.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("OPay coordinate parser", () => {
  it("detects OPay, reconstructs wrapped rows, and reconciles statement totals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spendlens-opay-"));
    temporaryPaths.push(directory);
    const path = join(directory, "sanitized-opay.pdf");
    await writeFile(path, await createSanitizedOPayPdf());
    const document = await readPositionedPdf(path);

    const parser = selectParser(document, [
      new PalmPayStatementParser(),
      new OPayStatementParser(),
    ]);
    const statement = parser.parse(document);

    expect(parser).toMatchObject({ key: "opay-ng-pdf", version: "1.0.0" });
    expect(statement).toMatchObject({
      institutionName: "OPay",
      maskedAccountNumber: "•••• 4321",
      statementStart: "2026-01-01",
      statementEnd: "2026-07-31",
      declaredInflowMinor: 100_000,
      declaredOutflowMinor: 25_050,
      reconciliation: {
        status: "matched",
        parsedInflowMinor: 100_000,
        parsedOutflowMinor: 25_050,
      },
    });
    expect(statement.transactions).toHaveLength(2);
    expect(statement.transactions[0]).toMatchObject({
      narration: "Received from Example Client",
      sourceTransactionId: "fixture-credit-001",
      direction: "credit",
      amountMinor: 100_000,
    });
    expect(statement.transactions[1]).toMatchObject({
      narration: "Send to Example Store",
      sourceTransactionId: "fixture-debit-002",
      direction: "debit",
      amountMinor: 25_050,
    });
  });
});

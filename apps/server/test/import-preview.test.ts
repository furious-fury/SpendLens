import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createEncryptedDatabase,
  type EncryptedDatabase,
  ImportPreviewStore,
  MemoryKeyProvider,
} from "@spendlens/db";
import { PasswordResponses } from "pdfjs-dist/legacy/build/pdf.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { DuplicateImportError, ImportPreviewService } from "../src/imports/import-service.js";
import { PalmPayStatementParser } from "../src/imports/palmpay-parser.js";
import { pdfLoadingError, readPositionedPdf } from "../src/imports/pdf-document.js";
import { selectParser } from "../src/imports/parser-types.js";
import { receiveSecurePdf } from "../src/imports/secure-upload.js";
import { createSanitizedPalmPayPdf } from "./palmpay-fixture.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("PalmPay coordinate parser", () => {
  it("reconstructs wrapped fields and reconciles a sanitized statement", async () => {
    const path = await fixturePath(await createSanitizedPalmPayPdf());
    const document = await readPositionedPdf(path);
    const parser = selectParser(document, [new PalmPayStatementParser()]);
    const statement = parser.parse(document);

    expect(parser).toMatchObject({ key: "palmpay-ng-pdf", version: "1.0.0" });
    expect(statement).toMatchObject({
      institutionName: "PalmPay",
      maskedAccountNumber: "•••• 4321",
      statementStart: "2026-06-01",
      statementEnd: "2026-06-30",
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
    });
    expect(statement.transactions[1]).toMatchObject({
      narration: "Send to Example Store Lagos",
      sourceTransactionId: "fixture-debit-002",
      direction: "debit",
      amountMinor: 25_050,
    });
  });

  it("identifies scanned, unsupported, malformed, encrypted, and overlong PDFs", async () => {
    const scannedPath = await fixturePath(await createSanitizedPalmPayPdf({ includeText: false }));
    const scanned = await readPositionedPdf(scannedPath);
    expect(() => selectParser(scanned, [new PalmPayStatementParser()])).toThrowError(
      expect.objectContaining({ code: "PDF_SCANNED" }),
    );

    const unsupportedPath = await fixturePath(
      await createSanitizedPalmPayPdf({ declaredInflow: "9.00" }),
    );
    const unsupported = await readPositionedPdf(unsupportedPath);
    const unsupportedFirstPage = unsupported.pages[0];
    if (!unsupportedFirstPage) throw new Error("Expected a sanitized PDF page.");
    unsupportedFirstPage.items = unsupportedFirstPage.items.filter(
      (item) => !item.text.includes("palmpay.com") && item.text !== "Account Statement",
    );
    expect(() => selectParser(unsupported, [new PalmPayStatementParser()])).toThrowError(
      expect.objectContaining({ code: "PARSER_UNSUPPORTED" }),
    );

    const malformedPath = await fixturePath(new TextEncoder().encode("%PDF-not-valid"));
    await expect(readPositionedPdf(malformedPath)).rejects.toMatchObject({
      code: "PDF_MALFORMED",
    });
    expect(pdfLoadingError({ code: PasswordResponses.NEED_PASSWORD })).toMatchObject({
      code: "PDF_ENCRYPTED",
    });

    const longPath = await fixturePath(
      await createSanitizedPalmPayPdf({ includeText: false, pageCount: 201 }),
    );
    await expect(readPositionedPdf(longPath)).rejects.toMatchObject({
      code: "PDF_TOO_MANY_PAGES",
    });
  });
});

describe("secure import previews", () => {
  it("stores parsed rows, flags mismatches, removes temp PDFs, and rejects exact repeats", async () => {
    const database = await databaseFixture();
    const uploadRoot = await temporaryDirectory("spendlens-upload-root");
    const bytes = await createSanitizedPalmPayPdf({ declaredInflow: "999.00" });
    const request = pdfRequest(bytes);
    const upload = await receiveSecurePdf(request, { temporaryRoot: uploadRoot });
    const service = new ImportPreviewService(new ImportPreviewStore(database.sqlite));
    const preview = await service.create("workspace", upload);

    expect(preview).toMatchObject({
      transactionCount: 2,
      reconciliationStatus: "mismatched",
      declaredInflowMinor: 99_900,
      parsedInflowMinor: 100_000,
    });
    expect(await readdir(uploadRoot)).toEqual([]);
    expect(
      database.sqlite
        .prepare(
          `SELECT count(*) AS count FROM parsed_source_rows
           WHERE import_batch_id = ?`,
        )
        .get(preview.id),
    ).toEqual({ count: 2 });

    const repeated = await receiveSecurePdf(pdfRequest(bytes), {
      temporaryRoot: uploadRoot,
    });
    await expect(service.create("workspace", repeated)).rejects.toBeInstanceOf(
      DuplicateImportError,
    );
    expect(await readdir(uploadRoot)).toEqual([]);
    database.close();
  });

  it("removes temp data on parser failure and enforces MIME and size limits", async () => {
    const uploadRoot = await temporaryDirectory("spendlens-upload-failure");
    const database = await databaseFixture();
    const service = new ImportPreviewService(new ImportPreviewStore(database.sqlite));
    const malformed = new TextEncoder().encode("%PDF-not-valid");
    const upload = await receiveSecurePdf(pdfRequest(malformed), {
      temporaryRoot: uploadRoot,
    });
    await expect(service.create("workspace", upload)).rejects.toMatchObject({
      code: "PDF_MALFORMED",
    });
    expect(await readdir(uploadRoot)).toEqual([]);

    await expect(
      receiveSecurePdf(
        new Request("http://localhost/import", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: malformed,
        }),
        { temporaryRoot: uploadRoot },
      ),
    ).rejects.toMatchObject({ code: "PDF_INVALID_SIGNATURE" });

    await expect(
      receiveSecurePdf(pdfRequest(malformed), {
        temporaryRoot: uploadRoot,
        maximumBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "PDF_TOO_LARGE" });
    expect(await readdir(uploadRoot)).toEqual([]);
    database.close();
  });

  it("removes partial uploads after timeout or cancellation", async () => {
    const uploadRoot = await temporaryDirectory("spendlens-upload-interrupted");
    await expect(
      receiveSecurePdf(streamingPdfRequest(new ReadableStream()), {
        temporaryRoot: uploadRoot,
        timeoutMs: 5,
      }),
    ).rejects.toThrow("timed out");
    expect(await readdir(uploadRoot)).toEqual([]);

    const controller = new AbortController();
    const cancelled = receiveSecurePdf(
      streamingPdfRequest(new ReadableStream(), controller.signal),
      { temporaryRoot: uploadRoot, timeoutMs: 1_000 },
    );
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled");
    expect(await readdir(uploadRoot)).toEqual([]);
  });
});

async function databaseFixture(): Promise<EncryptedDatabase> {
  const directory = await temporaryDirectory("spendlens-import-db");
  const database = await createEncryptedDatabase({
    filePath: join(directory, "spendlens.db"),
    keyProvider: new MemoryKeyProvider(),
  });
  database.sqlite
    .prepare(
      `INSERT INTO workspaces
        (id, name, timezone, created_at, updated_at)
       VALUES ('workspace', 'Sanitized fixture', 'Africa/Lagos', 1, 1)`,
    )
    .run();
  return database;
}

function pdfRequest(bytes: Uint8Array): Request {
  return new Request("http://localhost/api/imports/previews", {
    method: "POST",
    headers: {
      "content-type": "application/pdf",
      "x-spendlens-filename": "sanitized-statement.pdf",
    },
    body: bytes,
  });
}

function streamingPdfRequest(body: ReadableStream, signal?: AbortSignal): Request {
  return new Request("http://localhost/api/imports/previews", {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body,
    signal,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function fixturePath(bytes: Uint8Array): Promise<string> {
  const directory = await temporaryDirectory("spendlens-pdf-fixture");
  const path = join(directory, "statement.pdf");
  await writeFile(path, bytes, { mode: 0o600 });
  return path;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = join("/tmp", `${prefix}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  temporaryPaths.push(directory);
  return directory;
}

import { createHash } from "node:crypto";
import {
  fallbackTransactionFingerprint,
  type ImportPreviewStore,
  type StoredImportPreview,
} from "@spendlens/db";
import { PalmPayStatementParser } from "./palmpay-parser.js";
import { readPositionedPdf } from "./pdf-document.js";
import { selectParser } from "./parser-types.js";
import type { SecurePdfUpload } from "./secure-upload.js";

export class DuplicateImportError extends Error {
  constructor(readonly existingImportId: string) {
    super("This exact statement has already been imported.");
    this.name = "DuplicateImportError";
  }
}

export class ImportPreviewService {
  readonly #store: ImportPreviewStore;

  constructor(store: ImportPreviewStore) {
    this.#store = store;
  }

  get(workspaceId: string, importId: string): StoredImportPreview | null {
    return this.#store.get(workspaceId, importId);
  }

  async create(
    workspaceId: string,
    upload: SecurePdfUpload,
    afterSave?: (importId: string) => void,
  ): Promise<StoredImportPreview> {
    try {
      const duplicate = this.#store.findByFingerprint(workspaceId, upload.fingerprint);
      if (duplicate) throw new DuplicateImportError(duplicate.id);

      const document = await readPositionedPdf(upload.filePath);
      const parser = selectParser(document, [new PalmPayStatementParser()]);
      const statement = parser.parse(document);
      return this.#store.save(
        {
          workspaceId,
          sourceFilename: upload.sourceFilename,
          fileFingerprint: upload.fingerprint,
          adapterKey: parser.key,
          adapterVersion: parser.version,
          institutionName: statement.institutionName,
          maskedAccountNumber: statement.maskedAccountNumber,
          statementStartSource: statement.statementStart,
          statementEndSource: statement.statementEnd,
          sourceTimezone: statement.sourceTimezone,
          declaredInflowMinor: statement.declaredInflowMinor,
          declaredOutflowMinor: statement.declaredOutflowMinor,
          parsedInflowMinor: statement.reconciliation.parsedInflowMinor,
          parsedOutflowMinor: statement.reconciliation.parsedOutflowMinor,
          reconciliationStatus: statement.reconciliation.status,
          rows: statement.transactions.map((transaction) => ({
            sourceRowIndex: transaction.sourceRowIndex,
            sourceTransactionId: transaction.sourceTransactionId,
            sourceTimestamp: transaction.sourceTimestamp,
            occurredAtUtc: transaction.occurredAtUtc,
            direction: transaction.direction,
            amountMinor: transaction.amountMinor,
            currency: transaction.currency,
            narration: transaction.narration,
            fallbackFingerprint: fallbackTransactionFingerprint(transaction),
            rowFingerprint: rowFingerprint(transaction),
            rawFields: {
              sourcePage: transaction.pageNumber,
              parserKey: parser.key,
              parserVersion: parser.version,
            },
          })),
        },
        afterSave,
      );
    } finally {
      await upload.dispose();
    }
  }
}

function rowFingerprint(transaction: {
  sourceTransactionId: string;
  sourceTimestamp: string;
  direction: string;
  amountMinor: number;
  currency: string;
}): string {
  return createHash("sha256")
    .update(
      [
        "palmpay",
        transaction.sourceTransactionId,
        transaction.sourceTimestamp,
        transaction.direction,
        transaction.amountMinor,
        transaction.currency,
      ].join("\u001f"),
    )
    .digest("hex");
}

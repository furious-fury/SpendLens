import { readFile } from "node:fs/promises";
import { getDocument, PasswordResponses, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  type PositionedPdfDocument,
  type PositionedPdfPage,
  StatementParserError,
} from "./parser-types.js";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;

export async function readPositionedPdf(filePath: string): Promise<PositionedPdfDocument> {
  const bytes = await readFile(filePath);
  if (bytes.byteLength < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new StatementParserError(
      "PDF_INVALID_SIGNATURE",
      "The uploaded file does not have a valid PDF signature.",
    );
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new StatementParserError(
      "PDF_TOO_LARGE",
      `PDF statements must be ${MAX_PDF_BYTES / 1024 / 1024} MB or smaller.`,
    );
  }

  const loadingTask = getDocument({
    data: new Uint8Array(bytes),
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    const pdf = await loadingTask.promise;
    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new StatementParserError(
        "PDF_TOO_MANY_PAGES",
        `PDF statements must contain no more than ${MAX_PDF_PAGES} pages.`,
      );
    }

    const pages: PositionedPdfPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      pages.push({
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        items: content.items
          .filter((item) => "str" in item && item.str.trim().length > 0)
          .map((item) => {
            if (!("str" in item)) throw new Error("Unreachable PDF text item.");
            return {
              text: item.str,
              x: item.transform[4],
              y: item.transform[5],
              width: item.width,
              height: item.height,
            };
          }),
      });
    }
    return { pageCount: pdf.numPages, pages };
  } catch (error) {
    if (error instanceof StatementParserError) throw error;
    throw pdfLoadingError(error);
  } finally {
    await loadingTask.destroy();
  }
}

export function pdfLoadingError(error: unknown): StatementParserError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === PasswordResponses.NEED_PASSWORD ||
      error.code === PasswordResponses.INCORRECT_PASSWORD)
  ) {
    return new StatementParserError(
      "PDF_ENCRYPTED",
      "Password-protected PDF statements are not supported.",
    );
  }
  return new StatementParserError(
    "PDF_MALFORMED",
    "The PDF could not be read. Download a fresh statement and try again.",
  );
}

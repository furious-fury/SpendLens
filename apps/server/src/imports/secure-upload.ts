import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAX_PDF_BYTES } from "./pdf-document.js";
import { StatementParserError } from "./parser-types.js";

const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;

export interface SecurePdfUpload {
  filePath: string;
  sourceFilename: string;
  fingerprint: string;
  size: number;
  dispose(): Promise<void>;
}

export async function receiveSecurePdf(
  request: Request,
  options: {
    temporaryRoot?: string;
    maximumBytes?: number;
    timeoutMs?: number;
  } = {},
): Promise<SecurePdfUpload> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/pdf") {
    throw new StatementParserError(
      "PDF_INVALID_SIGNATURE",
      "Upload the statement with the application/pdf content type.",
    );
  }
  if (!request.body) {
    throw new StatementParserError("PDF_MALFORMED", "The PDF upload is empty.");
  }

  const maximumBytes = options.maximumBytes ?? MAX_PDF_BYTES;
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const directory = await mkdtemp(join(temporaryRoot, "spendlens-upload-"));
  await chmod(directory, 0o700);
  const filePath = join(directory, "statement.pdf");
  const file = await open(filePath, "wx", 0o600);
  const reader = request.body.getReader();
  const hash = createHash("sha256");
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
  let size = 0;

  try {
    while (true) {
      if (request.signal.aborted || Date.now() > deadline) {
        await reader.cancel();
        throw uploadInterrupted(request.signal.aborted);
      }
      const chunk = await readBeforeDeadline(reader, deadline, request.signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new StatementParserError(
          "PDF_TOO_LARGE",
          `PDF statements must be ${maximumBytes / 1024 / 1024} MB or smaller.`,
        );
      }
      hash.update(chunk.value);
      await file.writeFile(chunk.value);
    }
    if (size === 0) {
      throw new StatementParserError("PDF_MALFORMED", "The PDF upload is empty.");
    }
    await file.sync();
    await file.close();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await file.close().catch(() => undefined);
    await rm(directory, { force: true, recursive: true });
    throw error;
  }

  let disposed = false;
  return {
    filePath,
    sourceFilename: safeFilename(request.headers.get("x-spendlens-filename")),
    fingerprint: hash.digest("hex"),
    size,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(directory, { force: true, recursive: true });
    },
  };
}

async function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadline: number,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  const remaining = Math.max(1, deadline - Date.now());
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(uploadInterrupted(false)), remaining);
        onAbort = () => reject(uploadInterrupted(true));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function uploadInterrupted(cancelled: boolean): StatementParserError {
  return new StatementParserError(
    "PDF_MALFORMED",
    cancelled ? "The PDF upload was cancelled." : "The PDF upload timed out.",
  );
}

function safeFilename(value: string | null): string {
  if (!value) return "statement.pdf";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    decoded = value;
  }
  const cleaned = basename(decoded)
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .slice(0, 180);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : "statement.pdf";
}

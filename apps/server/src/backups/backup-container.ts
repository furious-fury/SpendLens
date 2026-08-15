import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, open, rename, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { BackupManifest, BackupKind } from "@spendlens/contracts";
import { BackupManifestSchema } from "@spendlens/contracts";

const MAGIC = Buffer.from("SPENDLENS-BACKUP\n", "ascii");
const MANIFEST_LENGTH_BYTES = 4;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface BackupManifestInput {
  workspaceId: string;
  createdAt: string;
  applicationVersion: string;
  schemaVersion: string;
  latestMigrationId: string;
  kind: BackupKind;
  durableWorkspaceDigest: string;
  exclusions: string[];
}

export interface ParsedBackup {
  manifest: BackupManifest;
  payloadOffset: number;
}

export async function writeBackupContainer(
  outputPath: string,
  payloadPath: string,
  databaseKey: Buffer,
  input: BackupManifestInput,
): Promise<BackupManifest> {
  const payload = await stat(payloadPath);
  const payloadSha256 = await hashFile(payloadPath);
  const unsigned = {
    type: "spendlens-backup" as const,
    formatVersion: 1 as const,
    ...input,
    payloadSize: payload.size,
    payloadSha256,
  };
  const authenticationHmac = authenticateManifest(unsigned, databaseKey);
  const manifest = BackupManifestSchema.parse({ ...unsigned, authenticationHmac });
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error("Backup manifest is too large.");
  const length = Buffer.alloc(MANIFEST_LENGTH_BYTES);
  length.writeUInt32BE(bytes.length);
  const partialPath = `${outputPath}.partial`;
  const handle = await open(partialPath, "wx", 0o600);
  try {
    await handle.write(Buffer.concat([MAGIC, length, bytes]));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await pipeline(createReadStream(payloadPath), createWriteStream(partialPath, { flags: "a" }));
  const finalHandle = await open(partialPath, "r+");
  try {
    await finalHandle.sync();
  } finally {
    await finalHandle.close();
  }
  await chmod(partialPath, 0o600);
  await rename(partialPath, outputPath);
  return manifest;
}

export async function parseBackupContainer(path: string): Promise<ParsedBackup> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(MAGIC.length + MANIFEST_LENGTH_BYTES);
    const headerRead = await file.read(header, 0, header.length, 0);
    if (headerRead.bytesRead !== header.length || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("BACKUP_INVALID_FORMAT");
    }
    const manifestLength = header.readUInt32BE(MAGIC.length);
    if (manifestLength <= 0 || manifestLength > MAX_MANIFEST_BYTES) {
      throw new Error("BACKUP_INVALID_FORMAT");
    }
    const manifestBytes = Buffer.alloc(manifestLength);
    const result = await file.read(manifestBytes, 0, manifestLength, header.length);
    if (result.bytesRead !== manifestLength) throw new Error("BACKUP_INVALID_FORMAT");
    const manifest = BackupManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
    const payloadOffset = header.length + manifestLength;
    const fileStat = await file.stat();
    if (fileStat.size - payloadOffset !== manifest.payloadSize) {
      throw new Error("BACKUP_DIGEST_MISMATCH");
    }
    return { manifest, payloadOffset };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("BACKUP_INVALID_FORMAT");
    throw error;
  } finally {
    await file.close();
  }
}

export async function verifyBackupContainer(
  path: string,
  databaseKey: Buffer,
): Promise<ParsedBackup> {
  const parsed = await parseBackupContainer(path);
  const actualDigest = await hashFile(path, parsed.payloadOffset);
  if (!safeHexEqual(actualDigest, parsed.manifest.payloadSha256)) {
    throw new Error("BACKUP_DIGEST_MISMATCH");
  }
  const { authenticationHmac, ...unsigned } = parsed.manifest;
  const expected = authenticateManifest(unsigned, databaseKey);
  if (!safeHexEqual(expected, authenticationHmac)) {
    throw new Error("BACKUP_AUTHENTICATION_FAILED");
  }
  return parsed;
}

export async function extractBackupPayload(
  backupPath: string,
  destinationPath: string,
  payloadOffset: number,
): Promise<void> {
  await pipeline(
    createReadStream(backupPath, { start: payloadOffset }),
    createWriteStream(destinationPath, { flags: "wx", mode: 0o600 }),
  );
}

function authenticateManifest(
  manifest: Omit<BackupManifest, "authenticationHmac">,
  databaseKey: Buffer,
): string {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      databaseKey,
      Buffer.from(manifest.workspaceId, "utf8"),
      Buffer.from("spendlens-backup-auth-v1", "utf8"),
      32,
    ),
  );
  try {
    return createHmac("sha256", key).update(canonicalJson(manifest)).digest("hex");
  } finally {
    key.fill(0);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hashFile(path: string, start = 0): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { start })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

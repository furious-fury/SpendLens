import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseBackupContainer,
  verifyBackupContainer,
  writeBackupContainer,
} from "../src/backups/backup-container.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("backup container", () => {
  it("round-trips a canonical authenticated manifest", async () => {
    const directory = await temporaryDirectory();
    const payloadPath = join(directory, "payload.db");
    const backupPath = join(directory, "workspace.slbackup");
    const key = Buffer.alloc(32, 5);
    await writeFile(payloadPath, Buffer.from("encrypted-payload-placeholder"));
    const manifest = await writeBackupContainer(backupPath, payloadPath, key, {
      workspaceId: "10000000-0000-4000-8000-000000000001",
      createdAt: "2026-08-03T10:00:00.000Z",
      applicationVersion: "0.1.0",
      schemaVersion: "0009_backup_restore_upgrades",
      latestMigrationId: "0009_backup_restore_upgrades",
      kind: "manual",
      durableWorkspaceDigest: "d".repeat(64),
      exclusions: ["sessions"],
    });
    expect(manifest.authenticationHmac).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyBackupContainer(backupPath, key)).resolves.toMatchObject({
      manifest: { workspaceId: manifest.workspaceId },
    });
    await expect(verifyBackupContainer(backupPath, Buffer.alloc(32, 6))).rejects.toThrow(
      "BACKUP_AUTHENTICATION_FAILED",
    );
    expect((await parseBackupContainer(backupPath)).payloadOffset).toBeGreaterThan(20);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    `spendlens-container-${crypto.randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  paths.push(directory);
  return directory;
}

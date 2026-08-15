import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nextTwoAm } from "../src/backups/backup-scheduler.js";
import { retainedBackupIds } from "../src/backups/backup-service.js";
import {
  MaintenanceConflictError,
  MaintenanceCoordinator,
} from "../src/backups/maintenance-coordinator.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("backup scheduling and maintenance", () => {
  it("calculates the next 02:00 in the workspace timezone", () => {
    expect(nextTwoAm(new Date("2026-08-03T00:30:00.000Z"), "Africa/Lagos").toISOString()).toBe(
      "2026-08-03T01:00:00.000Z",
    );
    expect(nextTwoAm(new Date("2026-08-03T00:59:30.000Z"), "Africa/Lagos").toISOString()).toBe(
      "2026-08-03T01:00:00.000Z",
    );
  });

  it("retains daily, weekly, monthly, and the newest valid backup", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    const backups = Array.from({ length: 450 }, (_, index) => ({
      id: `backup-${index}`,
      createdAt: new Date(now.getTime() - index * 86_400_000),
    }));
    const retained = retainedBackupIds(backups, now);
    expect(retained.has("backup-0")).toBe(true);
    expect(retained.size).toBeLessThanOrEqual(23);
    expect(retained.size).toBeGreaterThanOrEqual(12);
  });

  it("rejects a live maintenance lock and clears a stale lock", async () => {
    const directory = await temporaryDirectory();
    const lockPath = join(directory, "maintenance.lock");
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, operation: "backup" }));
    const coordinator = new MaintenanceCoordinator(lockPath);
    await expect(coordinator.run("restore", async () => undefined)).rejects.toBeInstanceOf(
      MaintenanceConflictError,
    );
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, operation: "backup" }));
    await expect(coordinator.run("restore", async () => "ok")).resolves.toBe("ok");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    `spendlens-maintenance-${crypto.randomUUID()}`,
  );
  await mkdir(directory, { recursive: true });
  paths.push(directory);
  return directory;
}

import {
  BackupManifestSchema,
  BackupStatusSchema,
  ManualBackupRequestSchema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

describe("backup contracts", () => {
  it("accepts the versioned authenticated backup manifest", () => {
    expect(
      BackupManifestSchema.parse({
        type: "spendlens-backup",
        formatVersion: 1,
        workspaceId: "10000000-0000-4000-8000-000000000001",
        createdAt: "2026-08-03T10:00:00.000Z",
        applicationVersion: "0.1.0",
        schemaVersion: "0009_backup_restore_upgrades",
        latestMigrationId: "0009_backup_restore_upgrades",
        kind: "manual",
        payloadSize: 4096,
        payloadSha256: "a".repeat(64),
        durableWorkspaceDigest: "b".repeat(64),
        exclusions: ["sessions", "jobs"],
        authenticationHmac: "c".repeat(64),
      }),
    ).toMatchObject({ formatVersion: 1, kind: "manual" });
  });

  it("keeps retention and recovery-location warnings explicit", () => {
    expect(
      BackupStatusSchema.parse({
        scheduleEnabled: false,
        backupDirectoryConfigured: false,
        sameVolumeWarning: false,
        recoveryStorageVerified: false,
        lastSuccessfulAt: null,
        nextScheduledAt: null,
        retention: { daily: 7, weekly: 4, monthly: 12 },
        items: [],
      }),
    ).toMatchObject({ recoveryStorageVerified: false });
  });

  it("requires reauthentication for manual backup requests", () => {
    expect(ManualBackupRequestSchema.safeParse({ password: "" }).success).toBe(false);
    expect(ManualBackupRequestSchema.safeParse({ password: "valid password" }).success).toBe(true);
  });
});

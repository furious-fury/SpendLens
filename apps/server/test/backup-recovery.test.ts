import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AnalyticsEngine,
  createEncryptedDatabase,
  ImportPreviewStore,
  ImportReconciliationStore,
  MemoryKeyProvider,
  openEncryptedDatabase,
  sessions,
  users,
  workspaces,
} from "@spendlens/db";
import { hash, verify } from "argon2";
import { afterEach, describe, expect, it } from "vitest";
import { BackupService, durableDigest } from "../src/backups/backup-service.js";
import { extractBackupPayload, verifyBackupContainer } from "../src/backups/backup-container.js";
import { MaintenanceCoordinator } from "../src/backups/maintenance-coordinator.js";
import {
  recoverInterruptedRestore,
  restorePortableBackup,
  verifyPortableBackup,
} from "../src/backups/restore-service.js";
import { createRecoveryKit } from "../src/security/crypto.js";

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("portable encrypted backups", () => {
  it("creates an authenticated encrypted artifact without transient sessions", async () => {
    const fixture = await backupFixture();
    const created = await fixture.backups.createManual();
    const parsed = await verifyBackupContainer(created.path, fixture.database.key);
    expect(parsed.manifest).toMatchObject({
      type: "spendlens-backup",
      workspaceId: fixture.workspaceId,
      kind: "manual",
      schemaVersion: "0009_backup_restore_upgrades",
    });

    const extracted = join(fixture.directory, "extracted.db");
    await extractBackupPayload(created.path, extracted, parsed.payloadOffset);
    await expect(
      openEncryptedDatabase({
        filePath: extracted,
        keyProvider: new MemoryKeyProvider(Buffer.alloc(32, 7)),
        migrate: false,
      }),
    ).rejects.toThrow("could not be opened");
    const restored = await openEncryptedDatabase({
      filePath: extracted,
      keyProvider: new MemoryKeyProvider(fixture.database.key),
      migrate: false,
    });
    expect(restored.sqlite.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
      count: 0,
    });
    expect(restored.sqlite.prepare("SELECT count(*) AS count FROM users").get()).toEqual({
      count: 1,
    });
    restored.close();
    fixture.database.close();
  });

  it("rejects corruption and the wrong database key", async () => {
    const fixture = await backupFixture();
    const created = await fixture.backups.createManual();
    await expect(verifyBackupContainer(created.path, Buffer.alloc(32, 4))).rejects.toThrow(
      "BACKUP_AUTHENTICATION_FAILED",
    );
    const bytes = await readFile(created.path);
    const finalIndex = bytes.length - 1;
    bytes[finalIndex] = (bytes[finalIndex] ?? 0) ^ 0xff;
    await writeFile(created.path, bytes);
    await expect(verifyBackupContainer(created.path, fixture.database.key)).rejects.toThrow(
      "BACKUP_DIGEST_MISMATCH",
    );
    fixture.database.close();
  });

  it("restores a wiped workspace with separate recovery material", async () => {
    const fixture = await backupFixture();
    const created = await fixture.backups.createManual();
    const expectedDigest = (await verifyBackupContainer(created.path, fixture.database.key))
      .manifest.durableWorkspaceDigest;
    const recovery = await createRecoveryKit(fixture.workspaceId, fixture.database.key);
    fixture.database.close();

    const targetDirectory = await temporaryDirectory("restore-target");
    const targetPath = join(targetDirectory, "spendlens.db");
    const provider = new MemoryKeyProvider();
    await expect(
      verifyPortableBackup({
        backupPath: created.path,
        recoveryFile: recovery.recoveryFile,
        recoveryCode: recovery.recoveryCode,
        workDirectory: join(targetDirectory, "verify"),
      }),
    ).resolves.toMatchObject({ workspaceId: fixture.workspaceId });
    await restorePortableBackup({
      backupPath: created.path,
      recoveryFile: recovery.recoveryFile,
      recoveryCode: recovery.recoveryCode,
      workDirectory: join(targetDirectory, "verify"),
      databasePath: targetPath,
      dataDirectory: targetDirectory,
      keyProvider: provider,
      replaceExisting: false,
      coordinator: new MaintenanceCoordinator(join(targetDirectory, "maintenance.lock")),
    });
    const restored = await openEncryptedDatabase({ filePath: targetPath, keyProvider: provider });
    const owner = restored.db.select().from(users).get();
    expect(owner?.displayName).toBe("Backup Owner");
    expect(await verify(owner?.passwordHash ?? "", "correct horse battery staple")).toBe(true);
    expect(restored.sqlite.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
      count: 0,
    });
    expect(durableDigest(restored)).toBe(expectedDigest);

    const restoredAccountId = crypto.randomUUID();

    restored.sqlite
      .prepare(`INSERT INTO accounts (
      id, workspace_id, institution_name, institution_code, display_name,
      account_type, base_currency, created_at, updated_at
    ) VALUES (?, ?, 'PalmPay', 'palmpay', 'Restored PalmPay', 'wallet', 'NGN', ?, ?)`)
      .run(restoredAccountId, fixture.workspaceId, Date.now(), Date.now());
    const analytics = new AnalyticsEngine(restored.sqlite).query(fixture.workspaceId, {
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      currency: "NGN",
      accountIds: [restoredAccountId],
      scopes: ["personal", "business"],
      metricIds: ["cashflow.net"],
      comparison: { mode: "none" },
      excludeInternalTransfers: true,
      useCache: false,
    });
    expect(analytics.metrics).toHaveLength(1);

    const preview = new ImportPreviewStore(restored.sqlite).save({
      workspaceId: fixture.workspaceId,
      sourceFilename: "after-restore.pdf",
      fileFingerprint: "a".repeat(64),
      adapterKey: "palmpay-ng-pdf",
      adapterVersion: "1.0.0",
      institutionName: "PalmPay",
      maskedAccountNumber: null,
      statementStartSource: "2026-08-01",
      statementEndSource: "2026-08-31",
      sourceTimezone: "Africa/Lagos",
      declaredInflowMinor: 0,
      declaredOutflowMinor: 1_000,
      parsedInflowMinor: 0,
      parsedOutflowMinor: 1_000,
      reconciliationStatus: "matched",
      rows: [
        {
          sourceRowIndex: 0,
          sourceTransactionId: "after-restore-1",
          sourceTimestamp: "2026-08-15 12:00:00",
          occurredAtUtc: new Date("2026-08-15T11:00:00.000Z"),
          direction: "debit",
          amountMinor: 1_000,
          currency: "NGN",
          narration: "Post-restore import",
          fallbackFingerprint: "b".repeat(64),
          rowFingerprint: "c".repeat(64),
          rawFields: {},
        },
      ],
    });
    const reconciler = new ImportReconciliationStore(restored.sqlite);
    reconciler.analyze({
      workspaceId: fixture.workspaceId,
      importId: preview.id,
      accountId: restoredAccountId,
    });
    expect(
      reconciler.commit({
        workspaceId: fixture.workspaceId,
        importId: preview.id,
        confirmUnreconciled: false,
      }).status,
    ).toBe("committed");
    restored.close();
  });

  it("rejects invalid recovery material and insufficient restore space without creating a workspace", async () => {
    const fixture = await backupFixture();
    const created = await fixture.backups.createManual();
    const recovery = await createRecoveryKit(fixture.workspaceId, fixture.database.key);
    const wrongCode = `${recovery.recoveryCode.slice(0, -1)}${recovery.recoveryCode.endsWith("A") ? "B" : "A"}`;
    await expect(
      verifyPortableBackup({
        backupPath: created.path,
        recoveryFile: recovery.recoveryFile,
        recoveryCode: wrongCode,
        workDirectory: join(fixture.directory, "wrong-code"),
      }),
    ).rejects.toThrow();

    const wrongRecovery = await createRecoveryKit(crypto.randomUUID(), fixture.database.key);
    await expect(
      verifyPortableBackup({
        backupPath: created.path,
        recoveryFile: wrongRecovery.recoveryFile,
        recoveryCode: wrongRecovery.recoveryCode,
        workDirectory: join(fixture.directory, "wrong-recovery"),
      }),
    ).rejects.toThrow("BACKUP_WORKSPACE_MISMATCH");
    fixture.database.close();

    const targetDirectory = await temporaryDirectory("insufficient-space");
    const targetPath = join(targetDirectory, "spendlens.db");
    const provider = new MemoryKeyProvider();
    await expect(
      restorePortableBackup({
        backupPath: created.path,
        recoveryFile: recovery.recoveryFile,
        recoveryCode: recovery.recoveryCode,
        workDirectory: join(targetDirectory, "verify"),
        databasePath: targetPath,
        dataDirectory: targetDirectory,
        keyProvider: provider,
        replaceExisting: false,
        coordinator: new MaintenanceCoordinator(join(targetDirectory, "maintenance.lock")),
        availableBytes: 0n,
      }),
    ).rejects.toThrow("BACKUP_INSUFFICIENT_SPACE");
    await expect(stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(provider.load()).resolves.toBeNull();
  });

  it("rolls back an interrupted restore to the last openable encrypted workspace", async () => {
    const directory = await temporaryDirectory("interrupted-restore");
    const databasePath = join(directory, "spendlens.db");
    const rollbackPath = join(directory, "rollback.db");
    const interruptedPath = join(directory, "interrupted.db");
    const provider = new MemoryKeyProvider();
    const original = await createEncryptedDatabase({
      filePath: databasePath,
      keyProvider: provider,
    });
    original.sqlite.exec("CREATE TABLE recovery_marker (value TEXT NOT NULL)");
    original.sqlite.prepare("INSERT INTO recovery_marker VALUES ('original')").run();
    original.close();
    await rename(databasePath, rollbackPath);

    const replacement = await createEncryptedDatabase({
      filePath: databasePath,
      keyProvider: new MemoryKeyProvider(),
    });
    replacement.close();
    await writeFile(
      join(directory, "restore-journal.json"),
      JSON.stringify({
        version: 1,
        databasePath,
        rollbackPath,
        interruptedPath,
        phase: "database-swapped",
      }),
    );

    await expect(
      recoverInterruptedRestore({ dataDirectory: directory, keyProvider: provider }),
    ).resolves.toBe("rolled-back");
    const recovered = await openEncryptedDatabase({
      filePath: databasePath,
      keyProvider: provider,
    });
    expect(recovered.sqlite.prepare("SELECT value FROM recovery_marker").get()).toEqual({
      value: "original",
    });
    recovered.close();
  });

  it("creates a transactionally valid snapshot while background activity is scheduled", async () => {
    const fixture = await backupFixture();
    const accountId = crypto.randomUUID();
    const createBackup = fixture.backups.createManual();
    const backgroundWrite = Promise.resolve().then(() => {
      fixture.database.sqlite
        .prepare(`INSERT INTO accounts (
        id, workspace_id, institution_name, display_name, account_type,
        base_currency, created_at, updated_at
      ) VALUES (?, ?, 'PalmPay', 'Background account', 'wallet', 'NGN', ?, ?)`)
        .run(accountId, fixture.workspaceId, Date.now(), Date.now());
    });
    const [created] = await Promise.all([createBackup, backgroundWrite]);
    const parsed = await verifyBackupContainer(created.path, fixture.database.key);
    const extracted = join(fixture.directory, "concurrent-snapshot.db");
    await extractBackupPayload(created.path, extracted, parsed.payloadOffset);
    const snapshot = await openEncryptedDatabase({
      filePath: extracted,
      keyProvider: new MemoryKeyProvider(fixture.database.key),
      migrate: false,
    });
    expect(snapshot.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    const accountCount = snapshot.sqlite
      .prepare("SELECT count(*) AS count FROM accounts WHERE id = ?")
      .get(accountId) as { count: number };
    expect([0, 1]).toContain(accountCount.count);
    snapshot.close();
    fixture.database.close();
  });
});

async function backupFixture() {
  const directory = await temporaryDirectory("backup");
  const databasePath = join(directory, "spendlens.db");
  const database = await createEncryptedDatabase({
    filePath: databasePath,
    keyProvider: new MemoryKeyProvider(),
  });
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const now = new Date("2026-08-03T10:00:00.000Z");
  database.db
    .insert(workspaces)
    .values({
      id: workspaceId,
      name: "Backup test",
      timezone: "Africa/Lagos",
      setupCompletedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(users)
    .values({
      id: userId,
      workspaceId,
      username: "owner",
      displayName: "Backup Owner",
      passwordHash: await hash("correct horse battery staple"),
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  database.db
    .insert(sessions)
    .values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: "token",
      csrfTokenHash: "csrf",
      expiresAt: new Date(now.getTime() + 60_000),
      lastSeenAt: now,
      createdAt: now,
    })
    .run();
  const coordinator = new MaintenanceCoordinator(join(directory, "maintenance.lock"));
  const backups = new BackupService({
    database: () => database,
    dataDirectory: directory,
    applicationVersion: "0.1.0",
    coordinator,
    clock: () => now.getTime(),
  });
  return { directory, database, workspaceId, backups };
}

async function temporaryDirectory(label: string): Promise<string> {
  const directory = join(process.env.TMPDIR ?? "/tmp", `spendlens-${label}-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  paths.push(directory);
  return directory;
}

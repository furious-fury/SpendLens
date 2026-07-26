import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import type { RecoveryFile } from "@spendlens/contracts";
import {
  type DatabaseKeyProvider,
  databaseExists,
  openEncryptedDatabase,
  securityEvents,
  sessions,
  users,
} from "@spendlens/db";
import { eq } from "drizzle-orm";
import { hashPassword, unwrapDatabaseKey } from "./crypto.js";

export interface RecoverWorkspaceOptions {
  databasePath: string;
  recoveryFile: RecoveryFile;
  recoveryCode: string;
  newPassword: string;
  keyProvider: DatabaseKeyProvider;
  backupPath?: string;
  clock?: () => number;
}

export interface RecoverWorkspaceResult {
  backupPath: string;
}

export async function recoverWorkspace(
  options: RecoverWorkspaceOptions,
): Promise<RecoverWorkspaceResult> {
  if (!(await databaseExists(options.databasePath))) {
    throw new Error("The encrypted database backup does not exist.");
  }

  const clock = options.clock ?? Date.now;
  const databaseKey = await unwrapDatabaseKey(options.recoveryFile, options.recoveryCode);
  const previousProviderKey = await options.keyProvider.load();
  const providerAlreadyMatches = previousProviderKey?.equals(databaseKey) ?? false;

  if (!providerAlreadyMatches) {
    await options.keyProvider.save(databaseKey);
  }

  const backupPath =
    options.backupPath ??
    `${options.databasePath}.pre-recovery-${new Date(clock()).toISOString().replaceAll(":", "-")}`;

  try {
    let database = await openEncryptedDatabase({
      filePath: options.databasePath,
      keyProvider: options.keyProvider,
    });
    database.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    database.close();
    await copyFile(options.databasePath, backupPath, constants.COPYFILE_EXCL);

    database = await openEncryptedDatabase({
      filePath: options.databasePath,
      keyProvider: options.keyProvider,
    });
    try {
      const user = database.db.select().from(users).limit(1).get();
      if (!user) {
        throw new Error("The encrypted database does not contain a SpendLens owner.");
      }

      const now = new Date(clock());
      const passwordHash = await hashPassword(options.newPassword);
      database.sqlite.transaction(() => {
        database.db
          .update(users)
          .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
          .where(eq(users.id, user.id))
          .run();
        database.db.delete(sessions).run();
        database.db
          .insert(securityEvents)
          .values({
            id: randomUUID(),
            workspaceId: user.workspaceId,
            userId: user.id,
            eventType: "auth.maintenance_recovery",
            outcome: "success",
            createdAt: now,
          })
          .run();
      })();
    } finally {
      database.close();
    }

    return { backupPath };
  } catch (error) {
    if (!providerAlreadyMatches) {
      if (previousProviderKey) {
        await options.keyProvider.save(previousProviderKey);
      } else {
        await options.keyProvider.remove();
      }
    }
    throw error;
  } finally {
    databaseKey.fill(0);
    previousProviderKey?.fill(0);
  }
}

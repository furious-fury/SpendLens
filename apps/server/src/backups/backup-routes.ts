import { readFile } from "node:fs/promises";
import { apiPaths, ManualBackupRequestSchema } from "@spendlens/contracts";
import { Hono } from "hono";
import type { AppEnv } from "../api/request-context.js";
import { AppError } from "../api/app-error.js";
import type { SecurityService } from "../security/security-service.js";
import { BACKUP_MIME_TYPE, type BackupService } from "./backup-service.js";
import { MaintenanceConflictError } from "./maintenance-coordinator.js";

export function createBackupRoutes(options: {
  backups: BackupService;
  security: SecurityService;
  nextScheduledAt?: () => Date | null;
}) {
  const routes = new Hono<AppEnv>();

  routes.get(apiPaths.backupStatus, async (context) =>
    context.json(await options.backups.status(options.nextScheduledAt?.() ?? null)),
  );

  routes.get(apiPaths.backups, async (context) =>
    context.json({ items: await options.backups.list() }),
  );

  routes.post(apiPaths.manualBackup, async (context) => {
    const input = parseManualRequest(await context.req.json());
    await options.security.reauthenticate(context.get("session"), input.password);
    try {
      const created = await options.backups.createManual();
      const body = await readFile(created.path);
      await options.backups.consumeManual(created.record.id);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": BACKUP_MIME_TYPE,
          "content-disposition": `attachment; filename="${created.filename}"`,
          "cache-control": "no-store",
          "x-spendlens-backup-id": created.record.id,
        },
      });
    } catch (error) {
      throw asBackupError(error);
    }
  });

  routes.post(apiPaths.downloadBackup(":backupId"), async (context) => {
    const input = parseManualRequest(await context.req.json());
    await options.security.reauthenticate(context.get("session"), input.password);
    try {
      const backupId = context.req.param("backupId");
      if (!backupId)
        throw new AppError(
          "backup",
          "BACKUP_NOT_FOUND",
          "The requested backup is not available.",
          404,
        );
      const download = await options.backups.resolveDownload(backupId);
      return new Response(await readFile(download.path), {
        headers: {
          "content-type": BACKUP_MIME_TYPE,
          "content-disposition": `attachment; filename="${download.filename}"`,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      throw asBackupError(error);
    }
  });

  return routes;
}

function parseManualRequest(value: unknown) {
  const result = ManualBackupRequestSchema.safeParse(value);
  if (!result.success) {
    throw AppError.validation("VALIDATION_FAILED", "Enter your current password and try again.", {
      password: result.error.issues.map((issue) => issue.message),
    });
  }
  return result.data;
}

function asBackupError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof MaintenanceConflictError) {
    return new AppError("backup", "MAINTENANCE_CONFLICT", error.message, 409, {
      retryable: true,
    });
  }
  const code =
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "BACKUP_FAILED";
  const status =
    code === "BACKUP_NOT_FOUND" ? 404 : code === "BACKUP_INSUFFICIENT_SPACE" ? 422 : 500;
  return new AppError("backup", code, backupMessage(code), status);
}

function backupMessage(code: string): string {
  switch (code) {
    case "BACKUP_NOT_FOUND":
      return "The requested backup is not available.";
    case "BACKUP_INSUFFICIENT_SPACE":
      return "There is not enough free space to create a safe backup.";
    case "BACKUP_DIRECTORY_NOT_CONFIGURED":
      return "Configure a backup directory before enabling scheduled backups.";
    default:
      return "SpendLens could not create or read the encrypted backup.";
  }
}

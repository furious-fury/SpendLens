import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RecoveryFileSchema } from "@spendlens/contracts";
import { loadSecurityRuntimeConfig } from "../security/runtime-config.js";
import { MaintenanceCoordinator } from "./maintenance-coordinator.js";
import { restorePortableBackup, verifyPortableBackup } from "./restore-service.js";

const [command, ...rawArguments] = process.argv.slice(2);
const arguments_ = rawArguments.filter((argument) => argument !== "--");

try {
  if (command === "verify") await verify(arguments_);
  else if (command === "restore") await restore(arguments_);
  else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "The backup command failed.";
  process.stderr.write(`SpendLens backup command failed: ${message}\n`);
  process.exitCode = 1;
}

async function verify(arguments_: string[]): Promise<void> {
  const config = loadSecurityRuntimeConfig();
  const input = await backupInput(arguments_);
  const manifest = await verifyPortableBackup({
    ...input,
    workDirectory: resolve(config.dataDirectory, "backup-verify"),
  });
  process.stdout.write(
    `Backup verified for workspace ${manifest.workspaceId} (${manifest.schemaVersion}, ${manifest.createdAt}).\n`,
  );
}

async function restore(arguments_: string[]): Promise<void> {
  const config = loadSecurityRuntimeConfig();
  const input = await backupInput(arguments_);
  const replaceExisting = arguments_.includes("--replace-existing");
  const confirmedWorkspaceId =
    option(arguments_, "--confirm-workspace") ?? process.env.SPENDLENS_RESTORE_CONFIRM_WORKSPACE_ID;
  delete process.env.SPENDLENS_RESTORE_CONFIRM_WORKSPACE_ID;
  const manifest = await restorePortableBackup({
    ...input,
    databasePath: config.databasePath,
    dataDirectory: config.dataDirectory,
    workDirectory: resolve(config.dataDirectory, "backup-verify"),
    keyProvider: config.keyProvider,
    replaceExisting,
    ...(confirmedWorkspaceId ? { confirmedWorkspaceId } : {}),
    coordinator: new MaintenanceCoordinator(config.maintenanceLockPath),
  });
  process.stdout.write(
    `Workspace ${manifest.workspaceId} restored. Start SpendLens and sign in with the password stored in the backup.\n`,
  );
}

async function backupInput(arguments_: string[]) {
  const backupPath = option(arguments_, "--backup");
  const recoveryFilePath = option(arguments_, "--recovery-file");
  if (!backupPath) throw new Error("Provide --backup <path>.");
  if (!recoveryFilePath) throw new Error("Provide --recovery-file <path>.");
  const recoveryFile = RecoveryFileSchema.parse(
    JSON.parse(await readFile(resolve(recoveryFilePath), "utf8")),
  );
  const recoveryCode = await readSecret("Recovery code: ", "SPENDLENS_BACKUP_RECOVERY_CODE");
  return {
    backupPath: resolve(backupPath),
    recoveryFile,
    recoveryCode,
  };
}

function option(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

async function readSecret(label: string, environmentName: string): Promise<string> {
  const fromEnvironment = process.env[environmentName];
  delete process.env[environmentName];
  if (fromEnvironment) return fromEnvironment;
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error(`${environmentName} is required when no interactive terminal is available.`);
  }
  process.stdout.write(label);
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolveSecret, reject) => {
    let value = "";
    const finish = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of chunk.toString()) {
        if (character === "\r" || character === "\n") {
          finish();
          resolveSecret(value);
          return;
        }
        if (character === "\u0003") {
          finish();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
  });
}

function usage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  pnpm backup:verify -- --backup <file> --recovery-file <file>",
      "  pnpm backup:restore -- --backup <file> --recovery-file <file> [--replace-existing --confirm-workspace <id>]",
      "",
    ].join("\n"),
  );
}

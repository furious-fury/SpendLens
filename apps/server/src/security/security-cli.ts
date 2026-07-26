import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RecoveryFileSchema } from "@spendlens/contracts";
import { serializeDatabaseKey } from "@spendlens/db";
import { recoverWorkspace } from "./maintenance-recovery.js";
import { loadSecurityRuntimeConfig } from "./runtime-config.js";

const [command, ...rawArguments] = process.argv.slice(2);
const arguments_ = rawArguments.filter((argument) => argument !== "--");

try {
  switch (command) {
    case "setup-token":
      await showSetupToken();
      break;
    case "generate-secret":
      await generateSecret(arguments_[0]);
      break;
    case "recover":
      await recover(arguments_);
      break;
    default:
      usage();
      process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "The security command failed.";
  process.stderr.write(`SpendLens security command failed: ${message}\n`);
  process.exitCode = 1;
}

async function showSetupToken(): Promise<void> {
  const config = loadSecurityRuntimeConfig();
  const token = (await readFile(config.setupTokenPath, "utf8")).trim();
  process.stdout.write(`${token}\n`);
}

async function generateSecret(pathArgument?: string): Promise<void> {
  const config = loadSecurityRuntimeConfig();
  const outputPath = resolve(pathArgument ?? `${config.dataDirectory}/database-key`);
  await writeFile(outputPath, serializeDatabaseKey(randomBytes(32)), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") {
    await chmod(outputPath, 0o600);
  }
  process.stdout.write(`Created a permission-restricted database secret at ${outputPath}\n`);
}

async function recover(arguments_: string[]): Promise<void> {
  const config = loadSecurityRuntimeConfig();
  const databasePath = resolve(option(arguments_, "--database") ?? config.databasePath);
  const recoveryFilePath = option(arguments_, "--recovery-file");
  if (!recoveryFilePath) {
    throw new Error("Provide --recovery-file <path>.");
  }

  const recoveryFile = RecoveryFileSchema.parse(
    JSON.parse(await readFile(resolve(recoveryFilePath), "utf8")),
  );
  const recoveryCode = await readSecret("Recovery code: ", "SPENDLENS_MAINTENANCE_RECOVERY_CODE");
  const newPassword = await readSecret(
    "New SpendLens password: ",
    "SPENDLENS_MAINTENANCE_NEW_PASSWORD",
  );
  const confirmation = await readSecret(
    "Confirm new password: ",
    "SPENDLENS_MAINTENANCE_CONFIRM_PASSWORD",
  );
  if (newPassword !== confirmation) {
    throw new Error("The new passwords do not match.");
  }
  if (newPassword.length < 12 || newPassword.length > 128) {
    throw new Error("The new password must contain between 12 and 128 characters.");
  }

  const result = await recoverWorkspace({
    databasePath,
    recoveryFile,
    recoveryCode,
    newPassword,
    keyProvider: config.keyProvider,
  });
  process.stdout.write(
    `Access credentials were changed. The pre-recovery database is at ${result.backupPath}\n`,
  );
}

function option(arguments_: string[], name: string): string | undefined {
  const index = arguments_.indexOf(name);
  return index >= 0 ? arguments_[index + 1] : undefined;
}

async function readSecret(label: string, environmentName: string): Promise<string> {
  const fromEnvironment = process.env[environmentName];
  delete process.env[environmentName];
  if (fromEnvironment) {
    return fromEnvironment;
  }

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
      const text = chunk.toString();
      for (const character of text) {
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
        if (character === "\u007f") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    input.on("data", onData);
  });
}

function usage(): void {
  process.stderr.write(
    [
      "Usage:",
      "  pnpm security:setup-token",
      "  pnpm security:generate-secret -- [path]",
      "  pnpm security:recover -- --recovery-file <path> [--database <path>]",
      "",
    ].join("\n"),
  );
}

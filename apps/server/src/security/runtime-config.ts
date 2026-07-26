import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OsKeyringProvider, SecretFileKeyProvider } from "@spendlens/db";

export interface SecurityRuntimeConfig {
  dataDirectory: string;
  databasePath: string;
  setupTokenPath: string;
  keyProvider: OsKeyringProvider | SecretFileKeyProvider;
  secureCookies: boolean;
}

export function loadSecurityRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SecurityRuntimeConfig {
  const workspaceRoot = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
  const dataDirectory = resolve(environment.SPENDLENS_DATA_DIR ?? join(workspaceRoot, "data"));
  const databasePath = resolve(
    environment.SPENDLENS_DATABASE_PATH ?? join(dataDirectory, "spendlens.db"),
  );
  const setupTokenPath = resolve(
    environment.SPENDLENS_SETUP_TOKEN_PATH ?? join(dataDirectory, "setup-token"),
  );
  const secretPath = environment.SPENDLENS_DATABASE_KEY_FILE;
  const keyProvider = secretPath
    ? new SecretFileKeyProvider(
        isAbsolute(secretPath) ? secretPath : resolve(workspaceRoot, secretPath),
      )
    : new OsKeyringProvider();

  return {
    dataDirectory,
    databasePath,
    setupTokenPath,
    keyProvider,
    secureCookies: environment.SPENDLENS_SECURE_COOKIES === "true",
  };
}

function findWorkspaceRoot(start: string): string {
  let candidate = resolve(start);
  while (dirname(candidate) !== candidate) {
    if (existsSync(join(candidate, "pnpm-workspace.yaml"))) {
      return candidate;
    }
    candidate = dirname(candidate);
  }
  return process.cwd();
}

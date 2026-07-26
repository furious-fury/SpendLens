import { existsSync } from "node:fs";
import { join } from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
const supportedNode = (major === 22 && minor >= 13) || major === 23 || major === 24;

if (!supportedNode) {
  console.error(
    `SpendLens requires Node.js 22.13 through 24.x. Current version: ${process.version}.`,
  );
  process.exit(1);
}

const commandExtension = process.platform === "win32" ? ".cmd" : "";
const requiredCommands = [
  ["TypeScript", join("node_modules", ".bin", `tsc${commandExtension}`)],
  ["Vite", join("apps", "web", "node_modules", ".bin", `vite${commandExtension}`)],
  ["tsx", join("apps", "server", "node_modules", ".bin", `tsx${commandExtension}`)],
];
const missingCommands = requiredCommands.filter(([, path]) => !existsSync(path));

if (missingCommands.length > 0) {
  const installedForAnotherPlatform =
    process.platform === "win32" &&
    missingCommands.some(([, path]) => existsSync(path.replace(/\.cmd$/, "")));

  console.error("SpendLens dependencies are incomplete for the current operating system.");

  if (installedForAnotherPlatform) {
    console.error(
      "The existing node_modules was created in Linux or WSL, but SpendLens is running in Windows.",
    );
  }

  console.error("\nRun this command from the same terminal you use for `pnpm dev`:\n");
  console.error("  pnpm install --force\n");
  console.error("Do not share the same node_modules installation between Windows and WSL.");
  process.exit(1);
}

console.log(`Development environment ready (${process.version}, ${process.platform}).`);

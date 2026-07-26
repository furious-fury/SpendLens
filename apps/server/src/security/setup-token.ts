import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeEqual } from "./crypto.js";

export class SetupTokenManager {
  constructor(readonly path: string) {}

  async ensure(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

    try {
      await writeFile(this.path, randomBytes(32).toString("hex"), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    if (process.platform !== "win32") {
      await chmod(this.path, 0o600);
    }
  }

  async verify(candidate: string): Promise<boolean> {
    try {
      const expected = (await readFile(this.path, "utf8")).trim();
      return safeEqual(expected, candidate.trim());
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async consume(): Promise<void> {
    await unlink(this.path).catch((error) => {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

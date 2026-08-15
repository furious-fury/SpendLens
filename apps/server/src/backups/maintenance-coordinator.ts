import { open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

export type MaintenanceOperation = "backup" | "restore" | "rekey" | "upgrade";

interface LockRecord {
  pid: number;
  operation: MaintenanceOperation;
  createdAt: string;
}

export class MaintenanceConflictError extends Error {
  constructor(readonly operation: MaintenanceOperation | "unknown") {
    super("Another SpendLens maintenance operation is already running.");
    this.name = "MaintenanceConflictError";
  }
}

export class MaintenanceCoordinator {
  #active: MaintenanceOperation | null = null;
  readonly #listeners = new Set<(operation: MaintenanceOperation | null) => void>();
  readonly #guards = new Set<{ pause(): Promise<void>; resume(): void }>();

  constructor(readonly lockPath: string) {}

  get activeOperation(): MaintenanceOperation | null {
    return this.#active;
  }

  subscribe(listener: (operation: MaintenanceOperation | null) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  registerGuard(guard: { pause(): Promise<void>; resume(): void }): () => void {
    this.#guards.add(guard);
    return () => this.#guards.delete(guard);
  }

  async run<T>(operation: MaintenanceOperation, task: () => Promise<T>): Promise<T> {
    if (this.#active) throw new MaintenanceConflictError(this.#active);
    const release = await this.#acquireFileLock(operation);
    this.#active = operation;
    for (const listener of this.#listeners) listener(operation);
    try {
      await Promise.all([...this.#guards].map((guard) => guard.pause()));
      return await task();
    } finally {
      this.#active = null;
      for (const guard of this.#guards) guard.resume();
      for (const listener of this.#listeners) listener(null);
      await release();
    }
  }

  async #acquireFileLock(operation: MaintenanceOperation): Promise<() => Promise<void>> {
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    const record: LockRecord = { pid: process.pid, operation, createdAt: new Date().toISOString() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
        await handle.close();
        return async () => rm(this.lockPath, { force: true });
      } catch (error) {
        if (!isExistsError(error)) throw error;
        const current = await readLock(this.lockPath);
        if (current && processIsAlive(current.pid)) {
          throw new MaintenanceConflictError(current.operation);
        }
        await rm(this.lockPath, { force: true });
      }
    }
    throw new MaintenanceConflictError("unknown");
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    return typeof value.pid === "number" && typeof value.operation === "string"
      ? (value as LockRecord)
      : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEncryptedDatabase,
  MemoryKeyProvider,
  openEncryptedDatabase,
  OsKeyringProvider,
  SecretFileKeyProvider,
  workspaces,
} from "../src/index.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("encrypted database", () => {
  it("persists schema data and reopens using the key provider", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "spendlens.db");
    const provider = new MemoryKeyProvider();
    const first = await createEncryptedDatabase({ filePath, keyProvider: provider });
    const now = new Date();

    first.db
      .insert(workspaces)
      .values({
        id: "workspace",
        name: "My finances",
        timezone: "Africa/Lagos",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    first.close();

    const reopened = await openEncryptedDatabase({ filePath, keyProvider: provider });
    expect(
      reopened.db.select().from(workspaces).where(eq(workspaces.id, "workspace")).get()?.name,
    ).toBe("My finances");
    reopened.close();
  });

  it("rejects a wrong database key", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "spendlens.db");
    const first = await createEncryptedDatabase({
      filePath,
      keyProvider: new MemoryKeyProvider(),
    });
    first.close();

    await expect(
      openEncryptedDatabase({
        filePath,
        keyProvider: new MemoryKeyProvider(Buffer.alloc(32, 7)),
      }),
    ).rejects.toThrow("could not be opened");
  });

  it("rekeys the database and invalidates the previous key", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "spendlens.db");
    const provider = new MemoryKeyProvider();
    const database = await createEncryptedDatabase({ filePath, keyProvider: provider });
    const previousKey = await provider.load();
    const nextKey = Buffer.alloc(32, 9);

    await database.rekey(nextKey);
    database.close();

    await expect(
      openEncryptedDatabase({
        filePath,
        keyProvider: new MemoryKeyProvider(previousKey),
      }),
    ).rejects.toThrow("could not be opened");

    const reopened = await openEncryptedDatabase({ filePath, keyProvider: provider });
    reopened.close();
  });
});

describe("OS keyring provider", () => {
  it("reopens the encrypted database after a simulated process restart", async () => {
    let password: string | null = null;
    const entry = {
      getPassword: () => password,
      setPassword: (next: string) => {
        password = next;
      },
      deletePassword: () => {
        password = null;
      },
    };
    const firstProcess = new OsKeyringProvider("SpendLens Test", "workspace", entry);
    const directory = await temporaryDirectory();
    const filePath = join(directory, "spendlens.db");
    const firstDatabase = await createEncryptedDatabase({
      filePath,
      keyProvider: firstProcess,
    });
    firstDatabase.close();

    const restartedProcess = new OsKeyringProvider("SpendLens Test", "workspace", entry);
    const reopened = await openEncryptedDatabase({
      filePath,
      keyProvider: restartedProcess,
    });
    expect(reopened.sqlite.prepare("SELECT count(*) AS count FROM workspaces").get()).toEqual({
      count: 0,
    });
    reopened.close();
    await restartedProcess.remove();
    await expect(restartedProcess.load()).resolves.toBeNull();
  });
});

describe("secret file key provider", () => {
  it("loads a permission-restricted mounted secret", async () => {
    const directory = await temporaryDirectory();
    const secretPath = join(directory, "database-key");
    await writeFile(secretPath, "ab".repeat(32), { mode: 0o600 });

    await expect(new SecretFileKeyProvider(secretPath).load()).resolves.toEqual(
      Buffer.from("ab".repeat(32), "hex"),
    );
  });

  it("reopens after restart without browser input", async () => {
    const directory = await temporaryDirectory();
    const secretPath = join(directory, "database-key");
    const filePath = join(directory, "spendlens.db");
    await writeFile(secretPath, "cd".repeat(32), { mode: 0o600 });
    const first = await createEncryptedDatabase({
      filePath,
      keyProvider: new SecretFileKeyProvider(secretPath),
    });
    first.close();

    const restarted = await openEncryptedDatabase({
      filePath,
      keyProvider: new SecretFileKeyProvider(secretPath),
    });
    expect(restarted.sqlite.prepare("SELECT count(*) AS count FROM users").get()).toEqual({
      count: 0,
    });
    restarted.close();
  });

  it.runIf(process.platform !== "win32")("rejects an overly broad file mode", async () => {
    const directory = await temporaryDirectory();
    const secretPath = join(directory, "database-key");
    await writeFile(secretPath, "ab".repeat(32), { mode: 0o600 });
    await chmod(secretPath, 0o644);

    await expect(new SecretFileKeyProvider(secretPath).load()).rejects.toThrow(
      "must not be accessible",
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = join(process.env.TMPDIR ?? "/tmp", `spendlens-db-test-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  temporaryPaths.push(directory);
  return directory;
}

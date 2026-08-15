import Database from "better-sqlite3";
import {
  applyMigrations,
  latestMigrationId,
  migrationChecksums,
  migrations,
  validateMigrationEvolution,
} from "../src/migrations.js";
import { describe, expect, it } from "vitest";

describe("safe migration metadata", () => {
  it("registers stable checksums and compatibility metadata", () => {
    const checksums = migrationChecksums();
    expect(latestMigrationId()).toBe("0009_backup_restore_upgrades");
    expect(Object.keys(checksums)).toHaveLength(migrations.length);
    expect(Object.values(checksums).every((checksum) => /^[a-f0-9]{64}$/.test(checksum))).toBe(
      true,
    );
    expect(
      migrations.every(
        (migration) =>
          migration.compatibility === "backward-compatible" ||
          migration.compatibility === "restore-required",
      ),
    ).toBe(true);
  });

  it("accepts the current expand-only release history", () => {
    expect(() => validateMigrationEvolution()).not.toThrow();
  });
  it("rolls back a failed migration and preserves the pre-upgrade state", () => {
    const sqlite = new Database(":memory:");
    applyMigrations(sqlite, "0008_analytics_metric_engine");
    sqlite
      .prepare(`INSERT INTO workspaces (
      id, name, timezone, created_at, updated_at
    ) VALUES ('workspace', 'Before upgrade', 'Africa/Lagos', 1, 1)`)
      .run();
    migrations.push({
      id: "9999_intentional_failure",
      applicationVersion: "0.2.0",
      compatibility: "restore-required",
      phase: "expand",
      sql: `
        CREATE TABLE should_rollback (id TEXT PRIMARY KEY);
        INSERT INTO should_rollback VALUES ('partial');
        INSERT INTO table_that_does_not_exist VALUES ('fail');
      `,
    });

    try {
      expect(() => applyMigrations(sqlite)).toThrow();
      expect(sqlite.prepare("SELECT name FROM workspaces WHERE id = 'workspace'").get()).toEqual({
        name: "Before upgrade",
      });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(
        sqlite
          .prepare(
            "SELECT count(*) AS count FROM _spendlens_migrations WHERE id = '9999_intentional_failure'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      migrations.pop();
      sqlite.close();
    }
  });
});

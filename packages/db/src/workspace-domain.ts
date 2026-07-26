import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type WorkspaceErrorCode =
  | "TRANSACTION_NOT_FOUND"
  | "TRANSACTION_CURSOR_INVALID"
  | "TRANSACTION_EDIT_INVALID"
  | "SPLIT_INVALID"
  | "ACCOUNT_NOT_FOUND"
  | "ACCOUNT_IDENTIFIER_EXISTS"
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_INVALID"
  | "CATEGORY_IN_USE"
  | "COUNTERPARTY_NOT_FOUND"
  | "TRANSFER_PAIR_INVALID"
  | "TRANSFER_PAIR_CONFLICT";

export class TransactionWorkspaceError extends Error {
  constructor(
    readonly code: WorkspaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransactionWorkspaceError";
  }
}

export interface WorkspaceMutation {
  entityType: string;
  entityId: string;
  action: string;
  beforeState?: unknown;
  afterState?: unknown;
}

export type WorkspaceMutationHook = (mutation: WorkspaceMutation) => void;

export function invalidateMetrics(
  sqlite: Database.Database,
  input: {
    workspaceId: string;
    reason: string;
    transactionId?: string;
    occurredAt?: number;
  },
  clock = Date.now,
): void {
  sqlite
    .prepare(
      `INSERT INTO metric_invalidations (
        id, workspace_id, reason, transaction_id, start_at, end_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.workspaceId,
      input.reason,
      input.transactionId ?? null,
      input.occurredAt ?? null,
      input.occurredAt ?? null,
      clock(),
    );
}

export function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizedName(value: string): string {
  return normalizeDisplayName(value).toLocaleLowerCase("en-NG");
}

export function slugify(value: string): string {
  const slug = normalizedName(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "category";
}

export function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

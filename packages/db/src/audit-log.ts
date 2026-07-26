import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { safeJson, sanitizePrivateData } from "./privacy.js";

export interface AuditEventInput {
  workspaceId: string;
  actorUserId?: string;
  entityType: string;
  entityId: string;
  action: string;
  beforeState?: unknown;
  afterState?: unknown;
  relatedImportBatchId?: string;
  relatedRuleId?: string;
  relatedJobId?: string;
  requestId?: string;
}

export interface AuditEventRecord {
  id: string;
  workspaceId: string;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  beforeState: unknown;
  afterState: unknown;
  relatedImportBatchId: string | null;
  relatedRuleId: string | null;
  relatedJobId: string | null;
  requestId: string | null;
  createdAt: Date;
}

export class AuditLog {
  readonly #sqlite: () => Database.Database;
  readonly #clock: () => number;

  constructor(sqlite: Database.Database | (() => Database.Database), clock = Date.now) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#clock = clock;
  }

  record(input: AuditEventInput): AuditEventRecord {
    const id = randomUUID();
    const createdAt = this.#clock();
    const beforeState = input.beforeState === undefined ? null : safeJson(input.beforeState);
    const afterState = input.afterState === undefined ? null : safeJson(input.afterState);
    this.#sqlite()
      .prepare(
        `INSERT INTO audit_events (
          id, workspace_id, actor_user_id, entity_type, entity_id, action,
          before_state, after_state, related_import_batch_id, related_rule_id,
          related_job_id, request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.actorUserId ?? null,
        input.entityType,
        input.entityId,
        input.action,
        beforeState,
        afterState,
        input.relatedImportBatchId ?? null,
        input.relatedRuleId ?? null,
        input.relatedJobId ?? null,
        input.requestId ?? null,
        createdAt,
      );
    return {
      id,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      beforeState: input.beforeState === undefined ? null : sanitizePrivateData(input.beforeState),
      afterState: input.afterState === undefined ? null : sanitizePrivateData(input.afterState),
      relatedImportBatchId: input.relatedImportBatchId ?? null,
      relatedRuleId: input.relatedRuleId ?? null,
      relatedJobId: input.relatedJobId ?? null,
      requestId: input.requestId ?? null,
      createdAt: new Date(createdAt),
    };
  }

  listForEntity(workspaceId: string, entityType: string, entityId: string): AuditEventRecord[] {
    const rows = this.#sqlite()
      .prepare(
        `SELECT * FROM audit_events
         WHERE workspace_id = ? AND entity_type = ? AND entity_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(workspaceId, entityType, entityId) as AuditRow[];
    return rows.map(mapAuditRow);
  }
}

interface AuditRow {
  id: string;
  workspace_id: string;
  actor_user_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  before_state: string | null;
  after_state: string | null;
  related_import_batch_id: string | null;
  related_rule_id: string | null;
  related_job_id: string | null;
  request_id: string | null;
  created_at: number;
}

function mapAuditRow(row: AuditRow): AuditEventRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    beforeState: row.before_state ? JSON.parse(row.before_state) : null,
    afterState: row.after_state ? JSON.parse(row.after_state) : null,
    relatedImportBatchId: row.related_import_batch_id,
    relatedRuleId: row.related_rule_id,
    relatedJobId: row.related_job_id,
    requestId: row.request_id,
    createdAt: new Date(row.created_at),
  };
}

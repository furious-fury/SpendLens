export const classificationMigrationSql = `
  CREATE TABLE classification_rules (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('exact','pattern','counterparty','bank')),
    conditions TEXT NOT NULL CHECK (json_valid(conditions)),
    action TEXT NOT NULL CHECK (json_valid(action)),
    priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN -1000 AND 1000),
    specificity INTEGER NOT NULL CHECK (specificity >= 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX classification_rules_workspace_order_idx
    ON classification_rules(workspace_id, enabled, priority DESC, specificity DESC, created_at, id);
  CREATE INDEX classification_rules_kind_idx
    ON classification_rules(workspace_id, kind, enabled);

  CREATE TABLE classification_decisions (
    transaction_id TEXT PRIMARY KEY NOT NULL
      REFERENCES transactions(id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN (
      'manual','transfer','rule','counterparty','bank','history','unclassified'
    )),
    confidence TEXT NOT NULL CHECK (confidence IN (
      'unknown','low','medium','high','confirmed'
    )),
    suggestion TEXT CHECK (suggestion IS NULL OR json_valid(suggestion)),
    winner_rule_id TEXT REFERENCES classification_rules(id) ON DELETE SET NULL,
    matched_rule_ids TEXT NOT NULL CHECK (json_valid(matched_rule_ids)),
    suppressed_rule_ids TEXT NOT NULL CHECK (json_valid(suppressed_rule_ids)),
    conflict_rule_ids TEXT NOT NULL CHECK (json_valid(conflict_rule_ids)),
    evidence TEXT NOT NULL CHECK (json_valid(evidence)),
    needs_review INTEGER NOT NULL CHECK (needs_review IN (0, 1)),
    evaluated_at INTEGER NOT NULL
  );

  CREATE INDEX classification_decisions_review_idx
    ON classification_decisions(workspace_id, needs_review, evaluated_at);
  CREATE INDEX classification_decisions_winner_idx
    ON classification_decisions(winner_rule_id);

  CREATE TABLE classification_review_actions (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    group_key TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('accept','change','ignore')),
    apply_scope TEXT NOT NULL CHECK (apply_scope IN (
      'selected','existing_matches','future_matches'
    )),
    transaction_ids TEXT NOT NULL CHECK (json_valid(transaction_ids)),
    before_values TEXT NOT NULL CHECK (json_valid(before_values)),
    after_values TEXT NOT NULL CHECK (json_valid(after_values)),
    created_rule_id TEXT REFERENCES classification_rules(id) ON DELETE SET NULL,
    undone_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX classification_review_actions_workspace_idx
    ON classification_review_actions(workspace_id, created_at DESC);
  CREATE INDEX classification_review_actions_rule_idx
    ON classification_review_actions(created_rule_id);
`;

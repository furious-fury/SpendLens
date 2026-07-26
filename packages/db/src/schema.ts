import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull(),
  setupCompletedAt: integer("setup_completed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordChangedAt: integer("password_changed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("users_workspace_unique").on(table.workspaceId),
    uniqueIndex("users_username_unique").on(table.username),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    ipHash: text("ip_hash"),
    userAgentHash: text("user_agent_hash"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const securityEvents = sqliteTable(
  "security_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").references(() => workspaces.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    outcome: text("outcome", { enum: ["success", "failure"] }).notNull(),
    remoteAddressHash: text("remote_address_hash"),
    details: text("details"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("security_events_workspace_idx").on(table.workspaceId),
    index("security_events_created_at_idx").on(table.createdAt),
  ],
);

export const securitySchema = {
  workspaces,
  users,
  sessions,
  securityEvents,
};

const currencyCheck = (column: AnySQLiteColumn) =>
  sql`length(${column}) = 3 AND ${column} GLOB '[A-Z][A-Z][A-Z]'`;

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    institutionName: text("institution_name").notNull(),
    institutionCode: text("institution_code"),
    displayName: text("display_name").notNull(),
    accountType: text("account_type", {
      enum: ["wallet", "current", "savings", "business", "loan", "cash", "other"],
    })
      .notNull()
      .default("other"),
    baseCurrency: text("base_currency").notNull(),
    maskedAccountNumber: text("masked_account_number"),
    isOwned: integer("is_owned", { mode: "boolean" }).notNull().default(true),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("accounts_workspace_idx").on(table.workspaceId),
    check("accounts_currency_check", currencyCheck(table.baseCurrency)),
  ],
);

export const ownedAccountIdentifiers = sqliteTable(
  "owned_account_identifiers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    institutionCode: text("institution_code").notNull(),
    accountNumberFingerprint: text("account_number_fingerprint").notNull(),
    maskedAccountNumber: text("masked_account_number").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("owned_account_identifiers_fingerprint_unique").on(
      table.workspaceId,
      table.institutionCode,
      table.accountNumberFingerprint,
    ),
    index("owned_account_identifiers_account_idx").on(table.accountId),
    check(
      "owned_account_identifiers_fingerprint_check",
      sql`length(${table.accountNumberFingerprint}) = 64
          AND ${table.accountNumberFingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
);

export const importBatches = sqliteTable(
  "import_batches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "restrict" }),
    sourceType: text("source_type", { enum: ["pdf", "csv", "xlsx", "manual"] }).notNull(),
    adapterKey: text("adapter_key").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    sourceFilename: text("source_filename").notNull(),
    fileFingerprint: text("file_fingerprint").notNull(),
    status: text("status", {
      enum: ["pending", "previewed", "committed", "failed"],
    })
      .notNull()
      .default("pending"),
    statementStartSource: text("statement_start_source"),
    statementEndSource: text("statement_end_source"),
    sourceTimezone: text("source_timezone").notNull(),
    openingBalanceMinor: integer("opening_balance_minor"),
    closingBalanceMinor: integer("closing_balance_minor"),
    balanceCurrency: text("balance_currency"),
    institutionName: text("institution_name"),
    maskedAccountNumber: text("masked_account_number"),
    declaredInflowMinor: integer("declared_inflow_minor"),
    declaredOutflowMinor: integer("declared_outflow_minor"),
    parsedInflowMinor: integer("parsed_inflow_minor"),
    parsedOutflowMinor: integer("parsed_outflow_minor"),
    transactionCount: integer("transaction_count"),
    reconciliationStatus: text("reconciliation_status", {
      enum: ["matched", "mismatched"],
    }),
    committedAt: integer("committed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("import_batches_workspace_idx").on(table.workspaceId),
    index("import_batches_account_idx").on(table.accountId),
    index("import_batches_fingerprint_idx").on(table.workspaceId, table.fileFingerprint),
    check(
      "import_batches_fingerprint_check",
      sql`length(${table.fileFingerprint}) = 64
          AND ${table.fileFingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "import_batches_balance_currency_check",
      sql`(${table.openingBalanceMinor} IS NULL
            AND ${table.closingBalanceMinor} IS NULL
            AND ${table.balanceCurrency} IS NULL)
          OR (${table.balanceCurrency} IS NOT NULL
            AND ${currencyCheck(table.balanceCurrency)})`,
    ),
  ],
);

export const parsedSourceRows = sqliteTable(
  "parsed_source_rows",
  {
    id: text("id").primaryKey(),
    importBatchId: text("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    sourceRowIndex: integer("source_row_index").notNull(),
    sourceTransactionId: text("source_transaction_id"),
    sourceReference: text("source_reference"),
    sourceTimestamp: text("source_timestamp").notNull(),
    sourceTimezone: text("source_timezone").notNull(),
    occurredAtUtc: integer("occurred_at_utc", { mode: "timestamp_ms" }).notNull(),
    direction: text("direction", { enum: ["debit", "credit"] }).notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    balanceAfterMinor: integer("balance_after_minor"),
    rawNarration: text("raw_narration"),
    senderOrRecipientName: text("sender_or_recipient_name"),
    institutionName: text("institution_name"),
    maskedAccountNumber: text("masked_account_number"),
    fallbackFingerprint: text("fallback_fingerprint"),
    rowFingerprint: text("row_fingerprint").notNull(),
    rawFields: text("raw_fields").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("parsed_source_rows_batch_row_unique").on(
      table.importBatchId,
      table.sourceRowIndex,
    ),
    uniqueIndex("parsed_source_rows_id_batch_unique").on(table.id, table.importBatchId),
    index("parsed_source_rows_batch_idx").on(table.importBatchId),
    index("parsed_source_rows_occurred_at_idx").on(table.occurredAtUtc),
    index("parsed_source_rows_reference_idx").on(table.sourceReference),
    index("parsed_source_rows_fallback_idx").on(table.fallbackFingerprint),
    check("parsed_source_rows_index_check", sql`${table.sourceRowIndex} >= 0`),
    check(
      "parsed_source_rows_amount_check",
      sql`typeof(${table.amountMinor}) = 'integer' AND ${table.amountMinor} > 0`,
    ),
    check("parsed_source_rows_currency_check", currencyCheck(table.currency)),
    check(
      "parsed_source_rows_fingerprint_check",
      sql`length(${table.rowFingerprint}) = 64
          AND ${table.rowFingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "parsed_source_rows_fallback_check",
      sql`${table.fallbackFingerprint} IS NULL
          OR (length(${table.fallbackFingerprint}) = 64
            AND ${table.fallbackFingerprint} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check("parsed_source_rows_raw_fields_check", sql`json_valid(${table.rawFields})`),
  ],
);

export const counterparties = sqliteTable(
  "counterparties",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    kind: text("kind", {
      enum: ["person", "business", "merchant", "bank", "government", "unknown"],
    })
      .notNull()
      .default("unknown"),
    institutionName: text("institution_name"),
    accountNumberFingerprint: text("account_number_fingerprint"),
    maskedAccountNumber: text("masked_account_number"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("counterparties_workspace_idx").on(table.workspaceId),
    index("counterparties_normalized_name_idx").on(table.workspaceId, table.normalizedName),
    check(
      "counterparties_fingerprint_check",
      sql`${table.accountNumberFingerprint} IS NULL
          OR (length(${table.accountNumberFingerprint}) = 64
            AND ${table.accountNumberFingerprint} NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
);

export const categories = sqliteTable(
  "categories",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => categories.id, {
      onDelete: "set null",
    }),
    systemKey: text("system_key"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sortOrder: integer("sort_order").notNull().default(0),
    isIncome: integer("is_income", { mode: "boolean" }).notNull().default(false),
    isExpense: integer("is_expense", { mode: "boolean" }).notNull().default(false),
    isTransfer: integer("is_transfer", { mode: "boolean" }).notNull().default(false),
    isEssential: integer("is_essential", { mode: "boolean" }).notNull().default(false),
    isDiscretionary: integer("is_discretionary", { mode: "boolean" }).notNull().default(false),
    isSavings: integer("is_savings", { mode: "boolean" }).notNull().default(false),
    isRefund: integer("is_refund", { mode: "boolean" }).notNull().default(false),
    isFee: integer("is_fee", { mode: "boolean" }).notNull().default(false),
    isCashWithdrawal: integer("is_cash_withdrawal", { mode: "boolean" }).notNull().default(false),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("categories_workspace_slug_unique").on(table.workspaceId, table.slug),
    uniqueIndex("categories_workspace_system_key_unique").on(table.workspaceId, table.systemKey),
    index("categories_parent_idx").on(table.parentId),
    check(
      "categories_parent_check",
      sql`${table.parentId} IS NULL OR ${table.parentId} <> ${table.id}`,
    ),
    check(
      "categories_spending_type_check",
      sql`NOT (${table.isEssential} = 1 AND ${table.isDiscretionary} = 1)`,
    ),
  ],
);

export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    occurredAtUtc: integer("occurred_at_utc", { mode: "timestamp_ms" }).notNull(),
    sourceTimestamp: text("source_timestamp").notNull(),
    sourceTimezone: text("source_timezone").notNull(),
    valueAtUtc: integer("value_at_utc", { mode: "timestamp_ms" }),
    direction: text("direction", { enum: ["debit", "credit"] }).notNull(),
    transactionType: text("transaction_type", {
      enum: [
        "expense",
        "income",
        "transfer",
        "refund",
        "fee",
        "cash_withdrawal",
        "debt",
        "unclassified",
      ],
    })
      .notNull()
      .default("unclassified"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    normalizedNarration: text("normalized_narration"),
    sourceReference: text("source_reference"),
    fallbackFingerprint: text("fallback_fingerprint"),
    counterpartyId: text("counterparty_id").references(() => counterparties.id, {
      onDelete: "set null",
    }),
    categoryId: text("category_id").references(() => categories.id, {
      onDelete: "set null",
    }),
    scope: text("scope", { enum: ["personal", "business"] })
      .notNull()
      .default("personal"),
    classificationSource: text("classification_source", {
      enum: ["unclassified", "manual", "rule", "history", "deterministic", "ai"],
    })
      .notNull()
      .default("unclassified"),
    confidenceLevel: text("confidence_level", {
      enum: ["unknown", "low", "medium", "high", "confirmed"],
    })
      .notNull()
      .default("unknown"),
    confidenceBasisPoints: integer("confidence_basis_points"),
    classificationExplanation: text("classification_explanation"),
    reviewState: text("review_state", {
      enum: ["unreviewed", "needs_review", "reviewed"],
    })
      .notNull()
      .default("unreviewed"),
    pairedTransactionId: text("paired_transaction_id").references(
      (): AnySQLiteColumn => transactions.id,
      { onDelete: "set null" },
    ),
    transferPairingStatus: text("transfer_pairing_status", {
      enum: ["none", "suggested", "confirmed", "rejected"],
    })
      .notNull()
      .default("none"),
    transferPairingConfidenceBasisPoints: integer("transfer_pairing_confidence_basis_points"),
    transferPairingSource: text("transfer_pairing_source", {
      enum: ["automatic", "manual"],
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("transactions_workspace_date_idx").on(table.workspaceId, table.occurredAtUtc),
    index("transactions_account_idx").on(table.accountId),
    index("transactions_category_idx").on(table.categoryId),
    index("transactions_counterparty_idx").on(table.counterpartyId),
    index("transactions_review_state_idx").on(table.workspaceId, table.reviewState),
    index("transactions_pair_idx").on(table.pairedTransactionId),
    index("transactions_account_reference_idx").on(table.accountId, table.sourceReference),
    index("transactions_account_fallback_idx").on(table.accountId, table.fallbackFingerprint),
    check(
      "transactions_amount_check",
      sql`typeof(${table.amountMinor}) = 'integer'
          AND ${table.amountMinor} > 0
          AND ${table.amountMinor} <= 9007199254740991`,
    ),
    check("transactions_currency_check", currencyCheck(table.currency)),
    check(
      "transactions_fallback_check",
      sql`${table.fallbackFingerprint} IS NULL
          OR (length(${table.fallbackFingerprint}) = 64
            AND ${table.fallbackFingerprint} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "transactions_confidence_check",
      sql`${table.confidenceBasisPoints} IS NULL
          OR ${table.confidenceBasisPoints} BETWEEN 0 AND 10000`,
    ),
    check(
      "transactions_pair_confidence_check",
      sql`${table.transferPairingConfidenceBasisPoints} IS NULL
          OR ${table.transferPairingConfidenceBasisPoints} BETWEEN 0 AND 10000`,
    ),
    check(
      "transactions_pair_check",
      sql`${table.pairedTransactionId} IS NULL OR ${table.pairedTransactionId} <> ${table.id}`,
    ),
    check(
      "transactions_confirmed_pair_check",
      sql`${table.transferPairingStatus} <> 'confirmed'
          OR (${table.pairedTransactionId} IS NOT NULL AND ${table.transactionType} = 'transfer')`,
    ),
  ],
);

export const transactionSources = sqliteTable(
  "transaction_sources",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    parsedSourceRowId: text("parsed_source_row_id").notNull(),
    importBatchId: text("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    linkType: text("link_type", { enum: ["original", "duplicate"] }).notNull(),
    matchConfidence: text("match_confidence", {
      enum: ["strong", "medium", "weak", "manual"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.transactionId, table.parsedSourceRowId] }),
    uniqueIndex("transaction_sources_source_unique").on(table.parsedSourceRowId),
    index("transaction_sources_transaction_idx").on(table.transactionId),
    index("transaction_sources_import_batch_idx").on(table.importBatchId),
    foreignKey({
      columns: [table.parsedSourceRowId, table.importBatchId],
      foreignColumns: [parsedSourceRows.id, parsedSourceRows.importBatchId],
      name: "transaction_sources_source_batch_fk",
    }).onDelete("cascade"),
  ],
);

export const transactionSplitSets = sqliteTable(
  "transaction_split_sets",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["draft", "active", "superseded"] })
      .notNull()
      .default("draft"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("transaction_split_sets_active_unique")
      .on(table.transactionId)
      .where(sql`${table.status} = 'active'`),
    index("transaction_split_sets_transaction_idx").on(table.transactionId),
  ],
);

export const transactionSplits = sqliteTable(
  "transaction_splits",
  {
    id: text("id").primaryKey(),
    splitSetId: text("split_set_id")
      .notNull()
      .references(() => transactionSplitSets.id, { onDelete: "cascade" }),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    scope: text("scope", { enum: ["personal", "business"] })
      .notNull()
      .default("personal"),
    note: text("note"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("transaction_splits_set_idx").on(table.splitSetId),
    index("transaction_splits_category_idx").on(table.categoryId),
    check(
      "transaction_splits_amount_check",
      sql`typeof(${table.amountMinor}) = 'integer' AND ${table.amountMinor} > 0`,
    ),
    check("transaction_splits_currency_check", currencyCheck(table.currency)),
  ],
);

export const metricInvalidations = sqliteTable(
  "metric_invalidations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    transactionId: text("transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),
    startAt: integer("start_at", { mode: "timestamp_ms" }),
    endAt: integer("end_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("metric_invalidations_pending_idx").on(
      table.workspaceId,
      table.consumedAt,
      table.createdAt,
    ),
    index("metric_invalidations_transaction_idx").on(table.transactionId),
    check(
      "metric_invalidations_range_check",
      sql`(${table.startAt} IS NULL AND ${table.endAt} IS NULL)
          OR (${table.startAt} IS NOT NULL
            AND ${table.endAt} IS NOT NULL
            AND ${table.startAt} <= ${table.endAt})`,
    ),
  ],
);

export const transactionNotes = sqliteTable(
  "transaction_notes",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("transaction_notes_transaction_idx").on(table.transactionId),
    check("transaction_notes_body_check", sql`length(trim(${table.body})) > 0`),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("tags_workspace_slug_unique").on(table.workspaceId, table.slug),
    index("tags_workspace_idx").on(table.workspaceId),
  ],
);

export const transactionTags = sqliteTable(
  "transaction_tags",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.transactionId, table.tagId] })],
);

export const transactionRevisions = sqliteTable(
  "transaction_revisions",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    source: text("source", { enum: ["manual", "rule", "system", "import"] }).notNull(),
    beforeValues: text("before_values").notNull(),
    afterValues: text("after_values").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("transaction_revisions_number_unique").on(
      table.transactionId,
      table.revisionNumber,
    ),
    index("transaction_revisions_transaction_idx").on(table.transactionId),
    check("transaction_revisions_number_check", sql`${table.revisionNumber} > 0`),
    check(
      "transaction_revisions_json_check",
      sql`json_valid(${table.beforeValues}) AND json_valid(${table.afterValues})`,
    ),
  ],
);

export const classificationRules = sqliteTable(
  "classification_rules",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["exact", "pattern", "counterparty", "bank"] }).notNull(),
    conditions: text("conditions").notNull(),
    action: text("action").notNull(),
    priority: integer("priority").notNull().default(0),
    specificity: integer("specificity").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("classification_rules_workspace_order_idx").on(
      table.workspaceId,
      table.enabled,
      table.priority,
      table.specificity,
      table.createdAt,
      table.id,
    ),
    index("classification_rules_kind_idx").on(table.workspaceId, table.kind, table.enabled),
    check(
      "classification_rules_json_check",
      sql`json_valid(${table.conditions}) AND json_valid(${table.action})`,
    ),
    check("classification_rules_priority_check", sql`${table.priority} BETWEEN -1000 AND 1000`),
    check("classification_rules_specificity_check", sql`${table.specificity} >= 0`),
  ],
);

export const classificationDecisions = sqliteTable(
  "classification_decisions",
  {
    transactionId: text("transaction_id")
      .primaryKey()
      .references(() => transactions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source", {
      enum: ["manual", "transfer", "rule", "counterparty", "bank", "history", "unclassified"],
    }).notNull(),
    confidence: text("confidence", {
      enum: ["unknown", "low", "medium", "high", "confirmed"],
    }).notNull(),
    suggestion: text("suggestion"),
    winnerRuleId: text("winner_rule_id").references(() => classificationRules.id, {
      onDelete: "set null",
    }),
    matchedRuleIds: text("matched_rule_ids").notNull(),
    suppressedRuleIds: text("suppressed_rule_ids").notNull(),
    conflictRuleIds: text("conflict_rule_ids").notNull(),
    evidence: text("evidence").notNull(),
    needsReview: integer("needs_review", { mode: "boolean" }).notNull(),
    evaluatedAt: integer("evaluated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("classification_decisions_review_idx").on(
      table.workspaceId,
      table.needsReview,
      table.evaluatedAt,
    ),
    index("classification_decisions_winner_idx").on(table.winnerRuleId),
    check(
      "classification_decisions_json_check",
      sql`(${table.suggestion} IS NULL OR json_valid(${table.suggestion}))
          AND json_valid(${table.matchedRuleIds})
          AND json_valid(${table.suppressedRuleIds})
          AND json_valid(${table.conflictRuleIds})
          AND json_valid(${table.evidence})`,
    ),
  ],
);

export const classificationReviewActions = sqliteTable(
  "classification_review_actions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    groupKey: text("group_key").notNull(),
    decision: text("decision", { enum: ["accept", "change", "ignore"] }).notNull(),
    applyScope: text("apply_scope", {
      enum: ["selected", "existing_matches", "future_matches"],
    }).notNull(),
    transactionIds: text("transaction_ids").notNull(),
    beforeValues: text("before_values").notNull(),
    afterValues: text("after_values").notNull(),
    createdRuleId: text("created_rule_id").references(() => classificationRules.id, {
      onDelete: "set null",
    }),
    undoneAt: integer("undone_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("classification_review_actions_workspace_idx").on(table.workspaceId, table.createdAt),
    index("classification_review_actions_rule_idx").on(table.createdRuleId),
    check(
      "classification_review_actions_json_check",
      sql`json_valid(${table.transactionIds})
          AND json_valid(${table.beforeValues})
          AND json_valid(${table.afterValues})`,
    ),
  ],
);

export const importReconciliations = sqliteTable(
  "import_reconciliations",
  {
    importBatchId: text("import_batch_id")
      .primaryKey()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "restrict" }),
    createAccount: integer("create_account", { mode: "boolean" }).notNull().default(false),
    newCount: integer("new_count").notNull(),
    duplicateCount: integer("duplicate_count").notNull(),
    possibleDuplicateCount: integer("possible_duplicate_count").notNull(),
    conflictCount: integer("conflict_count").notNull(),
    skippedCount: integer("skipped_count").notNull().default(0),
    canonicalCreatedCount: integer("canonical_created_count"),
    duplicateLinkedCount: integer("duplicate_linked_count"),
    analyzedAt: integer("analyzed_at", { mode: "timestamp_ms" }).notNull(),
    committedAt: integer("committed_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("import_reconciliations_account_idx").on(table.accountId),
    check(
      "import_reconciliations_counts_check",
      sql`${table.newCount} >= 0
          AND ${table.duplicateCount} >= 0
          AND ${table.possibleDuplicateCount} >= 0
          AND ${table.conflictCount} >= 0
          AND ${table.skippedCount} >= 0
          AND (${table.canonicalCreatedCount} IS NULL OR ${table.canonicalCreatedCount} >= 0)
          AND (${table.duplicateLinkedCount} IS NULL OR ${table.duplicateLinkedCount} >= 0)`,
    ),
  ],
);

export const importMatchDecisions = sqliteTable(
  "import_match_decisions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    importBatchId: text("import_batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    parsedSourceRowId: text("parsed_source_row_id").notNull(),
    candidateTransactionId: text("candidate_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    classification: text("classification", {
      enum: ["new", "duplicate", "possible_duplicate", "conflict"],
    }).notNull(),
    decision: text("decision", {
      enum: ["pending", "confirmed", "rejected", "skipped"],
    }).notNull(),
    matchBasis: text("match_basis", {
      enum: ["none", "strong_id", "fallback"],
    }).notNull(),
    reasonCode: text("reason_code").notNull(),
    decidedByUserId: text("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("import_match_decisions_source_unique").on(table.parsedSourceRowId),
    index("import_match_decisions_import_idx").on(table.importBatchId),
    index("import_match_decisions_candidate_idx").on(table.candidateTransactionId),
    index("import_match_decisions_pending_idx")
      .on(table.workspaceId, table.decision)
      .where(sql`${table.decision} = 'pending'`),
    foreignKey({
      columns: [table.parsedSourceRowId, table.importBatchId],
      foreignColumns: [parsedSourceRows.id, parsedSourceRows.importBatchId],
      name: "import_match_decisions_source_batch_fk",
    }).onDelete("cascade"),
    check(
      "import_match_decisions_candidate_check",
      sql`(${table.classification} = 'new' AND ${table.candidateTransactionId} IS NULL)
          OR (${table.classification} <> 'new'
            AND (${table.candidateTransactionId} IS NOT NULL
              OR ${table.decision} IN ('rejected','skipped')))`,
    ),
    check(
      "import_match_decisions_automatic_check",
      sql`${table.classification} IN ('possible_duplicate','conflict')
          OR ${table.decision} = 'confirmed'`,
    ),
  ],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    jobType: text("job_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    payload: text("payload").notNull(),
    result: text("result"),
    progressBasisPoints: integer("progress_basis_points").notNull().default(0),
    progressMessage: text("progress_message"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    relatedImportBatchId: text("related_import_batch_id").references(() => importBatches.id, {
      onDelete: "set null",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("jobs_idempotency_unique").on(
      table.workspaceId,
      table.jobType,
      table.idempotencyKey,
    ),
    index("jobs_claim_idx").on(table.status, table.availableAt, table.createdAt),
    index("jobs_workspace_idx").on(table.workspaceId, table.createdAt),
    index("jobs_import_idx").on(table.relatedImportBatchId),
    index("jobs_lease_idx").on(table.status, table.leaseExpiresAt),
    check("jobs_progress_check", sql`${table.progressBasisPoints} BETWEEN 0 AND 10000`),
    check("jobs_attempts_check", sql`${table.attempts} >= 0 AND ${table.maxAttempts} > 0`),
    check("jobs_payload_check", sql`json_valid(${table.payload})`),
    check("jobs_result_check", sql`${table.result} IS NULL OR json_valid(${table.result})`),
    check(
      "jobs_lease_check",
      sql`(${table.status} = 'running'
            AND ${table.leaseOwner} IS NOT NULL
            AND ${table.leaseExpiresAt} IS NOT NULL)
          OR (${table.status} <> 'running'
            AND ${table.leaseOwner} IS NULL
            AND ${table.leaseExpiresAt} IS NULL)`,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    beforeState: text("before_state"),
    afterState: text("after_state"),
    relatedImportBatchId: text("related_import_batch_id").references(() => importBatches.id, {
      onDelete: "set null",
    }),
    relatedRuleId: text("related_rule_id"),
    relatedJobId: text("related_job_id").references(() => jobs.id, {
      onDelete: "set null",
    }),
    requestId: text("request_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("audit_events_workspace_time_idx").on(table.workspaceId, table.createdAt),
    index("audit_events_entity_idx").on(table.entityType, table.entityId, table.createdAt),
    index("audit_events_actor_idx").on(table.actorUserId, table.createdAt),
    index("audit_events_import_idx").on(table.relatedImportBatchId),
    index("audit_events_job_idx").on(table.relatedJobId),
    check(
      "audit_events_state_check",
      sql`(${table.beforeState} IS NULL OR json_valid(${table.beforeState}))
          AND (${table.afterState} IS NULL OR json_valid(${table.afterState}))`,
    ),
  ],
);

export const aiProviderSettings = sqliteTable(
  "ai_provider_settings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider", {
      enum: ["openai_compatible", "anthropic", "gemini", "ollama"],
    }).notNull(),
    endpoint: text("endpoint").notNull(),
    model: text("model").notNull(),
    timeoutMs: integer("timeout_ms").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    localModel: integer("local_model", { mode: "boolean" }).notNull().default(false),
    payloadPolicy: text("payload_policy", {
      enum: ["remote_redacted", "local_full"],
    }).notNull(),
    credentialStorage: text("credential_storage", {
      enum: ["keyring", "encrypted_database"],
    }).notNull(),
    credentialCiphertext: text("credential_ciphertext"),
    credentialNonce: text("credential_nonce"),
    credentialAuthTag: text("credential_auth_tag"),
    hasCredential: integer("has_credential", { mode: "boolean" }).notNull().default(false),
    remotePayloadAcknowledgedAt: integer("remote_payload_acknowledged_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("ai_provider_settings_workspace_provider_unique").on(
      table.workspaceId,
      table.provider,
    ),
    index("ai_provider_settings_enabled_idx").on(table.workspaceId, table.enabled),
  ],
);

export const aiClassificationRuns = sqliteTable(
  "ai_classification_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerSettingId: text("provider_setting_id").references(() => aiProviderSettings.id, {
      onDelete: "set null",
    }),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    promptVersion: text("prompt_version").notNull(),
    provider: text("provider", {
      enum: ["openai_compatible", "anthropic", "gemini", "ollama"],
    }).notNull(),
    model: text("model").notNull(),
    payloadHash: text("payload_hash").notNull(),
    status: text("status", {
      enum: ["running", "succeeded", "failed", "cancelled"],
    }).notNull(),
    result: text("result"),
    errorCode: text("error_code"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("ai_classification_runs_workspace_idx").on(table.workspaceId, table.createdAt),
    index("ai_classification_runs_job_idx").on(table.jobId),
  ],
);

export const aiClassificationSuggestions = sqliteTable(
  "ai_classification_suggestions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => aiClassificationRuns.id, { onDelete: "cascade" }),
    suggestion: text("suggestion").notNull(),
    confidence: text("confidence", { enum: ["low", "medium", "high"] }).notNull(),
    reasonCodes: text("reason_codes").notNull(),
    explanation: text("explanation").notNull(),
    evidence: text("evidence").notNull(),
    inputUpdatedAt: integer("input_updated_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("ai_classification_suggestions_transaction_idx").on(
      table.workspaceId,
      table.transactionId,
      table.createdAt,
    ),
    index("ai_classification_suggestions_run_idx").on(table.runId),
  ],
);

export const financialSchema = {
  accounts,
  ownedAccountIdentifiers,
  importBatches,
  parsedSourceRows,
  counterparties,
  categories,
  transactions,
  transactionSources,
  transactionSplitSets,
  transactionSplits,
  metricInvalidations,
  transactionNotes,
  tags,
  transactionTags,
  transactionRevisions,
  classificationRules,
  classificationDecisions,
  classificationReviewActions,
  aiProviderSettings,
  aiClassificationRuns,
  aiClassificationSuggestions,
  importReconciliations,
  importMatchDecisions,
};

export const infrastructureSchema = {
  jobs,
  auditEvents,
};

export const databaseSchema = {
  ...securitySchema,
  ...financialSchema,
  ...infrastructureSchema,
};

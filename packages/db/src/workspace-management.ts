import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  invalidateMetrics,
  normalizeDisplayName,
  normalizedName,
  slugify,
  toIso,
  TransactionWorkspaceError,
  type WorkspaceMutationHook,
} from "./workspace-domain.js";

export type AccountType = "wallet" | "current" | "savings" | "business" | "loan" | "cash" | "other";

export interface AccountRecord {
  id: string;
  institutionName: string;
  institutionCode: string | null;
  displayName: string;
  accountType: AccountType;
  baseCurrency: string;
  maskedAccountNumber: string | null;
  isOwned: boolean;
  archivedAt: string | null;
  transactionCount: number;
}

export interface CategoryFlags {
  isIncome: boolean;
  isExpense: boolean;
  isTransfer: boolean;
  isEssential: boolean;
  isDiscretionary: boolean;
  isSavings: boolean;
  isRefund: boolean;
  isFee: boolean;
  isCashWithdrawal: boolean;
}

type CategoryFlagChanges = {
  [Key in keyof CategoryFlags]?: boolean | undefined;
};

export interface CategoryRecord {
  id: string;
  parentId: string | null;
  systemKey: string | null;
  slug: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  transactionCount: number;
  flags: CategoryFlags;
}

export type CounterpartyKind =
  | "person"
  | "business"
  | "merchant"
  | "bank"
  | "government"
  | "unknown";

export interface CounterpartyRecord {
  id: string;
  displayName: string;
  kind: CounterpartyKind;
  institutionName: string | null;
  maskedAccountNumber: string | null;
  transactionCount: number;
}

interface AccountRow {
  id: string;
  institution_name: string;
  institution_code: string | null;
  display_name: string;
  account_type: AccountType;
  base_currency: string;
  masked_account_number: string | null;
  is_owned: number;
  archived_at: number | null;
  transaction_count: number;
}

interface CategoryRow {
  id: string;
  parent_id: string | null;
  system_key: string | null;
  slug: string;
  name: string;
  description: string | null;
  archived_at: number | null;
  transaction_count: number;
  is_income: number;
  is_expense: number;
  is_transfer: number;
  is_essential: number;
  is_discretionary: number;
  is_savings: number;
  is_refund: number;
  is_fee: number;
  is_cash_withdrawal: number;
}

interface CounterpartyRow {
  id: string;
  display_name: string;
  kind: CounterpartyKind;
  institution_name: string | null;
  masked_account_number: string | null;
  transaction_count: number;
}

const categoryFlagColumns: Record<keyof CategoryFlags, string> = {
  isIncome: "is_income",
  isExpense: "is_expense",
  isTransfer: "is_transfer",
  isEssential: "is_essential",
  isDiscretionary: "is_discretionary",
  isSavings: "is_savings",
  isRefund: "is_refund",
  isFee: "is_fee",
  isCashWithdrawal: "is_cash_withdrawal",
};

export class WorkspaceManagement {
  readonly #sqlite: () => Database.Database;
  readonly #clock: () => number;

  constructor(sqlite: Database.Database | (() => Database.Database), clock = Date.now) {
    this.#sqlite = typeof sqlite === "function" ? sqlite : () => sqlite;
    this.#clock = clock;
  }

  listAccounts(workspaceId: string): AccountRecord[] {
    const rows = this.#sqlite()
      .prepare(
        `SELECT a.*, count(t.id) AS transaction_count
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
         WHERE a.workspace_id = ?
         GROUP BY a.id
         ORDER BY a.archived_at IS NOT NULL, a.display_name COLLATE NOCASE, a.id`,
      )
      .all(workspaceId) as AccountRow[];
    return rows.map(mapAccount);
  }

  createAccount(
    input: {
      workspaceId: string;
      institutionName: string;
      institutionCode?: string | null | undefined;
      displayName: string;
      accountType: AccountType;
      baseCurrency: string;
      isOwned: boolean;
    },
    onMutation?: WorkspaceMutationHook,
  ): AccountRecord {
    const sqlite = this.#sqlite();
    const create = sqlite.transaction(() => {
      const id = randomUUID();
      const now = this.#clock();
      sqlite
        .prepare(
          `INSERT INTO accounts (
            id, workspace_id, institution_name, institution_code, display_name,
            account_type, base_currency, is_owned, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          normalizeDisplayName(input.institutionName),
          input.institutionCode?.trim().toLocaleLowerCase("en-NG") || null,
          normalizeDisplayName(input.displayName),
          input.accountType,
          input.baseCurrency,
          input.isOwned ? 1 : 0,
          now,
          now,
        );
      const account = this.#account(input.workspaceId, id);
      invalidateMetrics(
        sqlite,
        { workspaceId: input.workspaceId, reason: "account.created" },
        this.#clock,
      );
      onMutation?.({
        entityType: "account",
        entityId: id,
        action: "account.created",
        afterState: account,
      });
      return account;
    });
    return create();
  }

  updateAccount(
    input: {
      workspaceId: string;
      accountId: string;
      changes: {
        institutionName?: string | undefined;
        institutionCode?: string | null | undefined;
        displayName?: string | undefined;
        accountType?: AccountType | undefined;
        isOwned?: boolean | undefined;
        archived?: boolean | undefined;
      };
    },
    onMutation?: WorkspaceMutationHook,
  ): AccountRecord {
    const sqlite = this.#sqlite();
    const update = sqlite.transaction(() => {
      const before = this.#account(input.workspaceId, input.accountId);
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      if (input.changes.institutionName !== undefined) {
        assignments.push("institution_name = ?");
        values.push(normalizeDisplayName(input.changes.institutionName));
      }
      if (Object.hasOwn(input.changes, "institutionCode")) {
        assignments.push("institution_code = ?");
        values.push(input.changes.institutionCode?.trim().toLocaleLowerCase("en-NG") || null);
      }
      if (input.changes.displayName !== undefined) {
        assignments.push("display_name = ?");
        values.push(normalizeDisplayName(input.changes.displayName));
      }
      if (input.changes.accountType !== undefined) {
        assignments.push("account_type = ?");
        values.push(input.changes.accountType);
      }
      if (input.changes.isOwned !== undefined) {
        assignments.push("is_owned = ?");
        values.push(input.changes.isOwned ? 1 : 0);
      }
      if (input.changes.archived !== undefined) {
        assignments.push("archived_at = ?");
        values.push(input.changes.archived ? this.#clock() : null);
      }
      assignments.push("updated_at = ?");
      values.push(this.#clock());
      sqlite
        .prepare(
          `UPDATE accounts SET ${assignments.join(", ")}
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(...values, input.workspaceId, input.accountId);
      const after = this.#account(input.workspaceId, input.accountId);
      invalidateMetrics(
        sqlite,
        { workspaceId: input.workspaceId, reason: "account.updated" },
        this.#clock,
      );
      onMutation?.({
        entityType: "account",
        entityId: input.accountId,
        action: "account.updated",
        beforeState: before,
        afterState: after,
      });
      return after;
    });
    return update();
  }

  registerOwnedAccount(
    input: {
      workspaceId: string;
      accountId: string;
      institutionCode: string;
      accountNumber: string;
    },
    onMutation?: WorkspaceMutationHook,
  ): AccountRecord {
    const sqlite = this.#sqlite();
    const register = sqlite.transaction(() => {
      const before = this.#account(input.workspaceId, input.accountId);
      const institutionCode = input.institutionCode.trim().toLocaleLowerCase("en-NG");
      const normalizedAccountNumber = input.accountNumber.replace(/[\s-]/g, "");
      const fingerprint = createHash("sha256")
        .update(`${input.workspaceId}\0${institutionCode}\0${normalizedAccountNumber}`)
        .digest("hex");
      const maskedAccountNumber = `•••• ${normalizedAccountNumber.slice(-4)}`;
      try {
        sqlite
          .prepare(
            `INSERT INTO owned_account_identifiers (
              id, workspace_id, account_id, institution_code,
              account_number_fingerprint, masked_account_number, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            input.workspaceId,
            input.accountId,
            institutionCode,
            fingerprint,
            maskedAccountNumber,
            this.#clock(),
          );
      } catch (error) {
        if (isConstraintError(error)) {
          throw new TransactionWorkspaceError(
            "ACCOUNT_IDENTIFIER_EXISTS",
            "This owned account number is already registered.",
          );
        }
        throw error;
      }
      sqlite
        .prepare(
          `UPDATE accounts SET
            is_owned = 1,
            masked_account_number = coalesce(masked_account_number, ?),
            updated_at = ?
           WHERE id = ? AND workspace_id = ?`,
        )
        .run(maskedAccountNumber, this.#clock(), input.accountId, input.workspaceId);
      const after = this.#account(input.workspaceId, input.accountId);
      onMutation?.({
        entityType: "account",
        entityId: input.accountId,
        action: "account.identifier_registered",
        beforeState: before,
        afterState: {
          ...after,
          registeredIdentifier: { institutionCode, maskedAccountNumber },
        },
      });
      return after;
    });
    return register();
  }

  listCategories(workspaceId: string): CategoryRecord[] {
    const rows = this.#sqlite()
      .prepare(
        `SELECT c.*, count(t.id) AS transaction_count
         FROM categories c
         LEFT JOIN transactions t ON t.category_id = c.id
         WHERE c.workspace_id = ?
         GROUP BY c.id
         ORDER BY c.archived_at IS NOT NULL, c.sort_order, c.name COLLATE NOCASE, c.id`,
      )
      .all(workspaceId) as CategoryRow[];
    return rows.map(mapCategory);
  }

  createCategory(
    input: {
      workspaceId: string;
      name: string;
      description?: string | null | undefined;
      parentId?: string | null | undefined;
      flags?: CategoryFlagChanges | undefined;
    },
    onMutation?: WorkspaceMutationHook,
  ): CategoryRecord {
    const sqlite = this.#sqlite();
    const create = sqlite.transaction(() => {
      if (input.parentId) this.#requireCategory(input.workspaceId, input.parentId);
      const flags = mergeCategoryFlags(emptyCategoryFlags(), input.flags);
      assertCategoryFlags(flags);
      const id = randomUUID();
      const now = this.#clock();
      sqlite
        .prepare(
          `INSERT INTO categories (
            id, workspace_id, parent_id, slug, name, description,
            is_income, is_expense, is_transfer, is_essential, is_discretionary,
            is_savings, is_refund, is_fee, is_cash_withdrawal,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          input.parentId ?? null,
          this.#availableSlug(input.workspaceId, input.name),
          normalizeDisplayName(input.name),
          input.description?.trim() || null,
          ...flagsToValues(flags),
          now,
          now,
        );
      const category = this.#category(input.workspaceId, id);
      invalidateMetrics(
        sqlite,
        { workspaceId: input.workspaceId, reason: "category.created" },
        this.#clock,
      );
      onMutation?.({
        entityType: "category",
        entityId: id,
        action: "category.created",
        afterState: category,
      });
      return category;
    });
    return create();
  }

  updateCategory(
    input: {
      workspaceId: string;
      categoryId: string;
      changes: {
        name?: string | undefined;
        description?: string | null | undefined;
        parentId?: string | null | undefined;
        archived?: boolean | undefined;
        flags?: CategoryFlagChanges | undefined;
      };
    },
    onMutation?: WorkspaceMutationHook,
  ): CategoryRecord {
    const sqlite = this.#sqlite();
    const update = sqlite.transaction(() => {
      const before = this.#category(input.workspaceId, input.categoryId);
      if (Object.hasOwn(input.changes, "parentId")) {
        this.#validateCategoryParent(
          input.workspaceId,
          input.categoryId,
          input.changes.parentId ?? null,
        );
      }
      const flags = mergeCategoryFlags(before.flags, input.changes.flags);
      assertCategoryFlags(flags);
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      if (input.changes.name !== undefined) {
        assignments.push("name = ?", "slug = ?");
        values.push(
          normalizeDisplayName(input.changes.name),
          this.#availableSlug(input.workspaceId, input.changes.name, input.categoryId),
        );
      }
      if (Object.hasOwn(input.changes, "description")) {
        assignments.push("description = ?");
        values.push(input.changes.description?.trim() || null);
      }
      if (Object.hasOwn(input.changes, "parentId")) {
        assignments.push("parent_id = ?");
        values.push(input.changes.parentId ?? null);
      }
      if (input.changes.archived !== undefined) {
        assignments.push("archived_at = ?");
        values.push(input.changes.archived ? this.#clock() : null);
      }
      if (input.changes.flags) {
        for (const [field, value] of Object.entries(input.changes.flags) as Array<
          [keyof CategoryFlags, boolean | undefined]
        >) {
          if (value === undefined) continue;
          assignments.push(`${categoryFlagColumns[field]} = ?`);
          values.push(value ? 1 : 0);
        }
      }
      assignments.push("updated_at = ?");
      values.push(this.#clock());
      sqlite
        .prepare(
          `UPDATE categories SET ${assignments.join(", ")}
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(...values, input.workspaceId, input.categoryId);
      const after = this.#category(input.workspaceId, input.categoryId);
      invalidateMetrics(
        sqlite,
        { workspaceId: input.workspaceId, reason: "category.updated" },
        this.#clock,
      );
      onMutation?.({
        entityType: "category",
        entityId: input.categoryId,
        action:
          before.parentId && after.parentId === null ? "category.promoted" : "category.updated",
        beforeState: before,
        afterState: after,
      });
      return after;
    });
    return update();
  }

  mergeCategory(
    input: {
      workspaceId: string;
      sourceCategoryId: string;
      targetCategoryId: string;
      actorUserId: string;
    },
    onMutation?: WorkspaceMutationHook,
  ): CategoryRecord {
    const sqlite = this.#sqlite();
    const merge = sqlite.transaction(() => {
      if (input.sourceCategoryId === input.targetCategoryId) {
        throw new TransactionWorkspaceError(
          "CATEGORY_INVALID",
          "A category cannot be merged into itself.",
        );
      }
      const source = this.#category(input.workspaceId, input.sourceCategoryId);
      const target = this.#category(input.workspaceId, input.targetCategoryId);
      this.#validateCategoryParent(
        input.workspaceId,
        input.sourceCategoryId,
        input.targetCategoryId,
      );
      const affectedTransactions = sqlite
        .prepare(
          `SELECT DISTINCT t.id
           FROM transactions t
           LEFT JOIN transaction_split_sets ss
             ON ss.transaction_id = t.id AND ss.status = 'active'
           LEFT JOIN transaction_splits s ON s.split_set_id = ss.id
           WHERE t.workspace_id = ? AND (t.category_id = ? OR s.category_id = ?)`,
        )
        .all(input.workspaceId, input.sourceCategoryId, input.sourceCategoryId) as Array<{
        id: string;
      }>;
      const activeSplitSets = sqlite
        .prepare(
          `SELECT DISTINCT ss.id, ss.transaction_id
           FROM transaction_split_sets ss
           JOIN transactions t ON t.id = ss.transaction_id
           JOIN transaction_splits s ON s.split_set_id = ss.id
           WHERE t.workspace_id = ? AND ss.status = 'active' AND s.category_id = ?`,
        )
        .all(input.workspaceId, input.sourceCategoryId) as Array<{
        id: string;
        transaction_id: string;
      }>;
      const now = this.#clock();
      for (const splitSet of activeSplitSets) {
        const previousSplits = sqlite
          .prepare(
            `SELECT category_id, amount_minor, currency, scope, note, sort_order
             FROM transaction_splits WHERE split_set_id = ? ORDER BY sort_order, id`,
          )
          .all(splitSet.id) as Array<{
          category_id: string;
          amount_minor: number;
          currency: string;
          scope: string;
          note: string | null;
          sort_order: number;
        }>;
        sqlite
          .prepare("UPDATE transaction_split_sets SET status = 'superseded' WHERE id = ?")
          .run(splitSet.id);
        const replacementId = randomUUID();
        sqlite
          .prepare(
            `INSERT INTO transaction_split_sets (
              id, transaction_id, status, created_by_user_id, created_at
            ) VALUES (?, ?, 'draft', ?, ?)`,
          )
          .run(replacementId, splitSet.transaction_id, input.actorUserId, now);
        const insert = sqlite.prepare(
          `INSERT INTO transaction_splits (
            id, split_set_id, category_id, amount_minor, currency,
            scope, note, sort_order, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const split of previousSplits) {
          insert.run(
            randomUUID(),
            replacementId,
            split.category_id === input.sourceCategoryId
              ? input.targetCategoryId
              : split.category_id,
            split.amount_minor,
            split.currency,
            split.scope,
            split.note,
            split.sort_order,
            now,
          );
        }
        sqlite
          .prepare(
            `UPDATE transaction_split_sets
             SET status = 'active', activated_at = ? WHERE id = ?`,
          )
          .run(now, replacementId);
      }
      sqlite
        .prepare(
          `UPDATE transaction_splits SET category_id = ?
           WHERE category_id = ?
             AND split_set_id IN (
               SELECT id FROM transaction_split_sets WHERE status <> 'active'
             )`,
        )
        .run(input.targetCategoryId, input.sourceCategoryId);
      sqlite
        .prepare(
          `UPDATE transactions SET category_id = ?, updated_at = ?
           WHERE workspace_id = ? AND category_id = ?`,
        )
        .run(input.targetCategoryId, now, input.workspaceId, input.sourceCategoryId);
      sqlite
        .prepare(
          `UPDATE categories SET parent_id = ?, updated_at = ?
           WHERE workspace_id = ? AND parent_id = ?`,
        )
        .run(input.targetCategoryId, now, input.workspaceId, input.sourceCategoryId);
      sqlite
        .prepare(
          `UPDATE categories SET archived_at = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(now, now, input.workspaceId, input.sourceCategoryId);
      invalidateMetrics(
        sqlite,
        { workspaceId: input.workspaceId, reason: "category.merged" },
        this.#clock,
      );
      onMutation?.({
        entityType: "category",
        entityId: input.sourceCategoryId,
        action: "category.merged",
        beforeState: source,
        afterState: {
          mergedInto: { id: target.id, name: target.name },
          affectedTransactionCount: affectedTransactions.length,
        },
      });
      return this.#category(input.workspaceId, input.targetCategoryId);
    });
    return merge();
  }

  listCounterparties(workspaceId: string): CounterpartyRecord[] {
    const rows = this.#sqlite()
      .prepare(
        `SELECT cp.*, count(t.id) AS transaction_count
         FROM counterparties cp
         LEFT JOIN transactions t ON t.counterparty_id = cp.id
         WHERE cp.workspace_id = ?
         GROUP BY cp.id
         ORDER BY cp.display_name COLLATE NOCASE, cp.id`,
      )
      .all(workspaceId) as CounterpartyRow[];
    return rows.map(mapCounterparty);
  }

  createCounterparty(
    input: {
      workspaceId: string;
      displayName: string;
      kind: CounterpartyKind;
      institutionName?: string | null | undefined;
    },
    onMutation?: WorkspaceMutationHook,
  ): CounterpartyRecord {
    const sqlite = this.#sqlite();
    const create = sqlite.transaction(() => {
      const id = randomUUID();
      const now = this.#clock();
      const displayName = normalizeDisplayName(input.displayName);
      sqlite
        .prepare(
          `INSERT INTO counterparties (
            id, workspace_id, display_name, normalized_name, kind,
            institution_name, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.workspaceId,
          displayName,
          normalizedName(displayName),
          input.kind,
          input.institutionName?.trim() || null,
          now,
          now,
        );
      const counterparty = this.#counterparty(input.workspaceId, id);
      onMutation?.({
        entityType: "counterparty",
        entityId: id,
        action: "counterparty.created",
        afterState: counterparty,
      });
      return counterparty;
    });
    return create();
  }

  updateCounterparty(
    input: {
      workspaceId: string;
      counterpartyId: string;
      changes: {
        displayName?: string | undefined;
        kind?: CounterpartyKind | undefined;
        institutionName?: string | null | undefined;
      };
    },
    onMutation?: WorkspaceMutationHook,
  ): CounterpartyRecord {
    const sqlite = this.#sqlite();
    const update = sqlite.transaction(() => {
      const before = this.#counterparty(input.workspaceId, input.counterpartyId);
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      if (input.changes.displayName !== undefined) {
        const displayName = normalizeDisplayName(input.changes.displayName);
        assignments.push("display_name = ?", "normalized_name = ?");
        values.push(displayName, normalizedName(displayName));
      }
      if (input.changes.kind !== undefined) {
        assignments.push("kind = ?");
        values.push(input.changes.kind);
      }
      if (Object.hasOwn(input.changes, "institutionName")) {
        assignments.push("institution_name = ?");
        values.push(input.changes.institutionName?.trim() || null);
      }
      assignments.push("updated_at = ?");
      values.push(this.#clock());
      sqlite
        .prepare(
          `UPDATE counterparties SET ${assignments.join(", ")}
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(...values, input.workspaceId, input.counterpartyId);
      const after = this.#counterparty(input.workspaceId, input.counterpartyId);
      invalidateMetrics(
        sqlite,
        { workspaceId: input.workspaceId, reason: "counterparty.updated" },
        this.#clock,
      );
      onMutation?.({
        entityType: "counterparty",
        entityId: input.counterpartyId,
        action: "counterparty.updated",
        beforeState: before,
        afterState: after,
      });
      return after;
    });
    return update();
  }

  #account(workspaceId: string, accountId: string): AccountRecord {
    const row = this.#sqlite()
      .prepare(
        `SELECT a.*, count(t.id) AS transaction_count
         FROM accounts a
         LEFT JOIN transactions t ON t.account_id = a.id
         WHERE a.workspace_id = ? AND a.id = ?
         GROUP BY a.id`,
      )
      .get(workspaceId, accountId) as AccountRow | undefined;
    if (!row) {
      throw new TransactionWorkspaceError("ACCOUNT_NOT_FOUND", "The account was not found.");
    }
    return mapAccount(row);
  }

  #category(workspaceId: string, categoryId: string): CategoryRecord {
    const row = this.#sqlite()
      .prepare(
        `SELECT c.*, count(t.id) AS transaction_count
         FROM categories c
         LEFT JOIN transactions t ON t.category_id = c.id
         WHERE c.workspace_id = ? AND c.id = ?
         GROUP BY c.id`,
      )
      .get(workspaceId, categoryId) as CategoryRow | undefined;
    if (!row) {
      throw new TransactionWorkspaceError("CATEGORY_NOT_FOUND", "The category was not found.");
    }
    return mapCategory(row);
  }

  #counterparty(workspaceId: string, counterpartyId: string): CounterpartyRecord {
    const row = this.#sqlite()
      .prepare(
        `SELECT cp.*, count(t.id) AS transaction_count
         FROM counterparties cp
         LEFT JOIN transactions t ON t.counterparty_id = cp.id
         WHERE cp.workspace_id = ? AND cp.id = ?
         GROUP BY cp.id`,
      )
      .get(workspaceId, counterpartyId) as CounterpartyRow | undefined;
    if (!row) {
      throw new TransactionWorkspaceError(
        "COUNTERPARTY_NOT_FOUND",
        "The counterparty was not found.",
      );
    }
    return mapCounterparty(row);
  }

  #requireCategory(workspaceId: string, categoryId: string): void {
    const exists = this.#sqlite()
      .prepare(
        `SELECT 1 FROM categories
         WHERE workspace_id = ? AND id = ? AND archived_at IS NULL`,
      )
      .get(workspaceId, categoryId);
    if (!exists) {
      throw new TransactionWorkspaceError(
        "CATEGORY_NOT_FOUND",
        "The category was not found or is archived.",
      );
    }
  }

  #validateCategoryParent(workspaceId: string, categoryId: string, parentId: string | null): void {
    if (!parentId) return;
    this.#requireCategory(workspaceId, parentId);
    if (parentId === categoryId) {
      throw new TransactionWorkspaceError(
        "CATEGORY_INVALID",
        "A category cannot be its own parent.",
      );
    }
    const descendant = this.#sqlite()
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM categories WHERE workspace_id = ? AND parent_id = ?
          UNION ALL
          SELECT c.id
          FROM categories c
          JOIN descendants d ON c.parent_id = d.id
          WHERE c.workspace_id = ?
        )
        SELECT 1 FROM descendants WHERE id = ?`,
      )
      .get(workspaceId, categoryId, workspaceId, parentId);
    if (descendant) {
      throw new TransactionWorkspaceError(
        "CATEGORY_INVALID",
        "A category cannot be nested beneath one of its descendants.",
      );
    }
  }

  #availableSlug(workspaceId: string, name: string, excludeId?: string): string {
    const base = slugify(name);
    let candidate = base;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const existing = this.#sqlite()
        .prepare(
          `SELECT id FROM categories
           WHERE workspace_id = ? AND slug = ?`,
        )
        .get(workspaceId, candidate) as { id: string } | undefined;
      if (!existing || existing.id === excludeId) return candidate;
      candidate = `${base}-${suffix}`;
    }
    throw new TransactionWorkspaceError(
      "CATEGORY_INVALID",
      "A unique category slug could not be generated.",
    );
  }
}

function mapAccount(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    institutionName: row.institution_name,
    institutionCode: row.institution_code,
    displayName: row.display_name,
    accountType: row.account_type,
    baseCurrency: row.base_currency,
    maskedAccountNumber: row.masked_account_number,
    isOwned: row.is_owned === 1,
    archivedAt: toIso(row.archived_at),
    transactionCount: row.transaction_count,
  };
}

function mapCategory(row: CategoryRow): CategoryRecord {
  return {
    id: row.id,
    parentId: row.parent_id,
    systemKey: row.system_key,
    slug: row.slug,
    name: row.name,
    description: row.description,
    archivedAt: toIso(row.archived_at),
    transactionCount: row.transaction_count,
    flags: {
      isIncome: row.is_income === 1,
      isExpense: row.is_expense === 1,
      isTransfer: row.is_transfer === 1,
      isEssential: row.is_essential === 1,
      isDiscretionary: row.is_discretionary === 1,
      isSavings: row.is_savings === 1,
      isRefund: row.is_refund === 1,
      isFee: row.is_fee === 1,
      isCashWithdrawal: row.is_cash_withdrawal === 1,
    },
  };
}

function mapCounterparty(row: CounterpartyRow): CounterpartyRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind,
    institutionName: row.institution_name,
    maskedAccountNumber: row.masked_account_number,
    transactionCount: row.transaction_count,
  };
}

function emptyCategoryFlags(): CategoryFlags {
  return {
    isIncome: false,
    isExpense: false,
    isTransfer: false,
    isEssential: false,
    isDiscretionary: false,
    isSavings: false,
    isRefund: false,
    isFee: false,
    isCashWithdrawal: false,
  };
}

function assertCategoryFlags(flags: CategoryFlags): void {
  if (flags.isEssential && flags.isDiscretionary) {
    throw new TransactionWorkspaceError(
      "CATEGORY_INVALID",
      "A category cannot be both essential and discretionary.",
    );
  }
}

function mergeCategoryFlags(
  base: CategoryFlags,
  changes: CategoryFlagChanges | undefined,
): CategoryFlags {
  const merged = { ...base };
  if (!changes) return merged;
  for (const [field, value] of Object.entries(changes) as Array<
    [keyof CategoryFlags, boolean | undefined]
  >) {
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

function flagsToValues(flags: CategoryFlags): number[] {
  return [
    flags.isIncome,
    flags.isExpense,
    flags.isTransfer,
    flags.isEssential,
    flags.isDiscretionary,
    flags.isSavings,
    flags.isRefund,
    flags.isFee,
    flags.isCashWithdrawal,
  ].map((value) => (value ? 1 : 0));
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error
      ? String((error as Error & { code: unknown }).code).startsWith("SQLITE_CONSTRAINT")
      : error.message.includes("UNIQUE constraint failed"))
  );
}

import type Database from "better-sqlite3";

export interface StarterCategory {
  key: string;
  slug: string;
  name: string;
  parentKey?: string;
  sortOrder: number;
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

type CategoryFlags = Partial<
  Pick<
    StarterCategory,
    | "isIncome"
    | "isExpense"
    | "isTransfer"
    | "isEssential"
    | "isDiscretionary"
    | "isSavings"
    | "isRefund"
    | "isFee"
    | "isCashWithdrawal"
  >
>;

function category(
  key: string,
  name: string,
  sortOrder: number,
  flags: CategoryFlags,
  parentKey?: string,
): StarterCategory {
  return {
    key,
    slug: key,
    name,
    sortOrder,
    ...(parentKey ? { parentKey } : {}),
    isIncome: false,
    isExpense: false,
    isTransfer: false,
    isEssential: false,
    isDiscretionary: false,
    isSavings: false,
    isRefund: false,
    isFee: false,
    isCashWithdrawal: false,
    ...flags,
  };
}

export const starterTaxonomy: readonly StarterCategory[] = [
  category("food-and-dining", "Food & Dining", 100, { isExpense: true }),
  category(
    "groceries",
    "Groceries",
    110,
    { isExpense: true, isEssential: true },
    "food-and-dining",
  ),
  category("transport", "Transport", 200, { isExpense: true, isEssential: true }),
  category("housing-and-rent", "Housing & Rent", 300, {
    isExpense: true,
    isEssential: true,
  }),
  category("utilities", "Utilities", 400, { isExpense: true, isEssential: true }),
  category("airtime-and-data", "Airtime & Data", 500, {
    isExpense: true,
    isEssential: true,
  }),
  category("entertainment", "Entertainment", 600, {
    isExpense: true,
    isDiscretionary: true,
  }),
  category("shopping", "Shopping", 700, { isExpense: true, isDiscretionary: true }),
  category("health", "Health", 800, { isExpense: true, isEssential: true }),
  category("education", "Education", 900, { isExpense: true, isEssential: true }),
  category("family-and-support", "Family & Support", 1000, { isExpense: true }),
  category("charity-and-giving", "Charity & Giving", 1100, { isExpense: true }),
  category("subscriptions", "Subscriptions", 1200, {
    isExpense: true,
    isDiscretionary: true,
  }),
  category("travel", "Travel", 1300, { isExpense: true, isDiscretionary: true }),
  category("cash-withdrawal", "Cash Withdrawal", 1400, { isCashWithdrawal: true }),
  category("bank-fees-and-charges", "Bank Fees & Charges", 1500, {
    isExpense: true,
    isFee: true,
  }),
  category("taxes", "Taxes", 1600, { isExpense: true, isEssential: true }),
  category("debt-and-loans", "Debt & Loans", 1700, {
    isIncome: true,
    isExpense: true,
  }),
  category("savings-and-investments", "Savings & Investments", 1800, {
    isTransfer: true,
    isSavings: true,
  }),
  category("salary-and-wages", "Salary & Wages", 1900, { isIncome: true }),
  category("business-income", "Business Income", 2000, { isIncome: true }),
  category("refunds-and-reversals", "Refunds & Reversals", 2100, {
    isIncome: true,
    isRefund: true,
  }),
  category("owned-account-transfers", "Transfers Between Owned Accounts", 2200, {
    isTransfer: true,
  }),
  category("other-or-unclassified", "Other / Unclassified", 2300, {
    isIncome: true,
    isExpense: true,
  }),
] as const;

export function starterCategoryId(workspaceId: string, key: string): string {
  return `${workspaceId}:category:${key}`;
}

export function seedStarterTaxonomy(sqlite: Database.Database, workspaceId: string): void {
  const insert = sqlite.prepare(`
    INSERT OR IGNORE INTO categories (
      id,
      workspace_id,
      parent_id,
      system_key,
      slug,
      name,
      sort_order,
      is_income,
      is_expense,
      is_transfer,
      is_essential,
      is_discretionary,
      is_savings,
      is_refund,
      is_fee,
      is_cash_withdrawal,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const now = Date.now();

  const seed = sqlite.transaction(() => {
    for (const entry of starterTaxonomy) {
      insert.run(
        starterCategoryId(workspaceId, entry.key),
        workspaceId,
        entry.parentKey ? starterCategoryId(workspaceId, entry.parentKey) : null,
        entry.key,
        entry.slug,
        entry.name,
        entry.sortOrder,
        Number(entry.isIncome),
        Number(entry.isExpense),
        Number(entry.isTransfer),
        Number(entry.isEssential),
        Number(entry.isDiscretionary),
        Number(entry.isSavings),
        Number(entry.isRefund),
        Number(entry.isFee),
        Number(entry.isCashWithdrawal),
        now,
        now,
      );
    }
  });

  seed();
}

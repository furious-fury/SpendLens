import {
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import {
  ArrowLineDown,
  ArrowLineUp,
  ArrowsLeftRight,
  BookOpenText,
  Brain,
  FileArrowDown,
  Receipt,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { AppShell } from "@/components/app-shell";
import { AccountsPage } from "@/pages/accounts-page";
import { OverviewPage } from "@/pages/overview-page";
import { PlaceholderPage } from "@/pages/placeholder-page";
import { SecuritySettingsPage } from "@/pages/security-settings-page";
import { parseTransactionSearch, TransactionsPage } from "@/pages/transactions-page";

const rootRoute = createRootRoute({
  component: AppShell,
  errorComponent: RouteError,
  notFoundComponent: () => (
    <PlaceholderPage
      icon={Receipt}
      title="Page not found"
      description="The requested SpendLens page does not exist."
    />
  ),
});

function placeholder<const TPath extends string>(
  path: TPath,
  title: string,
  description: string,
  icon: typeof Receipt,
) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <PlaceholderPage icon={icon} title={title} description={description} />,
  });
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SecuritySettingsPage,
});

const transactionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/transactions",
  validateSearch: parseTransactionSearch,
  component: TransactionsPage,
});

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/accounts",
  component: AccountsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  transactionsRoute,
  placeholder(
    "/review",
    "Review uncertain activity",
    "Clarify suggested categories, resolve duplicates, and teach SpendLens what to remember.",
    BookOpenText,
  ),
  placeholder(
    "/spending",
    "Understand your spending",
    "Explore categories, counterparties, recurring expenses, fees, and unusual activity.",
    ArrowLineUp,
  ),
  placeholder(
    "/income",
    "Understand your income",
    "Compare sources, timing, recurrence, concentration, and genuine income versus refunds.",
    ArrowLineDown,
  ),
  placeholder(
    "/cash-flow",
    "Follow your cash flow",
    "See inflow, outflow, cumulative movement, and account-level activity over time.",
    ArrowsLeftRight,
  ),
  placeholder(
    "/behaviour",
    "See your financial patterns",
    "Explore how and when you move money without turning your finances into a score.",
    Brain,
  ),
  placeholder(
    "/imports",
    "Import a statement",
    "Upload a PalmPay PDF, preview detected transactions, and confirm the import safely.",
    FileArrowDown,
  ),
  placeholder(
    "/rules",
    "Manage remembered decisions",
    "Inspect, prioritize, disable, and update the rules behind automatic classifications.",
    SlidersHorizontal,
  ),
  accountsRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function RouteError({ error }: ErrorComponentProps) {
  return (
    <PlaceholderPage
      icon={Receipt}
      title="Something went wrong"
      description={`${error.message}. Refresh the page or try the action again.`}
    />
  );
}

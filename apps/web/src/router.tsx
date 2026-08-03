import { FileArrowDown, Receipt } from "@phosphor-icons/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { AccountsPage } from "@/pages/accounts-page";
import { PlaceholderPage } from "@/pages/placeholder-page";
import { ReviewPage } from "@/pages/review-page";
import { RulesPage } from "@/pages/rules-page";
import { SecuritySettingsPage } from "@/pages/security-settings-page";
import { parseTransactionSearch, TransactionsPage } from "@/pages/transactions-page";
import { parseInsightSearch } from "@/lib/insights";

const OverviewPage = lazy(async () => {
  const module = await import("@/pages/overview-page");
  return { default: module.OverviewPage };
});

const SpendingPage = lazy(async () => {
  const module = await import("@/pages/insights-page");
  return { default: module.SpendingPage };
});

const IncomePage = lazy(async () => {
  const module = await import("@/pages/insights-page");
  return { default: module.IncomePage };
});

const CashFlowPage = lazy(async () => {
  const module = await import("@/pages/insights-page");
  return { default: module.CashFlowPage };
});

const BehaviourPage = lazy(async () => {
  const module = await import("@/pages/insights-page");
  return { default: module.BehaviourPage };
});

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
  component: () => (
    <Suspense
      fallback={
        <div
          className="h-[420px] animate-pulse rounded-xl border border-border bg-muted/40"
          role="status"
          aria-label="Loading overview"
        />
      }
    >
      <OverviewPage />
    </Suspense>
  ),
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

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review",
  component: ReviewPage,
});

const rulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rules",
  component: RulesPage,
});

function insightRoute(
  path: "/spending" | "/income" | "/cash-flow" | "/behaviour",
  Page: typeof SpendingPage,
) {
  return createRoute({
    getParentRoute: () => rootRoute,
    path,
    validateSearch: parseInsightSearch,
    component: () => (
      <Suspense
        fallback={
          <div
            className="h-[520px] animate-pulse rounded-xl border border-border bg-muted/40"
            role="status"
            aria-label="Loading detailed insights"
          />
        }
      >
        <Page />
      </Suspense>
    ),
  });
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  transactionsRoute,
  reviewRoute,
  insightRoute("/spending", SpendingPage),
  insightRoute("/income", IncomePage),
  insightRoute("/cash-flow", CashFlowPage),
  insightRoute("/behaviour", BehaviourPage),
  placeholder(
    "/imports",
    "Import a statement",
    "Upload a PalmPay PDF, preview detected transactions, and confirm the import safely.",
    FileArrowDown,
  ),
  rulesRoute,
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

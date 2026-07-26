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
  Bank,
  Receipt,
  GearSix,
  SlidersHorizontal,
} from "@phosphor-icons/react";
import { AppShell } from "@/components/app-shell";
import { OverviewPage } from "@/pages/overview-page";
import { PlaceholderPage } from "@/pages/placeholder-page";

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

const routeTree = rootRoute.addChildren([
  indexRoute,
  placeholder(
    "/transactions",
    "Your transaction workspace",
    "Search, filter, edit, split, and understand imported activity in one place.",
    Receipt,
  ),
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
  placeholder(
    "/accounts",
    "Manage your accounts",
    "Register owned accounts so internal transfers never distort income or spending.",
    Bank,
  ),
  placeholder(
    "/settings",
    "Configure SpendLens",
    "Control privacy, appearance, AI providers, security, backups, and local operation.",
    GearSix,
  ),
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

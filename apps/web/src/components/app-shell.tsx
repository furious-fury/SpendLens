import {
  CaretDoubleLeft,
  CaretDoubleRight,
  Gauge,
  CaretRight,
  List,
  SealCheck,
  SignOut,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ThemeMenu } from "@/components/theme-menu";
import { useSecurity } from "@/components/security-gate";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SuppliedBank,
  SuppliedBookSaved,
  SuppliedChart,
  SuppliedDocumentDownload,
  SuppliedGear,
  SuppliedExportArrow,
  SuppliedFlashCircle,
  SuppliedImportArrow,
  SuppliedMore,
  SuppliedReceipt,
  SuppliedSearch,
  SuppliedSliders,
  SuppliedTransfer,
} from "@/components/supplied-icons";
import { SpendLensMark } from "@/components/spendlens-logo";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  path: string;
  icon: Icon | typeof SuppliedBank;
  shortLabel?: string;
}

const primaryNavigation: NavItem[] = [
  { label: "Overview", path: "/", icon: Gauge },
  { label: "Transactions", path: "/transactions", icon: SuppliedReceipt },
  { label: "Review", path: "/review", icon: SuppliedBookSaved },
];

const insightNavigation: NavItem[] = [
  { label: "Spending", path: "/spending", icon: SuppliedExportArrow },
  { label: "Income", path: "/income", icon: SuppliedImportArrow },
  { label: "Cash Flow", path: "/cash-flow", icon: SuppliedTransfer },
  { label: "Behaviour", path: "/behaviour", icon: SuppliedFlashCircle },
];

const managementNavigation: NavItem[] = [
  { label: "Imports", path: "/imports", icon: SuppliedDocumentDownload },
  { label: "Rules", path: "/rules", icon: SuppliedSliders },
  { label: "Accounts", path: "/accounts", icon: SuppliedBank },
  { label: "Settings", path: "/settings", icon: SuppliedGear },
];

const mobileNavigation: NavItem[] = [
  { label: "Overview", shortLabel: "Overview", path: "/", icon: Gauge },
  {
    label: "Transactions",
    shortLabel: "Transactions",
    path: "/transactions",
    icon: SuppliedReceipt,
  },
  { label: "Review", shortLabel: "Review", path: "/review", icon: SuppliedBookSaved },
  { label: "Insights", shortLabel: "Insights", path: "/spending", icon: SuppliedChart },
  { label: "More", shortLabel: "More", path: "/settings", icon: SuppliedMore },
];

const defaultRouteMeta = {
  title: "Overview",
  description: "A clear view of how your money moved.",
};

const routeTitles: Record<string, { title: string; description: string }> = {
  "/": defaultRouteMeta,
  "/transactions": {
    title: "Transactions",
    description: "Search, understand, and correct your financial activity.",
  },
  "/review": {
    title: "Review",
    description: "Resolve uncertain classifications and possible duplicates.",
  },
  "/spending": {
    title: "Spending",
    description: "See where money went and what changed.",
  },
  "/income": {
    title: "Income",
    description: "Understand where money came from and how reliable it is.",
  },
  "/cash-flow": {
    title: "Cash Flow",
    description: "Compare inflows, outflows, and net movement over time.",
  },
  "/behaviour": {
    title: "Behaviour",
    description: "Patterns in how and when you move money.",
  },
  "/imports": {
    title: "Imports",
    description: "Bring in statements and verify what SpendLens found.",
  },
  "/rules": {
    title: "Rules",
    description: "Manage the decisions SpendLens remembers.",
  },
  "/accounts": {
    title: "Accounts",
    description: "Manage owned accounts and internal transfers.",
  },
  "/settings": {
    title: "Settings",
    description: "Control privacy, appearance, AI providers, and backups.",
  },
};
const routeSections: Record<string, string> = {
  "/": "Workspace",
  "/transactions": "Workspace",
  "/review": "Workspace",
  "/spending": "Insights",
  "/income": "Insights",
  "/cash-flow": "Insights",
  "/behaviour": "Insights",
  "/imports": "Manage",
  "/rules": "Manage",
  "/accounts": "Manage",
  "/settings": "Manage",
};

function PageHeader({
  meta,
  section,
}: {
  meta: { title: string; description: string };
  section: string;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 border-b border-border bg-background px-4 py-4 sm:flex-row sm:items-end sm:justify-between md:px-5 md:py-5">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-[-0.035em] md:text-[28px]">{meta.title}</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{meta.description}</p>
      </div>
      <nav className="order-first shrink-0 sm:order-last sm:pb-1" aria-label="Breadcrumb">
        <ol className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <li>{section}</li>
          <li aria-hidden="true"><CaretRight className="size-3.5" weight="bold" /></li>
          <li className="text-foreground" aria-current="page">{meta.title}</li>
        </ol>
      </nav>
    </header>
  );
}


function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <Link to="/" className="flex min-w-0 items-center gap-3" aria-label="SpendLens overview">
      <span className="grid size-10 shrink-0 place-items-center rounded-md border border-black/5 bg-white/95 shadow-sm">
        <SpendLensMark className="size-8" tone="accent" />
      </span>
      {!collapsed && (
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold tracking-[-0.02em]">
            SpendLens
          </span>
          <span className="block truncate text-[9px] font-medium uppercase tracking-[0.1em] text-sidebar-foreground/50">
            Open source personal finance
          </span>
        </span>
      )}
    </Link>
  );
}

function NavigationLink({
  collapsed,
  item,
  active,
  onNavigate,
}: {
  collapsed: boolean;
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const content = (
    <Link
      to={item.path}
      onClick={onNavigate}
      className={cn(
        "group relative flex h-10 items-center gap-3 rounded pr-3 text-sm text-sidebar-foreground/62 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
        active && "bg-sidebar-accent font-medium text-sidebar-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <span
        className={cn(
          "grid h-full w-10 shrink-0 place-items-center rounded-l rounded-r-none transition-[background-color,color,box-shadow]",
          active
            ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
            : "text-sidebar-foreground/58 group-hover:text-sidebar-foreground",
          collapsed && "w-full rounded",
        )}
      >
        <Icon className="size-[17px]" weight="bold" />
      </span>
      {!collapsed && <span className="leading-none">{item.label}</span>}
    </Link>
  );

  if (!collapsed) {
    return content;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent side="right">{item.label}</TooltipContent>
    </Tooltip>
  );
}

const navigationSections = [
  { label: "Workspace", ariaLabel: "Primary navigation", items: primaryNavigation },
  { label: "Insights", ariaLabel: "Insights navigation", items: insightNavigation },
  { label: "Manage", ariaLabel: "Management navigation", items: managementNavigation },
];

export function isNavigationItemActive(pathname: string, itemPath: string) {
  return itemPath === "/" ? pathname === "/" : pathname.startsWith(itemPath);
}

function SidebarNavigation({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div>
      {navigationSections.map((section, index) => (
        <div
          key={section.label}
          className={cn(index > 0 && "mt-5 border-t border-sidebar-border pt-5")}
        >
          {!collapsed && (
            <p className="mb-2 px-2.5 text-[11px] font-semibold uppercase tracking-[0.11em] text-sidebar-foreground/42">
              {section.label}
            </p>
          )}
          <nav aria-label={section.ariaLabel} className="space-y-1.5">
            {section.items.map((item) => (
              <NavigationLink
                key={item.path}
                collapsed={collapsed}
                item={item}
                active={isNavigationItemActive(pathname, item.path)}
                onNavigate={onNavigate}
              />
            ))}
          </nav>
        </div>
      ))}
    </div>
  );
}

function Sidebar({
  collapsed,
  mobileOpen,
  onCollapse,
  onMobileClose,
  onSignOut,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapse: () => void;
  onMobileClose: () => void;
  onSignOut: () => void;
}) {
  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          aria-label="Close navigation"
          onClick={onMobileClose}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200",
          collapsed && "lg:w-[76px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div
          className={cn(
            "flex h-[72px] items-center justify-between border-b border-sidebar-border px-5",
            collapsed && "lg:justify-center lg:px-3",
          )}
        >
          <Brand collapsed={collapsed} />
          <Button
            variant="ghost"
            size="icon"
            className="text-sidebar-foreground hover:bg-sidebar-accent lg:hidden"
            onClick={onMobileClose}
            aria-label="Close navigation"
          >
            <X />
          </Button>
        </div>

        <div className="scrollbar-none flex-1 overflow-y-auto px-3 py-4">
          <SidebarNavigation collapsed={collapsed} onNavigate={onMobileClose} />
        </div>

        <div className="border-t border-sidebar-border p-3">
          <button
            type="button"
            className={cn(
              "hidden h-10 w-full items-center gap-3 rounded px-3 text-sm text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground lg:flex",
              collapsed && "justify-center px-0",
            )}
            onClick={onCollapse}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <CaretDoubleRight /> : <CaretDoubleLeft />}
            {!collapsed && <span>Collapse sidebar</span>}
          </button>
          <div
            className={cn(
              "mt-1 flex items-center gap-3 rounded px-3 py-2",
              collapsed && "justify-center px-0",
            )}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-primary/15 text-sidebar-primary">
              <SealCheck className="size-4" weight="fill" />
            </span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium">Local workspace</span>
                <span className="block truncate text-[11px] text-sidebar-foreground/40">
                  Your data stays here
                </span>
              </span>
            )}
          </div>
          <button
            type="button"
            className={cn(
              "mt-1 flex h-9 w-full items-center gap-3 rounded px-3 text-xs text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
              collapsed && "justify-center px-0",
            )}
            onClick={onSignOut}
            aria-label="Sign out"
          >
            <SignOut className="size-4" />
            {!collapsed && <span>Sign out</span>}
          </button>
        </div>
      </aside>
    </>
  );
}

function MobileBottomNavigation() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 grid h-[68px] grid-cols-5 border-t border-border bg-background/96 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      aria-label="Mobile navigation"
    >
      {mobileNavigation.map((item) => {
        const Icon = item.icon;
        const active =
          item.path === "/"
            ? pathname === "/"
            : item.label === "Insights"
              ? ["/spending", "/income", "/cash-flow", "/behaviour"].some((path) =>
                  pathname.startsWith(path),
                )
              : pathname.startsWith(item.path);
        return (
          <Link
            key={item.label}
            to={item.path}
            className={cn(
              "flex min-w-0 flex-col items-center justify-center gap-1 text-[10px] font-medium text-muted-foreground",
              active && "text-primary",
            )}
          >
            <Icon className="size-[19px]" weight={active ? "bold" : "regular"} />
            <span className="truncate">{item.shortLabel}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell() {
  const security = useSecurity();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("sidebar") === "collapsed");
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const meta = routeTitles[pathname] ?? defaultRouteMeta;

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem("sidebar", next ? "collapsed" : "expanded");
      return next;
    });
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-dvh bg-background">
        <Sidebar
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onCollapse={toggleCollapsed}
          onMobileClose={() => setMobileOpen(false)}
          onSignOut={() => void security.signOut()}
        />
        <div
          className={cn(
            "app-main-surface min-h-dvh transition-[padding] duration-200 lg:pl-72",
            collapsed && "lg:pl-[76px]",
          )}
        >
          <header className="sticky top-0 z-20 grid h-[72px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-sidebar-border bg-sidebar/92 px-4 backdrop-blur md:grid-cols-[minmax(2.5rem,1fr)_minmax(20rem,50rem)_minmax(2.5rem,1fr)] md:px-7">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="Open navigation"
              >
                <List />
              </Button>
            </div>
            <button
              type="button"
              className="hidden h-10 w-full items-center gap-2.5 rounded-xl border border-border bg-background/72 px-3.5 text-left text-sm text-muted-foreground shadow-[0_1px_2px_oklch(0.2_0.02_260_/_0.04)] transition-[background-color,border-color,box-shadow] hover:border-primary/25 hover:bg-background hover:shadow-sm md:flex"
              aria-label="Search SpendLens"
            >
              <SuppliedSearch className="size-[17px]" />
              <span className="flex-1">Search transactions</span>
              <kbd className="rounded-md border border-border bg-card px-1.5 py-0.5 text-[10px] shadow-sm">/</kbd>
            </button>
            <div className="flex items-center justify-end gap-2">
              <ThemeMenu />
            </div>
          </header>
          <main className="relative z-10 mx-auto w-full max-w-[1540px] p-4 pb-24 md:p-7 lg:pb-10">
            <PageHeader meta={meta} section={routeSections[pathname] ?? "SpendLens"} />
            <Outlet />
          </main>
        </div>
        <MobileBottomNavigation />
      </div>
    </TooltipProvider>
  );
}

export const routeMeta = routeTitles;

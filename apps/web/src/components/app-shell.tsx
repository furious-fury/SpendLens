import {
  ArrowLineDown,
  ArrowLineUp,
  ArrowsLeftRight,
  Bank,
  BookOpenText,
  Brain,
  CaretDoubleLeft,
  CaretDoubleRight,
  ChartBar,
  CurrencyCircleDollar,
  DotsThree,
  FileArrowDown,
  Gauge,
  GearSix,
  List,
  MagnifyingGlass,
  Receipt,
  SealCheck,
  SignOut,
  SlidersHorizontal,
  X,
  type Icon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ThemeMenu } from "@/components/theme-menu";
import { useSecurity } from "@/components/security-gate";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  path: string;
  icon: Icon;
  shortLabel?: string;
}

const primaryNavigation: NavItem[] = [
  { label: "Overview", path: "/", icon: Gauge },
  { label: "Transactions", path: "/transactions", icon: Receipt },
  { label: "Review", path: "/review", icon: BookOpenText },
  { label: "Spending", path: "/spending", icon: ArrowLineUp },
  { label: "Income", path: "/income", icon: ArrowLineDown },
  { label: "Cash Flow", path: "/cash-flow", icon: ArrowsLeftRight },
  { label: "Behaviour", path: "/behaviour", icon: Brain },
];

const managementNavigation: NavItem[] = [
  { label: "Imports", path: "/imports", icon: FileArrowDown },
  { label: "Rules", path: "/rules", icon: SlidersHorizontal },
  { label: "Accounts", path: "/accounts", icon: Bank },
  { label: "Settings", path: "/settings", icon: GearSix },
];

const mobileNavigation: NavItem[] = [
  { label: "Overview", shortLabel: "Overview", path: "/", icon: Gauge },
  {
    label: "Transactions",
    shortLabel: "Transactions",
    path: "/transactions",
    icon: Receipt,
  },
  { label: "Review", shortLabel: "Review", path: "/review", icon: BookOpenText },
  { label: "Insights", shortLabel: "Insights", path: "/spending", icon: ChartBar },
  { label: "More", shortLabel: "More", path: "/settings", icon: DotsThree },
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

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <Link to="/" className="flex min-w-0 items-center gap-3" aria-label="SpendLens overview">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-sm">
        <CurrencyCircleDollar className="size-5" weight="regular" />
      </span>
      {!collapsed && (
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-semibold tracking-[-0.02em]">
            SpendLens
          </span>
          <span className="block truncate text-[10px] font-medium uppercase tracking-[0.16em] text-sidebar-foreground/45">
            Private intelligence
          </span>
        </span>
      )}
    </Link>
  );
}

function NavigationLink({
  collapsed,
  item,
  onNavigate,
}: {
  collapsed: boolean;
  item: NavItem;
  onNavigate?: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = item.path === "/" ? pathname === "/" : pathname.startsWith(item.path);
  const Icon = item.icon;
  const content = (
    <Link
      to={item.path}
      onClick={onNavigate}
      className={cn(
        "group relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium text-sidebar-foreground/64 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
        active && "bg-sidebar-accent text-sidebar-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="size-[18px] shrink-0" weight={active ? "bold" : "regular"} />
      {!collapsed && <span>{item.label}</span>}
      {active && (
        <span className="absolute inset-y-2 -right-px w-0.5 rounded-full bg-sidebar-primary" />
      )}
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
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width,transform] duration-200",
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

        <div className="scrollbar-none flex-1 overflow-y-auto px-3 py-5">
          <nav aria-label="Primary navigation" className="space-y-1">
            {primaryNavigation.map((item) => (
              <NavigationLink
                key={item.path}
                collapsed={collapsed}
                item={item}
                onNavigate={onMobileClose}
              />
            ))}
          </nav>
          <div className="my-5 h-px bg-sidebar-border" />
          {!collapsed && (
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/35">
              Manage
            </p>
          )}
          <nav aria-label="Management navigation" className="space-y-1">
            {managementNavigation.map((item) => (
              <NavigationLink
                key={item.path}
                collapsed={collapsed}
                item={item}
                onNavigate={onMobileClose}
              />
            ))}
          </nav>
        </div>

        <div className="border-t border-sidebar-border p-3">
          <button
            type="button"
            className={cn(
              "hidden h-10 w-full items-center gap-3 rounded-lg px-3 text-sm text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground lg:flex",
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
              "mt-1 flex items-center gap-3 rounded-lg px-3 py-2",
              collapsed && "justify-center px-0",
            )}
          >
            <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-sidebar-primary/15 text-sidebar-primary">
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
              "mt-1 flex h-9 w-full items-center gap-3 rounded-lg px-3 text-xs text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
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
            "min-h-dvh transition-[padding] duration-200 lg:pl-64",
            collapsed && "lg:pl-[76px]",
          )}
        >
          <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-border bg-background/92 px-4 backdrop-blur md:px-6">
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
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-[-0.025em]">{meta.title}</h1>
                <p className="hidden truncate text-xs text-muted-foreground sm:block">
                  {meta.description}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="hidden h-9 w-56 items-center gap-2 rounded-lg border border-border bg-muted/45 px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted md:flex"
                aria-label="Search SpendLens"
              >
                <MagnifyingGlass className="size-4" />
                <span className="flex-1">Search transactions</span>
                <kbd className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px]">
                  /
                </kbd>
              </button>
              <ThemeMenu />
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1600px] p-4 pb-24 md:p-6 lg:pb-8">
            <Outlet />
          </main>
        </div>
        <MobileBottomNavigation />
      </div>
    </TooltipProvider>
  );
}

export const routeMeta = routeTitles;

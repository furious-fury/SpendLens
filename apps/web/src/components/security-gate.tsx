import {
  ArrowClockwise,
  CheckCircle,
  Copy,
  CurrencyCircleDollar,
  DownloadSimple,
  Eye,
  EyeSlash,
  LockKey,
  ShieldCheck,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecoveryKit, SetupRequest } from "@spendlens/contracts";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "@/lib/api";

interface SecurityContextValue {
  signOut(): Promise<void>;
}

const SecurityContext = createContext<SecurityContextValue | null>(null);

export function useSecurity(): SecurityContextValue {
  const context = useContext(SecurityContext);
  if (!context) {
    throw new Error("Security context is only available inside the authenticated application.");
  }
  return context;
}

export function SecurityGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const stateQuery = useQuery({
    queryKey: ["security-state"],
    queryFn: api.securityState,
    retry: false,
  });

  const context = useMemo<SecurityContextValue>(
    () => ({
      async signOut() {
        await api.logout();
        await queryClient.invalidateQueries({ queryKey: ["security-state"] });
      },
    }),
    [queryClient],
  );

  if (stateQuery.isPending) {
    return <SecurityLoading />;
  }

  if (stateQuery.isError) {
    return (
      <SecurityFrame>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>SpendLens could not open securely</CardTitle>
            <CardDescription>{errorMessage(stateQuery.error)}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={() => stateQuery.refetch()}>
              <ArrowClockwise />
              Try again
            </Button>
          </CardContent>
        </Card>
      </SecurityFrame>
    );
  }

  if (stateQuery.data.status === "setup-required") {
    return (
      <SetupWizard
        setupPhase={stateQuery.data.setupPhase}
        keyMode={stateQuery.data.keyMode}
        onComplete={() => queryClient.invalidateQueries({ queryKey: ["security-state"] })}
      />
    );
  }

  if (stateQuery.data.status === "unauthenticated") {
    return (
      <LoginScreen
        onAuthenticated={() => queryClient.invalidateQueries({ queryKey: ["security-state"] })}
      />
    );
  }

  return <SecurityContext.Provider value={context}>{children}</SecurityContext.Provider>;
}

function SecurityFrame({ children }: { children: ReactNode }) {
  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-background px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,color-mix(in_oklch,var(--primary)_9%,transparent),transparent_35%)]" />
      <div className="relative flex w-full flex-col items-center gap-6">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground">
            <CurrencyCircleDollar className="size-6" />
          </span>
          <div>
            <p className="font-semibold tracking-[-0.02em]">SpendLens</p>
            <p className="text-xs text-muted-foreground">Private financial intelligence</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

function SecurityLoading() {
  return (
    <SecurityFrame>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ArrowClockwise className="animate-spin" />
        Opening your private workspace…
      </div>
    </SecurityFrame>
  );
}

function LoginScreen({ onAuthenticated }: { onAuthenticated(): Promise<unknown> }) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const login = useMutation({
    mutationFn: () => api.login(password),
    onSuccess: onAuthenticated,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate();
  }

  return (
    <SecurityFrame>
      <Card className="w-full max-w-md">
        <CardHeader className="pb-4">
          <span className="mb-2 grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <LockKey className="size-5" />
          </span>
          <CardTitle className="text-xl">Unlock SpendLens</CardTitle>
          <CardDescription>
            Your financial data is encrypted locally. Sign in with your SpendLens password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={submit}>
            <PasswordField
              id="login-password"
              label="Password"
              value={password}
              show={showPassword}
              onShowChange={setShowPassword}
              onChange={setPassword}
              autoFocus
            />
            {login.error && <InlineError error={login.error} />}
            <Button className="w-full" disabled={login.isPending || !password}>
              {login.isPending ? "Unlocking…" : "Unlock workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="max-w-sm text-center text-xs leading-5 text-muted-foreground">
        This login is required on localhost and on remotely hosted installations.
      </p>
    </SecurityFrame>
  );
}

function SetupWizard({
  setupPhase,
  keyMode,
  onComplete,
}: {
  setupPhase: "new" | "recovery-confirmation";
  keyMode: "keyring" | "secret-file";
  onComplete(): Promise<unknown>;
}) {
  const [form, setForm] = useState<SetupRequest>(() => ({
    setupToken: "",
    workspaceName: "My SpendLens",
    displayName: "",
    password: "",
    confirmPassword: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos",
  }));
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const prepare = useMutation({
    mutationFn: () => api.setup(form),
    onSuccess: (result) => setRecoveryKit(result.recoveryKit),
  });
  const complete = useMutation({
    mutationFn: () => api.completeSetup(form.setupToken),
    onSuccess: onComplete,
  });

  if (recoveryKit) {
    return (
      <SecurityFrame>
        <Card className="w-full max-w-xl">
          <CardHeader>
            <span className="mb-2 grid size-10 place-items-center rounded-xl bg-success/10 text-success">
              <ShieldCheck className="size-5" />
            </span>
            <CardTitle className="text-xl">Save your recovery material</CardTitle>
            <CardDescription>
              Store the file and code separately. You will need both plus an encrypted backup after
              a device loss.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => downloadRecoveryFile(recoveryKit)}
              >
                <DownloadSimple />
                Download recovery file
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigator.clipboard.writeText(recoveryKit.recoveryCode)}
              >
                <Copy />
                Copy recovery code
              </Button>
            </div>
            <div className="rounded-xl border border-attention/30 bg-attention/8 p-4">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Recovery code
              </p>
              <code className="mt-2 block break-all font-mono text-sm font-semibold tracking-wide">
                {recoveryKit.recoveryCode}
              </code>
            </div>
            <label
              htmlFor="recovery-confirmed"
              className="flex cursor-pointer items-start gap-3 rounded-xl border p-4"
            >
              <Checkbox
                id="recovery-confirmed"
                checked={recoveryConfirmed}
                onCheckedChange={(checked) => setRecoveryConfirmed(checked === true)}
                className="mt-0.5"
              />
              <span className="text-sm leading-5">
                I saved the recovery file and code in separate, safe locations.
              </span>
            </label>
            {complete.error && <InlineError error={complete.error} />}
            <Button
              className="w-full"
              disabled={!recoveryConfirmed || complete.isPending}
              onClick={() => complete.mutate()}
            >
              <CheckCircle />
              {complete.isPending ? "Finishing setup…" : "Finish secure setup"}
            </Button>
          </CardContent>
        </Card>
      </SecurityFrame>
    );
  }

  function update<K extends keyof SetupRequest>(field: K, value: SetupRequest[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <SecurityFrame>
      <Card className="w-full max-w-xl">
        <CardHeader>
          <span className="mb-2 grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="size-5" />
          </span>
          <CardTitle className="text-xl">
            {setupPhase === "new" ? "Create your private workspace" : "Resume secure setup"}
          </CardTitle>
          <CardDescription>
            SpendLens will encrypt the local database and require this password every time you sign
            in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              prepare.mutate();
            }}
          >
            <Field
              id="setup-name"
              label="Your name"
              value={form.displayName}
              onChange={(value) => update("displayName", value)}
              autoComplete="name"
            />
            <Field
              id="workspace-name"
              label="Workspace name"
              value={form.workspaceName}
              onChange={(value) => update("workspaceName", value)}
            />
            <div className="sm:col-span-2">
              <Field
                id="timezone"
                label="Timezone"
                value={form.timezone}
                onChange={(value) => update("timezone", value)}
              />
            </div>
            <PasswordField
              id="setup-password"
              label="Password"
              value={form.password}
              show={showPassword}
              onShowChange={setShowPassword}
              onChange={(value) => update("password", value)}
              hint="At least 12 characters"
            />
            <PasswordField
              id="setup-confirm-password"
              label="Confirm password"
              value={form.confirmPassword}
              show={showPassword}
              onShowChange={setShowPassword}
              onChange={(value) => update("confirmPassword", value)}
            />
            <div className="sm:col-span-2">
              <Field
                id="setup-token"
                label="One-time setup token"
                value={form.setupToken}
                onChange={(value) => update("setupToken", value)}
                autoComplete="off"
                hint={
                  keyMode === "secret-file"
                    ? "Read it with: pnpm security:setup-token"
                    : "Start the server, then run: pnpm security:setup-token"
                }
              />
            </div>
            {prepare.error && (
              <div className="sm:col-span-2">
                <InlineError error={prepare.error} />
              </div>
            )}
            <Button className="sm:col-span-2" disabled={prepare.isPending}>
              {prepare.isPending ? "Encrypting workspace…" : "Create encrypted workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </SecurityFrame>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  hint,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  hint?: string;
  autoComplete?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  show,
  onShowChange,
  onChange,
  hint,
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  show: boolean;
  onShowChange(show: boolean): void;
  onChange(value: string): void;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={id.includes("login") ? "current-password" : "new-password"}
          className="pr-10"
          required
          autoFocus={autoFocus}
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
          onClick={() => onShowChange(!show)}
          aria-label={show ? "Hide password" : "Show password"}
        >
          {show ? <EyeSlash /> : <Eye />}
        </button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function InlineError({ error }: { error: unknown }) {
  const message = errorMessage(error);
  const retry =
    error instanceof ApiError && error.retryAfterSeconds
      ? ` Try again in ${error.retryAfterSeconds} seconds.`
      : "";
  return (
    <div role="alert" className="rounded-lg border border-danger/25 bg-danger/8 p-3 text-sm">
      {message}
      {retry}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function downloadRecoveryFile(kit: RecoveryKit): void {
  const blob = new Blob([`${JSON.stringify(kit.recoveryFile, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `spendlens-recovery-${kit.recoveryFile.workspaceId}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

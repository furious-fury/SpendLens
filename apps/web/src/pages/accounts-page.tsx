import type { Account, AccountType } from "@spendlens/contracts";
import { Archive, Bank, CheckCircle, Plus, ShieldCheck } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export function AccountsPage() {
  const queryClient = useQueryClient();
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const [selected, setSelected] = useState<Account | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["accounts"] }),
      queryClient.invalidateQueries({ queryKey: ["transactions"] }),
    ]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <p className="text-sm text-muted-foreground">
            Owned accounts help SpendLens identify internal transfers without counting them as
            income or spending.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus />
          Add account
        </Button>
      </div>

      {message && <p className="rounded-lg bg-muted px-4 py-3 text-sm">{message}</p>}

      {accountsQuery.isLoading ? (
        <Card>
          <CardContent className="grid min-h-52 place-items-center text-sm text-muted-foreground">
            Loading accounts…
          </CardContent>
        </Card>
      ) : accountsQuery.data?.items.length === 0 ? (
        <Card>
          <CardContent className="grid min-h-52 place-items-center p-8 text-center">
            <div>
              <Bank className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">No accounts yet</p>
              <p className="mt-1 text-xs text-muted-foreground">
                An account is also created automatically when you commit your first statement.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {accountsQuery.data?.items.map((account) => (
            <button
              type="button"
              key={account.id}
              className={cn(
                "rounded-xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/35 hover:bg-muted/20",
                account.archivedAt && "opacity-60",
              )}
              onClick={() => setSelected(account)}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-primary/9 text-primary">
                  <Bank className="size-5" />
                </span>
                {account.isOwned && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-1 text-[11px] text-success">
                    <CheckCircle weight="fill" />
                    Owned
                  </span>
                )}
              </div>
              <p className="mt-4 font-semibold">{account.displayName}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {account.institutionName} · {account.accountType}
              </p>
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <span>{account.maskedAccountNumber ?? "No identifier"}</span>
                <span>
                  {account.transactionCount} transaction
                  {account.transactionCount === 1 ? "" : "s"}
                </span>
              </div>
              {account.archivedAt && (
                <p className="mt-3 text-xs font-medium text-attention">Archived</p>
              )}
            </button>
          ))}
        </div>
      )}

      <CreateAccountSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async () => {
          setCreating(false);
          setMessage("Account created.");
          await refresh();
        }}
      />
      <EditAccountSheet
        account={selected}
        onClose={() => setSelected(null)}
        onUpdated={async (next, notice) => {
          setSelected(next);
          setMessage(notice);
          await refresh();
        }}
      />
    </div>
  );
}

function CreateAccountSheet({
  onClose,
  onCreated,
  open,
}: {
  onClose: () => void;
  onCreated: () => Promise<void>;
  open: boolean;
}) {
  const [displayName, setDisplayName] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [institutionCode, setInstitutionCode] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("wallet");
  const [currency, setCurrency] = useState("NGN");
  const [isOwned, setIsOwned] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createAccount({
        displayName,
        institutionName,
        institutionCode: institutionCode || null,
        accountType,
        baseCurrency: currency.toUpperCase(),
        isOwned,
      });
      setDisplayName("");
      setInstitutionName("");
      setInstitutionCode("");
      await onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The account could not be created.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Add an account">
      <form className="grid gap-4 p-5" onSubmit={(event) => void submit(event)}>
        <Field label="Display name">
          <Input
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="PalmPay wallet"
          />
        </Field>
        <Field label="Institution">
          <Input
            required
            value={institutionName}
            onChange={(event) => setInstitutionName(event.target.value)}
            placeholder="PalmPay"
          />
        </Field>
        <Field label="Institution code">
          <Input
            value={institutionCode}
            onChange={(event) => setInstitutionCode(event.target.value)}
            placeholder="palmpay"
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account type">
            <AccountTypeSelect value={accountType} onChange={setAccountType} />
          </Field>
          <Field label="Currency">
            <Input
              required
              maxLength={3}
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
            />
          </Field>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border p-4">
          <Checkbox
            aria-label="I own this account"
            checked={isOwned}
            onCheckedChange={(checked) => setIsOwned(checked === true)}
          />
          <span>
            <span className="block text-sm font-medium">I own this account</span>
            <span className="block text-xs text-muted-foreground">
              Enables internal-transfer matching.
            </span>
          </span>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button className="justify-self-end" disabled={saving}>
          {saving ? "Creating…" : "Create account"}
        </Button>
      </form>
    </Sheet>
  );
}

function EditAccountSheet({
  account,
  onClose,
  onUpdated,
}: {
  account: Account | null;
  onClose: () => void;
  onUpdated: (account: Account, message: string) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [institutionName, setInstitutionName] = useState("");
  const [institutionCode, setInstitutionCode] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("other");
  const [isOwned, setIsOwned] = useState(false);
  const [accountNumber, setAccountNumber] = useState("");
  const [identifierCode, setIdentifierCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!account) return;
    setDisplayName(account.displayName);
    setInstitutionName(account.institutionName);
    setInstitutionCode(account.institutionCode ?? "");
    setIdentifierCode(account.institutionCode ?? "");
    setAccountType(account.accountType);
    setIsOwned(account.isOwned);
    setAccountNumber("");
    setError(null);
  }, [account]);

  if (!account) {
    return null;
  }
  const currentAccount = account;

  async function update() {
    setSaving(true);
    setError(null);
    try {
      const next = await api.updateAccount(currentAccount.id, {
        displayName,
        institutionName,
        institutionCode: institutionCode || null,
        accountType,
        isOwned,
      });
      await onUpdated(next, "Account updated.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The account could not be updated.");
    } finally {
      setSaving(false);
    }
  }

  async function registerIdentifier() {
    setSaving(true);
    setError(null);
    try {
      const next = await api.registerOwnedAccount(currentAccount.id, {
        institutionCode: identifierCode,
        accountNumber,
      });
      setAccountNumber("");
      await onUpdated(next, "Owned-account identifier registered.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The identifier could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={account.displayName} description={account.institutionName}>
      <div className="space-y-7 p-5">
        <section className="grid gap-4">
          <Field label="Display name">
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Field>
          <Field label="Institution">
            <Input
              value={institutionName}
              onChange={(event) => setInstitutionName(event.target.value)}
            />
          </Field>
          <Field label="Institution code">
            <Input
              value={institutionCode}
              onChange={(event) => setInstitutionCode(event.target.value)}
            />
          </Field>
          <Field label="Account type">
            <AccountTypeSelect value={accountType} onChange={setAccountType} />
          </Field>
          <div className="flex items-center gap-3">
            <Checkbox
              aria-label="Owned by me"
              checked={isOwned}
              onCheckedChange={(checked) => setIsOwned(checked === true)}
            />
            <span className="text-sm">Owned by me</span>
          </div>
          <Button className="justify-self-end" disabled={saving} onClick={() => void update()}>
            Save account
          </Button>
        </section>

        <section className="border-t border-border pt-6">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-primary" />
            Register an owned-account identifier
          </h3>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            SpendLens stores only a one-way fingerprint and the last four digits. The full account
            number is never retained.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="Institution code">
              <Input
                value={identifierCode}
                onChange={(event) => setIdentifierCode(event.target.value)}
              />
            </Field>
            <Field label="Account number">
              <Input
                type="password"
                autoComplete="off"
                value={accountNumber}
                onChange={(event) => setAccountNumber(event.target.value)}
                placeholder="Not stored"
              />
            </Field>
          </div>
          <Button
            variant="outline"
            className="mt-3"
            disabled={saving || identifierCode.length === 0 || accountNumber.length < 4}
            onClick={() => void registerIdentifier()}
          >
            Register securely
          </Button>
        </section>

        <section className="border-t border-border pt-6">
          <Button
            variant="ghost"
            className="text-danger"
            disabled={saving}
            onClick={async () => {
              const next = await api.updateAccount(account.id, {
                archived: !account.archivedAt,
              });
              await onUpdated(next, account.archivedAt ? "Account restored." : "Account archived.");
            }}
          >
            <Archive />
            {account.archivedAt ? "Restore account" : "Archive account"}
          </Button>
        </section>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    </Sheet>
  );
}

function AccountTypeSelect({
  onChange,
  value,
}: {
  onChange: (value: AccountType) => void;
  value: AccountType;
}) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value as AccountType)}>
      <option value="wallet">Wallet</option>
      <option value="current">Current</option>
      <option value="savings">Savings</option>
      <option value="business">Business</option>
      <option value="loan">Loan</option>
      <option value="cash">Cash</option>
      <option value="other">Other</option>
    </Select>
  );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="text-xs text-muted-foreground">{label}</legend>
      {children}
    </fieldset>
  );
}

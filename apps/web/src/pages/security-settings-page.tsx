import {
  ArrowClockwise,
  CheckCircle,
  Copy,
  Database,
  DownloadSimple,
  Key,
  SignOut,
} from "@phosphor-icons/react";
import type { RecoveryKit } from "@spendlens/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { AiProviderSettings } from "@/components/ai-provider-settings";
import { downloadRecoveryFile, useSecurity } from "@/components/security-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, api } from "@/lib/api";

export function SecuritySettingsPage() {
  const security = useSecurity();
  const queryClient = useQueryClient();
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    password: "",
    confirmPassword: "",
  });
  const [rekeyPassword, setRekeyPassword] = useState("");
  const [recoveryKit, setRecoveryKit] = useState<RecoveryKit | null>(null);
  const changePassword = useMutation({
    mutationFn: () => api.changePassword(passwordForm),
    onSuccess: () => {
      setPasswordForm({ currentPassword: "", password: "", confirmPassword: "" });
      return queryClient.invalidateQueries({ queryKey: ["security-state"] });
    },
  });
  const revokeSessions = useMutation({
    mutationFn: api.logoutAll,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["security-state"] }),
  });
  const rekey = useMutation({
    mutationFn: () => api.rekey(rekeyPassword),
    onSuccess: (kit) => {
      setRecoveryKit(kit);
      setRekeyPassword("");
    },
  });

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    changePassword.mutate();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Security</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage access separately from the key that encrypts your local database.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Key />
            </span>
            <div>
              <CardTitle>Change password</CardTitle>
              <CardDescription>
                Changing your password revokes every existing session and signs this browser back in
                securely.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4 md:grid-cols-3" onSubmit={submitPassword}>
            <PasswordInput
              id="current-password"
              label="Current password"
              value={passwordForm.currentPassword}
              onChange={(currentPassword) =>
                setPasswordForm((current) => ({ ...current, currentPassword }))
              }
              autoComplete="current-password"
            />
            <PasswordInput
              id="new-password"
              label="New password"
              value={passwordForm.password}
              onChange={(password) => setPasswordForm((current) => ({ ...current, password }))}
              autoComplete="new-password"
            />
            <PasswordInput
              id="confirm-new-password"
              label="Confirm new password"
              value={passwordForm.confirmPassword}
              onChange={(confirmPassword) =>
                setPasswordForm((current) => ({ ...current, confirmPassword }))
              }
              autoComplete="new-password"
            />
            <div className="md:col-span-3">
              {changePassword.error && <SettingsError error={changePassword.error} />}
              {changePassword.isSuccess && (
                <p className="mb-3 flex items-center gap-2 text-sm text-success">
                  <CheckCircle weight="fill" />
                  Password changed and previous sessions revoked.
                </p>
              )}
              <Button disabled={changePassword.isPending}>
                {changePassword.isPending ? "Changing password…" : "Change password"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <AiProviderSettings />

      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Database />
            </span>
            <div>
              <CardTitle>Rotate database encryption key</CardTitle>
              <CardDescription>
                Re-encrypt the database with a new random 256-bit key. Your previous recovery file
                will stop working.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!recoveryKit ? (
            <form
              className="flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                rekey.mutate();
              }}
            >
              <div className="flex-1">
                <PasswordInput
                  id="rekey-password"
                  label="Confirm your password"
                  value={rekeyPassword}
                  onChange={setRekeyPassword}
                  autoComplete="current-password"
                />
              </div>
              <Button disabled={rekey.isPending || !rekeyPassword}>
                <ArrowClockwise />
                {rekey.isPending ? "Rotating key…" : "Rotate key"}
              </Button>
            </form>
          ) : (
            <div className="space-y-4 rounded-xl border border-attention/30 bg-attention/8 p-4">
              <div>
                <p className="font-medium">Save the new recovery material now</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Replace your old recovery file and keep this code separately.
                </p>
              </div>
              <code className="block break-all rounded-lg bg-background p-3 font-mono text-sm">
                {recoveryKit.recoveryCode}
              </code>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => downloadRecoveryFile(recoveryKit)}>
                  <DownloadSimple />
                  Download recovery file
                </Button>
                <Button
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(recoveryKit.recoveryCode)}
                >
                  <Copy />
                  Copy code
                </Button>
                <Button variant="ghost" onClick={() => setRecoveryKit(null)}>
                  I saved both
                </Button>
              </div>
            </div>
          )}
          {rekey.error && <SettingsError error={rekey.error} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>
            Sign out this browser or revoke every active SpendLens session.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={() => security.signOut()}>
            <SignOut />
            Sign out
          </Button>
          <Button
            variant="outline"
            disabled={revokeSessions.isPending}
            onClick={() => revokeSessions.mutate()}
          >
            Revoke all sessions
          </Button>
          {revokeSessions.error && <SettingsError error={revokeSessions.error} />}
        </CardContent>
      </Card>
    </div>
  );
}

function PasswordInput({
  id,
  label,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  autoComplete: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required
      />
    </div>
  );
}

function SettingsError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : "The security action failed.";
  const retry =
    error instanceof ApiError && error.retryAfterSeconds
      ? ` Try again in ${error.retryAfterSeconds} seconds.`
      : "";
  return (
    <p role="alert" className="mb-3 rounded-lg border border-danger/25 bg-danger/8 p-3 text-sm">
      {message}
      {retry}
    </p>
  );
}

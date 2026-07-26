import {
  Brain,
  CheckCircle,
  Cloud,
  HardDrives,
  Key,
  PencilSimple,
  Plug,
  Plus,
  ShieldCheck,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import type { AiProviderInput, AiProviderKind, AiProviderSetting } from "@spendlens/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { ApiError, api } from "@/lib/api";

const providerDefaults: Record<
  AiProviderKind,
  { label: string; endpoint: string; model: string; local: boolean }
> = {
  openai_compatible: {
    label: "OpenAI-compatible",
    endpoint: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    local: false,
  },
  anthropic: {
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    local: false,
  },
  gemini: {
    label: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
    local: false,
  },
  ollama: {
    label: "Ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "llama3.2",
    local: true,
  },
};

interface FormState {
  name: string;
  provider: AiProviderKind;
  endpoint: string;
  model: string;
  timeoutMs: string;
  enabled: boolean;
  localModel: boolean;
  apiKey: string;
  acknowledgeRemotePayload: boolean;
}

export function AiProviderSettings() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery({ queryKey: ["ai-providers"], queryFn: api.aiProviders });
  const [editing, setEditing] = useState<AiProviderSetting | "new" | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["ai-providers"] });
  const testMutation = useMutation({
    mutationFn: api.testAiProvider,
    onSuccess: (result, id) =>
      setTestResult((current) => ({
        ...current,
        [id]: `${result.message} ${result.models.length} model${
          result.models.length === 1 ? "" : "s"
        } found.`,
      })),
  });
  const deleteMutation = useMutation({
    mutationFn: api.deleteAiProvider,
    onSuccess: refresh,
  });

  const providers = providersQuery.data?.items ?? [];
  return (
    <section className="space-y-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">AI providers</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Optional bring-your-own-key models suggest classifications. Suggestions always wait in
            Review for your confirmation.
          </p>
        </div>
        <Button variant="outline" onClick={() => setEditing("new")}>
          <Plus />
          Add provider
        </Button>
      </div>

      {providersQuery.isLoading ? (
        <div className="rounded-xl border p-6 text-sm text-muted-foreground">
          Loading AI providers…
        </div>
      ) : providersQuery.error ? (
        <SettingsError error={providersQuery.error} />
      ) : providers.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-40 flex-col items-center justify-center p-6 text-center">
            <Brain className="size-8 text-primary" />
            <p className="mt-3 font-medium">AI is fully disabled</p>
            <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
              SpendLens remains fully functional with deterministic rules and manual review.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {providers.map((provider) => (
            <Card key={provider.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      {provider.localModel ? <HardDrives /> : <Cloud />}
                    </span>
                    <div className="min-w-0">
                      <CardTitle className="truncate">{provider.name}</CardTitle>
                      <CardDescription className="mt-1">
                        {providerDefaults[provider.provider].label} · {provider.model}
                      </CardDescription>
                    </div>
                  </div>
                  <StatusBadge enabled={provider.enabled} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <dl className="grid gap-2 text-xs sm:grid-cols-2">
                  <Detail
                    label="Payload"
                    value={provider.localModel ? "Full local context" : "Remote redacted"}
                  />
                  <Detail
                    label="Credential"
                    value={
                      provider.hasCredential
                        ? `Stored in ${provider.credentialStorage.replace("_", " ")}`
                        : provider.localModel
                          ? "Not required"
                          : "Missing"
                    }
                  />
                  <Detail label="Timeout" value={`${provider.timeoutMs / 1_000}s`} />
                  <Detail label="Endpoint" value={provider.endpoint} />
                </dl>
                {testResult[provider.id] && (
                  <p className="flex items-start gap-2 rounded-lg bg-success/8 p-3 text-xs text-success">
                    <CheckCircle className="mt-0.5 shrink-0" weight="fill" />
                    {testResult[provider.id]}
                  </p>
                )}
                {testMutation.error && testMutation.variables === provider.id && (
                  <SettingsError error={testMutation.error} />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    disabled={testMutation.isPending}
                    onClick={() => testMutation.mutate(provider.id)}
                  >
                    <Plug />
                    Test
                  </Button>
                  <Button variant="outline" onClick={() => setEditing(provider)}>
                    <PencilSimple />
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    className="text-danger"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`Delete ${provider.name}?`)) {
                        deleteMutation.mutate(provider.id);
                      }
                    }}
                  >
                    <Trash />
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ProviderEditor
        setting={editing}
        existingProviders={providers.map(({ provider }) => provider)}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await refresh();
        }}
      />
    </section>
  );
}

function ProviderEditor({
  setting,
  existingProviders,
  onClose,
  onSaved,
}: {
  setting: AiProviderSetting | "new" | null;
  existingProviders: AiProviderKind[];
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [form, setForm] = useState<FormState>(() => initialForm("openai_compatible"));
  const previewQuery = useQuery({
    queryKey: ["ai-payload-preview", setting === "new" ? null : setting?.id],
    queryFn: () => api.aiPayloadPreview((setting as AiProviderSetting).id),
    enabled: Boolean(setting && setting !== "new"),
  });
  const modelsQuery = useQuery({
    queryKey: ["ai-provider-models", setting === "new" ? null : setting?.id],
    queryFn: () => api.aiProviderModels((setting as AiProviderSetting).id),
    enabled: false,
  });
  const mutation = useMutation({
    mutationFn: async () => {
      const input: AiProviderInput = {
        name: form.name.trim(),
        provider: form.provider,
        endpoint: form.endpoint.trim(),
        model: form.model.trim(),
        timeoutMs: Number(form.timeoutMs) * 1_000,
        enabled: form.enabled,
        localModel: form.localModel,
        payloadPolicy: form.localModel ? "local_full" : "remote_redacted",
        acknowledgeRemotePayload: form.localModel || form.acknowledgeRemotePayload,
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
      };
      return setting === "new"
        ? api.createAiProvider(input)
        : api.updateAiProvider((setting as AiProviderSetting).id, input);
    },
    onSuccess: onSaved,
  });

  useEffect(() => {
    if (!setting) {
      setForm(initialForm("openai_compatible"));
      return;
    }
    if (setting === "new") {
      const available =
        (Object.keys(providerDefaults) as AiProviderKind[]).find(
          (provider) => !existingProviders.includes(provider),
        ) ?? "openai_compatible";
      setForm(initialForm(available));
      return;
    }
    setForm({
      name: setting.name,
      provider: setting.provider,
      endpoint: setting.endpoint,
      model: setting.model,
      timeoutMs: String(setting.timeoutMs / 1_000),
      enabled: setting.enabled,
      localModel: setting.localModel,
      apiKey: "",
      acknowledgeRemotePayload: Boolean(setting.remotePayloadAcknowledgedAt),
    });
  }, [setting, existingProviders]);

  if (!setting) {
    return (
      <Sheet open={false} onClose={onClose} title="AI provider">
        <div />
      </Sheet>
    );
  }

  const remotePreview = previewQuery.data?.sample ?? {
    occurredDate: "2026-06-15",
    direction: "debit",
    amountMinor: 125000,
    currency: "NGN",
    narration: "Transfer to [REDACTED_NUMBER]",
    currentCategory: null,
    currentCounterparty: null,
    scope: "personal",
  };
  const canSave =
    form.name.trim() &&
    form.endpoint.trim() &&
    form.model.trim() &&
    Number(form.timeoutMs) >= 1 &&
    (!form.enabled || form.localModel || form.acknowledgeRemotePayload);

  function chooseProvider(provider: AiProviderKind) {
    const defaults = providerDefaults[provider];
    setForm({
      ...initialForm(provider),
      name: defaults.label,
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSave) mutation.mutate();
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={setting === "new" ? "Add AI provider" : `Edit ${setting.name}`}
      description="Keys are never returned to the browser after saving."
    >
      <form className="space-y-5 p-5" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider">
            <Select
              value={form.provider}
              onChange={(event) => chooseProvider(event.target.value as AiProviderKind)}
            >
              {(Object.keys(providerDefaults) as AiProviderKind[]).map((provider) => (
                <option
                  key={provider}
                  value={provider}
                  disabled={
                    setting === "new" &&
                    existingProviders.includes(provider) &&
                    form.provider !== provider
                  }
                >
                  {providerDefaults[provider].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Display name">
            <Input
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              required
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Endpoint">
              <Input
                type="url"
                value={form.endpoint}
                onChange={(event) =>
                  setForm((current) => ({ ...current, endpoint: event.target.value }))
                }
                required
              />
            </Field>
          </div>
          <Field label="Model">
            <Input
              list="available-ai-models"
              value={form.model}
              onChange={(event) =>
                setForm((current) => ({ ...current, model: event.target.value }))
              }
              required
            />
            <datalist id="available-ai-models">
              {(modelsQuery.data?.items ?? []).map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </Field>
          <Field label="Timeout (seconds)">
            <Input
              type="number"
              min={1}
              max={120}
              value={form.timeoutMs}
              onChange={(event) =>
                setForm((current) => ({ ...current, timeoutMs: event.target.value }))
              }
              required
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label={setting === "new" ? "API key" : "Replace API key"}>
              <Input
                type="password"
                value={form.apiKey}
                placeholder={
                  setting !== "new" && setting.hasCredential
                    ? "Credential is already stored"
                    : form.localModel
                      ? "Optional for local models"
                      : "Required before enabling"
                }
                autoComplete="off"
                onChange={(event) =>
                  setForm((current) => ({ ...current, apiKey: event.target.value }))
                }
              />
            </Field>
          </div>
        </div>

        {setting !== "new" && (
          <Button
            type="button"
            variant="outline"
            disabled={modelsQuery.isFetching}
            onClick={() => modelsQuery.refetch()}
          >
            <Plug />
            {modelsQuery.isFetching ? "Loading models…" : "List models"}
          </Button>
        )}

        <div className="flex items-start gap-3 rounded-xl border p-4">
          <Checkbox
            aria-label="This model runs locally"
            checked={form.localModel}
            onCheckedChange={(checked) =>
              setForm((current) => ({
                ...current,
                localModel: checked === true,
                acknowledgeRemotePayload: checked === true,
              }))
            }
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium">This model runs locally</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              Local models may receive complete parsed context. Enable only for an endpoint you
              control on your machine or private network.
            </span>
          </span>
        </div>

        {!form.localModel && (
          <div className="space-y-3 rounded-xl border border-attention/30 bg-attention/5 p-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 shrink-0 text-attention" />
              <div>
                <p className="text-sm font-medium">Remote redacted payload</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  Account numbers, references, balances, import identifiers, and user notes are
                  omitted. Long identifiers inside narration are replaced before transmission.
                </p>
              </div>
            </div>
            <pre className="max-h-48 overflow-auto rounded-lg border bg-background p-3 text-[11px] leading-5">
              {JSON.stringify(remotePreview, null, 2)}
            </pre>
            <div className="flex items-start gap-3">
              <Checkbox
                aria-label="Acknowledge remote payload policy"
                checked={form.acknowledgeRemotePayload}
                onCheckedChange={(checked) =>
                  setForm((current) => ({
                    ...current,
                    acknowledgeRemotePayload: checked === true,
                  }))
                }
                className="mt-0.5"
              />
              <span className="text-xs leading-5">
                I reviewed what will be sent to this remote provider.
              </span>
            </div>
          </div>
        )}

        <div className="flex items-start gap-3 rounded-xl border p-4">
          <Checkbox
            aria-label="Enable provider"
            checked={form.enabled}
            onCheckedChange={(checked) =>
              setForm((current) => ({ ...current, enabled: checked === true }))
            }
            className="mt-0.5"
          />
          <span>
            <span className="block text-sm font-medium">Enable provider</span>
            <span className="mt-1 block text-xs leading-5 text-muted-foreground">
              Enabling never sends data automatically. You choose transactions from Review.
            </span>
          </span>
        </div>

        {mutation.error && <SettingsError error={mutation.error} />}
        {modelsQuery.error && <SettingsError error={modelsQuery.error} />}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!canSave || mutation.isPending}>
            <Key />
            {mutation.isPending ? "Saving securely…" : "Save provider"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function initialForm(provider: AiProviderKind): FormState {
  const defaults = providerDefaults[provider];
  return {
    name: defaults.label,
    provider,
    endpoint: defaults.endpoint,
    model: defaults.model,
    timeoutMs: "30",
    enabled: false,
    localModel: defaults.local,
    apiKey: "",
    acknowledgeRemotePayload: defaults.local,
  };
}

function StatusBadge({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`rounded-full px-2 py-1 text-[11px] font-medium ${
        enabled ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
      }`}
    >
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-muted/30 p-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-medium" title={value}>
        {value}
      </dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SettingsError({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError || error instanceof Error
      ? error.message
      : "The AI provider action failed.";
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-danger/25 bg-danger/8 p-3 text-sm"
    >
      <Warning className="mt-0.5 shrink-0" />
      {message}
    </p>
  );
}

import { ServiceHealthSchema, apiPaths, type ServiceHealth } from "@spendlens/contracts";

async function request<T>(path: string, parse: (value: unknown) => T): Promise<T> {
  const response = await fetch(path, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`SpendLens request failed with status ${response.status}.`);
  }

  return parse(await response.json());
}

export const api = {
  readiness(): Promise<ServiceHealth> {
    return request(apiPaths.ready, (value) => ServiceHealthSchema.parse(value));
  },
};

import { z } from "zod";

export const ServiceHealthSchema = z.object({
  service: z.literal("spendlens"),
  status: z.enum(["ok", "ready"]),
  timestamp: z.string().datetime(),
  version: z.string(),
});

export type ServiceHealth = z.infer<typeof ServiceHealthSchema>;

export const apiPaths = {
  live: "/health/live",
  ready: "/health/ready",
} as const;

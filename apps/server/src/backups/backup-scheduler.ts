import type { BackupService } from "./backup-service.js";

export class BackupScheduler {
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #nextScheduledAt: Date | null = null;

  constructor(
    private readonly backups: BackupService,
    private readonly timezone: () => string,
    private readonly onError: (error: unknown) => void,
    private readonly clock: () => number = Date.now,
  ) {}

  get nextScheduledAt(): Date | null {
    return this.#nextScheduledAt;
  }

  start(): void {
    if (this.#timer) return;
    void this.#tick();
    this.#timer = setInterval(() => void this.#tick(), 60_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const now = new Date(this.clock());
      const timezone = this.timezone();
      this.#nextScheduledAt = nextTwoAm(now, timezone);
      const local = localParts(now, timezone);
      if (local.hour < 2) return;
      const lastScheduled = this.backups.latestScheduledAt();
      if (!lastScheduled || localDate(lastScheduled, timezone) !== local.date) {
        await this.backups.createScheduled();
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.#running = false;
    }
  }
}

export function nextTwoAm(now: Date, timezone: string): Date {
  const start = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let minute = 1; minute <= 49 * 60; minute += 1) {
    const candidate = new Date(start + minute * 60_000);
    const parts = localParts(candidate, timezone);
    if (parts.hour === 2 && parts.minute === 0) return candidate;
  }
  throw new Error(`Could not calculate the next backup time for ${timezone}.`);
}

function localDate(date: Date, timezone: string): string {
  return localParts(date, timezone).date;
}

function localParts(date: Date, timezone: string): { date: string; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

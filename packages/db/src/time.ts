export interface LocalDateRange {
  startUtc: Date;
  endUtcExclusive: Date;
}

export function localDateRangeToUtc(
  startDate: string,
  endDateInclusive: string,
  timeZone: string,
): LocalDateRange {
  const start = parseDate(startDate);
  const end = parseDate(endDateInclusive);
  const startUtc = localDateTimeToUtc({ ...start, hour: 0, minute: 0, second: 0 }, timeZone);
  const nextDay = new Date(Date.UTC(end.year, end.month - 1, end.day + 1));
  const endUtcExclusive = localDateTimeToUtc(
    {
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: 0,
      minute: 0,
      second: 0,
    },
    timeZone,
  );
  if (startUtc >= endUtcExclusive) {
    throw new Error("The start date must not be after the end date.");
  }
  return { startUtc, endUtcExclusive };
}

export function normalizeSourceTimestamp(sourceTimestamp: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(sourceTimestamp);
  if (!match) {
    throw new Error("Source timestamps must use YYYY-MM-DD HH:mm[:ss].");
  }
  return localDateTimeToUtc(
    {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4]),
      minute: Number(match[5]),
      second: Number(match[6] ?? "0"),
    },
    timeZone,
  );
}

interface DateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function parseDate(value: string): Pick<DateTimeParts, "year" | "month" | "day"> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error("Dates must use YYYY-MM-DD.");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date: ${value}.`);
  }
  return { year, month, day };
}

function localDateTimeToUtc(parts: DateTimeParts, timeZone: string): Date {
  const formatter = formatterFor(timeZone);
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desired;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = partsAt(new Date(candidate), formatter);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const difference = desired - actualAsUtc;
    candidate += difference;
    if (difference === 0) return new Date(candidate);
  }

  throw new Error(`The local timestamp does not exist in ${timeZone}.`);
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(`Invalid IANA timezone: ${timeZone}.`);
  }
}

function partsAt(date: Date, formatter: Intl.DateTimeFormat): DateTimeParts {
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: requiredPart(values, "year"),
    month: requiredPart(values, "month"),
    day: requiredPart(values, "day"),
    hour: requiredPart(values, "hour"),
    minute: requiredPart(values, "minute"),
    second: requiredPart(values, "second"),
  };
}

function requiredPart(values: Record<string, number>, name: string): number {
  const value = values[name];
  if (value === undefined) {
    throw new Error(`Timezone formatter did not return ${name}.`);
  }
  return value;
}

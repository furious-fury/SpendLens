const ISO_CURRENCY = /^[A-Z]{3}$/;
const MAX_SAFE_MINOR_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export interface MonetaryAmount {
  amountMinor: number;
  currency: string;
}

export function assertCurrency(currency: string): void {
  if (!ISO_CURRENCY.test(currency)) {
    throw new Error("Currency must be a three-letter uppercase ISO 4217 code.");
  }
}

export function currencyFractionDigits(currency: string): number {
  assertCurrency(currency);
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    throw new Error(`Unsupported currency: ${currency}.`);
  }
}

export function parseMoneyToMinorUnits(value: string, currency: string): number {
  const fractionDigits = currencyFractionDigits(currency);
  const normalized = value.trim().replaceAll(",", "");
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) {
    throw new Error(`Invalid monetary amount: ${value}.`);
  }

  const fraction = match[3] ?? "";
  if (fraction.length > fractionDigits) {
    throw new Error(`${currency} supports at most ${fractionDigits} fractional digits.`);
  }

  const scale = 10n ** BigInt(fractionDigits);
  const major = BigInt(match[2] ?? "0");
  const paddedFraction = fraction.padEnd(fractionDigits, "0");
  const minor = major * scale + BigInt(paddedFraction || "0");
  const signedMinor = match[1] === "-" ? -minor : minor;

  if (signedMinor > MAX_SAFE_MINOR_UNITS || signedMinor < -MAX_SAFE_MINOR_UNITS) {
    throw new Error("The amount exceeds SpendLens' safe integer storage range.");
  }
  return Number(signedMinor);
}

export function formatMoney(amountMinor: number, currency: string, locale = "en-NG"): string {
  assertSafeMinorUnits(amountMinor);
  const fractionDigits = currencyFractionDigits(currency);
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amountMinor / 10 ** fractionDigits);
}

export function sumMoney(amounts: readonly MonetaryAmount[], currency?: string): number {
  if (currency) {
    assertCurrency(currency);
  }

  const currencies = new Set(amounts.map((amount) => amount.currency));
  if (!currency && currencies.size > 1) {
    throw new Error("Mixed currencies require an explicit currency filter.");
  }

  const selectedCurrency = currency ?? amounts[0]?.currency;
  let total = 0n;
  for (const amount of amounts) {
    assertCurrency(amount.currency);
    assertSafeMinorUnits(amount.amountMinor);
    if (amount.currency === selectedCurrency) {
      total += BigInt(amount.amountMinor);
    }
  }

  if (total > MAX_SAFE_MINOR_UNITS || total < -MAX_SAFE_MINOR_UNITS) {
    throw new Error("The total exceeds SpendLens' safe integer storage range.");
  }
  return Number(total);
}

export function assertSafeMinorUnits(amountMinor: number): void {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new Error("Monetary amounts must be stored as safe integer minor units.");
  }
}

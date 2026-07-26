import { assertCurrency, assertSafeMinorUnits } from "./money.js";

export interface TransactionSplit {
  amountMinor: number;
  currency: string;
}

export function validateSplitTotal(
  parentAmountMinor: number,
  parentCurrency: string,
  splits: readonly TransactionSplit[],
): void {
  assertSafeMinorUnits(parentAmountMinor);
  assertCurrency(parentCurrency);
  if (parentAmountMinor <= 0) {
    throw new Error("The parent amount must be positive.");
  }
  if (splits.length < 2) {
    throw new Error("A split transaction must contain at least two parts.");
  }

  let total = 0n;
  for (const split of splits) {
    assertSafeMinorUnits(split.amountMinor);
    assertCurrency(split.currency);
    if (split.currency !== parentCurrency) {
      throw new Error("Every split must use the parent transaction currency.");
    }
    if (split.amountMinor <= 0) {
      throw new Error("Every split amount must be positive.");
    }
    total += BigInt(split.amountMinor);
  }

  if (total !== BigInt(parentAmountMinor)) {
    throw new Error("Split amounts must equal the parent transaction amount.");
  }
}

export function allocateByWeights(totalMinor: number, weights: readonly number[]): number[] {
  assertSafeMinorUnits(totalMinor);
  if (totalMinor <= 0 || weights.length < 2) {
    throw new Error("Provide a positive total and at least two weights.");
  }
  if (weights.some((weight) => !Number.isSafeInteger(weight) || weight <= 0)) {
    throw new Error("Split weights must be positive safe integers.");
  }

  const total = BigInt(totalMinor);
  const divisor = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  const allocations = weights.map((weight, index) => {
    const numerator = total * BigInt(weight);
    return {
      index,
      amount: numerator / divisor,
      remainder: numerator % divisor,
    };
  });
  let unitsLeft = total - allocations.reduce((sum, item) => sum + item.amount, 0n);

  for (const item of [...allocations].sort(
    (left, right) => Number(right.remainder - left.remainder) || left.index - right.index,
  )) {
    if (unitsLeft === 0n) break;
    item.amount += 1n;
    unitsLeft -= 1n;
  }

  return allocations.map((item) => Number(item.amount));
}

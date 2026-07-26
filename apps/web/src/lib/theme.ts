export const appearances = ["light", "dark", "system"] as const;
export const accents = ["indigo", "violet", "blue", "teal", "amber"] as const;

export type Appearance = (typeof appearances)[number];
export type Accent = (typeof accents)[number];

const appearanceKey = "spendlens-appearance";
const accentKey = "spendlens-accent";

function includes<T extends string>(values: readonly T[], value: string | null): value is T {
  return value !== null && values.includes(value as T);
}

export function readAppearance(storage: Pick<Storage, "getItem">): Appearance {
  const value = storage.getItem(appearanceKey);
  return includes(appearances, value) ? value : "system";
}

export function readAccent(storage: Pick<Storage, "getItem">): Accent {
  const value = storage.getItem(accentKey);
  return includes(accents, value) ? value : "indigo";
}

export function applyAppearance(appearance: Appearance, prefersDark: boolean) {
  const root = document.documentElement;
  const dark = appearance === "dark" || (appearance === "system" && prefersDark);

  root.classList.toggle("dark", dark);
  root.dataset.appearance = appearance;
}

export function applyAccent(accent: Accent) {
  document.documentElement.dataset.accent = accent;
}

export const themeStorageKeys = {
  appearance: appearanceKey,
  accent: accentKey,
} as const;

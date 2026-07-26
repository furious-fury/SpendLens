import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import {
  accents,
  type Accent,
  type Appearance,
  applyAccent,
  applyAppearance,
  readAccent,
  readAppearance,
  themeStorageKeys,
} from "@/lib/theme";

interface ThemeContextValue {
  accent: Accent;
  appearance: Appearance;
  setAccent: (accent: Accent) => void;
  setAppearance: (appearance: Appearance) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<Appearance>(() =>
    readAppearance(window.localStorage),
  );
  const [accent, setAccentState] = useState<Accent>(() => readAccent(window.localStorage));

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyAppearance(appearance, media.matches);

    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [appearance]);

  useEffect(() => {
    applyAccent(accent);
  }, [accent]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      accent,
      appearance,
      setAccent(nextAccent) {
        if (!accents.includes(nextAccent)) {
          return;
        }
        window.localStorage.setItem(themeStorageKeys.accent, nextAccent);
        setAccentState(nextAccent);
      },
      setAppearance(nextAppearance) {
        window.localStorage.setItem(themeStorageKeys.appearance, nextAppearance);
        setAppearanceState(nextAppearance);
      },
    }),
    [accent, appearance],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }
  return context;
}

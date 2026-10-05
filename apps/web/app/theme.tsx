"use client";

// Live theme provider. Switches [data-theme] on <html> between the
// "midnight" (black + light green) and "sage" (black + sage green) palettes.
// Choice persists in localStorage; default is midnight.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Theme = "midnight" | "sage";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "midnight",
  setTheme: () => undefined,
  toggle: () => undefined,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("midnight");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("midman-theme");
      if (saved === "sage" || saved === "midnight") setThemeState(saved);
    } catch {
      // storage unavailable — keep default
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("midman-theme", theme);
    } catch {
      // storage unavailable — session-only theme
    }
  }, [theme]);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme: setThemeState,
        toggle: () => setThemeState((t) => (t === "midnight" ? "sage" : "midnight")),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

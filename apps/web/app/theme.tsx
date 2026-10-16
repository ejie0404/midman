"use client";

// Theme provider: "system" (follow the OS), "light" or "dark". The choice is
// a per-viewer convenience in localStorage; [data-theme] on <html> is set
// before first paint by THEME_BOOT_SCRIPT (app/layout.tsx) so there is no
// flash of the wrong theme.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemeMode = "system" | "light" | "dark";

const STORAGE_KEY = "midman-theme";

/** Inline, pre-paint: apply a stored explicit theme; "system" leaves CSS media queries in charge. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem("${STORAGE_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}`;

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Cycle system -> light -> dark -> system. */
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "system",
  setMode: () => undefined,
  cycle: () => undefined,
});

function readStored(): ThemeMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    setModeState(readStored());
  }, []);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    const root = document.documentElement;
    if (next === "system") delete root.dataset.theme;
    else root.dataset.theme = next;
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage unavailable: theme lasts for this page view only
    }
  };

  const cycle = () => setMode(mode === "system" ? "light" : mode === "light" ? "dark" : "system");

  return <ThemeContext.Provider value={{ mode, setMode, cycle }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}

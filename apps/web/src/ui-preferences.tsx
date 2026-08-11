import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

export type UiLocale = "zh-CN" | "en";
export type UiTheme = "dark" | "light";

export function uiText(locale: UiLocale, zh: string, en: string): string {
  return locale === "zh-CN" ? zh : en;
}

type UiPreferences = {
  locale: UiLocale;
  theme: UiTheme;
  text: (zh: string, en: string) => string;
  toggleLocale: () => void;
  toggleTheme: () => void;
};

const defaultPreferences: UiPreferences = {
  locale: "zh-CN",
  theme: "dark",
  text: (zh) => zh,
  toggleLocale: () => undefined,
  toggleTheme: () => undefined,
};

const UiPreferencesContext = createContext<UiPreferences>(defaultPreferences);

function initialLocale(): UiLocale {
  if (typeof window === "undefined") return "zh-CN";
  return window.localStorage.getItem("arena-locale") === "en" ? "en" : "zh-CN";
}

function initialTheme(): UiTheme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem("arena-theme");
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function UiPreferencesProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<UiLocale>(initialLocale);
  const [theme, setTheme] = useState<UiTheme>(initialTheme);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    window.localStorage.setItem("arena-locale", locale);
    window.localStorage.setItem("arena-theme", theme);
  }, [locale, theme]);

  const value = useMemo<UiPreferences>(() => ({
    locale,
    theme,
    text: (zh, en) => uiText(locale, zh, en),
    toggleLocale: () => setLocale((current) => current === "zh-CN" ? "en" : "zh-CN"),
    toggleTheme: () => setTheme((current) => current === "dark" ? "light" : "dark"),
  }), [locale, theme]);

  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function useUiPreferences(): UiPreferences {
  return useContext(UiPreferencesContext);
}

export function PreferenceControls({ className = "" }: { className?: string }) {
  const { locale, theme, text, toggleLocale, toggleTheme } = useUiPreferences();
  return (
    <div className={`preference-controls${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        onClick={toggleLocale}
        aria-label={text("切换为英文", "Switch to Chinese")}
        title={text("切换为英文", "Switch to Chinese")}
      >
        {locale === "zh-CN" ? "EN" : "中"}
      </button>
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? text("切换为明亮模式", "Switch to light mode") : text("切换为深色模式", "Switch to dark mode")}
        title={theme === "dark" ? text("切换为明亮模式", "Switch to light mode") : text("切换为深色模式", "Switch to dark mode")}
      >
        {theme === "dark" ? text("明", "Light") : text("暗", "Dark")}
      </button>
    </div>
  );
}

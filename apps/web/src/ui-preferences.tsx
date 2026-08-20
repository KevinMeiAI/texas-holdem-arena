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

export function uiLocaleFromSearch(search: string): UiLocale | null {
  const requested = new URLSearchParams(search).get("lang");
  if (requested === "en") return "en";
  if (requested === "zh" || requested === "zh-CN") return "zh-CN";
  return null;
}

export function urlWithUiLocale(href: string, locale: UiLocale): string {
  const url = new URL(href);
  if (locale === "en") url.searchParams.set("lang", "en");
  else url.searchParams.delete("lang");
  return `${url.pathname}${url.search}${url.hash}`;
}

function initialLocale(): UiLocale {
  if (typeof window === "undefined") return "zh-CN";
  const requested = uiLocaleFromSearch(window.location.search);
  if (requested) return requested;
  return window.localStorage.getItem("arena-locale") === "en" ? "en" : "zh-CN";
}

function replaceLocaleInCurrentUrl(locale: UiLocale): void {
  if (typeof window === "undefined") return;
  window.history.replaceState(
    window.history.state,
    "",
    urlWithUiLocale(window.location.href, locale),
  );
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
    toggleLocale: () => setLocale((current) => {
      const next = current === "zh-CN" ? "en" : "zh-CN";
      replaceLocaleInCurrentUrl(next);
      return next;
    }),
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
        {locale === "zh-CN" ? "EN" : "ZH"}
      </button>
      <button
        type="button"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? text("切换为明亮模式", "Switch to light mode") : text("切换为深色模式", "Switch to dark mode")}
        title={theme === "dark" ? text("切换为明亮模式", "Switch to light mode") : text("切换为深色模式", "Switch to dark mode")}
      >
        {theme === "dark" ? (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="3.1" /><path d="M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.3 3.3l1.2 1.2M11.5 11.5l1.2 1.2M12.7 3.3l-1.2 1.2M4.5 11.5l-1.2 1.2" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13.6 9.4A5.9 5.9 0 1 1 6.6 2.4a4.7 4.7 0 0 0 7 7Z" /></svg>
        )}
      </button>
    </div>
  );
}

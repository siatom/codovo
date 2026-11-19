import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import i18n from "./i18n";

export type LocalePreference = "system" | "zh-CN" | "en";
export type Locale = "zh-CN" | "en";
const KEY = "codovo.locale";

function systemLocale(): Locale {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "en";
}

function readPreference(): LocalePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === "zh-CN" || value === "en" || value === "system" ? value : "system";
  } catch { return "system"; }
}

interface LocaleContextValue {
  preference: LocalePreference;
  locale: Locale;
  setPreference: (value: LocalePreference) => void;
}
const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<LocalePreference>(readPreference);
  const [system, setSystem] = useState<Locale>(systemLocale);
  const locale = preference === "system" ? system : preference;
  useEffect(() => {
    void i18n.changeLanguage(locale);
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const update = () => setSystem(systemLocale());
    window.addEventListener("languagechange", update);
    return () => window.removeEventListener("languagechange", update);
  }, []);
  const setPreference = useCallback((value: LocalePreference) => {
    setPreferenceState(value);
    void i18n.changeLanguage(value === "system" ? systemLocale() : value);
    try { localStorage.setItem(KEY, value); } catch { /* 当前会话仍可切换 */ }
  }, []);
  const value = useMemo(() => ({ preference, locale, setPreference }), [preference, locale, setPreference]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used within LocaleProvider");
  return value;
}

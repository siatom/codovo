import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/** 用户的选择，`system` 表示跟着操作系统走 */
export type Theme = "dark" | "light" | "system";
/** 真正落到界面上的主题，只可能是这两个 */
export type ResolvedTheme = "dark" | "light";

const THEME_KEY = "codedock.theme";
const MEDIA = "(prefers-color-scheme: dark)";

/** 没存过偏好（或存坏了）时的主题；设置面板「恢复默认」也回到它 */
export const DEFAULT_THEME: Theme = "dark";

export function readSavedTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "system" ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 把三态偏好解析成实际主题；首帧渲染前要用它，所以得是纯函数 */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  return window.matchMedia(MEDIA).matches ? "dark" : "light";
}

/** 主题挂在 <html data-theme> 上，CSS 变量按它整组切。 */
export function applyTheme(theme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme;
}

interface ThemeValue {
  /** 实际生效的主题：终端和编辑器按它选调色板 */
  theme: ResolvedTheme;
  /** 用户的原始选择，可能是 `system` */
  preference: Theme;
  setPreference: (theme: Theme) => void;
  /** 在深色/浅色之间翻一下；从 `system` 出发就翻当前生效的那个 */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme>(readSavedTheme);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() =>
    resolveTheme("system"),
  );

  // 一直挂着监听：选没选"跟随系统"都要知道当前系统是深还是浅，
  // 否则从 system 切到手动时拿不到基准色
  useEffect(() => {
    const media = window.matchMedia(MEDIA);
    const onChange = () => setSystemTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const theme: ResolvedTheme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    applyTheme(theme);
    try {
      window.localStorage.setItem(THEME_KEY, preference);
    } catch {
      // 隐私模式等场景写不进去，忽略即可，只是下次启动回到深色
    }
  }, [preference, theme]);

  const toggle = useCallback(() => {
    setPreference(theme === "dark" ? "light" : "dark");
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, preference, setPreference, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return value;
}

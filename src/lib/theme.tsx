import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/** 用户的选择，`system` 表示跟着操作系统走 */
export type Theme = "dark" | "light" | "system" | "vscode" | "vscode-light" | "one-dark" | "dracula" | "github-dark" | "github-light" | "material-nova" | "neon-green" | "tokyo-night" | "catppuccin-mocha" | "nord" | "solarized-dark" | "solarized-light" | "monokai";
/** 真正落到界面上的主题，只可能是这两个 */
export type ResolvedTheme = "dark" | "light";

const THEME_KEY = "codedock.theme";
const MEDIA = "(prefers-color-scheme: dark)";

/** 没存过偏好（或存坏了）时的主题；设置面板「恢复默认」也回到它 */
export const DEFAULT_THEME: Theme = "dark";

export function readSavedTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "system" || saved === "vscode" || saved === "vscode-light" || saved === "one-dark" || saved === "dracula" || saved === "github-dark" || saved === "github-light" || saved === "material-nova" || saved === "neon-green" || saved === "tokyo-night" || saved === "catppuccin-mocha" || saved === "nord" || saved === "solarized-dark" || saved === "solarized-light" || saved === "monokai" ? saved : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 把三态偏好解析成实际主题；首帧渲染前要用它，所以得是纯函数 */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme === "light" || theme === "github-light" || theme === "solarized-light" || theme === "vscode-light" ? "light" : "dark";
  return window.matchMedia(MEDIA).matches ? "dark" : "light";
}

/** 主题挂在 <html data-theme> 上，CSS 变量按它整组切。 */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = resolveTheme(theme);
  document.documentElement.dataset.palette = theme;
}

interface ThemeValue {
  /** 实际生效的主题：终端和编辑器按它选调色板 */
  theme: ResolvedTheme;
  /** 用户的原始选择，可能是 `system`；只认它、不认预览 */
  preference: Theme;
  /** 当前渲染所用的那套配色：有悬停预览时是预览值，否则等于 `preference` */
  palette: Theme;
  setPreference: (theme: Theme) => void;
  /** 在深色/浅色之间翻一下；从 `system` 出发就翻当前生效的那个 */
  toggle: () => void;
  /** 悬停预览：只改渲染、不落盘；传 `null` 恢复成 `preference` */
  previewTheme: (theme: Theme | null) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<Theme>(readSavedTheme);
  // 主题下拉悬停时的临时配色：盖住 preference 但不写 localStorage，
  // 松开（选中或移开）就清掉，用户没真正选过的东西不该留在偏好里
  const [preview, setPreview] = useState<Theme | null>(null);
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

  const palette = preview ?? preference;
  const theme: ResolvedTheme = palette === "system" ? systemTheme : resolveTheme(palette);

  useEffect(() => {
    applyTheme(palette);
    // 预览只是看一眼，别把它写进偏好
    if (preview !== null) return;
    try {
      window.localStorage.setItem(THEME_KEY, preference);
    } catch {
      // 隐私模式等场景写不进去，忽略即可，只是下次启动回到深色
    }
  }, [palette, preference, preview]);

  // 另一个窗口切了主题就跟着走。storage 事件只在别的 document 触发，
  // 不会自己回灌自己
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_KEY) return;
      setPreference(readSavedTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback(() => {
    setPreference(theme === "dark" ? "light" : "dark");
  }, [theme]);

  const previewTheme = useCallback((next: Theme | null) => setPreview(next), []);

  return (
    <ThemeContext.Provider value={{ theme, preference, palette, setPreference, toggle, previewTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme 必须在 ThemeProvider 内使用");
  return value;
}

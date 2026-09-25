import type { ReactNode } from "react";
import {
  siAnthropic,
  siC,
  siClaude,
  siClaudecode,
  siCmake,
  siCodebuddy,
  siCplusplus,
  siCss,
  siCursor,
  siDart,
  siDeepseek,
  siDocker,
  siDotenv,
  siGit,
  siGithubcopilot,
  siGnubash,
  siGo,
  siGooglegemini,
  siHaskell,
  siHtml5,
  siJavascript,
  siJson,
  siJulia,
  siJupyter,
  siKotlin,
  siLess,
  siLua,
  siMarkdown,
  siMistralai,
  siNpm,
  siOllama,
  siOpenjdk,
  siOpencode,
  siPhp,
  siPnpm,
  siPython,
  siQwen,
  siR,
  siReact,
  siRuby,
  siRust,
  siSass,
  siScala,
  siSvelte,
  siSwift,
  siToml,
  siTypescript,
  siVuedotjs,
  siXml,
  siYaml,
  siYarn,
} from "simple-icons";

/**
 * 界面图标统一走这里：线条风格（描边 1.7），尺寸由调用处用 className 指定。
 * 之前各组件混用 emoji，同一个"文件夹"在不同面板里长得不一样，也和线条图标不搭。
 */
function Svg({ children, className }: { children: ReactNode; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} shrink-0`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** 包一层默认尺寸，省得每个图标都写一遍 props 类型 */
function icon(children: ReactNode) {
  return function Icon({ className = "h-4 w-4" }: { className?: string }) {
    return <Svg className={className}>{children}</Svg>;
  };
}

const FOLDER =
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";

export const IconFolder = icon(<path d={FOLDER} />);

export const IconFolderPlus = icon(
  <>
    <path d="M12 10v6M9 13h6" />
    <path d={FOLDER} />
  </>,
);

export const IconFile = icon(
  <>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v5h5" />
  </>,
);

/* ---------- 文件类型图标 ---------- */

/** Simple Icons 的一个条目：24×24 的实心路径 + 品牌色（不带 #） */
interface BrandIcon {
  hex: string;
  path: string;
}

/**
 * 品牌图标只能填充、不能描边，所以不走上面的线条工厂。
 * 颜色直接用品牌自己的色——这是界面里唯一不跟主题走的一类颜色，
 * 换成语义色这些图标就失去辨识度了。
 */
function BrandGlyph({ icon, className }: { icon: BrandIcon; className: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} shrink-0`}
      fill={brandFill(icon.hex)}
      aria-hidden="true"
    >
      <path d={icon.path} />
    </svg>
  );
}

/**
 * markdown / json / rust 这些品牌的官方色是纯黑，在深色主题下等于看不见，
 * 所以偏暗的一律改用 currentColor 跟着主题走。阈值是感知亮度。
 */
const DARK_BRAND_LUMA = 0.25;

function brandFill(hex: string): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luma < DARK_BRAND_LUMA ? "currentColor" : `#${hex}`;
}

/** 扩展名 -> 图标。没列的落到默认的文件图标 */
const FILE_BY_EXT: Record<string, BrandIcon> = {
  py: siPython,
  pyi: siPython,
  pyw: siPython,
  ipynb: siJupyter,
  js: siJavascript,
  mjs: siJavascript,
  cjs: siJavascript,
  jsx: siReact,
  tsx: siReact,
  ts: siTypescript,
  mts: siTypescript,
  cts: siTypescript,
  rs: siRust,
  go: siGo,
  java: siOpenjdk,
  c: siC,
  h: siCplusplus,
  hpp: siCplusplus,
  cc: siCplusplus,
  cpp: siCplusplus,
  cxx: siCplusplus,
  php: siPhp,
  rb: siRuby,
  kt: siKotlin,
  kts: siKotlin,
  swift: siSwift,
  lua: siLua,
  r: siR,
  jl: siJulia,
  hs: siHaskell,
  dart: siDart,
  scala: siScala,
  sh: siGnubash,
  bash: siGnubash,
  zsh: siGnubash,
  md: siMarkdown,
  markdown: siMarkdown,
  mdx: siMarkdown,
  json: siJson,
  jsonc: siJson,
  html: siHtml5,
  htm: siHtml5,
  css: siCss,
  scss: siSass,
  sass: siSass,
  less: siLess,
  vue: siVuedotjs,
  svelte: siSvelte,
  yml: siYaml,
  yaml: siYaml,
  toml: siToml,
  xml: siXml,
};

/**
 * 按整个文件名认的那些：要么没有扩展名（Dockerfile / Makefile），
 * 要么扩展名说明不了问题（lock 文件、package.json）。键一律小写。
 */
const FILE_BY_NAME: Record<string, BrandIcon> = {
  dockerfile: siDocker,
  makefile: siGnubash,
  "cmakelists.txt": siCmake,
  ".gitignore": siGit,
  ".gitattributes": siGit,
  ".gitmodules": siGit,
  "package.json": siNpm,
  "pnpm-lock.yaml": siPnpm,
  "yarn.lock": siYarn,
  "cargo.lock": siRust,
};

/**
 * 文件树按文件名挑图标。先认整个文件名，再认扩展名，都不中就回落到默认文件图标。
 */
export function FileTypeIcon({ name, className = "h-4 w-4" }: { name: string; className?: string }) {
  const lower = name.toLowerCase();
  // `.gitignore` 这种以点开头的没有扩展名，所以要求点不在第 0 位
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  // `.env` / `.env.local` / `.env.production` 都算环境变量文件
  const icon =
    FILE_BY_NAME[lower] ??
    (lower === ".env" || lower.startsWith(".env.") ? siDotenv : FILE_BY_EXT[ext]);
  if (!icon) return <IconFile className={className} />;
  return <BrandGlyph icon={icon} className={className} />;
}

export const IconChevronRight = icon(<path d="m9 18 6-6-6-6" />);

export const IconChevronDown = icon(<path d="m6 9 6 6 6-6" />);

/** 行尾的「更多操作」入口：三个点。描边画出来太淡，直接填实心 */
export const IconMore = icon(
  <>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </>,
);

export const IconSun = icon(
  <>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
  </>,
);

export const IconMoon = icon(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />);

export const IconPanelCollapse = icon(
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18M16 15l-3-3 3-3" />
  </>,
);

export const IconPanelExpand = icon(
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18M14 9l3 3-3 3" />
  </>,
);

/**
 * 右边栏收起/展开：把侧边栏那对（IconPanelCollapse / IconPanelExpand）水平镜像过来，
 * 分隔线落到右侧、箭头方向相反。两处收放长得一样，用户扫一眼就知道是同一类控件。
 * 不要用「填实右栏」表示状态——那是个直角块，会顶出外框的圆角。
 */
export const IconPanelRight = icon(
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18M10 9l-3 3 3 3" />
  </>,
);

export const IconPanelRightOpen = icon(
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18M8 15l3-3-3-3" />
  </>,
);

export const IconRefresh = icon(
  <>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </>,
);

export const IconSettings = icon(
  <>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

/** 右栏的「浏览器」模块 */
export const IconGlobe = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M3.5 9h17M3.5 15h17" />
    <path d="M12 3a13.5 13.5 0 0 0 0 18 13.5 13.5 0 0 0 0-18Z" />
  </>,
);

/** 用系统默认程序打开 */
export const IconExternalLink = icon(
  <>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </>,
);

/** 进入全屏：四角朝外 */
export const IconFullscreen = icon(
  <>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M16 3h3a2 2 0 0 1 2 2v3" />
    <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>,
);

/** 退出全屏：四角朝内 */
export const IconFullscreenExit = icon(
  <>
    <path d="M3 8h3a2 2 0 0 0 2-2V3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M21 16h-3a2 2 0 0 0-2 2v3" />
  </>,
);

export const IconClose = icon(<path d="M18 6 6 18M6 6l12 12" />);

export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20.5 20.5-4.4-4.4" />
  </>,
);

export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);

/** 搜索面板的「全部替换」：上下两条反向箭头，表示整体换掉 */
export const IconReplaceAll = icon(
  <>
    <path d="M6 8.5h12" />
    <path d="m15.5 6 2.5 2.5-2.5 2.5" />
    <path d="M18 15.5H6" />
    <path d="m8.5 13-2.5 2.5 2.5 2.5" />
  </>,
);

/** 清除搜索结果：左边是结果列表，右边一个叉。用它而不是普通 IconClose，
 *  免得被当成"关闭面板" */
export const IconClearResults = icon(
  <>
    <path d="M4 7h8M4 12h8M4 17h8" />
    <path d="m14 9 6 6M20 9l-6 6" />
  </>,
);

/** 四角星，AI 的通用符号。用在 Git 面板的「生成提交信息」上 */
export const IconSparkle = icon(
  <path d="M12 3.6 14 10l6.4 2-6.4 2-2 6.4-2-6.4L3.6 12 10 10Z" />,
);

/**
 * 终端工具条上的「启动 AI CLI」：机器人头像。
 * 四角星太泛，混在一排工具按钮里认不出是干嘛的，换成带角色的符号。
 */
export const IconBot = icon(
  <>
    <rect x="4" y="9" width="16" height="11" rx="2.5" />
    <path d="M12 9V5.5" />
    <circle cx="12" cy="4.2" r="1.2" />
    <path d="M9.2 13.5v2M14.8 13.5v2" />
  </>,
);

/** 「终端」tab 的图标：`>` 加下划线，命令行最通用的写法 */
export const IconTerminal = icon(
  <>
    <path d="m4 17 6-6-6-6" />
    <path d="M12 19h8" />
  </>,
);

/** 「历史会话」：表盘 + 一圈回转箭头 */
export const IconHistory = icon(
  <>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </>,
);

/** 发送消息 */
export const IconSend = icon(
  <>
    <path d="M21.5 2.5 11 13" />
    <path d="M21.5 2.5 15 21l-4-8-8-4Z" />
  </>,
);

/** 中止正在跑的这一轮 */
export const IconStop = icon(<rect x="6" y="6" width="12" height="12" rx="1.5" />);

/**
 * 全字匹配：带下划线的 ab（编辑器里约定俗成的写法）。
 * 和旁边"Aa"".*"两个开关一样是个字形，不是示意图标。
 */
export const IconWholeWord = icon(
  <>
    <path d="M4.6 17.6h14.8" />
    <circle cx="8.2" cy="11.6" r="2.4" />
    <path d="M10.6 9.2v4.8" />
    <path d="M15 6.4V14" />
    <path d="M15 9.2a2.4 2.4 0 1 1 0 4.8" />
  </>,
);

export const IconMinus = icon(<path d="M5 12h14" />);

export const IconBranch = icon(
  <>
    <path d="M6 3v12" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </>,
);

/** 从远程取回引用：云 + 下箭头。刻意不用 IconRefresh 那个回转箭头，免得和"刷新"混淆 */
export const IconCloudDownload = icon(
  <>
    <path d="M12 13v8l-4-4" />
    <path d="m12 21 4-4" />
    <path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284" />
  </>,
);

/** 拉取：箭头落进底线 */
export const IconArrowDownToLine = icon(
  <>
    <path d="M12 17V3" />
    <path d="m6 11 6 6 6-6" />
    <path d="M19 21H5" />
  </>,
);

/** 推送：箭头从底线升起 */
export const IconArrowUpFromLine = icon(
  <>
    <path d="m18 9-6-6-6 6" />
    <path d="M12 3v14" />
    <path d="M5 21h14" />
  </>,
);

/** 放弃修改：回退箭头。和 IconRefresh 的双向回转箭头区分开，免得被当成"刷新" */
export const IconUndo = icon(
  <>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
  </>,
);

/** 编辑态显示，点了进预览 */
export const IconEye = icon(
  <>
    <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

/** 预览态显示，点了回编辑 */
export const IconPencil = icon(
  <>
    <path d="M21.17 6.81a1 1 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63l4.35-1.32a2 2 0 0 0 .83-.5Z" />
    <path d="m15 5 4 4" />
  </>,
);

/* ---------- AI CLI 的品牌 logo ---------- */

/** 认得出是哪家就上哪家的 logo；认不出回落成上面那个通用的机器人图标 */
const AGENT_LOGOS: Record<string, BrandIcon> = {
  claude: siClaude,
  "claude-code": siClaudecode,
  anthropic: siAnthropic,
  codebuddy: siCodebuddy,
  opencode: siOpencode,
  gemini: siGooglegemini,
  cursor: siCursor,
  copilot: siGithubcopilot,
  deepseek: siDeepseek,
  qwen: siQwen,
  ollama: siOllama,
  mistral: siMistralai,
};

/**
 * 从一段文本里认出 agent 名：取第一个词（可执行文件名），去掉目录前缀和
 * Windows 上常见的 .exe / .cmd 垫片后缀。用户填的是命令行，不是品牌名。
 */
function agentKey(text: string): string {
  const first = text.trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}

/**
 * AI CLI 菜单里名字前面的 logo。先按命令认（`npx opencode` 这种也认得出来），
 * 认不出再按用户起的名字认——名字可以随便填，命令才是真正会跑的那个。
 */
export function AgentLogo({
  name,
  command,
  className = "h-3.5 w-3.5",
}: {
  name: string;
  command: string;
  className?: string;
}) {
  const logo = AGENT_LOGOS[agentKey(command)] ?? AGENT_LOGOS[agentKey(name)];
  if (!logo) return <IconBot className={className} />;
  return <BrandGlyph icon={logo} className={className} />;
}

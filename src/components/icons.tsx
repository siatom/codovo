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
  siFishshell,
  siGit,
  siGitforwindows,
  siGithubcopilot,
  siGnubash,
  siGo,
  siGooglegemini,
  siHaskell,
  siHtml5,
  siJavascript,
  siJulia,
  siJupyter,
  siKotlin,
  siLess,
  siLua,
  siMarkdown,
  siMistralai,
  siNpm,
  siNushell,
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
  siTypescript,
  siVuedotjs,
  siXml,
  siYarn,
  siZsh,
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

// 文件夹打开态：右侧多一个斜出的盖板，和闭合态一眼区分
export const IconFolderOpen = icon(
  <path
    d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"
  />,
);

export const IconFolderPlus = icon(
  <>
    <path d="M12 10v6M9 13h6" />
    <path d={FOLDER} />
  </>,
);

/**
 * 通用文件图标的两条 path。单独提出来是因为 contenteditable 里插 chip 时只能
 * 拼 HTML 字符串，图标得有个字符串形态（见下面的 fileIconHtml）——
 * 提出常量是为了两条 path 只写一遍。
 */
const FILE_PATHS = [
  "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
  "M14 2v5h5",
];

export const IconFile = icon(
  <>
    <path d={FILE_PATHS[0]} />
    <path d={FILE_PATHS[1]} />
  </>,
);

/**
 * 图标的字符串形态：contenteditable 里的 chip 只能拼 HTML，图标得有个字符串版本。
 * 参数和上面的 Svg 完全一致（同样的描边、圆头），path 只从常量来，不会两处各写一遍。
 */
function svgHtml(paths: string[], className: string): string {
  const body = paths.map((d) => `<path d="${d}"/>`).join("");
  return `<svg viewBox="0 0 24 24" class="${className}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** 文件图标的字符串形态，给拼 HTML 的地方用（如智能体输入框里的位置引用 chip） */
export function fileIconHtml(className = "h-3.5 w-3.5"): string {
  return svgHtml(FILE_PATHS, className);
}

/** 叉号的字符串形态，给 chip 上的删除按钮用 */
export function closeIconHtml(className = "h-3 w-3"): string {
  return svgHtml([CLOSE_PATH], className);
}

/* ---------- 文件类型图标 ---------- */

/** Simple Icons 的一个条目：24×24 的实心路径 + 品牌色（不带 #） */
interface BrandIcon {
  hex: string;
  path: string;
}

/**
 * 自绘的线条图形。json / yaml / toml 的 Simple Icons 标是把 "YAML""TOML"
 * 这些字母拼成的路径，缩到 16px 就糊成一团，这几个格式改用几何图形更认得出。
 * 颜色照旧固定用各自的品牌色，不跟主题走。
 */
interface StrokeIcon {
  color: string;
  body: ReactNode;
}

/** 文件图标的两种画法 */
type FileIcon = BrandIcon | StrokeIcon;

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

/** 线条图形的画笔参数和上面 Svg 一模一样，只是描边色由调用处定死 */
function StrokeGlyph({
  color,
  className,
  children,
}: {
  color: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`${className} shrink-0`}
      fill="none"
      stroke={color}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/* ---------- 三个自绘的格式图标 ---------- */

/**
 * JSON 的花括号。官方品牌色是纯黑，在深色主题下看不见，所以另给一个固定的
 * 金黄色——和 JS 的黄接近但不完全一样，摆在一起仍分得开。
 * 几何取自 lucide 的 braces，和本文件其它线条图标是同一套手感。
 */
const JSON_BRACES: StrokeIcon = {
  color: "#EAB308",
  body: (
    <>
      <path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" />
      <path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" />
    </>
  ),
};

/**
 * YAML 的层级：三条逐级缩进的横线，正好是 YAML 靠缩进表结构那件事。
 * 本来想画成"短横 + 内容"的列表，但在 16px 下六段线会糊成一块，三条更清爽。
 */
const YAML_LIST: StrokeIcon = {
  color: "#CB171E",
  body: (
    <>
      <path d="M4 6h16" />
      <path d="M7 12h10" />
      <path d="M10 18h7" />
    </>
  ),
};

/**
 * TOML 的 [section]：一对中括号 + 里面一条线。
 * 本来里面画的是等号（key = value），但 16px 下两条线并成一块，留一条更清楚。
 */
const TOML_SECTION: StrokeIcon = {
  color: "#9C4121",
  body: (
    <>
      <path d="M9 4H6v16h3" />
      <path d="M15 4h3v16h-3" />
      <path d="M10.5 12h3" />
    </>
  ),
};

/** 扩展名 -> 图标。没列的落到默认的文件图标 */
const FILE_BY_EXT: Record<string, FileIcon> = {
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
  json: JSON_BRACES,
  jsonc: JSON_BRACES,
  html: siHtml5,
  htm: siHtml5,
  css: siCss,
  scss: siSass,
  sass: siSass,
  less: siLess,
  vue: siVuedotjs,
  svelte: siSvelte,
  yml: YAML_LIST,
  yaml: YAML_LIST,
  toml: TOML_SECTION,
  xml: siXml,
};

/**
 * 按整个文件名认的那些：要么没有扩展名（Dockerfile / Makefile），
 * 要么扩展名说明不了问题（lock 文件、package.json）。键一律小写。
 */
const FILE_BY_NAME: Record<string, FileIcon> = {
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
  if ("body" in icon) {
    return (
      <StrokeGlyph color={icon.color} className={className}>
        {icon.body}
      </StrokeGlyph>
    );
  }
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

/**
 * 推送变更：一个顺时针的环形箭头（提交完还有本地领先的提交要推时用）。
 * 刻意和 IconRefresh 的双向回转箭头区分开——那个是"刷新"，这个是"推上去"。
 */
export const IconSync = icon(
  <>
    <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
  </>,
);

export const IconList = icon(
  <>
    <path d="M8 6h13M8 12h13M8 18h13" />
    {/* `h.01` 配圆头笔帽画出来就是一个点，比画小圆省事 */}
    <path d="M3 6h.01M3 12h.01M3 18h.01" />
  </>,
);

/**
 * 层级树：左边一根主干，圆角分叉成三层。用来表示"按目录树形显示"。
 * 几何取自 lucide 的 list-tree——自己拿直线拼过一版，小尺寸下横臂和叶子
 * 对不齐、看着像画歪了，弧形分叉更禁得住缩。
 */
export const IconTree = icon(
  <>
    <path d="M21 12h-8M21 6H8M21 18h-8" />
    <path d="M3 6v4c0 1.1.9 2 2 2h3" />
    <path d="M3 10v6c0 1.1.9 2 2 2h3" />
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

/**
 * 终端分栏的三个布局图标。以前这几个用的是 ▣ ◫ ▤ 这些字符，字形深浅不一、
 * 和旁边的线条图标也不搭，且「上下并列」那个字符在不同字体下看起来像标题栏。
 * 统一自绘画出来，三个只在分隔线上不同，一眼能对上。
 */
export const IconLayoutSingle = icon(<rect x="3" y="4" width="18" height="16" rx="2" />);

export const IconLayoutColumns = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </>,
);

export const IconLayoutRows = icon(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 12h18" />
  </>,
);

const CLOSE_PATH = "M18 6 6 18M6 6l12 12";

export const IconClose = icon(<path d={CLOSE_PATH} />);

export const IconSearch = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20.5 20.5-4.4-4.4" />
  </>,
);

export const IconPlus = icon(<path d="M12 5v14M5 12h14" />);export const IconCheck = icon(<path d="M20 6 9 17l-5-5" />);/** 从接口拉取列表：向下打进托盘里的箭头 */
export const IconDownload = icon(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <path d="m7 10 5 5 5-5" />
    <path d="M12 15V3" />
  </>,
);/** 复制一份配置（提供商列表里用）：后面那张纸叠在前面那张上 */
export const IconCopy = icon(
  <>
    <rect x="8" y="8" width="13" height="13" rx="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>,
);

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

/** 合并：岔出去的那条线又汇回主线。和 IconBranch（一条干分两叉）区分开语义 */
export const IconMerge = icon(
  <>
    <circle cx="18" cy="18" r="3" />
    <circle cx="6" cy="6" r="3" />
    <path d="M6 21V9a9 9 0 0 0 9 9" />
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

/** 工作区置顶：一枚图钉，菜单里切换、列表里标示置顶态都用它 */
export const IconPin = icon(
  <>
    <path d="M12 17v5" />
    <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
  </>,
);

/** 意见反馈：一个带尾巴的对话框，和「聊天」区分开的语义靠调用处的 title 说明 */
export const IconFeedback = icon(
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
);

/** 垃圾桶：反馈历史里「只删本地记录」那一下 */
export const IconTrash = icon(
  <>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <path d="M10 11v6M14 11v6" />
  </>,
);

/* ---------- AI CLI 的品牌 logo ---------- */

/**
 * codex 是 OpenAI 家的 CLI，但 simple-icons 从 v10 起把 openai 条目删了（商标），
 * 所以这条 path 是内联的旧版 v9 数据，不额外引包。hex 填纯黑——按 brandFill 的
 * 亮度阈值会走 currentColor 分支，深浅主题下都看得清。
 */
const SI_OPENAI: BrandIcon = {
  hex: "000000",
  path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
};

/** 认得出是哪家就上哪家的 logo；认不出回落成上面那个通用的机器人图标 */
const AGENT_LOGOS: Record<string, BrandIcon> = {
  claude: siClaude,
  "claude-code": siClaudecode,
  anthropic: siAnthropic,
  codebuddy: siCodebuddy,
  codex: SI_OPENAI,
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

/* ---------- 终端类型的品牌 logo ---------- */

/**
 * simple-icons 里没有 PowerShell / cmd / WSL——前两个是微软商标、被该库移除了。
 * 这三条补自 Material Design Icons（Apache-2.0），path 直接内联，不为它们多引一个包。
 * hex 填品牌色；填 000000 的会命中 brandFill 的暗色分支、改用 currentColor 跟随主题。
 */
const MDI_POWERSHELL: BrandIcon = {
  hex: "5391FE",
  path: "M21.83 4c.49 0 .8.4.67.89l-3.16 14.22c-.11.49-.59.89-1.08.89H2.17c-.49 0-.8-.4-.67-.89L4.66 4.89C4.77 4.4 5.25 4 5.74 4zm-6 12h-4c-.46 0-.83.38-.83.84c0 .47.37.85.83.85h4c.47 0 .85-.38.85-.85c0-.46-.38-.84-.85-.84m-10.05.28a.87.87 0 0 0-.21 1.22c.28.42.84.5 1.24.23c7.35-5.17 7.4-5.23 7.45-5.26c.18-.16.27-.38.28-.6c.01-.2-.04-.37-.16-.56L9.46 6.03A.867.867 0 0 0 8.21 6c-.36.32-.38.88-.05 1.24l4.15 4.44z",
};

const MDI_CONSOLE: BrandIcon = {
  hex: "000000",
  path: "M20 19V7H4v12zm0-16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm-7 14v-2h5v2zm-3.42-4L5.57 9H8.4l3.3 3.3c.39.39.39 1.03 0 1.42L8.42 17H5.59z",
};

/** 只有 `>_` 加一条下划线，比上面那个带窗口的轻，用来区分 csh / tcsh */
const MDI_CONSOLE_LINE: BrandIcon = {
  hex: "000000",
  path: "M13 19v-3h8v3zm-4.5-6L2.47 7h4.24l4.96 4.95c.58.59.58 1.55 0 2.12L6.74 19H2.5z",
};

const MDI_LINUX: BrandIcon = {
  hex: "000000",
  path: "M14.62 8.35c-.42.28-1.75 1.04-1.95 1.19c-.39.31-.75.29-1.14-.01c-.2-.16-1.53-.92-1.95-1.19c-.48-.31-.45-.7.08-.92c1.64-.69 3.28-.64 4.91.03c.49.21.51.6.05.9m7.22 7.28c-.93-2.09-2.2-3.99-3.84-5.66a4.3 4.3 0 0 1-1.06-1.88c-.1-.33-.17-.67-.24-1.01c-.2-.88-.29-1.78-.7-2.61c-.73-1.58-2-2.4-3.84-2.47c-1.81.05-3.16.81-3.95 2.4c-.21.43-.36.88-.46 1.34c-.17.76-.32 1.55-.5 2.32c-.15.65-.45 1.21-.96 1.71c-1.61 1.57-2.9 3.37-3.88 5.35c-.14.29-.28.58-.37.88c-.19.66.29 1.12.99.96c.44-.09.88-.18 1.3-.31c.41-.15.57-.05.67.35c.65 2.15 2.07 3.66 4.24 4.5c4.12 1.56 8.93-.66 9.97-4.58c.07-.27.17-.37.47-.27c.46.14.93.24 1.4.35c.49.09.85-.16.92-.64c.03-.26-.06-.49-.16-.73",
};

/**
 * 终端标签页上的 shell 图标。kind 由后端给（见 shells.rs 的 describe），
 * 认不出的按 shell 处理、落回单色终端图标。
 * PowerShell 5 和 7 是同一个 logo，所以两个 kind 指同一条。
 */
const SHELL_LOGOS: Record<string, BrandIcon> = {
  pwsh: MDI_POWERSHELL,
  powershell: MDI_POWERSHELL,
  cmd: MDI_CONSOLE,
  // WSL 跑的就是 Linux，用企鹅比微软四方标更贴切
  wsl: MDI_LINUX,
  zsh: siZsh,
  // bash / sh / dash / ksh / ash 这些 POSIX 系共用一个图标，后端都归到 kind "bash"
  bash: siGnubash,
  // C shell 家族（csh / tcsh）没有 logo，用带下划线的命令行图标和 cmd 的窗口区分开
  csh: MDI_CONSOLE_LINE,
  fish: siFishshell,
  nushell: siNushell,
  "git-bash": siGitforwindows,
};

export function ShellIcon({
  kind,
  className = "h-3.5 w-3.5",
}: {
  kind: string;
  className?: string;
}) {
  const logo = SHELL_LOGOS[kind];
  if (!logo) return <IconTerminal className={className} />;
  return <BrandGlyph icon={logo} className={className} />;
}

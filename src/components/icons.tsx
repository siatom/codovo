import type { ReactNode } from "react";

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

export const IconChevronRight = icon(<path d="m9 18 6-6-6-6" />);

export const IconChevronDown = icon(<path d="m6 9 6 6 6-6" />);

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

/** 右边栏收起态：只画出右侧那一栏的轮廓 */
export const IconPanelRight = icon(
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
  </>,
);

/** 右边栏展开态：右侧那一栏填实 */
export const IconPanelRightOpen = icon(
  <>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <rect width="6" height="18" x="15" y="3" fill="currentColor" />
    <path d="M15 3v18" />
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

export const IconMinus = icon(<path d="M5 12h14" />);

export const IconBranch = icon(
  <>
    <path d="M6 3v12" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
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

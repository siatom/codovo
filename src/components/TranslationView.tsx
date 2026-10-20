import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { renderMarkdown } from "../lib/markdown";
import { useSettings } from "../lib/settings";
import { useEffectiveAiConfig } from "../lib/ai";
import {
  cancelTranslation,
  partialTranslation,
  startTranslation,
  useTranslationRun,
} from "../lib/translate-store";
import {
  contentSignature,
  isDocumentPath,
  isMarkdownDocument,
  MAX_TRANSLATE_CHARS,
  translateTargetLabel,
  type TranslateTarget,
} from "../lib/translate";
import { MarkdownPreview } from "./MarkdownPreview";
import {
  IconAlert,
  IconArrowsLeftRight,
  IconCheck,
  IconCopy,
  IconRefresh,
  IconSettings,
  IconStop,
} from "./icons";

interface TranslationViewProps {
  /** 标签 key，翻译状态按它隔离 */
  tabKey: string;
  /** 文件绝对路径；未命名缓冲区为 null */
  path: string | null;
  /** 标签标题，只作为模型上下文 */
  title: string;
  /** 当前编辑器里的正文（含未保存改动） */
  content: string;
  roots: string[];
  /** 超过 8MB 的文件不翻译 */
  isLarge: boolean;
  onOpenSettings: () => void;
}

const TOOL_BUTTON =
  "flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted";

const TARGET_BUTTON =
  "rounded px-2 py-0.5 text-[11px] transition-colors";

/** 从预览外壳里取真正的滚动容器：MarkdownPreview 内部才是 .markdown-body */
function scrollContainer(host: HTMLDivElement | null): HTMLDivElement | null {
  return host?.querySelector<HTMLDivElement>(".markdown-body") ?? host;
}

/**
 * 文档翻译视图：左原文、右译文。
 *
 * 翻译运行状态放在模块级 store（见 `lib/translate-store.ts`），本组件卸载后
 * 进度仍然保留；重新进入、切目标语言或正文变化时才决定是否重新发起。
 */
export function TranslationView({
  tabKey,
  path,
  title,
  content,
  roots,
  isLarge,
  onOpenSettings,
}: TranslationViewProps) {
  const { settings, update } = useSettings();
  const { config, ready } = useEffectiveAiConfig();
  const run = useTranslationRun(tabKey);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  const target = settings.translateTarget;
  const supported = isDocumentPath(path);
  const markdown = isMarkdownDocument(path);
  const signature = contentSignature(content);
  const modelRef = config.providerId ? `${config.providerId}/${config.model}` : config.model;

  const start = useCallback(
    (force = false) => {
      void startTranslation({
        tabKey,
        path,
        title,
        content,
        target,
        config,
        modelRef,
        ready,
        force,
      });
    },
    [tabKey, path, title, content, target, config, modelRef, ready],
  );

  /**
   * 进入视图、切目标语言或正文变化时自动开始。
   * 已有同签名 + 同语言的失败 / 完成结果不再自动重试，交给用户点「重试」。
   */
  useEffect(() => {
    if (!supported || !ready || isLarge) return;
    if (content.trim() === "" || content.length > MAX_TRANSLATE_CHARS) return;
    if (run && run.signature === signature && run.target === target) return;
    start();
    // start 已包含全部输入；这里只需要在签名 / 语言 / 配置变化时重新判断
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, ready, isLarge, signature, target, run?.signature, run?.target]);

  const partial = partialTranslation(run);
  const loading = run?.status === "loading";
  const done = run?.status === "done";
  const failed = run?.status === "error";
  const translatedText = done ? run.translated : partial;
  const showTranslated = translatedText.trim() !== "";
  const progressTotal = run?.progress.total ?? 0;
  const progressDone = run?.progress.done ?? 0;
  const percent =
    progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : 0;

  const originalHtml = useMemo(
    () =>
      markdown
        ? renderMarkdown(content, { filePath: path ?? undefined, roots })
        : "",
    [markdown, content, path, roots],
  );
  const translatedHtml = useMemo(
    () =>
      markdown && showTranslated
        ? renderMarkdown(translatedText, { filePath: path ?? undefined, roots })
        : "",
    [markdown, showTranslated, translatedText, path, roots],
  );

  const copy = useCallback(() => {
    if (!showTranslated) return;
    void writeText(translatedText)
      .then(() => {
        setCopied(true);
        window.clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => {
        /* 剪贴板失败不打断阅读 */
      });
  }, [showTranslated, translatedText]);

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  // 左右按滚动比例同步。用 guard 吃掉程序化滚动产生的回声，避免两边互相抢。
  const leftHostRef = useRef<HTMLDivElement>(null);
  const rightHostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const left = scrollContainer(leftHostRef.current);
    const right = scrollContainer(rightHostRef.current);
    if (!left || !right) return;

    let guard: "left" | "right" | null = null;
    let timer: number | undefined;
    const hold = (side: "left" | "right") => {
      guard = side;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        guard = null;
      }, 100);
    };
    const sync = (from: HTMLDivElement, to: HTMLDivElement, side: "left" | "right") => {
      const fromMax = from.scrollHeight - from.clientHeight;
      const toMax = to.scrollHeight - to.clientHeight;
      if (fromMax <= 0 || toMax <= 0) return;
      hold(side);
      to.scrollTop = (from.scrollTop / fromMax) * toMax;
    };
    const onLeft = () => {
      if (guard === "right") return;
      sync(left, right, "left");
    };
    const onRight = () => {
      if (guard === "left") return;
      sync(right, left, "right");
    };

    left.addEventListener("scroll", onLeft, { passive: true });
    right.addEventListener("scroll", onRight, { passive: true });
    return () => {
      left.removeEventListener("scroll", onLeft);
      right.removeEventListener("scroll", onRight);
      window.clearTimeout(timer);
    };
  }, [showTranslated, markdown, originalHtml, translatedHtml]);

  const targetButtons: { id: TranslateTarget; label: string }[] = [
    { id: "zh", label: "中文" },
    { id: "en", label: "English" },
  ];

  return (
    <div className="absolute inset-0 flex flex-col bg-surface">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-2">
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-fg-muted">
          <IconArrowsLeftRight className="h-3.5 w-3.5" />
          文档翻译
        </span>
        <div
          role="group"
          aria-label="翻译目标语言"
          className="flex shrink-0 items-center gap-0.5 rounded-md border border-line-strong p-0.5"
        >
          {targetButtons.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => update({ translateTarget: item.id })}
              aria-pressed={target === item.id}
              className={`${TARGET_BUTTON} ${
                target === item.id
                  ? "bg-selected text-fg"
                  : "text-fg-dim hover:bg-hover hover:text-fg"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="min-w-0 truncate text-[11px] text-fg-faint">
          {loading && progressTotal > 0
            ? `翻译中 ${progressDone}/${progressTotal} 段`
            : run?.fromCache
              ? "来自本地缓存"
              : done
                ? "翻译完成"
                : failed && !showTranslated
                  ? "翻译未完成"
                  : ""}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => start(true)}
            disabled={!ready || loading || isLarge}
            title="忽略缓存，重新翻译整篇文档"
            className={TOOL_BUTTON}
          >
            <IconRefresh className="h-3.5 w-3.5" />
            重新翻译
          </button>
          {loading && (
            <button
              type="button"
              onClick={() => cancelTranslation(tabKey)}
              title="停止翻译：已发出的请求不会中断，但不会再发送后续片段"
              className={TOOL_BUTTON}
            >
              <IconStop className="h-3.5 w-3.5" />
              停止
            </button>
          )}
          <button
            type="button"
            onClick={copy}
            disabled={!showTranslated}
            title="复制译文"
            className={TOOL_BUTTON}
          >
            {copied ? <IconCheck className="h-3.5 w-3.5 text-ok" /> : <IconCopy className="h-3.5 w-3.5" />}
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="打开设置（AI → 文档翻译）"
            className={TOOL_BUTTON}
          >
            <IconSettings className="h-3.5 w-3.5" />
            设置
          </button>
        </div>
      </div>

      {/* 进度条只在翻译中占位，完成后收起，避免长期占一条线 */}
      {loading && (
        <div className="h-0.5 shrink-0 bg-raised" role="progressbar" aria-valuenow={percent}>
          <div
            className="h-full bg-accent-soft transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col border-r border-line" aria-label="原文">
          <div className="flex h-7 shrink-0 items-center justify-between border-b border-line px-3 text-[11px] text-fg-dim">
            <span>原文</span>
            <span className="text-fg-faint">{markdown ? "Markdown" : "文本"}</span>
          </div>
          <div ref={leftHostRef} className="relative min-h-0 flex-1 overflow-auto">
            {content.trim() === "" ? (
              <p className="px-4 py-3 text-[12px] text-fg-faint">文档为空</p>
            ) : markdown ? (
              <MarkdownPreview html={originalHtml} />
            ) : (
              <pre className="whitespace-pre-wrap break-words px-4 py-3 text-[12.5px] leading-relaxed text-fg">
                {content}
              </pre>
            )}
          </div>
        </section>

        <section className="flex min-w-0 flex-1 flex-col" aria-label="译文">
          <div className="flex h-7 shrink-0 items-center justify-between border-b border-line px-3 text-[11px] text-fg-dim">
            <span>译文</span>
            <span className="text-fg-faint">{translateTargetLabel(target)}</span>
          </div>
          <div ref={rightHostRef} className="relative min-h-0 flex-1 overflow-auto">
            {!supported ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <IconAlert className="h-6 w-6 text-warn" />
                <p className="text-[13px] text-fg">该文件不是文档类型</p>
                <p className="text-[12px] leading-relaxed text-fg-faint">
                  文档翻译仅支持 Markdown、纯文本等文档；源码、脚本和配置文件不参与翻译。
                </p>
              </div>
            ) : isLarge ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <IconAlert className="h-6 w-6 text-warn" />
                <p className="text-[13px] text-fg">文档过大</p>
                <p className="text-[12px] text-fg-faint">超过 8 MB 的文档不启用翻译，请切分后再试。</p>
              </div>
            ) : !ready ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <IconArrowsLeftRight className="h-6 w-6 text-fg-faint" />
                <p className="text-[13px] text-fg">尚未配置翻译模型</p>
                <p className="max-w-[320px] text-[12px] leading-relaxed text-fg-faint">
                  文档翻译复用「设置 → AI」里的全局默认模型。填好接口地址、模型和 API
                  密钥即可开始；密钥只保存在系统钥匙串，不会传进界面。
                </p>
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded border border-accent-line px-3 py-1 text-[12px] text-accent-soft hover:bg-active"
                >
                  打开设置
                </button>
              </div>
            ) : content.length > MAX_TRANSLATE_CHARS ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <IconAlert className="h-6 w-6 text-warn" />
                <p className="text-[13px] text-fg">文档过长</p>
                <p className="text-[12px] text-fg-faint">
                  超过 {Math.floor(MAX_TRANSLATE_CHARS / 1000)}k 字符，暂不支持整篇翻译。
                </p>
              </div>
            ) : failed && !showTranslated ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <IconAlert className="h-6 w-6 text-warn" />
                <p className="text-[13px] text-fg">翻译未完成</p>
                <p className="max-w-[420px] text-[12px] leading-relaxed text-fg-faint">
                  {run?.error ?? "未能取得译文"}
                </p>
                <button
                  type="button"
                  onClick={() => start(true)}
                  className="rounded border border-accent-line px-3 py-1 text-[12px] text-accent-soft hover:bg-active"
                >
                  重试
                </button>
              </div>
            ) : !showTranslated ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent-soft" />
                <p className="text-[12px] text-fg-faint">
                  {loading ? "正在准备译文…" : "进入翻译视图后自动开始"}
                </p>
              </div>
            ) : markdown ? (
              <MarkdownPreview html={translatedHtml} />
            ) : (
              <pre className="whitespace-pre-wrap break-words px-4 py-3 text-[12.5px] leading-relaxed text-fg">
                {translatedText}
              </pre>
            )}
          </div>

          {failed && showTranslated && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-2 border-t border-line bg-danger-bg px-3 py-1.5 text-[11px] text-danger"
            >
              <IconAlert className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{run?.error ?? "翻译未完成"}</span>
              <button
                type="button"
                onClick={() => start(true)}
                className="shrink-0 rounded border border-danger-line px-2 py-0.5 hover:bg-hover"
              >
                重试
              </button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

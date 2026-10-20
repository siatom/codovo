import { useSyncExternalStore } from "react";
import type { AiConfig } from "./ai";
import { translateText } from "./ai";
import {
  assembleTranslation,
  contentSignature,
  hasTranslatableProse,
  MAX_TRANSLATE_CHARS,
  prepareDocument,
  previewTranslation,
  type PreparedDocument,
  type TranslateTarget,
} from "./translate";

/**
 * 文档翻译的运行状态与译文缓存。
 *
 * 没有引入 zustand：一个模块级快照 + `useSyncExternalStore` 就够了，还能在
 * 标签切走、翻译视图卸载后继续保留进度。每个标签用 `tabKey` 隔离，关闭标签时
 * 由 EditorPane 调 `clearTranslation` 清理。
 */

export interface TranslationRun {
  status: "loading" | "done" | "error";
  target: TranslateTarget;
  /** 发起翻译时的原文签名，用于判断译文是否过期 */
  signature: string;
  translated: string;
  /** 已完成片段的译文，翻译过程中先展示出来 */
  partial: string[];
  /** 被屏蔽的代码/目录原文，用于还原占位符 */
  blocks: string[];
  progress: { done: number; total: number };
  error: string | null;
  runId: number;
  /** 本次结果直接来自本地缓存，没有请求模型 */
  fromCache: boolean;
}

type TranslationSnapshot = Readonly<Record<string, TranslationRun>>;

let snapshot: TranslationSnapshot = {};
const listeners = new Set<() => void>();
let runSeq = 0;
/**
 * 运行中的翻译当前挂在哪个标签 key 上。另存为会换 key，但已经发出的分段请求
 * 仍按原 runId 返回，靠这张表把它们写回新 key，而不是让进度卡在旧 key 上。
 */
const runKeys = new Map<number, string>();

function emit(next: TranslationSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function setRun(tabKey: string, run: TranslationRun): void {
  emit({ ...snapshot, [tabKey]: run });
}

export function subscribeTranslations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTranslationSnapshot(): TranslationSnapshot {
  return snapshot;
}

export function getTranslationRun(tabKey: string): TranslationRun | undefined {
  return snapshot[tabKey];
}

/** 订阅某个标签的翻译状态；标签切走再回来仍能拿到同一份 run */
export function useTranslationRun(tabKey: string): TranslationRun | undefined {
  return useSyncExternalStore(
    subscribeTranslations,
    () => snapshot[tabKey],
    () => snapshot[tabKey],
  );
}

/** 翻译进行中时给预览面板使用的已完成内容 */
export function partialTranslation(run: TranslationRun | undefined): string {
  if (!run || run.partial.length === 0) return "";
  return previewTranslation(run.partial, run.blocks);
}

function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// ── 译文缓存 ────────────────────────────────────────────────────────────────

interface TranslationCacheEntry {
  path: string;
  signature: string;
  target: TranslateTarget;
  /** provider/model 引用：换模型后旧译文不再复用 */
  modelRef: string;
  translated: string;
  updatedAt: number;
}

const CACHE_KEY = "codedock.translationCache";
const CACHE_VERSION = 1;
/** 最多保留的文档数量 */
const MAX_CACHE_ENTRIES = 24;
/** 缓存译文总字符上限，超出后按最近使用时间淘汰 */
const MAX_CACHE_CHARS = 600_000;

let cacheEntries: TranslationCacheEntry[] = [];
let cacheLoaded = false;

function cacheKey(path: string, signature: string, target: TranslateTarget): string {
  return `${path}\u0000${signature}\u0000${target}`;
}

function isCacheEntry(value: unknown): value is TranslationCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    entry.path !== "" &&
    typeof entry.signature === "string" &&
    entry.signature !== "" &&
    (entry.target === "zh" || entry.target === "en") &&
    typeof entry.modelRef === "string" &&
    typeof entry.translated === "string" &&
    entry.translated.trim() !== "" &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

function totalCacheChars(): number {
  return cacheEntries.reduce((total, entry) => total + entry.translated.length, 0);
}

/** 按最近使用时间淘汰，`keepKey` 是刚写入的那条，永远不淘汰它自己 */
function pruneCache(keepKey: string | null): void {
  while (cacheEntries.length > MAX_CACHE_ENTRIES || totalCacheChars() > MAX_CACHE_CHARS) {
    let oldestIndex = -1;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (let index = 0; index < cacheEntries.length; index++) {
      const entry = cacheEntries[index];
      if (cacheKey(entry.path, entry.signature, entry.target) === keepKey) continue;
      if (entry.updatedAt < oldestAt) {
        oldestAt = entry.updatedAt;
        oldestIndex = index;
      }
    }
    if (oldestIndex < 0) break;
    cacheEntries.splice(oldestIndex, 1);
  }
}

function persistCache(): void {
  const payload = JSON.stringify({ version: CACHE_VERSION, entries: cacheEntries });
  try {
    window.localStorage.setItem(CACHE_KEY, payload);
  } catch {
    // 配额满了：丢掉最旧的一半再试一次。仍失败就只保留内存缓存，不影响翻译
    cacheEntries = cacheEntries
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Math.floor(MAX_CACHE_ENTRIES / 2)));
    try {
      window.localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ version: CACHE_VERSION, entries: cacheEntries }),
      );
    } catch {
      /* 缓存写入失败不影响翻译 */
    }
  }
}

function ensureCacheLoaded(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return;
    const seen = new Set<string>();
    for (const entry of parsed.entries) {
      if (!isCacheEntry(entry)) continue;
      const key = cacheKey(entry.path, entry.signature, entry.target);
      if (seen.has(key)) continue;
      seen.add(key);
      cacheEntries.push(entry);
    }
    pruneCache(null);
  } catch {
    // 缓存损坏或读取失败时按无缓存处理
    cacheEntries = [];
  }
}

/** 缓存只按路径 + 内容签名 + 目标语言 + 模型区分；未命名缓冲区不缓存 */
function getCachedTranslation(
  path: string | null,
  signature: string,
  target: TranslateTarget,
  modelRef: string,
): string | null {
  if (!path) return null;
  ensureCacheLoaded();
  const key = cacheKey(path, signature, target);
  const entry = cacheEntries.find(
    (item) =>
      cacheKey(item.path, item.signature, item.target) === key && item.modelRef === modelRef,
  );
  if (!entry) return null;
  // 命中即刷新时间，作为 LRU 的「最近使用」
  entry.updatedAt = Date.now();
  persistCache();
  return entry.translated;
}

function cacheTranslation(
  path: string | null,
  signature: string,
  target: TranslateTarget,
  modelRef: string,
  translated: string,
): void {
  if (!path || translated.trim() === "") return;
  ensureCacheLoaded();
  const key = cacheKey(path, signature, target);
  const now = Date.now();
  const next: TranslationCacheEntry = {
    path,
    signature,
    target,
    modelRef,
    translated,
    updatedAt: now,
  };
  const index = cacheEntries.findIndex(
    (item) => cacheKey(item.path, item.signature, item.target) === key,
  );
  if (index >= 0) cacheEntries[index] = next;
  else cacheEntries.push(next);
  pruneCache(key);
  persistCache();
}

// ── 翻译运行 ────────────────────────────────────────────────────────────────

export interface StartTranslationInput {
  tabKey: string;
  /** 磁盘路径；未命名缓冲区为 null，不写缓存 */
  path: string | null;
  /** 文档标题，只作为模型上下文 */
  title: string;
  content: string;
  target: TranslateTarget;
  config: AiConfig;
  /** provider/model 引用，用于缓存失效 */
  modelRef: string;
  /** 默认模型是否配置齐全（地址 + 模型 + 密钥） */
  ready: boolean;
  /** 忽略缓存，用户手动「重新翻译」时用 */
  force?: boolean;
}

/**
 * 开始（或继续）翻译一个标签。同一份内容 + 同一目标语言正在跑时直接复用；
 * 内容或目标语言变了才会起新 run。
 */
export async function startTranslation(input: StartTranslationInput): Promise<void> {
  if (!input.ready) return;

  const { tabKey, path, title, content, target, config, modelRef } = input;
  const signature = contentSignature(content);
  const current = snapshot[tabKey];

  // 同一份内容、同一目标语言正在翻译时直接复用，避免视图重渲染重复发请求
  if (
    current &&
    current.status === "loading" &&
    current.signature === signature &&
    current.target === target
  ) {
    return;
  }

  const force = input.force === true;
  if (!force) {
    const cached = getCachedTranslation(path, signature, target, modelRef);
    if (cached !== null) {
      const runId = ++runSeq;
      setRun(tabKey, {
        status: "done",
        target,
        signature,
        translated: cached,
        partial: [],
        blocks: [],
        progress: { done: 0, total: 0 },
        error: null,
        runId,
        fromCache: true,
      });
      return;
    }
  }

  const runId = ++runSeq;
  // 另存为可能在翻译途中换 key；后续读写都以这张表里的最新 key 为准
  runKeys.set(runId, tabKey);
  const currentKey = () => runKeys.get(runId) ?? tabKey;
  const fail = (error: string) => {
    const previous = snapshot[currentKey()];
    if (!previous || previous.runId !== runId) return;
    setRun(currentKey(), { ...previous, status: "error", error });
  };
  const invalid = (error: string): void => {
    setRun(currentKey(), {
      status: "error",
      target,
      signature,
      translated: "",
      partial: [],
      blocks: [],
      progress: { done: 0, total: 0 },
      error,
      runId,
      fromCache: false,
    });
  };

  if (!content.trim()) {
    invalid("文档内容为空，没有可翻译的文本");
    return;
  }
  if (content.length > MAX_TRANSLATE_CHARS) {
    invalid(`文档超过 ${Math.floor(MAX_TRANSLATE_CHARS / 1000)}k 字符，暂不支持整篇翻译`);
    return;
  }

  let prepared: PreparedDocument;
  try {
    prepared = prepareDocument(content);
  } catch (error) {
    invalid(errorMessage(error));
    return;
  }

  if (prepared.chunks.length === 0 || !hasTranslatableProse(prepared.chunks)) {
    invalid("文档主要由代码、目录结构或空白组成，没有需要翻译的正文");
    return;
  }

  setRun(currentKey(), {
    status: "loading",
    target,
    signature,
    translated: "",
    partial: [],
    blocks: prepared.blocks,
    progress: { done: 0, total: prepared.chunks.length },
    error: null,
    runId,
    fromCache: false,
  });

  const parts: string[] = [];
  const isCurrent = () => snapshot[currentKey()]?.runId === runId;

  for (let index = 0; index < prepared.chunks.length; index++) {
    if (!isCurrent()) return;

    let text = "";
    let lastError: unknown = null;
    // 网络抖动 / 限流时重试一次；鉴权等确定性错误重试也无害
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        text = await translateText(config, target, prepared.chunks[index], title || null);
        break;
      } catch (error) {
        lastError = error;
        if (!isCurrent()) return;
        if (attempt === 0) await wait(700);
      }
    }

    if (!isCurrent()) return;
    if (!text) {
      fail(
        prepared.chunks.length > 1
          ? `第 ${index + 1}/${prepared.chunks.length} 段翻译失败：${errorMessage(lastError)}`
          : errorMessage(lastError),
      );
      return;
    }

    parts.push(text.trim());
    const previous = snapshot[currentKey()];
    if (!previous || previous.runId !== runId) return;
    setRun(currentKey(), {
      ...previous,
      partial: [...parts],
      progress: { done: index + 1, total: prepared.chunks.length },
    });
  }

  if (!isCurrent()) return;

  try {
    const translated = assembleTranslation(parts, prepared.blocks);
    cacheTranslation(path, signature, target, modelRef, translated);
    const previous = snapshot[currentKey()];
    if (!previous || previous.runId !== runId) return;
    setRun(currentKey(), {
      ...previous,
      status: "done",
      translated,
      error: null,
      fromCache: false,
    });
  } catch (error) {
    fail(errorMessage(error));
  }
}

/**
 * 停止翻译：已发出的请求无法中断，但不会再发后续片段。
 * 换一个新 runId，旧请求返回后不会写回这份状态。
 */
export function cancelTranslation(tabKey: string): void {
  const run = snapshot[tabKey];
  if (!run || run.status !== "loading") return;
  setRun(tabKey, {
    ...run,
    status: "error",
    error: "已停止翻译",
    runId: ++runSeq,
  });
}

/** 关标签时清理运行状态；缓存仍留在 localStorage，重新打开还能命中 */
export function clearTranslation(tabKey: string): void {
  if (!(tabKey in snapshot)) return;
  const run = snapshot[tabKey];
  if (run) runKeys.delete(run.runId);
  const next = { ...snapshot };
  delete next[tabKey];
  emit(next);
}

/**
 * 另存为把标签换成新路径时，把翻译运行状态一起搬到新 key。
 *
 * 只改 key、不重建 run：正在进行的分段请求仍用原来的 runId 写回，
 * 切回编辑再进翻译视图也能直接看到刚才的译文。缓存本身按路径索引，
 * 新路径没有缓存命中，下次重新翻译会重新请求。
 */
export function rekeyTranslation(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  const run = snapshot[oldKey];
  if (!run) return;
  // 正在跑的分段循环按 runId 找当前 key，跟着搬到新 key 才能继续写进度
  runKeys.set(run.runId, newKey);
  const next = { ...snapshot };
  delete next[oldKey];
  next[newKey] = run;
  emit(next);
}

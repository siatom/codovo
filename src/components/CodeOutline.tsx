import { useEffect, useState } from "react";
import { monaco } from "../lib/monaco-setup";
import { createCodeOutlineReader, OUTLINE_LANGUAGES } from "../lib/code-outline";
// Monaco 0.56.0 未公开符号查询 API；复用其内置命令，避免另写一套语言解析器。
// @ts-expect-error Monaco 内部模块没有声明文件，升级版本时需验证此入口。
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices";
// @ts-expect-error 同上，命令服务只在本组件内使用。
import { ICommandService } from "monaco-editor/platform/commands/common/commands";
// @ts-expect-error 监听语言服务懒加载，首次打开时 provider 可能尚未注册。
import { ILanguageFeaturesService } from "monaco-editor/editor/common/services/languageFeatures";
import "monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols";
import { IconChevronDown, IconClose, IconCode } from "./icons";

interface Props {
  model: monaco.editor.ITextModel;
  onNavigate: (range: monaco.IRange) => void;
  onClose: () => void;
}

function SymbolItem({ symbol, depth, onNavigate }: {
  symbol: monaco.languages.DocumentSymbol;
  depth: number;
  onNavigate: Props["onNavigate"];
}) {
  const [expanded, setExpanded] = useState(true);
  const children = symbol.children ?? [];
  return (
    <li>
      <div className="flex min-w-0 items-center rounded hover:bg-hover" style={{ paddingLeft: Math.min(depth, 12) * 12 }}>
        {children.length > 0 ? (
          <button type="button" aria-label={`${expanded ? "收起" : "展开"} ${symbol.name}`} aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)} className="flex h-6 w-5 shrink-0 items-center justify-center text-fg-faint">
            <IconChevronDown className={`h-3 w-3 ${expanded ? "" : "-rotate-90"}`} />
          </button>
        ) : <span className="w-5 shrink-0" />}
        <button type="button" onClick={() => onNavigate(symbol.selectionRange)}
          title={`${symbol.name}${symbol.detail ? ` · ${symbol.detail}` : ""} · 第 ${symbol.selectionRange.startLineNumber} 行`}
          className="flex h-6 min-w-0 flex-1 items-center gap-1.5 pr-2 text-left text-[11px] text-fg-dim hover:text-fg">
          <IconCode className="h-3 w-3 shrink-0 text-accent-soft" />
          <span className="truncate">{symbol.name}</span>
          <span className="ml-auto shrink-0 pl-2 text-[10px] text-fg-faint">{symbol.selectionRange.startLineNumber}</span>
        </button>
      </div>
      {expanded && children.length > 0 && <ul>{children.map((child, index) => (
        <SymbolItem key={`${child.name}:${index}`} symbol={child} depth={depth + 1} onNavigate={onNavigate} />
      ))}</ul>}
    </li>
  );
}

export function CodeOutline({ model, onNavigate, onClose }: Props) {
  const [symbols, setSymbols] = useState<monaco.languages.DocumentSymbol[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let timer: ReturnType<typeof setTimeout>;
    let reader: ReturnType<typeof createCodeOutlineReader> | undefined;
    const refresh = async () => {
      const current = ++revision;
      setState("loading");
      try {
        const language = model.getLanguageId();
        const result: monaco.languages.DocumentSymbol[] = OUTLINE_LANGUAGES.has(language)
          ? await (reader ??= createCodeOutlineReader()).read(language, model.uri.toString(), model.getValue())
          : await StandaloneServices.get(ICommandService).executeCommand("_executeDocumentSymbolProvider", model.uri);
        if (disposed || current !== revision || model.isDisposed()) return;
        setSymbols(result ?? []);
        setState("ready");
      } catch {
        if (!disposed && current === revision) setState("error");
      }
    };
    const schedule = () => {
      // 内容变化时立刻作废旧请求，防止旧版本结果在防抖窗口里写回。
      ++revision;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 350);
    };
    setSymbols([]);
    void refresh();
    const content = model.onDidChangeContent(schedule);
    const language = model.onDidChangeLanguage(schedule);
    const providers = StandaloneServices.get(ILanguageFeaturesService).documentSymbolProvider.onDidChange(schedule);
    return () => {
      disposed = true;
      clearTimeout(timer);
      content.dispose();
      language.dispose();
      providers.dispose();
      reader?.dispose();
    };
  }, [model]);

  return (
    <aside aria-label="代码大纲" className="flex h-full w-52 max-w-[40%] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line px-2 text-[11px] text-fg-dim">
        <span>代码大纲</span>
        <button type="button" onClick={onClose} aria-label="关闭代码大纲" title="关闭代码大纲"
          className="flex h-5 w-5 items-center justify-center rounded hover:bg-hover hover:text-fg">
          <IconClose className="h-3 w-3" />
        </button>
      </div>
      <nav aria-label="代码符号" className="min-h-0 flex-1 overflow-auto p-1">
        {symbols.length > 0 && state !== "error" ? <ul>{symbols.map((symbol, index) => (
          <SymbolItem key={`${model.uri}:${symbol.name}:${index}`} symbol={symbol} depth={0} onNavigate={onNavigate} />
        ))}</ul> : <p role="status" className="px-2 py-4 text-[11px] leading-relaxed text-fg-faint">
          {state === "loading" ? "正在加载大纲…" : state === "error" ? "大纲加载失败，请重新打开重试" : "当前文件没有可用符号，或该语言暂不支持大纲"}
        </p>}
      </nav>
    </aside>
  );
}

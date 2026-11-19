import type { languages } from "monaco-editor";
import i18n from "./i18n";
import OutlineWorker from "./code-outline.worker?worker";

export const OUTLINE_LANGUAGES = new Set([
  "rust", "c", "cpp", "python", "javascript", "typescript", "go", "java", "csharp",
]);

export interface OutlineRequest {
  id: number;
  language: string;
  uri: string;
  text: string;
}

export interface OutlineResponse {
  id: number;
  symbols?: languages.DocumentSymbol[];
  error?: string;
}

/** 每个可见大纲一个 Worker；关闭面板时释放解析器、语法缓存和待处理请求。 */
export function createCodeOutlineReader() {
  const worker = new OutlineWorker();
  let sequence = 0;
  let failure: Error | null = null;
  const pending = new Map<number, {
    resolve: (symbols: languages.DocumentSymbol[]) => void;
    reject: (error: Error) => void;
  }>();
  const failAll = (message: string) => {
    failure = new Error(message);
    for (const entry of pending.values()) entry.reject(failure);
    pending.clear();
  };
  worker.onmessage = ({ data }: MessageEvent<OutlineResponse>) => {
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.symbols ?? []);
  };
  worker.onerror = (event) => {
    console.error("代码大纲 Worker 加载失败", event);
    failAll(event.message || i18n.t("解析服务加载失败，请刷新应用后重试"));
  };
  worker.onmessageerror = () => failAll(i18n.t("解析服务返回了无效数据，请重试"));
  return {
    read(language: string, uri: string, text: string) {
      if (failure) return Promise.reject(failure);
      return new Promise<languages.DocumentSymbol[]>((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, language, uri, text } satisfies OutlineRequest);
      });
    },
    dispose() {
      worker.terminate();
      failAll(i18n.t("代码大纲已关闭"));
    },
  };
}

import type { languages } from "monaco-editor";
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
  worker.onerror = () => failAll("代码解析器加载失败");
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
      failAll("代码大纲已关闭");
    },
  };
}

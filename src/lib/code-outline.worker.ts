import { collectSymbols } from "./outline-symbols";
import { Parser, Language } from "web-tree-sitter";
import type { languages } from "monaco-editor";
import type { OutlineRequest, OutlineResponse } from "./code-outline";
import runtimeUrl from "web-tree-sitter/tree-sitter.wasm?url";
import rustUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm?url";
import cppUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm?url";
import pythonUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url";
import javascriptUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm?url";
import typescriptUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm?url";
import tsxUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm?url";
import goUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm?url";
import javaUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm?url";
import csharpUrl from "@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm?url";

const grammarUrls: Record<string, string> = {
  rust: rustUrl, c: cppUrl, cpp: cppUrl, python: pythonUrl,
  javascript: javascriptUrl, typescript: typescriptUrl, tsx: tsxUrl,
  go: goUrl, java: javaUrl, csharp: csharpUrl,
};

const ready = Parser.init({ locateFile: () => runtimeUrl });
const grammars = new Map<string, Promise<Language>>();
async function parse(request: OutlineRequest): Promise<languages.DocumentSymbol[]> {
  await ready;
  const language = request.language === "typescript" && /\.tsx(?:$|[?#])/i.test(request.uri) ? "tsx" : request.language;
  const url = grammarUrls[language];
  if (!url) return [];
  let grammar = grammars.get(url);
  if (!grammar) {
    grammar = Language.load(url).catch((error) => { grammars.delete(url); throw error; });
    grammars.set(url, grammar);
  }
  const parser = new Parser();
  try {
    parser.setLanguage(await grammar);
    const deadline = performance.now() + 1000;
    const tree = parser.parse(request.text, null, { progressCallback: () => performance.now() > deadline });
    if (!tree) throw new Error("代码解析超时");
    try { return collectSymbols(tree.rootNode, request.language); }
    finally { tree.delete(); }
  } finally { parser.delete(); }
}

// 串行处理：WASM 运行时共用内存，不能让两个 parse 调用交错。
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<OutlineRequest>) => {
  queue = queue.then(async () => {
    try { self.postMessage({ id: data.id, symbols: await parse(data) } satisfies OutlineResponse); }
    catch (error) { self.postMessage({ id: data.id, error: String(error) } satisfies OutlineResponse); }
  });
};

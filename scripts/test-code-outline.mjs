import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";
import { Parser, Language } from "web-tree-sitter";

const require = createRequire(import.meta.url);
const wasm = join(dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
const source = readFileSync(new URL("../src/lib/outline-symbols.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } });
const { collectSymbols } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
await Parser.init();

const fixtures = [
  { language: "rust", grammar: "rust", text: 'pub struct App { value: i32 }\nimpl App { pub fn run(&self) {} }\npub trait Task { fn execute(&self); }\n// fn fake() {}\nconst TEXT: &str = "fn ghost() {}";', paths: ["App", "App/value", "impl App/run", "Task/execute", "TEXT"], absent: ["fake", "ghost"] },
  { language: "c", grammar: "cpp", text: 'typedef struct Point { int x; } Point;\nint sum(\n int a, int b\n) { return a + b; }\nvoid reset(void);\n/* void fake() {} */\nconst char *text = "int ghost() {}";', paths: ["Point", "sum", "reset"], absent: ["fake", "ghost"] },
  { language: "cpp", grammar: "cpp", text: 'namespace demo { class App { public: void run() {} void stop(); }; }\nint *make(int x) { return nullptr; }', paths: ["demo/App/run", "demo/App/stop", "make"], absentPaths: ["demo/App/stop/stop"] },
  { language: "python", grammar: "python", text: '@decorator\nclass Greeter:\n    async def greet(self):\n        text = "def ghost(): pass"\n        return text\n\ndef welcome(\n name: str\n):\n    pass\n# def fake(): pass', paths: ["Greeter/greet", "welcome"], absent: ["fake", "ghost"] },
  { language: "javascript", grammar: "javascript", text: 'export class App { async run() {} }\nexport const arrow = (x) => x;\nconst obj = { greet: function() {} };\n// function fake() {}\nconst text = `function ghost() {}`;\nexport function outer() { const hidden = 1; function nested() {} }', paths: ["App/run", "arrow", "obj/greet", "outer/nested"], absent: ["fake", "ghost", "hidden"] },
  { language: "typescript", grammar: "typescript", text: 'export interface Task { run(): void; }\nexport type Name = string;\nexport const run = (name: Name) => name;\nexport enum State { Ready, Done }', paths: ["Task/run", "Name", "run", "State"] },
  { language: "typescript", grammar: "tsx", text: 'export const View = () => <main>Hello</main>;\nexport function App() { return <View />; }', paths: ["View", "App"] },
  { language: "go", grammar: "go", text: 'package main\ntype App struct { Value int }\nfunc (app *App) Run() {}\nfunc main() {}', paths: ["App", "Run", "main"] },
  { language: "java", grammar: "java", text: 'package demo;\npublic class App { public App() {} public void run() {} }', paths: ["App/App", "App/run"] },
  { language: "csharp", grammar: "c-sharp", text: 'namespace Demo { public class App { public string Name { get; set; } public void Run() {} } }', paths: ["Demo/App/Name", "Demo/App/Run"] },
  { language: "javascript", grammar: "javascript", text: '/* 中文 😀 */ const 名称 = () => {};', paths: ["名称"], position: [1, 19] },
  { language: "python", grammar: "python", text: 'def incomplete():\n    pass\nx = (\n', paths: ["incomplete"] },
  { language: "rust", grammar: "rust", text: '// no declarations', paths: [] },
];

for (const fixture of fixtures) {
  const parser = new Parser();
  parser.setLanguage(await Language.load(join(wasm, `tree-sitter-${fixture.grammar}.wasm`)));
  const tree = parser.parse(fixture.text);
  assert.ok(tree);
  try {
    const symbols = collectSymbols(tree.rootNode, fixture.language);
    const entries = [];
    function flatten(items, prefix = "") {
      for (const symbol of items) {
        entries.push([`${prefix}${symbol.name}`, symbol]);
        flatten(symbol.children ?? [], `${prefix}${symbol.name}/`);
      }
    }
    flatten(symbols);
    const paths = entries.map(([path]) => path);
    for (const path of fixture.paths) assert.ok(paths.includes(path), `${fixture.language}: missing ${path}; got ${paths.join(", ")}`);
    for (const absent of fixture.absent ?? []) assert.ok(!entries.some(([, symbol]) => symbol.name === absent), `${fixture.language}: unexpected ${absent}`);
    for (const absent of fixture.absentPaths ?? []) assert.ok(!paths.includes(absent), `${fixture.language}: duplicate ${absent}`);
    for (const [, symbol] of entries) {
      const { startLineNumber, startColumn, endLineNumber, endColumn } = symbol.selectionRange;
      assert.equal(startLineNumber, endLineNumber);
      const selected = fixture.text.split("\n")[startLineNumber - 1].slice(startColumn - 1, endColumn - 1);
      assert.ok(symbol.name.includes(selected) && selected.length > 0, `Invalid selection for ${symbol.name}`);
    }
    if (fixture.position) assert.deepEqual([symbols[0].selectionRange.startLineNumber, symbols[0].selectionRange.startColumn], fixture.position);
    if (fixture.paths.length === 0) assert.equal(symbols.length, 0);
    console.log(`PASS ${fixture.language}/${fixture.grammar}: ${paths.join(", ") || "empty"}`);
  } finally { tree.delete(); parser.delete(); }
}

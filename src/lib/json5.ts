// json5 / jsonc 的语言支持：Monarch 高亮 + 格式化 provider。
//
// Monaco 自带的 json 语言走严格 JSON（json worker 里的 vscode-json-languageservice）：
// JSON5/JSONC 的注释、单引号、裸键、尾随逗号在它眼里全是语法错误——高亮标红、格式化直接罢工。
// 而 0.56 把 basic-languages 打进了单文件，拿不到 json 的 Monarch 定义来复用，只能自己写一套。
//
// 真正重排缩进的算法在 json-format.ts（纯函数、不依赖编辑器）；这里只做 Monaco 侧的注册与接线。

import * as monaco from "monaco-editor";

import { formatJsonLike } from "./json-format";

/** 两个语言共用同一套高亮与格式化：都是「JSON 加注释」，差别只在字符串写法，宽松处理即可。 */
const LANGUAGES = [
  { id: "json5", extension: ".json5" },
  { id: "jsonc", extension: ".jsonc" },
];

const CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  // 回车时的自动缩进：行尾是开括号就再缩一级，行首是闭括号就退回来
  indentationRules: {
    increaseIndentPattern: /[{[]\s*$/,
    decreaseIndentPattern: /^\s*[}\]]/,
  },
};

const TOKENIZER: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      // 块注释必须排在行注释前面：否则 /* 的头两个字符先被 // 规则吃掉
      [/\/\*/, "comment", "@comment"],
      [/\/\/.*$/, "comment"],

      // 后面跟冒号的引号串当键；字符串只接受 JSON5 定义的转义序列。
      // 单行规则让未闭合字符串止于本行，不会把后续内容吞进字符串状态。
      // 键名 token 用 `key` 而不是 `string.key`：Monaco 内置主题只定义了带 `.json` 后缀的
      // `string.key.json`，而 Monarch 会自动加 `.json5/.jsonc` 后缀，`string.key` 匹配不上、
      // 回退到 `string` 规则，导致键和值同色；根级的 `key` 规则各主题都有，能拿到区分色。
      [/"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\r\n])*"(?=\s*:)/, "key"],
      [/'(?:\\(?:['\\/bfnrt]|u[0-9a-fA-F]{4})|[^'\\\r\n])*'(?=\s*:)/, "key"],
      [/"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\r\n])*"/, "string"],
      [/'(?:\\(?:['\\/bfnrt]|u[0-9a-fA-F]{4})|[^'\\\r\n])*'/, "string"],
      // 闭合串中的非法转义单独标错，其他部分仍保留字符串颜色。
      [/"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\r\n])*\\[^\r\n]?/, "string.invalid"],
      [/'(?:\\(?:['\\/bfnrt]|u[0-9a-fA-F]{4})|[^'\\\r\n])*\\[^\r\n]?/, "string.invalid"],
      [/"(?:\\.|[^"\\\r\n])*$/, "string.invalid"],
      [/'(?:\\.|[^'\\\r\n])*$/, "string.invalid"],

      // 数字和特殊数值要有词边界，避免 12abc 被拆成合法数字 + 标识符。
      [/[+-]?(?:0[xX][0-9a-fA-F]+|Infinity|NaN)(?![\w$])/, "number"],
      [/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![\w$])/, "number"],

      [/\b(?:true|false|null)\b/, "keyword"],

      // 裸键（JSON5 特有）：后面跟冒号的标识符（token 同样用 `key`，理由见上）
      [/[A-Za-z_$][\w$]*(?=\s*:)/, "key"],
      [/[A-Za-z_$][\w$]*/, "identifier"],

      [/[{}]/, "delimiter.curly"],
      [/[\[\]]/, "delimiter.square"],
      [/[:,]/, "delimiter"],

      [/\s+/, "white"],
      // 兜底：消费任何漏网字符，否则 tokenizer 会在原地卡住
      [/./, "invalid"],
    ],
    comment: [
      [/[^/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[/*]/, "comment"],
    ],
  },
};

const FORMATTER: monaco.languages.DocumentFormattingEditProvider = {
  displayName: "重排缩进（保留注释与原样风格）",
  provideDocumentFormattingEdits(model, options) {
    const before = model.getValue();
    const after = formatJsonLike(before, options.tabSize, options.insertSpaces);
    // 已经规范就返回空 edit：Monaco 据此判定「无改动」，不会把干净的文件标脏
    if (after === before) return [];
    return [{ range: model.getFullModelRange(), text: after }];
  },
};

let registered = false;

/** 幂等：dev 下 HMR 会重复执行模块，重复注册会让同一 id 出现多条记录。 */
export function registerJsonLikeLanguages(): void {
  if (registered) return;
  registered = true;

  for (const { id, extension } of LANGUAGES) {
    monaco.languages.register({ id, extensions: [extension], aliases: [id] });
    monaco.languages.setLanguageConfiguration(id, CONFIGURATION);
    monaco.languages.setMonarchTokensProvider(id, TOKENIZER);
    monaco.languages.registerDocumentFormattingEditProvider(id, FORMATTER);
  }
}

/**
 * 打开文件时把 json5 / jsonc 重排一次（内容是乱缩进的才有变化）。
 *
 * 用 pushEditOperations 而不是 setValue：前者进撤销栈，用户一步 Ctrl+Z 就能回到原样。
 * 调用方要把 savedVersionId 记成**重排前**的版本号，这样重排完立刻算未保存改动。
 */
export function reindentModelOnOpen(model: monaco.editor.ITextModel): void {
  try {
    const options = model.getOptions();
    const before = model.getValue();
    const after = formatJsonLike(before, options.tabSize, options.insertSpaces);
    if (after === before) return;
    model.pushEditOperations(
      null,
      [{ range: model.getFullModelRange(), text: after, forceMoveMarkers: true }],
      () => null,
    );
    model.pushStackElement(); // 把这次重排收成单独一步撤销
  } catch {
    // 格式化失败绝不能挡住打开文件，保持原文静默处理
  }
}

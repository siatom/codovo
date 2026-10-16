import * as monaco from "monaco-editor";

const IGNORE_TOKENIZER: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/^\s*#.*/, "comment"],
      [/^\s*!/, "keyword"],
      [/\*\*|\*|\?|\//, "operator"],
      [/[^\s!*?/#]+/, "string"],
      [/\s+/, "white"],
      [/./, "invalid"],
    ],
  },
};

const CMAKE_TOKENIZER: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      [/#.*/, "comment"],
      [/\b(?:if|elseif|else|endif|foreach|endforeach|while|endwhile|function|endfunction|macro|endmacro|return|break|continue)\b/i, "keyword"],
      [/\b(?:TRUE|FALSE|ON|OFF|YES|NO|NOTFOUND)\b/i, "constant"],
      [/[A-Za-z_][\w]*(?=\s*\()/, "predefined"],
      [/\$\{[^}]+\}/, "variable"],
      [/@[^@]+@/, "variable"],
      [/(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/, "string"],
      [/-{1,2}[A-Za-z_][\w-]*/, "attribute.name"],
      [/-[A-Za-z_][\w-]*/, "attribute.name"],
      [/[+-]?\d+(?:\.\d+)?/, "number"],
      [/\(|\)/, "delimiter.parenthesis"],
      [/[A-Za-z_][\w-]*/, "identifier"],
      [/\s+/, "white"],
      [/./, "operator"],
    ],
  },
};

/**
 * Makefile 的 Monarch 定义。Monaco 内置语言里没有 make，`languages.ts` 早就把
 * `Makefile` / `.mk` 映射到了 `makefile`，但那个 id 一直没人注册——等于没有高亮，
 * 这里补上定义才让那几行映射真正生效。
 *
 * recipe（行首 tab 的命令行）内部不再往下分析：那本质是 shell 脚本，交给终端去认，
 * 这里整行按命令文本着色，只保证行内的 `#` 仍是注释。
 */
const MAKEFILE_TOKENIZER: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenizer: {
    root: [
      // 注释优先：make 里 `#` 到行尾都是注释，recipe 行内的也是
      [/#.*$/, "comment"],
      // recipe 行整行当命令文本，免得命令名和参数被当成标识符
      [/^\t.*$/, "string"],
      // 指令行（条件、引入、导出）
      [/^[ \t]*(?:ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|export|unexport|override|undefine|include|-include|sinclude|vpath)\b/, "keyword"],
      // 赋值：VAR = / := / ?= / += / !=，三字符的写在前面
      [/^([A-Za-z_][\w.-]*)([ \t]*(?::=|\?=|\+=|!=|=))/, ["variable", "operator"]],
      // 目标行 `target: deps`，双冒号规则也算；`:=` 已被上一条拦下，这里再兜一层
      [/^([^\s:=\t#][^:=\n]*)(::?)(?!=)/, ["key", "delimiter"]],
      // 变量引用 `$(VAR)` / `${VAR}`，以及自动变量 $@ $< $^ $? $* $% $|
      [/\$[(\{][^)\}\n]*[)\}]/, "variable"],
      [/\$[@<^?*%|+]/, "variable"],
      // 行尾续行与转义
      [/\\$/, "string"],
      [/\\./, "string"],
      [/[-%*?]/, "operator"],
      [/[A-Za-z_][\w.-]*/, "identifier"],
      [/\d+(?:\.\d+)*/, "number"],
      [/[.:=|;,(){}]/, "delimiter"],
      [/\s+/, "white"],
      // 兜底：消费漏网字符，否则 tokenizer 会在原地卡住
      [/./, ""],
    ],
  },
};

let registered = false;

export function registerConfigLanguages(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: "makefile", extensions: [".mk", ".mak"], aliases: ["Makefile"] });
  monaco.languages.setMonarchTokensProvider("makefile", MAKEFILE_TOKENIZER);
  // 刻意不给 indentationRules / autoClosingPairs：recipe 必须以 tab 开头，
  // 回车自动缩进（跟编辑器设置走，多半是空格）和自动补括号都会写出跑不通的 Makefile。
  monaco.languages.setLanguageConfiguration("makefile", {
    comments: { lineComment: "#" },
    brackets: [["(", ")"]],
  });

  monaco.languages.register({ id: "ignore", aliases: ["Ignore rules"] });
  monaco.languages.setMonarchTokensProvider("ignore", IGNORE_TOKENIZER);
  monaco.languages.setLanguageConfiguration("ignore", {
    comments: { lineComment: "#" },
  });

  monaco.languages.register({ id: "cmake", extensions: [".cmake", ".txt"], aliases: ["CMake"] });
  monaco.languages.setMonarchTokensProvider("cmake", CMAKE_TOKENIZER);
  monaco.languages.setLanguageConfiguration("cmake", {
    comments: { lineComment: "#" },
    brackets: [["(", ")"]],
    autoClosingPairs: [{ open: "(", close: ")" }, { open: '"', close: '"' }],
  });
}

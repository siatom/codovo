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

let registered = false;

export function registerConfigLanguages(): void {
  if (registered) return;
  registered = true;

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

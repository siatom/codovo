// json5 / jsonc 的格式化：只重排空白，token 内容一个字节都不动。
//
// 刻意**不用**「解析成 AST 再打印」：那会丢掉注释、把单引号改成双引号、抹掉尾随逗号，
// 对配置文件是破坏性的，而且要额外引解析器依赖。所以这里只做词法切分 + 空白重排，
// 注释、引号、尾随逗号、十六进制数这些全部原样保留。
//
// 独立成文件、不 import monaco：格式化逻辑跟编辑器无关，单独拎出来更好读也更好测。

type TokenKind =
  | "open"
  | "close"
  | "comma"
  | "colon"
  | "string"
  | "word"
  | "lineComment"
  | "blockComment";

interface JsonToken {
  kind: TokenKind;
  /** 原样保留，重排时只动它前后的空白 */
  text: string;
}

/**
 * 词法切分。只按字符扫，不解析语法——所以残缺、未闭合的输入也能产出 token 序列，
 * 不会抛异常，最坏结果只是排版难看。
 */
function tokenize(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  const length = text.length;
  let index = 0;

  while (index < length) {
    const char = text[index];

    // 空白没有意义，重排时重新生成
    if (char === " " || char === "\t" || char === "\r" || char === "\n") {
      index++;
      continue;
    }

    if (char === "/" && text[index + 1] === "/") {
      let end = text.indexOf("\n", index);
      if (end < 0) end = length;
      tokens.push({ kind: "lineComment", text: text.slice(index, end) });
      index = end;
      continue;
    }

    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close < 0 ? length : close + 2;
      tokens.push({ kind: "blockComment", text: text.slice(index, end) });
      index = end;
      continue;
    }

    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < length) {
        const inner = text[end];
        // 转义：\ 后面的字符不参与闭合判断
        if (inner === "\\") {
          end += 2;
          continue;
        }
        if (inner === char) {
          end++;
          break;
        }
        // JSON5 的字符串不跨行，遇换行就当未闭合
        if (inner === "\n") break;
        end++;
      }
      if (end > length) end = length;
      tokens.push({ kind: "string", text: text.slice(index, end) });
      index = end;
      continue;
    }

    if (char === "{" || char === "[") {
      tokens.push({ kind: "open", text: char });
      index++;
      continue;
    }
    if (char === "}" || char === "]") {
      tokens.push({ kind: "close", text: char });
      index++;
      continue;
    }
    if (char === ",") {
      tokens.push({ kind: "comma", text: char });
      index++;
      continue;
    }
    if (char === ":") {
      tokens.push({ kind: "colon", text: char });
      index++;
      continue;
    }

    // 其余一律当一个「词」原样收下：数字、裸键、true/false/null、以及任何非法内容
    let end = index;
    while (end < length) {
      const inner = text[end];
      if (" \t\r\n{}[],:\"'".includes(inner)) break;
      if (inner === "/" && (text[end + 1] === "/" || text[end + 1] === "*")) break;
      end++;
    }
    if (end === index) end++; // 兜底，绝不原地踏步
    tokens.push({ kind: "word", text: text.slice(index, end) });
    index = end;
  }

  return tokens;
}

/**
 * 重排缩进与换行，token 内容原样保留。已规范的输入会原样返回（调用方据此判断「无需改动」）。
 */
export function formatJsonLike(text: string, tabSize: number, insertSpaces: boolean): string {
  // 空文件 / 纯空白：原样返回，别把行尾空白顺手清了
  if (text.trim() === "") return text;

  const unit = insertSpaces ? " ".repeat(Math.max(0, Math.floor(tabSize))) : "\t";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const tokens = tokenize(text);

  const lines: string[] = [];
  /** 当前行内容（不含缩进） */
  let current = "";
  /** 这一行是否还没落下任何 token——决定下次写入时要不要先补缩进 */
  let empty = true;
  let depth = 0;
  /** 下一个普通 token 前要补一个空格（冒号、单行块注释之后） */
  let pendingSpace = false;
  /** 上一个 token 是逗号：该换行了，但先欠着——紧跟其后的注释要留在原行末尾 */
  let breakAfter = false;

  const flush = () => {
    if (!empty) lines.push(current.replace(/[ \t]+$/, ""));
    current = "";
    empty = true;
    pendingSpace = false;
    breakAfter = false;
  };
  // 普通内容：需要与前面的内容用空格隔开
  const write = (value: string) => {
    if (empty) {
      current = unit.repeat(depth);
      empty = false;
    }
    if (pendingSpace && !current.endsWith(" ")) current += " ";
    pendingSpace = false;
    current += value;
  };
  // 标点：紧贴前面的 token（逗号前面不能有空格）
  const writeTight = (value: string) => {
    if (empty) {
      current = unit.repeat(depth);
      empty = false;
    }
    current = current.replace(/[ \t]+$/, "") + value;
    pendingSpace = false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // 逗号欠下的换行，等真正碰到下一个非注释 token 再还：这样逗号后面的注释
    // 能和逗号待在同一行，不会跑到下一行去、把归属搞乱
    if (breakAfter && token.kind !== "lineComment" && token.kind !== "blockComment") {
      flush();
    }

    if (token.kind === "open") {
      // 空的 {} / [] 保持一行，别炸成三行
      const next = tokens[i + 1];
      const closer = token.text === "{" ? "}" : "]";
      if (next && next.kind === "close" && next.text === closer) {
        write(token.text + next.text);
        i++;
        continue;
      }
      write(token.text);
      flush();
      depth++;
      continue;
    }

    if (token.kind === "close") {
      flush();
      depth = Math.max(0, depth - 1);
      write(token.text);
      continue;
    }

    if (token.kind === "comma") {
      writeTight(",");
      breakAfter = true;
      continue;
    }

    if (token.kind === "colon") {
      writeTight(":");
      pendingSpace = true;
      continue;
    }

    if (token.kind === "lineComment") {
      if (empty) {
        write(token.text);
      } else {
        // 行内注释跟在本行末尾，至少留一个空格别和前面的 token 粘一起
        current = current.replace(/[ \t]+$/, "") + " " + token.text;
      }
      flush();
      continue;
    }

    if (token.kind === "blockComment") {
      const parts = token.text.split(/\r\n|\r|\n/);
      // 块注释也算一段内容，和前面的 token 之间留个空格（它可能紧跟在逗号后面）
      pendingSpace = true;
      write(parts[0]);
      if (parts.length > 1) {
        flush();
        // 跨行块注释的内部原样保留：连缩进一起动它就不是「保留原样」了
        for (let p = 1; p < parts.length; p++) lines.push(parts[p]);
      } else {
        pendingSpace = true;
      }
      continue;
    }

    write(token.text);
  }

  flush();

  let result = lines.join(eol);
  // 原文末尾有换行就保留一个，没有也不擅自加
  if (/\r?\n$/.test(text)) result += eol;
  return result;
}

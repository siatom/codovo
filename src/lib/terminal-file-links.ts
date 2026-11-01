import type { Terminal } from "@xterm/xterm";
import { ownerRoot, pathsPresent } from "./fs";

const FILE_REFERENCE =
  /"[^"\r\n]+"|'[^'\r\n]+'|(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])?[\p{L}\p{N}_@.+~-][\p{L}\p{N}_@.+~:/\\-]*\.[\p{L}\p{N}_-]+(?:\(\d+(?:,\d+)?\)|:\d+(?::\d+)?)?/gu;

interface FileLocation {
  path: string;
  line: number;
}

function resolveFileReference(text: string, cwd: string): FileLocation | null {
  let reference = text.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  let line = 1;

  const parenthesized = reference.match(/\((\d+)(?:,\d+)?\)$/);
  const numbered = parenthesized ?? reference.match(/:(\d+)(?::\d+)?$/);
  if (numbered) {
    line = Number(numbered[1]);
    reference = reference.slice(0, numbered.index);
  }

  if (!reference || /^https?:/i.test(reference)) return null;

  const windows = /^[A-Za-z]:[\\/]/.test(cwd);
  if (windows) {
    // Git Bash 把 Windows 盘符写成 /d/path；转回原生路径供 Tauri 文件 API 使用。
    reference = reference.replace(/^\/([a-z])\//i, (_match, drive: string) => `${drive.toUpperCase()}:\\`);
    reference = reference.replace(/\//g, "\\");
    if (!/^[A-Za-z]:\\/.test(reference) && !reference.startsWith("\\\\")) {
      reference = `${cwd.replace(/[\\/]+$/, "")}\\${reference}`;
    }

    const drive = reference.match(/^([A-Za-z]:)\\/);
    if (drive) {
      const segments: string[] = [];
      for (const segment of reference.slice(drive[0].length).split("\\")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
      }
      reference = `${drive[1]}\\${segments.join("\\")}`;
    }
  } else if (!reference.startsWith("/")) {
    reference = `${cwd.replace(/\/+$/, "")}/${reference}`;
    const segments: string[] = [];
    for (const segment of reference.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    reference = `/${segments.join("/")}`;
  }

  return { path: reference, line };
}

/** 让终端中指向当前工作区文件的路径可点击，并跳到可选的行号。 */
export function registerTerminalFileLinks(
  terminal: Terminal,
  cwd: string,
  roots: string[],
  onOpenFile: (path: string, line: number) => void,
): { dispose: () => void } {
  return terminal.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const row = terminal.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true);
      if (!row) {
        callback(undefined);
        return;
      }

      const links = [...row.matchAll(FILE_REFERENCE)].map((match) => {
        const location = resolveFileReference(match[0], cwd);
        if (!location || ownerRoot(roots, location.path) === null) return null;

        const start = match.index ?? 0;
        const startColumn = columnAtOffset(terminal, bufferLineNumber, start);
        const endColumn = columnAtOffset(terminal, bufferLineNumber, start + match[0].length) - 1;
        return {
          range: {
            start: { x: startColumn, y: bufferLineNumber },
            end: { x: Math.max(startColumn, endColumn), y: bufferLineNumber },
          },
          text: match[0],
          activate: () => {
            if (ownerRoot(roots, location.path) === null) return;
            void pathsPresent([location.path])
              .then(([exists]) => {
                if (exists) onOpenFile(location.path, location.line);
              })
              .catch(() => {});
          },
        };
      }).filter((link): link is NonNullable<typeof link> => link !== null);

      callback(links.length ? links : undefined);
    },
  });
}

/** 把字符串偏移换成 xterm 的单元格列，正确覆盖 CJK 等双宽字符。 */
function columnAtOffset(terminal: Terminal, bufferLineNumber: number, offset: number): number {
  const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
  if (!line) return offset + 1;

  let consumed = 0;
  for (let column = 0; column < terminal.cols; ) {
    if (offset <= consumed) return column + 1;
    const cell = line.getCell(column);
    if (!cell) break;
    const chars = cell.getChars();
    if (chars && offset < consumed + chars.length) return column + 1;
    consumed += chars.length;
    column += Math.max(cell.getWidth(), 1);
  }
  return Math.min(terminal.cols + 1, offset + 1);
}

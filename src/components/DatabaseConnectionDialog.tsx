import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  dbSecretPresence,
  DB_KINDS,
  DB_KIND_LABELS,
  DEFAULT_PORTS,
  newConnectionId,
  setDbPassword,
  type DbConnection,
  type DbKind,
} from "../lib/database";
import { IconFolderOpen } from "./icons";

interface DatabaseConnectionDialogProps {
  /** 编辑已有连接时传入；新增传 null */
  connection: DbConnection | null;
  onSave: (connection: DbConnection) => void;
  onClose: () => void;
}

const INPUT =
  "h-7 w-full rounded border border-line-strong bg-surface px-2 text-[12px] text-fg outline-none placeholder:text-fg-faint focus:border-accent";

const SEGMENT = "flex-1 rounded px-2 py-1 text-[12px]";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-fg-dim">{label}</span>
      {children}
    </label>
  );
}

/**
 * 新增 / 编辑一个数据库连接。密码只在提交时写系统钥匙串，
 * localStorage 里只落「有没有」的布尔位（照远程主机那套）。
 */
export function DatabaseConnectionDialog({
  connection,
  onSave,
  onClose,
}: DatabaseConnectionDialogProps) {
  const [kind, setKind] = useState<DbKind>(connection?.kind ?? "mysql");
  const [name, setName] = useState(connection?.name ?? "");
  const [host, setHost] = useState(connection?.host ?? "127.0.0.1");
  const [port, setPort] = useState(String(connection?.port ?? DEFAULT_PORTS.mysql));
  const [user, setUser] = useState(connection?.user ?? "");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(connection?.database ?? "");
  const [file, setFile] = useState(connection?.file ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 切到某个库时端口若还停在别的库的默认值，顺手换成本库默认端口
  const pickKind = (next: DbKind) => {
    setKind((current) => {
      const number = Number(port);
      if (!port || number === DEFAULT_PORTS[current]) setPort(String(DEFAULT_PORTS[next]));
      return next;
    });
  };

  const pickFile = async () => {
    try {
      const selected = await open({ multiple: false, title: "选择 SQLite 数据库文件" });
      if (typeof selected === "string") setFile(selected);
    } catch {
      // 用户取消或对话框不可用，保持原值
    }
  };

  const submit = async () => {
    const connName = name.trim();
    if (kind === "sqlite") {
      if (!file.trim()) return setError("请选择 SQLite 数据库文件");
    } else {
      if (!host.trim()) return setError("请填写主机地址");
      const portNumber = Number(port);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        return setError("端口要在 1–65535 之间");
      }
    }

    setSaving(true);
    setError("");
    const id = connection?.id ?? newConnectionId();
    const portNumber = Number(port);
    try {
      // 只在用户填了才写，留空 = 不改动已有凭据
      if (password) await setDbPassword(id, password);
      const presence = await dbSecretPresence(id);
      onSave({
        id,
        kind,
        name: connName || (kind === "sqlite" ? file.trim() : host.trim()),
        host: kind === "sqlite" ? "" : host.trim(),
        port: kind === "sqlite" ? 0 : portNumber,
        user: kind === "sqlite" ? "" : user.trim(),
        database: kind === "sqlite" ? "" : database.trim(),
        file: kind === "sqlite" ? file.trim() : "",
        hasPassword: presence.hasPassword,
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-[440px] max-w-full flex-col gap-3 rounded-xl border border-line-strong bg-raised p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[13px] font-medium text-fg">
          {connection ? "编辑连接" : "新增连接"}
        </h2>

        <Row label="类型">
          <div className="flex gap-1 rounded-md border border-line-strong p-0.5">
            {DB_KINDS.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => pickKind(item)}
                className={`${SEGMENT} ${kind === item ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
              >
                {DB_KIND_LABELS[item]}
              </button>
            ))}
          </div>
        </Row>

        <Row label="名称">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="留空用地址或文件名"
            spellCheck={false}
            className={INPUT}
          />
        </Row>

        {kind === "sqlite" ? (
          <Row label="数据库文件">
            <div className="flex gap-2">
              <input
                value={file}
                onChange={(event) => setFile(event.target.value)}
                placeholder="如 C:\\data\\app.db"
                spellCheck={false}
                className={INPUT}
              />
              <button
                type="button"
                onClick={() => void pickFile()}
                title="选择数据库文件"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line-strong text-fg-dim hover:bg-hover hover:text-fg"
              >
                <IconFolderOpen className="h-3.5 w-3.5" />
              </button>
            </div>
          </Row>
        ) : (
          <>
            <div className="flex gap-3">
              <div className="flex-[2]">
                <Row label="主机地址">
                  <input
                    value={host}
                    onChange={(event) => setHost(event.target.value)}
                    placeholder="IP 或域名"
                    spellCheck={false}
                    className={INPUT}
                  />
                </Row>
              </div>
              <div className="flex-1">
                <Row label="端口">
                  <input
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    spellCheck={false}
                    className={INPUT}
                  />
                </Row>
              </div>
            </div>

            <div className="flex gap-3">
              <div className="flex-1">
                <Row label="用户名">
                  <input
                    value={user}
                    onChange={(event) => setUser(event.target.value)}
                    placeholder={kind === "mysql" ? "如 root" : "如 postgres"}
                    spellCheck={false}
                    className={INPUT}
                  />
                </Row>
              </div>
              <div className="flex-1">
                <Row label="密码">
                  <input
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={connection?.hasPassword ? "已保存，留空则不改动" : "留空表示无密码"}
                    spellCheck={false}
                    className={INPUT}
                  />
                </Row>
              </div>
            </div>

            <Row label="数据库">
              <input
                value={database}
                onChange={(event) => setDatabase(event.target.value)}
                placeholder="库名，留空用默认库"
                spellCheck={false}
                className={INPUT}
              />
            </Row>
          </>
        )}

        {error && <p className="text-[11px] leading-relaxed text-danger">{error}</p>}

        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="rounded-md border border-accent px-3 py-1 text-[12px] text-accent hover:bg-selected disabled:opacity-60"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

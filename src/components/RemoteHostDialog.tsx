import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  clearHostSecrets,
  hostSecretPresence,
  newHostId,
  setHostPassphrase,
  setHostPassword,
  testRemoteConnection,
  type RemoteAuth,
  type RemoteHost,
} from "../lib/remote";
import { IconFolderOpen } from "./icons";

interface RemoteHostDialogProps {
  /** 编辑已有主机时传入；新增传 null */
  host: RemoteHost | null;
  onSave: (host: RemoteHost) => void;
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
 * 新增 / 编辑一台远程主机。密码与私钥口令只在提交时写系统钥匙串，
 * localStorage 里只落「有没有」的布尔位（照 AI 提供商那套）。
 */
export function RemoteHostDialog({ host, onSave, onClose }: RemoteHostDialogProps) {
  const [name, setName] = useState(host?.name ?? "");
  const [address, setAddress] = useState(host?.host ?? "");
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [user, setUser] = useState(host?.user ?? "");
  const [auth, setAuth] = useState<RemoteAuth>(host?.auth ?? "password");
  const [keyPath, setKeyPath] = useState(host?.keyPath ?? "");
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  /** 测试连接的结果；null = 还没测过。改动任一连接参数后清掉，免得留着过期的「连接成功」 */
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** 钥匙串里是否存着凭据。本对话框里可以「清除」，所以用本地状态，不直接读 host */
  const [savedPassword, setSavedPassword] = useState(host?.hasPassword ?? false);
  const [savedPassphrase, setSavedPassphrase] = useState(host?.hasPassphrase ?? false);

  // 改动任何一个影响连接的字段，上次的测试结果就过期了
  useEffect(() => {
    setTestResult(null);
  }, [address, port, user, auth, keyPath, password, passphrase]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickKey = async () => {
    try {
      const selected = await open({ multiple: false, title: "选择私钥文件" });
      if (typeof selected === "string") setKeyPath(selected);
    } catch {
      // 用户取消或对话框不可用，保持原值
    }
  };

  /** 校验表单，通过返回解析后的端口，不通过则设错误并返回 null */
  const validate = (): number | null => {
    if (!address.trim()) {
      setError("请填写主机地址");
      return null;
    }
    if (!user.trim()) {
      setError("请填写用户名");
      return null;
    }
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError("端口要在 1–65535 之间");
      return null;
    }
    if (auth === "key" && !keyPath.trim()) {
      setError("私钥认证需要选择私钥文件");
      return null;
    }
    if (auth === "password" && !password && !savedPassword) {
      setError("请填写密码");
      return null;
    }
    return portNumber;
  };

  /** 试连一次验证参数。刚敲的明文凭据直接传后端，不落钥匙串 */
  const runTest = async () => {
    const portNumber = validate();
    if (portNumber === null) return;
    setTesting(true);
    setError("");
    setTestResult(null);
    const addr = address.trim();
    try {
      const result = await testRemoteConnection({
        hostId: host?.id ?? "",
        host: addr,
        port: portNumber,
        user: user.trim(),
        auth,
        keyPath: keyPath.trim(),
        // 地址 / 端口没变才沿用旧指纹；换了地址不该拿旧指纹去校验
        expectedFingerprint:
          host && host.host === addr && host.port === portNumber ? host.fingerprint : "",
        password,
        passphrase,
      });
      setTestResult({
        ok: true,
        message: result.fingerprint ? `连接成功，主机指纹 ${result.fingerprint}` : "连接成功",
      });
    } catch (reason) {
      setTestResult({ ok: false, message: String(reason) });
    } finally {
      setTesting(false);
    }
  };

  /** 把该主机在钥匙串里的密码 / 口令清掉（后端传空串即删除），并刷新「已保存」状态 */
  const clearCredentials = async () => {
    if (!host) return;
    setClearing(true);
    setError("");
    try {
      await clearHostSecrets(host.id);
      const presence = await hostSecretPresence(host.id);
      setSavedPassword(presence.hasPassword);
      setSavedPassphrase(presence.hasPassphrase);
      setTestResult(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setClearing(false);
    }
  };

  const submit = async () => {
    const portNumber = validate();
    if (portNumber === null) return;
    const addr = address.trim();
    const userName = user.trim();

    setSaving(true);
    setError("");
    const id = host?.id ?? newHostId();
    try {
      // 只在用户填了才写，留空 = 不改动已有凭据
      if (password) await setHostPassword(id, password);
      if (passphrase) await setHostPassphrase(id, passphrase);
      const presence = await hostSecretPresence(id);
      onSave({
        id,
        name: name.trim() || addr,
        host: addr,
        port: portNumber,
        user: userName,
        auth,
        keyPath: keyPath.trim(),
        hasPassword: presence.hasPassword,
        hasPassphrase: presence.hasPassphrase,
        // 换地址 / 端口后旧指纹不该再信任；同地址保留
        fingerprint: host && host.host === addr && host.port === portNumber ? host.fingerprint : "",
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="codovo-modal-scrim fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      // 认「按下点就在遮罩上」而不是 click：从弹窗内按下、拖到遮罩上松开会误判成点外部
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-[440px] max-w-full flex-col gap-3 rounded-xl border border-line-strong bg-raised p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[13px] font-medium text-fg">
          {host ? "编辑主机" : "新增主机"}
        </h2>

        <div className="flex gap-3">
          <div className="flex-[2]">
            <Row label="名称">
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="如 生产服务器"
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

        <Row label="主机地址">
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="IP 或域名"
            spellCheck={false}
            className={INPUT}
          />
        </Row>

        <Row label="用户名">
          <input
            value={user}
            onChange={(event) => setUser(event.target.value)}
            placeholder="如 root"
            spellCheck={false}
            className={INPUT}
          />
        </Row>

        <Row label="认证方式">
          <div className="flex gap-1 rounded-md border border-line-strong p-0.5">
            <button
              type="button"
              onClick={() => setAuth("password")}
              className={`${SEGMENT} ${auth === "password" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              密码
            </button>
            <button
              type="button"
              onClick={() => setAuth("key")}
              className={`${SEGMENT} ${auth === "key" ? "bg-selected text-fg" : "text-fg-dim hover:bg-hover"}`}
            >
              私钥文件
            </button>
          </div>
        </Row>

        {auth === "password" ? (
          <Row label="密码">
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={savedPassword ? "已保存，留空则不改动" : "输入登录密码"}
              spellCheck={false}
              className={INPUT}
            />
          </Row>
        ) : (
          <>
            <Row label="私钥文件">
              <div className="flex gap-2">
                <input
                  value={keyPath}
                  onChange={(event) => setKeyPath(event.target.value)}
                  placeholder="如 ~/.ssh/id_ed25519"
                  spellCheck={false}
                  className={INPUT}
                />
                <button
                  type="button"
                  onClick={() => void pickKey()}
                  title="选择私钥文件"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line-strong text-fg-dim hover:bg-hover hover:text-fg"
                >
                  <IconFolderOpen className="h-3.5 w-3.5" />
                </button>
              </div>
            </Row>
            <Row label="私钥口令">
              <input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder={savedPassphrase ? "已保存，留空则不改动" : "私钥没加密就留空"}
                spellCheck={false}
                className={INPUT}
              />
            </Row>
          </>
        )}

        {host && (savedPassword || savedPassphrase) && (
          <div className="flex justify-end">
            <button
              type="button"
              disabled={clearing || saving || testing}
              onClick={() => void clearCredentials()}
              className="text-[11px] text-fg-dim hover:text-danger disabled:opacity-60"
            >
              {clearing ? "清除中…" : "清除已保存凭据"}
            </button>
          </div>
        )}

        {error && <p className="text-[11px] leading-relaxed text-danger">{error}</p>}

        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            disabled={testing || saving}
            onClick={() => void runTest()}
            className="shrink-0 rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg disabled:opacity-60"
          >
            {testing ? "测试中…" : "测试连接"}
          </button>
          <span
            className={`min-w-0 flex-1 truncate text-[11px] ${
              testResult?.ok ? "text-accent" : "text-danger"
            }`}
            title={testResult?.message}
          >
            {testResult?.message ?? ""}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md border border-line-strong px-3 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg"
          >
            取消
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="shrink-0 rounded-md border border-accent px-3 py-1 text-[12px] text-accent hover:bg-selected disabled:opacity-60"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}

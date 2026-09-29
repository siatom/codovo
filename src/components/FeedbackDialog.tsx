import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useEffect, useState } from "react";
import { formatTime } from "../lib/agent";
import {
  CATEGORIES,
  categoryLabel,
  cliStatus,
  composeBody,
  deleteFeedback,
  environmentInfo,
  feedbackTarget,
  listFeedback,
  newIssueUrl,
  refreshFeedback,
  stateLabel,
  submitFeedback,
  type CliStatus,
  type FeedbackRecord,
  type FeedbackTarget,
} from "../lib/feedback";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  IconCheck,
  IconClose,
  IconExternalLink,
  IconRefresh,
  IconSend,
  IconTrash,
} from "./icons";

interface FeedbackDialogProps {
  onClose: () => void;
}

/** 一行提示：提交结果 / 错误都在按钮下方露一行，不弹第二个框 */
type Status = { kind: "idle" | "busy" | "ok" | "error"; text: string };

const INPUT =
  "w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[12px] text-fg outline-none focus:border-accent";

const PRIMARY_BUTTON =
  "flex items-center gap-1.5 rounded-md border border-accent-line bg-selected px-3 py-1 text-[12px] text-accent hover:border-accent disabled:cursor-not-allowed disabled:opacity-40";

const GHOST_BUTTON =
  "rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-fg-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40";

/** 分类下拉 / 正文输入框的行标题 */
const LABEL = "mb-1 block text-[11px] text-fg-faint";

/** 「我的反馈」里每条记录右侧的删除按钮：平时不抢眼，悬停才透出危险色 */
const ROW_ACTION =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-faint hover:bg-hover hover:text-danger";

const TABS = [
  { id: "write", label: "写反馈" },
  { id: "history", label: "我的反馈" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** 状态徽标配色：待处理给点提醒色、已解决给绿色，其余保持中性 */
function stateClass(state: string): string {
  switch (state) {
    case "open":
      return "border-warn-line text-warn";
    case "progressing":
      return "border-accent-line text-accent";
    case "closed":
      return "border-line-strong text-ok";
    default:
      return "border-line-strong text-fg-faint";
  }
}

/** 提交结果那一行的配色：成功绿、失败红、进行中灰 */
function statusTextClass(kind: Status["kind"]): string {
  const base = "text-[11px]";
  if (kind === "ok") return `${base} text-ok`;
  if (kind === "error") return `${base} text-danger`;
  return `${base} text-fg-faint`;
}

/**
 * 意见反馈：填完直接建成本项目 Gitee 仓库的 issue，并在这里跟踪自己提过的那些状态。
 *
 * 外壳照 `SettingsDialog` / `ConfirmDialog`（遮罩 + 圆角卡片，Esc / 点遮罩关闭），
 * 刻意不用 `window.confirm` / `prompt`——WKWebView 不支持，会静默失效。
 *
 * 提交与查询都交给本机 gitee 官方 CLI：Gitee 的 WAF 按客户端指纹放行，应用自己的
 * HTTP 客户端过不去（详见 `feedback.rs` 的头注释）。CLI 没装或没登录时退成
 * 「浏览器打开新建 issue 页 + 正文写进剪贴板」——预填参数 Gitee 不一定认，
 * 剪贴板是兜底；这条路产生不了可跟踪的记录，界面上如实说明。
 */
export function FeedbackDialog({ onClose }: FeedbackDialogProps) {
  const [tab, setTab] = useState<TabId>("write");
  /** 本机 CLI 状态；null = 还在探测 */
  const [cli, setCli] = useState<CliStatus | null>(null);
  const [target, setTarget] = useState<FeedbackTarget | null>(null);
  const [category, setCategory] = useState<string>(CATEGORIES[0].value);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const [records, setRecords] = useState<FeedbackRecord[]>([]);
  /** 刷新状态时单条失败的说明；能刷新的部分照常更新 */
  const [refreshErrors, setRefreshErrors] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  /** 等待确认删除的那条本地记录 */
  const [pendingDelete, setPendingDelete] = useState<FeedbackRecord | null>(null);

  const ready = cli?.available === true && cli.loggedIn;

  /** 探一次 CLI 状态；登录状态可能在弹窗开着的时候变，所以也用于「重新检测」 */
  async function probeCli(): Promise<boolean> {
    try {
      const next = await cliStatus();
      setCli(next);
      return next.available && next.loggedIn;
    } catch (reason) {
      setCli({ available: false, loggedIn: false, detail: String(reason) });
      return false;
    }
  }

  /** 拉一份最新的记录列表，并逐条刷新状态 */
  async function refreshHistory() {
    setRefreshing(true);
    try {
      const result = await refreshFeedback();
      setRecords(result.records);
      setRefreshErrors(result.errors);
    } catch (reason) {
      setRefreshErrors([String(reason)]);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = await probeCli();
      if (!alive) return;
      // 本地记录不依赖网络，先把列表铺出来；状态刷新下面再说
      const list = await listFeedback().catch(() => []);
      if (!alive) return;
      setRecords(list);
      // 一条都没有就不用去问 Gitee 了
      if (ok && list.length > 0) void refreshHistory();
    })();
    // 仓库地址由后端给（owner/repo 只在 feedback.rs 里写一份）
    void feedbackTarget()
      .then((value) => {
        if (alive) setTarget(value);
      })
      .catch(() => {
        // 拿不到就只禁用浏览器兜底那条路，CLI 提交照常
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // 删除确认框开着时让 Esc 只关它：两个弹窗都监听 Esc，不挡住的话
      // 一下会把确认框和整个反馈弹窗一起关掉
      if (event.key === "Escape" && !pendingDelete) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pendingDelete]);

  /** 校验并拼出 issue 正文；不合格时把原因写进 status 并返回 null */
  const buildBody = (): string | null => {
    if (!title.trim()) {
      setStatus({ kind: "error", text: "请先填个标题" });
      return null;
    }
    if (!content.trim()) {
      setStatus({ kind: "error", text: "请先写点内容" });
      return null;
    }
    return composeBody(category, content, environmentInfo());
  };

  const submit = async () => {
    const body = buildBody();
    if (body === null) return;
    setStatus({ kind: "busy", text: "正在提交…" });
    try {
      const record = await submitFeedback(title.trim(), body, category);
      setRecords((prev) => [record, ...prev]);
      setTitle("");
      setContent("");
      setStatus({
        kind: "ok",
        text: `已提交，编号 ${record.number}。切到「我的反馈」可以跟踪状态。`,
      });
    } catch (reason) {
      setStatus({ kind: "error", text: String(reason) });
    }
  };

  /**
   * CLI 用不了时的兜底：浏览器打开新建 issue 页。
   * 正文先写进剪贴板——预填参数 Gitee 不一定认，认不了用户还能直接粘贴。
   */
  const openInBrowser = async () => {
    const body = buildBody();
    if (body === null || !target) return;
    const copied = await writeText(body).then(
      () => true,
      () => false,
    );
    try {
      await openUrl(newIssueUrl(target.webNewIssue, title.trim(), body));
    } catch (reason) {
      setStatus({ kind: "error", text: `打不开浏览器：${reason}` });
      return;
    }
    setStatus({
      kind: "ok",
      text: copied
        ? "已在浏览器打开新建 issue，正文已复制到剪贴板，粘贴进去即可。这样提交的反馈无法在这里跟踪状态。"
        : "已在浏览器打开新建 issue，把内容填进去即可。这样提交的反馈无法在这里跟踪状态。",
    });
  };

  const removeRecord = async (number: string) => {
    setPendingDelete(null);
    try {
      setRecords(await deleteFeedback(number));
      setRefreshErrors((prev) => prev.filter((item) => !item.startsWith(`#${number} `)));
    } catch (reason) {
      setRefreshErrors([String(reason)]);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          className="flex max-h-full w-[640px] max-w-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-lg"
          onClick={(event) => event.stopPropagation()}
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-medium text-fg">意见反馈</h2>
            {target && (
              <span className="min-w-0 truncate text-[11px] text-fg-faint">
                {target.owner}/{target.repo}
              </span>
            )}
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-hover hover:text-fg"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </header>

          <div className="flex shrink-0 gap-1 px-4 pt-3">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`rounded-md px-2.5 py-1 text-[12px] ${
                  tab === item.id
                    ? "bg-selected text-fg"
                    : "text-fg-muted hover:bg-hover hover:text-fg"
                }`}
              >
                {item.label}
                {item.id === "history" && records.length > 0 && ` (${records.length})`}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {tab === "history" ? renderHistory() : renderWrite()}
          </div>
        </div>
      </div>

      {/* 确认框放在遮罩**外面**：嵌在遮罩里的话，点它自己的遮罩会冒泡上去
          把整个反馈弹窗一起关掉 */}
      {pendingDelete && (
        <ConfirmDialog
          message={`从本地历史里移除 #${pendingDelete.number}？只清 CodeDock 这边的记录，Gitee 上的 issue 不受影响。`}
          confirmLabel="移除"
          onConfirm={() => void removeRecord(pendingDelete.number)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </>
  );

  /** CLI 不可用时的说明条：讲清为什么、怎么修，并给一个重新检测的入口 */
  function renderCliHint() {
    if (cli === null) return null;
    return (
      <div className="mb-3 rounded-lg border border-line bg-surface p-2.5">
        <p className="text-[11px] leading-relaxed text-fg-muted">
          {cli.available
            ? "本机 gitee CLI 还没登录。"
            : "本机没有找到 gitee CLI，反馈功能需要它代发。"}
        </p>
        {cli.detail && (
          <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">{cli.detail}</p>
        )}
        <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
          {cli.available
            ? "在终端执行 gitee auth login 后回来重新检测。"
            : "安装：npm i -g @gitee/gitee-cli，然后 gitee auth login。"}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setStatus({ kind: "idle", text: "" });
              void probeCli();
            }}
            className={GHOST_BUTTON}
          >
            重新检测
          </button>
          <span className="text-[11px] text-fg-faint">
            不装也能反馈：下面的按钮会改为在浏览器里打开新建 issue 页面。
          </span>
        </div>
      </div>
    );
  }

  function renderWrite() {
    return (
      <>
        {ready ? (
          <div className="mb-3 flex items-center gap-2 text-[11px] text-fg-faint">
            <IconCheck className="h-3.5 w-3.5 text-ok" />
            <span>将由本机 gitee CLI 提交</span>
          </div>
        ) : (
          renderCliHint()
        )}

        <label className={LABEL} htmlFor="feedback-category">
          类型
        </label>
        <select
          id="feedback-category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          className={`${INPUT} mb-3`}
        >
          {CATEGORIES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>

        <label className={LABEL} htmlFor="feedback-title">
          标题
        </label>
        <input
          id="feedback-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="一句话说明问题或建议"
          className={`${INPUT} mb-3`}
        />

        <label className={LABEL} htmlFor="feedback-content">
          详细描述
        </label>
        <textarea
          id="feedback-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={8}
          placeholder="期望发生什么、实际发生了什么，能复现的话写一下步骤"
          className={`${INPUT} resize-y leading-relaxed`}
        />

        <p className="mt-2 text-[11px] text-fg-faint">
          提交时会自动附上版本号和系统信息，方便定位问题。
        </p>

        <div className="mt-3 flex items-center gap-2">
          {ready ? (
            <button type="button" onClick={() => void submit()} className={PRIMARY_BUTTON}>
              <IconSend className="h-3.5 w-3.5" />
              提交反馈
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void openInBrowser()}
              disabled={cli === null || !target}
              title={
                cli === null
                  ? "正在检测本机 gitee CLI…"
                  : target
                    ? "在浏览器里打开新建 issue 页面"
                    : "拿不到仓库地址，稍后再试"
              }
              className={PRIMARY_BUTTON}
            >
              <IconExternalLink className="h-3.5 w-3.5" />
              在浏览器中打开
            </button>
          )}
          <span className={statusTextClass(status.kind)}>{status.text}</span>
        </div>
      </>
    );
  }

  function renderHistory() {
    return (
      <>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[11px] text-fg-faint">
            {records.length > 0 ? `共 ${records.length} 条` : ""}
          </span>
          <button
            type="button"
            onClick={() => void refreshHistory()}
            disabled={!ready || refreshing || records.length === 0}
            title={
              ready ? "重新向 Gitee 查询状态" : "本机 gitee CLI 不可用，刷新不了状态"
            }
            className={`ml-auto flex items-center gap-1 ${GHOST_BUTTON}`}
          >
            <IconRefresh className="h-3.5 w-3.5" />
            {refreshing ? "刷新中…" : "刷新状态"}
          </button>
        </div>

        {refreshErrors.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1">
            {refreshErrors.map((item, index) => (
              <li key={index} className="text-[11px] text-warn">
                {item}
              </li>
            ))}
          </ul>
        )}

        {records.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-fg-faint">
            还没提交过反馈
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {records.map((record) => (
              <li
                key={record.number}
                className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-hover"
              >
                <span
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${stateClass(record.state)}`}
                >
                  {stateLabel(record.state)}
                </span>
                <span className="shrink-0 rounded border border-line-strong px-1.5 py-0.5 text-[10px] text-fg-faint">
                  {categoryLabel(record.category)}
                </span>
                <button
                  type="button"
                  onClick={() => void openUrl(record.url).catch(() => {})}
                  title={`${record.url}\n在浏览器中打开`}
                  className="min-w-0 flex-1 truncate text-left text-[12px] text-fg-muted hover:text-fg hover:underline"
                >
                  {record.title}
                </button>
                <span className="shrink-0 text-[11px] text-fg-faint">
                  {formatTime(record.createdAt)}
                </span>
                <button
                  type="button"
                  onClick={() => setPendingDelete(record)}
                  title="从本地历史里移除"
                  className={`${ROW_ACTION} opacity-0 group-hover:opacity-100 focus-visible:opacity-100`}
                >
                  <IconTrash className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FullscreenButton } from "./FullscreenButton";
import {
  IconChevronDown,
  IconChevronRight,
  IconRefresh,
  IconRocket,
} from "./icons";
import {
  cicdStatus,
  detectCicdConfig,
  readCicdConfig,
  runCicd,
  stopCicd,
  writeCicdConfig,
  type CicdConfigFile,
  type CicdEvent,
  type CicdStatus,
} from "../lib/cicd";

const HEAD_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-dim hover:bg-active hover:text-fg disabled:text-fg-faint disabled:hover:bg-transparent";

/** 主阶段顺序。Rollback 只在失败时出现，单独附加 */
const STAGES: { id: string; label: string }[] = [
  { id: "preflight", label: "Preflight" },
  { id: "build", label: "Build" },
  { id: "deploy", label: "Deploy" },
  { id: "verify", label: "Verify" },
];

type StageStatus = "pending" | "running" | "ok" | "fail";

interface StageState {
  status: StageStatus;
  command: string;
  durationMs?: number;
  code?: number;
}

interface LogLine {
  stage: string;
  stream: "stdout" | "stderr";
  line: string;
}

const emptyStages = (): Record<string, StageState> => ({});

/**
 * 右栏的「部署」模块：读 / 改项目根的 `.local-cicd.yaml`，一键按
 * Preflight → Build → Deploy → Verify 在本机跑一条流水线，实时看阶段进度与日志。
 *
 * 对齐本机的 local-cicd 技能：配置驱动、单机单环境、失败即停。产出落 `.local-cicd/`。
 */
export function DeployPane({
  root,
  visible,
  fullscreen,
  onToggleFullscreen,
}: {
  root: string;
  /** 面板是不是真的露在用户眼前（右栏展开且当前看的正是它）。收起时轮询短路 */
  visible: boolean;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const [config, setConfig] = useState<CicdConfigFile | null>(null);
  const [yaml, setYaml] = useState("");
  const [dirty, setDirty] = useState(false);
  const [configOpen, setConfigOpen] = useState(true);
  const [configMsg, setConfigMsg] = useState("");
  const [status, setStatus] = useState<CicdStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<Record<string, StageState>>(emptyStages);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    try {
      const file = await readCicdConfig(root);
      setConfig(file);
      // 没有配置文件时按项目标记给一份建议，让用户有个起点
      if (file.exists) {
        setYaml(file.yaml);
      } else {
        const suggestion = await detectCicdConfig(root);
        setYaml(suggestion);
        setConfigMsg("未找到配置文件，已按项目标记生成建议");
      }
      setDirty(false);
      setError("");
    } catch (reason) {
      setError(String(reason));
    }
  }, [root]);

  // 切工作区 / 首次挂载：重置并重新加载
  useEffect(() => {
    setConfig(null);
    setStatus(null);
    setStages(emptyStages());
    setLogs([]);
    setError("");
    setConfigMsg("");
    void load();
  }, [load]);

  // 状态轮询：只在面板可见时跑
  useEffect(() => {
    if (!visible) return;
    let stopped = false;
    const tick = async () => {
      try {
        const next = await cicdStatus(root);
        if (!stopped) setStatus(next);
      } catch {
        // 轮询失败不打扰界面
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [visible, root]);

  // 日志自动滚到底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const onEvent = useCallback((event: CicdEvent) => {
    switch (event.type) {
      case "stageStart":
        setStages((current) => ({
          ...current,
          [event.stage]: { status: "running", command: event.command },
        }));
        break;
      case "output":
        setLogs((current) => [
          ...current,
          { stage: event.stage, stream: event.stream, line: event.line },
        ]);
        break;
      case "stageEnd":
        setStages((current) => ({
          ...current,
          [event.stage]: {
            ...(current[event.stage] ?? { command: "" }),
            status: event.ok ? "ok" : "fail",
            durationMs: event.durationMs,
            code: event.code,
          },
        }));
        break;
      case "finished":
        setBusy(false);
        if (!event.ok) setError(event.message);
        void cicdStatus(root).then(setStatus);
        break;
    }
  }, [root]);

  const start = useCallback(async () => {
    setError("");
    setStages(emptyStages());
    setLogs([]);
    setBusy(true);
    try {
      await runCicd(root, onEvent);
      // 后端 spawn 后台线程后立即返回，真正的结束看 finished 事件
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  }, [root, onEvent]);

  const stop = useCallback(async () => {
    try {
      await stopCicd(root);
    } catch (reason) {
      setError(String(reason));
    }
  }, [root]);

  const save = useCallback(async () => {
    setConfigMsg("");
    try {
      await writeCicdConfig(root, yaml);
      setDirty(false);
      setConfigMsg("已保存");
      await load();
    } catch (reason) {
      setConfigMsg(String(reason));
    }
  }, [root, yaml, load]);

  const detect = useCallback(async () => {
    setConfigMsg("");
    try {
      const suggestion = await detectCicdConfig(root);
      setYaml(suggestion);
      setDirty(true);
      setConfigMsg("已按项目标记重新生成，请确认后保存");
    } catch (reason) {
      setConfigMsg(String(reason));
    }
  }, [root]);

  const running = busy || status?.running === true;
  const version = status?.currentVersion ?? null;
  const stageList = useMemo(
    () => (stages.rollback ? [...STAGES, { id: "rollback", label: "Rollback" }] : STAGES),
    [stages.rollback],
  );

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-content">
      <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${running ? "bg-accent" : "bg-line-strong"}`}
          title={running ? "流水线运行中" : "空闲"}
        />
        <span className="shrink-0 text-[11px] font-medium tracking-wide text-fg-dim">
          部署
        </span>
        {version && (
          <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-fg-dim">
            {version}
          </span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-fg-faint"
          title={config?.path ?? ""}
        >
          {config?.path ?? ""}
        </span>
        <button
          type="button"
          onClick={running ? stop : start}
          disabled={!running && yaml.trim().length === 0}
          title={running ? "停止流水线" : "在本机跑一条流水线"}
          className="flex h-6 shrink-0 items-center gap-1 rounded border border-line-strong px-2 text-[11px] text-fg hover:bg-hover disabled:opacity-50"
        >
          <IconRocket className="h-3.5 w-3.5" />
          {running ? "停止" : "部署"}
        </button>
        <button
          type="button"
          onClick={() => void load()}
          disabled={running}
          title="重新读取配置与状态"
          className={HEAD_BUTTON}
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
        <FullscreenButton fullscreen={fullscreen} onToggle={onToggleFullscreen} />
      </header>

      {error && (
        <div className="shrink-0 border-b border-line bg-danger-bg px-3 py-1.5 text-[11px] leading-relaxed text-danger">
          {error}
        </div>
      )}

      {/* 配置区：直接编辑 YAML 源，保存回项目根 .local-cicd.yaml */}
      <div className="shrink-0 border-b border-line">
        <button
          type="button"
          onClick={() => setConfigOpen((open) => !open)}
          className="flex h-7 w-full items-center gap-1 px-3 text-[11px] text-fg-dim hover:bg-hover"
        >
          {configOpen ? (
            <IconChevronDown className="h-3 w-3" />
          ) : (
            <IconChevronRight className="h-3 w-3" />
          )}
          <span>配置</span>
          {dirty && <span className="text-warn">·未保存</span>}
          <span className="min-w-0 flex-1 truncate text-right text-fg-faint">
            {config?.exists === false ? "（尚未创建）" : ""}
          </span>
        </button>
        {configOpen && (
          <div className="px-3 pb-2">
            <textarea
              value={yaml}
              onChange={(event) => {
                setYaml(event.target.value);
                setDirty(true);
                setConfigMsg("");
              }}
              spellCheck={false}
              placeholder=".local-cicd.yaml 内容"
              className="h-52 w-full resize-y rounded border border-line-strong bg-surface p-2 font-mono text-[11px] leading-relaxed text-fg outline-none placeholder:text-fg-faint focus:border-accent"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty}
                className="h-6 rounded bg-accent px-2 text-[11px] font-medium text-app hover:opacity-90 disabled:opacity-50"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => void detect()}
                className="h-6 rounded border border-line-strong px-2 text-[11px] text-fg hover:bg-hover"
              >
                按项目探测
              </button>
              <span className="min-w-0 flex-1 truncate text-[11px] text-fg-faint">
                {configMsg}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 阶段进度 */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        {stageList.map((stage) => {
          const state = stages[stage.id];
          const stageStatus = state?.status ?? "pending";
          return (
            <div
              key={stage.id}
              className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] ${stageBox(stageStatus)}`}
              title={state?.command ?? ""}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${stageDot(stageStatus)}`} />
              <span>{stage.label}</span>
              {stageStatus === "ok" && state?.durationMs != null && (
                <span className="text-fg-faint">{state.durationMs}ms</span>
              )}
            </div>
          );
        })}
      </div>

      {/* 日志 */}
      <div
        ref={logRef}
        className="min-h-0 flex-1 overflow-auto bg-app px-3 py-2 font-mono text-[11px] leading-relaxed"
      >
        {logs.length === 0 ? (
          <p className="text-fg-faint">
            {running ? "正在等待输出…" : "（暂无输出，点右上角「部署」开跑）"}
          </p>
        ) : (
          logs.map((line, index) => (
            <div
              key={index}
              className={`whitespace-pre-wrap ${line.stream === "stderr" ? "text-warn" : "text-fg-dim"}`}
            >
              {line.line}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function stageBox(status: StageStatus): string {
  switch (status) {
    case "running":
      return "bg-accent-soft text-accent";
    case "ok":
      return "bg-hover text-ok";
    case "fail":
      return "bg-danger-bg text-danger";
    default:
      return "bg-hover text-fg-faint";
  }
}

function stageDot(status: StageStatus): string {
  switch (status) {
    case "running":
      return "bg-accent";
    case "ok":
      return "bg-ok";
    case "fail":
      return "bg-danger";
    default:
      return "bg-line-strong";
  }
}

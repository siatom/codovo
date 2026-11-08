import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import {
  TerminalSession,
  type TerminalSessionHandle,
} from "./TerminalSession";
import { useSettings } from "../lib/settings";
import { agentEnvFor } from "../lib/agents";
import { hasInternalTabs, prepareLaunch } from "../lib/cli-launch";
import { acpProviderKey } from "../lib/acp";
import { cliKey } from "../lib/cli-sessions";
import { pathKey, samePath } from "../lib/fs";
import { terminalTarget, useAttention } from "../lib/attention";
import { useTouchActivity } from "../lib/activity";
import { listShells, type ShellInfo } from "../lib/pty";
import { usePaneSizes } from "../lib/use-pane-sizes";
import type { EditorLocation, TerminalSessionInfo } from "../lib/types";
import { AcpChatPane, type AcpChatPaneHandle, type AcpChatTaskTab, type AcpCliOption } from "./AcpChatPane";
import {
  AgentLogo,
  IconLayoutColumns,
  IconLayoutRows,
  IconLayoutSingle,
  ShellIcon,
} from "./icons";
import { ICON_SM, IconButton } from "./ui";

/** + 号右侧下拉的宽度；菜单贴到窗口右边时要靠它往回收 */
const SHELL_MENU_ITEM =
  "flex items-center gap-2 truncate px-3 py-1 text-left text-[12px] text-fg-muted hover:bg-hover hover:text-fg";

/**
 * 「路径:起[-止]」——单行只写一个行号，跨行才带结束行号。
 * 路径带空格时整串加引号：不加的话 shell 会把它拆成两个词，引用就废了。
 * 只在这一侧加——智能体那边给的是 API 的纯文本，不经过 shell。
 */
function formatLocation({ path, start, end }: EditorLocation): string {
  const text = `${path}:${start}${end > start ? `-${end}` : ""}`;
  return /\s/.test(path) ? `"${text}"` : text;
}

export interface TerminalPaneHandle {
  /**
   * 新开一个终端标签并在里面执行命令（Agent 面板与会话 resume 都用它；
   * 对自带多标签页的 CLI 会先复用已经开着的标签，见 launchCli）。
   * 不能写进当前活动会话——那儿可能正跑着别的东西，命令会被当成它的输入。
   * 命令会按工作区的附加目录自动注入 CLI 参数（见 lib/cli-launch.ts）。
   * `title` 直接作新标签的标题：AI CLI 传 CLI 名，resume 传被恢复会话的标题。
   */
  runInNewSession: (command: string, title: string) => void;
  /** 在终端或 ACP 对话中切换到指定 Agent */
  selectAgent: (command: string, title: string, mode: "terminal" | "chat") => void;
  selectAcpChat: (command: string, chatId: string) => void;
  createAcpChat: (command: string) => string | null;
  closeAcpChat: (command: string, chatId: string) => void;
  /** 新建、关闭或重启超级 Tab 中的终端会话 */
  newSession: (shell?: string) => void;
  openCreateMenu: (anchor: HTMLElement) => void;
  closeSession: (id: number) => void;
  restartSession: (id: number) => void;
  /** 把位置引用写进当前活动的终端会话，不带回车（用户自己按回车执行） */
  insertToTerminal: (location: EditorLocation) => void;
  /**
   * 选中某个已存在的终端标签并聚焦它。侧栏的「在等用户」提示点它跳过来用。
   * 标签已经关掉了就什么都不做。
   */
  focusSession: (id: number) => void;
  /**
   * 切到落在某个目录里的终端：已经有（cwd 相同）就聚焦，没有就新开一个。
   * 变更雷达的「去看」用它——工作树不在工作区根下，得单独指定落点。
   */
  focusOrOpenAt: (cwd: string) => void;
}

export interface TerminalTaskTab {
  id: number;
  label: string;
  attention: TerminalSessionInfo["attention"];
  agent: { name: string; command: string } | null;
  shellKind: string;
}

interface TerminalPaneProps {
  /** 这个终端区属于哪个工作区（活动根）。PTY 会话按它归属，关工作区时要能收干净 */
  root: string;
  /** 工作区挂的全部工作目录。root 是活动根，其余目录在启动 AI CLI 时作为附加目录注入 */
  roots: string[];
  /** 是不是当前显示的工作区。隐藏时只是不显示，shell 照跑 */
  visible: boolean;
  /** 由工作区超级 Tab 控制：终端与 ACP 对话是两个并列任务 */
  view: "terminal" | "chat";
  /** 将终端会话标签同步到工作区超级 Tab 栏 */
  onTaskTabsChange: (tabs: TerminalTaskTab[], activeId: number) => void;
  onSelectView: (view: "terminal") => void;
  onSelectAcpChat: (command: string, chatId: string) => void;
  onAcpChatsChange: (chats: AcpChatTaskTab[]) => void;
  selectedAcpChat: { command: string; chatId: string } | null;
  /** 将终端布局操作放入工作区超级 Tab 右侧 */
  toolbarTarget?: HTMLElement | null;
  /**
   * 会话归属上报：id、shell 落点、是否在等用户。变更雷达靠它把「哪个工作树在跑、
   * 谁在等我」落到具体工作树上（attention store 是按工作区根记的，落不到树）。
   */
  onSessionsReport?: (sessions: TerminalSessionInfo[]) => void;
  /** 点击终端里的文件引用时路由到编辑器 */
  onOpenFile?: (path: string, line: number) => void;
  /** React 19 起 ref 可以直接当普通 prop 传，不必再包 forwardRef */
  ref?: Ref<TerminalPaneHandle>;
}

/**
 * 终端区：管一组会话，每个会话各自持有一个 PTY。
 * 超级 Tab 和右侧 Agent 面板负责切换；切走只是隐藏，shell 不会被打断。
 */
export function TerminalPane({
  root,
  roots,
  visible,
  view,
  onTaskTabsChange,
  onSelectView,
  onSelectAcpChat,
  onAcpChatsChange,
  selectedAcpChat,
  toolbarTarget,
  onSessionsReport,
  onOpenFile,
  ref,
}: TerminalPaneProps) {
  const [sessions, setSessions] = useState<number[]>([0]);
  const [titleRevision, setTitleRevision] = useState(0);
  const [activeId, setActiveId] = useState(0);
  const [layout, setLayout] = useState<"tabs" | "horizontal" | "vertical">("tabs");
  /** 对话面板选中的 CLI，存整条命令（设置里可能同名多条） */
  const [chatCommand, setChatCommand] = useState<string | null>(null);
  /**
   * 新建标签时要自动敲进去的命令，按会话 id 记。和 sessions 在同一次事件里更新，
   * 新会话第一次渲染就带着它——不存在"先挂载、后补命令"的时间窗。
   */
  const [launchFor, setLaunchFor] = useState<{ id: number; command: string } | null>(null);
  // 终端标签的「在等用户」标记：TerminalSession 启发式判出来上抛，这里写进全局 store，
  // 侧栏工作区行、标签栏据此提示（非当前工作区的也要看得见）
  const {
    entries: attention,
    set: setAttention,
    clear: clearAttention,
  } = useAttention(root);
  // 终端有真实使用（用户输入 / 已在跑命令的输出）时上报一次，侧栏据此把最近用过的工作区排前面
  const touchActivity = useTouchActivity();
  const nextIdRef = useRef(1);
  const handlesRef = useRef(new Map<number, TerminalSessionHandle>());
  const acpChatRef = useRef<AcpChatPaneHandle>(null);
  const selectAgentRef = useRef<(command: string, title: string, mode: "terminal" | "chat") => void>(() => {});
  /** 每个会话被创建时在下拉里选的 shell id；没记的走设置里的默认 */
  const shellByIdRef = useRef(new Map<number, string>());
  /** shell 落点：只有工作树终端会记，没记的落在 root。创建时定死，不随切换变化 */
  const cwdByIdRef = useRef(new Map<number, string>());
  /**
   * 普通 shell 会话的标签序号：它用的 shell 是第几次被开出来的。**创建时定死**，
   * 不按「当前还剩几个同名」算——关掉别的标签不会让剩下的跳号（pwsh 3 → pwsh 2）。
   */
  const shellSeqByIdRef = useRef(new Map<number, number>());
  /** 每个 shell 已开出过几个会话，给上面那份序号计数 */
  const shellCountRef = useRef(new Map<string, number>());
  /** AI CLI / resume 会话的标签标题；有值的会话不再按 shell 命名 */
  const customTitleByIdRef = useRef(new Map<number, string>());
  /** AI CLI / resume 的原始启动命令：用于顶栏精确匹配与 logo 识别 */
  const hintByIdRef = useRef(new Map<number, string>());
  /** 实际敲进终端的完整命令（带注入的附加目录参数），只用于标签的 hover 提示 */
  const launchCommandByIdRef = useRef(new Map<number, string>());
  /** 某些 CLI 的附加目录要靠环境变量传（opencode），按会话记一份，PTY 启动时设进去 */
  const launchEnvByIdRef = useRef(new Map<number, Record<string, string>>());
  /** 并列布局的容器：拖分隔条时按它的尺寸换算比例 */
  const splitRef = useRef<HTMLDivElement>(null);
  const {
    sizes: paneSizes,
    onHandleDown,
    onHandleMove,
    onHandleUp,
  } = usePaneSizes(sessions.length, layout === "horizontal" ? "row" : "column", splitRef);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [shellOptions, setShellOptions] = useState<ShellInfo[]>([]);
  const [createMenuPos, setCreateMenuPos] = useState<{ left: number; top: number } | null>(null);
  const { settings } = useSettings();

  /** root 之外的工作目录：启动 AI CLI 时作为附加目录传给 CLI */
  const additionalRoots = useMemo(
    () => roots.filter((item) => !samePath(item, root)),
    [root, roots],
  );
  // runInNewSession 走 useImperativeHandle 暴露给 App，句柄必须保持稳定；
  // 附加目录却会随活动根切换而变，用 ref 取最新值，别把 ref 回调带旧。
  const additionalRootsRef = useRef(additionalRoots);
  additionalRootsRef.current = additionalRoots;
  // 同上：runInNewSession 的句柄要稳定，但 Agent 的环境变量随时可能在设置里改
  const aiCommandsRef = useRef(settings.aiCommands);
  aiCommandsRef.current = settings.aiCommands;

  // 标签页要显示每个会话的 shell 图标和名字，所以候选一挂载就拉，不用等到点开菜单
  useEffect(() => {
    listShells()
      .then(setShellOptions)
      .catch(() => setShellOptions([{ id: "", label: "自动", name: "终端", kind: "shell" }]));
  }, []);

  /** 会话实际归属的 shell id：创建时选过就用选的，否则跟随设置里的默认 */
  const shellKeyOf = (id: number) => shellByIdRef.current.get(id) ?? settings.terminalShell;

  /** 会话在标签栏要显示的 shell（名字 / 图标 / 全名）；列表还没拉回来就回落到首项 */
  const shellForSession = (id: number) => {
    const key = shellKeyOf(id);
    return shellOptions.find((item) => item.id === key) ?? shellOptions[0];
  };

  /**
   * 给一个普通 shell 会话排固定序号。分配过的直接跳过——这样初始化那个 effect
   * 在 StrictMode 下跑两遍也只算一次，计数不会被多扣。
   */
  const assignShellSeq = (id: number) => {
    if (shellSeqByIdRef.current.has(id)) return;
    const key = shellKeyOf(id);
    const seq = (shellCountRef.current.get(key) ?? 0) + 1;
    shellCountRef.current.set(key, seq);
    shellSeqByIdRef.current.set(id, seq);
  };

  // 初始会话（sessions 的 [0]）不走 addSession，序号在这儿补。它必然是第一个，
  // 序号 1 不显示后缀，所以补分配不需要触发重渲染。上面已分配的直接跳过
  useEffect(() => {
    for (const id of sessions) {
      if (customTitleByIdRef.current.has(id)) continue;
      assignShellSeq(id);
    }
  }, [sessions]);

  const attachHandle = useCallback(
    (id: number) => (handle: TerminalSessionHandle | null) => {
      if (handle) handlesRef.current.set(id, handle);
      else handlesRef.current.delete(id);
    },
    [],
  );

  // shell 不传 = 用设置里的默认；传空串 = 明确点的是「自动」（后端自己挑）。
  // 两者必须分开：用户在菜单里点「自动」时不该被设置里的具体 shell 顶掉。
  /**
   * 新开一个会话。`cwd` 是 shell 落点，不传就落在工作区根（绝大多数情况）。
   * 工作树里的终端传它自己的目录，归属根仍然是 root——后端按 root 收进程。
   */
  const addSession = (shell?: string, cwd?: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    if (shell !== undefined) shellByIdRef.current.set(id, shell);
    if (cwd) cwdByIdRef.current.set(id, cwd);
    assignShellSeq(id);
    setSessions((list) => [...list, id]);
    setActiveId(id);
  };

  /**
   * 切到并列布局。只有一个会话时先补一个再切——不然「左右/上下并列」摆出来只有一栏，
   * 和单终端没有区别，用户还得自己去点「+」。
   */
  const setSplitLayout = (next: "horizontal" | "vertical") => {
    if (sessions.length === 1) addSession();
    setLayout(next);
  };

  const openCreateMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    setCreateMenuPos({
      left: Math.min(rect.right - 236, window.innerWidth - 240),
      top: rect.bottom + 4,
    });
    setCreateMenuOpen(true);
  };

  const closeSession = (id: number) => {
    // 标签没了，它的「在等用户」标记也一并撤掉（TerminalSession 的 cleanup 也会撤，双保险）
    clearAttention(terminalTarget(id));
    // 关掉最后一个就换一个新的顶上，终端区不留空白
    if (sessions.length === 1) {
      const fresh = nextIdRef.current;
      nextIdRef.current += 1;
      assignShellSeq(fresh);
      setSessions([fresh]);
      setActiveId(fresh);
      return;
    }

    const index = sessions.indexOf(id);
    const rest = sessions.filter((item) => item !== id);
    setSessions(rest);
    // 关掉的是当前会话时，焦点落到它右边那个（没有就往左退一格）
    if (activeId === id) {
      setActiveId(rest[Math.min(index, rest.length - 1)]);
    }
  };

  /**
   * 新开标签跑一条命令。命令不在这儿写——新会话的 PTY 还在异步 spawn，
   * 现在写必然被丢掉。交给 initialCommand，由 TerminalSession 在 shell
   * 就绪后自己敲。
   *
   * 一律新开标签，不写进当前活动会话：那儿可能正跑着别的东西（shell、别的 AI CLI），
   * 命令会被当成它的输入。
   */
  const runInNewSession = useCallback((command: string, title: string) => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    // 标题与提示创建时就定死，之后不随别的标签增删改动
    customTitleByIdRef.current.set(id, title);
    // 顶栏匹配用原始命令；实际敲进去的命令带上工作区的附加目录
    hintByIdRef.current.set(id, command);
    const prepared = prepareLaunch(command, additionalRootsRef.current);
    launchCommandByIdRef.current.set(id, prepared.command);
    // 用户在「设置 → 智能体」里给这家 CLI 配的环境变量 + 启动时自动注入的权限配置。
    // 自动注入的放后面：工作区边界的权限不能被用户配置盖掉。
    const env = {
      ...agentEnvFor(aiCommandsRef.current, command),
      ...prepared.env,
    };
    if (Object.keys(env).length > 0) {
      launchEnvByIdRef.current.set(id, env);
    }
    setLaunchFor({ id, command: prepared.command });
    setSessions((list) => [...list, id]);
    setActiveId(id);
  }, []);

  // 编辑器浮窗送来的位置引用：终端只认文本，在这儿拼成「路径:起[-止]」再写进活动会话。
  // 末尾补一个空格，和用户接着敲的内容隔开。不带 \r——左侧终端常跑着 AI CLI，
  // 写完让它读文件，什么时候回车由用户决定
  const insertToTerminal = useCallback(
    (location: EditorLocation) => {
      const handle = handlesRef.current.get(activeId);
      handle?.write(`${formatLocation(location)} `);
      handle?.focus();
    },
    [activeId],
  );

  // 侧栏点了「在等用户」提示：选中那个标签并聚焦它。标签可能已经被关掉了，那就不动
  const focusSession = useCallback(
    (id: number) => {
      if (!sessions.includes(id)) return;
      setLayout("tabs");
      setActiveId(id);
      const handle = handlesRef.current.get(id);
      // 「切过去即已读」：要切的标签本来就是当前这个时 setActiveId 是空操作，
      // 不会有 active 变化，没法靠会话自己的 effect 清掉 done 标记，直接走 handle
      handle?.markSeen();
      handle?.focus();
    },
    [sessions],
  );

  /**
   * 变更雷达的「去看」：cwd 相同的标签已经开着就切过去，否则新开一个。
   * 只看 cwd，不看跑的是什么——用户要的是「那棵树上现在有终端」，不关心是哪个 CLI。
   */
  const focusOrOpenAt = useCallback(
    (cwd: string) => {
      const key = pathKey(cwd);
      const existing = sessions.find(
        (id) => pathKey(cwdByIdRef.current.get(id) ?? root) === key,
      );
      if (existing !== undefined) {
        setLayout("tabs");
        setActiveId(existing);
        handlesRef.current.get(existing)?.focus();
        return;
      }
      addSession(undefined, cwd);
    },
    [sessions, root],
  );

  useImperativeHandle(
    ref,
    () => ({
      runInNewSession,
      selectAgent: (command, title, mode) => selectAgentRef.current(command, title, mode),
      selectAcpChat: (command, chatId) => {
        setChatCommand(command);
        acpChatRef.current?.selectChat(command, chatId);
      },
      createAcpChat: (command) => {
        const chatId = acpChatRef.current?.createChat(command) ?? null;
        if (chatId) setChatCommand(command);
        return chatId;
      },
      closeAcpChat: (command, chatId) => acpChatRef.current?.closeChat(command, chatId),
      insertToTerminal,
      focusSession,
      focusOrOpenAt,
      newSession: (shell) => addSession(shell),
      openCreateMenu,
      closeSession,
      restartSession: (id) => {
        setActiveId(id);
        handlesRef.current.get(id)?.restart();
      },
    }),
    [runInNewSession, insertToTerminal, focusSession, focusOrOpenAt, closeSession],
  );

  // 把会话归属上报给上层：变更雷达要按 cwd 把「在跑 / 在等你」落到具体工作树上。
  // attention 存在全局 store 里、按 terminalTarget(id) 索引，这里翻译成 cwd + 状态
  useEffect(() => {
    if (!onSessionsReport) return;
    onSessionsReport(
      sessions.map((id) => ({
        id,
        cwd: cwdByIdRef.current.get(id) ?? root,
        attention: attention[terminalTarget(id)] ?? null,
      })),
    );
  }, [sessions, attention, root, onSessionsReport]);

  useEffect(() => {
    onTaskTabsChange(
      sessions.map((id, index) => {
        const shell = shellForSession(id);
        const custom = customTitleByIdRef.current.get(id);
        const seq = shellSeqByIdRef.current.get(id) ?? 1;
        const shellName = shell?.name ?? `终端 ${index + 1}`;
        return {
          id,
          label: custom ?? (seq > 1 ? `${shellName} ${seq}` : shellName),
          attention: attention[terminalTarget(id)] ?? null,
          agent: hintByIdRef.current.get(id)
            ? { name: custom ?? hintByIdRef.current.get(id)!, command: hintByIdRef.current.get(id)! }
            : null,
          shellKind: shell?.kind ?? "shell",
        };
      }),
      activeId,
    );
  }, [activeId, attention, onTaskTabsChange, sessions, settings.terminalShell, shellOptions, titleRevision]);

  /** 配过的 AI CLI（空命令是加了还没填的，不进顶栏） */
  const aiCommands = useMemo(
    () =>
      settings.aiCommands
        .map((item) => ({
          ...item,
          name: item.name.trim() || "未命名 AI CLI",
          command: item.command.trim(),
        }))
        .filter((item) => item.command),
    [settings.aiCommands],
  );

  /** 顶栏里真正能进对话面板的 CLI：命令能被认出来，且后端接了 ACP */
  const acpCommands = useMemo<AcpCliOption[]>(
    () =>
      aiCommands.flatMap((item) => {
        const key = acpProviderKey(item.command, item.name);
        if (!key) return [];
        const env = item.env
          .map((entry) => ({ key: entry.key.trim(), value: entry.value }))
          .filter((entry) => entry.key !== "");
        return [{ key, label: item.name, command: item.command, env }];
      }),
    [aiCommands],
  );
  const chatCli = useMemo(
    () => acpCommands.find((item) => item.command === chatCommand) ?? acpCommands[0] ?? null,
    [acpCommands, chatCommand],
  );

  useEffect(() => {
    if (view !== "chat") return;
    if (selectedAcpChat && acpCommands.some((option) => option.command === selectedAcpChat.command)) {
      setChatCommand(selectedAcpChat.command);
      return;
    }
    const active = hintByIdRef.current.get(activeId);
    if (acpCommands.some((option) => option.command === active)) {
      setChatCommand(active ?? null);
    } else if (acpCommands[0]) {
      setChatCommand((current) => current ?? acpCommands[0].command);
    }
  }, [activeId, acpCommands, selectedAcpChat, view]);

  /**
   * 顶栏点某个 AI CLI。
   *
   * opencode 这类自带多标签页的 CLI 已经有标签就切过去——它自己就能在 TUI 里开多个会话，
   * 再叠一个终端标签只是多一份重复的界面。有多个（历史遗留 / resume 开的）时取最近创建的。
   * 其余 CLI 仍然每次新开，允许同一 CLI 同时运行多个实例。
   *
   * 对话视图下同一排按钮改成切换「跟哪家聊」，不新开终端。
   */
  const launchCli = useCallback(
    (command: string, title: string) => {
      if (hasInternalTabs(command)) {
        let existing: number | undefined;
        for (const id of sessions) {
          if (!hasInternalTabs(hintByIdRef.current.get(id) ?? "")) continue;
          if (existing === undefined || id > existing) existing = id;
        }
        if (existing !== undefined) {
          setActiveId(existing);
          const handle = handlesRef.current.get(existing);
          // 当前就在这个标签时 setActiveId 是空操作，清「已完成」标记得直接走 handle
          handle?.markSeen();
          handle?.focus();
          return;
        }
      }
      runInNewSession(command, title);
    },
    [runInNewSession, sessions],
  );

  selectAgentRef.current = (command, title, mode) => {
    if (mode === "chat") {
      if (acpCommands.some((option) => option.command === command)) setChatCommand(command);
      return;
    }
    launchCli(command, title);
  };

  // 整块不铺底色：终端自己画（跟着界面透明度走），这里再铺一层就叠成两层 alpha，
  // 半透明时看着比侧栏实一大截。需要底色的只有顶栏和标签栏这两条
  return (
    <section className="flex h-full min-h-0 flex-col">
      {toolbarTarget && createPortal(
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label="单终端" active={layout === "tabs"} onClick={() => setLayout("tabs")}>
            <IconLayoutSingle className={ICON_SM} />
          </IconButton>
          <IconButton
            label="左右并列"
            active={layout === "horizontal"}
            onClick={() => setSplitLayout("horizontal")}
          >
            <IconLayoutColumns className={ICON_SM} />
          </IconButton>
          <IconButton
            label="上下并列"
            active={layout === "vertical"}
            onClick={() => setSplitLayout("vertical")}
          >
            <IconLayoutRows className={ICON_SM} />
          </IconButton>
        </div>,
        toolbarTarget,
      )}
      {/* 终端会话始终挂载；切到 ACP 对话时只隐藏终端，PTY 和滚动历史都保留 */}
      <div className={view === "chat" ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        {/* 容器元素始终是同一种标签，只换 className：切布局时各会话的包裹层按 key 复用，
            不重建 TerminalSession（重建会杀掉 shell） */}
        <div
          ref={splitRef}
          className={
            layout === "tabs"
              ? "relative min-h-0 flex-1"
              : `flex min-h-0 flex-1 ${layout === "horizontal" ? "flex-row" : "flex-col"}`
          }
        >
          {sessions.flatMap((id, index) => {
            const cell = (
              <div
                key={id}
                className={
                  layout === "tabs"
                    ? id === activeId
                      ? "absolute inset-0"
                      : "hidden"
                    : "relative min-h-0 min-w-0 overflow-hidden"
                }
                // 并列模式按拖出来的比例分配：basis 0 + grow 之比 = 尺寸之比
                style={
                  layout === "tabs"
                    ? undefined
                    : { flexBasis: 0, flexGrow: paneSizes[index] ?? 1, flexShrink: 1 }
                }
                onMouseDown={() => setActiveId(id)}
              >
                <TerminalSession
                  ref={attachHandle(id)}
                  root={root}
                  roots={roots}
                  cwd={cwdByIdRef.current.get(id)}
                  onOpenFile={onOpenFile}
                  // undefined = 跟随设置里的默认；只有在下拉里明确选过 shell 的会话才有值
                  shell={shellByIdRef.current.get(id)}
                  // Ctrl/Cmd+W 关的是「当前这个」标签；只剩一个时会换新会话顶上，
                  // 和标签上的关闭按钮同一套语义
                  onRequestClose={() => closeSession(id)}
                  // Ctrl/Cmd+T 新建一个标签，和标签栏那个「+」同一个动作（默认 shell）
                  onRequestNew={() => addSession()}
                  // 只有从历史里 resume 出来的那个新会话带命令，其余一律 undefined
                  initialCommand={launchFor?.id === id ? launchFor.command : undefined}
                  onTitleChange={
                    ["codex", "opencode"].includes(cliKey(hintByIdRef.current.get(id) ?? ""))
                      ? (terminalTitle) => {
                          const provider = cliKey(hintByIdRef.current.get(id) ?? "");
                          // Codex 默认 OSC 标题按“活动 | thread name | project”组合，
                          // 只取首段并剥掉活动 spinner，避免标签跟着动画每秒闪动。
                          const firstPart = terminalTitle.split(" | ", 1)[0]?.trim() ?? "";
                          const name =
                            provider === "opencode"
                              ? terminalTitle.match(/^OC\s\|\s*(.+)$/u)?.[1]?.trim() ?? ""
                              : firstPart
                                  .replace(/^[\u2800-\u28ff]\s*/u, "")
                                  .replace(/\s+/g, " ")
                                  .trim();
                          if (!name || name === customTitleByIdRef.current.get(id)) return;
                          customTitleByIdRef.current.set(id, Array.from(name).slice(0, 60).join(""));
                          setTitleRevision((revision) => revision + 1);
                        }
                      : undefined
                  }
                  // opencode 这类把附加目录放在环境变量里的 CLI，启动 shell 时一起设进去
                  initialEnv={launchEnvByIdRef.current.get(id)}
                  // 启发式判出「在等用户」（等回应 / 任务完成）时上抛，写进全局 store
                  onAttentionChange={(next) => {
                    const target = terminalTarget(id);
                    if (next) setAttention(target, next);
                    else clearAttention(target);
                  }}
                  // 这个会话有真实使用（用户输入 / 已在跑命令的输出）时上报工作区活动
                  onActivity={() => touchActivity(root)}
                  // 并列模式显示全部会话；标签模式只显示当前会话。active 仍只负责焦点和补尺寸。
                  visible={visible && (layout !== "tabs" || id === activeId)}
                  active={visible && id === activeId}
                />
              </div>
            );
            // 第一个 pane 前面没有分隔条；其余每个前面插一条，拖动改它和左边/上面那个的比例
            if (layout === "tabs" || index === 0) return [cell];
            return [
              <div
                key={`sep-${id}`}
                role="separator"
                aria-orientation={layout === "horizontal" ? "vertical" : "horizontal"}
                aria-label="拖动调整终端大小"
                onPointerDown={(event) => onHandleDown(index - 1, event)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                className={`relative z-10 shrink-0 bg-line-strong transition-colors hover:bg-line-hover ${
                  layout === "horizontal"
                    ? "w-px cursor-col-resize"
                    : "h-px cursor-row-resize"
                }`}
              >
                {/* 加宽命中区，视觉上仍是一条细线 */}
                <span
                  className={
                    layout === "horizontal"
                      ? "absolute inset-y-0 -left-1 -right-1"
                      : "absolute inset-x-0 -top-1 -bottom-1"
                  }
                />
              </div>,
              cell,
            ];
          })}
        </div>
      </div>

      {/* 对话面板始终挂载：切回终端只是 hidden，ACP 会话和消息都留着 */}
      <div className={view === "chat" ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
        <AcpChatPane
          ref={acpChatRef}
          root={root}
          roots={roots}
          cli={chatCli}
          agents={acpCommands}
          selectedChat={selectedAcpChat}
          onChatsChange={onAcpChatsChange}
        />
      </div>

      {/* 新建终端旁的下拉。用 fixed 定位：标签栏是横向滚动容器，
          绝对定位的菜单会被 overflow 裁掉。终端面板隐藏时也需要能从超级 Tab 打开，
          因此菜单 portal 到 body，不受面板的 hidden 状态影响 */}
      {createMenuOpen && createMenuPos && createPortal(
        <>
          {/* 铺一层透明遮罩接住外部点击 */}
          <div className="fixed inset-0 z-30" onClick={() => setCreateMenuOpen(false)} />
          <div
            className="fixed z-40 flex flex-col rounded border border-line-strong bg-raised py-1 shadow-lg"
            style={{
              width: 236,
              // 贴到窗口右边就往回收，别把菜单顶出可视区
              left: Math.min(createMenuPos.left, window.innerWidth - 240),
              top: createMenuPos.top,
            }}
          >
            <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-faint">终端</div>
            {shellOptions.map((item) => (
              <button
                key={item.id}
                type="button"
                title={item.label}
                onClick={() => {
                  setCreateMenuOpen(false);
                  addSession(item.id);
                  onSelectView("terminal");
                }}
                className={SHELL_MENU_ITEM}
              >
                <ShellIcon kind={item.kind} className="h-4 w-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            ))}
            {aiCommands.length > 0 && <div className="mx-2 my-1 border-t border-line" />}
            {aiCommands.length > 0 && <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-faint">智能体</div>}
            {aiCommands.map((item, index) => {
              const chatOption = acpCommands.some((option) => option.command === item.command);
              return (
                <div key={`${item.name}-${item.command}-${index}`} className="flex items-center gap-1 px-2">
                  <AgentLogo name={item.name} command={item.command} className="ml-1 h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate px-1 text-[12px] text-fg-muted">{item.name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      launchCli(item.command, item.name);
                      onSelectView("terminal");
                    }}
                    title={`${item.name}（终端）`}
                    className="rounded px-2 py-1 text-[11px] text-fg-dim hover:bg-hover hover:text-fg"
                  >终端</button>
                  <button
                    type="button"
                    disabled={!chatOption}
                    onClick={() => {
                      setCreateMenuOpen(false);
                      if (!chatOption) return;
                      const chatId = acpChatRef.current?.createChat(item.command);
                      if (chatId) {
                        setChatCommand(item.command);
                        onSelectAcpChat(item.command, chatId);
                      }
                    }}
                    title={chatOption ? `${item.name}（ACP 对话）` : `${item.name} 尚未接入 ACP 对话`}
                    className={`rounded px-2 py-1 text-[11px] ${chatOption ? "text-fg-dim hover:bg-hover hover:text-fg" : "cursor-not-allowed text-fg-faint opacity-40"}`}
                  >ACP</button>
                </div>
              );
            })}
          </div>
        </>,
        document.body,
      )}

      {/* 标签右键菜单。标签栏横向滚动，绝对定位会被裁掉，所以和上面的 shell 菜单一样用 fixed */}

    </section>
  );
}

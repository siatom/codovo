import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { IconArrowDownToLine } from "./icons";

/** 距底部不超过这个像素就算「贴近底部」，继续自动跟随 */
const BOTTOM_THRESHOLD = 24;

/**
 * 对话流「贴底跟随」：贴底时新内容自动滚到底；用户上滚后暂停并露出「回到底部」按钮，
 * 滚回底部（或点按钮）再恢复跟随。终端区智能体与数据库智能体共用这一份。
 *
 * 是否贴底按**几何距离**判定，而不是记「这次滚动是谁触发的」——程序自身只会滚到底，
 * 滚到底时距离为 0，天然不会被误判成用户上滚。
 *
 * `signal` 是「内容变了」的哨兵（传 conversation），它变一次就尝试贴一次底。
 */
export function useStickToBottom(signal: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  /** 自动跟随开关。放 ref 里给 layout effect 读，免得拿到渲染期的旧值 */
  const stickRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  // 用 layout effect：新内容一提交就贴底。等浏览器派发滚动事件时位置已经是底部，
  // 内容长高那一帧的滚动事件就不会因距离短暂变大而误停跟随
  useLayoutEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [signal, scrollToBottom]);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const near = distance <= BOTTOM_THRESHOLD;
    stickRef.current = near;
    // 值没变就直接返回，React 会跳过重渲染；滚动很频繁，别每帧都 set
    setAtBottom((current) => (current === near ? current : near));
  }, []);

  /** 点「回到底部」：立刻贴底并恢复跟随（随后的滚动事件会再确认一次） */
  const jumpToBottom = useCallback(() => {
    scrollToBottom();
    stickRef.current = true;
    setAtBottom(true);
  }, [scrollToBottom]);

  /** 整段对话被换掉（切会话 / 新对话）时复位，别把上一条对话的「已上滚」带过去 */
  const reset = useCallback(() => {
    stickRef.current = true;
    setAtBottom(true);
  }, []);

  return { ref, atBottom, onScroll, jumpToBottom, reset };
}

/** 悬在对话流右下角的「回到底部」按钮，和终端那边同款观感 */
export function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      title="回到最新消息"
      aria-label="回到最新消息"
      onClick={onClick}
      className="absolute right-3 bottom-3 z-10 flex h-7 w-7 items-center justify-center rounded-md border border-line-strong bg-surface text-fg-dim shadow-lg hover:bg-hover hover:text-fg"
    >
      <IconArrowDownToLine className="h-4 w-4" />
    </button>
  );
}

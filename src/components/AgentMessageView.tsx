import type { AgentMessage, AgentPart } from "../lib/types";
import { useHighlightedMarkdown } from "../lib/highlight";
import { AgentToolCard } from "./AgentToolCard";
import { IconBot } from "./icons";

function TextPartView({ text, streaming }: { text: string; streaming: boolean }) {
  // 流式期间不跑 markdown：每个增量都过一遍 marked + DOMPurify 太浪费，
  // 而且半截的 ``` 会把整段渲染成代码块、来回跳。等这一轮结束再上排版。
  // 代码高亮是异步的（Monaco 语言包懒加载），所以先给一版没上色的，算好之后它自己换上。
  // 字号和行高都要跟下面的 .agent-text 对齐，否则这一轮跑完切 markdown 时会跳一下
  const html = useHighlightedMarkdown(text, !streaming);
  if (streaming) {
    return <div className="text-[14px] leading-[1.75] whitespace-pre-wrap">{text}</div>;
  }
  return (
    <div
      className="markdown-body agent-text text-[14px]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ReasoningPartView({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="my-2 rounded-lg bg-raised px-2.5 py-1.5 text-[12px] leading-relaxed text-fg-faint">
      <span className="mr-1.5 text-[10px] font-medium text-fg-dim">
        {streaming ? "思考中…" : "思考过程"}
      </span>
      <span className="whitespace-pre-wrap">{text}</span>
    </div>
  );
}

function PartView({ part, streaming }: { part: AgentPart; streaming: boolean }) {
  switch (part.type) {
    case "text":
      return <TextPartView text={part.text} streaming={streaming} />;
    case "reasoning":
      return <ReasoningPartView text={part.text} streaming={streaming} />;
    case "tool":
      return <AgentToolCard part={part} />;
    default:
      // 认不出的 part 类型直接不渲染：宁可少显示，也别把原始 JSON 糊到对话里
      return null;
  }
}

export function AgentMessageView({
  message,
  streaming,
}: {
  message: AgentMessage;
  streaming: boolean;
}) {
  if (message.role === "user") {
    return (
      <div className="my-4 flex justify-end">
        {/* 用 selected 而不是中性的 active：气泡带一点色相，和助手的裸文本拉开区分 */}
        <div className="max-w-[85%] rounded-2xl bg-selected px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap text-fg">
          {message.parts.map((part) => (part.type === "text" ? part.text : "")).join("")}
        </div>
      </div>
    );
  }

  return (
    <div className="my-4 text-fg">
      {/* 每条助手轮次都挂一次头像和名字，来回翻记录时能一眼分清谁说的 */}
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-raised text-fg-dim">
          <IconBot className="h-3.5 w-3.5" />
        </span>
        <span className="text-[12px] font-semibold text-fg-muted">智能体</span>
      </div>
      {message.parts.map((part) => (
        <PartView key={part.id} part={part} streaming={streaming} />
      ))}
    </div>
  );
}

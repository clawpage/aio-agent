import type { AgentEvent } from "./types";

export type Block =
  | { kind: "user"; id: string; text: string; attachments: Array<{ path: string; name?: string; kind?: string }> }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "reasoning"; id: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; toolType: string; title: string; detail: string; status: "running" | "done" | "error"; output: string }
  | { kind: "approval"; id: string; requestId: string; method: string; payload: Record<string, unknown>; status: "pending" | "resolved"; decision?: string }
  | { kind: "status"; id: string; text: string; level: "info" | "warn" | "error" };

export interface TimelineState {
  blocks: Block[];
  /** itemId -> index in blocks, for streaming updates. */
  index: Map<string, number>;
}

export function removeBlock(state: TimelineState, id: string): TimelineState {
  const idx = state.index.get(id);
  if (idx === undefined) return state;
  const blocks = state.blocks.filter((_, i) => i !== idx);
  const index = new Map<string, number>();
  blocks.forEach((b, i) => index.set(b.id, i));
  return { blocks, index };
}

export function emptyTimeline(): TimelineState {
  return { blocks: [], index: new Map() };
}

function push(state: TimelineState, block: Block): number {
  state.blocks.push(block);
  state.index.set(block.id, state.blocks.length - 1);
  return state.blocks.length - 1;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const TOOL_TITLES: Record<string, string> = {
  commandExecution: "执行命令",
  fileChange: "修改文件",
  mcpToolCall: "MCP 工具",
  webSearch: "联网检索",
  plan: "计划",
  reasoning: "思考",
};

function toolDetail(toolType: string, item: Record<string, unknown>): string {
  switch (toolType) {
    case "commandExecution":
      return [text(item.command), item.cwd ? `（cwd: ${text(item.cwd)}）` : ""].join("");
    case "fileChange":
      return Array.isArray(item.changes)
        ? (item.changes as Array<Record<string, unknown>>).map((c) => text(c.path) || text(c.kind)).join("、")
        : "文件变更";
    case "mcpToolCall":
      return `${text(item.server) || "mcp"} · ${text(item.tool) || ""}`;
    default:
      return text(item.title) || text(item.name) || toolType;
  }
}

function toolOutput(item: Record<string, unknown>): string {
  const candidates = ["aggregatedOutput", "output", "result", "text", "content"];
  for (const key of candidates) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object") return JSON.stringify(value, null, 2);
  }
  return "";
}

export function applyEvent(state: TimelineState, event: AgentEvent): void {
  const p = event.payload ?? {};
  switch (event.type) {
    case "local.pending": {
      // Optimistic echo of a message the client just sent. It is reconciled (or
      // rolled back) by clientMessageId once the server responds.
      const clientMessageId = text(p.clientMessageId);
      const attachments = Array.isArray(p.attachments) ? (p.attachments as Array<{ path: string }>) : [];
      push(state, { kind: "user", id: `user:pending:${clientMessageId}`, text: text(p.text), attachments });
      return;
    }
    case "turn.queued": {
      const attachments = Array.isArray(p.attachments) ? (p.attachments as Array<{ path: string }>) : [];
      const turnId = String(p.turnId ?? event.id);
      const clientMessageId = text(p.clientMessageId);
      // Reconcile the optimistic bubble with the authoritative server turn instead
      // of leaving a duplicate user message behind.
      const pendingId = clientMessageId ? `user:pending:${clientMessageId}` : null;
      const existingIdx = pendingId ? state.index.get(pendingId) : undefined;
      if (existingIdx !== undefined && state.blocks[existingIdx]?.kind === "user") {
        const block = state.blocks[existingIdx] as Extract<Block, { kind: "user" }>;
        const finalId = `user:${turnId}`;
        state.index.delete(pendingId as string);
        block.id = finalId;
        block.text = text(p.text) || block.text;
        if (attachments.length) block.attachments = attachments;
        state.index.set(finalId, existingIdx);
        return;
      }
      if (state.index.has(`user:${turnId}`)) return;
      push(state, { kind: "user", id: `user:${turnId}`, text: text(p.text), attachments });
      return;
    }
    case "item/started": {
      const item = (p.item ?? {}) as Record<string, unknown>;
      const type = text(item.type) || "item";
      const id = `item:${text(item.id) || String(event.id)}`;
      if (type === "agentMessage") {
        if (!state.index.has(id)) push(state, { kind: "assistant", id, text: "", streaming: true });
        return;
      }
      if (type === "reasoning") {
        if (!state.index.has(id)) push(state, { kind: "reasoning", id, text: "", streaming: true });
        return;
      }
      if (type === "userMessage") return;
      push(state, {
        kind: "tool",
        id,
        toolType: type,
        title: TOOL_TITLES[type] ?? type,
        detail: toolDetail(type, item),
        status: "running",
        output: "",
      });
      return;
    }
    case "item/completed": {
      const item = (p.item ?? {}) as Record<string, unknown>;
      const id = `item:${text(item.id) || String(event.id)}`;
      const existing = state.index.get(id);
      const type = text(item.type) || "item";
      if (type === "agentMessage") {
        if (existing === undefined) {
          push(state, { kind: "assistant", id, text: text(item.text), streaming: false });
        } else {
          const block = state.blocks[existing] as Extract<Block, { kind: "assistant" }>;
          block.text = text(item.text) || block.text;
          block.streaming = false;
        }
        return;
      }
      if (type === "reasoning") {
        if (existing !== undefined) {
          const block = state.blocks[existing] as Extract<Block, { kind: "reasoning" }>;
          block.text = text(item.summary) || text(item.text) || block.text;
          block.streaming = false;
        }
        return;
      }
      if (type === "userMessage") return;
      const output = toolOutput(item);
      const failed = text(item.status) === "failed" || text(item.status) === "error";
      if (existing === undefined) {
        push(state, {
          kind: "tool",
          id,
          toolType: type,
          title: TOOL_TITLES[type] ?? type,
          detail: toolDetail(type, item),
          status: failed ? "error" : "done",
          output,
        });
      } else {
        const block = state.blocks[existing] as Extract<Block, { kind: "tool" }>;
        block.status = failed ? "error" : "done";
        if (output) block.output = output;
        const detail = toolDetail(type, item);
        if (detail) block.detail = detail;
      }
      return;
    }
    case "stream.delta": {
      const itemId = text(p.itemId) || "stream";
      const kind = text(p.kind);
      const delta = text(p.delta);
      if (!delta) return;
      const isReasoning = kind.includes("reasoning");
      const id = `item:${itemId}`;
      let idx = state.index.get(id);
      if (idx === undefined) {
        idx = push(
          state,
          isReasoning
            ? { kind: "reasoning", id, text: delta, streaming: true }
            : { kind: "assistant", id, text: delta, streaming: true },
        );
        return;
      }
      const block = state.blocks[idx]!;
      if (block.kind === "assistant" || block.kind === "reasoning") {
        block.text += delta;
        block.streaming = true;
      } else if (block.kind === "tool") {
        block.output += delta;
      }
      return;
    }
    case "item/agentMessage/delta": {
      const itemId = text(p.itemId) || "stream";
      const delta = text(p.delta);
      const id = `item:${itemId}`;
      const idx = state.index.get(id);
      if (idx === undefined) push(state, { kind: "assistant", id, text: delta, streaming: true });
      else {
        const block = state.blocks[idx] as Extract<Block, { kind: "assistant" }>;
        block.text += delta;
      }
      return;
    }
    case "item/commandExecution/outputDelta": {
      const itemId = text(p.itemId) || "stream";
      const delta = text(p.delta) || text(p.output);
      const idx = state.index.get(`item:${itemId}`);
      if (idx !== undefined) {
        const block = state.blocks[idx]!;
        if (block.kind === "tool") block.output += delta;
      }
      return;
    }
    case "approval.requested": {
      const requestId = text(p.requestId);
      push(state, {
        kind: "approval",
        id: `approval:${requestId}`,
        requestId,
        method: text(p.method),
        payload: (p.params ?? {}) as Record<string, unknown>,
        status: "pending",
      });
      return;
    }
    case "approval.resolved": {
      const requestId = text(p.requestId);
      const idx = state.index.get(`approval:${requestId}`);
      if (idx !== undefined) {
        const block = state.blocks[idx] as Extract<Block, { kind: "approval" }>;
        block.status = "resolved";
        block.decision = text(p.decision);
      }
      return;
    }
    case "turn.finished": {
      const status = text(p.status);
      const level = status === "completed" ? "info" : status === "unknown" ? "error" : "warn";
      const label =
        status === "completed" ? "本轮完成" : status === "interrupted" ? "已停止" : status === "unknown" ? "结果未知" : `结束：${status}`;
      push(state, { kind: "status", id: `finish:${String(p.turnId ?? event.id)}`, text: `${label}${text(p.message) ? ` · ${text(p.message)}` : ""}`, level });
      return;
    }
    case "turn.failed":
      push(state, { kind: "status", id: `fail:${String(p.turnId ?? event.id)}`, text: `执行失败：${text(p.message)}`, level: "error" });
      return;
    case "turn.cancelled":
      push(state, { kind: "status", id: `cancel:${String(p.turnId ?? event.id)}`, text: "已取消排队中的轮次", level: "warn" });
      return;
    case "turn.reconciled":
      push(state, {
        kind: "status",
        id: `reconciled:${String(p.turnId ?? event.id)}`,
        text: text(p.message) || "服务重启后状态已核对",
        level: text(p.status) === "unknown" ? "error" : "warn",
      });
      return;
    case "turn.interrupt_requested":
      push(state, { kind: "status", id: `stop:${event.id}`, text: "已请求停止…", level: "warn" });
      return;
    case "thread.started":
      push(state, { kind: "status", id: `thread:${String(p.threadId ?? event.id)}`, text: `已创建会话线程（模型 ${text(p.model)}）`, level: "info" });
      return;
    case "error":
      push(state, { kind: "status", id: `err:${event.id}`, text: `错误：${text(p.message) || JSON.stringify(p).slice(0, 300)}`, level: "error" });
      return;
    case "warning":
      push(state, { kind: "status", id: `warn:${event.id}`, text: `提示：${text(p.message) || JSON.stringify(p).slice(0, 200)}`, level: "warn" });
      return;
    default:
      return;
  }
}

export function buildTimeline(events: AgentEvent[], state: TimelineState = emptyTimeline()): TimelineState {
  for (const event of events) applyEvent(state, event);
  return state;
}

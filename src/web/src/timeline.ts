import type { AgentEvent } from "./types";

/** Lifecycle of one turn's collapsed "Working" group. */
export type WorkingStatus = "queued" | "running" | "stopping" | "done" | "error" | "stopped" | "unknown";

export interface UserBlock {
  kind: "user";
  id: string;
  text: string;
  attachments: Array<{ path: string; name?: string; kind?: string }>;
}

export interface AssistantBlock {
  kind: "assistant";
  id: string;
  text: string;
  streaming: boolean;
}

export interface ReasoningBlock {
  kind: "reasoning";
  id: string;
  /** Owning turn: the outer event turnId, never the remote Codex turn id. */
  turnId: string;
  text: string;
  streaming: boolean;
}

export interface ToolBlock {
  kind: "tool";
  id: string;
  turnId: string;
  toolType: string;
  title: string;
  detail: string;
  status: "running" | "done" | "error";
  output: string;
}

export interface ApprovalBlock {
  kind: "approval";
  id: string;
  requestId: string;
  method: string;
  payload: Record<string, unknown>;
  status: "pending" | "resolved";
  decision?: string;
}

export interface StatusBlock {
  kind: "status";
  id: string;
  text: string;
  level: "info" | "warn" | "error";
}

/**
 * One turn's collapsed activity: every tool call and reasoning summary of that
 * turn lives here. Normal user/assistant prose, approvals and status lines stay
 * top-level so nothing important is ever hidden behind a collapsed header.
 */
export interface WorkingBlock {
  kind: "working";
  id: string;
  turnId: string;
  status: WorkingStatus;
  children: Array<ToolBlock | ReasoningBlock>;
  /** True once any child tool failed, so the header can flag it even on success. */
  hasToolError: boolean;
}

export type Block = UserBlock | AssistantBlock | ReasoningBlock | ToolBlock | ApprovalBlock | StatusBlock | WorkingBlock;

export interface TimelineState {
  blocks: Block[];
  /** block id -> index in `blocks`, for top-level streaming updates. */
  index: Map<string, number>;
  /** turnId -> index in `blocks` of that turn's working group. */
  groupIndex: Map<string, number>;
  /** child block id -> owning turnId, so a child update finds its group. */
  groupOf: Map<string, string>;
  /** turnId -> latest lifecycle status, so a late group inherits a terminal one. */
  turnStatus: Map<string, WorkingStatus>;
  /**
   * assistant item ids that were seen as an empty `agentMessage` item and whose
   * block was dropped (never created) because it carried no text at all. A late
   * or duplicated `item/started` for such an id must not resurrect a blank
   * bubble. This is not a suppression list: any real prose (a non-empty delta or
   * completed text) clears the marker and builds the block again, so genuine
   * content is never swallowed.
   */
  blankAssistantItems: Set<string>;
  /** Most recent turn-scoped id, used to attribute events carrying no turnId. */
  currentTurnId: string | null;
}

const TERMINAL_STATUSES = new Set<WorkingStatus>(["done", "error", "stopped", "unknown"]);

const STATUS_RANK: Record<WorkingStatus, number> = {
  // `queued` is an un-proven state: a real lifecycle event later in the stream
  // always outranks it.
  queued: 0,
  running: 1,
  stopping: 2,
  done: 3,
  error: 3,
  stopped: 3,
  unknown: 3,
};

/** Header text for a group. `queued` never claims to be working. */
export function workingLabel(status: WorkingStatus): string {
  switch (status) {
    case "queued":
      return "已排队等待";
    case "running":
      return "Working…";
    case "stopping":
      return "正在停止…";
    case "done":
      return "已完成";
    case "error":
      return "执行出错";
    case "stopped":
      return "已停止";
    case "unknown":
      return "结果未知";
  }
}

/**
 * Whether a child row should present itself as still in progress. Once the turn
 * reached a terminal state, a tool that never received its `item/completed` (or a
 * summary that never got its final delta) must stop claiming to be "进行中": the
 * row keeps its real output, but the spinner/open styling is suppressed. The
 * child's own recorded status is never rewritten, so no success is faked.
 */
export function childInProgress(group: WorkingBlock, child: ToolBlock | ReasoningBlock): boolean {
  if (TERMINAL_STATUSES.has(group.status)) return false;
  return child.kind === "tool" ? child.status === "running" : child.streaming;
}

/** Only a genuinely in-flight turn animates; history and queued rows stay still. */
export function isWorkingActive(status: WorkingStatus): boolean {
  return status === "running" || status === "stopping";
}

export function removeBlock(state: TimelineState, id: string): TimelineState {
  const idx = state.index.get(id);
  if (idx === undefined) return state;
  const blocks = state.blocks.filter((_, i) => i !== idx);
  return reindex({ ...state, blocks });
}

/**
 * Drop one block in place, keeping `blocks` and both index maps exact. Used by
 * the reducers, which rewrite the state object they are given rather than
 * returning a new one.
 */
function removeBlockInPlace(state: TimelineState, id: string): boolean {
  const idx = state.index.get(id);
  if (idx === undefined) return false;
  state.blocks.splice(idx, 1);
  reindexInPlace(state);
  return true;
}

/**
 * Copy-on-write base for an incremental update. The reducers mutate in place, so
 * every block that a reducer can write to is copied here: each top-level block,
 * every working group, and each group's children (and the children array itself).
 * Only the payloads that are never mutated (attachments, approval params) are
 * shared. The index maps are copied for the same reason. A caller can therefore
 * apply events to the copy while the previously rendered state stays byte-for-byte
 * intact, which is what keeps React from re-applying a delta on the same object.
 */
export function cloneTimeline(state: TimelineState): TimelineState {
  return {
    blocks: state.blocks.map((b) =>
      b.kind === "working" ? { ...b, children: b.children.map((c) => ({ ...c })) } : { ...b },
    ),
    index: new Map(state.index),
    groupIndex: new Map(state.groupIndex),
    groupOf: new Map(state.groupOf),
    turnStatus: new Map(state.turnStatus),
    blankAssistantItems: new Set(state.blankAssistantItems),
    currentTurnId: state.currentTurnId,
  };
}

export function emptyTimeline(): TimelineState {
  return {
    blocks: [],
    index: new Map(),
    groupIndex: new Map(),
    groupOf: new Map(),
    turnStatus: new Map(),
    blankAssistantItems: new Set(),
    currentTurnId: null,
  };
}

/** Rebuild both index maps from `blocks`, writing them into `state`. */
function reindexInPlace(state: TimelineState): void {
  const index = new Map<string, number>();
  const groupIndex = new Map<string, number>();
  state.blocks.forEach((b, i) => {
    index.set(b.id, i);
    if (b.kind === "working") groupIndex.set(b.turnId, i);
  });
  state.index = index;
  state.groupIndex = groupIndex;
}

function reindex(state: TimelineState): TimelineState {
  reindexInPlace(state);
  return state;
}

/**
 * Drop a working group that no longer holds any child, keeping the maps exact.
 * A group that is still in flight is kept even while empty: the turn is real from
 * the moment it starts, so an activity row must not blink out and back in before
 * its first tool or summary arrives. Only a settled group with nothing to show is
 * dropped (for example a legacy blank summary with no turn lifecycle at all).
 */
function removeGroupIfEmpty(state: TimelineState, group: WorkingBlock): void {
  if (group.children.length > 0) return;
  if (isWorkingActive(group.status)) return;
  const idx = state.blocks.indexOf(group);
  if (idx === -1) return;
  state.blocks.splice(idx, 1);
  reindexInPlace(state);
}

function push(state: TimelineState, block: Block): number {
  state.blocks.push(block);
  state.index.set(block.id, state.blocks.length - 1);
  if (block.kind === "working") state.groupIndex.set(block.turnId, state.blocks.length - 1);
  return state.blocks.length - 1;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Codex reasoning items carry `summary` (model-generated) and `content` (raw
 * chain-of-thought) as string arrays. Only the summary is ever surfaced; a raw
 * `content` array is never rendered or fabricated.
 */
function reasoningSummaryText(item: Record<string, unknown>): string {
  const summary = item.summary;
  if (Array.isArray(summary)) {
    return summary
      .filter((part): part is string => typeof part === "string")
      .join("\n\n")
      .trim();
  }
  return text(summary).trim();
}

/**
 * The only reasoning-family delta kinds that may surface as a reasoning row.
 * These are model-generated summaries. Any other reasoning delta (notably raw
 * `item/reasoning/textDelta` chain-of-thought) is dropped before it can create
 * or extend a block.
 */
const REASONING_SUMMARY_DELTA_KINDS = new Set([
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
]);

/**
 * The server buffers every tool-output stream method and re-emits it as a
 * `stream.delta` carrying the original method in `kind`. These deltas extend the
 * owning tool card's output; they must never be mistaken for assistant prose.
 */
const TOOL_OUTPUT_DELTA_KINDS = new Set([
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "command/exec/outputDelta",
  "process/outputDelta",
  "item/mcpToolCall/progress",
]);

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

/**
 * The turn a block belongs to. The outer event turnId (this server's turn id)
 * always wins; the payload's `turnId` is the remote Codex turn id and is only a
 * fallback for legacy events. Events with neither attach to the most recent
 * turn seen in this conversation, and finally to a stable `untracked` bucket.
 */
function resolveTurnId(state: TimelineState, event: AgentEvent): string {
  if (event.turnId) return event.turnId;
  const payloadTurnId = text((event.payload ?? {}).turnId);
  if (payloadTurnId) return payloadTurnId;
  return state.currentTurnId ?? "untracked";
}

function setTurnStatus(state: TimelineState, turnId: string, status: WorkingStatus): void {
  const previous = state.turnStatus.get(turnId);
  if (previous && TERMINAL_STATUSES.has(previous) && !TERMINAL_STATUSES.has(status)) return;
  if (previous && STATUS_RANK[status] < STATUS_RANK[previous]) return;
  state.turnStatus.set(turnId, status);
  const idx = state.groupIndex.get(turnId);
  if (idx === undefined) return;
  const group = state.blocks[idx];
  if (group?.kind === "working") group.status = status;
}

/** Find (or lazily create) the working group for a turn. */
function workingGroupFor(state: TimelineState, turnId: string): WorkingBlock {
  const idx = state.groupIndex.get(turnId);
  if (idx !== undefined) {
    const group = state.blocks[idx];
    if (group?.kind === "working") return group;
  }
  const group: WorkingBlock = {
    kind: "working",
    id: `working:${turnId}`,
    turnId,
    // A group created after its turn already ended inherits that terminal status;
    // a group with no observed lifecycle at all (legacy events, partial history)
    // is shown as an unknown static record instead of animating forever or
    // claiming a success that was never observed.
    status: state.turnStatus.get(turnId) ?? "unknown",
    children: [],
    hasToolError: false,
  };
  push(state, group);
  return group;
}

function findChild(state: TimelineState, id: string): { group: WorkingBlock; child: ToolBlock | ReasoningBlock } | null {
  const turnId = state.groupOf.get(id);
  if (turnId === undefined) return null;
  const groupIdx = state.groupIndex.get(turnId);
  if (groupIdx === undefined) return null;
  const group = state.blocks[groupIdx];
  if (group?.kind !== "working") return null;
  const child = group.children.find((c) => c.id === id);
  return child ? { group, child } : null;
}

/** The tool block with this id, whether it lives in a group or (legacy) top level. */
function findToolBlock(state: TimelineState, id: string): ToolBlock | null {
  const found = findChild(state, id);
  if (found && found.child.kind === "tool") return found.child;
  const idx = state.index.get(id);
  if (idx === undefined) return null;
  const block = state.blocks[idx];
  return block?.kind === "tool" ? block : null;
}

function addTool(state: TimelineState, turnId: string, block: Omit<ToolBlock, "turnId">): void {
  const group = workingGroupFor(state, turnId);
  group.children.push({ ...block, turnId });
  state.groupOf.set(block.id, turnId);
  if (block.status === "error") group.hasToolError = true;
}

function addReasoning(state: TimelineState, turnId: string, block: Omit<ReasoningBlock, "turnId">): void {
  const group = workingGroupFor(state, turnId);
  group.children.push({ ...block, turnId });
  state.groupOf.set(block.id, turnId);
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
      // Every lifecycle branch resolves the turn id the same way: the outer
      // event turnId (this server's turn id) wins, and the payload's turnId is a
      // legacy fallback for rows persisted before that column was populated.
      const turnId = event.turnId || text(p.turnId) || String(event.id);
      state.currentTurnId = turnId;
      setTurnStatus(state, turnId, "queued");
      const clientMessageId = text(p.clientMessageId);
      // Reconcile the optimistic bubble with the authoritative server turn instead
      // of leaving a duplicate user message behind.
      const pendingId = clientMessageId ? `user:pending:${clientMessageId}` : null;
      const existingIdx = pendingId ? state.index.get(pendingId) : undefined;
      if (existingIdx !== undefined && state.blocks[existingIdx]?.kind === "user") {
        const block = state.blocks[existingIdx] as UserBlock;
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
    case "turn.started": {
      const turnId = event.turnId || text(p.turnId) || String(event.id);
      state.currentTurnId = turnId;
      setTurnStatus(state, turnId, "running");
      // The turn's activity row belongs to the turn itself, not to its first tool:
      // create it now so a turn that is running (or that only ever produces
      // assistant prose) still shows one honest Working row. `workingGroupFor` is
      // idempotent, so replaying `turn.started` never duplicates the group.
      workingGroupFor(state, turnId);
      return;
    }
    case "item/started": {
      const item = (p.item ?? {}) as Record<string, unknown>;
      const type = text(item.type) || "item";
      const id = `item:${text(item.id) || String(event.id)}`;
      const turnId = resolveTurnId(state, event);
      if (type === "agentMessage") {
        // A blank item that was already resolved to nothing stays resolved: a
        // duplicated or late `item/started` (both occur in stored history) must
        // not put an empty bubble back on screen. Real text clears the marker.
        if (state.blankAssistantItems.has(id)) return;
        if (!state.index.has(id)) push(state, { kind: "assistant", id, text: "", streaming: true });
        return;
      }
      if (type === "reasoning") {
        // Reasoning rows are created lazily by a real summary delta (or the
        // completed item). Creating one here would leave an empty expandable
        // row for every reasoning item that has no summary.
        return;
      }
      if (type === "userMessage") return;
      if (findChild(state, id)) return;
      addTool(state, turnId, {
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
      const type = text(item.type) || "item";
      const turnId = resolveTurnId(state, event);
      if (type === "agentMessage") {
        const completedText = text(item.text);
        const existing = state.index.get(id);
        if (existing !== undefined) {
          const block = state.blocks[existing] as AssistantBlock;
          block.text = completedText || block.text;
          block.streaming = false;
          // The bridge model emits an empty `agentMessage` item before each tool
          // call: `item/started` and `item/completed` both carry `text === ""` and
          // no delta ever arrives. Such an item must not leave a blank bubble
          // behind. Prose that was buffered from real deltas is kept as-is.
          if (!block.text.trim()) {
            removeBlockInPlace(state, id);
            state.blankAssistantItems.add(id);
          }
          return;
        }
        if (completedText.trim()) {
          // Real text on a settled item always creates its block, even if an
          // earlier empty completion had marked this id as blank.
          state.blankAssistantItems.delete(id);
          push(state, { kind: "assistant", id, text: completedText, streaming: false });
          return;
        }
        // A blank completion with no block (and no buffered delta) creates
        // nothing, so replaying legacy history leaves no empty bubble either.
        state.blankAssistantItems.add(id);
        return;
      }
      if (type === "reasoning") {
        const summaryText = reasoningSummaryText(item);
        const found = findChild(state, id);
        if (found) {
          const block = found.child as ReasoningBlock;
          if (summaryText) block.text = summaryText;
          block.streaming = false;
          // A reasoning item with neither summary text nor buffered deltas must
          // not remain as an empty expandable row on replay. If it was the group's
          // only child, the group goes too — a later real tool for the same turn
          // recreates it from the retained turn status.
          if (!block.text.trim()) {
            found.group.children = found.group.children.filter((c) => c.id !== id);
            state.groupOf.delete(id);
            removeGroupIfEmpty(state, found.group);
          }
        } else if (summaryText) {
          addReasoning(state, turnId, { kind: "reasoning", id, text: summaryText, streaming: false });
        }
        return;
      }
      if (type === "userMessage") return;
      const output = toolOutput(item);
      const failed = text(item.status) === "failed" || text(item.status) === "error";
      const found = findChild(state, id);
      if (found) {
        const block = found.child as ToolBlock;
        block.status = failed ? "error" : "done";
        if (output) block.output = output;
        const detail = toolDetail(type, item);
        if (detail) block.detail = detail;
        if (failed) found.group.hasToolError = true;
        return;
      }
      addTool(state, turnId, {
        kind: "tool",
        id,
        toolType: type,
        title: TOOL_TITLES[type] ?? type,
        detail: toolDetail(type, item),
        status: failed ? "error" : "done",
        output,
      });
      return;
    }
    case "stream.delta": {
      const itemId = text(p.itemId) || "stream";
      const kind = text(p.kind);
      const delta = text(p.delta);
      if (!delta) return;
      // Only model-generated reasoning summaries are surfaced. Drop every other
      // reasoning-family delta (especially raw `item/reasoning/textDelta`
      // chain-of-thought) before it can create or extend a block. The server
      // already filters these; this guards replayed or malformed events.
      const isReasoningSummary = REASONING_SUMMARY_DELTA_KINDS.has(kind);
      if (kind.includes("reasoning") && !isReasoningSummary) return;
      const id = `item:${itemId}`;
      const turnId = resolveTurnId(state, event);
      if (isReasoningSummary) {
        const found = findChild(state, id);
        if (found) {
          const block = found.child as ReasoningBlock;
          block.text += delta;
          block.streaming = true;
        } else {
          addReasoning(state, turnId, { kind: "reasoning", id, text: delta, streaming: true });
        }
        return;
      }
      // Tool-output streams arrive normalized as `stream.delta` (the server
      // buffers item/commandExecution/outputDelta & co and re-emits them with the
      // original method in `kind`). They extend the owning tool card's output and
      // must never be appended to an assistant bubble.
      if (TOOL_OUTPUT_DELTA_KINDS.has(kind)) {
        const tool = findToolBlock(state, id);
        if (tool) tool.output += delta;
        return;
      }
      const idx = state.index.get(id);
      if (idx === undefined) {
        // Real prose always has the last word: an item that once completed blank
        // is un-marked here so a late delta still produces its bubble.
        state.blankAssistantItems.delete(id);
        push(state, { kind: "assistant", id, text: delta, streaming: true });
        return;
      }
      const block = state.blocks[idx]!;
      if (block.kind === "assistant") {
        block.text += delta;
        block.streaming = true;
      }
      return;
    }
    case "item/agentMessage/delta": {
      const itemId = text(p.itemId) || "stream";
      const delta = text(p.delta);
      const id = `item:${itemId}`;
      // Same rule as `stream.delta`: an empty delta carries no prose, so it may
      // neither create a blank bubble nor keep one alive.
      if (!delta) return;
      const idx = state.index.get(id);
      if (idx === undefined) {
        state.blankAssistantItems.delete(id);
        push(state, { kind: "assistant", id, text: delta, streaming: true });
      } else {
        const block = state.blocks[idx] as AssistantBlock;
        block.text += delta;
        state.blankAssistantItems.delete(id);
      }
      return;
    }
    case "item/commandExecution/outputDelta": {
      const itemId = text(p.itemId) || "stream";
      const delta = text(p.delta) || text(p.output);
      const found = findChild(state, `item:${itemId}`);
      if (found && found.child.kind === "tool") found.child.output += delta;
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
        const block = state.blocks[idx] as ApprovalBlock;
        block.status = "resolved";
        block.decision = text(p.decision);
      }
      return;
    }
    case "turn.finished": {
      const status = text(p.status);
      // The outer event turnId is this server's turn id and is the only value the
      // working groups are keyed by; the payload's turnId is the remote Codex turn
      // id and is a legacy fallback only.
      const turnId = event.turnId || text(p.turnId) || "";
      const mapped: WorkingStatus =
        status === "completed"
          ? "done"
          : status === "interrupted"
            ? "stopped"
            : status === "failed" || status === "error"
              ? "error"
              : "unknown";
      if (turnId) setTurnStatus(state, turnId, mapped);
      const level = status === "completed" ? "info" : status === "unknown" ? "error" : "warn";
      const label =
        status === "completed" ? "本轮完成" : status === "interrupted" ? "已停止" : status === "unknown" ? "结果未知" : `结束：${status}`;
      push(state, { kind: "status", id: `finish:${String(p.turnId ?? event.id)}`, text: `${label}${text(p.message) ? ` · ${text(p.message)}` : ""}`, level });
      return;
    }
    case "turn.failed": {
      const turnId = event.turnId || text(p.turnId) || "";
      if (turnId) setTurnStatus(state, turnId, "error");
      push(state, { kind: "status", id: `fail:${String(p.turnId ?? event.id)}`, text: `执行失败：${text(p.message)}`, level: "error" });
      return;
    }
    case "turn.cancelled": {
      const turnId = event.turnId || text(p.turnId) || "";
      if (turnId) setTurnStatus(state, turnId, "stopped");
      push(state, { kind: "status", id: `cancel:${String(p.turnId ?? event.id)}`, text: "已取消排队中的轮次", level: "warn" });
      return;
    }
    case "turn.reconciled": {
      const turnId = event.turnId || text(p.turnId) || "";
      if (turnId) setTurnStatus(state, turnId, text(p.status) === "unknown" ? "unknown" : "stopped");
      push(state, {
        kind: "status",
        id: `reconciled:${String(p.turnId ?? event.id)}`,
        text: text(p.message) || "服务重启后状态已核对",
        level: text(p.status) === "unknown" ? "error" : "warn",
      });
      return;
    }
    case "turn.interrupt_requested": {
      const turnId = event.turnId || text(p.turnId) || "";
      if (turnId) setTurnStatus(state, turnId, "stopping");
      push(state, { kind: "status", id: `stop:${event.id}`, text: "已请求停止…", level: "warn" });
      return;
    }
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

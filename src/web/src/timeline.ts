import type { AgentEvent } from "./types";

/** Lifecycle of one turn's collapsed "Working" group. */
export type WorkingStatus = "queued" | "running" | "stopping" | "done" | "error" | "stopped" | "unknown";

export interface UserBlock {
  kind: "user";
  createdAt?: number;
  id: string;
  text: string;
  attachments: Array<{ path: string; name?: string; kind?: string }>;
}

export interface AssistantBlock {
  kind: "assistant";
  createdAt?: number;
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
 * One *continuous* run of activity inside a turn. A turn owns as many of these
 * as it has activity runs: non-empty assistant prose or an approval card between
 * two runs closes the current segment and opens a fresh one, so the stream reads
 * `prose1 — 执行了N项操作 — prose2 — 执行了M项操作 — 最新文字 — 当前状态`
 * instead of clustering every tool at the top of the turn. Normal prose,
 * approvals and status lines stay top-level so nothing important is ever hidden
 * behind a collapsed header.
 */
export interface WorkingBlock {
  kind: "working";
  id: string;
  turnId: string;
  /** 0-based position of this segment within its turn. */
  seq: number;
  /**
   * Set once later visible content closed this segment. A closed segment keeps
   * its place in the stream, never animates again, and never absorbs children
   * that belong to a later segment.
   */
  closed: boolean;
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
  /** activity segment id -> index in `blocks`. */
  groupIndex: Map<string, number>;
  /** child block id -> owning segment id, so a late update finds its own segment. */
  segmentOf: Map<string, string>;
  /** turnId -> that turn's segment ids, in stream order. */
  segmentsByTurn: Map<string, string[]>;
  /** turnId -> next segment sequence number (a removed segment never reuses an id). */
  segSeq: Map<string, number>;
  /**
   * `<turnId>\u0000<itemId>` keys of content items that already opened a segment
   * boundary. Streaming deltas for one assistant item must open exactly one
   * boundary, so later deltas for the same item never rotate the segment again.
   */
  boundaryItems: Set<string>;
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

/**
 * Whether this segment is the turn's single live "current activity" row. A
 * segment closed by later visible content is a historical record: the turn may
 * still be running, but this row must not animate again or claim to be current.
 * At most one open segment exists per turn, so at most one row ever animates.
 */
export function segmentIsActive(group: WorkingBlock): boolean {
  return isWorkingActive(group.status) && !group.closed;
}

/**
 * Header text for one activity segment.
 *
 * Only the turn's open segment reads as in progress (`Working…`, `正在停止…`,
 * `已排队等待`). Every other segment is history and must never carry
 * in-progress wording — not even while the turn is still running: a segment
 * closed by later prose is a finished record. History says what the segment
 * actually did: `执行了 N 项操作` when tools ran, a plain `思考摘要` for a
 * summary-only run. The turn's outcome is never faked: a non-done terminal state
 * keeps its own wording and gains the recorded action summary.
 */
export function segmentLabel(group: WorkingBlock, toolCount?: number): string {
  const count = toolCount ?? group.children.filter((c) => c.kind === "tool").length;
  const reasoningCount = group.children.length - count;
  const live = !group.closed && (group.status === "running" || group.status === "stopping" || group.status === "queued");
  if (live) return workingLabel(group.status);
  // History: describe what the segment recorded, never "Working…".
  const done = count > 0 ? `执行了 ${count} 项操作` : reasoningCount > 0 ? "思考摘要" : "";
  if (!done) return workingLabel(group.status);
  // The turn's own terminal outcome wins over the generic failure note, so a
  // stop or an unknown result is never relabelled as an error.
  if (group.status === "stopped") return `${done} · 已停止`;
  if (group.status === "unknown") return `${done} · 结果未知`;
  // A real tool failure is never swallowed by neutral history wording — not even
  // while the enclosing turn is still running.
  if (group.status === "error" || group.hasToolError) return `${done} · 出错`;
  // Still-running turn whose older segment already closed: the segment itself is
  // a finished record, so it keeps its neutral historical wording.
  return done;
}

/**
 * Whether a segment is a finished historical record (closed, or its turn already
 * settled). Its header dot must read as neutral history rather than the amber
 * in-progress marker — while a real tool error still flags loudly.
 */
export function segmentStatusTone(group: WorkingBlock): "active" | "error" | "history" {
  if (segmentIsActive(group)) return "active";
  if (group.status === "error" || group.hasToolError) return "error";
  return "history";
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
    segmentOf: new Map(state.segmentOf),
    segmentsByTurn: new Map([...state.segmentsByTurn].map(([turnId, ids]) => [turnId, [...ids]])),
    segSeq: new Map(state.segSeq),
    boundaryItems: new Set(state.boundaryItems),
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
    segmentOf: new Map(),
    segmentsByTurn: new Map(),
    segSeq: new Map(),
    boundaryItems: new Set(),
    turnStatus: new Map(),
    blankAssistantItems: new Set(),
    currentTurnId: null,
  };
}

/** Rebuild both index maps from `blocks`, writing them into `state`. */
function reindexInPlace(state: TimelineState): void {
  const index = new Map<string, number>();
  const groupIndex = new Map<string, number>();
  const segmentsByTurn = new Map<string, string[]>();
  state.blocks.forEach((b, i) => {
    index.set(b.id, i);
    if (b.kind !== "working") return;
    groupIndex.set(b.id, i);
    const list = segmentsByTurn.get(b.turnId) ?? [];
    list.push(b.id);
    segmentsByTurn.set(b.turnId, list);
  });
  state.index = index;
  state.groupIndex = groupIndex;
  state.segmentsByTurn = segmentsByTurn;
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
  // An empty segment is only worth keeping while it is the live "current
  // activity" row of an in-flight turn. Once it is closed by later content, or
  // its turn reached a terminal state, an empty segment holds nothing and is
  // dropped: a running turn must not blink its row out and back in, and a
  // finished turn must not leave a stale Working behind.
  if (isWorkingActive(group.status) && !group.closed) return;
  const idx = state.blocks.indexOf(group);
  if (idx === -1) return;
  state.blocks.splice(idx, 1);
  reindexInPlace(state);
}

/** Drop every empty segment of a turn that has settled. */
function pruneEmptySegments(state: TimelineState, turnId: string): void {
  for (const id of [...(state.segmentsByTurn.get(turnId) ?? [])]) {
    const idx = state.groupIndex.get(id);
    const group = idx === undefined ? undefined : state.blocks[idx];
    if (group?.kind === "working") removeGroupIfEmpty(state, group);
  }
}

function push(state: TimelineState, block: Block): number {
  state.blocks.push(block);
  state.index.set(block.id, state.blocks.length - 1);
  if (block.kind === "working") state.groupIndex.set(block.id, state.blocks.length - 1);
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
  // Every segment of the turn reflects its lifecycle. A closed segment is a
  // historical record: its children keep their real statuses, and the header
  // keeps reporting the turn's outcome (a failure must not disappear just
  // because more prose followed it).
  for (const segId of state.segmentsByTurn.get(turnId) ?? []) {
    const idx = state.groupIndex.get(segId);
    if (idx === undefined) continue;
    const group = state.blocks[idx];
    if (group?.kind === "working") group.status = status;
  }
  // A settled turn keeps only segments that actually recorded something.
  if (TERMINAL_STATUSES.has(status)) pruneEmptySegments(state, turnId);
}

/**
 * The segment that should receive the next activity child for a turn: the last
 * open segment, or a freshly opened one. Visible content (assistant prose, an
 * approval card) closes the current segment, so this is exactly the thread of
 * activity that is still running after the newest visible content.
 */
function segmentFor(state: TimelineState, turnId: string): WorkingBlock {
  const ids = state.segmentsByTurn.get(turnId);
  if (ids?.length) {
    const lastId = ids[ids.length - 1]!;
    const idx = state.groupIndex.get(lastId);
    const last = idx === undefined ? undefined : state.blocks[idx];
    if (last?.kind === "working" && !last.closed) return last;
  }
  const seq = state.segSeq.get(turnId) ?? 0;
  const group: WorkingBlock = {
    kind: "working",
    id: `working:${turnId}:${seq}`,
    turnId,
    seq,
    closed: false,
    // A segment created after its turn already ended inherits that terminal
    // status; one with no observed lifecycle at all (legacy events, partial
    // history) is shown as an unknown static record instead of animating
    // forever or claiming a success that was never observed.
    status: state.turnStatus.get(turnId) ?? "unknown",
    children: [],
    hasToolError: false,
  };
  state.segSeq.set(turnId, seq + 1);
  state.segmentsByTurn.set(turnId, [...(ids ?? []), group.id]);
  push(state, group);
  return group;
}

/**
 * Place a turn-scoped notice (status line, warning, stop request) at the end of
 * the turn's visible history *without* pushing the live activity row off the
 * bottom. The row that is still in flight is the newest thing on screen, so a
 * notice lands just before it rather than after; with no live row this is a
 * plain append.
 */
function pushNotice(state: TimelineState, turnId: string, block: Block): void {
  const ids = state.segmentsByTurn.get(turnId);
  const lastId = ids?.length ? ids[ids.length - 1] : undefined;
  const idx = lastId === undefined ? undefined : state.groupIndex.get(lastId);
  const live = idx === undefined ? undefined : state.blocks[idx];
  if (live?.kind === "working" && !live.closed && isWorkingActive(live.status)) {
    state.blocks.splice(idx as number, 0, block);
    reindexInPlace(state);
    return;
  }
  push(state, block);
}

/** The turn's current open activity segment, if it has one. */
function openSegment(state: TimelineState, turnId: string): WorkingBlock | null {
  const ids = state.segmentsByTurn.get(turnId);
  if (!ids?.length) return null;
  const idx = state.groupIndex.get(ids[ids.length - 1]!);
  const last = idx === undefined ? undefined : state.blocks[idx];
  return last?.kind === "working" && !last.closed ? last : null;
}

/**
 * Close the turn's open segment because later visible content (assistant prose,
 * an approval card) has been emitted. The closed segment keeps its position and
 * its children; the next tool/summary opens a new segment after that content, so
 * the active activity row is always the last one in the turn.
 */
function closeSegment(state: TimelineState, turnId: string): void {
  const open = openSegment(state, turnId);
  if (open) open.closed = true;
}

/**
 * Register visible content that splits a turn's activity into segments. The key
 * is per turn *and* per item so a long stream of deltas for one assistant
 * message rotates the segment only once, while an empty item (a blank
 * `agentMessage` from the bridge) never rotates anything.
 *
 * Must be called *after* the content block was placed in `blocks`, so the fresh
 * open segment that follows it lands below the content. That new row is the
 * single live "current activity" indicator while the turn keeps running; an
 * empty one is pruned once the turn settles.
 */
function contentBoundary(state: TimelineState, turnId: string, key: string): void {
  const composite = `${turnId}\u0000${key}`;
  if (state.boundaryItems.has(composite)) return;
  state.boundaryItems.add(composite);
  closeSegment(state, turnId);
  // A segment that closed with nothing recorded was only the placeholder row of
  // a prose-only run; it holds no history and is dropped before the trailing row
  // is opened, so the stream never shows two empty activity rows at once.
  for (const id of [...(state.segmentsByTurn.get(turnId) ?? [])]) {
    const idx = state.groupIndex.get(id);
    const group = idx === undefined ? undefined : state.blocks[idx];
    if (group?.kind === "working" && group.closed) removeGroupIfEmpty(state, group);
  }
  const status = state.turnStatus.get(turnId);
  // The text that just landed is itself the newest visible content, so a turn
  // still in flight gets a trailing row beneath it; a settled turn gets none.
  if (status === "running" || status === "stopping") segmentFor(state, turnId);
}

function findChild(state: TimelineState, id: string): { group: WorkingBlock; child: ToolBlock | ReasoningBlock } | null {
  const segmentId = state.segmentOf.get(id);
  if (segmentId === undefined) return null;
  const groupIdx = state.groupIndex.get(segmentId);
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
  const group = segmentFor(state, turnId);
  group.children.push({ ...block, turnId });
  state.segmentOf.set(block.id, group.id);
  if (block.status === "error") group.hasToolError = true;
}

function addReasoning(state: TimelineState, turnId: string, block: Omit<ReasoningBlock, "turnId">): void {
  const group = segmentFor(state, turnId);
  group.children.push({ ...block, turnId });
  state.segmentOf.set(block.id, group.id);
}

export function applyEvent(state: TimelineState, event: AgentEvent): void {
  const p = event.payload ?? {};
  switch (event.type) {
    case "local.pending": {
      // Optimistic echo of a message the client just sent. It is reconciled (or
      // rolled back) by clientMessageId once the server responds.
      const clientMessageId = text(p.clientMessageId);
      const attachments = Array.isArray(p.attachments) ? (p.attachments as Array<{ path: string }>) : [];
      push(state, { kind: "user", createdAt: event.createdAt, id: `user:pending:${clientMessageId}`, text: text(p.text), attachments });
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
      push(state, { kind: "user", createdAt: event.createdAt, id: `user:${turnId}`, text: text(p.text), attachments });
      return;
    }
    case "turn.started": {
      const turnId = event.turnId || text(p.turnId) || String(event.id);
      state.currentTurnId = turnId;
      setTurnStatus(state, turnId, "running");
      // The turn's activity row belongs to the turn itself, not to its first tool:
      // create it now so a turn that is running (or that only ever produces
      // assistant prose) still shows one honest Working row. `segmentFor` reuses
      // the open segment, so replaying `turn.started` never duplicates a row.
      segmentFor(state, turnId);
      return;
    }
    case "item/started": {
      const item = (p.item ?? {}) as Record<string, unknown>;
      const type = text(item.type) || "item";
      const id = `item:${text(item.id) || String(event.id)}`;
      const turnId = resolveTurnId(state, event);
      if (type === "agentMessage") {
        // A start can be duplicated or arrive late (both occur in stored
        // history). Once the item has a block, the start is a pure no-op: it must
        // never append a second block for one id, and never reset already
        // settled prose back to streaming.
        if (state.index.has(id)) return;
        // Creation is *lazy*: the bridge opens a text-less `agentMessage` item
        // before every tool call, and materialising a block for it would both
        // paint an empty bubble and — because a block appended now sits after the
        // turn's live activity row — wrongly steal the bottom slot from the
        // current "进行中" row. So such an item only starts existing once real
        // prose actually arrives: a non-empty delta or `item/completed`. Text
        // carried on the start itself is real, so it builds the block (and its
        // boundary) immediately; a blank start stays inert. Any stale blank
        // marker is cleared so real prose is never suppressed.
        const startText = text(item.text).trim();
        if (startText) {
          state.blankAssistantItems.delete(id);
          push(state, { kind: "assistant", createdAt: event.createdAt, id, text: startText, streaming: true });
          contentBoundary(state, turnId, id);
        }
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
          } else if (completedText.trim()) {
            // The settled prose closes the activity run that preceded it and
            // opens the trailing live row beneath it.
            contentBoundary(state, turnId, id);
          }
          return;
        }
        if (completedText.trim()) {
          // Real text on a settled item always creates its block, even if an
          // earlier empty completion had marked this id as blank.
          state.blankAssistantItems.delete(id);
          push(state, { kind: "assistant", createdAt: event.createdAt, id, text: completedText, streaming: false });
          contentBoundary(state, turnId, id);
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
            state.segmentOf.delete(id);
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
        // is un-marked here so a late delta still produces its bubble. The first
        // real delta is what closes the current activity run.
        state.blankAssistantItems.delete(id);
        push(state, { kind: "assistant", createdAt: event.createdAt, id, text: delta, streaming: true });
        contentBoundary(state, turnId, id);
        return;
      }
      const block = state.blocks[idx]!;
      if (block.kind === "assistant") {
        block.text += delta;
        block.streaming = true;
        contentBoundary(state, turnId, id);
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
      const turnId = resolveTurnId(state, event);
      const idx = state.index.get(id);
      if (idx === undefined) {
        state.blankAssistantItems.delete(id);
        push(state, { kind: "assistant", createdAt: event.createdAt, id, text: delta, streaming: true });
        contentBoundary(state, turnId, id);
      } else {
        const block = state.blocks[idx] as AssistantBlock;
        block.text += delta;
        state.blankAssistantItems.delete(id);
        contentBoundary(state, turnId, id);
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
      const turnId = resolveTurnId(state, event);
      push(state, {
        kind: "approval",
        id: `approval:${requestId}`,
        requestId,
        method: text(p.method),
        payload: (p.params ?? {}) as Record<string, unknown>,
        status: "pending",
      });
      // An approval card is visible content: it splits the turn's activity so the
      // activity that follows is a new segment below the card (the card itself is
      // never hidden, and never absorbed into a collapsed row).
      contentBoundary(state, turnId, `approval:${requestId}`);
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
      pushNotice(state, turnId || resolveTurnId(state, event), {
        kind: "status",
        id: `finish:${String(p.turnId ?? event.id)}`,
        text: `${label}${text(p.message) ? ` · ${text(p.message)}` : ""}`,
        level,
      });
      return;
    }
    case "turn.failed": {
      const turnId = event.turnId || text(p.turnId) || "";
      if (turnId) setTurnStatus(state, turnId, "error");
      pushNotice(state, turnId || resolveTurnId(state, event), {
        kind: "status",
        id: `fail:${String(p.turnId ?? event.id)}`,
        text: `执行失败：${text(p.message)}`,
        level: "error",
      });
      return;
    }
    case "turn.cancelled": {
      const turnId = event.turnId || text(p.turnId) || "";
      if (turnId) setTurnStatus(state, turnId, "stopped");
      pushNotice(state, turnId || resolveTurnId(state, event), {
        kind: "status",
        id: `cancel:${String(p.turnId ?? event.id)}`,
        text: "已取消排队中的轮次",
        level: "warn",
      });
      return;
    }
    case "turn.reconciled": {
      const turnId = event.turnId || text(p.turnId) || "";
      if (turnId) setTurnStatus(state, turnId, text(p.status) === "unknown" ? "unknown" : "stopped");
      pushNotice(state, turnId || resolveTurnId(state, event), {
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
      // Still stopping, so the live row stays the bottom-most element.
      pushNotice(state, turnId || resolveTurnId(state, event), {
        kind: "status",
        id: `stop:${event.id}`,
        text: "已请求停止…",
        level: "warn",
      });
      return;
    }
    case "thread.started": {
      const turnId = resolveTurnId(state, event);
      pushNotice(state, turnId, { kind: "status", id: `thread:${String(p.threadId ?? event.id)}`, text: `已创建会话线程（模型 ${text(p.model)}）`, level: "info" });
      return;
    }
    case "error":
      pushNotice(state, resolveTurnId(state, event), {
        kind: "status",
        id: `err:${event.id}`,
        text: `错误：${text(p.message) || JSON.stringify(p).slice(0, 300)}`,
        level: "error",
      });
      return;
    case "warning":
      pushNotice(state, resolveTurnId(state, event), {
        kind: "status",
        id: `warn:${event.id}`,
        text: `提示：${text(p.message) || JSON.stringify(p).slice(0, 200)}`,
        level: "warn",
      });
      return;
    default:
      return;
  }
}

export function buildTimeline(events: AgentEvent[], state: TimelineState = emptyTimeline()): TimelineState {
  for (const event of events) applyEvent(state, event);
  return state;
}

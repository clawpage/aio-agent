import { describe, expect, it } from "vitest";
import {
  applyEvent,
  buildTimeline,
  childInProgress,
  cloneTimeline,
  emptyTimeline,
  isWorkingActive,
  removeBlock,
  segmentIsActive,
  segmentLabel,
  segmentStatusTone,
  workingLabel,
  type AssistantBlock,
  type ReasoningBlock,
  type TimelineState,
  type ToolBlock,
  type WorkingBlock,
} from "../../src/ui/src/timeline";
import type { AgentEvent } from "../../src/ui/src/types";

/** Every tool block, whether it sits inside a working group or (legacy) top level. */
function tools(state: TimelineState): ToolBlock[] {
  const out: ToolBlock[] = [];
  for (const b of state.blocks) {
    if (b.kind === "tool") out.push(b);
    else if (b.kind === "working") out.push(...b.children.filter((c): c is ToolBlock => c.kind === "tool"));
  }
  return out;
}

/** Every reasoning summary, wherever it lives. */
function reasonings(state: TimelineState): ReasoningBlock[] {
  const out: ReasoningBlock[] = [];
  for (const b of state.blocks) {
    if (b.kind === "reasoning") out.push(b);
    else if (b.kind === "working") out.push(...b.children.filter((c): c is ReasoningBlock => c.kind === "reasoning"));
  }
  return out;
}

function groups(state: TimelineState): WorkingBlock[] {
  return state.blocks.filter((b): b is WorkingBlock => b.kind === "working");
}

/** Every assistant prose bubble currently on screen. */
function assistants(state: TimelineState): AssistantBlock[] {
  return state.blocks.filter((b): b is AssistantBlock => b.kind === "assistant");
}

/** Every index map must agree with the real block positions after every edit. */
function expectExactIndexes(state: TimelineState): void {
  state.blocks.forEach((b, i) => {
    expect(state.index.get(b.id)).toBe(i);
    if (b.kind === "working") expect(state.groupIndex.get(b.id)).toBe(i);
  });
  // Each turn's segment list is exactly its live segments, in stream order.
  for (const [turnId, ids] of state.segmentsByTurn) {
    const actual = groups(state)
      .filter((g) => g.turnId === turnId)
      .map((g) => g.id);
    expect(ids).toEqual(actual);
  }
  // Every recorded child points at a segment that exists.
  for (const segmentId of state.segmentOf.values()) expect(state.groupIndex.has(segmentId)).toBe(true);
}

/** The ids of one turn's activity segments, in stream order. */
function segmentIds(state: TimelineState, turnId: string): string[] {
  return (state.segmentsByTurn.get(turnId) ?? []).slice();
}

let seq = 0;
function ev(type: string, payload: Record<string, unknown>, turnId: string | null = null): AgentEvent {
  seq += 1;
  return { id: seq, type, turnId, createdAt: Date.now(), payload };
}

function feed(events: AgentEvent[]) {
  return buildTimeline(events);
}

describe("timeline reducer", () => {
  it("reconciles the optimistic bubble with the authoritative turn without duplicating", () => {
    const state = feed([
      ev("local.pending", { clientMessageId: "cm-1", text: "你好", attachments: [] }),
      ev("turn.queued", { turnId: "turn_real", clientMessageId: "cm-1", text: "你好", attachments: [] }),
    ]);
    const users = state.blocks.filter((b) => b.kind === "user");
    expect(users.length).toBe(1);
    expect(users[0]!.id).toBe("user:turn_real");
    expect(state.index.has("user:pending:cm-1")).toBe(false);
  });

  it("drops the optimistic bubble on rollback", () => {
    const state = feed([ev("local.pending", { clientMessageId: "cm-2", text: "失败", attachments: [] })]);
    expect(state.blocks.length).toBe(1);
    const rolledBack = removeBlock(state, "user:pending:cm-2");
    expect(rolledBack.blocks.length).toBe(0);
    // A later real event for the same id must still create a fresh block.
    const after = buildTimeline([ev("turn.queued", { turnId: "t2", clientMessageId: "cm-2", text: "失败", attachments: [] })], rolledBack);
    expect(after.blocks.filter((b) => b.kind === "user").length).toBe(1);
  });

  it("applies deltas that arrive before item/completed exactly once", () => {
    const state = feed([
      ev("item/started", { item: { id: "i1", type: "agentMessage" } }),
      ev("stream.delta", { itemId: "i1", kind: "item/agentMessage/delta", delta: "PROBE" }),
      ev("stream.delta", { itemId: "i1", kind: "item/agentMessage/delta", delta: "_OK" }),
      ev("item/completed", { item: { id: "i1", type: "agentMessage", text: "PROBE_OK" } }),
    ]);
    const assistants = state.blocks.filter((b) => b.kind === "assistant") as Array<{ text: string; streaming: boolean }>;
    expect(assistants.length).toBe(1);
    expect(assistants[0]!.text).toBe("PROBE_OK");
    expect(assistants[0]!.streaming).toBe(false);
  });

  it("uses the completed text when deltas were lossy and never regresses streaming", () => {
    const state = feed([
      ev("stream.delta", { itemId: "i2", kind: "item/agentMessage/delta", delta: "partial" }),
      ev("item/completed", { item: { id: "i2", type: "agentMessage", text: "partial answer complete" } }),
    ]);
    const block = state.blocks.find((b) => b.kind === "assistant") as { text: string; streaming: boolean };
    expect(block.text).toBe("partial answer complete");
    expect(block.streaming).toBe(false);
  });

  it("renders tool cards with output and terminal status", () => {
    const state = feed([
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "uname -a", cwd: "/home/gem" } }),
      ev("stream.delta", { itemId: "c1", kind: "item/commandExecution/outputDelta", delta: "Linux\n" }),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "Linux\n" } }),
    ]);
    const tool = tools(state)[0]!;
    expect(tool.detail).toContain("uname -a");
    expect(tool.status).toBe("done");
    expect(tool.output).toContain("Linux");
  });

  it("marks an unknown outcome explicitly and never claims success", () => {
    const state = feed([
      ev("turn.finished", { turnId: "t3", status: "unknown", message: "结果未知" }),
      ev("turn.reconciled", { turnId: "t4", status: "unknown", message: "服务重启时正在执行" }),
    ]);
    const statuses = state.blocks.filter((b) => b.kind === "status") as Array<{ level: string; text: string }>;
    expect(statuses.every((s) => s.level === "error" || s.level === "warn")).toBe(true);
    expect(statuses.some((s) => s.text.includes("服务重启时正在执行"))).toBe(true);
  });

  it("resolves approval cards by request id", () => {
    const state = feed([
      ev("approval.requested", { requestId: "r1", method: "item/commandExecution/requestApproval", params: { command: "ls" } }),
      ev("approval.resolved", { requestId: "r1", decision: "accept" }),
    ]);
    const approval = state.blocks.find((b) => b.kind === "approval") as { status: string; decision?: string };
    expect(approval.status).toBe("resolved");
    expect(approval.decision).toBe("accept");
  });

  it("is a no-op for unknown event types", () => {
    const state = emptyTimeline();
    applyEvent(state, ev("mcpServer/startupStatus/updated", { name: "aio_browser" }));
    expect(state.blocks.length).toBe(0);
  });

  it("never renders an empty reasoning row for a started item with no summary", () => {
    const state = feed([
      ev("item/started", { item: { id: "r-empty", type: "reasoning", summary: [], content: [] } }),
      ev("item/completed", { item: { id: "r-empty", type: "reasoning", summary: [], content: [] } }),
    ]);
    expect(reasonings(state)).toHaveLength(0);
    // No empty group is left behind either.
    expect(groups(state).every((g) => g.children.length > 0)).toBe(true);
  });

  it("renders a completed reasoning item from its summary array only", () => {
    const state = feed([
      ev("item/started", { item: { id: "r1", type: "reasoning", summary: [], content: [] } }),
      ev("item/completed", { item: { id: "r1", type: "reasoning", summary: ["先确认目标", "再执行"], content: ["RAW COT"] } }),
    ]);
    const reasoning = reasonings(state);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.text).toBe("先确认目标\n\n再执行");
    expect(reasoning[0]!.streaming).toBe(false);
    // Raw chain-of-thought must never leak into the row.
    expect(reasoning[0]!.text).not.toContain("RAW COT");
  });

  it("keeps summary deltas in order before the completed item", () => {
    const state = feed([
      ev("item/started", { item: { id: "r2", type: "reasoning", summary: [], content: [] } }),
      ev("stream.delta", { itemId: "r2", kind: "item/reasoning/summaryTextDelta", delta: "第一段" }),
      ev("stream.delta", { itemId: "r2", kind: "item/reasoning/summaryTextDelta", delta: "第二段" }),
      ev("item/completed", { item: { id: "r2", type: "reasoning", summary: ["第一段第二段"] } }),
    ]);
    const reasoning = reasonings(state);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.text).toBe("第一段第二段");
    expect(reasoning[0]!.streaming).toBe(false);
  });

  it("drops raw chain-of-thought deltas without creating a reasoning row", () => {
    const state = feed([
      ev("stream.delta", { itemId: "raw1", kind: "item/reasoning/textDelta", delta: "RAW" }),
      ev("stream.delta", { itemId: "raw1", kind: "item/reasoning/contentDelta", delta: "COT" }),
    ]);
    expect(state.blocks).toHaveLength(0);
    expect(state.index.has("item:raw1")).toBe(false);
  });

  it("still renders a reasoning row for a real summary delta", () => {
    const state = feed([
      ev("item/started", { item: { id: "r3", type: "reasoning", summary: [], content: [] } }),
      ev("stream.delta", { itemId: "r3", kind: "item/reasoning/summaryPartAdded", delta: "先确认目标" }),
    ]);
    const reasoning = reasonings(state);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.text).toBe("先确认目标");
    expect(reasoning[0]!.streaming).toBe(true);
  });
});

describe("working groups", () => {
  it("collects each turn's tools and summaries into one group, isolated per turn", () => {
    const state = feed([
      ev("turn.queued", { turnId: "t1", text: "第一轮" }),
      ev("turn.started", { turnId: "t1" }),
      ev("item/started", { item: { id: "a1", type: "commandExecution", command: "ls" } }),
      ev("item/completed", { item: { id: "a1", type: "commandExecution", status: "completed", aggregatedOutput: "ok" } }),
      ev("item/completed", { item: { id: "r1", type: "reasoning", summary: ["先看目录"] } }),
      ev("turn.finished", { turnId: "t1", status: "completed" }),
      ev("turn.queued", { turnId: "t2", text: "第二轮" }),
      ev("turn.started", { turnId: "t2" }),
      ev("item/started", { item: { id: "b1", type: "commandExecution", command: "pwd" } }),
      ev("item/completed", { item: { id: "b1", type: "commandExecution", status: "completed" } }),
      ev("turn.finished", { turnId: "t2", status: "completed" }),
    ]);
    const gs = groups(state);
    expect(gs.map((g) => g.id)).toEqual(["working:t1:0", "working:t2:0"]);
    expect(gs[0]!.children.map((c) => c.id)).toEqual(["item:a1", "item:r1"]);
    expect(gs[1]!.children.map((c) => c.id)).toEqual(["item:b1"]);
    // Every child knows its owning turn, and the turn is the local one.
    expect(tools(state).map((t) => t.turnId)).toEqual(["t1", "t2"]);
    expect(reasonings(state).map((r) => r.turnId)).toEqual(["t1"]);
    // The first tool of each turn sits at the group's position, not top level.
    expect(state.blocks.some((b) => b.kind === "tool")).toBe(false);
    expect(state.blocks.some((b) => b.kind === "reasoning")).toBe(false);
  });

  it("keeps normal assistant prose out of the group", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "这是正文" } }),
    ]);
    const assistant = state.blocks.filter((b) => b.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(groups(state)[0]!.children).toHaveLength(1);
    expect(groups(state)[0]!.children[0]!.kind).toBe("tool");
  });

  it("resolves the local turn id the same way for lifecycle and item events", () => {
    // The payload carries the remote Codex turn id; the outer event turnId is this
    // server's local turn id. Every branch must agree on the outer one, otherwise a
    // group would never receive its own turn's lifecycle.
    const state = feed([
      ev("turn.started", { turnId: "remote-1" }, "local1"),
      ev("item/started", { item: { id: "x1", type: "commandExecution", command: "ls" }, turnId: "remote-1" }, "local1"),
      ev("turn.finished", { turnId: "remote-1", status: "completed" }, "local1"),
    ]);
    expect(groups(state).map((g) => g.turnId)).toEqual(["local1"]);
    expect(groups(state)[0]!.status).toBe("done");
    expect(state.currentTurnId).toBe("local1");
  });

  it("prefers the outer local turnId over the payload's remote turn id", () => {
    const state = feed([
      ev("turn.started", { turnId: "local1" }),
      // The payload carries the remote Codex turn id; the group must key on local1.
      ev("item/started", { item: { id: "x1", type: "commandExecution", command: "ls" }, turnId: "remote-9" }, "local1"),
      ev("turn.finished", { turnId: "remote-9", status: "completed" }, "local1"),
    ]);
    const gs = groups(state);
    expect(gs).toHaveLength(1);
    expect(gs[0]!.turnId).toBe("local1");
    expect(gs[0]!.status).toBe("done");
    expect(tools(state)[0]!.turnId).toBe("local1");
  });

  it("gives an unowned legacy event a stable static bucket when no turn is known", () => {
    // Replayed history can contain events with no turn identity at all. With no
    // observed turn to attach them to they land in one stable `untracked` group
    // that stays static: no animation, no invented success.
    const state = feed([
      { id: 998, type: "item/completed", turnId: null, createdAt: Date.now(), payload: { item: { id: "old1", type: "commandExecution", status: "completed" } } },
      { id: 999, type: "item/completed", turnId: null, createdAt: Date.now(), payload: { item: { id: "old2", type: "commandExecution", status: "completed" } } },
    ]);
    const gs = groups(state);
    expect(gs).toHaveLength(1);
    expect(gs[0]!.turnId).toBe("untracked");
    expect(gs[0]!.children.map((c) => c.id)).toEqual(["item:old1", "item:old2"]);
    expect(gs[0]!.status).toBe("unknown");
    expect(isWorkingActive(gs[0]!.status)).toBe(false);
    expect(workingLabel(gs[0]!.status)).toBe("结果未知");
  });

  it("attaches an early live event with no turnId to the turn that just started", () => {
    // The server can emit the first item of a turn before the local turn id is
    // persisted; those events carry no turnId and must join the starting turn
    // rather than a separate bucket.
    const state = feed([
      ev("turn.started", { turnId: "live" }),
      ev("item/started", { item: { id: "early", type: "commandExecution", command: "ls" } }),
    ]);
    expect(groups(state).map((g) => g.turnId)).toEqual(["live"]);
    expect(groups(state)[0]!.status).toBe("running");
  });

  it("routes every normalized tool-output stream delta into the tool, never into prose", () => {
    const kinds = [
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "command/exec/outputDelta",
      "process/outputDelta",
      "item/mcpToolCall/progress",
    ];
    for (const kind of kinds) {
      const state = feed([
        ev("turn.started", { turnId: "t1" }),
        ev("item/started", { item: { id: "cmd1", type: "commandExecution", command: "probe" } }),
        ev("stream.delta", { itemId: "cmd1", kind, delta: "probe-output" }),
      ]);
      expect(tools(state)[0]!.output).toBe("probe-output");
      expect(state.blocks.filter((b) => b.kind === "assistant")).toHaveLength(0);
    }
  });

  it("keeps a failed tool flagged on the group header even after the turn succeeds", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }),
      ev("item/started", { item: { id: "f1", type: "commandExecution", command: "boom" } }),
      ev("item/completed", { item: { id: "f1", type: "commandExecution", status: "failed" } }),
      ev("turn.finished", { turnId: "t1", status: "completed" }),
    ]);
    const g = groups(state)[0]!;
    expect(g.status).toBe("done");
    expect(g.hasToolError).toBe(true);
    expect(tools(state)[0]!.status).toBe("error");
  });

  it("maps every terminal lifecycle onto the right label without faking success", () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ status: "completed" }, "done", "已完成"],
      [{ status: "failed", message: "boom" }, "error", "执行出错"],
      [{ status: "interrupted" }, "stopped", "已停止"],
      [{ status: "unknown", message: "断连" }, "unknown", "结果未知"],
    ];
    for (const [payload, status, label] of cases) {
      const state = feed([
        ev("turn.started", { turnId: "t1" }),
        ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }),
        ev("turn.finished", { turnId: "t1", ...payload }),
      ]);
      expect(groups(state)[0]!.status).toBe(status);
      expect(workingLabel(status as never)).toBe(label);
      expect(isWorkingActive(status as never)).toBe(false);
    }
  });

  it("reports a failed turn as an execution error, not an unknown outcome", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }),
      ev("turn.failed", { turnId: "t1", message: "沙箱崩了" }),
    ]);
    expect(groups(state)[0]!.status).toBe("error");
    const status = state.blocks.find((b) => b.kind === "status") as { level: string; text: string };
    expect(status.level).toBe("error");
    expect(status.text).toContain("沙箱崩了");
  });

  it("never animates a queued turn and only animates once it actually started", () => {
    const queued = feed([
      ev("turn.queued", { turnId: "t1", text: "排队" }),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }),
    ]);
    expect(groups(queued)[0]!.status).toBe("queued");
    expect(isWorkingActive(groups(queued)[0]!.status)).toBe(false);
    expect(workingLabel("queued")).not.toContain("Working");

    const running = buildTimeline([ev("turn.started", { turnId: "t1" })], queued);
    expect(groups(running)[0]!.status).toBe("running");
    expect(isWorkingActive("running")).toBe(true);
  });

  it("does not animate a completed tool that never saw a lifecycle event", () => {
    const state = feed([
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }),
    ]);
    const g = groups(state)[0]!;
    expect(g.turnId).toBe("untracked");
    expect(isWorkingActive(g.status)).toBe(false);
    expect(workingLabel(g.status)).toBe("结果未知");
  });

  it("inherits the terminal status for a group created after its turn already ended", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }),
      ev("turn.finished", { turnId: "t1", status: "completed" }),
      // A late/replayed tool event for the same turn must not restart the animation.
      ev("item/completed", { item: { id: "late", type: "commandExecution", status: "completed" } }, "t1"),
    ]);
    const g = groups(state)[0]!;
    expect(g.status).toBe("done");
    expect(isWorkingActive(g.status)).toBe(false);
    expect(g.children).toHaveLength(1);
  });

  it("stops claiming in-progress on children when the turn ends without their completion", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "sleep 100" } }),
      ev("stream.delta", { itemId: "r1", kind: "item/reasoning/summaryTextDelta", delta: "还在想" }),
      ev("turn.finished", { turnId: "t1", status: "interrupted" }),
    ]);
    const g = groups(state)[0]!;
    expect(g.status).toBe("stopped");
    const tool = g.children.find((c) => c.kind === "tool")!;
    const reasoning = g.children.find((c) => c.kind === "reasoning")!;
    // The recorded statuses are untouched; only the "in progress" presentation stops.
    expect(tool.kind === "tool" && tool.status).toBe("running");
    expect(childInProgress(g, tool)).toBe(false);
    expect(childInProgress(g, reasoning)).toBe(false);
    // While the turn is live the same children do present as in progress.
    const live = feed([
      ev("turn.started", { turnId: "t1" }),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "sleep 100" } }),
    ]);
    const liveGroup = groups(live)[0]!;
    expect(childInProgress(liveGroup, liveGroup.children[0]!)).toBe(true);
  });

  it("keeps a real recorded output visible after the turn ends", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }),
      ev("stream.delta", { itemId: "c1", kind: "item/commandExecution/outputDelta", delta: "partial" }),
      ev("turn.finished", { turnId: "t1", status: "interrupted" }),
    ]);
    const tool = tools(state)[0]!;
    expect(tool.output).toBe("partial");
  });

  it("applies an incremental update to a clone without touching the previous state", () => {
    const first = feed([
      ev("turn.started", { turnId: "local1" }),
      ev("item/started", { item: { id: "cmd1", type: "commandExecution", command: "probe" } }),
    ]);
    const next = cloneTimeline(first);
    applyEvent(next, ev("stream.delta", { itemId: "cmd1", kind: "item/commandExecution/outputDelta", delta: "probe" }));

    // The maps are independent copies...
    expect(next.groupIndex).not.toBe(first.groupIndex);
    expect(next.segmentOf).not.toBe(first.segmentOf);
    expect(next.turnStatus).not.toBe(first.turnStatus);
    // ...and so are the block objects the reducer mutates: the group, the
    // children array, and the child that received the delta.
    const firstGroup = groups(first)[0]!;
    const nextGroup = groups(next)[0]!;
    expect(nextGroup).not.toBe(firstGroup);
    expect(nextGroup.children).not.toBe(firstGroup.children);
    expect(nextGroup.children[0]).not.toBe(firstGroup.children[0]);
    // The previous state is byte-for-byte unchanged: no duplicated delta, no
    // leaked child.
    expect((firstGroup.children[0] as ToolBlock).output).toBe("");
    expect(firstGroup.children).toHaveLength(1);
    expect((nextGroup.children[0] as ToolBlock).output).toBe("probe");
    // A second, independent update still starts from the untouched original.
    const third = cloneTimeline(first);
    applyEvent(third, ev("item/started", { item: { id: "cmd2", type: "commandExecution", command: "pwd" } }));
    expect(groups(first)[0]!.children).toHaveLength(1);
    expect(groups(third)[0]!.children).toHaveLength(2);
    // Mutating the clone's group status must not reach the original either.
    applyEvent(third, ev("turn.finished", { turnId: "local1", status: "completed" }));
    expect(groups(first)[0]!.status).toBe("running");
    expect(groups(third)[0]!.status).toBe("done");
  });

  it("drops a whitespace-only summary while keeping the live row and exact indexes", () => {
    const state = feed([
      // A group for an earlier turn, so the reindex has something to keep correct.
      ev("turn.queued", { turnId: "t0", text: "第一轮" }),
      ev("turn.started", { turnId: "t0" }),
      ev("item/completed", { item: { id: "k0", type: "commandExecution", status: "completed" } }, "t0"),
      ev("turn.finished", { turnId: "t0", status: "completed" }, "t0"),
      // The turn under test: only a blank summary, then a real tool and prose.
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("stream.delta", { itemId: "r", kind: "item/reasoning/summaryTextDelta", delta: "\n\n" }, "t1"),
      ev("item/completed", { item: { id: "r", type: "reasoning", summary: [] } }, "t1"),
    ]);

    // The blank summary row is gone, and the still-running t1 row survives with
    // no children (its first tool has not arrived yet).
    expect(groups(state).map((g) => g.turnId)).toEqual(["t0", "t1"]);
    expect(groups(state)[1]!.children).toHaveLength(0);
    expect(groups(state)[1]!.status).toBe("running");
    expect(reasonings(state)).toHaveLength(0);
    expect(state.segmentOf.has("item:r")).toBe(false);

    // A later real tool for t1 joins that live row; the prose that follows closes
    // that run and opens a fresh current-activity row beneath it.
    applyEvent(state, ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"));
    applyEvent(state, ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "正文" } }, "t1"));
    const t1Segments = segmentIds(state, "t1");
    expect(t1Segments).toHaveLength(2);
    const first = groups(state).find((g) => g.id === t1Segments[0]!)!;
    const trailing = groups(state).find((g) => g.id === t1Segments[1]!)!;
    expect(first.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect(first.closed).toBe(true);
    expect(segmentIsActive(first)).toBe(false);
    expect(trailing.children).toHaveLength(0);
    expect(segmentIsActive(trailing)).toBe(true);
    // The tool run ended before the prose, which precedes the live row.
    const assistantIdx = state.index.get("item:m1")!;
    expect(state.groupIndex.get(t1Segments[0]!)!).toBeLessThan(assistantIdx);
    expect(assistantIdx).toBeLessThan(state.groupIndex.get(t1Segments[1]!)!);
    expect(state.segmentOf.get("item:c1")).toBe(t1Segments[0]);
    expectExactIndexes(state);
  });

  it("keeps a real summary alongside a dropped blank one", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("stream.delta", { itemId: "keep", kind: "item/reasoning/summaryTextDelta", delta: "有内容" }, "t1"),
      ev("stream.delta", { itemId: "blank", kind: "item/reasoning/summaryTextDelta", delta: "   " }, "t1"),
      ev("item/completed", { item: { id: "blank", type: "reasoning", summary: [] } }, "t1"),
    ]);
    const g = groups(state)[0]!;
    expect(g.children.map((c) => c.id)).toEqual(["item:keep"]);
    expect(reasonings(state)).toHaveLength(1);
  });
});

describe("working group presence", () => {
  it("creates the turn's activity row on turn.started, before any tool or summary", () => {
    const state = feed([ev("turn.started", { turnId: "t1" }, "t1")]);
    const gs = groups(state);
    expect(gs).toHaveLength(1);
    expect(gs[0]!.id).toBe("working:t1:0");
    expect(gs[0]!.children).toHaveLength(0);
    expect(gs[0]!.status).toBe("running");
    expect(isWorkingActive(gs[0]!.status)).toBe(true);
  });

  it("keeps a running turn's row when the only summary was blank", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("stream.delta", { itemId: "r", kind: "item/reasoning/summaryTextDelta", delta: "\n\n" }, "t1"),
      ev("item/completed", { item: { id: "r", type: "reasoning", summary: [] } }, "t1"),
    ]);
    // The empty summary is dropped, but the live turn's row survives.
    expect(groups(state)).toHaveLength(1);
    expect(groups(state)[0]!.children).toHaveLength(0);
    expect(groups(state)[0]!.status).toBe("running");
    expect(reasonings(state)).toHaveLength(0);
    // A real summary afterwards joins the same row instead of creating a second.
    applyEvent(state, ev("item/completed", { item: { id: "r2", type: "reasoning", summary: ["真实摘要"] } }, "t1"));
    expect(groups(state)).toHaveLength(1);
    expect(reasonings(state).map((r) => r.text)).toEqual(["真实摘要"]);
  });

  it("keeps a settled row for a turn that produced no activity", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("turn.finished", { turnId: "t1", status: "completed" }, "t1"),
    ]);
    // The row exists while the turn is live, so the header appears immediately...
    const live = groups(
      feed([ev("turn.started", { turnId: "t1" }, "t1")]),
    )[0]!;
    expect(live.status).toBe("running");
    expect(isWorkingActive(live.status)).toBe(true);
    // ...but a settled turn with nothing recorded leaves no empty "执行 0 项操作"
    // row behind. Its outcome stays visible as an honest status line instead.
    expect(groups(state)).toHaveLength(0);
    const statuses = state.blocks.filter((b) => b.kind === "status") as Array<{ text: string }>;
    expect(statuses.map((s) => s.text).join(" ")).toContain("本轮完成");
  });

  it("never duplicates the row when turn.started is replayed", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("turn.started", { turnId: "t1" }, "t1"),
    ]);
    expect(groups(state)).toHaveLength(1);
    expect(groups(state)[0]!.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect(state.blocks.filter((b) => b.kind === "working")).toHaveLength(1);
  });

  it("shows a current-activity row while a prose-only turn is still running", () => {
    const midTurn = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "纯文本回答" } }, "t1"),
    ]);
    // The prose itself stays a top-level assistant block, and the turn's live
    // activity row sits *after* it while the turn is still running.
    expect(assistants(midTurn).map((b) => b.id)).toEqual(["item:m1"]);
    const live = groups(midTurn);
    expect(live).toHaveLength(1);
    expect(live[0]!.children).toHaveLength(0);
    expect(isWorkingActive(live[0]!.status)).toBe(true);
    expect(segmentIsActive(live[0]!)).toBe(true);
    expect(midTurn.groupIndex.get(live[0]!.id)!).toBeGreaterThan(midTurn.index.get("item:m1")!);

    // Once it settles the empty row is gone: no "执行 0 项操作" line is left, but
    // the turn's outcome is still reported.
    applyEvent(midTurn, ev("turn.finished", { turnId: "t1", status: "completed" }, "t1"));
    expect(groups(midTurn)).toHaveLength(0);
    const statuses = midTurn.blocks.filter((b) => b.kind === "status") as Array<{ text: string }>;
    expect(statuses.map((s) => s.text).join(" ")).toContain("本轮完成");
  });

  it("keeps a queued turn out of the running state and off the animation", () => {
    const state = feed([ev("turn.queued", { turnId: "t1", text: "排队" }, "t1")]);
    // A queued turn is honest about waiting; it has no activity row until it runs.
    expect(groups(state)).toHaveLength(0);
    expect(state.turnStatus.get("t1")).toBe("queued");
    expect(isWorkingActive("queued")).toBe(false);
    expect(workingLabel("queued")).toBe("已排队等待");

    // Once it starts, exactly one row appears and it animates.
    applyEvent(state, ev("turn.started", { turnId: "t1" }, "t1"));
    expect(groups(state)).toHaveLength(1);
    expect(groups(state)[0]!.status).toBe("running");
  });

  it("keeps the live row through stopping and clears it on the terminal event", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("turn.interrupt_requested", { turnId: "t1" }, "t1"),
    ]);
    expect(groups(state)).toHaveLength(1);
    expect(groups(state)[0]!.status).toBe("stopping");
    expect(isWorkingActive(groups(state)[0]!.status)).toBe(true);
    expect(segmentIsActive(groups(state)[0]!)).toBe(true);

    applyEvent(state, ev("turn.finished", { turnId: "t1", status: "interrupted" }, "t1"));
    // Nothing was recorded and the turn stopped: the empty row is pruned, and the
    // stop is reported truthfully ("已停止"). The stop notice precedes the live
    // row while stopping, so the row stays bottom-most until it settles.
    expect(groups(state)).toHaveLength(0);
    const statuses = state.blocks.filter((b) => b.kind === "status") as Array<{ text: string }>;
    expect(statuses.map((s) => s.text).join(" ")).toContain("已停止");
    expect(isWorkingActive("stopped")).toBe(false);
  });

  it("reports a failed turn with no tools instead of leaving an empty row", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("turn.failed", { turnId: "t1", message: "启动失败" }, "t1"),
    ]);
    // No tools ran, so no "执行 0 项操作" row is left — but the failure is never
    // hidden: it stays visible as an error status line.
    expect(groups(state)).toHaveLength(0);
    const statuses = state.blocks.filter((b) => b.kind === "status") as Array<{ text: string; level: string }>;
    const failure = statuses.find((s) => s.text.includes("启动失败"));
    expect(failure).toBeDefined();
    expect(failure!.level).toBe("error");
    expect(workingLabel("error")).toBe("执行出错");
    expect(isWorkingActive("error")).toBe(false);
  });

  it("still gives each turn its own row across a multi-turn replay", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/completed", { item: { id: "a1", type: "commandExecution", status: "completed" } }, "t1"),
      ev("turn.finished", { turnId: "t1", status: "completed" }, "t1"),
      ev("turn.started", { turnId: "t2" }, "t2"),
      ev("item/completed", { item: { id: "m2", type: "agentMessage", text: "只有正文" } }, "t2"),
      ev("turn.finished", { turnId: "t2", status: "completed" }, "t2"),
      ev("turn.started", { turnId: "t3" }, "t3"),
    ]);
    const gs = groups(state);
    // t1 recorded a tool; t2 produced only prose (its empty rows settled away);
    // t3 is still live so its activity row is present and empty.
    expect(gs.map((g) => g.turnId)).toEqual(["t1", "t3"]);
    expect(gs.map((g) => g.status)).toEqual(["done", "running"]);
    // Only the genuinely running turn animates and counts as current.
    expect(gs.map((g) => segmentIsActive(g))).toEqual([false, true]);
    expect(gs[0]!.children.map((c) => c.id)).toEqual(["item:a1"]);
    expect(gs[1]!.children).toHaveLength(0);
    // A late tool for the settled first turn joins its own row, not the live one.
    applyEvent(state, ev("item/completed", { item: { id: "late", type: "commandExecution", status: "completed" } }, "t1"));
    expect(groups(state)[0]!.children.map((c) => c.id)).toEqual(["item:a1", "item:late"]);
    expect(groups(state)[1]!.children).toHaveLength(0);
    expect(assistants(state).map((b) => b.id)).toEqual(["item:m2"]);
  });

  it("never surfaces raw reasoning in a row created before its first summary", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("stream.delta", { itemId: "raw", kind: "item/reasoning/textDelta", delta: "RAW COT" }, "t1"),
      ev("item/completed", { item: { id: "raw", type: "reasoning", summary: [], content: ["RAW COT"] } }, "t1"),
    ]);
    expect(groups(state)).toHaveLength(1);
    expect(groups(state)[0]!.children).toHaveLength(0);
    expect(reasonings(state)).toHaveLength(0);
    expect(JSON.stringify(state.blocks)).not.toContain("RAW COT");
  });
});

describe("interleaved activity segments", () => {
  // The user-visible contract: a turn's tools and summaries must not pile up at
  // the top of the turn. Visible prose (and approval cards) split the turn into
  // segments, and the still-running segment is always the last thing on screen.
  it("splits a turn into text / activity / text / activity and keeps the live row last", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "第一段" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "a" } }, "t1"),
      ev("item/completed", { item: { id: "m2", type: "agentMessage", text: "第二段" } }, "t1"),
      ev("item/started", { item: { id: "c2", type: "commandExecution", command: "pwd" } }, "t1"),
    ]);
    // Rendered order: 文本1 — 执行1 — 文本2 — 进行中. The placeholder row opened
    // by turn.started held nothing, so the first boundary pruned it instead of
    // leaving an empty line at the top of the turn.
    expect(state.blocks.map((b) => (b.kind === "working" ? `working(${b.children.length})` : `${b.kind}:${b.id.split(":").pop()}`))).toEqual([
      "assistant:m1",
      "working(1)",
      "assistant:m2",
      "working(1)",
    ]);
    // Exactly one row is the current one, and it is the last block.
    const active = groups(state).filter((g) => segmentIsActive(g));
    expect(active).toHaveLength(1);
    expect(state.blocks[state.blocks.length - 1]!.id).toBe(active[0]!.id);
    // The completed segment kept its place and reports what it did.
    const closed = groups(state).find((g) => g.closed)!;
    expect(closed.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect(segmentLabel(closed)).toBe("执行了 1 项操作");
    expectExactIndexes(state);
  });

  it("does not move a closed segment when later deltas keep arriving", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "开场" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }, "t1"),
      ev("item/completed", { item: { id: "m2", type: "agentMessage", text: "正文" } }, "t1"),
    ]);
    const closedId = groups(state).find((g) => g.closed)!.id;
    const closedBefore = state.groupIndex.get(closedId)!;
    // Streams of deltas for the live prose must not reorder settled history.
    for (const chunk of ["继", "续", "输", "出"]) {
      applyEvent(state, ev("stream.delta", { itemId: "m2", kind: "item/agentMessage/delta", delta: chunk }, "t1"));
    }
    applyEvent(state, ev("item/completed", { item: { id: "m3", type: "agentMessage", text: "再一段" } }, "t1"));
    expect(state.groupIndex.get(closedId)).toBe(closedBefore);
    expect(groups(state).find((g) => g.id === closedId)!.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect(assistants(state).find((b) => b.id === "item:m2")!.text).toBe("正文继续输出");
    expectExactIndexes(state);
  });

  it("updates a late tool completion inside its own original segment", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "slow" } }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "先说话" } }, "t1"),
      ev("item/started", { item: { id: "c2", type: "commandExecution", command: "fast" } }, "t1"),
      ev("item/completed", { item: { id: "c2", type: "commandExecution", status: "completed", aggregatedOutput: "fast" } }, "t1"),
    ]);
    const ids = segmentIds(state, "t1");
    expect(ids).toHaveLength(2);
    // c1's completion lands while c2's segment is the live one.
    applyEvent(state, ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "slow-done" } }, "t1"));
    const first = groups(state).find((g) => g.id === ids[0]!)!;
    const newest = groups(state).find((g) => g.id === ids[1]!)!;
    expect(first.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect((first.children[0] as ToolBlock).output).toBe("slow-done");
    expect((first.children[0] as ToolBlock).status).toBe("done");
    // No duplicate and no move: c2 stayed in the newest segment.
    expect(newest.children.map((c) => c.id)).toEqual(["item:c2"]);
    expect(tools(state).map((t) => t.id)).toEqual(["item:c1", "item:c2"]);
    expectExactIndexes(state);
  });

  it("keeps a late output delta routed to the segment that owns the tool", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "build" } }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "等待中" } }, "t1"),
    ]);
    const ownerId = state.segmentOf.get("item:c1")!;
    applyEvent(state, ev("stream.delta", { itemId: "c1", kind: "item/commandExecution/outputDelta", delta: "late-log" }, "t1"));
    expect(state.segmentOf.get("item:c1")).toBe(ownerId);
    const owner = groups(state).find((g) => g.id === ownerId)!;
    expect((owner.children[0] as ToolBlock).output).toBe("late-log");
    expect(state.blocks.filter((b) => b.kind === "assistant")).toHaveLength(1);
    expectExactIndexes(state);
  });

  it("keeps independent open state per segment and never reopens a closed one", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "中间" } }, "t1"),
    ]);
    const ids = segmentIds(state, "t1");
    expect(ids).toHaveLength(2);
    const first = groups(state).find((g) => g.id === ids[0]!)!;
    // The closed segment keeps its own identity (and therefore its own expand
    // state) even as the live segment grows.
    applyEvent(state, ev("item/started", { item: { id: "c2", type: "commandExecution", command: "pwd" } }, "t1"));
    expect(groups(state).find((g) => g.id === ids[0]!)!.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect(groups(state).find((g) => g.id === ids[1]!)!.children.map((c) => c.id)).toEqual(["item:c2"]);
    expect(segmentIsActive(first)).toBe(false);
  });

  it("produces the same structure from a replay and from step-by-step deltas", () => {
    const events = [
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "第一段" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "x" } }, "t1"),
      ev("item/completed", { item: { id: "m2", type: "agentMessage", text: "第二段" } }, "t1"),
      ev("turn.finished", { turnId: "t1", status: "completed" }, "t1"),
    ];
    const replayed = buildTimeline(events);
    const incremental = emptyTimeline();
    for (const event of events) applyEvent(incremental, event);
    const shape = (state: TimelineState) =>
      state.blocks.map((b) => (b.kind === "working" ? `working:${b.children.map((c) => c.id).join(",")}` : `${b.kind}:${b.id}`));
    expect(shape(incremental)).toEqual(shape(replayed));
  });

  it("gives a second turn its own segments without cross-talk", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "a1", type: "commandExecution", command: "one" } }, "t1"),
      ev("item/completed", { item: { id: "am1", type: "agentMessage", text: "t1 正文" } }, "t1"),
      ev("turn.finished", { turnId: "t1", status: "completed" }, "t1"),
      ev("turn.started", { turnId: "t2" }, "t2"),
      ev("item/started", { item: { id: "b1", type: "commandExecution", command: "two" } }, "t2"),
    ]);
    const t1 = segmentIds(state, "t1");
    const t2 = segmentIds(state, "t2");
    // t1's prose closed its tool run; the empty trailing row was pruned when the
    // turn settled, so only the recorded segment survives.
    expect(t1).toHaveLength(1);
    expect(t2).toHaveLength(1);
    expect(t1).not.toContain(t2[0]);
    expect(groups(state).find((g) => g.id === t1[0]!)!.children.map((c) => c.id)).toEqual(["item:a1"]);
    expect(groups(state).find((g) => g.id === t2[0]!)!.children.map((c) => c.id)).toEqual(["item:b1"]);
    // Only the live second turn's row is current.
    expect(groups(state).filter((g) => segmentIsActive(g)).map((g) => g.turnId)).toEqual(["t2"]);
    expectExactIndexes(state);
  });

  it("never lets an empty agentMessage item open a segment", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "b1", type: "agentMessage" } }, "t1"),
      ev("item/completed", { item: { id: "b1", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }, "t1"),
    ]);
    // One activity run only: the blank bridge item split nothing.
    expect(segmentIds(state, "t1")).toHaveLength(1);
    expect(groups(state)).toHaveLength(1);
    expect(groups(state)[0]!.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect(assistants(state)).toHaveLength(0);
    expectExactIndexes(state);
  });

  it("keeps a blank agentMessage start from occupying the bottom before a tool", () => {
    // The bridge opens a text-less `agentMessage` item, then a tool, then the
    // real prose. The blank start must not create a block that jumps ahead of the
    // tool or steals the live row's bottom slot.
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "真正的正文" } }, "t1"),
    ]);
    // Nothing was materialised for the blank start: the tool is the only child of
    // the still-live first segment, and the prose follows it.
    expect(state.blocks.map((b) => (b.kind === "working" ? `working(${b.children.length})` : `${b.kind}:${b.id.split(":").pop()}`))).toEqual([
      "working(1)",
      "assistant:m1",
      "working(0)",
    ]);
    expect(tools(state).map((t) => t.id)).toEqual(["item:c1"]);
    const active = groups(state).filter((g) => segmentIsActive(g));
    expect(active).toHaveLength(1);
    expect(state.blocks[state.blocks.length - 1]!.id).toBe(active[0]!.id);
    expectExactIndexes(state);
  });

  it("appends a live tool before prose when the prose start is empty", () => {
    // Stream order start(empty m1) → tool c1 → delta(m1): the delta is the first
    // real prose, so the tool segment closes above it and the live row trails.
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("stream.delta", { itemId: "m1", kind: "item/agentMessage/delta", delta: "正文" }, "t1"),
    ]);
    expect(assistants(state)).toHaveLength(1);
    expect(assistants(state)[0]!.text).toBe("正文");
    const segments = groups(state);
    expect(segments[0]!.closed).toBe(true);
    expect(segments[0]!.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect(segmentIsActive(segments[segments.length - 1]!)).toBe(true);
    expectExactIndexes(state);
  });

  it("treats an approval card as a boundary that stays visible above the live row", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "rm" } }, "t1"),
      ev("approval.requested", { requestId: "r1", method: "item/commandExecution/requestApproval", params: { command: "rm" } }, "t1"),
    ]);
    const approval = state.blocks.find((b) => b.kind === "approval")!;
    const live = state.blocks[state.blocks.length - 1]!;
    // The card is a top-level block, before the live row, and never hidden.
    expect(approval).toBeDefined();
    expect(state.index.get(approval.id)!).toBeLessThan(state.index.get(live.id)!);
    expect(state.blocks.filter((b) => b.kind === "working").map((g) => (g as WorkingBlock).closed)).toEqual([true, false]);
    expect(segmentIsActive(groups(state)[1]!)).toBe(true);
    expectExactIndexes(state);
  });

  it("reports queued/stopped/unknown/error truthfully without faking success", () => {
    const settled = (status: string) =>
      feed([
        ev("turn.started", { turnId: "t1" }, "t1"),
        ev("item/started", { item: { id: "c1", type: "commandExecution", command: "x" } }, "t1"),
        ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }, "t1"),
        ev("turn.finished", { turnId: "t1", status }, "t1"),
      ]);
    expect(segmentLabel(groups(settled("completed"))[0]!)).toBe("执行了 1 项操作");
    expect(segmentLabel(groups(settled("interrupted"))[0]!)).toBe("执行了 1 项操作 · 已停止");
    expect(segmentLabel(groups(settled("unknown"))[0]!)).toBe("执行了 1 项操作 · 结果未知");
    // A queued turn never animates.
    const queued = feed([ev("turn.queued", { turnId: "tq", text: "排队" }, "tq")]);
    expect(groups(queued)).toHaveLength(0);
    expect(isWorkingActive("queued")).toBe(false);
    // A failed turn keeps its error wording instead of claiming success.
    const failed = feed([
      ev("turn.started", { turnId: "tf" }, "tf"),
      ev("turn.failed", { turnId: "tf", message: "boom" }, "tf"),
    ]);
    expect(workingLabel("error")).toBe("执行出错");
    expect(groups(failed).every((g) => !segmentIsActive(g))).toBe(true);
  });

  it("never calls a closed history segment '处理中…', even while its turn still runs", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("stream.delta", { itemId: "r1", kind: "item/reasoning/summaryTextDelta", delta: "先想一下" }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "说点什么" } }, "t1"),
    ]);
    const history = groups(state)[0]!;
    expect(history.closed).toBe(true);
    expect(history.status).toBe("running");
    // A summary-only history segment reads as a finished summary, never Working.
    expect(segmentLabel(history)).toBe("思考摘要");
    expect(segmentLabel(history)).not.toContain("Working");
    // And it must not be treated as the current row: only the trailing row is.
    expect(segmentIsActive(history)).toBe(false);
    expect(segmentStatusTone(history)).toBe("history");
    const live = groups(state)[1]!;
    expect(segmentIsActive(live)).toBe(true);
    expect(segmentStatusTone(live)).toBe("active");
    expect(segmentLabel(live)).toBe("处理中…");
  });

  it("orders reasoning → assistant prose → live row and labels each honestly", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("stream.delta", { itemId: "r1", kind: "item/reasoning/summaryTextDelta", delta: "推理摘要" }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "第一段正文" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
    ]);
    // The live row is the last thing on screen; the summary segment precedes the
    // prose it was closed by.
    const segments = groups(state);
    expect(segments.map((g) => g.turnId)).toEqual(["t1", "t1"]);
    expect(state.groupIndex.get(segments[0]!.id)!).toBeLessThan(state.index.get("item:m1")!);
    expect(state.index.get("item:m1")!).toBeLessThan(state.groupIndex.get(segments[1]!.id)!);
    // History keeps the neutral wording; the live row is the only "处理中…".
    expect(segmentLabel(segments[0]!)).toBe("思考摘要");
    expect(segmentStatusTone(segments[0]!)).toBe("history");
    expect(segmentLabel(segments[1]!)).toBe("处理中…");
    expect(segmentStatusTone(segments[1]!)).toBe("active");
  });

  it("flags a real tool error on a history segment instead of a neutral mark", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "f1", type: "commandExecution", command: "boom" } }, "t1"),
      ev("item/completed", { item: { id: "f1", type: "commandExecution", status: "failed" } }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "出错了" } }, "t1"),
    ]);
    const history = groups(state)[0]!;
    expect(history.closed).toBe(true);
    expect(segmentStatusTone(history)).toBe("error");
    expect(segmentLabel(history)).toBe("执行了 1 项操作 · 出错");
  });

  it("counts operations exactly once in the history label", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "one" } }, "t1"),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed" } }, "t1"),
      ev("item/started", { item: { id: "c2", type: "commandExecution", command: "two" } }, "t1"),
      ev("item/completed", { item: { id: "c2", type: "commandExecution", status: "completed" } }, "t1"),
      ev("stream.delta", { itemId: "r1", kind: "item/reasoning/summaryTextDelta", delta: "摘要一" }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "结束" } }, "t1"),
    ]);
    const history = groups(state)[0]!;
    // One label states the tool count exactly once; the meta only adds summaries.
    expect(segmentLabel(history)).toBe("执行了 2 项操作");
    expect((segmentLabel(history).match(/2/g) ?? []).length).toBe(1);
  });

  it("keeps a closed segment's children honest once the turn ends without their completion", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "sleep" } }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "等待" } }, "t1"),
      ev("turn.finished", { turnId: "t1", status: "interrupted" }, "t1"),
    ]);
    const first = groups(state)[0]!;
    expect(first.closed).toBe(true);
    const tool = first.children[0]! as ToolBlock;
    // The recorded status is untouched; only the "in progress" presentation stops.
    expect(tool.status).toBe("running");
    expect(childInProgress(first, tool)).toBe(false);
    expect(segmentLabel(first)).toBe("执行了 1 项操作 · 已停止");
  });
});

describe("blank agentMessage items", () => {
  // The bridge model emits an empty `agentMessage` item before each tool call:
  // `item/started` and `item/completed` both carry `text === ""` and no delta
  // ever arrives. None of that may reach the screen as an empty bubble.
  it("produces no assistant bubble for a blank started + completed pair with no delta", () => {
    const state = feed([
      ev("item/started", { item: { id: "blank1", type: "agentMessage" } }, "t1"),
      ev("item/completed", { item: { id: "blank1", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "ok" } }, "t1"),
    ]);
    expect(assistants(state)).toHaveLength(0);
    expect(state.index.has("item:blank1")).toBe(false);
    // The real tool of that turn is untouched.
    expect(tools(state).map((t) => t.id)).toEqual(["item:c1"]);
    expectExactIndexes(state);
  });

  it("stays empty when the same blank item/started is written twice", () => {
    // Stored history really does contain a duplicated `item/started` with the
    // identical payload and id; the second one must not rebuild a blank bubble.
    const state = feed([
      ev("item/started", { item: { id: "blank2", type: "agentMessage" } }, "t1"),
      ev("item/started", { item: { id: "blank2", type: "agentMessage" } }, "t1"),
      ev("item/completed", { item: { id: "blank2", type: "agentMessage", text: "" } }, "t1"),
    ]);
    expect(assistants(state)).toHaveLength(0);
    expect(state.index.has("item:blank2")).toBe(false);
    expectExactIndexes(state);

    // A duplicate `item/started` arriving after the blank completion is equally
    // inert, and the maps stay exact.
    applyEvent(state, ev("item/started", { item: { id: "blank2", type: "agentMessage" } }, "t1"));
    expect(assistants(state)).toHaveLength(0);
    expectExactIndexes(state);
  });

  it("ignores a blank completed item that arrives before its item/started", () => {
    const state = feed([
      ev("item/completed", { item: { id: "blank3", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "blank3", type: "agentMessage" } }, "t1"),
    ]);
    expect(assistants(state)).toHaveLength(0);
    expect(state.index.has("item:blank3")).toBe(false);
    expectExactIndexes(state);
  });

  it("still renders real prose after a blank completion for the same id", () => {
    // Out-of-order recovery: the blank completion came first, but the item did
    // produce genuine prose. Nothing may be swallowed permanently.
    const delayed = feed([
      ev("item/completed", { item: { id: "late1", type: "agentMessage", text: "" } }, "t1"),
      ev("stream.delta", { itemId: "late1", kind: "item/agentMessage/delta", delta: "真实回答" }, "t1"),
    ]);
    expect(assistants(delayed)).toHaveLength(1);
    expect(assistants(delayed)[0]!.text).toBe("真实回答");
    expectExactIndexes(delayed);

    const viaCompleted = feed([
      ev("item/completed", { item: { id: "late2", type: "agentMessage", text: "" } }, "t1"),
      ev("item/completed", { item: { id: "late2", type: "agentMessage", text: "补上的正文" } }, "t1"),
    ]);
    expect(assistants(viaCompleted)).toHaveLength(1);
    expect(assistants(viaCompleted)[0]!.text).toBe("补上的正文");
    expect(assistants(viaCompleted)[0]!.streaming).toBe(false);
    expectExactIndexes(viaCompleted);
  });

  it("recovers a late item/started with real delta text that follows a blank completion", () => {
    const state = feed([
      ev("item/completed", { item: { id: "late3", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "late3", type: "agentMessage" } }, "t1"),
      ev("stream.delta", { itemId: "late3", kind: "item/agentMessage/delta", delta: "增量正文" }, "t1"),
    ]);
    expect(assistants(state)).toHaveLength(1);
    expect(assistants(state)[0]!.text).toBe("增量正文");
    expect(assistants(state)[0]!.streaming).toBe(true);
    expectExactIndexes(state);
  });

  it("keeps prose buffered from real deltas out of the blank rule", () => {
    const state = feed([
      ev("item/started", { item: { id: "m5", type: "agentMessage" } }, "t1"),
      ev("stream.delta", { itemId: "m5", kind: "item/agentMessage/delta", delta: "PROBE" }),
      ev("stream.delta", { itemId: "m5", kind: "item/agentMessage/delta", delta: "_OK" }),
      ev("item/completed", { item: { id: "m5", type: "agentMessage", text: "PROBE_OK" } }, "t1"),
    ]);
    expect(assistants(state)).toHaveLength(1);
    expect(assistants(state)[0]!.text).toBe("PROBE_OK");
    expect(assistants(state)[0]!.streaming).toBe(false);
    expectExactIndexes(state);
  });

  it("keeps whitespace-only completed text out of the timeline but never drops a neighbour", () => {
    const state = feed([
      ev("item/completed", { item: { id: "keep", type: "agentMessage", text: "保留的正文" } }, "t1"),
      ev("item/started", { item: { id: "ws", type: "agentMessage" } }, "t1"),
      ev("item/completed", { item: { id: "ws", type: "agentMessage", text: "   \n\n" } }, "t1"),
    ]);
    expect(assistants(state).map((b) => b.id)).toEqual(["item:keep"]);
    expect(state.index.get("item:keep")).toBe(0);
    expectExactIndexes(state);
  });

  it("never lets an empty delta create a blank bubble", () => {
    const state = feed([
      ev("item/agentMessage/delta", { itemId: "e1", delta: "" }, "t1"),
      ev("stream.delta", { itemId: "e2", kind: "item/agentMessage/delta", delta: "" }, "t1"),
    ]);
    expect(assistants(state)).toHaveLength(0);
    expect(state.index.size).toBe(0);
  });

  it("never deletes real prose when a duplicate empty completion follows it", () => {
    const state = feed([
      ev("item/started", { item: { id: "m6", type: "agentMessage" } }, "t1"),
      ev("item/completed", { item: { id: "m6", type: "agentMessage", text: "真实正文" } }, "t1"),
      // A replayed/duplicated empty completion must not overwrite or delete it.
      ev("item/completed", { item: { id: "m6", type: "agentMessage", text: "" } }, "t1"),
    ]);
    expect(assistants(state)).toHaveLength(1);
    expect(assistants(state)[0]!.text).toBe("真实正文");
    expect(assistants(state)[0]!.streaming).toBe(false);
    expectExactIndexes(state);
  });

  it("never duplicates the block when a non-empty item/started arrives twice", () => {
    // Two separate events, same item id, both carrying real text: only one block
    // may exist, and the live row must still be last.
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "m1", type: "agentMessage", text: "hello" } }, "t1"),
      ev("item/started", { item: { id: "m1", type: "agentMessage", text: "hello" } }, "t1"),
    ]);
    expect(assistants(state).map((b) => b.id)).toEqual(["item:m1"]);
    expect(assistants(state)[0]!.text).toBe("hello");
    const active = groups(state).filter((g) => segmentIsActive(g));
    expect(active).toHaveLength(1);
    expect(state.blocks[state.blocks.length - 1]!.id).toBe(active[0]!.id);
    expect(state.blocks[state.blocks.length - 1]!.kind).toBe("working");
    expectExactIndexes(state);
  });

  it("keeps a late item/started from restoring streaming on settled prose", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "已结算正文" } }, "t1"),
    ]);
    const before = assistants(state)[0]!;
    expect(before.streaming).toBe(false);
    // A replayed `item/started` (real text or not) must neither duplicate nor
    // flip the settled block back to streaming.
    applyEvent(state, ev("item/started", { item: { id: "m1", type: "agentMessage", text: "已结算正文" } }, "t1"));
    applyEvent(state, ev("item/started", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"));
    expect(assistants(state).map((b) => b.id)).toEqual(["item:m1"]);
    expect(assistants(state)[0]!.text).toBe("已结算正文");
    expect(assistants(state)[0]!.streaming).toBe(false);
    expectExactIndexes(state);
  });

  it("lets a real non-empty start outrank a stale blank marker", () => {
    // A blank completion first marked the id as content-free; a later non-empty
    // item/started carries genuine prose and must still build its block.
    const state = feed([
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "m1", type: "agentMessage", text: "迟到的正文" } }, "t1"),
    ]);
    expect(assistants(state).map((b) => b.id)).toEqual(["item:m1"]);
    expect(assistants(state)[0]!.text).toBe("迟到的正文");
    expect(assistants(state)[0]!.streaming).toBe(true);
    expectExactIndexes(state);
  });

  it("does not split a tool segment when a blank start never gains prose", () => {
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "ok" } }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "" } }, "t1"),
      ev("turn.finished", { turnId: "t1", status: "completed" }, "t1"),
    ]);
    // One activity run only; the blank start/completion split nothing.
    expect(segmentIds(state, "t1")).toHaveLength(1);
    expect(groups(state)).toHaveLength(1);
    expect(groups(state)[0]!.children.map((c) => c.id)).toEqual(["item:c1"]);
    expect(assistants(state)).toHaveLength(0);
    expectExactIndexes(state);
  });

  it("drops a blank assistant bubble during a legacy history replay, leaving the tools", () => {
    // A whole stored conversation: the bridge's blank prose items interleaved
    // with real tool calls, replayed in one pass exactly as the client does.
    const state = feed([
      ev("turn.started", { turnId: "t1" }, "t1"),
      ev("item/started", { item: { id: "b1", type: "agentMessage" } }, "t1"),
      ev("item/started", { item: { id: "b1", type: "agentMessage" } }, "t1"),
      ev("item/completed", { item: { id: "b1", type: "agentMessage", text: "" } }, "t1"),
      ev("item/started", { item: { id: "c1", type: "commandExecution", command: "ls" } }, "t1"),
      ev("item/completed", { item: { id: "c1", type: "commandExecution", status: "completed", aggregatedOutput: "a\nb" } }, "t1"),
      ev("item/completed", { item: { id: "m1", type: "agentMessage", text: "最终回答" } }, "t1"),
      ev("turn.finished", { turnId: "t1", status: "completed" }, "t1"),
    ]);
    expect(assistants(state).map((b) => b.id)).toEqual(["item:m1"]);
    expect(tools(state).map((t) => t.id)).toEqual(["item:c1"]);
    expect(groups(state)[0]!.children.map((c) => c.id)).toEqual(["item:c1"]);
    expectExactIndexes(state);
  });
});

import { describe, expect, it } from "vitest";
import { applyEvent, buildTimeline, emptyTimeline, removeBlock } from "../../src/web/src/timeline";
import type { AgentEvent } from "../../src/web/src/types";

let seq = 0;
function ev(type: string, payload: Record<string, unknown>): AgentEvent {
  seq += 1;
  return { id: seq, type, turnId: null, createdAt: Date.now(), payload };
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
    const tool = state.blocks.find((b) => b.kind === "tool") as { detail: string; status: string; output: string };
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
});

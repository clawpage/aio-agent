/**
 * Translate Claude Code `--output-format stream-json` lines into the Codex
 * app-server notifications the rest of the control plane already persists and
 * renders (`item/started`, `item/agentMessage/delta`, `item/completed`). Keeping
 * the Codex shape means the event store, task results and timeline need no
 * harness-specific branches.
 *
 * Only top-level events are surfaced: a sub-agent's own messages carry a
 * `parent_tool_use_id` and stay inside its Task tool call, like Codex keeps a
 * sub-agent's internals out of the main timeline.
 */

export type Emit = (method: string, params: Record<string, unknown>) => void;

/** Bound one tool output stored in an event; the sandbox keeps the real data. */
export const MAX_TOOL_OUTPUT_CHARS = 50_000;

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

type Json = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…（输出过长，已截断）` : text;
}

/** A short, human label for a generic tool call. */
function summarize(input: Json): string {
  for (const key of ["file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
    const value = str(input[key]).trim();
    if (value) return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  }
  return "";
}

/** The Codex-shaped item a Claude Code tool call is shown as. */
export function toolItem(id: string, name: string, input: Json, cwd: string): Json {
  if (name === "Bash") return { type: "commandExecution", id, command: str(input.command), cwd };
  if (FILE_TOOLS.has(name)) {
    return { type: "fileChange", id, changes: [{ path: str(input.file_path) || str(input.notebook_path), kind: name === "Write" ? "add" : "update" }] };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { type: "mcpToolCall", id, server: mcp[1], tool: mcp[2], arguments: input };
  if (name === "WebSearch") return { type: "webSearch", id, query: str(input.query), title: str(input.query) };
  return { type: name, id, title: summarize(input) };
}

/** Text of a `tool_result` content (a string or a list of blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const b = (block ?? {}) as Json;
      if (b.type === "text") return str(b.text);
      if (b.type === "image") return "[图片]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export class ClaudeStreamTranslator {
  #threadId: string;
  #turnId: string;
  #cwd: string;
  #emit: Emit;
  #messageId = "";
  #counter = 0;
  /** Text block currently streaming (opened by a partial `content_block_start`). */
  #openText: string | null = null;
  #startedText = new Set<string>();
  #tools = new Map<string, Json>();

  constructor(threadId: string, turnId: string, cwd: string, emit: Emit) {
    this.#threadId = threadId;
    this.#turnId = turnId;
    this.#cwd = cwd;
    this.#emit = emit;
  }

  #send(method: string, params: Json): void {
    this.#emit(method, { threadId: this.#threadId, turnId: this.#turnId, ...params });
  }

  handle(event: Json): void {
    if (event.parent_tool_use_id) return;
    switch (event.type) {
      case "stream_event":
        this.#streamEvent((event.event ?? {}) as Json);
        return;
      case "assistant":
        this.#assistant(event);
        return;
      case "user":
        if (!event.isReplay) this.#toolResults(event);
        return;
    }
  }

  #streamEvent(e: Json): void {
    if (e.type === "message_start") {
      this.#messageId = str(((e.message ?? {}) as Json).id) || this.#messageId;
      return;
    }
    if (e.type === "content_block_start") {
      const block = (e.content_block ?? {}) as Json;
      if (block.type !== "text") return;
      const id = `${this.#messageId || "msg"}:${String(e.index ?? this.#counter++)}`;
      this.#openText = id;
      this.#startedText.add(id);
      this.#send("item/started", { item: { type: "agentMessage", id, text: "" } });
      return;
    }
    if (e.type === "content_block_delta") {
      const delta = (e.delta ?? {}) as Json;
      if (delta.type === "text_delta" && this.#openText && str(delta.text)) {
        this.#send("item/agentMessage/delta", { itemId: this.#openText, delta: str(delta.text) });
      }
    }
  }

  #assistant(event: Json): void {
    const message = (event.message ?? {}) as Json;
    const messageId = str(message.id) || this.#messageId || "msg";
    // A synthetic error message (e.g. "Not logged in") is reported as the turn's
    // failure, never as the assistant's answer.
    if (event.error) {
      this.#openText = null;
      return;
    }
    const blocks = Array.isArray(message.content) ? (message.content as Json[]) : [];
    for (const block of blocks) {
      if (block.type === "text") {
        const id = this.#openText ?? `${messageId}:c${this.#counter++}`;
        this.#openText = null;
        if (!this.#startedText.has(id)) {
          this.#startedText.add(id);
          this.#send("item/started", { item: { type: "agentMessage", id, text: "" } });
        }
        this.#send("item/completed", { item: { type: "agentMessage", id, text: str(block.text) } });
      } else if (block.type === "thinking" && str(block.thinking).trim()) {
        this.#send("item/completed", { item: { type: "reasoning", id: `${messageId}:r${this.#counter++}`, summary: [str(block.thinking)] } });
      } else if (block.type === "tool_use") {
        const id = str(block.id);
        const item = toolItem(id, str(block.name), (block.input ?? {}) as Json, this.#cwd);
        this.#tools.set(id, item);
        this.#send("item/started", { item: { ...item, status: "inProgress" } });
      }
    }
  }

  #toolResults(event: Json): void {
    const content = ((event.message ?? {}) as Json).content;
    if (!Array.isArray(content)) return;
    for (const block of content as Json[]) {
      if (block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const item = this.#tools.get(id);
      if (!item) continue;
      this.#tools.delete(id);
      const output = clip(toolResultText(block.content));
      const status = block.is_error ? "failed" : "completed";
      const outputKey = item.type === "commandExecution" ? "aggregatedOutput" : "output";
      this.#send("item/completed", { item: { ...item, status, [outputKey]: output } });
    }
  }

  /** Close tool calls that never got a result (stop, crash): they did not finish. */
  settleOpenTools(): void {
    for (const item of this.#tools.values()) this.#send("item/completed", { item: { ...item, status: "failed" } });
    this.#tools.clear();
  }
}

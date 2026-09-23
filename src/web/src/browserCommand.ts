/**
 * Recognition for "the agent just navigated the sandbox browser", used by the
 * console to reveal the workspace browser automatically.
 *
 * Matching is deliberately strict so an echo, log line or quoted string that
 * merely *contains* `aio browser navigate` is never mistaken for a real command:
 * a shell segment has to actually start with it. Shell separators (`&&`, `||`,
 * `;`, `|`, newline) begin a new segment, matching the executable positions of a
 * compound command — but only when they appear *outside* quotes, so
 * `echo "x && aio browser navigate ..."` stays a single `echo` segment.
 */

/** Matches `aio browser navigate` at the very start of a command segment. */
const NAVIGATE_AT_START = /^aio\s+browser\s+navigate(?:\s|$)/;

/**
 * Split a shell command into segments on separators that are not inside single
 * or double quotes. Quotes are kept in the segment text; this only needs to be
 * good enough to tell which segments could start a command, not to fully parse
 * shell quoting (escaped quotes are handled, command substitution is not).
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += command[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    const next = command[i + 1];
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments;
}

/** True when a shell command actually runs `aio browser navigate`. */
export function isBrowserNavigateCommand(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  return splitSegments(command).some((segment) => NAVIGATE_AT_START.test(segment.trim()));
}

/** True for the registered `aio_browser` MCP server's `browser_navigate` tool. */
export function isBrowserNavigateTool(server: unknown, tool: unknown): boolean {
  return server === "aio_browser" && tool === "browser_navigate";
}

/**
 * Decide from a raw `item/started` item whether the agent opened the sandbox
 * browser. Covers both the `aio` CLI (`commandExecution`) and the MCP tool
 * (`mcpToolCall`) shapes; every other item is ignored.
 */
export function itemOpensSandboxBrowser(item: Record<string, unknown> | null | undefined): boolean {
  if (!item || typeof item !== "object") return false;
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "commandExecution") return isBrowserNavigateCommand(item.command);
  if (type === "mcpToolCall") return isBrowserNavigateTool(item.server, item.tool);
  return false;
}

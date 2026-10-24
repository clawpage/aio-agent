/**
 * A final answer still being written, as the main session shows it: a code block that has
 * not closed yet (a card, chart or map half written) is left out until its closing fence
 * arrives, so half a JSON never shows as raw code. Fences (``` or ~~~) open and close the
 * way Markdown does: a closing fence uses the same character, at least as many of it.
 * A daily feed's machine lines (`<!-- feed-… -->`, never shown) are cut off as they begin.
 */
export function draftSource(text: string): string {
  const lines = text.split(/<!--\s*feed-/)[0]!.split("\n");
  let open: { at: number; char: string; size: number } | null = null;
  for (const [at, line] of lines.entries()) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence) continue;
    const run = fence[1]!;
    if (!open) open = { at, char: run[0]!, size: run.length };
    else if (run[0] === open.char && run.length >= open.size && !line.trim().slice(run.length).trim()) open = null;
  }
  const kept = open ? lines.slice(0, open.at) : lines;
  // A fence still arriving one backtick at a time.
  if (!open && /^\s{0,3}(`{1,2}|~{1,2})$/.test(kept.at(-1) ?? "")) kept.pop();
  return kept.join("\n").trimEnd();
}

/** The final answer an execution conversation is writing: which item it is, and its text so far. */
export type Draft = { item: string; text: string } | null;

/**
 * One event of an execution conversation's stream, applied to the answer it is writing.
 * Codex marks its final answer (`phase: "final_answer"`) when the item starts; any item
 * started after it (a steer, more work) means that answer is not the last word any more.
 * A replay from the beginning ends where the live stream is: each answer starts from empty.
 */
export function nextDraft(draft: Draft, event: { type: string; payload: unknown }): Draft {
  const p = (event.payload ?? {}) as { item?: { type?: string; id?: string; phase?: string; text?: string }; itemId?: string; kind?: string; delta?: string };
  switch (event.type) {
    case "item/started":
      return p.item?.type === "agentMessage" && p.item.phase === "final_answer" && typeof p.item.id === "string" ? { item: p.item.id, text: "" } : null;
    case "stream.delta":
      return draft && p.itemId === draft.item && p.kind === "item/agentMessage/delta" && typeof p.delta === "string" ? { ...draft, text: draft.text + p.delta } : draft;
    case "item/completed":
      return draft && p.item?.id === draft.item && typeof p.item.text === "string" ? { ...draft, text: p.item.text } : draft;
    case "turn.queued": case "turn.started": case "turn.input_appended":
      return null;
    default:
      return draft;
  }
}

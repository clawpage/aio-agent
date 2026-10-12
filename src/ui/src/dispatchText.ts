/**
 * What the person asked, out of the message the main session dispatched to an
 * execution session. That message carries the executor's whole brief (rules,
 * related tasks, the main-session timeline) before the task itself; on the
 * execution page the task is what matters, the brief is there on demand.
 *
 * Display only: it reads the shape the control plane writes (the dispatch
 * prompt in src/control/tasks/service.ts), and anything else is shown in full.
 */
// Both the English prompts and the Chinese ones written before them.
const DISPATCH_HEADS = ["You are a sub-agent delegated by AIO Agent's main session", "你是 AIO Agent 主会话委派的子 agent"]; // i18n-exempt: matches the control plane's dispatch prompt
const TASK_MARKERS = ["\n\nThe user's task this time:\n\n", "\n\n本次用户任务：\n\n"]; // i18n-exempt: matches the control plane's dispatch prompt
// The account's language line closes a prompt, after the person's words.
const LANGUAGE_LINE = "\n\nLanguage: write everything the user will see"; // i18n-exempt: matches the control plane's language line (src/control/locale.ts)

// A supplement steered into a running turn: an optional note that the browser was handed back, then this head.
const SUPPLEMENT_HEAD = /^(?:(?:When the user sent this supplement|用户发这条补充时)[^\n]*\n\n)?(?:This is the user's supplement to the current task, sent at \d{1,2}:\d{2}|这是用户在 \d{1,2}:\d{2} 对当前任务的补充)/; // i18n-exempt: matches the control plane's steer prompt
const SUPPLEMENT_MARKERS = ["\n\nThe user's supplement:\n\n", "\n\n本次用户补充：\n\n"]; // i18n-exempt: matches the control plane's steer prompt
// Written before the marker existed: the person's words follow the dispatcher's judgment line.
const LEGACY_JUDGMENT = "\n\n派单器的判断（仅作背景）："; // i18n-exempt: matches the control plane's steer prompt
const LEGACY_DEPENDENCIES = "\n\n补充所需的已完成任务资料："; // i18n-exempt: matches the control plane's steer prompt

/** The person's words after the last of `markers`, without the language line that may close the prompt. */
function after(message: string, markers: string[]): string | null {
  for (const marker of markers) {
    const at = message.lastIndexOf(marker);
    if (at <= 0) continue;
    const rest = message.slice(at + marker.length);
    const end = rest.lastIndexOf(LANGUAGE_LINE);
    return (end >= 0 ? rest.slice(0, end) : rest).trim() || null;
  }
  return null;
}

/** What the person added, out of a supplement steered into a running execution turn. */
export function dispatchedSupplement(message: string): string | null {
  if (!SUPPLEMENT_HEAD.test(message)) return null;
  const added = after(message, SUPPLEMENT_MARKERS);
  if (added) return added;
  const judged = message.lastIndexOf(LEGACY_JUDGMENT);
  if (judged < 0) return null;
  const rest = message.slice(judged + LEGACY_JUDGMENT.length);
  const end = rest.indexOf("\n\n");
  if (end < 0) return null;
  const words = rest.slice(end + 2);
  const deps = words.indexOf(LEGACY_DEPENDENCIES);
  return (deps >= 0 ? words.slice(0, deps) : words).trim() || null;
}

export function dispatchedTask(message: string): string | null {
  if (!DISPATCH_HEADS.some(head => message.startsWith(head))) return null;
  return after(message, TASK_MARKERS);
}

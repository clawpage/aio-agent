/**
 * What the person asked, out of the message the main session dispatched to an
 * execution session. That message carries the executor's whole brief (rules,
 * related tasks, the main-session timeline) before the task itself; on the
 * execution page the task is what matters, the brief is there on demand.
 *
 * Display only: it reads the shape the control plane writes (the dispatch
 * prompt in src/control/tasks/service.ts), and anything else is shown in full.
 */
const DISPATCH_HEAD = "你是 AIO Agent 主会话委派的子 agent"; // i18n-exempt: matches the control plane's dispatch prompt
const TASK_MARKER = "\n\n本次用户任务：\n\n"; // i18n-exempt: matches the control plane's dispatch prompt

// A supplement steered into a running turn: an optional note that the browser was handed back, then this head.
const SUPPLEMENT_HEAD = /^(?:用户发这条补充时[^\n]*\n\n)?这是用户在 \d{1,2}:\d{2} 对当前任务的补充/; // i18n-exempt: matches the control plane's steer prompt
const SUPPLEMENT_MARKER = "\n\n本次用户补充：\n\n"; // i18n-exempt: matches the control plane's steer prompt
// Written before the marker existed: the person's words follow the dispatcher's judgment line.
const LEGACY_JUDGMENT = "\n\n派单器的判断（仅作背景）："; // i18n-exempt: matches the control plane's steer prompt
const LEGACY_DEPENDENCIES = "\n\n补充所需的已完成任务资料："; // i18n-exempt: matches the control plane's steer prompt

/** What the person added, out of a supplement steered into a running execution turn. */
export function dispatchedSupplement(message: string): string | null {
  if (!SUPPLEMENT_HEAD.test(message)) return null;
  const at = message.lastIndexOf(SUPPLEMENT_MARKER);
  if (at > 0) return message.slice(at + SUPPLEMENT_MARKER.length).trim() || null;
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
  if (!message.startsWith(DISPATCH_HEAD)) return null;
  const at = message.lastIndexOf(TASK_MARKER);
  const task = at > 0 ? message.slice(at + TASK_MARKER.length).trim() : "";
  return task || null;
}

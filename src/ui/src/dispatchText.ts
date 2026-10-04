/**
 * What the person asked, out of the message the main session dispatched to an
 * execution session. That message carries the executor's whole brief (rules,
 * related tasks, the main-session timeline) before the task itself; on the
 * execution page the task is what matters, the brief is there on demand.
 *
 * Display only: it reads the shape the control plane writes (the dispatch
 * prompt in src/control/tasks/service.ts), and anything else is shown in full.
 */
const DISPATCH_HEAD = "你是 AIO Agent 主会话委派的子 agent";
const TASK_MARKER = "\n\n本次用户任务：\n\n";

export function dispatchedTask(message: string): string | null {
  if (!message.startsWith(DISPATCH_HEAD)) return null;
  const at = message.lastIndexOf(TASK_MARKER);
  const task = at > 0 ? message.slice(at + TASK_MARKER.length).trim() : "";
  return task || null;
}

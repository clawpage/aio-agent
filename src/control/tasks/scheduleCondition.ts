/**
 * A schedule's condition: a short bash, Python or Node.js snippet that runs in the
 * account's own sandbox each time the schedule is due. Exit 0 = the condition is
 * met and the run starts (its output goes to the executor); exit 1 = not met, the
 * run is skipped and nothing reaches a model; anything else, a timeout or a
 * sandbox that cannot run it = an error, skipped too. Never runs in the control plane.
 */
import { t } from "../i18n/index.js";
import type { ResourceSandbox } from "./resources.js";

export type ConditionLanguage = "bash" | "python" | "node";
export interface ScheduleCondition { language: ConditionLanguage; code: string }
export type ConditionResult = "fired" | "skipped" | "error";
/** How the last check went, as the schedules page shows it. */
export interface ConditionCheck {
  at: number;
  result: ConditionResult;
  /** error only: timeout, exit (any code but 0 and 1), or unavailable (the sandbox did not run it). */
  error?: "timeout" | "exit" | "unavailable";
  exitCode?: number;
  /** The start of what it printed (stdout and stderr). */
  output?: string;
}

export const CONDITION_LANGUAGES: ConditionLanguage[] = ["bash", "python", "node"];
export const MAX_CONDITION_CODE = 4000;
/** A check is stopped after this long (inside the container, with its child processes). */
export const CONDITION_TIMEOUT_SECONDS = 60;
/** What a check may print and hand on to the run. */
export const MAX_CONDITION_OUTPUT = 4000;
/** What the schedules page keeps of the last check's output. */
const SHOWN_OUTPUT = 300;
const EXIT_MARK = "__AIO_CONDITION_EXIT__=";

/**
 * Runs inside the sandbox as the sandbox user: the snippet under `timeout` (killed
 * 5 s after it is asked to stop), output to a file so a long print is cut here, not
 * by a broken pipe, then its exit code on a last line of its own.
 */
const RUNNER = `lang=$1; secs=$2; cap=$3; dir=$4; code=$5
case "$lang" in
  bash) set -- bash -c "$code" ;;
  python) set -- python3 -c "$code" ;;
  node) set -- node -e "$code" ;;
  *) exit 97 ;;
esac
cd "$dir" 2>/dev/null || cd "$HOME" 2>/dev/null || cd /
out=$(mktemp) || exit 98
timeout -k 5 "$secs" "$@" >"$out" 2>&1 </dev/null
rc=$?
head -c "$cap" "$out"
rm -f "$out"
printf '\\n${EXIT_MARK}%d\\n' "$rc"`;

/** A condition as given (to create, change or remove one): checked, or why it cannot be used. `null` removes it. */
export function validateCondition(raw: unknown): { condition: ScheduleCondition | null } | { error: string } {
  const invalid = t().tasks.schedules.invalid;
  if (raw === null) return { condition: null };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: invalid.conditionNotObject };
  const r = raw as Record<string, unknown>;
  const language = r.language as ConditionLanguage;
  if (!CONDITION_LANGUAGES.includes(language)) return { error: invalid.conditionLanguage(CONDITION_LANGUAGES.join("/")) };
  const code = typeof r.code === "string" ? r.code.trim() : "";
  if (!code || code.length > MAX_CONDITION_CODE || code.includes("\0")) return { error: invalid.conditionCode(MAX_CONDITION_CODE) };
  return { condition: { language, code } };
}

/** Run one check in the sandbox. Never throws: a sandbox that cannot run it is an error result. */
export async function checkCondition(sandbox: ResourceSandbox, condition: ScheduleCondition, workdir: string, now: () => number = Date.now): Promise<ConditionCheck & { fullOutput: string }> {
  let res: { code: number; stdout: string };
  try {
    res = await sandbox.execInSandbox(["bash", "-c", RUNNER, "aio-condition", condition.language, String(CONDITION_TIMEOUT_SECONDS), String(MAX_CONDITION_OUTPUT), workdir, condition.code],
      { timeoutMs: (CONDITION_TIMEOUT_SECONDS + 30) * 1000 });
  } catch {
    return { at: now(), result: "error", error: "unavailable", fullOutput: "" };
  }
  const stdout = res.stdout ?? "";
  const at = stdout.lastIndexOf(`\n${EXIT_MARK}`);
  const exit = at >= 0 ? Number(/^(\d+)/.exec(stdout.slice(at + 1 + EXIT_MARK.length))?.[1] ?? NaN) : NaN;
  if (!Number.isInteger(exit)) return { at: now(), result: "error", error: "unavailable", fullOutput: "" };
  const fullOutput = stdout.slice(0, at).trim();
  const output = fullOutput ? { output: [...fullOutput].slice(0, SHOWN_OUTPUT).join("") } : {};
  if (exit === 0) return { at: now(), result: "fired", ...output, fullOutput };
  if (exit === 1) return { at: now(), result: "skipped", ...output, fullOutput };
  // timeout's own codes: 124 stopped, 137 killed after the grace period.
  if (exit === 124 || exit === 137) return { at: now(), result: "error", error: "timeout", ...output, fullOutput };
  return { at: now(), result: "error", error: "exit", exitCode: exit, ...output, fullOutput };
}

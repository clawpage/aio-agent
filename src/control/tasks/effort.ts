import { confident, type JevAnswer, type JevQuestion } from "../jev.js";

/**
 * Auto reasoning effort: when an account leaves its effort on Auto, Jev picks the
 * level each new or resumed task needs. Only these levels are offered to Jev, in
 * this order; the costliest ones (max, ultra) and the ones that may switch off
 * reasoning (none, minimal) stay explicit choices.
 */
export const AUTO_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

/** The name of the effort question in a Jev request. */
export const EFFORT_QUESTION = "effort";

/** An account on Auto: the levels Jev may choose from, and what runs when it cannot decide. */
export interface AutoEffort {
  levels: string[];
  /** The effort to run when Jev is unsure or unavailable; null is the model's own default. */
  fallback: string | null;
}

/** How a task's effort was chosen, kept in its plan and dispatch log so the choice can be evaluated. */
export interface EffortDecision {
  /** The effort the task runs with; null is the model's own default. */
  effort: string | null;
  /** jev: Jev's confident answer; fallback: Auto, but Jev was unsure or unavailable. */
  source: "jev" | "fallback";
  levels: string[];
  /** Jev's answer, when it gave a usable one. */
  answer?: JevAnswer;
  /** Why Jev could not answer. */
  error?: string;
}

const MEANING: Record<string, string> = {
  low: "Quick: a direct answer from general knowledge, a greeting or casual reply, a single simple lookup, or one small, obvious action",
  medium: "Moderate: a few steps or tool calls, a short comparison, a routine edit, or a focused search with a clear target",
  high: "Deep: multi-step research across several sources, planning with constraints, non-trivial coding or debugging, or careful analysis where a mistake is costly",
  xhigh: "Very deep: a long, open-ended investigation or complex engineering that needs sustained reasoning and repeated verification",
};

/** Jev's question: how hard and deep is the work this message asks for. */
export function effortQuestion(levels: string[]): JevQuestion {
  return {
    criteria: Object.fromEntries(levels.map((level) => [level, MEANING[level] ?? level])),
    instructions: {
      goal: "Choose the reasoning effort the executor needs to do what this message asks well. Judge how hard and deep the work is: how many steps, how much research, how much careful reasoning or verification it takes. Do not judge by the length of the message: a short message can ask for hard work, and a long one for something simple.",
      rules: [
        "When the message continues earlier work (see the timeline), judge the work it asks for now, not the earlier task as a whole.",
        "When two levels would do the job equally well, choose the lower one.",
      ],
    },
  };
}

/**
 * The effort a task on Auto runs with: Jev's choice when it is clearly sure of one
 * allowed level (the same bar the dispatcher uses for Jev's other answers), otherwise
 * the account's fallback.
 */
export function decideEffort(auto: AutoEffort, answer: JevAnswer | null | undefined, error?: string): EffortDecision {
  const usable = answer && auto.levels.includes(answer.choice) && auto.levels.every((level) => level in answer.probabilities) ? answer : null;
  if (usable && confident(usable)) return { effort: usable.choice, source: "jev", levels: auto.levels, answer: usable };
  // Not sure, or no usable answer (kept only when it was usable but below the bar).
  return { effort: auto.fallback, source: "fallback", levels: auto.levels, ...(usable ? { answer: usable } : {}), ...(error ? { error } : {}) };
}

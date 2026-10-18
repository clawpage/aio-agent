import { t } from "../i18n/index.js";

/** Milliseconds spent in each dispatcher stage. Missing fields were not observable. */
export interface DispatchTiming {
  model?: string;
  effort?: string;
  queueMs?: number;
  contextMs?: number;
  jevMs?: number;
  sandboxMs?: number;
  connectionMs?: number;
  threadStartMs?: number;
  turnStartMs?: number;
  /** From submitting the turn until its first visible text delta. */
  firstTextMs?: number;
  /** From the first visible text delta until turn completion. */
  finishMs?: number;
  classifierMs?: number;
  /** From starting sandbox readiness until the classifier returned or failed. */
  totalMs?: number;
  attempts?: number;
}

export type DispatchTimingSink = (timing: Partial<DispatchTiming>) => void;

/**
 * The dispatcher gave no answer in time. Not a format problem to correct and
 * re-ask about: the task fails planning with this reason and the person can retry.
 */
export class DispatchTimeoutError extends Error {
  constructor(seconds: number) {
    super(t().agent.dispatch.timedOut(seconds));
    this.name = "DispatchTimeoutError";
  }
}

import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { expandHome, readSecretFile } from "./bridgeModel.js";

/**
 * Jev (TypeSafe System One): one request asks one or more choice questions about
 * a state and answers each with a choice, per-option probabilities and a
 * confidence. The control plane holds the key; nothing here ever reaches a
 * sandbox, a log or the browser.
 */

export const JEV_KEY = "TYPESAFE_API_KEY";

export interface JevQuestion {
  /** option id -> what choosing it means */
  criteria: Record<string, string>;
  instructions: Record<string, unknown>;
}

export interface JevAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: unknown;
  latencyMs: number;
}

/** An answer the caller may act on: a clear first choice with a real margin. */
export function confident(answer: JevAnswer, minTop = 0.6, minMargin = 0.15): boolean {
  const [first = 0, second = 0] = Object.values(answer.probabilities).sort((a, b) => b - a);
  return first >= minTop && first - second >= minMargin;
}

/** The invariants a usable answer keeps (same as the CLI router's validator). */
function valid(answer: unknown, ids: string[]): answer is JevAnswer {
  if (!answer || typeof answer !== "object") return false;
  const a = answer as JevAnswer;
  const probs = a.probabilities;
  if (!probs || typeof probs !== "object" || !ids.includes(a.choice)) return false;
  const keys = Object.keys(probs);
  if (keys.length !== ids.length || !ids.every((id) => keys.includes(id))) return false;
  const numbers = [...Object.values(probs), a.confidence];
  if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)) return false;
  const sum = Object.values(probs).reduce((s, n) => s + n, 0);
  return Math.abs(sum - 1) < 0.02 && probs[a.choice]! >= Math.max(...Object.values(probs)) - 1e-6;
}

export class Jev {
  #cfg: Config;
  #log: Logger;
  #key: string | null | undefined;

  constructor(cfg: Config, log: Logger) {
    this.#cfg = cfg;
    this.#log = log.child("jev");
  }

  #secret(): string | null {
    if (this.#key !== undefined) return this.#key;
    const fromEnv = process.env[JEV_KEY]?.trim();
    if (fromEnv) return (this.#key = fromEnv);
    const file = readSecretFile(expandHome(this.#cfg.jev.secretsFile), JEV_KEY);
    if (!file.ok) this.#log.debug("Jev unavailable", { reason: file.reason });
    return (this.#key = file.ok ? file.value : null);
  }

  get enabled(): boolean {
    return this.#secret() !== null;
  }

  /** Ask every question at once; an answer that breaks the invariants fails the call. */
  async decide(state: Record<string, unknown>, questions: Record<string, JevQuestion>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<JevResult> {
    const key = this.#secret();
    if (!key) throw new Error("Jev 未配置");
    const body = JSON.stringify({
      model: this.#cfg.jev.model,
      state,
      questions: Object.fromEntries(Object.entries(questions).map(([name, q]) => [name, { type: "choice", criteria: q.criteria, instructions: q.instructions }])),
    });
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? this.#cfg.jev.timeoutMs;
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1_000, timeoutMs - (Date.now() - started))), ...(opts.signal ? [opts.signal] : [])]);
      const res = await fetch(this.#cfg.jev.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body,
        signal,
      });
      if ([429, 503, 529].includes(res.status) && attempt < 2) {
        await res.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`Jev 返回 HTTP ${res.status}`);
      const parsed = (await res.json()) as { answers?: Record<string, unknown>; usage?: unknown };
      const answers: Record<string, JevAnswer> = {};
      for (const [name, q] of Object.entries(questions)) {
        const answer = parsed.answers?.[name];
        if (!valid(answer, Object.keys(q.criteria))) throw new Error(`Jev 对 ${name} 的回答不完整`);
        answers[name] = { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities };
      }
      return { answers, usage: parsed.usage ?? null, latencyMs: Date.now() - started };
    }
  }
}

import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { formatLocal, haAccess, parseLocal } from "./camera.js";

/**
 * Home Assistant's history on aio_ha: how the home's entities changed over a
 * time range, which HA's own MCP tools (current state only) cannot tell.
 * Sensors with long-term statistics come back as mean / min / max per period
 * (HA keeps hour and day statistics for good, 5-minute ones for about ten
 * days); everything else as its state changes and how long each state lasted,
 * a thermostat also by what its equipment was doing (hvac_action). Only the
 * entities exposed to Assist are read, the same set HA's MCP tools see; all of
 * it goes over HA's WebSocket API with the gateway's token, on the host.
 */

class HistoryError extends Error {}

const TIMEOUT_MS = 25_000;
const DAY = 24 * 3600_000;
const MAX_ENTITIES = 10;
const MAX_ROWS = 120;
const MAX_CHANGES = 60;
const PERIODS = ["5minute", "hour", "day", "week", "month"] as const;
type Period = (typeof PERIODS)[number];

export const HA_HISTORY_TOOLS = [
  {
    name: "ha_history",
    description:
      "How home devices changed over a time range (Home Assistant's history), e.g. today's temperature trend, the day's high and low, when the heating or cooling ran, when a light, switch or door was on. " +
      "Temperature/humidity and other measured sensors come back as average / low / high per period with the range's overall high and low; other devices (thermostats, lights, switches, binary sensors) as their state changes and the time spent in each state, " +
      "thermostats also as how long the equipment was heating, cooling or idle. Values are in Home Assistant's units. Times are local, YYYY-MM-DD HH:MM:SS.",
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: { type: "string" },
          maxItems: MAX_ENTITIES,
          description: "Entity ids (e.g. sensor.upstairs_temperature) or device names as the state tools show them; a partial name matches every exposed entity containing it",
        },
        from: { type: "string", description: "Start of the range, local time; default 24 hours before `to`. For \"today\" use today's 00:00:00" },
        to: { type: "string", description: "End of the range, local time; default now" },
        period: {
          type: "string",
          enum: [...PERIODS],
          description: "Granularity for measured sensors; default by range length (5minute up to 6 hours, hour up to 5 days, day up to 120 days, then week)",
        },
      },
      required: ["entities"],
    },
  },
];

export const HA_HISTORY_TOOL_NAMES = new Set(HA_HISTORY_TOOLS.map((t) => t.name));

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type State = { entity_id: string; state: string; attributes: Record<string, unknown> };
type StatRow = { start: number | string; end: number | string; mean?: number | null; min?: number | null; max?: number | null };
/** HA's compressed history rows: state, attributes (when they changed), last updated in seconds. */
type HistoryRow = { s: string; a?: Record<string, unknown>; lu: number };
type Call = (message: Record<string, unknown>) => Promise<unknown>;

export function autoPeriod(spanMs: number): Period {
  if (spanMs <= 6 * 3600_000) return "5minute";
  if (spanMs <= 5 * DAY) return "hour";
  if (spanMs <= 120 * DAY) return "day";
  return "week";
}

/** The start of the period holding `ms` (local midnight for a day or longer), so the first period is not dropped. */
function periodStart(ms: number, period: Period): number {
  if (period === "5minute") return ms - (ms % 300_000);
  if (period === "hour") return ms - (ms % 3600_000);
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, " ").trim();
const nameOf = (s: State) => (typeof s.attributes.friendly_name === "string" ? s.attributes.friendly_name : s.entity_id);

/** The entities a request names: an exact id or name wins, otherwise every entity whose id or name contains it. */
export function resolveEntities(asked: string[], states: State[]): { picked: State[]; missing: string[] } {
  const picked = new Map<string, State>();
  const missing: string[] = [];
  for (const raw of asked) {
    const q = norm(raw);
    const exact = states.filter((s) => norm(s.entity_id) === q || norm(nameOf(s)) === q);
    const found = exact.length ? exact : states.filter((s) => norm(s.entity_id).includes(q) || norm(nameOf(s)).includes(q));
    if (!found.length) missing.push(raw);
    for (const s of found) picked.set(s.entity_id, s);
  }
  return { picked: [...picked.values()], missing };
}

const num = (v: number) => String(Math.round(v * 100) / 100);
const ms = (v: number | string) => (typeof v === "number" ? v : Date.parse(v));
const when = (t: number, period: Period) => (period === "5minute" || period === "hour" ? formatLocal(t).slice(5, 16) : formatLocal(t).slice(0, 10));

function duration(msLong: number): string {
  if (msLong < 60_000) return `${Math.round(msLong / 1000)}s`;
  const minutes = Math.round(msLong / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
}

function statsBlock(state: State, rows: StatRow[], period: Period): string[] {
  const unit = typeof state.attributes.unit_of_measurement === "string" ? state.attributes.unit_of_measurement : "";
  const points = rows.map((r) => ({ start: ms(r.start), end: ms(r.end), mean: r.mean ?? null, min: r.min ?? null, max: r.max ?? null }));
  const lows = points.filter((p) => p.min !== null);
  const highs = points.filter((p) => p.max !== null);
  const means = points.flatMap((p) => (p.mean === null ? [] : [p.mean]));
  const low = lows.reduce((a, b) => (b.min! < a.min! ? b : a), lows[0]!);
  const high = highs.reduce((a, b) => (b.max! > a.max! ? b : a), highs[0]!);
  const out = [`${nameOf(state)} (${state.entity_id})${unit ? `, ${unit}` : ""}: ${period} statistics ${when(points[0]!.start, period)} to ${formatLocal(points.at(-1)!.end).slice(5, 16)}`];
  const summary: string[] = [];
  if (low) summary.push(`low ${num(low.min!)} (${period} from ${when(low.start, period)})`);
  if (high) summary.push(`high ${num(high.max!)} (${period} from ${when(high.start, period)})`);
  if (means.length) summary.push(`average ${num(means.reduce((a, b) => a + b, 0) / means.length)}`);
  summary.push(`now ${state.state}`);
  out.push(`Overall: ${summary.join(", ")}.`);
  const shown = points.slice(-MAX_ROWS);
  if (points.length > shown.length) out.push(`(the latest ${shown.length} of ${points.length} periods; narrow the range or use a longer period for earlier ones)`);
  out.push("Per period (start: average / low / high):");
  const v = (x: number | null) => (x === null ? "-" : num(x));
  for (const p of shown) out.push(`- ${when(p.start, period)}  ${v(p.mean)} / ${v(p.min)} / ${v(p.max)}`);
  return out;
}

function changesBlock(state: State, rows: HistoryRow[], end: number, tempUnit: string): string[] {
  const climate = state.entity_id.startsWith("climate.");
  const unit = typeof state.attributes.unit_of_measurement === "string" ? ` ${state.attributes.unit_of_measurement}` : "";
  let attrs: Record<string, unknown> = {};
  const points = rows.map((r) => {
    if (r.a) attrs = r.a;
    return { at: r.lu * 1000, s: r.s, a: attrs };
  });
  const head = `${nameOf(state)} (${state.entity_id})`;
  if (!points.length) return [`${head}: no recorded history in this range (Home Assistant keeps detailed history only for its recorder's purge window, 10 days by default).`];
  const target = (a: Record<string, unknown>) =>
    a.temperature != null ? `target ${a.temperature}${tempUnit}` : a.target_temp_low != null || a.target_temp_high != null ? `target ${a.target_temp_low ?? "?"}–${a.target_temp_high ?? "?"}${tempUnit}` : "";
  const describe = (p: (typeof points)[number]) =>
    climate ? [p.s, typeof p.a.hvac_action === "string" ? p.a.hvac_action : "", target(p.a)].filter(Boolean).join(", ") : `${p.s}${unit}`;
  const changes = points.filter((p, i) => i === 0 || describe(p) !== describe(points[i - 1]!));
  const spans = (valueOf: (p: (typeof points)[number]) => string) => {
    const total = new Map<string, number>();
    points.forEach((p, i) => {
      const length = Math.min(points[i + 1]?.at ?? end, end) - p.at;
      if (length > 0) total.set(valueOf(p), (total.get(valueOf(p)) ?? 0) + length);
    });
    return [...total].sort((a, b) => b[1] - a[1]).map(([value, length]) => `${value} ${duration(length)}`).join(", ");
  };
  const out = [`${head}: ${changes.length - 1} change${changes.length === 2 ? "" : "s"}, from ${formatLocal(points[0]!.at).slice(5, 16)}`];
  if (!unit) out.push(`Time in each state: ${spans((p) => p.s)}.`);
  if (climate && points.some((p) => typeof p.a.hvac_action === "string")) out.push(`Equipment (hvac_action): ${spans((p) => String(p.a.hvac_action ?? "unknown"))}.`);
  const shown = changes.slice(-MAX_CHANGES);
  if (changes.length > shown.length) out.push(`(the latest ${shown.length} of ${changes.length} entries; narrow the range for earlier ones)`);
  out.push("State over time (the first line is the state at the start):");
  for (const p of shown) out.push(`- ${formatLocal(p.at).slice(5, 16)} ${describe(p)}`);
  return out;
}

export class HaHistory {
  #base: string;
  #token: () => string | null;
  #log: Logger;

  constructor(opts: { baseUrl: string; token: () => string | null; log: Logger }) {
    this.#base = opts.baseUrl.replace(/\/+$/, "");
    this.#token = opts.token;
    this.#log = opts.log.child("ha-history");
  }

  static from(cfg: Config, log: Logger): HaHistory | null {
    const access = haAccess(cfg);
    return access ? new HaHistory({ ...access, log }) : null;
  }

  async tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (name !== "ha_history") throw new HistoryError(`unknown tool ${name}`);
      return { content: [{ type: "text", text: await this.#history(args) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof HistoryError)) this.#log.warn("history tool failed", { tool: name, error: message });
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }

  async #history(args: Record<string, unknown>): Promise<string> {
    const asked = (Array.isArray(args.entities) ? args.entities : [args.entities]).filter((e): e is string => typeof e === "string" && e.trim() !== "");
    if (!asked.length) throw new HistoryError('entities must list entity ids or names, e.g. ["sensor.upstairs_temperature"]');
    const now = Date.now();
    const to = args.to === undefined ? now : parseLocal(args.to);
    const from = args.from === undefined ? (to ?? now) - DAY : parseLocal(args.from);
    if (from === null || to === null) throw new HistoryError("from/to must be local times like 2026-10-15 00:00:00");
    if (to <= from) throw new HistoryError("to must be after from");
    if (from >= now) throw new HistoryError(`from is in the future (now ${formatLocal(now)})`);
    const end = Math.min(to, now);
    const period = args.period === undefined ? autoPeriod(end - from) : (args.period as Period);
    if (!PERIODS.includes(period)) throw new HistoryError(`period must be one of ${PERIODS.join(", ")}`);

    return await this.#session(async (call) => {
      const [states, exposure, config] = (await Promise.all([
        call({ type: "get_states" }),
        call({ type: "homeassistant/expose_entity/list" }),
        call({ type: "get_config" }),
      ])) as [State[], { exposed_entities?: Record<string, { conversation?: boolean }> }, { unit_system?: { temperature?: string } }];
      const exposed = states.filter((s) => exposure.exposed_entities?.[s.entity_id]?.conversation === true);
      const { picked, missing } = resolveEntities(asked, exposed);
      if (!picked.length) {
        const names = exposed.filter((s) => /^(sensor|climate|binary_sensor|light|switch|fan|cover|lock|vacuum|media_player)\./.test(s.entity_id)).map((s) => `${s.entity_id} "${nameOf(s)}"`);
        throw new HistoryError(`No entity exposed to Assist matches ${missing.join(", ")}. Exposed: ${names.join(", ")}`);
      }
      const chosen = picked.slice(0, MAX_ENTITIES);
      const measured = chosen.filter((s) => s.attributes.state_class === "measurement");
      const stats = (measured.length
        ? await call({
            type: "recorder/statistics_during_period",
            start_time: new Date(periodStart(from, period)).toISOString(),
            end_time: new Date(end).toISOString(),
            statistic_ids: measured.map((s) => s.entity_id),
            period,
            types: ["mean", "min", "max"],
          })
        : {}) as Record<string, StatRow[]>;
      const others = chosen.filter((s) => !stats[s.entity_id]?.length);
      const history = (others.length
        ? await call({
            type: "history/history_during_period",
            start_time: new Date(from).toISOString(),
            end_time: new Date(end).toISOString(),
            entity_ids: others.map((s) => s.entity_id),
            minimal_response: false,
            no_attributes: false,
            significant_changes_only: false,
          })
        : {}) as Record<string, HistoryRow[]>;

      const out = [`History ${formatLocal(from)} to ${formatLocal(end)} (local time; now ${formatLocal(now)}):`];
      for (const s of chosen) {
        out.push("");
        const rows = stats[s.entity_id];
        if (rows?.length) out.push(...statsBlock(s, rows, period));
        else {
          if (measured.includes(s)) out.push(`(no ${period} statistics for ${s.entity_id} in this range: HA writes one when each period ends${period === "5minute" ? " and keeps 5-minute ones about 10 days" : ""}; raw readings follow)`);
          out.push(...changesBlock(s, history[s.entity_id] ?? [], end, config.unit_system?.temperature ?? ""));
        }
      }
      if (picked.length > chosen.length) out.push("", `${picked.length - chosen.length} more entities matched (${picked.slice(MAX_ENTITIES).map((s) => s.entity_id).join(", ")}); ask for them separately.`);
      if (missing.length) out.push("", `Not found among the entities exposed to Assist: ${missing.join(", ")}.`);
      return out.join("\n");
    });
  }

  /** One WebSocket connection for a tool call: authenticate, then any number of commands. */
  async #session<T>(work: (call: Call) => Promise<T>): Promise<T> {
    const token = this.#token();
    if (!token) throw new HistoryError("Home Assistant is not configured");
    const ws = new WebSocket(`${this.#base.replace(/^http/, "ws")}/api/websocket`);
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let fail: (err: Error) => void = () => {};
    const broken = new Promise<never>((_, reject) => { fail = reject; });
    broken.catch(() => {});
    const abort = (err: Error) => {
      fail(err);
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    let authed: () => void = () => {};
    const ready = new Promise<void>((resolve) => { authed = resolve; });
    ws.onerror = () => abort(new HistoryError("Cannot reach Home Assistant"));
    ws.onclose = () => abort(new HistoryError("Home Assistant closed the connection"));
    ws.onmessage = (ev) => {
      let m: { type?: string; id?: number; success?: boolean; result?: unknown; error?: { message?: string } };
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "auth_required") ws.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (m.type === "auth_ok") authed();
      else if (m.type === "auth_invalid") {
        this.#log.warn("Home Assistant rejected the history token");
        abort(new HistoryError("Home Assistant refused the request"));
      } else if (m.type === "result" && typeof m.id === "number") {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.success) p.resolve(m.result);
        else p.reject(new HistoryError(m.error?.message ?? "Home Assistant refused the request"));
      }
    };
    let nextId = 0;
    const call: Call = (message) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, ...message }));
    });
    const timer = setTimeout(() => abort(new HistoryError("Home Assistant did not answer in time")), TIMEOUT_MS);
    try {
      await Promise.race([ready, broken]);
      return await Promise.race([work(call), broken]);
    } finally {
      clearTimeout(timer);
      ws.onclose = null;
      try { ws.close(); } catch { /* already closed */ }
    }
  }
}

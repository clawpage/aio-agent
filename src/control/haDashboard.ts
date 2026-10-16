import type { Config } from "./config.js";
import type { Logger } from "../common/logger.js";
import { haAccess } from "./camera.js";
import { withHaSocket, type HaEndpoint } from "./haSocket.js";

/**
 * What the home's HA dashboards call each device: a tile named 婴儿卧室 on
 * sensor.h5100_2676_temperature, under the heading 房间温湿度 › 温度 of the 家
 * view. HA's own MCP tools only know the integration's names (H5100 2676
 * Temperature), so the executor could not tell which room a sensor is in. The
 * notes are read from every dashboard's config, kept for the entities exposed
 * to Assist, refreshed every few minutes (dashboard edits show up on their own)
 * and offered with GetLiveContext and ha_history.
 */

export interface DashboardNote {
  /** The name the card gives the entity, when it gives one. */
  name: string | null;
  /** Where it is: view › heading › subheading (or card title). */
  place: string;
}

const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;

export const formatNote = (n: DashboardNote) => [n.name, n.place].filter(Boolean).join(" — ");

/** Every entity a dashboard config shows, with the names and places it shows it under. */
export function dashboardNotes(config: unknown): Map<string, DashboardNote[]> {
  const out = new Map<string, DashboardNote[]>();
  const add = (entity: unknown, name: unknown, place: Array<string | undefined>) => {
    if (typeof entity !== "string" || !ENTITY.test(entity)) return;
    const note = { name: typeof name === "string" && name.trim() ? name.trim() : null, place: place.filter((p): p is string => Boolean(p?.trim())).map((p) => p.trim()).join(" › ") };
    if (!note.name && !note.place) return;
    const list = out.get(entity) ?? [];
    if (!list.some((n) => n.name === note.name && n.place === note.place)) list.push(note);
    out.set(entity, list);
  };
  const refs = (list: unknown, place: Array<string | undefined>) => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (typeof e === "string") add(e, null, place);
      else if (e && typeof e === "object") add((e as Record<string, unknown>).entity, (e as Record<string, unknown>).name, place);
    }
  };
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const cards = (list: unknown, place: Array<string | undefined>) => {
    if (!Array.isArray(list)) return;
    // A heading names the cards after it in the same list; a subtitle heading nests under the last title.
    let title: string | undefined;
    let sub: string | undefined;
    for (const card of list) {
      if (!card || typeof card !== "object") continue;
      const c = card as Record<string, unknown>;
      if (c.type === "heading") {
        if (c.heading_style === "subtitle") sub = text(c.heading);
        else [title, sub] = [text(c.heading), undefined];
        refs(c.badges, [...place, title, sub]);
        continue;
      }
      const here = [...place, title, sub, text(c.title)];
      add(c.entity, c.name, here);
      refs(c.entities, here);
      refs(c.badges, here);
      cards(c.cards, here);
      if (c.card) cards([c.card], here);
    }
  };
  const views = (config as { views?: unknown } | null)?.views;
  if (Array.isArray(views)) {
    for (const view of views) {
      if (!view || typeof view !== "object") continue;
      const v = view as Record<string, unknown>;
      const place = [text(v.title)];
      refs(v.badges, place);
      cards(v.cards, place);
      if (Array.isArray(v.sections)) for (const section of v.sections) cards((section as Record<string, unknown> | null)?.cards, place);
    }
  }
  return out;
}

export class HaDashboard {
  #ha: HaEndpoint;
  #ttlMs: number;
  #cached: { at: number; notes: Map<string, DashboardNote[]>; names: Map<string, string> } | null = null;
  #loading: Promise<void> | null = null;

  constructor(opts: { baseUrl: string; token: () => string | null; log: Logger; ttlMs?: number }) {
    this.#ha = { baseUrl: opts.baseUrl, token: opts.token, log: opts.log.child("ha-dashboard") };
    this.#ttlMs = opts.ttlMs ?? TTL_MS;
  }

  static from(cfg: Config, log: Logger): HaDashboard | null {
    const access = haAccess(cfg);
    return access ? new HaDashboard({ ...access, log }) : null;
  }

  /** Exposed entity -> its dashboard notes; the last good read (or none) when HA cannot be read now. Never throws. */
  async notes(): Promise<Map<string, DashboardNote[]>> {
    return (await this.#current()).notes;
  }

  /** The block added to GetLiveContext's answer; null when no exposed entity has a note. */
  async liveContextText(): Promise<string | null> {
    const { notes, names } = await this.#current();
    if (!notes.size) return null;
    const lines = [...notes].map(([id, list]) => `- ${names.get(id) ?? id} (${id}): ${list.map(formatNote).join("; ")}`);
    return ["Names on the home's Home Assistant dashboard (name — view › heading), how the family labels these devices; use them to tell which device or room the user means:", ...lines].join("\n");
  }

  async #current(): Promise<{ notes: Map<string, DashboardNote[]>; names: Map<string, string> }> {
    if (this.#cached && Date.now() - this.#cached.at < this.#ttlMs) return this.#cached;
    this.#loading ??= this.#load().finally(() => { this.#loading = null; });
    await this.#loading;
    return this.#cached ?? { notes: new Map(), names: new Map() };
  }

  async #load(): Promise<void> {
    try {
      const { configs, exposure, states } = await withHaSocket(this.#ha, async (call) => {
        const [dashboards, exposure, states] = (await Promise.all([
          call({ type: "lovelace/dashboards/list" }),
          call({ type: "homeassistant/expose_entity/list" }),
          call({ type: "get_states" }),
        ])) as [Array<{ url_path?: string }>, { exposed_entities?: Record<string, { conversation?: boolean }> }, Array<{ entity_id: string; attributes?: { friendly_name?: unknown } }>];
        // The default dashboard plus the added ones; one that has no saved config (auto-generated) is skipped.
        const paths = [null, ...dashboards.map((d) => d.url_path).filter((p): p is string => typeof p === "string")];
        const configs = await Promise.all(paths.map((url_path) => call({ type: "lovelace/config", ...(url_path ? { url_path } : {}) }).catch(() => null)));
        return { configs, exposure, states };
      }, TIMEOUT_MS);
      const notes = new Map<string, DashboardNote[]>();
      for (const config of configs) {
        for (const [id, list] of dashboardNotes(config)) {
          if (exposure.exposed_entities?.[id]?.conversation !== true) continue;
          const all = notes.get(id) ?? [];
          for (const n of list) if (!all.some((m) => m.name === n.name && m.place === n.place)) all.push(n);
          notes.set(id, all);
        }
      }
      // The same name in a broader place (a view's badge) adds nothing to the tile under a heading.
      for (const [id, list] of notes) notes.set(id, list.filter((n) => !list.some((m) => m !== n && m.name === n.name && m.place.startsWith(`${n.place} › `))));
      const names = new Map(states.flatMap((s) => (typeof s.attributes?.friendly_name === "string" ? [[s.entity_id, s.attributes.friendly_name.trim()] as const] : [])));
      this.#cached = { at: Date.now(), notes, names };
    } catch (err) {
      this.#ha.log.warn("cannot read the dashboard notes", { error: err instanceof Error ? err.message : String(err) });
    }
  }
}

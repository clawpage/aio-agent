import { it, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { HaGateway } from "../../src/control/ha.js";
import { HaHistory, autoPeriod, resolveEntities } from "../../src/control/haHistory.js";
import { HaDashboard, dashboardNotes } from "../../src/control/haDashboard.js";
import { formatLocal } from "../../src/control/camera.js";
import { memberConfig } from "../../src/control/tenants.js";

const TOKEN = "host-ha-secret";
const HOUR = 3600_000;

/** A stand-in Home Assistant WebSocket API with a thermostat, its temperature sensor, a switch and an entity not exposed to Assist. */
async function fakeHa(from: number) {
  const seen: Array<Record<string, any>> = [];
  const panel = {
    dashboards: [{ url_path: "home-panel", mode: "yaml" }],
    failing: false,
    config: {
      views: [
        {
          title: "家",
          badges: [{ type: "entity", entity: "switch.aisle", name: "走廊" }],
          sections: [
            {
              type: "grid",
              cards: [
                { type: "heading", heading: "房间温湿度", heading_style: "title" },
                { type: "heading", heading: "温度", heading_style: "subtitle" },
                { type: "grid", cards: [{ type: "tile", entity: "sensor.upstairs_temperature", name: "婴儿卧室" }] },
                { type: "tile", entity: "device_tracker.phone", name: "爸爸手机" },
              ],
            },
            { type: "grid", cards: [{ type: "heading", heading: "走廊与车库" }, { type: "tile", entity: "switch.aisle", name: "走廊" }] },
          ],
        },
      ],
    } as Record<string, any>,
  };
  const states = [
    { entity_id: "sensor.upstairs_temperature", state: "74.8", attributes: { friendly_name: "Upstairs Temperature", unit_of_measurement: "°F", state_class: "measurement" } },
    { entity_id: "climate.upstairs", state: "cool", attributes: { friendly_name: "Upstairs", hvac_action: "idle", temperature: 75 } },
    { entity_id: "switch.aisle", state: "off", attributes: { friendly_name: "Aisle" } },
    { entity_id: "device_tracker.phone", state: "home", attributes: { friendly_name: "Phone" } },
  ];
  const climate = (hvac_action: string, current_temperature: number) => ({ temperature: 75, hvac_action, current_temperature, friendly_name: "Upstairs" });
  const server = http.createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({ server, path: "/api/websocket" });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "auth_required" }));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "auth") return ws.send(JSON.stringify({ type: m.access_token === TOKEN ? "auth_ok" : "auth_invalid" }));
      seen.push(m);
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, type: "result", success: true, result }));
      if (m.type === "get_states") return reply(states);
      if (m.type === "get_config") return reply({ unit_system: { temperature: "°F" } });
      if (m.type === "homeassistant/expose_entity/list") {
        return reply({ exposed_entities: { "sensor.upstairs_temperature": { conversation: true }, "climate.upstairs": { conversation: true }, "switch.aisle": { conversation: true }, "device_tracker.phone": { conversation: false } } });
      }
      if (m.type === "lovelace/dashboards/list") {
        if (panel.failing) return ws.send(JSON.stringify({ id: m.id, type: "result", success: false, error: { code: "unauthorized", message: "Unauthorized" } }));
        return reply(panel.dashboards);
      }
      if (m.type === "lovelace/config") {
        if (m.url_path === "home-panel") return reply(panel.config);
        return ws.send(JSON.stringify({ id: m.id, type: "result", success: false, error: { code: "config_not_found", message: "No config found." } }));
      }
      if (m.type === "recorder/statistics_during_period") {
        const rows = [0, 1, 2].map((i) => ({ start: from + i * HOUR, end: from + (i + 1) * HOUR, mean: 75 - i, min: 74.5 - i, max: 75.5 - i }));
        return reply({ "sensor.upstairs_temperature": rows });
      }
      if (m.type === "history/history_during_period") {
        const s = from / 1000;
        return reply({
          "climate.upstairs": [
            { s: "cool", a: climate("idle", 76), lu: s },
            { s: "cool", a: climate("cooling", 76), lu: s + 3600 },
            // Only the reading changed: not a change worth a line.
            { s: "cool", a: climate("cooling", 75.5), lu: s + 4500 },
            { s: "cool", a: climate("idle", 75), lu: s + 5400 },
          ],
        });
      }
      ws.send(JSON.stringify({ id: m.id, type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
    panel,
    close: () => { for (const c of wss.clients) c.terminate(); wss.close(); server.closeAllConnections(); server.close(); },
  };
}

it("picks the period from the range and names to entities, an exact name first", () => {
  expect(autoPeriod(2 * HOUR)).toBe("5minute");
  expect(autoPeriod(24 * HOUR)).toBe("hour");
  expect(autoPeriod(30 * 24 * HOUR)).toBe("day");
  expect(autoPeriod(365 * 24 * HOUR)).toBe("week");
  const states = [
    { entity_id: "climate.upstairs", state: "cool", attributes: { friendly_name: "Upstairs" } },
    { entity_id: "sensor.upstairs_temperature", state: "74", attributes: { friendly_name: "Upstairs Temperature" } },
    { entity_id: "sensor.upstairs_humidity", state: "49", attributes: { friendly_name: "Upstairs Humidity" } },
  ];
  const ids = (asked: string[]) => resolveEntities(asked, states).picked.map((s) => s.entity_id);
  expect(ids(["upstairs"])).toEqual(["climate.upstairs"]);
  expect(ids(["sensor.upstairs_humidity"])).toEqual(["sensor.upstairs_humidity"]);
  expect(ids(["upstairs t"])).toEqual(["sensor.upstairs_temperature"]);
  expect(ids(["Upstairs_"])).toEqual(["climate.upstairs"]);
  expect(resolveEntities(["garage"], states)).toEqual({ picked: [], missing: ["garage"] });
});

it("adds ha_history to aio_ha: statistics for sensors, state changes and run time for the rest, exposed entities only", async () => {
  const day = new Date(Date.now() - 2 * 24 * HOUR);
  const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const to = from + 12 * HOUR;
  const ha = await fakeHa(from);
  const h = await startHarness();
  const upstreamCalls: any[] = [];
  const mcp = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    upstreamCalls.push(body);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "HassTurnOn" }] } }));
  });
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aio-ha-history-")), "ha-mcp.env");
  fs.writeFileSync(keyFile, `HA_MCP_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const saved = process.env.HA_MCP_TOKEN;
  delete process.env.HA_MCP_TOKEN;
  const cfg = { ...h.ctx.cfg, memberModelPort: 0, haMcp: { upstreamUrl: `http://127.0.0.1:${(mcp.address() as { port: number }).port}/api/mcp`, secretsFile: keyFile, accounts: ["cr"], cameras: {} } };
  const history = new HaHistory({ baseUrl: ha.base, token: () => TOKEN, log: h.ctx.log });
  const gatewayHa = new HaGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: (id) => (id === "user_cr" ? "cr" : null), history });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, gatewayHa);
  await gateway.start();
  try {
    const member = memberConfig(cfg, "user_cr", 18094);
    gateway.provision(member);
    const url = member.ha!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    let id = 0;
    const rpc = async (method: string, params?: unknown) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json()) as any;
    const call = async (args: Record<string, unknown>) => (await rpc("tools/call", { name: "ha_history", arguments: args })).result as { content: any[]; isError?: boolean };

    expect((await rpc("tools/list")).result.tools.map((t: { name: string }) => t.name)).toEqual(["HassTurnOn", "ha_history"]);

    const result = await call({ entities: ["Upstairs Temperature", "upstairs", "Phone"], from: formatLocal(from), to: formatLocal(to) });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text as string;
    expect(text).toContain(`History ${formatLocal(from)} to ${formatLocal(to)}`);
    const at = (ms: number) => formatLocal(ms).slice(5, 16);
    expect(text).toContain("Upstairs Temperature (sensor.upstairs_temperature), °F: hour statistics");
    expect(text).toContain(`Overall: low 72.5 (hour from ${at(from + 2 * HOUR)}), high 75.5 (hour from ${at(from)}), average 74, now 74.8.`);
    expect(text).toContain(`- ${at(from + HOUR)}  74 / 73.5 / 74.5`);
    expect(text).toContain("Upstairs (climate.upstairs): 2 changes");
    expect(text).toContain("Time in each state: cool 12h.");
    expect(text).toContain("Equipment (hvac_action): idle 11h30m, cooling 30m.");
    expect(text).toContain(`- ${at(from + HOUR)} cool, cooling, target 75°F`);
    expect(text).not.toContain("75.5, target");
    expect(text.match(/^- .* cool, /gm)).toHaveLength(3);
    // Not exposed to Assist: never read, reported as not found.
    expect(text).toContain("Not found among the entities exposed to Assist: Phone.");
    expect(JSON.stringify(ha.seen)).not.toContain("device_tracker.phone");

    const stats = ha.seen.find((m) => m.type === "recorder/statistics_during_period")!;
    expect(stats).toMatchObject({ statistic_ids: ["sensor.upstairs_temperature"], period: "hour", start_time: new Date(from).toISOString(), end_time: new Date(to).toISOString() });
    expect(ha.seen.find((m) => m.type === "history/history_during_period")).toMatchObject({ entity_ids: ["climate.upstairs"] });
    // History calls are answered on the host; HA's MCP server only saw the tool list.
    expect(upstreamCalls.map((c) => c.method)).toEqual(["tools/list"]);

    const unknown = await call({ entities: ["garage door"] });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('No entity exposed to Assist matches garage door. Exposed: sensor.upstairs_temperature "Upstairs Temperature", climate.upstairs "Upstairs", switch.aisle "Aisle"');
    expect((await call({ entities: [] })).isError).toBe(true);
    expect((await call({ entities: ["switch.aisle"], from: formatLocal(to), to: formatLocal(from) })).content[0].text).toBe("to must be after from");
  } finally {
    if (saved !== undefined) process.env.HA_MCP_TOKEN = saved;
    gateway.close();
    mcp.closeAllConnections();
    mcp.close();
    ha.close();
    await h.shutdown();
  }
});

it("reads the names and places a dashboard shows entities under", () => {
  const notes = dashboardNotes({
    views: [
      {
        title: "车",
        badges: ["binary_sensor.lock", { entity: "sensor.battery", name: "电量" }],
        cards: [
          { type: "heading", heading: "车况" },
          { type: "entities", title: "门窗", entities: [{ entity: "binary_sensor.door", name: "车门" }, "binary_sensor.window", { entity: "opower:pge_cost", name: "电费" }] },
          { type: "vertical-stack", cards: [{ type: "tile", entity: "sensor.inside", name: "车内温度" }] },
          { type: "conditional", card: { type: "tile", entity: "sensor.outside" } },
        ],
      },
    ],
  });
  expect(Object.fromEntries(notes)).toEqual({
    "binary_sensor.lock": [{ name: null, place: "车" }],
    "sensor.battery": [{ name: "电量", place: "车" }],
    "binary_sensor.door": [{ name: "车门", place: "车 › 车况 › 门窗" }],
    "binary_sensor.window": [{ name: null, place: "车 › 车况 › 门窗" }],
    "sensor.inside": [{ name: "车内温度", place: "车 › 车况" }],
    "sensor.outside": [{ name: null, place: "车 › 车况" }],
  });
  expect(dashboardNotes(null).size).toBe(0);
});

it("adds the dashboard's names to GetLiveContext and ha_history, exposed entities only, following dashboard edits", async () => {
  const from = Date.now() - 12 * HOUR;
  const ha = await fakeHa(from);
  const h = await startHarness();
  const upstreamCalls: any[] = [];
  const mcp = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    upstreamCalls.push(body);
    const result = body.method === "tools/list" ? { tools: [{ name: "GetLiveContext" }] } : { content: [{ type: "text", text: "Live Context: - names: Upstairs Temperature" }] };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r));
  const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aio-ha-dashboard-")), "ha-mcp.env");
  fs.writeFileSync(keyFile, `HA_MCP_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const saved = process.env.HA_MCP_TOKEN;
  delete process.env.HA_MCP_TOKEN;
  const cfg = { ...h.ctx.cfg, memberModelPort: 0, haMcp: { upstreamUrl: `http://127.0.0.1:${(mcp.address() as { port: number }).port}/api/mcp`, secretsFile: keyFile, accounts: ["cr"], cameras: {} } };
  const access = { baseUrl: ha.base, token: () => TOKEN, log: h.ctx.log };
  const dashboard = new HaDashboard({ ...access, ttlMs: 0 });
  const history = new HaHistory({ ...access, dashboard });
  const gatewayHa = new HaGateway({ cfg, log: h.ctx.log, port: 0, usernameOf: (id) => (id === "user_cr" ? "cr" : null), history, dashboard });
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, undefined, undefined, undefined, gatewayHa);
  await gateway.start();
  try {
    const member = memberConfig(cfg, "user_cr", 18095);
    gateway.provision(member);
    const url = member.ha!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    let id = 0;
    const rpc = async (method: string, params?: unknown) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json()) as any;
    const live = async () => (await rpc("tools/call", { name: "GetLiveContext", arguments: {} })).result.content as Array<{ type: string; text: string }>;

    const content = await live();
    expect(content[0]).toEqual({ type: "text", text: "Live Context: - names: Upstairs Temperature" });
    expect(content).toHaveLength(2);
    expect(content[1]!.text).toContain("- Upstairs Temperature (sensor.upstairs_temperature): 婴儿卧室 — 家 › 房间温湿度 › 温度");
    // The view badge's 走廊 is covered by the tile under its heading.
    expect(content[1]!.text).toContain("- Aisle (switch.aisle): 走廊 — 家 › 走廊与车库\n");
    expect(content[1]!.text).not.toContain("爸爸手机");
    expect(upstreamCalls.filter((c) => c.method === "tools/call").map((c) => c.params.name)).toEqual(["GetLiveContext"]);

    const byRoom = (await rpc("tools/call", { name: "ha_history", arguments: { entities: ["婴儿卧室"] } })).result;
    expect(byRoom.isError).toBeUndefined();
    expect(byRoom.content[0].text).toContain("Upstairs Temperature (sensor.upstairs_temperature) [dashboard: 婴儿卧室 — 家 › 房间温湿度 › 温度], °F:");
    expect(byRoom.content[0].text).not.toContain("climate.upstairs");

    // Renamed on the dashboard: the next call says so.
    ha.panel.config.views[0].sections[0].cards[2].cards[0].name = "Roy 房间";
    expect((await live())[1]!.text).toContain("(sensor.upstairs_temperature): Roy 房间 — 家 › 房间温湿度 › 温度");

    // Dashboards unreadable: GetLiveContext is HA's answer, unchanged.
    const fresh = new HaDashboard({ ...access, ttlMs: 0 });
    ha.panel.failing = true;
    expect(await fresh.liveContextText()).toBeNull();
  } finally {
    if (saved !== undefined) process.env.HA_MCP_TOKEN = saved;
    gateway.close();
    mcp.closeAllConnections();
    mcp.close();
    ha.close();
    await h.shutdown();
  }
});

import { describe, expect, it } from "vitest";
import { OnDemandPrograms, ON_DEMAND } from "../../src/control/sandbox/programs.js";

const IDLE = 15 * 60_000;

function setup(running: string[] = []) {
  const world = { now: 1_000_000, running: new Set(running), execs: [] as string[][], logs: [] as string[] };
  const container = {
    async execInSandbox(argv: string[]) {
      world.execs.push(argv);
      if (argv[0] === "supervisorctl" && argv[1] === "start") world.running.add(argv[2]!);
      if (argv[0] === "supervisorctl" && argv[1] === "stop") world.running.delete(argv[2]!);
      if (argv[0] === "supervisorctl" && argv[1] === "status") {
        return { code: 3, stdout: argv.slice(2).map((p) => `${p.padEnd(20)}${world.running.has(p) ? "RUNNING   pid 1, uptime 0:10:00" : "STOPPED   Not started"}`).join("\n"), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    async fetch(pathname: string) {
      const entry = ON_DEMAND.find((p) => p.probe === pathname)!;
      return new Response(null, { status: world.running.has(entry.program) ? 200 : 502 });
    },
  };
  const programs = new OnDemandPrograms({
    container,
    log: { info: (m) => void world.logs.push(m), warn: (m) => void world.logs.push(m) },
    idleMs: IDLE,
    now: () => world.now,
    sleep: async (ms) => { world.now += ms; },
  });
  return { world, programs };
}

const editor = ON_DEMAND.find((p) => p.program === "code-server")!;
const notebook = ON_DEMAND.find((p) => p.program === "jupyter")!;

describe("on-demand sandbox programs", () => {
  it("maps workspace paths to their program and nothing else", () => {
    const { programs } = setup();
    expect(programs.match("/code-server/static/x.js?v=1")).toBe(editor);
    expect(programs.match("/code-server")).toBe(editor);
    expect(programs.match("/jupyter/lab")).toBe(notebook);
    expect(programs.match("/code-serverx/")).toBeNull();
    expect(programs.match("/terminal")).toBeNull();
  });

  it("starts a stopped program on first use, once for concurrent requests, and waits until it answers", async () => {
    const { world, programs } = setup();
    await Promise.all([programs.use(editor), programs.use(editor)]);
    expect(world.running.has("code-server")).toBe(true);
    expect(world.execs.filter((a) => a[1] === "start")).toHaveLength(1);
    // Known up: later requests cost nothing.
    const before = world.execs.length;
    await programs.use(editor);
    expect(world.execs.length).toBe(before);
  });

  it("stops what the image started at boot when nobody used it, and leaves a program in use running", async () => {
    const { world, programs } = setup(["code-server", "jupyter"]);
    world.now += IDLE;
    programs.touch(notebook);
    await programs.reap();
    expect(world.running.has("code-server")).toBe(false);
    expect(world.running.has("jupyter")).toBe(true);
    // At most one look a minute, and none once nothing this side started is left.
    world.now += 30_000;
    const looks = world.execs.length;
    await programs.reap();
    expect(world.execs.length).toBe(looks);
  });

  it("stops a program it started once unused for the idle period", async () => {
    const { world, programs } = setup();
    await programs.use(editor);
    world.now += IDLE - 1000;
    await programs.reap();
    expect(world.running.has("code-server")).toBe(true);
    world.now += 2 * 60_000;
    await programs.reap();
    expect(world.running.has("code-server")).toBe(false);
    // The next use starts it again.
    await programs.use(editor);
    expect(world.running.has("code-server")).toBe(true);
  });

  it("switches only the image's boot start off, idempotently", async () => {
    const { world, programs } = setup();
    await programs.disableBootStart();
    const [sed] = world.execs;
    expect(sed!.slice(0, 4)).toEqual(["sed", "-i", "-E", "s/^autostart=%\\(ENV_AUTOSTART_[A-Z0-9_]+\\)s$/autostart=false/"]);
    expect(sed!.slice(4).every((f) => f.startsWith("/opt/gem/supervisord/supervisord."))).toBe(true);
    const rule = new RegExp(sed![3]!.slice(2, sed![3]!.lastIndexOf("/autostart=false/")));
    expect("autostart=%(ENV_AUTOSTART_CODE_SERVER)s".replace(rule, "autostart=false")).toBe("autostart=false");
    expect("autostart=true".replace(rule, "autostart=false")).toBe("autostart=true");
  });
});

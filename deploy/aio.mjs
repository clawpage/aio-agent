#!/usr/bin/env node
/**
 * Build, check and run the three layers with Docker Compose.
 *
 *   node deploy/aio.mjs init                 create the node token file if missing
 *   node deploy/aio.mjs build [layer...]     build images stamped with version labels
 *   node deploy/aio.mjs check                verify the selected images fit together
 *   node deploy/aio.mjs up                   check, then `docker compose up -d` and wait for health
 *   node deploy/aio.mjs run                  for a process supervisor: up, follow the logs, stop on SIGTERM
 *   node deploy/aio.mjs down | ps | logs [service] | config
 *   node deploy/aio.mjs import-data <dir>    copy a control data directory into the data volume
 *   node deploy/aio.mjs export-data <dir>    copy the data volume out (backup, rollback, moving machines)
 *
 * Settings come from AIO_ENV_FILE (default deploy/aio.env; see deploy/aio.env.example).
 * AIO_LAYERS picks the layers this machine runs (default ui,control,sandbox): a
 * sandbox-only machine sets AIO_LAYERS=sandbox, and so on.
 *
 * Compose itself knows nothing about compatibility, so `up` first reads the
 * labels every image carries (its version and the protocol numbers from
 * src/common/version.ts) and refuses a combination that does not fit. Each layer
 * checks again at runtime, which also covers layers on other machines.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LAYERS = ["sandbox", "control", "ui"];

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const at = t.indexOf("=");
    if (at > 0) out[t.slice(0, at).trim()] = t.slice(at + 1).trim();
  }
  return out;
}

const envFile = path.resolve(ROOT, process.env.AIO_ENV_FILE ?? "deploy/aio.env");
const settings = { ...loadEnvFile(envFile), ...pick(process.env, /^AIO_/) };
const packageVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const version = settings.AIO_VERSION ?? packageVersion;
const layers = (settings.AIO_LAYERS ?? "ui,control,sandbox").split(",").map((s) => s.trim()).filter(Boolean);
const prefix = settings.AIO_IMAGE_PREFIX ?? "";
const project = settings.AIO_PROJECT ?? "aio";
for (const l of layers) if (!LAYERS.includes(l)) die(`unknown layer ${l} (expected ${LAYERS.join(", ")})`);

const versionOf = (layer) => settings[`AIO_${layer.toUpperCase()}_VERSION`] ?? version;
const imageOf = (layer) => `${prefix}aio-agent-${layer}:${versionOf(layer)}`;

function pick(env, re) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => re.test(k)));
}

function die(message) {
  console.error(`aio: ${message}`);
  process.exit(1);
}

/** The compatibility numbers in src/common/version.ts, as this source tree declares them. */
function contract() {
  const text = fs.readFileSync(path.join(ROOT, "src/common/version.ts"), "utf8");
  const read = (name) => {
    const m = new RegExp(`export const ${name} = (\\d+);`).exec(text);
    if (!m) die(`src/common/version.ts has no ${name}`);
    return m[1];
  };
  return { API: read("API_VERSION"), API_MIN: read("API_MIN"), SP: read("SANDBOX_PROTOCOL"), SP_MIN: read("SANDBOX_PROTOCOL_MIN"), SP_MAX: read("SANDBOX_PROTOCOL_MAX") };
}

function build(selected) {
  const c = contract();
  const args = {
    ui: { AIO_API_REQUIRES: c.API },
    control: { AIO_API: c.API, AIO_API_MIN: c.API_MIN, AIO_SANDBOX_PROTOCOL_MIN: c.SP_MIN, AIO_SANDBOX_PROTOCOL_MAX: c.SP_MAX },
    sandbox: { AIO_SANDBOX_PROTOCOL: c.SP },
  };
  for (const layer of selected) {
    const image = imageOf(layer);
    console.log(`aio: building ${image}`);
    const buildArgs = Object.entries({ AIO_VERSION: versionOf(layer), ...args[layer] }).flatMap(([k, v]) => ["--build-arg", `${k}=${v}`]);
    const res = spawnSync("docker", ["build", "-f", `deploy/${layer}.Dockerfile`, "-t", image, ...buildArgs, "."], { cwd: ROOT, stdio: "inherit" });
    if (res.status !== 0) die(`building ${image} failed`);
  }
}

function labelsOf(image) {
  try {
    const out = execFileSync("docker", ["image", "inspect", image, "--format", "{{json .Config.Labels}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(out) ?? {};
  } catch {
    return null;
  }
}

/** The images this machine would run, and whether they fit together; exits on a mismatch. */
function check() {
  const found = {};
  const problems = [];
  for (const layer of layers) {
    const labels = labelsOf(imageOf(layer));
    if (!labels) problems.push(`${imageOf(layer)} is not built or pulled`);
    else if (labels["ai.aio.component"] !== layer) problems.push(`${imageOf(layer)} is not an aio ${layer} image`);
    else found[layer] = labels;
  }
  const num = (labels, key) => {
    const n = Number(labels[key]);
    if (!Number.isInteger(n) || labels[key] === "") problems.push(`missing label ${key}`);
    return n;
  };
  if (found.ui && found.control) {
    const need = num(found.ui, "ai.aio.api.requires");
    const [api, min] = [num(found.control, "ai.aio.api"), num(found.control, "ai.aio.api.min")];
    if (!(need >= min && need <= api)) problems.push(`ui ${found.ui["ai.aio.version"]} needs API v${need}; control ${found.control["ai.aio.version"]} serves v${min}-v${api}`);
  }
  if (found.control && found.sandbox) {
    const speaks = num(found.sandbox, "ai.aio.sandbox-protocol");
    const [min, max] = [num(found.control, "ai.aio.sandbox-protocol.min"), num(found.control, "ai.aio.sandbox-protocol.max")];
    if (!(speaks >= min && speaks <= max)) problems.push(`sandbox ${found.sandbox["ai.aio.version"]} speaks protocol ${speaks}; control ${found.control["ai.aio.version"]} drives ${min}-${max}`);
  }
  for (const [layer, labels] of Object.entries(found)) console.log(`aio: ${layer.padEnd(8)} ${imageOf(layer).padEnd(36)} version ${labels["ai.aio.version"]}`);
  const absent = LAYERS.filter((l) => !layers.includes(l));
  if (absent.length) console.log(`aio: not on this machine: ${absent.join(", ")} (checked at runtime by the layers themselves)`);
  if (problems.length) die(`incompatible or missing images:\n  - ${problems.join("\n  - ")}`);
  console.log("aio: images are compatible");
}

function composeArgs() {
  const files = layers.flatMap((l) => ["-f", path.join(ROOT, "deploy", `compose.${l}.yml`)]);
  const envArgs = fs.existsSync(envFile) ? ["--env-file", envFile] : [];
  return ["compose", "-p", project, "--project-directory", path.join(ROOT, "deploy"), ...envArgs, ...files];
}

/** Compose reads the per-layer versions from the environment this script resolved. */
function composeEnv() {
  const env = { ...process.env, ...settings };
  for (const layer of LAYERS) env[`AIO_${layer.toUpperCase()}_VERSION`] = versionOf(layer);
  return env;
}

function compose(args) {
  const child = spawn("docker", [...composeArgs(), ...args], { cwd: ROOT, stdio: "inherit", env: composeEnv() });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}

/**
 * Supervised mode (bin/serve): bring the stack up, stream its logs, and on
 * SIGTERM stop the containers before exiting, so stopping the service really
 * stops the layers (sandbox containers are not compose services and keep running).
 */
function run() {
  check();
  // Moving an existing host deployment over: its data directory seeds an empty volume
  // once, while nothing else is running. A volume that has a database is never touched.
  const seed = settings.AIO_SEED_DATA_FROM;
  if (seed && layers.includes("control") && !volumeHasData()) {
    console.log(`aio: seeding ${volume} from ${seed}`);
    importData(path.resolve(ROOT, seed), () => runStack());
    return;
  }
  runStack();
}

function runStack() {
  const up = spawnSync("docker", [...composeArgs(), "up", "-d", "--remove-orphans", "--wait", "--wait-timeout", settings.AIO_WAIT_SECONDS ?? "180"], { cwd: ROOT, stdio: "inherit", env: composeEnv() });
  if (up.status !== 0) die("compose up failed");
  const logs = spawn("docker", [...composeArgs(), "logs", "-f", "--since", "1s"], { cwd: ROOT, stdio: "inherit", env: composeEnv() });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`aio: ${signal}: stopping the layers`);
    logs.kill("SIGTERM");
    spawnSync("docker", [...composeArgs(), "stop", "-t", "8"], { cwd: ROOT, stdio: "inherit", env: composeEnv() });
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  // The log stream only ends when the containers are gone: let the supervisor start over.
  logs.on("exit", () => {
    if (!stopping) die("the layers stopped");
  });
}

function init() {
  const file = path.resolve(ROOT, settings.AIO_SECRET_NODE_TOKEN ?? "var/deploy/node-token.env");
  if (fs.existsSync(file)) return console.log(`aio: node token exists: ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `AIO_SANDBOX_NODE_TOKEN=${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  console.log(`aio: wrote node token ${file} (copy it to every machine of this deployment)`);
}

/**
 * The control plane's data (SQLite databases, owner secret, push keys, shares)
 * lives in a named volume. These copy it in and out with the control plane
 * stopped, so a database is never copied mid-write.
 */
const DATA_SKIP = ["cloudflared", "runtime.env", "deploy", "backups", "logs", "sandboxd", "sandbox-node.env", ".auth", ".playwright", ".playwright-local", ".playwright-artifacts", "server.pid"];
const volume = settings.AIO_CONTROL_DATA ?? "aio-control-data";

function controlRunning() {
  const out = spawnSync("docker", ["ps", "-q", "--filter", `volume=${volume}`], { encoding: "utf8" });
  return out.stdout.trim().length > 0;
}

function importData(dir, done = () => undefined) {
  if (!dir || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) die("import-data needs a directory");
  if (controlRunning()) die(`a container is using ${volume}; stop the control plane first`);
  const skip = (name) => DATA_SKIP.includes(name) || name.includes(".pre-compose-") || name.startsWith("domain-migration") || name.startsWith("task-browser-gate-backup");
  const entries = fs.readdirSync(dir).filter((name) => !skip(name));
  // COPYFILE_DISABLE: macOS tar would otherwise add ._* metadata files for every entry.
  const tar = spawn("tar", ["--no-xattrs", "-C", dir, "-cf", "-", ...entries], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const load = spawn("docker", ["run", "--rm", "-i", "--network", "none", "--user", "0", "--entrypoint", "sh", "-v", `${volume}:/data`, imageOf("control"), "-c", "tar -C /data -xf - && chown -R 1000:1000 /data && chmod 700 /data"], { stdio: ["pipe", "inherit", "inherit"] });
  tar.stdout.pipe(load.stdin);
  load.on("exit", (code) => {
    if (code !== 0) die("import failed");
    console.log(`aio: imported ${entries.length} entries from ${dir} into ${volume}`);
    done();
  });
}

/** Whether the data volume already holds a control plane's database. */
function volumeHasData() {
  const probe = spawnSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "test", "-v", `${volume}:/data:ro`, imageOf("control"), "-f", "/data/personal-agent.sqlite"]);
  return probe.status === 0;
}

function exportData(dir) {
  if (!dir) die("export-data needs a target directory");
  if (controlRunning()) die(`a container is using ${volume}; stop the control plane first`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dump = spawn("docker", ["run", "--rm", "--network", "none", "--user", "0", "--entrypoint", "tar", "-v", `${volume}:/data:ro`, imageOf("control"), "-C", "/data", "-cf", "-", "."], { stdio: ["ignore", "pipe", "inherit"] });
  const unpack = spawn("tar", ["-C", dir, "-xf", "-"], { stdio: ["pipe", "inherit", "inherit"] });
  dump.stdout.pipe(unpack.stdin);
  unpack.on("exit", (code) => {
    if (code !== 0) die("export failed");
    console.log(`aio: exported ${volume} to ${dir}`);
  });
}

const [command = "help", ...rest] = process.argv.slice(2);
switch (command) {
  case "init":
    init();
    break;
  case "build":
    build(rest.length ? rest : layers);
    break;
  case "check":
    check();
    break;
  case "up":
    check();
    compose(["up", "-d", "--remove-orphans", "--wait", "--wait-timeout", settings.AIO_WAIT_SECONDS ?? "180"]);
    break;
  case "run":
    run();
    break;
  case "down":
    compose(["down", "--remove-orphans"]);
    break;
  case "import-data":
    importData(rest[0] && path.resolve(rest[0]));
    break;
  case "export-data":
    exportData(rest[0] && path.resolve(rest[0]));
    break;
  case "ps":
  case "logs":
  case "config":
    compose([command, ...rest]);
    break;
  default:
    {
      const lines = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n");
      console.log(lines.slice(2, lines.indexOf(" */")).join("\n").replace(/^ \* ?/gm, ""));
    }
    process.exit(command === "help" ? 0 : 1);
}

import type { EnvInfo } from "./catalog.js";

/**
 * How the agent chooses where to act (docs/EXEC-ENVS.md, "Choosing the environment"): the rules, said
 * once in every execution thread, and a short brief at the start of each turn with what is online now
 * and where the message came from. Model-facing, so English.
 */
export const ENV_POLICY =
  "You run in the sandbox, but you can act in other execution environments: the user's own devices linked to their account (a Mac, an iPhone, Android phones), each reached through aio_env with an env id from env_list. Each environment lists its capabilities (browser, files, photos, reminders, calendar, apps, screen, shell); use a tool only on an environment that has its capability. " +
  "Choose the environment per task: (1) when the user is using one of their devices right now (the turn's brief says so), work that concerns that device goes there first: its apps, its photos and schedule, and websites the user wants to use on it (their sign-ins are there); " +
  "(2) everything else stays in the sandbox with your own tools: research, files, code, documents, long or background work, and scheduled runs stay in the sandbox (nobody is at a device then, and phones sleep); " +
  "(3) when a device is offline or its app is not on screen, fall back to the sandbox if the work allows, otherwise tell the user in one sentence what to do (open the app and keep it on screen) and do not keep retrying. " +
  "Paying, granting permissions, signing in for the user, sending messages or mail, and deleting are confirmed by the user on the device itself: a call that answers it is waiting for the user to confirm means exactly that; tell the user and wait, never work around it. Photos, files and pages from a device are private: do not send them anywhere the user did not ask for.";

const PLATFORM_KIND: Record<string, EnvInfo["kind"]> = { ios: "ios", android: "android", mac: "mac" };

/** The start of a turn: the environments online now, and the device the user is on, if they are using one of theirs. */
export function envBrief(envs: EnvInfo[], platform: string | null | undefined): string {
  const devices = envs.filter((e) => e.kind !== "sandbox");
  if (!devices.length) return "";
  const kind = platform ? PLATFORM_KIND[platform] : undefined;
  const using = kind ? devices.find((e) => e.kind === kind && e.online && e.foreground) : undefined;
  const lines = devices.map((e) => `- ${e.name} (${e.id}, ${e.kind}): ${e.online ? `online${e.foreground ? ", app on screen" : ""}` : "offline"}; ${e.capabilities.length ? e.capabilities.join(", ") : "nothing turned on"}${e === using ? " — the user is using it now: prefer it for what concerns this device" : ""}`);
  return ["Execution environments now (aio_env; the sandbox is always there):", ...lines].join("\n");
}

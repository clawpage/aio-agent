/**
 * The iPhone app's own abilities for the agent (src/ui/tauri, DeviceTools.swift): its Photos,
 * Reminders and Calendar, given to the account signed in here. The console turns each on (which is
 * when iOS asks for the permission), hands the app a device token its account just issued, and says
 * who is signed in; the app answers every message with its state. Only the app's main frame on the
 * console origin has this handler; a browser never does.
 */
export type Ability = "photos" | "reminders" | "calendar";
export const ABILITIES: readonly Ability[] = ["photos", "reminders", "calendar"];
/** What iOS allows: "limited" is Photos with a selection of photos only; "writeOnly" is not enough to read. */
export type Permission = "authorized" | "limited" | "denied" | "writeOnly" | "notDetermined";
export type ToolsState = "off" | "connecting" | "online" | "offline" | "revoked";

export interface NativeTools {
  linked: boolean;
  linkId: string | null;
  state: ToolsState;
  /** This iPhone's name, offered as the link's name. */
  name: string;
  abilities: Record<Ability, { enabled: boolean; permission: Permission }>;
}

type Message =
  | { type: "status" | "unlink" | "settings" }
  | { type: "account"; account: string | null }
  | { type: "link"; token: string; linkId: string; account: string }
  | { type: "enable" | "disable"; ability: Ability };
/** Messages are JSON strings; the app's reply is the state, as JSON. */
type ToolsBridge = { postMessage(message: string): Promise<string> };
type ToolsWindow = Window & { webkit?: { messageHandlers?: { aioDeviceTools?: ToolsBridge } } };

function bridge(): ToolsBridge | undefined {
  return (window as ToolsWindow).webkit?.messageHandlers?.aioDeviceTools;
}

export function hasDeviceTools(): boolean {
  return Boolean(bridge());
}

/** One message to the app; its answer is the state after it. */
export async function askDeviceTools(message: Message): Promise<NativeTools> {
  const app = bridge();
  if (!app) throw new Error("no device tools");
  return JSON.parse(await app.postMessage(JSON.stringify(message))) as NativeTools;
}

/** Follow the app's state as its connection changes. */
export function listenDeviceTools(callback: (state: NativeTools) => void): () => void {
  const listener = (event: Event) => callback((event as CustomEvent<NativeTools>).detail);
  window.addEventListener("aio-device-tools", listener);
  return () => window.removeEventListener("aio-device-tools", listener);
}

/**
 * Who is signed in here (null: nobody). The app connects only for the account its link belongs to,
 * pauses while nobody is signed in, and forgets the link when another account signs in.
 */
export function syncDeviceToolsAccount(account: string | null): void {
  if (bridge()) void askDeviceTools({ type: "account", account }).catch(() => undefined);
}

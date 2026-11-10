/**
 * The phone app's own abilities for the agent, given to the account signed in here. The iPhone app
 * (src/ui/tauri, DeviceTools.swift) has its Photos, Reminders and Calendar, each turned on by the console
 * (which is when iOS asks for the permission); the Android app (DeviceTools.kt) has only its browser and
 * folder, turned on as a whole by handing it a link. Either way the console hands the app a device token
 * its account just issued and says who is signed in; the app answers every message with its state. Only
 * the app's main frame on the console origin has this bridge; a browser never does.
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
  /** This phone's name, offered as the link's name. */
  name: string;
  /** Empty on Android, which has no abilities to turn on one by one. */
  abilities: Record<Ability, { enabled: boolean; permission: Permission }>;
}

type Message =
  | { type: "status" | "unlink" | "settings" }
  | { type: "account"; account: string | null }
  | { type: "link"; token: string; linkId: string; account: string }
  | { type: "enable" | "disable"; ability: Ability };
/** Messages are JSON strings. iOS: a reply handler whose promise is the state, as JSON. */
type WebkitBridge = { postMessage(message: string): Promise<string> };
/** Android: a web message listener that answers with a message repeating the `seq` it was sent with. */
type AndroidBridge = { postMessage(message: string): void; addEventListener(type: "message", listener: (event: MessageEvent<string>) => void): void };
type ToolsWindow = Window & { webkit?: { messageHandlers?: { aioDeviceTools?: WebkitBridge } }; aioDeviceTools?: AndroidBridge };
export type DeviceApp = "ios" | "android";

/** Which phone app this console runs in, if any. */
export function deviceToolsApp(): DeviceApp | null {
  const shell = window as ToolsWindow;
  if (shell.webkit?.messageHandlers?.aioDeviceTools) return "ios";
  return shell.aioDeviceTools ? "android" : null;
}

export function hasDeviceTools(app: DeviceApp): boolean {
  return deviceToolsApp() === app;
}

/** Android answers out of band, so each message carries a number its answer repeats. */
const androidWaiting = new Map<number, (reply: NativeTools & { error?: string }) => void>();
let androidSeq = 0;
let androidListening = false;

function androidAsk(app: AndroidBridge, message: Message): Promise<NativeTools> {
  if (!androidListening) {
    androidListening = true;
    app.addEventListener("message", (event) => {
      const { seq, ...reply } = JSON.parse(event.data) as NativeTools & { seq: number; error?: string };
      androidWaiting.get(seq)?.(reply);
      androidWaiting.delete(seq);
    });
  }
  return new Promise((resolve, reject) => {
    const seq = ++androidSeq;
    androidWaiting.set(seq, ({ error, ...state }) => error ? reject(new Error(error)) : resolve(state as NativeTools));
    app.postMessage(JSON.stringify({ ...message, seq }));
  });
}

/** One message to the app; its answer is the state after it. */
export async function askDeviceTools(message: Message): Promise<NativeTools> {
  const shell = window as ToolsWindow;
  const ios = shell.webkit?.messageHandlers?.aioDeviceTools;
  if (ios) return JSON.parse(await ios.postMessage(JSON.stringify(message))) as NativeTools;
  if (shell.aioDeviceTools) return androidAsk(shell.aioDeviceTools, message);
  throw new Error("no device tools");
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
  if (deviceToolsApp()) void askDeviceTools({ type: "account", account }).catch(() => undefined);
}

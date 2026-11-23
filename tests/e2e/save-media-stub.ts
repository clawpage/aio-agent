import type { Page } from "@playwright/test";

/**
 * Stands in for the apps' `aioSaveMedia` bridge (DeviceBrowser.swift on iOS, a web
 * message listener in MainActivity.kt on Android): it answers begin / chunk /
 * finish / cancel / settings as the apps do and records what reached Photos.
 * "finish" waits for `release()` so a test can see the page say 下载中… first.
 * The share sheet is stubbed too, to show it is not what saved the file.
 * `files`: an iOS shell with the `aioSaveToFiles` marker, whose "finish" for a
 * file sent `to: "files"` stands for the Files picker (`cancelFiles`: closed unsaved).
 */
export type Platform = "ios" | "android";

export interface SaveLog {
  begun: { name: string; mime: string; to?: string }[];
  /** Bytes of each finished file, reassembled from its chunks. */
  saved: number[];
  chunks: number;
  cancelled: number;
  settings: number;
  shared: number;
}

export async function stubSaveMedia(page: Page, platform: Platform, opts: { deny?: boolean; files?: boolean; cancelFiles?: boolean } = {}): Promise<void> {
  await page.addInitScript(({ platform, deny, files, cancelFiles }) => {
    const log = { begun: [] as { name: string; mime: string; to?: string }[], saved: [] as number[], chunks: 0, cancelled: 0, settings: 0, shared: 0 };
    const open = new Map<string, number>();
    const toFiles = new Set<string>();
    let next = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(window, { __saveLog: log, __release: () => release() });
    type Message = { type: string; id?: string; name?: string; mime?: string; data?: string; to?: string };
    const answer = async (message: Message): Promise<Record<string, string>> => {
      switch (message.type) {
        case "begin": {
          if (deny) return { error: "denied" };
          log.begun.push({ name: message.name ?? "", mime: message.mime ?? "", ...(message.to ? { to: message.to } : {}) });
          const id = `t${++next}`;
          if (message.to === "files") toFiles.add(id);
          open.set(id, 0);
          return { id };
        }
        case "chunk":
          log.chunks += 1;
          open.set(message.id!, (open.get(message.id!) ?? 0) + atob(message.data ?? "").length);
          return {};
        case "finish":
          await held;
          if (toFiles.has(message.id!) && cancelFiles) { open.delete(message.id!); return { error: "cancelled" }; }
          log.saved.push(open.get(message.id!) ?? -1);
          open.delete(message.id!);
          return {};
        case "cancel":
          log.cancelled += 1;
          return {};
        case "settings":
          log.settings += 1;
          return {};
        default:
          return { error: "unknown" };
      }
    };
    const plain = { postMessage: () => undefined };
    if (platform === "ios") {
      const aioSaveMedia = { postMessage: async (text: string) => JSON.stringify(await answer(JSON.parse(text) as Message)) };
      Object.assign(window, { webkit: { messageHandlers: { aioDeviceBrowser: plain, aioSaveFiles: plain, aioSaveMedia, ...(files ? { aioSaveToFiles: plain } : {}) } } });
    } else {
      const listeners: ((event: { data: string }) => void)[] = [];
      Object.assign(window, {
        aioDeviceBrowser: plain,
        aioSaveMedia: {
          addEventListener: (_type: string, listener: (event: { data: string }) => void) => listeners.push(listener),
          postMessage: (text: string) => {
            const message = JSON.parse(text) as Message & { seq: number };
            void answer(message).then((reply) => {
              const data = JSON.stringify({ ...reply, seq: message.seq });
              setTimeout(() => listeners.forEach((listener) => listener({ data })), 0);
            });
          },
        },
      });
    }
    Object.defineProperty(navigator, "canShare", { value: () => true });
    Object.defineProperty(navigator, "share", { value: async () => { log.shared += 1; } });
  }, { platform, deny: opts.deny ?? false, files: opts.files ?? false, cancelFiles: opts.cancelFiles ?? false });
}

export const saveLog = (page: Page) => page.evaluate(() => (window as unknown as { __saveLog: SaveLog }).__saveLog);
export const releaseSave = (page: Page) => page.evaluate(() => (window as unknown as { __release: () => void }).__release());

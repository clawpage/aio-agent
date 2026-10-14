/**
 * Camera cards in messages: a Home Assistant camera, live or played back from
 * its recording. An executor writes a fenced block:
 *
 *   ```camera
 *   {"camera": "camera.c201_go2rtc"}
 *   ```
 *
 * adding `"at": "2026-10-13 20:38:10"` (the house's local time) to play the
 * recording from that moment, and optionally a `"title"`. Video, pictures and
 * pan/tilt all go through the control plane (/api/cameras), which admits only
 * the accounts granted Home Assistant. A block that does not parse stays an
 * ordinary code block.
 */

export interface CameraSpec {
  camera: string;
  /** Local time to play back from; null for live. */
  at: string | null;
  title: string | null;
}

export type CameraPart = { kind: "camera"; spec: CameraSpec };

const FENCE = /^```camera[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

export function parseCamera(raw: string): CameraSpec | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const camera = typeof (r.camera ?? r.entity) === "string" ? String(r.camera ?? r.entity).trim() : "";
  if (!/^camera\.[a-z0-9_]+$/.test(camera)) return null;
  const at = typeof r.at === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}(?::\d{2})?$/.test(r.at.trim()) ? r.at.trim().replace("T", " ") : null;
  const title = typeof r.title === "string" && r.title.trim() ? [...r.title.trim()].slice(0, 40).join("") : null;
  return { camera, at, title };
}

/** Split a text part into text and camera cards, in order. */
export function splitCameraBlocks(source: string): Array<{ kind: "text"; text: string } | CameraPart> {
  const parts: Array<{ kind: "text"; text: string } | CameraPart> = [];
  let last = 0;
  for (const match of source.matchAll(FENCE)) {
    const spec = parseCamera(match[1]!);
    if (!spec) continue;
    if (match.index! > last) parts.push({ kind: "text", text: source.slice(last, match.index) });
    parts.push({ kind: "camera", spec });
    last = match.index! + match[0].length;
  }
  if (parts.length === 0) return [{ kind: "text", text: source }];
  if (last < source.length) parts.push({ kind: "text", text: source.slice(last) });
  return parts.filter((p) => p.kind === "camera" || p.text.trim() !== "");
}

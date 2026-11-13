import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiUrl, API_BASE, ApiError, type CameraInfo } from "../api";
import type { CameraSpec } from "../cameraBlocks";
import { useNearViewport } from "./ProductCards";
import { downloadFile } from "../saveFile";
import { locale, t } from "../i18n";

type Playback = { url: string; hls?: string | null; offset: number; start: number; end: number; next: number | null };
type Direction = "left" | "right" | "up" | "down";

const SNAPSHOT_REFRESH_MS = 10_000;

/** A wall-clock time in the house's zone (the server's), not the viewer's. */
function clock(ms: number, timeZone: string, withDate: boolean): string {
  try {
    return new Intl.DateTimeFormat(locale, { timeZone, hour12: false, ...(withDate ? { month: "numeric", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toLocaleTimeString(locale);
  }
}

/** The same moment as a file name stamp: 2026-11-12_16-54-00. */
function stamp(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short", timeStyle: "medium" }).format(ms).replace(" ", "_").replace(/:/g, "-");
  } catch {
    return String(ms);
  }
}

/** What the save button on a recording keeps, from the moment on screen. */
const SAVE_SECONDS = 60;

function messageOf(err: unknown): string {
  if (err instanceof ApiError && err.status === 404 && err.code === "camera_unavailable") return t.cards.camera.noAccess;
  return err instanceof Error && err.message ? err.message : t.cards.camera.unavailable;
}

/**
 * Plays an HLS address in a video element: natively in Apple's WebKit (Safari,
 * iOS, the iOS app), otherwise through hls.js, loaded only when needed. Chrome
 * also answers "maybe" for HLS now, but its built-in player cannot parse Home
 * Assistant's low-latency playlists (DEMUXER_ERROR_COULD_NOT_PARSE).
 * `startAt` is for a recording: where in it to begin, in seconds.
 */
async function attachHls(video: HTMLVideoElement, url: string, onFatal: () => void, startAt?: number): Promise<() => void> {
  const native = Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
  const playNatively = () => {
    const seek = () => { if (startAt) video.currentTime = startAt; };
    video.addEventListener("loadedmetadata", seek, { once: true });
    video.src = url;
    return () => { video.removeEventListener("loadedmetadata", seek); video.removeAttribute("src"); video.load(); };
  };
  if (native && navigator.vendor.startsWith("Apple")) return playNatively();
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) {
    if (native) return playNatively();
    throw new Error(t.cards.camera.unsupported);
  }
  const hls = new Hls({ enableWorker: false, lowLatencyMode: startAt === undefined, backBufferLength: 30, ...(startAt === undefined ? {} : { startPosition: startAt }), xhrSetup: (xhr) => { xhr.withCredentials = Boolean(API_BASE); } });
  hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) onFatal(); });
  hls.loadSource(url);
  hls.attachMedia(video);
  return () => hls.destroy();
}

/** How long live video may take to show its first frame: a stream that was asleep needs about 20 seconds. */
const LIVE_START_TIMEOUT_MS = 45_000;

/** Live video. The snapshot stays on screen until the first frame, so the card is never a black box while the stream starts. */
function LiveVideo({ entity, poster, onError }: { entity: string; poster: string; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let detach: (() => void) | null = null;
    let live = true;
    const el = video.current;
    const giveUp = setTimeout(() => { if (live) onError(t.cards.camera.dropped); }, LIVE_START_TIMEOUT_MS);
    const started = () => clearTimeout(giveUp);
    el?.addEventListener("playing", started);
    void (async () => {
      try {
        const { url } = await api.cameraLive(entity);
        if (!live || !video.current) return;
        detach = await attachHls(video.current, apiUrl(url), () => onError(t.cards.camera.dropped));
        if (!live) detach();
        else void video.current.play().catch(() => undefined);
      } catch (err) {
        if (live) onError(messageOf(err));
      }
    })();
    return () => { live = false; clearTimeout(giveUp); el?.removeEventListener("playing", started); detach?.(); };
  }, [entity, onError]);
  // The element's own error is the only failure signal where the browser plays HLS itself (Safari, iOS).
  return <video ref={video} className="camera-media" poster={poster} muted autoPlay playsInline controls crossOrigin={API_BASE ? "use-credentials" : undefined} onError={() => onError(t.cards.camera.dropped)} />;
}

/**
 * A recording from a moment. Nothing of the video is fetched until it is started: the picture at that moment
 * stands in. It then plays the piece's playlist, which reaches the moment without reading the piece from its
 * start; a piece without one (still being written) plays as the bare file.
 */
function PlaybackVideo({ entity, at, onTime, onError }: { entity: string; at: string; onTime: (ms: number) => void; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [piece, setPiece] = useState<Playback | null>(null);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [still, setStill] = useState(true);
  useEffect(() => {
    let live = true;
    api.cameraPlayback(entity, at).then((p) => { if (live) setPiece(p); }, (err) => { if (live) onError(messageOf(err)); });
    return () => { live = false; };
  }, [entity, at, onError]);
  useEffect(() => { if (piece) onTime(piece.start + piece.offset * 1000); }, [piece, onTime]);
  useEffect(() => {
    const el = video.current;
    if (!started || !piece || !el) return;
    let live = true;
    let detach: (() => void) | null = null;
    const play = () => void el.play().catch(() => undefined);
    const plain = () => {
      el.src = `${apiUrl(piece.url)}#t=${piece.offset.toFixed(1)}`;
      play();
      return () => { el.removeAttribute("src"); el.load(); };
    };
    if (!piece.hls) detach = plain();
    else {
      void attachHls(el, apiUrl(piece.hls), () => onError(t.cards.camera.recordingGone), piece.offset).then(
        (d) => { if (live) { detach = d; play(); } else d(); },
        () => { if (live) detach = plain(); },
      );
    }
    return () => { live = false; detach?.(); };
  }, [started, piece, onError]);
  const playOn = useCallback(() => {
    if (!piece?.next) { setEnded(true); return; }
    api.cameraPlayback(entity, piece.next).then((p) => setPiece({ ...p, offset: 0 }), (err) => onError(messageOf(err)));
  }, [entity, piece, onError]);
  if (!piece) return <div className="camera-media camera-wait">{t.cards.camera.loading}</div>;
  if (!started) {
    return (
      <>
        {still
          ? <img className="camera-media" src={api.cameraFrameUrl(entity, Math.round(piece.start + piece.offset * 1000))} alt="" onError={() => setStill(false)} />
          : <div className="camera-media" />}
        <button type="button" className="camera-play" onClick={() => setStarted(true)} aria-label={t.cards.camera.startRecording}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>
        </button>
      </>
    );
  }
  return (
    <>
      <video
        ref={video}
        key={piece.url}
        className="camera-media"
        controls
        playsInline
        crossOrigin={API_BASE ? "use-credentials" : undefined}
        onTimeUpdate={(e) => onTime(piece.start + e.currentTarget.currentTime * 1000)}
        onPlay={() => setEnded(false)}
        onEnded={playOn}
        onError={() => onError(t.cards.camera.recordingGone)}
      />
      {ended && <span className="camera-chip camera-ended">{t.cards.camera.recordingEnded}</span>}
    </>
  );
}

/** A camera in a message: live video (or refreshed snapshots) with pan/tilt, or its recording from a moment. */
export function CameraCard({ spec }: { spec: CameraSpec }) {
  const box = useRef<HTMLElement>(null);
  const near = useNearViewport(box);
  const [info, setInfo] = useState<{ camera: CameraInfo; timeZone: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"live" | "playback">(spec.at ? "playback" : "live");
  const [playing, setPlaying] = useState(false);
  const [shot, setShot] = useState(() => Date.now());
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [time, setTime] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!near) return;
    const ctrl = new AbortController();
    setError(null);
    api.camera(spec.camera, ctrl.signal).then(setInfo, (err) => { if (!ctrl.signal.aborted) setError(messageOf(err)); });
    return () => ctrl.abort();
  }, [near, spec.camera, attempt]);

  // A camera without live video here (Ring) shows snapshots, refreshed while the card is on screen.
  const snapshotsOnly = Boolean(info && !info.camera.live);
  useEffect(() => {
    if (mode !== "live" || !snapshotsOnly || !box.current || typeof IntersectionObserver !== "function") return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const observer = new IntersectionObserver(([entry]) => {
      if (timer) clearInterval(timer);
      timer = entry?.isIntersecting ? setInterval(() => setShot(Date.now()), SNAPSHOT_REFRESH_MS) : null;
    });
    observer.observe(box.current);
    return () => { observer.disconnect(); if (timer) clearInterval(timer); };
  }, [mode, snapshotsOnly]);

  const fail = useCallback((message: string) => { setError(message); setPlaying(false); }, []);
  const retry = () => { setError(null); setPlaying(false); setShot(Date.now()); setAttempt((n) => n + 1); };

  const turn = async (direction: Direction) => {
    setMoving(true);
    setNote(null);
    try {
      await api.cameraPtz(spec.camera, { direction });
      if (!playing) setTimeout(() => setShot(Date.now()), 1200);
    } catch (err) {
      setNote(t.cards.camera.turnFailed(messageOf(err)));
    } finally {
      setMoving(false);
    }
  };

  const camera = info?.camera;
  const name = spec.title ?? camera?.name ?? spec.camera;
  const canSwitch = Boolean(spec.at && camera?.recordings);
  return (
    <section ref={box} className="camera-card" aria-label={t.cards.camera.label(name)}>
      <header className="camera-card-head">
        <strong>{name}</strong>
        {mode === "live"
          ? <span className="camera-badge"><span className="camera-dot" aria-hidden="true" />{snapshotsOnly ? t.cards.camera.snapshot : t.cards.camera.live}</span>
          : <span className="camera-badge">{t.cards.camera.playback(time !== null && info ? clock(time, info.timeZone, true) : spec.at ?? "")}</span>}
        {canSwitch && (
          <button type="button" className="camera-switch" onClick={() => { setError(null); setPlaying(false); setMode(mode === "live" ? "playback" : "live"); }}>
            {mode === "live" ? t.cards.camera.backToPlayback : t.cards.camera.watchLive}
          </button>
        )}
      </header>
      <div className="camera-stage">
        {error ? (
          <div className="camera-media camera-wait camera-error">
            <span>{error}</span>
            <button type="button" onClick={retry}>{t.cards.camera.retry}</button>
          </div>
        ) : !info ? (
          <div className="camera-media camera-wait">{t.cards.camera.loading}</div>
        ) : mode === "playback" && spec.at ? (
          <PlaybackVideo entity={spec.camera} at={spec.at} onTime={setTime} onError={fail} />
        ) : playing ? (
          <LiveVideo entity={spec.camera} poster={api.cameraSnapshotUrl(spec.camera, shot)} onError={fail} />
        ) : (
          <>
            <img className="camera-media" src={api.cameraSnapshotUrl(spec.camera, shot)} alt={t.cards.camera.label(name)} onError={() => setError(t.cards.camera.unavailable)} />
            {!snapshotsOnly && (
              <button type="button" className="camera-play" onClick={() => setPlaying(true)} aria-label={t.cards.camera.start}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" /></svg>
              </button>
            )}
          </>
        )}
        {mode === "live" && camera?.ptz && !error && (
          <div className="camera-ptz">
            {(["up", "left", "right", "down"] as const).map((d) => (
              <button key={d} type="button" className={`camera-ptz-${d}`} disabled={moving} onClick={() => void turn(d)} aria-label={t.cards.camera.turn[d]} title={t.cards.camera.turn[d]}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14.5 12 9.5l5 5" /></svg>
              </button>
            ))}
          </div>
        )}
      </div>
      {mode === "playback" && info && time !== null && !error && (
        <div className="camera-foot">
          <button
            type="button"
            className="camera-switch"
            title={t.cards.camera.saveHint(clock(time, info.timeZone, false))}
            onClick={() => downloadFile(api.cameraClipUrl(spec.camera, time, SAVE_SECONDS), `${spec.camera.slice("camera.".length)}-${stamp(time, info.timeZone)}.mp4`)}
          >
            {t.cards.camera.save}
          </button>
        </div>
      )}
      {(note || (mode === "live" && snapshotsOnly && !error)) && <p className="camera-note">{note ?? t.cards.camera.snapshotOnly}</p>}
    </section>
  );
}

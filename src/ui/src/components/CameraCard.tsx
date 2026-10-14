import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiUrl, API_BASE, ApiError, type CameraInfo } from "../api";
import type { CameraSpec } from "../cameraBlocks";
import { useNearViewport } from "./ProductCards";
import { t } from "../i18n";

type Playback = { url: string; offset: number; start: number; end: number; next: number | null };
type Direction = "left" | "right" | "up" | "down";

const SNAPSHOT_REFRESH_MS = 10_000;

/** A wall-clock time in the house's zone (the server's), not the viewer's. */
function clock(ms: number, timeZone: string, withDate: boolean): string {
  try {
    return new Intl.DateTimeFormat(undefined, { timeZone, hour12: false, ...(withDate ? { month: "numeric", day: "numeric" } : {}), hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toLocaleTimeString();
  }
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError && err.status === 404 && err.code === "camera_unavailable") return t.cards.camera.noAccess;
  return err instanceof Error && err.message ? err.message : t.cards.camera.unavailable;
}

/**
 * Plays an HLS address in a video element: natively where the browser can
 * (Safari, iOS, Android), otherwise through hls.js, loaded only when needed.
 */
async function attachHls(video: HTMLVideoElement, url: string, onFatal: () => void): Promise<() => void> {
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    return () => { video.removeAttribute("src"); video.load(); };
  }
  const { default: Hls } = await import("hls.js");
  if (!Hls.isSupported()) throw new Error(t.cards.camera.unsupported);
  const hls = new Hls({ enableWorker: false, lowLatencyMode: true, backBufferLength: 30, xhrSetup: (xhr) => { xhr.withCredentials = Boolean(API_BASE); } });
  hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) onFatal(); });
  hls.loadSource(url);
  hls.attachMedia(video);
  return () => hls.destroy();
}

function LiveVideo({ entity, onError }: { entity: string; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let detach: (() => void) | null = null;
    let live = true;
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
    return () => { live = false; detach?.(); };
  }, [entity, onError]);
  return <video ref={video} className="camera-media" muted autoPlay playsInline controls crossOrigin={API_BASE ? "use-credentials" : undefined} />;
}

function PlaybackVideo({ entity, at, timeZone, onClock, onError }: { entity: string; at: string; timeZone: string; onClock: (text: string) => void; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [piece, setPiece] = useState<Playback | null>(null);
  const [ended, setEnded] = useState(false);
  const autoplay = useRef(false);
  useEffect(() => {
    let live = true;
    api.cameraPlayback(entity, at).then((p) => { if (live) setPiece(p); }, (err) => { if (live) onError(messageOf(err)); });
    return () => { live = false; };
  }, [entity, at, onError]);
  useEffect(() => { if (piece) onClock(clock(piece.start + piece.offset * 1000, timeZone, true)); }, [piece, timeZone, onClock]);
  const playOn = useCallback(() => {
    if (!piece?.next) { setEnded(true); return; }
    autoplay.current = true;
    api.cameraPlayback(entity, piece.next).then((p) => setPiece({ ...p, offset: 0 }), (err) => onError(messageOf(err)));
  }, [entity, piece, onError]);
  if (!piece) return <div className="camera-media camera-wait">{t.cards.camera.loading}</div>;
  return (
    <>
      <video
        ref={video}
        key={piece.url}
        className="camera-media"
        src={`${apiUrl(piece.url)}#t=${piece.offset.toFixed(1)}`}
        poster={api.cameraFrameUrl(entity, Math.round(piece.start + piece.offset * 1000))}
        preload="metadata"
        controls
        playsInline
        autoPlay={autoplay.current}
        crossOrigin={API_BASE ? "use-credentials" : undefined}
        onTimeUpdate={(e) => onClock(clock(piece.start + e.currentTarget.currentTime * 1000, timeZone, true))}
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
  const [time, setTime] = useState<string | null>(null);
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
          : <span className="camera-badge">{t.cards.camera.playback(time ?? spec.at ?? "")}</span>}
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
          <PlaybackVideo entity={spec.camera} at={spec.at} timeZone={info.timeZone} onClock={setTime} onError={fail} />
        ) : playing ? (
          <LiveVideo entity={spec.camera} onError={fail} />
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
      {(note || (mode === "live" && snapshotsOnly && !error)) && <p className="camera-note">{note ?? t.cards.camera.snapshotOnly}</p>}
    </section>
  );
}

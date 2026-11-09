import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { MAX_SECONDS, MIN_SECONDS, startRecording, voiceSupported, type Recording } from "../voice";
import { ComposerIcon } from "./ComposerControls";
import { locale, t } from "../i18n";
import { haptic } from "../haptics";
import { tapProps } from "../tap";

const WARM_EVERY_MS = 4_000;
/**
 * An upload that stalls on a phone's network (22 s and 47 s for about 300 KB that usually take 0.3 s)
 * is sent again on a new request: the upload alone gets this long, plus a second for every 100 KB,
 * then once more. Once it is all sent, the server (recognition, then at most 6 s of polishing) gets ANSWER_MS.
 */
const UPLOAD_MS = 3_000;
const UPLOAD_MS_PER_KB = 10;
const ANSWER_MS = 20_000;
const ATTEMPTS = 2;

/** Why the microphone would not open, in words the user can act on. */
function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t.voice.micErrors.denied;
  if (name === "NotFoundError" || name === "OverconstrainedError") return t.voice.micErrors.notFound;
  if (name === "NotReadableError") return t.voice.micErrors.busy;
  return t.voice.micErrors.other;
}

/**
 * The composer's microphone: tap to talk, tap again to stop (a minute at most;
 * under a second is ignored).
 * What was said is added to the draft for a look before sending. Hidden when
 * the browser cannot record, no speech recognizer is configured, or it does not
 * hear the console's language.
 */
export function VoiceButton({ disabled, onText, onError }: { disabled: boolean; onText: (text: string) => void; onError: (message: string | null) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const recording = useRef<Recording | null>(null);
  /** Stops the transcription under way: a tap while it loads cancels it. */
  const transcription = useRef<AbortController | null>(null);
  /** When the microphone started listening. */
  const startedAt = useRef(0);
  const button = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  useEffect(() => {
    if (!voiceSupported()) return;
    let live = true;
    // Only in a language the speech server hears; an older control plane lists none and allows any.
    api.asr().then(r => { if (live) setEnabled(r.enabled && (!r.locales || r.locales.includes(locale))); }).catch(() => { /* an older control plane: no voice input */ });
    return () => { live = false; recording.current?.cancel(); recording.current = null; transcription.current?.abort(); };
  }, []);

  const finish = async () => {
    const r = recording.current;
    if (!r) return;
    recording.current = null;
    if (Date.now() - startedAt.current < MIN_SECONDS * 1000) { r.cancel(); setState("idle"); return; }
    haptic("tap");
    setState("transcribing");
    const cancel = new AbortController();
    transcription.current = cancel;
    try {
      const stopped = performance.now();
      const audio = r.stop();
      const sent = performance.now();
      const uploadLimit = UPLOAD_MS + Math.round(audio.byteLength / 1024) * UPLOAD_MS_PER_KB;
      let attempts = 0, uploadMs: number | null = null, answer: { text: string; ref?: string } | null = null;
      while (!answer) {
        attempts += 1;
        const attempt = new AbortController();
        const stop = () => attempt.abort();
        cancel.signal.addEventListener("abort", stop);
        const began = performance.now();
        let stalled = false, uploading = false;
        // All sent: from here only the server's answer is waited for, and a slow one is not sent again.
        const awaitAnswer = () => { clearTimeout(timer); timer = setTimeout(stop, ANSWER_MS); };
        // Only an upload the browser says began and has not finished counts as stalled; one it says nothing about is not judged.
        let timer = setTimeout(() => { if (uploading) { stalled = true; stop(); } else awaitAnswer(); }, uploadLimit);
        const onSent = () => { uploading = false; uploadMs = performance.now() - began; awaitAnswer(); };
        try {
          answer = await api.transcribe(audio, r.microphone, { signal: attempt.signal, onStart: () => { uploading = true; }, onSent });
        } catch (err) {
          // Cancelled by the person, a server too slow to answer, or the last stalled upload: no retry.
          if (cancel.signal.aborted || !stalled || attempts >= ATTEMPTS) throw err;
        } finally {
          clearTimeout(timer);
          cancel.signal.removeEventListener("abort", stop);
        }
      }
      const { text, ref } = answer;
      if (ref) void api.asrTiming({ ref, prepareMs: sent - stopped, roundTripMs: performance.now() - sent, uploadMs, attempts }).catch(() => { /* only a measurement */ });
      if (text) callbacks.current.onText(text);
      else callbacks.current.onError(t.voice.notHeard);
    } catch (err) {
      // A cancel says nothing: the person asked for it.
      if (!cancel.signal.aborted) callbacks.current.onError(err instanceof DOMException && err.name === "AbortError" ? t.voice.failed : err instanceof Error ? err.message : t.voice.failed);
    } finally {
      if (transcription.current === cancel) transcription.current = null;
      setState("idle");
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    setSeconds(0);
    // The speech server slows down after a few seconds idle: keep it awake while the user talks.
    const warm = () => void api.asrWarm().catch(() => { /* an older control plane, or only a warm-up */ });
    warm();
    let warmed = started;
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (Date.now() - warmed >= WARM_EVERY_MS) { warmed = Date.now(); warm(); }
      if (s >= MAX_SECONDS) void finishRef.current();
    }, 250);
    return () => clearInterval(timer);
  }, [state]);

  // The ring follows the voice: straight onto the button's style each frame, no re-render.
  useEffect(() => {
    if (state !== "recording") return;
    let shown = 0, frame = 0;
    const tick = () => {
      const heard = recording.current?.level() ?? 0;
      shown += (heard - shown) * (heard > shown ? 0.5 : 0.12);   // rises with the voice, settles gently
      button.current?.style.setProperty("--voice-level", shown.toFixed(3));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); button.current?.style.removeProperty("--voice-level"); };
  }, [state]);

  const start = async () => {
    setState("starting");
    callbacks.current.onError(null);
    try {
      recording.current = await startRecording();
      startedAt.current = Date.now();
      setState("recording");
      haptic("start");
    } catch (err) {
      setState("idle");
      callbacks.current.onError(micError(err));
    }
  };

  if (!enabled) return null;
  const listening = state === "recording";
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <button ref={button} type="button" className={`ghost voice-button${state === "idle" ? "" : ` ${state}`}`} data-testid="voice-button"
    disabled={(disabled && !listening && state !== "transcribing") || state === "starting"}
    aria-pressed={listening} aria-label={listening ? t.voice.stopRecording(clock) : state === "transcribing" ? t.voice.cancelTranscribing : t.voice.input}
    title={listening ? t.voice.stopAndTranscribe : state === "transcribing" ? t.voice.cancelTranscribing : t.voice.input}
    {...tapProps(() => void (listening ? finish() : state === "transcribing" ? transcription.current?.abort() : start()))}>
    {/* The microphone stays while it opens; while the words come back a cross inside the turning arc says a tap cancels. */}
    <span className="voice-glyph">{listening ? <ComposerIcon kind="stop"/> : state === "transcribing" ? <ComposerIcon kind="close"/>
      : <svg className="composer-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>}</span>
    <span className="composer-button-label">{listening ? clock : state === "transcribing" ? t.voice.transcribing : t.voice.short}</span>
  </button>;
}

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { MAX_SECONDS, startRecording, voiceSupported, type Recording } from "../voice";
import { ComposerIcon } from "./ComposerControls";
import { t } from "../i18n";

/** Why the microphone would not open, in words the user can act on. */
function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return t.voice.micErrors.denied;
  if (name === "NotFoundError" || name === "OverconstrainedError") return t.voice.micErrors.notFound;
  if (name === "NotReadableError") return t.voice.micErrors.busy;
  return t.voice.micErrors.other;
}

/**
 * The composer's microphone: tap to talk, tap again to stop (a minute at most).
 * What was said is added to the draft for a look before sending. Hidden when
 * the browser cannot record or no speech recognizer is configured.
 */
export function VoiceButton({ disabled, onText, onError }: { disabled: boolean; onText: (text: string) => void; onError: (message: string | null) => void }) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<"idle" | "starting" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const recording = useRef<Recording | null>(null);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };

  useEffect(() => {
    if (!voiceSupported()) return;
    let live = true;
    api.asr().then(r => { if (live) setEnabled(r.enabled); }).catch(() => { /* an older control plane: no voice input */ });
    return () => { live = false; recording.current?.cancel(); recording.current = null; };
  }, []);

  const finish = async () => {
    const r = recording.current;
    if (!r) return;
    recording.current = null;
    setState("transcribing");
    try {
      const { text } = await api.transcribe(r.stop());
      if (text) callbacks.current.onText(text);
      else callbacks.current.onError(t.voice.notHeard);
    } catch (err) {
      callbacks.current.onError(err instanceof Error ? err.message : t.voice.failed);
    } finally {
      setState("idle");
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) void finishRef.current();
    }, 250);
    return () => clearInterval(timer);
  }, [state]);

  const start = async () => {
    setState("starting");
    callbacks.current.onError(null);
    try {
      recording.current = await startRecording();
      setState("recording");
    } catch (err) {
      setState("idle");
      callbacks.current.onError(micError(err));
    }
  };

  if (!enabled) return null;
  const listening = state === "recording";
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <button type="button" className={`ghost voice-button${listening ? " recording" : ""}`} data-testid="voice-button"
    disabled={(disabled && !listening) || state === "starting" || state === "transcribing"}
    aria-pressed={listening} aria-label={listening ? t.voice.stopRecording(clock) : state === "transcribing" ? t.voice.transcribing : t.voice.input} title={listening ? t.voice.stopAndTranscribe : t.voice.input}
    onClick={() => void (listening ? finish() : start())}>
    {state === "starting" || state === "transcribing" ? <ComposerIcon kind="busy"/> : listening ? <ComposerIcon kind="stop"/>
      : <svg className="composer-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>}
    <span className="composer-button-label">{listening ? clock : state === "transcribing" ? t.voice.transcribing : t.voice.short}</span>
  </button>;
}

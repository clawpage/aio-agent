import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { MAX_SECONDS, startRecording, voiceSupported, type Recording } from "../voice";
import { ComposerIcon } from "./ComposerControls";

/** Why the microphone would not open, in words the user can act on. */
function micError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "没有麦克风权限，请在浏览器设置里允许本站使用麦克风";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "没有找到麦克风";
  if (name === "NotReadableError") return "麦克风正被别的程序占用";
  return "打不开麦克风";
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
      else callbacks.current.onError("没听清，请再说一次");
    } catch (err) {
      callbacks.current.onError(err instanceof Error ? err.message : "语音识别失败");
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
    aria-pressed={listening} aria-label={listening ? `停止录音（${clock}）` : state === "transcribing" ? "识别中…" : "语音输入"} title={listening ? "停止并识别" : "语音输入"}
    onClick={() => void (listening ? finish() : start())}>
    {state === "starting" || state === "transcribing" ? <ComposerIcon kind="busy"/> : listening ? <ComposerIcon kind="stop"/>
      : <svg className="composer-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>}
    <span className="composer-button-label">{listening ? clock : state === "transcribing" ? "识别中…" : "语音"}</span>
  </button>;
}

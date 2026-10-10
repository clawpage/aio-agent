import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "../api";

/**
 * The owner's phone, live: the H.264 stream from bin/phone-bridge.mjs decoded
 * with WebCodecs onto a canvas, and touches, scrolls, keys and text sent back.
 * Coordinates go out as fractions of the screen, so the bridge maps them onto
 * the phone whatever the size or rotation.
 */
interface Props {
  /** The console is visible; a hidden one drops the stream and the phone stops encoding. */
  active: boolean;
  onNotify?: (message: string, level?: "info" | "error") => void;
}

type State = "connecting" | "live" | "closed" | "unsupported";

const KEYS: Array<{ k: string; label: string; title: string }> = [
  { k: "back", label: "◁", title: "返回" },
  { k: "home", label: "○", title: "主屏幕" },
  { k: "recents", label: "▢", title: "最近应用" },
  { k: "voldown", label: "音量−", title: "音量减" },
  { k: "volup", label: "音量+", title: "音量加" },
  { k: "power", label: "电源", title: "锁屏 / 点亮屏幕" },
];

/** `avc1.PPCCLL` from the first SPS in an Annex B config packet. */
function codecOf(config: Uint8Array): string {
  for (let i = 0; i + 4 < config.length; i++) {
    const start = config[i] === 0 && config[i + 1] === 0 && (config[i + 2] === 1 || (config[i + 2] === 0 && config[i + 3] === 1));
    if (!start) continue;
    const nal = i + (config[i + 2] === 1 ? 3 : 4);
    if ((config[nal]! & 0x1f) === 7 && nal + 3 < config.length) {
      return `avc1.${[config[nal + 1]!, config[nal + 2]!, config[nal + 3]!].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return "avc1.42e01f";
}

function screenUrl(): string {
  const url = new URL(apiUrl("/api/phone/screen"), window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function PhoneScreen({ active, onNotify }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>(() => (typeof VideoDecoder === "undefined" ? "unsupported" : "connecting"));
  const [device, setDevice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [retry, setRetry] = useState(0);

  const send = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  useEffect(() => {
    if (!active || typeof VideoDecoder === "undefined") return;
    let disposed = false;
    let decoder: VideoDecoder | null = null;
    let config: Uint8Array | null = null;
    let needKey = true;
    let reconnect: number | undefined;
    setState("connecting");
    setError(null);

    const draw = (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
    };
    const resetDecoder = () => {
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      needKey = true;
    };
    const configure = () => {
      resetDecoder();
      if (!config) return;
      decoder = new VideoDecoder({
        output: draw,
        error: () => {
          // A broken stream: start over at the next key frame.
          resetDecoder();
          configure();
          send({ t: "reset" });
        },
      });
      decoder.configure({ codec: codecOf(config), optimizeForLatency: true });
    };

    const ws = new WebSocket(screenUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data) as { type: string; name?: string; width?: number; height?: number; message?: string };
        if (msg.type === "device") setDevice(msg.name ?? "");
        else if (msg.type === "session" && canvasRef.current) {
          canvasRef.current.width = msg.width!;
          canvasRef.current.height = msg.height!;
          setState("live");
        } else if (msg.type === "error") setError(msg.message ?? "手机不可用");
        return;
      }
      const buf = new Uint8Array(event.data as ArrayBuffer);
      const flags = buf[0]!;
      const payload = buf.subarray(9);
      if (flags & 1) {
        config = payload.slice();
        configure();
        return;
      }
      const key = (flags & 2) !== 0;
      if (!decoder || decoder.state !== "configured" || (needKey && !key)) return;
      // Too far behind: drop to the next key frame rather than show old video.
      if (decoder.decodeQueueSize > 8 && !key) { needKey = true; send({ t: "reset" }); return; }
      const timestamp = Number(new DataView(buf.buffer, buf.byteOffset + 1, 8).getBigUint64(0));
      let data: Uint8Array = payload;
      if (key && config) {
        data = new Uint8Array(config.length + payload.length);
        data.set(config);
        data.set(payload, config.length);
      }
      needKey = false;
      decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }));
    };
    ws.onclose = (event) => {
      if (disposed) return;
      resetDecoder();
      setState("closed");
      // The bridge restarts the phone's encoder on demand; come back on our own after a drop.
      if (event.code !== 1008) reconnect = window.setTimeout(() => setRetry((n) => n + 1), 3000);
    };
    return () => {
      disposed = true;
      window.clearTimeout(reconnect);
      wsRef.current = null;
      ws.close();
      resetDecoder();
    };
  }, [active, retry, send]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  const touch = (a: "down" | "move" | "up" | "cancel") => (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (a === "move" && event.buttons === 0 && event.pointerType === "mouse") return;
    if (a === "down") event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    send({ t: "touch", a, id: event.isPrimary ? 0 : event.pointerId, ...point(event) });
  };

  useEffect(() => {
    // React's onWheel is passive, so the page would scroll too; listen directly.
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      send({ t: "scroll", x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height, dx: -event.deltaX / 50, dy: -event.deltaY / 50 });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [send]);

  const sendText = () => {
    if (!text.trim()) return;
    send({ t: "text", s: text });
    setText("");
    onNotify?.("已粘贴到手机当前的输入框");
  };

  if (state === "unsupported") {
    return <div className="phone"><p className="muted">这个浏览器不能解码实时画面（需要 WebCodecs，Safari 16.4+ 或 Chrome）。</p></div>;
  }
  return (
    <div className="phone">
      <div className="phone-bar">
        <span className={`phone-dot ${state === "live" ? "live" : ""}`} aria-hidden="true" />
        <span className="phone-name">{state === "live" ? device || "手机" : state === "closed" ? "连接已断开，正在重连…" : "正在连接手机…"}</span>
      </div>
      <div className="phone-stage">
        <canvas
          ref={canvasRef}
          className="phone-canvas"
          width={360}
          height={800}
          aria-label="手机屏幕"
          onPointerDown={touch("down")}
          onPointerMove={touch("move")}
          onPointerUp={touch("up")}
          onPointerCancel={touch("cancel")}
          onContextMenu={(e) => e.preventDefault()}
        />
        {error && <div className="frame-hint error">{error}</div>}
      </div>
      <div className="phone-keys" role="toolbar" aria-label="手机按键">
        {KEYS.map((key) => (
          <button key={key.k} type="button" className="ghost" title={key.title} aria-label={key.title} onClick={() => send({ t: "key", k: key.k })}>
            {key.label}
          </button>
        ))}
      </div>
      <form className="phone-text row" onSubmit={(e) => { e.preventDefault(); sendText(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="输入文字，发送到手机当前的输入框" aria-label="发送到手机的文字" />
        <button type="submit" className="primary" disabled={!text.trim() || state !== "live"}>发送</button>
      </form>
    </div>
  );
}

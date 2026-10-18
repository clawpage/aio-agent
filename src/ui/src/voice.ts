/**
 * Microphone recording for voice input, as the 16-bit mono WAV the speech
 * server takes (the same recognizer the voice gadget uses). Raw samples rather
 * than MediaRecorder: its formats differ by browser and the server wants WAV.
 */

/** The speech server takes about a minute of 16 kHz audio per request. */
export const MAX_SECONDS = 60;
const RATE = 16_000;

export interface Recording {
  /** Stops the microphone; the WAV of everything heard. */
  stop(): Uint8Array;
  /** Stops the microphone and drops what was heard. */
  cancel(): void;
}

type AudioContextClass = typeof AudioContext;
const audioContextClass = (): AudioContextClass | undefined =>
  window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;

export function voiceSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(audioContextClass());
}

const PROCESSING = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const BUILT_IN_KEY = "voice.builtInMicrophone";

/** Phones and tablets (an iPad's Safari says Macintosh, but has a touch screen). */
export function mobileOs(userAgent: string, touchPoints = 0): "ios" | "android" | null {
  if (/Android/i.test(userAgent)) return "android";
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && touchPoints > 1)) return "ios";
  return null;
}

/**
 * The phone's own microphone among the inputs, never a Bluetooth, wired or USB
 * one. Pages see only names: Chrome and WebView on Android call the built-in
 * microphone "Speakerphone" or "Headset earpiece" (Chromium's
 * CommunicationDeviceSelector); WebKit uses the system's port name, "iPhone
 * Microphone" or "iPad Microphone", in the phone's language.
 */
export function builtInMicrophone(os: "ios" | "android", inputs: Pick<MediaDeviceInfo, "deviceId" | "label">[]): string | null {
  // Android: speakerphone first, the microphone set up for a phone held in front of you.
  const preference: ((label: string) => boolean)[] = os === "android"
    ? [label => /^speakerphone$/i.test(label), label => /^headset earpiece$/i.test(label)]
    : [label => /iphone|ipad|built-?in|内建|內建|内置|內置/i.test(label) && !/bluetooth|airpods|headset|耳机|耳機/i.test(label)]; // i18n-exempt: iOS names its microphones in the phone's language
  for (const matches of preference) {
    const device = inputs.find(d => d.deviceId && matches(d.label.trim()));
    if (device) return device.deviceId;
  }
  return null;
}

const open = (deviceId?: string) =>
  navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...PROCESSING, deviceId: { exact: deviceId } } : PROCESSING });

/**
 * On a phone, always the phone's own microphone, even with a Bluetooth headset
 * connected; the system's choice elsewhere, or when the phone's can't be found.
 * Names are only readable once the microphone is allowed, so the first
 * recording may open it twice; the device found is remembered for the next.
 */
async function openMicrophone(): Promise<MediaStream> {
  const os = mobileOs(navigator.userAgent, navigator.maxTouchPoints);
  if (!os) return open();
  const builtIn = (stream: MediaStream) => {
    const track = stream.getAudioTracks()[0];
    return Boolean(track && builtInMicrophone(os, [{ deviceId: "x", label: track.label }]));
  };
  const saved = localStorage.getItem(BUILT_IN_KEY);
  if (saved) {
    const stream = await open(saved).catch(() => null);
    if (stream && builtIn(stream)) return stream;
    stream?.getTracks().forEach(track => track.stop());
    localStorage.removeItem(BUILT_IN_KEY);
  }
  const stream = await open();
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
  const id = builtInMicrophone(os, inputs);
  if (!id) return stream;
  if (stream.getAudioTracks()[0]?.getSettings().deviceId === id) {
    localStorage.setItem(BUILT_IN_KEY, id);
    return stream;
  }
  stream.getTracks().forEach(track => track.stop());
  const own = await open(id).catch(() => null);
  if (!own) return open();
  localStorage.setItem(BUILT_IN_KEY, id);
  return own;
}

export async function startRecording(): Promise<Recording> {
  // Made before waiting for the microphone, while the tap still counts as a user gesture (iOS).
  const audio = new (audioContextClass()!)();
  let stream: MediaStream;
  try {
    stream = await openMicrophone();
    await audio.resume();
  } catch (err) {
    void audio.close();
    throw err;
  }
  const rate = audio.sampleRate;
  const source = audio.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but, unlike an AudioWorklet, needs no separate module and works in every WebKit.
  const node = audio.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  node.onaudioprocess = e => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  source.connect(node);
  node.connect(audio.destination);   // Chrome only runs a processor that leads somewhere; it outputs silence
  const release = () => {
    node.onaudioprocess = null;
    node.disconnect();
    source.disconnect();
    stream.getTracks().forEach(track => track.stop());
    void audio.close();
  };
  return {
    stop() {
      release();
      const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      chunks.reduce((at, c) => { samples.set(c, at); return at + c.length; }, 0);
      return rate > RATE ? wav(downsample(samples, rate, RATE), RATE) : wav(samples, rate);
    },
    cancel: release,
  };
}

/** Averages each output sample's span of input: plain decimation would alias. */
function downsample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export function wav(samples: Float32Array, rate: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);          // PCM header size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);    // bytes per second
  view.setUint16(32, 2, true);           // bytes per frame
  view.setUint16(34, 16, true);          // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(view.buffer);
}

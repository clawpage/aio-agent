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

export async function startRecording(): Promise<Recording> {
  // Made before waiting for the microphone, while the tap still counts as a user gesture (iOS).
  const audio = new (audioContextClass()!)();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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

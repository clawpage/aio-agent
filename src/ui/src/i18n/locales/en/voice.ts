import type { voice as zh } from "../zh/voice";

export const voice: typeof zh = {
  micErrors: {
    denied: "No microphone access. Allow this site to use the microphone in your browser settings.",
    notFound: "No microphone found",
    busy: "The microphone is in use by another app",
    other: "Couldn't open the microphone",
  },
  notHeard: "Didn't catch that. Please try again.",
  failed: "Speech recognition failed",
  stopRecording: (clock: string) => `Stop recording (${clock})`,
  transcribing: "Transcribing…",
  input: "Voice input",
  stopAndTranscribe: "Stop and transcribe",
  short: "Voice",
};

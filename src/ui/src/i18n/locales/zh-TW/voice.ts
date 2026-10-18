import type { voice as zh } from '../zh/voice';
export const voice: typeof zh = {
  micErrors: {
    denied: "沒有麥克風權限，請在瀏覽器設定裡允許本站使用麥克風",
    notFound: "沒有找到麥克風",
    busy: "麥克風正被別的程式佔用",
    other: "打不開麥克風",
  },
  notHeard: "沒聽清楚，請再說一次",
  failed: "語音辨識失敗",
  stopRecording: (clock: string) => `停止錄音（${clock}）`,
  transcribing: "辨識中…",
  input: "語音輸入",
  stopAndTranscribe: "停止並辨識",
  short: "語音",
};

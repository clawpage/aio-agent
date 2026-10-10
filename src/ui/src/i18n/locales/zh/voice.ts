export const voice = {
  micErrors: {
    denied: "没有麦克风权限，请在浏览器设置里允许本站使用麦克风",
    notFound: "没有找到麦克风",
    busy: "麦克风正被别的程序占用",
    other: "打不开麦克风",
  },
  notHeard: "没听清，请再说一次",
  failed: "语音识别失败",
  stopRecording: (clock: string) => `停止录音（${clock}）`,
  transcribing: "识别中…",
  input: "语音输入",
  stopAndTranscribe: "停止并识别",
  short: "语音",
};

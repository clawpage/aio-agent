import type { voice as zh } from '../zh/voice';

export const voice: typeof zh = {
  micErrors: {
    denied: 'マイクへのアクセスが許可されていません。ブラウザの設定でこのサイトのマイク使用を許可してください',
    notFound: 'マイクが見つかりません',
    busy: 'マイクは別のアプリで使用中です',
    other: 'マイクを開けませんでした',
  },
  notHeard: '聞き取れませんでした。もう一度話してください',
  failed: '音声認識に失敗しました',
  stopRecording: (clock: string) => `録音を停止（${clock}）`,
  transcribing: '認識中…',
  input: '音声入力',
  stopAndTranscribe: '停止して認識',
  short: '音声',
};

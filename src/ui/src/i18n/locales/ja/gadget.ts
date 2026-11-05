import type { gadget as zh } from '../zh/gadget';

export const gadget: typeof zh = {
  /** Shown while the gadget's account is unknown or unbound. */
  fallbackTitle: '音声ガジェット',
  subtitle: '音声ガジェットの会話履歴 · 閲覧のみ',
  logLabel: (title: string) => `${title} の会話`,
  readFailed: '会話履歴を読み込めませんでした',
  loading: '会話を読み込み中…',
  unbound: '音声ガジェットは専用のアカウントに紐づいていないため、メッセージはメインチャットにあります。',
  empty: 'まだ会話はありません。',
  loadingOlder: '読み込み中…',
  loadOlder: 'さらに前の会話を読み込む',
  failed: {
    failed: '回答に失敗しました',
    unknown: '結果は不明です',
    interrupted: '停止しました',
  },
  noReply: '回答なし',
  errorDetail: (error: string) => `：${error}`,
  answering: '回答中…',
};

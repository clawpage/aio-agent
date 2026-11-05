import type { library as zh } from '../zh/library';

export const library: typeof zh = {
  title: 'ファイル',
  sub: 'AI がメインチャットで作成した画像やドキュメントなどのファイルを、すべてここにまとめています',
  back: '← ファイルに戻る',
  shelfGroup: '種類で絞り込み',
  shelves: { all: 'すべて', images: '画像', documents: 'ドキュメント', media: '音声・動画', other: 'その他' },
  openTask: (title: string) => `「${title}」の会話を見る`,
  emptyTitle: 'まだファイルはありません',
  emptyBody: '表やレポート、画像の作成を AI に頼むと、できたファイルが自動的にここに入ります。',
  shelfEmpty: 'この種類のファイルはまだありません。',
  loading: '読み込み中…',
  loadFailed: 'ファイル一覧を読み込めませんでした',
  retry: '再試行',
  noMore: 'これ以上はありません',
};

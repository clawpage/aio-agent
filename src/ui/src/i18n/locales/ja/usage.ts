import type { usage as zh } from '../zh/usage';

export const usage: typeof zh = {
  readFailed: '使用量を読み込めませんでした',
  unavailable: (names: string[]) => `${names.join('、')} のデータは現在読み込めないため、合計に含まれていません。`,
  noUsage: 'この期間に記録された使用量はありません。',
  columns: {
    user: 'ユーザー',
    total: '合計トークン',
    share: '割合',
    input: '入力',
    cached: 'うちキャッシュ',
    output: '出力',
  },
  roles: {
    owner: 'オーナー',
    member: 'メンバー',
  },
  notAvailable: '利用不可',
  note: '合計トークン = 入力 + 出力（キャッシュは入力に含まれます）。Clawpage Agent の Codex / Claude による実行と振り分けの呼び出しを集計しています。外部クライアント、画像生成、Jev の呼び出しは含まず、サブスクリプションの上限や請求額を示すものでもありません。',
  historyNote: '過去分は保存済みの Codex イベントからのみ補完しています。以前の Claude・振り分けや、報告されなかった使用量は補完できません。中断時に報告を受け取れなかった消費は欠けることがあり、日付をまたぐ呼び出しは使用量の報告を受け取った日に計上されます。',
  /** `since`: when live collection began (null: not yet); `first`: the earliest record (null: none). */
  coverage: (name: string, since: string | null, first: string | null) => `${name}：リアルタイム集計${since ? `は ${since} から` : 'はアカウントの実行エンジンの起動後に開始'}、${first ? `最初の記録 ${first}` : '記録なし'}`,
};

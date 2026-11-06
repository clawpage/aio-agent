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
    cost: '推定コスト',
    quota: '本日',
    noPrice: '価格なし',
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
  costNote: '推定コストは各アカウントの現在のモデルを API 定価で換算したものです（100 万トークンあたり USD：GPT-6.1 Sol 入力 2・キャッシュ 0.10・出力 10、GPT-6.1 Terra 1 / 0.05 / 5、Claude Sonnet 5.5 入力 2・キャッシュ読み取り 0.20・キャッシュ書き込み 2.50・出力 10）。実際の請求額ではありません。コントロールプレーンはサブスクリプションでログインしており、トークン単位では支払っていません。定期実行は実際には Terra を使いますがアカウントのモデルで計算するため、やや高めに出ます。価格は第三者の一覧によるもので、公式ページでは確認していません。',
  quotaNote: 'メンバーは 1 日 1 億トークン（キャッシュを含む入力 + 出力）まで無料です。毎日太平洋時間 2:00 にリセットされ、繰り越しはなく、導入後の利用分のみ数えます。使い切るとその日はサービスを停止します。オーナーには上限がありません。',
};

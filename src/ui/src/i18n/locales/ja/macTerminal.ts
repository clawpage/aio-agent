import type { macTerminal as zh } from '../zh/macTerminal';

export const macTerminal: typeof zh = {
  title: 'Mac のターミナル',
  loading: 'Mac のターミナルを確認中…',
  unlinked: 'まだ Mac が接続されていません。Clawpage Agent の Mac アプリ を入れた Mac で、「スマートフォン」の「Mac のスマートフォンとブラウザ」からこの Mac を接続してください。',
  linkMac: 'Mac を接続',
  offline: '接続中の Mac がオフラインです。Mac のアプリが閉じているか、Mac がスリープしています。',
  outdated: 'その Mac の Clawpage Agent アプリ はバージョンが古く、ターミナルに対応していません。アプリをアップデートしてから、ここでオンにしてください。',
  on: 'オン：AI はお使いの Mac でファイルの読み書きやコマンドの実行ができます。',
  off: 'オフ：AI はお使いの Mac のターミナルを使えません。',
  toggle: 'この Mac のターミナルの使用を AI に許可',
  onlyInApp: 'オン / オフの切り替えは、その Mac の Clawpage Agent アプリ で「Mac のターミナル」を開いて行ってください。',
  noTmux: 'この Mac には tmux がインストールされていないため、AI はまだコマンドを実行できません（ファイルの読み書きは可能です）。Mac のターミナルで brew install tmux を実行してインストールしてください。',
  hint: 'オンにすると、AI はあなたの Mac ユーザーがアクセスできるすべてのファイルを読み書き・変更し、コマンドを実行できます（bash は専用の tmux 内で動き、タスクごとに 1 つのセッションを使います）。この Mac に対してあなたと同じ権限を持つため、Mac で作業させたいときだけオンにしてください。ファイルの削除や変更、ソフトウェアのインストール、sudo などの操作の前には必ず確認します。デフォルトはオフです。',
  watch: 'AI が Mac で実行している内容を見るには、Mac のターミナルで tmux -L aio-agent attach を実行します。',
};

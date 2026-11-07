import type { profile as zh } from "../zh/profile";

export const profile: typeof zh = {
  title: "プロフィール",
  intro: "すべて任意です。アシスタントは必要なときにナレッジベースから参照し、毎回持ち歩くことはありません。clawpage に見えるのはニックネームだけです。",
  fields: {
    nickname: { label: "ニックネーム", placeholder: "例：たろう", hint: "clawpage にログインしたとき、ページに見える名前" },
    preferredName: { label: "呼び方", placeholder: "例：山田さん" },
    location: { label: "居住地またはタイムゾーン", placeholder: (zone: string) => `例：${zone}` },
    language: { label: "よく使う言語", placeholder: "例：日本語、English" },
    occupation: { label: "職業・立場", placeholder: "例：エンジニア、学生" },
    interests: { label: "興味", placeholder: "例：写真、ハイキング、料理" },
    notes: { label: "アシスタントに気をつけてほしいこと", placeholder: "例：回答は短めに。買い物の前に価格を比較。お酒はすすめない" },
  },
  save: "保存",
  saving: "保存中…",
  saved: "保存しました",
  failed: "保存できませんでした。もう一度お試しください。",
  loadFailed: "プロフィールを読み込めませんでした。もう一度お試しください。",
  retry: "再試行",
  onboarding: {
    title: "あなたのことを教えてください",
    body: "基本的なことを少し書くと、アシスタントがあなたをより理解できます。どれもスキップでき、あとから「設定 → プロフィール」でいつでも変更できます。",
    done: "完了",
    skip: "スキップ",
  },
};

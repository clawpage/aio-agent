import type { profile as zh } from "../zh/profile";

export const profile: typeof zh = {
  title: "個人資料",
  intro: "都可以不填。助理需要時會在你的知識庫裡查這些資料，不會每次都帶上；clawpage 只能看到你的暱稱。",
  fields: {
    nickname: { label: "暱稱", placeholder: "例如：小林", hint: "登入 clawpage 時頁面看到的名字" },
    preferredName: { label: "希望怎麼稱呼你", placeholder: "例如：林老師" },
    location: { label: "所在地或時區", placeholder: (zone: string) => `例如：${zone}` },
    language: { label: "常用語言", placeholder: "例如：中文、English" },
    occupation: { label: "職業或身分", placeholder: "例如：產品經理、學生" },
    interests: { label: "興趣", placeholder: "例如：攝影、健行、做菜" },
    notes: { label: "想讓助理注意的事", placeholder: "例如：回答簡短一些；買東西先比價；不要推薦酒類" },
  },
  save: "儲存",
  saving: "正在儲存…",
  saved: "已儲存",
  failed: "沒能儲存，請重試。",
  loadFailed: "沒能讀取資料，請重試。",
  retry: "重試",
  onboarding: {
    step: "最後一步",
    title: "介紹一下你自己",
    body: "四項都可以不填。寫上幾句，助理就知道怎麼稱呼你、該留意什麼；之後隨時可以在「設定 → 個人資料」修改。",
    name: { label: "怎麼稱呼你", placeholder: "例如：小林", hint: "助理會這樣稱呼你；登入 clawpage 頁面時，頁面看到的也是這個名字" },
    done: "完成",
    skip: "略過",
  },
};

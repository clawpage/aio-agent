import type { library as zh } from "../zh/library";

export const library: typeof zh = {
  title: "檔案庫",
  sub: "主對話裡的圖片、文件等檔案，都收在這裡",
  back: "← 返回檔案庫",
  shelfGroup: "依類型篩選",
  shelves: { all: "全部", images: "圖片", documents: "文件", media: "影音", other: "其他" },
  fromYou: "你傳送",
  fromAi: "AI 回覆",
  openTask: (title: string) => `查看「${title}」的對話`,
  emptyTitle: "還沒有檔案",
  emptyBody: "在主對話裡傳圖片、文件，或請 AI 幫你做表格、報告、圖片，檔案都會自動收到這裡。",
  shelfEmpty: "這一類還沒有檔案。",
  loading: "正在讀取…",
  loadFailed: "檔案列表讀取失敗",
  retry: "重試",
  noMore: "沒有更多了",
};

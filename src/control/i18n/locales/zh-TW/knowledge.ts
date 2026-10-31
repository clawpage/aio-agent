import type { knowledge as zh } from "../zh/knowledge.js";
export const knowledge: typeof zh = {
  notFound: "沒有這個共享庫，或你不是它的成員",
  adminOnly: "只有管理員能這樣做",
  badName: (max: number) => `名稱不能空白，最多 ${max} 個字`,
  rulesTooLong: (max: number) => `規則最多 ${max} 個字`,
  sensitive: "內容裡像是有密碼、驗證碼、證件號碼或卡號，不能記進知識庫",
  inviteInvalid: "邀請連結無效、已過期或已作廢",
  transferFirst: "你是管理員，退出前請先把管理員轉給其他成員",
  cannotRemoveSelf: "不能移出自己；要離開請用「退出」",
  notMember: "對方不是這個庫的成員",
  required: "內容不能空白",
  tooLong: (max: number) => `最多 ${max} 個字`,
  badDomain: "沒有這個領域",
  needContent: "至少寫一條內容或一句摘要",
  undoConflict: (n: number) => `有 ${n} 處在這次變更之後又被改過，請先復原較晚的變更`,
  presets: {
    family: "收：家庭成員的狀況和偏好（飲食、過敏、作息、衣服尺寸等）、健康與就醫安排、孩子的學校和活動、家裡的行程與約定、常用的店家和服務（家事、維修、醫生）、家裡設備和帳號的用法（不含密碼）、全家一起做過的決定。\n不收：只和某一個人有關、其他家人用不上的事；工作；一次性的小事；任何密碼、驗證碼、證件號碼和卡號。",
    project: "收：專案的目標與範圍、做過的決定和理由、約定（命名、流程、分工）、關鍵做法和踩過的坑、相關的人和系統、重要的連結。\n不收：閒聊；只在一個任務裡用得上的臨時細節；個人隱私；任何金鑰、密碼和權杖。",
    blank: "",
  },
};

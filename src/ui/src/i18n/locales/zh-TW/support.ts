import type { support as zh } from '../zh/support';
export const support: typeof zh = {
  requestKind: '請求類型', ask: '諮詢或回饋', askInfo: '你的說明會傳送給管理員處理。', deleteAccount: '刪除帳號',
  settingsIntro: '向管理員諮詢或回饋、查看隱私政策，或申請刪除帳號及相關資料。', signedInAs: (who: string) => `目前帳號：${who}`,
  account: '帳號與隱私', privacy: '隱私政策', deletion: '申請刪除帳號',
  limitations: 'AI 回覆可能有誤，僅供一般參考。一站不是醫療裝置，不提供診斷、治療或預防疾病的功能；醫療問題請諮詢合格醫生，法律和投資問題請諮詢相應專業人員。',
  feedbackTitle: '這則回覆哪裡不好？', feedbackInfo: '說明可以不寫。寫了的話，管理員會看到這則回覆（最多 20,000 字）和你的說明，用於改進回答。', feedbackHint: '例如：答錯了、沒理解我的意思、太囉嗦。請勿填寫密碼或其他機密。', alsoReport: '同時檢舉這則回覆（違法、有害或不當內容）', feedbackThanks: '謝謝，已記錄你的回饋。', feedbackQueue: '回覆回饋', feedbackQueueInfo: '使用者對 AI 回覆的按讚和倒讚，最新的在前。', feedbackEmpty: '暫無回饋', ratings: {up: '有幫助', down: '沒幫助'},
  reportInfo: '提交後，管理員會收到這條 AI 回覆（最多 20,000 字）和你的說明，用於核查和改進內容安全。不會傳送其他對話。',
  deletionInfo: '此申請會傳送給管理員進行身分核驗。確認後將刪除帳號、對話與任務、工作區和儲存的憑證。提交申請不會立即刪除資料。',
  note: '說明', noteHint: '說明需要處理的問題，請勿填寫密碼或其他秘密。', send: '提交', sending: '提交中…',
  success: '請求已收到，管理員將進行核查。請求編號：', close: '關閉', cancel: '取消',
  queue: '使用者支援', queueInfo: '人工核驗刪除請求；核查檢舉並據此調整安全規則。只有完成實際處理後才記錄結果。', empty: '暫無請求',
  kinds: {content: '內容檢舉', deletion: '帳號刪除', privacy: '隱私諮詢'}, pending: '待處理', reviewed: '已記錄處理結果', decision: '核查和處理記錄', review: '記錄處理結果',
};

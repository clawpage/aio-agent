import type { sandbox as zh } from "../zh/sandbox.js";
export const sandbox: typeof zh = {
    codexInstallFailed: (version: string, output: string) => `沙箱 Codex CLI 安裝失敗（需要 @openai/codex@${version}）：${output}`,
    codexVerifyFailed: (expected: string, actual: string) => `沙箱 Codex CLI 安裝後檢查失敗：預期 ${expected}，實際 ${actual}`,
    claudeInstallFailed: (version: string, output: string) => `沙箱 Claude Code CLI 安裝失敗（需要 @anthropic-ai/claude-code@${version}）：${output}`,
    claudeVerifyFailed: (expected: string, actual: string) => `沙箱 Claude Code CLI 安裝後檢查失敗：預期 ${expected}，實際 ${actual}`,
    claudeConfigFailed: (output: string) => `Claude Code 設定目錄初始化失敗：${output}`,
    startFailed: "沙箱啟動失敗，請稍後再試",
    node: {
        incompatible: (node: string, protocol: number | string, range: string) => `沙箱節點 ${node} 的協定 ${protocol} 不在本控制面支援的 ${range} 內`,
        unreachable: (node: string, error: string) => `無法連線到沙箱節點 ${node}：${error}`,
        httpStatus: (node: string, status: number) => `沙箱節點 ${node} 回傳 HTTP ${status}`,
        unauthorized: "節點權杖無效",
        containerForeign: (name: string) => `容器名稱 ${name} 已被非本系統建立的容器佔用（缺少 personal-agent.managed=1 標籤）。請先人工確認，再重新命名或移除該容器。`,
        imageMismatch: (name: string, image: string, expected: string) => `容器 ${name} 使用的映像檔 ${image} 與固定映像檔 ${expected} 不一致，已停止自動接管。`,
        volumeMissing: (name: string, volume: string, destination: string) => `容器 ${name} 缺少持久磁碟區掛載 ${volume} -> ${destination}，為避免資料遺失已停止接管。`,
        sandboxMissing: (name: string) => `沙箱 ${name} 不存在`,
        sandboxUnmanaged: (name: string) => `容器 ${name} 不是本系統管理的沙箱`,
        noWebPort: (name: string) => `沙箱 ${name} 沒有發布網頁連接埠`,
    },
};

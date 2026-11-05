import type { sandbox as zh } from "../zh/sandbox.js";
export const sandbox: typeof zh = {
    codexInstallFailed: (version: string, output: string) => `サンドボックスに Codex CLI をインストールできませんでした（@openai/codex@${version} が必要）：${output}`,
    codexVerifyFailed: (expected: string, actual: string) => `サンドボックスの Codex CLI がインストール後の確認に失敗しました：期待値 ${expected}、実際 ${actual}`,
    claudeInstallFailed: (version: string, output: string) => `サンドボックスに Claude Code CLI をインストールできませんでした（@anthropic-ai/claude-code@${version} が必要）：${output}`,
    claudeVerifyFailed: (expected: string, actual: string) => `サンドボックスの Claude Code CLI がインストール後の確認に失敗しました：期待値 ${expected}、実際 ${actual}`,
    claudeConfigFailed: (output: string) => `Claude Code の設定フォルダを初期化できませんでした：${output}`,
    startFailed: "サンドボックスを起動できませんでした。しばらくしてから再試行してください",
    node: {
        incompatible: (node: string, protocol: number | string, range: string) => `サンドボックスノード ${node} のプロトコル ${protocol} は、このコントロールプレーンが対応する ${range} の範囲外です`,
        unreachable: (node: string, error: string) => `サンドボックスノード ${node} に接続できません：${error}`,
        httpStatus: (node: string, status: number) => `サンドボックスノード ${node} が HTTP ${status} を返しました`,
        unauthorized: "ノードのトークンが無効です",
        containerForeign: (name: string) => `コンテナ名 ${name} は、このシステム以外が作成したコンテナに使われています（personal-agent.managed=1 ラベルがありません）。先に手動で確認し、そのコンテナの名前を変えるか削除してください。`,
        imageMismatch: (name: string, image: string, expected: string) => `コンテナ ${name} が使うイメージ ${image} は固定のイメージ ${expected} と一致しないため、自動での引き継ぎを止めました。`,
        volumeMissing: (name: string, volume: string, destination: string) => `コンテナ ${name} に永続ボリュームのマウント ${volume} -> ${destination} がないため、データを失わないよう引き継ぎを止めました。`,
        sandboxMissing: (name: string) => `サンドボックス ${name} が存在しません`,
        sandboxUnmanaged: (name: string) => `コンテナ ${name} はこのシステムが管理するサンドボックスではありません`,
        noWebPort: (name: string) => `サンドボックス ${name} は Web ポートを公開していません`,
    },
};

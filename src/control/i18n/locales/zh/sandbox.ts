/** Setting up the sandbox and what its node refuses (sandbox/, relayed from sandboxd by its codes). */
export const sandbox = {
    codexInstallFailed: (version: string, output: string) => `沙箱 Codex CLI 安装失败（需要 @openai/codex@${version}）：${output}`,
    codexVerifyFailed: (expected: string, actual: string) => `沙箱 Codex CLI 安装后校验失败：期望 ${expected}，实际 ${actual}`,
    claudeInstallFailed: (version: string, output: string) => `沙箱 Claude Code CLI 安装失败（需要 @anthropic-ai/claude-code@${version}）：${output}`,
    claudeVerifyFailed: (expected: string, actual: string) => `沙箱 Claude Code CLI 安装后校验失败：期望 ${expected}，实际 ${actual}`,
    claudeConfigFailed: (output: string) => `Claude Code 配置目录初始化失败：${output}`,
    startFailed: "沙箱启动失败，请稍后重试",
    node: {
        incompatible: (node: string, protocol: number | string, range: string) => `沙箱节点 ${node} 的协议 ${protocol} 不在本控制面支持的 ${range} 内`,
        unreachable: (node: string, error: string) => `沙箱节点 ${node} 无法连接：${error}`,
        httpStatus: (node: string, status: number) => `沙箱节点 ${node} 返回 HTTP ${status}`,
        unauthorized: "节点令牌无效",
        containerForeign: (name: string) => `容器名 ${name} 已被非本系统创建的容器占用（缺少 personal-agent.managed=1 标签）。请先人工确认并重命名或移除该容器。`,
        imageMismatch: (name: string, image: string, expected: string) => `容器 ${name} 使用的镜像 ${image} 与固定镜像 ${expected} 不一致，已停止自动接管。`,
        volumeMissing: (name: string, volume: string, destination: string) => `容器 ${name} 缺少持久卷挂载 ${volume} -> ${destination}，为避免数据丢失已停止接管。`,
        sandboxMissing: (name: string) => `沙箱 ${name} 不存在`,
        sandboxUnmanaged: (name: string) => `容器 ${name} 不是本系统管理的沙箱`,
        noWebPort: (name: string) => `沙箱 ${name} 没有发布网页端口`,
    },
};

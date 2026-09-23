/**
 * Content seeded into the sandbox so the main agent knows which native tools
 * live inside its own box. Every command below was verified against
 * `aio <command> --help` inside the pinned image (aio CLI 0.3.14).
 *
 * Nothing here grants a Mac (host) capability: the sandbox has no access to the
 * host filesystem, host secrets or host tools. Ordinary outbound network access
 * from inside the sandbox is unaffected.
 */

export const WORKSPACE_AGENTS_MD = `# 沙箱工作区说明（由 personal-agent 自动生成，可自由修改）

你运行在一个隔离的 AIO Sandbox 容器里。持久化工作区是 \`/home/gem/workspace\`（当前目录）。
宿主机（Mac）的能力没有接入到这个沙箱：你没有宿主机文件、密钥或应用权限，也不需要它们。
容器自身的网络是正常可用的，可以按需访问互联网。

## 首选工具：\`aio\` CLI（无需任何 API Key）

不确定参数时一律先看帮助：\`aio <命令> --help\`。

- 浏览器（真实 Chromium，和 VNC 桌面里是同一个浏览器）
  - \`aio browser navigate <url>\`
  - \`aio browser text\`（页面正文）、\`aio browser markdown\`、\`aio browser html\`
  - 截图先建目录再写（示例主题 \`example\`，可换成你自己的）：\`mkdir -p /home/gem/workspace/.scratch/artifacts/example && aio browser screenshot -o /home/gem/workspace/.scratch/artifacts/example/screenshot.png\`（\`--full\` 整页）
  - \`aio browser click <selector>\`、\`aio browser fill <text> -s <selector>\`
  - \`aio browser evaluate 'document.title'\`（读取标题等任意 JS 结果）
  - \`aio browser snapshot\`（无障碍树）、\`aio browser tabs\`、\`aio browser wait <type>\`
- 桌面 GUI（VNC 中同一个桌面）
  - 同样先建目录：\`mkdir -p /home/gem/workspace/.scratch/artifacts/example && aio gui screenshot -o /home/gem/workspace/.scratch/artifacts/example/desktop.png\`
  - \`aio gui tap <x> <y>\`、\`aio gui type <text>\`、\`aio gui hotkey <keys...>\`
- Shell：\`aio shell exec <command>\`（长任务可加 \`--async\` 后用 \`aio shell output <session-id>\` 取回结果）
- 文件：\`aio file --help\`（读、写、列表、查找、替换）
- 沙箱信息：\`aio sandbox --help\`

## MCP 工具

已注册 MCP 服务器 \`aio_browser\`（streamable HTTP：\`http://127.0.0.1:8080/mcp\`）。
该端点实际提供的工具包括：\`browser_navigate\`、\`browser_get_text\`、\`browser_get_markdown\`、
\`browser_screenshot\`、\`browser_click\`、\`browser_evaluate\`、\`browser_tab_list\`、\`browser_press_key\` 等。

## 目录与产物约定

工作区根目录只用来放少数顶层目录，不要散落项目、下载物和交付文件。

- 长期维护的项目放在 \`/home/gem/workspace/projects/<name>/\`。每个项目应有自己的 \`README.md\`（用途、
  运行方式、验证命令）、自己的 Git 仓库和依赖（依赖装在该项目内，不在工作区根安装）。完成一个
  阶段后按项目约定运行验证（测试 / 构建 / 冒烟），并说明实际执行的命令与结果。
- 临时实验、下载内容、解包结果、截图和一次性测试产物放在
  \`/home/gem/workspace/.scratch/\` 下，按主题分目录：
  - \`.scratch/tmp/<topic>/\`：下载、解包、转换中间文件、候选第三方源码。
  - \`.scratch/tests/<topic>/\`：一次性诊断或验证脚本。
  - \`.scratch/artifacts/<topic>/\`：截图、日志、报告、构建交付物等一次性产物。
  \`.scratch/\` 不保证备份；需要长期保留的脚本或结论要移入对应项目并提交。写入任何产物前先
  用 \`mkdir -p <目录>\` 建好目标目录，不要把 \`<topic>\` 之类的占位符原样当命令输入 shell。
- 不把业务项目、下载目录、\`test-*\`、\`tmp-*\` 或交付文件夹直接放在 \`/home/gem/workspace\` 根目录。
- \`/home/gem/workspace/uploads/\` 是系统收到的原始附件（用户在对话里上传的文件），不是项目交付物；
  不要把它当项目目录，也不要删除或整理里面的用户文件。

## 动文件之前

- 先查已有目录和归属（\`ls\`、\`aio file --help\`、Git 状态），复用现有结构，不要无差别覆盖或重建。
- 保护用户现有文件与密钥：不要删除、覆盖或移动你不确定的文件；\`.env\`、密钥、凭据和用户资料只读取
  完成任务所需的部分，不复制到别处，也不打印到输出里。
- 新建内容前先判断它属于长期项目还是临时产物，落到上面约定的位置。

## 容器内已就绪的网页服务

- 交互终端：\`http://127.0.0.1:8080/terminal\`
- 浏览器控制台：\`http://127.0.0.1:8080/browser-ui\`
- 桌面（noVNC）：\`http://127.0.0.1:8080/vnc/vnc.html\`
- 代码编辑器 code-server：\`http://127.0.0.1:8080/code-server/\`
- JupyterLab：\`http://127.0.0.1:8080/jupyter/lab\`

## 约定

- 产物按上面的目录约定写入 \`/home/gem/workspace\`（会持久保存），不要只放在 \`/tmp\`，也不要散落在工作区根目录。
- 需要浏览器操作时优先用 \`aio browser\` 或 MCP 工具，而不是只描述步骤。
- 用中文回答，说明你实际执行的命令与结果。
`;

export const CODEX_CONFIG_TOML = `# 由 personal-agent 生成；如果你自行修改，系统不会覆盖此文件。
[mcp_servers.aio_browser]
url = "http://127.0.0.1:8080/mcp"

# Codex 本地 memory 开关（等价于命令行 \`codex features enable memories\`）；
# 记忆由后台在会话闲置后生成，不会立即出现。
[features]
memories = true
`;

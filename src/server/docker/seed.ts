/**
 * Content seeded into the sandbox so the main agent knows which native tools
 * live inside its own box. Every command below was verified against
 * `aio <command> --help` inside the pinned image (aio CLI 0.3.14).
 *
 * Nothing here grants a Mac (host) capability: the sandbox has no access to the
 * host filesystem, host secrets or host tools. Ordinary outbound network access
 * from inside the sandbox is unaffected.
 */

export const WORKSPACE_AGENTS_MD = `# 沙箱工作区说明（由 AIO Agent 自动生成，可自由修改）

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

## 文档工具（Word / Excel / PPT / PDF）

创建、修改、转换文档用 \`/home/gem/.codex/tools/aio-doc/bin/aio-doc\`（也可直接用同名 skill）：

- 先确认就绪：\`/home/gem/.codex/tools/aio-doc/bin/aio-doc doctor\`。未就绪时如实说明，不要假装成功。
- 创建/修改：python-docx（Word）、openpyxl（Excel）、python-pptx（PPT），都在隔离 venv 里。
- 格式转换：headless LibreOffice，例如 Word → PDF、旧格式 .doc/.xls/.ppt → 现代格式。
- **openpyxl 不会计算公式**：写完 \`=SUM(...)\` 必须用 \`aio-doc xlsx-recalc\` 让 LibreOffice 重算，
  再用 \`xlsx-read --values\` 确认缓存值出现，才算真的算对了。\`xlsx-recalc\` 默认输出新文件
  （\`<原名>.recalc.xlsx\`），只有显式加 \`--in-place\` 才会覆盖原文件。
- 转换输出为新文件，不要覆盖用户原件；字体与复杂排版可能有差异，不要承诺 100% 保真。

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
- 用中文以个人助理的方式回答：先给用户要的结果、建议和交付物，保留必要来源和限制。
- 工具、skill、命令与验证步骤留在过程说明中；除非用户询问技术细节，不在最终回复中罗列。
- 按表达需要选择格式：普通文字、清单和简单表格可用 Markdown；复杂排版、图表、多栏卡片或交互优先用 HTML 页面。HTML 尽量自包含、适配手机，并在沙盒浏览器验证展示；文件链接使用简短有意义的标题。
`;

/**
 * Sandbox document skill. Written into the controlled CODEX_HOME skills
 * directory so both new and existing sandboxes can discover the document tools.
 * It is self-contained: it names the actual in-container CLI and libraries and
 * never refers to a host tool, a host skill package, or a network service.
 *
 * The file is managed (not `onlyIfAbsent`) so a tool-path change actually
 * reaches existing sandboxes; it never touches any other skill.
 */
export const DOCUMENT_SKILL_DIR = "skills/aio-documents";
export const DOCUMENT_SKILL_MD = `---
name: aio-documents
description: Create, modify and convert Word/Excel/PowerPoint/PDF documents inside the AIO sandbox with python-docx, openpyxl, python-pptx and headless LibreOffice. Use for generating reports, spreadsheets with formulas, slide decks, or converting between Office/PDF formats.
---

# 沙箱文档工具

在沙箱内创建、修改和转换文档。所有处理都在沙箱里完成，不依赖宿主机 Office。

## 先检查工具是否就绪

\`\`\`bash
/home/gem/.codex/tools/aio-doc/bin/aio-doc doctor        # 一次输出 CLI 与 Python 库的就绪状态
\`\`\`

未就绪时不要假装成功：告诉用户工具未安装，并让其在工作区「文件」页底部展开「文档处理」，点「安装/修复」。

## 首选入口：\`aio-doc\`

命令安装在 \`/home/gem/.codex/tools/aio-doc/bin/aio-doc\`（不在 PATH 上，用绝对路径调用）：

\`\`\`bash
/home/gem/.codex/tools/aio-doc/bin/aio-doc --help
\`\`\`

常用命令：

- Word：\`aio-doc docx-new <path> --text "..."\`、\`docx-read\`、\`docx-append\`
- Excel：\`aio-doc xlsx-new <path> --rows "a,b"\`、\`xlsx-set <path> B4 --value "=SUM(B1:B3)"\`、\`xlsx-read --values\`
- PPT：\`aio-doc pptx-new <path> --titles "第一页"\`、\`pptx-read\`
- 转换：\`aio-doc convert <path> --to pdf\`（也支持 docx/xlsx/pptx/csv/txt）
- PDF 文本：\`aio-doc pdf-text <path>\`

路径一律用工作区内的绝对路径（\`/home/gem/workspace/...\`）。工具只读写工作区内的文件。下文为简洁仍写作 \`aio-doc\`，实际请用上面的绝对路径。

## 直接使用 Python 库

需要更细的控制时直接用库（与 \`aio-doc\` 使用同一个隔离 venv）：

\`\`\`bash
/home/gem/.codex/tools/aio-doc/venv/bin/python -c 'from docx import Document; d = Document(); d.add_paragraph("你好"); d.save("/home/gem/workspace/报告.docx")'
\`\`\`

可用：\`docx\`（python-docx）、\`openpyxl\`、\`pptx\`（python-pptx）、\`pypdf\`、\`reportlab\`。
中文要指定字体（如 \`宋体\` / \`Noto Sans CJK SC\`）并确认渲染效果。

## Excel 公式的硬性规则

**openpyxl 不会计算公式。** 写入 \`=SUM(A1:A5)\` 只保存公式字符串，没有缓存值；
不重算的读取方会看到空白。因此：

1. 用 \`xlsx-set\` 或 openpyxl 写公式；
2. 用 \`aio-doc xlsx-recalc <path>\` 让 LibreOffice 重算并写入缓存值。默认输出到新文件
   \`<原名>.recalc.xlsx\`，**不覆盖原文件**；只有显式 \`--in-place\` 才覆盖原件，
   用 \`--out <path>\` 可指定输出路径；
3. 用 \`aio-doc xlsx-read <path> --values\` 确认缓存值真的出现。

只有第 3 步有真实数字才算成功；不要因为写入了公式就报告计算完成。

## LibreOffice 转换

\`\`\`bash
soffice --headless --norestore --nolockcheck --nodefault --nologo \
  -env:UserInstallation=file:///tmp/lo-profile-$$ \
  --convert-to pdf --outdir /home/gem/workspace/out /home/gem/workspace/输入.docx
\`\`\`

- 每次用一个独立的 \`-env:UserInstallation\`，避免与其它转换互相干扰。
- 不要加 \`--\` 分隔符：LibreOffice 7.3 会直接报 \`Error in option: --\`。路径本身是绝对路径，
  不会被当成选项。
- 输出到工作区内的新文件，**不要覆盖用户原件**。
- 字体与复杂排版可能与用户本机 Office 有差异，不要承诺 100% 保真；转换后要实际检查结果。
- 旧格式（.doc/.xls/.ppt）可先转成现代格式再处理。

## 交付

生成的文件放在 \`/home/gem/workspace\` 下的项目目录或 \`.scratch/artifacts/<topic>/\`，
不要散落在工作区根目录。最终回复交付文档链接与关键内容、必要限制；命令和检查步骤放在过程说明中，
不要在最终回复或交付文档中罗列使用的 skill、工具或命令，除非用户明确询问。
`;

export const CODEX_CONFIG_TOML = `# 由 AIO Agent 生成；如果你自行修改，系统不会覆盖此文件。
[mcp_servers.aio_browser]
url = "http://127.0.0.1:8080/mcp"

# Codex 本地 memory 开关（等价于命令行 \`codex features enable memories\`）；
# 记忆由后台在会话闲置后生成，不会立即出现。
[features]
memories = true
apps = false
plugins = false
remote_plugin = false

[apps._default]
enabled = false
`;

// System policy applies to both existing and newly created sandboxes, including
// CLI sessions started from their terminal. Keep personal account connectors out
// even when project/user config or a CLI override attempts to enable them.
export const CODEX_ISOLATION_MARKER = "# Managed by personal-agent: sandbox MCP isolation";
export const CODEX_REQUIREMENTS_TOML = `${CODEX_ISOLATION_MARKER}
[features]
apps = false
plugins = false
remote_plugin = false

[mcp_servers.aio_browser.identity]
url = "http://127.0.0.1:8080/mcp"
`;

export const CODEX_ISOLATION_OVERRIDES = [
  "-c", "features.apps=false",
  "-c", "features.plugins=false",
  "-c", "features.remote_plugin=false",
  "-c", "apps._default.enabled=false",
];

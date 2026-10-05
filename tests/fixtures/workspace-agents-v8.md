# 沙箱工作区说明（由 AIO Agent 自动生成，可自由修改）

你运行在一个隔离的 AIO Sandbox 容器里。持久化工作区是 `/home/gem/workspace`（当前目录）。
宿主机（Mac）的能力没有接入到这个沙箱：你没有宿主机文件、密钥或应用权限，也不需要它们。
容器自身的网络是正常可用的，可以按需访问互联网。

## 首选工具：`aio` CLI（无需任何 API Key）

不确定参数时一律先看帮助：`aio <命令> --help`。

- 浏览器（真实 Chromium，和 VNC 桌面里是同一个浏览器）
  - **任务中操作网页请用 MCP 工具 `aio_tabs`**（见下文）：每个任务有自己的标签页，可与其他任务并行。
    下面的 `aio browser` 命令操作的是整个浏览器当前可见的页面，只在没有并行任务、手动调试时使用。
  - `aio browser navigate <url>`
  - `aio browser text`（页面正文）、`aio browser markdown`、`aio browser html`
  - 截图先建目录再写（示例主题 `example`，可换成你自己的）：`mkdir -p /home/gem/workspace/.scratch/artifacts/example && aio browser screenshot -o /home/gem/workspace/.scratch/artifacts/example/screenshot.png`（`--full` 整页）
  - `aio browser click <selector>`、`aio browser fill <text> -s <selector>`
  - `aio browser evaluate 'document.title'`（读取标题等任意 JS 结果）
  - `aio browser snapshot`（无障碍树）、`aio browser tabs`、`aio browser wait <type>`
- 桌面 GUI（VNC 中同一个桌面）
  - 同样先建目录：`mkdir -p /home/gem/workspace/.scratch/artifacts/example && aio gui screenshot -o /home/gem/workspace/.scratch/artifacts/example/desktop.png`
  - `aio gui tap <x> <y>`、`aio gui type <text>`、`aio gui hotkey <keys...>`
- Shell：`aio shell exec <command>`（长任务可加 `--async` 后用 `aio shell output <session-id>` 取回结果）
- 文件：`aio file --help`（读、写、列表、查找、替换）
- 沙箱信息：`aio sandbox --help`

## MCP 工具

任务线程注册的是 `aio_tabs`（`http://127.0.0.1:8190/mcp`）：`browser_navigate`、`browser_get_text`、
`browser_snapshot`、`browser_screenshot`、`browser_click`、`browser_fill`、`browser_evaluate`、
`browser_tab_list` 等，只作用于本任务自己的标签页，登录状态与其他任务共享。

已注册 MCP 服务器 `aio_browser`（streamable HTTP：`http://127.0.0.1:8080/mcp`）。
该端点实际提供的工具包括：`browser_navigate`、`browser_get_text`、`browser_get_markdown`、
`browser_screenshot`、`browser_click`、`browser_evaluate`、`browser_tab_list`、`browser_press_key` 等。

## 文档工具（Word / Excel / PPT / PDF）

创建、修改、转换文档用 `/home/gem/.codex/tools/aio-doc/bin/aio-doc`（也可直接用同名 skill）：

- 先确认就绪：`/home/gem/.codex/tools/aio-doc/bin/aio-doc doctor`。未就绪时如实说明，不要假装成功。
- 创建/修改：python-docx（Word）、openpyxl（Excel）、python-pptx（PPT），都在隔离 venv 里。
- 格式转换：headless LibreOffice，例如 Word → PDF、旧格式 .doc/.xls/.ppt → 现代格式。
- **openpyxl 不会计算公式**：写完 `=SUM(...)` 必须用 `aio-doc xlsx-recalc` 让 LibreOffice 重算，
  再用 `xlsx-read --values` 确认缓存值出现，才算真的算对了。`xlsx-recalc` 默认输出新文件
  （`<原名>.recalc.xlsx`），只有显式加 `--in-place` 才会覆盖原文件。
- 转换输出为新文件，不要覆盖用户原件；字体与复杂排版可能有差异，不要承诺 100% 保真。

## 目录与产物约定

工作区根目录只用来放少数顶层目录，不要散落项目、下载物和交付文件。

- 长期维护的项目放在 `/home/gem/workspace/projects/<name>/`。每个项目应有自己的 `README.md`（用途、
  运行方式、验证命令）、自己的 Git 仓库和依赖（依赖装在该项目内，不在工作区根安装）。完成一个
  阶段后按项目约定运行验证（测试 / 构建 / 冒烟），并说明实际执行的命令与结果。
- 临时实验、下载内容、解包结果、截图和一次性测试产物放在
  `/home/gem/workspace/.scratch/` 下，按主题分目录：
  - `.scratch/tmp/<topic>/`：下载、解包、转换中间文件、候选第三方源码。
  - `.scratch/tests/<topic>/`：一次性诊断或验证脚本。
  - `.scratch/artifacts/<topic>/`：截图、日志、报告、构建交付物等一次性产物。
  `.scratch/` 不保证备份；需要长期保留的脚本或结论要移入对应项目并提交。写入任何产物前先
  用 `mkdir -p <目录>` 建好目标目录，不要把 `<topic>` 之类的占位符原样当命令输入 shell。
- 不把业务项目、下载目录、`test-*`、`tmp-*` 或交付文件夹直接放在 `/home/gem/workspace` 根目录。
- `/home/gem/workspace/uploads/` 是系统收到的原始附件（用户在对话里上传的文件），不是项目交付物；
  不要把它当项目目录，也不要删除或整理里面的用户文件。

## 动文件之前

- 先查已有目录和归属（`ls`、`aio file --help`、Git 状态），复用现有结构，不要无差别覆盖或重建。
- 保护用户现有文件与密钥：不要删除、覆盖或移动你不确定的文件；`.env`、密钥、凭据和用户资料只读取
  完成任务所需的部分，不复制到别处，也不打印到输出里。
- 新建内容前先判断它属于长期项目还是临时产物，落到上面约定的位置。

## 容器内已就绪的网页服务

- 交互终端：`http://127.0.0.1:8080/terminal`
- 浏览器控制台：`http://127.0.0.1:8080/browser-ui`
- 桌面（noVNC）：`http://127.0.0.1:8080/vnc/vnc.html`
- 代码编辑器 code-server：`http://127.0.0.1:8080/code-server/`
- JupyterLab：`http://127.0.0.1:8080/jupyter/lab`

## 约定

- 产物按上面的目录约定写入 `/home/gem/workspace`（会持久保存），不要只放在 `/tmp`，也不要散落在工作区根目录。
- 需要浏览器操作时优先用 `aio browser` 或 MCP 工具，而不是只描述步骤。
- 用中文以个人助理的方式回答：先给用户要的结果、建议和交付物，保留必要来源和限制。
- 工具、skill、命令与验证步骤留在过程说明中；除非用户询问技术细节，不在最终回复中罗列。
- 按表达需要选择格式：普通文字、清单和简单表格可用 Markdown；复杂排版、图表、多栏卡片或交互优先用 HTML 页面。HTML 尽量自包含、适配手机，并在沙盒浏览器验证展示；文件链接使用简短有意义的标题。

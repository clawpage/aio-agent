# AIO Agent

> Canonical repository: <https://github.com/clawpage/aio-agent>

**AIO Agent** 是一个 single-owner、self-hosted 的智能体控制台：一个常驻 **AIO Sandbox** 容器，
一个常驻 **Codex** 主智能体，中文 UI，桌面与手机功能对等。它适合个人或单人团队把
Codex + AIO Sandbox 跑在自己的机器上，通过自己的入口访问。

- **Single owner / self-hosted**：只有一个 owner 账号，没有注册入口，不是多租户服务，
  也不对外提供公共 demo。
- **Codex + AIO Sandbox**：命令、文件、浏览器、桌面、编辑器、笔记本都发生在容器里；
  控制面只以固定参数调用 Docker，不挂载宿主 home / workspace / `docker.sock`。
- **中文 UI**：登录、对话、审批、历史、配置、工作区全部为中文界面。
- **两个来源**：控制台（主站）与伴随工作区（AIO 全部界面）是两个不同来源，都要求登录，
  未登录一律 401。

本仓库的公开安装入口（Quickstart）只依赖本仓库与宿主已安装的 Docker + Codex CLI；
公共域名由使用者自行填写，仓库不附带任何公共 demo 入口。

## Quickstart

前置条件：

- Node.js **>= 24**（见 `package.json` 的 `engines`）
- 宿主已安装 **Docker**（AIO Agent 用它启动固定版沙箱容器）
- 宿主 **Codex CLI 已登录**（`codex login`；控制面通过官方方法从宿主机取访问 token，
  refresh token 永不离开宿主机）——这是真实运行时依赖，不是可选项

```bash
git clone https://github.com/clawpage/aio-agent.git
cd aio-agent
npm ci
cp .env.example .env
npm run build
node --env-file=.env dist/server/index.js
```

`node --env-file=.env` 只在这次启动读取仓库根目录的 `.env`（Quickstart 的配置入口）。
`var/runtime.env` 是另一条路径：只有 `bin/serve` 守护进程会读取它（见运行手册），
用 `node --env-file` 直接启动时**不会**读取。

首次启动会生成 owner 密码到 `var/owner-secret.txt`（0600，git 忽略，从不写日志）。

本机访问（两个不同来源，本地开发时分别对应）：

- 控制台（主站）：<http://localhost:4891>
- 伴随工作区：<http://127.0.0.1:4891>

生产使用者**必须**覆盖 `PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST` 为自己的域名；
`.env.example` 中的 `agent.example.com` / `workspace.example.com` 只是占位示例，
不是公共 demo，也没有对应的公共实例。健康检查：

```bash
curl -s http://127.0.0.1:4891/healthz
```

> **兼容保留的运行时标识**：为兼容既有部署，容器名 `personal-agent-sandbox`、命名卷
> `personal-agent-workspace` / `-codex` / `-browser`、SQLite 文件名 `personal-agent.sqlite`、
> cookie 名 `pa_*` 与 `PA_*` 环境变量前缀**保持不变**——这些承载既有容器、卷、数据库与登录
> 状态，改名会丢数据或中断服务。health `service` 字段与 Codex `clientInfo.name` 里的旧标识
> 只是为兼容已有集成而保留，不是品牌。品牌层（包名、页面标题、侧栏、文档）为 AIO Agent。

## 它是什么

```
浏览器 ─> agent.zymx.tech ────────┐   控制台：对话流、工具进度、审批、停止、重连、历史
浏览器 ─> agent-workspace.zymx.tech ┤   工作区：AIO 全部界面与 REST/WS 表面（同样需要登录）
                                   └─> 本机 Node 控制面（127.0.0.1:4891）
                                         └─> 沙箱容器 personal-agent-sandbox
                                               └─> 常驻 Codex app-server（stdio）
```

- **沙箱内执行**：命令、文件、浏览器、桌面、编辑器、笔记本都发生在容器里；宿主机（Mac）
  的能力没有接入沙箱，也不暴露 Docker socket 或 home 目录。
- **MCP 隔离**：沙箱的 Codex 禁用账号 Apps/Connector、插件及远程插件目录，MCP 只允许
  `aio_browser` 的沙箱内地址。独立系统策略同时覆盖当前与新沙箱，不改变 Mac 上的邮箱连接。
- **统一登录**：不在沙箱里重新登录。控制面从 Mac 上已有 `codex login` 通过官方方法
  `account/read {refreshToken:true}` + `getAuthStatus` 取访问 token，只把访问 token 交给沙箱
  （refresh token 永不离开 Mac）；沙箱 401 时由控制面按需重新取。
- **持久化**：工作区、CODEX_HOME、浏览器 profile 各一个命名卷；控制面重启、容器重启、
  浏览器断线都不丢历史。断线不会中断智能体，重连自动补齐事件。
- **自动标题**：每个会话首轮完成后，用沙箱内一个独立的临时 Luna 线程（`ephemeral` +
  `read-only` + `never` 审批）根据首条用户消息命名；不占用主执行队列、不改变主对话模型，
  失败保留“新会话”，用户手动改过的标题永不覆盖。

## 会话文件卡片与文档工具

对话里智能体提到的**工作区文件**（Markdown 文件链接、Markdown 图片引用、上传附件）会直接
渲染成文件卡片，不必再手动进工作区找：

- **图片**：卡片带懒加载缩略图，点开看大图。
- **PDF / Word / Excel / PowerPoint**：在沙箱内转换成分页 raster 图片预览（页码、翻页、
  截断提示），**原文件仍可下载**。
- **文本**：以转义后的纯文本展示（有大小上限），不执行其中内容。
- **其他格式**：明确说明「可下载」，不会假装能预览。
- 预览失败、转换失败、文件已删除都会给出可恢复的提示与重试，不显示成功空白。

工作区里的「文件」标签页统一承担目录导航、上传、新建、预览、下载、文本编辑与删除；对可转换格式的文件行还提供
「转换」入口（紧凑面板，可取消/执行，结果可预览下载），工具就绪状态收在底部默认折叠的「文档处理」里。
智能体侧可以在沙箱内**创建、修改、转换**文档（Word/Excel/PPT 用 Python 库，
格式转换与 PDF 用 LibreOffice），例如「把这个 Word 转成 PDF」「新建一个 Excel 并算总和」。

支持的转换目标：`pdf`、`docx`、`xlsx`、`pptx`、`csv`、`txt`、`odt`、`ods`、`odp`、`html`。

> **文档工具需要沙箱内系统依赖**（LibreOffice、poppler-utils、中文字体、Python 文档库），
> 不是 `npm ci` 带来的。缺失时 UI 会如实显示未就绪并提供「安装/修复」，不会让聊天服务无法启动。
> 安装/修复与重建后的处理见[运行手册](docs/RUNBOOK.md)。

所有解析与转换都发生在沙箱容器内，控制面只以固定 argv 调用固定容器命令；路径先经工作区范围
校验（拒绝越界、symlink 逃逸、选项注入），预览只回传受鉴权的 raster 图或安全文本，
下载主动内容一律 `attachment`。转换结果写成**新文件**，绝不覆盖原文件。

## 本地开发与测试

```bash
npm ci                   # 按 lockfile 安装（与 Quickstart 一致）
npm run build            # 构建前端 + 服务端
npm test                 # 单元 + 集成测试（自带假沙箱，无需 Docker）
npm run typecheck
```

本机运行（不经过任何 tunnel，只用 loopback）：

```bash
PA_BIND=127.0.0.1 PA_PORT=4891 node dist/server/index.js
# 首次启动会生成 owner 密码到 var/owner-secret.txt（0600，git 忽略，从不写日志）
curl -s http://127.0.0.1:4891/healthz
```

浏览器打开 `http://localhost:4891`（控制台；本地开发中 `127.0.0.1:4891` 是伴随站，
两者是不同来源，跨站规则与线上一致）。

> 可选：本仓库最初用 workspace 根目录的统一 launcher 管理现有部署
> （`tools/start.sh start|restart|stop|status personal-agent`）。它属于**现有部署的可选管理方式**，
> 不是公开安装的必要步骤；公开使用者用上面的 `node --env-file=.env dist/server/index.js` 即可。

## 验收（分四层，各层职责不同）

```bash
npm test                 # 1) vitest 单元 + 集成（自带假沙箱，不需要 Docker/网络）
npm run smoke            # 2) HTTP + WebSocket 冒烟（默认本地 localhost:4891 + 127.0.0.1:4891）
npx playwright test      # 3) 真实浏览器 UI（默认本地 http://localhost:4891）
# 真实公网验收：显式指定两个 origin（缺省只跑本地）
PA_PRIMARY_ORIGIN=https://agent.example.com \
PA_COMPANION_ORIGIN=https://workspace.example.com npm run smoke

# 本地假后端 UI 验收：静态 dist/web + 全部 /api 由 page.route mock，不会访问任何实例
npx playwright install chromium webkit # 首次准备浏览器运行时
npm run build && npx playwright test --config playwright.local.config.ts
```

| 层 | 覆盖 |
| --- | --- |
| `npm test` | 未登录绕过、会话过期/轮换/吊销与已建立连接被关闭、Host/Origin/CSRF 校验、重定向安全、代理 HTTP 与 WebSocket（对假沙箱）、事件回放与 delta 顺序、重复提交与跨会话冲突、停止语义、未知结果不重放、shell 支撑的文件操作只报真实结果、自动标题（首轮一次性、手动优先、失败保留、替换守卫、旧会话补名、超时后迟到事件隔离）、会话生命周期（空标题复用、重命名/恢复默认标题冲突 409、无删除接口）、沙箱浏览器标签 URL 校验 |
| `npm run smoke` | 真实 HTTPS 登录与 cookie 属性、模型列表、一次性票据（重放与开放重定向）、伴随站会话与跨源续期、经鉴权的 shell 调用、上传与列目录、跨源写入拒绝、原生界面可达、未登录时各表面一律 401、**真实 WebSocket 升级**（已登录 101 / 未登录 401） |
| `npx playwright test` | 登录界面（错误密码与正确密码）、对话页输入区不含任何模型/思考控件、统一配置页默认选中 GPT-6-Sol（桌面侧栏与手机底导航入口）、打开工作区后立刻切标签的竞态、连续切换最终落在最后点击的标签、真实文件列表与 code-server 可达、无横向溢出 |
| `npx playwright test --config playwright.local.config.ts` | 会话文件卡片与统一预览（图片缩略图/分页翻页/下载/失败重试/360px 无溢出）、工作区「文件」唯一入口/上传/目录导航/转换/迟到结果不跳目录、本地假后端（默认 `dist/web`，可用 `PA_TEST_WEB_ROOT` 指向 scratch 构建 + 全部 `/api` 由 `page.route` mock）：会话 `⋯` 菜单/重命名/归档/恢复且无删除、失败重命名保留输入、运行态与 `prefers-reduced-motion`、Markdown 链接只进沙箱浏览器（`mailto:`/相对链接保持不可导航）、归档行标题不可点、统一配置页保存/刷新持久化/跨会话生效/失败反馈/无模型列表时禁用保存/返回会话保留草稿、折叠 Working 分组默认收起/点击与键盘展开收起/增量不重置展开/终态停动画/审批露出/长历史展开自然高度与行可达（桌面 1440×900，手机 390/360 含 WebKit，短视口与暗亮无溢出） |
| 人工/父端验收 | VNC 桌面帧流、浏览器 CDP 帧流、手机 390/360 实际交互与截图 |

`npm run smoke` 会读取 `var/owner-secret.txt`（或用 `PA_OWNER_SECRET_FILE` 指定）。

## 配置

所有参数通过 `PA_*` 环境变量提供，见 [`.env.example`](.env.example)；生产覆盖写入
`var/runtime.env`（git 忽略）。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_PORT` / `PA_BIND` | `4891` / `127.0.0.1` | 控制面监听地址 |
| `PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST` | 源码默认 `agent.zymx.tech` / `agent-workspace.zymx.tech`（兼容保留） | **生产使用者必须覆盖**为自己的两个精确域名；`.env.example` 用 `agent.example.com` / `workspace.example.com` 占位 |
| `PA_TRUST_CF_CONNECTING_IP` | `0` | 仅当请求确实经由自己可信的反向代理（会覆盖 `CF-Connecting-IP`）时才设为 `1`；否则限速可被伪造头绕过 |
| `PA_SANDBOX_IMAGE` | `ghcr.io/agent-infra/sandbox:1.11.0` | 固定镜像，升级需人工确认 |
| `PA_SANDBOX_CODEX_VERSION` | `0.156.1` | 沙箱内固定版 Codex CLI（在持久卷里，升级见运行手册） |
| `PA_DEFAULT_MODEL` | `gpt-6-sol` | 未在统一配置页另选时的默认模型；配置页的模型/思考强度保存于 owner `meta`，对之后所有消息生效，提交时按 turn 冻结 |
| `PA_AUTO_TITLE` | `1` | 首轮完成后自动命名会话；只用首条用户消息，失败保留“新会话” |
| `PA_TITLE_MODEL` / `PA_TITLE_EFFORT` | `gpt-6-luna` / `low` | 只用于自动标题的隔离临时线程（read-only、never、ephemeral） |
| `PA_TITLE_MAX_CHARS` | `24` | 生成标题的最大字符数 |
| `PA_MAX_CONCURRENT_TURNS` | `3` | 跨会话同时执行的主 turn 上限（取值 clamp 到 1–3）；同一会话始终串行，排队 FIFO |
| `PA_REASONING_SUMMARY` | `concise` | 主 turn 的思考摘要模式（`concise`/`auto`/`detailed`/`none`），不展示原始思维链 |
| `PA_SANDBOX_PORT` | `18081` | 沙箱发布到 loopback 的端口 |
| `PA_OWNER_PASSWORD` | 空 | 设置则用它，否则生成到 `var/owner-secret.txt` |

## 文档

- [运行手册](docs/RUNBOOK.md)：启停、健康、日志、凭据、tunnel/DNS、故障处理
- [架构与安全边界](docs/ARCHITECTURE.md)：两个来源、会话与 CSRF、执行模型、token 边界
- [AIO 能力清单](docs/AIO-CAPABILITIES.md)：按固定镜像实测的 140 个接口与原生界面入口
- [项目规范](AGENTS.md)

## 已知限制

- 模型与思考强度已从对话输入区移入统一的“配置”页（桌面侧栏与手机底导航都有入口），
  输入区只保留附件、发送与停止。配置保存在 owner `meta`（`owner.agent_settings`），
  刷新与跨设备一致，且在每个 turn 提交时冻结，不影响正在执行的任务或历史。移动端布局测试
  包含 Chromium 与 WebKit 的 390/360 宽度、短视口、附件、发送和停止；配置页另测保存、
  刷新持久化、失败反馈与暗亮无溢出。WebKit 自动化不等同于 iPhone 真机软键盘与 Safari
  地址栏行为验收。

- 每轮的工具调用与思考摘要默认折叠进该轮的“Working…”分组：一轮一个分组、按 turn 隔离，
  该轮 `turn.started` 时就出现（不等首个工具），因此只有正文的轮次也有自己的一条。
  分组落在该轮开始处，缺失生命周期的旧历史按首次活动处，历史默认收起。分组头如实反映状态（运行中、排队等待、
  已完成、执行出错、已停止、结果未知），只有真正在执行的一轮才有循环扫光；排队不冒充
  运行，完成/失败/停止后动画停止。尚未产生工具或摘要的轮次展开后只给一句中性提示
  （如“正在处理…”），不伪造摘要。用户消息、助手正文、审批、补充输入与错误提示始终独立
  显示，不藏进分组；某个工具失败时折叠状态下也能从组头看到“工具出错”。分组头可点击或
  键盘操作（`aria-expanded`），展开状态在增量事件到达时保持，原始 reasoning 内容永不展示，
  只显示模型生成的摘要。展开时按内容自然撑开（卡片不参与父滚动容器的收缩），由外层滚动
  承载长历史。`prefers-reduced-motion` 下关闭扫光动画。

- JupyterLab 首次加载会出现 `Shared module @jupyter-widgets/base doesn't exist in shared scope`
  的第三方 widget 前端告警；内核执行本身正常（`/v1/jupyter/execute` 实测返回 stdout）。
- 沙箱镜像固定不自动升级；升级步骤见运行手册（需人工确认并复验浏览器与编辑器）。
- 沙箱里的 Codex CLI 不是镜像自带的那份，而是持久卷内固定版本（默认 `0.156.1`），
  控制面接管容器时核实/补齐，失败会明确报错而不是回退旧版；升级见运行手册。
- 只有本机 loopback 明文调试时才允许非 Secure cookie；公网一律 `Secure`。

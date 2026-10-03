# 一站 · AIO Agent

> Canonical repository: <https://github.com/clawpage/aio-agent>

**AIO Agent** 是一个 owner 管理的 self-hosted 的智能体控制台：每账号一个独立 **AIO Sandbox** 容器，
一个常驻 **Codex** 主智能体，中文 UI，桌面与手机功能对等。它适合个人或受信任的小团队把
Codex + AIO Sandbox 跑在自己的机器上，通过自己的入口访问。

- **账号分级 / self-hosted**：一个 owner 管理配置，可由管理员创建 member 账号；没有注册入口，账号间隔离运行环境，
  也不对外提供公共 demo。
- **Codex + AIO Sandbox**：命令、文件、浏览器、桌面、编辑器、笔记本都发生在容器里；
  沙箱容器不挂载宿主 home / workspace / `docker.sock`，只有不运行用户代码的沙箱守护进程 sandboxd 以固定参数调用 Docker。
- **三层可分开部署**：界面（`src/ui`）、控制（`src/control`）、沙箱（`src/sandbox`）各自构建、各自一个镜像，
  可以放在同一台机器或分开放；上线前和运行时都会校验版本兼容（见 [deploy/README.md](deploy/README.md)）。
- **中文 UI**：登录、对话、审批、配置、工作区全部为中文界面。
- **两个来源**：控制台（主站）与伴随工作区（AIO 全部界面）是两个不同来源，都要求登录，
  未登录一律 401。唯一例外是工作区来源上的公开分享页 `/u/<用户名>/share/<页面名>/`（见「分享网页」）。

本仓库的公开安装入口（Quickstart）只依赖本仓库与宿主已安装的 Docker（三个 Node 进程方式另需 Codex CLI 或 Claude 凭据）；
公共域名由使用者自行填写，仓库不附带任何公共 demo 入口。

## Quickstart

最省事的方式是 Docker Compose：三个镜像（界面、控制、沙箱）一条命令起齐，见 [deploy/README.md](deploy/README.md)。

也可以直接在宿主机上跑三个 Node 进程。前置条件：

- Node.js **>= 24**（见 `package.json` 的 `engines`）
- 宿主已安装 **Docker**（sandboxd 用它启动固定版沙箱容器）
- 模型凭据：宿主 **Codex CLI 已登录**（`codex login`；控制面通过官方方法从宿主机取访问 token，
  refresh token 永不离开宿主机），或 Claude Code 凭据（`PA_CLAUDE_CODE_SECRETS_FILE`）配合 `PA_HOST_CODEX=off`

```bash
git clone https://github.com/clawpage/aio-agent.git
cd aio-agent
npm ci
cp .env.example .env
npm run build
# 控制面与沙箱节点共用的令牌
printf 'AIO_SANDBOX_NODE_TOKEN=%s\n' "$(openssl rand -hex 32)" > var/sandbox-node.env && chmod 600 var/sandbox-node.env
PA_SANDBOXD_TOKEN_FILE=var/sandbox-node.env node dist/sandbox/index.js &   # 沙箱层 sandboxd :4894
node --env-file=.env dist/control/index.js &                                # 控制层 :4892
node src/ui/edge.mjs                                                        # 界面层 :4891
```

`node --env-file=.env` 只在这次启动读取仓库根目录的 `.env`（Quickstart 的配置入口）。
`var/runtime.env` 是另一条路径：只有 `bin/serve` 守护进程会读取它（见运行手册），
用 `node --env-file` 直接启动时**不会**读取。

首次启动会生成 owner 密码到 `var/owner-secret.txt`（0600，git 忽略，从不写日志）。

本机访问（两个不同来源，本地开发时分别对应）：

- 控制台（主站，经界面层）：<http://localhost:4891>
- 伴随工作区（控制层）：<http://127.0.0.1:4892>

生产使用者**必须**覆盖 `PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST` 为自己的域名；
`.env.example` 中的 `agent.example.com` / `workspace.example.com` 只是占位示例，
不是公共 demo，也没有对应的公共实例。健康检查：

```bash
curl -s http://127.0.0.1:4892/healthz   # 控制层（compatible = 能驱动沙箱节点）
curl -s http://127.0.0.1:4891/healthz   # 界面层（控制层提供它需要的 API 版本）
```

> **兼容保留的运行时标识**：为兼容既有部署，容器名 `personal-agent-sandbox`、命名卷
> `personal-agent-workspace` / `-codex` / `-browser`、SQLite 文件名 `personal-agent.sqlite`、
> cookie 名 `pa_*` 与 `PA_*` 环境变量前缀**保持不变**——这些承载既有容器、卷、数据库与登录
> 状态，改名会丢数据或中断服务。health `service` 字段与 Codex `clientInfo.name` 里的旧标识
> 只是为兼容已有集成而保留，不是品牌。品牌层为 **一站**（英文 AIO Agent）：页面标题、侧栏、登录页与图标用“一站”，包名与文档仍称 AIO Agent。配色语义：靛紫 = AI 在办（也是品牌主色），琥珀 = 轮到你（全站唯一醒目色），松绿 = 办完，朱红 = 出错；令牌定义在 `src/ui/src/styles.css` 顶部，新界面只用这些令牌，不写死颜色。

移动端使用左上角导航按钮打开左侧边栏，不占用底部对话空间；点开消息里的图片在预览窗口里完整显示（竖图按高度、横图按宽度缩放，顶部不被截掉；高度用 `100dvh`，iPhone Safari 的 `100vh` 比带工具栏时的可见区域高）；触屏设备上输入框、下拉框统一 16px 字号（iPhone Safari 会把字号小于 16px 的输入框聚焦时放大整页，且不缩回）；主会话、工作区、配置、主题和退出入口统一放在侧栏。Agent 操作浏览器不会自动展开工作区或切换当前工作区标签；用户可从侧栏手动打开，点击回复中的网页链接会在沙盒浏览器里新开一个属于你的标签页（独立窗口），并直接弹出与“接管”相同的操作面板：面板里是沙箱桌面（noVNC），打开时先把这个标签页的窗口提到最前；点按即点击，双指拖动滚动，手机上桌面按 1.6 倍屏宽显示，画面下方的黑色条既用来左右滑动查看整个页面，也是桌面工具栏（键盘、粘贴、回车、Tab、Esc，取代 noVNC 左侧的控制栏；只看 AI 操作时只留滑动），点「键盘」唤起手机键盘、输入直接发到桌面（镜像自带的 noVNC 1.4.0 在手机上有两个问题：键盘一次点按会发成两个键，长按会按住右键 —— 网站的「按住确认你是真人」因此在手机上永远过不了。控制面在沙箱启动时给它打了补丁：一次点按一个键，长按 1 秒后按住左键，双指点按仍是右键；双指捏合不再缩放网页——原版会发 Ctrl+滚轮，Chrome 按站点记住缩放（曾把 Amazon 停在 150%，页面按 853 像素宽排成窄版）；见 `src/control/sandbox/novncPatch.ts`）；页面被别的窗口盖住时点“切回这个页面”。这类标签页只归你：智能体的标签页列表看不到、也不能读取或操作它们，最多保留最近 3 个，关闭面板即关闭。需要完整桌面时点面板里的“在工作区打开”。手机上（视口 ≤720px）操作面板和工作区「浏览器」不再把 1280 宽的桌面缩到屏幕宽（约 0.3 倍，看不清），而是画成屏幕宽度的 2 倍，在图片外的黑色区域左右滑动平移查看；点按、双指滚动等照旧发给页面。电脑上照旧整屏适配。标签页服务不可用时退回为打开工作区浏览器。打开过程中显示一张加载卡片（打开的是什么、可随时取消；超过 8 秒提示浏览器可能在唤醒），60 秒仍无结果就自动放弃并说明原因，不会卡在遮罩上。

消息按浏览器本地时区显示“刚刚 / 几分钟前 / 今天 / 昨天 / 日期”，悬停可查看完整时间。
任务执行中显示实时经过时长，结束后固定为处理用时；不含分配、排队或执行前等待用户补充，
包含执行中的等待确认。没有实际开始记录、或执行结果未知时不推算处理时长。

## 账号与权限

- owner 保留模型、推理强度和 SOUL 配置。member 的主会话和任务列表只显示本账号内容，不能通过任务 ID 读取、引用或停止他人的任务。
- member 的派单和执行均由服务端固定为管理员分配的模型 / `high`：默认 `deepseek-v4.1-flash`（Codex），也可分配 `claude-sonnet-5-5`（Claude Code）。忽略客户端模型参数，分配的模型不可用时拒绝执行，不回退 GPT。会话标题由派单器按任务给出。
- member 不展示配置入口、模型与推理参数、SOUL 原文；配置/模型/能力清单接口拒绝访问，JSON 与 SSE 隐去模型配置元数据。正常回答内容不会被关键词过滤。
- **账号独立环境**：member 的容器、workspace、Codex 记忆/历史、浏览器 profile、终端、任务数据库、SOUL 和文档缓存独立。owner 沿用原容器与数据卷；新成员不复制 owner 的文件或历史。
- 成员环境默认限制为 2 GiB 内存、2 CPU、1024 个进程，阻止连接内网、宿主服务和其他沙盒；公网仍可访问。网络规则由独立只读守卫容器应用，成员无 NET_ADMIN / NET_RAW 权限。
- member 不接收 owner 的 ChatGPT token、模型桥管理密钥或 Claude Code 凭据。独立模型网关仅接受该账号凭据下的无状态 DeepSeek high 请求，禁用历史响应查询；分配了 Claude 的账号还可以请求 Messages API（仅 `/v1/messages` 与 `/v1/messages/count_tokens`），模型强制改为分配的模型，owner 的 Claude Code 凭据由网关在宿主侧附加，沙盒内只有该账号自己的网关令牌。分配了 `gpt-6.1-sol` 的账号走同一条无状态 Responses 路由，网关改发到 ChatGPT（`PA_CHATGPT_CODEX_URL`），模型固定为 `gpt-6.1-sol`、思考强度 high、`store:false`、去掉 `service_tier`，控制面自己的 ChatGPT 登录（`codex-login`）由网关在宿主侧附加；控制面没有 ChatGPT 登录时该账号直接报服务不可用，不会退回 DeepSeek。网关监听 `PA_MEMBER_MODEL_PORT`（默认 4902）。
- 每个账号都有自己的路径：主控制台是 `<主域名>/u/<用户名>`（根路径和 `/login` 登录后自动跳到自己的地址；同一浏览器一次只登录一个账号，打开别人的地址只显示“这是 X 的页面”，可退出后登录该账号或回到自己的页面）；工作区在同一个工作区域名下是 `<工作区域名>/u/<用户名>/...`（owner 也是 `/u/owner`，旧的根路径和 member 的 `/u/<账号散列>` 链接仍可用），不需要新增 DNS、TLS 或 tunnel 路由。容器与卷名仍按账号散列命名，不会改名。前缀与工作区会话账号不一致时一律 401；不对应任何账号的 `/u/...` 视为沙盒应用自己的路径，按会话账号路由；页面里不带前缀的绝对路径子资源（如 Jupyter 的 `/jupyter/static/...`）按工作区会话所属账号路由，只会到达该账号自己的沙盒。环境启动失败时拒绝连接，绝不退回 owner 沙盒。账号共用同一个浏览器来源，因此同一浏览器先后登录不同账号时，工作区页面（code-server、Jupyter 等）的浏览器端存储是共用的；沙盒文件、进程与记忆的隔离不受影响。
- 账号配置和登录鉴权由宿主控制面统一管理；容器共享宿主内核，因此这不是抵抗内核漏洞的虚拟机隔离。
- 创建账号（先构建；使用与服务相同的环境变量/数据目录）：`node --env-file=var/runtime.env bin/create-user.mjs <username>`。Quickstart 使用 `.env`。随机密码写入 `var/user-secrets/<username>.txt`（0600），命令不打印密码、不覆盖已有账号，不提供公开注册。
- 分配成员模型：`node --env-file=var/runtime.env bin/set-user-model.mjs <username> <deepseek-v4.1-flash|claude-sonnet-5-5|gpt-6.1-sol>`（compose 模式：`docker compose -p aio exec control node bin/set-user-model.mjs ...`），重启服务后生效。分配 Claude 需要 owner 已配置 Claude Code 凭据，用量计入 owner 的 Claude 账号；分配 `gpt-6.1-sol` 需要控制面已用 `codex-login` 登录 ChatGPT（`AIO_HOST_CODEX=on`），用量计入该 ChatGPT 账号。

## 用量看板

owner 侧栏的「用量看板」按账号显示每天的 token 趋势、输入/输出/缓存汇总和每日明细，
支持最近 7、30、90 天与单账号筛选。统计时区取 `PA_BROWSER_TIMEZONE`（默认洛杉矶），
每 30 秒刷新。成员无入口，`GET /api/usage?days=30` 仅 owner 可访问。

计数持久保存在控制面各账号数据库，包括 Codex / Claude 执行、派单和标题调用。
缓存读取与写入属于输入，总 token = 输入 + 输出。历史只回填已保存的 Codex 用量事件；
旧 Claude、旧派单、缺失报告、外部客户端、图片生成与 Jev 不计入，不推算账单或订阅额度。
采集开始时间与最早记录显示在看板底部。具体口径见 [运行手册](docs/RUNBOOK.md#token-用量统计)。

## 主会话的克制追问

派单时，只有缺少无法合理默认的关键条件才会在主会话提问。例如实际查询机票缺目的地或日期，
会一次问齐缺少的条件；一般旅行建议、灵活日期探索，以及预算、风格等可选偏好不会触发问卷。
问题显示为“等待你补充”，不启动子任务、不占执行名额或共享资源。直接在主输入框回答或补充，
主会话会结合待回答的问题和任务上下文自动接回原任务，无需点击按钮或选择任务；无关请求继续独立执行。部分回答只追问仍阻塞的条件。

问题是在几个明确答案里选一个时（哪个品牌、哪一家、要不要），派单器会同时给出 2–5 个选项（`options`），问题下方显示为可点选的列表；
点一下就作为回复发回这个任务，不再经过派单，原任务直接带着答案重新判断；也可以照常在输入框里自己写。执行中的任务需要用户拍板时，
回答最后可以带一个 ```` ```choices ```` 代码块（JSON 列表或每行一项），同样显示为可点选的答案，点选后作为回复接续该任务；
已经回复过的选项会勾选并关闭。
问题与回答持久保存，刷新或服务重启后仍可继续；答案足够后只启动原任务一次。

普通聊天、身份介绍和可直接回答的问题默认在对话中完整回复，不创建任务目录或额外生成文件。工具仅用于回答所需的事实或操作；只有需要独立文件交付时才进入制作与验证流程。

阅读型交付物按内容选择格式：普通文字与简单表格可用 Markdown；复杂排版、图表或交互优先用适配手机的 HTML 页面。用户指定的格式优先。HTML 文件卡片默认展示页面，可切换源码、下载原文件；隔离预览支持内嵌样式和脚本，不加载外部网络资源或读取主站登录状态。超过内联上限（`PA_DOC_TEXT_MAX_KB`，默认 256 KB）的页面不再只让下载，而是直接在沙箱浏览器里新开一个属于你的标签页完整打开，与点开网页链接一样弹出操作面板（noVNC）；小页面也可以点预览底部的「在浏览器打开」，需要联网资源的页面在那里能正常加载。文件不离开沙箱：控制面核对路径在工作区内、是 HTML 文件后，把解析后的真实路径作为 `file://` 地址交给沙箱浏览器（`POST /api/browser/files`），标签页服务也只接受工作区下的 `file://` 地址。

## 它是什么

```
浏览器 ─> agent.clawpage.ai ────────┐   控制台：对话流、工具进度、审批、停止、重连、历史
浏览器 ─> agent-workspace.clawpage.ai ┤   工作区：AIO 全部界面与 REST/WS 表面（同样需要登录）
                                   └─> 本机 Node 控制面（127.0.0.1:4891）
                                         └─> 沙箱容器 personal-agent-sandbox
                                               └─> 常驻 Codex app-server（stdio）
```

- **工作区是一台小电脑**：外观参照 macOS，顶部是菜单栏（当前应用、新标签页、时钟、关闭），中间是壁纸桌面和一个应用窗口，底部是程序坞（浏览器、终端、文件、编辑器、笔记本、预览，owner 另有接口与 MCP）。窗口左上角的红、黄按钮把窗口收起回到桌面（同时卸载页面、释放浏览器占用），绿按钮全屏；从程序坞或桌面图标重新打开。颜色都取自 `styles.css` 顶部的令牌。
- **沙箱内执行**：命令、文件、浏览器、桌面、编辑器、笔记本都发生在容器里；宿主机（Mac）
  的能力没有接入沙箱，也不暴露 Docker socket 或 home 目录。
- **MCP 隔离**：沙箱的 Codex 禁用账号 Apps/Connector、插件及远程插件目录，MCP 只允许
  `aio_browser` 的沙箱内地址。独立系统策略同时覆盖当前与新沙箱，不改变 Mac 上的邮箱连接。
  owner 接入知识库后，获准账号另放行它自己的 `aio_kb` 地址（见下文“知识库”）。
- **统一登录**：不在沙箱里重新登录。控制面从 Mac 上已有 `codex login` 通过官方方法
  `account/read {refreshToken:true}` + `getAuthStatus` 取访问 token，只把访问 token 交给沙箱
  （refresh token 永不离开 Mac）；沙箱 401 时由控制面按需重新取。
- **持久化**：工作区、CODEX_HOME、浏览器 profile 各一个命名卷；控制面重启、容器重启、
  浏览器断线都不丢历史。断线不会中断智能体，重连自动补齐事件。

## 一个主会话，多个任务

主页面只有一个对话入口。新请求创建持久化任务，由独立 Codex 线程执行；相关补充自动加入原任务。任务运行时
仍可继续发消息，默认最多 **3 个执行任务并行**，超出的任务等待空位。执行过程默认收拢为
状态条，开始执行时附一段不超过 100 字的整体说明，只生成一次，后续过程不反复刷新；点击可查看详情。结果按完成时间回报到主会话，支持文件卡片、预览与下载。

- 主派单器使用 `PA_TITLE_MODEL`（默认 `gpt-6-luna`，派单固定 high），判断任务标题、相关背景、
  前置依赖及共享资源；只做分类，不执行用户任务。子任务使用配置页的模型，提交时冻结模型设置。
- **历史召回**：派单器除了最近 12 个和进行中的任务，还会看到今天的其余任务（最多 10 个），以及按新消息从全部历史任务中检索出的相关任务（SQLite FTS5，中文按相邻两字切词，BM25 打分；低于最佳匹配 30% 的丢弃，最多 10 个；消息很短时再按今天最近的话题召回最多 3 个）。召回的任务只给摘录和日期。派单器判断消息指向更早的事而列表里没有时，可以先返回关键词搜索（每次最多 3 个词，最多搜 2 次，搜索合计最多加入 10 个任务），再带着结果做决定。召回的老任务一般作为相关背景交给新的执行会话；若新消息是在回应某个已结束任务最后提出的问题（如它问“需要你授权……吗？”，你回“已授权”），或要在它原有的现场接着做，派单器返回 `resume`，新任务续接那个任务原来的执行会话（`thread/resume`，保留完整上下文），与“引用任务”的效果相同。
- **主会话时序**：派单器和执行会话都会拿到“主会话时间线”——按时间先后列出最近的用户消息（时刻、原话摘录、归属的任务及状态、助理最后向用户问的问题），最后一条标 ▶ 是本次消息。执行会话还会看到相关任务的创建时刻和它们最后问用户的问题；续接已结束任务时写明“本次消息接续任务 X，它最后问：……”。追加给进行中任务的补充带上发送时刻和最近 6 条对话。
- **Jev 第二意见**：配置了 Jev（见下文“Jev 决策”）时，每次自动派单前先把候选任务（最近 15 个从新到旧，再加上按本消息内容召回的较早任务，带时刻、状态、最后的问题或结果摘要）和“NEW”交给 Jev，按主会话时间线判断本消息接续哪个任务；高置信（首选概率 ≥0.6 且领先 ≥0.15）时作为 `decisionHint` 交给派单器优先采信，派单器仍有最终决定权。Jev 的判断（概率 ≥10% 的前 3 项，含“独立新请求”）随计划存进 `plan_json.jev`，执行会话也会看到：主会话时间线里相应任务的那一行标注“〔Jev：本次消息接续它 N%〕”，时间线后另列这几项的时刻、状态、最后的问题或结果开头，以及用法（高置信时先沿用该任务已做的工作和结论、按它理解指代，不从零重做；否则只作线索，与用户原话冲突时以原话为准）；补充消息的时间线也带同样的标注。Jev 不可用或超时（`PA_JEV_DISPATCH_TIMEOUT_SECONDS`，默认 15 秒）时照常派单。每次的判断、概率与耗时记入召回监控（`recall_events.jev_json`）。
- **调试模式（仅 owner）**：配置页“调试模式”开关（只记在当前浏览器）打开后，主会话每条消息下方多一个“派单日志”按钮，按步骤展示这条消息的每次派单：主会话时间线、候选任务及来源、Jev 的候选说明与各项概率、派单器每一轮的完整提示词（最多 4 万字）和原始回答（最多 8 千字）、搜索词、重问原因、最终计划与自动修正、失败原因。日志随召回监控存在 `recall_events.steps_json`，接口 `GET /api/settings/dispatch-log/<任务id>` 仅 owner 可用。
- **派单结果容错**：派单器的回答有不影响权限的小问题时自动修正而不是整条失败（去掉不存在的任务 id、关联任务超过 12 个时截断且依赖优先、追加目标已结束时改为关联背景、追问超过 200 字截断、JSON 外包了说明文字时取出 JSON）；资源声明无效、缺标题或结构不对时，把原因告诉派单器重问一次，仍不行才标记“分配失败”，并在卡片上写明原因。修正与失败原因记入召回监控。
- **召回监控**：每次派单记录看到的候选及来源、搜索词、轮数、最终选中的任务、耗时和提示词长度；手动引用的老任务用来衡量检索能否找到它（排名、recall@上限、MRR）。配置页“历史召回”展示近 7/30 天统计（`GET /api/settings/recall`，仅 owner）。召回上限在手动引用的最近窗口外老任务满 20 次后，按其排名的 P90 + 2 自动收紧，范围 5–10。
- 每项任务提供“引用任务”：选择后输入框显示引用目标，可取消或切换；提交成功清除，失败保留引用、草稿和重试消息 ID。人工指定优先于模型：进行中或待补充的任务直接追加；已结束的任务复用原执行 conversation，调用 Codex `thread/resume` 保留完整上下文继续，同一执行会话的轮次串行。新的用户消息和结果独立记录，旧结果不会被覆盖；引用旧结果时若该会话已有后续任务在执行，补充到当前轮次。停止中的任务先等停止完成；尚未创建执行线程的任务首次执行才会创建线程。派单模型不能把人工引用改指其他任务。未引用时，普通跟进仍由派单器结合最近任务自动识别。
  地址、条件、纠正以及同一交付物的新增要求会直接追加到运行中的原子任务，只保留一条运行状态和最终回报。
  如果原任务恰好已结束，补充会作为带原结果背景的后续任务处理；送达状态不明时提示核对，不自动重发。
  必须依赖前置结果的任务等前置成功才执行；失败或未知结果不会被假定成功。
- 普通聊天、文字或文件任务不等待浏览器恢复；只有派单资源包含浏览器的任务才检查恢复状态。任务中途追加浏览器操作时也会先核对就绪，再送达补充；恢复失败不会中断原本的非浏览器工作。
- **浏览器锁标签页、不锁浏览器**：同一账号只有一个浏览器（登录状态共享），多个浏览器任务可以同时执行。每个标签页记录着创建它的任务（编号、任务标题、创建与结束时间，登记在沙箱内的标签页服务里，服务重启后按浏览器页面 ID 重新认领）：只有创建它的任务能操作（打开网址、点击、填写、按键、执行脚本、关闭），其他任务只能只读（正文、HTML、页面结构、截图、列表）。任务回合结束后标签页保留并标记为已结束，续接时接着用；按需销毁：任务自己关闭、已结束标签页超过 8 个时关最久未用的、浏览器因空闲释放前清理全部已结束标签页（不进快照）。渲染进程崩溃的标签页立即关闭，任务改开新标签页继续。**内存不够时让路**：沙箱的浏览器、智能体和工具共用一个 cgroup 内存上限（owner 沙箱 2 GB，浏览器常占一半以上），超了内核会结束渲染进程（页面 “crashed”）。标签页服务每 5 秒读 cgroup 的工作集（扣掉可回收的页缓存）和 OOM 次数，按价值从低到高关页面：已结束任务的标签页（最久没用的先关）→ 用户自己打开、闲置超过 10 分钟的页 → 内存吃紧时，没人管、15 分钟没换过地址且里面没打过字的页。工作集超过上限 85% 时开始腾到 75%；任务或用户要打开页面而空闲不足 400 MB、页面刚崩溃、或刚发生 OOM 时直接腾到底。进行中任务的标签页和用户接管中的页从不关；页面崩溃时智能体收到“已腾出内存，重新打开再试”。`/healthz` 带出当前用量和 OOM 次数。随包的 patchright-core 在构建时打了一处补丁（`scripts/patchright-patch.mjs`，版本对不上时构建失败）：它在页面崩溃后读取页面会无间隔地无限重试，把整个标签页服务卡死，补丁让这种读取直接报错。控制面若发现标签页服务连续两次不应答，只结束这个脚本自己的进程再重启，不会因为卡死的旧进程占着端口而永远起不来。
- **人与 AI 交接浏览器**：用到浏览器的任务卡片上有浏览器条（实时截图、标题网址、状态：AI 操作中 / 需要你操作 / 你正在操作 / 已结束）。每个任务的标签页开在各自的浏览器窗口里（后台窗口也能稳定截图）。点“接管”（或“去浏览器操作”）会打开操作面板：面板里是沙箱桌面（noVNC），先把该任务的窗口提到最前，你看到和操作的就是这个页面（noVNC 显示整个桌面，其他窗口仍在下面，可点“切回这个页面”）；需要完整桌面时可从面板“在工作区打开”。你控制期间 AI 对这个标签页既不能操作也不能读取（避免看到你输入的密码），它的标签页列表里也只显示“用户正在操作”，不显示标题和网址，其他任务照常并行，其他任务新开的标签页也不会把它挤到后台。遇到登录、验证码、二次验证、输入密码或支付信息、付款、下单、发送消息、修改账号设置等需要本人完成或不可撤销的最后一步，AI 调用 `browser_request_human` 说明原因后原地等待（最长 30 分钟，任务保持运行、浏览器不会被释放），任务卡与主会话标题都会显示“需要你操作浏览器”；你点“交还给 AI”后它拿到当前页面继续，超时、停止或任务结束则停止等待。AI 不在对话里索要密码或验证码，结果不确定的操作不自动重做。任务线程关闭了会抢“当前可见页”的 `aio_browser`，并被告知不要用 `aio browser` 命令行。文件使用 `read:绝对路径` / `write:绝对路径`：不同目录、同目录只读可并行；父子路径重叠且含写操作才等待。路径在沙盒内解析 realpath，同时保留原路径以覆盖符号链接别名；声明的路径解析失败退回工作区锁，任务自己的目录或附件解析失败则等其他任务都结束。`workspace` 保留给全局安装、共享环境变更和范围未知的写操作：它只与其他 `workspace` 任务及声明了文件路径的任务互相等待，不等只用自己任务目录和附件的任务（聊天、浏览器、新文档照常并行）。要动整个工作区（清空、整体移动或打包）时派单器申请 `write:<工作区根目录>`，等其他任务都结束。
- **密码器**：AI 遇到账号密码登录页时先看清登录框，写出登录步骤交给 `browser_login`（点开登录入口、把 `{{username}}` 填进账号框、`{{password}}` 填进密码框、提交），系统把密码器里的值代进占位符执行，AI 看不到值；密码只会填进 type=password 的框，步骤总是从重新加载的页面开始。出错时 AI 收到哪一步、什么错误（不含账号密码），改写步骤重试，同一个标签页最多 3 次，之后改为请你在浏览器里登录。AI 读取页面后用 `browser_login_report` 报告是否成功：成功的步骤按网站记下（密码器页显示步数、成功和失败次数，可清除），之后 AI 不写步骤时直接沿用。没有步骤时退回旧的自动识别输入框。系统按页面所在网站在密码器里找账号：正好一个就直接填进页面并提交；没有或有多个时，任务卡片上显示「需要登录」，你选一个已保存的账号，或当场输入一次（默认存进密码器），也可以点「跳过，自己在浏览器里输入」回到原来的接管方式。AI 只收到「已填入并提交」之类的结果，提交后页面上残留的密码框内容会先清空，AI 之前在该页执行过脚本时会先刷新页面再填，填写期间任何任务都不能读写这个标签页。侧栏「密码器」列出各网站的账号，可添加、修改、删除，点「显示密码」才取回单个密码，离开页面即隐藏。密码用 AES-256-GCM 加密存在本账号的控制数据库里，密钥是数据目录下 0600 的 `vault-key`，不进沙箱；一个账号只会填进它保存时的网站及其子域名。很多网站用 Google 登录：在卡片上点「用 Google 登录」（账号栏可填要用的 Gmail，不填就用浏览器里已登录的），或在密码器页把网站的登录方式设成「用 Google 登录」，都不存密码；之后 AI 再登录这个网站时会直接被告知点网站的 Google 登录按钮、选哪个 Google 账号，Google 要求输入密码或二次验证时再请你操作。验证码、二次验证、扫码登录仍走 `browser_request_human`。
- 新 PPT、文档等使用预装工具在 `workspace/tasks/<task-id>/` 生成，默认不申请共享工作区锁；服务端自动保护该任务目录和附件读路径。临时文件与 LibreOffice 配置也使用任务独立目录。前端区分文件冲突、浏览器、前置任务、并发空位等等待原因。
- 资源范围从派发持有到任务结束，补充需要扩大范围时先等冲突释放；旧任务资源不会自动缩窄。这是单控制面调度和执行指令层的协作约束，**不是每任务独立容器、文件权限隔离或分布式锁**。执行者不得通过新符号链接、全局配置或遗留后台写入绕过声明范围。
- 每个任务可以单独停止。重试发送用同一消息 ID 去重；派单失败尚未执行，可重试分配。
  执行结果未知不自动重跑，重启后的在途任务会明确提示先核对，避免重复副作用。
- 沙盒内 Codex 命令默认完整访问且不请求审批（`approval_policy=never`）；新建、恢复、派生线程和每次执行均显式设置。权限仅作用于容器，不开放 Mac 宿主机或解除 MCP 隔离。其他需要用户输入的交互仍保留；缺少必要信息时用户在主会话继续作答。
- 最终回复以个人助理的方式给出结果、建议和文件链接；skill、工具、命令等实现细节留在过程详情，保留来源和必要限制。
- 主界面不提供旧会话历史入口；任务结果保留在主会话中，任务过程可单独查看。相关补充归入原任务后，进行中卡片跟随最新补充消息，只保留一张，操作仍指向原任务。
- 登录页会重新验证 HttpOnly 会话 cookie；有效时自动进入主会话。页面返回前台、Safari 恢复页面或网络恢复时自动重查，登录页可见期间每 15 秒重试。网络故障不会清除凭据；过期或已撤销会话仍需要登录。登录态请求跳过缓存。
- 配置页「助理设定 · SOUL.md」可编辑个人助理身份、语气和行为。原文保存在控制面的 `var/SOUL.md`（自定义 `PA_DATA_DIR` 时在对应目录），权限 0600，不进入 Git、不暴露给沙盒写入。内容通过 Codex `developerInstructions` 系统层字段原样注入主会话规划及所有子任务执行线程的新建、resume、fork（owner/member 均适用）；不拼进普通用户消息。下次规划/启动/继续任务时读取最新内容，保存不打断当前轮次。支持清空（显式清除旧设定），最大 64 KiB，多设备编辑冲突会拒绝覆盖并保留草稿。模型目录暂不可用时仍可独立保存。
- 主会话每 2.5 秒刷新一次最近的任务：`GET /api/main` 返回整页内容的哈希 `version`，页面下次带上 `?v=<version>`，内容没变时只回 `{"unchanged":true}` 几十个字节，有变化才下载整页（约 150 KB）。滚动到接近顶部时自动加载更早的任务（每页 100 个），正在看的内容停在原处不跳。消息里的商品卡片图片（经沙箱取回的网上图片）、SVG 卡片和地图瓦片都在滚到附近时才加载；SVG 按自己声明的尺寸先占好位置。
- 侧边栏「任务列表」共用主会话的实时状态源，优先展示待补充和执行中任务；点击进入任务详情并可返回列表，分页加载更早任务，主会话草稿保持不变。追问以“需要你补充”强调卡片展示，仍直接在主输入框回答。

终端页使用紧凑会话选择器，点击可切换到对应 session 并恢复原终端输出；支持新建、复制完整 ID、刷新与关闭指定会话。关闭运行中的会话会先提示，关闭当前会话后选择剩余会话，全部关闭时显示空状态，不自动创建新会话。切换标签或隐藏页面不会关闭 session。底层 Shell 会话仍属于受信任成员共享环境。

## 定时任务与循环任务

在主会话里直接说时间和要做的事即可，例如「每天早上 8 点查天气提醒我带伞」「每 2 小时看一下这个商品降价没」「明天下午 3 点提醒我给妈妈打电话」「现在查一下，之后每周一再查」「帮我盯 10/6 Prime Day」。定时任务属于账号，保存在控制面里，与哪个对话、哪个执行会话创建它无关：会话结束后照样按时运行，每次运行是一个新任务。

- **创建**：派单器判断出定时或循环要求时，在计划里给出 `schedule`（`once` / `daily` / `weekly` / `monthly` / `interval`，可带次数 `maxRuns` 或结束日期 `until`，以及每次运行要做的 `instruction`）。服务端按 `PA_BROWSER_TIMEZONE`（默认 America/Los_Angeles）校验并算出下次运行时间，主会话里直接回复规则和下次时间；规则无效时把原因交回派单器重答，时间说不清时派单器会先问。「帮我盯着…」「到时候提醒我…」这类指向将来某天或等某件事变化（降价、到货、开售、活动日）的请求也按定时处理：派单器选合适的节奏（例如每天查到活动那天），节奏不明显时先问并给出可点选的选项。说了「现在先做一次」时本次照常执行。
- **执行会话也能建**：每个账号的执行会话注册 MCP 服务 `aio_schedule`（成员模型网关上的 `/schedule/<该运行时的令牌>/mcp`，只通向这个账号自己的定时任务），工具 `schedule_create` / `schedule_list` / `schedule_change`（暂停、恢复、取消），规则校验、上限和派单器创建的完全相同，执行会话被告知定时任务跨会话有效。Claude Code 自带的会话内计时工具（`CronCreate`、`CronDelete`、`CronList`、`ScheduleWakeup`，只活在一次 CLI 运行里）在执行轮次里关闭，避免智能体以为定时任务随会话结束。循环间隔至少 15 分钟，每个账号最多 20 个进行中的定时任务。
- **运行**：控制面每 30 秒检查一次到点的定时任务，直接建一个已派好的任务（不经派单路由），上一次运行的结果作为背景，便于对比变化；执行会话被告知用户不在场，要直接完成并汇报，不提问等待、也不再建定时任务。上一次还没结束时跳过这一拍；服务停机期间错过的只补跑一次。结果出现在主会话，显示为「定时任务「…」自动运行」，不冒充用户消息。
- **内置每日推送**（`PA_DAILY_FEED=1`，默认开启）：每个账号都有一个「每日推送」，每天 08:00 运行，但只有过去 24 小时里用户发过消息才真正运行，否则静默跳过（手动「立即运行一次」不受限）。执行会话拿到用户全部过往任务的摘要（不限 24 小时）和最近 14 次推送的话题记录，挑出今天可能感兴趣或需要提醒的 1-5 件事，需要时上网核实（例如关注的商品降价了）并附来源；同一话题连推 3 次而之后用户没有相关新任务就停推，新任务体现的兴趣优先；没什么可说时只回一句，不发手机通知。每次推送写到的话题记在 `feed_history`，结果里的机器标记（`<!--feed-topics: …-->` / `<!--feed-empty-->`）不显示给用户。内置任务可以暂停、恢复，不能删除；在主会话里说“别再推了”也会暂停它。有内容时用手机通知推送「今日为你留意」。
- **管理**：侧栏「定时任务」页可以暂停、恢复、立即运行一次、删除；也可以在主会话里说「暂停天气提醒」「取消价格监控」，派单器据已有定时任务的列表给出 `scheduleAction`。删除不影响已有的运行结果。

## 出图（aio_image）

在主会话里说「画一张…」「把这张图背景换成…」即可。每个账号的执行会话（Codex 和 Claude Code 都有）注册 MCP 服务 `aio_image`（成员模型网关上的 `/image/<该运行时的令牌>/mcp`，只写这个账号自己的工作区），工具 `image_generate`：

- **参数**：`prompt`；`path`（工作区里的 `.png`，一般放本任务目录，不填存进 `workspace/images/`）；要修改或参照的图放 `reference_paths`（工作区图片，最多 5 张，SVG 不行）；可选 `transparent_background`、`size`（auto / 1024x1024 / 1536x1024 / 1024x1536）、`quality`。
- **怎么画**：控制面用自己的 ChatGPT 登录（`codex-login` 那个，见部署说明）调 ChatGPT 的出图接口，请求和 Codex 内置 imagegen 的一样（`gpt-image-2`，`PA_CHATGPT_CODEX_URL` 下的 `/images/generations`，有参考图时 `/images/edits`），拿回 PNG 后写进该账号沙箱的工作区。登录只在宿主侧使用，不进任何沙箱；成员的 Codex 走成员网关，Codex 不会给它内置的 imagegen，所以用这个工具代替。
- **只在有 ChatGPT 登录时提供**（`PA_HOST_CODEX=on`）；出图用的是 owner 的 ChatGPT 套餐额度，所有账号共用，不设调用限额。
- 执行会话被告知生成后在回复里用 `![说明](路径)` 显示；示意图、流程图、图表这类线条图仍建议直接写 svg 代码块。

## 手机通知（Web Push）

在 iPhone 的 Safari 里把一站「添加到主屏幕」（iOS 16.4+），从主屏幕打开后，侧栏点「开启手机通知」并允许即可；Android、桌面浏览器同样可用。每个账号、每台设备各自订阅。

- **什么时候提醒**：任务完成、没有完成或结果待核对，任务需要你补充，有操作等你确认，智能体请你接管浏览器（定时任务的运行结果也在其中）。同一任务的后续消息替换前一条。控制台正在屏幕上（前台心跳 45 秒内）时不推送，它自己就看得到。
- **怎么送达**：标准 Web Push：控制面用本部署的 VAPID 密钥签名（首次启动生成在 `var/vapid.json`，权限 600），内容端到端加密后交给苹果（或 Google、Mozilla、微软）的推送服务，推送服务看不到内容。服务端只向这些已知推送服务的 https 地址发送，订阅无法把它指向别处；推送服务回 404/410 的订阅自动删除。
- **service worker**（`/sw.js`）只显示通知、点按打开一站，不拦截请求、不做缓存，不影响页面加载。

## 会话文件卡片与文档工具

对话里智能体提到的**工作区文件**（Markdown 文件链接、上传附件）会直接
渲染成文件卡片，不必再手动进工作区找。

- **图文混排**：用 Markdown 图片语法 `![说明](绝对路径)` 引用的工作区图片（png/jpg/webp/gif/svg 等）、视频和音频，按所在位置嵌在消息正文里（不再重复成卡片）：图片经鉴权的 `/api/documents/image` 取回、确认是图片类型后显示，点开看大图；视频和音频用原生播放器内联播放。`![说明](https://…)` 的网上图片也内嵌显示：控制台的 CSP 只放行同源图片，所以由这个账号自己的沙箱取回（`/api/documents/web-image`，只限 https、6 MB 以内、只回位图字节，结果缓存一天），浏览器从不直连图片站点；只写 `http://` 的图片不显示。路径在客户端复核、服务端再校验，Markdown 的安全过滤规则不变。执行会话的提示词里写明了这个格式，并要求图片放在相关文字旁边。
- **商品卡片**：消息里的 ```` ```products ```` 代码块（JSON 数组，最多 8 件：`name`、`image`、`price`、`was` 原价、`store`、`url`、`rating`、`badge`、`points` 2-4 条理由、`note`）显示为一组商品卡片：左边商品图（工作区图片或 https 图片，取不到时显示占位图标，不显示破图），右边价格（原价划线）、商店与评分、理由和「去看看」（在沙箱浏览器里打开商品页，只接受 https）。手机上一行一张，桌面一行两张；解析不了的块照常显示为代码。执行会话被要求：推荐或比较具体商品（也包括酒店、餐厅这类可比较、可购买或预订的条目）时用商品卡片代替宽表格，每张卡片都要有真实商品图，用 aio_tabs 新增的 `browser_save_image` 存进任务目录再引用，不手抄图片网址（模型抄长网址常删掉版本、签名参数，图片直接 404）：商品页上只给 path 就自动存这页的主图（页面声明的 og:image，没有就取最大的图片）；列表页上 selector 指向的元素是图片或含有图片时下载它的原图（不截屏：人用的浏览器开着页面缩放，Chromium 按元素截图会错位），没有图片才截取元素；也可以直接给主图地址。下载都以这个标签页的身份（Cookie、Referer，绕过防盗链）进行，存进任务目录再引用；只能存进工作区、只收 jpg/png/webp 位图、8 MB 以内。回答整体按手机阅读来写：先结论、图文穿插，少用宽表格。
- **地图卡片**：消息里的 ```` ```map ```` 代码块（JSON：`name`、`address`、`lat`/`lng`，取自高德/腾讯的坐标加 `"coord": "gcj02"`）显示为小地图卡片。没有坐标时按地址由控制面定位（OpenStreetMap Nominatim，排队、每秒至多一次、结果缓存）。定位不到的地点不画地图，只显示名称、地址和按钮。点卡片在地图应用里**查看这个地点**（不直接开始导航，要导航在地图应用里点路线）：网页看不到手机装了哪些应用、也没有呼起系统导航选择器的接口，所以 Android 默认用 `geo:` 让系统列出装了的地图应用（系统自带「始终」）；iPhone 和电脑第一次点时弹出应用列表（苹果地图、高德、百度、Google 地图、Waze，可缩放的大地图在上方），选过一次就记在这台设备的浏览器里（`localStorage`），之后点卡片直接用它打开，卡片上的「换」可重新选。未安装的应用会打开网页版或没反应。这些链接由用户点按、在手机上打开，不经沙箱浏览器。地图瓦片经登录后的 `/api/map/tiles/…` 由控制面代取 OpenStreetMap 并缓存（CSP 只放行同源图片，也不让瓦片服务看到是谁在看）。JSON 解析不了的块照常显示为代码。执行会话的提示词里写明了格式，并要求坐标只用查到的数值、查不到就只给地址。
- **SVG 图**：消息里的 ```` ```svg ```` 代码块（完整的 `<svg>` 文档，最多 100 万字符）和工作区里的 `.svg` 文件都显示为图片；点图或「看大图」全屏查看（点图放大到 2 倍、可拖动），「下载」存成白底 PNG（长边约 2000 像素，文件名取 SVG 的 `<title>`；浏览器拒绝导出时改存原 SVG），画不出来的 SVG 才显示源码；不是 SVG 的块照常显示为代码。SVG 只在 `<img>` 里绘制（脚本不运行、不加载外部资源），`/api/documents/image` 返回 SVG 时另加 `sandbox` CSP，单独打开也不会执行，服务端还会核对 `.svg` 文件内容确实是 SVG。没有固定宽度的图（只有 `viewBox` 或百分比宽度，智能体画的图多是这样）按消息宽度、原比例显示；写了固定宽度的保持原尺寸，不超过消息宽度。
- **分享卡片**：消息里链接到分享页（`/u/<用户名>/share/<页面名>/` 或 `share?<页面名>`）时，下方显示分享卡片：完整地址（可整段选中）、「复制链接」、系统分享（设备支持时）和「打开」（在你自己的浏览器里打开公开页面，不经沙箱浏览器）。代码里的地址不算。
- **视频播放**：消息里链接到 YouTube（`youtube.com/watch`、`youtu.be`、Shorts、直播）或 B 站（`bilibili.com/video/BV…`、`av…`，带 `p=` 分 P）的单个视频时，下方直接嵌入播放器（16:9，最多 4 个，按链接里的 `t=` 从该时间开始）。播放器地址只由识别出的视频 ID 重新拼成（YouTube 用隐私增强的 `youtube-nocookie.com`），框在不许弹窗、不许跳转本页的 sandbox iframe 里，滚动到附近才加载；主站 CSP 的 `frame-src` 只为此放行 `www.youtube-nocookie.com`、`player.bilibili.com` 与其手机版重定向到的 `www.bilibili.com`。播放时视频直接从 YouTube / B 站加载到你的设备（不经沙箱浏览器）。链接本身照旧在沙箱浏览器里打开；代码里的地址、播放列表、频道页和 `b23.tv` 短链不嵌入。

- **图片**：卡片带懒加载缩略图，点开看大图。
- **视频与音频**：视频支持 mp4/m4v/mov/webm，音频支持 mp3/m4a/aac/wav/ogg/opus/flac。会话卡片、附件与工作区文件共用原生播放器，支持播放/暂停、进度拖动和手机内联播放；音频卡片直接带播放条（按下播放才加载），点开预览也能播。都经鉴权的 `/api/documents/media` 按字节范围流式加载，不把整个文件放进内存；服务端按文件头核对格式与扩展名一致（改了扩展名的文件不会当音视频播放）。编码不受当前浏览器支持时可重试或下载原文件（例如部分浏览器不放 flac/ogg）。
- **PDF / Word / Excel / PowerPoint**：在沙箱内转换成分页 raster 图片预览（页码、翻页、
  截断提示），**原文件仍可下载**。
- **Markdown**：默认排版阅读，支持标题、列表、表格、引用和链接，可切换原文；卡片优先展示链接中的文档标题。
- **其他文本／代码**：以转义后的纯文本展示（有大小上限），HTML 不作为网页执行（SVG 按图片显示，见上）。
- **其他格式**：明确说明「可下载」，不会假装能预览。
- 预览失败、转换失败、文件已删除都会给出可恢复的提示与重试，不显示成功空白。

工作区里的「文件」标签页统一承担目录导航、上传、新建、预览、下载、文本编辑与删除；对可转换格式的文件行还提供
「转换」入口（紧凑面板，可取消/执行，结果可预览下载），工具就绪状态收在底部默认折叠的「文档处理」里。
「终端」页显示 AIO 当前存活的 Shell session ID、运行/空闲状态和工作目录，可复制 ID；仅在页面可见时每 5 秒刷新，切换页面即停止读取，不创建或终止任何 session。命令已完成但仍存活的 session 标为“空闲”，列表读取失败会明确提示。
智能体侧可以在沙箱内**创建、修改、转换**文档（Word/Excel/PPT 用 Python 库，
格式转换与 PDF 用 LibreOffice），例如「把这个 Word 转成 PDF」「新建一个 Excel 并算总和」。

支持的转换目标：`pdf`、`docx`、`xlsx`、`pptx`、`csv`、`txt`、`odt`、`ods`、`odp`、`html`。

> **文档工具需要沙箱内系统依赖**（LibreOffice、poppler-utils、中文字体、Python 文档库），
> 不是 `npm ci` 带来的。每个账号的沙箱都自带：容器启动后控制面在后台自动安装缺失的部分（新环境约一两分钟），
> 并把文档 skill 写给 Codex 与 Claude Code 两个执行器。安装失败时 UI 如实显示未就绪，owner 可点「安装/修复」重试，
> 不会让聊天服务无法启动。细节见[运行手册](docs/RUNBOOK.md)。

所有解析与转换都发生在沙箱容器内，控制面只以固定 argv 调用固定容器命令；路径先经工作区范围
校验（拒绝越界、symlink 逃逸、选项注入），图片/文本与音视频预览均需鉴权；音视频还按扩展名验证文件头并保留 Range/206/416 语义，
下载主动内容一律 `attachment`。转换结果写成**新文件**，绝不覆盖原文件。

## Jev 决策（所有账号共用，无需各自配置 key）

Jev（TypeSafe System One）给定状态和若干选项，返回选择、每个选项的概率和置信度。控制面从
`PA_JEV_SECRETS_FILE`（默认 `~/.config/aio-agent/jev.env`，权限须 600/400；环境变量 `TYPESAFE_API_KEY` 优先）读取 key，
key 只留在宿主进程。它有两个用途：

- **派单第二意见**：见上文“主会话时序 / Jev 第二意见”。
- **执行会话的 `decide` 工具**：每个账号的执行会话（Codex 线程级 MCP、Claude Code `--mcp-config`）都会注册 MCP 服务 `aio_decision`，
  地址是成员模型网关上的 `/decision/<该运行时的令牌>/mcp`（和 `aio_schedule`、`aio_kb` 一样写进沙箱 Codex 的受管策略 `/etc/codex/requirements.toml`，否则 Codex 会停用这个线程级服务）；工具参数为 `question`、`options`（id → 含义，2–20 个）、可选 `context` 和 `rules`。
  沙箱只拿到这个地址，拿不到 Jev key；每次调用的账号、问题、选项数、选择、置信度、耗时和用量记入宿主库 `decision_events`。不设调用限额。
  没有 key 时这个工具和派单第二意见都不出现。

## 知识库（可选，按账号授权）

owner 可以把宿主机上的一个知识库 MCP 服务（streamable HTTP）接给执行会话。设置 `PA_KB_MCP_URL` 后：

- **谁能用**：owner，以及 `PA_KB_MCP_MEMBERS` 列出的成员用户名。其余账号的会话里没有这个服务，也拿不到可用的地址。
  名单在服务重启时生效；移出名单的账号，原地址随之失效（403）。
- **怎么接**：获准账号的执行会话（Codex 线程级 MCP、Claude Code `--mcp-config`）注册 MCP 服务 `aio_kb`，
  地址是成员模型网关上的 `/kb/<该运行时的令牌>/mcp`。网关把请求转给上游，附上 `Authorization: Bearer <令牌>`
  和 `X-Aio-User: <用户名>`（供上游记审计）。上游令牌从 `PA_KB_MCP_SECRETS_FILE`（权限须 600/400；环境变量
  `KB_MCP_TOKEN` 优先）读取，只留在宿主进程；没有令牌时这个功能不出现。
- **隔离**：成员沙箱只能访问宿主机的网关端口，上游服务应只监听 loopback 并校验令牌。Codex 的受管策略只为
  获准的运行时放行这一条精确地址。上游拒绝网关令牌或不可达时，工具调用得到 502，任务的其余部分不受影响。
- 这是把宿主侧资料交给沙箱的通道，给什么内容完全由上游服务决定：上游应当只读，且只提供允许这些账号看到的内容。
  网关不缓存、不落库任何知识库内容。现有部署的上游（aio-kb 的 `kb-mcp`）除整理过的页面外，还用 `kb_source`
  提供页面所引用原件的文字（owner 决定 owner 与 `cr` 都可读，口径见 workspace `docs/aio-kb-contract.md`）；
  执行会话的提示里要求只在需要时读原文，个人信息只引用回答需要的部分。

## 分享网页（公开）

沙箱内置 `aio-share` skill（Codex 与 Claude Code 都能用）：智能体把页面目录
（`/home/gem/workspace/share/<页面名>/`，入口 `index.html`，可带相对路径的图片/CSS/JS）
用 `python3 /home/gem/.codex/tools/aio-share/aio-share.py publish <目录>` 发布，得到
`https://<工作区域名>/u/<用户名>/share/<页面名>/`，任何拿到链接的人都能打开；短地址
`/u/<用户名>/share?<页面名>` 会跳转到它。只有公开页面，没有密码或私密模式。

- **发布**走成员模型网关（`PA_MEMBER_MODEL_PORT`）的 `/share/<账号>/pages[/<页面名>]`，只认该运行时自己的分享令牌
  （宿主 `<数据目录>/share-token`，沙箱内 `~/.codex/tools/aio-share/config.json`，0600）。同名再次发布即整体替换，
  链接不变；另有 `list` / `delete`。
- **快照存在宿主** `<PA_DATA_DIR>/shares/<账号>/<页面名>/`，访问时只读这份快照、从不触碰沙箱，所以公开流量不会给沙箱加负载，
  沙箱停了页面也照常可看。每页上限 200 个文件、20 MB，每个账号 100 页；路径拒绝 `..`、隐藏文件、反斜杠与控制字符。
- **隔离**：页面放在工作区来源而不是主站（AI 生成内容不上主站），每个响应都带
  `Content-Security-Policy: sandbox allow-scripts …`（无 `allow-same-origin`），页面运行在不透明来源里，
  读不到工作区会话、调不了工作区接口，也用不了 cookie / localStorage。另带 `nosniff`、`no-referrer`、`noindex`，不设置任何 cookie。

## 浏览器内存生命周期（空闲释放与按需恢复）

> **owner 常驻，成员空闲释放**：每个账号只有一个浏览器。owner 的默认一直运行，登录状态（包括只在本次运行有效的会话 cookie）
> 始终留在同一个 Chromium 进程里，不再依赖快照导出/导入来接续。以前每空闲 5 分钟就停掉 Chromium 再从快照恢复，
> 恢复失败时网站会变成未登录。浏览器若因升级或崩溃处于已释放状态，后台巡检会自动恢复一次，之后保持常驻。
> 状态条显示“常驻，登录状态一直保留”，不再有“保留浏览器”按钮。需要恢复空闲释放以节省内存时设
> `PA_BROWSER_RELEASE_IDLE=1`，下面的释放规则才生效。成员浏览器默认按下面的规则空闲释放（`PA_MEMBER_BROWSER_RELEASE_IDLE=1`，设 `0` 回到常驻）：成员不常用浏览器，一个常驻的 Chromium 约占 500 MB；实测（Chromium 154）快照加释放约 20 秒、释放后容器少约 370 MB，下次使用时冷启动约 17 秒，cookie（含会话 cookie）全部恢复。智能体被要求只用这一个浏览器，不得另起浏览器或清除站点数据。
>
> **浏览器身份一致（少被网站拦截）**：镜像默认让 Linux 上的 Chromium 冒充 Mac 的 UA（页面读到的平台与 UA、客户端提示互相矛盾）、时区写死新加坡、关闭 GPU（没有 WebGL），这些都是反爬系统（如 eBay 的 Akamai）判定机器人的强信号。控制面在每次沙箱就绪时对齐：保留 Chromium 自己的 Linux UA，时区用 `PA_BROWSER_TIMEZONE`（默认 `America/Los_Angeles`，应与出口网络所在地一致），通过 SwiftShader 启用 WebGL；有改动时优雅重启一次浏览器。

> **较新的 Chromium**：镜像自带的 Chromium 146 在 TLS 握手阶段就被 eBay 拒绝（第一个请求 403，与页面指纹无关）。沙箱就绪时，控制面把 xtradeb PPA 为 Ubuntu 22.04 arm64 打包的 Chromium 154（`chromium` + `chromium-common`，外加镜像缺的 Ubuntu 官方 `libopenh264-6`、`libxnvctrl0`）解包到 `/opt/aio-browser/chromium-<校验和前缀>/`，每个包都必须与固定的 SHA-256 一致，只解包、不安装进系统，已存在时立即跳过；然后把镜像浏览器守护进程的可执行文件指向它（`LD_LIBRARY_PATH` 指向随包的库），优雅重启一次。旧版本目录要等没有进程在用时才删除（删掉运行中浏览器的文件会让它卡死）。仅在 `PA_BROWSER_BUILD_ARCH`（默认 `aarch64`）上启用；其他架构、下载或校验失败时保留镜像浏览器。`PA_BROWSER_BUILD_PACKAGES`（逗号分隔的 `url#sha256`）可换包，`PA_BROWSER_BUILD=off` 回到镜像浏览器。
> 为什么不用 Chrome for Testing：Google 没有 arm64 的正式版 Chrome，而 Cloudflare 会让 Chrome for Testing 的验证一直卡在「Verifying…」。实测还有三处会触发拦截，已在对齐时处理：`--use-angle=swiftshader` 和 `--disable-site-isolation-trials` 都会让 Cloudflare 验证卡住（因此去掉，WebGL 交给 ANGLE 自选，走 Mesa llvmpipe 软件渲染）；正式版 Chrome 在 Linux 上会多发一个 TLS 扩展（`AddTLSServerHandshakePadding`，扩展号 4832），缺了它 eBay 就拒绝握手，因此默认加上 `--enable-features=AddTLSServerHandshakePadding`。Cloudflare 的验证在 2 核的沙箱里可能要二三十秒才自动通过。
> 新版 Chromium 会升级浏览器 profile，旧版随后无法打开它。第一次换用其他可执行文件前，profile（去掉缓存）会备份到持久卷的 `~/.codex/aio-browser/profile-before-browser-change.tgz`（0600）；回退到旧版时先停浏览器，再用这份备份替换 `/home/gem/.config/browser`。换浏览器版本后，LinkedIn 等把会话绑定设备的网站会在下次访问时要求重新登录。

> **镜像自带的浏览器客户端不常驻**：python-server 的浏览器接口与 `mcp-server-browser` 第一次被用到（包括下面的恢复流程）就用未修补的 Playwright / Puppeteer 连上浏览器且不再断开，期间网站会把每个页面都判为自动化，python-server 还会把主线程的 `navigator.languages` 固定为 `en-US`，与 Worker 不一致。巡检在没有任务在跑、浏览器也不在唤醒或恢复时断开它们（下次使用时自动重连）；python-server 同时承载终端，只在它没有任何连接（终端的 WebSocket 不出现在会话列表里）且没有正在执行的 shell 命令时重启。

恢复会同时重建 AIO REST 与浏览器 MCP 的连接。镜像中的 MCP 会缓存旧 Puppeteer 页面，因此在恢复完成前精确重启 `mcp-server-browser`，并通过 Codex 使用的 `/mcp` 调用 `browser_tab_list` 验证页面连接；失败保留快照和恢复进度，不误报可用，不自动重放导航、点击等用户操作。该服务使用无状态 HTTP，重连不停止 Codex、终端或其他服务。

沙箱里的 Chromium 常驻会占住几百 MB 渲染内存，即使没人在看。这条功能让**只有浏览器**在
无人使用时被真正释放，下一次需要时再从快照重建；容器、Codex、终端、code-server、Jupyter
**都不会**被停掉。

- **谁算「在用」**：正在执行的智能体任务（整轮保护，不区分是否用到浏览器）、可见工作区面板里
  正在观看的人、进行中的浏览器/CDP/VNC 请求与 WebSocket 连接、以及用户手动「保留浏览器」。
- **默认空闲 5 分钟**释放（`PA_BROWSER_IDLE_SECONDS`，下限 30 秒）；面板心跳 TTL 60 秒
  （`PA_BROWSER_VIEWER_TTL_SECONDS`）。总开关 `PA_BROWSER_LIFECYCLE=1`（默认开）。
- **状态**：工作区浏览器/桌面面板顶部的中文状态条显示当前状态、占用原因、观看数量、空闲倒计时、
  已释放/正在恢复，并给出重试与「保留浏览器」入口。`/api/browser/status` 是**只读**轮询，
  永不唤醒、也不续期空闲倒计时。重新打开浏览器/桌面面板时自动按需恢复，失败时才显示重试。
- **观看租约**：仅当面板可见**且**页面 `document` 可见时持有；隐藏、关闭、切换标签或窗口转入
  后台会立即卸载 iframe/流并释放，不等 TTL。多窗口各自独立，断网/崩溃自动过期，注销会清理。

**快照与恢复的边界（诚实说明）**：

- 保存：标签顺序、当前 URL、选中页、滚动位置、`sessionStorage`，以及 cookies 和当前标签所属站点的 localStorage/IndexedDB，写入同一份 0600 原子快照。不会仅依赖 profile 自然保留存储。
- 同网址的多个标签通过临时内存标识核对真实身份，分别保存各自状态；核对后清除标识并恢复原选中页。核对期间标签变化或无法恢复焦点时保留浏览器，状态条显示具体原因。
- 恢复：**重新创建页面**并导航回 URL，不保留 JS 堆；先注入只对匹配 origin 生效的
  `sessionStorage` 初始化脚本再导航；站点持久存储在应用启动前导入。先连接 AIO 再按序建页，核对标签顺序后激活原选中页。
- **保守拒绝**：无法安全保存的页面（`chrome://` 等不支持、有未提交输入、正在下载）会**阻止**
  这次释放并给出原因，而**不是**静默丢状态；快照失败**绝不**停止浏览器。
- 恢复失败保留快照并如实报错，可重试；不会假报成功，也不会重复创建已恢复的标签。恢复按真实标签身份同步 AIO 焦点；AIO 重连后的内部编号变化不作为恢复失败，保留浏览器自行恢复或用户额外打开的同网址标签；只有内容、顺序和焦点均确认后才标记完成。
- 不删除用户 profile；不承诺保存 JS 堆、未落盘的编辑器状态或未打开站点的全部数据库。后台脚本或依赖内存状态的页面请使用「保留浏览器」。
- 存储工具与标签页服务使用锁定的 `patchright-core@1.63.0`（Playwright 同版本 API，但不调用 `Runtime.enable`），离线构建并安装到 root 管理的 `/opt/aio-browser`，不下载浏览器；快照独立保存在持久卷。
  换用它是因为标签页服务常驻连接浏览器：用 playwright-core 时，它会给浏览器里的**每个**页面留下 CDP 自动化痕迹（`isAutomatedWithCDP`），网站据此把整台浏览器判为机器人。

> 控制面从不让浏览器为「读状态」而保持运行，也不会把「进程归属未知」当成「浏览器不存在」
> （那会错误地另起一个 Chromium）：无法确认归属时按保守策略处理并如实显示。

## 整个容器空闲休眠（成员默认开启）

浏览器之外，成员的**整个沙箱容器**在没人用时也会停掉（`PA_MEMBER_SANDBOX_RELEASE_IDLE=1`；owner 默认常驻，`PA_SANDBOX_RELEASE_IDLE=0`），下次用到时再启动。

- **两个信号都静默满 5 分钟才停**（`PA_SANDBOX_IDLE_SECONDS`，下限 60 秒）：
  - 沙箱在用：执行中/排队的轮次、派单中或待执行的任务、待批准请求、浏览器租约、进行中的工作区代理请求、在工作区标签页里打字；
  - 控制台在前台：页面可见时每 20 秒发一次心跳，有效 60 秒。
- **停的顺序**：
  1. 看容器里有没有仍在运行的 shell 命令，再测 10 秒平均 CPU（不含 Chromium 自己的渲染，含已退出子进程的用时）：有命令在跑、CPU ≥ 5%（构建、笔记本计算等）或读不到，都算在用、重新计时；
  2. 给浏览器做快照并释放（登录保留），快照失败就不停。唯一例外：浏览器还有一份没恢复的快照（容器起来后还没人用过浏览器），那份快照就是真实状态，直接停；
  3. 这期间有人回来也不停。最后 `docker stop` 容器，卷都保留。
- **唤醒**：控制台回到前台就立刻开始预热；派单、执行任务、打开文件/文档/浏览器、加载工作区页面也会先等容器启动（约半分钟）。隐藏标签页里编辑器的自动重连和后台轮询**不会**唤醒，否则每次停完马上又被叫醒；工作区单独标签页里刷新一下即可唤醒。
- 休眠期间后台巡检不会把容器拉起，服务重启也不会：停着的容器按休眠接管，定时任务等后台工作照常，用到时才启动。控制台不提示休眠、唤醒或启动中：页面一显示就开始唤醒，没起来之前发的消息照常保留，等待算在这次请求的耗时里；只有启动失败才显示「智能体暂未就绪」。

## 可选：OpenCode Go 桥模型（DeepSeek / MiMo）

统一配置页的模型选择器默认只有 ChatGPT 账号的模型。若本机已装并运行
`tools/codex-opencode-go`（本地 LiteLLM 的 Responses 桥，监听 `127.0.0.1:4017`，
上游 `https://opencode.ai/zen/go/v1`），控制面会把桥上的每个模型都列进选择器
（默认 `deepseek-v4.1-flash` 与 `mimo-v2.6-pro`），可以和 ChatGPT 模型自由切换：

- **自动启用**：`PA_OPENCODE_GO_ENABLED=auto`（默认）只在能取到密钥时才列出这些模型；
  取不到就完全不出现，ChatGPT 路径与今天完全一致。`on` 会要求启用（取不到密钥会打警告）
  并保持关闭，`off` 显式关闭。
- **模型清单**：`PA_OPENCODE_GO_MODELS`（逗号分隔，默认两个模型）。旧变量
  `PA_OPENCODE_GO_MODEL` 仍可用，设置它等价于只列出那一个模型（优先级更高），
  既有单模型部署行为不变。
- **每个模型的思考强度**：DeepSeek 支持 `low`/`high`/`max`，MiMo 上游拒绝 `max`
  （HTTP 400），只提供 `low`/`high`；两者默认都是 `high`。选择器只列出各模型
  真实可用的档位，所以不会存下一个每次执行都失败的组合。
- **密钥**：优先读进程环境变量 `LITELLM_MASTER_KEY`，否则读私有文件
  `~/.config/codex-opencode-go/secrets.env`（逐行 `KEY=VALUE`，**不执行**）。
  文件权限宽于 `600`/`400` 时**拒绝使用**并给出可读日志。密钥不写日志、数据库、argv
  或前端；传给 `docker exec` 时 argv 只出现变量名（`-e LITELLM_MASTER_KEY`），值走子进程环境。
- **沙箱可达性**：容器内用 `http://host.docker.internal:4017/v1` 访问宿主桥，
  不是 `127.0.0.1`。provider 用 `-c` 覆盖在命令行注入，不改动容器内 `config.toml`，
  也不动固定镜像与既有隔离参数。
- **切换语义**：Codex 只在创建线程时才认 `modelProvider`（`thread/resume` 传它不生效），
  所以同一个会话换模型若跨了 provider，控制面会用 `thread/fork` 续在新 provider 上并保留
  历史；provider 不变时仍走普通 resume。ChatGPT 会话的启动/恢复/派生一如既往**不发送**
  `modelProvider`。
- **仅支持文本**：两个桥模型的 `inputModalities` 都只有 `text`，带图片的提交会在提交阶段
  就被拒绝（HTTP 400 `input_unsupported`，中文提示），不会等远端报错。
- **已知边界**：密钥在沙箱内对进程可见（Codex 需要读取它）——这是该桥的固有代价，
  与本项目「不桥接宿主机能力」的既有边界不冲突，但请自行评估；桥不可用时该模型只是不出现，
  不会影响控制面启动。

配置项见 [`.env.example`](.env.example) 的 `PA_OPENCODE_GO_*`。

## 可选：Claude Code 执行器

统一配置页默认只有 Codex 一个执行器。配置了 Claude Code 凭据后，页面会多出「执行器」选项
（Codex / Claude Code），模型列表按执行器过滤（Claude Code 提供 `claude-opus-5-5`、
`claude-sonnet-5-5`、`claude-fable-5-1`，思考强度 low～max，留空按 CLI 默认）：

- **选中即全部切换**：主会话派单和子任务执行都由 Claude Code 完成。派单使用
  无工具、不落盘的一次性运行（`--tools ""`，模型 `PA_CLAUDE_CODE_AUX_MODEL`，默认
  `claude-sonnet-5-5`）。成员账号默认不提供该执行器；被分配 `claude-sonnet-5-5` 的成员经成员模型网关使用它（见账号分级）。
- **执行方式**：每个任务轮次在沙箱内启动一个 `claude -p` 进程（stream-json 双向流），以
  `bypassPermissions` 在容器内完整执行（与 Codex 的 `approval_policy=never` 对等），MCP 只挂
  沙箱内的 `aio_browser`（`--strict-mcp-config`），SOUL.md 通过 `--append-system-prompt` 注入，
  工作区 `AGENTS.md` 通过配置目录里的 `CLAUDE.md` 导入。事件被翻译成与 Codex 相同的时间线
  条目（命令、文件修改、MCP、网页检索、回复流），任务结果、停止、重连沿用同一套机制。
- **会话连续**：控制面预先指定会话 UUID，首轮 `--session-id`、之后 `--resume`（以沙箱内会话文件
  是否存在为准，重启后判断不变）。运行中补充写入同一进程，收到 CLI 回显才算送达；停止通过
  控制通道 `interrupt`，15 秒未停再结束进程。进程无结果退出的轮次标记 `unknown`，只影响该轮。
- **切换执行器**：Codex 线程与 Claude Code 会话不能互相派生。已有任务在另一个执行器上续接时，
  会新开会话，并把此前的提问与最终回复（上限约 24k 字符）作为背景带入，不会退回原执行器。
- **固定版本**：CLI 版本固定为 `PA_CLAUDE_CODE_VERSION`（默认 `2.1.284`），首次使用时安装到持久卷，
  关闭自动升级；版本不符时重新安装并校验，失败如实报错。
- **凭据**：`CLAUDE_CODE_OAUTH_TOKEN`（宿主上 `claude setup-token` 生成）或 `ANTHROPIC_API_KEY`，
  先读进程环境，再读 `PA_CLAUDE_CODE_SECRETS_FILE`（默认 `~/.config/aio-agent/claude-code.env`，
  权限宽于 600/400 拒绝）。只经 `docker exec -e <变量名>` 的子进程环境传入，argv 中只有变量名。
  与 Codex 桥模型一样，凭据在沙箱进程内可见（CLI 需要读取它）。
- **已知边界**：Claude Code 自身的子代理（Task）只以一条工具调用出现在时间线，内部过程不展开；
  CLI 的审批与交互式提问不接入（容器内全权限执行）。

## 本地开发与测试

```bash
npm ci                   # 按 lockfile 安装（与 Quickstart 一致）
npm run build            # 构建前端 + 服务端
npm test                 # 单元 + 集成测试（自带假沙箱，无需 Docker）
npm run typecheck
```

本机运行（不经过任何 tunnel，只用 loopback）：先按 Quickstart 起三个进程，或分别用
`npm run dev:sandbox` / `npm run dev:control`（tsx watch）/ `npm run dev:ui`（Vite 开发服务器，`/api` 代理到 :4892）。

```bash
curl -s http://127.0.0.1:4892/healthz
# 首次启动会生成 owner 密码到 var/owner-secret.txt（0600，git 忽略，从不写日志）
```

浏览器打开 `http://localhost:4891`（控制台，经界面层；本地开发中 `127.0.0.1:4892` 是伴随站，
两者是不同来源，跨站规则与线上一致）。

> 可选：本仓库最初用 workspace 根目录的统一 launcher 管理现有部署
> （`tools/start.sh start|restart|stop|status personal-agent`），它运行 `bin/serve`（三个宿主进程或 compose，
> 见运行手册）。它属于**现有部署的可选管理方式**，不是公开安装的必要步骤。

## 验收（分四层，各层职责不同）

```bash
npm test                 # 1) vitest 单元 + 集成（自带假沙箱，不需要 Docker/网络）
npm run smoke            # 2) HTTP + WebSocket 冒烟（默认本地 localhost:4891 + 127.0.0.1:4892）
npx playwright test      # 3) 真实浏览器 UI（默认本地 http://localhost:4891）
# 真实公网验收：显式指定两个 origin（缺省只跑本地）
PA_PRIMARY_ORIGIN=https://agent.example.com \
PA_COMPANION_ORIGIN=https://workspace.example.com npm run smoke

# 本地假后端 UI 验收：静态 dist/ui + 全部 /api 由 page.route mock，不会访问任何实例
npx playwright install chromium webkit # 首次准备浏览器运行时
npm run build && npx playwright test --config playwright.local.config.ts
```

| 层 | 覆盖 |
| --- | --- |
| `npm test` | 未登录绕过、会话过期/轮换/吊销与已建立连接被关闭、Host/Origin/CSRF 校验、重定向安全、代理 HTTP 与 WebSocket（对假沙箱）、事件回放与 delta 顺序、重复提交与跨会话冲突、停止语义、未知结果不重放、shell 支撑的文件操作只报真实结果、派单临时线程的隔离（超时后迟到事件不混入用户会话）、会话生命周期（空标题复用、重命名/恢复默认标题冲突 409、无删除接口）、沙箱浏览器标签 URL 校验、**浏览器生命周期**（状态机竞态/多观看者 TTL/任务租约单飞/快照失败不停止/恢复 single-flight/归属未知 fail-closed/状态轮询不唤醒、浏览器 API 鉴权+CSRF+注销清理、代理只保护 browser/CDP/VNC 且拒绝时释放租约） |
| `python3 tests/unit/browser-runtime.test.py` | 容器内受管 helper 的纯函数与安全边界：真实 flattened cmdline 归属、`unknown` 不等于 `absent`、快照 schema/原子 0600、精确 PID/starttime 校验后才停、按 origin 限定且在导航前注入 `sessionStorage`、AIO soft 重连与激活 index、错误脱敏 |
| `npm run smoke` | 真实 HTTPS 登录与 cookie 属性、模型列表、一次性票据（重放与开放重定向）、伴随站会话与跨源续期、经鉴权的 shell 调用、上传与列目录、跨源写入拒绝、原生界面可达、未登录时各表面一律 401、**真实 WebSocket 升级**（已登录 101 / 未登录 401） |
| `npx playwright test` | 登录界面（错误密码与正确密码）、对话页输入区不含任何模型/思考控件、统一配置页默认选中 GPT-6-Sol（桌面侧栏与手机底导航入口）、打开工作区后立刻切标签的竞态、连续切换最终落在最后点击的标签、真实文件列表与 code-server 可达、无横向溢出 |
| `npx playwright test --config playwright.local.config.ts` | 会话文件卡片与统一预览（图片缩略图/分页翻页/下载/失败重试/360px 无溢出）、工作区「文件」唯一入口/上传/目录导航/转换/迟到结果不跳目录、本地假后端（默认 `dist/ui`，可用 `PA_TEST_WEB_ROOT` 指向 scratch 构建 + 全部 `/api` 由 `page.route` mock）：会话 `⋯` 菜单/重命名/归档/恢复且无删除、失败重命名保留输入、运行态与 `prefers-reduced-motion`、Markdown 链接只进沙箱浏览器（`mailto:`/相对链接保持不可导航）、归档行标题不可点、统一配置页保存/刷新持久化/跨会话生效/失败反馈/无模型列表时禁用保存/返回会话保留草稿、活动段混排（文本/活动多段次序、当前条唯一且置底、段独立展开且增量不重置、迟到日志回原段、空占位不切段、状态行在活动段之上）、默认收起/点击与键盘展开收起/终态停动画/审批露出/长历史展开自然高度（段自身不滚动）与行可达（桌面 1440×900，手机 390/360 含 WebKit，短视口与暗亮无溢出） |
| 人工/父端验收 | VNC 桌面帧流、浏览器 CDP 帧流、手机 390/360 实际交互与截图 |

`npm run smoke` 会读取 `var/owner-secret.txt`（或用 `PA_OWNER_SECRET_FILE` 指定）。

## 配置

所有参数通过 `PA_*` 环境变量提供，见 [`.env.example`](.env.example)；生产覆盖写入
`var/runtime.env`（git 忽略）。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_PORT` / `PA_BIND` | `4892` / `127.0.0.1` | 控制面监听地址 |
| `PA_UI_PORT` | `4891` | 界面层所在端口（本机开发时允许 `localhost:<端口>` 作为控制台来源） |
| `PA_SANDBOX_NODES` | `local=http://127.0.0.1:4894` | 控制面驱动的沙箱节点（`名字=地址`，逗号分隔；第一个承载已有账号，新账号放到剩余内存最多的节点） |
| `PA_SANDBOX_NODE_TOKENS_FILE` | `var/sandbox-node.env` | 节点令牌：先按节点名取，取不到用 `AIO_SANDBOX_NODE_TOKEN` |
| `PA_HOST_CODEX` | `on` | `off` 表示本机没有 Codex 登录（控制面容器）：owner 用 Claude Code 或桥模型，不提供 ChatGPT 模型 |
| `PA_OPENCODE_GO_UPSTREAM_URL` | 桥地址里的 `host.docker.internal` 换成 `127.0.0.1` | 控制面自己访问桥的地址（成员网关转发用）；在容器里设为 `http://host.docker.internal:4017/v1` |
| `PA_SANDBOXD_PORT` / `PA_SANDBOXD_BIND` / `PA_SANDBOXD_TOKEN_FILE` | `4894` / `127.0.0.1` / 无 | sandboxd 监听地址与节点令牌文件（键 `AIO_SANDBOX_NODE_TOKEN`） |
| `PA_SANDBOXD_IMAGES` | `ghcr.io/agent-infra/sandbox:1.11.0` | sandboxd 允许的沙箱镜像，其他一律拒绝 |
| `PA_SANDBOXD_CONTAINER_HOST` | `127.0.0.1` | sandboxd 访问沙箱发布端口的地址；在 Docker Desktop 容器里是 `host.docker.internal` |
| `PA_SANDBOXD_GATEWAY_UPSTREAM` | 空 | 控制面在别的机器时，sandboxd 把沙箱回连的网关请求中继过去（配 `PA_SANDBOXD_GATEWAY_BIND/PORT`） |
| `AIO_UI_PORT` / `AIO_CONTROL_URL` / `AIO_WORKSPACE_ORIGIN` | `4891` / `http://127.0.0.1:4892` / 空 | 界面层 edge 的监听端口、控制面地址、允许嵌入的工作区来源（CSP） |
| `PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST` | 源码默认 `agent.clawpage.ai` / `agent-workspace.clawpage.ai`（当前部署） | **生产使用者必须覆盖**为自己的两个精确域名；`.env.example` 用 `agent.example.com` / `workspace.example.com` 占位 |
| `PA_TRUST_CF_CONNECTING_IP` | `0` | 仅当请求确实经由自己可信的反向代理（会覆盖 `CF-Connecting-IP`）时才设为 `1`；否则限速可被伪造头绕过 |
| `PA_SANDBOX_IMAGE` | `ghcr.io/agent-infra/sandbox:1.11.0` | 固定镜像，升级需人工确认 |
| `PA_SANDBOX_CODEX_VERSION` | `0.160.0` | 沙箱内固定版 Codex CLI（在持久卷里，升级见运行手册） |
| `PA_DEFAULT_MODEL` | `gpt-6-sol` | 未在统一配置页另选时的默认模型；配置页的模型/思考强度保存于 owner `meta`，对之后所有消息生效，提交时按 turn 冻结 |
| `PA_TITLE_MODEL` | `gpt-6-luna` | Codex 执行器时主会话派单器的隔离临时线程（read-only、never、ephemeral）所用模型，派单固定 high；变量名沿用旧称 |
| `PA_MAX_CONCURRENT_TURNS` | `3` | 跨会话同时执行的主 turn 上限（取值 clamp 到 1–3）；同一会话始终串行，排队 FIFO |
| `PA_REASONING_SUMMARY` | `concise` | 主 turn 的思考摘要模式（`concise`/`auto`/`detailed`/`none`），不展示原始思维链 |
| `PA_OPENCODE_GO_ENABLED` | `auto` | 是否列出 OpenCode Go 桥模型；`auto` 仅在有密钥时出现，另有 `on`/`off` |
| `PA_OPENCODE_GO_BASE_URL` | `http://host.docker.internal:4017/v1` | 沙箱内可达的 LiteLLM Responses 桥地址 |
| `PA_OPENCODE_GO_MODELS` | `deepseek-v4.1-flash,mimo-v2.6-pro` | 桥模型 id 列表（逗号分隔），决定选择器里出现哪些桥模型 |
| `PA_OPENCODE_GO_MODEL`（兼容旧配置） | 空 | 设置则只列出这一个桥模型，优先级高于 `PA_OPENCODE_GO_MODELS` |
| `PA_OPENCODE_GO_PROVIDER_ID` | `opencode_go` | 注入 Codex 的 provider id（与 `~/.codex/opencode-go.config.toml` 保持一致） |
| `PA_OPENCODE_GO_SECRETS_FILE` / `PA_OPENCODE_GO_ENV_KEY` | `~/.config/codex-opencode-go/secrets.env` / `LITELLM_MASTER_KEY` | 密钥来源（环境变量优先，其次该文件；权限宽于 600/400 拒绝） |
| `PA_CLAUDE_CODE_ENABLED` | `auto` | 是否提供 Claude Code 执行器；`auto` 仅在取到凭据时出现，另有 `on`/`off` |
| `PA_CLAUDE_CODE_SECRETS_FILE` | `~/.config/aio-agent/claude-code.env` | `CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 的私有文件（环境变量优先；权限宽于 600/400 拒绝） |
| `PA_CLAUDE_CODE_VERSION` | `2.1.284` | 沙箱内固定版 Claude Code CLI（持久卷内，首次使用时安装） |
| `PA_CLAUDE_CODE_AUX_MODEL` | `claude-sonnet-5-5` | 选中 Claude Code 时派单使用的无工具模型 |
| `PA_JEV_SECRETS_FILE` | `~/.config/aio-agent/jev.env` | `TYPESAFE_API_KEY` 的私有文件（环境变量优先；权限宽于 600/400 拒绝）；缺省则不提供 Jev |
| `PA_JEV_ENDPOINT` / `PA_JEV_MODEL` | `https://api.typesafe.ai/v1/systemone` / `jev-latest` | Jev 接口与模型 |
| `PA_JEV_TIMEOUT_SECONDS` / `PA_JEV_DISPATCH_TIMEOUT_SECONDS` | `30` / `15` | `decide` 工具与派单第二意见各自的等待上限 |
| `PA_KB_MCP_URL` | 空 | 宿主机上知识库 MCP 服务的地址（如 `http://127.0.0.1:4797/mcp`）；为空则不提供知识库 |
| `PA_KB_MCP_SECRETS_FILE` | `~/.config/aio-agent/kb-mcp.env` | `KB_MCP_TOKEN` 的私有文件（环境变量优先；权限宽于 600/400 拒绝）；取不到则不提供知识库 |
| `PA_KB_MCP_MEMBERS` | 空 | 获准使用知识库的成员用户名，逗号分隔；owner 始终可用 |
| `PA_ANTHROPIC_API_BASE_URL` | `https://api.anthropic.com` | 成员模型网关转发 Claude 请求的上游 |
| `PA_CHATGPT_CODEX_URL` | `https://chatgpt.com/backend-api/codex` | 成员模型网关转发 `gpt-6.1-sol` 成员请求的上游（Codex 的 ChatGPT 后端） |
| `PA_SANDBOX_PORT` | `18081` | 沙箱发布到 loopback 的端口 |
| `PA_OWNER_PASSWORD` | 空 | 设置则用它，否则生成到 `var/owner-secret.txt` |
| `PA_BROWSER_LIFECYCLE` | `1` | 浏览器空闲释放总开关；关闭则浏览器始终常驻 |
| `PA_BROWSER_RELEASE_IDLE` | `0` | 是否在无占用时释放 owner 的浏览器；默认 `0` 常驻，登录状态一直保留 |
| `PA_MEMBER_BROWSER_RELEASE_IDLE` | `1` | 是否在无占用时释放成员的浏览器；默认 `1`，下次使用时从快照冷启动 |
| `PA_BROWSER_IDLE_SECONDS` | `300` | 开启空闲释放时，无占用后释放浏览器的空闲时长（下限 30 秒） |
| `PA_BROWSER_TIMEZONE` | `America/Los_Angeles` | 部署所在时区：沙箱浏览器、定时任务、智能体进程的时钟（`date`、"今天"）都用它；镜像自带的 `TZ=Asia/Singapore` 只对新建沙箱的容器环境改正，已有容器里人工开的终端仍是镜像时区 |
| `PA_DAILY_FEED` | `1` | 给每个账号内置每日 08:00 的推送（前一天有消息才运行）；设 `0` 不再创建 |
| `PA_SANDBOX_RELEASE_IDLE` | `0` | 是否在空闲时停掉 owner 的整个沙箱容器；默认 `0` 常驻 |
| `PA_MEMBER_SANDBOX_RELEASE_IDLE` | `1` | 是否在空闲时停掉成员的整个沙箱容器；下次使用时再启动 |
| `PA_SANDBOX_IDLE_SECONDS` | `300` | 沙箱不在用且控制台不在前台，持续多久后停容器（下限 60 秒） |
| `PA_BROWSER_VIEWER_TTL_SECONDS` | `60` | 观看心跳租约有效期（下限 10 秒）；到期即释放 |
| `PA_BROWSER_DIRTY_INPUT_POLICY` | `block` | 页面有未提交输入时 `block`（保守拒绝释放）/`warn` |

## 文档

- [部署](deploy/README.md)：三层镜像、Docker Compose、多机、版本兼容、数据卷
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

- 工具调用与思考摘要按“连续活动段”混排，而不是整轮聚到开头：一段可见内容（非空的助手
  正文块、审批卡）就是边界，边界之前的活动段就地留在原位置，边界之后立刻开启新的活动段。
  于是时间线读起来是 `文本1 — 执行了N项操作 — 文本2 — 执行了M项操作 — 最新文字 — 当前进行中`
  的 ChatGPT 式流，正在执行的那一条始终在该轮最新可见内容之后、也就是最后。每轮至多一条
  处于活动状态并有循环扫光；已结束的历史段不参与动画、不因为后续 delta 改变位置或展开
  状态。每个活动段有稳定 ID（`working:<turnId>:<seq>`），展开状态按段独立保存，增量事件
  不会重置；迟到的工具输出/完成事件按 `segmentOf` 归属写回它原本所在的段，既不重复新建也
  不会挪到末尾。桥模型在每次工具前发的空 `agentMessage` 采用惰性建块：只有首次真正出现非空正文（增量或完成事件）时才创建气泡，因此它既不产生空气泡、也不切段，更不会占住“当前进行中”的末位；重复或迟到的 `item/started` 对已有 id 是无副作用的空操作，不会重复建块、也不会把已结算正文改回 stream。
- 活动段头部如实反映状态（运行中、排队等待、已完成、执行出错、已停止、结果未知）：只有真正
  在执行的那段才有扫光；排队不冒充运行，完成/失败/停止后动画停止。已结束的历史段用中性
  灰点与陈述式文案（`执行了 N 项操作`，纯摘要段显示 `思考摘要`），不再重复计数、也不再叫
  “Working…”；工具真正失败时无论是否已结束都保留“工具出错”与错误提示。尚未产生工具或
  摘要的活动段展开后只给一句中性提示（如“正在处理…”），不伪造摘要；空的终态段不会以
  “执行了 0 项操作”留在历史里，但该轮结果仍以状态行如实呈现。用户消息、助手正文、审批、
  补充输入与错误提示始终独立显示，不藏进活动段；可见状态行（线程创建、提示、停止请求等）
  落在活动段之上，当前条保持在该轮最底部。段头可点击或键盘操作（`aria-expanded`），原始
  reasoning 内容永不展示，只显示模型生成的摘要。展开时按内容自然撑开（外层滚动承载长
  历史，段自身不设高度上限也不内层滚动；仅单个工具的日志保留自身高度上限并自行滚动）。
  `prefers-reduced-motion` 下关闭扫光动画。

- JupyterLab 首次加载会出现 `Shared module @jupyter-widgets/base doesn't exist in shared scope`
  的第三方 widget 前端告警；内核执行本身正常（`/v1/jupyter/execute` 实测返回 stdout）。
- 沙箱镜像固定不自动升级；升级步骤见运行手册（需人工确认并复验浏览器与编辑器）。
- 沙箱里的 Codex CLI 不是镜像自带的那份，而是持久卷内固定版本（默认 `0.160.0`），
  控制面接管容器时核实/补齐，失败会明确报错而不是回退旧版；升级见运行手册。
- 只有本机 loopback 明文调试时才允许非 Secure cookie；公网一律 `Secure`。

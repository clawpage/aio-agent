# AIO Agent 项目规范

本文件是仓库自包含的项目规范，不依赖仓库外的任何文件。公开使用者只需读本文件。

## 项目定位

**AIO Agent**：owner 管理、self-hosted 的智能体控制台 + 每账号独立 AIO 沙箱 + 主 Codex 智能体，
界面支持简体中文、英文、西班牙文和繁体中文（所有账号的配置页可切换）。owner 可在配置页把执行器切换为 Claude Code（可选，需凭据；派单、执行、标题一并切换）。用户只操作一个主会话，独立请求委派到子任务，相关补充追加到原任务；不展示旧会话历史入口。支持 owner/member 账号分级；任务与对话按账号归属隔离，普通用户固定为管理员分配的模型与推理强度（默认 GPT-6.1 Sol、推理强度「自动」——Jev 按任务选、拿不准时 high，可分配 Claude Sonnet 5.5 与固定档位；控制面的 ChatGPT 登录与 owner 的 Claude 凭据都只在宿主侧由成员模型网关附加），管理员配置与模型信息仅 owner 可见。每个 member 使用独立容器、文件卷、Codex 数据卷、浏览器卷、运行数据库和工作区路径（`/u/<用户名>`，兼容旧的 `/u/<账号散列>`，不新增域名；主控制台地址同样是 `/u/<用户名>`）；账号以邮箱注册和登录（老账号有隐藏的 `<用户名>@clawpage.ai` 占位邮箱、继续用用户名登录，见 `docs/FEATURES.md`「账号与权限」）；现有账户总数不足 20 时可免邀请码注册；达到 20 后须凭 owner 在配置页生成的一次性邀请码（只建 member，owner 与管理员创建的账号都计入总数），不对外提供公共 demo；业务 API 未登录返回 401。账号登录/注册入口、公开隐私与删除请求页面，以及同源匿名 `POST /api/support/requests` 为公开入口（仅支持隐私/删除申请、限流、不暴露账号是否存在，见 `docs/play-console.md`）；工作区来源上由 `clawpages` skill 发布的公开分享页 `/u/<用户名>/share/<页面名>/` 及其数据接口 `…/.data/`（宿主快照与按页隔离的数据表、CSP sandbox 隔离），以及只认该页协作者令牌的协作接口 `…/.api`（让别人的 Agent 拉取、发布与读写数据，不能删页、删表或改权限，见 `docs/FEATURES.md`「Clawpages」）；访客可用本站账号登录某一页（主站 `/clawpage-sso` 询问一次，令牌经地址片段只交给该页），登录后读写为登录访客设的表（`signed-in` / `per-user`）并经 `…/.ai` 用自己账号的模型得到回答（无工具、用量计入自己）。
公网入口（`PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST`）由使用者自行填写，见 `.env.example` 的
`agent.example.com` / `workspace.example.com` 占位。

**兼容保留的运行时标识**：容器名 `personal-agent-sandbox`、命名卷
`personal-agent-workspace` / `-codex` / `-browser`、SQLite 文件名 `personal-agent.sqlite`、
cookie 名 `pa_*` 与 `PA_*` 前缀**保持不变**——它们承载既有容器、卷、数据库与登录状态，改名会
丢数据或中断服务。health `service` 字段与 Codex `clientInfo.name` 的旧值仅为兼容已有集成保留，
不是品牌。品牌层为 **一站**（英文 **Clawpage Agent**，2026-10-13 正式上架时由 AIO Agent 改名）：中文界面的页面标题、侧栏、登录页与图标用“一站”，英文/西文界面、公开页、商店素材与智能体自称（默认 SOUL.md、派单与执行提示词）用 Clawpage Agent；仓库、包名与文档仍称 AIO Agent。标志是线路图上的一站：一条线（一）穿过一个站点（站），走过的一段实、前方的一段淡，琥珀色站心表示轮到你；`src/ui/src/components/Brand.tsx` 与 `src/ui/public/` 下的 favicon、PNG 图标、manifest，以及移动端图标源 `src/ui/tauri/icon/`（改后按该目录 README 重新生成）必须同步修改。配色语义：靛紫 = AI 在办（也是品牌主色），琥珀 = 轮到你（全站唯一醒目色），松绿 = 办完，朱红 = 出错；所有颜色只定义在 `src/ui/src/theme.css`（深浅两套），`styles.css` 与组件只引用令牌名，不写死颜色（画布、Mermaid 等必须拿到具体色值的地方用 `themeColor()`）。界面文案只放 `src/ui/src/i18n/locales/<语言>/<区域>.ts`：中文为默认与基准形状，其他语言必须同形（类型检查保证），组件通过 `t.<区域>.<键>` 取用、带参数的文案写成函数；解析服务器或执行器输出的中文留在代码里并加 `// i18n-exempt: <原因>`。`tests/unit/ui-literals.test.ts` 守护这三条。服务器写给人看的文字同样只放 `src/control/i18n/locales/<语言>/<区域>.ts`（四种语言同形，经 `t()` 取用，按请求的控制台语言或账号语言，默认英文）；只给模型或日志看的写英文；沙箱内脚本与 `src/sandbox/` 只写英文加错误代码，由控制面按代码翻译；`tests/unit/server-i18n.test.ts` 守护。

## 目录与职责

三层（界面、控制、沙箱）分目录、各自构建与部署，必须共享的代码只放 `src/common/`；
层之间不得互相 import（`tests/unit/layers.test.ts` 守护），界面只能用 `src/common/version.ts` 这类不依赖 Node 的模块。

| 路径 | 内容 |
| --- | --- |
| `src/ui/` | 界面层：React + Vite 中文前端（构建产物 `dist/ui`）与 `edge.mjs`（静态文件 + `/api` 原样转发给控制面，默认 :4891） |
| `src/control/` | 控制层：配置、SQLite、鉴权、任务与智能体、伴随站代理、成员网关；只经沙箱节点触达容器，自身不碰 Docker（默认 :4892） |
| `src/sandbox/` | 沙箱层：sandboxd，唯一持有 Docker 的进程；按校验过的参数创建/接管沙箱容器，只提供固定操作（检查、启停、容器内执行与流式执行、网页端口代理、网关中继），每个请求都要节点令牌（默认 :4894） |
| `src/ui/tauri/` | 界面层的 iOS/Android/macOS 外壳（Tauri 2）：全屏 web view 打开已部署的控制台，与 web 版共用 `src/ui/src` 同一套界面代码；只放原生适配（安全区、键盘、图标、签名，macOS 另有 Mac 上手机的桥接），见该目录 README；不进 Docker 镜像 |
| `src/common/` | 三层共享：控制面与沙箱节点的协议（`protocol.ts`）、兼容版本号（`version.ts`）、日志、密钥文件读取 |
| `deploy/` | 三个镜像的 Dockerfile、分层 compose 文件、`aio.mjs`（构建、上线前按镜像 label 校验兼容、启停、数据卷导入导出），见 `deploy/README.md` |
| `tests/unit/`、`tests/integration/` | vitest；集成测试自带假沙箱和假节点，不需要 Docker |
| `tests/e2e/live-smoke.mjs` | 对已部署实例的真实冒烟（`npm run smoke`） |
| `bin/serve` | 生产守护：按 `PA_DEPLOY` 以三个宿主进程（host）或 Docker Compose（compose）运行三层，外加专用 tunnel，转发信号 |
| `bin/phone-bridge.mjs` | Mac 上 USB 接的 Android 手机（mobile-mcp 工具白名单 + scrcpy 实时画面）、该 Mac 上 AI 专用的 Chrome（`bin/user-browser.mjs`）以及用户在 App 里打开后的终端（`bin/mac-shell.mjs`：read/write/edit/bash，bash 跑在专用 tmux 里），由 Mac App 运行，只听 loopback、要 App 给的桥接令牌，经 `bin/device-link-client.mjs` 主动连回控制面，交给连接这台 Mac 的账号 |
| `bin/keyboard-bridge.mjs` | 可选宿主进程：语音配件的「语音键盘」把润色后的文字粘贴到宿主 Mac 光标处；实际输入由 `bin/keyboard-bridge/main.swift` 编译的后台 App 完成（辅助功能权限只给它），只听 loopback、要桥接令牌，只由 `/api/gadget/dictation` 调用 |
| `bin/dns-agent.py` | 现有部署专用的 DNS 辅助脚本：依赖仓库外的 `tools/linode-local/dns.py`，**不是 quickstart 入口**，公开使用者通常不需要 |
| `var/` | 运行时数据（DB、日志、owner 凭据、tunnel 凭据），全部 git 忽略；compose 部署时控制面数据在命名卷里 |
| `docs/` | 功能说明、配置参考、架构、运行手册、开发与测试、能力清单 |

## 必须遵守

1. **凭据**：`var/owner-secret.txt` 是唯一可读的 owner 明文密码（0600，git 忽略，绝不写日志、
   绝不进 URL 或 localStorage）。**不要重置已运行的数据库或密码**；确需轮换用
   `PA_OWNER_PASSWORD_RESET=1` 一次性执行，并明确告知用户新位置。
2. **镜像与容器**：镜像版本固定；容器创建参数里包含归属标签、镜像与卷校验，名字被别的容器
   占用时拒绝接管。升级镜像属于单独任务，需人工确认并复验浏览器、编辑器、笔记本、终端。
3. **不接受宿主机能力桥接**：运行用户代码的沙箱容器永远不挂载宿主机 home、workspace 或 `docker.sock`。
   只有沙箱层的 sandboxd 可以持有 Docker 访问（compose 部署时挂载 `docker.sock`）：它不运行任何用户代码，
   每个请求都要节点令牌，沙箱访问不到它，且只以固定参数调用 Docker、不接受调用方给的 Docker 参数、
   宿主路径或挂载，不提供任意宿主机 shell 通道。控制面不持有 Docker 访问。owner 配置的知识库 MCP
   （`docs/FEATURES.md`“知识库”）、Home Assistant MCP（`docs/FEATURES.md`“Home Assistant”）与打印机（`docs/FEATURES.md`“打印机”）只经成员网关按账号转发，令牌不进沙箱；不要为它们另开直连端口，也不要把授权名单
   之外的账号接进去。手机（`bin/phone-bridge.mjs`，`docs/FEATURES.md`“手机”）每个账号只用自己的：只经 Mac App 接入，
   Mac 连接的手机只给连接它的账号（设备令牌只存哈希、可随时移除），控制面宿主不直接接手机；工具经成员网关，画面只在主站；
   桥接对 mobile-mcp 只放行作用在手机本身的工具，不得放开其中读写宿主机（含用户的 Mac）文件或云手机的工具。同一桥接经 `bin/user-browser.mjs` 提供用户 Mac 上 AI 专用的 Chrome
   （执行器经 `aio_mac_native` 使用，与沙箱浏览器并存、不可用时回退沙箱），只放行作用在浏览器里的工具，不得放开上传文件、带文件路径的参数或打开 `file://` 等非网页地址。桥接只以固定参数、无头方式启动它自己的专用配置（App 数据目录下的 `ai-chrome`），不得连接或启动用户自己的 Chrome 配置，也不得让它出现窗口、抢焦点或占用用户的屏幕。
   唯一读写用户 Mac 文件、运行命令的通道是同一桥接的终端（`bin/mac-shell.mjs`，`aio_mac_native` 的终端工具，`docs/FEATURES.md`“Mac 上的终端”）：默认关闭，只能由那台 Mac 上的 App 打开（开关存在 App 本地，以 `PA_MAC_SHELL=1` 传给桥接，控制面与网页无法打开），只给连接它的账号；
   shell 环境不得带入桥接或 App 的任何令牌，命令只跑在专用 tmux 服务器（socket `aio-agent`）里；不要另开别的宿主机命令或文件通道，也不要把它接给其他账号或配件。键盘桥（`bin/keyboard-bridge.mjs`）只接受配件令牌下
   `/api/gadget/dictation` 的输入，不得接进成员网关或任何执行器工具。
4. **两个来源**：主站与伴随站必须保持不同来源；不要把 AIO 生成内容放到主站上，也不要为了
   本地调试放宽 cookie 安全属性（localhost 明文是唯一例外）。
5. **DNS**：只允许用 `bin/dns-agent.py` 维护 `agent.clawpage.ai` 与 `agent-workspace.clawpage.ai` 两条记录；不得运行
   `tools/linode-local/dns.py` 的 plan/apply/rollback（那是另一条迁移线）。
6. **停止语义要诚实**：排队/执行中/启动中的停止分别处理，不得谎报已停止；连接中断导致的
   未知结果标记 `unknown` 并提示先核对，不自动重放有副作用的操作。
7. **事件顺序**：任何非 delta 事件落库前先冲刷 delta 缓冲，避免客户端重复文本。

## 常用命令

```bash
npm run typecheck && npm test      # 提交前必跑
npm run build                      # 改前端或服务端后必须重新构建（dist/ui、dist/control、dist/sandbox）
npm run smoke                      # 对已部署实例真实冒烟（控制台 :4891，伴随站 :4892）
node deploy/aio.mjs build          # 构建三个镜像（带版本 label）
node deploy/aio.mjs check          # 校验本机要跑的镜像彼此兼容
# 以下为现有部署的可选管理方式（非公开安装必需）：
tools/start.sh restart personal-agent
docker exec personal-agent-sandbox supervisorctl status          # 沙箱内服务
docker exec -u root personal-agent-sandbox supervisorctl start code-server   # 只启单个程序
```

## 运行与验证约束

- 公开安装/自托管路径：Docker Compose（`deploy/README.md`）或三个 Node 进程（README Quickstart），
  不依赖仓库外脚本。
- 兼容契约在 `src/common/version.ts`：改了控制面 API 或节点协议的不兼容行为，要同时调整版本号与范围；
  镜像 label 与运行时握手都从这里来，`deploy/aio.mjs check` 会拒绝不兼容的组合。
- 现有部署（本仓库最初的使用者）可选地继续用 workspace 根 `tools/start.sh` 管理；
  host 模式下 `bin/serve` 会在 `dist` 早于 `src` 时拒绝启动，compose 模式下由 `deploy/aio.mjs` 校验镜像，避免用旧构建验收。
- 修改 UI 后要用真实浏览器验桌面（1440×900）与手机（390×844、360 宽）；`HTTP 200 不等于可用`。
- 沙箱相关改动要在真容器上验证（健康接口检查 terminal；code-server / Jupyter 按需启动，打开它们的页面验证）。
- 重启只针对本服务（现有部署）：`tools/start.sh restart personal-agent`，不要重载全局 supervisor，
  也不要重启其他项目或共享容器。
- 文档分工：README 只做项目简介；功能行为写 `docs/FEATURES.md`，新增环境变量写 `docs/CONFIGURATION.md`，
  运维步骤写 `docs/RUNBOOK.md`。

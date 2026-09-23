# personal-agent 架构与安全边界

## 目标形态

一个 owner、一个持久 AIO 沙箱、一个常驻主 Codex 智能体；中文界面；桌面与手机功能对等；
公网只通过专用 Cloudflare tunnel 暴露两个精确域名。

```
浏览器 ──TLS──> agent.zymx.tech ──┐
浏览器 ──TLS──> agent-workspace.zymx.tech ──┤
                                            └─> cloudflared（专用 tunnel）
                                                  └─> Node 控制面 127.0.0.1:4891
                                                        ├─ 主域：SPA + /api + SSE
                                                        ├─ 伴随域：AIO 反向代理（HTTP + WS）
                                                        ├─ docker exec -i ─> 沙箱 codex app-server
                                                        └─ 宿主机 codex app-server（仅取 token）
沙箱容器 personal-agent-sandbox（镜像固定 1.11.0）
  ├─ volume personal-agent-workspace -> /home/gem/workspace
  ├─ volume personal-agent-codex     -> /home/gem/.codex
  └─ volume personal-agent-browser   -> /home/gem/.config/browser
```

## 同源策略：两个站点、一个进程

控制面按 `Host` 头把请求分成两类，两者共用同一个 Node 进程但**cookie 与来源互相独立**：

| | 主站 `agent.zymx.tech` | 伴随站 `agent-workspace.zymx.tech` |
|---|---|---|
| 内容 | 中文控制台 SPA、`/api/*`、SSE | AIO 全部 HTTP/WS 表面（终端、VNC、Jupyter、code-server、MCP、`/v1/*`） |
| Cookie | `pa_session`（HttpOnly）+ `pa_csrf` | `pa_ws_session`（HttpOnly）+ `pa_ws_csrf` |
| 进入方式 | 密码登录 | 主站签发的一次性短票据 `/_bootstrap` |
| 未知 Host | 404 | 404 |

把 AIO 生成的内容（用户代码、笔记本输出、浏览器页面）放在**另一个来源**上，是为了让主控制台
永远不会与用户代码同源执行。本地开发用 `localhost:4891` 当作主站、`127.0.0.1:4891` 当作伴随站，
两者仍然是不同来源，因此跨站规则与线上一致。

## 认证与会话

- 只有一个 owner。**没有注册接口**；owner 由 `PA_OWNER_PASSWORD` 或首次启动生成的
  `var/owner-secret.txt`（0600，git 忽略，从不写日志）建立。
- 密码用 scrypt（N=16384）加盐存储；比对用 `timingSafeEqual`，未知用户也走一次等价开销。
- 会话是随机 32 字节不透明 token，DB 只存 SHA-256，cookie 为 `HttpOnly` + `SameSite=Lax`；
  公网（HTTPS）强制 `Secure`，只有 loopback 明文调试时才省略 `Secure`。
- 续期：会话空闲即滑动续期；客户端每 15 分钟调用 `/api/auth/refresh` 主动轮换 token，
  轮换会**同时延长过期时间**（否则高频续期反而会提前失效），旧 token 有 90 秒宽限期以免
  并发标签页互相踢掉。伴随站会话有独立的 `/api/workspace/refresh`，只对主站来源开放跨源调用。
- 注销立即吊销会话，并通过事件关闭该会话已建立的 SSE 与 WebSocket。
- 登录失败按 IP 计数，默认 5 次/15 分钟窗口 → 15 分钟锁定。IP 取自 socket；
  只有显式开启 `PA_TRUST_CF_CONNECTING_IP=1`（专用 tunnel 后）才采信 `CF-Connecting-IP`，
  否则 `X-Forwarded-For` 之类的头可被伪造，会绕过限速。

## 请求防护

- **Host 白名单**：未知 Host 直接 404；`X-Forwarded-Host` 与 `Host` 不一致也拒绝（防头走私）。
- **Origin 白名单**：所有写操作（POST/PUT/PATCH/DELETE）必须携带允许的来源。主站另需
  `X-CSRF-Token`（双提交，绑定会话）；伴随站不要求该头，因为 AIO 自带界面无法配合，
  其保护来自 SameSite=Lax + host-only cookie + 精确 Origin 校验。
- **WebSocket 升级**同样经过 Host/Origin/会话三重校验，会话被吊销时连接立即断开。
- 沙箱 cookie 回写时改名/去 `Domain`（保持 host-only）、丢弃与 `pa_*` 冲突的名字（防 cookie
  tossing）；请求转发到沙箱前剥离 `authorization`、全部控制面 cookie 与客户端伪造的转发头。
- 上游响应只改写 `frame-ancestors`（允许伴随站自身与主站），保留其余 CSP 指令。

## 执行模型

- 沙箱里的 Codex 以 `docker exec -i ... <卷内固定版本 codex> app-server` 常驻，通过 stdio JSON-RPC 驱动。
  二进制取自持久卷（`/home/gem/.codex/tools/codex-<版本>/node_modules/.bin/codex`），
  不使用镜像 `PATH` 上的旧版本；接管容器时核实版本并自动补齐（失败则明确报错，不静默回退）。
- 每个轮次的模型在提交时解析并写入会话：客户端显式选择优先，其次沿用会话已存的模型，
  最后用 `PA_DEFAULT_MODEL`（默认 `gpt-6-sol`）。升级时有一次受 `meta` 键
  （`model_default_migration_v1`）保护的一次性迁移：仍带旧默认值 `gpt-5.5` 的会话改为新默认，
  只改 `model` 列、不动历史；之后用户手动选择（包括 5.5）永久保留。
- **自动标题**（独立于主对话）：会话首轮 `completed` 后，控制面异步启动一个沙箱内临时线程
  （`thread/start {ephemeral:true, sandbox:"read-only", approvalPolicy:"never", model: PA_TITLE_MODEL}`），
  把首条用户消息交给它生成短标题；首轮只有附件时用附件名/类型构造输入。只有临时线程被
  `threadSubscriber` 接管，其通知、审批、delta 不会进入用户会话（`#conversationForThread` 对
  未知线程不再回退到活动会话）。只有 `turn/completed` 状态为 `completed` 才采用结果；超时/失败
  返回 `null`，超时时 best-effort `turn/interrupt`，并把该临时线程标记为 tombstone：直到真正收到
  `turn/completed` 或会话关闭前，它的所有通知继续丢弃，避免迟到的 delta 被 `#bufferDelta` 记到主会话。
  写库用 `UPDATE ... WHERE title='新会话' AND archived=0 AND NOT EXISTS(meta.title_manual:<id>)`
  单条原子守卫；手动改名与 `meta.title_manual:<id>` 写入在同一 SQLite 事务，成功后发
  `conversation.title_updated`。只重命名仍为默认名且从未手动改名的会话；失败保留原名，
  同一进程不重试、下次启动可重试；旧会话在 Codex 就绪后串行补名。
- **会话管理**（侧栏）：每个会话只有一个 `⋯` 菜单（重命名；活跃项归档、归档项恢复），**没有删除**。
  重命名走 `PATCH /api/conversations/:id {title}`，与自动标题共用 `meta.title_manual:<id>` 保护，手动标题
  不会被自动重写。为保持“最多一个活跃空白默认会话”，空标题创建会复用已有空白默认；把零轮次会话
  改名成 `新会话`、或恢复另一个零轮次 `新会话` 而已有活跃空白时，服务端返回 409（归档项仍可恢复，
  有消息的会话不受影响）。归档只改 `archived` 标志，不清除沙箱文件或远端 Codex 数据。
  侧栏排序不依赖 `updated_at`（重命名、归档、恢复、状态变化都会改它）：唯一活跃的空白默认会话
  （`title='新会话'` 且零轮次）固定置顶，其余按每个会话最新一条 turn 的
  `MAX(COALESCE(completed_at, created_at))` 从新到旧排列，无 turn 的会话用 `created_at` 兜底，
  同时间戳用 `created_at`/`id` 稳定决胜；归档项不参与置顶。
- **附件上传**：对话里的“附件”经 `POST /api/sandbox/upload` 落到沙箱的固定目录
  `/home/gem/workspace/uploads/`（幂等创建并核实，失败如实报错）；该目录位于持久化工作区，旧版本
  工作区根目录里已有的附件不迁移、不删除。带显式 `dir` 的请求仍按传入目录写入，供工作区文件管理
  等通用调用者使用。
- 一个 owner 在沙箱内**跨会话并发、同会话串行**：最多 `PA_MAX_CONCURRENT_TURNS`（默认 3，取值 clamp
  到 1–3）个主
  turn 在不同会话里同时执行，第四个会话的输入按创建时间 FIFO 排队，任一槽位释放即被唤醒。
  同一会话始终只有一个 turn 在跑，其后续输入排队。活动 turn 以会话为键保存在
  `#activeTurns`；通知、delta、审批、停止、完成等待都按 `threadId`/`turnId` 归属到正确的会话，
  无身份可归属的事件（未知线程，或存在多个活动 turn 且无标识）被丢弃或直接拒绝，绝不记到随机会话。
  重复提交由 `clientMessageId` 幂等去重，同一 ID 携带不同内容会被 409 拒绝。旧的
  `agent_state.active_turn_id`/`active_conversation_id` 表示第一个活动 turn，重启核对仍扫描所有
  `running` 轮次。
- 所有事件（含流式 delta）先落 SQLite 再广播；浏览器断线**不会**中断智能体，重连按事件 id
  分页补齐历史（`?since=`）。delta 在 250 ms 窗口内合并，但任何非 delta 事件落库前会先冲刷
  缓冲区，保证客户端不会先看到完整文本、再收到旧 delta 而重复。
- 停止：排队中的轮次被原子取消；正在执行的发送 `turn/interrupt`；刚提交还没拿到 turn id 的
  记录取消意图，拿到 id 后立即中断。三者都如实返回状态，不会谎报已停止。
- 未知结果：进程中断、连接断开或 `turn/start` 中途失败时，轮次标记为 `unknown` 并明确提示
  “可能已在沙箱内产生操作，请先核对”，**绝不自动重放**。服务重启时 `running` 与 `queued`
  分别按 `unknown` / `interrupted` 处理。
- 审批与输入请求（命令/文件/权限/`requestUserInput`/MCP elicitation）成为 UI 上可操作的卡片，
  按各自 schema 回填响应，15 分钟无响应自动拒绝，Codex 断开时立即失效而不是干等超时。
- 思考展示只使用模型生成的**摘要**：主 turn 显式请求 `summary: PA_REASONING_SUMMARY`（默认 `concise`），
  UI 只解析 `item/reasoning/summaryTextDelta` 事件和 `reasoning` item 的 `summary` 数组，
  不展示原始思维链（`content` 数组与 `item/reasoning/textDelta` 被丢弃），没有摘要时不产生空的
  “摘要”可展开行。

## 统一登录与 token 边界

- 宿主机保持原有 `codex login`（使用本人已有订阅额度），不在容器里重复登录。
- 需要 token 时，控制面在本机启动宿主机 `codex app-server`，只调用官方方法
  `account/read {refreshToken:true}`（由宿主机 Codex 自己完成受管刷新）与
  `getAuthStatus {includeToken:true}`，绝不自行实现 OAuth、绝不写宿主机 auth 文件。
- 只把**访问 token** 通过 `account/login/start {type:"chatgptAuthTokens"}` 交给沙箱；
  refresh token 永不离开 Mac。沙箱侧 401 时由控制面向宿主机重新取 token 后应答。
- 宿主机 Codex 登录失效时，`/healthz` 的 `ready` 变为 false，控制台顶部显示明确提示。

## 沙箱隔离

- 账号登录复用不代表 Connector 权限隔离：Codex 的 Apps 默认开启，因此沙箱显式关闭
  `features.apps`、`features.plugins`、`features.remote_plugin`，并设置 `apps._default.enabled=false`。
  控制面在每次接管容器时安装独立的 `/etc/codex/requirements.toml`（root 管理），固定这三个
  feature 为 false；MCP 白名单只接受 `aio_browser` 的精确 URL `http://127.0.0.1:8080/mcp`。
  app-server 启动参数再次关闭相同入口；现有用户 config、AGENTS 与 Mac 连接配置不覆盖。
  遇到不属于 personal-agent 的 requirements 文件时拒绝覆盖并阻止运行时启动，需人工合并。
  此规则隔离的是 Codex 工具接入；不声称共享账号访问 token 已变为模型专用权限，也不隔离
  用户在沙箱浏览器中主动登录的网站。沙箱 root/自定义客户端仍属于原有可信执行边界。
- 只挂载三个命名卷（工作区、CODEX_HOME、浏览器 profile）；不挂载宿主机 home、
  `/var/run/docker.sock` 或任何 workspace 路径。
- 容器内以 `gem`(uid 1000) 运行；Node 控制面只以固定参数调用 Docker（固定的容器名、
  固定卷名），没有任意宿主机 shell 通道。
- 容器创建前会校验**归属标签**、**镜像**与**卷挂载**，名字被别的容器占用时拒绝接管；
  启动时修正 `/home/gem/.config` 等父目录属主并只重启需要的 supervisord 程序（例如 code-server），
  绝不 `restart all`。
- `BROWSER_NO_SANDBOX=--no-sandbox` 是该镜像在 Docker Desktop 的 Linux VM 里运行 Chromium
  的必要条件（VM 不支持 user namespace），仅影响容器内部浏览器。

## 数据与持久化

SQLite（`var/personal-agent.sqlite`，WAL）保存 owner、会话、对话、轮次、事件、审批与票据。
浏览器重连、控制面重启、容器重启都不会丢历史；被中断的轮次带明确状态而不是静默重试。

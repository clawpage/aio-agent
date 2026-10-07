# AIO Agent 架构与安全边界

## 目标形态

一个 owner 管理 member、每账号独立持久 AIO 沙箱和智能体；中文界面；桌面与手机功能对等；
公网只通过专用 Cloudflare tunnel 暴露两个精确域名。系统分三层，各自构建、各自一个镜像，
可以同机也可以分机部署：

```
浏览器 ──TLS──> agent.clawpage.ai ───────────> cloudflared（专用 tunnel）
浏览器 ──TLS──> agent-workspace.clawpage.ai ──┘        │
                                                      ├─> 界面层 ui :4891（src/ui/edge.mjs）
                                                      │     ├─ 控制台静态文件（dist/ui）
                                                      │     └─ /api/* 原样转发 ─┐
                                                      └─> 控制层 control :4892 ◀┘（src/control）
                                                            ├─ 主域 /api + SSE；伴随域 AIO 反向代理（HTTP + WS）
                                                            ├─ 成员网关 :4902（沙箱经 host.docker.internal 回连）
                                                            └─ 只经沙箱节点触达容器 ──> 沙箱层 sandboxd :4894（src/sandbox）
                                                                  ├─ 唯一持有 Docker 的组件（固定操作、节点令牌）
                                                                  ├─ 容器内执行 / 流式执行（Codex、Claude Code 的 stdio）
                                                                  └─ 网页端口代理 ──> 沙箱容器（每账号一个，镜像固定 1.11.0）
沙箱容器 personal-agent-sandbox / aio-user-<散列>
  ├─ volume …-workspace -> /home/gem/workspace
  ├─ volume …-codex     -> /home/gem/.codex
  └─ volume …-browser   -> /home/gem/.config/browser
```

## 三层与兼容契约

| 层 | 代码 | 职责 | 状态 |
| --- | --- | --- | --- |
| 界面 | `src/ui` | 控制台 SPA；edge 只提供静态文件并把 `/api` 原样转给控制面，网页与 API 同源，cookie/CSRF 模型不变 | 无状态、无密钥 |
| 控制 | `src/control` | 账号、会话、任务与派单、智能体会话、浏览器/空闲策略、文档、推送、伴随站代理、成员网关；沙箱里的一切（CLI、skill、策略、浏览器设置、noVNC 补丁）都从这里经节点下发 | SQLite 与密钥（数据卷） |
| 沙箱 | `src/sandbox` | sandboxd：按校验过的规格创建或接管容器（允许的镜像、只用命名卷、成员网络与资源上限、出站守卫、对端端口守卫、归属标签），其余只提供固定操作 | 无（容器与卷在 Docker 里） |
| 共享 | `src/common` | 节点协议 `protocol.ts`、兼容版本 `version.ts`、日志、密钥文件读取 | — |

层之间不互相 import（`tests/unit/layers.test.ts`）。控制面与节点之间只有 `protocol.ts` 定义的 HTTP/WebSocket：
`ensure`（规格）、`inspect`、`stop`、`restart`、`peer-ports`、`exec`（一次性命令，stdin 与密钥环境变量分开传）、
`spawn`（WebSocket 上的流式命令，控制面把它当子进程用）、以及带 `x-aio-sandbox` 头的网页端口代理。每个请求都要
节点令牌和兼容的协议范围（`x-aio-protocol`），否则 401/409。节点不接受 Docker 参数、宿主路径或挂载。

账号到节点的分配记录在根库 `meta` 的 `sandbox_node:<账号>`：已有账号固定在第一个节点（卷在那里），新账号放到
剩余内存最多的节点；配置里没有该节点时直接报错，绝不在别处重建。控制面在别的机器时，节点上的网关中继
（`PA_SANDBOXD_GATEWAY_UPSTREAM`）让沙箱照旧经 `host.docker.internal:<网关端口>` 回连。

兼容版本在 `src/common/version.ts`：控制面 API 版本与最低兼容版本、节点协议版本、控制面能驱动的协议范围。
镜像 label 带着这些数字，`deploy/aio.mjs` 在 `compose up` 前拒绝不兼容组合；运行时控制面拒绝协议不符的节点
（`/healthz` 的 `compatible`），界面 edge 只在控制面提供所需 API 时健康，网页在版本不符时提示。

控制面容器里没有 Codex 安装（`PA_HOST_CODEX=off`）：不向沙箱下发 ChatGPT token，只提供 Claude Code 与桥模型。

## 同源策略：两个站点

控制面按 `Host` 头把请求分成两类（主站请求经界面层转来，Host 不变），**cookie 与来源互相独立**：

| | 主站 `agent.clawpage.ai` | 伴随站 `agent-workspace.clawpage.ai` |
|---|---|---|
| 内容 | 中文控制台 SPA、`/api/*`、SSE | AIO 全部 HTTP/WS 表面（终端、VNC、Jupyter、code-server、MCP、`/v1/*`） |
| Cookie | `pa_session`（HttpOnly）+ `pa_csrf` | `pa_ws_session`（HttpOnly）+ `pa_ws_csrf` |
| 进入方式 | 密码登录 | 主站签发的一次性短票据 `/_bootstrap` |
| 未知 Host | 404 | 404 |

把 AIO 生成的内容（用户代码、笔记本输出、浏览器页面）放在**另一个来源**上，是为了让主控制台
永远不会与用户代码同源执行。本地开发用 `localhost:4891` 当作主站、`127.0.0.1:4891` 当作伴随站，
两者仍然是不同来源，因此跨站规则与线上一致。

## 主会话任务调度

`GET /api/main` 提供主会话任务账本，`POST /api/tasks` 接收消息并持久化后立即返回。
`tasks` 持久化每条消息，每行预留内部 `conversation`；新任务通过它执行，补充消息则用 `merged_into` 引用原任务、沿用原执行线程。后者仍复用已有事件、审批、停止与重连机制。
旧会话管理 API 为兼容保留，但任务所属 conversation 禁止通过旧接口追加 turn 或重命名/归档。
新前端只展示主会话、配置和工作区，不展示旧会话历史入口。

派单按数据库时序、倒排召回、Jev、派单器顺序进行。owner 选 Codex 时，最终派单器是隔离的临时分类线程（read-only、never、ephemeral），输出经校验的 JSON；owner 选 Claude 或 member 账号时沿用各自配置的派单模型。
只能引用已存在且更早的任务，防止循环依赖；相关任务结果在派发时重新读取，避免使用陈旧快照。
候选任务分为进行中与已结束两组，分别取最近 5 个，再从历史倒排检索补充最多 4 个（总数最多 14 个）。`task_search` 是 FTS5 表，
标题、任务用户消息（含补充）、任务结果及可用的最新助理消息预先切成中文二字词和拉丁词写入，按内容哈希（`task_search_state`）增量同步；短消息再结合邻近任务标题检索。Jev 对候选逐项独立评分，并建议 new/steer/resume；显示为 0% 的任务详情及时间线片段不交给派单器，用户显式引用除外。派单器使用 low 推理强度决定标题、简述和最终路由（用户点“引用任务”的消息除外：按被引用任务的状态，进行中则 steer、已结束则 resume，不经 Jev，派单器只生成标题和简述）；不进行搜索、预先追问或资源分配。执行者按用户授权自行使用文件、浏览器和工具，旧计划的资源字段只用于队列协调或浏览器预热，不是权限边界。Jev 失败时派单器仍根据召回决策。候选来源、搜索、Jev 回答、派单器计划和分阶段耗时写入 `recall_events`；两模型判断也进入执行会话的上下文。
并发数复用 `PA_MAX_CONCURRENT_TURNS`；浏览器不是互斥资源：沙箱内的标签页服务（`tab-server.cjs`，loopback `:8190`，
patchright-core 经 CDP 连接同一个 Chromium；不用 playwright-core，是因为常驻连接会给每个页面留下可被网站检测的 `Runtime.enable` 痕迹）按请求头 `X-AIO-Task`（执行会话 ID）与 `X-AIO-Task-Title` 把每个标签页登记到创建它的任务：创建者可操作，其他任务只读，
登记表存于 `/tmp/aio-tabs-state.json`，重启后按 CDP targetId 重新认领；执行线程经线程级配置（Codex `config.mcp_servers`、
Claude Code `--mcp-config`）接入它并关闭 `aio_browser`。回合结束只标记“已结束”（续接复用），按需销毁：超过 8 个已结束标签页
按最久未用关闭，浏览器空闲释放前的快照之前清理全部已结束标签页（`pruneBeforeSnapshot`）。
新派单不声明资源，也不限制执行者可用的文件、浏览器或工具；服务端仍为任务目录保留调度记录，并对旧计划中的资源提示做冲突排队（`claimsConflict`，`src/control/tasks/resources.ts`）。这些提示不是 OS 权限隔离；同账号执行者共享沙箱，跨账号使用不同容器。

派单 JSON 的 `decision` 是正式 new/steer/resume 决定；服务端按目标任务状态校验并归一化为 `appendTo` 或 `resume`。`appendTo` 用于识别同一进行中任务的补充（地址、条件、纠正、额外要求）。
尚未派发时合入原始输入；排队时更新 turn 输入；执行中通过 [Codex turn/steer](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn) 和 `expectedTurnId` 追加到同一轮，只有收到匹配回执才标记 merged。
补充状态为 merging → steering → merged；启动中等待 Codex turn ID，新增资源与其他执行任务冲突时等待资源。
原任务恰好结束且确认未送达时，转为带原结果的后续任务；RPC 明确拒绝标记 merge_failed，断线、超时或重启中的 steering 标记 merge_unknown，绝不自动重发。
主时间线保留补充原文和归属提示，不新增运行状态条或重复最终回报。

状态为 planning → waiting → queued/running → completed/failed/interrupted/unknown。
planning_failed 可安全重试分类；blocked 提示前置结果需要核对。每条用户消息 ID 唯一、payload
冲突返回 409；消息和内部会话同一事务创建。执行中断恢复由 AgentManager 先核对，TaskService
再从已持久化 turn 同步，绝不自动重放未知执行。任务行 revision 递增，客户端合并忽略陈旧快照。
主时间线只取终结后的最终消息，过程仍保留在子线程详情；审批仍按子线程独立处理。

## 认证与会话

- 一个 owner，可通过本地 `bin/create-user.mjs` 创建 member，或由 member 凭 owner 生成的一次性邀请码经 `POST /api/auth/register` 自助注册（`src/control/auth/invites.ts`）；owner 由 `PA_OWNER_PASSWORD` 或首次启动生成的
  `var/owner-secret.txt`（0600，git 忽略，从不写日志）建立。
- 密码用 scrypt（N=16384）加盐存储；比对用 `timingSafeEqual`，未知用户也走一次等价开销。
- 会话是随机 32 字节不透明 token，DB 只存 SHA-256，cookie 为 `HttpOnly` + `SameSite=Lax`；
  公网（HTTPS）强制 `Secure`，只有 loopback 明文调试时才省略 `Secure`。
- 续期：会话空闲即滑动续期；控制台打开期间每 15 分钟、以及回到前台时（距上次超过 5 分钟）调用 `/api/auth/refresh` 心跳，
  把会话和两个 cookie 都延长一个完整 TTL（默认 30 天），**不更换 token**，客户端同一时间只发一个心跳。
  早先心跳会轮换 token：手机从后台回来时定时器和可见性事件同时续期，两次轮换互相覆盖、或新 cookie 随被挂起的响应丢失，
  用户就被登出，所以改为只续期。伴随站会话有独立的 `/api/workspace/refresh`（同样只续期），只对主站来源开放跨源调用。
- 注销立即吊销会话，并通过事件关闭该会话已建立的 SSE 与 WebSocket。
- 登录失败按 IP 计数，默认 5 次/15 分钟窗口 → 15 分钟锁定。IP 取自 socket；
  只有显式开启 `PA_TRUST_CF_CONNECTING_IP=1`（专用 tunnel 后）才采信 `CF-Connecting-IP`，
  否则 `X-Forwarded-For` 之类的头可被伪造，会绕过限速。

## 账号分级边界

数据库保留兼容表名 `owners`，增加 `role=owner|member`；原 `owner_1` 迁移为 owner，密码与已有 session 不变。
任务经 conversation.owner_id 绑定账号；列表、详情、事件回放/实时流、审批、引用、停止与派单历史均核对归属。
owner 维护自己的模型与 SOUL，各 member 从默认 SOUL 开始独立保存；member 派单和执行固定为管理员分配的模型 / high（默认 GPT-6.1 Sol，可分配 Claude Sonnet 5.5），服务端拒绝覆盖，该模型不可用时失败，不换用别的模型。
member 不显示配置/模型/提示原文。这里的隐藏指产品配置及结构化元数据，不对正常回答文字做删词处理。

`UserRuntimes` 按服务器查证的账号身份选择完整运行环境，禁止客户端指定容器、端口、目录或上游。
member 使用独立容器和三个独立卷、独立宿主任务 DB / SOUL / 缓存、独立网络和工作区路径（同一工作区域名下的 `/u/<用户名>/`，owner 同样是 `/u/owner`，兼容旧的 `/u/<账号散列>/`；不带前缀的子资源按工作区会话的账号路由；容器与卷名仍用账号散列）。主控制台同样按 `/u/<用户名>` 区分地址，登录状态仍是整站一个会话。所有沙箱容器（owner 在内）内存上限默认 2 GB（`--memory 2g`，交换区合计 4 GB），节点可用 sandboxd 的 `PA_SANDBOXD_MEMORY`（如 `4g`）改成自己的值；member 另限 2 核 CPU、1024 个进程。改上限只影响新建的容器，已有容器用 `docker update --memory 2g --memory-swap 4g <容器>` 在线生效，无需重建。
HTTP、SSE、WebSocket、文件预览、上传、终端与浏览器都走同一账号绑定。工作区票据继承主站登录身份，且只能在该账号对应域名消费。
成员模型网关只转发账号分配的那一个模型：GPT 成员仅允许 POST responses（发往 ChatGPT，模型固定、强制 high / store=false，拒绝 previous_response_id、conversation 和后台请求），Claude 成员仅允许 Messages；控制面的 ChatGPT 登录与 owner 的 Claude 凭据留在宿主，成员只有独立能力凭据。
容器不挂载宿主路径或 Docker socket，丢弃 NET_RAW，原本不授予 NET_ADMIN。可信只读网络守卫通过共享目标网络命名空间原子安装 IPv4/IPv6 规则；不在用户可写容器中执行提权代码。仅模型网关是私网出口例外；其他私网/宿主地址被拒绝。
旧共享环境的 member 数据不自动复制，新账号从空环境开始。旧测试数据清理须明确授权，owner 原有卷不迁移。此设计仍依赖 Docker/宿主内核边界，不等于独立虚拟机。

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

- 沙箱里的 Codex 以 `docker exec -i ... <卷内固定版本 codex> app-server` 常驻（由 sandboxd 执行，stdio 经节点的
  WebSocket 流转给控制面），通过 stdio JSON-RPC 驱动。
  二进制取自持久卷（`/home/gem/.codex/tools/codex-<版本>/node_modules/.bin/codex`），
  不使用镜像 `PATH` 上的旧版本；接管容器时核实版本并自动补齐（失败则明确报错，不静默回退）。
- 每个轮次提交时冻结模型设置：owner 使用统一配置，否则用 `PA_DEFAULT_MODEL`（默认 `gpt-6-sol`）；member 强制管理员分配的模型 / high，提交与执行时均检查，不采用客户端覆盖。升级时有一次受 `meta` 键
  （`model_default_migration_v1`）保护的一次性迁移：仍带旧默认值 `gpt-5.5` 的会话改为新默认，
  只改 `model` 列、不动历史；之后用户手动选择（包括 5.5）永久保留。
- **派单器的临时线程**（Codex 执行器时，独立于主对话）：主会话派单在沙箱内启动一个临时线程
  （`thread/start {ephemeral:true, sandbox:"read-only", approvalPolicy:"never", model: PA_TITLE_MODEL}`，
  Luna effort low、其他模型 high，90 秒）。只有临时线程被 `threadSubscriber` 接管，其通知、审批、delta 不会进入用户会话
  （`#conversationForThread` 对未知线程不回退到活动会话）。只有 `turn/completed` 状态为 `completed`
  才采用结果；超时返回 `null` 并 best-effort `turn/interrupt`，同时把该线程标记为 tombstone：直到
  真正收到 `turn/completed` 或会话关闭前，它的所有通知继续丢弃，避免迟到的 delta 被 `#bufferDelta`
  记到主会话。会话标题由派单器按任务给出（早先的“首轮自动标题”已移除）。
- **旧版会话管理兼容接口**（当前主界面不展示）：每个会话只有一个 `⋯` 菜单（重命名；活跃项归档、归档项恢复），**没有删除**。
  重命名走 `PATCH /api/conversations/:id {title}`，成功后发 `conversation.title_updated`。为保持“最多一个活跃空白默认会话”，空标题创建会复用已有空白默认；把零轮次会话
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
  重复提交由 `clientMessageId` 幂等去重，同一 ID 携带不同内容会被 409 拒绝。重启核对扫描
  `turns` 里所有 `running` 轮次（`turns` 是唯一记录，旧的单槽 `agent_state` 表已删除）。
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

## 浏览器内存生命周期

沙箱 Chromium 在无人使用时会被**真正释放**（不是 `SIGSTOP`，也不是停容器），下次按需从快照
重建。控制面本身从不向进程发信号：它把**受管 helper**（`src/control/browser/scripts/browser-runtime.py`，
随构建复制到 `dist`，接管时以 root 写进持久卷并校验 digest）按子命令调用，归属核对与信号都在
helper 内、紧挨着信号发生。

- **状态机**（`src/control/browser/lifecycle.ts`）：`awake / idle / snapshotting / asleep / restoring / error`。
  聚合四类占用：主 turn（整轮同步租约）、观看者（可见面板心跳、TTL 过期）、进行中的浏览器
  HTTP/WS 调用、以及操作者 pin。默认空闲 5 分钟后进入 `snapshotting`。
- **竞态防护**：租约同步预留在任何 `await` 之前；快照后再**重新核对**租约，若中途有新增占用则
  **取消停止**。睡眠与恢复串行且 single-flight，`epoch` 防止迟到的探测覆盖新状态。`status()`
  是纯内存只读，永不唤醒、也不顺延空闲。
- **归属与 fail-closed**：只有 supervisor 与 browser **两处归属都证明成立**、且快照里的 source
  PID/starttime 与实际一致时才允许停止；否则如实报 `stop_unattributed`/`stop_failed` 并且**不动**
  进程。无法确认归属的浏览器报 `browserRunning: null` + `"unknown"`，**绝不**当成“不存在”
  （那会错误地另起一个 Chromium）。真实样本中 Chrome 会把整个命令行 flatten 成单个 NUL token、
  且 root 读不到 `/proc/<pid>/exe`，因此归属判定基于固定 binary 前缀 + profile 独立 token 边界 +
  排除 `--type=` 子进程，并结合 helper PID/PPID/uid/starttime。
- **代理保护**：伴随域的浏览器/CDP/VNC 路径在握手/请求同步预占调用租约，连接结束释放；
  终端、文件、code-server、Jupyter 与普通静态资源**不**保护浏览器。`/api/browser/status`
  是只读轮询。
- **任务保护**：`AgentManager` 在 turn 启动前同步 `reserveTurn()`，在 `finally` 归还，覆盖启动、
  异常、停止与审批等待；`await ready()` 在 `turn.started` 之后执行，恢复失败记录
  `turn.browser_unavailable` 并终止该轮，避免绕过代理的内部浏览器工具使用未恢复的实例。沙箱内 MCP/CLI 绕过控制面，因此第一版
  保守保护**整轮**而不是精确识别浏览器工具的那几秒。
- **快照边界**：保存标签顺序/URL/选中页/滚动/`sessionStorage`，以及 cookies 和当前标签站点的 localStorage/IndexedDB；完整存储导出失败则不停止。恢复是**重建页面**而非保留 JS 堆，先注入按 origin 限定的
  `sessionStorage` 初始化脚本再导航，在创建标签前让 AIO soft 重连，避免重连后的 CDP 枚举打乱索引；最后核对顺序并激活正确标签。不支持/含未提交输入/
  正在下载的页面会**保守拒绝**回收并给出原因；快照失败**绝不**停止浏览器，恢复失败保留快照不报成功。
  只有 `stop` 在发信号前标记为“已释放”的快照才欠恢复（之前的旧快照仍按进程身份判断）；欠恢复期间拒绝保存新快照。
  页面变短到不了原滚动位置、跳到别的 origin（如登录页）只记警告；同一快照连续 3 次恢复都失败的标签放弃并在 `unrestored` 里如实报告，
  恢复照常完成。`wake`/`restore` 的 `--deadline-s` 是整体时间预算，用尽后不再开始新步骤，返回 `deadline_exceeded`，重试接着做；
  `stop` 的 `--timeout-s` 是等待守护进程与浏览器退出的总上限。
  归属不明的进程（本沙箱的 Chromium 会把自己的命令行压成一个 token，root 也读不到 `/proc/<pid>/exe`）
  报 `browserAttribution: "unknown"` 且 `browserRunning: null`，**绝不当成“没有浏览器”**去另起一个；
  读不出内容的标签报 `tab_unresponsive` 而不是伪造原因，命令本身失败也一定返回结构化 JSON 而非堆栈。
- **恢复循环**：30 s runtime recovery 只用只读探测**核对**浏览器状态（离带停止、崩溃、空闲释放），
  绝不把“浏览器睡眠”当成“沙箱离线”去重启容器。

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
  获准使用知识库的运行时另有一条 `aio_kb`，URL 是它自己在成员网关上的能力地址；其他账号的策略里没有这一条。
  app-server 启动参数再次关闭相同入口；现有用户 config、AGENTS 与 Mac 连接配置不覆盖。
  遇到不属于 personal-agent 的 requirements 文件时拒绝覆盖并阻止运行时启动，需人工合并。
  此规则隔离的是 Codex 工具接入；不声称共享账号访问 token 已变为模型专用权限，也不隔离
  用户在沙箱浏览器中主动登录的网站。沙箱 root/自定义客户端仍属于原有可信执行边界。
- 只挂载三个命名卷（工作区、CODEX_HOME、浏览器 profile）；不挂载宿主机 home、
  `/var/run/docker.sock` 或任何 workspace 路径。Docker socket 只在 sandboxd 手里（它不运行用户代码，
  沙箱访问不到它的端口：成员沙箱的出站守卫拒绝私网地址，节点 API 还要令牌）。
- 容器内以 `gem`(uid 1000) 运行；sandboxd 只以固定参数调用 Docker（固定的容器名、
  固定卷名），没有任意宿主机 shell 通道。
- 容器创建前会校验**归属标签**、**镜像**与**卷挂载**，名字被别的容器占用时拒绝接管；
  启动时修正 `/home/gem/.config` 等父目录属主并只重启需要的 supervisord 程序（例如 code-server），
  绝不 `restart all`。
- `BROWSER_NO_SANDBOX=--no-sandbox` 是该镜像在 Docker Desktop 的 Linux VM 里运行 Chromium
  的必要条件（VM 不支持 user namespace），仅影响容器内部浏览器。member 容器同样只带这一个固定参数
  （不继承 owner 的 `PA_SANDBOX_EXTRA_ENV`），隔离边界是容器本身；该参数只在创建容器时生效，
  已有 member 容器需删除后由控制面重建（命名卷保留）。

## 数据与持久化

SQLite（`var/personal-agent.sqlite`，WAL）保存 owner、会话、对话、轮次、事件、审批与票据。
浏览器重连、控制面重启、容器重启都不会丢历史；被中断的轮次带明确状态而不是静默重试。

存储工具使用锁定的 Playwright 1.63.0。导入不用 `setStorageState`：它会先清空整个 HTTP 缓存、注销 service worker，并删除每个 origin 的 localStorage/IndexedDB/OPFS（OPFS 根本没有导出）。profile 里已有 cookie 时只补回缺的 cookie；cookie 为空时补回全部 cookie，并在受管临时页里只写入缺少的 localStorage 键和不存在的 IndexedDB 库，什么都不清空。升级版本须重新验证真实超时清理、启动时存储及标签顺序。受管可执行工具目录及其祖先必须由 root 控制；持久快照和可重建工具分别存放。

## 界面品牌（一站）

配色表达“现在该谁动”：靛紫是 AI 在办（也是品牌主色），琥珀是轮到你（全站唯一醒目的颜色），松绿是办完，朱红是出错；
中性色带一点靛紫。令牌集中在 `src/ui/src/styles.css` 顶部（`--ai` / `--you` / `--done` / `--error` 及 `-soft` 浅底、
`--on-accent` / `--on-you` 按钮文字色），深色为默认，浅色随系统或侧栏切换。任务卡左侧 4px 色条（`turn-ai` / `turn-you` /
`turn-err`；结果卡按完成或失败）、顶部计数胶囊、浏览器卡片和操作面板都只用这四种语义色。标志是一道弧线交出琥珀色圆点
（`src/ui/src/components/Brand.tsx`、`src/ui/public/favicon.svg` 与主屏图标）。

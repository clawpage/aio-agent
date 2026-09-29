# AIO Agent

> Canonical repository: <https://github.com/clawpage/aio-agent>

**AIO Agent** 是一个 owner 管理的 self-hosted 的智能体控制台：每账号一个独立 **AIO Sandbox** 容器，
一个常驻 **Codex** 主智能体，中文 UI，桌面与手机功能对等。它适合个人或受信任的小团队把
Codex + AIO Sandbox 跑在自己的机器上，通过自己的入口访问。

- **账号分级 / self-hosted**：一个 owner 管理配置，可由管理员创建 member 账号；没有注册入口，账号间隔离运行环境，
  也不对外提供公共 demo。
- **Codex + AIO Sandbox**：命令、文件、浏览器、桌面、编辑器、笔记本都发生在容器里；
  控制面只以固定参数调用 Docker，不挂载宿主 home / workspace / `docker.sock`。
- **中文 UI**：登录、对话、审批、配置、工作区全部为中文界面。
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

移动端使用左上角导航按钮打开左侧边栏，不占用底部对话空间；主会话、工作区、配置、主题和退出入口统一放在侧栏。Agent 操作浏览器不会自动展开工作区或切换当前工作区标签；用户可从侧栏手动打开，点击回复中的网页链接仍会打开沙盒浏览器。

消息按浏览器本地时区显示“刚刚 / 几分钟前 / 今天 / 昨天 / 日期”，悬停可查看完整时间。
任务执行中显示实时经过时长，结束后固定为处理用时；不含分配、排队或执行前等待用户补充，
包含执行中的等待确认。没有实际开始记录、或执行结果未知时不推算处理时长。

## 账号与权限

- owner 保留模型、推理强度和 SOUL 配置。member 的主会话和任务列表只显示本账号内容，不能通过任务 ID 读取、引用或停止他人的任务。
- member 的派单和执行均由服务端固定为 `deepseek-v4.1-flash` / `high`；忽略客户端模型参数，桥接不可用时拒绝执行，不回退 GPT。owner 的自动标题机制不会用于 member。
- member 不展示配置入口、模型与推理参数、SOUL 原文；配置/模型/能力清单接口拒绝访问，JSON 与 SSE 隐去模型配置元数据。正常回答内容不会被关键词过滤。
- **账号独立环境**：member 的容器、workspace、Codex 记忆/历史、浏览器 profile、终端、任务数据库、SOUL 和文档缓存独立。owner 沿用原容器与数据卷；新成员不复制 owner 的文件或历史。
- 成员环境默认限制为 2 GiB 内存、2 CPU、1024 个进程，阻止连接内网、宿主服务和其他沙盒；公网仍可访问。网络规则由独立只读守卫容器应用，成员无 NET_ADMIN / NET_RAW 权限。
- member 不接收 owner 的 ChatGPT token 或模型桥管理密钥。独立模型网关仅接受该账号凭据下的无状态 DeepSeek high 请求，禁用历史响应查询；网关监听 `PA_MEMBER_MODEL_PORT`（默认 4902）。
- 每个 member 工作区有独立来源 `<工作区首段>-<账号散列>.<域名>`，需配置对应 DNS、TLS 和 tunnel 路由；控制台仍是统一主域名。域名未配置或环境启动失败时拒绝连接，绝不退回 owner 沙盒。
- 账号配置和登录鉴权由宿主控制面统一管理；容器共享宿主内核，因此这不是抵抗内核漏洞的虚拟机隔离。
- 创建账号（先构建；使用与服务相同的环境变量/数据目录）：`node --env-file=var/runtime.env bin/create-user.mjs <username>`。Quickstart 使用 `.env`。随机密码写入 `var/user-secrets/<username>.txt`（0600），命令不打印密码、不覆盖已有账号，不提供公开注册。

## 主会话的克制追问

派单时，只有缺少无法合理默认的关键条件才会在主会话提问。例如实际查询机票缺目的地或日期，
会一次问齐缺少的条件；一般旅行建议、灵活日期探索，以及预算、风格等可选偏好不会触发问卷。
问题显示为“等待你补充”，不启动子任务、不占执行名额或共享资源。直接在主输入框回答或补充，
主会话会结合待回答的问题和任务上下文自动接回原任务，无需点击按钮或选择任务；无关请求继续独立执行。部分回答只追问仍阻塞的条件。
问题与回答持久保存，刷新或服务重启后仍可继续；答案足够后只启动原任务一次。

普通聊天、身份介绍和可直接回答的问题默认在对话中完整回复，不创建任务目录或额外生成文件。工具仅用于回答所需的事实或操作；只有需要独立文件交付时才进入制作与验证流程。

阅读型交付物按内容选择格式：普通文字与简单表格可用 Markdown；复杂排版、图表或交互优先用适配手机的 HTML 页面。用户指定的格式优先。HTML 文件卡片默认展示页面，可切换源码、下载原文件；隔离预览支持内嵌样式和脚本，不加载外部网络资源或读取主站登录状态。

## 它是什么

```
浏览器 ─> agent.clawpage.ai ────────┐   控制台：对话流、工具进度、审批、停止、重连、历史
浏览器 ─> agent-workspace.clawpage.ai ┤   工作区：AIO 全部界面与 REST/WS 表面（同样需要登录）
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

## 一个主会话，多个任务

主页面只有一个对话入口。新请求创建持久化任务，由独立 Codex 线程执行；相关补充自动加入原任务。任务运行时
仍可继续发消息，默认最多 **3 个执行任务并行**，超出的任务等待空位。执行过程默认收拢为
状态条，开始执行时附一段不超过 100 字的整体说明，只生成一次，后续过程不反复刷新；点击可查看详情。结果按完成时间回报到主会话，支持文件卡片、预览与下载。

- 主派单器使用 `PA_TITLE_MODEL`（默认 `gpt-6-luna`，派单固定 high），判断任务标题、相关背景、
  前置依赖及共享资源；只做分类，不执行用户任务。子任务使用配置页的模型，提交时冻结模型设置。
- 每项任务提供“引用任务”：选择后输入框显示引用目标，可取消或切换；提交成功清除，失败保留引用、草稿和重试消息 ID。人工指定优先于模型：进行中或待补充的任务直接追加；已结束的任务复用原执行 conversation，调用 Codex `thread/resume` 保留完整上下文继续，同一执行会话的轮次串行。新的用户消息和结果独立记录，旧结果不会被覆盖；引用旧结果时若该会话已有后续任务在执行，补充到当前轮次。停止中的任务先等停止完成；尚未创建执行线程的任务首次执行才会创建线程。派单模型不能把人工引用改指其他任务。未引用时，普通跟进仍由派单器结合最近任务自动识别。
  地址、条件、纠正以及同一交付物的新增要求会直接追加到运行中的原子任务，只保留一条运行状态和最终回报。
  如果原任务恰好已结束，补充会作为带原结果背景的后续任务处理；送达状态不明时提示核对，不自动重发。
  必须依赖前置结果的任务等前置成功才执行；失败或未知结果不会被假定成功。
- 普通聊天、文字或文件任务不等待浏览器恢复；只有派单资源包含浏览器的任务才检查恢复状态。任务中途追加浏览器操作时也会先核对就绪，再送达补充；恢复失败不会中断原本的非浏览器工作。
- 共享浏览器仍按任务互斥。文件使用 `read:绝对路径` / `write:绝对路径`：不同目录、同目录只读可并行；父子路径重叠且含写操作才等待。路径在沙盒内解析 realpath，同时保留原路径以覆盖符号链接别名；解析失败退回保守工作区锁。`workspace` 保留给全局安装、共享环境变更、范围未知的写操作及旧任务。
- 新 PPT、文档等使用预装工具在 `workspace/tasks/<task-id>/` 生成，默认不申请共享工作区锁；服务端自动保护该任务目录和附件读路径。临时文件与 LibreOffice 配置也使用任务独立目录。前端区分文件冲突、浏览器、前置任务、并发空位等等待原因。
- 资源范围从派发持有到任务结束，补充需要扩大范围时先等冲突释放；旧任务资源不会自动缩窄。这是单控制面调度和执行指令层的协作约束，**不是每任务独立容器、文件权限隔离或分布式锁**。执行者不得通过新符号链接、全局配置或遗留后台写入绕过声明范围。
- 每个任务可以单独停止。重试发送用同一消息 ID 去重；派单失败尚未执行，可重试分配。
  执行结果未知不自动重跑，重启后的在途任务会明确提示先核对，避免重复副作用。
- 沙盒内 Codex 命令默认完整访问且不请求审批（`approval_policy=never`）；新建、恢复、派生线程和每次执行均显式设置。权限仅作用于容器，不开放 Mac 宿主机或解除 MCP 隔离。其他需要用户输入的交互仍保留；缺少必要信息时用户在主会话继续作答。
- 最终回复以个人助理的方式给出结果、建议和文件链接；skill、工具、命令等实现细节留在过程详情，保留来源和必要限制。
- 主界面不提供旧会话历史入口；任务结果保留在主会话中，任务过程可单独查看。相关补充归入原任务后，进行中卡片跟随最新补充消息，只保留一张，操作仍指向原任务。
- 登录页会重新验证 HttpOnly 会话 cookie；有效时自动进入主会话。页面返回前台、Safari 恢复页面或网络恢复时自动重查，登录页可见期间每 15 秒重试。网络故障不会清除凭据；过期或已撤销会话仍需要登录。登录态请求跳过缓存。
- 配置页「助理设定 · SOUL.md」可编辑个人助理身份、语气和行为。原文保存在控制面的 `var/SOUL.md`（自定义 `PA_DATA_DIR` 时在对应目录），权限 0600，不进入 Git、不暴露给沙盒写入。内容通过 Codex `developerInstructions` 系统层字段原样注入主会话规划及所有子任务执行线程的新建、resume、fork（owner/member 均适用）；不拼进普通用户消息。下次规划/启动/继续任务时读取最新内容，保存不打断当前轮次。支持清空（显式清除旧设定），最大 64 KiB，多设备编辑冲突会拒绝覆盖并保留草稿。模型目录暂不可用时仍可独立保存。
- 侧边栏「任务列表」共用主会话的实时状态源，优先展示待补充和执行中任务；点击进入任务详情并可返回列表，分页加载更早任务，主会话草稿保持不变。追问以“需要你补充”强调卡片展示，仍直接在主输入框回答。

终端页使用紧凑会话选择器，点击可切换到对应 session 并恢复原终端输出；支持新建、复制完整 ID、刷新与关闭指定会话。关闭运行中的会话会先提示，关闭当前会话后选择剩余会话，全部关闭时显示空状态，不自动创建新会话。切换标签或隐藏页面不会关闭 session。底层 Shell 会话仍属于受信任成员共享环境。

## 会话文件卡片与文档工具

对话里智能体提到的**工作区文件**（Markdown 文件链接、Markdown 图片引用、上传附件）会直接
渲染成文件卡片，不必再手动进工作区找：

- **图片**：卡片带懒加载缩略图，点开看大图。
- **MP4 视频**：会话卡片、附件与工作区文件共用原生播放器，支持播放/暂停、进度拖动和手机内联播放；通过鉴权后的字节范围流加载，不把整个视频放进内存。编码不受浏览器支持时可重试或下载原文件。
- **PDF / Word / Excel / PowerPoint**：在沙箱内转换成分页 raster 图片预览（页码、翻页、
  截断提示），**原文件仍可下载**。
- **Markdown**：默认排版阅读，支持标题、列表、表格、引用和链接，可切换原文；卡片优先展示链接中的文档标题。
- **其他文本／代码**：以转义后的纯文本展示（有大小上限），HTML、SVG 不作为网页执行。
- **其他格式**：明确说明「可下载」，不会假装能预览。
- 预览失败、转换失败、文件已删除都会给出可恢复的提示与重试，不显示成功空白。

工作区里的「文件」标签页统一承担目录导航、上传、新建、预览、下载、文本编辑与删除；对可转换格式的文件行还提供
「转换」入口（紧凑面板，可取消/执行，结果可预览下载），工具就绪状态收在底部默认折叠的「文档处理」里。
「终端」页显示 AIO 当前存活的 Shell session ID、运行/空闲状态和工作目录，可复制 ID；仅在页面可见时每 5 秒刷新，切换页面即停止读取，不创建或终止任何 session。命令已完成但仍存活的 session 标为“空闲”，列表读取失败会明确提示。
智能体侧可以在沙箱内**创建、修改、转换**文档（Word/Excel/PPT 用 Python 库，
格式转换与 PDF 用 LibreOffice），例如「把这个 Word 转成 PDF」「新建一个 Excel 并算总和」。

支持的转换目标：`pdf`、`docx`、`xlsx`、`pptx`、`csv`、`txt`、`odt`、`ods`、`odp`、`html`。

> **文档工具需要沙箱内系统依赖**（LibreOffice、poppler-utils、中文字体、Python 文档库），
> 不是 `npm ci` 带来的。缺失时 UI 会如实显示未就绪并提供「安装/修复」，不会让聊天服务无法启动。
> 安装/修复与重建后的处理见[运行手册](docs/RUNBOOK.md)。

所有解析与转换都发生在沙箱容器内，控制面只以固定 argv 调用固定容器命令；路径先经工作区范围
校验（拒绝越界、symlink 逃逸、选项注入），图片/文本与 MP4 预览均需鉴权；MP4 还验证容器头并保留 Range/206/416 语义，
下载主动内容一律 `attachment`。转换结果写成**新文件**，绝不覆盖原文件。

## 浏览器内存生命周期（空闲释放与按需恢复）

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
- 存储工具从锁定的 `playwright-core@1.63.0` 离线构建并安装到 root 管理的 `/opt/aio-browser`，不下载浏览器；快照独立保存在持久卷。

> 控制面从不让浏览器为「读状态」而保持运行，也不会把「进程归属未知」当成「浏览器不存在」
> （那会错误地另起一个 Chromium）：无法确认归属时按保守策略处理并如实显示。

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
| `npm test` | 未登录绕过、会话过期/轮换/吊销与已建立连接被关闭、Host/Origin/CSRF 校验、重定向安全、代理 HTTP 与 WebSocket（对假沙箱）、事件回放与 delta 顺序、重复提交与跨会话冲突、停止语义、未知结果不重放、shell 支撑的文件操作只报真实结果、自动标题（首轮一次性、手动优先、失败保留、替换守卫、旧会话补名、超时后迟到事件隔离）、会话生命周期（空标题复用、重命名/恢复默认标题冲突 409、无删除接口）、沙箱浏览器标签 URL 校验、**浏览器生命周期**（状态机竞态/多观看者 TTL/任务租约单飞/快照失败不停止/恢复 single-flight/归属未知 fail-closed/状态轮询不唤醒、浏览器 API 鉴权+CSRF+注销清理、代理只保护 browser/CDP/VNC 且拒绝时释放租约） |
| `python3 tests/unit/browser-runtime.test.py` | 容器内受管 helper 的纯函数与安全边界：真实 flattened cmdline 归属、`unknown` 不等于 `absent`、快照 schema/原子 0600、精确 PID/starttime 校验后才停、按 origin 限定且在导航前注入 `sessionStorage`、AIO soft 重连与激活 index、错误脱敏 |
| `npm run smoke` | 真实 HTTPS 登录与 cookie 属性、模型列表、一次性票据（重放与开放重定向）、伴随站会话与跨源续期、经鉴权的 shell 调用、上传与列目录、跨源写入拒绝、原生界面可达、未登录时各表面一律 401、**真实 WebSocket 升级**（已登录 101 / 未登录 401） |
| `npx playwright test` | 登录界面（错误密码与正确密码）、对话页输入区不含任何模型/思考控件、统一配置页默认选中 GPT-6-Sol（桌面侧栏与手机底导航入口）、打开工作区后立刻切标签的竞态、连续切换最终落在最后点击的标签、真实文件列表与 code-server 可达、无横向溢出 |
| `npx playwright test --config playwright.local.config.ts` | 会话文件卡片与统一预览（图片缩略图/分页翻页/下载/失败重试/360px 无溢出）、工作区「文件」唯一入口/上传/目录导航/转换/迟到结果不跳目录、本地假后端（默认 `dist/web`，可用 `PA_TEST_WEB_ROOT` 指向 scratch 构建 + 全部 `/api` 由 `page.route` mock）：会话 `⋯` 菜单/重命名/归档/恢复且无删除、失败重命名保留输入、运行态与 `prefers-reduced-motion`、Markdown 链接只进沙箱浏览器（`mailto:`/相对链接保持不可导航）、归档行标题不可点、统一配置页保存/刷新持久化/跨会话生效/失败反馈/无模型列表时禁用保存/返回会话保留草稿、活动段混排（文本/活动多段次序、当前条唯一且置底、段独立展开且增量不重置、迟到日志回原段、空占位不切段、状态行在活动段之上）、默认收起/点击与键盘展开收起/终态停动画/审批露出/长历史展开自然高度（段自身不滚动）与行可达（桌面 1440×900，手机 390/360 含 WebKit，短视口与暗亮无溢出） |
| 人工/父端验收 | VNC 桌面帧流、浏览器 CDP 帧流、手机 390/360 实际交互与截图 |

`npm run smoke` 会读取 `var/owner-secret.txt`（或用 `PA_OWNER_SECRET_FILE` 指定）。

## 配置

所有参数通过 `PA_*` 环境变量提供，见 [`.env.example`](.env.example)；生产覆盖写入
`var/runtime.env`（git 忽略）。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_PORT` / `PA_BIND` | `4891` / `127.0.0.1` | 控制面监听地址 |
| `PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST` | 源码默认 `agent.clawpage.ai` / `agent-workspace.clawpage.ai`（当前部署） | **生产使用者必须覆盖**为自己的两个精确域名；`.env.example` 用 `agent.example.com` / `workspace.example.com` 占位 |
| `PA_TRUST_CF_CONNECTING_IP` | `0` | 仅当请求确实经由自己可信的反向代理（会覆盖 `CF-Connecting-IP`）时才设为 `1`；否则限速可被伪造头绕过 |
| `PA_SANDBOX_IMAGE` | `ghcr.io/agent-infra/sandbox:1.11.0` | 固定镜像，升级需人工确认 |
| `PA_SANDBOX_CODEX_VERSION` | `0.156.1` | 沙箱内固定版 Codex CLI（在持久卷里，升级见运行手册） |
| `PA_DEFAULT_MODEL` | `gpt-6-sol` | 未在统一配置页另选时的默认模型；配置页的模型/思考强度保存于 owner `meta`，对之后所有消息生效，提交时按 turn 冻结 |
| `PA_AUTO_TITLE` | `1` | 首轮完成后自动命名会话；只用首条用户消息，失败保留“新会话” |
| `PA_TITLE_MODEL` / `PA_TITLE_EFFORT` | `gpt-6-luna` / `low` | 只用于自动标题的隔离临时线程（read-only、never、ephemeral） |
| `PA_TITLE_MAX_CHARS` | `24` | 生成标题的最大字符数 |
| `PA_MAX_CONCURRENT_TURNS` | `3` | 跨会话同时执行的主 turn 上限（取值 clamp 到 1–3）；同一会话始终串行，排队 FIFO |
| `PA_REASONING_SUMMARY` | `concise` | 主 turn 的思考摘要模式（`concise`/`auto`/`detailed`/`none`），不展示原始思维链 |
| `PA_OPENCODE_GO_ENABLED` | `auto` | 是否列出 OpenCode Go 桥模型；`auto` 仅在有密钥时出现，另有 `on`/`off` |
| `PA_OPENCODE_GO_BASE_URL` | `http://host.docker.internal:4017/v1` | 沙箱内可达的 LiteLLM Responses 桥地址 |
| `PA_OPENCODE_GO_MODELS` | `deepseek-v4.1-flash,mimo-v2.6-pro` | 桥模型 id 列表（逗号分隔），决定选择器里出现哪些桥模型 |
| `PA_OPENCODE_GO_MODEL`（兼容旧配置） | 空 | 设置则只列出这一个桥模型，优先级高于 `PA_OPENCODE_GO_MODELS` |
| `PA_OPENCODE_GO_PROVIDER_ID` | `opencode_go` | 注入 Codex 的 provider id（与 `~/.codex/opencode-go.config.toml` 保持一致） |
| `PA_OPENCODE_GO_SECRETS_FILE` / `PA_OPENCODE_GO_ENV_KEY` | `~/.config/codex-opencode-go/secrets.env` / `LITELLM_MASTER_KEY` | 密钥来源（环境变量优先，其次该文件；权限宽于 600/400 拒绝） |
| `PA_SANDBOX_PORT` | `18081` | 沙箱发布到 loopback 的端口 |
| `PA_OWNER_PASSWORD` | 空 | 设置则用它，否则生成到 `var/owner-secret.txt` |
| `PA_BROWSER_LIFECYCLE` | `1` | 浏览器空闲释放总开关；关闭则浏览器始终常驻 |
| `PA_BROWSER_IDLE_SECONDS` | `300` | 无占用后释放浏览器的空闲时长（下限 30 秒） |
| `PA_BROWSER_VIEWER_TTL_SECONDS` | `60` | 观看心跳租约有效期（下限 10 秒）；到期即释放 |
| `PA_BROWSER_DIRTY_INPUT_POLICY` | `block` | 页面有未提交输入时 `block`（保守拒绝释放）/`warn` |

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
- 沙箱里的 Codex CLI 不是镜像自带的那份，而是持久卷内固定版本（默认 `0.156.1`），
  控制面接管容器时核实/补齐，失败会明确报错而不是回退旧版；升级见运行手册。
- 只有本机 loopback 明文调试时才允许非 Secure cookie；公网一律 `Secure`。

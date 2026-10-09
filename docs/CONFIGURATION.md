# AIO Agent 配置参考

控制层与沙箱层的参数都通过 `PA_*` 环境变量提供，界面层 edge 与部署脚本使用 `AIO_*`。

- 三个 Node 进程方式：仓库根目录的 `.env`（由 [`.env.example`](../.env.example) 复制），启动时以 `node --env-file=.env` 读取。
- `bin/serve` 守护：读取 `var/runtime.env`（git 忽略），`PA_DEPLOY=host|compose` 选择三个宿主进程或 Docker Compose。
- Docker Compose：`deploy/aio.env`（见 [deploy/README.md](../deploy/README.md)），控制面的 `PA_*` 写入 `AIO_CONTROL_ENV_FILE` 指向的文件。

下表默认值即源码默认值。

## 网络与入口

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_PORT` / `PA_BIND` | `4892` / `127.0.0.1` | 控制层监听地址 |
| `PA_UI_PORT` | `4891` | 界面层端口（本机开发时允许 `localhost:<端口>` 作为控制台来源） |
| `AIO_UI_PORT` / `AIO_CONTROL_URL` / `AIO_WORKSPACE_ORIGIN` | `4891` / `http://127.0.0.1:4892` / 空 | 界面层 edge 的监听端口、控制面地址、允许嵌入的工作区来源（CSP） |
| `PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST` | `agent.clawpage.ai` / `agent-workspace.clawpage.ai` | 控制台与工作区的精确域名。**自行部署必须覆盖**；`.env.example` 使用 `agent.example.com` / `workspace.example.com` 占位 |
| `PA_LEGACY_PRIMARY_HOST` | 空 | 旧主站域名，设置后只跳转到新主站 |
| `PA_ALLOWED_HOSTS` / `PA_PRIMARY_ORIGINS` / `PA_WORKSPACE_ORIGINS` | 空 | 在两个精确域名之外额外放行的 Host、控制台来源与工作区来源（逗号分隔） |
| `PA_TRUST_CF_CONNECTING_IP` | `0` | 仅当请求确实经过会覆盖 `CF-Connecting-IP` 的可信反向代理时设为 `1`，否则限速可被伪造头绕过 |
| `PA_ALLOW_INSECURE_LOOPBACK_COOKIES` | `1` | 仅 localhost 明文访问时允许不带 `Secure` 的 cookie |
| `PA_MEMBER_MODEL_PORT` | `4902` | 成员模型网关端口（沙箱经 `host.docker.internal` 回连） |

## 账号与会话

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_DATA_DIR` | `var/` | 运行数据目录 |
| `PA_DB_PATH` / `PA_OWNER_SECRET_PATH` | `<数据目录>/personal-agent.sqlite` / `<数据目录>/owner-secret.txt` | 数据库与 owner 明文密码文件 |
| `PA_OWNER_PASSWORD` | 空 | 设置则使用它，否则首次启动生成到 `owner-secret.txt` |
| `PA_INVITE_EMAIL` | 空 | 注册页显示的邀请码申请邮箱 |
| `PA_SESSION_TTL_HOURS` / `PA_SESSION_RENEW_MINUTES` | `720` / `60` | 登录会话有效期与续期间隔 |
| `PA_TICKET_TTL_SECONDS` | `60` | 工作区一次性票据有效期 |
| `PA_LOGIN_MAX_FAILURES` / `PA_LOGIN_WINDOW_MINUTES` / `PA_LOGIN_LOCKOUT_MINUTES` | `5` / `15` / `15` | 同一 IP 密码或邀请码错误次数、统计窗口与锁定时长 |

## 模型与执行器

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_HOST_CODEX` | `on` | 是否从本机 Codex 登录取 ChatGPT 凭据；`off` 时 owner 只能使用 Claude Code。compose 中由 `AIO_HOST_CODEX` 控制，默认 `off` |
| `PA_HOST_CODEX_BIN` / `PA_HOST_CODEX_HOME` | `codex` / `~/.codex` | 本机 Codex CLI 与登录目录 |
| `PA_HOST_CODEX_TIMEOUT_SECONDS` / `PA_HOST_TOKEN_SKEW_HOURS` | `10` / `6` | 取凭据超时；令牌剩余不足多少小时提前刷新 |
| `PA_DEFAULT_MODEL` | `gpt-6-sol` | 配置页未另选时的默认模型；配置保存在 owner `meta`，按轮次冻结 |
| `PA_TITLE_MODEL` | `gpt-6.1-sol` | Codex 执行器时派单器的临时线程模型；`gpt-6.1-sol` 与 `gpt-6-luna` 用 low，其他 high（变量名沿用旧称） |
| `PA_MAX_CONCURRENT_TURNS` | `3` | 同时执行的轮次上限（clamp 到 1–3），同一会话串行，排队 FIFO |
| `PA_REASONING_SUMMARY` | `concise` | 思考摘要模式（`concise` / `auto` / `detailed` / `none`） |
| `PA_SANDBOX_CODEX_VERSION` | `0.160.0` | 沙箱内固定版 Codex CLI（持久卷内，升级见运行手册） |
| `PA_CLAUDE_CODE_ENABLED` | `auto` | 是否提供 Claude Code 执行器；`auto` 仅在取到凭据时出现，另有 `on` / `off` |
| `PA_CLAUDE_CODE_SECRETS_FILE` | `~/.config/aio-agent/claude-code.env` | `CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_API_KEY`（环境变量优先；权限宽于 600 / 400 拒绝） |
| `PA_CLAUDE_CODE_VERSION` | `2.1.284` | 沙箱内固定版 Claude Code CLI |
| `PA_CLAUDE_CODE_AUX_MODEL` | `claude-sonnet-5-5` | Claude Code 执行器时派单使用的无工具模型 |
| `PA_ANTHROPIC_API_BASE_URL` | `https://api.anthropic.com` | 成员网关转发 Claude 请求的上游 |
| `PA_CHATGPT_CODEX_URL` | `https://chatgpt.com/backend-api/codex` | 成员网关转发 GPT 请求与出图的上游 |

## 沙箱与节点

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_SANDBOX_NODES` | `local=http://127.0.0.1:4894` | 控制面驱动的沙箱节点（`名字=地址`，逗号分隔）；已有账号留在原节点，新账号放到剩余内存最多的节点 |
| `PA_SANDBOX_NODE_TOKENS_FILE` | `var/sandbox-node.env` | 节点令牌：先按节点名取，取不到用 `AIO_SANDBOX_NODE_TOKEN` |
| `PA_SANDBOXD_PORT` / `PA_SANDBOXD_BIND` / `PA_SANDBOXD_TOKEN_FILE` | `4894` / `127.0.0.1` / 无 | sandboxd 监听地址与节点令牌文件 |
| `PA_SANDBOXD_IMAGES` | `ghcr.io/agent-infra/sandbox:1.11.0` | sandboxd 允许的沙箱镜像 |
| `PA_SANDBOXD_MEMORY` | `2g` | 新建沙箱容器的内存上限（已有容器用 `docker update` 修改） |
| `PA_SANDBOXD_CONTAINER_HOST` | `127.0.0.1` | sandboxd 访问沙箱发布端口的地址；在 Docker Desktop 容器中为 `host.docker.internal` |
| `PA_SANDBOXD_GATEWAY_UPSTREAM` | 空 | 控制面在其他机器时，sandboxd 把沙箱的网关请求中继过去（配合 `PA_SANDBOXD_GATEWAY_BIND/PORT`） |
| `PA_SANDBOXD_ADD_HOST_GATEWAY` | `0` | 给新沙箱添加 `host.docker.internal`（Linux Docker 需要） |
| `PA_SANDBOX_IMAGE` | `ghcr.io/agent-infra/sandbox:1.11.0` | 固定镜像，升级需人工确认 |
| `PA_SANDBOX_PORT` | `18081` | owner 沙箱发布到 loopback 的端口 |
| `PA_SANDBOX_USER` | `gem` | 沙箱内运行用户代码的账号 |
| `PA_SANDBOX_WORKSPACE_VOLUME` / `PA_SANDBOX_CODEX_VOLUME` / `PA_SANDBOX_BROWSER_VOLUME` | `personal-agent-workspace` / `-codex` / `-browser` | owner 沙箱的三个命名卷（改名会丢数据） |
| `PA_SANDBOX_READY_TIMEOUT_SECONDS` | `180` | 等待沙箱就绪的上限 |
| `PA_PROXY_CONNECT_TIMEOUT_SECONDS` | `30` | 工作区代理连接沙箱的超时 |
| `PA_FILE_OP_TIMEOUT_SECONDS` | `30` | 工作区文件操作超时 |
| `PA_DOC_TEXT_MAX_KB` | `256` | 文本 / HTML 内联预览上限 |

## 空闲回收

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_SANDBOX_RELEASE_IDLE` / `PA_MEMBER_SANDBOX_RELEASE_IDLE` | `0` / `1` | 空闲时是否停止 owner / 成员的整个沙箱容器 |
| `PA_SANDBOX_IDLE_SECONDS` | `300` | 沙箱不在用且控制台不在前台多久后停容器（下限 60） |
| `PA_RESIDENT_MEMBERS` | 空 | 容器与浏览器都常驻并随服务启动的成员用户名，逗号分隔 |
| `PA_BROWSER_LIFECYCLE` | `1` | 浏览器空闲释放总开关 |
| `PA_BROWSER_RELEASE_IDLE` / `PA_MEMBER_BROWSER_RELEASE_IDLE` | `0` / `1` | 空闲时是否释放 owner / 成员的浏览器 |
| `PA_BROWSER_IDLE_SECONDS` | `300` | 浏览器无占用后释放的时长（下限 30） |
| `PA_BROWSER_VIEWER_TTL_SECONDS` | `60` | 观看心跳租约有效期（下限 10） |
| `PA_BROWSER_DIRTY_INPUT_POLICY` | `block` | 页面有未提交输入时 `block`（拒绝释放）或 `warn` |

## 浏览器

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_BROWSER_TIMEZONE` | `America/Los_Angeles` | 部署时区：沙箱浏览器、定时任务、用量统计与智能体进程的时钟都用它；应与出口网络所在地一致 |
| `PA_BROWSER_BUILD` | `on` | 是否使用控制面下发的较新 Chromium；`off` 用镜像自带浏览器 |
| `PA_BROWSER_BUILD_ARCH` | `aarch64` | 启用较新 Chromium 的架构 |
| `PA_BROWSER_BUILD_PACKAGES` | 内置 | 替换 Chromium 包（逗号分隔的 `url#sha256`） |

## 可选功能

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_DAILY_FEED` | `1` | 为每个账号内置每日推送 |
| `PA_ASR_URL` | 空 | 语音输入的识别服务；为空则不显示麦克风按钮 |
| `PA_JEV_SECRETS_FILE` | `~/.config/aio-agent/jev.env` | `TYPESAFE_API_KEY`（环境变量优先）；缺失则不提供 Jev |
| `PA_JEV_ENDPOINT` / `PA_JEV_MODEL` | `https://api.typesafe.ai/v1/systemone` / `jev-latest` | Jev 接口与模型 |
| `PA_JEV_TIMEOUT_SECONDS` / `PA_JEV_DISPATCH_TIMEOUT_SECONDS` | `30` / `15` | `decide` 工具与派单评分的等待上限 |
| `PA_KB_MCP_URL` | 空 | 宿主上知识库 MCP 服务地址；为空则不提供 |
| `PA_KB_MCP_SECRETS_FILE` | `~/.config/aio-agent/kb-mcp.env` | `KB_MCP_TOKEN`（环境变量优先） |
| `PA_KB_MCP_MEMBERS` | 空 | 获准使用知识库的成员，逗号分隔；owner 始终可用 |
| `PA_HA_MCP_URL` | 空 | Home Assistant MCP Server 地址；为空则不提供 |
| `PA_HA_MCP_SECRETS_FILE` | `~/.config/aio-agent/ha-mcp.env` | `HA_MCP_TOKEN`（HA 长期访问令牌，环境变量优先） |
| `PA_HA_MCP_ACCOUNTS` | 空 | 获准操作 Home Assistant 的用户名（owner 也需列出） |
| `PA_PRINTER_URI` | 空 | 网络打印机的 `ipp://` 或 `ipps://` 地址；为空则不提供打印 |
| `PA_PRINTER_ACCOUNTS` | 空 | 获准使用打印机的用户名（owner 也需列出） |
| `PA_PHONE_BRIDGE_URL` | 空 | owner 手机桥接（`bin/phone-bridge.mjs`）地址，如 `http://127.0.0.1:4903`（compose 用 `http://host.docker.internal:4903`）；为空则不提供 |
| `PA_PHONE_BRIDGE_SECRETS_FILE` | `~/.config/aio-agent/phone-bridge.env` | `PHONE_BRIDGE_TOKEN`（环境变量优先）；控制面与桥接共用 |
| `PA_PHONE_BRIDGE` | 空 | `var/runtime.env` 中设为 `1` 时 `bin/serve` 同时运行手机桥接（宿主进程） |
| `PA_PHONE_BRIDGE_PORT` / `PA_PHONE_BRIDGE_BIND` | `4903` / `127.0.0.1` | 桥接监听地址 |
| `PA_PHONE_SERIAL` | 空 | 指定 adb 设备序列号；为空时用唯一已连接的设备 |
| `PA_ADB` | 自动 | adb 路径；默认按 `ANDROID_HOME`、`~/Library/Android/sdk/platform-tools` 查找 |
| `PA_PHONE_DIR` | `var/phone` | 桥接的 mobile-mcp 与 scrcpy server 安装目录 |
| `PA_GADGET_TOKEN_PATH` | `<数据目录>/gadget-token.env` | 语音配件令牌与绑定账号 |
| `PA_GADGET_USAGE_URL` | 空 | 配件「用量」页数据地址；为空则接口返回 404 |
| `PA_GADGET_FIRMWARE_DIR` | `<数据目录>/gadget-firmware` | 配件无线升级固件目录 |

标注「环境变量优先」的密钥文件，权限宽于 600 / 400 时拒绝读取。

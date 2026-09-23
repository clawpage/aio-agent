# personal-agent

私有个人智能体：**Codex + AIO Sandbox**，一个 owner、一个常驻沙箱、一个常驻主智能体，
中文控制台，桌面与手机功能对等。公网只通过专用 Cloudflare tunnel 暴露两个精确域名：

- 控制台（登录、对话、审批、历史）：<https://agent.zymx.tech>
- 伴随工作区（终端 / 桌面 / 浏览器 / 编辑器 / 笔记本 / 接口）：<https://agent-workspace.zymx.tech>

> 两个域名都要求本人登录（未登录一律 401）。没有注册入口，也不对外提供服务。

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
- **统一登录**：不在沙箱里重新登录。控制面从 Mac 上已有 `codex login` 通过官方方法
  `account/read {refreshToken:true}` + `getAuthStatus` 取访问 token，只把访问 token 交给沙箱
  （refresh token 永不离开 Mac）；沙箱 401 时由控制面按需重新取。
- **持久化**：工作区、CODEX_HOME、浏览器 profile 各一个命名卷；控制面重启、容器重启、
  浏览器断线都不丢历史。断线不会中断智能体，重连自动补齐事件。

## 快速开始

```bash
cd projects/personal-agent
npm install
npm run build            # 构建前端 + 服务端
npm test                 # 单元 + 集成测试（无需 Docker）
npm run typecheck
```

本机运行（不经过 tunnel）：

```bash
PA_BIND=127.0.0.1 PA_PORT=4891 node dist/server/index.js
# 首次启动会生成 owner 密码到 var/owner-secret.txt（0600，git 忽略，从不写日志）
curl -s http://127.0.0.1:4891/healthz
```

浏览器打开 `http://localhost:4891`（主站；本地开发中 `127.0.0.1:4891` 是伴随站，
两者是不同来源，跨站规则与线上一致）。

生产路径（由 workspace 的统一 launcher 管理）：

```bash
tools/start.sh start personal-agent      # 或 restart / stop / status
```

## 验收（分四层，各层职责不同）

```bash
npm test                 # 1) vitest 单元 + 集成（自带假沙箱，不需要 Docker/网络）
npm run smoke            # 2) 对已部署实例的真实 HTTP + WebSocket 冒烟（默认公网）
npx playwright test      # 3) 真实浏览器 UI（桌面 1440×900 + 手机 390×844）
PA_PRIMARY_ORIGIN=http://localhost:4891 \
PA_COMPANION_ORIGIN=http://127.0.0.1:4891 npm run smoke     # 对本地实例冒烟
```

| 层 | 覆盖 |
| --- | --- |
| `npm test`（104 项） | 未登录绕过、会话过期/轮换/吊销与已建立连接被关闭、Host/Origin/CSRF 校验、重定向安全、代理 HTTP 与 WebSocket（对假沙箱）、事件回放与 delta 顺序、重复提交与跨会话冲突、停止语义、未知结果不重放、shell 支撑的文件操作只报真实结果 |
| `npm run smoke`（33 项） | 真实 HTTPS 登录与 cookie 属性、模型列表、一次性票据（重放与开放重定向）、伴随站会话与跨源续期、经鉴权的 shell 调用、上传与列目录、跨源写入拒绝、原生界面可达、未登录时各表面一律 401、**真实 WebSocket 升级**（已登录 101 / 未登录 401） |
| `npx playwright test` | 登录界面（错误密码与正确密码）、新会话模型选择器默认选中 GPT-6-Sol（桌面与手机）、打开工作区后立刻切标签的竞态、连续切换最终落在最后点击的标签、真实文件列表与 code-server 可达、无横向溢出 |
| 人工/父端验收 | VNC 桌面帧流、浏览器 CDP 帧流、手机 390/360 实际交互与截图 |

`npm run smoke` 会读取 `var/owner-secret.txt`（或用 `PA_OWNER_SECRET_FILE` 指定）。

## 配置

所有参数通过 `PA_*` 环境变量提供，见 [`.env.example`](.env.example)；生产覆盖写入
`var/runtime.env`（git 忽略）。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PA_PORT` / `PA_BIND` | `4891` / `127.0.0.1` | 控制面监听地址 |
| `PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST` | `agent.zymx.tech` / `agent-workspace.zymx.tech` | 两个精确域名 |
| `PA_TRUST_CF_CONNECTING_IP` | `1`（生产） | 仅在专用 tunnel 之后开启，否则限速可被伪造头绕过 |
| `PA_SANDBOX_IMAGE` | `ghcr.io/agent-infra/sandbox:1.11.0` | 固定镜像，升级需人工确认 |
| `PA_SANDBOX_CODEX_VERSION` | `0.156.1` | 沙箱内固定版 Codex CLI（在持久卷里，升级见运行手册） |
| `PA_DEFAULT_MODEL` | `gpt-6-sol` | 新会话与旧会话后续轮次的默认模型 |
| `PA_SANDBOX_PORT` | `18081` | 沙箱发布到 loopback 的端口 |
| `PA_OWNER_PASSWORD` | 空 | 设置则用它，否则生成到 `var/owner-secret.txt` |

## 文档

- [运行手册](docs/RUNBOOK.md)：启停、健康、日志、凭据、tunnel/DNS、故障处理
- [架构与安全边界](docs/ARCHITECTURE.md)：两个来源、会话与 CSRF、执行模型、token 边界
- [AIO 能力清单](docs/AIO-CAPABILITIES.md)：按固定镜像实测的 140 个接口与原生界面入口
- [项目规范](AGENTS.md)

## 已知限制

- JupyterLab 首次加载会出现 `Shared module @jupyter-widgets/base doesn't exist in shared scope`
  的第三方 widget 前端告警；内核执行本身正常（`/v1/jupyter/execute` 实测返回 stdout）。
- 沙箱镜像固定不自动升级；升级步骤见运行手册（需人工确认并复验浏览器与编辑器）。
- 沙箱里的 Codex CLI 不是镜像自带的那份，而是持久卷内固定版本（默认 `0.156.1`），
  控制面接管容器时核实/补齐，失败会明确报错而不是回退旧版；升级见运行手册。
- 只有本机 loopback 明文调试时才允许非 Secure cookie；公网一律 `Secure`。

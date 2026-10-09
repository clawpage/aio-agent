# 一站 · AIO Agent

> Canonical repository: <https://github.com/clawpage/aio-agent>

AIO Agent 是一个自托管的个人智能体控制台。每个账号拥有独立的
[AIO Sandbox](https://github.com/agent-infra/sandbox) 容器与常驻的 Codex 智能体：你在一个中文主会话里提出请求，
智能体在沙箱中使用终端、文件、浏览器、编辑器与笔记本完成任务，并把结果回报到对话中。桌面与手机功能对等。

它面向个人或受信任的小团队，部署在自己的机器上、通过自己的域名访问，不提供公共 demo。

## 特性

- **一个主会话，多个任务**：请求自动派发为并行执行的任务，相关补充追加到原任务；支持追问、引用、停止与断线续传。
- **独立沙箱**：每个账号一个容器、独立数据卷与浏览器；沙箱不挂载宿主目录或 Docker socket，成员网络与资源受限。
- **人机协作的浏览器**：标签页按任务归属，可随时接管；登录、支付等关键步骤交还给人，密码器代填凭据且不暴露给模型。
- **多执行器**：默认 Codex（ChatGPT 登录），可切换 Claude Code；成员使用管理员分配的模型，凭据只留在宿主侧。
- **丰富的结果呈现**：图文混排、商品与地图卡片、SVG / Mermaid 图、Office 与 PDF 预览、公开分享网页。
- **自动化**：定时与循环任务、每日推送、手机通知（Web Push）、语音输入与语音配件。
- **可选集成**：知识库 MCP、Home Assistant、邮件、Jev 决策、AI 出图。
- **三层可分离部署**：界面、控制、沙箱各自一个镜像，可同机或分机运行，上线前与运行时都校验版本兼容。

完整行为说明见 [功能说明](docs/FEATURES.md)。

## 架构

```
Browser ── console host ──> ui (:4891) ── /api ──┐
Browser ── workspace host ───────────────────────┴─> control (:4892, gateway :4902)
                                                        │  node protocol + token
                                                        v
                                                     sandboxd (:4894) ── Docker
                                                        │
                                                        v
                                                     per-account sandbox container
                                                     (Codex / Claude Code, browser, terminal, editor, notebook)
```

| 层 | 代码 | 职责 |
| --- | --- | --- |
| 界面 | `src/ui` | React 中文控制台；`edge.mjs` 提供静态文件并把 `/api` 原样转给控制层 |
| 控制 | `src/control` | 账号与鉴权、任务与派单、智能体会话、工作区代理、成员模型网关；不直接访问 Docker |
| 沙箱 | `src/sandbox` | sandboxd：按校验过的参数管理沙箱容器，只提供固定操作，每个请求都需节点令牌 |
| 共享 | `src/common` | 节点协议、兼容版本号、日志与密钥读取 |

控制台与工作区是两个不同来源，都要求登录；AI 生成的内容只出现在工作区来源。设计细节见 [架构与安全边界](docs/ARCHITECTURE.md)。

## 快速开始

### Docker Compose（推荐）

只需要 Docker。三个镜像一条命令起齐：

```bash
git clone https://github.com/clawpage/aio-agent.git && cd aio-agent
cp deploy/aio.env.example deploy/aio.env      # 填写域名等设置
node deploy/aio.mjs init                      # 生成节点令牌
node deploy/aio.mjs build                     # 构建三个镜像
node deploy/aio.mjs up                        # 校验兼容后启动，等待全部健康
```

模型登录、多机部署、升级与备份见 [部署文档](deploy/README.md)。

### 宿主机进程

前置条件：Node.js ≥ 24、Docker，以及模型凭据——已登录的 Codex CLI（`codex login`），或 Claude Code 凭据
（`PA_CLAUDE_CODE_SECRETS_FILE`）并设置 `PA_HOST_CODEX=off`。

```bash
git clone https://github.com/clawpage/aio-agent.git && cd aio-agent
npm ci
cp .env.example .env
npm run build
mkdir -p var && printf 'AIO_SANDBOX_NODE_TOKEN=%s\n' "$(openssl rand -hex 32)" > var/sandbox-node.env && chmod 600 var/sandbox-node.env

PA_SANDBOXD_TOKEN_FILE=var/sandbox-node.env node dist/sandbox/index.js &   # 沙箱层 :4894
node --env-file=.env dist/control/index.js &                                # 控制层 :4892
node src/ui/edge.mjs                                                        # 界面层 :4891
```

首次启动会把 owner 密码写入 `var/owner-secret.txt`（0600）。本机访问：

- 控制台：<http://localhost:4891>
- 工作区：<http://127.0.0.1:4892>

```bash
curl -s http://127.0.0.1:4892/healthz   # 控制层（compatible 表示能驱动沙箱节点）
curl -s http://127.0.0.1:4891/healthz   # 界面层
```

公网部署时，必须把 `PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST` 设为自己的两个域名（`.env.example` 中为占位值）。

## 账号

- 一个 owner 负责配置；member 由管理员用 `bin/create-user.mjs` 创建，或凭 owner 生成的一次性邀请码注册。
- 每个账号的任务、对话、沙箱、浏览器与数据库相互隔离；member 固定使用管理员分配的模型（`bin/set-user-model.mjs`），看不到配置与模型信息。
- 地址按账号区分：控制台 `/u/<用户名>`，工作区 `<工作区域名>/u/<用户名>/`。

详见 [功能说明 · 账号与权限](docs/FEATURES.md#3-账号与权限)。

## 安全模型

- 运行用户代码的沙箱从不挂载宿主 home、workspace 或 `docker.sock`；只有不运行用户代码的 sandboxd 持有 Docker，并只以固定参数调用。
- 模型凭据留在宿主：控制面只向沙箱提供访问 token 或按账号的网关能力地址，refresh token 与 owner 凭据不进入沙箱。
- 沙箱内 Codex 关闭 Apps、插件与远程插件，MCP 只允许受管策略中的精确地址。
- 控制台与工作区分属不同来源，cookie 独立；所有写操作校验 Origin 与 CSRF，未登录请求一律 401（公开分享页除外）。
- 容器共享宿主内核，这不是虚拟机级隔离。

## 开发

```bash
npm run typecheck && npm test   # 提交前必跑；测试自带假沙箱，无需 Docker
npm run build                   # 修改前端或服务端后重新构建
```

开发模式、测试分层与验收要求见 [开发与测试](docs/DEVELOPMENT.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [功能说明](docs/FEATURES.md) | 各功能的产品行为与实现要点 |
| [配置参考](docs/CONFIGURATION.md) | 全部环境变量与默认值 |
| [部署](deploy/README.md) | 三层镜像、Docker Compose、多机、版本兼容、数据卷 |
| [架构与安全边界](docs/ARCHITECTURE.md) | 两个来源、会话与 CSRF、执行模型、token 边界 |
| [运行手册](docs/RUNBOOK.md) | 现有部署的启停、健康检查、凭据、故障处理 |
| [开发与测试](docs/DEVELOPMENT.md) | 本地开发、测试分层、验收要求 |
| [AIO 能力清单](docs/AIO-CAPABILITIES.md) | 固定沙箱镜像的接口与原生界面 |
| [移动端 App](src/ui/tauri/README.md) | iOS / Android 外壳（Tauri 2） |
| [项目规范](AGENTS.md) | 贡献与维护约束 |

## 已知限制

- 只在 macOS + Docker Desktop 上完整验证；Linux 需要额外网络设置（见部署文档）。
- 控制面为单实例。
- 沙箱镜像固定为 `ghcr.io/agent-infra/sandbox:1.11.0`，不自动升级；沙箱内 Codex CLI 是持久卷中的固定版本，升级步骤见运行手册。
- JupyterLab 首次加载会出现第三方 widget 的前端告警，内核执行不受影响。

## 兼容说明

项目早期名为 personal-agent。为保留既有容器、卷、数据库与登录状态，以下运行时标识保持不变：容器名 `personal-agent-sandbox`、
命名卷 `personal-agent-workspace` / `-codex` / `-browser`、数据库文件 `personal-agent.sqlite`、cookie 前缀 `pa_` 与环境变量前缀 `PA_`。

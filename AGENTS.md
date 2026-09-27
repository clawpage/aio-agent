# AIO Agent 项目规范

本文件是仓库自包含的项目规范，不依赖仓库外的任何文件。公开使用者只需读本文件。

## 项目定位

**AIO Agent**：single-owner、self-hosted 的智能体控制台 + 常驻 AIO 沙箱 + 常驻主 Codex 智能体，
中文 UI。用户只操作一个主会话，每条消息委派到独立子任务；旧会话保留只读历史。不是多租户服务，没有注册入口，不对外提供公共 demo；未登录一律 401。
公网入口（`PA_PRIMARY_HOST` / `PA_WORKSPACE_HOST`）由使用者自行填写，见 `.env.example` 的
`agent.example.com` / `workspace.example.com` 占位。

**兼容保留的运行时标识**：容器名 `personal-agent-sandbox`、命名卷
`personal-agent-workspace` / `-codex` / `-browser`、SQLite 文件名 `personal-agent.sqlite`、
cookie 名 `pa_*` 与 `PA_*` 前缀**保持不变**——它们承载既有容器、卷、数据库与登录状态，改名会
丢数据或中断服务。health `service` 字段与 Codex `clientInfo.name` 的旧值仅为兼容已有集成保留，
不是品牌。品牌层（包名、页面标题、侧栏、文档）为 AIO Agent。

## 目录与职责

| 路径 | 内容 |
| --- | --- |
| `src/server/` | Node 控制面：配置、SQLite、鉴权、HTTP/WS 代理、Docker 生命周期、Codex 桥接 |
| `src/web/` | React + Vite 中文前端（构建产物 `dist/web`） |
| `tests/unit/`、`tests/integration/` | vitest；集成测试自带假沙箱，不需要 Docker |
| `tests/e2e/live-smoke.mjs` | 对已部署实例的真实冒烟（`npm run smoke`） |
| `bin/serve` | 生产守护：Node 服务 + 专用 tunnel 两个子进程，转发信号 |
| `bin/dns-agent.py` | 现有部署专用的 DNS 辅助脚本：依赖仓库外的 `tools/linode-local/dns.py`，**不是 quickstart 入口**，公开使用者通常不需要 |
| `var/` | 运行时数据（DB、日志、owner 凭据、tunnel 凭据），全部 git 忽略 |
| `docs/` | 运行手册、架构、能力清单 |

## 必须遵守

1. **凭据**：`var/owner-secret.txt` 是唯一可读的 owner 明文密码（0600，git 忽略，绝不写日志、
   绝不进 URL 或 localStorage）。**不要重置已运行的数据库或密码**；确需轮换用
   `PA_OWNER_PASSWORD_RESET=1` 一次性执行，并明确告知用户新位置。
2. **镜像与容器**：镜像版本固定；容器创建参数里包含归属标签、镜像与卷校验，名字被别的容器
   占用时拒绝接管。升级镜像属于单独任务，需人工确认并复验浏览器、编辑器、笔记本、终端。
3. **不接受宿主机能力桥接**：不挂载 Mac 的 home、workspace 或 `docker.sock`；控制面只以固定
   参数调用 Docker，不提供任意宿主机 shell 通道。
4. **两个来源**：主站与伴随站必须保持不同来源；不要把 AIO 生成内容放到主站上，也不要为了
   本地调试放宽 cookie 安全属性（localhost 明文是唯一例外）。
5. **DNS**：只允许维护 `agent.zymx.tech` 与 `agent-workspace.zymx.tech` 两条记录；不得运行
   `tools/linode-local/dns.py` 的 plan/apply/rollback（那是另一条迁移线）。
6. **停止语义要诚实**：排队/执行中/启动中的停止分别处理，不得谎报已停止；连接中断导致的
   未知结果标记 `unknown` 并提示先核对，不自动重放有副作用的操作。
7. **事件顺序**：任何非 delta 事件落库前先冲刷 delta 缓冲，避免客户端重复文本。

## 常用命令

```bash
npm run typecheck && npm test      # 提交前必跑
npm run build                      # 改前端或服务端后必须重新构建
npm run smoke                      # 对已部署实例真实冒烟
# 以下为现有部署的可选管理方式（非公开安装必需）：
tools/start.sh restart personal-agent
docker exec personal-agent-sandbox supervisorctl status          # 沙箱内服务
docker exec -u root personal-agent-sandbox supervisorctl start code-server   # 只启单个程序
```

## 运行与验证约束

- 公开安装/自托管路径：`npm ci && cp .env.example .env && npm run build &&
  node --env-file=.env dist/server/index.js`（详见 README Quickstart），不依赖仓库外脚本。
- 现有部署（本仓库最初的使用者）可选地继续用 workspace 根 `tools/start.sh` 管理；
  `bin/serve` 会在 `dist` 早于 `src/server` 时拒绝启动，避免用旧构建验收。
- 修改 UI 后要用真实浏览器验桌面（1440×900）与手机（390×844、360 宽）；`HTTP 200 不等于可用`。
- 沙箱相关改动要在真容器上验证（健康接口会检查 terminal / code-server / Jupyter 三个表面）。
- 重启只针对本服务（现有部署）：`tools/start.sh restart personal-agent`，不要重载全局 supervisor，
  也不要重启其他项目或共享容器。
- DNS：`bin/dns-agent.py` 只允许维护现有部署的两个精确 CNAME；不得运行
  `tools/linode-local/dns.py` 的 plan/apply/rollback（那是另一条迁移线）。

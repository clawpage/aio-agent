# personal-agent 项目规范

先读 workspace 根 [AGENTS.md](../../AGENTS.md)。本文只写本项目的边界与专属约束。

## 项目定位

单 owner 的私有智能体：中文控制台 + 常驻 AIO 沙箱 + 常驻主 Codex 智能体。
公网入口只有两个精确域名（`agent.zymx.tech`、`agent-workspace.zymx.tech`），未登录一律 401。

## 目录与职责

| 路径 | 内容 |
| --- | --- |
| `src/server/` | Node 控制面：配置、SQLite、鉴权、HTTP/WS 代理、Docker 生命周期、Codex 桥接 |
| `src/web/` | React + Vite 中文前端（构建产物 `dist/web`） |
| `tests/unit/`、`tests/integration/` | vitest；集成测试自带假沙箱，不需要 Docker |
| `tests/e2e/live-smoke.mjs` | 对已部署实例的真实冒烟（`npm run smoke`） |
| `bin/serve` | 生产守护：Node 服务 + 专用 tunnel 两个子进程，转发信号 |
| `bin/dns-agent.py` | 只创建/检查两个精确 CNAME 的有界脚本 |
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
npm run smoke                      # 部署后真实冒烟
tools/start.sh restart personal-agent
docker exec personal-agent-sandbox supervisorctl status          # 沙箱内服务
docker exec -u root personal-agent-sandbox supervisorctl start code-server   # 只启单个程序
```

## 运行与验证约束

- 生产必须走 `tools/start.sh`；`bin/serve` 会在 `dist` 早于 `src/server` 时拒绝启动，
  避免用旧构建验收。
- 修改 UI 后要用真实浏览器验桌面（1440×900）与手机（390×844、360 宽）；`HTTP 200 不等于可用`。
- 沙箱相关改动要在真容器上验证（健康接口会检查 terminal / code-server / Jupyter 三个表面）。
- 重启只针对本服务：`tools/start.sh restart personal-agent`，不要重载全局 supervisor，
  也不要重启其他项目或共享容器。

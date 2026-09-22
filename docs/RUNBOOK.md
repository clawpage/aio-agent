# personal-agent 运行手册

面向运维与故障处理。安全模型与设计理由见 [架构与安全边界](ARCHITECTURE.md)。

## 1. 服务组成

| 组件 | 说明 | 入口 |
| --- | --- | --- |
| workspace launcher | 统一服务管理 | `tools/start.sh start\|restart\|stop\|status personal-agent` |
| 项目守护 `bin/serve` | 守护 Node 服务 + 专用 tunnel，转发 SIGTERM | `projects/personal-agent/bin/serve` |
| Node 控制面 | SPA、`/api`、SSE、AIO 代理 | `127.0.0.1:4891` |
| 专用 tunnel | 只发布两个精确域名 | `var/cloudflared/config.yml` |
| 沙箱容器 | AIO 1.11.0，随容器重启策略 `unless-stopped` | `personal-agent-sandbox`，loopback `18081` |

PID 在 `.pids/personal-agent.pid`（即 `bin/serve`），日志在 `.logs/personal-agent.log`
（守护）与 `projects/personal-agent/var/logs/*.log`（应用、tunnel 各自独立）。

## 2. 日常操作

```bash
# 状态（只读 pidfile；running 不代表被守护，见下方“崩溃恢复验证”）
tools/start.sh status personal-agent

# 定点重启本服务（不要重载全局 supervisor）
tools/start.sh restart personal-agent

# 停止
tools/start.sh stop personal-agent

# 健康：ready 需要 dependenciesReady && servicesReady && agentReady 同时为真
curl -s http://127.0.0.1:4891/healthz
# {"ok":true,"dependenciesReady":true,"servicesReady":true,"agentReady":true,"ready":true,...}

# 公网两处入口
curl -s -o /dev/null -w '%{http_code}\n' https://agent.zymx.tech/                 # 200 登录页
curl -s -o /dev/null -w '%{http_code}\n' https://agent-workspace.zymx.tech/terminal  # 401（未登录）
```

`ready` 的语义：`dependenciesReady` = 沙箱健康 + 宿主机 Codex 登录有效 + 原生表面
（terminal / code-server / Jupyter）可达；`servicesReady` = 三个表面都返回 <500；
`agentReady` = 沙箱内 Codex 会话已建立。详细分解在登录后的 `/api/status`（含 `sandbox.surfaces`）。

## 3. 构建与升级

```bash
cd projects/personal-agent
npm run typecheck && npm test
npm run build                      # 必须先构建，bin/serve 会拒绝启动早于 src 的 dist
tools/start.sh restart personal-agent
npm run smoke
```

**沙箱镜像升级**（单独任务，需人工确认）：
1. 记录当前镜像与 digest；2. `docker pull` 目标版本并在**临时容器名**下验证
   `/health`、`code-server`、`jupyter`、`vnc`、`aio browser`；3. 更新 `PA_SANDBOX_IMAGE`
   （写入 `var/runtime.env`）；4. 停掉本服务、删除旧容器（三个命名卷保留）、重新
   `tools/start.sh start personal-agent` 让控制面按新镜像重建；5. 复验 `npm run smoke`
   与一次真实浏览器/文件任务；6. 更新 README 与本文档中的版本号。

## 4. 凭据

- owner 密码：`var/owner-secret.txt`（0600，明文，方便本人查看；git 忽略；从不写日志）。
  **不要**删除或重置已运行实例的密码。确需轮换：
  ```bash
  PA_OWNER_PASSWORD_RESET=1 node dist/server/index.js   # 生成新密码并覆盖 secret 文件；Ctrl-C 结束
  tools/start.sh restart personal-agent
  ```
  轮换后旧密码立即失效。
- 沙箱 Codex 登录由 Mac 上已有 `codex login` 提供；失效时 `/healthz.ready=false`，
  控制台顶部显示明确提示，恢复方式是在 Mac 上重新 `codex login`，无需改配置。
- tunnel 凭据：`var/cloudflared/credentials.json`（0600）。不要复制到别处或提交。

## 5. Tunnel 与 DNS

- 专用 tunnel 名 `personal-agent`，ID `384645fd-a428-4df6-a84b-e392c6e0df2d`；
  配置 `var/cloudflared/config.yml`，ingress 只列两个 hostname，最后一条默认 404。
- DNS 只有两条记录，由有界脚本维护：
  ```bash
  python3 bin/dns-agent.py check    # 只读，逐条核对类型/目标/proxied
  python3 bin/dns-agent.py create   # 缺失才创建；已指向别处会拒绝覆盖并打印
  ```
  **不要**运行 `tools/linode-local/dns.py` 的 plan/apply/rollback（不属于本项目）。

## 6. 故障处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `bin/serve` 拒绝启动并提示 dist 过期 | 改了 `src/server` 没重新构建 | `npm run build:server` 后再启动 |
| `/healthz.ready=false` 且 `servicesReady=false` | 沙箱内某程序未运行 | `docker exec personal-agent-sandbox supervisorctl status`；对失败程序单独 `supervisorctl start <prog>`，**不要** `supervisorctl restart all` |
| code-server 反复 `EACCES mkdir '/home/gem/.config/code-server'` | 挂载卷导致 `/home/gem/.config` 变为 root 属主 | 控制面启动时会修正属主；手工修：`docker exec -u root personal-agent-sandbox chown -R 1000:1000 /home/gem/.config /home/gem/.local/share/code-server` 然后只 `supervisorctl start code-server` |
| 终端/VNC/Jupyter 502 | 沙箱未就绪或刚被重启 | 看 `/healthz` 与容器状态；控制面每 30 s 自动重试接管容器与 Codex |
| 智能体不回话、`agentReady=false` | 宿主机 Codex 登录失效 | 在 Mac 上 `codex login`，再 `tools/start.sh restart personal-agent` |
| 登录提示会话过期 | 会话被吊销或超过 TTL | 重新登录即可；客户端每 15 分钟自动续期并轮换 token |
| 手机端外链工作区要求再次登录 | 跨来源 cookie 在部分浏览器被拦截 | 用「新标签页打开」按钮；或回到控制台重新点开工作区 |

## 7. 崩溃恢复验证（唯一可靠方式）

```bash
SERVE=$(cat .pids/personal-agent.pid)
CHILD=$(pgrep -P "$SERVE" -f 'dist/server/index.js' | head -1)
kill -9 "$CHILD"                        # 守护应在 ~3s 后拉起新子进程
sleep 6 && pgrep -P "$SERVE" -f 'dist/server/index.js'
curl -s http://127.0.0.1:4891/healthz   # 应恢复 ready:true
grep -E 'exited code|started pid' .logs/personal-agent.log
```

登录密码、会话数据、工作区文件都应保持；沙箱容器不受影响。全局 supervisor 不会被触碰。

## 8. 数据与备份

| 数据 | 位置 | 备份价值 |
| --- | --- | --- |
| 对话、事件、会话、票据 | `var/personal-agent.sqlite`（含 `-wal`/`-shm`） | 高（历史与登录态） |
| 工作区文件 | docker volume `personal-agent-workspace` | 高 |
| Codex 会话状态 | docker volume `personal-agent-codex` | 中 |
| 浏览器 profile | docker volume `personal-agent-browser` | 低 |
| owner 密码 | `var/owner-secret.txt` | 高（丢失需重置） |
| tunnel 凭据 | `var/cloudflared/credentials.json` | 高 |

备份 SQLite 时先 `docker`/服务停止或用 `sqlite3 .backup`，避免复制到半写状态的 WAL。

## 9. 已知限制

- 未实现自动滚动升级镜像；升级需人工按第 3 节执行。
- 编辑器/笔记本等原生界面依赖浏览器 iframe 与第三方 cookie 策略；不支持内嵌时用新标签页打开。
- Playwright 桌面/手机自动化用例尚未落地，UI 回归目前靠人工 + `npm run smoke`。

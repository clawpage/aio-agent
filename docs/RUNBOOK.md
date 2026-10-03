# AIO Agent 运行手册

面向运维与故障处理。安全模型与设计理由见 [架构与安全边界](ARCHITECTURE.md)。

## 1. 服务组成

当前部署（2026-10-02）在当前 Mac 以 Docker Compose 运行界面与控制层，沙箱层及全部用户沙箱
在 Intel Mac `old-mb` 上运行。`var/runtime.env` 里 `PA_DEPLOY=compose`，当前机设置在
`var/deploy/aio.env` 与 `var/deploy/control.env`；节点配置与迁移回退见 [Intel 远程沙箱部署](REMOTE-SANDBOX-MAC.md)。

| 组件 | 说明 | 入口 |
| --- | --- | --- |
| workspace launcher | 统一服务管理（launchd 下的守护会在几秒内拉起被停掉的服务） | `/Users/mengxiao/workspace/tools/start.sh start\|restart\|stop\|status personal-agent` |
| 项目守护 `bin/serve` | 运行 `deploy/aio.mjs run`（校验镜像 → `compose up -d --wait` → 跟随日志，SIGTERM 时 `compose stop`）+ 专用 tunnel | `projects/personal-agent/bin/serve` |
| 界面层 `aio-ui-1` | 控制台静态文件 + `/api` 原样转给控制层 | `127.0.0.1:4891`（主站入口） |
| 控制层 `aio-control-1` | API、SSE、伴随站代理、成员网关；数据在当前机卷 `aio-control-data`；无 Docker 访问；控制面 Codex 登录开启，支持分配 GPT 的成员 | `127.0.0.1:4892`（伴随站入口）、网关 `127.0.0.1:4902` |
| 沙箱层 `ai.aio.sandboxd` | old-mb 上的 Node/launchd 服务，持有该机 Docker 访问 | 本机 `127.0.0.1:4894`，经 Tailscale Serve 提供 `100.80.219.88:4894` |
| 专用 tunnel | 主站 → 4891，伴随站与旧域名 → 4892 | `var/cloudflared/config.yml` |
| 沙箱容器 | old-mb 上的 AIO 1.11.0 amd64，现有四个用户各 4 GiB 上限，重启策略 `unless-stopped`，不是 compose 服务 | `personal-agent-sandbox`（节点 loopback 18081）、`aio-user-<散列>` |

PID 在 `.pids/personal-agent.pid`（即 `bin/serve`）。日志：`.logs/personal-agent.log`（守护）、
`var/logs/personal-agent.log`（三层容器的合并日志流）、`docker logs aio-control-1` 等。
下文的 `docker exec personal-agent-sandbox ...` 等用户容器命令须在 old-mb 执行；控制面命令仍在当前机执行。

`PA_DEPLOY=host`（默认）是不用镜像的另一种运行方式：`bin/serve` 起三个宿主进程（sandboxd :4894、控制层 :4892、
界面层 :4891），数据在 `var/`，节点令牌 `var/sandbox-node.env` 自动生成。

## 2. 日常操作

```bash
# 状态（只读 pidfile；running 不代表被守护，见下方“崩溃恢复验证”）
/Users/mengxiao/workspace/tools/start.sh status personal-agent

# 定点重启本服务（不要重载全局 supervisor）
/Users/mengxiao/workspace/tools/start.sh restart personal-agent

# 停止
/Users/mengxiao/workspace/tools/start.sh stop personal-agent

# 健康：ready 需要 dependenciesReady && servicesReady && agentReady 同时为真；compatible = 能驱动沙箱节点
curl -s http://127.0.0.1:4892/healthz
# {"ok":true,"dependenciesReady":true,"servicesReady":true,"agentReady":true,"ready":true,"compatible":true,...}
curl -s http://127.0.0.1:4891/healthz       # 界面层：控制层提供它需要的 API 版本
cd projects/personal-agent && AIO_ENV_FILE=var/deploy/aio.env node deploy/aio.mjs ps

# 公网两处入口
curl -s -o /dev/null -w '%{http_code}\n' https://agent.clawpage.ai/                 # 200 登录页
curl -s -o /dev/null -w '%{http_code}\n' https://agent-workspace.clawpage.ai/terminal  # 401（未登录）
```

`ready` 的语义：`dependenciesReady` = 沙箱健康 + 宿主机 Codex 登录有效 + 原生表面
（terminal / code-server / Jupyter）可达；`servicesReady` = 三个表面都返回 <500；
`agentReady` = 沙箱内 Codex 会话已建立。详细分解在登录后的 `/api/status`（含 `sandbox.surfaces`）。

## 3. 构建与升级

```bash
cd projects/personal-agent
npm run typecheck && npm test
npm run build                      # host 模式需要；bin/serve 会拒绝启动早于 src 的 dist
node deploy/aio.mjs build          # compose 模式：重建三个镜像（只改了某层时可只建那层）
AIO_ENV_FILE=var/deploy/aio.env node deploy/aio.mjs check
/Users/mengxiao/workspace/tools/start.sh restart personal-agent   # 先确认没有进行中的任务
# npm run smoke 默认只打本地；当前部署要对公网冒烟必须显式给出两个 origin：
PA_PRIMARY_ORIGIN=https://agent.clawpage.ai \
PA_COMPANION_ORIGIN=https://agent-workspace.clawpage.ai npm run smoke
```

**沙箱 Codex CLI 版本**（与镜像分开固定）：模型可用性由 CLI 版本决定，固定镜像里的旧 CLI
（`codex-cli 0.139.0`）无法运行 `gpt-6-sol`。因此控制面不调用 `PATH` 上的 `codex`，而是调用持久卷里的
固定版本：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `PA_SANDBOX_CODEX_VERSION` | `0.160.0` | 固定版本；安装前缀与二进制路径都由它推导，不会与路径不一致 |
| `PA_DEFAULT_MODEL` | `gpt-6-sol` | 新会话与旧会话后续轮次的默认模型；`/api/models` 也以它标记默认项 |
| `PA_TITLE_MODEL` | `gpt-6-luna` | 主会话派单器（Codex 执行器时）的临时线程模型，派单固定 high / 90 秒；变量名沿用旧称 |

- 二进制路径：`/home/gem/.codex/tools/codex-<版本>/node_modules/.bin/codex`（在 `personal-agent-codex` 卷内）。
- 每次接管容器时控制面会核实版本；缺失或版本不符时用
  `npm install --prefix <前缀> @openai/codex@<版本>` 以 `gem` 用户补齐，不改动固定镜像。
  补齐失败会明确报错并保持 `/healthz.ready=false`，**不会**静默回退到镜像里的旧 CLI。
- 升级步骤：改 `PA_SANDBOX_CODEX_VERSION`（写 `var/runtime.env`）→ `npm run build` → 定点重启服务。
  先用独立 `CODEX_HOME` 验证 `model/list` 与一次真实 turn，再让生产使用；旧版本目录保留，
  把版本改回去即可回退。
- 默认模型迁移：服务启动时若 `meta.model_default_migration_v1` 不存在，会把仍为旧默认
  `model='gpt-5.5'` 的会话改为 `PA_DEFAULT_MODEL`（只改 `model` 列，不动历史消息与线程），
  并写入该 meta 键。迁移只跑一次，之后用户手动选择 5.5 不会被重置。风险场景（需恢复旧默认）：
  删掉该 meta 行并重启会再跑一次，会同时把用户手动选择的 5.5 一起改掉，只在明确需要时使用。

**沙箱文档工具（会话预览 + 智能体创建/转换）**：

工具装在**持久工具目录** `/home/gem/.codex/tools/aio-doc`（不在镜像里，卷保留即保留），
分两层：root 只做系统包与目录权限，gem 用户建 venv 并安装 Python 库。

**推荐：在工作区「文件」页底部展开「文档处理」，点「安装/修复」**。它会先把控制面当前源码里的脚本
部署进沙箱，再依次跑 root 层与用户层安装，fresh/新重建环境最可靠。

也可以在**项目根目录**手工执行等价的两步（`cd` 到本仓库根再运行）：

```bash
# 只读就绪检查（不改任何东西）
docker exec -u gem personal-agent-sandbox \
  bash /home/gem/.codex/tools/aio-doc/scripts/provision.sh check /home/gem/.codex/tools/aio-doc

# root 层：apt 装 libreoffice / poppler-utils / 中文字体 / python3-venv。
# root 脚本必须以受信任的 stdin 传入当前源码仓的内容，绝不执行 gem 可写的沙箱内脚本
# （否则被入侵的 gem 账号就能改变 root 执行的东西）。故用 `bash -s -- <tool_dir> gem`
# 加 `docker exec -i` 重定向；注意在项目根目录执行：
docker exec -i -u root personal-agent-sandbox \
  bash -s -- /home/gem/.codex/tools/aio-doc gem \
  < src/control/documents/scripts/install-root.sh

# 用户层：venv + python-docx/openpyxl/python-pptx/pypdf/reportlab（gem 自己的脚本，可读路径执行）
docker exec -u gem personal-agent-sandbox \
  bash /home/gem/.codex/tools/aio-doc/scripts/provision.sh install /home/gem/.codex/tools/aio-doc
```

两步都幂等、可重复执行；已就绪时走 fast path，只刷新 CLI，不跑 apt/pip。

- 控制面每次启动会**非阻塞**同步一次工具脚本（含已发布的 `bin/aio-doc`），只做 digest 比对
  与写文件，不跑 apt/pip，不会拖慢聊天启动；失败只记日志。
- **重建/换新沙箱后系统包要重装**：venv 在持久卷里会保留，但 apt 系统包（LibreOffice、
  poppler、字体）属于容器层，随容器重建消失，需重新执行上面的 root 层安装，再跑一次就绪检查。
- 智能体侧的用法说明写在沙箱内 `/home/gem/.codex/skills/aio-documents/SKILL.md` 与
  `/home/gem/.codex/tools/aio-doc/bin/aio-doc --help`（未加 PATH，用绝对路径）；技能文件由控制面在新沙箱启动时写入（既有沙箱的 AGENTS.md 不会被覆盖）。
- 转换在独立 LibreOffice profile 下运行（禁宏、不自动更新外链、限制时长/页数/并发），
  输出为新文件，不覆盖原件；不做 100% 保真承诺（字体与 LO 复杂特性可能有差异）。

**沙箱镜像升级**（单独任务，需人工确认）：
1. 记录当前镜像与 digest；2. `docker pull` 目标版本并在**临时容器名**下验证
   `/health`、`code-server`、`jupyter`、`vnc`、`aio browser`；3. 更新 `PA_SANDBOX_IMAGE`
   （写入 `var/runtime.env`）；4. 停掉本服务、删除旧容器（三个命名卷保留）、重新
   `/Users/mengxiao/workspace/tools/start.sh start personal-agent` 让控制面按新镜像重建；5. 复验 `npm run smoke`
   与一次真实浏览器/文件任务；6. 更新 README 与本文档中的版本号。

## 4. 凭据

创建受信任普通成员（构建后，使用同一生产环境配置）：

```bash
node --env-file=var/runtime.env bin/create-user.mjs <username>           # host 模式
docker exec aio-control-1 node bin/create-user.mjs <username>          # compose 模式（密码写在卷内 /data/user-secrets/）
```

账号固定 member，随机密码只写 `var/user-secrets/<username>.txt`（0600）；重复执行拒绝覆盖。
没有注册入口，不改变 owner 密码与会话。member 固定 DeepSeek high，因此上线前需确认 OpenCode Go 桥接可用。
member 首次访问或服务启动时创建独立 `aio-user-<散列>` 容器及三卷，数据存在控制层数据目录的 `users/<散列>/`；owner 原卷保留。
成员工作区与 owner 共用 `agent-workspace.clawpage.ai`，用路径 `/u/<散列>/` 区分账号，无需新增 CNAME/TLS/tunnel；前缀与会话账号不符时 401，不会回退 owner 工作区。
成员模型网关仅监听无状态 DeepSeek 请求，以及分配了模型的成员的 Claude Messages / `gpt-6.1-sol` Responses 请求（默认端口 4902，owner 凭据只在宿主侧附加），凭据按账号存放 `var/users/<散列>/model-token`，不可公开。网络守卫镜像 `aio-agent-network-guard:1` 从固定沙箱镜像构建，独立只读运行并只授予 NET_ADMIN。
运行验收必须包括：两个账号的同名文件互不可见；任务/HTTP/WS 指向各自容器；成员不能 TCP 连接 owner 容器与宿主私网服务；成员卷没有 owner auth.json/记忆；成员无法读取 owner 历史响应。


- owner 密码：`var/owner-secret.txt`（0600，明文，方便本人查看；git 忽略；从不写日志；compose 模式下卷内
  `/data/owner-secret.txt` 是生效的那份）。**不要**删除或重置已运行实例的密码。compose 模式确需轮换：在
  `var/deploy/control.env` 临时加 `PA_OWNER_PASSWORD_RESET=1`，重启一次，看到 “owner password rotated” 后删掉这行
  再重启，并用 `docker exec aio-control-1 cat /data/owner-secret.txt` 更新 `var/owner-secret.txt`。host 模式轮换：
  ```bash
  /Users/mengxiao/workspace/tools/start.sh stop personal-agent                       # 必须先停，避免第二个进程争用端口与数据库
  cd /Users/mengxiao/workspace/projects/personal-agent     # 用绝对路径，避免相对路径找不到 start.sh
  PA_OWNER_PASSWORD_RESET=1 node dist/control/index.js      # 生成新密码、覆盖 secret 文件并吊销全部旧会话
  # 看到 “owner password rotated” 后 Ctrl-C 结束
  /Users/mengxiao/workspace/tools/start.sh start personal-agent
  ```
  轮换会同时撤销所有已登录会话，旧密码与旧 cookie 立即失效。
- host 模式下沙箱 Codex 登录由 Mac 上已有 `codex login` 提供；失效时 `/healthz.ready=false`，
  控制台顶部显示明确提示，恢复方式是在 Mac 上重新 `codex login`，无需改配置。compose 模式不用 Codex 登录
  （`PA_HOST_CODEX=off`）：owner 走 Claude Code（`~/.config/aio-agent/claude-code.env` 只读挂载进控制层），
  不提供 ChatGPT 模型。
- compose 模式的凭据都是只读挂载的原文件（`var/deploy/aio.env` 的 `AIO_SECRET_*`），镜像里不含密钥。
- tunnel 凭据：`var/cloudflared/credentials.json`（0600）。不要复制到别处或提交。

## 5. Tunnel 与 DNS

- 专用 tunnel 名 `personal-agent`，ID `384645fd-a428-4df6-a84b-e392c6e0df2d`；
  配置 `var/cloudflared/config.yml`，ingress 列出两个正式 hostname，另保留旧主站的跳转入口，最后一条默认 404。
- 正式入口为 `agent.clawpage.ai`，工作区为 `agent-workspace.clawpage.ai`。设置
  `PA_LEGACY_PRIMARY_HOST=agent.zymx.tech` 后，旧入口仅跳转新主站，不接受 API 写入。
  域名变更后需在新域名重新登录一次，沿用既有账号密码与数据。
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
| 智能体不回话、`agentReady=false` | 宿主机 Codex 登录失效 | 在 Mac 上 `codex login`，再 `/Users/mengxiao/workspace/tools/start.sh restart personal-agent` |
| 登录提示会话过期 | 会话被吊销或超过 TTL | 重新登录即可；客户端每 15 分钟自动续期并轮换 token |
| 登录返回 429 | 本机限速：同一 IP 密码错误过多（默认锁定 15 分钟） | 等待锁定窗口结束后再登录；不要反复重试 |
| 登录页出现 Cloudflare 提示页或 1015 | 公网边缘限流（高频自动化登录触发） | 降低登录频率并等待冷却；这是正确的保护行为，不要放宽边缘策略 |
| 手机端外链工作区要求再次登录 | 跨来源 cookie 在部分浏览器被拦截 | 用「新标签页打开」按钮；或回到控制台重新点开工作区 |

## 6.1 浏览器内存生命周期（空闲释放 / 按需恢复）

owner 默认不释放（`PA_BROWSER_RELEASE_IDLE=0`）：一个常驻浏览器，登录状态留在同一进程；后台巡检发现它处于已释放状态会自动恢复一次。
成员默认空闲释放（`PA_MEMBER_BROWSER_RELEASE_IDLE=1`，空闲时长同 `PA_BROWSER_IDLE_SECONDS`）。以下释放/恢复流程只对开启释放的账号生效。

只有**沙箱 Chromium** 会被释放，容器与 Codex/终端/code-server/Jupyter 不受影响。控制面从不
自己发信号：它把受管 helper 写进持久卷再按子命令调用，helper 负责核对归属后才可安全停/启。

```bash
# 只读状态（父端验收用；绝不停/不停/不唤醒）
docker exec -i -u root personal-agent-sandbox python3 - status \
  < src/control/browser/scripts/browser-runtime.py
# 期望：真实运行时 {"ok":true,"browserRunning":true,"browserAttribution":"owned",...}
# 无法确认归属时必须是 browserRunning:null + "unknown"，绝不当作"不存在"。
```

- **停止前必须两处归属都成立**：supervisor 与 browser 都 `owned`，且快照里的 source
  PID/starttime 与实际一致；否则拒绝并如实报 `stop_unattributed`/`stop_failed`，不动进程。
- **上游 helper 的强杀**：向 `/opt/gem/browser-supervisor.py` 发 SIGTERM 后，它会在内部约 10 秒
  后强制结束其 Chrome（upstream 行为，不改镜像）。生产执行前应按下方受控脚本观察它确实退出。
- **快照失败/未支持的页面**：不停止浏览器；拒绝原因会出现在 UI。恢复失败保留快照并可重试。
- **快照文件**：持久卷内 0600 原子写入，含标签/URL/滚动/sessionStorage、cookies 和当前站点的 localStorage/IndexedDB；URL 与存储内容从不
  进日志或 API。

**受控真实验收（仅本服务所有者、确认当前无活动任务与观看者后执行）**

```bash
cd /path/to/aio-agent
# 0) 只读确认没有正在运行的任务/观看者，并记录当前 Chrome PID/starttime
docker exec -i -u root personal-agent-sandbox python3 - status \
  < src/control/browser/scripts/browser-runtime.py
# 1) 快照 -> 睡眠 -> 唤醒，逐步执行并观察真实 PID 变化与标签恢复
#    snapshot:  docker exec ... python3 /opt/aio-browser/browser-runtime.py snapshot --snapshot <snapshotPath>
#    stop:      docker exec ... python3 /opt/aio-browser/browser-runtime.py stop --snapshot <snapshotPath> \
#                 --source-pid <pid> --source-starttime <starttime>
#    wake:      docker exec ... python3 /opt/aio-browser/browser-runtime.py wake --snapshot <snapshotPath> --wait-ms 60000
# 2) 每一步后重新 status，核对 browserRunning/pid/starttime/restorePending
# 3) 恢复后从控制台或 AIO MCP 触发一次真实浏览器工具，确认连到新浏览器
```

> 不要在有人正在看浏览器、或有任务在跑时执行上面的 stop/wake。

## 6.2 整个容器空闲休眠

成员默认开启（`PA_MEMBER_SANDBOX_RELEASE_IDLE=1`），owner 默认关闭（`PA_SANDBOX_RELEASE_IDLE=0`）。
沙箱不在用、控制台也不在前台，两者都持续 `PA_SANDBOX_IDLE_SECONDS`（默认 300）后：先检查容器里有没有仍在运行的 shell 命令、10 秒平均 CPU（不含 Chromium）是否 ≥ 5%，再给浏览器做快照并释放，最后 `docker stop` 容器。日志里 `sandbox in use` 会写明是哪个信号让容器留着。判定细节见 README「整个容器空闲休眠」。

- 看状态：`grep -E "sandbox (stopped after idle|waking from idle)|sandbox idle" var/users/*/logs/personal-agent.log`；`docker ps -a --filter name=aio-user-` 里 `Exited` 是休眠，不是故障。
- 休眠时巡检会跳过这个容器，不要手动 `docker start`：控制面会以为它还在休眠，就不会把 Codex 会话接回来。要唤醒就打开该成员的控制台，或在工作区页面刷新一下。
- 已知窗口：成员容器刚启动、还没装好出站隔离规则之前，有几秒不受网络限制（镜像自带的服务在跑，智能体进程还没启动）。休眠后容器启停变频繁，这个窗口出现得也更多。
- 每次重启服务都会先把所有成员容器拉起来；没人用的话 5 分钟后会再停掉。

## 7. 崩溃恢复验证（唯一可靠方式）

```bash
# compose 模式：容器崩溃由 Docker 的 unless-stopped 拉起；守护链本身这样验
cd /Users/mengxiao/workspace
docker exec aio-control-1 kill -TERM 1  # 控制层进程退出（docker kill/stop 算人工停止，不会自动拉起）
sleep 15 && docker inspect aio-control-1 --format '{{.State.Status}} restarts={{.RestartCount}}'   # running，次数 +1（2026-10-02 实测 6 秒恢复）
curl -s http://127.0.0.1:4892/healthz   # 应恢复 ready:true、compatible:true
# host 模式：杀子进程，bin/serve 应在 ~3s 后拉起
SERVE=$(cat .pids/personal-agent.pid)
CHILD=$(pgrep -P "$SERVE" -f 'dist/control/index.js' | head -1)
kill -9 "$CHILD"
sleep 6 && pgrep -P "$SERVE" -f 'dist/control/index.js'
grep -E 'exited code|started pid' .logs/personal-agent.log
```

登录密码、会话数据、工作区文件都应保持；沙箱容器不受影响。全局 supervisor 不会被触碰。

## 8. 数据与备份

| 数据 | 位置 | 备份价值 |
| --- | --- | --- |
| 对话、事件、会话、票据、成员库、推送密钥、分享快照 | compose：卷 `aio-control-data`（`/data`）；host：`var/` | 高（历史与登录态） |
| 工作区文件 | docker volume `personal-agent-workspace`（成员 `aio-user-<散列>-workspace`） | 高 |
| Codex / Claude Code 会话状态 | docker volume `personal-agent-codex` | 中（同时保存固定版 CLI） |
| 浏览器 profile | docker volume `personal-agent-browser` | 低 |
| owner 密码 | 卷内 `/data/owner-secret.txt`；`var/owner-secret.txt` 是迁移前的同一份（`npm run smoke` 读它） | 高（丢失需重置） |
| tunnel 凭据 | `var/cloudflared/`（宿主机，不进卷） | 高 |
| 节点令牌、部署设置 | `var/deploy/`（0600） | 中（丢失可重新生成令牌后重启） |

compose 模式下 `var/` 里的数据库是 2026-10-02 迁移前的旧副本，**不再更新**（迁移前的一致备份在
`var/backups/pre-compose-20261002-034925/`）。备份与回退：

```bash
cd projects/personal-agent
# 卷 → 目录（控制层必须先停：stop 后 launchd 守护几秒内会拉起，故在同一条命令里做完）
/Users/mengxiao/workspace/tools/start.sh stop personal-agent && \
  AIO_ENV_FILE=var/deploy/aio.env node deploy/aio.mjs export-data /path/to/backup
```

退回 host 模式：先把卷导出，用导出的数据库替换 `var/` 里的旧副本，再把 `var/runtime.env` 的 `PA_DEPLOY`
改成 `host` 并重启；跳过导出会让控制层用上迁移前的旧数据。

## 9. Codex MCP 隔离验收

构建并启动后运行 `npm run smoke:isolation`：使用真实沙箱与既有账号，只查询配置及工具元数据，
验证强行开启 Apps/插件、添加外部 MCP、把 AIO 地址指向其他服务均无法突破受管理策略。
临时 app-server 与宿主机鉴权辅助进程会在验收结束后关闭，不创建模型轮次。

容器每次接管时都会更新由本项目管理的 `/etc/codex/requirements.toml`。不覆盖未知管理者的
策略文件；遇到该冲突应先审查合并，不要删除文件绕过。新容器同时写入禁用 Apps/插件的默认
config，已有容器保留自定义 config、memory 和 AGENTS，通过独立系统策略生效。

用固定版本的 Codex 运行 `features list`，应看到 `apps`、`plugins`、`remote_plugin` 为 false，
memory 保持原值。`mcp list --json` 中唯一可启用的服务器为沙箱内 `aio_browser`；通过
app-server 的 `mcpServerStatus/list` 与 `app/list` 只验元数据，应分别得到 AIO 工具和空 App
清单。验收不需要读取或发送任何邮件。启动参数和 requirements 变化需重启本服务的 Codex
进程才对已运行实例生效；先核对 running/queued 轮次，不能静默中断任务。

接入知识库（`PA_KB_MCP_URL`）后，获准账号的沙箱里 `/etc/codex/requirements.toml` 多一条
`[mcp_servers.aio_kb.identity]`，URL 是该运行时自己的网关地址；未获准的账号没有这一条。验收：在获准
账号的沙箱里用 `-c 'mcp_servers.aio_kb.url="<该地址>"' mcp list --json` 应看到 `aio_kb` 可启用，
换成任何别的 URL 则被 requirements 拒绝；未获准账号用同样的命令也应被拒绝。

以上为工具接入隔离，不是共享账号 token 的服务端权限裁剪；需要更强的独立信任边界时应
另外使用没有个人 Connector 的账号/凭据与受控网络出口。

## 10. 已知限制

- 未实现自动滚动升级镜像；升级需人工按第 3 节执行。沙箱内 Codex CLI 是卷里的固定版本，
  升级方式见第 3 节，不需要重建镜像。
- 编辑器/笔记本等原生界面依赖浏览器 iframe 与第三方 cookie 策略；不支持内嵌时用新标签页打开。
- JupyterLab 首次加载会打印 `@jupyter-widgets/base` 的第三方 widget 前端告警；内核执行正常，
  不影响 `/v1/jupyter/execute` 与 notebook 计算。
- Playwright 用例覆盖登录、工作区标签竞态、文件列表与 code-server 可达、横向溢出；
  VNC/CDP 帧流仍由人工验收。

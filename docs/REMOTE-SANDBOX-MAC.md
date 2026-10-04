# Intel Mac 远程沙箱部署

本机配置记录，2026-10-02。业务源码未改动；修正了控制层 Compose 对本机 sandbox 的依赖，支持独立部署。
界面、账号、任务数据库、模型凭据与公网 tunnel
留在当前 Mac，owner、yzmy、cr、xjy 的沙箱及三种持久卷移到 old-mb。

## 拓扑与配置

| 位置 | 服务与数据 |
| --- | --- |
| 当前 Mac `100.110.16.34` | UI :4891、control :4892、成员网关 :4902、卷 `aio-control-data` |
| old-mb `100.80.219.88` | sandboxd :4894、网关中继 :4902、四个用户容器及 12 个卷 |

所有宿主监听均绑定 loopback。当前机 Tailscale Serve 将 :4902 转到本机同端口；
old-mb Serve 将 :4894 转到本机 sandboxd。仅 tailnet 可达，不使用 Funnel。
短名 `old-mb` 在当前机不解析时使用 Tailscale IP；完整 DNS 名是 `old-mb.tail8dae86.ts.net`。

当前机 `var/deploy/aio.env`：

```dotenv
AIO_LAYERS=ui,control
AIO_SANDBOX_NODES=local=http://100.80.219.88:4894
AIO_HOST_CODEX=on
```

节点名 `local` 沿用数据库中的既有分配，仅其 URL 改为远程地址；不要随意改名或清空分配。
节点令牌经 SSH 复制到 old-mb 的 `var/remote-node/node-token.env`（0600），模型长效凭据留在控制面。
成员在自己的容器中访问 `host.docker.internal:4902`，由节点中继返回当前机网关，再按账号附加凭据。
用户容器不挂宿主目录或 Docker socket。

2026-10-04 移除 OpenCode Go 桥（DeepSeek / MiMo）后，原来的 :4017 链路全部停用：当前机的 LiteLLM 服务
`codex-opencode-go` 和 Tailscale Serve 的 :4017 转发、old-mb 的 `ai.aio.bridge-relay` 都已停止。
`ai.aio.bridge-relay` 只做了 `launchctl disable` 加 `bootout`，plist 保留未删。

old-mb 仓库 `/Users/max/workspace/projects/aio-agent`，节点构建基于 `6b7cff0`（协议 1）。
Node 24.21.0 安装在 `/Users/max/.local`，Docker Desktop 4.93.0 / Engine 29.8.1
在 `/Applications/Docker.app`。sandboxd 的 `var/remote-node/sandbox.env`：

```dotenv
PA_SANDBOXD_BIND=127.0.0.1
PA_SANDBOXD_PORT=4894
PA_SANDBOXD_TOKEN_FILE=/Users/max/workspace/projects/aio-agent/var/remote-node/node-token.env
PA_SANDBOXD_DATA_DIR=/Users/max/workspace/projects/aio-agent/var/remote-node
PA_SANDBOXD_CONTAINER_HOST=127.0.0.1
PA_SANDBOXD_GATEWAY_UPSTREAM=http://100.110.16.34:4902
PA_SANDBOXD_GATEWAY_BIND=127.0.0.1
PA_SANDBOXD_GATEWAY_PORT=4902
PA_SANDBOXD_IMAGES=ghcr.io/agent-infra/sandbox:1.11.0
PA_SANDBOXD_MEMORY=4g
```

`~/Library/LaunchAgents` 中的 `ai.aio.sandboxd`、`ai.aio.keep-awake`
登录后自动启动并由 launchd 保活（`ai.aio.bridge-relay` 已停用，见上）。Docker Desktop 设置 AutoStart，VM 总额度 24 GiB、8 CPU。
笔记本须接电、保持开盖；`caffeinate -s` 防止接电时系统空闲休眠，不承诺合盖运行。
重启后需 max 登录 macOS，Docker Desktop 与 Tailscale 启动后才能服务；未开启自动登录。

## 用户容器与 Intel 依赖

| 用户 | 容器 | 节点网页端口 | 内存上限 |
| --- | --- | --- | --- |
| owner | personal-agent-sandbox | 18081 | 4 GiB |
| yzmy | aio-user-29e1b7a1fd47d5c09c25 | 18082 | 4 GiB |
| cr | aio-user-de68dcf57945de46ebe4 | 18083 | 4 GiB |
| xjy | aio-user-29e13a1607be44ab4dbf | 18084 | 4 GiB |

成员仍限定 2 CPU、1024 PID，使用独立 bridge 网络、禁 NET_RAW，并由现有 network-guard 设置内网隔离。
迁移的四个容器手工设为 `--memory 4g --memory-swap 4g`，重启保留。源码默认仍为 2 GiB，
本节点由 `sandbox.env` 的 `PA_SANDBOXD_MEMORY=4g` 让新建容器（新增账号、删除后自动重建）同样是 4 GiB
（交换区按 Docker 默认合计 8 GiB）。改这一项要重启 sandboxd，只影响之后新建的容器；已有容器在节点上用
`docker update` 在线修改。创建后可核对 `HostConfig.Memory=4294967296`：

```bash
export PATH=/Applications/Docker.app/Contents/Resources/bin:$HOME/.local/bin:$PATH
docker update --memory 4g --memory-swap 4g <精确容器名>
docker inspect --format '{{.Name}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}' <精确容器名>
```

基础镜像仍固定 1.11.0，使用其 amd64 平台。原 ARM 沙箱使用 Chromium 154.0.8037.57，
而镜像自带 146，因此迁移容器在第一次打开原资料前安装相同版本的 Intel Chromium。
节点 `var/remote-node/native-browser/native-154.tar` 保存其 root 管理的程序和库，SHA-256 为
`0a9c8fa7a0eba4e1038bb9aa36d5d055b90a96c37a7676aeb0b5185662be21ef`。
容器入口 `/opt/aio-browser/bootstrap.sh` 将 `/usr/local/bin/browser` 指向原生包装器，再调用镜像原入口
`/opt/gem/run.sh`；目录及所有程序须归 root 且不允许 gem 修改。包装器仅设置原生库路径并执行 Chromium。依赖来自 xtradeb Chromium 154 amd64
和 Ubuntu openh264/xnvctrl 包；无需改业务代码或固定基础镜像版本。
容器删除重建时不能直接让旧资料在默认 146 浏览器下启动，须先补齐同样的原生入口。

控制面核对运行中的浏览器时，要识别包装器实际 `exec` 的 Chromium 路径，不能直接把
`/opt/aio-browser/start-native.sh` 与进程命令行比较。`alignBrowserIdentity` 只解析 root
拥有且不可被组/其他用户写入的简单原生包装器；匹配时保留进程，实际换版本仍备份 profile
并重启。曾经的直接路径比较会在每次控制面启动时误重启 owner 浏览器，打断页面验证与接管。
验收：在同一真实沙箱连续运行两次身份核对，都应返回 `same`，Chromium PID/starttime 不变。

旧的固定 Codex、Claude Code 目录与文档 venv 仅移到卷内
`/home/gem/.codex/tools/arm64-before-migration-20261002`，保留为备份；执行工具重新安装 Intel 版本。
工作区里的用户自装原生依赖需要按项目重新构建，不直接复用 ARM 二进制。
旧机确认停止后，迁入的浏览器卷只清理 `SingletonLock`、`SingletonSocket`、`SingletonCookie`
三个引用旧容器的锁，再启动新浏览器，避免 Chromium 误判资料仍被旧主机占用。

## 检查与重启

当前机仍只用 `/Users/mengxiao/workspace/tools/start.sh restart personal-agent` 重启界面与控制层。
节点检查：

```bash
export PATH=/Applications/Docker.app/Contents/Resources/bin:$HOME/.local/bin:$PATH
docker info --format '{{.NCPU}} {{.MemTotal}}'
docker ps -a --filter label=personal-agent.managed=1
launchctl print gui/501/ai.aio.sandboxd
curl -s http://127.0.0.1:4894/healthz
launchctl kickstart -k gui/501/ai.aio.sandboxd
```

节点日志 `var/remote-node/logs/ai.aio.*.log`；用户日志用 `docker logs <精确容器名>`。
重启 sandboxd 不应重启全部用户容器。服务健康必须另验账号登录、真实任务、终端/WebSocket、
浏览器/桌面、文件、编辑器和 Jupyter，不能只看 healthz。

## 数据备份与回退

当前机 `var/migrations/2026-10-02-old-mb` 保存 12 个沙箱卷和 `aio-control-data` 的停止态 tar、
SHA-256 清单、切换前配置与账号/任务状态清单（目录 0700，卷归档 0600）；控制数据库备份仅留当前机。
节点同路径（其仓库内）只有沙箱卷归档与清单。原机的四个容器和 12 个卷保留为停止状态，不删除。

回退须先检查任务并停止控制面和远程执行，避免双写。若远程已产生新文件/会话，先停止对应容器并
导出卷，不能直接丢弃这些变化；Intel 工具目录也不能原样恢复为 ARM 运行环境。
将当前机部署设置恢复为 `AIO_LAYERS=ui,control,sandbox` 和原本地节点地址，保留现有控制数据库，
通过 scoped service restart 重新接管旧容器。恢复历史数据库快照是单独的有损回退，不默认执行。

## 本次迁移验收

12 个沙箱卷停止态归档共 5,655,654,400 字节，目标恢复前逐一匹配 SHA-256。
账号、账号模型分配、任务数据库仍是原控制卷，没有重置密码或历史。
冻结前 owner 有 483 个任务、459 个 turn，cr 有 22 个任务、21 个 turn，另外两账号尚无任务；
切换后历史总数均未减少（验收和用户正常请求会增加新记录）。冻结前最终分配为：owner Claude Opus 5.5，
三个成员均 GPT 6.1 Sol；切换后的四个只读任务均按该分配实际执行，返回 x86_64 和 4294967296。

验收结果：

- 控制面 `/healthz`：ready/compatible 与全部就绪项为 true；四容器均为 amd64，浏览器实际运行 154.0.8037.57。
- 四账号分别完成同名文件写读与清理、自己的终端 WebSocket、12 次跨账号路径拒绝；成员到 owner/宿主私网、owner 到成员端口均被阻断。
- 四账号文档工具 ready，分别成功把临时中文 Word 转为 PDF 并清理。
- 真实公网 `npm run smoke` 39/39 通过（Cookie、票据、文件、原生表面与 WebSocket）。
- 真实浏览器检查：owner/yzmy 1440 宽，cr 390 宽、xjy 360 宽；控制台、原生工作区 iframe 和文件应用可用，无页面脚本错误或水平溢出。
- typecheck 通过；完整测试 74 文件 / 786 项通过。测试需要允许本地监听和浏览器启动，受限执行环境会产生 EPERM。

原机四个用户容器保留为停止状态；旧本机 sandboxd compose 容器已随层拆分移除，其用户卷保留。
现有空闲回收机制继续生效：无前台使用/执行的成员沙箱可以休眠，访问时由控制面重新启动，4 GiB 限额不变。

# 部署：三层镜像与 Docker Compose

AIO Agent 分三层，各自一个镜像，可以放在同一台机器，也可以分开放：

| 层 | 镜像 | 端口 | 职责 |
| --- | --- | --- | --- |
| 界面 ui | `aio-agent-ui` | 4891 | 控制台静态文件 + 把 `/api` 原样转给控制面（网页与 API 同源） |
| 控制 control | `aio-agent-control` | 4892、网关 4902 | 账号、任务、智能体、伴随站（工作区来源）、沙箱回连的成员网关；数据在命名卷 |
| 沙箱 sandbox | `aio-agent-sandbox` | 4894 | sandboxd：唯一持有 Docker 的组件，管理本机的沙箱容器 |

公网入口：主站（控制台）指向 ui 的 4891，伴随站（工作区）指向 control 的 4892。

## 单机

```bash
cp deploy/aio.env.example deploy/aio.env       # 按需填写；控制面的 PA_* 设置写进 AIO_CONTROL_ENV_FILE
node deploy/aio.mjs init                       # 生成节点令牌（控制面与 sandboxd 共用）
node deploy/aio.mjs build                      # 构建三个镜像，打上版本与协议号 label
node deploy/aio.mjs up                         # 先校验镜像兼容，再 compose up 并等待全部健康
node deploy/aio.mjs ps | logs control | down
```

首次启动在数据卷里生成 owner 密码：`docker compose -p aio exec control cat /data/owner-secret.txt`。
管理员命令在容器里运行，例如 `docker compose -p aio exec control node bin/create-user.mjs <账号>`。

owner 的任务可以跑在 ChatGPT 模型、Claude Code（`AIO_SECRET_CLAUDE_CODE`）或桥模型（`AIO_SECRET_OPENCODE_GO`）上。
ChatGPT 默认关闭：控制面镜像自带 Codex CLI（与沙箱同版本），先执行 `node deploy/aio.mjs codex-login`，按提示在浏览器打开
链接、输入一次性代码完成登录（设备码登录；ChatGPT 设置里需允许 Codex 设备码授权），再在 `aio.env` 设 `AIO_HOST_CODEX=on`
并重启。这是这套部署自己的登录，存在数据卷的 `/data/codex-home`，由容器里的 Codex 自行刷新；不要把别处的 `~/.codex`
挂进来或拷进来——两边共用一个会轮换的 refresh token，先刷新的一方会让另一方掉线。`codex-login status` 查看登录状态。
其他凭据以只读文件挂载，镜像里不含任何密钥。

## 多机

每台机器只跑自己那一层，`AIO_LAYERS` 指定：

- **沙箱机**：`AIO_LAYERS=sandbox`。sandboxd 的 4894 只应发布到控制面可达的私网地址（如 Tailscale/WireGuard），
  跨公网时放在 TLS 反向代理后面（控制面支持 `https://` 节点地址）。控制面不在这台机器上时，设
  `PA_SANDBOXD_GATEWAY_UPSTREAM`（控制面网关地址）并发布中继端口，让本机沙箱照旧通过
  `host.docker.internal:<网关端口>` 回连控制面。
- **控制机**：`AIO_LAYERS=control`，`AIO_SANDBOX_NODES=local=http://<节点1>:4894,big=http://<节点2>:4894`。
  已有账号留在第一个节点（卷在那里），新账号放到剩余内存最多的节点；分配记录在根库 `meta` 的
  `sandbox_node:<账号>`，节点从配置中消失时该账号直接报错，不会在别处重建。
- **界面机**：`AIO_LAYERS=ui`，`AIO_CONTROL_URL=http://<控制机>:4892`。

所有机器使用同一个节点令牌文件（`AIO_SECRET_NODE_TOKEN`）。控制面只有一个实例。

## 版本兼容

兼容契约在 `src/common/version.ts`：控制面提供的 API 版本（和仍兼容的最低版本）、sandboxd 讲的节点协议、
控制面能驱动的协议范围。每个镜像都带这些 label：

- `node deploy/aio.mjs check`（`up` 前自动执行）读本机要跑的镜像 label，组合不兼容就拒绝启动；
- 运行时再握手一次：控制面拒绝协议不在范围内的节点（`/healthz` 的 `compatible`），ui edge 只在控制面
  提供它需要的 API 时健康，网页在版本不匹配时顶部提示刷新或更新；
- 因此 `up --wait` 会在任何一层不兼容时失败，而不是半可用。

升级不兼容的协议时，先让新控制面同时支持新旧两个版本（放宽范围），再逐台升级沙箱节点，最后收窄范围。

## 数据卷

```bash
node deploy/aio.mjs export-data /path/to/backup   # 控制面停止时，把数据卷拷出（备份、回退、换机器）
node deploy/aio.mjs import-data /path/to/var      # 控制面停止时，把一个数据目录拷进数据卷
```

从宿主进程部署迁过来时，设 `AIO_SEED_DATA_FROM=var`：`run`（`bin/serve` 的 compose 模式）在数据卷还没有数据库时，
先在什么都没运行的时刻把这个目录拷进卷，再启动；卷里已有数据库就不会再动它。

## 已知限制

- 只在 macOS + Docker Desktop 上验证过。Linux 机器需要 `AIO_SANDBOXD_ADD_HOST_GATEWAY=1`，且 sandboxd
  需要能连到沙箱发布在本机回环上的端口（`network_mode: host` 或相应网络设置），尚未实测。
- 控制面是单实例；按账号分片的多实例尚未实现。
- 打包成原生 App（Tauri）还需要：App 内的 token 登录、实时事件与图片链接的鉴权、工作区在原生窗口打开、原生通知。

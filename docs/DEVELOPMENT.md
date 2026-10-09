# AIO Agent 开发与测试

## 本地开发

```bash
npm ci
npm run build            # 构建界面（dist/ui）与服务端（dist/control、dist/sandbox）
npm run typecheck
npm test                 # 单元 + 集成测试，自带假沙箱，无需 Docker
```

开发模式分别启动三层（只用 loopback，不经过 tunnel）：

```bash
npm run dev:sandbox      # sandboxd :4894（需要 PA_SANDBOXD_TOKEN_FILE，见 README 快速开始）
npm run dev:control      # 控制层 :4892（tsx watch）
npm run dev:ui           # Vite 开发服务器，/api 代理到 :4892
```

浏览器打开 `http://localhost:4891` 为控制台；`http://127.0.0.1:4892` 为工作区。两者是不同来源，跨站规则与线上一致。
首次启动生成的 owner 密码在 `var/owner-secret.txt`。

层之间不得互相 import（`tests/unit/layers.test.ts` 守护），共享代码只放 `src/common/`。改动控制面 API 或节点协议的不兼容行为时，
同步调整 `src/common/version.ts` 中的版本号与兼容范围。

## 测试分层

```bash
npm test                                              # 1) 单元 + 集成
npm run smoke                                         # 2) HTTP + WebSocket 冒烟（默认 localhost:4891 + 127.0.0.1:4892）
npx playwright test                                   # 3) 真实浏览器 UI（默认 http://localhost:4891）
npm run build && npx playwright test --config playwright.local.config.ts   # 4) 本地假后端 UI
npm run smoke:isolation                               # Codex MCP 隔离验收（真实沙箱，只读元数据）

# 对公网实例冒烟需显式指定两个来源
PA_PRIMARY_ORIGIN=https://agent.example.com \
PA_COMPANION_ORIGIN=https://workspace.example.com npm run smoke
```

首次运行 Playwright 前执行 `npx playwright install chromium webkit`。`npm run smoke` 读取 `var/owner-secret.txt`（或 `PA_OWNER_SECRET_FILE`）。

| 层 | 覆盖 |
| --- | --- |
| `npm test`（vitest） | 鉴权与会话（未登录绕过、过期 / 续期 / 吊销后关闭已建立连接）、Host / Origin / CSRF、重定向安全、HTTP 与 WebSocket 代理、事件回放与 delta 顺序、重复提交冲突、停止语义与未知结果不重放、派单临时线程隔离、沙箱浏览器标签 URL 校验、浏览器生命周期（状态机竞态、观看者 TTL、快照失败不停止、恢复 single-flight、归属未知 fail-closed、状态轮询不唤醒） |
| `tests/unit/browser-runtime.test.py`（随 `npm test` 运行） | 容器内受管 helper：进程归属判定、`unknown` 不等于 `absent`、快照 schema 与 0600 原子写、按 PID / starttime 校验后才停止、`sessionStorage` 按 origin 注入、错误脱敏 |
| `npm run smoke` | 真实登录与 cookie 属性、模型列表、一次性票据（重放与开放重定向）、工作区会话与跨源续期、经鉴权的 shell 调用、上传与列目录、跨源写入拒绝、原生界面可达、未登录 401、真实 WebSocket 升级 |
| `npx playwright test` | 登录、对话输入区不含模型控件、配置页默认模型、工作区标签切换竞态、文件列表与 code-server 可达、无横向溢出 |
| `playwright.local.config.ts` | 静态 `dist/ui` + 全部 `/api` 由 `page.route` mock：文件卡片与预览、工作区文件操作、配置页保存与失败反馈、任务时间线活动段、链接路由、安全区与键盘、移动端 390 / 360 宽（含 WebKit）、暗亮主题。可用 `PA_TEST_PORT`、`PA_TEST_WEB_ROOT` 调整 |
| 人工验收 | VNC 桌面帧流、浏览器 CDP 帧流、手机真机交互 |

## 验收要求

- 改动 UI 后用真实浏览器检查桌面（1440×900）与手机（390×844、360 宽）；HTTP 200 不等于可用。
  WebKit 自动化不能替代 iPhone 真机的软键盘与 Safari 地址栏行为。
- 沙箱相关改动在真实容器上验证（健康接口会检查 terminal、code-server、Jupyter 三个表面）。
- 修改 Playwright 用例后同时运行 `npm run typecheck`（Playwright 不做类型检查）。
- 移动端 App（`src/ui/tauri/`）的构建与验证见 [该目录 README](../src/ui/tauri/README.md)。

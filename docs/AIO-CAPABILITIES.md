# AIO 沙箱能力清单（按固定镜像实测）

本清单由 `ghcr.io/agent-infra/sandbox:1.11.0` 容器自身导出的 `/v1/openapi.json` 生成，
而不是上游文档，因此与本机实际运行的镜像一致：共 **123 个路径**（每个路径下的 HTTP 方法合计 **140 个操作**）。下文按操作列出。

- 控制台里「接口与 MCP」标签页会在运行时重新抓取同一份文档，可随时查看最新结果。
- 所有接口都通过伴随域名 `agent-workspace.clawpage.ai` 暴露，并且**每一条路径都要求
  owner 会话**（未登录返回 401）；`/v1/*`、`/mcp`、`/cdp/*`、`/jupyter`、`/code-server/`、
  `/vnc/*`、`/terminal`、`/browser-ui` 与 WebSocket 升级全部经过同一鉴权与来源校验。
- 控制台里还提供受限的「接口调用」面板：只允许访问沙箱自身的 `/v1`、`/mcp`、`/cdp`、`/json`
  路径，不能借此发起任意宿主机请求。

## 原生界面入口（同一伴随域名下）

| 界面 | 路径 | 说明 |
| --- | --- | --- |
| 桌面（noVNC） | `/vnc/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=ws` | 真实 X11 桌面，手机可点击/输入；工作区“浏览器”标签与任务操作面板都用它 |
| 浏览器控制台 | `/browser-ui` | CDP 调试与页面操作（控制台不再使用：工作区“浏览器”标签和任务操作面板都用上面的 noVNC 桌面） |
| 交互终端 | `/terminal` | tmux 终端会话 |
| 代码编辑器 | `/code-server/` | VS Code Web |
| JupyterLab | `/jupyter/lab` | 多内核笔记本 |
| 端口预览 | `/proxy/<port>/` | 访问沙箱内自行启动的服务 |
| MCP 端点 | `/mcp`、`/v1/mcp` | streamable HTTP MCP |

### 浏览器与桌面（53 个接口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/browser/actions` | Execute Action |
| GET | `/v1/browser/captcha/detect` | Detect Captcha |
| POST | `/v1/browser/captcha/wait` | Wait For Captcha |
| POST | `/v1/browser/config` | Set Config |
| DELETE | `/v1/browser/cookies` | Clear Cookies |
| GET | `/v1/browser/cookies` | Get Cookies |
| POST | `/v1/browser/cookies` | Set Cookies |
| GET | `/v1/browser/info` | Get Browser Info |
| POST | `/v1/browser/network/export_har` | Export Har |
| POST | `/v1/browser/network/headers` | Set Extra Headers |
| GET | `/v1/browser/network/requests` | Get Requests |
| DELETE | `/v1/browser/network/route` | Remove Route |
| POST | `/v1/browser/network/route` | Add Route |
| POST | `/v1/browser/network/scoped_headers` | Set Scoped Headers |
| POST | `/v1/browser/page/back` | Go Back |
| POST | `/v1/browser/page/check` | Check |
| POST | `/v1/browser/page/click` | Click |
| GET | `/v1/browser/page/console` | Get Console Logs |
| POST | `/v1/browser/page/console/export` | Export Console Logs |
| GET | `/v1/browser/page/elements` | Get Interactive Elements |
| POST | `/v1/browser/page/evaluate` | Evaluate |
| POST | `/v1/browser/page/fill` | Fill |
| POST | `/v1/browser/page/fill_form` | Fill Form |
| POST | `/v1/browser/page/find_text` | Find Text |
| POST | `/v1/browser/page/forward` | Go Forward |
| POST | `/v1/browser/page/hot_key` | Hot Key |
| POST | `/v1/browser/page/hover` | Hover |
| GET | `/v1/browser/page/html` | Get Html |
| GET | `/v1/browser/page/markdown` | Get Markdown |
| POST | `/v1/browser/page/navigate` | Navigate |
| POST | `/v1/browser/page/press_key` | Press Key |
| POST | `/v1/browser/page/record` | Page Record |
| POST | `/v1/browser/page/reload` | Reload |
| GET | `/v1/browser/page/screenshot` | Page Screenshot |
| POST | `/v1/browser/page/scroll` | Scroll |
| POST | `/v1/browser/page/scroll_to` | Scroll To |
| POST | `/v1/browser/page/scroll_to_element` | Scroll To Element |
| POST | `/v1/browser/page/select_option` | Select Option |
| GET | `/v1/browser/page/text` | Get Text |
| POST | `/v1/browser/page/type` | Type Text |
| POST | `/v1/browser/page/uncheck` | Uncheck |
| POST | `/v1/browser/page/upload_file` | Upload File |
| POST | `/v1/browser/page/wait` | Wait |
| GET | `/v1/browser/proxy.pac` | Get Proxy Pac |
| POST | `/v1/browser/restart` | Restart |
| GET | `/v1/browser/screenshot` | Take Screenshot |
| POST | `/v1/browser/state/load` | Load State |
| POST | `/v1/browser/state/save` | Save State |
| GET | `/v1/browser/tabs` | List Tabs |
| POST | `/v1/browser/tabs` | Create Tab |
| DELETE | `/v1/browser/tabs/{index}` | Close Tab |
| PUT | `/v1/browser/tabs/{index}/activate` | Activate Tab |
| POST | `/v1/display/record` | Record |

### 终端与 Shell（19 个接口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/bash/exec` | Exec |
| POST | `/v1/bash/kill` | Kill |
| POST | `/v1/bash/output` | Output |
| GET | `/v1/bash/sessions` | Sessions |
| POST | `/v1/bash/sessions/create` | Create Session |
| POST | `/v1/bash/sessions/{session_id}/close` | Close Session |
| POST | `/v1/bash/write` | Write |
| POST | `/v1/shell/exec` | Exec Command |
| POST | `/v1/shell/kill` | Kill Process |
| DELETE | `/v1/shell/sessions` | Cleanup All Sessions |
| GET | `/v1/shell/sessions` | List Sessions |
| POST | `/v1/shell/sessions/create` | Create Session |
| GET | `/v1/shell/sessions/stats` | Get Session Stats |
| POST | `/v1/shell/sessions/update` | Update Session |
| DELETE | `/v1/shell/sessions/{session_id}` | Cleanup Session |
| GET | `/v1/shell/terminal-url` | Get Terminal Url |
| POST | `/v1/shell/view` | View Shell |
| POST | `/v1/shell/wait` | Wait For Process |
| POST | `/v1/shell/write` | Write To Process |

### 文件管理（17 个接口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/file/download` | Download File |
| POST | `/v1/file/find` | Find Files |
| POST | `/v1/file/glob` | Glob Files |
| POST | `/v1/file/grep` | Grep Files |
| POST | `/v1/file/list` | List Path |
| POST | `/v1/file/read` | Read File |
| POST | `/v1/file/replace` | Replace In File |
| POST | `/v1/file/search` | Search In File |
| POST | `/v1/file/str_replace_editor` | Str Replace Editor |
| POST | `/v1/file/upload` | Upload File |
| GET | `/v1/file/watch` | List Watches |
| POST | `/v1/file/watch` | Create Watch |
| POST | `/v1/file/watch/wait` | Wait For File |
| DELETE | `/v1/file/watch/{watcher_id}` | Stop Watch |
| GET | `/v1/file/watch/{watcher_id}/events` | Watch Events |
| POST | `/v1/file/watch/{watcher_id}/poll` | Poll Events |
| POST | `/v1/file/write` | Write File |

### 笔记本与代码执行（15 个接口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/code/execute` | Execute Code |
| GET | `/v1/code/info` | Code Info |
| POST | `/v1/jupyter/execute` | Execute Jupyter Code |
| GET | `/v1/jupyter/info` | Jupyter Info |
| DELETE | `/v1/jupyter/sessions` | Cleanup All Sessions |
| GET | `/v1/jupyter/sessions` | List Sessions |
| POST | `/v1/jupyter/sessions/create` | Create Jupyter Session |
| DELETE | `/v1/jupyter/sessions/{session_id}` | Cleanup Session |
| POST | `/v1/nodejs/execute` | Execute Nodejs Code |
| GET | `/v1/nodejs/info` | Nodejs Info |
| GET | `/v1/nodejs/sessions` | List Nodejs Sessions |
| POST | `/v1/nodejs/sessions` | Create Nodejs Session |
| DELETE | `/v1/nodejs/sessions/{session_id}` | Delete Nodejs Session |
| GET | `/v1/nodejs/sessions/{session_id}` | Get Nodejs Session |
| PATCH | `/v1/nodejs/sessions/{session_id}` | Update Nodejs Session |

### MCP 与技能（8 个接口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/mcp/servers` | List Mcp Servers |
| GET | `/v1/mcp/{server_name}/tools` | List Mcp Tools |
| POST | `/v1/mcp/{server_name}/tools/{tool_name}` | Execute Mcp Tool |
| DELETE | `/v1/skills` | Clear Skills |
| GET | `/v1/skills/metadatas` | List Skills Metadata |
| POST | `/v1/skills/register` | Register Skills |
| DELETE | `/v1/skills/{name}` | Delete Skill |
| GET | `/v1/skills/{name}/content` | Get Skill Content |

### 沙箱与代理（26 个接口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/proxy/diagnose` | Diagnose |
| DELETE | `/v1/proxy/excludes` | Remove Exclude |
| GET | `/v1/proxy/excludes` | List Excludes |
| POST | `/v1/proxy/excludes` | Add Exclude |
| GET | `/v1/proxy/health` | Health Check |
| GET | `/v1/proxy/mappings` | List Mappings |
| POST | `/v1/proxy/mappings` | Add Mapping |
| DELETE | `/v1/proxy/mappings/{source}` | Remove Mapping |
| DELETE | `/v1/proxy/upstream` | Remove Upstream |
| GET | `/v1/proxy/upstream` | Get Upstream |
| PUT | `/v1/proxy/upstream` | Set Upstream |
| GET | `/v1/sandbox` | Get Sandbox Context |
| GET | `/v1/sandbox/hooks` | List Hooks |
| POST | `/v1/sandbox/hooks` | Register Hook |
| DELETE | `/v1/sandbox/hooks/{name}` | Remove Hook |
| POST | `/v1/sandbox/observe/export` | Observe Export |
| GET | `/v1/sandbox/observe/live` | Observe Live |
| GET | `/v1/sandbox/observe/reports` | Observe Reports |
| DELETE | `/v1/sandbox/observe/reports/{report_id}` | Observe Report Delete |
| GET | `/v1/sandbox/observe/reports/{report_id}` | Observe Report Download |
| POST | `/v1/sandbox/observe/start` | Observe Start |
| GET | `/v1/sandbox/observe/status` | Observe Status |
| POST | `/v1/sandbox/observe/stop` | Observe Stop |
| GET | `/v1/sandbox/packages/nodejs` | Nodejs Packages |
| GET | `/v1/sandbox/packages/python` | Python Packages |
| POST | `/v1/util/convert_to_markdown` | Convert To Markdown |

### 其他（2 个接口）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/auth` | Authenticate Request |
| POST | `/tickets` | Create Ticket |
## 与智能体的关系

沙箱内的主智能体（Codex app-server）通过这些接口工作：工作区里播种了
`/home/gem/workspace/AGENTS.md`，说明 `aio` CLI（`aio browser`、`aio gui`、`aio shell`、
`aio file`）与已注册的 MCP 服务器 `aio_browser`（`http://127.0.0.1:8080/mcp`，工具名已按
`tools/list` 实测：`browser_navigate`、`browser_get_text`、`browser_screenshot`、
`browser_evaluate`、`browser_click` 等）。这些能力全部位于容器内部，宿主机能力没有接入。

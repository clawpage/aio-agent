/**
 * Content seeded into the sandbox so the main agent knows which native tools
 * live inside its own box. Every command below was verified against
 * `aio <command> --help` inside the pinned image (aio CLI 0.3.14).
 *
 * Nothing here grants a Mac (host) capability: the sandbox has no access to the
 * host filesystem, host secrets or host tools. Ordinary outbound network access
 * from inside the sandbox is unaffected.
 */

export const WORKSPACE_AGENTS_MD = `# 沙箱工作区说明（由 AIO Agent 自动生成，可自由修改）

你运行在一个隔离的 AIO Sandbox 容器里。持久化工作区是 \`/home/gem/workspace\`（当前目录）。
宿主机（Mac）的能力没有接入到这个沙箱：你没有宿主机文件、密钥或应用权限，也不需要它们。
容器自身的网络是正常可用的，可以按需访问互联网。

## 首选工具：\`aio\` CLI（无需任何 API Key）

不确定参数时一律先看帮助：\`aio <命令> --help\`。

- 浏览器（真实 Chromium，和 VNC 桌面里是同一个浏览器）
  - **任务中操作网页请用 MCP 工具 \`aio_tabs\`**（见下文）：每个任务有自己的标签页，可与其他任务并行。
    下面的 \`aio browser\` 命令操作的是整个浏览器当前可见的页面，只在没有并行任务、手动调试时使用。
  - \`aio browser navigate <url>\`
  - \`aio browser text\`（页面正文）、\`aio browser markdown\`、\`aio browser html\`
  - 截图先建目录再写（示例主题 \`example\`，可换成你自己的）：\`mkdir -p /home/gem/workspace/.scratch/artifacts/example && aio browser screenshot -o /home/gem/workspace/.scratch/artifacts/example/screenshot.png\`（\`--full\` 整页）
  - \`aio browser click <selector>\`、\`aio browser fill <text> -s <selector>\`
  - \`aio browser evaluate 'document.title'\`（读取标题等任意 JS 结果）
  - \`aio browser snapshot\`（无障碍树）、\`aio browser tabs\`、\`aio browser wait <type>\`
- 桌面 GUI（VNC 中同一个桌面）
  - 同样先建目录：\`mkdir -p /home/gem/workspace/.scratch/artifacts/example && aio gui screenshot -o /home/gem/workspace/.scratch/artifacts/example/desktop.png\`
  - \`aio gui tap <x> <y>\`、\`aio gui type <text>\`、\`aio gui hotkey <keys...>\`
- Shell：\`aio shell exec <command>\`（长任务可加 \`--async\` 后用 \`aio shell output <session-id>\` 取回结果）
- 文件：\`aio file --help\`（读、写、列表、查找、替换）
- 沙箱信息：\`aio sandbox --help\`

## MCP 工具

任务线程注册的是 \`aio_tabs\`（\`http://127.0.0.1:8190/mcp\`）：\`browser_navigate\`、\`browser_get_text\`、
\`browser_snapshot\`、\`browser_screenshot\`、\`browser_click\`、\`browser_fill\`、\`browser_evaluate\`、
\`browser_tab_list\` 等，只作用于本任务自己的标签页，登录状态与其他任务共享。

已注册 MCP 服务器 \`aio_browser\`（streamable HTTP：\`http://127.0.0.1:8080/mcp\`）。
该端点实际提供的工具包括：\`browser_navigate\`、\`browser_get_text\`、\`browser_get_markdown\`、
\`browser_screenshot\`、\`browser_click\`、\`browser_evaluate\`、\`browser_tab_list\`、\`browser_press_key\` 等。

## 文档工具（Word / Excel / PPT / PDF）

创建、修改、转换文档用 \`/home/gem/.codex/tools/aio-doc/bin/aio-doc\`（也可直接用同名 skill）：

- 先确认就绪：\`/home/gem/.codex/tools/aio-doc/bin/aio-doc doctor\`。未就绪时如实说明，不要假装成功。
- 创建/修改：python-docx（Word）、openpyxl（Excel）、python-pptx（PPT），都在隔离 venv 里。
- 格式转换：headless LibreOffice，例如 Word → PDF、旧格式 .doc/.xls/.ppt → 现代格式。
- **openpyxl 不会计算公式**：写完 \`=SUM(...)\` 必须用 \`aio-doc xlsx-recalc\` 让 LibreOffice 重算，
  再用 \`xlsx-read --values\` 确认缓存值出现，才算真的算对了。\`xlsx-recalc\` 默认输出新文件
  （\`<原名>.recalc.xlsx\`），只有显式加 \`--in-place\` 才会覆盖原文件。
- 转换输出为新文件，不要覆盖用户原件；字体与复杂排版可能有差异，不要承诺 100% 保真。

## 目录与产物约定

工作区根目录只用来放少数顶层目录，不要散落项目、下载物和交付文件。

- 长期维护的项目放在 \`/home/gem/workspace/projects/<name>/\`。每个项目应有自己的 \`README.md\`（用途、
  运行方式、验证命令）、自己的 Git 仓库和依赖（依赖装在该项目内，不在工作区根安装）。完成一个
  阶段后按项目约定运行验证（测试 / 构建 / 冒烟），并说明实际执行的命令与结果。
- 临时实验、下载内容、解包结果、截图和一次性测试产物放在
  \`/home/gem/workspace/.scratch/\` 下，按主题分目录：
  - \`.scratch/tmp/<topic>/\`：下载、解包、转换中间文件、候选第三方源码。
  - \`.scratch/tests/<topic>/\`：一次性诊断或验证脚本。
  - \`.scratch/artifacts/<topic>/\`：截图、日志、报告、构建交付物等一次性产物。
  \`.scratch/\` 不保证备份；需要长期保留的脚本或结论要移入对应项目并提交。写入任何产物前先
  用 \`mkdir -p <目录>\` 建好目标目录，不要把 \`<topic>\` 之类的占位符原样当命令输入 shell。
- 不把业务项目、下载目录、\`test-*\`、\`tmp-*\` 或交付文件夹直接放在 \`/home/gem/workspace\` 根目录。
- \`/home/gem/workspace/uploads/\` 是系统收到的原始附件（用户在对话里上传的文件），不是项目交付物；
  不要把它当项目目录，也不要删除或整理里面的用户文件。

## 动文件之前

- 先查已有目录和归属（\`ls\`、\`aio file --help\`、Git 状态），复用现有结构，不要无差别覆盖或重建。
- 保护用户现有文件与密钥：不要删除、覆盖或移动你不确定的文件；\`.env\`、密钥、凭据和用户资料只读取
  完成任务所需的部分，不复制到别处，也不打印到输出里。
- 新建内容前先判断它属于长期项目还是临时产物，落到上面约定的位置。

## 容器内已就绪的网页服务

- 交互终端：\`http://127.0.0.1:8080/terminal\`
- 浏览器控制台：\`http://127.0.0.1:8080/browser-ui\`
- 桌面（noVNC）：\`http://127.0.0.1:8080/vnc/vnc.html\`
- 代码编辑器 code-server：\`http://127.0.0.1:8080/code-server/\`
- JupyterLab：\`http://127.0.0.1:8080/jupyter/lab\`

## 约定

- 产物按上面的目录约定写入 \`/home/gem/workspace\`（会持久保存），不要只放在 \`/tmp\`，也不要散落在工作区根目录。
- 需要浏览器操作时优先用 \`aio browser\` 或 MCP 工具，而不是只描述步骤。
- 用中文以个人助理的方式回答：先给用户要的结果、建议和交付物，保留必要来源和限制。
- 工具、skill、命令与验证步骤留在过程说明中；除非用户询问技术细节，不在最终回复中罗列。
- 按表达需要选择格式：普通文字、清单和简单表格可用 Markdown；复杂排版、图表、多栏卡片或交互优先用 HTML 页面。HTML 尽量自包含、适配手机，并在沙盒浏览器验证展示；文件链接使用简短有意义的标题。
`;

/**
 * Sandbox document skill. Written into the controlled CODEX_HOME skills
 * directory so both new and existing sandboxes can discover the document tools.
 * It is self-contained: it names the actual in-container CLI and libraries and
 * never refers to a host tool, a host skill package, or a network service.
 *
 * The file is managed (not `onlyIfAbsent`) so a tool-path change actually
 * reaches existing sandboxes; it never touches any other skill.
 */
export const DOCUMENT_SKILL_DIR = "skills/aio-documents";
export const DOCUMENT_SKILL_MD = `---
name: aio-documents
description: Create, modify and convert Word/Excel/PowerPoint/PDF documents inside the AIO sandbox with python-docx, openpyxl, python-pptx and headless LibreOffice. Use for generating reports, spreadsheets with formulas, slide decks, or converting between Office/PDF formats.
---

# 沙箱文档工具

在沙箱内创建、修改和转换文档。所有处理都在沙箱里完成，不依赖宿主机 Office。

## 先检查工具是否就绪

\`\`\`bash
/home/gem/.codex/tools/aio-doc/bin/aio-doc doctor        # 一次输出 CLI 与 Python 库的就绪状态
\`\`\`

未就绪时不要假装成功：告诉用户工具未安装，并让其在工作区「文件」页底部展开「文档处理」，点「安装/修复」。

## 首选入口：\`aio-doc\`

命令安装在 \`/home/gem/.codex/tools/aio-doc/bin/aio-doc\`（不在 PATH 上，用绝对路径调用）：

\`\`\`bash
/home/gem/.codex/tools/aio-doc/bin/aio-doc --help
\`\`\`

常用命令：

- Word：\`aio-doc docx-new <path> --text "..."\`、\`docx-read\`、\`docx-append\`
- Excel：\`aio-doc xlsx-new <path> --rows "a,b"\`、\`xlsx-set <path> B4 --value "=SUM(B1:B3)"\`、\`xlsx-read --values\`
- PPT：\`aio-doc pptx-new <path> --titles "第一页"\`、\`pptx-read\`
- 转换：\`aio-doc convert <path> --to pdf\`（也支持 docx/xlsx/pptx/csv/txt）
- PDF 文本：\`aio-doc pdf-text <path>\`

路径一律用工作区内的绝对路径（\`/home/gem/workspace/...\`）。工具只读写工作区内的文件。下文为简洁仍写作 \`aio-doc\`，实际请用上面的绝对路径。

## 直接使用 Python 库

需要更细的控制时直接用库（与 \`aio-doc\` 使用同一个隔离 venv）：

\`\`\`bash
/home/gem/.codex/tools/aio-doc/venv/bin/python -c 'from docx import Document; d = Document(); d.add_paragraph("你好"); d.save("/home/gem/workspace/报告.docx")'
\`\`\`

可用：\`docx\`（python-docx）、\`openpyxl\`、\`pptx\`（python-pptx）、\`pypdf\`、\`reportlab\`。
中文要指定字体（如 \`宋体\` / \`Noto Sans CJK SC\`）并确认渲染效果。

## Excel 公式的硬性规则

**openpyxl 不会计算公式。** 写入 \`=SUM(A1:A5)\` 只保存公式字符串，没有缓存值；
不重算的读取方会看到空白。因此：

1. 用 \`xlsx-set\` 或 openpyxl 写公式；
2. 用 \`aio-doc xlsx-recalc <path>\` 让 LibreOffice 重算并写入缓存值。默认输出到新文件
   \`<原名>.recalc.xlsx\`，**不覆盖原文件**；只有显式 \`--in-place\` 才覆盖原件，
   用 \`--out <path>\` 可指定输出路径；
3. 用 \`aio-doc xlsx-read <path> --values\` 确认缓存值真的出现。

只有第 3 步有真实数字才算成功；不要因为写入了公式就报告计算完成。

## LibreOffice 转换

\`\`\`bash
soffice --headless --norestore --nolockcheck --nodefault --nologo \
  -env:UserInstallation=file:///tmp/lo-profile-$$ \
  --convert-to pdf --outdir /home/gem/workspace/out /home/gem/workspace/输入.docx
\`\`\`

- 每次用一个独立的 \`-env:UserInstallation\`，避免与其它转换互相干扰。
- 不要加 \`--\` 分隔符：LibreOffice 7.3 会直接报 \`Error in option: --\`。路径本身是绝对路径，
  不会被当成选项。
- 输出到工作区内的新文件，**不要覆盖用户原件**。
- 字体与复杂排版可能与用户本机 Office 有差异，不要承诺 100% 保真；转换后要实际检查结果。
- 旧格式（.doc/.xls/.ppt）可先转成现代格式再处理。

## 交付

生成的文件放在 \`/home/gem/workspace\` 下的项目目录或 \`.scratch/artifacts/<topic>/\`，
不要散落在工作区根目录。最终回复交付文档链接与关键内容、必要限制；命令和检查步骤放在过程说明中，
不要在最终回复或交付文档中罗列使用的 skill、工具或命令，除非用户明确询问。
`;

export const CODEX_CONFIG_TOML = `# 由 AIO Agent 生成；如果你自行修改，系统不会覆盖此文件。
approval_policy = "never"
sandbox_mode = "danger-full-access"
[mcp_servers.aio_browser]
url = "http://127.0.0.1:8080/mcp"

# Codex 本地 memory 开关（等价于命令行 \`codex features enable memories\`）；
# 记忆由后台在会话闲置后生成，不会立即出现。
[features]
memories = true
apps = false
plugins = false
remote_plugin = false

[apps._default]
enabled = false
`;

// System policy applies to both existing and newly created sandboxes, including
// CLI sessions started from their terminal. Keep personal account connectors out
// even when project/user config or a CLI override attempts to enable them.
export const CODEX_ISOLATION_MARKER = "# Managed by personal-agent: sandbox MCP isolation";
export const CODEX_REQUIREMENTS_TOML = `${CODEX_ISOLATION_MARKER}
[features]
apps = false
plugins = false
remote_plugin = false

[mcp_servers.aio_browser.identity]
url = "http://127.0.0.1:8080/mcp"

[mcp_servers.aio_tabs.identity]
url = "http://127.0.0.1:8190/mcp"
`;

/**
 * The policy for one runtime: the sandbox's own servers, plus the gateway tools this
 * account was given (Codex disables a thread's MCP server whose exact URL is not listed).
 */
export function codexRequirementsToml(cfg: { decision?: { url: string }; schedule?: { url: string }; image?: { url: string }; kb?: { url: string } }): string {
  const gateway = ([["aio_decision", cfg.decision], ["aio_schedule", cfg.schedule], ["aio_image", cfg.image], ["aio_kb", cfg.kb]] as const)
    .filter(([, server]) => server)
    .map(([name, server]) => `\n[mcp_servers.${name}.identity]\nurl = ${JSON.stringify(server!.url)}\n`);
  return CODEX_REQUIREMENTS_TOML + gateway.join("");
}

export const CODEX_ISOLATION_OVERRIDES = [
  "-c", "features.apps=false",
  "-c", "features.plugins=false",
  "-c", "features.remote_plugin=false",
  "-c", "apps._default.enabled=false",
];

/**
 * User-level CLAUDE.md for the Claude Code harness. It reads the workspace rules
 * Codex reads natively, and the same long-term memory Codex keeps: switching
 * executor must not make the assistant forget earlier work. Codex owns that
 * directory (it rebuilds it from its sessions), so Claude Code only reads it.
 */
export function claudeCodeUserMemory(workspaceDir: string, codexHome: string): string {
  const memories = `${codexHome}/memories`;
  return `@${workspaceDir}/AGENTS.md

# 长期记忆（与 Codex 执行器共用）

下面是此前积累的长期记忆总览（包括在 Codex 执行器上完成的工作）：

@${memories}/memory_summary.md

- 用户问到过去做过的事、之前的安排或偏好时，先查这些记忆，不要直接说没有记录。
- 需要细节时，在 \`${memories}/MEMORY.md\` 里按关键词找到对应任务组，再读其中列出的 \`${memories}/rollout_summaries/\` 摘要；任务产出的文件在 \`${workspaceDir}/tasks/\` 下。
- 记忆可能过时：价格、路况、天气、营业时间等随时间变化的信息，使用前重新核实。
- 这个目录由 Codex 自动维护，只读，不要修改。
`;
}

/**
 * Public share pages. The CLI and its skill are managed like the document
 * skill; the per-runtime config holding the share token is written beside the
 * CLI only when the control plane provisioned sharing.
 */
export const SHARE_TOOL_DIR = "tools/aio-share";
export const SHARE_SKILL_DIR = "skills/aio-share";
export const SHARE_CLI_PY = String.raw`#!/usr/bin/env python3
"""aio-share: publish a page directory as a public web page (managed by AIO Agent)."""
import argparse, base64, json, os, re, sys, urllib.error, urllib.request

CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
MAX_FILES, MAX_BYTES = 200, 20 * 1024 * 1024


def fail(message):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(1)


def call(method, path, body=None):
    try:
        with open(CONFIG) as f:
            cfg = json.load(f)
    except OSError:
        fail("分享功能未启用：缺少 " + CONFIG)
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(cfg["endpoint"] + path, data=data, method=method,
                                 headers={"authorization": "Bearer " + cfg["token"], "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            raw = res.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        try:
            fail(json.loads(err.read()).get("error") or "HTTP %d" % err.code)
        except ValueError:
            fail("HTTP %d" % err.code)
    except OSError as err:
        fail("无法连接分享服务：%s" % err)


def collect(root):
    files, total = [], 0
    for base, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(names):
            if name.startswith("."):
                continue
            full = os.path.join(base, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as f:
                data = f.read()
            total += len(data)
            files.append({"path": rel, "data": base64.b64encode(data).decode()})
    if not any(f["path"] == "index.html" for f in files):
        fail("目录里没有 index.html：" + root)
    if len(files) > MAX_FILES:
        fail("文件数 %d 超过上限 %d" % (len(files), MAX_FILES))
    if total > MAX_BYTES:
        fail("总大小 %.1f MB 超过上限 20 MB" % (total / 1024 / 1024))
    return files


def main():
    parser = argparse.ArgumentParser(prog="aio-share", description="把页面目录发布成公开网页；同名再次发布即更新，链接不变。")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("publish", help="发布或更新页面")
    p.add_argument("dir", help="页面目录，必须包含 index.html")
    p.add_argument("--name", help="页面名（小写字母、数字、连字符），默认取目录名")
    p.add_argument("--title", help="页面标题（用于列表）")
    sub.add_parser("list", help="列出已发布的页面")
    d = sub.add_parser("delete", help="删除页面（链接随即失效）")
    d.add_argument("name")
    args = parser.parse_args()

    if args.cmd == "list":
        print(json.dumps(call("GET", "/pages"), ensure_ascii=False, indent=2))
    elif args.cmd == "delete":
        if not NAME.match(args.name):
            fail("页面名不合法：" + args.name)
        call("DELETE", "/pages/" + args.name)
        print(json.dumps({"ok": True, "deleted": args.name}, ensure_ascii=False))
    else:
        root = os.path.abspath(args.dir)
        if not os.path.isdir(root):
            fail("不是目录：" + root)
        name = args.name or re.sub(r"[^a-z0-9-]+", "-", os.path.basename(root).lower()).strip("-")[:63]
        if not NAME.match(name):
            fail("页面名不合法，请用 --name 指定小写字母、数字和连字符组成的名字")
        page = call("POST", "/pages/" + name, {"title": args.title, "files": collect(root)})
        page["ok"] = True
        print(json.dumps(page, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
`;

export const SHARE_SKILL_MD = `---
name: aio-share
description: Publish a web page the user can share with anyone as a public link (/u/<user>/share/<name>/). Use when the user wants a shareable page, a link to send others, or to update, list or delete pages already shared.
---

# 分享网页（公开）

把一个页面目录发布成**任何人拿到链接都能打开**的网页。没有密码、没有私密模式。

## 发布前必须确认

- 页面是公开的：不要放用户没有明确同意公开的个人信息（住址、电话、证件、行程细节、账号、内部链接），
  也不要放任何密钥或令牌。拿不准时先问用户。
- 用户只是想看结果、没说要分享时，不要发布；在工作区里做好页面给用户看即可。

## 做页面

1. 页面目录放在 \`/home/gem/workspace/share/<name>/\`，入口必须是 \`index.html\`。
   \`<name>\` 用小写字母、数字、连字符，简短有意义（如 \`tokyo-trip-plan\`），它就是链接的一部分。
2. 优先做成单个自包含的 \`index.html\`；需要图片、CSS、JS 时放在同一目录里用**相对路径**引用。
   上限 200 个文件、总计 20 MB，以点开头的文件不会上传。
3. 适配手机（\`<meta name="viewport" content="width=device-width, initial-scale=1">\`），中文字体要有回退。
4. 页面在隔离环境中运行：脚本可以执行，也可以请求允许跨域的外部接口，
   但**不能使用 cookie、localStorage、sessionStorage**，也不能读写工作区。需要保存状态的交互不要做。
5. 发布前先在沙箱浏览器里打开 \`file:///home/gem/workspace/share/<name>/index.html\` 检查效果。

## 发布、更新、查看、删除

命令（不在 PATH 上，用绝对路径）：

\`\`\`bash
python3 /home/gem/.codex/tools/aio-share/aio-share.py publish /home/gem/workspace/share/<name> --title "页面标题"
python3 /home/gem/.codex/tools/aio-share/aio-share.py list
python3 /home/gem/.codex/tools/aio-share/aio-share.py delete <name>
\`\`\`

- \`publish\` 默认用目录名作页面名，也可用 \`--name\` 指定。输出 JSON，其中 \`url\` 就是公开链接。
- **同名再次发布就是更新**，链接不变，旧内容被整体替换。新建页面前先 \`list\`，避免覆盖已有页面。
- 删除后链接立即失效，无法恢复；只在用户要求时删除。
- 命令失败时如实转述 \`error\`，不要假装发布成功。

## 交付

把 \`url\` 用简短有意义的标题作为链接发给用户，并说明「任何拿到链接的人都能看到」。
`;

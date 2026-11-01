# iOS App Store 发布

iOS App 是 `src/ui/tauri` 的 Tauri 壳（见该目录 README），加载线上控制台 `https://agent.clawpage.ai`；界面随 UI 部署更新，
只有原生改动（权限说明、隐私清单、图标、桥接）需要重新打包送审。Android 的对应流程见 [play-console.md](play-console.md)。

## 送审前提

- **付费 Apple Developer Program**：免费个人 team（`Z3T74M8F47`，`tauri.conf.json` 的 `bundle.iOS.developmentTeam`）只能装到自己的手机、7 天过期，
  不能上传 App Store Connect。送审用付费 team 的 ID 替换 `developmentTeam`（个人或公司账号均可；公司账号需要 D-U-N-S）。
- App Store Connect 里新建 App：平台 iOS，Bundle ID `ai.clawpage.agent`（与 Android 包名相同），SKU 自定，主要语言建议简体中文。
  名称在 App Store 全局唯一；被占用时改用 `Clawpage Agent - AI 助手` 之类再试。
- 账号持有人需接受最新的 Program License Agreement，免费 App 不需要签付费协议与税务信息。

## 原生包里已经准备好的

| 要求 | 位置 |
| --- | --- |
| 隐私清单（必需理由 API：文件时间戳 `C617.1`；收集的数据类型与下方 App 隐私一致；不追踪） | `gen/apple/aio-agent-tauri_iOS/PrivacyInfo.xcprivacy` |
| 出口合规：只用 HTTPS，`ITSAppUsesNonExemptEncryption = false`，上传后不再问加密问题 | `gen/apple/project.yml` → `Info.plist` |
| 只支持 iPhone（`TARGETED_DEVICE_FAMILY = 1`）：不需要 iPad 截图；iPad 上以兼容模式运行 | `gen/apple/project.yml` |
| 主屏名称与权限说明四种语言：英/西 Clawpage，中文一站；麦克风、相机、存入相册 | `gen/apple/Localization/<语言>.lproj/InfoPlist.strings` |
| 1024 图标不透明（App Store 拒收带 alpha 的图标） | `Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` |
| 版本 `0.1.2`，构建号每次上传递增（`--build-number`） | `tauri.conf.json` `version` |

改 `project.yml` 后在 `gen/apple` 跑 `xcodegen generate`；重新 `tauri ios init` 会覆盖 `gen/`，以上各项要重新放回。

## 构建与上传

在 `src/ui/tauri`，付费 team 已登录 Xcode（Xcode → Settings → Accounts）后：

```bash
env -u NODE_ENV npm run -- tauri ios build --target aarch64 --export-method app-store-connect --build-number 1
# 产物：src-tauri/gen/apple/build/arm64/AIOAgent.ipa；归档：src-tauri/gen/apple/build/aio-agent-tauri_iOS.xcarchive
```

上传任选其一：Xcode → Window → Organizer 打开上面的 xcarchive → Distribute App → App Store Connect；
或用 Apple 的 Transporter App 拖入 ipa。上传后约 10–30 分钟出现在 App Store Connect 的 TestFlight，处理完才能选进版本。
建议先用 TestFlight 内部测试装到真机走一遍下方的真机清单，再提交审核。

## App Store Connect 填写

商店文案（名称 30、副标题 30、宣传文本 170、关键词 100、描述 4000 字符以内，已校验）在
`docs/assets/app-store/<语言>/listing.json`：`zh-Hans`、`zh-Hant`、`en-US`、`es-MX`。
截图由 `scripts/app-store.mts` 用真实界面和虚构演示任务生成（6.9 英寸 1320×2868；不登录真实账号）。

- 类别：效率（Productivity），次要类别可选“工具”。价格：免费。不含 App 内购买，App 里没有任何付费或外部购买入口。
- 支持网址 / 营销网址：`https://agent.clawpage.ai/about.html`（含支持邮箱 `feedback@clawpage.ai`）；
  隐私政策：`https://agent.clawpage.ai/privacy.html`。这些页面都有四种语言。
- 版权：`2026 <开发者账号上的法定名称>`。
- 年龄分级问卷如实回答：无暴力、色情、赌博等内容；**无限制网络访问：是**（任务浏览器可打开任意网页）；
  用户生成内容/聊天：AI 生成的回复，没有用户之间的私信或公开社区；有应用内举报。分级结果以 Connect 计算为准（预计最高一档）。
- App 隐私（“数据用于追踪你”：否；以下都“与用户身份关联”）：
  - 联系信息 › 电子邮件地址：App 功能（注册登录）。
  - 标识符 › 用户 ID：App 功能。
  - 用户内容 › 照片或视频、音频数据、客户支持、其他用户内容：App 功能（附件、语音输入、举报与删除申请、任务与文件）。
  - 使用数据 › 产品交互：分析（自建统计，不含消息内容，保留不超过 400 天，见隐私政策“使用统计”）。
  - 不收集：位置、健康、财务、通讯录、浏览历史、诊断数据、广告数据。
- 账号删除（准则 5.1.1(v)）：应用内 侧栏 → 账户与隐私 → 申请删除账户；外部网页 `https://agent.clawpage.ai/account-deletion.html`。

## 审核信息

- 登录信息：审核专用普通成员 `apple-reviewer`，空白工作区，没有 owner 权限、知识库/家庭设备/打印机授权；
  密码只存在被忽略的 `var/user-secrets/apple-reviewer.txt`（0600，控制面卷内 `/data/user-secrets/` 同一份），复制进 Connect，不进仓库。
  它和 Google Play 的 `play-reviewer` 分开，便于分别停用。
- 联系人：填开发者本人的姓名、电话、邮箱（`feedback@clawpage.ai`）。
- 备注（英文，直接粘贴）：

```text
Clawpage Agent is an AI task assistant. Sign in with the demo account above (email field accepts the username).

Suggested test: type "Make a checklist for a short weekend trip" in the main chat and send it. The AI plans and works on it as a task; tap the task to see progress and the result, then add a follow-up in the same task.

Native features in this app:
- Voice input: tap the microphone in the message box (asks for microphone permission), speak, tap again; the words appear as a draft.
- Camera and files: the attachment button offers Take Photo/Video and file picking (camera permission).
- Links in replies open in an in-app Safari sheet; downloaded images can be saved to Photos via the share sheet.
- The app still opens its last page without a network connection.

Account deletion: side menu > Account & privacy > Request account deletion (the administrator verifies the request and deletes the account and its data). Reporting: each finished reply has "Report response".
There are no purchases. AI replies come from the service's configured model providers (OpenAI; Anthropic optional).
The task browser can visit arbitrary websites on the user's request, so the age rating declares unrestricted web access.
```

## 真机清单（TestFlight 安装后）

冷启动加载控制台；登录审核账号与 owner 各一次，杀进程后仍保持登录；刘海与底部安全区；键盘不遮输入框；
语音输入首次弹出麦克风授权并能转写；附件“拍照”弹出相机授权、不闪退；回复里的外部链接在 Safari 面板打开并能关闭回到原处；
下载图片走分享面板“存储图像”不闪退；“账户与隐私”打开删除申请页面；飞行模式冷启动显示离线页、恢复网络后自动重新加载；
系统语言切到英文后主屏名称为 Clawpage、权限弹窗为英文。

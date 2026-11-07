# iOS App Store 发布

iOS App 是 `src/ui/tauri` 的 Tauri 壳（见该目录 README），加载线上控制台 `https://agent.clawpage.ai`；界面随 UI 部署更新，
只有原生改动（权限说明、隐私清单、图标、桥接）需要重新打包送审。Android 的对应流程见 [play-console.md](play-console.md)。

## 送审前提

- **付费 Apple Developer Program**：team `MGS58YVTW7`（`tauri.conf.json` 的 `bundle.iOS.developmentTeam` 与 `project.pbxproj`）。
  旧的免费个人 team `Z3T74M8F47` 只能装到自己的手机、7 天过期，不能上传。
- App ID `ai.clawpage.agent` 已开 Sign in with Apple（`APPLE_ID_AUTH`，与 entitlements 的 `com.apple.developer.applesignin` 对应）。
- App ID 已开 Push Notifications（`PUSH_NOTIFICATIONS`，entitlements 的 `aps-environment`；仓库里写 `development`，导出 App Store 包时 Xcode 按发布描述文件改成 `production`）。
  服务器发通知要另一把 APNs 密钥（Apple Developer → Keys，勾 APNs，Sandbox & Production），放进控制面数据目录并配 `PA_APNS_*`（`docs/CONFIGURATION.md`）；App Store Connect API 密钥不能发通知。
- App Store Connect 的 App：「一站 Clawpage Agent」，Apple ID `6830089706`，SKU `aio-agent-ios`，主要语言简体中文。
- 账号持有人需接受最新的 Program License Agreement，免费 App 不需要签付费协议与税务信息。

## 原生包里已经准备好的

| 要求 | 位置 |
| --- | --- |
| 隐私清单（必需理由 API：文件时间戳 `C617.1`；收集的数据类型与下方 App 隐私一致；不追踪） | `gen/apple/aio-agent-tauri_iOS/PrivacyInfo.xcprivacy` |
| 出口合规：只用 HTTPS，`ITSAppUsesNonExemptEncryption = false`，上传后不再问加密问题 | `gen/apple/project.yml` → `Info.plist` |
| 只支持 iPhone（`TARGETED_DEVICE_FAMILY = 1`）：不需要 iPad 截图；iPad 上以兼容模式运行 | `gen/apple/project.yml` |
| 主屏名称与权限说明四种语言：英/西 Clawpage，中文一站；麦克风、相机、存入相册 | `gen/apple/Localization/<语言>.lproj/InfoPlist.strings` |
| 1024 图标不透明（App Store 拒收带 alpha 的图标） | `Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` |
| 版本 `0.1.3`，构建号每次上传递增（`--build-number`）；改版本同时改 `project.yml` 与 `Info.plist` 里的版本号 | `tauri.conf.json` `version` |

改 `project.yml` 后在 `gen/apple` 跑 `xcodegen generate`；重新 `tauri ios init` 会覆盖 `gen/`，以上各项要重新放回。

## 构建与上传

签名用 App Store Connect API 密钥（Admin），不需要在 Xcode 登录账号：Xcode 按密钥自动生成发布证书和描述文件。
密钥 `AuthKey_<Key ID>.p8` 放在 `var/user-secrets/`（Git 忽略），Key ID 与 Issuer ID 在 App Store Connect →「用户和访问」→「集成」。
在 `src/ui/tauri`：

```bash
env -u NODE_ENV APPLE_API_KEY=<Key ID> APPLE_API_ISSUER=<Issuer ID> APPLE_API_KEY_PATH=$PWD/../../../var/user-secrets/AuthKey_<Key ID>.p8 \
  npm run -- tauri ios build --target aarch64 --export-method app-store-connect --build-number <N>
# 产物：src-tauri/gen/apple/build/arm64/AIOAgent.ipa；归档：src-tauri/gen/apple/build/aio-agent-tauri_iOS.xcarchive
```

上传任选其一：Xcode → Window → Organizer 打开上面的 xcarchive → Distribute App → App Store Connect；
或用 Apple 的 Transporter App 拖入 ipa。上传后约 10–30 分钟出现在 App Store Connect 的 TestFlight，处理完才能选进版本。
建议先用 TestFlight 内部测试装到真机走一遍下方的真机清单，再提交审核。

## App Store Connect 填写

商店文案（名称 30、副标题 30、宣传文本 170、关键词 100、描述 4000 字符以内，已校验）在
`docs/assets/app-store/<语言>/listing.json`：`zh-Hans`、`zh-Hant`、`en-US`、`es-MX`。
截图由 `scripts/store-shots.mts` 生成（与 Google Play 共用，用法见脚本开头）：真实界面加虚构演示任务，不登录真实账号；
截取主会话、执行过程、引用补充、侧栏与整屏的片段，排成五张海报（大标题 + 倾斜卡片，品牌靛紫与荧光黄绿），
输出到 `app-store/<语言>/`，6.9 英寸 1320×2868、无透明通道（Connect 的 `APP_IPHONE_67` 截图组）。
颜色取自 `src/ui/src/theme.css`，标题字体用 macOS 的 PingFang / SF，须在 Mac 上生成。
已上架（`READY_FOR_SALE`）或在审的版本不能换截图：要么在新版本里换，要么先从审核中撤回当前版本、换好后重新提交。

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

Sign in with Apple is offered first on the sign-in screen, alongside Google sign-in; a new Apple ID gets its own account (the private relay email works).
Account deletion: side menu > Account & privacy > Request account deletion (the administrator verifies the request and deletes the account and its data). Reporting: each finished reply has "Report response".
There are no purchases. AI replies come from the service's configured model providers (OpenAI; Anthropic optional).
The task browser can visit arbitrary websites on the user's request, so the age rating declares unrestricted web access.
```

## 真机清单（TestFlight 安装后）

冷启动加载控制台；登录审核账号与 owner 各一次，杀进程后仍保持登录；刘海与底部安全区；键盘不遮输入框；
语音输入首次弹出麦克风授权并能转写；附件“拍照”弹出相机授权、不闪退；回复里的外部链接在 Safari 面板打开并能关闭回到原处；
下载图片走分享面板“存储图像”不闪退；“账户与隐私”打开删除申请页面；飞行模式冷启动显示离线页、恢复网络后自动重新加载；
系统语言切到英文后主屏名称为 Clawpage、权限弹窗为英文。

## 2026-11-06 0.1.3：存入相册（TestFlight）

- 原生改动：`aioSaveMedia` 桥把页面已有的图片、视频直接写进相册（`DeviceBrowser.swift` 的 `SaveMediaHandler`，只要「添加到相册」权限），见 `docs/FEATURES.md`。
- 构建 `0.1.3 (0.1.3.1)`，`altool` 上传成功（Delivery UUID `93ac50bf-1d82-4cb1-ac98-fa6a14f06be6`），处理为 VALID 后加入外部测试组、
  填中英文「测试内容」并提交 Beta 审核，状态 `WAITING_FOR_REVIEW`。审核通过前外部测试者拿不到；未在真机上实际存过一次，也未验过首次权限弹窗。

## 2026-11-06 0.1.3 (0.1.3.2)：前台不弹通知、震动（TestFlight）

- 原生改动（`DeviceBrowser.swift`）：App 在前台时不显示通知，变为活跃时清掉已送达的通知；`aioHaptic` 桥按控制台的请求震动（`HapticHandler`），见 `docs/FEATURES.md`「手机通知」「语音输入」。
- `altool` 上传成功（Delivery UUID `86924b5e-daa2-478e-a8b6-42dceeda90f3`），只上传，未加入外部测试组或提交 Beta 审核；未在真机上验过震动和清通知。

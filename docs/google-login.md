# Google 登录与首次邀请码

Google 登录/注册与原有密码登录并存。Google 首次认证只得到 10 分钟有效的待注册身份；用户选定账号并提交有效的一次性邀请码后，才原子地创建 `member`、关联 Google 身份、消费邀请码并签发应用会话。待注册身份不能调用成员 API，也不会创建沙箱。之后同一 Google `sub` 直接登录，不再索要邀请码。

Google 邮箱用于展示，不能据此自动关联既有账号或获得 owner 权限。既有密码账号不会被自动迁移；目前没有账号合并或 Google 绑定入口。OAuth-only 成员的密码为不公开的随机值，使用 Google 登录。

## 配置

1. 在 Google Cloud 的 Google Auth Platform 配置外部受众、应用名称与支持邮箱。只使用 `openid email`，不申请 Google Drive、Gmail 或其他 API 访问权限。
2. 创建 **Web application** OAuth 客户端，授权回调精确为 `https://agent.clawpage.ai/api/auth/google/callback`。系统浏览器和 Web 共用服务端回调；Android 不在 WebView 中加载 Google 登录页。
3. 将 client ID 写入私有 `var/runtime.env` 的 `PA_GOOGLE_CLIENT_ID`。将 client secret 写入权限为 `0600` 或 `0400` 的独立私有 env 文件，格式为 `PA_GOOGLE_CLIENT_SECRET=...`，用 `PA_GOOGLE_SECRETS_FILE` 指定绝对路径。也支持进程环境里的 `PA_GOOGLE_CLIENT_SECRET`，不可提交或打印。
4. `PA_GOOGLE_REDIRECT_URI` 默认使用 `PA_PRIMARY_HOST` 的上述回调路径。HTTPS 为默认要求；本地集成测试可用已配置的 `http://localhost:<port>` 回调。
5. 按既有生产启动路径构建并重启 personal-agent，再做真实 Google 登录验收。凭据未配置时 Google 按钮隐藏，密码登录保持可用。Cloud 测试/生产状态与 Google 的应用验证要求单独核对。

当前 compose 部署使用 `AIO_CONTROL_ENV_FILE` 里的 client ID 与 `AIO_SECRET_GOOGLE_OAUTH` 指定的私有密钥文件；不要把宿主机路径直接写进容器的 `PA_GOOGLE_SECRETS_FILE`。见 [部署说明](../deploy/README.md)。

## 安全与原生返回

服务端使用 Google 官方 `google-auth-library` 验证 ID token 的签名、issuer、audience，并核对 nonce、授权方及已验证邮箱。授权码采用 PKCE；state 与浏览器 HttpOnly Cookie 绑定，Web 回调还必须匹配发起浏览器。授权码回调在网络请求前一次性认领，不能重放。Google 错误不会直接返回前端或写日志。访问/刷新令牌不落库。

Android 的 `ai.clawpage.agent` 用 Custom Tab 打开授权入口；iOS 用 AuthenticationServices。原生回调为 `aioagent://auth?ticket=...`。ticket 只能与发起 App WebView 持有的 HttpOnly Cookie 配对消费一次，单独拦截深链不能登录；待邀请码阶段只能读取本人的待注册邮箱。桥接回调仅交给 `https://agent.clawpage.ai` 主页面。临时 state、PKCE verifier 与 nonce 在 10 分钟后失效，下一次登录发起时清理；成功或取消立即删除相应记录。

Android 在打开系统浏览器前及 Activity 暂停时调用 `CookieManager.flush()`，保存发起登录的 HttpOnly Cookie。仅把 Cookie 留在 WebView 内存里会使授权期间进程被结束后的 ticket 兑换失败；不能通过取消 Cookie 绑定来修复。

首次邀请码支持已有的规范化、撤销、一次性消费、用户名校验、IP 错误次数限制。身份关联和邀请码消费在同一个数据库事务内，失败不留下成员账号或已消费的邀请码。

## 验证入口

- `npm run typecheck && npm test`
- `npm run build`
- `npx playwright test --config playwright.local.config.ts tests/e2e/google-login.spec.ts tests/e2e/register.spec.ts tests/e2e/login-restore.spec.ts`
- 服务端测试：`tests/integration/google-login.test.ts`。Google 交换和签名验证调用在隔离测试中替换为明确的假服务，测试不能当作真实 Google 登录成功。
- Android 重新打包后安装到连接的手机，实际验证系统浏览器认证、返回 App、首次邀请码、再次登录。原生桥改动需要新 APK，不能靠 UI 发布替代。

参考：[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)、[Google OAuth 政策](https://developers.google.com/identity/protocols/oauth2/policies)。

## 2026-10-11 实际部署与真机验收

Google Cloud 专用项目 `main-voltage-511319-c3` 已创建 Web 登录客户端并启用上述回调。凭据存于私有 `var/google-auth/`。
品牌主页、隐私与条款 URL 已保存，支持邮箱为 `feedback@clawpage.ai`；OAuth Audience 已切换为 Production。
配置支持邮箱时给专用 Google 账号的项目级 OAuth Config Editor 临时权限已撤回，原 Owner 保留。

已有 compose 的 control 与 ui 两层已刷新并健康，公共双域 smoke 39/39 通过。Google 首次注册、无效邀请码拒绝、有效邀请码一次性消费、普通成员权限、再次登录免邀请码均在连接的 Galaxy Z Flip6（Android 16、正式签名 `ai.clawpage.agent`）实际验证。授权时结束 App 进程，再由真实 Google 回调冷启动 App，能直接进入主会话；随后独立结束/重启 App 仍保留登录。Web UI 的 Google 彩色标志及移动布局已在该手机检查。

新支持账号另已完成真实 Google 授权，服务端核对流程到达原生 `handoff`；桌面测试没有完成深链返回及邀请码 UI，未创建 AIO 成员。
Play 正式版及资料的 11 项变更已提交，当前正在审核、尚未上线；这不代表 iOS 真机 Google 回调或 Play 分发安装已经验收。

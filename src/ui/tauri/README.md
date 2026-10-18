# 一站 mobile app (Tauri 2)

The iOS and Android app is a shell around the deployed console at
`https://agent.clawpage.ai`: it opens that page in a full-screen web view and
provides a narrow native browser bridge. The console is the same UI code as the
web version (`src/ui/src`), so a UI change ships with the next UI deploy. Native
bridge changes require an app update. Change this directory only for native
concerns (web view insets, keyboard, icons, signing).

Only the main frame at `https://agent.clawpage.ai` can ask the bridge to open an
HTTP(S) URL. The page gets no Tauri IPC. `fallback/` is only the bundled
`frontendDist`; the window opens the remote URL, so it is not an offline page.

## Offline

Without a network the app still opens: the console's service worker
(`src/ui/public/sw.js`, see "无网打开" in `docs/FEATURES.md`) serves the last console
page that loaded, which shows "现在连不上一站" and reloads to the latest deployed UI
as soon as the server answers. Online, the page always comes from the server.
The shell itself bundles no UI, so a UI change still ships with the next UI deploy.

- Android: WebView runs service workers as is, but never learns about connectivity by
  itself (`navigator.onLine` stays true, no `online` event). `MainActivity.kt` follows the
  default network and calls `setNetworkAvailable` (needs `ACCESS_NETWORK_STATE`), so the
  page says the device is offline and reloads the moment the network is back (0.1.2).
- iOS: WKWebView runs service workers only with App-Bound Domains. The main window
  sets `limitNavigationsToAppBoundDomains` (`src-tauri/tauri.conf.json`), and
  `WKAppBoundDomains` (`gen/apple/project.yml` and the generated `Info.plist`) lists
  `localhost`, `clawpage.ai` (console and workspace), `youtube-nocookie.com` and
  `bilibili.com` (embedded players; see `frame-src` in `src/ui/edge.mjs`). The web view
  can no longer navigate to any other site; outside links already open in the system
  browser. A new embedded site must be added here and needs a new app build (at most 10).
- A device that never opened the console online has no saved page and shows the
  web view's own error page.

## Native adjustments

- Google authentication opens a system authentication browser and returns to the
  console with a single-use ticket bound to its initiating HttpOnly cookie.
  Android handles `aioagent://auth` in `MainActivity.kt`; iOS uses
  `ASWebAuthenticationSession`. Both dispatch `aio-google-return` only to the
  console origin. First-time Google users must then submit an invite code before
  receiving an application session. See [Google login](../../../docs/google-login.md).
  The application identifier is `ai.clawpage.agent`; artifacts and device tests
  built with the previous identifier must be replaced before Play submission.

- Public conversation links open with SafariServices on iOS (`DeviceBrowser.swift`)
  or the device browser Custom Tab on Android (`MainActivity.kt`, AndroidX Browser).
  Both request an initial height near 90%; iOS 15 uses the system sheet default.
  The OS/browser may expand the panel. Private IP links retain sandbox routing.
  The web version opens a normal browser tab and cannot set the system sheet height.
  Regression: `tests/e2e/device-links.spec.ts`; native panel acceptance also requires
  installing the new shell. No remote Tauri capability is enabled.

- Policy and account-deletion links on sign-in and account dialogs use the same
  system browser bridge. This preserves the App WebView, session and unsent form
  when the user closes the browser. Without the bridge, a `target="_blank"` page
  can replace the Android WebView and Back exits the App. Regression:
  `tests/e2e/support.spec.ts`; the shared UI fix needs a UI deploy, not a new shell.

- iOS: the web view covers the whole screen (`contentInsetAdjustmentBehavior = never`,
  `src-tauri/src/lib.rs`); the console reads all four `env(safe-area-inset-*)`
  into `--safe-top/right/bottom/left` in `src/ui/src/styles.css`.
  The app grid owns the page insets; nested page headers/composers must not add
  them again. Fixed surfaces (drawers, workspace, previews, task console, image
  viewer, map sheet) own their own insets because they bypass the grid. Dialog
  height limits subtract the same insets and spacing as their backdrop. Never
  substitute a fixed status-bar height. The bottom inset becomes zero while the
  keyboard is open, and `--viewport-height` follows the keyboard viewport.
  [WebKit's safe-area guidance](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)
  explains `viewport-fit=cover` and the four environment variables.
  Regression: `npx playwright test --config playwright.local.config.ts tests/e2e/safe-area.spec.ts`
  from the repository root after `npm run build:ui`. These tests inject nonzero
  insets into the shared tokens (headless browsers report zero), use real page
  interactions, and cover portrait, landscape, short viewports and keyboard
  resizing in Chromium/WebKit. They do not replace native-device acceptance.
- Microphone (the composer's voice input, `getUserMedia` in the web view): iOS declares
  `NSMicrophoneUsageDescription` (`gen/apple/project.yml` and the generated `Info.plist`);
  wry grants the page's capture request and the system asks once. Android declares
  `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS` (`AndroidManifest.xml`); wry's chrome client
  asks for the runtime permission when the page first records.
- Saving files (the console's 下载): WKWebView ignores download links, so the console hands the file to the
  web share sheet instead. Its "Save Image" writes to Photos, which needs `NSPhotoLibraryAddUsageDescription`
  (`gen/apple/project.yml` and the generated `Info.plist`) or iOS kills the app on that tap. The shell registers
  an `aioSaveFiles` message handler as a marker (`DeviceBrowser.swift`); the console uses the share sheet only
  when it sees the marker, so an older shell keeps the plain link. Regression: `tests/e2e/home-screen-save.spec.ts`.
- Camera (the attachment picker's "Take Photo/Video"): iOS declares `NSCameraUsageDescription`
  (`gen/apple/project.yml` and the generated `Info.plist`). Without it iOS kills the app the
  moment the camera opens (TCC: "attempted to access privacy-sensitive data without a usage
  description"); the crash log on the phone names the missing key.
- Android: edge to edge, the window is no longer resized for the keyboard, so the
  activity gives the keyboard's height back as bottom padding
  (`gen/android/.../MainActivity.kt`).
- Android: the Rust library is linked for 16 KB pages (`src-tauri/build.rs`).
- macOS: `src-tauri/tauri.macos.conf.json` replaces the phone-sized window with a
  1280×820 desktop window, so the console shows its wide web layout. The same
  narrow bridge (`mac` in `src-tauri/src/lib.rs`) opens links and the Google
  authorization page in the default browser, because Google stops at the account
  chooser inside the web view. The browser returns through the `aioagent` URL scheme,
  and microphone permission text is in `src-tauri/Info.macos.plist` (English, the fallback) and, per
  language, in `src-tauri/macos/*.lproj/InfoPlist.strings`. Build with
  `env -u NODE_ENV npm run -- tauri build --bundles app` and copy
  `src-tauri/target/release/bundle/macos/Clawpage.app` to `/Applications`. A copy
  left in `target/` also claims the scheme; unregister it with `lsregister -u <path>`.
  The Mac app is named Clawpage in English and Spanish and 一站 in Simplified and Traditional Chinese (`productName` in
  `tauri.macos.conf.json`, `src-tauri/macos/*.lproj/InfoPlist.strings`); the window title is
  read from the same localized name at start. Since 0.1.1 (versionCode 1001) Android shows Clawpage
  Agent, and 一站 on a Chinese device (`values-zh`); iOS still shows 一站.
  Verified 2026-10-12: Google sign-in returned to the app and survived a restart.
- macOS phones: settings → "Phones on a Mac" links this Mac's USB Android phones to the
  signed-in account (`src-tauri/src/phone_link.rs`). The console posts JSON strings to the
  `aioDeviceLink` message handler (`status`, `link` with the device token, `unlink`) and gets
  `aio-device-link` events back. On first use `phone/install.sh` fills
  `~/Library/Application Support/ai.clawpage.agent/phone/` (about 300 MB: pinned Node.js,
  mobile-mcp and ws from `phone/package-lock.json`, scrcpy, and Google's platform-tools unless the
  Mac already has adb); the bridge (`bin/phone-bridge.mjs`, bundled as a resource) then dials
  `wss://agent.clawpage.ai/api/device-link/connect` and runs while the app is open. The token is in
  `device-link.json` beside it (0600), not the Keychain: an ad-hoc signed build would re-prompt for
  Keychain access after every rebuild. When `phone/package.json` changes, regenerate the lock with
  `npm install --package-lock-only` in that directory. iPhone is not supported yet.
- macOS browser: the same bridge offers the AI its own Chrome on this Mac (`bin/user-browser.mjs`, bundled as a
  resource beside the bridge; chrome-devtools-mcp from the same lockfile). The bridge starts the installed Google
  Chrome headless with a profile of its own (`ai-chrome` beside the phone runtime), so there is no Allow prompt, no
  window, no Dock icon and no focus taken from the person at the Mac; sign-ins made in it stay. It never attaches to
  the user's own Chrome profile. The control plane offers it as `aio_user_browser` next to the sandbox browser, which
  takes over whenever the Mac or Chrome is not there. The console's task cards show a task's page (a screenshot, or a
  live CDP screencast over the link) and take it over; the person's input goes in over the bridge's own DevTools
  connection. `PA_AI_CHROME_PROFILE` / `PA_AI_CHROME_PATH` override the profile and the Chrome binary (tests, other installs).
- Home-screen name: iOS 一站 in `gen/apple/project.yml` (`CFBundleDisplayName`, then
  `xcodegen generate`); Android Clawpage Agent in `gen/android/app/src/main/res/values/strings.xml`
  and 一站 in `values-zh/strings.xml`.
- Icons: the 一站 mark (`src/ui/public/favicon.svg`) full bleed in `icon/app-icon.svg`, plus a
  glyph-only foreground and a solid background for the Android adaptive icon. Regenerate with
  `npm run -- tauri icon icon/icon.json`, which writes into `gen/` directly; then flatten the
  iOS PNGs to opaque RGB (the App Store rejects alpha) and copy them over `src-tauri/icons/ios`
  and `src-tauri/icons/android`.

Re-running `tauri ios init` / `android init` overwrites `gen/`: re-apply the native browser sources/framework/dependency, App-Bound Domains, keyboard, name and icon
`gen/` changes above.

## Build and run

Toolchain: Rust with the iOS/Android targets, Xcode, xcodegen, Android SDK + NDK 27,
the JDK bundled with Android Studio. Commands run from this directory; `env -u NODE_ENV`
keeps devDependencies installed when the shell sets `NODE_ENV=production`.

```bash
env -u NODE_ENV npm install --include=dev

# iOS simulator
env -u NODE_ENV npm run -- tauri ios build --debug --target aarch64-sim
xcrun simctl install booted src-tauri/gen/apple/build/arm64-sim/AIOAgent.app
xcrun simctl launch booted ai.clawpage.agent

# Android phone over USB (adb devices shows it as "device")
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=$HOME/Library/Android/sdk NDK_HOME=$HOME/Library/Android/sdk/ndk/27.0.12077973
env -u NODE_ENV npm run -- tauri android build --debug --target aarch64 --apk
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n ai.clawpage.agent/.MainActivity
```

A device build for an iPhone signs with the team in `tauri.conf.json`
(`bundle.iOS.developmentTeam`, automatic signing; the device has to be registered on that team):

```bash
env -u NODE_ENV npm run -- tauri ios build --debug --target aarch64
xcrun devicectl list devices
xcrun devicectl device install app --device <identifier> src-tauri/gen/apple/build/arm64/AIOAgent.ipa
```

The team is a personal (free) team, so the profile expires after 7 days and the app then stops
opening until it is rebuilt and installed again. The first time, the phone has to trust the developer
in Settings → General → VPN & Device Management.

## Android release signing

Google Play requires a signed Android App Bundle (AAB) for a new app. The APK is
for direct installation; Play App Signing signs the APKs delivered by Google.
See [Tauri Android signing](https://v2.tauri.app/distribute/sign/android/) and
[Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756).

Set `AIO_ANDROID_KEYSTORE_PROPERTIES` to an absolute path to a private properties
file with `keyAlias`, `password` (the keystore and key password), and `storeFile`
(absolute keystore path). Keep both files outside the generated project, for
example under the repository's ignored `var/android-signing/`, with directory
mode 0700 and file mode 0600. Back up the upload key and properties securely;
reuse the same key for updates. Do not put credentials in commands, logs or Git.
Debug builds keep the usual Android debug key. Without this environment variable,
release builds are unsigned.

From this directory, with the toolchain environment above:

```bash
export AIO_ANDROID_KEYSTORE_PROPERTIES=/absolute/private/path/keystore.properties
env -u NODE_ENV npm run -- tauri android build --target aarch64 --apk --aab
```

This builds arm64 only. Omit `--target aarch64` to build all configured Android
architectures. Outputs are under `src-tauri/gen/android/app/build/outputs/`:
`apk/universal/release/app-universal-release.apk` and
`bundle/universalRelease/app-universal-release.aab`. Verify the APK with
`apksigner verify --verbose --print-certs`, the AAB with `jarsigner -verify`, and
native ZIP alignment with `zipalign -c -P 16 -v 4`. The ELF LOAD segments must also
align to at least 16 KB. Keep the package identifier stable and increase the
Android version code for subsequent Play uploads.

A release certificate cannot update an installed debug-signed package. Preserve
the phone's data when validating: use a test copy re-signed with its existing
debug certificate, and compare every non-signature ZIP entry with the signed
release APK. This validates release content on the device, but not installation
of a Google Play-signed APK; final acceptance still requires a Play test track.

## Google acceptance (2026-10-11)

The upload-signed `ai.clawpage.agent` arm64 release was installed on the connected
Galaxy Z Flip6 (Android 16). Real Google authorization in device Chrome returned
to the App; the first visit rejected an invalid invite, consumed a valid invite
once and created a member. A repeat Google sign-in needed no invite. The cold
return test stopped the App process while Chrome was authorizing; after fixing
Cookie persistence before browser launch, the real callback cold-started the App
and entered the member inbox. A separate process restart retained the session.
The deployed sign-in page's Google logo and layout were visually checked on this
phone. Google Cloud is still in testing mode; Play submission is pending.

The shared UI policy-link fix (`59d5e06`) was then deployed and checked on this
same signed package. A cold restart retained the member session. Privacy and
account-deletion pages opened in Chrome Custom Tabs; one Android Back returned
to the original account dialog without leaving the App. No production report
or deletion request was submitted. Desktop/mobile Chromium and mobile WebKit
support regressions passed 15/15; these browser tests do not establish iOS
physical-device acceptance.

## Initial acceptance (2026-10-11)

This initial acceptance used the previous application identifier. After the
identifier correction and Google authentication bridge change, the new signed
`ai.clawpage.agent` package must be separately accepted; the historical checks
below do not establish real Google sign-in or its App return.

Galaxy Z Flip6 (Android 16), current native shell, version 0.1.0 / Android code
1000, arm64. Debug build: existing owner login, config header/status-bar separation,
navigation, workspace browser and terminal. Optimized release content (re-signed
with the installed debug certificate, all 628 non-signature ZIP entries identical
to the upload-signed APK): cold start retained login, task list/detail, keyboard
input and draft cleanup, public URL opened in Chrome Custom Tab and returned,
system attachment picker opened and cancelled, microphone runtime permission,
recording and stopping. With no intelligible speech, transcription returned the
expected retry notice; real spoken transcription was not verified. A controlled
message requesting only `ANDROID_OK` completed and its reply appeared in the task
detail. No `DEBUGGABLE` package flag on the release test build.

The upload-signed APK and AAB passed `apksigner` / `jarsigner` verification;
APK ZIP alignment and every native ELF LOAD segment passed 16 KB alignment
checks. Type checking, 986 Vitest tests and 93 Python checks passed. Camera,
download handling, offline fallback, rotation/folding and Play-delivered
installation remain unverified. Publishing still depends on Play Console account
eligibility and the store's listing/content/reviewer-access requirements.

## Verified (2026-10-06)

Voice input. Android 15 emulator: the system "record audio" prompt, recording, and
real Chinese speech (fed through the page's microphone stream over WebView DevTools)
transcribed into the draft. iPhone 16 Pro simulator (iOS 18.2, microphone granted with
`simctl privacy`): recording in WKWebView reached the speech server (the Mac has no
input device, so only silence). Installed on Tech Z; speaking into a real phone was
not checked here.

## Verified (2026-10-04)

iPhone 16 Pro simulator (iOS 18.2): deployed config header clears the status bar;
a public product link opens the native Safari sheet with its toolbar and close
control. Tech Z iPhone 17 Pro: the signed update was installed and launched;
physical screen interactions were not inspected. Android arm64 APK built; no
Android device was connected for this run. Shared-UI regressions cover desktop,
390/360px Chromium and WebKit, safe-area injection, message expansion, nested
previews and public/private link routing.

## Verified (2026-10-03)

iPhone 16 Pro simulator (iOS 26.2) and a Galaxy Z Flip6 (Android 16): login, main
session, cold restart keeps the login, navigation drawer, workspace desktop (the
companion origin in an iframe gets its cookie), keyboard over the message box.

Known limits: phone notifications (Web Push) are not available inside the app's web
view; file downloads from cards have not been checked in the app.

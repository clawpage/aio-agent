# 一站 mobile app (Tauri 2)

The iOS and Android app is a shell around the deployed console at
`https://agent.clawpage.ai`: it opens that page in a full-screen web view and
provides a narrow native browser bridge. The console is the same UI code as the
web version (`src/ui/src`), so a UI change ships with the next UI deploy. Native
bridge changes require an app update. Change this directory only for native
concerns (web view insets, keyboard, icons, signing).

Only the main frame at `https://agent.clawpage.ai` can ask the bridge to open an
HTTP(S) URL. The page gets no Tauri IPC; `fallback/` is only shown if the remote
page cannot load.

## Native adjustments

- Public conversation links open with SafariServices on iOS (`DeviceBrowser.swift`)
  or the device browser Custom Tab on Android (`MainActivity.kt`, AndroidX Browser).
  Both request an initial height near 90%; iOS 15 uses the system sheet default.
  The OS/browser may expand the panel. Private IP links retain sandbox routing.
  The web version opens a normal browser tab and cannot set the system sheet height.
  Regression: `tests/e2e/device-links.spec.ts`; native panel acceptance also requires
  installing the new shell. No remote Tauri capability is enabled.

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
- Android: edge to edge, the window is no longer resized for the keyboard, so the
  activity gives the keyboard's height back as bottom padding
  (`gen/android/.../MainActivity.kt`).
- Android: the Rust library is linked for 16 KB pages (`src-tauri/build.rs`).
- Home-screen name 一站: `gen/apple/project.yml` (`CFBundleDisplayName`, then
  `xcodegen generate`) and `gen/android/app/src/main/res/values/strings.xml`.
- Icons: the 一站 mark (`src/ui/public/favicon.svg`) full bleed in `icon/app-icon.svg`, plus a
  glyph-only foreground and a solid background for the Android adaptive icon. Regenerate with
  `npm run -- tauri icon icon/icon.json`, which writes into `gen/` directly; then flatten the
  iOS PNGs to opaque RGB (the App Store rejects alpha) and copy them over `src-tauri/icons/ios`
  and `src-tauri/icons/android`.

Re-running `tauri ios init` / `android init` overwrites `gen/`: re-apply the native browser sources/framework/dependency, keyboard, name and icon
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
xcrun simctl launch booted com.mengxiao.aioagent

# Android phone over USB (adb devices shows it as "device")
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=$HOME/Library/Android/sdk NDK_HOME=$HOME/Library/Android/sdk/ndk/27.0.12077973
env -u NODE_ENV npm run -- tauri android build --debug --target aarch64 --apk
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n com.mengxiao.aioagent/.MainActivity
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

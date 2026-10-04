# 一站 mobile app (Tauri 2)

The iOS and Android app is a shell around the deployed console at
`https://agent.clawpage.ai`: it opens that page in a full-screen web view and adds
nothing else. The console is the same UI code as the web version (`src/ui/src`), so a UI
change ships to the app with the next UI deploy, no app release needed. Change this
directory only for native concerns (web view insets, keyboard, icons, signing).

The page gets no Tauri IPC; `fallback/` is only shown if the remote page cannot load.

## Native adjustments

- iOS: the web view covers the whole screen (`contentInsetAdjustmentBehavior = never`,
  `src-tauri/src/lib.rs`); the console pads itself with `env(safe-area-inset-*)`.
- Android: edge to edge, the window is no longer resized for the keyboard, so the
  activity gives the keyboard's height back as bottom padding
  (`gen/android/.../MainActivity.kt`).
- Android: the Rust library is linked for 16 KB pages (`src-tauri/build.rs`).
- Home-screen name 一站: `gen/apple/project.yml` (`CFBundleDisplayName`, then
  `xcodegen generate`) and `gen/android/app/src/main/res/values/strings.xml`.
- Icons come from `src/ui/public/icon-512.png`: `npm run -- tauri icon ../public/icon-512.png`.

Re-running `tauri ios init` / `android init` overwrites `gen/`: re-apply the three
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

A device build for an iPhone goes through `npm run -- tauri ios dev "<device name>"`
(the Rust build step talks back to the CLI), with signing set in `gen/apple/project.yml`.

## Verified (2026-10-03)

iPhone 16 Pro simulator (iOS 26.2) and a Galaxy Z Flip6 (Android 16): login, main
session, cold restart keeps the login, navigation drawer, workspace desktop (the
companion origin in an iframe gets its cookie), keyboard over the message box.

Known limits: phone notifications (Web Push) are not available inside the app's web
view; file downloads from cards have not been checked in the app.

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

Android: without a network the app still opens. The console's service worker
(`src/ui/public/sw.js`, see "无网打开" in `docs/FEATURES.md`) serves the last console
page that loaded, which shows "现在连不上一站" and reloads to the latest deployed UI
as soon as the server answers. WebView never learns about connectivity by itself
(`navigator.onLine` stays true, no `online` event), so `MainActivity.kt` follows the
default network and calls `setNetworkAvailable` (needs `ACCESS_NETWORK_STATE`): the page
says the device is offline and reloads the moment the network is back (0.1.2).

iOS: no service worker. WKWebView runs one only with App-Bound Domains, and those stop
the agent's in-app browser (`AIBrowser.swift`) from reading pages on other sites, so the
app has none (0.1.2 to 0.1.4 had them; do not bring `WKAppBoundDomains` or
`limitNavigationsToAppBoundDomains` back). The console always comes from the server.
When it cannot be loaded at launch, `ConsoleOffline.swift` covers the empty web view
with a native card in the device's language (the same words as `auth.offline` in the
console's locales: the device is offline, or the server cannot be reached) and opens the
console by itself when the network returns, every 8 s while the card shows, when the app
comes to the front, or on "Try again". To see it in the simulator, launch a debug build
with `-AIOConsoleFailFirst 1`.

The shell bundles no UI on either platform, so a UI change still ships with the next UI deploy.

An Android device that never opened the console online has no saved page and shows the
web view's own error page.

Pictures in messages are likewise kept by the shared UI, not the shell: a copy in the
web view's IndexedDB (both shells use the persistent default store) is shown at once
on a cold start and checked behind it (see "图片留在设备上" in `docs/FEATURES.md`).
A native cache could not do better: WKWebView lets no native code answer its https
requests, and the wait was the check with the sandbox, which any cache has to make.

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
- iOS keyboard: `KeyboardFit` (`DeviceBrowser.swift`) keeps the web view full height and holds the page at the top while a keyboard is up or moving (WebKit keeps its own keyboard handling, which swaps the keyboard for the attachment menu). As the keyboard starts to move it tells the page once where it will end (`aio-keyboard` with `height` and `duration`); `useKeyboardViewport` moves what lies below each chat header on the compositor with the keyboard's own curve (sampled in the simulator, CSS `linear()`), and lays the page out once, at the end when rising and at the start when falling. Earlier attempts and why they went: left to WebKit, the page was scrolled to the box and put back at the top (it sprang up and down); resizing the web view showed a blank page while WebKit repainted, moved the content ahead of the keyboard and stranded the attachment menu; sending the height on every frame made a long conversation drop frames. The attachment button keeps the message box focused (`keepTyping`), so the keyboard stays up and its menu opens next to the button. The console follows the events only when the app registers the `aioKeyboard` marker, so the page must be deployed before an app build that sends them (an app that sends heights without `duration`, 0.1.2.3, is followed frame by frame). Regression: `tests/e2e/app-keyboard.spec.ts`.
- Notifications: WKWebView has no Web Push, so `DeviceBrowser.swift` registers with APNs for the console (`aioPush`: status / enable / settings, answered with `aio-push` events) and adds the device-token callbacks to Tauri's app delegate at runtime; `aps-environment` is in the entitlements (see `docs/FEATURES.md` §13).
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
- Saving images and videos to Photos: both shells offer `aioSaveMedia` (iOS: a reply handler in `DeviceBrowser.swift`;
  Android: a web message listener in `MainActivity.kt`, answers carry the message's `seq`), main console frame only.
  The console posts JSON strings: `begin` (name, mime; iOS asks for add-only Photos access here, Android 7–9 for
  `WRITE_EXTERNAL_STORAGE`, declared with `maxSdkVersion 28`), base64 `chunk`s of 512 KB into a temp file
  (`aio-save-*`, swept at start), then `finish` (PHAssetCreationRequest / MediaStore `Pictures|Movies/Clawpage`) or
  `cancel`; `settings` opens the app's system settings after a refusal. The page shows 下载中… then 已存到相册.
  Without the handler the console keeps the share sheet (iOS) or the plain link (Android). Regression:
  `tests/e2e/media-save.spec.ts`, `tests/e2e/home-screen-save.spec.ts` (bridges stubbed).
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
  The Mac app is named Clawpage in English, Spanish and Japanese and 一站 in Simplified and Traditional Chinese (`productName` in
  `tauri.macos.conf.json`, `src-tauri/macos/*.lproj/InfoPlist.strings`); the window title is
  read from the same localized name at start. Since 0.1.1 (versionCode 1001) Android shows Clawpage
  Agent, 一站 on a Chinese device (`values-zh`) and Clawpage on a Japanese one (`values-ja`); iOS still shows 一站.
  Verified 2026-10-12: Google sign-in returned to the app and survived a restart.
- macOS phones: settings → "Phones on a Mac" links this Mac's USB Android phones to the
  signed-in account (`src-tauri/src/phone_link.rs`). The console posts JSON strings to the
  `aioDeviceLink` message handler (`status`, `link` with the device token, `unlink`) and gets
  `aio-device-link` events back. On first use `phone/install.sh` fills
  `~/Library/Application Support/ai.clawpage.agent/phone/` (about 300 MB: pinned Node.js,
  mobile-mcp and ws from `phone/package-lock.json`, scrcpy, and Google's platform-tools unless the
  Mac already has adb); the bridge (`bin/phone-bridge.mjs`, bundled as a resource with every `bin/` module it
  imports, which `tests/integration/mac-env.test.ts` checks) then dials
  `wss://agent.clawpage.ai/api/device-link/connect` and runs while the app is open. The token is in
  `device-link.json` beside it (0600), not the Keychain: an ad-hoc signed build would re-prompt for
  Keychain access after every rebuild. When `phone/package.json` changes, regenerate the lock with
  `npm install --package-lock-only` in that directory. iPhone is not supported yet.
- macOS browser: the same bridge offers the AI its own Chrome on this Mac (`bin/user-browser.mjs`, bundled as a
  resource beside the bridge; chrome-devtools-mcp from the same lockfile). The bridge starts the installed Google
  Chrome headless with a profile of its own (`ai-chrome` beside the phone runtime), so there is no Allow prompt, no
  window, no Dock icon and no focus taken from the person at the Mac; sign-ins made in it stay. It never attaches to
  the user's own Chrome profile. The control plane offers it as part of `aio_mac_native` next to the sandbox browser, which
  takes over whenever the Mac or Chrome is not there. The console's task cards show a task's page (a screenshot, or a
  live CDP screencast over the link) and take it over; the person's input goes in over the bridge's own DevTools
  connection. `PA_AI_CHROME_PROFILE` / `PA_AI_CHROME_PATH` override the profile and the Chrome binary (tests, other installs).
  That Chrome lives only as long as the bridge: closing the bridge ends it by the pid its `SingletonLock` names, and the
  bridge ends itself within 5 s when the app goes away without stopping it (force quit, crash). A Chrome still holding
  the profile that does not answer its DevTools within 3 s is hung (open port, no answer, unreaped children); the
  next call ends it and starts a new one instead of waiting on it.
- macOS terminal: the same bridge can give the agent this Mac's terminal (`bin/mac-shell.mjs`, bundled beside the bridge):
  read, write, edit and bash, bash in a tmux server of its own (`tmux -L aio-agent`), one session per task. It is off
  until the person turns on "Let the AI use this Mac's terminal" in the workspace's Mac Terminal app inside this app; the console posts
  `{"type":"shell","enabled":…}`, the app keeps it in `device-link.json` (`shell`), restarts the bridge with
  `PA_MAC_SHELL=1` and reports `shell` in its `aio-device-link` events. Needs tmux on the Mac (Homebrew's is found;
  `PA_TMUX` overrides). The control plane offers it as part of `aio_mac_native` (`src/control/macShell.ts`, `src/control/macNative.ts`).
- iPhone abilities: `DeviceTools.swift` offers this iPhone's Photos, Reminders and Calendar to the agent of the
  account signed in here (`aio_ios`, `src/control/iosDevice.ts`; see "iPhone 上的相册、提醒事项与日历" in
  `docs/FEATURES.md`). The console's main frame posts JSON strings to `aioDeviceTools` (a reply handler:
  `status`, `account`, `link`, `unlink`, `enable`/`disable` an ability, `settings`) and gets the state back, plus
  `aio-device-tools` events when the connection changes. The app holds the device token in the Keychain and dials
  `wss://agent.clawpage.ai/api/device-link/connect` itself while it is in the foreground. The permission texts
  (`NSPhotoLibraryUsageDescription`, `NSRemindersFullAccessUsageDescription` / `NSRemindersUsageDescription`,
  `NSCalendarsFullAccessUsageDescription` / `NSCalendarsUsageDescription`) are in `gen/apple/project.yml`, the
  generated `Info.plist` and the five `InfoPlist.strings`. A new Swift file has to be added to
  `aio-agent-tauri.xcodeproj` too: `xcodegen generate` does it, but it also empties the entitlements and drops
  `DEVELOPMENT_TEAM`, so keep only its four `DeviceTools.swift` lines. Debug builds only:
  `xcrun simctl launch <udid> ai.clawpage.agent -AIODeviceToolsSelfTest YES` runs every tool on the simulator's own
  data and logs the results (`log show --predicate 'eventMessage CONTAINS "aio-device-tools"'`; grant the
  permissions with `xcrun simctl privacy <udid> grant photos|reminders|calendar ai.clawpage.agent`, though iOS 18
  still asks once for Photos), and `-AIODeviceToolsLinkURL ws://localhost:<port>/api/device-link/connect
  -AIODeviceToolsLinkToken dl_…` links the app to a local control plane without the console.
- Android as an execution environment (docs/EXEC-ENVS.md): `DeviceTools.kt` links the app to the account
  signed in here and answers the agent over `wss://agent.clawpage.ai/api/device-link/connect` (kind `android`, OkHttp
  WebSocket, the one Gradle dependency it adds) while the app is in the foreground; `AIBrowser.kt` is the agent's browser
  panel over the console and `DeviceFiles.kt` its folder (`Android/data/ai.clawpage.agent/files/AI Files`, shown in the
  system Files app by `AIFilesProvider.kt`); `DeviceCalendar.kt` the calendar (`READ_CALENDAR` / `WRITE_CALENDAR`, asked
  when the person turns it on) and `DevicePhotos.kt` the photos the person picks in the system Photo Picker (no media
  permission: Play allows those only to gallery apps); see "Android App 的浏览器、文件夹、日历与相册" in `docs/FEATURES.md`.
  The console's main frame talks to it through the `aioDeviceTools` web message listener (`status`, `account`, `link`,
  `unlink`, `enable` / `disable`, `settings`, `photosAdd`, `photosShared`, `photosRemove`; JSON strings with a `seq` the
  answer repeats), from Settings → "Android phone" (`AndroidSettings.tsx`). The token and the switches are in
  `noBackupFilesDir/device-link.json`, the shared photos in `noBackupFilesDir/shared-photos.json`. Native strings
  (panel, confirmation) are in `values*/strings.xml` in five languages (`values-b+zh+Hant` is Traditional Chinese).
  Debug builds only (`BuildConfig.DEBUG`): `adb -s <emulator> shell am start -n ai.clawpage.agent/.MainActivity --es
  AIODeviceToolsLinkURL ws://10.0.2.2:<port>/api/device-link/connect --es AIODeviceToolsLinkToken dl_… [--es
  AIOConfirmSeconds 4]` links the app to a local control plane without the console; R8 removes this in a release
  build (its extras' names are not in the release `classes.dex`). The emulator test is
  `AIO_ANDROID_E2E=1 npx vitest run tests/devices/android.e2e.test.ts` (from the repository root, after the debug build);
  it dials 10.0.2.2, not `adb reverse`, which dropped the emulator when a screenshot's answer went through it. The
  debug APK (about 120 MB) needs about 1 GB free on the emulator's `/data`; a full AVD can be started with a data
  image of its own instead (`emulator -avd <name> -data <path>/userdata-qemu.img -partition-size 8192 -no-snapshot`).
- Home-screen name: iOS shows Clawpage in English, Spanish and Japanese and 一站 in Chinese
  (`gen/apple/Localization/<lang>.lproj/InfoPlist.strings`, which also localize the permission prompts;
  the base `CFBundleDisplayName` 一站 is in `gen/apple/project.yml`, then `xcodegen generate`); Android Clawpage Agent in
  `gen/android/app/src/main/res/values/strings.xml`, 一站 in `values-zh/strings.xml` and Clawpage in `values-ja/strings.xml`.
- App Store: iPhone only, a privacy manifest (`gen/apple/aio-agent-tauri_iOS/PrivacyInfo.xcprivacy`) and
  `ITSAppUsesNonExemptEncryption = false`; building, uploading and the App Store Connect answers are in
  [app-store.md](../../../docs/app-store.md).
- Icons: the 一站 mark (`src/ui/public/favicon.svg`) full bleed in `icon/app-icon.svg`, plus a
  glyph-only foreground and a solid background for the Android adaptive icon. Regenerate with
  `npm run -- tauri icon icon/icon.json`, which writes into `gen/` directly; then flatten the
  iOS PNGs to opaque RGB (the App Store rejects alpha) and copy them over `src-tauri/icons/ios`
  and `src-tauri/icons/android`.

Re-running `tauri ios init` / `android init` overwrites `gen/`: re-apply the native browser sources/framework/dependency, the Swift sources and their project entries (`AIBrowser`, `DeviceFiles`, `ConsoleOffline`), the Kotlin sources (`DeviceTools`, `AIBrowser`, `DeviceFiles`, and `src/play`, `src/full`, `src/fullDebug`, `src/fullTest` with the `AIO_ANDROID_DIST` switch in `app/build.gradle.kts`), the OkHttp dependency and the strings, keyboard, name and icon
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

## The side-loaded Android app

`AIO_ANDROID_DIST=full` builds the side-loaded app (docs/EXEC-ENVS.md, "The side-loaded Android app"): application
id `ai.clawpage.agent.full`, so it installs beside the Play app, plus `src/full` (its manifest, `PhoneControl.kt`,
`ShellHelper.kt`, `HelperClient.kt`, `PhoneTools.kt`, `ControlService.kt`, `ControlReceiver.kt`, notification strings
in five languages, `full-rules.txt` for R8) and the Kadb dependency. Without it Gradle compiles `src/play`'s
`PhoneControl.kt`, a stand-in that offers nothing, so `DeviceTools.kt` is the same file in both. Debug signing only for
now; the full build shares the Play build's version (0.1.6 / 1006) and its output path, so build one, then the other.

```bash
AIO_ANDROID_DIST=full env -u NODE_ENV npm run -- tauri android build --debug --target aarch64 --apk
./check-android-builds.sh   # both release builds (unsigned): the Play one has nothing of this, the full one no debug-only path
```

`check-android-builds.sh` builds the Play release APK and checks that its merged manifest asks for exactly
`play-permissions.txt`, that its runtime classpath has no Kadb (nor its libraries) and that its dex has none of
`src/full`'s names or strings; then it builds the side-loaded release APK and checks that the shell helper's class
name survived R8 and that none of the debug-only names (`ai.clawpage.agent.DEBUG_PAIR`, `HelperProbe`, the
`AIODeviceToolsLink*` extras) are in its dex. Run it after any change to the Gradle files or to `src/full`.

- Debug builds only: `adb -s <emulator> shell am broadcast -a ai.clawpage.agent.DEBUG_PAIR -p ai.clawpage.agent.full
  --es code <six digits>` hands in a pairing code as the notification's reply would (the pairing dialog stays open),
  and `src/fullDebug`'s `HelperProbe` knocks on the helper as whoever runs it (the emulator test runs it as the shell
  user). R8 removes the first from a release build; the second is not compiled into one.
- The emulator test is `AIO_ANDROID_FULL_E2E=1 npx vitest run tests/devices/android-full.e2e.test.ts` (from the
  repository root, after the full debug build). The emulator's Wi-Fi must have been allowed for wireless debugging
  once ("Always allow on this network"). Its comparison with mobile-mcp needs the Mac app's phone runtime
  (`~/Library/Application Support/ai.clawpage.agent/phone`) and reaches the emulator only, through an adb wrapper.
- The SPAKE2 port's JVM tests: `(cd src-tauri/gen/android && AIO_ANDROID_DIST=full ./gradlew :app:testUniversalDebugUnitTest)`.
- Licences of what it adds: Kadb (`com.flyfishxu:kadb-android`, Apache-2.0), Bouncy Castle (MIT-style), Okio and
  kotlinx-coroutines (Apache-2.0), HiddenApiBypass (Apache-2.0), and `Spake2Context.kt`, ported from BoringSSL's
  `spake25519.cc` (Apache-2.0). Kadb's own SPAKE2 dependency (`com.github.Flyfish233:spake2-java`) is GPL-3.0 and is
  excluded; do not let it back in. The repository keeps no third-party notice file yet; the app shows none.

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
Android version code for subsequent Play uploads. The Android version can run ahead of iOS's:
`src-tauri/tauri.android.conf.json` overrides `version` for Android builds only (0.1.6 → versionCode 1006);
remove it once both platforms ship the same version again.

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

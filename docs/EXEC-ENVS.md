# Execution environments

The agent always runs in the account's sandbox. What it acts on is an **execution environment**: the
sandbox itself, the user's Mac (through the Mac app), an Android phone or an iPhone. Every environment
is described the same way and reached through the same MCP server, `aio_env`, so the agent learns one
set of tools and picks the environment per task. This replaces the per-device servers `aio_mac_native`
and `aio_ios`, which stay wired, unchanged, until the new iOS and Android apps have passed review and
every linked device speaks the new protocol (see "Retiring the old servers").

## Model

An environment is `{ id, kind, name, online, foreground, capabilities }`:

| kind | reached through | capabilities it can declare |
|---|---|---|
| `sandbox` | the account's container (always there) | `browser`, `files`, `shell` (used directly, not through `aio_env`) |
| `mac` | the Mac app's device link | `browser` (the AI's own Chrome), `shell` (the Mac's terminal, off until the person turns it on there) |
| `ios` | the iPhone app's device link | `browser` (the app's own in-app browser), `files` (the app's folder, shown in Files), `photos`, `reminders`, `calendar` |
| `android` | the Android app's device link, or a Mac app's USB/adb | `browser`, `files`, `photos`, `calendar`; with debugging granted also `apps` and `screen` |

- **Capabilities, never transports.** An Android phone plugged into a Mac and one running the app are the
  same kind with the same tools; only what it was granted decides its capabilities. The agent and the
  routing rules never see how a device is connected.
- **One phone, one environment.** A device names itself with a stable `deviceId` (Android: the hardware
  serial / `Settings.Secure.ANDROID_ID` hash; iOS: `identifierForVendor`). The same phone reached two
  ways is one environment; calls go to the link with more capabilities, the other is the fallback.
- **Ids** are `<kind>:<short hash of deviceId>` and stay the same across reconnects.

## Tools (`aio_env`)

`env_list` and one tool per action, each with a required `env` (an id from `env_list`). The tool list is
fixed (Codex starts a thread's servers once); a call to an environment that lacks the capability, or is
offline, comes back as a tool error that says what to do.

| capability | tools |
|---|---|
| `browser` | `browser_open`, `browser_read`, `browser_click`, `browser_type`, `browser_scroll`, `browser_back`, `browser_screenshot`, `browser_request_human` |
| `files` | `files_list`, `files_pull` (device → workspace), `files_push` (workspace → device); up to 20 MB either way, a pull asked for in parts (below) |
| `photos` | `photos_albums`, `photos_list`, `photos_get` |
| `reminders` | `reminders_lists`, `reminders_list`, `reminders_create`, `reminders_complete` |
| `calendar` | `calendar_calendars`, `calendar_events`, `calendar_create_event` |
| `apps` | `apps_list`, `app_open` |
| `screen` | `screen_read`, `screen_tap`, `screen_type`, `screen_swipe`, `screen_key`, `screen_shot` |
| `shell` | `shell_bash`, `shell_read`, `shell_write`, `shell_edit` |

`browser_read` returns the page's text and its interactive elements with `ref`s; `browser_click` /
`browser_type` take a `ref`. Pictures (`photos_get`, `browser_screenshot`, `screen_shot`) are saved in the
workspace and shown to the model, as `aio_ios` does today.

**Confirmation on the device.** Paying, granting a permission or signing in on someone's behalf,
sending a message or mail, and deleting are never done on the agent's word alone: the device shows the
action and waits for the person to tap. The call answers `needs_confirmation` until they do (or
`declined`), and the agent says so instead of retrying.

**Patience.** A call to a device is given two minutes; a transfer (`photos_get`, `files_*`) a little more,
`shell_bash` its own timeout, and `browser_request_human` the ten minutes the apps wait for the person
(`callTimeoutMs` in `envs/registry.ts`). The executor waits for `aio_env` longer than any of them, as long
as for a page the person holds in the console.

## Device protocol (over the existing device link)

The device link (`deviceLink.ts`) is unchanged: the device dials `/api/device-link/connect` with its
token, and requests go down as `req` frames. New devices answer two more paths and push one event:

- `GET /env/manifest` → `{ protocol: 1, envs: [{ deviceId, kind, name, capabilities, foreground }] }`.
  A Mac lists itself and every phone plugged into it.
- `POST /env/call` `{ env: deviceId, tool, arguments }` → `{ ok: true, result }` or
  `{ ok: false, code, message }` (codes: `off`, `denied`, `not_found`, `invalid`, `unknown_tool`,
  `needs_confirmation`, `declined`, `busy`).
- Device → control frame `{ t: "event", name: "manifest", data: <manifest> }` whenever it changes
  (an ability turned on, the app coming to the foreground, a phone plugged in).

**Old devices keep working** (no breaking change): a device that answers `/env/manifest` with 404 is
read through an adapter.

- An old iPhone app: its environment comes from `/ios/status` (the abilities turned on), calls go to
  `/ios/call`, which already answers in the shape above.
- An old Mac app (before its bridge spoke protocol 1, see "The Mac"): the Mac's own environment from what its bridge offers, and one `android` environment
  per phone `/status` lists; `screen_*` / `apps_*` are translated to the bridge's whitelisted mobile-mcp
  tools, `browser_*` to its Chrome tools, `shell_*` to its terminal.

## Choosing the environment

Every turn starts with a short **environment brief** (`envBrief`): the environments online now with
their capabilities, and where the message came from (the console's `x-client-platform`: `ios`,
`android`, `mac`, `web`, `pwa`). The rules live in one place (`ENV_POLICY`):

1. When the person is using one of their devices' apps right now (the message came from it and that
   device is online and in the foreground), work that concerns that device — its apps, photos,
   schedule, a site to be used on it — goes to that environment first.
2. Everything else stays in the sandbox: long or background work, heavy files or computation, and
   scheduled runs (nobody is at a device; phones sleep).
3. A device going offline falls back to the sandbox where the work allows; otherwise the agent says in
   one sentence what the person should do (open the app, keep it on screen).

## The Mac

The Mac app's bridge (`bin/phone-bridge.mjs`, its protocol half in `bin/mac-env.mjs`) speaks protocol 1
itself. Its manifest lists the Mac (`deviceId` a hash of the Mac's hardware UUID; `browser` while the AI's
Chrome can be used, `shell` only while the person turned the terminal on in the app, which restarts the
bridge with `PA_MAC_SHELL=1`) and one `android` environment per phone ready on its USB (`deviceId` its adb
serial, `apps` and `screen`). It checks every 3 s what it offers and sends a `manifest` event when that
changed. `/env/call` translates aio_env's tools to the bridge's own: mobile-mcp's whitelisted tools on the
phone (the bridge keeps its own session with mobile-mcp), the AI's Chrome and the terminal (the task named
by `X-AIO-Task`, which the control plane sends with every call, gets its own shell).

- **Same ids after the update.** The registry knows a Mac first by its link (`link:<id>`, as for an old
  Mac) and a phone by its serial (as before, and as the side-loaded app names it in `aliases`), so a Mac
  updating its app keeps both environments' ids, and a phone on USB and in its own app stays one.
- **The console's part of the browser.** The Mac's Chrome is headless; the person sees and takes over a
  task's page in the console. So for a Mac, `browser_*` go to the device through `UserBrowserGateway.envCall`:
  a page `browser_open` opened (its `page` in the answer) goes on the task's card, calls are refused while
  the person holds the page, and `browser_request_human` waits there and never reaches the Mac.
- The old endpoints (`/mcp`, `/status`, `/browser/*`, `/shell/*`) are unchanged, so a control plane with
  `PA_EXEC_ENVS` off, or one from before, works with an updated bridge as it did.

## The iPhone app's browser

The agent's pages open in the app's own web view (`AIBrowser.swift`), a panel the person sees and can
use. It reads and acts on a page from an isolated script world (`WKContentWorld`): element references
live there, so the page sees no attribute, node or global of ours (the simulator test watches a page
with a `MutationObserver` to hold this). Clicks are script clicks (`isTrusted` is false) and typing
sets the value and fires the input events; a site that insists on a real touch, a captcha or a login
goes to the person with `browser_request_human`, who acts in the same panel. A click that would
submit an order or a payment waits for the person's confirmation on the device. The app has no
App-Bound Domains, which would confine these scripts to our own domains (so no service worker on
iOS: see "Offline" in `src/ui/tauri/README.md`).

## The Android app's browser

The same panel in the Android app (`AIBrowser.kt`): a second web view over the console, with a WebView
profile of its own (its sign-ins are apart from the console's), shown as a small live window that opens
full screen, with Minimize and Close; Back goes back in it or makes it small again. Android's WebView
has no isolated script world, so the scripts run in the page's own world and leave nothing behind: each is
a function that returns, with no global, attribute, node or patched prototype. An element's ref is its
place in the same enumeration of the page's controls on every call, checked against a fingerprint from
the last read; a page that changed answers "read the page again". Clicks are real touches on the
element's centre (measured once the page holds still), typing is the keyboard's text through the web
view's own input connection (Chinese too) and Enter a real key, scrolling a finger's swipe, so the page
sees trusted events; the emulator test's probe page holds `attrs=0 nodes=0 global=false marked=false
click=trusted value=Alice input=trusted`. Script stands in only where real input cannot: a click on an
element something covers or that cannot be brought on screen, a select's value, and text the keyboard
connection did not deliver (each logged). The user agent is WebView's own (`…; wv) … Version/4.0
Chrome/…`, client hints brand "Android WebView"), not changed; the app asks WebView not to send its
`X-Requested-With` header, which WebView 124 (the emulator's) still sent on a main-frame navigation.
Confirmation, `browser_request_human` and the refusal to type passwords are as on the iPhone.

The console turns it on from Settings → "Android phone" (`AndroidSettings.tsx`). Its first switch is the
browser and the app's folder: on creates a device link of kind `android` for the signed-in account and hands
it to the app; off deletes the link and tells the app to forget it, every ability and every shared photo with
it. Below, as on the iPhone's page, one switch per ability: `calendar` (Android's permission prompt comes
then, and only then) and `photos`; turning one on before the phone is linked links it. Every change is told
to the server as a `manifest` event. `deviceTools.ts` speaks to both apps: iOS through
`webkit.messageHandlers.aioDeviceTools` (the reply is the promise), Android through the `aioDeviceTools` web
message listener (each message carries a `seq` its answer repeats; `{error}` is a refusal).

## The Android app's calendar, photos and folder

- **Calendar** (`DeviceCalendar.kt`): the system calendar provider, with `READ_CALENDAR` / `WRITE_CALENDAR`,
  answering what the iPhone answers for the same three tools (recurring events expanded, all-day events given
  as that local day from 00:00:00 to 23:59:59). Like the iPhone, no on-device confirmation for a new event: the
  agent's own rule is to ask the user first when they did not ask for it.
- **Photos** (`DevicePhotos.kt`): Google Play allows `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` only to apps
  whose core function needs the whole library, so the Play build has neither. The person picks photos in the
  system Photo Picker (no permission) from Settings; the app keeps a persistable read grant for each, and the
  agent sees exactly those as one album, `shared` ("Shared with AI"). The person removes them there too (the
  grant goes with them). Same tool shapes as the iPhone; no favorites, no location; at most five 1600-px JPEGs
  of at most 1.4 MB each per call, so an answer stays one device-link message.
- **Folder in the Files app**: `AIFilesProvider.kt`, a `DocumentsProvider` only the system can bind to
  (`MANAGE_DOCUMENTS`), shows `AI Files` under the app's name in the system Files app, as the iPhone's shows
  in its Files app. No permission.
- **Large pulls**: a device-link answer is one WebSocket message, base64 twice, and OkHttp sends at most
  16 MB at once, so `aio_env` asks for `files_pull` in parts (`offset`, `length`, 6 MB each) and puts them
  together; a device that answers with `size` gets asked for the rest, one that answers whole (the iPhone
  app) is taken at its word. The limit is the workspace's, 20 MB.

## The side-loaded Android app

The same app built with `AIO_ANDROID_DIST=full` (application id `ai.clawpage.agent.full`, beside the Play app; the
Play build compiles `src/play`'s stand-in instead, and `src/ui/tauri/check-android-builds.sh` proves it has none of
this: same permissions, no Kadb, none of `src/full`'s code). It adds `apps` and `screen` to the phone's own
environment, answering every tool in the words a phone on a Mac's USB answers with (mobile-mcp 1.0.9 with mobilecli),
so the agent cannot tell the two apart.

- **Pairing, once.** Settings → Android phone → "Pair" asks for notifications, posts a notification with a reply
  field and opens Developer options. The person turns on Wireless debugging (Android 11+), taps "Pair device with
  pairing code" and types the six digits into the notification while the dialog stays open. The app finds the
  pairing port by mDNS (`_adb-tls-pairing._tcp`, only this phone's own addresses) and pairs as its own adb client
  over 127.0.0.1 (Kadb 2.1.1, Apache-2.0; its SPAKE2 library is GPL-3.0, so the app carries a port of BoringSSL's
  `spake25519.cc` under the names Kadb calls, `com/flyfish233/crypto/spake2/Spake2Context.kt`, and leaves that
  library out). The adb key lives in the app's no-backup folder.
- **Starting.** The app connects to adbd (`_adb-tls-connect._tcp`; a port that refuses is dropped and, without a new
  announcement within 2 s, the loopback ports 32768–60999 are tried), checks `id -u` is 2000 (the shell user), grants
  itself `WRITE_SECURE_SETTINGS` (`pm grant`, so from then on it turns wireless debugging on and off itself), reads
  `ro.serialno` and starts the **shell helper** (`ShellHelper.kt`) from its own APK:
  `AIO_HELPER_TOKEN=… CLASSPATH=<base.apk> setsid app_process /system/bin ai.clawpage.agent.ShellHelper <port> <app uid>`.
  The adb connection is then closed. A foreground service (`specialUse`) keeps the app running; it is started the
  moment the person acts (the notification's reply, the console's button), since Android allows that only then.
- **The helper** listens on `127.0.0.1:<port>` as the shell user and runs one argv per request (never a shell line
  built from the agent's words). A connection from any uid but the app's is closed before a byte is read (the
  kernel's `/proc/net/tcp*` says whose socket it is); then both sides prove they hold the token without sending it
  (HMAC-SHA256 over each other's nonce), so a program that took the port first cannot pass for the helper either.
  It ends when told, or after 30 minutes without the app. Deviation from the first design: a loopback socket with
  these checks instead of a binder handed over through a content provider, whose hidden-API calls change shape
  across Android 9–16.
- **Tools** (`PhoneTools.kt`): the shell commands mobile-mcp runs over USB, through the helper. `screen_read`
  lists the other windows as `uiautomator dump --windows` has them and the window in use as a plain dump has it
  (mobilecli's reading, line for line); `screen_shot` is a JPEG at most 1024 px long (quality 75) with the same
  coordinate sentence; Chinese is typed through the clipboard and a paste. `apps_list` names the same apps;
  mobilecli's order is its own, so the order differs.
- **The one place a step is held back** is `PhoneTools.refusal`: today typing into a focused password field is
  refused (the person types passwords). An on-device confirmation for paying or sending would go there.
- **Background.** While the helper runs the device link stays up with the app in the background; the manifest
  then says `foreground: false` and drops `browser` (a panel over the console). `apps` and `screen` are listed only
  while the helper answers; the manifest's `aliases` carries the adb serial, so a phone also on a Mac's USB is one
  environment, reached through the app first and through the Mac when the app is gone.
- **Stop** (the notification, or the console) ends the helper and turns wireless debugging off. **Unlinking**
  the phone (or another account signing in) also deletes the adb key and gives `WRITE_SECURE_SETTINGS` back
  (`pm revoke` from the helper, 3 s later, after everything else).
- Not yet: the hidden virtual display (Android 13+), the live preview, restarting after a reboot, the release
  signing and where the APK is offered.

## Distribution

- **App Store iOS app** and **Google Play Android app**: `browser`, `files`, `photos`, `calendar` (and
  `reminders` on iOS). No accessibility service, no shell helper, no virtual display in the Play build.
- **Side-loaded Android APK**: the same app plus wireless-debugging pairing and the shell helper (`apps`,
  `screen`; see "The side-loaded Android app"). Planned: apps on a hidden virtual display, with a live preview the
  person can take over.

## Rollout

`PA_EXEC_ENVS=1` gives executors `aio_env` and the environment brief instead of `aio_ios` and
`aio_mac_native`. Off by default until the work below is done and verified end to end; then on.
`PA_EXEC_ENVS=owner` turns it on for the owner's account alone, to try it on real devices first; every
other account keeps its tools as they were.

1. Control plane: environment registry, `aio_env`, adapters for old devices, the brief. (iOS first.)
2. iPhone app: `/env/manifest`, `/env/call`, the in-app browser and files, foreground events.
3. Android app (Play build): device link, browser, files, the console's settings, calendar, the photos the
   person picks, the folder in the Files app, 20 MB pulls (done; 0.1.6).
4. Android APK: pairing, shell helper, `apps` / `screen` on the phone's own screen (built, emulator-tested, debug
   signing only); next the hidden virtual display, the live preview, a restart after reboot, release signing and
   where it is offered.

## Retiring the old servers

`aio_ios`, `aio_mac_native`, `PHONE_POLICY` and the `/ios/*` adapter are removed once both store apps
speaking protocol 1 are live and the device-link log shows no old-protocol device for 30 days.

## Tests

- `tests/integration/exec-envs.test.ts`: the control plane end to end with stand-in devices over a real
  device-link socket (new and old iPhone, old Mac with a USB phone, a Play-build and an APK Android, and the APK with
  the same phone on a protocol-1 Mac's USB as one environment).
- `tests/integration/mac-env.test.ts`: the real Mac bridge linked to a local control plane, with fakes only at
  the edge (adb, mobile-mcp, Chrome, a tmux server of its own): ids kept from the old adapter, phones plugged
  in and out, Chrome appearing, the terminal off and on, and the old endpoints still answering.
- `tests/devices/ios.e2e.test.ts`: the real iPhone app in the simulator against a local control plane.
- `tests/devices/android.e2e.test.ts`: the real Android app (the Play build) in the emulator against a local
  control plane: the same behaviours as the iPhone's, typing in Chinese included, and the console's own
  `deviceTools.ts` (put into the app's console page through DevTools, since that page is the deployed one)
  linking and unlinking it as the settings page does, turning the calendar on through Android's real prompt,
  picking photos in the real Photo Picker, a 13 MB pull, and the folder shown in the Files app.
- `tests/devices/android-full.e2e.test.ts`: the side-loaded app in the emulator against a local control plane:
  pairing with the emulator's own wireless debugging (the code handed in by a debug-only broadcast while the dialog
  stays open), the shell helper, every `apps` / `screen` tool compared with mobile-mcp's answer for the same
  emulator (through an adb that reaches only that serial), Chinese typing and the password refusal, the helper
  refusing the shell user even with the token, Stop from the notification, starting again and unlinking.
- `src/ui/tauri/check-android-builds.sh`: both release builds, checking the Play one has nothing of the side-loaded
  one and the side-loaded one none of its debug-only paths. The SPAKE2 port has JVM tests
  (`gradlew :app:testUniversalDebugUnitTest` with `AIO_ANDROID_DIST=full`).
- `tests/e2e/android-phone.spec.ts` and `iphone-abilities.spec.ts`: the two settings pages against a stand-in
  bridge (`playwright.local.config.ts`).

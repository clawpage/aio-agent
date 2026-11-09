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
| `files` | `files_list`, `files_pull` (device → workspace), `files_push` (workspace → device) |
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
- An old Mac app: the Mac's own environment from what its bridge offers, and one `android` environment
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

## Distribution

- **App Store iOS app** and **Google Play Android app**: `browser`, `files`, `photos`, `calendar` (and
  `reminders` on iOS). No accessibility service, no shell helper, no virtual display in the Play build.
- **Side-loaded Android APK**: the same app plus wireless-debugging pairing and the shell helper that
  runs apps on a hidden virtual display (`apps`, `screen`), with a live preview the person can take over.

## Rollout

`PA_EXEC_ENVS=1` gives executors `aio_env` and the environment brief instead of `aio_ios` and
`aio_mac_native`. Off by default until the work below is done and verified end to end; then on.

1. Control plane: environment registry, `aio_env`, adapters for old devices, the brief. (iOS first.)
2. iPhone app: `/env/manifest`, `/env/call`, the in-app browser and files, foreground events.
3. Android app (Play build): device link, browser, files, photos, calendar.
4. Android APK: pairing, shell helper, virtual display, `apps` / `screen`.

## Retiring the old servers

`aio_ios`, `aio_mac_native`, `PHONE_POLICY` and the `/ios/*` adapter are removed once both store apps
speaking protocol 1 are live and the device-link log shows no old-protocol device for 30 days.

## Tests

- `tests/integration/exec-envs.test.ts`: the control plane end to end with stand-in devices over a real
  device-link socket (new and old iPhone, old Mac with a USB phone, a Play-build and an APK Android).
- `tests/devices/ios.e2e.mjs`: the real iPhone app in the simulator against a local control plane.
- `tests/devices/android.e2e.mjs`: the real Android app in the emulator, both builds.

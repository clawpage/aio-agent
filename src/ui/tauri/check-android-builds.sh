#!/bin/bash
# Proves the Play build has nothing of the side-loaded one, and that the side-loaded release build has none of its
# debug-only paths (README.md, "The side-loaded Android app"). Builds both release APKs (unsigned, arm64 only) and checks:
#   1. Play: the merged manifest asks for exactly the permissions in play-permissions.txt;
#   2. Play: neither its runtime classpath nor its dex has Kadb or any of src/full's code;
#   3. full: the dex has the shell helper app_process starts, and none of the debug-only names.
# Usage (from this directory, with the Android toolchain of "Build and run" in the environment): ./check-android-builds.sh
set -euo pipefail
cd "$(dirname "$0")"
TOOLS="${ANDROID_HOME:?set ANDROID_HOME}/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)"
APK=src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
# The APK's application id (read whole: grep -q would close the pipe early, and pipefail would call that a failure).
package_of() { "$TOOLS/aapt2" dump badging "$1" | sed -n "s/^package: name='\([^']*\)'.*/\1/p"; }

# Every string in an APK's dex files.
dex_strings() { (cd "$WORK" && rm -rf dex && mkdir dex && unzip -q -o "$OLDPWD/$1" 'classes*.dex' -d dex && cat dex/*.dex | strings -n 6); }

# Unsigned release builds: no upload key, whatever the shell has.
build() { env -u AIO_ANDROID_KEYSTORE_PROPERTIES -u NODE_ENV "$@" npm run -- tauri android build --target aarch64 --apk >"$WORK/build.log" 2>&1 || { tail -40 "$WORK/build.log"; fail "build"; }; }

echo "Play release build…"
build env -u AIO_ANDROID_DIST
[ -f "$APK" ] || fail "no $APK"
[ "$(package_of "$APK")" = ai.clawpage.agent ] || fail "Play build's application id is not ai.clawpage.agent"
"$TOOLS/aapt2" dump permissions "$APK" | sed -n "s/^uses-permission: name='\([^']*\)'.*/\1/p" | sort >"$WORK/permissions"
diff -u play-permissions.txt "$WORK/permissions" || fail "Play build's permissions differ from play-permissions.txt"
(cd src-tauri/gen/android && env -u AIO_ANDROID_DIST ./gradlew -q :app:dependencies --configuration universalReleaseRuntimeClasspath) >"$WORK/deps"
grep -q -i -E "kadb|spake2|hiddenapibypass|bouncycastle" "$WORK/deps" && fail "Play build's runtime classpath has the side-loaded build's libraries"
dex_strings "$APK" >"$WORK/play-strings"
for marker in com/flyfishxu/kadb com/flyfish233 ShellHelper HelperClient PhoneTools ControlService ControlReceiver \
  _adb-tls-connect _adb-tls-pairing adb_wifi_enabled AIO_HELPER_TOKEN DEBUG_PAIR app_process; do
  grep -q -F "$marker" "$WORK/play-strings" && fail "Play build's dex has \"$marker\""
done
echo "OK: Play build unchanged (permissions, classpath, dex)"

echo "Side-loaded release build…"
build AIO_ANDROID_DIST=full
[ "$(package_of "$APK")" = ai.clawpage.agent.full ] || fail "side-loaded build's application id is not ai.clawpage.agent.full"
dex_strings "$APK" >"$WORK/full-strings"
grep -q -F "Lai/clawpage/agent/ShellHelper;" "$WORK/full-strings" || fail "side-loaded build lost the shell helper's class name"
for marker in ai.clawpage.agent.DEBUG_PAIR HelperProbe AIODeviceToolsLinkToken AIODeviceToolsLinkURL AIOConfirmSeconds; do
  grep -q -F "$marker" "$WORK/full-strings" && fail "side-loaded release build's dex has the debug-only \"$marker\""
done
echo "OK: side-loaded release build has none of the debug-only paths"

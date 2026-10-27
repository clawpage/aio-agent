#!/bin/sh
# The Mac app's phone runtime (src/phone_link.rs runs this before the bridge):
# Node.js, mobile-mcp, chrome-devtools-mcp (the user's own Chrome) and ws from the
# bundled lockfile, the scrcpy server, and Android's adb. Everything is a pinned version checked against its SHA-256, and
# lives in the app's data directory, so installing the app is all a user does.
# An adb already on this Mac is used as it is: it shares its server with
# whatever else talks to the phone.
#
#   install.sh <runtime dir> <bundled phone resources dir>
#
# Output, one per line: "step <what is being fetched>", then "node <path>",
# "adb <path>", "bridge <path>"; or "error <reason>" and a non-zero exit.
set -eu
DIR=$1
RES=$2

NODE_VERSION=v24.21.0
case "$(uname -m)" in
  arm64) NODE_ARCH=arm64; NODE_SHA256=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
  x86_64) NODE_ARCH=x64; NODE_SHA256=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
  *) echo "error unsupported processor $(uname -m)"; exit 1 ;;
esac
# Google publishes SHA-1 (6ae73f4de6452dc57e62ec02b68eed92a4c21661) in its repository manifest; this is the same archive.
PLATFORM_TOOLS=platform-tools_r37.0.1-darwin.zip
PLATFORM_TOOLS_SHA256=ee39ad5967e95c2a07f04dbcbde96b1a0c916ba376096db5d2f498b7727a5d1d

mkdir -p "$DIR"
cd "$DIR"

fetch() {
  part="$2.part"
  if ! curl -fsSL --retry 3 --connect-timeout 20 -o "$part" "$1"; then rm -f "$part"; echo "error download failed: $1"; exit 1; fi
  if [ "$(shasum -a 256 "$part" | cut -d' ' -f1)" != "$3" ]; then rm -f "$part"; echo "error checksum mismatch: $1"; exit 1; fi
  mv "$part" "$2"
}

NODE_DIR="node-$NODE_VERSION-darwin-$NODE_ARCH"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  echo "step Node.js"
  fetch "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIR.tar.gz" node.tar.gz "$NODE_SHA256"
  tar -xzf node.tar.gz
  rm node.tar.gz
fi
NODE_BIN="$DIR/$NODE_DIR/bin"

ADB=
for candidate in "${ANDROID_HOME:-/nonexistent}/platform-tools/adb" "$HOME/Library/Android/sdk/platform-tools/adb" /opt/homebrew/bin/adb /usr/local/bin/adb; do
  if [ -x "$candidate" ]; then ADB=$candidate; break; fi
done
if [ -z "$ADB" ]; then
  if [ ! -x platform-tools/adb ]; then
    echo "step Android platform-tools"
    fetch "https://dl.google.com/android/repository/$PLATFORM_TOOLS" platform-tools.zip "$PLATFORM_TOOLS_SHA256"
    unzip -q -o platform-tools.zip
    rm platform-tools.zip
  fi
  ADB="$DIR/platform-tools/adb"
fi

# The bridge scripts sit beside their node_modules so `ws` resolves; a new app version reinstalls.
STAMP=$(cat "$RES/package-lock.json" "$RES/phone-bridge.mjs" "$RES/device-link-client.mjs" "$RES/user-browser.mjs" "$RES/mac-shell.mjs" | shasum -a 256 | cut -d' ' -f1)
if [ "$(cat mobile-mcp/.stamp 2>/dev/null || true)" != "$STAMP" ]; then
  echo "step mobile-mcp"
  mkdir -p mobile-mcp
  cp "$RES/package.json" "$RES/package-lock.json" "$RES/phone-bridge.mjs" "$RES/device-link-client.mjs" "$RES/user-browser.mjs" "$RES/mac-shell.mjs" mobile-mcp/
  if ! (cd mobile-mcp && PATH="$NODE_BIN:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1); then
    echo "error npm ci failed"; exit 1
  fi
  echo "$STAMP" > mobile-mcp/.stamp
fi

if ! PA_PHONE_DIR="$DIR" "$NODE_BIN/node" mobile-mcp/phone-bridge.mjs setup-screen >/dev/null 2>&1; then
  echo "error scrcpy server download failed"; exit 1
fi

echo "node $NODE_BIN/node"
echo "adb $ADB"
echo "bridge $DIR/mobile-mcp/phone-bridge.mjs"

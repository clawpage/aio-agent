#!/bin/bash
# The existing deployment's speech server for aio_tts (docs/FEATURES.md「朗读」), on a Mac on the
# home network: Qwen3-TTS 12Hz 0.6B CustomVoice, INT8, on the CPU, served by the pure-C engine
# gabriele-mastrapasqua/qwen3-tts (MIT) at a pinned commit and kept running under launchd.
# Optional: any server answering POST /v1/tts {text, speaker, language} with a WAV works for PA_TTS_URL.
# Usage: deploy/tts/deploy.sh [user@host]   (default: old-mb)
set -euo pipefail
host=${1:-max@100.80.219.88}
dir=workspace/projects/qwen3-tts
label=com.workspace.qwen3-tts
port=4911
rev=ef339be58a778b062e1c14382347964552eae007
# Half of old-mb's 12 hardware threads: the sandboxes on the same machine keep the rest.
threads=6

ssh "$host" bash -s <<EOF
set -euo pipefail
mkdir -p ~/$dir/var ~/$dir/models
cd ~/$dir
test -d src/.git || git clone -q https://github.com/gabriele-mastrapasqua/qwen3-tts.git src
git -C src fetch -q origin
git -C src checkout -q $rev
# AVX2 + FMA is what old-mb's i7-9750H has (no AVX-512).
make -C src blas SIMD=portable >var/build.log 2>&1 || { tail -20 var/build.log; exit 1; }
(cd src && ./download_model.sh --model small --dir ~/$dir/models/qwen3-tts-0.6b)
plist=~/Library/LaunchAgents/$label.plist
cat > \$plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>\$HOME/$dir/src/qwen_tts</string>
    <string>-d</string><string>\$HOME/$dir/models/qwen3-tts-0.6b</string>
    <string>--int8</string>
    <string>-j</string><string>$threads</string>
    <string>--serve</string><string>$port</string>
  </array>
  <key>WorkingDirectory</key><string>\$HOME/$dir</string>
  <key>RunAtLoad</key><true/>
  <!-- Unset, launchd throttles the job's CPU (it doubled X-ASR's decode time on this machine). -->
  <key>ProcessType</key><string>Interactive</string>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>\$HOME/$dir/var/server.log</string>
  <key>StandardErrorPath</key><string>\$HOME/$dir/var/server.log</string>
</dict></plist>
PLIST
launchctl bootout gui/\$(id -u)/$label 2>/dev/null || true
# bootout returns before the job is gone; bootstrap fails until it is.
for _ in \$(seq 1 20); do launchctl print gui/\$(id -u)/$label >/dev/null 2>&1 || break; sleep 0.5; done
launchctl bootstrap gui/\$(id -u) \$plist
for _ in \$(seq 1 60); do curl -sf http://127.0.0.1:$port/v1/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:$port/v1/health && echo " $label up"
EOF

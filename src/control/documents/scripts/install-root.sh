#!/usr/bin/env bash
# Root-only provisioning step for the AIO sandbox document toolchain.
#
#   install-root.sh <tool_dir>
#
# This content is supplied by the control plane as fixed argv (never read from a
# path the sandbox user can write), so a compromised `gem` account cannot change
# what root executes. It is deliberately narrow:
#
#   * it installs OS packages only (LibreOffice, poppler, CJK fonts, python3-venv);
#   * it makes exactly one directory tree writable by the sandbox user - the
#     managed tool directory - and never chowns anything else in CODEX_HOME;
#   * it never reads, writes or relaxes /etc/codex, so the Codex MCP isolation
#     policy installed by the control plane stays in force.
set -u

TOOL_DIR="${1:-}"
[ -n "$TOOL_DIR" ] || { echo '{"ok":false,"code":"missing_tool_dir","message":"Missing tool directory"}'; exit 0; }
# A prefix match alone would accept `/home/gem/.codex/tools/../../etc`, which
# realpath-collapses to a directory outside the intended tree. Reject any `.` or
# `..` segment outright before the prefix check below.
case "$TOOL_DIR/" in
  */./*|*/../*|*//*) echo '{"ok":false,"code":"bad_tool_dir","message":"The tool directory must not contain . or .. path segments"}'; exit 0 ;;
esac
case "$TOOL_DIR" in
  /home/gem/.codex/tools/*) : ;;
  *) echo '{"ok":false,"code":"tool_dir_outside","message":"The tool directory must be under /home/gem/.codex/tools"}'; exit 0 ;;
esac

SANDBOX_USER="${2:-gem}"

export DEBIAN_FRONTEND=noninteractive

# Only touch apt when something is actually missing. This step also performs the
# directory ownership fix, so it is re-run whenever the tool directory is not
# writable by the sandbox user; without this fast path every such re-run would
# pay a full apt update/install for nothing.
NEED_APT=0
command -v soffice >/dev/null 2>&1 || NEED_APT=1
command -v pdftoppm >/dev/null 2>&1 || NEED_APT=1
command -v pdfinfo >/dev/null 2>&1 || NEED_APT=1
# python3-venv is required by the user-side step; without it the isolated venv
# cannot be created, which is exactly the failure this step must prevent.
python3 -c 'import ensurepip' >/dev/null 2>&1 || NEED_APT=1
if [ -d /usr/share/fonts/truetype/noto ] || [ -d /usr/share/fonts/opentype/noto ]; then : ; else NEED_APT=1; fi

if [ "$NEED_APT" = "1" ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo '{"ok":false,"code":"no_apt","message":"This image has no apt-get, so system dependencies cannot be installed"}'
    exit 0
  fi
  if ! apt-get update -qq >/dev/null 2>&1; then
    echo '{"ok":false,"code":"apt_update_failed","message":"apt-get update failed (usually the sandbox has no outbound network)"}'
    exit 0
  fi
  if ! apt-get install -y -qq --no-install-recommends \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils fonts-noto-cjk python3-venv >/dev/null 2>&1; then
    echo '{"ok":false,"code":"apt_install_failed","message":"Could not install LibreOffice/poppler/fonts/python3-venv"}'
    exit 0
  fi
fi

# The tool directory lives under the sandbox user's own CODEX_HOME, so that user
# can create a symlink there. Root must never follow one: chown/chmod would then
# hand over (or damage) whatever the link points at. Every level of the path is
# therefore checked, and any symlink is a hard failure rather than a silent skip.
if ! id -u "$SANDBOX_USER" >/dev/null 2>&1; then
  echo '{"ok":false,"code":"no_user","message":"The sandbox user does not exist, so the tool directory permissions cannot be set"}'
  exit 0
fi

check_no_symlink() {
  # $1 = absolute path. Walks each existing ancestor and refuses symlinks.
  local target="$1" current=""
  local IFS=/
  # shellcheck disable=SC2086
  set -- $target
  for segment in "$@"; do
    [ -n "$segment" ] || continue
    current="$current/$segment"
    if [ -L "$current" ]; then
      echo "$current"
      return 1
    fi
  done
  return 0
}

if ! link=$(check_no_symlink "$TOOL_DIR"); then
  echo "{\"ok\":false,\"code\":\"tool_dir_symlink\",\"path\":\"$link\",\"message\":\"The tool directory path contains a symbolic link, so root refused to act on it: $link\"}"
  exit 0
fi

# Narrow, explicit ownership fix: only the managed tool directory (which is
# ours alone) becomes writable by the sandbox user, so the user-side step can
# create its venv and the render cache. Nothing else under CODEX_HOME is touched.
if ! mkdir -p -- "$TOOL_DIR/cache"; then
  echo '{"ok":false,"code":"tool_dir","message":"Could not create the tool directory"}'
  exit 0
fi
if ! chown -R "$SANDBOX_USER":"$SANDBOX_USER" -- "$TOOL_DIR"; then
  echo '{"ok":false,"code":"chown_failed","message":"Could not set the tool directory owner"}'
  exit 0
fi
if ! chmod 0755 -- "$TOOL_DIR"; then
  echo '{"ok":false,"code":"chmod_failed","message":"Could not set the tool directory permissions"}'
  exit 0
fi

echo "{\"ok\":true,\"code\":\"root_installed\",\"aptRan\":$([ "$NEED_APT" = "1" ] && echo true || echo false),\"message\":\"System dependencies are ready and the tool directory permissions are set\"}"

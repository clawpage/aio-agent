#!/usr/bin/env bash
# Provision (or verify) the AIO sandbox document toolchain.
#
#   provision.sh check   <tool_dir>   -> read-only readiness JSON
#   provision.sh install <tool_dir>   -> user-side install, then check
#
# Two-phase design, because the two halves have different privileges:
#
#   * The OS packages (LibreOffice, poppler, CJK fonts, python3-venv) need root.
#     That step lives in `install-root.sh`, whose content the control plane
#     supplies as fixed argv - root never executes a script the sandbox user can
#     edit. This script only *reports* whether that step is still needed
#     (`needsRoot`), it never attempts apt itself.
#   * Everything else - the isolated venv, the Python document libraries, the
#     published CLI - runs as the sandbox user inside the managed tool directory,
#     which `install-root.sh` made writable by that user.
#
# Repeatability rules:
#   * The fixed AIO image is never modified. Everything managed here lives in the
#     persistent CODEX_HOME volume, so a container rebuild keeps it.
#   * A marker file records which tool set was provisioned, and `install` exits
#     immediately when the marker and the real commands agree, so a normal start
#     never repeats a large apt/pip run.
#   * Python libraries go into an isolated venv. The image's own Python packages
#     are never pip-installed over, so a sandbox service that depends on them
#     cannot be broken by provisioning.
#   * Failure is reported as data, never as a crash: the control plane keeps
#     serving chat even when documents are unavailable.
set -u

MODE="${1:-check}"
TOOL_DIR="${2:-/home/gem/.codex/tools/aio-doc}"

MARKER="$TOOL_DIR/.provision.json"
VENV_DIR="$TOOL_DIR/venv"
VENV_PY="$VENV_DIR/bin/python"
MARKER_VERSION="aio-doc-tools-v1"

# Fonts matter for fidelity: without a CJK font a Chinese document renders as
# boxes even though the conversion itself succeeded.
FONT_DIRS="/usr/share/fonts/truetype/noto /usr/share/fonts/opentype/noto"

have() { command -v "$1" >/dev/null 2>&1; }

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# `python3 -m venv` fails with "ensurepip is not available" when the
# python3-venv package is missing, so that module is the real signal - not the
# presence of the `venv` directory, which may exist but be unusable.
have_ensurepip() {
  have python3 || return 1
  python3 -c 'import ensurepip' >/dev/null 2>&1
}

emit_check() {
  local soffice="false" pdftoppm="false" pdfinfo="false" font="false"
  local docx="false" openpyxl="false" pptx="false" pypdf="false" reportlab="false" pandas="false"
  local venv="false" marker="false" ready="false" cli="false"
  local venv_module="false" needs_root="false" tool_dir_writable="false"
  local missing=""

  have soffice && soffice="true"
  have pdftoppm && pdftoppm="true"
  have pdfinfo && pdfinfo="true"
  for d in $FONT_DIRS; do [ -d "$d" ] && font="true"; done
  have fc-list && fc-list 2>/dev/null | grep -qi 'cjk\|noto sans sc\|wqy' && font="true"
  have_ensurepip && venv_module="true"

  [ -x "$VENV_PY" ] && venv="true"
  [ -x "$TOOL_DIR/bin/aio-doc" ] && cli="true"
  [ -f "$MARKER" ] && grep -q "$MARKER_VERSION" "$MARKER" 2>/dev/null && marker="true"
  # The user-side step can only run when the managed directory is writable by us.
  if [ -d "$TOOL_DIR" ] && [ -w "$TOOL_DIR" ]; then tool_dir_writable="true"; fi

  local py=""
  if [ -x "$VENV_PY" ]; then py="$VENV_PY"; elif have python3; then py="python3"; fi
  if [ -n "$py" ]; then
    # One interpreter probe for every library: never a per-library process.
    local probe
    probe=$("$py" - <<'PY' 2>/dev/null || true
import importlib
for mod in ("docx", "openpyxl", "pptx", "pypdf", "reportlab", "pandas"):
    try:
        importlib.import_module(mod)
        print(f"{mod}=1")
    except Exception:
        print(f"{mod}=0")
PY
)
    case "$probe" in *"docx=1"*) docx="true" ;; esac
    case "$probe" in *"openpyxl=1"*) openpyxl="true" ;; esac
    case "$probe" in *"pptx=1"*) pptx="true" ;; esac
    case "$probe" in *"pypdf=1"*) pypdf="true" ;; esac
    case "$probe" in *"reportlab=1"*) reportlab="true" ;; esac
    case "$probe" in *"pandas=1"*) pandas="true" ;; esac
  fi

  [ "$soffice" = "true" ] || missing="$missing,\"libreoffice\""
  [ "$pdftoppm" = "true" ] || missing="$missing,\"poppler\""
  [ "$venv_module" = "true" ] || missing="$missing,\"python3-venv\""
  [ "$docx" = "true" ] || missing="$missing,\"python-docx\""
  [ "$openpyxl" = "true" ] || missing="$missing,\"openpyxl\""
  [ "$pptx" = "true" ] || missing="$missing,\"python-pptx\""

  # Anything the OS package manager must supply means the root step has to run.
  if [ "$soffice" != "true" ] || [ "$pdftoppm" != "true" ] || [ "$pdfinfo" != "true" ] || [ "$venv_module" != "true" ]; then
    needs_root="true"
  fi

  # Preview only needs LibreOffice + poppler; the libraries add create/edit.
  local preview="false" authoring="false"
  [ "$soffice" = "true" ] && [ "$pdftoppm" = "true" ] && preview="true"
  [ "$docx" = "true" ] && [ "$openpyxl" = "true" ] && [ "$pptx" = "true" ] && authoring="true"
  [ "$preview" = "true" ] && [ "$authoring" = "true" ] && ready="true"

  printf '{"ok":true,"version":"%s","ready":%s,"previewReady":%s,"authoringReady":%s,"marker":%s,"venv":%s,' \
    "$MARKER_VERSION" "$ready" "$preview" "$authoring" "$marker" "$venv"
  printf '"needsRoot":%s,"venvModule":%s,"toolDirWritable":%s,' "$needs_root" "$venv_module" "$tool_dir_writable"
  printf '"tools":{"soffice":%s,"pdftoppm":%s,"pdfinfo":%s,"cjkFont":%s,"aioDocCli":%s},' "$soffice" "$pdftoppm" "$pdfinfo" "$font" "$cli"
  printf '"python":{"docx":%s,"openpyxl":%s,"pptx":%s,"pypdf":%s,"reportlab":%s,"pandas":%s},' \
    "$docx" "$openpyxl" "$pptx" "$pypdf" "$reportlab" "$pandas"
  printf '"venvPython":"%s","missing":[%s]}\n' "$(json_escape "$VENV_PY")" "${missing#,}"
}

emit_install_result() {
  local ok="$1" code="$2" message="$3"
  printf '{"ok":%s,"code":"%s","message":"%s"}\n' "$ok" "$(json_escape "$code")" "$(json_escape "$message")"
}

# Publish the managed CLI at its stable absolute path. The scripts directory is
# rewritten by the control plane on every start (the digest changes), so the
# installed CLI must be refreshed too - otherwise the fast path below would exit
# before copying and the sandbox would keep running an old `aio-doc` forever.
# A failed copy/chmod is reported, never silently treated as success.
publish_cli() {
  local src="$TOOL_DIR/scripts/aio-doc" dst="$TOOL_DIR/bin/aio-doc"
  [ -f "$src" ] || { emit_install_result false "cli_missing" "控制面脚本目录缺少 aio-doc"; return 1; }
  if ! mkdir -p -- "$TOOL_DIR/bin"; then
    emit_install_result false "cli_dir" "无法创建 bin 目录"
    return 1
  fi
  if ! cp -- "$src" "$dst"; then
    emit_install_result false "cli_copy_failed" "复制 aio-doc 到 bin 目录失败"
    return 1
  fi
  if ! chmod 0755 -- "$dst"; then
    emit_install_result false "cli_chmod_failed" "设置 aio-doc 执行权限失败"
    return 1
  fi
  return 0
}

if [ "$MODE" = "check" ]; then
  emit_check
  exit 0
fi

if [ "$MODE" != "install" ]; then
  emit_install_result false "bad_mode" "未知模式：只支持 check / install"
  exit 0
fi

# The user-side step needs a directory it can write. `install-root.sh` grants it;
# if it is still not writable, say so instead of failing halfway.
if ! mkdir -p -- "$TOOL_DIR" 2>/dev/null; then
  emit_install_result false "tool_dir" "无法创建工具目录 $TOOL_DIR（需要先运行 root 安装步骤）"
  exit 0
fi
if [ ! -w "$TOOL_DIR" ]; then
  emit_install_result false "tool_dir_readonly" "工具目录 $TOOL_DIR 对沙箱用户不可写；需要先运行 root 安装步骤设置权限"
  exit 0
fi

# Root-side dependencies must already be in place: this script never calls apt.
if ! have soffice || ! have pdftoppm || ! have pdfinfo; then
  emit_install_result false "need_root" "缺少 LibreOffice/poppler；需要先运行 root 安装步骤"
  exit 0
fi
if ! have_ensurepip; then
  emit_install_result false "need_root" "缺少 python3-venv（无法创建隔离 venv）；需要先运行 root 安装步骤"
  exit 0
fi

# Fast path: marker and real commands agree -> no pip/apt work.
#
# The CLI is still re-published first: the control plane rewrites the scripts
# directory on every start, so an early exit that skipped the copy would leave a
# stale `aio-doc` in place while the skill/README describe the new one.
if [ -f "$MARKER" ] && grep -q "$MARKER_VERSION" "$MARKER" 2>/dev/null; then
  if [ -x "$VENV_PY" ]; then
    if "$VENV_PY" -c 'import docx, openpyxl, pptx' >/dev/null 2>&1; then
      publish_cli || exit 0
      mkdir -p -- "$TOOL_DIR/cache" 2>/dev/null || true
      emit_install_result true "already" "文档工具已就绪，无需重复安装"
      emit_check
      exit 0
    fi
  fi
fi

# A venv created before python3-venv existed is a broken directory, not a venv:
# recreate it rather than piling a pip install onto something unusable.
if [ -e "$VENV_DIR" ] && ! [ -x "$VENV_PY" ]; then
  rm -rf -- "$VENV_DIR" 2>/dev/null || true
fi

if [ ! -x "$VENV_PY" ]; then
  # --system-site-packages lets the venv reuse the image's verified openpyxl/pptx
  # instead of reinstalling them, while keeping every new package out of the
  # image's own site-packages.
  if ! python3 -m venv --system-site-packages "$VENV_DIR" >/dev/null 2>&1; then
    rm -rf -- "$VENV_DIR" 2>/dev/null || true
    emit_install_result false "venv_failed" "创建隔离 venv 失败（可能仍缺少 python3-venv 或 ensurepip）"
    exit 0
  fi
fi

if ! "$VENV_PY" -c 'import docx, openpyxl, pptx' >/dev/null 2>&1; then
  if ! "$VENV_PY" -m pip install --quiet --disable-pip-version-check \
      python-docx openpyxl python-pptx pypdf reportlab >/dev/null 2>&1; then
    emit_install_result false "pip_failed" "安装 Python 文档库失败（通常是沙箱没有网络出口）"
    exit 0
  fi
fi

if ! "$VENV_PY" -c 'import docx, openpyxl, pptx' >/dev/null 2>&1; then
  emit_install_result false "verify_failed" "安装后仍无法导入文档库，未标记为就绪"
  exit 0
fi

# Publish the CLI at a stable absolute path so the skill/README can name it.
publish_cli || exit 0

# The render cache must be writable by the user-side renderer; create it here so
# a fresh install never leaves the cache directory owned by root.
mkdir -p -- "$TOOL_DIR/cache" 2>/dev/null || true

printf '{"version":"%s","installedAt":%s}\n' "$MARKER_VERSION" "$(date +%s)" > "$MARKER" 2>/dev/null || true
emit_install_result true "installed" "文档工具安装完成"
emit_check

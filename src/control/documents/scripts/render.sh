#!/usr/bin/env bash
# Render a workspace document into page rasters (PNG) inside the AIO sandbox, or
# convert it to another format.
#
#   render.sh <input> <cache_dir> <max_pages> [timeout]         -> page rasters
#   render.sh --convert <input> <format> <outdir> [timeout]     -> one converted file
#
# `timeout` is seconds and is enforced *inside* the container by `timeout(1)`,
# not only by the caller killing the docker CLI: a killed CLI would leave
# LibreOffice running and the cache directory half-written.
#
# This script (with lo-run.sh) is the ONLY thing that parses a document. The
# control plane never reads Office/PDF bytes itself: it fetches the PNGs this
# script produced through the sandbox file API and serves them as authenticated
# images.
#
# Safety properties, all enforced here rather than trusted from the caller:
#   * input and output must resolve (realpath) inside the workspace root, so a
#     symlink cannot escape the workspace even though the lexical path looked
#     valid - this is the second check, the caller's lexical check is the first;
#   * LibreOffice runs through lo-run.sh, which uses a private profile with macro
#     security at the highest level and external-link updating disabled;
#   * page count and per-page pixel size are capped, and every step is bounded by
#     `timeout`, so one huge/corrupt document cannot exhaust the container;
#   * output goes to the cache directory (or a NEW file for conversion) only - a
#     user's original file is never overwritten or modified.
set -u

WORKSPACE_ROOT="/home/gem/workspace"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LO_RUN="$SCRIPT_DIR/lo-run.sh"
# Page rasters are written here and nowhere else. It sits beside the managed
# scripts (outside the user's workspace), so a preview never litters the files a
# user sees, and the only path this script ever deletes from is a per-run
# subdirectory of this root.
CACHE_ROOT="$(dirname -- "$SCRIPT_DIR")/cache"

# Bounds. Each page is capped by longest-side pixels so a giant PDF page cannot
# allocate an unbounded bitmap; the total page cap bounds the work per request.
MAX_PAGE_PIXELS=2200
MAX_RENDER_PAGES=50
MAX_SOURCE_BYTES=104857600
MAX_PAGE_BYTES=12582912
DEFAULT_CONVERT_TIMEOUT=150
DEFAULT_RENDER_TIMEOUT=180
MAX_TIMEOUT=600

fail() {
  # $1 = machine code, $2 = human message (Chinese, shown to the user)
  json_fail "$1" "$2"
  exit 0
}

# Resolve an absolute path and confirm it is inside the workspace.
#
# The workspace root itself is accepted as well as anything below it: an output
# directory of `/home/gem/workspace` is legitimate (a file at the workspace root
# converts in place), and only `resolve_in_workspace` callers that need a file
# reject it later with `not_a_file`.
resolve_in_workspace() {
  local candidate="$1"
  case "$candidate" in
    "$WORKSPACE_ROOT"|"$WORKSPACE_ROOT"/*) : ;;
    *) return 1 ;;
  esac
  local real
  real=$(realpath -e -- "$candidate" 2>/dev/null) || return 1
  case "$real" in
    "$WORKSPACE_ROOT"|"$WORKSPACE_ROOT"/*) printf '%s' "$real"; return 0 ;;
    *) return 1 ;;
  esac
}

# Emit one JSON line, encoding every value properly instead of splicing strings
# into a template. Usage:
#   json_emit <page_count> [<index> <path> <bytes>]... [key value]...
# python3 is guaranteed in the image (the toolchain requires it), and it does the
# escaping, so a path containing a quote or a backslash cannot corrupt the JSON
# the control plane parses.
json_emit() {
  python3 - "$@" <<'PYEOF'
import json, sys

args = list(sys.argv[1:])
count = int(args[0])
cursor = 1
pages = []
for _ in range(count):
    pages.append({"index": int(args[cursor]), "path": args[cursor + 1], "bytes": int(args[cursor + 2])})
    cursor += 3
payload = {"ok": True, "pages": pages}
rest = args[cursor:]
for key, value in zip(rest[0::2], rest[1::2]):
    if value in ("true", "false"):
        payload[key] = value == "true"
    elif value.isdigit():
        payload[key] = int(value)
    else:
        payload[key] = value
print(json.dumps(payload, ensure_ascii=False))
PYEOF
}

# Encode one value as a JSON string literal (quotes included).
json_str() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1], ensure_ascii=False))' "$1"
}

# Emit a failure as JSON with the same proper escaping.
json_fail() {
  python3 - "$1" "$2" <<'PYEOF'
import json, sys
print(json.dumps({"ok": False, "code": sys.argv[1], "message": sys.argv[2]}, ensure_ascii=False))
PYEOF
}

require_size_ok() {
  local target="$1" size
  size=$(stat -c %s -- "$target" 2>/dev/null || echo 0)
  case "$size" in ''|*[!0-9]*) size=0 ;; esac
  if [ "$size" -gt "$MAX_SOURCE_BYTES" ]; then
    fail "too_large" "文件超过 100MB，无法在线处理，请下载后处理"
  fi
  if [ "$size" -eq 0 ]; then
    fail "empty_file" "文件是空的（0 字节）"
  fi
}

# Publish <src> into <outdir> as <stem>.<ext>, never overwriting. The file is
# created with O_EXCL, so a concurrent conversion of the same source loses the
# race and takes the next numbered name rather than clobbering the winner. Prints
# the final absolute path; exits non-zero if nothing could be written.
publish_exclusive() {
  python3 - "$1" "$2" "$3" "$4" <<'PY'
import os, shutil, sys

src, outdir, stem, ext = sys.argv[1:5]
for suffix in range(0, 1000):
    name = "%s.%s" % (stem, ext) if suffix == 0 else "%s (%d).%s" % (stem, suffix, ext)
    destination = os.path.join(outdir, name)
    try:
        fd = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        continue
    except OSError:
        sys.exit(3)
    try:
        with os.fdopen(fd, "wb") as out, open(src, "rb") as inp:
            shutil.copyfileobj(inp, out)
    except OSError:
        try:
            os.unlink(destination)
        except OSError:
            pass
        sys.exit(3)
    sys.stdout.write(destination)
    sys.exit(0)
sys.exit(4)
PY
}

# ------------------------------------------------------------------ convert ---
if [ "${1:-}" = "--convert" ]; then
  CONVERT_INPUT="${2:-}"
  CONVERT_FORMAT="${3:-}"
  CONVERT_OUTDIR="${4:-}"
  CONVERT_TIMEOUT="${5:-$DEFAULT_CONVERT_TIMEOUT}"
  case "$CONVERT_TIMEOUT" in ''|*[!0-9]*) CONVERT_TIMEOUT="$DEFAULT_CONVERT_TIMEOUT" ;; esac
  [ "$CONVERT_TIMEOUT" -ge 5 ] || CONVERT_TIMEOUT="$DEFAULT_CONVERT_TIMEOUT"
  [ "$CONVERT_TIMEOUT" -le "$MAX_TIMEOUT" ] || CONVERT_TIMEOUT="$MAX_TIMEOUT"

  case "$CONVERT_FORMAT" in
    pdf|docx|xlsx|pptx|csv|txt|odt|ods|odp|html) : ;;
    *) fail "bad_request" "不支持的目标格式" ;;
  esac
  [ -n "$CONVERT_INPUT" ] || fail "bad_request" "缺少文件路径"
  [ -n "$CONVERT_OUTDIR" ] || fail "bad_request" "缺少输出目录"

  CONVERT_REAL=$(resolve_in_workspace "$CONVERT_INPUT") || fail "outside_workspace" "只允许转换工作区内的文件（或该路径指向工作区之外）"
  [ -f "$CONVERT_REAL" ] || fail "not_a_file" "该路径不是普通文件"
  require_size_ok "$CONVERT_REAL"

  OUTDIR_REAL=$(resolve_in_workspace "$CONVERT_OUTDIR") || fail "outside_workspace" "输出目录必须在工作区内"
  [ -d "$OUTDIR_REAL" ] || fail "not_found" "输出目录不存在"

  [ -x "$LO_RUN" ] || fail "missing_tool" "沙箱缺少 LibreOffice 运行脚本"
  command -v soffice >/dev/null 2>&1 || fail "missing_tool" "沙箱缺少 LibreOffice"

  STEM=$(basename -- "${CONVERT_REAL%.*}")
  TARGET_NAME="$STEM.$CONVERT_FORMAT"
  if [ "$CONVERT_REAL" = "$OUTDIR_REAL/$TARGET_NAME" ]; then
    # A same-format conversion would rewrite the user's own file in place.
    fail "bad_request" "转换结果会覆盖原文件，请换一个目标格式"
  fi

  # LibreOffice writes into a throwaway directory first. Writing straight into
  # the user's directory had two failure modes: it silently overwrote an existing
  # file of the same name, and a failed conversion that left an *old* file behind
  # was then reported as a success. A fresh temp directory makes "did this run
  # produce anything?" a real question.
  CONVERT_TMP=$(mktemp -d /tmp/aio-lo-convert-XXXXXX 2>/dev/null) || fail "temp_error" "无法创建临时目录"
  # The inner cap is the configured budget; the outer `timeout` is only a
  # backstop in case soffice ignores its own deadline, so it is deliberately
  # larger. Nothing here kills anything but this conversion's own children.
  if ! timeout "$((CONVERT_TIMEOUT + 15))" "$LO_RUN" convert "$CONVERT_REAL" "$CONVERT_FORMAT" "$CONVERT_TMP" "$CONVERT_TIMEOUT" >/dev/null 2>&1; then
    rm -rf -- "$CONVERT_TMP" 2>/dev/null || true
    fail "convert_failed" "转换失败：文件可能已损坏，或不支持该目标格式"
  fi
  PRODUCED="$CONVERT_TMP/$TARGET_NAME"
  if [ ! -s "$PRODUCED" ]; then
    # LibreOffice names the output after the input; fall back to the single
    # produced file only when there is exactly one, so we never guess.
    CANDIDATES=$(find "$CONVERT_TMP" -maxdepth 1 -type f 2>/dev/null | wc -l)
    if [ "$CANDIDATES" -eq 1 ]; then
      PRODUCED=$(find "$CONVERT_TMP" -maxdepth 1 -type f 2>/dev/null | head -n 1)
    fi
  fi
  if [ ! -s "$PRODUCED" ]; then
    rm -rf -- "$CONVERT_TMP" 2>/dev/null || true
    fail "convert_failed" "LibreOffice 未生成预期的输出文件"
  fi

  # Publish without ever overwriting. The destination is created exclusively
  # (O_EXCL): two concurrent conversions of the same source cannot both claim the
  # same name - the loser advances to the next numbered name instead of racing a
  # plain `cp` into the same file, which was observed to fail under concurrency.
  if ! FINAL=$(publish_exclusive "$PRODUCED" "$OUTDIR_REAL" "$STEM" "$CONVERT_FORMAT"); then
    rm -rf -- "$CONVERT_TMP" 2>/dev/null || true
    fail "convert_failed" "无法写入转换结果"
  fi
  rm -rf -- "$CONVERT_TMP" 2>/dev/null || true

  BYTES=$(stat -c %s -- "$FINAL" 2>/dev/null || echo 0)
  case "$BYTES" in ''|*[!0-9]*) BYTES=0 ;; esac
  printf '{"ok":true,"path":%s,"bytes":%s}\n' "$(json_str "$FINAL")" "$BYTES"
  exit 0
fi

# ------------------------------------------------------------------ preview ---
INPUT="${1:-}"
CACHE_DIR="${2:-}"
MAX_PAGES="${3:-12}"
CONVERT_TIMEOUT="${4:-$DEFAULT_CONVERT_TIMEOUT}"
case "$CONVERT_TIMEOUT" in ''|*[!0-9]*) CONVERT_TIMEOUT="$DEFAULT_CONVERT_TIMEOUT" ;; esac
[ "$CONVERT_TIMEOUT" -ge 5 ] || CONVERT_TIMEOUT="$DEFAULT_CONVERT_TIMEOUT"
[ "$CONVERT_TIMEOUT" -le "$MAX_TIMEOUT" ] || CONVERT_TIMEOUT="$MAX_TIMEOUT"
RENDER_TIMEOUT="$CONVERT_TIMEOUT"

[ -n "$INPUT" ] || fail "bad_request" "缺少文件路径"
[ -n "$CACHE_DIR" ] || fail "bad_request" "缺少缓存目录"
case "$MAX_PAGES" in
  ''|*[!0-9]*) fail "bad_request" "页数上限非法" ;;
esac
[ "$MAX_PAGES" -ge 1 ] || fail "bad_request" "页数上限非法"
[ "$MAX_PAGES" -le "$MAX_RENDER_PAGES" ] || MAX_PAGES="$MAX_RENDER_PAGES"

REAL=$(resolve_in_workspace "$INPUT") || fail "outside_workspace" "只允许预览工作区内的文件（或该路径指向工作区之外）"
[ -f "$REAL" ] || fail "not_a_file" "该路径不是普通文件"
require_size_ok "$REAL"

# The cache directory must be a dedicated subdirectory of the managed cache
# root, so a crafted cache path can neither write into the user's workspace nor
# anywhere else in the container. The `*` guarantees it is never the root
# itself: only a per-run directory is ever cleared.
case "$CACHE_DIR" in
  "$CACHE_ROOT"/*) : ;;
  *) fail "bad_request" "缓存目录必须是受管缓存根目录下的子目录" ;;
esac
case "$CACHE_DIR" in
  *..*) fail "bad_request" "缓存目录不能包含 .." ;;
esac
mkdir -p -- "$CACHE_DIR" || fail "cache_error" "无法创建缓存目录"
rm -f -- "$CACHE_DIR"/page-*.png 2>/dev/null || true
rm -f -- "$CACHE_DIR"/source.pdf 2>/dev/null || true

BASE=$(basename -- "$REAL")
EXT=$(printf '%s' "${BASE##*.}" | tr '[:upper:]' '[:lower:]')
[ "$EXT" != "$BASE" ] || EXT=""

PDF_PATH=""
case "$EXT" in
  pdf)
    PDF_PATH="$REAL"
    ;;
  doc|docx|odt|rtf|xls|xlsx|ods|ppt|pptx|odp)
    [ -x "$LO_RUN" ] || fail "missing_tool" "沙箱缺少 LibreOffice 运行脚本"
    TMP_OUT=$(mktemp -d /tmp/aio-lo-out-XXXXXX 2>/dev/null) || fail "temp_error" "无法创建临时目录"
    if ! timeout "$((CONVERT_TIMEOUT + 15))" "$LO_RUN" convert "$REAL" pdf "$TMP_OUT" "$CONVERT_TIMEOUT" >/dev/null 2>&1; then
      rm -rf -- "$TMP_OUT" 2>/dev/null || true
      fail "convert_failed" "转换失败：文件可能已损坏，或包含当前工具不支持的复杂特性"
    fi
    CANDIDATE="$TMP_OUT/${BASE%.*}.pdf"
    if [ ! -s "$CANDIDATE" ]; then
      CANDIDATE=$(find "$TMP_OUT" -maxdepth 1 -name '*.pdf' -type f 2>/dev/null | head -n 1)
    fi
    if [ -z "$CANDIDATE" ] || [ ! -s "$CANDIDATE" ]; then
      rm -rf -- "$TMP_OUT" 2>/dev/null || true
      fail "convert_failed" "转换失败：没有生成 PDF 中间文件"
    fi
    PDF_PATH="$CACHE_DIR/source.pdf"
    if ! cp -- "$CANDIDATE" "$PDF_PATH" 2>/dev/null; then
      rm -rf -- "$TMP_OUT" 2>/dev/null || true
      fail "convert_failed" "转换结果无法写入缓存目录"
    fi
    rm -rf -- "$TMP_OUT" 2>/dev/null || true
    ;;
  *)
    fail "unsupported" "该格式暂不支持在线预览，请直接下载"
    ;;
esac

TOTAL_PAGES=""
if command -v pdfinfo >/dev/null 2>&1; then
  TOTAL_PAGES=$(pdfinfo -- "$PDF_PATH" 2>/dev/null | awk '/^Pages:/ {print $2}' | head -n 1)
fi
case "$TOTAL_PAGES" in ''|*[!0-9]*) TOTAL_PAGES="" ;; esac

command -v pdftoppm >/dev/null 2>&1 || fail "missing_tool" "沙箱缺少 poppler-utils（pdftoppm），无法生成预览"

# -scale-to caps the longest side in pixels, so a huge page cannot allocate an
# unbounded bitmap. No `--` separator: every path is absolute and validated.
if ! timeout "$RENDER_TIMEOUT" pdftoppm -png -scale-to "$MAX_PAGE_PIXELS" -f 1 -l "$MAX_PAGES" \
    "$PDF_PATH" "$CACHE_DIR/page" >/dev/null 2>&1; then
  fail "render_failed" "生成预览图片失败"
fi

# Each entry is three shell words: index, path, bytes. json_emit turns them into
# page objects, so the path is JSON-escaped rather than string-spliced.
PAGES=""
COUNT=0
for f in "$CACHE_DIR"/page-*.png; do
  [ -s "$f" ] || continue
  # Only a real PNG is ever handed to the browser: a truncated/HTML error page
  # saved with a .png name must not be served as an image.
  MAGIC=$(head -c 4 -- "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')
  [ "$MAGIC" = "89504e47" ] || continue
  BYTES=$(stat -c %s -- "$f" 2>/dev/null || echo 0)
  case "$BYTES" in ''|*[!0-9]*) BYTES=0 ;; esac
  # A single page over the per-page budget would defeat the cache bound; skip it
  # rather than serve something the control plane will refuse to store.
  [ "$BYTES" -le "$MAX_PAGE_BYTES" ] || continue
  COUNT=$((COUNT + 1))
  PAGES="$PAGES $COUNT $f $BYTES"
done

if [ "$COUNT" -eq 0 ]; then
  fail "render_failed" "没有生成任何有效预览页（文件可能是空的或已损坏）"
fi

TRUNCATED="false"
if [ -n "$TOTAL_PAGES" ] && [ "$TOTAL_PAGES" -gt "$COUNT" ]; then TRUNCATED="true"; fi

SIZE=$(stat -c %s -- "$REAL" 2>/dev/null || echo 0)
case "$SIZE" in ''|*[!0-9]*) SIZE=0 ;; esac

# Emit through json_emit so page paths (which come from the filesystem) are
# escaped rather than spliced into a template.
# shellcheck disable=SC2086
json_emit "$COUNT" $PAGES pageCount "$COUNT" totalPages "${TOTAL_PAGES:-$COUNT}" truncated "$TRUNCATED" size "$SIZE"

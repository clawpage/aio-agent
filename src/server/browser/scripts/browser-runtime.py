#!/usr/bin/env python3
"""Managed browser runtime for the AIO Agent sandbox.

This helper is written by the control plane into the persistent CODEX_HOME volume
and executed INSIDE the sandbox container. It never modifies the image, never
touches upstream files under /opt/gem, never stops the container, and never
signals a process it cannot attribute exactly.

Subcommands (all print a single JSON object on stdout):
  status    Read-only. Is the browser / its supervisor running, and which
            snapshot does the running browser have applied?
  check     Read-only preflight. Would a snapshot be safe right now?
  snapshot  Capture tabs/order/active/scroll/sessionStorage to a 0600 atomic file.
            Refuses to write anything unless the whole capture succeeded.
  stop      Release Chromium by signalling the verified supervisor, once a
            snapshot that belongs to *that exact* browser process exists.
  wake      Start Chromium exactly as the image's own init does, then restore.
  restore   Restore tabs from an existing snapshot into a running browser.

Process attribution rules (the reason this script exists rather than a shell
one-liner): every process we signal is first verified by PID, by an exact argv
match (interpreter + script path / browser binary + profile argument), by UID,
by parent, and by start time. If any check fails we return an explicit error
instead of guessing, and a PID that was recycled can never be signalled.

Exit behaviour of the upstream helper (stated honestly, because it bounds what
this script can promise): /opt/gem/browser-supervisor.py terminates Chromium on
SIGTERM and, if the child does not exit, escalates to SIGKILL after a grace
period. This script therefore always tries the graceful path first and never
force-kills anything itself, but it cannot promise that no SIGKILL ever happens
inside the upstream helper. A stop that leaves processes alive is reported as a
failure; it is never reported as success.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlsplit

# ---------------------------------------------------------------- constants

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222

HELPER_SCRIPT = "/opt/gem/browser-supervisor.py"
HELPER_PID_FILE = "/var/run/gem/browser-supervisor.pid"
HELPER_CONFIG_FILE = "/var/run/gem/browser-supervisor.json"
HELPER_LOG_FILE = "/var/log/gem/browser-supervisor.log"
BROWSER_PID_FILE = "/var/run/gem/browser.pid"
DEFAULT_PROFILE_DIR = "/home/gem/.config/browser"

# The AIO sandbox API inside the container. `/v1/browser/info` has no active-tab
# field; `/v1/browser/tabs` does, and is authoritative for tab order + focus.
AIO_API_HOST = "127.0.0.1"
AIO_API_PORT = 8080
MCP_PROBE_DEADLINE_S = 15.0
MCP_PROBE_INTERVAL_S = 0.5
AIO_TABS_PATH = "/v1/browser/tabs"

# Chromium leaves `.crdownload` markers next to an in-flight download. Honest
# boundary: only these markers, in these directories, are detected. A download
# that writes elsewhere, streams in memory, or was already fully written but not
# yet handed to the user is NOT detected here.
DEFAULT_DOWNLOAD_DIRS = (
    "/home/gem/Downloads",
    "/home/gem/.config/browser/Default/Downloads",
)

SNAPSHOT_SCHEMA = 2
DEFAULT_SNAPSHOT_PATH = "/home/gem/.codex/tools/aio-browser/browser-snapshot.json"

# The Playwright-backed storage exporter/importer, provisioned next to this
# script. It is the only component that reads/writes cookies + localStorage +
# IndexedDB; this process never serializes those values itself.
STORAGE_HELPER_NAME = "browser-storage.cjs"
# Vendored playwright-core lives beside the helper (commented in README).
STORAGE_VENDOR_NAME = "playwright-core"

# Node interpreters, tried in order. A browser image does not promise a `node`
# on PATH for root, so the absolute candidates come first.
NODE_CANDIDATES = (
    "/opt/nodejs/24/bin/node",
    "/opt/nodejs/22/bin/node",
    "/opt/nodejs/20/bin/node",
    "/usr/local/bin/node20",
    "/usr/local/bin/node",
    "/usr/bin/node",
)

# A page we are willing to re-open. Everything else is reported, never guessed.
RESTORABLE_SCHEMES = ("http", "https")
RESTORABLE_LITERAL = ("about:blank",)
# Chromium's own empty pages. AIO reports `chrome://new-tab-page/` while CDP
# reports `chrome://newtab/` for the *same* default tab, so the two are
# normalised to `about:blank` before any strict tab matching. Without this the
# pairing is unprovable and the release is blocked forever (verified real case).
BLANK_URLS = ("about:blank", "chrome://newtab/", "chrome://new-tab-page/")
CHROME_BLANK_ALIASES = ("chrome://newtab/", "chrome://new-tab-page/", "chrome://newtab", "chrome://new-tab-page")
BLANK_LITERAL = "about:blank"

# Default policy: never drop a page silently.
DEFAULT_DIRTY_INPUT_POLICY = "block"

PROC_ROOT = "/proc"

BROWSER_BIN_NAMES = ("chrome", "chromium", "chromium-browser", "google-chrome", "google-chrome-stable")
HELPER_INTERPRETER_NAMES = ("python3", "python")
# Explicit, non-fatal-looking codes we recognise; anything else is unknown.
# `problems` entries that make a restore fail: they are not warnings, because a
# caller that trusted them would use the wrong page.
BLOCKING_PROBLEMS = (
    "active_activate_failed",
    "aio_reconnect_failed",
    "active_index_out_of_range",
)

SNAPSHOT_WARNING_CODES = (
    "unsupported_scheme",
    "unreachable",
    "dirty_input",
    "download_in_flight",
    "no_tabs",
    "tab_error",
    "tab_order_unverified",
    "active_unknown",
    "storage_unavailable",
)


# ------------------------------------------------------------------ results


def ok(**fields: Any) -> dict[str, Any]:
    return {"ok": True, **fields}


def err(message: str, **fields: Any) -> dict[str, Any]:
    return {"ok": False, "message": message, **fields}


# ------------------------------------------------------------ pure helpers


def normalize_blank_url(url: str) -> str:
    """Map a default-new-tab alias to `about:blank`; leave everything else alone.

    AIO reports `chrome://new-tab-page/` and CDP reports `chrome://newtab/` for the
    same empty default tab (verified live in the acceptance sandbox). Comparing the
    raw strings made the tab pairing permanently unprovable, which blocked every
    release. Only these known-empty aliases are rewritten: any other `chrome://`
    page stays untouched and keeps blocking, and duplicate detection still runs on
    the normalised values.
    """
    if not isinstance(url, str):
        return url
    trimmed = url.strip()
    if trimmed in CHROME_BLANK_ALIASES or trimmed.rstrip("/") in CHROME_BLANK_ALIASES:
        return BLANK_LITERAL
    return url


def classify_url(url: str) -> tuple[bool, str]:
    """Return (restorable, scheme). Never raises; unknown input is not restorable."""
    url = normalize_blank_url(url)
    if not isinstance(url, str) or not url.strip():
        return False, ""
    trimmed = url.strip()
    if trimmed in RESTORABLE_LITERAL:
        return True, trimmed.split(":", 1)[0]
    match = re.match(r"^([A-Za-z][A-Za-z0-9+.\-]*):", trimmed)
    if not match:
        return False, ""
    scheme = match.group(1).lower()
    return scheme in RESTORABLE_SCHEMES, scheme


def redact_urls(text: str) -> str:
    """Strip URLs and long opaque blobs from text that may reach the API.

    Runtime errors can quote a page URL (which may carry a token in its query) or
    a serialized storage value. Every message that leaves this process through a
    JSON result - warnings included - is passed through here first.
    """
    if not isinstance(text, str):
        return str(text)
    cleaned = re.sub(r"[A-Za-z][A-Za-z0-9+.\-]*://[^\s\"'`)]+", "<url>", text)
    cleaned = re.sub(r"[A-Za-z0-9_\-]{40,}", "<redacted>", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:200] if len(cleaned) > 200 else cleaned


def origin_of(url: str) -> str:
    """Origin used to scope sessionStorage injection. "" when not applicable."""
    if not isinstance(url, str):
        return ""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return ""
    if parts.scheme not in RESTORABLE_SCHEMES or not parts.netloc:
        return ""
    return f"{parts.scheme}://{parts.netloc}"


def parse_argv(raw: bytes) -> list[str]:
    """Split a /proc/<pid>/cmdline blob into argv, preserving empty arguments."""
    if not raw:
        return []
    text = raw.decode("utf-8", "replace")
    if text.endswith("\0"):
        text = text[:-1]
    return text.split("\0")


def is_helper_argv(argv: Sequence[str], helper_script: str = HELPER_SCRIPT) -> bool:
    """Exact match for `python3 /opt/gem/browser-supervisor.py`, not a substring."""
    if len(argv) < 2:
        return False
    interpreter = os.path.basename(argv[0])
    if interpreter not in HELPER_INTERPRETER_NAMES:
        return False
    return argv[1] == helper_script


def _strip_quotes(token: str) -> str:
    if len(token) >= 2 and token[0] == token[-1] and token[0] in ("'", '"'):
        return token[1:-1]
    return token


def argv_tokens(argv: Sequence[str]) -> list[str]:
    """Tokenize argv, tolerating a Chromium that flattened its command line.

    Verified in this sandbox on 2026-09-24: `/proc/294/cmdline` splits into a
    *single* NUL-free token holding the entire command line, because Chromium's
    setproctitle overwrote the argv block in place:

        /opt/browser/chrome --user-data-dir=/home/gem/.config/browser \
            --user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWe...

    So an exact argv[1] comparison alone can never recognise the real browser.
    Entries that contain whitespace are re-split; entries without it are kept
    verbatim so the normal (non-flattened) form still works.
    """
    tokens: list[str] = []
    for entry in argv:
        if not entry:
            continue
        if any(ch.isspace() for ch in entry):
            tokens.extend(_strip_quotes(t) for t in re.split(r"\s+", entry) if t)
        else:
            tokens.append(_strip_quotes(entry))
    return tokens


def browser_argv_verdict(
    argv: Sequence[str], profile_dir: str = DEFAULT_PROFILE_DIR
) -> tuple[bool, str]:
    """Classify an argv blob as the profile's browser process. Never substring-trusts.

    Rules, all of which must hold:
      * the first token is an absolute path to a known Chromium binary;
      * `--user-data-dir=<profile_dir>` is present as a *whole* token (or as
        `--user-data-dir` followed by exactly the profile path), so a sibling
        profile such as `/home/gem/.config/browser-old` never matches;
      * the command line is not a helper child (`--type=...`), which would carry
        the same profile flag but is not the process we may release.
    Returns (matched, reason) so callers can report *why* attribution failed
    instead of treating "cannot tell" as "not there".
    """
    tokens = argv_tokens(argv)
    if not tokens:
        return False, "empty_cmdline"
    binary = tokens[0]
    if not os.path.isabs(binary):
        return False, "relative_binary"
    if os.path.basename(binary) not in BROWSER_BIN_NAMES:
        return False, "unknown_binary"
    if any(t.startswith("--type=") for t in tokens):
        # Renderer / GPU / utility child: same profile flag, wrong process.
        return False, "child_process"
    expected = f"--user-data-dir={profile_dir}"
    if expected in tokens:
        return True, "profile_flag"
    for index, token in enumerate(tokens[:-1]):
        if token == "--user-data-dir" and tokens[index + 1] == profile_dir:
            return True, "profile_flag_split"
    return False, "profile_mismatch"


def is_browser_argv(argv: Sequence[str], profile_dir: str = DEFAULT_PROFILE_DIR) -> bool:
    """True only for the profile's own browser process (see `browser_argv_verdict`)."""
    return browser_argv_verdict(argv, profile_dir)[0]


# ---------------------------------------------------------- storage bridge


class StorageError(RuntimeError):
    """A storage export/import failed. Never carries storage contents."""


def find_node() -> str | None:
    for candidate in NODE_CANDIDATES:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    found = shutil.which("node")
    if found and os.access(found, os.X_OK):
        return found
    return None


def storage_helper_paths(helper_dir: str | None = None) -> tuple[str, str]:
    """(helper script, vendored playwright-core dir) inside the managed tool dir."""
    base = helper_dir or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, STORAGE_HELPER_NAME), os.path.join(base, STORAGE_VENDOR_NAME)


def _run_storage_helper(
    argv: Sequence[str], timeout: float, helper_dir: str | None = None
) -> dict[str, Any]:
    """Invoke the node storage helper and parse its single JSON line.

    The helper only ever prints counts and fixed codes, so nothing secret can
    leak through this boundary; a non-zero exit is turned into a fixed message.
    """
    helper, vendor = storage_helper_paths(helper_dir)
    if not os.path.isfile(helper):
        raise StorageError("storage_helper_missing")
    node = find_node()
    if node is None:
        raise StorageError("node_missing")
    if not os.path.isdir(vendor):
        raise StorageError("storage_vendor_missing")
    try:
        completed = subprocess.run(
            [node, helper, *argv, "--vendor", vendor],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise StorageError("storage_timeout") from exc
    except OSError as exc:
        raise StorageError(f"storage_spawn_failed:{type(exc).__name__}") from exc
    text = (completed.stdout or b"").decode("utf-8", "replace").strip()
    line = text.split("\n")[-1] if text else ""
    parsed: Any = None
    if line:
        try:
            parsed = json.loads(line)
        except ValueError:
            parsed = None
    if not isinstance(parsed, dict):
        raise StorageError(f"storage_bad_output_exit_{completed.returncode}")
    if parsed.get("ok") is not True:
        code = parsed.get("code") or "storage_failed"
        raise StorageError(str(code))
    return parsed


def export_storage_state(
    origins: Sequence[str],
    endpoint: str = "http://127.0.0.1:9222",
    timeout: float = 45.0,
    helper_dir: str | None = None,
    temp_dir: str | None = None,
) -> dict[str, Any]:
    """Export cookies + localStorage + IndexedDB for the given origins.

    Returns `{"schema": 1, "capturedAt": ms, "state": {...}, "counts": {...}}`.
    A missing node/helper/vendor is a hard failure: the caller must then refuse
    the release, because a snapshot without storage is not a complete snapshot.
    """
    # An empty origin set is legitimate: a browser parked on about:blank still
    # owns cookies, and refusing here would make it unreleasable forever.
    usable = sorted({origin_of(o) for o in origins} - {""})
    directory = temp_dir or os.path.dirname(os.path.abspath(DEFAULT_SNAPSHOT_PATH))
    os.makedirs(directory, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(mode="w", suffix=".storage.json", dir=directory, delete=False)
    handle.close()
    os.chmod(handle.name, 0o600)
    try:
        argv = ["export", "--endpoint", endpoint, "--out", handle.name]
        for origin in usable:
            argv.extend(["--origin", origin])
        # The helper enforces its own shorter deadline and reports it as a fixed
        # code; the caller keeps a margin so cleanup still runs inside this bound.
        result = _run_storage_helper(argv, timeout, helper_dir)
        try:
            with open(handle.name, encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, ValueError) as exc:
            raise StorageError("storage_read_failed") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("state"), dict):
            raise StorageError("storage_state_malformed")
        return {
            "schema": 1,
            "capturedAt": int(payload.get("capturedAt") or time.time() * 1000),
            "state": payload["state"],
            "counts": {
                "cookies": int(result.get("cookies") or 0),
                "origins": int(result.get("origins") or 0),
                "requestedOrigins": int(result.get("requestedOrigins") or 0),
                "localStorageEntries": int(result.get("localStorageEntries") or 0),
                "indexedDbDatabases": int(result.get("indexedDbDatabases") or 0),
            },
        }
    finally:
        try:
            os.unlink(handle.name)
        except OSError:
            pass


def import_storage_state(
    storage: Mapping[str, Any],
    endpoint: str = "http://127.0.0.1:9222",
    timeout: float = 45.0,
    helper_dir: str | None = None,
    temp_dir: str | None = None,
) -> dict[str, Any]:
    """Apply a captured storage state to the default context *before* navigating.

    Uses a short-lived 0600 file because the state is written by node; it is
    removed even when the import fails.
    """
    state = storage.get("state") if isinstance(storage, Mapping) else None
    if not isinstance(state, dict):
        raise StorageError("storage_state_malformed")
    directory = temp_dir or os.path.dirname(os.path.abspath(DEFAULT_SNAPSHOT_PATH))
    os.makedirs(directory, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(mode="w", suffix=".storage-import.json", dir=directory, delete=False)
    try:
        json.dump({"schema": 1, "state": state}, handle)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.chmod(handle.name, 0o600)
        return _run_storage_helper(
            ["import", "--endpoint", endpoint, "--in", handle.name], timeout, helper_dir
        )
    finally:
        try:
            handle.close()
        except OSError:
            pass
        try:
            os.unlink(handle.name)
        except OSError:
            pass


def snapshot_origin_list(snapshot: Mapping[str, Any]) -> list[str]:
    """Every distinct http(s) origin the snapshot's tabs need storage for."""
    origins: list[str] = []
    for tab in snapshot.get("tabs") or []:
        if not isinstance(tab, Mapping):
            continue
        origin = origin_of(str(tab.get("url") or ""))
        if origin and origin not in origins:
            origins.append(origin)
    return origins


def storage_counts(snapshot: Mapping[str, Any]) -> dict[str, int]:
    """Safe, content-free counts for logs and the API."""
    storage = snapshot.get("storage")
    if not isinstance(storage, Mapping):
        return {"cookies": 0, "origins": 0, "localStorageEntries": 0, "indexedDbDatabases": 0}
    counts = storage.get("counts")
    if isinstance(counts, Mapping):
        return {
            "cookies": int(counts.get("cookies") or 0),
            "origins": int(counts.get("origins") or 0),
            "localStorageEntries": int(counts.get("localStorageEntries") or 0),
            "indexedDbDatabases": int(counts.get("indexedDbDatabases") or 0),
        }
    # Older/foreign snapshots: count from the raw state without echoing values.
    state = storage.get("state") if isinstance(storage.get("state"), Mapping) else {}
    origins = state.get("origins") if isinstance(state.get("origins"), list) else []
    return {
        "cookies": len(state.get("cookies") or []) if isinstance(state.get("cookies"), list) else 0,
        "origins": len(origins),
        "localStorageEntries": sum(
            len(o.get("localStorage") or []) for o in origins if isinstance(o, Mapping)
        ),
        "indexedDbDatabases": sum(len(o.get("indexedDB") or []) for o in origins if isinstance(o, Mapping)),
    }


def snapshot_has_storage(obj: Mapping[str, Any]) -> bool:
    """True when the snapshot carries a usable, complete storage capture."""
    storage = obj.get("storage")
    if not isinstance(storage, Mapping):
        return False
    if storage.get("schema") != 1:
        return False
    return isinstance(storage.get("state"), Mapping)


# Snapshots this build can *read*. Schema 1 predates the storage capture and is
# deliberately still readable so the operator gets an honest message instead of
# "cannot read" - but it never authorises a release (see `stop_browser`).
READABLE_SNAPSHOT_SCHEMAS = (1, SNAPSHOT_SCHEMA)


def validate_snapshot(obj: Any) -> tuple[bool, str]:
    """Validate a decoded snapshot. Returns (ok, error-message)."""
    if not isinstance(obj, dict):
        return False, "快照不是 JSON 对象"
    if obj.get("schema") not in READABLE_SNAPSHOT_SCHEMAS:
        return False, f"快照 schema 不受支持：{obj.get('schema')!r}"
    tabs = obj.get("tabs")
    if not isinstance(tabs, list):
        return False, "快照缺少 tabs 数组"
    for index, tab in enumerate(tabs):
        if not isinstance(tab, dict):
            return False, f"第 {index} 个标签不是对象"
        url = tab.get("url")
        if not isinstance(url, str) or not url:
            return False, f"第 {index} 个标签缺少 url"
        if not isinstance(tab.get("active"), bool):
            return False, f"第 {index} 个标签的 active 不是布尔值"
        scroll = tab.get("scrollY", None)
        if scroll is not None and not isinstance(scroll, (int, float)):
            return False, f"第 {index} 个标签的 scrollY 不是数字"
        storage = tab.get("sessionStorage", None)
        if storage is not None and not isinstance(storage, dict):
            return False, f"第 {index} 个标签的 sessionStorage 不是对象"
    warnings = obj.get("warnings", [])
    if not isinstance(warnings, list):
        return False, "快照的 warnings 不是数组"
    for index, warning in enumerate(warnings):
        if not isinstance(warning, dict):
            return False, f"第 {index} 条 warning 不是对象"
        if warning.get("code") not in SNAPSHOT_WARNING_CODES:
            return False, f"第 {index} 条 warning 的 code 未知：{warning.get('code')!r}"
    if not isinstance(obj.get("orderVerified", False), bool):
        return False, "快照的 orderVerified 不是布尔值"
    source = obj.get("source", None)
    if source is not None and not isinstance(source, dict):
        return False, "快照的 source 不是对象"
    storage = obj.get("storage", None)
    if storage is not None:
        if not isinstance(storage, dict):
            return False, "快照的 storage 不是对象"
        if storage.get("schema") != 1:
            return False, f"快照 storage schema 不受支持：{storage.get('schema')!r}"
        if not isinstance(storage.get("state"), dict):
            return False, "快照 storage 缺少 state 对象"
        state = storage["state"]
        if not isinstance(state.get("cookies"), list):
            return False, "快照 storage state 缺少 cookies 数组"
        if not isinstance(state.get("origins"), list):
            return False, "快照 storage state 缺少 origins 数组"
    return True, ""


def snapshot_source_pids(snapshot: Mapping[str, Any]) -> tuple[int | None, int | None]:
    """(browserPid, browserStarttime) recorded when the snapshot was taken."""
    source = snapshot.get("source") or {}
    pid = source.get("browserPid")
    starttime = source.get("browserStarttime")
    return (
        int(pid) if isinstance(pid, int) else None,
        int(starttime) if isinstance(starttime, int) else None,
    )


def find_in_flight_downloads(
    dirs: Iterable[str] = DEFAULT_DOWNLOAD_DIRS,
    listdir: Any = None,
) -> list[str]:
    """Chrome leaves `.crdownload` files behind while a download is running.

    Bounded to one directory level under each configured path; a listing failure
    is ignored rather than treated as activity. A caller that needs certainty
    should treat a non-empty result as "do not release".

    Coverage boundary: this detects only the `.crdownload` marker, and only in
    the directories passed in. Downloads that target another directory, stream
    without a marker, or have already completed are NOT visible here; the caller
    must pair this with the task/viewer leases, which are the real protection.
    """
    lister = listdir or os.listdir
    found: list[str] = []
    for directory in dirs:
        try:
            entries = lister(directory)
        except OSError:
            continue
        for name in entries:
            if str(name).endswith(".crdownload"):
                found.append(os.path.join(directory, str(name)))
    return found


def dirty_input_probe_expression() -> str:
    """JS that returns a truthy string when a page has unsubmitted user input.

    Unchecked checkboxes/radios and unchanged defaults are not "dirty"; only a
    value the user actually typed counts, so a normal page is never blocked.
    """
    return (
        "(() => {"
        " const skip = new Set(['hidden','submit','button','reset','image','checkbox','radio','file']);"
        " for (const el of document.querySelectorAll('input, textarea, [contenteditable]')) {"
        "   const tag = el.tagName;"
        "   if (tag === 'INPUT') {"
        "     const type = String(el.getAttribute('type') || 'text').toLowerCase();"
        "     if (skip.has(type)) continue;"
        "     const value = String(el.value == null ? '' : el.value);"
        "     const base = String(el.defaultValue == null ? '' : el.defaultValue);"
        "     if (value && value !== base) return 'input';"
        "   } else if (tag === 'TEXTAREA') {"
        "     const value = String(el.value == null ? '' : el.value);"
        "     const base = String(el.defaultValue == null ? '' : el.defaultValue);"
        "     if (value && value !== base) return 'textarea';"
        "   } else if (el.isContentEditable) {"
        "     if (String(el.textContent || '').trim()) return 'contenteditable';"
        "   }"
        " }"
        " return null;"
        "})()"
    )


def scroll_capture_expression() -> str:
    return "(() => Math.max(window.scrollY || 0, document.documentElement.scrollTop || 0))()"


def session_storage_capture_expression() -> str:
    return (
        "(() => { try { const out = {};"
        " for (let i = 0; i < window.sessionStorage.length; i += 1) {"
        "   const key = window.sessionStorage.key(i);"
        "   if (key != null) out[key] = String(window.sessionStorage.getItem(key));"
        " } return out; } catch (e) { return null; } })()"
    )


def ready_state_expression() -> str:
    return "(() => String(document.readyState))()"


def location_origin_expression() -> str:
    return "(() => { try { return String(window.location.origin); } catch (e) { return ''; } })()"


def apply_storage_expression(origin: str, pairs: Mapping[str, str]) -> str:
    """Inject sessionStorage only when the document is still on `origin`.

    A redirect after restore must not receive the previous site's tokens, so the
    origin is re-checked inside the same evaluated script. Existing keys are left
    alone (`skip-present`): the boot-time init script already seeded them, and the
    application may have legitimately advanced them while starting up.
    """
    payload = json.dumps({str(k): str(v) for k, v in pairs.items()}, ensure_ascii=False)
    expected = json.dumps(origin)
    return (
        "(() => { try {"
        f" if (String(window.location.origin) !== {expected}) return 'origin-mismatch';"
        f" const data = {payload};"
        " let wrote = false;"
        " for (const [k, v] of Object.entries(data)) {"
        "   if (window.sessionStorage.getItem(k) === null) {"
        "     window.sessionStorage.setItem(k, v); wrote = true;"
        "   }"
        " }"
        " return wrote ? 'ok' : 'skip-present';"
        " } catch (e) { return 'error'; } })()"
    )


def storage_init_script(origin: str, pairs: Mapping[str, str]) -> str:
    """Source for `Page.addScriptToEvaluateOnNewDocument`, scoped to one origin.

    It runs before the page's own scripts on every new document in the target, so
    an SPA that reads sessionStorage during boot sees the restored values. The
    origin check means a document that lands somewhere else (a redirect) is left
    untouched, and existing keys win so a real navigation is never overwritten.
    """
    payload = json.dumps({str(k): str(v) for k, v in pairs.items()}, ensure_ascii=False)
    expected = json.dumps(origin)
    return (
        "(() => { try {"
        f" if (String(window.location.origin) !== {expected}) return;"
        f" const data = {payload};"
        " for (const [k, v] of Object.entries(data)) {"
        "   if (window.sessionStorage.getItem(k) === null) window.sessionStorage.setItem(k, v);"
        " }"
        " } catch (e) { /* storage may be unavailable on this document; ignore */ } })()"
    )


def apply_scroll_expression(scroll_y: int) -> str:
    return (
        "(() => { try {"
        f" window.scrollTo(0, {int(scroll_y)});"
        " const actual = Math.max(window.scrollY || 0, document.documentElement.scrollTop || 0);"
        " return actual; } catch (e) { return null; } })()"
    )


# --------------------------------------------------------------- /proc view


def read_cmdline_raw(pid: int) -> bytes:
    try:
        with open(f"{PROC_ROOT}/{pid}/cmdline", "rb") as handle:
            return handle.read()
    except OSError:
        return b""


def read_cmdline(pid: int) -> str:
    return " ".join(parse_argv(read_cmdline_raw(pid))).strip()


def read_stat(pid: int) -> tuple[int, str] | None:
    """Return (starttime, state) from /proc/<pid>/stat, or None when unreadable."""
    try:
        with open(f"{PROC_ROOT}/{pid}/stat", encoding="utf-8") as handle:
            data = handle.read()
    except OSError:
        return None
    # The comm field can contain spaces/parentheses; split after the last ')'.
    close = data.rfind(")")
    if close < 0:
        return None
    fields = data[close + 2 :].split()
    if len(fields) < 20:
        return None
    state = fields[0]
    try:
        starttime = int(fields[19])
    except (TypeError, ValueError):
        return None
    return starttime, state


def read_uid(pid: int) -> int | None:
    return read_status_field(pid, "Uid", 0)


def read_ppid(pid: int) -> int | None:
    return read_status_field(pid, "PPid", 0)


def read_status_field(pid: int, field: str, index: int) -> int | None:
    try:
        with open(f"{PROC_ROOT}/{pid}/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(f"{field}:"):
                    return int(line.split()[1 + index])
    except (OSError, ValueError, IndexError):
        return None
    return None


def pid_alive(pid: int) -> bool:
    if pid <= 1:
        return False
    stat = read_stat(pid)
    if stat is None:
        return False
    # A zombie has not exited from the kernel's view but cannot be alive work.
    return stat[1] != "Z"


def read_pid_file(path: str) -> int | None:
    try:
        with open(path, encoding="utf-8") as handle:
            text = handle.read().strip()
    except OSError:
        return None
    if not text.isdigit():
        return None
    try:
        return int(text)
    except ValueError:
        return None


def write_pid_file(path: str, pid: int, mode: int = 0o644) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(f"{pid}\n")
    os.chmod(tmp, mode)
    os.replace(tmp, path)


def remove_pid_file_if_owned(path: str, pid: int) -> bool:
    """Delete a pid file only when it still names `pid`; never another's file."""
    if read_pid_file(path) != pid:
        return False
    try:
        os.unlink(path)
        return True
    except OSError:
        return False


def profile_owner_uid(profile_dir: str = DEFAULT_PROFILE_DIR) -> int | None:
    try:
        return os.stat(profile_dir).st_uid
    except OSError:
        return None


def _current_browser_identity(
    browser_pid_file: str = BROWSER_PID_FILE,
    profile_dir: str = DEFAULT_PROFILE_DIR,
) -> tuple[int | None, int | None]:
    """(pid, starttime) of the attributed browser, or (None, None)."""
    verified = verify_browser(browser_pid_file, profile_dir)
    if not verified.get("ok"):
        return None, None
    return int(verified["pid"]), int(verified["starttime"])


def verify_helper(
    pid_file: str = HELPER_PID_FILE,
    helper_script: str = HELPER_SCRIPT,
    expected_uid: int | None = 0,
) -> dict[str, Any]:
    """Confirm the pid file really points at the image's browser supervisor."""
    pid = read_pid_file(pid_file)
    if pid is None:
        return err("未找到浏览器守护进程的 PID 文件")
    if not pid_alive(pid):
        return err("浏览器守护进程未运行", pid=pid)
    argv = parse_argv(read_cmdline_raw(pid))
    if not is_helper_argv(argv, helper_script):
        return err("PID 文件指向的进程不是 browser-supervisor.py", pid=pid)
    stat = read_stat(pid)
    if stat is None:
        return err("无法读取浏览器守护进程状态", pid=pid)
    uid = read_uid(pid)
    if expected_uid is not None and uid != expected_uid:
        return err(f"浏览器守护进程的 UID 不是预期的 {expected_uid}", pid=pid, uid=uid)
    return ok(pid=pid, starttime=stat[0], uid=uid, cmdline=read_cmdline(pid))


def verify_browser(
    pid_file: str = BROWSER_PID_FILE,
    profile_dir: str = DEFAULT_PROFILE_DIR,
    expected_ppid: int | None = None,
    expected_uid: int | None = None,
) -> dict[str, Any]:
    """Confirm the browser pid file points at Chromium using our profile.

    Every result carries `attribution`:
      * `"owned"`  - exactly the profile's browser process, fully attributed;
      * `"absent"` - the pid file is gone or names a process that is not running;
      * `"unknown"` - something is there but we cannot prove what it is (unreadable
        cmdline, a binary we do not recognise, a profile mismatch).
    `unknown` is deliberately *not* `absent`: a caller that would start a second
    Chromium (or release one) on `absent` must treat `unknown` as fail-closed
    instead of concluding no browser exists. Verified real shape: this sandbox's
    Chromium flattens its command line into one token, and root cannot read
    `/proc/<pid>/exe`, so a naive exact-argv check reports "not the browser"
    while PID 294 is in fact running.
    """
    pid = read_pid_file(pid_file)
    if pid is None:
        return err("未找到浏览器进程的 PID 文件", attribution="absent")
    if not pid_alive(pid):
        return err("浏览器进程未运行", pid=pid, attribution="absent")
    argv = parse_argv(read_cmdline_raw(pid))
    matched, reason = browser_argv_verdict(argv, profile_dir)
    if not matched:
        message = {
            "empty_cmdline": "无法读取浏览器进程的命令行，归属未知",
            "relative_binary": "浏览器进程的可执行路径不是绝对路径，归属未知",
            "unknown_binary": "PID 文件指向的进程不是已知的 Chromium 可执行文件",
            "child_process": "PID 文件指向的是浏览器子进程，不是浏览器主进程",
            "profile_mismatch": "PID 文件指向的进程未使用该 profile",
        }.get(reason, "无法确认浏览器进程归属")
        return err(message, pid=pid, attribution="unknown", reason=reason)
    stat = read_stat(pid)
    if stat is None:
        return err("无法读取浏览器进程状态", pid=pid, attribution="unknown")
    uid = read_uid(pid)
    owner = profile_owner_uid(profile_dir)
    if owner is not None and uid is not None and uid != owner:
        return err("浏览器进程的 UID 与 profile 目录所有者不一致", pid=pid, uid=uid, attribution="unknown")
    if expected_uid is not None and uid != expected_uid:
        return err(f"浏览器进程的 UID 不是预期的 {expected_uid}", pid=pid, uid=uid, attribution="unknown")
    ppid = read_ppid(pid)
    if expected_ppid is not None and ppid != expected_ppid:
        return err("浏览器进程的父进程不是已验证的守护进程", pid=pid, ppid=ppid, attribution="unknown")
    return ok(
        pid=pid,
        starttime=stat[0],
        uid=uid,
        ppid=ppid,
        cmdline=read_cmdline(pid),
        attribution="owned",
        argvReason=reason,
    )


def browser_attribution(
    browser_pid_file: str = BROWSER_PID_FILE,
    profile_dir: str = DEFAULT_PROFILE_DIR,
    expected_ppid: int | None = None,
) -> str:
    """`owned` / `absent` / `unknown` for the pid file, without listing processes."""
    return str(verify_browser(browser_pid_file, profile_dir, expected_ppid).get("attribution") or "unknown")


def find_browsers_for_profile(
    profile_dir: str = DEFAULT_PROFILE_DIR,
    proc_root: str = PROC_ROOT,
) -> list[int]:
    """Any live Chromium using this profile, found without trusting a pid file."""
    found: list[int] = []
    try:
        entries = os.listdir(proc_root)
    except OSError:
        return found
    for name in entries:
        if not name.isdigit():
            continue
        pid = int(name)
        if not pid_alive(pid):
            continue
        if is_browser_argv(parse_argv(read_cmdline_raw(pid)), profile_dir):
            found.append(pid)
    return found


def same_process(pid: int, starttime: int) -> bool:
    """Guard against PID reuse between two reads."""
    stat = read_stat(pid)
    return stat is not None and stat[0] == starttime and stat[1] != "Z"


# ---------------------------------------------------------------- file lock


class LockBusy(RuntimeError):
    pass


class FileLock:
    """Cross-process advisory lock (flock), so two control planes cannot overlap.

    flock is released automatically when the process dies, so a crashed control
    plane can never leave a lock behind that blocks the next one.
    """

    def __init__(self, path: str, shared: bool = False) -> None:
        self.path = path
        # A shared holder proves "no transition owns this browser" without
        # blocking another *reader*; only an exclusive holder (a real transition)
        # makes it fail.
        self.shared = shared
        self._fd: int | None = None

    def acquire(self) -> None:
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        mode = fcntl.LOCK_SH if self.shared else fcntl.LOCK_EX
        try:
            fcntl.flock(fd, mode | fcntl.LOCK_NB)
        except OSError as exc:
            os.close(fd)
            raise LockBusy(f"另一个浏览器生命周期操作正在进行（{exc}）") from exc
        self._fd = fd

    def release(self) -> None:
        if self._fd is None:
            return
        try:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(self._fd)
        self._fd = None

    def __enter__(self) -> "FileLock":
        self.acquire()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()


def lock_path_for(snapshot_path: str) -> str:
    return f"{snapshot_path}.lock"


def restore_state_path_for(snapshot_path: str) -> str:
    return f"{snapshot_path}.restore.json"


# --------------------------------------------------------------------- CDP


class CdpError(RuntimeError):
    pass


class Cdp:
    """Minimal synchronous CDP client over the browser-level WebSocket."""

    def __init__(self, host: str = CDP_HOST, port: int = CDP_PORT, timeout: float = 10.0) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self._ws: Any = None
        self._next_id = 0
        self._events: list[dict[str, Any]] = []

    # -- lifecycle
    def cdp_http(self, path: str, timeout: float | None = None) -> Any:
        import http.client

        conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout or self.timeout)
        try:
            conn.request("GET", path)
            response = conn.getresponse()
            payload = response.read()
            if response.status != 200:
                raise CdpError(f"CDP {path} -> HTTP {response.status}")
            return json.loads(payload.decode("utf-8"))
        except OSError as exc:
            raise CdpError(f"无法连接 CDP：{exc}") from exc
        finally:
            conn.close()

    def version(self) -> dict[str, Any]:
        return self.cdp_http("/json/version")

    def targets(self) -> list[dict[str, Any]]:
        data = self.cdp_http("/json/list")
        if not isinstance(data, list):
            raise CdpError("CDP /json/list 返回了非数组")
        return [t for t in data if isinstance(t, dict)]

    def connect(self, ws_url: str | None = None) -> None:
        from websockets.sync.client import connect as ws_connect

        url = ws_url
        if url is None:
            info = self.version()
            url = info.get("webSocketDebuggerUrl")
        if not isinstance(url, str) or not url:
            raise CdpError("CDP 未提供 webSocketDebuggerUrl")
        try:
            self._ws = ws_connect(url, open_timeout=self.timeout, max_size=64 * 1024 * 1024)
        except Exception as exc:  # noqa: BLE001 - websockets raises several transport types
            # Never echo the URL: it is host-local, but errors must stay secret-free
            # and JSON-serialisable so the control plane can fail closed.
            raise CdpError(f"无法建立 CDP 连接：{type(exc).__name__}") from exc

    def close(self) -> None:
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:  # noqa: BLE001 - closing must never mask a real error
                pass
            self._ws = None

    def __enter__(self) -> "Cdp":
        self.connect()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # -- protocol
    def call(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        if self._ws is None:
            raise CdpError("CDP 尚未连接")
        self._next_id += 1
        message_id = self._next_id
        payload: dict[str, Any] = {"id": message_id, "method": method}
        if params:
            payload["params"] = dict(params)
        if session_id:
            payload["sessionId"] = session_id
        self._ws.send(json.dumps(payload))
        deadline = time.monotonic() + self.timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CdpError(f"CDP {method} 超时")
            try:
                raw = self._ws.recv(timeout=remaining)
            except TimeoutError:
                # Verified in this sandbox: a wedged page (Runtime.enable on a
                # busy renderer) never replies, so this must surface as a
                # structured timeout, never as a raw TimeoutError traceback.
                raise CdpError(f"CDP {method} 超时") from None
            except Exception as exc:  # noqa: BLE001 - closed/broken transport
                raise CdpError(f"CDP {method} 连接中断：{type(exc).__name__}") from exc
            try:
                message = json.loads(raw)
            except (TypeError, ValueError):
                continue
            if not isinstance(message, dict) or message.get("id") != message_id:
                continue
            if "error" in message:
                raise CdpError(f"CDP {method} 失败：{message['error']}")
            result = message.get("result")
            return result if isinstance(result, dict) else {}

    def attach(self, target_id: str) -> str:
        session = self.call("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        session_id = session.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise CdpError("CDP 无法附加到目标标签")
        return session_id

    def evaluate(self, session_id: str, expression: str) -> Any:
        result = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            session_id=session_id,
        )
        if result.get("exceptionDetails"):
            raise CdpError("页面脚本执行失败")
        return (result.get("result") or {}).get("value")


def wait_for_cdp(host: str = CDP_HOST, port: int = CDP_PORT, timeout_s: float = 60.0) -> bool:
    probe = Cdp(host, port, timeout=3.0)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            probe.version()
            return True
        except Exception:  # noqa: BLE001 - probing must never propagate
            time.sleep(0.5)
    return False


def wait_for_ready_state(cdp: Cdp, session_id: str, timeout: float, want: str = "complete") -> bool:
    """Poll document.readyState until it reaches `want` (or a complete-enough state)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            state = cdp.evaluate(session_id, ready_state_expression())
        except CdpError:
            return False
        if state == want:
            return True
        if want == "complete" and state == "interactive":
            # `interactive` still counts as usable for scrolling; give it one more
            # short window to reach complete, then accept it.
            time.sleep(0.2)
            try:
                if cdp.evaluate(session_id, ready_state_expression()) == "complete":
                    return True
            except CdpError:
                return False
            return True
        time.sleep(0.2)
    return False


# ------------------------------------------------------- AIO tabs (ordering)

AIO_TIMEOUT_S = 5.0


def aio_tabs() -> tuple[list[dict[str, Any]] | None, str]:
    """Read the container's own tab list: authoritative order + focused index.

    Verified shape on 2026-09-24: `data` is an array of
    {index,url,title,is_active}. `/v1/browser/info` carries no focus field, so
    focus may only be taken from here - never guessed from CDP ordering.
    """
    import http.client

    conn = http.client.HTTPConnection(AIO_API_HOST, AIO_API_PORT, timeout=AIO_TIMEOUT_S)
    try:
        conn.request("GET", AIO_TABS_PATH)
        response = conn.getresponse()
        payload = response.read()
        if response.status != 200:
            return None, f"AIO tabs 接口返回 HTTP {response.status}"
        parsed = json.loads(payload.decode("utf-8"))
    except (OSError, ValueError) as exc:
        return None, f"无法读取 AIO tabs 接口：{exc}"
    finally:
        conn.close()
    data = parsed.get("data") if isinstance(parsed, dict) else parsed
    if not isinstance(data, list):
        return None, "AIO tabs 接口未返回数组"
    rows: list[dict[str, Any]] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        url = item.get("url")
        if not isinstance(url, str) or not url:
            continue
        index = item.get("index")
        rows.append(
            {
                "url": url,
                "title": str(item.get("title") or ""),
                "index": int(index) if isinstance(index, int) else len(rows),
                "is_active": bool(item.get("is_active")),
            }
        )
    rows.sort(key=lambda row: row["index"])
    return rows, ""


def aio_request(method: str, path: str, body: Mapping[str, Any] | None = None) -> tuple[Any, str]:
    """One small JSON call against the container's own browser API."""
    import http.client

    conn = http.client.HTTPConnection(AIO_API_HOST, AIO_API_PORT, timeout=AIO_TIMEOUT_S)
    encoded = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if encoded is not None else {}
    try:
        conn.request(method, path, body=encoded, headers=headers)
        response = conn.getresponse()
        payload = response.read()
        if response.status >= 400:
            return None, f"AIO {path} 返回 HTTP {response.status}"
        if not payload:
            return {}, ""
        try:
            return json.loads(payload.decode("utf-8")), ""
        except ValueError:
            return None, f"AIO {path} 返回了非 JSON 响应"
    except OSError as exc:
        return None, f"无法访问 AIO 接口：{exc}"
    finally:
        conn.close()


def aio_activate_index(index: int, tab_count: int, reconnect: bool = True) -> tuple[bool, str]:
    """Point the AIO tool API at the tab we just focused natively.

    The AIO API tracks its own active index; if it is not told, later browser tool
    calls address a different page than the one the user sees. Reconnect first
    (`restart` with `mode: soft` only re-attaches its Playwright/CDP client - it
    never restarts the browser), then activate. Returns (ok, problem-code).
    """
    if index < 0 or (tab_count and index >= tab_count):
        return False, "active_index_out_of_range"
    if reconnect:
        _, reconnect_error = aio_request("POST", "/v1/browser/restart", {"mode": "soft"})
        if reconnect_error:
            return False, "aio_reconnect_failed"
    _, activate_error = aio_request("PUT", f"/v1/browser/tabs/{int(index)}/activate")
    if activate_error:
        return False, "active_activate_failed"
    return True, ""


def aio_restored_indices(
    cdp: Cdp, entries: Sequence[Any], *, require_order: bool = True,
    expected_rows: Sequence[Mapping[str, Any]] | None = None,
) -> tuple[list[int] | None, str]:
    """Map restored CDP targets to AIO indices without guessing by URL.

    Chromium may restore its own session or the user may add tabs during recovery.
    Extra tabs must survive, including same-URL ones. Use an ephemeral, random
    non-enumerable window property to prove identity through both clients. It is
    removed in finally and never touches cookies, storage, URL or page content.
    """
    rows, problem = aio_tabs()
    if problem or rows is None:
        return None, "active_activate_failed"
    if expected_rows is not None and rows != list(expected_rows):
        return None, "active_activate_failed"
    key = "__aio_restore_" + uuid.uuid4().hex
    sessions: list[str] = []
    indices: list[int | None] = [None] * len(entries)
    try:
        for position, entry in enumerate(entries):
            if not isinstance(entry, dict) or not isinstance(entry.get("targetId"), str):
                return None, "active_activate_failed"
            session = cdp.attach(entry["targetId"])
            sessions.append(session)
            cdp.evaluate(session, f"Object.defineProperty(globalThis, {json.dumps(key)}, {{value:{position},configurable:true}}); true")
        for row in rows:
            activated, problem = aio_activate_index(row["index"], len(rows), reconnect=False)
            if not activated:
                return None, problem
            result, problem = aio_request("POST", "/v1/browser/page/evaluate", {"expression": f"globalThis[{json.dumps(key)}] ?? null"})
            if problem or not isinstance(result, dict) or result.get("success") is False:
                return None, "active_activate_failed"
            position = result.get("data")
            if type(position) is int and 0 <= position < len(entries):
                if indices[position] is not None:
                    return None, "active_activate_failed"
                indices[position] = row["index"]
        after, problem = aio_tabs()
        if problem or after is None or [(r["index"], r["url"]) for r in after] != [(r["index"], r["url"]) for r in rows]:
            return None, "active_activate_failed"
        if any(index is None for index in indices):
            return None, "active_activate_failed"
        # Extra pages can surround restored pages, but their relative order must
        # still match the snapshot. Never silently claim reordered tabs survived.
        if require_order and indices != sorted(indices):
            return None, "active_activate_failed"
        return indices, ""
    except CdpError:
        return None, "active_activate_failed"
    finally:
        for session in sessions:
            try:
                cdp.evaluate(session, f"delete globalThis[{json.dumps(key)}]")
            except CdpError:
                pass  # A page that closed or navigated already discarded it.
            try:
                cdp.call("Target.detachFromTarget", {"sessionId": session})
            except CdpError:
                pass


def duplicate_capture_plan(
    cdp: Cdp, pages: Sequence[Mapping[str, Any]], rows: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool, str]:
    """Prove duplicate-tab identity, preserving the original AIO focus.

    URL/title/order are not identities. The same ephemeral marker protocol used
    by restore pairs each AIO index with its actual CDP target. No page storage,
    URL or content is modified. Navigation/closure during probing blocks capture.
    """
    active = [r for r in rows if r.get("is_active")]
    if len(active) != 1:
        return [], [], False, "tab_identity_unverified"
    original_index = active[0]["index"]
    result = ([], [], False, "tab_identity_unverified")
    focus_restored = False
    try:
        entries = [{"targetId": p.get("id")} for p in pages]
        indices, problem = aio_restored_indices(cdp, entries, require_order=False, expected_rows=rows)
        if indices is not None and not problem:
            # Target ids and URLs must still describe exactly the captured set.
            current = [p for p in cdp.targets() if p.get("type") == "page"]
            identity = lambda ps: sorted((p.get("id", ""), normalize_blank_url(str(p.get("url") or ""))) for p in ps)
            if identity(current) == identity(pages):
                result = tab_plan(pages, rows, verified_targets={i: p["id"] for i, p in zip(indices, pages)})
    except CdpError:
        pass
    finally:
        # Even failed probes must undo their temporary tab selection. Refuse a
        # snapshot if the index set changed or the original focus cannot return.
        after, problem = aio_tabs()
        shape = lambda rs: [(r["index"], r["url"]) for r in rs]
        if not problem and after is not None and shape(after) == shape(rows):
            focus_restored, _ = aio_activate_index(original_index, len(rows), reconnect=False)
            after, problem = aio_tabs()
            focus_restored = focus_restored and not problem and after is not None and [r["index"] for r in after if r.get("is_active")] == [original_index]
    return result if focus_restored else ([], [], False, "tab_focus_unverified")


def tab_plan(
    cdp_pages: Sequence[Mapping[str, Any]],
    aio_rows: Sequence[Mapping[str, Any]] | None,
    aio_error: str = "",
    verified_targets: Mapping[int, str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], bool, str]:
    """Pair CDP pages with the AIO tab rows, provably, one target per tab.

    Returns (plan, warnings, order_verified, blocked_reason). `blocked_reason` is
    non-empty when the pairing cannot be proven, and the caller must fail the whole
    capture: pairing the wrong target would write one tab's scroll and
    sessionStorage into another, which is silent data loss the user cannot see.

    Rules:
      * order and focus come from the AIO API only - never guessed from CDP;
      * the AIO and CDP URL *multisets* must be equal. A set difference would
        quietly drop or duplicate a page, so a mismatch blocks instead;
      * duplicate URLs require a live, marker-proven target↔row mapping;
      * when the API is unavailable, the plan is built from CDP order with every
        tab marked unfocused and the order flagged unverified - each entry still
        carries its own targetId, so the mapping stays 1:1.
    """
    warnings: list[dict[str, Any]] = []
    if not aio_rows:
        warnings.append(
            {
                "code": "tab_order_unverified",
                "message": f"无法确认标签顺序（{aio_error or 'AIO tabs 接口不可用'}），恢复时将按当前顺序打开且不会自动切换选中标签",
                "tabIndex": None,
            }
        )
        warnings.append(
            {
                "code": "active_unknown",
                "message": "无法确认当前选中标签，恢复后不会自动切换",
                "tabIndex": None,
            }
        )
        plan = [
            {
                "url": normalize_blank_url(str(page.get("url") or "")),
                "title": str(page.get("title") or ""),
                "active": False,
                "targetId": str(page.get("id") or "") or None,
            }
            for page in cdp_pages
        ]
        return plan, warnings, False, ""

    cdp_urls: list[str] = []
    cdp_by_url: dict[str, list[str]] = {}
    for page in cdp_pages:
        # The default-new-tab aliases are normalised *before* matching so AIO's
        # `chrome://new-tab-page/` and CDP's `chrome://newtab/` describe one tab.
        url = normalize_blank_url(str(page.get("url") or ""))
        if not url:
            continue
        target_id = str(page.get("id") or "")
        if not target_id:
            # A page we cannot address cannot be paired; refusing is safer than
            # capturing it twice.
            return [], warnings, False, "cdp_target_missing_id"
        cdp_urls.append(url)
        cdp_by_url.setdefault(url, []).append(target_id)
    aio_urls = [normalize_blank_url(str(row.get("url") or "")) for row in aio_rows]

    def counts(items: Sequence[str]) -> dict[str, int]:
        tally: dict[str, int] = {}
        for item in items:
            tally[item] = tally.get(item, 0) + 1
        return tally

    cdp_counts = counts(cdp_urls)
    aio_counts = counts(aio_urls)
    if cdp_counts != aio_counts:
        return [], warnings, False, "tab_set_mismatch"
    duplicated = [url for url, count in cdp_counts.items() if count > 1]
    if duplicated and verified_targets is None:
        # Two tabs on the same URL: the API cannot say which CDP target is which,
        # so neither scroll nor sessionStorage can be attributed.
        return [], warnings, False, "ambiguous_duplicate_tabs"

    plan = []
    used_targets: set[str] = set()
    for row in aio_rows:
        url = normalize_blank_url(str(row.get("url") or ""))
        target_ids = cdp_by_url.get(url) or []
        if verified_targets is not None:
            proven = verified_targets.get(row["index"])
            target_ids = [proven] if proven in target_ids else []
        if len(target_ids) != 1:
            return [], warnings, False, "tab_target_not_unique"
        if target_ids[0] in used_targets:
            return [], warnings, False, "tab_target_not_unique"
        used_targets.add(target_ids[0])
        plan.append(
            {
                "url": url,
                "title": str(row.get("title") or ""),
                "active": bool(row.get("is_active")),
                "targetId": target_ids[0],
            }
        )
    return plan, warnings, True, ""


# ---------------------------------------------------------------- snapshot


def _capture_one_tab(
    cdp: Cdp,
    cd_target_id: str,
    entry: dict[str, Any],
    policy: str,
) -> dict[str, Any] | None:
    """Fill scroll/sessionStorage/pages for one tab. Returns a blocking problem."""
    try:
        session_id = cdp.attach(cd_target_id)
        cdp.call("Page.enable", {}, session_id=session_id)
        cdp.call("Runtime.enable", {}, session_id=session_id)
        dirty = cdp.evaluate(session_id, dirty_input_probe_expression())
        if dirty:
            warning = {
                "code": "dirty_input",
                "message": f"标签有未提交的输入（{dirty}），已放弃释放以避免丢失",
                "tabIndex": None,
            }
            if policy == "block":
                return {"blocking": True, "warning": warning}
        scroll = cdp.evaluate(session_id, scroll_capture_expression())
        if isinstance(scroll, (int, float)):
            entry["scrollY"] = int(scroll)
        storage = cdp.evaluate(session_id, session_storage_capture_expression())
        if isinstance(storage, dict):
            entry["sessionStorage"] = {str(k): str(v) for k, v in storage.items()}
        # A page that cannot be reloaded as-is is reported, never silently kept.
        origin = origin_of(str(entry.get("url") or ""))
        entry["origin"] = origin
        return None
    except CdpError as exc:
        return {
            "blocking": True,
            "warning": {
                "code": "tab_error",
                "message": redact_urls(f"标签内容无法读取（{exc}），已放弃释放以避免丢页"),
                "tabIndex": None,
            },
        }


def capture_snapshot(
    snapshot_path: str,
    policy: str = DEFAULT_DIRTY_INPUT_POLICY,
    download_dirs: Sequence[str] = DEFAULT_DOWNLOAD_DIRS,
    timeout: float = 30.0,
    profile_dir: str = DEFAULT_PROFILE_DIR,
    browser_pid_file: str = BROWSER_PID_FILE,
) -> dict[str, Any]:
    """Capture tabs in order. Never writes a partial snapshot.

    Any tab that cannot be captured in full (unsupported scheme, unreachable,
    unsubmitted input under the `block` policy, read error) fails the whole
    capture: the existing snapshot on disk is left untouched and the browser is
    never released on top of a lossy capture.
    """
    downloads = find_in_flight_downloads(download_dirs)
    if downloads:
        return err(
            f"检测到未完成的下载（{len(downloads)} 个 .crdownload），保守起见不保存也不释放",
            blocked=True,
            reason="download_in_flight",
        )

    browser = verify_browser(browser_pid_file, profile_dir)

    cdp = Cdp(timeout=timeout)
    try:
        info = cdp.version()
    except CdpError as exc:
        return err(redact_urls(f"无法连接浏览器 CDP：{exc}"), blocked=True)

    try:
        pages = [t for t in cdp.targets() if t.get("type") == "page"]
    except CdpError as exc:
        return err(redact_urls(f"无法读取标签列表：{exc}"), blocked=True)

    if not pages:
        return err(
            "没有可保存的标签页",
            blocked=True,
            warnings=[{"code": "no_tabs", "message": "当前没有标签页", "tabIndex": None}],
        )

    aio_rows, aio_error = aio_tabs()
    plan, warnings, order_verified, blocked_reason = tab_plan(pages, aio_rows, aio_error)
    if blocked_reason == "ambiguous_duplicate_tabs" and aio_rows:
        try:
            cdp.connect()
            plan, warnings, order_verified, blocked_reason = duplicate_capture_plan(cdp, pages, aio_rows)
        except CdpError:
            blocked_reason = "tab_identity_unverified"
        finally:
            cdp.close()
    if blocked_reason:
        # The API and CDP listings disagree, or a URL repeats: the tab↔target
        # pairing is not provable, so no snapshot is written and nothing is stopped.
        explain = {
            "tab_set_mismatch": "AIO 标签列表与浏览器实际标签不一致（数量或多重集不同），无法安全配对",
            "ambiguous_duplicate_tabs": "存在多个相同 URL 的标签，无法区分各自内容，已放弃保存",
            "tab_target_not_unique": "无法为某个标签唯一确定 CDP 目标，已放弃保存",
            "cdp_target_missing_id": "有标签缺少 CDP 目标 id，已放弃保存",
            "tab_identity_unverified": "标签身份核对失败或核对期间页面发生变化，已保留浏览器",
            "tab_focus_unverified": "无法恢复核对前的选中标签，已保留浏览器",
        }.get(blocked_reason, "无法确认标签与 CDP 目标的对应关系")
        return err(
            f"{explain}；已放弃释放浏览器，请整理标签后重试",
            blocked=True,
            reason=blocked_reason,
            warnings=warnings,
        )

    try:
        cdp.connect()
    except CdpError as exc:
        # Fails closed: no snapshot is written and nothing is released.
        return err(redact_urls(f"无法连接浏览器 CDP：{exc}"), blocked=True)
    tabs: list[dict[str, Any]] = []
    try:
        for index, planned in enumerate(plan):
            url = str(planned.get("url") or "")
            restorable, scheme = classify_url(url)
            if not restorable:
                return err(
                    f"第 {index + 1} 个标签使用 {scheme or '未知'} 协议，无法自动恢复；已放弃释放浏览器，请手动处理后重试",
                    blocked=True,
                    reason="unsupported_scheme",
                    warnings=warnings
                    + [
                        {
                            "code": "unsupported_scheme",
                            "message": f"第 {index + 1} 个标签（{scheme or '未知'} 协议）无法自动恢复",
                            "tabIndex": index,
                        }
                    ],
                )
            entry: dict[str, Any] = {
                "index": index,
                "url": url,
                "title": str(planned.get("title") or ""),
                "active": bool(planned.get("active")),
                "scrollY": None,
                "sessionStorage": None,
                "origin": origin_of(url),
            }
            target_id = planned.get("targetId")
            if not isinstance(target_id, str) or not target_id:
                return err(
                    f"第 {index + 1} 个标签无法在 CDP 中定位，已放弃释放浏览器",
                    blocked=True,
                    reason="tab_error",
                    warnings=warnings,
                )
            problem = _capture_one_tab(cdp, target_id, entry, policy)
            if problem is not None:
                warning = problem["warning"]
                warning["tabIndex"] = index
                return err(
                    warning["message"],
                    blocked=True,
                    reason=warning["code"],
                    warnings=warnings + [warning],
                )
            tabs.append(entry)
    finally:
        cdp.close()

    if not tabs:
        return err("所有标签都无法安全保存", blocked=True, warnings=warnings)

    if not any(tab["active"] for tab in tabs) and order_verified and aio_rows:
        # The API listed tabs but none was focused (e.g. the window lost focus).
        # Do not invent one: report it and leave focus alone on restore.
        warnings = warnings + [
            {"code": "active_unknown", "message": "接口未报告选中标签，恢复后不会自动切换", "tabIndex": None}
        ]

    # Cookies + localStorage + IndexedDB. The persistent profile alone is NOT
    # enough (verified live: session cookies and localStorage were lost across a
    # stop), so the state is captured explicitly through the vendored Playwright
    # helper. A missing helper/node/vendor fails the whole capture: releasing on a
    # storage-less snapshot would silently log the user out.
    storage_origins = [origin for origin in (origin_of(str(tab["url"])) for tab in tabs) if origin]
    try:
        storage = export_storage_state(storage_origins, timeout=max(timeout, 45.0))
    except StorageError as exc:
        return err(
            "无法导出浏览器存储（cookies/localStorage/IndexedDB），已放弃释放以避免丢失登录状态",
            blocked=True,
            reason="storage_unavailable",
            detail=str(exc),
            warnings=warnings
            + [
                {
                    "code": "storage_unavailable",
                    "message": "无法导出浏览器存储，已放弃释放以避免丢失登录状态",
                    "tabIndex": None,
                }
            ],
        )

    snapshot: dict[str, Any] = {
        "schema": SNAPSHOT_SCHEMA,
        "savedAt": int(time.time() * 1000),
        "browserVersion": str(info.get("Browser") or "") or None,
        "tabs": tabs,
        "warnings": warnings,
        "skipped": 0,
        "orderVerified": order_verified,
        "storage": storage,
        "source": {
            "browserPid": int(browser["pid"]) if browser["ok"] else None,
            "browserStarttime": int(browser["starttime"]) if browser["ok"] else None,
            "generation": int(time.time() * 1000),
        },
    }
    valid, problem = validate_snapshot(snapshot)
    if not valid:
        return err(f"生成的快照未通过校验：{problem}", blocked=True)
    try:
        write_snapshot(snapshot_path, snapshot)
    except OSError as exc:
        return err(redact_urls(f"写入快照失败：{exc}"), blocked=True)
    return ok(
        savedAt=snapshot["savedAt"],
        tabs=len(tabs),
        skipped=0,
        warnings=warnings,
        orderVerified=order_verified,
        storageCounts=storage_counts(snapshot),
        browserPid=snapshot["source"]["browserPid"],
    )


def write_snapshot(snapshot_path: str, snapshot: Mapping[str, Any]) -> None:
    """Atomic 0600 write; the directory is created if missing."""
    directory = os.path.dirname(snapshot_path) or "."
    os.makedirs(directory, exist_ok=True)
    body = json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=directory, prefix=".snapshot-", delete=False
    )
    try:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.chmod(handle.name, 0o600)
        os.replace(handle.name, snapshot_path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def read_snapshot(snapshot_path: str) -> tuple[dict[str, Any] | None, str]:
    """Read and validate the snapshot. Returns (snapshot, error)."""
    try:
        with open(snapshot_path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return None, "尚未保存过快照"
    except (OSError, ValueError) as exc:
        return None, f"读取快照失败：{exc}"
    valid, problem = validate_snapshot(data)
    if not valid:
        return None, problem
    return data, ""


# --------------------------------------------------------------- stop/wake


def stop_browser(
    snapshot_path: str,
    helper_pid_file: str = HELPER_PID_FILE,
    browser_pid_file: str = BROWSER_PID_FILE,
    timeout_s: float = 30.0,
    profile_dir: str = DEFAULT_PROFILE_DIR,
    helper_script: str = HELPER_SCRIPT,
    source_pid: int | None = None,
    source_starttime: int | None = None,
) -> dict[str, Any]:
    """Release Chromium, but only for the exact process the snapshot belongs to.

    Every check below must pass before anything is signalled:
      1. a valid snapshot exists on disk;
      2. the snapshot names a browser PID *and* start time (a snapshot without a
         complete source can never authorise a stop);
      3. the pid file attributes to Chromium on our profile, and the supervisor
         pid file attributes to the image's own supervisor - both `owned`;
      4. the running browser is the same PID *and* start time the snapshot names,
         and - when the control plane supplied them - the same identity it
         verified before calling;
      5. the parent/child relationship and both start times are re-read
         immediately before the signal.
    The supervisor is then signalled with SIGTERM only. Upstream may escalate to
    SIGKILL internally after its grace period; that behaviour belongs to
    /opt/gem/browser-supervisor.py and is not something this helper can promise
    away. Anything still alive after the timeout is reported as a failure.
    """
    snapshot, problem = read_snapshot(snapshot_path)
    if snapshot is None:
        return err(f"没有可用快照，拒绝停止浏览器：{problem}", blocked=True)

    snapshot_pid, snapshot_start = snapshot_source_pids(snapshot)
    if snapshot_pid is None or snapshot_start is None:
        return err(
            "快照未记录完整的浏览器进程身份（PID/starttime），拒绝停止",
            blocked=True,
            reason="snapshot_source_incomplete",
        )


    helper = verify_helper(helper_pid_file, helper_script)
    if not helper["ok"]:
        # An unverifiable supervisor means we cannot attribute the process tree we
        # are about to signal; "unknown" must fail closed, never be read as absent.
        return err(
            "浏览器守护进程归属未知，拒绝停止",
            blocked=True,
            reason="helper_unattributed",
            helperAttribution="absent" if helper.get("attribution") == "absent" else "unknown",
        )
    browser = verify_browser(browser_pid_file, profile_dir, expected_ppid=int(helper["pid"]))
    if not browser["ok"]:
        return err(
            "浏览器进程归属未知或不是该 profile 的浏览器，拒绝停止",
            blocked=True,
            reason="browser_unattributed",
            browserAttribution=str(browser.get("attribution") or "unknown"),
        )

    browser_pid = int(browser["pid"])
    browser_start = int(browser["starttime"])
    if browser_pid != snapshot_pid:
        return err("快照属于另一个浏览器进程，拒绝停止当前的浏览器", blocked=True)
    if browser_start != snapshot_start:
        return err("浏览器进程已重启（starttime 不匹配），快照不再适用，拒绝停止", blocked=True)
    if source_pid is not None and int(source_pid) != browser_pid:
        return err("控制面核验的 PID 与当前浏览器不一致，拒绝停止", blocked=True)
    if source_starttime is not None and int(source_starttime) != browser_start:
        return err("控制面核验的 starttime 与当前浏览器不一致，拒绝停止", blocked=True)

    # A schema-1 snapshot (or any snapshot without the storage capture) is not a
    # complete snapshot: releasing on it would drop cookies/localStorage/IndexedDB.
    # This is a conservative refusal the operator sees, never a silent data loss.
    if not snapshot_has_storage(snapshot):
        return err(
            "快照不包含 cookies/localStorage/IndexedDB（旧 schema 或存储导出缺失），拒绝停止以免丢失登录状态；请重新保存快照",
            blocked=True,
            reason="snapshot_storage_missing",
            snapshotSchema=snapshot.get("schema"),
        )

    pid = int(helper["pid"])
    starttime = int(helper["starttime"])
    # Re-verify the whole attribution immediately before signalling: a PID recycled
    # (or a restart that raced this call) must never receive the signal.
    if not same_process(pid, starttime):
        return err("浏览器守护进程在发送信号前已发生变化，未执行停止", pid=pid)
    if read_ppid(browser_pid) != pid:
        return err("浏览器进程的父进程已不是已核验的守护进程，未执行停止", pid=browser_pid)
    if read_stat(browser_pid) is None or read_stat(browser_pid)[0] != browser_start:
        return err("浏览器进程在发送信号前已发生变化，未执行停止", pid=browser_pid)

    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError as exc:
        return err(redact_urls(f"发送停止信号失败：{exc}"), pid=pid)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not same_process(pid, starttime):
            break
        time.sleep(0.2)
    else:
        return err("浏览器守护进程在超时内未退出，请人工确认", pid=pid)

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not pid_alive(browser_pid):
            break
        time.sleep(0.2)

    remaining: list[str] = []
    if pid_alive(browser_pid):
        remaining.append(f"browser pid={browser_pid}")
    if same_process(pid, starttime):
        remaining.append(f"supervisor pid={pid}")
    if remaining:
        return err(f"浏览器进程未在超时内退出（{', '.join(remaining)}）")
    # Only remove the pid files that still name the processes we verified.
    remove_pid_file_if_owned(helper_pid_file, pid)
    remove_pid_file_if_owned(browser_pid_file, browser_pid)
    return ok(savedAt=snapshot.get("savedAt"), tabs=len(snapshot.get("tabs") or []))


def start_supervisor(
    helper_script: str = HELPER_SCRIPT,
    helper_config: str = HELPER_CONFIG_FILE,
    helper_pid_file: str = HELPER_PID_FILE,
    helper_log: str = HELPER_LOG_FILE,
    profile_dir: str = DEFAULT_PROFILE_DIR,
) -> dict[str, Any]:
    """Relaunch the image's own supervisor exactly as gem_init.sh does.

    Refuses to start a second supervisor while a Chromium using our profile is
    already running: that would give two owners for one profile. A pid file that
    is stale (invalid or recycled) never blocks a start, and is never deleted on
    behalf of another process.

    The upstream config is required and never fabricated: if it is missing we
    return an explicit error so an operator can restore it.
    """
    existing = verify_helper(helper_pid_file, helper_script)
    if existing["ok"]:
        return ok(pid=existing["pid"], started=False)
    # An *unverifiable* process for this profile must block a start just like a
    # findable one: "cannot tell" is not "nothing is there" (review item 9).
    candidates = find_browsers_for_profile(profile_dir)
    unverified = verify_browser(BROWSER_PID_FILE, profile_dir)
    if unverified.get("attribution") == "unknown" and int(unverified.get("pid") or 0) not in candidates:
        candidates = [int(unverified["pid"]), *candidates]
    if candidates:
        return err(
            f"已有使用该 profile 的浏览器进程（pid={candidates[0]}）但守护进程不可验证，拒绝重复启动",
            blocked=True,
            orphanPids=candidates[:5],
        )
    if not os.path.exists(helper_script):
        return err(f"找不到上游浏览器守护脚本 {helper_script}")
    if not os.path.exists(helper_config):
        return err(f"缺少上游浏览器守护配置 {helper_config}，拒绝自行编造")

    log_dir = os.path.dirname(helper_log)
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)
    with open(helper_log, "ab", buffering=0) as sink:
        process = subprocess.Popen(
            ["/usr/bin/python3", helper_script],
            stdin=subprocess.DEVNULL,
            stdout=sink,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    write_pid_file(helper_pid_file, process.pid)
    return ok(pid=process.pid, started=True)


# --------------------------------------------------------------- restore


def read_restore_state(snapshot_path: str) -> dict[str, Any] | None:
    try:
        with open(restore_state_path_for(snapshot_path), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def write_restore_state(snapshot_path: str, state: Mapping[str, Any]) -> None:
    path = restore_state_path_for(snapshot_path)
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", dir=directory, prefix=".restore-", delete=False
    )
    try:
        handle.write(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
        handle.close()
        os.chmod(handle.name, 0o600)
        os.replace(handle.name, path)
    except BaseException:
        try:
            os.unlink(handle.name)
        except OSError:
            pass
        raise


def clear_restore_state(snapshot_path: str) -> None:
    try:
        os.unlink(restore_state_path_for(snapshot_path))
    except OSError:
        pass


def _page_target_ids(cdp: Cdp) -> set[str]:
    try:
        return {str(t.get("id")) for t in cdp.targets() if t.get("type") == "page" and t.get("id")}
    except CdpError:
        return set()


def _close_startup_pages(cdp: Cdp, startup_ids: set[str], keep_ids: set[str]) -> None:
    """Close only the browser's own startup placeholders.

    The set is captured before anything is created, so a restored tab can never
    be in it. `about:blank` pages created by this restore are deliberately kept.
    """
    for target in cdp.targets():
        target_id = target.get("id")
        if target.get("type") != "page" or not isinstance(target_id, str):
            continue
        if target_id not in startup_ids or target_id in keep_ids:
            continue
        if str(target.get("url") or "") not in BLANK_URLS:
            continue
        try:
            cdp.call("Target.closeTarget", {"targetId": target_id})
        except CdpError:
            # A startup page we could not close is harmless; the restored tabs are
            # the ones that must survive.
            continue


def restore_tabs(
    snapshot: Mapping[str, Any],
    snapshot_path: str = DEFAULT_SNAPSHOT_PATH,
    timeout: float = 60.0,
    load_timeout: float = 20.0,
) -> dict[str, Any]:
    """Re-open the snapshot's tabs, idempotently. Only restorable URLs are created.

    Idempotency: progress lives next to the snapshot, keyed by the snapshot's
    `savedAt` and by per-tab target ids. A retry re-uses the tabs that already
    exist instead of appending a second copy of every page, and a target that has
    gone away is recreated.

    Storage and scroll are applied *after* the page finished loading, sessionStorage
    only when the document is still on the recorded origin (a redirect must not
    receive the previous site's tokens), and every step is verified. Any tab that
    could not be fully restored makes the whole restore fail - the snapshot stays
    on disk so a later retry can finish the job.
    """
    tabs = snapshot.get("tabs") or []
    saved_at = snapshot.get("savedAt")
    cdp = Cdp(timeout=timeout)
    try:
        cdp.connect()
    except CdpError as exc:
        return err(redact_urls(f"无法连接浏览器 CDP：{exc}"))

    state = read_restore_state(snapshot_path)
    if state is None or state.get("snapshotSavedAt") != saved_at:
        state = {"snapshotSavedAt": saved_at, "tabs": [None] * len(tabs)}

    # Storage (cookies/localStorage/IndexedDB) is imported exactly once per
    # (snapshot, browser process) pair, and *before* any tab is created or
    # navigated, so a page's first boot sees the restored values. The marker is
    # bound to the browser's pid+starttime: a retry against the same process must
    # not re-import (which would wipe state the restored pages have since
    # written), while a *new* browser legitimately re-imports.
    identity_pid, identity_start = _current_browser_identity()
    storage = snapshot.get("storage")
    storage_ok = snapshot_has_storage(snapshot)
    already_imported = (
        state.get("storageImported") is True
        and state.get("storageSavedAt") == saved_at
        and state.get("storageBrowserPid") == identity_pid
        and state.get("storageBrowserStarttime") == identity_start
    )
    if storage_ok and not already_imported:
        try:
            import_storage_state(storage, timeout=timeout)
        except StorageError as exc:
            # Fail closed: opening the tabs without their cookies/storage would
            # look like a successful restore while the user is logged out.
            return err(
                "无法导入浏览器存储，恢复未完成；快照已保留以便重试",
                restoredTabs=0,
                failed=[{"index": None, "reason": "storage_import_failed", "detail": str(exc)}],
                problems=["storage_import_failed"],
            )
        state["storageImported"] = True
        state["storageSavedAt"] = saved_at
        state["storageBrowserPid"] = identity_pid
        state["storageBrowserStarttime"] = identity_start
        write_restore_state(snapshot_path, state)

    existing_ids = _page_target_ids(cdp)
    startup_ids = set(existing_ids)
    entries: list[dict[str, Any]] = list(state.get("tabs") or [])
    while len(entries) < len(tabs):
        entries.append(None)

    failed: list[dict[str, Any]] = []
    problems: list[str] = []
    try:
        # Attach AIO before creating restored tabs, so its page-added events
        # preserve creation order. Reconnecting afterwards enumerates CDP targets
        # in an unspecified order and can silently reverse the tool indices.
        if not any(isinstance(entry, dict) and entry.get("targetId") in existing_ids for entry in entries):
            _, reconnect_error = aio_request("POST", "/v1/browser/restart", {"mode": "soft"})
            if reconnect_error:
                return err("无法连接 AIO 浏览器接口，快照已保留", restoredTabs=0)
        # 1. Make sure every snapshot tab has a live target (re-using existing ones).
        for index, tab in enumerate(tabs):
            url = str(tab.get("url") or "")
            restorable, scheme = classify_url(url)
            if not restorable:
                failed.append({"index": index, "reason": "unsupported_scheme", "scheme": scheme or "unknown"})
                continue
            entry = entries[index] if isinstance(entries[index], dict) else None
            target_id = entry.get("targetId") if entry else None
            if not isinstance(target_id, str) or target_id not in existing_ids:
                # Create the tab blank, attach, install the origin-scoped storage
                # init script, *then* navigate. A SPA that reads sessionStorage
                # while it boots must see the values on its very first run; writing
                # them after `load` would be too late and the app would render a
                # logged-out/empty state.
                try:
                    created = cdp.call("Target.createTarget", {"url": "about:blank"})
                except CdpError as exc:
                    failed.append({"index": index, "reason": "create_failed", "detail": redact_urls(str(exc))})
                    continue
                target_id = created.get("targetId")
                if not isinstance(target_id, str) or not target_id:
                    # Never count a tab we cannot address; it is not restored.
                    failed.append({"index": index, "reason": "no_target_id"})
                    continue
                existing_ids.add(target_id)
                entries[index] = {
                    "targetId": target_id,
                    "navigated": False,
                    "scriptId": None,
                    "storageApplied": False,
                    "scrollApplied": False,
                }
                state["tabs"] = entries
                write_restore_state(snapshot_path, state)

        # 2. Navigate + apply storage/scroll onto exactly the tabs we addressed.
        #
        #    Order matters for SPAs that read sessionStorage while booting:
        #      blank target -> attach -> Page.addScriptToEvaluateOnNewDocument
        #      (origin-scoped) -> Page.navigate(target URL) -> wait for load
        #      -> remove the init script -> apply the scroll offset.
        #    The init script is removed once the document is up so a later, normal
        #    navigation is not stomped by the values we restored here.
        for index, tab in enumerate(tabs):
            entry = entries[index] if isinstance(entries[index], dict) else None
            if not entry or not isinstance(entry.get("targetId"), str):
                continue
            target_id = str(entry["targetId"])
            url = str(tab.get("url") or "")
            origin = str(tab.get("origin") or origin_of(url))
            storage = tab.get("sessionStorage")
            if target_id not in _page_target_ids(cdp):
                failed.append({"index": index, "reason": "target_disappeared"})
                continue
            try:
                session_id = cdp.attach(target_id)
                cdp.call("Page.enable", {}, session_id=session_id)
                cdp.call("Runtime.enable", {}, session_id=session_id)
            except CdpError as exc:
                failed.append({"index": index, "reason": "attach_failed", "detail": redact_urls(str(exc))})
                continue
            if not entry.get("navigated"):
                # Install the boot-time storage seed before any application code
                # runs on the target origin.
                if isinstance(storage, dict) and storage and origin:
                    try:
                        installed = cdp.call(
                            "Page.addScriptToEvaluateOnNewDocument",
                            {"source": storage_init_script(origin, storage)},
                            session_id=session_id,
                        )
                    except CdpError as exc:
                        failed.append({"index": index, "reason": "init_script_failed", "detail": redact_urls(str(exc))})
                        continue
                    script_id = installed.get("identifier")
                    entry["scriptId"] = script_id if isinstance(script_id, str) else None
                try:
                    cdp.call("Page.navigate", {"url": url}, session_id=session_id)
                except CdpError as exc:
                    failed.append({"index": index, "reason": "navigate_failed", "detail": redact_urls(str(exc))})
                    continue
                entry["navigated"] = True
                state["tabs"] = entries
                write_restore_state(snapshot_path, state)
            if not wait_for_ready_state(cdp, session_id, load_timeout):
                failed.append({"index": index, "reason": "load_timeout"})
                continue
            if isinstance(entry.get("scriptId"), str):
                # The document is up; drop the seed so future navigations are not
                # overwritten by the restored values.
                try:
                    cdp.call(
                        "Page.removeScriptToEvaluateOnNewDocument",
                        {"identifier": entry["scriptId"]},
                        session_id=session_id,
                    )
                except CdpError as exc:
                    failed.append({"index": index, "reason": "init_script_remove_failed", "detail": redact_urls(str(exc))})
                    continue
                entry["scriptId"] = None
            if not entry.get("storageApplied"):
                if isinstance(storage, dict) and storage and origin:
                    try:
                        applied = cdp.evaluate(session_id, apply_storage_expression(origin, storage))
                    except CdpError as exc:
                        failed.append({"index": index, "reason": "storage_failed", "detail": redact_urls(str(exc))})
                        continue
                    if applied == "origin-mismatch":
                        # The page redirected off-origin. Refusing to write is
                        # correct; say so instead of silently continuing.
                        failed.append({"index": index, "reason": "storage_origin_mismatch"})
                        continue
                    if applied not in ("ok", "skip-present"):
                        failed.append({"index": index, "reason": "storage_failed"})
                        continue
                entry["storageApplied"] = True
            if not entry.get("scrollApplied"):
                scroll = tab.get("scrollY")
                if isinstance(scroll, (int, float)) and scroll > 0:
                    try:
                        actual = cdp.evaluate(session_id, apply_scroll_expression(int(scroll)))
                    except CdpError as exc:
                        failed.append({"index": index, "reason": "scroll_failed", "detail": redact_urls(str(exc))})
                        continue
                    if not isinstance(actual, (int, float)) or abs(float(actual) - float(scroll)) > 8:
                        failed.append({"index": index, "reason": "scroll_unverified"})
                        continue
                entry["scrollApplied"] = True
            state["tabs"] = entries
            write_restore_state(snapshot_path, state)

        # 3. Move AIO off its startup page before closing placeholders. If its
        # selected Playwright page is closed, AIO reconnects on the next request
        # and enumerates CDP targets in an unspecified (often reversed) order.
        # Prove identities while that page is still alive, then select a restored
        # page so closing the placeholder cannot invalidate the AIO session.
        keep = {str(e["targetId"]) for e in entries if isinstance(e, dict) and isinstance(e.get("targetId"), str)}
        before_close, _ = aio_restored_indices(cdp, entries, require_order=False)
        if before_close:
            selected, _ = aio_activate_index(before_close[0], 0, reconnect=False)
            if selected:
                _close_startup_pages(cdp, startup_ids, keep)

        # Prove target identity, preserving extra tabs instead of blocking forever
        # on a full-list URL comparison (duplicates/redirects are not identities).
        restored_indices, index_problem = aio_restored_indices(cdp, entries, require_order=False)
        if restored_indices is None:
            problems.append(index_problem)
        elif restored_indices != sorted(restored_indices):
            # AIO re-enumerates CDP targets on reconnect; its indices are not
            # native Chrome tab order. Identity and focus remain fully verified.
            problems.append("tab_order_unverified")

        # 4. Focus the tab the user had focused, but only when the snapshot could
        #    actually prove which one it was, and only after the AIO API agrees.
        #    The AIO tool pointer is what later MCP/browser calls use, so the
        #    native focus and the API's active index must be the same page.
        active_index = next((i for i, tab in enumerate(tabs) if tab.get("active")), None)
        if active_index is not None:
            entry = entries[active_index] if active_index < len(entries) else None
            target_id = entry.get("targetId") if isinstance(entry, dict) else None
            if restored_indices is not None and isinstance(target_id, str) and target_id in _page_target_ids(cdp):
                try:
                    cdp.call("Target.activateTarget", {"targetId": target_id})
                except CdpError:
                    problems.append("active_activate_failed")
                synced, problem = aio_activate_index(restored_indices[active_index], 0, reconnect=False)
                if not synced:
                    problems.append(problem)
            else:
                problems.append("active_activate_failed")
        else:
            problems.append("active_unknown")

    except CdpError as exc:
        return err(
            redact_urls(f"恢复标签失败：{exc}"), restoredTabs=_restored_count(entries), failed=failed
        )
    finally:
        cdp.close()

    restored = _restored_count(entries)
    # A tab whose focus could not be handed to the AIO API is not a cosmetic
    # problem: later browser tool calls would address a different page than the
    # one the user sees, so the restore is not reported as success.
    focus_failed = [p for p in problems if p in BLOCKING_PROBLEMS]
    if failed or focus_failed:
        # Partial restore is never reported as success, and the snapshot is kept so
        # the next attempt can finish the remaining tabs. The progress record stays
        # too: a retry resumes instead of appending a second copy of every tab.
        state["tabs"] = entries
        state["completed"] = False
        write_restore_state(snapshot_path, state)
        if failed:
            message = f"有 {len(failed)} 个标签未能完整恢复，快照已保留以便重试"
        else:
            message = "标签已重建，但无法把焦点同步给 AIO 接口，快照已保留以便重试"
        return err(message, restoredTabs=restored, failed=failed, problems=problems)
    # Record completion instead of deleting the record: `status` needs it to tell
    # "the running browser has applied this snapshot" from "still pending". The
    # record is bound to the browser process that did the work, so a *different*
    # (later) browser can never inherit a stale "completed".
    identity = _current_browser_identity()
    state["tabs"] = entries
    # Both browser clients must be ready before the snapshot is marked restored.
    # On failure keep the progress record, so retry reuses tabs and storage.
    mcp = reconnect_mcp_browser()
    if not mcp["ok"]:
        state["completed"] = False
        write_restore_state(snapshot_path, state)
        return err(mcp["message"], restoredTabs=restored)
    state["completed"] = True
    state["browserPid"] = identity[0]
    state["browserStarttime"] = identity[1]
    write_restore_state(snapshot_path, state)
    return ok(restoredTabs=restored, orderVerified=bool(snapshot.get("orderVerified", False)) and "tab_order_unverified" not in problems, problems=problems)


def reconnect_mcp_browser() -> dict[str, Any]:
    """Discard the image MCP's stale Puppeteer cache after Chromium recovery.

    REST soft-restart only resets AIO's Playwright connection. The separate
    mcp-server-browser process can return cached pages even after CDP disconnects.
    Its streamable HTTP transport is stateless; restart only this named service,
    then exercise a page-bound tool (tools/list would miss this exact failure).
    Never retry user actions or close the newly restored browser/pages.
    """
    import pwd

    try:
        check = subprocess.run(["supervisorctl", "pid", "mcp-server-browser"],
                               capture_output=True, text=True, timeout=5, check=False)
        pid = int(check.stdout.strip())
        if check.returncode != 0 or pid < 0:
            return err("无法确认浏览器 MCP 服务状态")
        if pid:
            argv = parse_argv(read_cmdline_raw(pid))
            stat = read_stat(pid)
            if (len(argv) < 2 or os.path.basename(argv[0]) != "node"
                    or os.path.realpath(argv[1]) != os.path.realpath("/usr/local/bin/mcp-server-browser")
                    or read_uid(pid) != pwd.getpwnam("gem").pw_uid
                    or stat is None or not same_process(pid, stat[0])):
                return err("浏览器 MCP 进程归属不明，未执行重连")
        result = subprocess.run(["supervisorctl", "restart", "mcp-server-browser"],
                                capture_output=True, text=True, timeout=20, check=False)
        if result.returncode != 0:
            return err("浏览器 MCP 服务重连失败，快照已保留")
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return err("浏览器 MCP 重连或验证超时，快照已保留")
    # `supervisorctl restart` returns once node is spawned, before it listens on
    # 8100; a probe in that window gets AIO's "Client failed to connect". The
    # probe is a read-only tab list, so retrying it until the deadline is safe.
    deadline = time.monotonic() + MCP_PROBE_DEADLINE_S
    while True:
        if _probe_mcp_page_tool():
            return ok()
        if time.monotonic() >= deadline:
            return err("浏览器 MCP 页面连接验证失败，快照已保留")
        time.sleep(MCP_PROBE_INTERVAL_S)


def _probe_mcp_page_tool() -> bool:
    """Exercise a page-bound tool through the same AIO MCP entry used by Codex."""
    import http.client

    try:
        conn = http.client.HTTPConnection(AIO_API_HOST, AIO_API_PORT, timeout=15)
        try:
            conn.request("POST", "/mcp", body=json.dumps({"jsonrpc": "2.0", "id": 1,
                "method": "tools/call", "params": {"name": "browser_tab_list", "arguments": {}}}),
                headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
            response = conn.getresponse()
            raw = response.read().decode("utf-8")
            # AIO can wrap the stateless upstream response in an SSE event.
            if "text/event-stream" in (response.getheader("Content-Type") or ""):
                payload = next(json.loads(line[5:].strip()) for line in raw.splitlines()
                               if line.startswith("data:") and '"id"' in line)
            else:
                payload = json.loads(raw)
            result = payload.get("result") if isinstance(payload, dict) else None
            return not (response.status != 200 or not isinstance(result, dict) or payload.get("error")
                        or result.get("isError") or not result.get("content"))
        finally:
            conn.close()
    except (OSError, ValueError, KeyError, StopIteration, http.client.HTTPException):
        return False


def _restored_count(entries: Sequence[Any]) -> int:
    return sum(
        1
        for entry in entries
        if isinstance(entry, dict) and entry.get("storageApplied") and entry.get("scrollApplied")
    )


def restore_pending(
    snapshot_path: str,
    browser_pid: int | None = None,
    browser_starttime: int | None = None,
) -> bool:
    """True when a *running* browser still has to be (re)built from the snapshot.

    The completion record is bound to the process that finished the restore. A
    snapshot merely existing on disk is never enough: if nothing was stopped, the
    live browser already owns its tabs and reporting "pending" would rebuild -
    and overwrite - pages the user is looking at right now.
    """
    snapshot, _problem = read_snapshot(snapshot_path)
    if snapshot is None:
        return False
    source_pid, source_start = snapshot_source_pids(snapshot)
    state = read_restore_state(snapshot_path)
    fresh = state is not None and state.get("snapshotSavedAt") == snapshot.get("savedAt")

    if fresh and state.get("completed") is True:
        # Only the exact process that finished the restore may reuse that record.
        if browser_pid is not None and state.get("browserPid") != browser_pid:
            return True
        if browser_starttime is not None and state.get("browserStarttime") != browser_starttime:
            return True
        return False

    if fresh:
        # Applying storage/scroll is not enough: order and AIO focus may still
        # have failed. Only an explicit completed record proves recovery.
        return True

    # No progress record at all. Saving a snapshot does not release the browser, so
    # "a snapshot exists" must never by itself mean a restore is owed. The one
    # positive signal available is identity: a snapshot recorded for a *different*
    # process than the one running was never applied to it. That covers the case
    # where the upstream supervisor restarted Chromium on its own - the tabs are
    # gone even though nothing here asked for a stop.
    if browser_pid is None or source_pid is None:
        return False
    if source_pid != browser_pid:
        return True
    if source_start is not None and browser_starttime is not None and source_start != browser_starttime:
        return True
    return False


def wake_browser(
    snapshot_path: str,
    helper_pid_file: str = HELPER_PID_FILE,
    wait_ms: int = 60_000,
    profile_dir: str = DEFAULT_PROFILE_DIR,
    helper_script: str = HELPER_SCRIPT,
    allow_blank: bool = False,
) -> dict[str, Any]:
    """Start Chromium (if needed) and restore the last snapshot into it.

    A browser is never started into a blank state while a snapshot is pending: the
    tabs are rebuilt first, so a caller can use the browser as soon as this
    returns. A snapshot path with nothing to restore only proceeds when the
    operator explicitly asks for it (`--allow-blank`), or when nothing was ever
    saved: no snapshot file and no restore record means the browser was never
    released (e.g. it crashed on a fresh volume), so there is no state to lose.
    An unreadable or invalid snapshot still refuses.
    """
    snapshot, problem = read_snapshot(snapshot_path)
    never_saved = not os.path.exists(snapshot_path) and not os.path.exists(restore_state_path_for(snapshot_path))
    if snapshot is None and not allow_blank and not never_saved:
        return err(f"没有可恢复的快照，拒绝启动空白浏览器：{problem}", blocked=True)

    helper = verify_helper(helper_pid_file, helper_script)
    if not helper["ok"]:
        started = start_supervisor(
            helper_script=helper_script,
            helper_pid_file=helper_pid_file,
            profile_dir=profile_dir,
        )
        if not started["ok"]:
            return started
        helper = verify_helper(helper_pid_file, helper_script)

    if not wait_for_cdp(timeout_s=max(wait_ms, 1000) / 1000.0):
        return err("浏览器启动后未在超时内暴露 CDP")

    if snapshot is None:
        mcp = reconnect_mcp_browser()
        if not mcp["ok"]:
            return mcp
        return ok(restoredTabs=0, message=f"浏览器已启动，无快照可恢复：{problem}")

    restored = restore_tabs(snapshot, snapshot_path=snapshot_path)
    if not restored["ok"]:
        return restored
    return ok(
        restoredTabs=restored.get("restoredTabs", 0),
        orderVerified=restored.get("orderVerified", False),
        problems=restored.get("problems", []),
    )


def preflight(policy: str, download_dirs: Sequence[str] = DEFAULT_DOWNLOAD_DIRS) -> dict[str, Any]:
    """Read-only: would a snapshot be safe right now?

    Checks the `.crdownload` markers in the configured directories (coverage
    boundary documented on `find_in_flight_downloads`), whether any page has
    unsubmitted input, and whether any page is still loading. It does not modify
    the browser and does not write a snapshot.
    """
    downloads = find_in_flight_downloads(download_dirs)
    if downloads:
        return ok(
            safe=False,
            reason="download_in_flight",
            count=len(downloads),
            downloadDirs=list(download_dirs),
            downloadCoverage="partial",
        )
    cdp = Cdp(timeout=10.0)
    try:
        pages = [t for t in cdp.targets() if t.get("type") == "page"]
    except CdpError as exc:
        return err(redact_urls(f"无法连接浏览器 CDP：{exc}"))
    if not pages:
        return ok(safe=False, reason="no_tabs", downloadCoverage="partial")

    unsupported = 0
    dirty = 0
    loading = 0
    unresponsive = 0
    try:
        cdp.connect()
    except CdpError as exc:
        return err(redact_urls(f"无法连接浏览器 CDP：{exc}"))
    try:
        for page in pages:
            url = str(page.get("url") or "")
            if not classify_url(url)[0]:
                unsupported += 1
                continue
            target_id = str(page.get("id") or "")
            if not target_id:
                unsupported += 1
                continue
            try:
                session_id = cdp.attach(target_id)
                cdp.call("Runtime.enable", {}, session_id=session_id)
                if cdp.evaluate(session_id, ready_state_expression()) != "complete":
                    loading += 1
                if cdp.evaluate(session_id, dirty_input_probe_expression()):
                    dirty += 1
            except CdpError:
                # A page we cannot inspect is *unproven*, not "unsupported scheme":
                # reporting the wrong reason would mislead the control plane.
                unresponsive += 1
    finally:
        cdp.close()

    safe = unsupported == 0 and loading == 0 and unresponsive == 0 and (dirty == 0 or policy != "block")
    reason = None
    if not safe:
        if unresponsive:
            reason = "tab_unresponsive"
        elif unsupported:
            reason = "unsupported_scheme"
        elif loading:
            reason = "page_loading"
        else:
            reason = "dirty_input"
    return ok(
        safe=safe,
        reason=reason,
        tabs=len(pages),
        unsupported=unsupported,
        unresponsive=unresponsive,
        dirty=dirty,
        loading=loading,
        policy=policy,
        downloadDirs=list(download_dirs),
        downloadCoverage="partial",
    )


def status(
    snapshot_path: str = DEFAULT_SNAPSHOT_PATH,
    helper_pid_file: str = HELPER_PID_FILE,
    browser_pid_file: str = BROWSER_PID_FILE,
    profile_dir: str = DEFAULT_PROFILE_DIR,
    helper_script: str = HELPER_SCRIPT,
) -> dict[str, Any]:
    """Read-only. Never starts, wakes or extends anything.

    A browser whose ownership cannot be *proved* is reported as
    `browserAttribution: "unknown"` with `browserRunning: null`, never as `false`:
    "cannot tell" must not be read by the control plane as "no browser exists".
    """
    # Read-only probe of the cross-process transition lock. A previous control
    # plane may still be releasing/restoring the browser: a restart must not hand
    # out "running and usable" while another process owns a transition on it.
    # This never waits and never takes the lock.
    transition_busy = False
    try:
        probe = FileLock(lock_path_for(snapshot_path), shared=True)
        probe.acquire()
        probe.release()
    except LockBusy:
        transition_busy = True

    helper = verify_helper(helper_pid_file, helper_script)
    browser = verify_browser(
        browser_pid_file,
        profile_dir,
        expected_ppid=int(helper["pid"]) if helper["ok"] else None,
    )
    attribution = str(browser.get("attribution") or "unknown")
    owned = bool(browser.get("ok"))
    version: str | None = None
    if owned:
        try:
            version = str(Cdp(timeout=5.0).version().get("Browser") or "") or None
        except CdpError:
            version = None
    snapshot, _problem = read_snapshot(snapshot_path)
    snapshot_at = snapshot.get("savedAt") if snapshot else None
    browser_pid = int(browser["pid"]) if owned else None
    browser_starttime = int(browser["starttime"]) if owned else None
    # Only a *proven* running browser can owe a restore, and only when the
    # completion record does not already belong to this exact process.
    pending = bool(
        owned and restore_pending(snapshot_path, browser_pid, browser_starttime)
    )
    restored_snapshot_at = None
    if owned and snapshot is not None and not pending:
        restored_snapshot_at = snapshot_at
    running: bool | None
    if owned:
        running = True
    elif attribution == "absent":
        running = False
    else:
        # Unknown ownership stays unknown so no caller starts a second browser.
        running = None
    return ok(
        browserRunning=running,
        browserAttribution=attribution,
        supervisorRunning=bool(helper["ok"]),
        supervisorAttribution="owned" if helper["ok"] else "absent",
        pid=browser_pid,
        starttime=browser_starttime,
        supervisorPid=int(helper["pid"]) if helper["ok"] else None,
        version=version,
        snapshotAt=snapshot_at,
        restoredSnapshotAt=restored_snapshot_at,
        restorePending=pending,
        snapshotSchema=snapshot.get("schema") if snapshot else None,
        snapshotHasStorage=bool(snapshot is not None and snapshot_has_storage(snapshot)),
        storageCounts=storage_counts(snapshot) if snapshot is not None else None,
        transitionBusy=transition_busy,
        message=None if owned else browser.get("message"),
    )


# --------------------------------------------------------------------- main


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="browser-runtime", description="AIO Agent managed browser runtime")
    parser.add_argument("command", choices=["status", "check", "snapshot", "stop", "wake", "restore"])
    parser.add_argument("--snapshot", default=DEFAULT_SNAPSHOT_PATH, help="snapshot file path")
    parser.add_argument(
        "--policy",
        default=DEFAULT_DIRTY_INPUT_POLICY,
        choices=["block", "warn"],
        help="unsubmitted-input policy (block refuses to release)",
    )
    parser.add_argument("--wait-ms", type=int, default=60_000, help="wake wait budget in milliseconds")
    parser.add_argument("--timeout-s", type=float, default=30.0, help="per-operation timeout in seconds")
    parser.add_argument(
        "--allow-blank",
        action="store_true",
        help="permit starting a browser with no snapshot to restore (explicit opt-in)",
    )
    parser.add_argument("--helper-pid-file", default=HELPER_PID_FILE)
    parser.add_argument("--browser-pid-file", default=BROWSER_PID_FILE)
    parser.add_argument("--profile-dir", default=DEFAULT_PROFILE_DIR)
    parser.add_argument(
        "--source-pid",
        type=int,
        default=None,
        help="browser PID the control plane verified before requesting the stop",
    )
    parser.add_argument(
        "--source-starttime",
        type=int,
        default=None,
        help="browser starttime the control plane verified before requesting the stop",
    )
    return parser


def dispatch(args: argparse.Namespace) -> dict[str, Any]:
    """Run one parsed command. Split out so `main` can guarantee JSON output."""
    if args.command in ("status", "check"):
        # Read-only commands take no lock: an observer must never be blocked by,
        # or block, an in-flight release.
        if args.command == "status":
            result = status(
                snapshot_path=args.snapshot,
                helper_pid_file=args.helper_pid_file,
                browser_pid_file=args.browser_pid_file,
                profile_dir=args.profile_dir,
            )
        else:
            result = preflight(args.policy)
    else:
        try:
            with FileLock(lock_path_for(args.snapshot)):
                if args.command == "snapshot":
                    result = capture_snapshot(
                        args.snapshot,
                        policy=args.policy,
                        timeout=args.timeout_s,
                        profile_dir=args.profile_dir,
                        browser_pid_file=args.browser_pid_file,
                    )
                elif args.command == "stop":
                    result = stop_browser(
                        args.snapshot,
                        helper_pid_file=args.helper_pid_file,
                        browser_pid_file=args.browser_pid_file,
                        timeout_s=args.timeout_s,
                        profile_dir=args.profile_dir,
                        source_pid=args.source_pid,
                        source_starttime=args.source_starttime,
                    )
                elif args.command == "wake":
                    result = wake_browser(
                        args.snapshot,
                        helper_pid_file=args.helper_pid_file,
                        wait_ms=args.wait_ms,
                        profile_dir=args.profile_dir,
                        allow_blank=args.allow_blank,
                    )
                else:  # restore
                    snapshot, problem = read_snapshot(args.snapshot)
                    if snapshot is None:
                        result = err(f"无法读取快照：{problem}", blocked=True)
                    else:
                        result = restore_tabs(snapshot, snapshot_path=args.snapshot, timeout=args.timeout_s)
        except LockBusy as exc:
            result = err(str(exc), blocked=True, reason="locked")
    return result


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = dispatch(args)
    except Exception as exc:  # noqa: BLE001 - a traceback is not an API contract
        # Verified live: an unexpected failure (e.g. a wedged renderer) must still
        # produce one structured, secret-free JSON line with a non-zero exit.
        result = err(f"浏览器运行时内部错误：{type(exc).__name__}", blocked=True)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())

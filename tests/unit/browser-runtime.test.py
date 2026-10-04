#!/usr/bin/env python3
"""Unit tests for the container-side managed browser runtime.

Run with: python3 tests/unit/browser-runtime.test.py

Only pure/synthetic seams are exercised here: process attribution is tested
against fabricated /proc trees, snapshots against a temp directory. Nothing in
this file contacts CDP, the container API, Docker or a real browser.
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
import tempfile
import traceback
from typing import Any, Callable

# Loading the script for tests must not drop a __pycache__ next to the shipped
# helper (the repo does not ignore one), so bytecode caching is off here.
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(REPO, "src", "control", "browser", "scripts", "browser-runtime.py")


def load_module() -> Any:
    spec = importlib.util.spec_from_file_location("browser_runtime", SCRIPT)
    if spec is None or spec.loader is None:  # pragma: no cover - import plumbing
        raise RuntimeError(f"无法加载 {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["browser_runtime"] = module
    spec.loader.exec_module(module)
    return module


rt = load_module()

TESTS: list[tuple[str, Callable[[], None]]] = []


def test(fn: Callable[[], None]) -> Callable[[], None]:
    TESTS.append((fn.__name__, fn))
    return fn


def assert_eq(actual: Any, expected: Any, note: str = "") -> None:
    if actual != expected:
        raise AssertionError(f"{note}: 期望 {expected!r}，实际 {actual!r}")


def assert_true(value: Any, note: str = "") -> None:
    if not value:
        raise AssertionError(f"{note}: 期望真值，实际 {value!r}")


def assert_false(value: Any, note: str = "") -> None:
    if value:
        raise AssertionError(f"{note}: 期望假值，实际 {value!r}")


# ------------------------------------------------------------- argv helpers


@test
def test_helper_argv_must_be_exact() -> None:
    good = ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"]
    assert_true(rt.is_helper_argv(good), "标准 helper argv 应被接受")
    assert_true(rt.is_helper_argv(["python3", "/opt/gem/browser-supervisor.py"]), "PATH 形式也应接受")
    # substring matches must be rejected: these are exactly the cases where a
    # naive "in cmdline" check would signal the wrong process.
    assert_false(
        rt.is_helper_argv(["/bin/sh", "-c", "tail -f /opt/gem/browser-supervisor.py.log"]),
        "路径出现在参数里不算归属",
    )
    assert_false(
        rt.is_helper_argv(["vim", "/opt/gem/browser-supervisor.py"]),
        "用编辑器打开脚本不算归属",
    )
    assert_false(
        rt.is_helper_argv(["/usr/bin/python3", "/opt/gem/browser-supervisor.py.bak"]),
        "同前缀的其它脚本不算归属",
    )
    assert_false(rt.is_helper_argv(["/usr/bin/python3"]), "只有解释器不算归属")
    assert_false(
        rt.is_helper_argv(["/usr/bin/python3", "/tmp/evil-browser-supervisor.py"]),
        "同名但不同路径不算归属",
    )


@test
def test_browser_argv_must_be_exact() -> None:
    good = ["/opt/browser/chrome", "--user-data-dir=/home/gem/.config/browser", "--no-sandbox"]
    assert_true(rt.is_browser_argv(good), "标准 Chromium argv 应被接受")
    assert_false(
        rt.is_browser_argv(["/opt/browser/chrome", "--user-data-dir=/home/gem/.config/browser-other"]),
        "同前缀的另一个 profile 不算归属",
    )
    assert_false(
        rt.is_browser_argv(["/opt/browser/chrome", "--user-data-dir=/home/gem/.config/browser2"]),
        "不同 profile 不算归属",
    )
    assert_false(
        rt.is_browser_argv(["chrome", "--user-data-dir=/home/gem/.config/browser"]),
        "非绝对路径不算归属",
    )
    assert_false(
        rt.is_browser_argv(["/opt/browser/not-chrome", "--user-data-dir=/home/gem/.config/browser"]),
        "非 chrome 二进制不算归属",
    )
    assert_false(
        rt.is_browser_argv(["/bin/grep", "-r", "--user-data-dir=/home/gem/.config/browser", "."]),
        "grep 里出现参数不算归属",
    )
    assert_false(rt.is_browser_argv([]), "空 argv 不算归属")


@test
def test_parse_argv_preserves_boundaries() -> None:
    assert_eq(
        rt.parse_argv(b"/usr/bin/python3\0/opt/gem/browser-supervisor.py\0"),
        ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"],
        "cmdline 解析应保留 argv 边界",
    )
    assert_eq(rt.parse_argv(b""), [], "空 cmdline 解析为空列表")
    # An empty argument is a real argument; it must not shift the indices.
    assert_eq(
        rt.parse_argv(b"/opt/browser/chrome\0\0--flag\0"),
        ["/opt/browser/chrome", "", "--flag"],
        "空参数必须保留位置",
    )


# ------------------------------------------------------- process attribution


class FakeProc:
    """A fabricated /proc tree for the exact-attribution helpers."""

    def __init__(self) -> None:
        self.processes: dict[int, dict[str, Any]] = {}

    def add(
        self,
        pid: int,
        argv: list[str],
        *,
        starttime: int = 100,
        state: str = "S",
        uid: int = 0,
        ppid: int = 1,
    ) -> None:
        self.processes[pid] = {
            "argv": argv,
            "starttime": starttime,
            "state": state,
            "uid": uid,
            "ppid": ppid,
        }

    def cmdline_raw(self, pid: int) -> bytes:
        entry = self.processes.get(pid)
        if entry is None:
            return b""
        return ("\0".join(entry["argv"]) + "\0").encode()

    def stat(self, pid: int) -> tuple[int, str] | None:
        entry = self.processes.get(pid)
        if entry is None:
            return None
        return entry["starttime"], entry["state"]

    def status_field(self, pid: int, field: str, index: int) -> int | None:
        entry = self.processes.get(pid)
        if entry is None:
            return None
        if field == "Uid":
            return entry["uid"] if index == 0 else None
        if field == "PPid":
            return entry["ppid"] if index == 0 else None
        return None


def with_fake_proc(fake: FakeProc) -> Callable[[], None]:
    """Patch /proc readers to the fabricated tree for the duration of a test."""
    saved = (
        rt.read_cmdline_raw,
        rt.read_stat,
        rt.read_status_field,
        rt.pid_alive,
    )
    rt.read_cmdline_raw = fake.cmdline_raw  # type: ignore[assignment]
    rt.read_stat = fake.stat  # type: ignore[assignment]
    rt.read_status_field = fake.status_field  # type: ignore[assignment]
    rt.pid_alive = lambda pid: (  # type: ignore[assignment]
        pid > 1 and fake.stat(pid) is not None and fake.stat(pid) is not None and fake.stat(pid)[1] != "Z"
    )
    return lambda: (
        setattr(rt, "read_cmdline_raw", saved[0]),
        setattr(rt, "read_stat", saved[1]),
        setattr(rt, "read_status_field", saved[2]),
        setattr(rt, "pid_alive", saved[3]),
    )


@test
def test_verify_helper_rejects_unknown_and_recycled_pids() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            pid_file = os.path.join(tmp, "browser-supervisor.pid")

            # (a) missing pid file
            result = rt.verify_helper(pid_file)
            assert_false(result["ok"], "缺少 PID 文件时必须失败")

            # (b) pid file names a process that is NOT the helper
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/other.py"])
            with open(pid_file, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            result = rt.verify_helper(pid_file)
            assert_false(result["ok"], "PID 指向其它进程时必须失败")
            assert_true("browser-supervisor.py" in result["message"], "失败原因应说明脚本不匹配")

            # (c) pid file is stale (process is gone)
            fake.processes.clear()
            result = rt.verify_helper(pid_file)
            assert_false(result["ok"], "PID 已不存在时必须失败")

            # (d) correct process but wrong UID
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=1000)
            result = rt.verify_helper(pid_file, expected_uid=0)
            assert_false(result["ok"], "UID 不符时必须失败")

            # (e) a zombie is not a live helper
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, state="Z")
            result = rt.verify_helper(pid_file)
            assert_false(result["ok"], "僵尸进程不算运行中")

            # (f) the real thing
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=777)
            result = rt.verify_helper(pid_file)
            assert_true(result["ok"], "完全匹配时应通过")
            assert_eq(result["pid"], 4242, "应回传 PID")
            assert_eq(result["starttime"], 777, "应回传 starttime")

            # (g) PID reuse: the recorded starttime no longer matches
            fake.processes[4242]["starttime"] = 778
            assert_false(rt.same_process(4242, 777), "starttime 变化后必须判定为不同进程")
            assert_true(rt.same_process(4242, 778), "starttime 相同才认定为同一进程")
            # A recycled PID switches to a zombie at the same starttime: still not ours.
            fake.processes[4242]["state"] = "Z"
            assert_false(rt.same_process(4242, 778), "僵尸不算同一可用进程")
    finally:
        restore()


@test
def test_verify_browser_checks_parent_and_profile() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            profile = os.path.join(tmp, "browser")
            os.makedirs(profile)
            pid_file = os.path.join(tmp, "browser.pid")
            argv = ["/opt/browser/chrome", f"--user-data-dir={profile}"]
            fake.add(555, argv, uid=os.stat(profile).st_uid, ppid=4242, starttime=9)
            with open(pid_file, "w", encoding="utf-8") as handle:
                handle.write("555\n")

            assert_true(rt.verify_browser(pid_file, profile, expected_ppid=4242)["ok"], "父子关系正确时应通过")
            # The parent changed: this browser no longer belongs to the supervisor
            # we verified, so it must not be adopted.
            assert_false(
                rt.verify_browser(pid_file, profile, expected_ppid=999)["ok"],
                "父进程不匹配时必须失败",
            )
            assert_false(
                rt.verify_browser(pid_file, profile, expected_uid=12345)["ok"],
                "UID 不匹配时必须失败",
            )
            # Wrong profile argument
            fake.add(556, ["/opt/browser/chrome", "--user-data-dir=/tmp/other"], uid=0, ppid=4242)
            with open(pid_file, "w", encoding="utf-8") as handle:
                handle.write("556\n")
            assert_false(rt.verify_browser(pid_file, profile)["ok"], "profile 不匹配时必须失败")
    finally:
        restore()


@test
def test_find_browsers_for_profile_does_not_trust_pid_files() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            profile = os.path.join(tmp, "browser")
            os.makedirs(profile)
            fake.add(11, ["/opt/browser/chrome", f"--user-data-dir={profile}"], uid=1000)
            fake.add(12, ["/opt/browser/chrome", "--user-data-dir=/tmp/other"], uid=1000)
            fake.add(13, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0)
            # The proc root is replaced by the fabricated tree's pid set.
            saved = os.listdir
            os.listdir = lambda _path: [str(pid) for pid in fake.processes]  # type: ignore[assignment]
            try:
                found = rt.find_browsers_for_profile(profile)
            finally:
                os.listdir = saved  # type: ignore[assignment]
            assert_eq(found, [11], "只能发现使用该 profile 的 Chromium")
    finally:
        restore()


@test
def test_remove_pid_file_only_when_owned() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        pid_file = os.path.join(tmp, "browser.pid")
        with open(pid_file, "w", encoding="utf-8") as handle:
            handle.write("777\n")
        # Another process replaced the pid file: ours must be left alone.
        assert_false(rt.remove_pid_file_if_owned(pid_file, 778), "PID 不匹配时不得删除他人 PID 文件")
        assert_true(os.path.exists(pid_file), "他人 PID 文件必须保留")
        assert_true(rt.remove_pid_file_if_owned(pid_file, 777), "PID 匹配时才可删除")
        assert_false(os.path.exists(pid_file), "匹配的 PID 文件应被删除")


# ----------------------------------------------------------- snapshot schema


def base_snapshot() -> dict[str, Any]:
    return {
        "schema": rt.SNAPSHOT_SCHEMA,
        "savedAt": 1_700_000_000_000,
        "browserVersion": "Chrome/140",
        "tabs": [
            {
                "index": 0,
                "url": "https://example.com/a",
                "title": "A",
                "active": False,
                "scrollY": 120,
                "sessionStorage": {"k": "v"},
                "origin": "https://example.com",
            }
        ],
        "warnings": [],
        "skipped": 0,
        "orderVerified": True,
        "source": {"browserPid": 555, "browserStarttime": 9, "generation": 1},
    }


def stoppable_snapshot() -> dict[str, Any]:
    """A schema-2 snapshot that also carries the storage capture.

    `stop_browser` refuses anything without it, so every test that wants to reach
    the process-ownership checks must start from this shape.
    """
    snap = base_snapshot()
    snap["storage"] = {
        "schema": 1,
        "capturedAt": 1,
        "counts": {"cookies": 1, "origins": 1, "localStorageEntries": 1, "indexedDbDatabases": 0},
        "state": {
            "cookies": [{"name": "a", "value": "b", "domain": "example.com", "path": "/"}],
            "origins": [{"origin": "https://example.com", "localStorage": [{"name": "k", "value": "v"}]}],
        },
    }
    return snap


@test
def test_validate_snapshot_accepts_and_rejects() -> None:
    assert_true(rt.validate_snapshot(base_snapshot())[0], "合法快照应通过")

    bad_schema = base_snapshot()
    bad_schema["schema"] = 99
    assert_false(rt.validate_snapshot(bad_schema)[0], "schema 不符必须拒绝")
    # Schema 1 stays readable so the operator gets an honest "storage missing"
    # refusal instead of "cannot read"; it is never released on.
    legacy = base_snapshot()
    legacy["schema"] = 1
    assert_true(rt.validate_snapshot(legacy)[0], "schema 1 仍应可读（用于给出诚实拒绝）")

    missing_tabs = base_snapshot()
    del missing_tabs["tabs"]
    assert_false(rt.validate_snapshot(missing_tabs)[0], "缺少 tabs 必须拒绝")

    no_url = base_snapshot()
    no_url["tabs"][0]["url"] = ""
    assert_false(rt.validate_snapshot(no_url)[0], "标签缺少 URL 必须拒绝")

    bad_active = base_snapshot()
    bad_active["tabs"][0]["active"] = "yes"
    assert_false(rt.validate_snapshot(bad_active)[0], "active 非布尔必须拒绝")

    bad_scroll = base_snapshot()
    bad_scroll["tabs"][0]["scrollY"] = "top"
    assert_false(rt.validate_snapshot(bad_scroll)[0], "scrollY 非数字必须拒绝")

    bad_storage = base_snapshot()
    bad_storage["tabs"][0]["sessionStorage"] = "abc"
    assert_false(rt.validate_snapshot(bad_storage)[0], "sessionStorage 非对象必须拒绝")

    unknown_warning = base_snapshot()
    unknown_warning["warnings"] = [{"code": "made_up", "message": "x", "tabIndex": None}]
    assert_false(rt.validate_snapshot(unknown_warning)[0], "未知 warning code 必须拒绝")

    good_storage = base_snapshot()
    good_storage["storage"] = {"schema": 1, "state": {"cookies": [], "origins": []}}
    assert_true(rt.validate_snapshot(good_storage)[0], "合法 storage 应通过")

    bad_storage_schema = base_snapshot()
    bad_storage_schema["storage"] = {"schema": 9, "state": {"cookies": [], "origins": []}}
    assert_false(rt.validate_snapshot(bad_storage_schema)[0], "storage schema 不符必须拒绝")

    bad_storage_state = base_snapshot()
    bad_storage_state["storage"] = {"schema": 1, "state": {"cookies": []}}
    assert_false(rt.validate_snapshot(bad_storage_state)[0], "storage 缺少 origins 必须拒绝")


@test
def test_snapshot_source_roundtrip() -> None:
    pid, start = rt.snapshot_source_pids(base_snapshot())
    assert_eq((pid, start), (555, 9), "应读出快照绑定的浏览器进程")
    assert_eq(rt.snapshot_source_pids({}), (None, None), "缺少 source 时返回空")
    assert_eq(rt.snapshot_source_pids({"source": {"browserPid": "x"}}), (None, None), "非法类型返回空")


@test
def test_classify_url_and_origin() -> None:
    assert_eq(rt.classify_url("https://a.example/x"), (True, "https"), "https 可恢复")
    assert_eq(rt.classify_url("http://a.example/"), (True, "http"), "http 可恢复")
    assert_eq(rt.classify_url("about:blank"), (True, "about"), "about:blank 可恢复")
    assert_eq(rt.classify_url("chrome://settings"), (False, "chrome"), "chrome:// 不可恢复")
    assert_eq(rt.classify_url("devtools://x"), (False, "devtools"), "devtools:// 不可恢复")
    assert_eq(rt.classify_url("file:///etc/passwd"), (False, "file"), "file:// 不可恢复")
    assert_eq(rt.classify_url(""), (False, ""), "空 URL 不可恢复")
    assert_eq(rt.classify_url(None), (False, ""), "非字符串不可恢复")
    # A javascript: URL is exactly the case where a naive restore would run
    # attacker-controlled code in the restored session.
    assert_eq(rt.classify_url("javascript:alert(1)"), (False, "javascript"), "javascript: 不可恢复")

    assert_eq(rt.origin_of("https://a.example/x?y=1"), "https://a.example", "应提取 origin")
    assert_eq(rt.origin_of("about:blank"), "", "about:blank 无 origin")
    assert_eq(rt.origin_of("nonsense"), "", "无法解析时无 origin")


# -------------------------------------------------------------- tab ordering


@test
def test_tab_plan_uses_aio_order_and_focus() -> None:
    pages = [
        {"id": "t2", "url": "https://second.example/", "type": "page"},
        {"id": "t1", "url": "https://first.example/", "type": "page"},
    ]
    rows = [
        {"index": 0, "url": "https://first.example/", "title": "First", "is_active": False},
        {"index": 1, "url": "https://second.example/", "title": "Second", "is_active": True},
    ]
    plan, warnings, verified, blocked = rt.tab_plan(pages, rows)
    assert_eq(blocked, "", "可证明的配对不应被阻塞")
    assert_true(verified, "AIO 接口可用时顺序应被确认")
    assert_eq([p["url"] for p in plan], ["https://first.example/", "https://second.example/"], "顺序必须来自 AIO")
    assert_eq([p["active"] for p in plan], [False, True], "选中标签必须来自 AIO is_active")
    # The mapping must be provable 1:1, so each entry carries its own target.
    assert_eq([p["targetId"] for p in plan], ["t1", "t2"], "每个标签必须绑定唯一 CDP 目标")
    assert_eq(warnings, [], "顺序可确认时不应有降级 warning")


@test
def test_tab_plan_refuses_to_guess_when_api_is_unavailable() -> None:
    pages = [
        {"id": "t1", "url": "https://a.example/", "type": "page"},
        {"id": "t2", "url": "https://b.example/", "type": "page"},
    ]
    plan, warnings, verified, blocked = rt.tab_plan(pages, None, "连接失败")
    assert_eq(blocked, "", "CDP 顺序仍可给出 1:1 映射，不需要阻塞")
    assert_false(verified, "接口不可用时顺序不可确认")
    assert_eq([p["active"] for p in plan], [False, False], "绝不允许猜测选中标签")
    assert_eq([p["targetId"] for p in plan], ["t1", "t2"], "降级路径同样必须保留 1:1 目标")
    codes = {w["code"] for w in warnings}
    assert_true("tab_order_unverified" in codes, "必须报告顺序不可确认")
    assert_true("active_unknown" in codes, "必须报告选中标签未知")


@test
def test_tab_plan_blocks_when_api_and_cdp_disagree() -> None:
    """A page one side lists and the other does not has no provable pairing."""
    pages = [
        {"id": "t1", "url": "https://a.example/", "type": "page"},
        {"id": "t2", "url": "https://extra.example/", "type": "page"},
    ]
    rows = [{"index": 0, "url": "https://a.example/", "title": "A", "is_active": True}]
    plan, _warnings, verified, blocked = rt.tab_plan(pages, rows)
    assert_false(verified, "集合不一致时不得声称顺序可确认")
    assert_eq(blocked, "tab_set_mismatch", "多重集不一致必须整次阻塞，而不是悄悄去重")
    assert_eq(plan, [], "阻塞时不产生任何计划")


@test
def test_tab_plan_blocks_duplicate_urls() -> None:
    """Two tabs on one URL are indistinguishable through the API."""
    pages = [
        {"id": "t1", "url": "https://same.example/", "type": "page"},
        {"id": "t2", "url": "https://same.example/", "type": "page"},
    ]
    rows = [
        {"index": 0, "url": "https://same.example/", "title": "A", "is_active": False},
        {"index": 1, "url": "https://same.example/", "title": "B", "is_active": True},
    ]
    plan, _warnings, _verified, blocked = rt.tab_plan(pages, rows)
    assert_eq(blocked, "ambiguous_duplicate_tabs", "重复 URL 无法区分内容时必须阻塞")
    assert_eq(plan, [], "绝不把两个标签都映射到第一个 target")


@test
def test_tab_plan_blocks_a_page_without_a_target_id() -> None:
    pages = [{"id": "", "url": "https://a.example/", "type": "page"}]
    rows = [{"index": 0, "url": "https://a.example/", "title": "A", "is_active": True}]
    plan, _warnings, _verified, blocked = rt.tab_plan(pages, rows)
    assert_eq(blocked, "cdp_target_missing_id", "无法寻址的标签不能按 1:1 处理")
    assert_eq(plan, [])


@test
def test_tab_plan_marks_order_unverified_when_api_lists_nothing() -> None:
    plan, warnings, verified, blocked = rt.tab_plan([], [], "")
    assert_eq(blocked, "", "空列表本身不是配对冲突")
    assert_false(verified, "空接管视为不可确认")
    codes = {w["code"] for w in warnings}
    assert_true("tab_order_unverified" in codes, "必须显式降级")


@test
def test_browser_argv_accepts_the_real_flattened_cmdline() -> None:
    """Real /proc/294/cmdline: Chrome flattened its whole command line into one token."""
    real = (
        "/opt/browser/chrome --user-data-dir=/home/gem/.config/browser "
        "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 --no-sandbox"
    )
    assert_true(rt.is_browser_argv([real]), "真实 flattened cmdline 必须被识别为浏览器")
    # A sibling profile whose name only shares a prefix must never match.
    sibling = real.replace(
        "--user-data-dir=/home/gem/.config/browser", "--user-data-dir=/home/gem/.config/browser-old"
    )
    assert_false(rt.is_browser_argv([sibling]), "同前缀的另一个 profile 不算归属")
    # A renderer child carries the same profile flag but is not the browser.
    child = real + " --type=renderer --renderer-client-id=7"
    assert_false(rt.is_browser_argv([child]), "带 --type= 的子进程不算浏览器主进程")
    # A flasked line that merely mentions the flag inside another value is not ours.
    assert_false(
        rt.is_browser_argv(["/opt/browser/chrome --some-arg=--user-data-dir=/home/gem/.config/browser"]),
        "参数值里的 profile 字样不算归属",
    )
    matched, reason = rt.browser_argv_verdict([real])
    assert_true(matched, "判定应为匹配")
    assert_eq(reason, "profile_flag", "应说明匹配依据")


@test
def test_argv_tokens_keeps_normal_argv_intact() -> None:
    tokens = rt.argv_tokens(["/opt/browser/chrome", "--user-data-dir=/home/gem/.config/browser"])
    assert_eq(tokens, ["/opt/browser/chrome", "--user-data-dir=/home/gem/.config/browser"], "常规 argv 不应被改写")
    assert_eq(rt.argv_tokens([]), [], "空 argv 保持为空")


@test
def test_verify_browser_reports_unknown_not_absent() -> None:
    """An unreadable/odd cmdline is `unknown`, never "there is no browser"."""
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            profile = os.path.join(tmp, "browser")
            os.makedirs(profile)
            pid_file = os.path.join(tmp, "browser.pid")

            # (a) no pid file at all -> genuinely absent
            result = rt.verify_browser(pid_file, profile)
            assert_false(result["ok"], "缺少 PID 文件时失败")
            assert_eq(result["attribution"], "absent", "缺少 PID 文件是 absent")

            # (b) pid file present, process gone -> absent
            with open(pid_file, "w", encoding="utf-8") as handle:
                handle.write("777\n")
            result = rt.verify_browser(pid_file, profile)
            assert_eq(result["attribution"], "absent", "进程不存在是 absent")

            # (c) process is there but its cmdline cannot be read -> unknown
            fake.add(777, [], uid=0, ppid=1)
            result = rt.verify_browser(pid_file, profile)
            assert_false(result["ok"], "无法读取命令行时不得认领")
            assert_eq(result["attribution"], "unknown", "无法读取命令行必须报 unknown，而不是不存在")

            # (d) process is a browser for another profile -> unknown
            fake.add(777, ["/opt/browser/chrome", "--user-data-dir=/tmp/other"], uid=0, ppid=1)
            result = rt.verify_browser(pid_file, profile)
            assert_eq(result["attribution"], "unknown", "profile 不符必须报 unknown")

            # (e) the real, flattened shape -> owned
            flattened = f"/opt/browser/chrome --user-data-dir={profile} --no-sandbox"
            fake.add(777, [flattened], uid=os.stat(profile).st_uid, ppid=1, starttime=44)
            result = rt.verify_browser(pid_file, profile)
            assert_true(result["ok"], "真实 flattened 形态应被认领")
            assert_eq(result["attribution"], "owned", "完全归属应为 owned")
            assert_eq(result["starttime"], 44, "应回传 starttime 供控制面比对")
    finally:
        restore()


# ---------------------------------------------------------------- downloads


@test
def test_find_in_flight_downloads_is_bounded_and_honest() -> None:
    def lister(entries: list[str] | Exception) -> Any:
        def inner(_path: str) -> list[str]:
            if isinstance(entries, Exception):
                raise entries
            return entries
        return inner

    found = rt.find_in_flight_downloads(["/dl"], listdir=lister(["a.crdownload", "b.pdf"]))
    assert_eq(found, ["/dl/a.crdownload"], "只识别 .crdownload 标记")
    assert_eq(rt.find_in_flight_downloads(["/dl"], listdir=lister(FileNotFoundError())), [], "目录不可读不当作活动")
    # A completed download is invisible here; the docstring must keep saying so.
    assert_true("crdownload" in (rt.find_in_flight_downloads.__doc__ or ""), "覆盖面边界必须写在文档里")
    assert_true("NOT visible" in (rt.find_in_flight_downloads.__doc__ or ""), "必须声明未覆盖的下载类型")


# ------------------------------------------------------- snapshot writing


@test
def test_write_snapshot_is_atomic_and_0600() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sub", "snapshot.json")
        rt.write_snapshot(path, base_snapshot())
        assert_true(os.path.exists(path), "快照应写入目标路径")
        mode = os.stat(path).st_mode & 0o777
        assert_eq(mode, 0o600, "快照权限必须是 0600")
        with open(path, encoding="utf-8") as handle:
            assert_eq(json.load(handle)["savedAt"], 1_700_000_000_000, "快照内容应可读回")
        # No temp files left behind.
        leftovers = [n for n in os.listdir(os.path.dirname(path)) if n.startswith(".snapshot-")]
        assert_eq(leftovers, [], "原子写入不得留下临时文件")


@test
def test_read_snapshot_reports_missing_and_corrupt() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snapshot.json")
        snapshot, problem = rt.read_snapshot(path)
        assert_true(snapshot is None and "尚未保存" in problem, "缺少快照应给出明确原因")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write("{not json")
        snapshot, problem = rt.read_snapshot(path)
        assert_true(snapshot is None and problem, "损坏快照应给出明确原因")
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"schema": 99}, handle)
        snapshot, problem = rt.read_snapshot(path)
        assert_true(snapshot is None and "schema" in problem, "schema 不符应给出原因")


# ------------------------------------------------------------- stop gating


@test
def test_stop_refuses_without_a_snapshot() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snapshot.json")
        result = rt.stop_browser(path, helper_pid_file=os.path.join(tmp, "h.pid"), browser_pid_file=os.path.join(tmp, "b.pid"))
        assert_false(result["ok"], "没有快照时必须拒绝停止")
        assert_true(result.get("blocked") is True, "拒绝原因应标记为保守阻止")


@test
def test_stop_refuses_when_snapshot_belongs_to_another_browser() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = base_snapshot()
            snapshot["source"]["browserPid"] = 111
            snapshot["source"]["browserStarttime"] = 222
            rt.write_snapshot(path, snapshot)

            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242, starttime=9)

            signals: list[tuple[int, int]] = []
            saved_kill = os.kill
            os.kill = lambda pid, sig: signals.append((pid, sig))  # type: ignore[assignment]
            try:
                result = rt.stop_browser(path, helper_pid_file=helper_pid, browser_pid_file=browser_pid)
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_false(result["ok"], "快照属于别的浏览器时必须拒绝停止")
            assert_eq(signals, [], "拒绝时不得发出任何信号")
            assert_true("另一个浏览器进程" in result["message"], "应说明快照不属于当前浏览器")
    finally:
        restore()


@test
def test_stop_refuses_when_the_browser_is_unattributed() -> None:
    """An unverifiable browser must never be signalled, and never read as absent."""
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = base_snapshot()
            snapshot["source"]["browserPid"] = 555
            snapshot["source"]["browserStarttime"] = 9
            rt.write_snapshot(path, snapshot)
            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            # A process is there, but its command line cannot be read: unknown.
            fake.add(555, [], uid=0, ppid=4242, starttime=9)

            signals: list[tuple[int, int]] = []
            saved_kill = os.kill
            os.kill = lambda pid, sig: signals.append((pid, sig))  # type: ignore[assignment]
            try:
                result = rt.stop_browser(path, helper_pid_file=helper_pid, browser_pid_file=browser_pid)
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_false(result["ok"], "归属未知时必须拒绝停止")
            assert_true(result.get("blocked") is True, "必须标记为保守阻塞")
            assert_eq(result.get("browserAttribution"), "unknown", "必须如实报告未知归属")
            assert_eq(signals, [], "归属未知时绝不能发出信号")
    finally:
        restore()


@test
def test_stop_refuses_without_a_complete_snapshot_source() -> None:
    """A snapshot with no recorded browser PID/starttime can never authorize a stop."""
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = base_snapshot()
            snapshot["source"] = {"browserPid": None, "browserStarttime": None, "generation": 3}
            rt.write_snapshot(path, snapshot)
            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242, starttime=9)

            signals: list[tuple[int, int]] = []
            saved_kill = os.kill
            os.kill = lambda pid, sig: signals.append((pid, sig))  # type: ignore[assignment]
            try:
                result = rt.stop_browser(path, helper_pid_file=helper_pid, browser_pid_file=browser_pid)
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_false(result["ok"], "快照缺少来源身份时必须拒绝")
            assert_eq(result.get("reason"), "snapshot_source_incomplete", "应指明缺少来源身份")
            assert_eq(signals, [], "不得发出信号")
    finally:
        restore()


@test
def test_stop_refuses_when_the_supervisor_is_unverifiable() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = base_snapshot()
            snapshot["source"]["browserPid"] = 555
            snapshot["source"]["browserStarttime"] = 9
            rt.write_snapshot(path, snapshot)
            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            # A pid file that names a *different* script: the supervisor is not ours.
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/other.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242, starttime=9)

            signals: list[tuple[int, int]] = []
            saved_kill = os.kill
            os.kill = lambda pid, sig: signals.append((pid, sig))  # type: ignore[assignment]
            try:
                result = rt.stop_browser(path, helper_pid_file=helper_pid, browser_pid_file=browser_pid)
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_false(result["ok"], "守护进程不可验证时必须拒绝")
            assert_eq(signals, [], "不得发出信号")
    finally:
        restore()


@test
def test_stop_refuses_when_the_control_plane_identity_disagrees() -> None:
    """The identity the control plane verified must match what we see now."""
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = base_snapshot()
            snapshot["source"]["browserPid"] = 555
            snapshot["source"]["browserStarttime"] = 9
            rt.write_snapshot(path, snapshot)
            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242, starttime=9)

            signals: list[tuple[int, int]] = []
            saved_kill = os.kill
            os.kill = lambda pid, sig: signals.append((pid, sig))  # type: ignore[assignment]
            try:
                stale = rt.stop_browser(
                    path, helper_pid_file=helper_pid, browser_pid_file=browser_pid, source_pid=999
                )
                stale_start = rt.stop_browser(
                    path, helper_pid_file=helper_pid, browser_pid_file=browser_pid, source_starttime=1234
                )
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_false(stale["ok"], "PID 不一致时必须拒绝")
            assert_false(stale_start["ok"], "starttime 不一致时必须拒绝")
            assert_eq(signals, [], "不得发出信号")
    finally:
        restore()


@test
def test_stop_reverifies_starttime_before_signalling() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = base_snapshot()
            snapshot["source"]["browserPid"] = 555
            snapshot["source"]["browserStarttime"] = 9
            rt.write_snapshot(path, snapshot)

            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242)

            # The browser restarted between the snapshot and the stop: its
            # starttime no longer matches, so the stale snapshot must not authorize
            # releasing it.
            fake.processes[555]["starttime"] = 10
            signals: list[tuple[int, int]] = []
            saved_kill = os.kill
            os.kill = lambda pid, sig: signals.append((pid, sig))  # type: ignore[assignment]
            try:
                result = rt.stop_browser(path, helper_pid_file=helper_pid, browser_pid_file=browser_pid)
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_false(result["ok"], "starttime 不符时必须拒绝停止")
            assert_eq(signals, [], "拒绝时不得发出任何信号")
    finally:
        restore()


@test
def test_stop_signals_only_sigterm_and_removes_owned_pid_files() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = stoppable_snapshot()
            snapshot["source"]["browserPid"] = 555
            snapshot["source"]["browserStarttime"] = 9
            rt.write_snapshot(path, snapshot)

            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242, starttime=9)

            signals: list[tuple[int, int]] = []
            saved_kill = os.kill
            os.kill = lambda pid, sig: (signals.append((pid, sig)), fake.processes.clear())  # type: ignore[assignment]
            try:
                result = rt.stop_browser(
                    path, helper_pid_file=helper_pid, browser_pid_file=browser_pid, timeout_s=0.3
                )
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_true(result["ok"], f"成功停止应返回 ok，实际 {result}")
            assert_eq(signals, [(4242, 15)], "只允许对已验证的守护进程发送 SIGTERM")
            assert_false(os.path.exists(helper_pid), "已确认退出的守护进程 PID 文件应被清理")
            assert_false(os.path.exists(browser_pid), "已确认退出的浏览器 PID 文件应被清理")
    finally:
        restore()


@test
def test_stop_reports_failure_when_processes_survive() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = stoppable_snapshot()
            snapshot["source"]["browserPid"] = 555
            snapshot["source"]["browserStarttime"] = 9
            rt.write_snapshot(path, snapshot)
            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242, starttime=9)

            saved_kill = os.kill
            os.kill = lambda pid, sig: None  # type: ignore[assignment]  # nothing ever exits
            try:
                result = rt.stop_browser(
                    path, helper_pid_file=helper_pid, browser_pid_file=browser_pid, timeout_s=0.3
                )
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_false(result["ok"], "进程未退出时绝不能声称成功")
            assert_true(
                "未在超时内退出" in result["message"] or "请人工确认" in result["message"],
                f"应如实报告未退出，实际 {result['message']!r}",
            )
            # It must never claim the browser is gone, and the evidence stays.
            assert_false(result.get("stopped") is True, "未退出时不得报告已停止")
            # Failure must not damage the evidence: pid files stay, snapshot stays.
            assert_true(os.path.exists(path), "失败时快照必须保留")
            assert_true(os.path.exists(helper_pid), "失败时不得删除 PID 文件")
    finally:
        restore()


@test
def test_stop_does_not_delete_pid_file_of_another_process() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            snapshot = stoppable_snapshot()
            snapshot["source"]["browserPid"] = 555
            snapshot["source"]["browserStarttime"] = 9
            rt.write_snapshot(path, snapshot)
            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242, starttime=9)

            def kill_and_replace(pid: int, sig: int) -> None:
                fake.processes.clear()
                # Another control plane started a new supervisor meanwhile.
                with open(helper_pid, "w", encoding="utf-8") as handle:
                    handle.write("9001\n")

            saved_kill = os.kill
            os.kill = kill_and_replace  # type: ignore[assignment]
            try:
                rt.stop_browser(path, helper_pid_file=helper_pid, browser_pid_file=browser_pid, timeout_s=0.3)
            finally:
                os.kill = saved_kill  # type: ignore[assignment]
            assert_true(os.path.exists(helper_pid), "不得删除另一个进程的 PID 文件")
            with open(helper_pid, encoding="utf-8") as handle:
                assert_eq(handle.read().strip(), "9001", "PID 文件内容必须是新进程的")
    finally:
        restore()


@test
def test_start_refuses_when_an_orphan_browser_already_runs() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            profile = os.path.join(tmp, "browser")
            os.makedirs(profile)
            helper_pid = os.path.join(tmp, "h.pid")
            config = os.path.join(tmp, "browser-supervisor.json")
            with open(config, "w", encoding="utf-8") as handle:
                handle.write("{}")
            # A Chromium for our profile is up, but no verifiable supervisor.
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={profile}"], uid=1000)
            saved_listdir = os.listdir
            os.listdir = lambda _path: [str(pid) for pid in fake.processes]  # type: ignore[assignment]
            saved_popen = rt.subprocess.Popen

            def boom(*_args: Any, **_kwargs: Any) -> Any:
                raise AssertionError("不得在已有同 profile 浏览器时启动第二个守护进程")

            rt.subprocess.Popen = boom  # type: ignore[assignment]
            try:
                result = rt.start_supervisor(
                    helper_script=config,
                    helper_config=config,
                    helper_pid_file=helper_pid,
                    helper_log=os.path.join(tmp, "log"),
                    profile_dir=profile,
                )
            finally:
                rt.subprocess.Popen = saved_popen  # type: ignore[assignment]
                os.listdir = saved_listdir  # type: ignore[assignment]
            assert_false(result["ok"], "已有孤儿浏览器时必须拒绝重复启动")
            assert_true(result.get("blocked") is True, "拒绝原因应标记为保守阻止")
            assert_true(555 in result.get("orphanPids", []), "应报告孤儿浏览器 PID")
    finally:
        restore()


@test
def test_start_refuses_without_upstream_config() -> None:
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            helper_pid = os.path.join(tmp, "h.pid")
            script = os.path.join(tmp, "browser-supervisor.py")
            with open(script, "w", encoding="utf-8") as handle:
                handle.write("# stub\n")
            saved_listdir = os.listdir
            os.listdir = lambda _path: []  # type: ignore[assignment]
            try:
                result = rt.start_supervisor(
                    helper_script=script,
                    helper_config=os.path.join(tmp, "missing.json"),
                    helper_pid_file=helper_pid,
                    helper_log=os.path.join(tmp, "log"),
                )
            finally:
                os.listdir = saved_listdir  # type: ignore[assignment]
            assert_false(result["ok"], "缺少上游配置时必须拒绝启动")
            assert_true("拒绝自行编造" in result["message"], "不得自行编造上游配置")
    finally:
        restore()


# -------------------------------------------------------- restore idempotency


@test
def test_restore_state_is_scoped_to_the_snapshot() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snapshot.json")
        assert_true(rt.read_restore_state(path) is None, "无进度记录时返回 None")
        rt.write_restore_state(path, {"snapshotSavedAt": 1, "tabs": [], "completed": False})
        state = rt.read_restore_state(path)
        assert_eq(state["snapshotSavedAt"], 1, "进度记录应可读回")
        mode = os.stat(rt.restore_state_path_for(path)).st_mode & 0o777
        assert_eq(mode, 0o600, "进度记录权限必须是 0600")


@test
def test_restore_pending_detects_unfinished_and_finished_states() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snapshot.json")
        snapshot = base_snapshot()
        rt.write_snapshot(path, snapshot)
        # A snapshot the *running* browser saved is not an owed restore: nothing was
        # released, so its tabs are already the live ones (review item 1).
        assert_false(rt.restore_pending(path, 555, 9), "同一进程保存的快照不构成待恢复")
        # A snapshot recorded for another process was never applied to this one.
        assert_true(rt.restore_pending(path, 556, 9), "另一个进程的快照视为待恢复")
        rt.write_restore_state(
            path,
            {
                "snapshotSavedAt": snapshot["savedAt"],
                "tabs": [{"targetId": "t1", "storageApplied": False, "scrollApplied": False}],
                "completed": False,
            },
        )
        assert_true(rt.restore_pending(path, 555, 9), "有未完成标签时仍视为待恢复")
        rt.write_restore_state(
            path,
            {
                "snapshotSavedAt": snapshot["savedAt"],
                "tabs": [{"targetId": "t1", "storageApplied": True, "scrollApplied": True}],
                "completed": True,
                "browserPid": 555,
                "browserStarttime": 9,
            },
        )
        assert_false(rt.restore_pending(path, 555, 9), "标记完成后不再视为待恢复")
        # A newer snapshot taken by the same running browser is still not owed.
        newer = base_snapshot()
        newer["savedAt"] = snapshot["savedAt"] + 1
        rt.write_snapshot(path, newer)
        assert_false(rt.restore_pending(path, 555, 9), "同一进程的新快照仍不构成待恢复")


@test
def test_restore_pending_is_bound_to_the_process_that_completed_it() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snapshot.json")
        rt.write_snapshot(path, base_snapshot())
        # A snapshot that was only *saved* - no stop, no restore - is never pending.
        assert_false(
            rt.restore_pending(path, browser_pid=555, browser_starttime=9),
            "只保存了快照不等于有待恢复（Chrome 仍原样运行）",
        )
        # A completion record from browser 555 must not be inherited by a new one.
        state = {"snapshotSavedAt": base_snapshot()["savedAt"], "tabs": [], "completed": True,
                 "browserPid": 555, "browserStarttime": 9}
        rt.write_restore_state(path, state)
        assert_false(rt.restore_pending(path, 555, 9), "同一进程完成后不再待恢复")
        assert_true(rt.restore_pending(path, 556, 9), "新 PID 不得沿用旧的完成记录")
        assert_true(rt.restore_pending(path, 555, 10), "同 PID 但重启过（starttime 变）同样不得沿用")


@test
def test_restore_counter_only_counts_fully_applied_tabs() -> None:
    entries = [
        {"targetId": "t1", "storageApplied": True, "scrollApplied": True},
        {"targetId": "t2", "storageApplied": True, "scrollApplied": False},
        None,
        "junk",
    ]
    assert_eq(rt._restored_count(entries), 1, "只统计完整应用的标签")


# ----------------------------------------------------------- storage safety


@test
def test_storage_expression_is_origin_scoped() -> None:
    expression = rt.apply_storage_expression("https://a.example", {"t": "secret"})
    assert_true('"https://a.example"' in expression, "脚本内必须绑定记录的 origin")
    assert_true("window.location.origin" in expression, "必须在页面内复核当前 origin")
    assert_true("origin-mismatch" in expression, "origin 不符时必须拒绝写入")


@test
def test_storage_expression_escapes_the_payload() -> None:
    expression = rt.apply_storage_expression("https://a.example", {"k'": "v\"</script>"})
    # The payload is JSON-encoded, so a quote in a key or value cannot break out
    # of the evaluated script.
    assert_true("\\\"" in expression or '\\"' in expression, "payload 必须被转义")
    assert_true("</script>" in expression, "内容保持原样但不得截断脚本")


@test
def test_scroll_expression_verifies_the_result() -> None:
    expression = rt.apply_scroll_expression(400)
    assert_true("window.scrollTo(0, 400)" in expression, "必须滚到记录位置")
    assert_true("return actual" in expression, "必须回填实际滚动位置以便校验")


@test
def test_dirty_input_expression_skips_non_text_controls() -> None:
    expression = rt.dirty_input_probe_expression()
    for control in ("checkbox", "radio", "file", "submit", "button", "reset", "hidden", "image"):
        assert_true(control in expression, f"{control} 不应被视为未提交输入")
    assert_true("defaultValue" in expression, "只有与默认值不同的输入才算脏")
    assert_true("contenteditable" in expression, "contenteditable 也要检查")


@test
def test_ready_state_expression_reports_document_state() -> None:
    assert_true("document.readyState" in rt.ready_state_expression(), "必须读取真实 readyState")


# -------------------------------------------------------------- CLI contract


@test
def test_parser_defaults_are_conservative() -> None:
    args = rt.build_parser().parse_args(["snapshot"])
    assert_eq(args.policy, "block", "默认必须拒绝而非丢弃带未提交输入的页面")
    assert_false(args.allow_blank, "默认不得允许无快照启动空白浏览器")


@test
def test_wake_starts_blank_only_when_nothing_was_ever_saved() -> None:
    """A browser that died before its first snapshot must be recoverable."""
    calls: list[str] = []
    saved = (rt.verify_helper, rt.start_supervisor, rt.wait_for_cdp, rt.reconnect_mcp_browser)
    rt.verify_helper = lambda *a, **k: calls.append("verify") or {"ok": True}
    rt.start_supervisor = lambda *a, **k: calls.append("start") or {"ok": True}
    rt.wait_for_cdp = lambda *a, **k: True
    rt.reconnect_mcp_browser = lambda: {"ok": True}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "browser-snapshot.json")
            result = rt.wake_browser(path)
            assert_true(result["ok"], f"从未保存过快照时应启动空白浏览器：{result}")
            assert_eq(result.get("restoredTabs"), 0, "空白启动不恢复任何标签")

            with open(rt.restore_state_path_for(path), "w", encoding="utf-8") as handle:
                handle.write("{}")
            result = rt.wake_browser(path)
            assert_false(result["ok"], "有恢复记录但快照缺失时必须拒绝")
            os.unlink(rt.restore_state_path_for(path))

            with open(path, "w", encoding="utf-8") as handle:
                handle.write("not json")
            result = rt.wake_browser(path)
            assert_false(result["ok"], "快照损坏时必须拒绝，不得静默丢弃")
    finally:
        rt.verify_helper, rt.start_supervisor, rt.wait_for_cdp, rt.reconnect_mcp_browser = saved


@test
def test_status_and_check_do_not_require_a_lock() -> None:
    """Read-only commands must never be blocked by an in-flight release."""
    source = open(SCRIPT, encoding="utf-8").read()
    assert_true('if args.command in ("status", "check"):' in source, "只读命令必须绕过锁")
    for command in ("snapshot", "stop", "wake", "restore"):
        assert_true(f'"{command}"' in source, f"{command} 应存在于 CLI")


@test
def test_stop_path_documents_upstream_escalation() -> None:
    """The docstring must state the real upstream behaviour, not a false promise."""
    doc = rt.stop_browser.__doc__ or ""
    assert_true("SIGKILL" in doc, "必须如实说明上游助手可能升级为 SIGKILL")
    assert_true("SIGTERM" in doc, "必须说明本脚本只发送 SIGTERM")
    top = rt.__doc__ or ""
    assert_true("SIGKILL" in top, "模块文档也必须说明该边界")


@test
def test_restore_applies_storage_and_scroll_only_after_load() -> None:
    """The restore must not write storage/scroll into a document that is still loading."""
    source = open(SCRIPT, encoding="utf-8").read()
    start = source.index("def restore_tabs(")
    body = source[start : source.index("def _restored_count(")]
    load_gate = body.index("wait_for_ready_state")
    storage_write = body.index("apply_storage_expression")
    scroll_write = body.index("apply_scroll_expression")
    assert_true(load_gate < storage_write, "必须先等待页面加载完成再注入 sessionStorage")
    assert_true(load_gate < scroll_write, "必须先等待页面加载完成再恢复滚动位置")
    # Storage must be written before the scroll so a page that scrolls itself on
    # load has already settled by the time we set the offset.
    assert_true(storage_write < scroll_write, "存储应先于滚动恢复")
    # Creation of targets must precede all of the above.
    assert_true(body.index("Target.createTarget") < load_gate, "必须先创建标签再等待加载")


@test
def test_restore_closes_only_startup_pages() -> None:
    """Cleanup must target the pre-existing placeholder, never a restored tab."""
    source = open(SCRIPT, encoding="utf-8").read()
    body = source[source.index("def _close_startup_pages(") : source.index("def restore_tabs(")]
    assert_true("target_id not in startup_ids" in body, "只能关闭启动时就存在的页面")
    assert_true("keep_ids" in body, "已恢复的标签必须被保护")
    assert_true("BLANK_URLS" in body, "只能关闭空白占位页")

    start = source.index("def restore_tabs(")
    restore_body = source[start : source.index("def _restored_count(")]
    startup_capture = restore_body.index("startup_ids = set(existing_ids)")
    first_create = restore_body.index("Target.createTarget")
    assert_true(
        startup_capture < first_create,
        "启动页集合必须在创建任何标签之前抓取，否则会误关恢复出来的页面",
    )


@test
def test_lock_is_exclusive_and_released() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snapshot.json.lock")
        first = rt.FileLock(path)
        first.acquire()
        second = rt.FileLock(path)
        try:
            second.acquire()
        except rt.LockBusy:
            pass
        else:
            second.release()
            raise AssertionError("第二个进程不应同时获得锁")
        first.release()
        # After release the lock is available again.
        third = rt.FileLock(path)
        third.acquire()
        third.release()
        mode = os.stat(path).st_mode & 0o777
        assert_eq(mode, 0o600, "锁文件权限必须是 0600")


@test
def test_lock_paths_derive_from_the_snapshot_path() -> None:
    assert_eq(rt.lock_path_for("/a/b/snap.json"), "/a/b/snap.json.lock", "锁路径应派生自快照路径")
    assert_eq(
        rt.restore_state_path_for("/a/b/snap.json"),
        "/a/b/snap.json.restore.json",
        "进度记录路径应派生自快照路径",
    )


@test
def test_restore_seeds_storage_before_navigating() -> None:
    """sessionStorage must exist before the app boots, not after `load`."""
    source = open(SCRIPT, encoding="utf-8").read()
    body = source[source.index("def restore_tabs(") : source.index("def _restored_count(")]
    create = body.index('"about:blank"')
    init_script = body.index("Page.addScriptToEvaluateOnNewDocument")
    navigate = body.index("Page.navigate")
    ready = body.index("wait_for_ready_state")
    remove_script = body.index("Page.removeScriptToEvaluateOnNewDocument")
    assert_true(create < init_script, "必须先创建 blank 目标再装初始化脚本")
    assert_true(init_script < navigate, "初始化脚本必须在导航前安装（SPA 启动时就要读到）")
    assert_true(navigate < ready, "导航之后才等待加载完成")
    assert_true(ready < remove_script, "加载完成后才移除初始化脚本，避免覆盖后续导航")
    assert_true(
        "storage_init_script" in body,
        "必须使用按 origin 限定的初始化脚本，而不是在加载后补写",
    )


@test
def test_restore_uses_a_blank_target_then_navigates() -> None:
    """Creating the target directly at the URL would beat any init script."""
    source = open(SCRIPT, encoding="utf-8").read()
    body = source[source.index("def restore_tabs(") : source.index("def _restored_count(")]
    assert_true('Target.createTarget", {"url": "about:blank"}' in body, "目标必须以 about:blank 创建")
    assert_true(
        'Target.createTarget", {"url": url}' not in body,
        "不得再把目标 URL 直接交给 createTarget",
    )


@test
def test_restore_fails_when_the_aio_focus_cannot_be_synced() -> None:
    """`problems` carrying a focus failure must not be reported as ok."""
    source = open(SCRIPT, encoding="utf-8").read()
    body = source[source.index("def restore_tabs(") : source.index("def _restored_count(")]
    assert_true("BLOCKING_PROBLEMS" in body, "必须按阻塞级别区分 problems")
    assert_true("focus_failed" in body, "焦点同步失败必须进入失败分支")
    assert_true(
        body.index("focus_failed") < body.index('state["completed"] = True'),
        "焦点同步失败必须在标记完成之前返回",
    )
    assert_true("aio_activate_index" in body, "恢复后必须同步 AIO 的活动标签")


@test
def test_restore_finishes_with_reindexed_aio_tabs_and_focuses_the_original_target() -> None:
    from unittest.mock import patch
    class FakeCdp:
        def __init__(self, **kwargs): self.calls = []
        def connect(self): pass
        def close(self): pass
        def attach(self, target): return target
        def targets(self): return [{"id": t, "type": "page", "url": "https://example.test/"} for t in ["a", "b", "c"]]
        def call(self, method, params, **kwargs): self.calls.append((method, params)); return {}
    cdp = FakeCdp()
    activated = []
    mapping = [0, 2, 1]
    def identify(c, entries, require_order=True):
        return (None, "active_activate_failed") if require_order else (mapping, "")
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snapshot.json")
        snapshot = {"savedAt": 123, "orderVerified": True, "tabs": [
            {"url": "https://example.test/", "active": i == 1} for i in range(3)]}
        state = {"snapshotSavedAt": 123, "completed": False, "tabs": [
            {"targetId": t, "navigated": True, "storageApplied": True, "scrollApplied": True} for t in ["a", "b", "c"]]}
        rt.write_restore_state(path, state)
        with patch.object(rt, "Cdp", lambda **k: cdp), patch.object(rt, "wait_for_ready_state", return_value=True), \
             patch.object(rt, "_current_browser_identity", return_value=(12, 34)), \
             patch.object(rt, "reconnect_mcp_browser", return_value={"ok": True}), \
             patch.object(rt, "aio_restored_indices", identify), \
             patch.object(rt, "aio_activate_index", lambda i, *a, **k: (activated.append(i) or True, "")):
            for _ in range(2):
                result = rt.restore_tabs(snapshot, snapshot_path=path)
                assert_true(result["ok"], "内部编号重排不应阻止恢复")
                assert_false(result["orderVerified"], "不能声称内部编号保持原序")
                assert_eq(activated[-1], 2, "原选中目标 b 对应当前 index 2")
                assert_true(rt.read_restore_state(path)["completed"])
            with patch.object(rt, "reconnect_mcp_browser", return_value={"ok": False, "message": "MCP reconnect failed"}):
                assert_false(rt.restore_tabs(snapshot, snapshot_path=path)["ok"])
                assert_false(rt.read_restore_state(path)["completed"], "MCP 失败必须保留待恢复状态")
            assert_true(rt.restore_tabs(snapshot, snapshot_path=path)["ok"])
            assert_false(any(m in ("Target.createTarget", "Target.closeTarget", "Page.navigate") for m, _ in cdp.calls), "重试不能重建、关闭或重新导航标签")
            assert_true(("Target.activateTarget", {"targetId": "b"}) in cdp.calls)


@test
def test_restore_pending_keeps_focus_failure_pending_even_when_all_pages_applied() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "snapshot.json")
        snapshot = base_snapshot()
        rt.write_snapshot(path, snapshot)
        rt.write_restore_state(path, {
            "snapshotSavedAt": snapshot["savedAt"], "completed": False,
            "tabs": [{"targetId": "t1", "storageApplied": True, "scrollApplied": True}],
        })
        assert_true(rt.restore_pending(path, 555, 9), "焦点同步失败不能被误报为已恢复")


@test
def test_aio_restored_indices_preserves_extra_and_duplicate_tabs_and_cleans_markers() -> None:
    saved_tabs, saved_request, saved_activate = rt.aio_tabs, rt.aio_request, rt.aio_activate_index
    class FakeCdp:
        def __init__(self): self.cleaned = []; self.detached = []
        def attach(self, target): return target
        def evaluate(self, session, expression):
            if expression.startswith("delete "): self.cleaned.append(session)
            return True
        def call(self, method, params): self.detached.append(params["sessionId"]); return {}
    cdp = FakeCdp()
    rows = [{"index": i, "url": "https://example.test/same", "is_active": False} for i in range(4)]
    active = [0]
    def activate(index, count, reconnect=True):
        assert_false(reconnect, "映射中不重连或重排")
        active[0] = index
        return True, ""
    def request(*args):
        return {"success": True, "data": {1: 0, 3: 1}.get(active[0])}, ""
    rt.aio_tabs = lambda: (rows, "")
    rt.aio_activate_index = activate
    rt.aio_request = request
    try:
        indices, problem = rt.aio_restored_indices(cdp, [{"targetId": "a"}, {"targetId": "b"}])
        assert_eq(indices, [1, 3], "相同 URL 的额外标签不能冒充恢复标签")
        assert_eq(problem, "")
        assert_eq(cdp.cleaned, ["a", "b"], "必须清理所有临时标识")
        assert_eq(cdp.detached, ["a", "b"])
        rt.aio_request = lambda *args: (None, "disconnected")
        cdp = FakeCdp()
        assert_eq(rt.aio_restored_indices(cdp, [{"targetId": "a"}])[0], None)
        assert_eq(cdp.cleaned, ["a"], "失败也清理")
        rt.aio_request = lambda *args: ({"success": True, "data": None}, "")
        assert_eq(rt.aio_restored_indices(FakeCdp(), [{"targetId": "a"}])[0], None, "找不到身份不猜 index")
        rt.aio_request = lambda *args: ({"success": True, "data": {1: 1, 3: 0}.get(active[0])}, "")
        assert_eq(rt.aio_restored_indices(FakeCdp(), [{"targetId": "a"}, {"targetId": "b"}])[0], None, "顺序改变不能报成功")
        assert_eq(rt.aio_restored_indices(FakeCdp(), [{"targetId": "a"}, {"targetId": "b"}], require_order=False)[0], [3, 1], "保存阶段按身份重排 CDP 枚举结果")
    finally:
        rt.aio_tabs, rt.aio_request, rt.aio_activate_index = saved_tabs, saved_request, saved_activate


@test
def test_duplicate_capture_matches_identity_and_preserves_focus_on_failure() -> None:
    saved = rt.aio_tabs, rt.aio_request, rt.aio_activate_index
    pages = [{"id": "second", "type": "page", "url": "https://example.test/same"},
             {"id": "first", "type": "page", "url": "https://example.test/same"}]
    active = [0]
    fail = [False]
    focus_failure = [False]
    changed = [False]
    def rows():
        return [{"index": i, "url": "https://example.test/same", "is_active": i == active[0]} for i in range(2)]
    class Cdp:
        def __init__(self): self.markers = {}; self.cleaned = []
        def attach(self, target): return target
        def evaluate(self, session, expression):
            if expression.startswith("delete "):
                self.markers.pop(session, None); self.cleaned.append(session)
            else:
                # The production probe assigns positions in CDP order.
                self.markers[session] = 0 if session == "second" else 1
            return True
        def targets(self): return pages[:1] if changed[0] else pages
        def call(self, *args): return {}
    cdp = Cdp()
    def activate(index, count, reconnect=True):
        assert_false(reconnect, "捕获不能重连并改变标签顺序")
        if focus_failure[0] and index == 0 and active[0] == 1:
            return False, "active_activate_failed"
        active[0] = index
        return True, ""
    def request(*args):
        if fail[0] and active[0] == 1: return None, "offline"
        return {"success": True, "data": cdp.markers.get(["first", "second"][active[0]])}, ""
    rt.aio_tabs = lambda: (rows(), "")
    rt.aio_activate_index = activate
    rt.aio_request = request
    try:
        plan, _, verified, problem = rt.duplicate_capture_plan(cdp, pages, rows())
        assert_eq(problem, "")
        assert_true(verified)
        assert_eq([p["targetId"] for p in plan], ["first", "second"], "同网址不能靠 CDP 枚举顺序配对")
        assert_eq([p["active"] for p in plan], [True, False])
        assert_eq(active[0], 0, "成功后恢复原选中页")
        assert_eq(cdp.markers, {}, "不留下页面标记")
        fail[0] = True
        assert_eq(rt.duplicate_capture_plan(cdp, pages, rows())[3], "tab_identity_unverified")
        assert_eq(active[0], 0, "失败也恢复原选中页")
        assert_eq(cdp.markers, {})
        fail[0] = False; changed[0] = True
        assert_eq(rt.duplicate_capture_plan(cdp, pages, rows())[3], "tab_identity_unverified", "标签关闭时禁止保存")
        assert_eq(active[0], 0)
        assert_eq(rt.tab_plan(pages, rows(), verified_targets={0: "first", 1: "first"})[3], "tab_target_not_unique", "同一 target 不能保存两次")
        changed[0] = False; focus_failure[0] = True
        assert_eq(rt.duplicate_capture_plan(cdp, pages, rows())[3], "tab_focus_unverified", "无法恢复焦点时不能保存")
    finally:
        rt.aio_tabs, rt.aio_request, rt.aio_activate_index = saved


@test
def test_aio_activate_uses_the_verified_soft_reconnect_and_index_route() -> None:
    calls: list[tuple[str, str, Any]] = []
    saved = rt.aio_request

    def fake(method: str, path: str, body: Any = None) -> tuple[Any, str]:
        calls.append((method, path, body))
        return {}, ""

    rt.aio_request = fake  # type: ignore[assignment]
    try:
        ok, problem = rt.aio_activate_index(1, 3)
        assert_true(ok, "两步都成功时应返回 ok")
        assert_eq(problem, "", "成功时不应有 problem")
    finally:
        rt.aio_request = saved  # type: ignore[assignment]
    assert_eq(calls[0][0], "POST", "先做 soft 重连")
    assert_eq(calls[0][1], "/v1/browser/restart", "重连走 restart 路由")
    assert_eq(calls[0][2], {"mode": "soft"}, "只能 soft 重连，绝不能 hard 重启浏览器")
    assert_eq(calls[1][0], "PUT", "激活是 PUT")
    assert_eq(calls[1][1], "/v1/browser/tabs/1/activate", "按 index 激活，且无 body")
    assert_eq(calls[1][2], None, "激活请求不带 body")

    rt.aio_request = lambda *a, **k: (None, "boom")  # type: ignore[assignment]
    try:
        ok, problem = rt.aio_activate_index(0, 2)
        assert_false(ok, "重连失败时不得声称成功")
        assert_eq(problem, "aio_reconnect_failed", "应报告重连失败")
    finally:
        rt.aio_request = saved  # type: ignore[assignment]


@test
def test_restore_never_counts_a_tab_without_a_target_id() -> None:
    source = open(SCRIPT, encoding="utf-8").read()
    body = source[source.index("def restore_tabs(") : source.index("def _restored_count(")]
    assert_true('"no_target_id"' in body, "缺失 targetId 必须记为失败")
    assert_true(
        "created += 1" not in body or body.index("no_target_id") < body.index("created += 1"),
        "缺失 targetId 时不得计入已恢复",
    )
    # Partial failure must return before the completion record is written, so the
    # retry resumes instead of treating the snapshot as applied.
    assert_true("if failed:" in body, "必须有部分失败分支")
    assert_true(
        body.index("if failed:") < body.index('state["completed"] = True'),
        "部分失败必须在标记完成之前返回",
    )
    assert_true("os.unlink" not in body and "delete_snapshot" not in body, "恢复流程不得删除快照")


@test
def test_redact_urls_strips_urls_and_long_blobs() -> None:
    cleaned = rt.redact_urls("无法连接浏览器 CDP：https://example.com/path?token=abcdefghijklmnopqrstuvwxyz0123456789")
    assert_true("example.com" not in cleaned, "URL 必须被移除")
    assert_true("abcdefghijklmnopqrstuvwxyz0123456789" not in cleaned, "长令牌必须被移除")
    assert_true("<url>" in cleaned, "应替换为占位符")
    # A long, opaque storage value is redacted too.
    assert_true("<redacted>" in rt.redact_urls("x" * 60), "长字符串必须被脱敏")
    # Plain short text is untouched, so messages stay readable.
    assert_eq(rt.redact_urls("浏览器未运行"), "浏览器未运行", "普通文本不应被改动")


@test
def test_no_runtime_error_reaches_json_without_redaction() -> None:
    """Every message that can embed a CDP error must pass through redact_urls."""
    import re as _re

    source = open(SCRIPT, encoding="utf-8").read()
    offenders = [
        match.group(0).strip()
        for match in _re.finditer(r"(?:err|failed\.append|\"message\":)\s*\(?[^\n]*", source)
        if "{exc}" in match.group(0) and "redact_urls" not in match.group(0)
    ]
    assert_eq(offenders, [], "所有可能含 URL 的错误信息都必须先脱敏")


class _StubCdp:
    """Minimal stand-in for the CDP client so preflight can be driven without CDP."""

    def __init__(self, pages, hang_targets=(), fail_connect=False, **_kw):
        self._pages = list(pages)
        self._hang = set(hang_targets)
        self._fail_connect = fail_connect
        self.closed = False

    def targets(self):
        return list(self._pages)

    def connect(self, ws_url=None):
        if self._fail_connect:
            raise rt.CdpError("无法建立 CDP 连接：ConnectionClosed")

    def attach(self, target_id):
        return f"sess-{target_id}"

    def call(self, method, params=None, session_id=None):
        target = (session_id or "").replace("sess-", "")
        if target in self._hang:
            # Real behaviour observed live: a wedged renderer never answers.
            raise rt.CdpError(f"CDP {method} 超时")
        return {}

    def evaluate(self, session_id, expression):
        if "readyState" in expression:
            return "complete"
        return False

    def close(self):
        self.closed = True


@test
def test_argv_flattened_cmdline_is_not_substring_trusted() -> None:
    """The real flattened token must match on whole tokens only, never substrings."""
    profile = rt.DEFAULT_PROFILE_DIR
    # Real shape: one token holding the whole command line, with a --type child
    # rejected even though it carries the same profile flag.
    real = f"/opt/browser/chrome --user-data-dir={profile} --no-sandbox --enable-features=A,B"
    assert_true(rt.is_browser_argv([real]), "真实 flattened 命令行必须认领")
    child = f"/opt/browser/chrome --user-data-dir={profile} --type=renderer"
    assert_false(rt.is_browser_argv([child]), "renderer 子进程不得被当作浏览器")
    # A *sibling* profile that merely shares the prefix must never match.
    sibling = f"/opt/browser/chrome --user-data-dir={profile}-old --no-sandbox"
    assert_false(rt.is_browser_argv([sibling]), f"同前缀的兄弟 profile 不得匹配：{sibling[:40]}")
    # A user-agent containing the profile path as text must not be trusted.
    decoy = f"/usr/bin/chromium --user-agent=see --user-data-dir={profile}xyz"
    assert_false(rt.is_browser_argv([decoy]), "仅子串出现 profile 不得匹配")


@test
def test_cdp_call_turns_recv_timeout_into_a_structured_error() -> None:
    """A wedged renderer must surface as CdpError, never a raw TimeoutError."""

    class _Ws:
        def send(self, _payload):
            return None

        def recv(self, timeout=None):
            raise TimeoutError("timed out in 10.0s")

    cdp = rt.Cdp()
    cdp._ws = _Ws()
    try:
        cdp.call("Runtime.enable", {}, session_id="s1")
    except rt.CdpError as exc:
        assert_true("超时" in str(exc), "必须是结构化超时说明")
    except Exception as exc:  # noqa: BLE001 - this is the regression under test
        raise AssertionError(f"recv 超时必须转为 CdpError，实际 {type(exc).__name__}: {exc}") from exc
    else:
        raise AssertionError("recv 超时必须抛错")


@test
def test_cdp_call_turns_a_broken_transport_into_a_structured_error() -> None:
    """A closed socket mid-call must not leak a websockets exception."""

    class _Ws:
        def send(self, _payload):
            return None

        def recv(self, timeout=None):
            raise RuntimeError("connection is closed")

    cdp = rt.Cdp()
    cdp._ws = _Ws()
    try:
        cdp.call("Runtime.enable", {}, session_id="s1")
    except rt.CdpError as exc:
        assert_true("连接中断" in str(exc), "必须是结构化断连说明")
    except Exception as exc:  # noqa: BLE001
        raise AssertionError(f"断连必须转为 CdpError，实际 {type(exc).__name__}") from exc
    else:
        raise AssertionError("断连必须抛错")


@test
def test_preflight_reports_an_unresponsive_tab_instead_of_unsupported_scheme() -> None:
    """An uninspectable page is unproven: it must not be mislabelled by scheme."""
    pages = [
        {"id": "t1", "type": "page", "url": "https://example.com/a"},
        {"id": "t2", "type": "page", "url": "https://example.com/b"},
    ]

    def factory(pages_=pages, **_kw):
        # t1 wedges exactly like the live renderer did; t2 answers normally.
        return _StubCdp(pages_, hang_targets={"t1"}, **_kw)

    original = rt.Cdp
    rt.Cdp = factory
    try:
        result = rt.preflight("block", download_dirs=[])
    finally:
        rt.Cdp = original
    # `ok` records that the command ran; `safe` is the reclaim verdict.
    assert_true(result["ok"], "preflight 命令本身应成功执行")
    assert_eq(result["safe"], False, "存在无法检查的页面时 safe 必须为 false")
    assert_eq(result["reason"], "tab_unresponsive", "原因必须是 tab_unresponsive")
    assert_eq(result["unresponsive"], 1, "应记录 1 个无响应页面")
    assert_eq(result["unsupported"], 0, "不得误报为不支持的协议")


@test
def test_preflight_connect_failure_is_a_structured_error() -> None:
    """If CDP cannot be reached at all, preflight must return err, not raise."""

    # One page must be listed so preflight reaches connect() instead of
    # short-circuiting on the no_tabs guard.
    listed = [{"id": "t1", "type": "page", "url": "https://example.com/a"}]

    def factory(pages_=listed, **_kw):
        return _StubCdp(listed, fail_connect=True, **_kw)

    original = rt.Cdp
    rt.Cdp = factory
    try:
        result = rt.preflight("block", download_dirs=[])
    finally:
        rt.Cdp = original
    assert_false(result["ok"], "无法连接 CDP 时必须返回结构化错误")
    assert_true("无法连接浏览器 CDP" in (result.get("message") or ""), "错误信息应说明无法连接")


@test
def test_preflight_returns_expected_shape_for_a_healthy_page() -> None:
    """Sanity: the happy path still reports safe with the new counter fields."""
    pages = [{"id": "t1", "type": "page", "url": "https://example.com/a"}]

    def factory(pages_=pages, **_kw):
        return _StubCdp(pages_, **_kw)

    original = rt.Cdp
    rt.Cdp = factory
    try:
        result = rt.preflight("block", download_dirs=[])
    finally:
        rt.Cdp = original
    assert_true(result["ok"], "健康页面的 preflight 应成功执行")
    assert_eq(result["safe"], True, "健康页面应可安全回收")
    assert_eq(result["unresponsive"], 0, "不应有误报的无响应页面")


@test
def test_main_never_escapes_as_a_traceback() -> None:
    """Every exit must be one structured JSON line, even when dispatch explodes."""
    import contextlib

    original = rt.dispatch

    def boom(_args):
        raise RuntimeError("secret-url https://example.com/private?token=abcdefghijklmnopqrstuvwxyz0123456789")

    rt.dispatch = boom
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            code = rt.main(["status"])
    finally:
        rt.dispatch = original
    output = buffer.getvalue().strip()
    assert_eq(code, 1, "内部错误必须以非零退出码结束")
    payload = json.loads(output)
    assert_false(payload["ok"], "内部错误必须报 ok=false")
    assert_true("Traceback" not in output, "不得输出 traceback")
    assert_true("abcdefghijklmnopqrstuvwxyz0123456789" not in output, "不得泄露 URL/令牌")


@test
def test_dispatch_is_a_separate_entrypoint_from_main() -> None:
    """`main` must delegate so that it can always emit JSON (regression guard)."""
    source = open(SCRIPT, encoding="utf-8").read()
    assert_true("def dispatch(" in source, "必须存在独立 dispatch 入口")
    assert_true("def main(" in source, "必须存在 main")
    assert_true("except Exception as exc" in source, "main 必须兜底异常")



@test
def test_blank_new_tab_aliases_are_normalised() -> None:
    # Verified live: AIO says chrome://new-tab-page/ while CDP says chrome://newtab/
    # for the same empty default tab. Without normalisation the pairing is
    # unprovable and every release is blocked forever.
    assert_eq(rt.normalize_blank_url("chrome://newtab/"), "about:blank", "CDP 别名应归一化")
    assert_eq(rt.normalize_blank_url("chrome://new-tab-page/"), "about:blank", "AIO 别名应归一化")
    assert_eq(rt.normalize_blank_url("about:blank"), "about:blank", "about:blank 保持不变")
    # A real chrome:// page is NOT a blank alias and must keep blocking.
    assert_eq(rt.normalize_blank_url("chrome://settings/"), "chrome://settings/", "其它 chrome:// 页不归一化")
    assert_eq(rt.normalize_blank_url("https://example.com/"), "https://example.com/", "普通 URL 不归一化")


@test
def test_tab_plan_pairs_the_real_blank_alias_sample() -> None:
    # The exact sample the parent acceptance run hit.
    cdp_pages = [
        {"id": "t1", "url": "http://127.0.0.1:8765/f.html?tab=one"},
        {"id": "t2", "url": "chrome://newtab/"},
    ]
    aio_rows = [
        {"index": 0, "url": "http://127.0.0.1:8765/f.html?tab=one", "title": "one", "is_active": False},
        {"index": 1, "url": "chrome://new-tab-page/", "title": "New Tab", "is_active": True},
    ]
    plan, warnings, order_verified, blocked = rt.tab_plan(cdp_pages, aio_rows)
    assert_eq(blocked, "", "默认新标签别名不应永久阻塞配对")
    assert_true(order_verified, "顺序应被确认")
    assert_eq(len(plan), 2, "两个标签都应进入计划")
    assert_eq(plan[1]["url"], "about:blank", "别名应以 about:blank 恢复")
    assert_true(plan[1]["active"], "选中状态应来自 AIO")


@test
def test_tab_plan_still_blocks_other_chrome_pages() -> None:
    cdp_pages = [{"id": "t1", "url": "chrome://settings/"}]
    aio_rows = [{"index": 0, "url": "chrome://settings/", "title": "Settings", "is_active": True}]
    plan, _warnings, _verified, blocked = rt.tab_plan(cdp_pages, aio_rows)
    # The plan pairs them (the URLs agree); it is `classify_url` that refuses the
    # scheme, so the capture fails closed rather than the pairing.
    assert_eq(blocked, "", "URL 一致的配对本身不阻塞")
    assert_eq(len(plan), 1, "计划中仍有这一页")
    assert_false(rt.classify_url("chrome://settings/")[0], "chrome://settings/ 不可恢复")
    assert_true(rt.classify_url("about:blank")[0], "about:blank 可恢复")


@test
def test_storage_helpers_report_content_free_counts() -> None:
    snap = stoppable_snapshot()
    counts = rt.storage_counts(snap)
    assert_eq(counts["cookies"], 1, "应统计 cookie 数量")
    assert_eq(counts["origins"], 1, "应统计 origin 数量")
    assert_eq(counts["localStorageEntries"], 1, "应统计 localStorage 条目数")
    assert_true(rt.snapshot_has_storage(snap), "带 storage 的快照应被判为完整")
    assert_false(rt.snapshot_has_storage(base_snapshot()), "缺少 storage 的快照不是完整快照")
    del snap["storage"]["state"]
    assert_false(rt.snapshot_has_storage(snap), "storage.state 缺失即不完整")


@test
def test_stop_refuses_a_snapshot_without_storage() -> None:
    """The added storage gate: an old schema-1 snapshot must never authorise a stop."""
    fake = FakeProc()
    restore = with_fake_proc(fake)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "snapshot.json")
            legacy = base_snapshot()
            legacy["schema"] = 1
            legacy["source"]["browserPid"] = 555
            legacy["source"]["browserStarttime"] = 9
            rt.write_snapshot(path, legacy)
            helper_pid = os.path.join(tmp, "h.pid")
            browser_pid = os.path.join(tmp, "b.pid")
            with open(helper_pid, "w", encoding="utf-8") as handle:
                handle.write("4242\n")
            with open(browser_pid, "w", encoding="utf-8") as handle:
                handle.write("555\n")
            fake.add(4242, ["/usr/bin/python3", "/opt/gem/browser-supervisor.py"], uid=0, starttime=1)
            fake.add(555, ["/opt/browser/chrome", f"--user-data-dir={rt.DEFAULT_PROFILE_DIR}"], uid=0, ppid=4242, starttime=9)
            result = rt.stop_browser(path, helper_pid_file=helper_pid, browser_pid_file=browser_pid, timeout_s=0.3)
            assert_false(result["ok"], "旧 schema 缺少存储时必须拒绝停止")
            assert_true("存储" in result["message"] or "拒绝停止" in result["message"], "应给出诚实原因")
            assert_eq(result.get("reason"), "snapshot_storage_missing", "应给出稳定的拒绝码")
    finally:
        restore()


@test
def test_storage_state_export_and_import_use_the_helper(monkeypatch_note: str = "") -> None:
    """The Python side must drive the vendored helper, never serialize storage itself."""
    calls: list[list[str]] = []

    class FakeCompleted:
        returncode = 0
        stdout = b'{"ok": true, "cookies": 2, "origins": 1, "localStorageEntries": 3, "indexedDbDatabases": 1}\n'
        stderr = b""

    import subprocess as _subprocess

    saved_run = _subprocess.run
    saved_which = rt.shutil.which

    def fake_run(argv: list[str], **kwargs: Any) -> Any:
        calls.append(list(argv))
        # The helper is expected to have written its own output file.
        out_index = argv.index("--out") + 1 if "--out" in argv else None
        if out_index is not None:
            with open(argv[out_index], "w", encoding="utf-8") as handle:
                handle.write(json.dumps({"schema": 1, "capturedAt": 5, "state": {"cookies": [], "origins": []}}))
        return FakeCompleted()

    def fake_helper_dir(tmp: str) -> str:
        with open(os.path.join(tmp, rt.STORAGE_HELPER_NAME), "w", encoding="utf-8") as handle:
            handle.write("// stub")
        os.makedirs(os.path.join(tmp, rt.STORAGE_VENDOR_NAME), exist_ok=True)
        return tmp

    with tempfile.TemporaryDirectory() as tmp:
        helper_dir = fake_helper_dir(tmp)
        saved_candidates = rt.NODE_CANDIDATES
        _subprocess.run = fake_run  # type: ignore[assignment]
        rt.NODE_CANDIDATES = ("/usr/bin/fake-node",)  # type: ignore[assignment]
        saved_isfile = rt.os.path.isfile
        saved_access = rt.os.access
        rt.os.path.isfile = lambda p: True if p == "/usr/bin/fake-node" else saved_isfile(p)  # type: ignore[assignment]
        rt.os.access = lambda p, m: True if p == "/usr/bin/fake-node" else saved_access(p, m)  # type: ignore[assignment]
        try:
            result = rt.export_storage_state(
                ["https://example.com/x"], timeout=5, helper_dir=helper_dir, temp_dir=tmp
            )
        finally:
            _subprocess.run = saved_run  # type: ignore[assignment]
            rt.shutil.which = saved_which  # type: ignore[assignment]
            rt.NODE_CANDIDATES = saved_candidates  # type: ignore[assignment]
            rt.os.path.isfile = saved_isfile  # type: ignore[assignment]
            rt.os.access = saved_access  # type: ignore[assignment]
        assert_eq(calls[0][0], "/usr/bin/fake-node", "应使用解析出的 node")
        assert_true(rt.STORAGE_HELPER_NAME in calls[0][1], "应调用受管的存储 helper")
        assert_eq(calls[0][2], "export", "第一个子命令应是 export")
        assert_eq(result["counts"]["cookies"], 2, "应回传内容无关的计数")
        assert_true("state" in result, "应带回原始 state 供快照保存")
        # The temporary export file must not be left behind.
        leftovers = [n for n in os.listdir(tmp) if n.endswith(".storage.json")]
        assert_eq(leftovers, [], "临时导出文件必须被清理")


@test
def test_storage_export_refuses_when_the_helper_is_missing() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        try:
            rt.export_storage_state(["https://example.com"], timeout=2, helper_dir=tmp, temp_dir=tmp)
        except rt.StorageError as exc:
            assert_true("storage_helper_missing" in str(exc), "应给出稳定的缺失码")
        else:
            raise AssertionError("缺少 helper 时必须拒绝导出")


# ---------------------------------------------------- storage completeness


@test
def test_storage_export_allows_an_empty_origin_set() -> None:
    """A browser parked on about:blank still owns cookies and must be releasable."""
    calls: list[list[str]] = []

    class FakeCompleted:
        returncode = 0
        stdout = b'{"ok": true, "cookies": 1, "origins": 0, "localStorageEntries": 0, "indexedDbDatabases": 0}\n'
        stderr = b""

    import subprocess as _subprocess

    saved_run = _subprocess.run

    def fake_run(argv: list[str], **kwargs: Any) -> Any:
        calls.append(list(argv))
        if "--out" in argv:
            with open(argv[argv.index("--out") + 1], "w", encoding="utf-8") as handle:
                handle.write(json.dumps({"schema": 1, "capturedAt": 5, "state": {"cookies": [{"name": "a"}], "origins": []}}))
        return FakeCompleted()

    with tempfile.TemporaryDirectory() as tmp:
        with open(os.path.join(tmp, rt.STORAGE_HELPER_NAME), "w", encoding="utf-8") as handle:
            handle.write("// stub")
        os.makedirs(os.path.join(tmp, rt.STORAGE_VENDOR_NAME), exist_ok=True)
        saved_candidates = rt.NODE_CANDIDATES
        saved_isfile = rt.os.path.isfile
        saved_access = rt.os.access
        _subprocess.run = fake_run  # type: ignore[assignment]
        rt.NODE_CANDIDATES = ("/usr/bin/fake-node",)  # type: ignore[assignment]
        rt.os.path.isfile = lambda p: True if p == "/usr/bin/fake-node" else saved_isfile(p)  # type: ignore[assignment]
        rt.os.access = lambda p, m: True if p == "/usr/bin/fake-node" else saved_access(p, m)  # type: ignore[assignment]
        try:
            result = rt.export_storage_state(["about:blank"], timeout=5, helper_dir=tmp, temp_dir=tmp)
        finally:
            _subprocess.run = saved_run  # type: ignore[assignment]
            rt.NODE_CANDIDATES = saved_candidates  # type: ignore[assignment]
            rt.os.path.isfile = saved_isfile  # type: ignore[assignment]
            rt.os.access = saved_access  # type: ignore[assignment]
        # No --origin flag was passed: an empty origin set is a complete capture.
        assert_false("--origin" in calls[0], "空 origin 集合不应传 --origin")
        assert_eq(result["counts"]["cookies"], 1, "空 origin 仍应导出 cookies")


@test
def test_snapshot_has_storage_requires_the_capture_schema() -> None:
    """A schema-1 (pre-storage) snapshot must never authorise a release."""
    assert_false(rt.snapshot_has_storage({"schema": 2}), "只有 schema+state 才算完整")
    assert_false(rt.snapshot_has_storage({"schema": 2, "storage": {"schema": 2, "state": {}}}), "storage schema 必须为 1")
    assert_true(
        rt.snapshot_has_storage({"schema": 2, "storage": {"schema": 1, "state": {"cookies": [], "origins": []}}}),
        "合法的 storage 捕获应被接受",
    )
    # The stop gate refuses a storage-less snapshot with a stable, secret-free
    # reason the control plane turns into an honest "cannot release" verdict.
    source = open(os.path.abspath(rt.__file__), encoding="utf-8").read()
    assert_true("snapshot_storage_missing" in source, "停止路径必须报告稳定的 storage 缺失码")


@test
def test_mcp_reconnect_checks_ownership_and_real_page_tool() -> None:
    from unittest.mock import patch
    from types import SimpleNamespace
    import http.client
    import pwd
    from contextlib import ExitStack
    calls = []
    requests = []
    owned = True
    response_body = {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "tabs"}]}}
    response_status = 200
    restart_code = 0
    refuse_connects = 0
    class Response:
        status = 200
        def read(self): return json.dumps(response_body).encode()
        def getheader(self, name): return "application/json"
    class Conn:
        def __init__(self, *args, **kwargs): pass
        def request(self, method, path, body, headers):
            nonlocal refuse_connects
            requests.append((method, path, json.loads(body)))
            if refuse_connects:
                refuse_connects -= 1
                raise ConnectionRefusedError("8100 not listening yet")
        def getresponse(self):
            r = Response(); r.status = response_status; return r
        def close(self): pass
    def run(argv, **kwargs):
        calls.append(argv)
        return SimpleNamespace(returncode=0 if argv[1] == "pid" else restart_code,
                               stdout="264" if argv[1] == "pid" else "")
    with ExitStack() as stack:
        for obj, name, replacement in [
            (rt.subprocess, "run", run), (rt, "read_cmdline_raw", lambda pid: b"node\0/usr/local/bin/mcp-server-browser\0--port\08100\0" if owned else b"node\0/other/service.js\0"),
            (rt, "read_stat", lambda pid: (123, "S")), (rt, "same_process", lambda *a: True),
            (rt, "read_uid", lambda pid: 1000), (pwd, "getpwnam", lambda name: SimpleNamespace(pw_uid=1000)),
            (http.client, "HTTPConnection", Conn), (rt, "MCP_PROBE_DEADLINE_S", 0.05),
            (rt, "MCP_PROBE_INTERVAL_S", 0.01)]:
            stack.enter_context(patch.object(obj, name, replacement))
        assert_true(rt.reconnect_mcp_browser()["ok"])
        assert_eq(calls, [["supervisorctl", "pid", "mcp-server-browser"], ["supervisorctl", "restart", "mcp-server-browser"]])
        assert_eq(requests[0][1], "/mcp")
        assert_eq(requests[0][2]["params"]["name"], "browser_tab_list", "不能只探测元数据")
        # supervisorctl restart returns before node listens: the first probe is refused.
        refuse_connects = 2
        before = len(requests)
        assert_true(rt.reconnect_mcp_browser()["ok"], "MCP 刚重启未监听时应重试探测")
        assert_eq(len(requests) - before, 3, "拒连两次后第三次探测成功")
        refuse_connects = 10**6
        assert_false(rt.reconnect_mcp_browser()["ok"], "超过截止时间仍拒连才算失败")
        refuse_connects = 0
        response_body = {"result": {"isError": True, "content": [{"text": "Session closed"}]}}
        assert_false(rt.reconnect_mcp_browser()["ok"], "HTTP 200 工具错误不能当恢复成功")
        response_body = {"error": {"message": "failed"}}
        assert_false(rt.reconnect_mcp_browser()["ok"])
        response_body = {"result": None}
        assert_false(rt.reconnect_mcp_browser()["ok"])
        restart_code = 1
        before = len(requests)
        assert_false(rt.reconnect_mcp_browser()["ok"])
        assert_eq(len(requests), before, "重启失败不进入工具探测")
        owned = False
        calls.clear()
        assert_false(rt.reconnect_mcp_browser()["ok"])
        assert_eq(len(calls), 1, "归属不明时不能重启")


# Node helper deadline and redaction are behavior-tested in browser-storage.test.ts.


def main() -> int:
    failures: list[str] = []
    for name, fn in TESTS:
        try:
            fn()
        except Exception:  # noqa: BLE001 - a test report wants everything
            failures.append(f"{name}\n{traceback.format_exc()}")
            print(f"FAIL {name}", flush=True)
        else:
            print(f"ok   {name}", flush=True)
    print(f"\n{len(TESTS) - len(failures)}/{len(TESTS)} passed")
    for failure in failures:
        print(f"\n--- {failure}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

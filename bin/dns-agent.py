#!/usr/bin/env python3
"""Bounded DNS helper for the ORIGINAL personal-agent deployment.

NOTE: this is NOT a quickstart entry point. It depends on tooling OUTSIDE this
repository (tools/linode-local/dns.py) and only manages the two exact CNAMEs of
the author's existing deployment. Public/self-hosted users should configure
PA_PRIMARY_HOST / PA_WORKSPACE_HOST themselves and ignore this script.

Creates exactly two proxied CNAMEs (agent.clawpage.ai, agent-workspace.clawpage.ai)
pointing at the dedicated personal-agent tunnel. It never modifies unrelated
records: if a name already exists it is reported and left untouched unless the
value already matches the expected tunnel target.

Usage: dns-agent.py check | create
Credential handling is reused from tools/linode-local/dns.py (import only; that
module's plan/apply/rollback actions are never invoked).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools" / "linode-local"))

import dns as dns_helper  # noqa: E402  (credential/api helpers only)

TUNNEL_ID = "384645fd-a428-4df6-a84b-e392c6e0df2d"
TARGET = f"{TUNNEL_ID}.cfargotunnel.com"
NAMES = ["agent.clawpage.ai", "agent-workspace.clawpage.ai"]
ZONE = "clawpage.ai"


def find(name: str):
    records = dns_helper.api(ZONE, "/dns_records?name=" + name)
    return [r for r in records if r["name"] == name]


def check() -> int:
    failures = 0
    for name in NAMES:
        existing = find(name)
        if not existing:
            print(f"MISSING {name}")
            failures += 1
            continue
        for record in existing:
            status = "OK" if record["type"] == "CNAME" and record["content"] == TARGET and record["proxied"] else "MISMATCH"
            print(f"{status} {name} {record['type']} -> {record['content']} proxied={record['proxied']}")
            if status != "OK":
                failures += 1
    return 1 if failures else 0


def create() -> int:
    for name in NAMES:
        existing = find(name)
        if existing:
            for record in existing:
                if record["type"] == "CNAME" and record["content"] == TARGET:
                    print(f"EXISTS {name} -> {TARGET}")
                else:
                    print(f"REFUSED {name}: already points to {record['type']} {record['content']}; not overwriting")
            continue
        created = dns_helper.api(
            ZONE,
            "/dns_records",
            "POST",
            {
                "type": "CNAME",
                "name": name,
                "content": TARGET,
                "proxied": True,
                "ttl": 1,
                "comment": "personal-agent dedicated tunnel (2026-09-22)",
            },
        )
        print(f"CREATED {created['name']} {created['type']} -> {created['content']} proxied={created['proxied']}")
    return 0


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    if action == "check":
        raise SystemExit(check())
    if action == "create":
        raise SystemExit(create())
    raise SystemExit("usage: dns-agent.py check|create")

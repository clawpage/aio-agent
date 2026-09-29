import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { login, rawUpgrade, startHarness, type TestHarness } from "../helpers/harness.js";

let h: TestHarness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.shutdown();
});

describe("host and origin gating", () => {
  it("redirects the configured retired host without forwarding requests or query secrets",async()=>{
    h.ctx.cfg.legacyPrimaryHost="agent.zymx.tech";
    try {
      const r=await h.request("/old?token=private",{hostHeader:"agent.zymx.tech"});
      expect(r.status).toBe(302);expect(r.headers.get("location")).toBe("https://agent.clawpage.ai/");
      const write=await h.request("/api/auth/login",{method:"POST",hostHeader:"agent.zymx.tech",body:"{}"});
      expect(write.status).toBe(410);
    } finally {delete h.ctx.cfg.legacyPrimaryHost;}
  });
  it("rejects unknown Host headers", async () => {
    const res = await h.request("/api/auth/session", { hostHeader: "evil.example.com" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown_host");
  });

  it("rejects a spoofed X-Forwarded-Host that disagrees with Host", async () => {
    const res = await h.request("/api/auth/session", {
      hostHeader: `localhost:${h.primaryPort}`,
      headers: { "x-forwarded-host": "evil.example.com" },
    });
    expect(res.status).toBe(404);
  });

  it("refuses login from a disallowed origin even before authentication", async () => {
    const res = await h.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ password: "correct horse battery staple" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("authentication", () => {
  it("denies API access without a session", async () => {
    for (const path of ["/api/status", "/api/conversations", "/api/models", "/api/capabilities"]) {
      const res = await h.request(path);
      expect(res.status, path).toBe(401);
    }
  });

  it("rate limits after repeated wrong passwords", async () => {
    const results: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await h.request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: `wrong-${i}` }),
      });
      results.push(res.status);
    }
    expect(results.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(results[5]).toBe(429);
  });
});

describe("session lifecycle", () => {
  it("logs in with an HttpOnly cookie and refreshes by rotation", async () => {
    const { cookie, csrf } = await login(h);
    expect(cookie).toContain("pa_session=");

    const sessionRes = await h.request("/api/auth/session", { headers: { cookie } });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { authenticated: boolean; username: string };
    expect(session.authenticated).toBe(true);
    expect(session.username).toBe("owner");

    const refresh = await h.request("/api/auth/refresh", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    expect(refresh.status).toBe(200);
    const rotated = refresh.headers.getSetCookie().find((c) => c.startsWith("pa_session="))!.split(";")[0]!;
    // Previous token is still valid inside the rotation grace window.
    expect((await h.request("/api/auth/session", { headers: { cookie } })).status).toBe(200);
    expect((await h.request("/api/auth/session", { headers: { cookie: rotated } })).status).toBe(200);
  });

  it("requires CSRF on the control plane and rejects a foreign origin", async () => {
    const { cookie } = await login(h);
    const noCsrf = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { error: string }).error).toBe("csrf_invalid");

    const { csrf } = await login(h);
    const badOrigin = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json", origin: "https://sibling.example.com" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(badOrigin.status).toBe(403);
    expect(((await badOrigin.json()) as { error: string }).error).toBe("origin_denied");
  });

  it("invalidates API access after logout", async () => {
    const { cookie, csrf } = await login(h);
    expect((await h.request("/api/conversations", { headers: { cookie } })).status).toBe(200);
    const logout = await h.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    expect(logout.status).toBe(200);
    expect((await h.request("/api/conversations", { headers: { cookie } })).status).toBe(401);
  });
});

describe("conversation and agent endpoints", () => {
  it("serves the app default model through the manager, not the CLI default", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/models", { headers: { cookie } });
    expect(res.status).toBe(200);
    const { models } = (await res.json()) as { models: Array<{ id: string; isDefault: boolean }> };
    // The fake CLI reports gpt-5.5 as its own default; the app default is Sol.
    expect(models.filter((m) => m.isDefault).map((m) => m.id)).toEqual(["gpt-6-sol"]);
  });

  it("creates conversations, streams events and reports status", async () => {
    const { cookie, csrf } = await login(h);
    const created = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ title: "测试会话" }),
    });
    expect(created.status).toBe(201);
    const { conversation } = (await created.json()) as { conversation: { id: string } };

    const events = await h.request(`/api/conversations/${conversation.id}/events?format=json`, { headers: { cookie } });
    expect(events.status).toBe(200);
    const payload = (await events.json()) as { events: Array<{ type: string }> };
    expect(payload.events.map((e) => e.type)).toContain("conversation.created");

    const status = await h.request("/api/status", { headers: { cookie } });
    const body = (await status.json()) as { agent: { queuedTurns: number }; sandbox: { running: boolean } };
    expect(body.sandbox.running).toBe(true);
    expect(body.agent.queuedTurns).toBe(0);
  });

  it("returns 409 when a clientMessageId is reused with different content", async () => {
    const { cookie, csrf } = await login(h);
    const created = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ title: "conflict" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };

    const first = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", clientMessageId: "dup-1" }),
    });
    expect(first.status).toBe(202);
    const again = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", clientMessageId: "dup-1" }),
    });
    expect(again.status).toBe(200);
    const conflict = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "different", clientMessageId: "dup-1" }),
    });
    expect(conflict.status).toBe(409);
  });

  it("reports a truthful status when there is nothing to interrupt", async () => {
    const { cookie, csrf } = await login(h);
    const created = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ title: "idle" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const res = await h.request(`/api/conversations/${conversation.id}/interrupt`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("none");
  });

  it("serves a minimal health endpoint without identities", async () => {
    const res = await h.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("personal-agent");
    expect(JSON.stringify(body)).not.toContain("owner@example.com");
    expect(body.agent).toBeUndefined();
  });
});

describe("unified settings endpoint", () => {
  it("denies settings access without a session", async () => {
    for (const [method, path] of [
      ["GET", "/api/settings"],
      ["PUT", "/api/settings"],
    ] as const) {
      const res = await h.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("requires CSRF and rejects a foreign origin on save", async () => {
    const { cookie } = await login(h);
    const noCsrf = await h.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as { error: string }).error).toBe("csrf_invalid");

    const { csrf } = await login(h);
    const badOrigin = await h.request("/api/settings", {
      method: "PUT",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json", origin: "https://sibling.example.com" },
      body: JSON.stringify({ model: "gpt-6-sol" }),
    });
    expect(badOrigin.status).toBe(403);
    expect(((await badOrigin.json()) as { error: string }).error).toBe("origin_denied");
  });

  it("returns the default choice, the model catalog and saved-model availability", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/settings", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { model: string | null; effort: string | null };
      defaultModel: string;
      models: Array<{ id: string; supportedReasoningEfforts: string[]; defaultReasoningEffort: string | null }>;
      savedModelAvailable: boolean | null;
    };
    expect(body.defaultModel).toBe("gpt-6-sol");
    expect(body.models.map((m) => m.id)).toContain("gpt-6-sol");
    expect(body.models.every((m) => Array.isArray(m.supportedReasoningEfforts))).toBe(true);
    expect(body.savedModelAvailable).toBe(true);
  });

  it("rejects malformed or invalid saves without overwriting the stored choice", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    const seed = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }),
    });
    expect(seed.status).toBe(200);

    // A numeric model must be refused, not silently coerced to null.
    const numeric = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: 123, effort: null }),
    });
    expect(numeric.status).toBe(400);
    expect(((await numeric.json()) as { error: string }).error).toBe("invalid_settings");

    const arrayBody = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify(["gpt-6-sol"]),
    });
    expect(arrayBody.status).toBe(400);

    const unknownModel = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "gpt-9-nope", effort: null }),
    });
    expect(unknownModel.status).toBe(400);

    const badEffort = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "gpt-6-sol", effort: "impossible" }),
    });
    expect(badEffort.status).toBe(400);

    // Every refusal left the seeded choice intact.
    const after = await h.request("/api/settings", { headers: { cookie } });
    expect(((await after.json()) as { settings: unknown }).settings).toEqual({ model: "gpt-6-sol", effort: "high" });
  });

  it("merges a partial save with the stored value instead of resetting the other field", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }),
    });
    // Only the effort changes; the model must be preserved.
    const partial = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ effort: "low" }),
    });
    expect(partial.status).toBe(200);
    expect(((await partial.json()) as { settings: unknown }).settings).toEqual({ model: "gpt-6-sol", effort: "low" });
    // Restore the default so later cases in this file start clean.
    await h.request("/api/settings", { method: "PUT", headers, body: JSON.stringify({ model: null, effort: null }) });
  });

  it("persists the saved choice and freezes it on the next submitted turn", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    const saved = await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }),
    });
    expect(saved.status).toBe(200);

    const reread = await h.request("/api/settings", { headers: { cookie } });
    expect(((await reread.json()) as { settings: unknown }).settings).toEqual({ model: "gpt-6-sol", effort: "high" });

    const created = await h.request("/api/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "settings-apply" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const turnRes = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "hello", clientMessageId: "settings-1" }),
    });
    expect(turnRes.status).toBe(202);
    const { turn } = (await turnRes.json()) as { turn: { model: string | null; effort: string | null } };
    expect(turn.model).toBe("gpt-6-sol");
    expect(turn.effort).toBe("high");

    await new Promise((r) => setTimeout(r, 60));
    expect(h.codex.startedTurns.at(-1)?.model).toBe("gpt-6-sol");
    h.codex.completeTurn(h.codex.startedTurns.at(-1)!.turnId);
    await h.request("/api/settings", { method: "PUT", headers, body: JSON.stringify({ model: null, effort: null }) });
  });

  it("ignores model/effort sent by an older client so the saved config always wins", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    await h.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "gpt-6-sol", effort: "high" }),
    });

    const created = await h.request("/api/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "legacy-client" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const turnRes = await h.request(`/api/conversations/${conversation.id}/turns`, {
      method: "POST",
      headers,
      // A pre-upgrade page would still send these; they must not override.
      body: JSON.stringify({ text: "hi", clientMessageId: "legacy-1", model: "gpt-5.5", effort: "low" }),
    });
    expect(turnRes.status).toBe(202);
    const { turn } = (await turnRes.json()) as { turn: { model: string | null; effort: string | null } };
    expect(turn.model).toBe("gpt-6-sol");
    expect(turn.effort).toBe("high");

    await new Promise((r) => setTimeout(r, 60));
    expect(h.codex.startedTurns.at(-1)?.model).toBe("gpt-6-sol");
    h.codex.completeTurn(h.codex.startedTurns.at(-1)!.turnId);
    await h.request("/api/settings", { method: "PUT", headers, body: JSON.stringify({ model: null, effort: null }) });
  });
});

describe("conversation management and sandbox browser tabs", () => {
  it("reuses a blank default conversation for an empty create and keeps explicit titles separate", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };

    const first = await h.request("/api/conversations", { method: "POST", headers, body: JSON.stringify({ title: "" }) });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { conversation: { id: string }; reused: boolean };
    expect(firstBody.reused).toBe(false);

    const second = await h.request("/api/conversations", { method: "POST", headers, body: JSON.stringify({ title: "   " }) });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { conversation: { id: string }; reused: boolean };
    expect(secondBody.reused).toBe(true);
    expect(secondBody.conversation.id).toBe(firstBody.conversation.id);

    const explicit = await h.request("/api/conversations", { method: "POST", headers, body: JSON.stringify({ title: "显式标题" }) });
    expect(explicit.status).toBe(201);
    const explicitBody = (await explicit.json()) as { conversation: { id: string }; reused: boolean };
    expect(explicitBody.reused).toBe(false);
    expect(explicitBody.conversation.id).not.toBe(firstBody.conversation.id);
  });

  it("returns 409 when restoring a blank default while another is already active", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    // Ensure one active blank default exists (created or reused from the other test).
    const active = await h.request("/api/conversations", { method: "POST", headers, body: JSON.stringify({ title: "" }) });
    expect([200, 201]).toContain(active.status);

    const now = Date.now();
    h.ctx.db
      .prepare(
        "INSERT INTO conversations (id, owner_id, title, model, cwd, status, archived, created_at, updated_at) VALUES ('conv_blank_archived', 'owner_1', '新会话', NULL, NULL, 'idle', 1, ?, ?)",
      )
      .run(now, now);
    const res = await h.request("/api/conversations/conv_blank_archived", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ archived: false }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("conversation_conflict");
    h.ctx.db.prepare("DELETE FROM conversations WHERE id = 'conv_blank_archived'").run();
  });

  it("returns 409 when a blank conversation is renamed onto the active default slot", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    // Ensure one active blank default exists (created or reused from a prior test).
    const active = await h.request("/api/conversations", { method: "POST", headers, body: JSON.stringify({ title: "" }) });
    expect([200, 201]).toContain(active.status);

    const created = await h.request("/api/conversations", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "将被改名" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string; title: string } };

    const conflict = await h.request(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "新会话" }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe("conversation_conflict");

    // A normal rename still works and is announced.
    const renamed = await h.request(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "改名成功" }),
    });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { conversation: { title: string } }).conversation.title).toBe("改名成功");
  });

  it("rejects a blank or over-long rename with 400 without touching the row or manual marker", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };

    const now = Date.now();
    h.ctx.db
      .prepare(
        "INSERT INTO conversations (id, owner_id, title, model, cwd, status, archived, created_at, updated_at) VALUES ('conv_title_guard', 'owner_1', '原始标题', NULL, NULL, 'idle', 0, ?, ?)",
      )
      .run(now, now);
    const manualKey = "title_manual:conv_title_guard";
    expect(h.ctx.db.prepare("SELECT value FROM meta WHERE key = ?").get(manualKey)).toBeUndefined();

    try {
      for (const bad of ["", "   ", "x".repeat(201), null, 42]) {
        const res = await h.request("/api/conversations/conv_title_guard", {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: bad }),
        });
        expect(res.status, `rejecting ${JSON.stringify(bad)}`).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("invalid_title");
      }

      // Neither the stored title nor the manual-title marker moved.
      const row = h.ctx.db.prepare("SELECT title FROM conversations WHERE id = 'conv_title_guard'").get() as { title: string };
      expect(row.title).toBe("原始标题");
      expect(h.ctx.db.prepare("SELECT value FROM meta WHERE key = ?").get(manualKey)).toBeUndefined();

      // A valid, trimmed title still renames and records the manual marker.
      const ok = await h.request("/api/conversations/conv_title_guard", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ title: `  ${"长".repeat(200)}  ` }),
      });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { conversation: { title: string } }).conversation.title).toBe("长".repeat(200));
      expect(h.ctx.db.prepare("SELECT value FROM meta WHERE key = ?").get(manualKey)).toBeTruthy();
    } finally {
      h.ctx.db.prepare("DELETE FROM events WHERE conversation_id = 'conv_title_guard'").run();
      h.ctx.db.prepare("DELETE FROM conversations WHERE id = 'conv_title_guard'").run();
      h.ctx.db.prepare("DELETE FROM meta WHERE key = ?").run(manualKey);
    }
  });

  it("has no delete endpoint for conversations", async () => {
    const { cookie, csrf } = await login(h);
    const created = await h.request("/api/conversations", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ title: "不可删除" }),
    });
    const { conversation } = (await created.json()) as { conversation: { id: string } };
    const res = await h.request(`/api/conversations/${conversation.id}`, {
      method: "DELETE",
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(res.status).toBe(404);
  });

  it("orders the conversation list by latest message activity, not updated_at", async () => {
    const { cookie } = await login(h);
    const db = h.ctx.db;
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const blank = `conv_sort_${suffix}_blank`;
    const old = `conv_sort_${suffix}_old`;
    const recent = `conv_sort_${suffix}_recent`;
    const base = Date.now();
    const ids = [blank, old, recent];
    const insertConv = db.prepare(
      "INSERT INTO conversations (id, owner_id, title, model, cwd, status, archived, created_at, updated_at) VALUES (?, 'owner_1', ?, NULL, '/home/gem/workspace', 'idle', 0, ?, ?)",
    );
    const insertTurn = db.prepare(
      "INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, created_at, completed_at) VALUES (?, ?, ?, 'completed', '', ?, ?)",
    );
    try {
      // Every row shares the same `updated_at`, so the old `updated_at DESC`
      // ordering could not have produced this result.
      insertConv.run(blank, "新会话", base - 5000, base);
      insertConv.run(old, "旧", base - 4000, base);
      insertConv.run(recent, "新", base - 3000, base);
      insertTurn.run(`turn_sort_${suffix}_old`, old, `cm_sort_${suffix}_old`, base - 4000, base - 4000);
      insertTurn.run(`turn_sort_${suffix}_recent`, recent, `cm_sort_${suffix}_recent`, base - 3000, base - 3000);

      const res = await h.request("/api/conversations", { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { conversations: Array<{ id: string; turnCount: number }> };
      const ordered = body.conversations.map((c) => c.id).filter((id) => ids.includes(id));
      expect(ordered).toEqual([blank, recent, old]);
      const blankRow = body.conversations.find((c) => c.id === blank);
      expect(blankRow?.turnCount).toBe(0);
    } finally {
      for (const id of ids) {
        db.prepare("DELETE FROM turns WHERE conversation_id = ?").run(id);
        db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      }
    }
  });

  it("does not pin an archived blank default in the archived list", async () => {
    const { cookie } = await login(h);
    const db = h.ctx.db;
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const archivedBlank = `conv_sort_${suffix}_ablank`;
    const archivedUsed = `conv_sort_${suffix}_aused`;
    const base = Date.now();
    const ids = [archivedBlank, archivedUsed];
    const insertConv = db.prepare(
      "INSERT INTO conversations (id, owner_id, title, model, cwd, status, archived, created_at, updated_at) VALUES (?, 'owner_1', ?, NULL, '/home/gem/workspace', 'idle', 1, ?, ?)",
    );
    try {
      insertConv.run(archivedBlank, "新会话", base - 5000, base);
      insertConv.run(archivedUsed, "有消息", base - 4000, base);
      db.prepare(
        "INSERT INTO turns (id, conversation_id, client_message_id, status, input_text, created_at, completed_at) VALUES (?, ?, ?, 'completed', '', ?, ?)",
      ).run(`turn_sort_${suffix}_aused`, archivedUsed, `cm_sort_${suffix}_aused`, base - 3000, base - 3000);

      const res = await h.request("/api/conversations?archived=1", { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { conversations: Array<{ id: string; archived: number }> };
      const ordered = body.conversations
        .filter((c) => c.archived === 1 && ids.includes(c.id))
        .map((c) => c.id);
      expect(ordered).toEqual([archivedUsed, archivedBlank]);
    } finally {
      for (const id of ids) {
        db.prepare("DELETE FROM turns WHERE conversation_id = ?").run(id);
        db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
      }
    }
  });

  it("opens an http/https link as a sandbox browser tab and rejects unsafe URLs", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };

    const ok = await h.request("/api/browser/tabs", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://example.com/a?b=1" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { ok: boolean }).ok).toBe(true);
    expect((JSON.parse(h.sandbox.lastBrowserTabBody()) as { url: string }).url).toBe("https://example.com/a?b=1");

    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.com/", "mailto:x@y.com", "not a url", ""]) {
      const res = await h.request("/api/browser/tabs", { method: "POST", headers, body: JSON.stringify({ url: bad }) });
      expect(res.status, `rejecting ${bad}`).toBe(400);
    }

    // A sandbox-side failure must surface, never be reported as success.
    h.sandbox.script.browserTab = { success: false, message: "模拟浏览器错误" };
    const failed = await h.request("/api/browser/tabs", {
      method: "POST",
      headers,
      body: JSON.stringify({ url: "https://example.com/" }),
    });
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { message: string }).message).toContain("模拟浏览器错误");
  });
});

describe("sandbox proxy", () => {
  it("denies unauthenticated access to the companion origin", async () => {
    const res = await h.request("/terminal", { host: "workspace" });
    expect(res.status).toBe(401);
    const api = await h.request("/v1/shell/exec", { host: "workspace", method: "POST" });
    expect(api.status).toBe(401);
  });

  it("accepts an API request with a forged X-Forwarded-Host only when it matches", async () => {
    const res = await h.request("/api/workspace/session", {
      host: "workspace",
      headers: { "x-forwarded-host": "evil.example.com" },
    });
    expect(res.status).toBe(404);
  });

  it("forwards requests with an intact raw body and strips control cookies", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const payload = JSON.stringify({ hello: "沙箱", nested: { n: 1 } });
    const res = await h.request("/echo/path?x=1", {
      host: "workspace",
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { url: string; method: string; headers: Record<string, string>; body: string };
    expect(echoed.url).toBe("/echo/path?x=1");
    expect(echoed.method).toBe("POST");
    expect(echoed.body).toBe(payload);
    expect(echoed.headers.cookie ?? "").not.toContain("pa_ws_session");
    expect(echoed.headers.authorization).toBeUndefined();
  });

  it("rewrites sandbox cookies and injects a narrow frame-ancestors policy", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const res = await h.request("/set-cookie", { host: "workspace", headers: { cookie } });
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("jupyter_token="))).toBe(true);
    expect(setCookies.some((c) => c.startsWith("pa_session="))).toBe(false);
    expect(setCookies.join(" ")).not.toContain("Domain=example.com");
    expect(res.headers.get("x-frame-options")).toBeNull();
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'self' https://agent.clawpage.ai");
    expect(csp).not.toContain("frame-ancestors 'none'");
  });

  it("denies cross-origin writes to the companion origin", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const res = await h.request("/echo", {
      host: "workspace",
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example.com" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("workspace bootstrap tickets", () => {
  it("issues a one-time ticket that sets a host-only cookie and clears the URL", async () => {
    const { cookie, csrf } = await login(h);
    const ticketRes = await h.request("/api/workspace/ticket", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ next: "/terminal" }),
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };

    const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}&next=%2Fterminal`, { host: "workspace" });
    expect(boot.status).toBe(303);
    expect(boot.headers.get("location")).toBe("/terminal");
    expect(boot.headers.get("cache-control")).toBe("no-store");
    expect(boot.headers.get("referrer-policy")).toBe("no-referrer");
    const setCookie = boot.headers.getSetCookie().join(" ");
    expect(setCookie).toContain("pa_ws_session=");
    expect(setCookie).not.toContain("Domain=");

    // Replay must fail: tickets are single use.
    const replay = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}`, { host: "workspace" });
    expect(replay.status).toBe(403);
  });

  it("rejects an open-redirect next parameter", async () => {
    const { cookie, csrf } = await login(h);
    const ticketRes = await h.request("/api/workspace/ticket", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ next: "//evil.example.com/steal" }),
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}&next=%2F%2Fevil.example.com`, {
      host: "workspace",
    });
    expect(boot.status).toBe(303);
    expect(boot.headers.get("location")).toBe("/");
  });

  it("refuses a ticket once the primary session is revoked", async () => {
    const { cookie, csrf } = await login(h);
    const ticketRes = await h.request("/api/workspace/ticket", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    const { ticket } = (await ticketRes.json()) as { ticket: string };
    await h.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: "{}",
    });
    const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}`, { host: "workspace" });
    expect(boot.status).toBe(403);
  });
});

describe("file manager failures are reported truthfully", () => {
  it("does not report mkdir success when the command fails", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.shell = {
      success: true,
      message: "Command executed",
      data: { session_id: "s1", status: "completed", exit_code: 1, output: "mkdir: cannot create directory" },
    };
    const res = await h.request("/api/files/mkdir", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/tmp-file/child" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("mkdir_failed");
    expect(body.message).toContain("退出码 1");
    h.sandbox.script.shell = undefined;
  });

  it("does not report mkdir success when the directory is not actually present", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.shell = {
      success: true,
      data: { session_id: "s1", status: "completed", exit_code: 0, output: "" },
    };
    h.sandbox.script.existingPaths = [];
    const res = await h.request("/api/files/mkdir", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/never-created" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("mkdir_unverified");
    h.sandbox.script.shell = undefined;
    h.sandbox.script.existingPaths = undefined;
  });

  it("reports a still-running command instead of claiming the deletion happened", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.shell = { success: true, data: { session_id: "s1", status: "running", output: "" } };
    // The process stays running even after polling, so success must never be claimed.
    h.sandbox.script.shellView = { success: true, data: { status: "running", output: "still going" } };
    const res = await h.request("/api/files/delete", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/still-running" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("delete_failed");
    h.sandbox.script.shell = undefined;
    h.sandbox.script.shellView = undefined;
  });

  it("does not report deletion when the path still exists afterwards", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.shell = { success: true, data: { session_id: "s1", status: "completed", exit_code: 0 } };
    h.sandbox.script.existingPaths = ["/home/gem/workspace/keep-me"];
    const res = await h.request("/api/files/delete", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/keep-me" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe("delete_unverified");
    h.sandbox.script.shell = undefined;
    h.sandbox.script.existingPaths = undefined;
  });

  it("surfaces a structured file write error", async () => {
    const { cookie, csrf } = await login(h);
    h.sandbox.script.writeError = true;
    const res = await h.request("/api/files/write", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/x.txt", content: "hi" }),
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { message: string }).message).toContain("EACCES");
    h.sandbox.script.writeError = false;
  });

  it("rejects non-absolute paths before touching the sandbox", async () => {
    const { cookie, csrf } = await login(h);
    const res = await h.request("/api/files/read?path=relative.txt", { headers: { cookie } });
    expect(res.status).toBe(400);
    void csrf;
  });
});

describe("companion session renewal across origins", () => {
  it("allows the control-plane origin to read and renew the companion session", async () => {
    const boot = await bootstrapWorkspaceWithSession(h);
    const primaryOrigin = `http://localhost:${h.primaryPort}`;

    const session = await h.request("/api/workspace/session", {
      host: "workspace",
      headers: { cookie: boot.cookie, origin: primaryOrigin },
    });
    expect(session.status).toBe(200);
    expect((await session.json()) as { authenticated: boolean }).toMatchObject({ authenticated: true });
    expect(session.headers.get("access-control-allow-origin")).toBe(primaryOrigin);
    expect(session.headers.get("access-control-allow-credentials")).toBe("true");

    const renew = await h.request("/api/workspace/refresh", {
      host: "workspace",
      method: "POST",
      headers: { cookie: boot.cookie, origin: primaryOrigin, "content-type": "application/json" },
      body: "{}",
    });
    expect(renew.status).toBe(200);
    const rotated = renew.headers.getSetCookie().find((c) => c.startsWith("pa_ws_session="))!.split(";")[0]!;
    expect((await h.request("/api/workspace/session", { host: "workspace", headers: { cookie: rotated } })).status).toBe(200);
  });

  it("refuses a foreign origin on the renewal endpoint", async () => {
    const boot = await bootstrapWorkspaceWithSession(h);
    const res = await h.request("/api/workspace/refresh", {
      host: "workspace",
      method: "POST",
      headers: { cookie: boot.cookie, origin: "https://evil.example.com", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("keeps sandbox writes closed to the control-plane origin", async () => {
    const boot = await bootstrapWorkspaceWithSession(h);
    const res = await h.request("/echo", {
      host: "workspace",
      method: "POST",
      headers: {
        cookie: boot.cookie,
        origin: `http://localhost:${h.primaryPort}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ a: 1 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("websocket proxy", () => {
  it("denies unauthenticated and cross-origin upgrades", async () => {
    const anon = await rawUpgrade(h.primaryPort, "/v1/shell/ws", { Origin: "http://127.0.0.1:1" });
    expect(anon.statusLine).toContain("401");

    const { cookie } = await bootstrapWorkspace(h);
    const badOrigin = await rawUpgrade(h.primaryPort, "/v1/shell/ws", {
      Origin: "https://evil.example.com",
      Cookie: cookie,
    });
    expect(badOrigin.statusLine).toContain("403");
  });

  it("proxies an authenticated upgrade and filters handshake cookies", async () => {
    const { cookie } = await bootstrapWorkspace(h);
    const result = await rawUpgrade(h.primaryPort, "/v1/shell/ws", {
      Origin: `http://127.0.0.1:${h.primaryPort}`,
      Cookie: `${cookie}; jupyter_token=keep`,
    });
    expect(result.statusLine).toContain("101");
    expect(result.data).toContain("hello-from-sandbox");
  });

  it("closes an established websocket when the session is revoked", async () => {
    const boot = await bootstrapWorkspaceWithSession(h);
    const socket = net.connect(h.primaryPort, "127.0.0.1");
    let closed = false;
    let handshake = false;
    socket.on("close", () => {
      closed = true;
    });
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => {
      socket.on("connect", () => {
        socket.write(
          [
            "GET /v1/shell/ws HTTP/1.1",
            `Host: 127.0.0.1:${h.primaryPort}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "Sec-WebSocket-Version: 13",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            `Origin: http://127.0.0.1:${h.primaryPort}`,
            `Cookie: ${boot.cookie}`,
            "",
            "",
          ].join("\r\n"),
        );
      });
      socket.on("data", () => {
        handshake = true;
        resolve();
      });
      setTimeout(resolve, 1000).unref?.();
    });
    expect(handshake).toBe(true);
    // Wait past the guard's first liveness tick is not required: revocation is event driven.
    h.ctx.sessions.revoke(boot.sessionId, "logout");
    const deadline = Date.now() + 3000;
    while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(closed).toBe(true);
    socket.destroy();
  });
});

describe("sandbox upload and agent status", () => {
  it("relays a synthetic attachment into the sandbox and reports its kind", async () => {
    const { cookie, csrf } = await login(h);
    const bytes = Buffer.from("synthetic-attachment-content");
    const res = await h.request("/api/sandbox/upload", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "note.txt", mime: "text/plain", contentBase64: bytes.toString("base64") }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; name: string; kind: string; size: number };
    expect(body.name).toBe("note.txt");
    expect(body.kind).toBe("file");
    expect(body.size).toBe(bytes.byteLength);
    expect(body.path.startsWith("/home/gem/workspace/uploads/")).toBe(true);
    expect(body.path.endsWith("-note.txt")).toBe(true);
    // The bytes really reached the sandbox upload endpoint.
    expect(h.sandbox.lastUploadBody()).toContain("synthetic-attachment-content");
    // The default uploads directory is created and verified before uploading.
    expect(h.sandbox.lastShellCommand()).toContain("mkdir -p -- '/home/gem/workspace/uploads'");
  });

  it("classifies an image attachment and rejects a missing payload", async () => {
    const { cookie, csrf } = await login(h);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const ok = await h.request("/api/sandbox/upload", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "pixel.png", mime: "image/png", contentBase64: png.toString("base64") }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { kind: string }).kind).toBe("image");

    const empty = await h.request("/api/sandbox/upload", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ name: "", contentBase64: "" }),
    });
    expect(empty.status).toBe(400);
  });

  it("honours an explicit upload dir and never overwrites a same-named upload", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    const body = { name: "note.txt", mime: "text/plain", contentBase64: Buffer.from("x").toString("base64"), dir: "/home/gem/workspace/projects/demo" };
    const first = await h.request("/api/sandbox/upload", { method: "POST", headers, body: JSON.stringify(body) });
    const second = await h.request("/api/sandbox/upload", { method: "POST", headers, body: JSON.stringify(body) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstPath = ((await first.json()) as { path: string }).path;
    const secondPath = ((await second.json()) as { path: string }).path;
    expect(firstPath.startsWith("/home/gem/workspace/projects/demo/")).toBe(true);
    expect(secondPath.startsWith("/home/gem/workspace/projects/demo/")).toBe(true);
    expect(firstPath).not.toBe(secondPath);
    // An explicit dir keeps the old contract: it is never auto-created, so the
    // API cannot be used to mkdir an arbitrary sandbox path.
    expect(h.sandbox.lastShellCommand()).not.toContain("/home/gem/workspace/projects/demo");
  });

  it("reports a failed attachment-directory creation instead of a fake success", async () => {
    const { cookie, csrf } = await login(h);
    const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
    const body = JSON.stringify({ name: "note.txt", contentBase64: Buffer.from("x").toString("base64") });
    h.sandbox.script.shell = { success: false, message: "模拟 mkdir 失败" };
    try {
      const res = await h.request("/api/sandbox/upload", { method: "POST", headers, body });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe("mkdir_failed");
    } finally {
      delete h.sandbox.script.shell;
    }

    // The command may succeed while the sandbox still does not report the dir.
    h.sandbox.script.existingPaths = [];
    try {
      const res = await h.request("/api/sandbox/upload", { method: "POST", headers, body });
      expect(res.status).toBe(502);
      expect(((await res.json()) as { error: string }).error).toBe("mkdir_unverified");
    } finally {
      delete h.sandbox.script.existingPaths;
    }
  });

  it("exposes activeTurns and capacity in the agent status", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/status", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agent: { activeTurns: unknown[]; capacity: number } };
    expect(Array.isArray(body.agent.activeTurns)).toBe(true);
    expect(body.agent.capacity).toBeGreaterThanOrEqual(1);
  });
});

/** Obtain a workspace session cookie by redeeming a real bootstrap ticket. */
async function bootstrapWorkspace(h: TestHarness): Promise<{ cookie: string }> {
  const boot = await bootstrapWorkspaceWithSession(h);
  return { cookie: boot.cookie };
}

async function bootstrapWorkspaceWithSession(h: TestHarness): Promise<{ cookie: string; sessionId: string }> {
  const { cookie: primaryCookie, csrf } = await login(h);
  const ticketRes = await h.request("/api/workspace/ticket", {
    method: "POST",
    headers: { cookie: primaryCookie, "x-csrf-token": csrf, "content-type": "application/json" },
    body: "{}",
  });
  const { ticket } = (await ticketRes.json()) as { ticket: string };
  const boot = await h.request(`/_bootstrap?ticket=${encodeURIComponent(ticket)}`, { host: "workspace" });
  const cookie = boot.headers
    .getSetCookie()
    .filter((c) => c.startsWith("pa_ws_session="))
    .map((c) => c.split(";")[0])
    .join("; ");
  const row = h.ctx.db
    .prepare("SELECT id FROM sessions WHERE kind = 'workspace' ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string };
  return { cookie, sessionId: row.id };
}

describe("document endpoints", () => {
  it("creates and closes only explicit terminal sessions with auth, CSRF and upstream failure handling",async()=>{
    const route='/api/sandbox/shell-sessions';
    const before=h.sandbox.requests.length;
    expect((await h.request(route,{method:'POST',body:'{}'})).status).toBe(401);
    expect((await h.request(route+'/session-a',{method:'DELETE'})).status).toBe(401);
    const {cookie,csrf}=await login(h);
    expect((await h.request(route+'/session-a',{method:'DELETE',headers:{cookie}})).status).toBe(403);
    expect(h.sandbox.requests.slice(before).filter(r=>r.url.includes('/shell/sessions'))).toHaveLength(0);
    const headers={cookie,'x-csrf-token':csrf,'content-type':'application/json'};
    expect((await h.request(route+'/%2e%2e%2fother',{method:'DELETE',headers})).status).toBe(400);
    const create=await h.request(route,{method:'POST',headers,body:'{}'});expect(create.status).toBe(201);
    expect((await create.json() as any).id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await h.request(route+'/session-a',{method:'DELETE',headers})).status).toBe(200);
    const deletes=h.sandbox.requests.slice(before).filter(r=>r.method==='DELETE');
    expect(deletes.map(r=>r.url)).toEqual(['/v1/shell/sessions/session-a']);
    h.sandbox.script.shellSessionMutation={success:false};
    try {
      expect((await h.request(route+'/session-a',{method:'DELETE',headers})).status).toBe(502);
      expect((await h.request(route,{method:'POST',headers,body:'{}'})).status).toBe(502);
    }finally{delete h.sandbox.script.shellSessionMutation;}
  });
  it("lists authenticated live terminal sessions without leaking command contents or creating sessions",async()=>{
    const get=vi.spyOn(h.ctx.aio,'get').mockResolvedValue({success:true,data:{sessions:{alpha:{status:'running',working_dir:'/home/gem/workspace',last_used_at:'2026-09-29T01:00:00Z',current_command:'private command'},beta:{status:'completed'},old:{status:'closed'}}}});
    try {
      expect((await h.request('/api/sandbox/shell-sessions')).status).toBe(401);expect(get).not.toHaveBeenCalled();
      const {cookie}=await login(h);
      const res=await h.request('/api/sandbox/shell-sessions',{headers:{cookie}});
      expect(res.status).toBe(200);expect(res.headers.get('cache-control')).toBe('no-store');
      const data=await res.json() as {sessions:Array<{id:string}>};expect(data.sessions.map(s=>s.id)).toEqual(['alpha','beta']);expect(JSON.stringify(data)).not.toContain('private command');
      expect(get).toHaveBeenCalledWith('/v1/shell/sessions');
      get.mockResolvedValue({success:false,data:null});expect((await h.request('/api/sandbox/shell-sessions',{headers:{cookie}})).status).toBe(502);
      get.mockResolvedValue({success:true,data:{sessions:[]}});expect((await h.request('/api/sandbox/shell-sessions',{headers:{cookie}})).status).toBe(502);
    } finally {get.mockRestore();}
  });
  it("authenticates video streams, validates paths, and preserves range/HEAD responses",async()=>{
    const {cookie}=await login(h);
    const video=vi.spyOn(h.ctx.documents,'video').mockImplementation(async(_path,range,head)=>new Response(head?null:'part',{
      status:206,headers:{'content-length':'4','content-range':'bytes 2-5/100'}
    }));
    try {
      const url='/api/documents/video?path=/home/gem/workspace/movie.mp4';
      expect((await h.request(url)).status).toBe(401);
      expect((await h.request('/api/documents/video?path=/etc/private.mp4',{headers:{cookie}})).status).toBe(400);
      expect(video).not.toHaveBeenCalled();
      const res=await h.request(url,{headers:{cookie,range:'bytes=2-5'}});
      expect(res.status).toBe(206);expect(res.headers.get('content-type')).toBe('video/mp4');expect(res.headers.get('content-range')).toBe('bytes 2-5/100');expect(res.headers.get('accept-ranges')).toBe('bytes');expect(res.headers.get('content-disposition')).toBe('inline');expect(res.headers.get('cache-control')).toBe('no-store');expect(await res.text()).toBe('part');
      expect(video.mock.calls[0]![1]).toBe('bytes=2-5');
      const head=await h.request(url,{method:'HEAD',headers:{cookie}});expect(head.status).toBe(206);expect(await head.text()).toBe('');expect(video.mock.calls.at(-1)![2]).toBe(true);
      video.mockResolvedValue(new Response(null,{status:416,headers:{'content-range':'bytes */100'}}));
      const bad=await h.request(url,{headers:{cookie,range:'bytes=999-'}});expect(bad.status).toBe(416);expect(bad.headers.get('content-range')).toBe('bytes */100');
    } finally {video.mockRestore();}
  });
  it("serves HTML only with origin isolation, no network and size/path guards", async () => {
    const {cookie}=await login(h);
    const {cookie:wsCookie}=await bootstrapWorkspace(h);
    const text=vi.spyOn(h.ctx.documents,"text").mockResolvedValue({text:"<h1>Demo</h1><script>document.title='demo'</script>",size:65,truncated:false});
    try {
      expect((await h.request("/api/documents/html?path=/home/gem/workspace/demo.html",{headers:{cookie}})).status).toBe(404);
      expect((await h.request("/api/documents/html?path=/home/gem/workspace/demo.html",{host:"workspace"})).status).toBe(401);
      const res=await h.request("/api/documents/html?path=/home/gem/workspace/demo.html",{host:"workspace",headers:{cookie:wsCookie}});
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const csp=res.headers.get("content-security-policy")!;
      expect(csp).toContain("sandbox allow-scripts");expect(csp).not.toContain("allow-same-origin");
      expect(csp).toContain("connect-src 'none'");expect(csp).toContain("default-src 'none'");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.text()).toContain("<h1>Demo");
      for(const path of ["/etc/secret.html","/home/gem/workspace/a.svg"]){
        expect((await h.request(`/api/documents/html?path=${encodeURIComponent(path)}`,{host:"workspace",headers:{cookie:wsCookie}})).status).toBe(400);
      }
      text.mockResolvedValue({text:"partial",size:999999,truncated:true});
      expect((await h.request("/api/documents/html?path=/home/gem/workspace/demo.html",{host:"workspace",headers:{cookie:wsCookie}})).status).toBe(413);
    } finally {text.mockRestore();}
  });
  it("requires a session for every document route", async () => {
    for (const path of [
      "/api/documents/readiness",
      "/api/documents/info?path=/home/gem/workspace/a.docx",
      "/api/documents/render?path=/home/gem/workspace/a.docx",
      "/api/documents/page?path=/home/gem/workspace/a.docx&page=1",
      "/api/documents/image?path=/home/gem/workspace/a.png",
      "/api/documents/text?path=/home/gem/workspace/a.txt",
    ]) {
      const res = await h.request(path);
      expect(res.status, path).toBe(401);
    }
    const post = await h.request("/api/documents/provision", { method: "POST", body: "{}" });
    expect(post.status).toBe(401);
    const convert = await h.request("/api/documents/convert", {
      method: "POST",
      body: JSON.stringify({ path: "/home/gem/workspace/a.docx", format: "pdf" }),
    });
    expect(convert.status).toBe(401);
  });

  it("rejects a path outside the workspace before touching the sandbox", async () => {
    const { cookie } = await login(h);
    for (const path of [
      "/etc/passwd",
      "/home/gem/workspace/../etc/passwd",
      "/home/gem/workspace-evil/x.png",
      "relative/x.png",
      "",
      "/home/gem/workspace",
    ]) {
      const res = await h.request(`/api/documents/info?path=${encodeURIComponent(path)}`, {
        headers: { cookie },
      });
      expect(res.status, path).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error, path).toBe("outside_workspace");
    }
  });

  it("rejects a control character or option-looking segment in the path", async () => {
    const { cookie } = await login(h);
    for (const path of ["/home/gem/workspace/a\u0000b.png", "/home/gem/workspace/-rf.png"]) {
      const res = await h.request(`/api/documents/info?path=${encodeURIComponent(path)}`, {
        headers: { cookie },
      });
      expect(res.status, path).toBe(400);
    }
  });

  it("rejects an unsupported conversion target with a client error, not a 500", async () => {
    const { cookie, csrf } = await login(h);
    const res = await h.request("/api/documents/convert", {
      method: "POST",
      headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" },
      body: JSON.stringify({ path: "/home/gem/workspace/a.docx", format: "exe" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("bad_request");
  });

  it("answers readiness as data even when the sandbox cannot be reached", async () => {
    const { cookie } = await login(h);
    const res = await h.request("/api/documents/readiness", { headers: { cookie } });
    // The fake container stub has no exec seam, so readiness reports an error as
    // data with HTTP 200: a broken document toolchain must never break chat.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; ready: boolean };
    expect(typeof body.ready).toBe("boolean");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe('SOUL.md configuration',()=>{
 it('requires auth and CSRF, persists content and protects concurrent edits',async()=>{
  expect((await h.request('/api/settings/soul')).status).toBe(401);
  const {cookie,csrf}=await login(h);
  const initial=await h.request('/api/settings/soul',{headers:{cookie}});
  expect(initial.headers.get('cache-control')).toBe('no-store');
  const doc=await initial.json() as {revision:string;content:string};
  const headers={cookie,origin:`http://localhost:${h.primaryPort}`,'content-type':'application/json','x-csrf-token':csrf};
  const body=JSON.stringify({content:'# SOUL\n我的个人助理。\n',revision:doc.revision});
  expect((await h.request('/api/settings/soul',{method:'PUT',headers:{...headers,'x-csrf-token':''},body})).status).toBe(403);
  const saved=await h.request('/api/settings/soul',{method:'PUT',headers,body});expect(saved.status).toBe(200);
  const value=await saved.json() as {revision:string;content:string};
  expect((await (await h.request('/api/settings/soul',{headers:{cookie}})).json() as any).content).toBe(value.content);
  expect((await h.request('/api/settings/soul',{method:'PUT',headers,body})).status).toBe(409);
  expect((await h.request('/api/settings/soul',{method:'PUT',headers,body:JSON.stringify({revision:value.revision,content:'x'.repeat(65537)})})).status).toBe(400);
  expect((await h.request('/api/settings/soul',{method:'PUT',headers,body:JSON.stringify({revision:value.revision,content:doc.content})})).status).toBe(200);
 });
});

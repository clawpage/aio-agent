import { describe, expect, it } from "vitest";
import { classifyHost, clientIp, originAllowed, hostnameOf } from "../../src/server/http/security.js";
import { filterUpstreamCookie, frameAncestorsValue, rewriteSetCookie, sanitizeResponseHeaders } from "../../src/server/http/proxy.js";
import { safeRedirectPath } from "../../src/server/auth/tickets.js";
import { loadConfig } from "../../src/server/config.js";
import type { IncomingMessage } from "node:http";

function cfg() {
  return loadConfig();
}

describe("host classification", () => {
  it("maps the configured hosts and the loopback dev pair", () => {
    const c = cfg();
    expect(classifyHost(c, "agent.clawpage.ai")).toBe("primary");
    expect(classifyHost(c, "agent-workspace.clawpage.ai")).toBe("workspace");
    expect(classifyHost(c, "localhost:4891")).toBe("primary");
    expect(classifyHost(c, "127.0.0.1:4891")).toBe("workspace");
  });

  it("rejects unknown hosts and host:port mismatches", () => {
    const c = cfg();
    expect(classifyHost(c, "evil.example.com")).toBeNull();
    expect(classifyHost(c, "agent.clawpage.ai.evil.com")).toBeNull();
    expect(classifyHost(c, "")).toBeNull();
    expect(classifyHost(c, "agent.clawpage.ai:4443")).toBeNull();
  });

  it("strips ports for hostname comparison", () => {
    expect(hostnameOf("agent.clawpage.ai:443")).toBe("agent.clawpage.ai");
    expect(hostnameOf("[::1]:4891")).toBe("[::1]");
  });
});

describe("origin allowlisting", () => {
  it("allows only the configured origins per site", () => {
    const c = cfg();
    expect(originAllowed(c, "primary", "https://agent.clawpage.ai")).toBe(true);
    expect(originAllowed(c, "primary", "https://agent.clawpage.ai/")).toBe(true);
    expect(originAllowed(c, "primary", "https://agent-workspace.clawpage.ai")).toBe(false);
    expect(originAllowed(c, "workspace", "https://agent-workspace.clawpage.ai")).toBe(true);
    expect(originAllowed(c, "primary", "https://evil.example.com")).toBe(false);
    expect(originAllowed(c, "primary", "null")).toBe(false);
    expect(originAllowed(c, "primary", null)).toBe(false);
  });
});

describe("client IP trust", () => {
  const req = (headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: "10.0.0.5" } }) as unknown as IncomingMessage;

  it("ignores spoofable forwarded headers by default", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }), false)).toBe("10.0.0.5");
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4" }), false)).toBe("10.0.0.5");
  });

  it("honours CF-Connecting-IP only in trusted tunnel mode", () => {
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }), true)).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9" }), true)).toBe("10.0.0.5");
  });
});

describe("bootstrap redirect safety", () => {
  it("keeps same-site absolute paths", () => {
    expect(safeRedirectPath("/vnc/vnc.html")).toBe("/vnc/vnc.html");
    expect(safeRedirectPath("/a?b=c")).toBe("/a?b=c");
  });

  it("rejects protocol-relative, absolute, backslash and control-character targets", () => {
    expect(safeRedirectPath("//evil.com")).toBe("/");
    expect(safeRedirectPath("https://evil.com")).toBe("/");
    expect(safeRedirectPath("/\\evil.com")).toBe("/");
    expect(safeRedirectPath("/%5Cevil.com")).toBe("/");
    expect(safeRedirectPath("/\u0000bad")).toBe("/");
    expect(safeRedirectPath(undefined)).toBe("/");
  });
});

describe("sandbox cookie rewriting", () => {
  it("drops cookies that collide with control-plane cookie names", () => {
    expect(rewriteSetCookie("pa_session=evil; Path=/", true)).toBeNull();
    expect(rewriteSetCookie("pa_csrf=evil; Path=/", true)).toBeNull();
    expect(rewriteSetCookie("pa_ws_session=evil; Path=/", true)).toBeNull();
  });

  it("forces host-only, SameSite=Lax cookies and keeps Secure on https", () => {
    const rewritten = rewriteSetCookie("jupyter_token=abc; Domain=example.com; Path=/lab; HttpOnly", true)!;
    expect(rewritten).toContain("jupyter_token=abc");
    expect(rewritten).not.toContain("Domain=");
    expect(rewritten).toContain("Path=/lab");
    expect(rewritten).toContain("HttpOnly");
    expect(rewritten).toContain("SameSite=Lax");
    expect(rewritten).toContain("Secure");
  });

  it("omits Secure on loopback http so local testing works", () => {
    expect(rewriteSetCookie("a=b; Path=/", false)).not.toContain("Secure");
  });
});

describe("upstream cookie filtering", () => {
  it("removes control cookies but keeps sandbox cookies", () => {
    const filtered = filterUpstreamCookie("pa_session=x; pa_ws_csrf=y; jupyter_token=keep; other=1")!;
    expect(filtered).toContain("jupyter_token=keep");
    expect(filtered).toContain("other=1");
    expect(filtered).not.toContain("pa_session");
    expect(filtered).not.toContain("pa_ws_csrf");
  });

  it("returns undefined when nothing is left", () => {
    expect(filterUpstreamCookie("pa_session=x")).toBeUndefined();
    expect(filterUpstreamCookie(undefined)).toBeUndefined();
  });
});

describe("response header sanitisation", () => {
  it("replaces X-Frame-Options with a narrow frame-ancestors policy and keeps other CSP directives", () => {
    const out = sanitizeResponseHeaders(cfg(), {
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
      "content-type": "text/html",
    }, true);
    expect(out["x-frame-options"]).toBeUndefined();
    const csp = out["content-security-policy"] as unknown as string[];
    expect(csp.join(" ")).toContain("default-src 'self'");
    expect(csp.join(" ")).not.toContain("frame-ancestors 'none'");
    expect(csp.join(" ")).toContain(frameAncestorsValue(cfg()));
    expect(out["content-type"]).toBe("text/html");
  });

  it("adds a frame-ancestors policy even when the sandbox sends none", () => {
    const out = sanitizeResponseHeaders(cfg(), { "content-type": "text/html" }, false);
    expect(out["content-security-policy"]).toBe(frameAncestorsValue(cfg()));
  });

  it("strips hop-by-hop headers", () => {
    const out = sanitizeResponseHeaders(cfg(), { connection: "keep-alive", "transfer-encoding": "chunked" }, false);
    expect(out.connection).toBeUndefined();
    expect(out["transfer-encoding"]).toBeUndefined();
  });
});

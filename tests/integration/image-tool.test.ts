import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { startHarness } from "../helpers/harness.js";
import { MemberModelGateway } from "../../src/control/memberModelGateway.js";
import { IMAGE_POLICY, ImageGateway, imageMcpServers, imageThreadServers, type ImageFiles } from "../../src/control/imageTool.js";
import { memberConfig } from "../../src/control/tenants.js";
import { codexRequirementsToml } from "../../src/control/sandbox/seed.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000020000000108020000007b40e8dd0000000f49444154789c63f8cfc0c0b0200000079101f0e7755c1d0000000049454e44ae426082", "hex");

it("gives every account an image tool that draws with the control plane's own login and saves into that account's workspace", async () => {
  const h = await startHarness();
  // A stand-in for ChatGPT's images endpoint.
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, any> }> = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { created: 1, data: [{ b64_json: PNG.toString("base64") }] } };
  const upstream = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    seen.push({ url: req.url!, headers: req.headers, body: JSON.parse(data) });
    res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  let invalidated = 0;
  const hostTokens = { getTokens: async () => ({ accessToken: "owner-chatgpt-access", chatgptAccountId: "acct_owner", planType: "prolite", expiresAt: Date.now() + 3600_000 }), invalidate: () => { invalidated += 1; } };
  // Each account's own workspace.
  const written = new Map<string, Map<string, Buffer>>();
  const filesFor = async (id: string): Promise<ImageFiles> => {
    const mine = written.get(id) ?? new Map<string, Buffer>();
    written.set(id, mine);
    return {
      read: async (file) => { if (!mine.has(file)) throw new Error("文件不存在或已被移动"); return { bytes: mine.get(file)!, contentType: "image/png" }; },
      write: async (file, bytes) => { mine.set(file, bytes); },
    };
  };
  const image = new ImageGateway({ port: 0, log: h.ctx.log, hostTokens, chatgptUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/backend-api/codex/`, workspace: "/home/gem/workspace", filesFor });
  const cfg = { ...h.ctx.cfg, memberModelPort: 0 };
  const gateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, hostTokens, image);
  await gateway.start();
  try {
    const owner = { ...cfg, runtimeUserId: "owner_1", dataDir: path.join(h.dataDir, "owner-runtime") };
    image.provision(owner);
    // A member never inherits the owner's tool: the gateway gives it one of its own.
    expect(memberConfig(owner, "user_m", 18092).image).toBeUndefined();
    const member = memberConfig(owner, "user_m", 18092);
    gateway.provision(member);
    expect(member.image!.url).toMatch(/^http:\/\/host\.docker\.internal:0\/image\/[a-f0-9]{64}\/mcp$/);
    expect(member.image!.url).not.toBe(owner.image!.url);
    expect(imageThreadServers(member)).toEqual({ aio_image: { url: member.image!.url, tool_timeout_sec: 330 } });
    expect(imageMcpServers(member)).toEqual({ aio_image: { type: "http", url: member.image!.url } });
    // Codex runs a thread's MCP server only when its exact URL is in the managed policy.
    expect(codexRequirementsToml(member)).toContain(`[mcp_servers.aio_image.identity]\nurl = "${member.image!.url}"\n`);
    // The login stays on the host: no file the member's runtime keeps holds it.
    for (const file of fs.readdirSync(member.dataDir)) expect(fs.readFileSync(path.join(member.dataDir, file), "utf8")).not.toContain("owner-chatgpt-access");

    const local = (url: string) => url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${gateway.port}`);
    const rpc = (url: string, body: unknown) => fetch(local(url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const call = async (url: string, args: Record<string, unknown>) => (await (await rpc(url, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "image_generate", arguments: args } })).json()).result as { content: Array<{ text: string }>; isError?: boolean };
    expect((await rpc(member.image!.url.replace(/[a-f0-9]{64}/, "f".repeat(64)), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    const init = await rpc(member.image!.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.headers.get("mcp-session-id")).toBeTruthy();
    expect((await init.json()).result).toMatchObject({ serverInfo: { name: "aio_image" }, instructions: IMAGE_POLICY });
    const tools = (await (await rpc(member.image!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["image_generate"]);

    // A new picture: the request Codex's imagegen makes, with the host's login added here; saved where asked.
    const poster = "/home/gem/workspace/tasks/task-1/海报.png";
    const made = await call(member.image!.url, { prompt: "一张秋天的海报，写着“周末快乐”", path: poster, size: "1024x1536" });
    expect(made.isError).toBeUndefined();
    expect(made.content[0]!.text).toContain(`![说明](${poster})`);
    expect(seen[0]).toMatchObject({ url: "/backend-api/codex/images/generations", body: { prompt: "一张秋天的海报，写着“周末快乐”", model: "gpt-image-2", background: "opaque", quality: "auto", size: "1024x1536" } });
    expect(seen[0]!.headers.authorization).toBe("Bearer owner-chatgpt-access");
    expect(seen[0]!.headers["chatgpt-account-id"]).toBe("acct_owner");
    expect(written.get("user_m")!.get(poster)).toEqual(PNG);
    expect(written.get("owner_1")).toBeUndefined();

    // A change to that picture sends it along as a reference, to the edits endpoint.
    const edited = await call(member.image!.url, { prompt: "背景改成雪天，其余不变", path: "/home/gem/workspace/tasks/task-1/海报-雪天.png", reference_paths: [poster], transparent_background: true });
    expect(edited.isError).toBeUndefined();
    expect(seen[1]).toMatchObject({ url: "/backend-api/codex/images/edits", body: { images: [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }], background: "transparent", model: "gpt-image-2" } });

    // Without a path it goes into the workspace's images folder; the owner's tool writes the owner's files.
    const plain = await call(owner.image!.url, { prompt: "一只猫" });
    expect(plain.content[0]!.text).toMatch(/图片已保存：\/home\/gem\/workspace\/images\/\d{8}-\d{6}-[0-9a-f]{6}\.png/);
    expect([...written.get("owner_1")!.keys()]).toHaveLength(1);

    // Nothing outside the workspace, nothing but .png, no SVG or missing references.
    for (const [args, message] of [
      [{ prompt: "x", path: "/etc/x.png" }, "只允许访问沙箱工作区内的文件"],
      [{ prompt: "x", path: "/home/gem/workspace/../.codex/x.png" }, "只允许访问沙箱工作区内的文件"],
      [{ prompt: "x", path: "/home/gem/workspace/a.jpg" }, ".png"],
      [{ prompt: "" }, "缺少 prompt"],
      [{ prompt: "x", reference_paths: ["/home/gem/workspace/none.png"] }, "文件不存在"],
      [{ prompt: "x", reference_paths: Array(6).fill(poster) }, "最多 5 张"],
    ] as const) {
      const failed = await call(member.image!.url, args);
      expect(failed.isError).toBe(true);
      expect(failed.content[0]!.text).toContain(message);
    }
    expect(seen).toHaveLength(3);

    // A refused login is fetched afresh next time; a used-up quota says so plainly; never a non-PNG file.
    answer = { status: 401, body: { error: "expired" } };
    expect((await call(member.image!.url, { prompt: "x" })).isError).toBe(true);
    expect(invalidated).toBe(1);
    answer = { status: 429, body: { error: "rate limited" } };
    expect((await call(member.image!.url, { prompt: "x" })).content[0]!.text).toContain("额度");
    answer = { status: 200, body: { created: 1, data: [{ b64_json: Buffer.from("<html>").toString("base64") }] } };
    expect((await call(member.image!.url, { prompt: "x", path: "/home/gem/workspace/tasks/task-1/bad.png" })).content[0]!.text).toContain("没有返回 PNG");
    expect(written.get("user_m")!.has("/home/gem/workspace/tasks/task-1/bad.png")).toBe(false);
  } finally {
    gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    await h.shutdown();
  }
});

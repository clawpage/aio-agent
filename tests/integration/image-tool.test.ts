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
const GIF = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");

it("gives every account an image tool that draws with the control plane's own login and saves into that account's workspace", async () => {
  const h = await startHarness();
  // A stand-in for ChatGPT's images endpoint.
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: Record<string, any> }> = [];
  let answer: { status: number; body: unknown } = { status: 200, body: { created: 1, data: [{ b64_json: PNG.toString("base64") }] } };
  // A model the endpoint does not offer (yet).
  let unknownModel: string | undefined;
  const upstream = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    seen.push({ url: req.url!, headers: req.headers, body });
    if (unknownModel && body.model === unknownModel) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Invalid value: '${unknownModel}'.`, type: "invalid_request_error", param: "model", code: "invalid_value" } }));
      return;
    }
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
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  // GIFs go to the public Images API with the deployment's OpenAI key; the same stand-in answers both.
  const image = new ImageGateway({ port: 0, log: h.ctx.log, hostTokens, chatgptUrl: `${upstreamUrl}/backend-api/codex/`, openaiApiKey: "sk-test-openai", openaiUrl: `${upstreamUrl}/v1`, workspace: "/home/gem/workspace", filesFor });
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
    // A real photo of people is retouched with the aio-photo skill, never redrawn by the image model.
    expect(IMAGE_POLICY).toContain("never redrawn with image_generate");
    expect(IMAGE_POLICY).toContain("aio-photo skill");
    // ...but what retouching cannot fix is not held back from the image model.
    expect(IMAGE_POLICY).toContain("Do not hold back from image_generate on a photo");
    expect(IMAGE_POLICY).toContain("deliver only when nothing shows");
    const tools = (await (await rpc(member.image!.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["image_generate"]);

    // A new picture: the request Codex's imagegen makes, with the host's login added here; saved where asked.
    const poster = "/home/gem/workspace/tasks/task-1/海报.png";
    const made = await call(member.image!.url, { prompt: "一张秋天的海报，写着“周末快乐”", path: poster, size: "1024x1536" });
    expect(made.isError).toBeUndefined();
    expect(made.content[0]!.text).toContain(`![description](${poster})`);
    expect(seen[0]).toMatchObject({ url: "/backend-api/codex/images/generations", body: { prompt: "一张秋天的海报，写着“周末快乐”", model: "gpt-image-2.6-sunburst", background: "opaque", quality: "auto", size: "1024x1536" } });
    expect(seen[0]!.headers.authorization).toBe("Bearer owner-chatgpt-access");
    expect(seen[0]!.headers["chatgpt-account-id"]).toBe("acct_owner");
    expect(written.get("user_m")!.get(poster)).toEqual(PNG);
    expect(written.get("owner_1")).toBeUndefined();

    // A change to that picture sends it along as a reference, to the edits endpoint.
    const edited = await call(member.image!.url, { prompt: "背景改成雪天，其余不变", path: "/home/gem/workspace/tasks/task-1/海报-雪天.png", reference_paths: [poster], transparent_background: true });
    expect(edited.isError).toBeUndefined();
    expect(seen[1]).toMatchObject({ url: "/backend-api/codex/images/edits", body: { images: [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }], background: "transparent", model: "gpt-image-2.6-sunburst" } });

    // Without a path it goes into the workspace's images folder; the owner's tool writes the owner's files.
    const plain = await call(owner.image!.url, { prompt: "一只猫" });
    expect(plain.content[0]!.text).toMatch(/Image saved: \/home\/gem\/workspace\/images\/\d{8}-\d{6}-[0-9a-f]{6}\.png/);
    expect([...written.get("owner_1")!.keys()]).toHaveLength(1);

    // Nothing outside the workspace, nothing but .png, no SVG or missing references.
    for (const [args, message] of [
      [{ prompt: "x", path: "/etc/x.png" }, "Only files inside the sandbox workspace can be accessed"],
      [{ prompt: "x", path: "/home/gem/workspace/../.codex/x.png" }, "Only files inside the sandbox workspace can be accessed"],
      [{ prompt: "x", path: "/home/gem/workspace/a.jpg" }, ".png"],
      [{ prompt: "" }, "Missing prompt"],
      [{ prompt: "x", reference_paths: ["/home/gem/workspace/none.png"] }, "文件不存在"],
      [{ prompt: "x", reference_paths: Array(6).fill(poster) }, "at most 5 images"],
    ] as const) {
      const failed = await call(member.image!.url, args);
      expect(failed.isError).toBe(true);
      expect(failed.content[0]!.text).toContain(message);
    }
    expect(seen).toHaveLength(3);

    // An endpoint that does not offer GPT Image 2.6 yet: the picture is drawn with gpt-image-2 instead.
    unknownModel = "gpt-image-2.6-sunburst";
    const fallback = await call(member.image!.url, { prompt: "一只狗", path: "/home/gem/workspace/tasks/task-1/狗.png" });
    expect(fallback.isError).toBeUndefined();
    expect(seen.slice(3).map((s) => s.body.model)).toEqual(["gpt-image-2.6-sunburst", "gpt-image-2"]);
    expect(written.get("user_m")!.get("/home/gem/workspace/tasks/task-1/狗.png")).toEqual(PNG);
    // A refused prompt is not a refused model: no second try.
    unknownModel = undefined;
    answer = { status: 400, body: { error: { message: "Your request was rejected by the safety system.", code: "moderation_blocked" } } };
    expect((await call(member.image!.url, { prompt: "x" })).content[0]!.text).toContain("refused");
    expect(seen).toHaveLength(6);

    // An animated GIF: one generations call asking GPT Image 2.6 for gif output, saved as .gif.
    expect(IMAGE_POLICY).toContain("animated set to true");
    answer = { status: 200, body: { created: 1, data: [{ b64_json: GIF.toString("base64") }] } };
    const gifPath = "/home/gem/workspace/tasks/task-1/招手.gif";
    const moving = await call(member.image!.url, { prompt: "一只小猫招手，循环", path: gifPath, animated: true, frame_count: 12, frame_duration_ms: 120, size: "1024x1024" });
    expect(moving.isError).toBeUndefined();
    expect(moving.content[0]!.text).toContain(`Animated GIF saved: ${gifPath}`);
    // The ChatGPT login's endpoint refuses GIF output, so this one goes to the public API with the OpenAI key, never the login.
    expect(seen[6]).toMatchObject({ url: "/v1/images/generations", body: { model: "gpt-image-2.6-sunburst", output_format: "gif", frame_count: 12, frame_duration_ms: 120, size: "1024x1024" } });
    expect(seen[6]!.headers.authorization).toBe("Bearer sk-test-openai");
    expect(seen[6]!.headers).not.toHaveProperty("chatgpt-account-id");
    expect(seen[6]!.body).not.toHaveProperty("background");
    expect(written.get("user_m")!.get(gifPath)).toEqual(GIF);
    // Defaults are the API's own; without a path it goes into images/ as a .gif.
    const plainGif = await call(member.image!.url, { prompt: "跳动的爱心", animated: true });
    expect(plainGif.content[0]!.text).toMatch(/Animated GIF saved: \/home\/gem\/workspace\/images\/\d{8}-\d{6}-[0-9a-f]{6}\.gif/);
    expect(seen[7]!.body).not.toHaveProperty("frame_count");
    expect(seen[7]!.body).toMatchObject({ output_format: "gif" });
    // Still images never carry gif fields.
    expect(seen[0]!.body).not.toHaveProperty("output_format");
    for (const [args, message] of [
      [{ prompt: "x", animated: true, path: "/home/gem/workspace/a.png" }, ".gif"],
      [{ prompt: "x", path: "/home/gem/workspace/a.gif" }, "set animated to true"],
      [{ prompt: "x", animated: true, reference_paths: [poster] }, "prompt only"],
      [{ prompt: "x", animated: true, transparent_background: true }, "transparent"],
      [{ prompt: "x", animated: true, frame_count: 65 }, "frame_count must be a whole number from 2 to 64"],
      [{ prompt: "x", animated: true, frame_duration_ms: 10 }, "frame_duration_ms must be a whole number from 20 to 2000"],
      [{ prompt: "x", frame_count: 4 }, "only for an animated GIF"],
    ] as const) {
      const failed = await call(member.image!.url, args);
      expect(failed.isError).toBe(true);
      expect(failed.content[0]!.text).toContain(message);
    }
    expect(seen).toHaveLength(8);
    // A PNG where a GIF was asked for is not saved under the .gif name.
    answer = { status: 200, body: { created: 1, data: [{ b64_json: PNG.toString("base64") }] } };
    expect((await call(member.image!.url, { prompt: "x", animated: true, path: "/home/gem/workspace/tasks/task-1/bad.gif" })).content[0]!.text).toContain("did not return a GIF");
    expect(written.get("user_m")!.has("/home/gem/workspace/tasks/task-1/bad.gif")).toBe(false);
    // A refused GIF is not retried with a model that cannot animate.
    unknownModel = "gpt-image-2.6-sunburst";
    const refusedGif = await call(member.image!.url, { prompt: "x", animated: true });
    expect(refusedGif.isError).toBe(true);
    expect(refusedGif.content[0]!.text).toContain("animated GIF request was refused");
    expect(seen).toHaveLength(10);
    unknownModel = undefined;
    // Without an OpenAI key there are no GIFs: said plainly, and nothing is sent.
    const keyless = new ImageGateway({ port: 0, log: h.ctx.log, hostTokens, chatgptUrl: `${upstreamUrl}/backend-api/codex/`, workspace: "/home/gem/workspace", filesFor });
    const keylessGateway = new MemberModelGateway(cfg, h.ctx.log, undefined, undefined, undefined, undefined, hostTokens, keyless);
    await keylessGateway.start();
    try {
      const other = memberConfig(owner, "user_k", 18093);
      keylessGateway.provision(other);
      const url = other.image!.url.replace(/^http:\/\/host\.docker\.internal:0/, `http://127.0.0.1:${keylessGateway.port}`);
      const answer = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "image_generate", arguments: { prompt: "x", animated: true } } }) })).json();
      expect(answer.result.isError).toBe(true);
      expect(answer.result.content[0].text).toContain("Animated GIFs are not available on this server");
      expect(seen).toHaveLength(10);
    } finally {
      keylessGateway.close();
    }

    // GPT Image 2.6: one marked part changed (a markup layer, low complexity), the fast model, and an SVG.
    answer = { status: 200, body: { created: 1, data: [{ b64_json: PNG.toString("base64") }] } };
    const layer = "/home/gem/workspace/tasks/task-1/海报-markup.png";
    written.get("user_m")!.set(layer, PNG);
    expect(IMAGE_POLICY).toContain("markup_path");
    const marked = await call(member.image!.url, { prompt: "去掉圈里的路人，其余不变，去掉红圈", path: "/home/gem/workspace/tasks/task-1/去路人.png", reference_paths: [poster], markup_path: layer, complexity: "low" });
    expect(marked.isError).toBeUndefined();
    // The ChatGPT login's endpoint takes markup edits itself.
    expect(seen[10]).toMatchObject({ url: "/backend-api/codex/images/edits", body: { images: [{ image_url: `data:image/png;base64,${PNG.toString("base64")}` }], markup: { image_url: `data:image/png;base64,${PNG.toString("base64")}` }, complexity: "low", model: "gpt-image-2.6-sunburst" } });
    expect(seen[10]!.headers.authorization).toBe("Bearer owner-chatgpt-access");
    await call(member.image!.url, { prompt: "一只猫的草图", fast: true });
    expect(seen[11]!.body).toMatchObject({ model: "gpt-image-2.6-flare" });
    expect(seen[11]!.body).not.toHaveProperty("complexity");
    expect(seen[11]!.body).not.toHaveProperty("markup");
    const SVG = '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
    answer = { status: 200, body: { created: 1, data: [{ b64_json: Buffer.from(SVG).toString("base64") }] } };
    const svgPath = "/home/gem/workspace/tasks/task-1/logo.svg";
    const vector = await call(member.image!.url, { prompt: "麦穗面包店的扁平 logo", path: svgPath, svg: true });
    expect(vector.content[0]!.text).toContain(`SVG saved: ${svgPath}`);
    // The ChatGPT login's endpoint answers SVG requests with a PNG, so SVGs go to the public API with the key.
    expect(seen[12]).toMatchObject({ url: "/v1/images/generations", body: { model: "gpt-image-2.6-sunburst", output_format: "svg", n: 1 } });
    expect(seen[12]!.headers.authorization).toBe("Bearer sk-test-openai");
    expect(seen[12]!.body).not.toHaveProperty("background");
    expect(seen[12]!.body).not.toHaveProperty("size");
    expect(written.get("user_m")!.get(svgPath)!.toString()).toBe(SVG);
    answer = { status: 200, body: { created: 1, data: [{ b64_json: PNG.toString("base64") }] } };
    expect((await call(member.image!.url, { prompt: "x", svg: true, path: "/home/gem/workspace/tasks/task-1/bad.svg" })).content[0]!.text).toContain("did not return an SVG");
    expect(written.get("user_m")!.has("/home/gem/workspace/tasks/task-1/bad.svg")).toBe(false);
    for (const [args, message] of [
      [{ prompt: "x", markup_path: layer }, "put that image in reference_paths"],
      [{ prompt: "x", reference_paths: [poster], markup_path: "/home/gem/workspace/none.png" }, "文件不存在"],
      [{ prompt: "x", reference_paths: [poster], markup_path: "/etc/markup.png" }, "markup_path: Only files inside the sandbox workspace"],
      [{ prompt: "x", svg: true, path: "/home/gem/workspace/a.png" }, ".svg"],
      [{ prompt: "x", svg: true, reference_paths: [poster] }, "prompt only"],
      [{ prompt: "x", svg: true, animated: true }, "Choose one"],
      [{ prompt: "x", complexity: "max" }, "complexity must be one of low, medium, high"],
      [{ prompt: "x", path: "/home/gem/workspace/a.svg" }, "svg to true"],
    ] as const) {
      const failed = await call(member.image!.url, args);
      expect(failed.isError).toBe(true);
      expect(failed.content[0]!.text).toContain(message);
    }
    expect(seen).toHaveLength(14);

    // A refused login is fetched afresh next time; a used-up quota says so plainly; never a non-PNG file.
    answer = { status: 401, body: { error: "expired" } };
    expect((await call(member.image!.url, { prompt: "x" })).isError).toBe(true);
    expect(invalidated).toBe(1);
    answer = { status: 429, body: { error: "rate limited" } };
    expect((await call(member.image!.url, { prompt: "x" })).content[0]!.text).toContain("quota");
    answer = { status: 200, body: { created: 1, data: [{ b64_json: Buffer.from("<html>").toString("base64") }] } };
    expect((await call(member.image!.url, { prompt: "x", path: "/home/gem/workspace/tasks/task-1/bad.png" })).content[0]!.text).toContain("did not return a PNG");
    expect(written.get("user_m")!.has("/home/gem/workspace/tasks/task-1/bad.png")).toBe(false);
  } finally {
    gateway.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    await h.shutdown();
  }
});

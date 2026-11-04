import crypto from "node:crypto";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { apnsSender } from "../../src/control/push.js";

// Apple's push service, played by a local HTTP/2 server: what arrives, and what it answers.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const received: Array<{ headers: http2.IncomingHttpHeaders; body: string }> = [];
let answer: { status: number; reason?: string } = { status: 200 };
let server: http2.Http2Server;
let origin = "";
beforeAll(async () => {
  server = http2.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.reason ? JSON.stringify({ reason: answer.reason }) : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const token = "ab".repeat(32);

it("posts the notification to the device with a signed token key, and reports Apple's refusals", async () => {
  const send = apnsSender({ key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), keyId: "ABCDE12345", teamId: "TEAM123456", topic: "ai.clawpage.agent", origins: { production: origin, development: origin } });
  expect(await send({ token, environment: "production" }, { title: "办完了：订机票", body: "已订好", tag: "task_1", url: "/" })).toEqual({ statusCode: 200, reason: undefined });
  const [first] = received;
  expect(first!.headers[":path"]).toBe(`/3/device/${token}`);
  expect(first!.headers).toMatchObject({ "apns-topic": "ai.clawpage.agent", "apns-push-type": "alert", "apns-collapse-id": "task_1" });
  expect(JSON.parse(first!.body)).toEqual({ aps: { alert: { title: "办完了：订机票", body: "已订好" }, sound: "default", "thread-id": "task_1" }, url: "/" });
  // The bearer is an ES256 JWT of the key id and team, which verifies with the key's public half.
  const jwt = String(first!.headers.authorization).replace(/^bearer /, "");
  const [head, claims, signature] = jwt.split(".");
  expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "ES256", kid: "ABCDE12345" });
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ iss: "TEAM123456" });
  expect(crypto.verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);

  answer = { status: 400, reason: "BadDeviceToken" };
  expect(await send({ token, environment: "development" }, { title: "t", body: "b" })).toEqual({ statusCode: 400, reason: "BadDeviceToken" });
  // The same token key is reused rather than signed again for every notification.
  expect(received[1]!.headers.authorization).toBe(first!.headers.authorization);
  expect(received[1]!.headers["apns-collapse-id"]).toBeUndefined();
});

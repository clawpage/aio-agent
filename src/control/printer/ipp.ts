import http from "node:http";
import https from "node:https";

/**
 * Just enough IPP/2.0 (RFC 8010/8011) for one network printer: ask its state,
 * send a print job, read the job back. Values are kept as strings or numbers by
 * attribute name; collections (media-col-ready and the like) are skipped.
 */

export const OP = { printJob: 0x0002, validateJob: 0x0004, getJobAttributes: 0x0009, getPrinterAttributes: 0x000b } as const;

const TAG = { operation: 0x01, job: 0x02, end: 0x03, integer: 0x21, boolean: 0x22, enum: 0x23, keyword: 0x44, uri: 0x45, charset: 0x47, language: 0x48, mime: 0x49, name: 0x42, text: 0x41, begCollection: 0x34, endCollection: 0x37 } as const;

export type IppValue = string | number | boolean;
export type IppAttrs = Record<string, IppValue | IppValue[]>;
type Attr = [tag: number, name: string, value: IppValue | IppValue[]];

export interface IppResponse {
  status: number;
  /** Attributes of every group, by name; a later group's value replaces an earlier one's. */
  attrs: Record<string, IppValue[]>;
}

function encodeValue(tag: number, value: IppValue): Buffer {
  if (tag === TAG.integer || tag === TAG.enum) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Number(value));
    return b;
  }
  if (tag === TAG.boolean) return Buffer.from([value ? 1 : 0]);
  return Buffer.from(String(value), "utf8");
}

function encodeAttr([tag, name, value]: Attr): Buffer {
  const parts: Buffer[] = [];
  (Array.isArray(value) ? value : [value]).forEach((one, index) => {
    const n = Buffer.from(index === 0 ? name : "", "utf8");
    const v = encodeValue(tag, one);
    const head = Buffer.alloc(3);
    head.writeUInt8(tag, 0);
    head.writeUInt16BE(n.length, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(v.length);
    parts.push(head, n, len, v);
  });
  return Buffer.concat(parts);
}

export function encodeRequest(op: number, requestId: number, printerUri: string, operation: Attr[], job: Attr[] = []): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt16BE(0x0200, 0);
  head.writeUInt16BE(op, 2);
  head.writeUInt32BE(requestId, 4);
  const base: Attr[] = [[TAG.charset, "attributes-charset", "utf-8"], [TAG.language, "attributes-natural-language", "en"], [TAG.uri, "printer-uri", printerUri]];
  return Buffer.concat([
    head,
    Buffer.from([TAG.operation]),
    ...[...base, ...operation].map(encodeAttr),
    ...(job.length ? [Buffer.from([TAG.job]), ...job.map(encodeAttr)] : []),
    Buffer.from([TAG.end]),
  ]);
}

export function decodeResponse(buf: Buffer): IppResponse {
  if (buf.length < 9) throw new Error("打印机回应不完整");
  const status = buf.readUInt16BE(2);
  const attrs: Record<string, IppValue[]> = {};
  let i = 8;
  let current: string | null = null;
  let depth = 0;
  while (i < buf.length) {
    const tag = buf[i++]!;
    if (tag === TAG.end) break;
    if (tag < 0x10) {
      current = null;
      continue; // the start of an attribute group
    }
    const nameLen = buf.readUInt16BE(i);
    const name = buf.toString("utf8", i + 2, i + 2 + nameLen);
    i += 2 + nameLen;
    const valueLen = buf.readUInt16BE(i);
    const raw = buf.subarray(i + 2, i + 2 + valueLen);
    i += 2 + valueLen;
    if (tag === TAG.begCollection) depth += 1;
    if (tag === TAG.endCollection) {
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (name) {
      current = name;
      attrs[name] = [];
    }
    if (!current) continue;
    const value: IppValue =
      tag === TAG.integer || tag === TAG.enum ? raw.readInt32BE(0) : tag === TAG.boolean ? raw[0] === 1 : raw.toString("utf8");
    attrs[current]!.push(value);
  }
  return { status, attrs };
}

/** The http(s) endpoint for an ipp:// or ipps:// printer URI (port 631 unless given). */
export function endpointOf(printerUri: string): URL {
  const uri = new URL(printerUri);
  if (uri.protocol !== "ipp:" && uri.protocol !== "ipps:") throw new Error(`打印机地址要以 ipp:// 或 ipps:// 开头：${printerUri}`);
  const url = new URL(`${uri.protocol === "ipps:" ? "https" : "http"}://${uri.host}${uri.pathname}`);
  if (!uri.port) url.port = "631";
  return url;
}

/**
 * One IPP request. Printers on a home network present self-signed certificates,
 * so an ipps:// printer's certificate is not checked: the address the owner
 * configured is what identifies it.
 */
export async function ippRequest(printerUri: string, body: Buffer, timeoutMs: number): Promise<IppResponse> {
  const url = endpointOf(printerUri);
  const client = url.protocol === "https:" ? https : http;
  const reply = await new Promise<Buffer>((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/ipp", "content-length": body.length },
        timeout: timeoutMs,
        ...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`打印机 HTTP ${res.statusCode}`))));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("打印机没有响应（超时）")));
    req.on("error", reject);
    req.end(body);
  });
  return decodeResponse(reply);
}

export { TAG };

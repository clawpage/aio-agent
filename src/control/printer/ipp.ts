import http from "node:http";
import https from "node:https";

/**
 * Just enough IPP/2.0 (RFC 8010/8011) for one network printer: ask its state,
 * send a print job, read the job back. Values are kept as strings or numbers by
 * attribute name; collections (media-col-ready and the like) are kept apart.
 */

export const OP = { printJob: 0x0002, validateJob: 0x0004, getJobAttributes: 0x0009, getPrinterAttributes: 0x000b } as const;

const TAG = { operation: 0x01, job: 0x02, end: 0x03, integer: 0x21, boolean: 0x22, enum: 0x23, keyword: 0x44, uri: 0x45, charset: 0x47, language: 0x48, mime: 0x49, name: 0x42, text: 0x41, begCollection: 0x34, endCollection: 0x37, memberName: 0x4a } as const;

export type IppValue = string | number | boolean;
export type IppAttrs = Record<string, IppValue | IppValue[]>;
/** A collection value: integers and keywords by member name, or a collection inside it. */
export interface IppCollection {
  [member: string]: IppValue | IppCollection;
}
type Attr = [tag: number, name: string, value: IppValue | IppValue[] | IppCollection | IppCollection[]];

export interface IppResponse {
  status: number;
  /** Attributes of every group, by name; a later group's value replaces an earlier one's. */
  attrs: Record<string, IppValue[]>;
  /** Collection attributes of the top level, by name. */
  collections: Record<string, IppCollection[]>;
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

function encodeOne(tag: number, name: string, v: Buffer): Buffer {
  const n = Buffer.from(name, "utf8");
  const head = Buffer.alloc(3);
  head.writeUInt8(tag, 0);
  head.writeUInt16BE(n.length, 1);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(v.length);
  return Buffer.concat([head, n, len, v]);
}

const EMPTY = Buffer.alloc(0);

function encodeCollection(name: string, collection: IppCollection): Buffer {
  const parts = [encodeOne(TAG.begCollection, name, EMPTY)];
  for (const [member, value] of Object.entries(collection)) {
    parts.push(encodeOne(TAG.memberName, "", Buffer.from(member, "utf8")));
    if (typeof value === "object") parts.push(encodeCollection("", value));
    else {
      const tag = typeof value === "number" ? TAG.integer : typeof value === "boolean" ? TAG.boolean : TAG.keyword;
      parts.push(encodeOne(tag, "", encodeValue(tag, value)));
    }
  }
  parts.push(encodeOne(TAG.endCollection, "", EMPTY));
  return Buffer.concat(parts);
}

function encodeAttr([tag, name, value]: Attr): Buffer {
  return Buffer.concat(
    (Array.isArray(value) ? value : [value]).map((one, index) => {
      const n = index === 0 ? name : "";
      return typeof one === "object" ? encodeCollection(n, one) : encodeOne(tag, n, encodeValue(tag, one));
    }),
  );
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
  if (buf.length < 9) throw new Error("The printer's response was incomplete");
  const status = buf.readUInt16BE(2);
  const attrs: Record<string, IppValue[]> = {};
  const collections: Record<string, IppCollection[]> = {};
  let i = 8;
  let current: string | null = null;
  let collection: string | null = null;
  /** The collections being read, outermost first, each with the member its next value belongs to. */
  const open: Array<{ value: IppCollection; member: string }> = [];
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
    const inside = open.at(-1);
    if (tag === TAG.begCollection) {
      const value: IppCollection = {};
      if (inside) inside.value[inside.member] = value;
      else {
        if (name) collections[(collection = name)] = [];
        if (collection) collections[collection]!.push(value);
      }
      open.push({ value, member: "" });
      continue;
    }
    if (tag === TAG.endCollection) {
      open.pop();
      continue;
    }
    if (inside) {
      if (tag === TAG.memberName) inside.member = raw.toString("utf8");
      else inside.value[inside.member] ??= tag === TAG.integer || tag === TAG.enum ? raw.readInt32BE(0) : tag === TAG.boolean ? raw[0] === 1 : raw.toString("utf8");
      continue;
    }
    if (name) {
      current = name;
      attrs[name] = [];
    }
    if (!current) continue;
    const value: IppValue =
      tag === TAG.integer || tag === TAG.enum ? raw.readInt32BE(0) : tag === TAG.boolean ? raw[0] === 1 : raw.toString("utf8");
    attrs[current]!.push(value);
  }
  return { status, attrs, collections };
}

/** The http(s) endpoint for an ipp:// or ipps:// printer URI (port 631 unless given). */
export function endpointOf(printerUri: string): URL {
  const uri = new URL(printerUri);
  if (uri.protocol !== "ipp:" && uri.protocol !== "ipps:") throw new Error(`The printer address must start with ipp:// or ipps://: ${printerUri}`);
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
        res.on("end", () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Printer HTTP ${res.statusCode}`))));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The printer did not respond (timed out)")));
    req.on("error", reject);
    req.end(body);
  });
  return decodeResponse(reply);
}

export { TAG };

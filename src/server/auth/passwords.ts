import crypto from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export interface PasswordRecord {
  hash: string;
  salt: string;
  params: string;
}

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return {
    hash: key.toString("base64"),
    salt: salt.toString("base64"),
    params: `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${KEY_LEN}`,
  };
}

export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  const [, n, r, p, len] = record.params.split("$");
  const opts = { N: Number(n), r: Number(r), p: Number(p) };
  const salt = Buffer.from(record.salt, "base64");
  const expected = Buffer.from(record.hash, "base64");
  const actual = await scryptAsync(password, salt, Number(len ?? expected.length), opts);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** Constant-time-ish dummy verify so unknown users cost roughly the same as known ones. */
export async function dummyVerify(password: string): Promise<void> {
  await scryptAsync(password, Buffer.alloc(16), KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

export function generateSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

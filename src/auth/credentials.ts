import crypto from "node:crypto";

export interface Credentials {
  mech: "PLAIN" | "LOGIN" | "XOAUTH2";
  username: string;
  password?: string;
  accessToken?: string;
  refreshToken?: string;
}

// Format: [12-byte nonce | 16-byte tag | ciphertext]
const NONCE_LEN = 12;
const TAG_LEN = 16;

export async function sealCredentials(key: Buffer, c: Credentials): Promise<Buffer> {
  if (key.length !== 32) throw new Error("vault key must be 32 bytes");
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const plain = Buffer.from(JSON.stringify(c), "utf8");
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]);
}

export async function openCredentials(key: Buffer, vault: Buffer): Promise<Credentials> {
  if (key.length !== 32) throw new Error("vault key must be 32 bytes");
  if (vault.length < NONCE_LEN + TAG_LEN) throw new Error("vault: truncated");
  const nonce = vault.subarray(0, NONCE_LEN);
  const tag = vault.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ct = vault.subarray(NONCE_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as Credentials;
}

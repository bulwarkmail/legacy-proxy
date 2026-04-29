import { b64uDecode, b64uEncode, varintDecode, varintEncode } from "../util/base64url.js";

export interface EmailState {
  uidvalidity: number;
  modseq: number;
}

export function encodeEmailState(s: EmailState): string {
  return b64uEncode(Buffer.concat([varintEncode(s.uidvalidity), varintEncode(s.modseq)]));
}

export function decodeEmailState(s: string): EmailState {
  const buf = b64uDecode(s);
  const a = varintDecode(buf, 0);
  const b = varintDecode(buf, a.next);
  if (b.next !== buf.length) throw new Error("decodeEmailState: trailing bytes");
  return { uidvalidity: a.value, modseq: b.value };
}

export function encodeCounterState(n: number): string {
  return b64uEncode(varintEncode(n));
}

export function decodeCounterState(s: string): number {
  const buf = b64uDecode(s);
  const v = varintDecode(buf, 0);
  if (v.next !== buf.length) throw new Error("decodeCounterState: trailing bytes");
  return v.value;
}

export function b64uEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replaceAll("-", "+").replaceAll("_", "/") + pad, "base64");
}

export function varintEncode(n: number): Buffer {
  if (n < 0 || !Number.isInteger(n)) throw new RangeError("varintEncode: non-negative int");
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

export function varintDecode(buf: Buffer, offset = 0): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  while (true) {
    if (i >= buf.length) throw new Error("varintDecode: truncated");
    const b = buf[i++]!;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("varintDecode: overflow");
  }
  return { value: value >>> 0, next: i };
}

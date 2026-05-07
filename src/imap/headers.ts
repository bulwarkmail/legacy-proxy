// Parse the raw header block of an RFC 5322 message and project values into
// the JMAP header forms (RFC 8621 §4.1.3): asRaw, asText, asAddresses,
// asGroupedAddresses, asMessageIds, asURLs, asDate.
//
// We parse ourselves rather than pull libmime as a direct dep: the surface we
// need is small, and the transitive libmime can be cleaned out from under us
// without notice. All parsing is forgiving — an undecodable encoded-word, an
// unparseable address, or a malformed date drops to the most useful fallback
// (the raw string, an empty array, etc.) rather than throwing.

export interface ParsedHeader {
  name: string;       // original casing as it appeared in the message
  rawValue: string;   // value AFTER folded-line unwrapping but before decoding
}

export function parseHeaderBlock(block: string | Buffer): ParsedHeader[] {
  const text = typeof block === "string" ? block : block.toString("utf8");
  // RFC 5322 header lines end at LF with optional CR; continuation lines start
  // with whitespace. Unfold first, then split on header boundaries.
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: ParsedHeader[] = [];
  let cur: ParsedHeader | null = null;
  for (const line of lines) {
    if (line === "") break; // empty line ends the header section
    if (/^[ \t]/.test(line)) {
      // continuation
      if (cur) cur.rawValue += " " + line.replace(/^[ \t]+/, "");
      continue;
    }
    const m = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    if (cur) out.push(cur);
    cur = { name: m[1]!, rawValue: m[2]! };
  }
  if (cur) out.push(cur);
  return out;
}

export function findHeaders(headers: ParsedHeader[], name: string): ParsedHeader[] {
  const lc = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === lc);
}

// Decode RFC 2047 encoded-words (`=?charset?B?...?=` / `=?charset?Q?...?=`).
// Whitespace BETWEEN consecutive encoded-words is preserved if textual but
// elided when it separates two encoded-words, per §6.2.
export function decodeWords(s: string): string {
  const ENCODED = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  // First pass: collapse whitespace between back-to-back encoded words.
  s = s.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return s.replace(ENCODED, (_m, charset: string, enc: string, text: string) => {
    try {
      let bytes: Buffer;
      if (enc.toUpperCase() === "B") {
        bytes = Buffer.from(text, "base64");
      } else {
        // Q: underscores → space, =XX → byte
        const replaced = text
          .replace(/_/g, " ")
          .replace(/=([0-9A-Fa-f]{2})/g, (_x, hex: string) =>
            String.fromCharCode(parseInt(hex, 16)),
          );
        bytes = Buffer.from(
          [...replaced].map((ch) => ch.charCodeAt(0)),
        );
      }
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      return _m;
    }
  });
}

export function asRaw(headers: ParsedHeader[], name: string): string | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  // RFC 8621 §4.1.3: "the value as it appears in the message" — last instance
  // wins, prefixed with a single space (the convention upstream tests follow).
  return " " + matches[matches.length - 1]!.rawValue;
}

export function asText(headers: ParsedHeader[], name: string): string | null {
  const raw = asRaw(headers, name);
  if (raw == null) return null;
  return decodeWords(raw).replace(/\s+/g, " ").trim();
}

// Parse an RFC 5322 address list: `name <addr>`, `<addr>`, `addr`, group syntax
// `Group: addr1, addr2;`. Used for asAddresses and asGroupedAddresses.
export function parseAddressList(value: string): { groups: { name: string | null; addresses: { name: string | null; email: string }[] }[] } {
  const groups: { name: string | null; addresses: { name: string | null; email: string }[] }[] = [];
  let buf: { name: string | null; addresses: { name: string | null; email: string }[] } = {
    name: null,
    addresses: [],
  };
  // Tokenize: walk the string honoring quoted strings, comments, angle-brackets.
  let i = 0;
  let token = "";
  const finishAddress = () => {
    const t = token.trim();
    token = "";
    if (!t) return;
    // Match `Display Name <foo@bar>` or just `foo@bar`.
    const angle = /^(.*)<([^>]+)>\s*$/.exec(t);
    if (angle) {
      const name = angle[1]!.trim().replace(/^"|"$/g, "").replace(/\\(.)/g, "$1");
      buf.addresses.push({ name: name ? decodeWords(name) : null, email: angle[2]!.trim() });
      return;
    }
    if (/@/.test(t)) buf.addresses.push({ name: null, email: t });
  };
  while (i < value.length) {
    const c = value[i]!;
    if (c === '"') {
      // quoted-string: read up to matching "
      token += c;
      i++;
      while (i < value.length && value[i] !== '"') {
        if (value[i] === "\\") { token += value[i]!; i++; }
        if (i < value.length) { token += value[i]!; i++; }
      }
      if (i < value.length) { token += value[i]!; i++; }
      continue;
    }
    if (c === "(") {
      // comment: skip to matching )
      let depth = 1;
      i++;
      while (i < value.length && depth > 0) {
        if (value[i] === "(") depth++;
        else if (value[i] === ")") depth--;
        if (depth > 0) i++;
      }
      i++;
      continue;
    }
    if (c === ":") {
      // group prefix: token so far is the group name
      const name = token.trim();
      if (buf.addresses.length || buf.name) groups.push(buf);
      buf = { name: name || null, addresses: [] };
      token = "";
      i++;
      continue;
    }
    if (c === ";") {
      finishAddress();
      groups.push(buf);
      buf = { name: null, addresses: [] };
      i++;
      continue;
    }
    if (c === ",") {
      finishAddress();
      i++;
      continue;
    }
    token += c;
    i++;
  }
  finishAddress();
  if (buf.addresses.length || buf.name) groups.push(buf);
  if (groups.length === 0) groups.push({ name: null, addresses: [] });
  return { groups };
}

export function asAddresses(headers: ParsedHeader[], name: string): { name: string | null; email: string }[] | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const out: { name: string | null; email: string }[] = [];
  for (const h of matches) {
    const decoded = decodeWords(h.rawValue);
    const parsed = parseAddressList(decoded);
    for (const g of parsed.groups) out.push(...g.addresses);
  }
  return out;
}

export function asGroupedAddresses(
  headers: ParsedHeader[],
  name: string,
): { name: string | null; addresses: { name: string | null; email: string }[] }[] | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const groups: { name: string | null; addresses: { name: string | null; email: string }[] }[] = [];
  for (const h of matches) {
    const decoded = decodeWords(h.rawValue);
    const parsed = parseAddressList(decoded);
    for (const g of parsed.groups) groups.push(g);
  }
  return groups;
}

export function asMessageIds(headers: ParsedHeader[], name: string): string[] | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const ids: string[] = [];
  for (const h of matches) {
    const re = /<([^>]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(h.rawValue)) !== null) ids.push(m[1]!);
  }
  return ids.length ? ids : null;
}

export function asURLs(headers: ParsedHeader[], name: string): string[] | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const urls: string[] = [];
  for (const h of matches) {
    const re = /<([^>]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(h.rawValue)) !== null) urls.push(m[1]!.trim());
  }
  return urls.length ? urls : null;
}

export function asDate(headers: ParsedHeader[], name: string): string | null {
  const matches = findHeaders(headers, name);
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1]!.rawValue;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Compute a stable JMAP threadId for a message from its headers, per the
// classic IMAP-threading heuristic (RFC 8621 §3 doesn't mandate a specific
// algorithm, so we follow the JWZ "References then In-Reply-To" approach):
//   1. The first Message-Id in References is the thread root (oldest ancestor).
//   2. If References is absent, fall back to In-Reply-To.
//   3. If both are absent, the message is its own root.
// We hash the chosen Message-Id so the threadId is opaque and URL-safe.
export function computeThreadIdFromHeaders(
  headers: ParsedHeader[],
  envelopeMessageId?: string | null,
): string | null {
  const refs = asMessageIds(headers, "References");
  if (refs && refs.length) return hashThreadId(refs[0]!);
  const irt = asMessageIds(headers, "In-Reply-To");
  if (irt && irt.length) return hashThreadId(irt[0]!);
  const own = asMessageIds(headers, "Message-ID");
  if (own && own.length) return hashThreadId(own[0]!);
  if (envelopeMessageId) return hashThreadId(envelopeMessageId);
  return null;
}

function hashThreadId(messageId: string): string {
  // Short base32-ish hash. Prefixed with "T" so a threadId is visually
  // distinguishable from an emailId in logs.
  const norm = messageId.replace(/^<|>$/g, "");
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < norm.length; i++) {
    const ch = norm.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = (BigInt(h1 >>> 0) << 32n) | BigInt(h2 >>> 0);
  // Encode as a short crockford-base32-ish string.
  const ALPH = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  let v = n;
  for (let i = 0; i < 13; i++) {
    out = ALPH[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return "T" + out;
}

// Project a JMAP `header:Name:asForm` (or `header:Name`, defaulting to asRaw)
// property string against a parsed header set. Returns the JMAP value the
// client should see in the Email response.
export function projectHeaderProp(
  headers: ParsedHeader[],
  prop: string,
):
  | string
  | string[]
  | { name: string | null; email: string }[]
  | { name: string | null; addresses: { name: string | null; email: string }[] }[]
  | null {
  // header:Name:asForm  → split on ':' but only the first two : are structural
  const m = /^header:([^:]+)(?::([^:]+))?$/.exec(prop);
  if (!m) return null;
  const name = m[1]!;
  const form = (m[2] ?? "asRaw").toLowerCase();
  switch (form) {
    case "asraw": return asRaw(headers, name);
    case "astext": return asText(headers, name);
    case "asaddresses": return asAddresses(headers, name);
    case "asgroupedaddresses": return asGroupedAddresses(headers, name);
    case "asmessageids": return asMessageIds(headers, name);
    case "asurls": return asURLs(headers, name);
    case "asdate": return asDate(headers, name);
    default: return null;
  }
}

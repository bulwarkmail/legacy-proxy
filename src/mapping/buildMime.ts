// Build an RFC 5322 / MIME message from a JMAP Email/set create payload.
// Used by Email/set create (drafts) which APPENDs the result via IMAP, and by
// the Gmail backend for its drafts.
//
// We use nodemailer's MimeNode (already a transitive dep) to handle
// quoted-printable encoding, header folding, and message id generation.
//
// The address headers are written from checked parts and read back with the
// strict address-list parser below (also used to derive a submission's
// envelope), so the message names exactly the mailboxes the client gave.

import { domainToASCII } from "node:url";
import MimeNode from "nodemailer/lib/mime-node/index.js";
import { JmapError } from "../jmap/errors.js";

// Whitespace, control characters and everything an address parser reads as
// syntax: list separators, angle brackets, quotes, escapes, comments and the
// colon of a group. U+FFFD stands for header bytes that weren't UTF-8.
const NOT_PLAIN = /[\s,;:<>"\\()\u0000-\u001f\u007f-\u009f\ufffd]/u;

/**
 * A plain address: one "@" between a non-empty local part and a non-empty
 * domain, and none of the characters in NOT_PLAIN. nodemailer parses every
 * envelope string again before it writes MAIL FROM and RCPT TO; for a plain
 * address every parser agrees on the mailbox, so what reaches the SMTP server
 * is the address the user was shown, one entry being one recipient.
 */
export function isPlainAddress(s: string): boolean {
  const at = s.indexOf("@");
  return at > 0 && at === s.lastIndexOf("@") && at < s.length - 1 && !NOT_PLAIN.test(s);
}

/** One header field: its name in lower case, its value unfolded, and the bytes its lines take in the message. */
export interface HeaderField {
  name: string;
  value: string;
  start: number;
  end: number;
}

/**
 * The header block of a raw message, read one way for everything that looks
 * at it (deriving a submission's envelope, stripping Bcc, checking a built
 * message). Lines end in CRLF, or all of them in LF (a message saved on a
 * Unix system). Null when readers could disagree about where a line or the
 * block ends: a bare CR, CRLF and LF mixed, a line of only whitespace, or a
 * line that is neither a field nor the continuation of one.
 */
export function readHeaderBlock(raw: Buffer): HeaderField[] | null {
  // latin1 keeps one character per byte, so string offsets are byte offsets.
  const text = raw.toString("latin1");
  const fields: HeaderField[] = [];
  let current: { name: string; parts: string[]; start: number; end: number } | null = null;
  let crlf = false;
  let lf = false;
  const close = () => {
    if (current) fields.push({ name: current.name, value: Buffer.from(current.parts.join(""), "latin1").toString("utf8"), start: current.start, end: current.end });
    current = null;
  };
  let pos = 0;
  while (pos < text.length) {
    const nl = text.indexOf("\n", pos);
    const next = nl < 0 ? text.length : nl + 1;
    let line = text.slice(pos, nl < 0 ? text.length : nl);
    if (nl >= 0) {
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
        crlf = true;
      } else lf = true;
    }
    if (line.includes("\r")) return null;
    if (line === "") break; // the empty line before the body
    if (line[0] === " " || line[0] === "\t") {
      if (!current || line.trim() === "") return null;
      current.parts.push(line);
      current.end = next;
    } else {
      const m = /^([!-9;-~]+)[ \t]*:/.exec(line);
      if (!m) return null;
      close();
      current = { name: m[1]!.toLowerCase(), parts: [line.slice(m[0].length)], start: pos, end: next };
    }
    pos = next;
  }
  close();
  return crlf && lf ? null : fields;
}

/** Every value of a header field (name in lower case), unfolded; none when the header block can't be read. */
export function headerValues(raw: Buffer, name: string): string[] {
  return (readHeaderBlock(raw) ?? []).filter((f) => f.name === name).map((f) => f.value);
}

/** One entry of an address list: the mailbox's address as written, or null when the entry isn't one mailbox. */
export interface AddressEntry {
  address: string | null;
  /** The entry as the header wrote it, trimmed: what an error names when there is no address. */
  written: string;
}

type Token = { kind: "word" | "quoted" | "literal" | "space" | "bad" | "<" | ">" | "," | ";" | ":"; start: number; end: number };

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  // Skips a quoted string, comment or domain literal; returns the index after it, or -1 if it never closes.
  const skip = (open: number, close: string, nests: boolean): number => {
    let depth = 0;
    for (let j = open; j < s.length; j++) {
      const c = s[j]!;
      if (c === "\\") j++;
      else if (j > open && c === close && depth === 0) return j + 1;
      else if (nests && j > open && c === "(") depth++;
      else if (nests && c === ")") depth--;
    }
    return -1;
  };
  while (i < s.length) {
    const c = s[i]!;
    const start = i;
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "(") {
      // Whitespace and comments separate words; neither is part of an address.
      while (i < s.length) {
        const d = s[i]!;
        if (d === " " || d === "\t" || d === "\r" || d === "\n") i++;
        else if (d === "(") {
          const end = skip(i, ")", true);
          if (end < 0) {
            out.push({ kind: "bad", start, end: s.length });
            return out;
          }
          i = end;
        } else break;
      }
      out.push({ kind: "space", start, end: i });
    } else if (c === '"' || c === "[") {
      const end = skip(i, c === '"' ? '"' : "]", false);
      if (end < 0) {
        out.push({ kind: "bad", start, end: s.length });
        return out;
      }
      out.push({ kind: c === '"' ? "quoted" : "literal", start, end });
      i = end;
    } else if (c === "<" || c === ">" || c === "," || c === ";" || c === ":") {
      out.push({ kind: c, start, end: i + 1 });
      i++;
    } else {
      while (i < s.length && !/[ \t\r\n("[<>,;:]/.test(s[i]!)) i++;
      out.push({ kind: "word", start, end: i });
    }
  }
  return out;
}

/**
 * An RFC 5322 address list (To, Cc, Bcc, From), read strictly. An entry is
 * an address, or a display name followed by an address in angle brackets,
 * with comments and whitespace only around them; a group's members are
 * entries of their own. The address is kept as written. Anything else (two
 * addresses without a comma, text after the angle brackets, an unquoted "@"
 * or ";" in the wrong place, an unclosed quote, bracket or group) is an entry
 * without an address, named as written, so the envelope check refuses it
 * instead of guessing a mailbox.
 */
export function parseAddressList(value: string): AddressEntry[] {
  const tokens = tokenize(value);
  const entries: AddressEntry[] = [];
  const text = (ts: Token[]) => (ts.length ? value.slice(ts[0]!.start, ts[ts.length - 1]!.end) : "");
  // A display name (of a mailbox or a group): words and quoted strings, no unquoted "@".
  const isName = (ts: Token[]) =>
    ts.every((t) => t.kind === "space" || t.kind === "quoted" || (t.kind === "word" && !value.slice(t.start, t.end).includes("@")));

  let current: Token[] = [];
  let valid = true;
  let depth = 0;
  let group: { start: number } | null = null;
  const finish = () => {
    const ts = trimSpace(current);
    if (ts.length > 0) entries.push({ address: valid ? mailboxOf(ts, value, isName) : null, written: text(ts).trim() });
    current = [];
    valid = true;
    depth = 0;
  };

  for (const t of tokens) {
    if (t.kind === "bad") valid = false;
    if (t.kind === "<") depth++;
    if (t.kind === ">") depth--;
    if (t.kind === "," && depth === 0) {
      finish();
    } else if (t.kind === ":" && depth === 0 && !group && isName(current)) {
      // The display name of a group; its members follow, up to the ";".
      const name = trimSpace(current);
      group = { start: name.length ? name[0]!.start : t.start };
      current = [];
      valid = true;
    } else if (t.kind === ";" && depth === 0 && group) {
      finish();
      group = null;
    } else {
      // A ":" or ";" anywhere else makes the entry something other than a mailbox.
      if (t.kind === ":" || t.kind === ";") valid = false;
      current.push(t);
    }
  }
  if (group) {
    // A group that never closes: none of it counts as an address.
    entries.push({ address: null, written: value.slice(group.start).trim() });
    current = [];
  }
  finish();
  return entries;
}

function trimSpace(ts: Token[]): Token[] {
  let a = 0;
  let b = ts.length;
  while (a < b && ts[a]!.kind === "space") a++;
  while (b > a && ts[b - 1]!.kind === "space") b--;
  return ts.slice(a, b);
}

/**
 * The address of one entry (tokens without leading or trailing space): a bare
 * address, or a display name and one address in angle brackets with nothing
 * after them. Null for anything else. The address is one run of words, quoted
 * strings and a domain literal, with no space inside and brackets only around
 * the domain.
 */
function mailboxOf(ts: Token[], value: string, isName: (ts: Token[]) => boolean): string | null {
  let parts = ts;
  const open = ts.findIndex((t) => t.kind === "<");
  if (open >= 0) {
    const close = ts.findIndex((t) => t.kind === ">");
    const angles = ts.filter((t) => t.kind === "<" || t.kind === ">").length;
    if (close !== ts.length - 1 || angles !== 2 || !isName(ts.slice(0, open))) return null;
    parts = trimSpace(ts.slice(open + 1, close));
  }
  if (parts.length === 0 || parts.some((t) => t.kind !== "word" && t.kind !== "quoted" && t.kind !== "literal")) return null;
  const address = parts.map((t) => value.slice(t.start, t.end)).join("");
  if (/[[\]]/.test(address) && !/^[^[\]]+@\[[^[\]]*\]$/.test(address)) return null;
  return address;
}

interface JmapAddress {
  name?: string | null;
  email?: string;
}

interface BodyPartRef {
  partId?: string;
}

interface BodyValue {
  value?: string;
}

// JMAP `bodyStructure` (RFC 8621 §4.1.4): a recursive tree describing the
// MIME hierarchy. Leaves carry either a partId (resolved through bodyValues)
// or a blobId (an upload, or a part of existing mail such as a forwarded
// attachment).
export interface BodyStructurePart {
  type?: string;
  partId?: string;
  blobId?: string;
  name?: string | null;
  disposition?: string | null;
  cid?: string | null;
  charset?: string | null;
  subParts?: BodyStructurePart[];
}

export interface JmapEmailCreate {
  bodyStructure?: BodyStructurePart | null;
  from?: JmapAddress[] | null;
  sender?: JmapAddress[] | null;
  to?: JmapAddress[] | null;
  cc?: JmapAddress[] | null;
  bcc?: JmapAddress[] | null;
  replyTo?: JmapAddress[] | null;
  subject?: string | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  messageId?: string[] | null;
  sentAt?: string | null;
  textBody?: BodyPartRef[] | null;
  htmlBody?: BodyPartRef[] | null;
  // RFC 8621 §4.6: with textBody / htmlBody, attachments (inline images with
  // a cid, and files) are listed here instead of in a bodyStructure.
  attachments?: BodyStructurePart[] | null;
  bodyValues?: Record<string, BodyValue> | null;
  // Headers passed through verbatim (asRaw form). We don't attempt to
  // re-parse these; clients that send us structured forms should map them
  // before submission.
  headers?: { name: string; value: string }[] | null;
}

// The JMAP address properties and the header each one is written to.
const ADDRESS_FIELDS = [
  ["from", "From"],
  ["sender", "Sender"],
  ["to", "To"],
  ["cc", "Cc"],
  ["bcc", "Bcc"],
  ["replyTo", "Reply-To"],
] as const;

interface CheckedAddress {
  name: string;
  address: string;
}

function refusedAddress(property: string, address: string): JmapError {
  return new JmapError("invalidProperties", `${property}: ${JSON.stringify(address)} is not one plain email address`, {
    properties: [property],
  });
}

/**
 * One address property, checked before anything reaches MimeNode: every
 * entry with an email must be one plain address (isPlainAddress); an entry
 * without an email names no mailbox and is left out. Anything else refuses
 * the create with invalidProperties naming the property and the address as
 * given.
 */
function checkedAddresses(property: string, list: unknown): CheckedAddress[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new JmapError("invalidProperties", `${property} must be a list of addresses`, { properties: [property] });
  const out: CheckedAddress[] = [];
  for (const entry of list as (JmapAddress | null)[]) {
    const email = entry?.email;
    if (email == null || email === "") continue;
    if (typeof email !== "string") throw refusedAddress(property, String(email));
    const address = email.trim();
    if (!address) continue;
    if (!isPlainAddress(address)) throw refusedAddress(property, email);
    out.push({ name: typeof entry?.name === "string" ? entry.name.trim() : "", address });
  }
  return out;
}

/** The same mailbox: the local part exactly, the domain without regard to case or IDN form. */
function sameMailbox(a: string, b: string): boolean {
  const split = (s: string): [string, string] => {
    const at = s.lastIndexOf("@");
    return [s.slice(0, at), s.slice(at + 1)];
  };
  const domain = (d: string) => domainToASCII(d.toLowerCase()) || d.toLowerCase();
  const [la, da] = split(a);
  const [lb, db] = split(b);
  return la === lb && domain(da) === domain(db);
}

/**
 * Reads each address header of the built message back with the strict parser
 * and refuses the create unless it names exactly the mailboxes it was given,
 * in order, and no others. MimeNode lower-cases and punycodes the domain; any
 * other difference, whatever the nodemailer version does, is refused.
 */
function verifyAddressHeaders(message: Buffer, given: Map<string, CheckedAddress[]>): void {
  const block = readHeaderBlock(message);
  if (!block) throw new JmapError("invalidProperties", "the message built from these properties has an unreadable header block");
  for (const [property, header] of ADDRESS_FIELDS) {
    const expected = given.get(property) ?? [];
    const read = block.filter((f) => f.name === header.toLowerCase()).flatMap((f) => parseAddressList(f.value));
    for (let i = 0; i < Math.max(expected.length, read.length); i++) {
      const want = expected[i];
      const got = read[i];
      if (!want || !got || got.address === null || !sameMailbox(got.address, want.address)) {
        throw refusedAddress(property, want?.address ?? got?.written ?? "");
      }
    }
  }
}

// Walk a bodyStructure tree into a nodemailer MimeNode. Multipart parts
// (type starting with "multipart/") get child nodes; leaves are filled from
// either bodyValues[partId] (text/* parts) or getBlob(blobId) (attachments).
function nodeFromBodyStructure(
  part: BodyStructurePart,
  bodyValues: Record<string, BodyValue> | null,
  getBlob: BlobLookup,
  hostname: string,
): MimeNode {
  const type = part.type ?? "text/plain";
  if (type.toLowerCase().startsWith("multipart/")) {
    const node = new MimeNode(type, { hostname });
    for (const child of part.subParts ?? []) {
      node.appendChild(nodeFromBodyStructure(child, bodyValues, getBlob, hostname));
    }
    return node;
  }
  // Leaf part: either text content via bodyValues, or a blob attachment.
  const headers: Record<string, string> = {};
  if (part.disposition || part.name) {
    const disp = part.disposition ?? "inline";
    const filename = part.name ? `; filename="${part.name.replace(/"/g, "")}"` : "";
    headers["Content-Disposition"] = `${disp}${filename}`;
  }
  if (part.cid) headers["Content-ID"] = `<${part.cid}>`;
  let contentType = type;
  if (type.toLowerCase().startsWith("text/")) {
    contentType = `${type}; charset=${part.charset ?? "utf-8"}`;
  }
  const node = new MimeNode(contentType, { hostname });
  for (const [k, v] of Object.entries(headers)) node.setHeader(k, v);

  if (part.partId && bodyValues?.[part.partId]?.value !== undefined) {
    node.setContent(bodyValues[part.partId]!.value!);
  } else if (part.blobId) {
    const blob = getBlob(part.blobId);
    // An empty part would go out as a blank file or a broken inline image;
    // refuse the message instead.
    if (!blob) throw new MissingBlobError(part.blobId);
    node.setContent(blob.body);
  }
  return node;
}

export class MissingBlobError extends Error {
  constructor(readonly blobId: string) {
    super(`blob ${blobId} not found`);
  }
}

function resolveBody(
  refs: BodyPartRef[] | null | undefined,
  values: Record<string, BodyValue> | null | undefined,
): string | null {
  if (!refs || refs.length === 0 || !values) return null;
  const chunks: string[] = [];
  for (const r of refs) {
    if (!r.partId) continue;
    const v = values[r.partId]?.value;
    if (typeof v === "string") chunks.push(v);
  }
  if (chunks.length === 0) return null;
  return chunks.join("\r\n");
}

// RFC 8621 §4.6: inline parts with a cid sit next to the HTML they are
// referenced from in a multipart/related; everything else, and inline parts
// without HTML to show them, goes into a multipart/mixed around that.
function wrapAttachments(
  body: MimeNode,
  attachments: BodyStructurePart[],
  hasHtml: boolean,
  getBlob: BlobLookup,
  hostname: string,
): MimeNode {
  const related = hasHtml ? attachments.filter((a) => a.cid && a.disposition === "inline") : [];
  const mixed = attachments.filter((a) => !related.includes(a));
  let root = body;
  for (const [type, parts] of [["multipart/related", related], ["multipart/mixed", mixed]] as const) {
    if (!parts.length) continue;
    const wrapper = new MimeNode(type, { hostname });
    wrapper.appendChild(root);
    for (const p of parts) {
      wrapper.appendChild(nodeFromBodyStructure({ ...p, disposition: p.disposition ?? "attachment" }, null, getBlob, hostname));
    }
    root = wrapper;
  }
  return root;
}

export interface BlobLookup {
  // Returns the bytes for a blobId, or null if missing. The lookup is
  // synchronous for buildRfc822's MimeNode walk; callers load the referenced
  // blobs up front (some need an IMAP fetch) and answer from those.
  (blobId: string): { body: Buffer; ctype: string } | null;
}

export async function buildRfc822(
  create: JmapEmailCreate,
  hostname: string,
  getBlob: BlobLookup = () => null,
  keepBcc = false,
): Promise<Buffer> {
  // Every address is checked before MimeNode sees any of it.
  const addresses = new Map<string, CheckedAddress[]>();
  for (const [property] of ADDRESS_FIELDS) addresses.set(property, checkedAddresses(property, create[property]));

  // Choose a root structure based on the inputs we got. Prefer `bodyStructure`
  // (RFC 8621 §4.5.1 form 1) when present — it's the canonical source of
  // truth and drives multipart/alternative + attachments. Otherwise fall back
  // to the simpler textBody/htmlBody form.
  let root: MimeNode;
  if (create.bodyStructure) {
    root = nodeFromBodyStructure(create.bodyStructure, create.bodyValues ?? null, getBlob, hostname);
  } else {
    const text = resolveBody(create.textBody, create.bodyValues);
    const html = resolveBody(create.htmlBody, create.bodyValues);
    if (text && html) {
      root = new MimeNode("multipart/alternative", { hostname });
      root.createChild("text/plain; charset=utf-8").setContent(text);
      root.createChild("text/html; charset=utf-8").setContent(html);
    } else if (html) {
      root = new MimeNode("text/html; charset=utf-8", { hostname });
      root.setContent(html);
    } else {
      root = new MimeNode("text/plain; charset=utf-8", { hostname });
      root.setContent(text ?? "");
    }
    root = wrapAttachments(root, create.attachments ?? [], html !== null, getBlob, hostname);
  }

  root.keepBcc = keepBcc;

  // Address objects, not "name <address>" strings: MimeNode then writes the
  // checked address (domain lower-cased and punycoded) and encodes the name,
  // without parsing anything again. (The type package declares strings only;
  // MimeNode takes {name, address} objects for address headers.)
  for (const [property, header] of ADDRESS_FIELDS) {
    const list = addresses.get(property)!;
    if (list.length) root.setHeader(header, list.map((a) => ({ name: a.name, address: a.address })) as unknown as string[]);
  }
  if (create.subject) root.setHeader("Subject", create.subject);

  const date = create.sentAt ? new Date(create.sentAt) : new Date();
  root.setHeader("Date", date.toUTCString().replace(/GMT/, "+0000"));

  if (create.messageId && create.messageId[0]) {
    root.setHeader("Message-ID", `<${create.messageId[0]}>`);
  }
  if (create.inReplyTo && create.inReplyTo.length) {
    root.setHeader("In-Reply-To", create.inReplyTo.map((id) => `<${id}>`).join(" "));
  }
  if (create.references && create.references.length) {
    root.setHeader("References", create.references.map((id) => `<${id}>`).join(" "));
  }

  // Verbatim headers (e.g. List-* additions). Skip headers we already set
  // so the explicit JMAP fields win.
  const reserved = new Set([
    "from",
    "sender",
    "to",
    "cc",
    "bcc",
    "reply-to",
    "subject",
    "date",
    "message-id",
    "in-reply-to",
    "references",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
  ]);
  for (const h of create.headers ?? []) {
    if (!h?.name) continue;
    if (reserved.has(h.name.toLowerCase())) continue;
    root.setHeader(h.name, h.value ?? "");
  }

  // MimeNode drops Bcc from the output by default. Keep it: the stored draft
  // is what EmailSubmission/set derives the envelope from when the client
  // sends none, and without the header Bcc recipients were silently never
  // sent to. Submission strips it again before handing the message to SMTP.
  root.keepBcc = true;

  const message = await new Promise<Buffer>((resolve, reject) => {
    root.build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
  verifyAddressHeaders(message, addresses);
  return message;
}

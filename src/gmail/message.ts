import type { EmailBodyPart } from "../mapping/structure.js";
import { selectBodies } from "../mapping/structure.js";
import { asAddresses, asDate, asMessageIds, asText, projectHeaderProp } from "../imap/headers.js";
import { invalidArguments, JmapError } from "../jmap/errors.js";

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}
export const ALL_MAIL = "all";
/** Gmail labels that are states (read, starred, important) or another product (Chat), not places mail is filed. Keywords carry the states. */
export const HIDDEN_LABELS: ReadonlySet<string> = new Set(["UNREAD", "STARRED", "IMPORTANT", "CHAT"]);
/** The prefix clients use for a tag keyword. */
export const LABEL_KEYWORD = "$label:";
/**
 * The keyword that carries one Gmail user label.
 *
 * A Gmail label is not a folder: a message wears several at once, and that is
 * the part a JMAP mailbox cannot express - a client reading `mailboxIds` sees
 * the message filed in several places, not labelled. Clients that show tags
 * read them as `$label:<id>` keywords instead, so a label is offered both ways:
 * as a mailbox, which is what a folder view and its filters need, and as a
 * keyword, which is what puts the label back on the message.
 *
 * The id is the label's own name, so nesting survives - Gmail writes it with
 * "/" and so do those clients. Case is dropped because keywords are
 * case-insensitive; accents are folded and anything an IMAP flag cannot hold
 * is removed, which is why this can return null for a name made entirely of
 * such characters.
 */
export function labelKeyword(name: string): string | null {
  const id = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split("/")
    .map((level) =>
      level
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9._-]/g, ""),
    )
    .filter(Boolean)
    .join("/");
  return id ? LABEL_KEYWORD + id : null;
}
/** Named entities Gmail's snippet can carry; the numeric forms are handled by code point. */
const SNIPPET_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
};
/**
 * The one-line preview of a message, from Gmail's own snippet.
 *
 * Gmail returns the snippet **HTML-escaped** - an apostrophe arrives as
 * `&#39;` - because it is meant to be dropped into a page. JMAP's `preview` is
 * plain text: a client writes it into a list row or a system notification,
 * where the escape shows through as itself. So it is decoded here, once, at
 * the edge where Gmail's conventions stop.
 *
 * The same pass drops the invisible padding that bulk senders put after their
 * preheader - runs of combining grapheme joiners, zero-width spaces and soft
 * hyphens, meant to push the quoted body out of the inbox preview. Left in,
 * they are what the preview mostly consists of: "See who reached out" followed
 * by two hundred characters of nothing.
 */
export function snippetPreview(snippet: string | undefined): string {
  if (!snippet) return "";
  return snippet
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
      const ref = body.toLowerCase();
      if (ref.startsWith("#x")) {
        const code = Number.parseInt(ref.slice(2), 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
      }
      if (ref.startsWith("#")) {
        const code = Number.parseInt(ref.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
      }
      return SNIPPET_ENTITIES[ref] ?? match;
    })
    .replace(/[\u00ad\u034f\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function upstreamId(id: unknown, prefix: string): string {
  if (
    typeof id !== "string" ||
    !id.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(id.slice(prefix.length))
  ) {
    throw invalidArguments("Invalid Gmail object id");
  }
  return id.slice(prefix.length);
}
export function blobId(messageId: string, partId: string | null): string {
  return "gb_" + Buffer.from(JSON.stringify([messageId, partId])).toString("base64url");
}
export function parseBlob(id: string): [string, string | null] {
  try {
    if (!id.startsWith("gb_") || id.length > 512) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(id.slice(3), "base64url").toString());
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value[0]) ||
      (value[1] !== null && typeof value[1] !== "string")
    )
      throw new Error();
    return value as [string, string | null];
  } catch {
    throw new JmapError("notFound", "Invalid Gmail blob id");
  }
}
export function partTree(message: GmailMessage): { root: EmailBodyPart; parts: Map<string, GmailPart> } {
  const parts = new Map<string, GmailPart>();
  function walk(p: GmailPart, fallback: string): EmailBodyPart {
    const id = p.partId || fallback;
    const headers = p.headers ?? [];
    const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value;
    const type = (p.mimeType ?? "application/octet-stream").toLowerCase();
    const multipart = type.startsWith("multipart/");
    if (!multipart) parts.set(id, p);
    const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(header("content-type") ?? "")?.[1] ?? null;
    return {
      partId: multipart ? null : id,
      blobId: multipart ? null : blobId(message.id, id),
      size: p.body?.size ?? 0,
      headers,
      name: p.filename || null,
      type,
      charset,
      disposition: header("content-disposition")?.split(";")[0]?.trim().toLowerCase() ?? null,
      cid: header("content-id")?.replace(/^<|>$/g, "") ?? null,
      language:
        header("content-language")
          ?.split(",")
          .map((s) => s.trim()) ?? null,
      location: header("content-location") ?? null,
      encoding: null,
      subParts: multipart ? (p.parts ?? []).map((child, i) => walk(child, `${id}.${i}`)) : null,
    };
  }
  return { root: walk(message.payload ?? {}, "root"), parts };
}
export async function mapMessage(
  message: GmailMessage,
  args: Record<string, unknown>,
  getBytes: (p: GmailPart) => Promise<Buffer>,
  /** Keyword for a user label id, or null for labels that are not carried as tags. */
  tag: (labelId: string) => string | null = () => null,
): Promise<Record<string, unknown>> {
  const headers = (message.payload?.headers ?? []).map((h) => ({ name: h.name, rawValue: h.value }));
  const { root, parts } = partTree(message);
  const bodies = selectBodies(root);
  const keywords: Record<string, true> = {};
  const labels = message.labelIds ?? [];
  if (!labels.includes("UNREAD")) keywords.$seen = true;
  if (labels.includes("STARRED")) keywords.$flagged = true;
  if (labels.includes("DRAFT")) keywords.$draft = true;
  if (labels.includes("IMPORTANT")) keywords.$important = true;
  for (const id of labels) {
    const keyword = tag(id);
    if (keyword) keywords[keyword] = true;
  }
  const bodyValues: Record<string, unknown> = {};
  const requested = args.properties as string[] | null | undefined;
  if (
    (!requested || requested.includes("bodyValues")) &&
    (args.fetchTextBodyValues || args.fetchHTMLBodyValues || args.fetchAllBodyValues)
  ) {
    const selected = new Set([
      ...(args.fetchTextBodyValues ? bodies.textBody.map((p) => p.partId) : []),
      ...(args.fetchHTMLBodyValues ? bodies.htmlBody.map((p) => p.partId) : []),
    ]);
    const max = typeof args.maxBodyValueBytes === "number" ? args.maxBodyValueBytes : 256_000;
    if (!Number.isSafeInteger(max) || max < 0 || max > 8_000_000)
      throw invalidArguments("maxBodyValueBytes must be between 0 and 8000000");
    for (const [id, part] of parts) {
      if (!(part.mimeType ?? "").startsWith("text/") || (!args.fetchAllBodyValues && !selected.has(id)))
        continue;
      const bytes = await getBytes(part);
      const type = (part.headers ?? []).find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
      const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1] ?? "utf-8";
      let value: string;
      let isEncodingProblem = false;
      try {
        value = new TextDecoder(charset, { fatal: true }).decode(bytes);
      } catch {
        value = bytes.toString("utf8");
        isEncodingProblem = true;
      }
      const utf8 = Buffer.from(value);
      const truncated = utf8.length > max;
      // stream:true avoids introducing a replacement character when the limit cuts a UTF-8 code point.
      if (truncated) value = new TextDecoder().decode(utf8.subarray(0, max), { stream: true });
      bodyValues[id] = { value, isEncodingProblem, isTruncated: truncated };
    }
  }
  const record: Record<string, unknown> = {
    id: `m_${message.id}`,
    threadId: `t_${message.threadId}`,
    blobId: blobId(message.id, null),
    mailboxIds: Object.fromEntries(
      [ALL_MAIL, ...labels.filter((id) => !HIDDEN_LABELS.has(id)).map((id) => `l_${id}`)].map((id) => [
        id,
        true,
      ]),
    ),
    keywords,
    size: message.sizeEstimate ?? 0,
    receivedAt: new Date(Number(message.internalDate)).toISOString(),
    messageId: asMessageIds(headers, "Message-ID"),
    inReplyTo: asMessageIds(headers, "In-Reply-To"),
    references: asMessageIds(headers, "References"),
    sender: asAddresses(headers, "Sender"),
    from: asAddresses(headers, "From"),
    to: asAddresses(headers, "To"),
    cc: asAddresses(headers, "Cc"),
    bcc: asAddresses(headers, "Bcc"),
    replyTo: asAddresses(headers, "Reply-To"),
    subject: asText(headers, "Subject") ?? "",
    sentAt: asDate(headers, "Date"),
    preview: snippetPreview(message.snippet),
    headers: message.payload?.headers ?? [],
    bodyStructure: root,
    ...bodies,
    bodyValues,
  };
  if (!requested) return record;
  const result: Record<string, unknown> = { id: record.id };
  for (const property of requested) {
    if (property.startsWith("header:")) result[property] = projectHeaderProp(headers, property);
    else if (property in record) result[property] = record[property];
    else throw invalidArguments(`Unsupported Email property: ${property}`);
  }
  return result;
}

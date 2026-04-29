import type { FetchMessageObject, ImapFlow } from "imapflow";
import { selectBodies, structureToBodyParts, type EmailBodyPart } from "../mapping/structure.js";
import { flagsToKeywords } from "../mapping/flags.js";
import { encodeBlobId, encodeEmailId } from "../mapping/ids.js";
import type { AccountRow, MailboxRow } from "../state/store.js";

const META_QUERY = {
  uid: true as const,
  flags: true as const,
  size: true as const,
  internalDate: true as const,
  envelope: true as const,
  bodyStructure: true as const,
  headers: ["Message-ID", "References", "In-Reply-To"],
};

export interface JmapEmail {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: string;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: { name: string | null; email: string }[] | null;
  from: { name: string | null; email: string }[] | null;
  to: { name: string | null; email: string }[] | null;
  cc: { name: string | null; email: string }[] | null;
  bcc: { name: string | null; email: string }[] | null;
  replyTo: { name: string | null; email: string }[] | null;
  subject: string | null;
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
  bodyStructure: ReturnType<typeof structureToBodyParts>;
  textBody: ReturnType<typeof selectBodies>["textBody"];
  htmlBody: ReturnType<typeof selectBodies>["htmlBody"];
  attachments: ReturnType<typeof selectBodies>["attachments"];
  bodyValues: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }>;
}

export interface BodyFetchOpts {
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: number;
}

function decodePartText(buf: Buffer, charset: string | null): string {
  const cs = (charset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|br|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchBodyValues(
  client: ImapFlow,
  uid: number,
  textParts: EmailBodyPart[],
  htmlParts: EmailBodyPart[],
  attachments: EmailBodyPart[],
  opts: BodyFetchOpts,
): Promise<Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }>> {
  const wanted = new Map<string, EmailBodyPart>();
  const cap = opts.maxBodyValueBytes ?? 256_000;
  const includeAll = opts.fetchAllBodyValues === true;
  if (opts.fetchTextBodyValues || includeAll) {
    for (const p of textParts) if (p.partId) wanted.set(p.partId, p);
  }
  if (opts.fetchHTMLBodyValues || includeAll) {
    for (const p of htmlParts) if (p.partId) wanted.set(p.partId, p);
  }
  if (includeAll) {
    for (const p of attachments) {
      if (p.partId && p.type.startsWith("text/")) wanted.set(p.partId, p);
    }
  }
  const out: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }> = {};
  if (wanted.size === 0) return out;

  // Fetch all wanted body parts in a single FETCH instead of one round-trip
  // per part. For a typical multipart/alternative email this collapses
  // 2+ round-trips into one.
  const partIds = [...wanted.keys()];
  let bodyParts: Map<string, Buffer> | undefined;
  try {
    const msg = await client.fetchOne(
      `${uid}`,
      { uid: true, bodyParts: partIds },
      { uid: true },
    );
    if (msg && msg.bodyParts) bodyParts = msg.bodyParts;
  } catch {
    // fall through and mark all as encoding problems
  }

  for (const [partId, part] of wanted) {
    const raw = bodyParts?.get(partId);
    if (!raw) {
      out[partId] = { value: "", isEncodingProblem: true, isTruncated: false };
      continue;
    }
    const truncated = raw.length > cap;
    const slice = truncated ? raw.subarray(0, cap) : raw;
    const value = decodePartText(slice, part.charset);
    out[partId] = { value, isEncodingProblem: false, isTruncated: truncated };
  }
  return out;
}

function addr(list: { name?: string | null; address?: string | null }[] | null | undefined) {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.address)
    .map((a) => ({ name: a.name?.trim() || null, email: a.address! }));
}

async function processMessage(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  msg: FetchMessageObject,
  bodyOpts: BodyFetchOpts,
): Promise<JmapEmail> {
  const emailId = encodeEmailId({
    accountIdx: account.id,
    mailboxIdx: mailbox.id,
    uidvalidity: mailbox.uidvalidity,
    uid: msg.uid!,
  });
  const blobId = encodeBlobId(emailId);

  const root = structureToBodyParts(msg.bodyStructure as never, (partId) =>
    partId ? encodeBlobId(emailId, partId) : blobId,
  );
  const sel = selectBodies(root);

  const env = msg.envelope ?? null;

  const wantsBodies =
    bodyOpts.fetchTextBodyValues === true ||
    bodyOpts.fetchHTMLBodyValues === true ||
    bodyOpts.fetchAllBodyValues === true;
  const bodyValues = wantsBodies
    ? await fetchBodyValues(client, msg.uid!, sel.textBody, sel.htmlBody, sel.attachments, bodyOpts)
    : {};

  let preview = "";
  if (wantsBodies) {
    const firstText = sel.textBody[0]?.partId;
    if (firstText && bodyValues[firstText]) {
      preview = bodyValues[firstText].value.replace(/\s+/g, " ").trim().slice(0, 256);
    }
    if (!preview) {
      const firstHtml = sel.htmlBody[0]?.partId;
      if (firstHtml && bodyValues[firstHtml]) {
        preview = htmlToPlain(bodyValues[firstHtml].value).slice(0, 256);
      }
    }
  }

  return {
    id: emailId,
    blobId,
    threadId: emailId,
    mailboxIds: { [String(mailbox.id)]: true },
    keywords: flagsToKeywords(Array.from(msg.flags ?? [])),
    size: msg.size ?? 0,
    receivedAt: new Date(msg.internalDate ?? Date.now()).toISOString(),
    messageId: env?.messageId ? [stripBrackets(env.messageId)] : null,
    inReplyTo: env?.inReplyTo ? [stripBrackets(env.inReplyTo)] : null,
    references: null,
    sender: addr(env?.sender as never),
    from: addr(env?.from as never),
    to: addr(env?.to as never),
    cc: addr(env?.cc as never),
    bcc: addr(env?.bcc as never),
    replyTo: addr(env?.replyTo as never),
    subject: env?.subject ?? null,
    sentAt: env?.date ? new Date(env.date).toISOString() : null,
    hasAttachment: sel.hasAttachment,
    preview,
    bodyStructure: root,
    textBody: sel.textBody,
    htmlBody: sel.htmlBody,
    attachments: sel.attachments,
    bodyValues,
  };
}

export async function fetchEmailMeta(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  uid: number,
  bodyOpts: BodyFetchOpts = {},
): Promise<JmapEmail | null> {
  const msg = await client.fetchOne(`${uid}`, META_QUERY, { uid: true });
  if (!msg) return null;
  return processMessage(client, account, mailbox, msg, bodyOpts);
}

// Bulk variant: a single FETCH for all UIDs in a mailbox, then per-message
// body fetch (each already collapsed to one round trip by fetchBodyValues).
// Returns a Map keyed by uid so callers can match notFound by id.
export async function fetchEmailsBatch(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  uids: number[],
  bodyOpts: BodyFetchOpts = {},
): Promise<Map<number, JmapEmail>> {
  const out = new Map<number, JmapEmail>();
  if (uids.length === 0) return out;
  const messages: FetchMessageObject[] = [];
  for await (const m of client.fetch(uids, META_QUERY, { uid: true })) {
    messages.push(m);
  }
  for (const m of messages) {
    if (m.uid == null) continue;
    out.set(m.uid, await processMessage(client, account, mailbox, m, bodyOpts));
  }
  return out;
}

function stripBrackets(s: string): string {
  return s.replace(/^<|>$/g, "");
}

// Build an RFC 5322 / MIME message from a JMAP Email/set create payload.
// Used by Email/set create (drafts) which APPENDs the result via IMAP.
//
// We use nodemailer's MimeNode (already a transitive dep) to handle
// quoted-printable encoding, header folding, and message id generation.

import MimeNode from "nodemailer/lib/mime-node/index.js";

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

export interface JmapEmailCreate {
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
  bodyValues?: Record<string, BodyValue> | null;
  // Headers passed through verbatim (asRaw form). We don't attempt to
  // re-parse these; clients that send us structured forms should map them
  // before submission.
  headers?: { name: string; value: string }[] | null;
}

function jmapAddrToHeader(list: JmapAddress[] | null | undefined): string | null {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.email)
    .map((a) => {
      const name = a.name?.trim();
      const email = a.email!;
      if (!name) return email;
      // Quote names that contain RFC 5322 specials
      const escaped = /[",;:<>@()\[\]\\]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
      return `${escaped} <${email}>`;
    })
    .join(", ");
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

export async function buildRfc822(create: JmapEmailCreate, hostname: string): Promise<Buffer> {
  const text = resolveBody(create.textBody, create.bodyValues);
  const html = resolveBody(create.htmlBody, create.bodyValues);

  // Choose a root structure based on which bodies were supplied.
  let root: MimeNode;
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

  const setIfPresent = (header: string, value: string | null): void => {
    if (value) root.setHeader(header, value);
  };
  setIfPresent("From", jmapAddrToHeader(create.from));
  setIfPresent("Sender", jmapAddrToHeader(create.sender));
  setIfPresent("To", jmapAddrToHeader(create.to));
  setIfPresent("Cc", jmapAddrToHeader(create.cc));
  setIfPresent("Bcc", jmapAddrToHeader(create.bcc));
  setIfPresent("Reply-To", jmapAddrToHeader(create.replyTo));
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

  return await new Promise<Buffer>((resolve, reject) => {
    root.build((err: Error | null, message: Buffer) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

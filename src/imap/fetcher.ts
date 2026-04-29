import type { ImapFlow } from "imapflow";
import { selectBodies, structureToBodyParts } from "../mapping/structure.js";
import { flagsToKeywords } from "../mapping/flags.js";
import { encodeBlobId, encodeEmailId } from "../mapping/ids.js";
import type { AccountRow, MailboxRow } from "../state/store.js";

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
}

function addr(list: { name?: string | null; address?: string | null }[] | null | undefined) {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.address)
    .map((a) => ({ name: a.name?.trim() || null, email: a.address! }));
}

export async function fetchEmailMeta(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  uid: number,
): Promise<JmapEmail | null> {
  const msg = await client.fetchOne(
    `${uid}`,
    {
      uid: true,
      flags: true,
      size: true,
      internalDate: true,
      envelope: true,
      bodyStructure: true,
      headers: ["Message-ID", "References", "In-Reply-To"],
    },
    { uid: true },
  );
  if (!msg) return null;

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

  return {
    id: emailId,
    blobId,
    threadId: emailId, // refined by threads.ts when called via Email/get
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
    preview: "",
    bodyStructure: root,
    textBody: sel.textBody,
    htmlBody: sel.htmlBody,
    attachments: sel.attachments,
  };
}

function stripBrackets(s: string): string {
  return s.replace(/^<|>$/g, "");
}

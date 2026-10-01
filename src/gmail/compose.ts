import crypto from "node:crypto";
import { simpleParser } from "mailparser";
import { buildRfc822, type JmapEmailCreate, type BodyStructurePart } from "../mapping/buildMime.js";
import { JmapError } from "../jmap/errors.js";
import { SIDE_RESPONSES, type MethodTable } from "../jmap/router.js";
import { GmailNotSent, type GmailApi } from "./api.js";
import { GmailStore, type ScheduleRow } from "./store.js";
import { ALL_MAIL, HIDDEN_LABELS, upstreamId, type GmailMessage } from "./message.js";
import { writableLabel } from "./write.js";
import type { GmailLabel } from "./store.js";

const MAX_RAW = 25_000_000;
const fail = (type: string, description: string): never => {
  throw new JmapError(type, description);
};
const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : fail("invalidProperties", "Expected an object");
const line = (x: unknown): string =>
  typeof x === "string" && !/[\r\n\x00]/.test(x) ? x : fail("invalidProperties", "Invalid header value");
const address = (x: unknown): string => {
  const s = line(x);
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(s)) fail("invalidProperties", "Invalid email address");
  return s;
};
interface Draft {
  id: string;
  message: GmailMessage & { raw?: string };
}
/** Subset of Gmail users.settings.sendAs. */
export interface SendAs {
  sendAsEmail?: string;
  displayName?: string;
  replyToAddress?: string;
  isPrimary?: boolean;
  verificationStatus?: string;
}
interface Identity {
  id: string;
  name: string;
  email: string;
  replyTo: { email: string }[] | null;
  bcc: null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: false;
}
interface ComposeContext {
  email: string;
  accountId: string;
  api: Pick<GmailApi, "get" | "mutate">;
  store: GmailStore;
  enabled: () => Promise<boolean>;
  state: () => Promise<string>;
  download: (id: string) => Promise<{ body: Buffer; type: string }>;
  /** Current Gmail labels, for Email/import into places other than Drafts. */
  labels: () => Promise<GmailLabel[]>;
  exclusive: <T>(work: () => Promise<T>) => Promise<T>;
  /** Absent when GMAIL_ALIASES_ENABLED is off: only the account address may send. */
  sendAs?: (fresh: boolean) => Promise<SendAs[]>;
  /** Absent when GMAIL_SCHEDULE_ENABLED is off: HOLDFOR/HOLDUNTIL are rejected. */
  schedule?: { maxDelayedSend: number; lateTolerance: number };
}
/** Native Gmail drafts preserve Bcc and make an ambiguous send non-replayable. */
export class GmailCompose {
  constructor(private c: ComposeContext) {}
  private primary(): Identity {
    return {
      id: "gi_" + this.c.accountId,
      name: this.c.email,
      email: this.c.email,
      replyTo: null,
      bcc: null,
      textSignature: "",
      htmlSignature: "",
      mayDelete: false,
    };
  }
  /** Primary address plus verified aliases. Signatures stay client-side by design; Google signatures are never imported. */
  async identities(fresh = false): Promise<Identity[]> {
    const primary = this.primary();
    if (!this.c.sendAs) return [primary];
    const list = await this.c.sendAs(fresh);
    const seen = new Set<string>([primary.email]);
    const result = [primary];
    for (const entry of list) {
      const email = typeof entry.sendAsEmail === "string" ? entry.sendAsEmail.trim().toLowerCase() : "";
      if (!/^[^\s<>@,;]+@[^\s<>@,;]+$/.test(email)) continue;
      const name =
        typeof entry.displayName === "string" &&
        !/[\r\n\x00]/.test(entry.displayName) &&
        entry.displayName.trim()
          ? entry.displayName.trim()
          : email;
      const reply = typeof entry.replyToAddress === "string" ? entry.replyToAddress.trim().toLowerCase() : "";
      const replyTo = /^[^\s<>@,;]+@[^\s<>@,;]+$/.test(reply) && reply !== email ? [{ email: reply }] : null;
      if (email === primary.email || entry.isPrimary === true) {
        if (email === primary.email) {
          primary.name = name;
          primary.replyTo = replyTo;
        }
        continue;
      }
      // Pending or failed verification: Gmail would refuse the send, so never offer it.
      if (entry.verificationStatus !== "accepted" || seen.has(email)) continue;
      seen.add(email);
      result.push({
        ...primary,
        id:
          "gi_" +
          this.c.accountId +
          "_" +
          crypto.createHash("sha256").update(email).digest("hex").slice(0, 16),
        name,
        email,
        replyTo,
      });
    }
    return result;
  }
  /** Lower-case addresses allowed in From. Falls back to the primary address if Gmail settings are unreachable. */
  private async senders(): Promise<Set<string>> {
    const list = await this.identities().catch(() => [this.primary()]);
    return new Set(list.map((i) => i.email));
  }
  private async check(a?: Record<string, unknown>) {
    if (a && a.accountId !== this.c.accountId) fail("accountNotFound", "Wrong account");
    if (!(await this.c.enabled())) fail("accountReadOnly", "Composition disabled");
  }
  private async mutate<T>(
    resource: string,
    cost: number,
    method: "POST" | "DELETE",
    data?: unknown,
    params?: Record<string, string>,
  ): Promise<T> {
    this.c.store.invalidate(this.c.email);
    try {
      return await this.c.api.mutate<T>(resource, cost, method, data, params);
    } finally {
      this.c.store.invalidate(this.c.email);
    }
  }
  private placement(input: Record<string, unknown>) {
    const boxes = obj(input.mailboxIds ?? { l_DRAFT: true });
    if (
      !boxes.l_DRAFT ||
      Object.entries(boxes).some(([k, v]) => v !== true || !["l_DRAFT", "all"].includes(k))
    )
      fail("invalidProperties", "New mail must be a draft");
    const keywords = obj(input.keywords ?? { $draft: true });
    if (
      keywords.$draft !== true ||
      Object.entries(keywords).some(([k, v]) => v !== true || !["$draft", "$seen"].includes(k))
    )
      fail("invalidProperties", "Unsupported draft keywords");
  }
  /** Gmail labels for an Email/import that files mail somewhere other than Drafts.
   * Returns null when the input describes a draft, which keeps the drafts path. */
  private async importLabels(input: Record<string, unknown>): Promise<string[] | null> {
    const boxes = obj(input.mailboxIds ?? { l_DRAFT: true });
    if (boxes.l_DRAFT) {
      this.placement(input);
      return null;
    }
    const entries = Object.entries(boxes);
    if (!entries.length) fail("invalidProperties", "Message must belong to at least one mailbox");
    const labels = await this.c.labels();
    const ids = new Set<string>();
    for (const [id, value] of entries) {
      if (value !== true) fail("invalidProperties", "Mailbox membership must be true");
      if (id === ALL_MAIL) continue;
      const label = labels.find((l) => "l_" + l.id === id);
      if (!label) fail("invalidProperties", "Unknown mailbox");
      if (!writableLabel(label!)) fail("invalidProperties", "Mailbox is read-only");
      ids.add(label!.id);
    }
    const keywords = obj(input.keywords ?? {});
    for (const [key, value] of Object.entries(keywords)) {
      if (value !== true) fail("invalidProperties", "Keyword value must be true");
      if (key === "$draft") fail("invalidProperties", "Drafts can only be imported into the Drafts mailbox");
    }
    // Gmail has no place for other keywords ($answered, $forwarded, custom): they are dropped, not refused.
    if (!keywords.$seen) ids.add("UNREAD");
    if (keywords.$flagged) ids.add("STARRED");
    if (keywords.$important) ids.add("IMPORTANT");
    return [...ids];
  }
  /** File received mail through users.messages.import: no From check, ordering from the Date header. */
  private async importRaw(raw: Buffer, labelIds: string[]): Promise<Record<string, unknown>> {
    const imported = await this.mutate<Partial<GmailMessage> & { id: string }>(
      "messages/import",
      25,
      "POST",
      { raw: raw.toString("base64url"), labelIds },
      { internalDateSource: "dateHeader", neverMarkSpam: "true" },
    );
    // Gmail answers messages.import with the id alone: read the stored message for its thread and labels.
    const message =
      imported.threadId && imported.labelIds
        ? (imported as GmailMessage)
        : await this.c.api.get<GmailMessage>("messages/" + encodeURIComponent(imported.id), 5, {
            format: "minimal",
          });
    const labels = message.labelIds ?? labelIds;
    const keywords: Record<string, true> = {};
    if (!labels.includes("UNREAD")) keywords.$seen = true;
    if (labels.includes("STARRED")) keywords.$flagged = true;
    if (labels.includes("IMPORTANT")) keywords.$important = true;
    return {
      id: "m_" + message.id,
      threadId: "t_" + message.threadId,
      size: message.sizeEstimate ?? raw.length,
      mailboxIds: Object.fromEntries(
        [ALL_MAIL, ...labels.filter((id) => !HIDDEN_LABELS.has(id)).map((id) => "l_" + id)].map((id) => [id, true]),
      ),
      keywords,
    };
  }
  private async rawFromCreate(input: Record<string, unknown>): Promise<Buffer> {
    const permitted = new Set([
      "mailboxIds",
      "keywords",
      "from",
      "sender",
      "to",
      "cc",
      "bcc",
      "replyTo",
      "subject",
      "messageId",
      "inReplyTo",
      "references",
      "sentAt",
      "bodyValues",
      "textBody",
      "htmlBody",
      "attachments",
      "bodyStructure",
      "header:Disposition-Notification-To:asText",
    ]);
    for (const k of Object.keys(input))
      if (!permitted.has(k)) fail("invalidProperties", "Unsupported draft property");
    for (const key of ["from", "sender", "to", "cc", "bcc", "replyTo"])
      if (input[key] != null) {
        if (!Array.isArray(input[key]) || (input[key] as unknown[]).length > 500)
          fail("invalidProperties", "Invalid address list");
        for (const v of input[key] as unknown[]) {
          const a = obj(v);
          address(a.email);
          if (a.name != null) line(a.name);
        }
      }
    const from = input.from as { email: string }[] | undefined;
    const allowed = await this.senders();
    const sender = from?.length === 1 ? from[0]!.email.toLowerCase() : "";
    if (!allowed.has(sender))
      fail("invalidProperties", "From must match the account address or a verified Gmail send-as alias");
    const senderHeader = input.sender as { email: string }[] | undefined;
    if (
      senderHeader != null &&
      (senderHeader.length !== 1 || senderHeader[0]!.email.toLowerCase() !== sender)
    )
      fail("invalidProperties", "Sender must match From");
    if (input.subject != null) line(input.subject);
    for (const key of ["messageId", "inReplyTo", "references"])
      if (input[key] != null) {
        if (!Array.isArray(input[key])) fail("invalidProperties", "Invalid message IDs");
        for (const id of input[key] as unknown[])
          if (!/^[^<>\s]+$/.test(line(id))) fail("invalidProperties", "Invalid message ID");
      }
    if (input.sentAt != null && !Number.isFinite(Date.parse(line(input.sentAt))))
      fail("invalidProperties", "Invalid sentAt");
    const values = obj(input.bodyValues ?? {});
    for (const v of Object.values(values))
      if (typeof obj(v).value !== "string") fail("invalidProperties", "Invalid body value");
    const create = { ...input } as JmapEmailCreate;
    const receipt = input["header:Disposition-Notification-To:asText"];
    if (receipt != null) create.headers = [{ name: "Disposition-Notification-To", value: address(receipt) }];
    const list = (value: unknown): BodyStructurePart[] => {
      if (value == null) return [];
      if (!Array.isArray(value)) fail("invalidProperties", "Invalid body parts");
      return value as BodyStructurePart[];
    };
    if (input.bodyStructure && (input.textBody || input.htmlBody || input.attachments))
      fail("invalidProperties", "Overlapping body structure forms");
    if (!input.bodyStructure) {
      const text = list(input.textBody).map((p) => ({ ...p, type: p.type ?? "text/plain" }));
      const html = list(input.htmlBody).map((p) => ({ ...p, type: p.type ?? "text/html" }));
      const content = [...text, ...html];
      const body: BodyStructurePart =
        content.length > 1
          ? { type: "multipart/alternative", subParts: content }
          : (content[0] ?? { type: "text/plain", partId: "__empty" });
      if (!content.length) values.__empty = { value: "" };
      const attachments = list(input.attachments);
      create.bodyStructure = attachments.length
        ? { type: "multipart/mixed", subParts: [body, ...attachments] }
        : body;
    }
    create.bodyValues = values as JmapEmailCreate["bodyValues"];
    const blobs = new Map<string, { body: Buffer; ctype: string }>();
    let parts = 0,
      total = 0;
    const visit = async (p: BodyStructurePart, depth: number): Promise<void> => {
      obj(p);
      if (++parts > 100 || depth > 15) fail("invalidProperties", "Body structure too complex");
      for (const key of ["type", "name", "cid", "charset", "disposition"] as const)
        if (p[key] != null) line(p[key]);
      if (p.subParts) {
        for (const child of list(p.subParts)) await visit(child, depth + 1);
        return;
      }
      if (p.partId && values[p.partId]) {
        const v = values[p.partId];
        if (typeof obj(v).value !== "string") fail("invalidProperties", "Missing body value");
        total += Buffer.byteLength(obj(v).value as string);
      } else if (p.blobId) {
        if (!blobs.has(p.blobId)) {
          let data;
          try {
            data = await this.c.download(p.blobId);
          } catch (e) {
            if (e instanceof JmapError && e.type !== "notFound") throw e;
            fail(
              "blobNotFound",
              "Attachment is unavailable; reattach the file. The previous draft is retained.",
            );
          }
          blobs.set(p.blobId, { body: data!.body, ctype: data!.type });
        }
        total += blobs.get(p.blobId)!.body.length;
      } else fail("invalidProperties", "Body part has no content");
      if (total > MAX_RAW) fail("tooLarge", "Message exceeds the compose limit");
    };
    await visit(create.bodyStructure!, 0);
    const raw = await buildRfc822(create, this.c.email.split("@")[1]!, (id) => blobs.get(id) ?? null, true);
    if (raw.length > MAX_RAW)
      fail(
        "tooLarge",
        "Message exceeds the 25 MB encoded size limit. Reduce attachments (18 MB total recommended) or shorten the body. The previous draft is retained.",
      );
    return raw;
  }
  async create(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.check();
    this.placement(input);
    return this.createRaw(await this.rawFromCreate(input), input);
  }
  private async createRaw(raw: Buffer, input?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let threadId: string | undefined;
    const parent = (input?.inReplyTo as string[] | undefined)?.at(-1);
    if (parent) {
      const q = 'in:anywhere rfc822msgid:"' + parent.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
      const found = await this.c.api.get<{ messages?: { id: string; threadId: string }[] }>("messages", 5, {
        q,
        maxResults: "2",
        includeSpamTrash: "true",
      });
      const candidate = found.messages?.[0];
      if (candidate) {
        const original = await this.c.api.get<GmailMessage>(
          "messages/" + encodeURIComponent(candidate.id),
          5,
          { format: "metadata" },
        );
        const header = (name: string) =>
          original.payload?.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? "";
        const subject = (value: string) => value.replace(/^(?:re:\s*)+/i, "").trim();
        if (
          header("message-id").replace(/^<|>$/g, "") === parent &&
          subject(header("subject")) === subject(String(input?.subject ?? ""))
        )
          threadId = candidate.threadId;
      }
    }
    const draft = await this.mutate<Draft>("drafts", 10, "POST", {
      message: { raw: raw.toString("base64url"), ...(threadId ? { threadId } : {}) },
    });
    this.c.store.rememberDraft(this.c.email, draft.message.id, draft.id);
    return {
      id: "m_" + draft.message.id,
      threadId: "t_" + draft.message.threadId,
      size: raw.length,
      mailboxIds: { all: true, l_DRAFT: true },
      keywords: { $draft: true, $seen: true },
    };
  }
  private async findDraft(original: string): Promise<string> {
    const known = this.c.store.draft(this.c.email, original);
    if (known) return known.draft;
    let pageToken = "";
    const tokens = new Set<string>();
    do {
      const page = await this.c.api.get<{ drafts?: Draft[]; nextPageToken?: string }>("drafts", 5, {
        maxResults: "500",
        ...(pageToken ? { pageToken } : {}),
      });
      const found = page.drafts?.find((d) => d.message.id === original);
      if (found) {
        this.c.store.rememberDraft(this.c.email, original, found.id);
        return found.id;
      }
      pageToken = page.nextPageToken ?? "";
      if (tokens.has(pageToken) || tokens.size > 200) fail("serverUnavailable", "Draft listing failed");
      tokens.add(pageToken);
    } while (pageToken);
    return fail("notFound", "Draft not found");
  }
  private async checkedDraft(original: string, format = "minimal"): Promise<Draft> {
    const draft = await this.c.api.get<Draft>(
      "drafts/" + encodeURIComponent(await this.findDraft(original)),
      5,
      { format },
    );
    if (draft.message.id !== original || !draft.message.labelIds?.includes("DRAFT"))
      fail("notFound", "Draft has changed; refresh before continuing");
    return draft;
  }
  async destroy(id: string): Promise<void> {
    await this.check();
    const original = upstreamId(id, "m_");
    // A draft whose send outcome is uncertain may still be discarded: deleting it can never cause a second send.
    if (this.c.store.submission(this.c.email, original)?.result)
      fail("forbidden", "Submitted drafts cannot be deleted through this operation");
    const m = await this.c.api.get<GmailMessage>(
      "messages/" + encodeURIComponent(this.c.store.upstreamId(this.c.email, original)),
      5,
      { format: "minimal" },
    );
    if (!m.labelIds?.includes("DRAFT")) fail("forbidden", "Permanent mail deletion is disabled");
    const draft = await this.checkedDraft(original);
    await this.mutate("drafts/" + encodeURIComponent(draft.id), 10, "DELETE");
    // Every autosave creates a draft; its id mapping is only needed while the message exists.
    this.c.store.forgetDraft(this.c.email, original);
  }
  private async recipients(raw: Buffer, allowed: Set<string>) {
    const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
    const collect = (v: typeof parsed.to) =>
      !v ? [] : (Array.isArray(v) ? v : [v]).flatMap((x) => x.value.map((a) => address(a.address)));
    const from = collect(parsed.from).map((a) => a.toLowerCase());
    if (from.length !== 1 || !allowed.has(from[0]!))
      fail("invalidEmail", "Draft sender does not match an allowed identity");
    return {
      mailFrom: { email: from[0]! },
      rcptTo: [...new Set([...collect(parsed.to), ...collect(parsed.cc), ...collect(parsed.bcc)])].map(
        (email) => ({ email }),
      ),
    };
  }
  /** Validates a submission request against the live draft. Shared by immediate, scheduled and worker sends. */
  private async prepare(p: Record<string, unknown>, fresh = true) {
    if (typeof p.identityId !== "string" || !p.identityId.startsWith("gi_" + this.c.accountId))
      fail("invalidProperties", "Unknown identity");
    const original = upstreamId(p.emailId, "m_");
    // Re-read Gmail settings right before sending: an alias removed meanwhile must not be used, and the draft stays intact.
    const identities = await this.identities(fresh).catch((e) => {
      if (e instanceof JmapError && e.type !== "notFound") throw e;
      return fail(
        "serverUnavailable",
        "Could not verify the sending identity with Gmail; retry later. The draft is retained.",
      );
    });
    const identity =
      identities.find((i) => i.id === p.identityId) ??
      fail(
        "forbiddenFrom",
        "The selected sender is no longer a verified Gmail send-as address; choose another identity. The draft is retained.",
      );
    const draft = await this.checkedDraft(original, "raw");
    const raw = Buffer.from(draft.message.raw ?? "", "base64url");
    if (!raw.length || raw.length > MAX_RAW) fail("invalidEmail", "Invalid draft MIME");
    const envelope = await this.recipients(raw, new Set([identity.email]));
    if (!envelope.rcptTo.length) fail("noRecipients", "No recipients");
    if (envelope.rcptTo.length > 500) fail("tooManyRecipients", "Too many recipients");
    let hold: number | null = null;
    if (p.envelope != null) {
      const e = obj(p.envelope),
        from = obj(e.mailFrom);
      const rcpts = Array.isArray(e.rcptTo)
        ? e.rcptTo.map(obj)
        : fail("invalidProperties", "Invalid envelope");
      const params = { ...obj(from.parameters ?? {}) };
      if (params.HOLDFOR !== undefined || params.HOLDUNTIL !== undefined) {
        const schedule =
          this.c.schedule ?? fail("invalidProperties", "Delayed send is not enabled on this bridge");
        if (params.HOLDFOR !== undefined && params.HOLDUNTIL !== undefined)
          fail("invalidProperties", "Use either HOLDFOR or HOLDUNTIL");
        const seconds =
          params.HOLDFOR !== undefined
            ? Number(line(params.HOLDFOR))
            : Math.ceil((Date.parse(line(params.HOLDUNTIL)) - Date.now()) / 1000);
        if (!Number.isFinite(seconds) || seconds < 0 || !/^\d+$/.test(String(params.HOLDFOR ?? "0")))
          fail("invalidProperties", "Invalid hold time");
        if (seconds > schedule.maxDelayedSend) fail("invalidProperties", "Hold time exceeds maxDelayedSend");
        hold = Math.max(seconds, 0);
        delete params.HOLDFOR;
        delete params.HOLDUNTIL;
      }
      if (
        typeof from.email !== "string" ||
        from.email.toLowerCase() !== identity.email ||
        Object.keys(params).length ||
        rcpts.some((r) => Object.keys(obj(r.parameters ?? {})).length)
      )
        fail("invalidProperties", "Custom SMTP envelopes and extensions are unsupported");
      const actual = rcpts.map((r) => address(r.email).toLowerCase()).sort();
      const expected = envelope.rcptTo.map((r) => r.email.toLowerCase()).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        fail("invalidProperties", "Envelope must match draft recipients");
    }
    return { original, identity, draft, raw, envelope, hold };
  }
  private async submitOne(input: unknown): Promise<Record<string, unknown>> {
    const p = obj(input);
    for (const k of Object.keys(p))
      if (!["emailId", "identityId", "envelope"].includes(k))
        fail("invalidProperties", "Unsupported submission property");
    const original = upstreamId(p.emailId, "m_");
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex");
    const previous = this.c.store.submission(this.c.email, original);
    if (previous) {
      if (!previous.result)
        fail("serverFail", "Send outcome is uncertain; check Sent before attempting another send");
      if (previous.fingerprint !== fingerprint)
        fail("invalidProperties", "Draft already submitted with different options");
      const { fingerprint: _f, ...result } = JSON.parse(previous.result!);
      return result;
    }
    const { identity, draft, raw, envelope, hold } = await this.prepare(p);
    if (hold !== null) {
      // Scheduled: nothing crosses the network now. The draft stays in Gmail; its hash pins the approved version.
      const row = this.c.store.scheduleCreate({
        email: this.c.email,
        original,
        identity: identity.id,
        thread: "t_" + draft.message.threadId,
        envelope,
        rawHash: crypto.createHash("sha256").update(raw).digest("hex"),
        sendAt: Date.now() + hold * 1000,
      });
      return this.scheduled(row);
    }
    if (!this.c.store.beginSubmission(this.c.email, original, fingerprint))
      fail("serverFail", "Submission already in progress");
    // Persist the intent before crossing the network. An unknown outcome is never replayed.
    const sent = await this.mutate<GmailMessage>("drafts/send", 100, "POST", { id: draft.id }).catch((e) => {
      // Google never received or refused the send: nothing went out, so the draft stays sendable.
      if (e instanceof GmailNotSent) {
        this.c.store.abandonSubmission(this.c.email, original);
        throw e;
      }
      return fail(
        "serverFail",
        "Send outcome is uncertain. Check Sent before sending again; the bridge will not automatically retry this draft.",
      );
    });
    const result = {
      id: this.c.store.submission(this.c.email, original)!.id,
      emailId: "m_" + original,
      identityId: p.identityId,
      threadId: "t_" + sent.threadId,
      envelope,
      sendAt: new Date().toISOString(),
      undoStatus: "final",
      deliveryStatus: null,
      dsnBlobIds: [],
      mdnBlobIds: [],
    };
    this.c.store.finishSubmission(this.c.email, original, result, sent.id);
    return result;
  }
  /** JMAP view of a queue entry. Suspended/uncertain entries are final with an explanatory per-recipient status. */
  private scheduled(row: ScheduleRow): Record<string, unknown> {
    const status = (reply: string, delivered: string) =>
      Object.fromEntries(
        row.envelope.rcptTo.map((r) => [r.email, { smtpReply: reply, delivered, displayed: "unknown" }]),
      );
    const deliveryStatus =
      row.status === "suspended"
        ? status(
            "554 5.7.0 Not sent by the bridge: " +
              (row.reason ?? "suspended") +
              ". The draft is retained; send it again from Drafts.",
            "no",
          )
        : row.status === "uncertain"
          ? status("451 4.3.0 Send outcome unknown; check Sent before sending again", "unknown")
          : null;
    return {
      id: row.id,
      emailId: "m_" + row.original,
      identityId: row.identity,
      threadId: row.thread,
      envelope: row.envelope,
      sendAt: new Date(row.sendAt).toISOString(),
      undoStatus:
        row.status === "pending" || row.status === "sending"
          ? "pending"
          : row.status === "canceled"
            ? "canceled"
            : "final",
      deliveryStatus,
      dsnBlobIds: [],
      mdnBlobIds: [],
    };
  }
  private allSubmissions(): Record<string, unknown>[] {
    const queue = this.c.store.schedules(this.c.email).map((r) => this.scheduled(r));
    // Worker sends record their ledger entry under the queue id; list them once, as queue entries.
    const immediate = this.c.store
      .submissionResults(this.c.email)
      .filter((x) => !String((x as { fingerprint?: string }).fingerprint ?? "").startsWith("gq_"));
    return [...queue, ...immediate.map(({ fingerprint: _f, ...rest }) => rest)];
  }
  /** Due entries for this account; runs under the account write lock so cancels and sends never interleave. */
  async runDue(now = Date.now()): Promise<void> {
    if (!this.c.schedule) return;
    for (const row of this.c.store.scheduleDue(this.c.email, now)) {
      if (!this.c.store.scheduleLease(row.id)) continue;
      try {
        await this.sendScheduled(row, now);
      } catch {
        // Only an entry that recorded its send intent can have reached drafts.send; earlier failures retry next tick.
        const ledger = this.c.store.submission(this.c.email, row.original);
        if (!ledger || ledger.fingerprint !== row.id) this.c.store.scheduleRelease(row.id);
        else if (ledger.result) this.c.store.scheduleFinish(row.id, "sent", null);
        else this.c.store.scheduleFinish(row.id, "uncertain", "unexpected error during send; check Sent");
      }
    }
  }
  private async sendScheduled(row: ScheduleRow, now: number): Promise<void> {
    const suspend = (reason: string) => this.c.store.scheduleFinish(row.id, "suspended", reason);
    const schedule = this.c.schedule ?? fail("serverFail", "Scheduling disabled");
    if (now - row.sendAt > schedule.lateTolerance * 1000)
      return suspend("the bridge was unavailable at the scheduled time");
    if (!(await this.c.enabled())) return suspend("composition is disabled");
    const ledger = this.c.store.submission(this.c.email, row.original);
    if (ledger?.result)
      return this.c.store.scheduleFinish(row.id, "canceled", "superseded by another send of the same draft");
    if (ledger)
      return this.c.store.scheduleFinish(
        row.id,
        "uncertain",
        "a previous send of this draft has an unknown outcome",
      );
    let identities;
    try {
      identities = await this.identities(true);
    } catch {
      return this.c.store.scheduleRelease(row.id);
    } // transient: retry next tick
    const identity = identities.find((i) => i.id === row.identity);
    if (!identity) return suspend("the sending identity is no longer available in Gmail");
    let draft: Draft;
    try {
      draft = await this.checkedDraft(row.original, "raw");
    } catch (e) {
      if (e instanceof JmapError && e.type === "notFound")
        return suspend("the draft was deleted or replaced");
      return this.c.store.scheduleRelease(row.id);
    }
    const raw = Buffer.from(draft.message.raw ?? "", "base64url");
    if (crypto.createHash("sha256").update(raw).digest("hex") !== row.rawHash)
      return suspend("the draft was edited after scheduling");
    try {
      const envelope = await this.recipients(raw, new Set([identity.email]));
      if (!envelope.rcptTo.length) return suspend("no recipients");
    } catch {
      return suspend("the draft sender no longer matches the identity");
    }
    if (!this.c.store.beginSubmission(this.c.email, row.original, row.id))
      return this.c.store.scheduleFinish(row.id, "uncertain", "concurrent send of the same draft");
    let sent: GmailMessage;
    try {
      sent = await this.mutate<GmailMessage>("drafts/send", 100, "POST", { id: draft.id });
    } catch (e) {
      if (e instanceof GmailNotSent) {
        this.c.store.abandonSubmission(this.c.email, row.original);
        // Transient (authorization, rate limit): retry next tick within the late tolerance. Refused: suspend.
        if (e.type === "serverUnavailable") return this.c.store.scheduleRelease(row.id);
        return suspend("Google refused the send (" + e.message + ")");
      }
      return this.c.store.scheduleFinish(row.id, "uncertain", "Google did not confirm the send; check Sent");
    }
    const result = {
      ...this.scheduled({ ...row, status: "sent" }),
      threadId: "t_" + sent.threadId,
      sendAt: new Date().toISOString(),
      fingerprint: row.id,
    };
    this.c.store.finishSubmission(this.c.email, row.original, result, sent.id);
    this.c.store.scheduleFinish(row.id, "sent", null);
  }
  private async submit(a: Record<string, unknown>): Promise<unknown> {
    await this.check(a);
    const create = obj(a.create ?? {});
    if (Object.keys(create).length > 20) fail("requestTooLarge", "Too many submissions");
    if (a.ifInState != null) fail("stateMismatch", "Conditional submissions are unsupported");
    const update = obj(a.update ?? {});
    if (Object.keys(update).length > 20) fail("requestTooLarge", "Too many updates");
    if (Array.isArray(a.destroy) ? a.destroy.length : a.destroy != null)
      fail("forbidden", "Submission deletion is unsupported");
    if (
      a.onSuccessDestroyEmail != null &&
      (!Array.isArray(a.onSuccessDestroyEmail) || a.onSuccessDestroyEmail.length)
    )
      fail("invalidProperties", "Gmail already files sent drafts; destruction is unsupported");
    const patches = obj(a.onSuccessUpdateEmail ?? {});
    for (const patch of Object.values(patches)) {
      const p = obj(patch);
      if (
        Object.keys(p).some((k) => !["mailboxIds", "keywords/$draft"].includes(k)) ||
        p["keywords/$draft"] !== null ||
        JSON.stringify(obj(p.mailboxIds)) !== JSON.stringify({ l_SENT: true })
      )
        fail("invalidProperties", "Only Gmail native Sent filing is supported");
    }
    const oldState = String(this.c.store.revision(this.c.email));
    const created: Record<string, unknown> = Object.create(null),
      notCreated: Record<string, unknown> = Object.create(null),
      updated: Record<string, unknown> = Object.create(null),
      notUpdated: Record<string, unknown> = Object.create(null);
    const sideUpdated: Record<string, unknown> = Object.create(null),
      sideNotUpdated: Record<string, unknown> = Object.create(null);
    for (const [key, input] of Object.entries(create)) {
      try {
        const result = await this.submitOne(input);
        created[key] = result;
        if (patches["#" + key] || patches[result.id as string]) {
          if (result.undoStatus === "pending")
            sideNotUpdated[result.emailId as string] = {
              type: "forbidden",
              description:
                "Gmail files the message in Sent when it is actually sent; it stays a draft until then",
            };
          else
            sideUpdated[result.emailId as string] = {
              mailboxIds: { all: true, l_SENT: true },
              keywords: { $seen: true },
            };
        }
      } catch (e) {
        notCreated[key] =
          e instanceof JmapError
            ? e.toMethodError()
            : { type: "serverFail", description: "Submission failed; verify Sent before retrying" };
      }
    }
    for (const [id, patch] of Object.entries(update)) {
      try {
        const p = obj(patch);
        if (Object.keys(p).some((k) => k !== "undoStatus") || p.undoStatus !== "canceled")
          fail("invalidProperties", "Only undoStatus can be set to canceled");
        if (!this.c.schedule || !id.startsWith("gq_"))
          fail(
            this.c.store.submissionResults(this.c.email).some((x) => x.id === id)
              ? "cannotUnsend"
              : "notFound",
            "Only pending scheduled submissions can be canceled",
          );
        const outcome = this.c.store.scheduleCancel(this.c.email, id);
        if (outcome === "done") {
          updated[id] = null;
          continue;
        }
        if (outcome === "missing") fail("notFound", "Unknown submission");
        fail(
          "cannotUnsend",
          outcome === "sending"
            ? "The message is being handed to Google right now and can no longer be canceled"
            : "The message has already been sent or is no longer pending",
        );
      } catch (e) {
        notUpdated[id] = e instanceof JmapError ? e.toMethodError() : { type: "serverFail" };
      }
    }
    const result: Record<string | symbol, unknown> = {
      accountId: this.c.accountId,
      oldState,
      newState: String(this.c.store.revision(this.c.email)),
      created: Object.keys(created).length ? created : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      updated: Object.keys(updated).length ? updated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      destroyed: null,
      notDestroyed: null,
    };
    if (Object.keys(sideUpdated).length || Object.keys(sideNotUpdated).length)
      result[SIDE_RESPONSES] = [
        [
          "Email/set",
          {
            accountId: this.c.accountId,
            oldState: null,
            newState: await this.c.state().catch(() => `w${this.c.store.revision(this.c.email)}`),
            updated: Object.keys(sideUpdated).length ? sideUpdated : null,
            notUpdated: Object.keys(sideNotUpdated).length ? sideNotUpdated : null,
          },
          "",
        ],
      ];
    return result;
  }
  private async importEmails(a: Record<string, unknown>): Promise<unknown> {
    if (a.accountId !== this.c.accountId) fail("accountNotFound", "Wrong account");
    const emails = obj(a.emails);
    if (Object.keys(emails).length > 20) fail("requestTooLarge", "Too many imports");
    const oldState = await this.c.state();
    if (a.ifInState != null && a.ifInState !== oldState) fail("stateMismatch", "Email state changed");
    const created: Record<string, unknown> = Object.create(null),
      notCreated: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(emails))
      try {
        const p = obj(value);
        for (const k of Object.keys(p))
          if (!["blobId", "mailboxIds", "keywords", "receivedAt"].includes(k))
            fail("invalidProperties", "Unsupported import property");
        // receivedAt is accepted for compatibility; Gmail orders imported mail by its Date header.
        const labelIds = await this.importLabels(p);
        if (typeof p.blobId !== "string") fail("blobNotFound", "Missing MIME blob");
        const data = await this.c.download(p.blobId as string);
        if (!data.body.length || data.body.length > MAX_RAW) fail("tooLarge", "MIME import exceeds limit");
        if (labelIds) {
          created[key] = await this.importRaw(data.body, labelIds);
          continue;
        }
        if (!(await this.c.enabled())) fail("accountReadOnly", "Composition disabled");
        await this.recipients(data.body, await this.senders());
        created[key] = await this.createRaw(data.body);
      } catch (e) {
        notCreated[key] = e instanceof JmapError ? e.toMethodError() : { type: "invalidEmail" };
      }
    return {
      accountId: this.c.accountId,
      oldState,
      newState: await this.c.state().catch(() => `w${this.c.store.revision(this.c.email)}`),
      created: Object.keys(created).length ? created : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
    };
  }
  methods(): MethodTable {
    return {
      "Email/import": (a) => this.c.exclusive(() => this.importEmails(a)),
      "Identity/get": async (a) => {
        await this.check(a);
        // Settings outages degrade to the primary address so composing keeps working; sending re-validates anyway.
        const list = await this.identities().catch(() => [this.primary()]);
        const ids = a.ids as string[] | null | undefined;
        if (ids != null && (!Array.isArray(ids) || ids.length > 100)) fail("invalidArguments", "Invalid ids");
        const state =
          "identity-" + crypto.createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 16);
        return {
          accountId: this.c.accountId,
          state,
          list: ids ? list.filter((i) => ids.includes(i.id)) : list,
          notFound: (ids ?? []).filter((id) => !list.some((i) => i.id === id)),
        };
      },
      "Identity/set": async (a) => {
        await this.check(a);
        throw new JmapError("forbidden", "Configure identities in Gmail");
      },
      "EmailSubmission/set": (a) => this.c.exclusive(() => this.submit(a)),
      "EmailSubmission/get": async (a) => {
        await this.check(a);
        const all = this.allSubmissions();
        const ids = a.ids as string[] | null | undefined;
        if (ids != null && (!Array.isArray(ids) || ids.length > 100)) fail("invalidArguments", "Invalid ids");
        return {
          accountId: this.c.accountId,
          state: String(this.c.store.revision(this.c.email)),
          list: ids ? all.filter((x) => ids.includes(x.id as string)) : all,
          notFound: (ids ?? []).filter((id) => !all.some((x) => x.id === id)),
        };
      },
      "EmailSubmission/query": async (a) => {
        await this.check(a);
        if (a.filter != null && Object.keys(obj(a.filter)).length)
          fail("unsupportedFilter", "Submission filters are unsupported");
        if (a.sort != null && (!Array.isArray(a.sort) || a.sort.length))
          fail("unsupportedSort", "Submission sorting is fixed: newest first");
        const all = this.allSubmissions();
        const position = Number(a.position ?? 0),
          limit = Number(a.limit ?? 100);
        if (
          !Number.isSafeInteger(position) ||
          position < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 500
        )
          fail("invalidArguments", "Invalid position or limit");
        return {
          accountId: this.c.accountId,
          queryState: String(this.c.store.revision(this.c.email)),
          canCalculateChanges: false,
          position,
          total: all.length,
          ids: all.slice(position, position + limit).map((x) => x.id),
        };
      },
    };
  }
}

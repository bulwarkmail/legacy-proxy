import {
  readHistory,
  affected,
  emailDelta,
  addedMessages,
  isDelivery,
  type HistoryRecord,
} from "./history.js";
import { GmailCompose, type SendAs } from "./compose.js";
import { GMAIL_MODIFY } from "./config.js";
import { emailPatch, labelInput, writableLabel } from "./write.js";
import crypto from "node:crypto";
import { GmailApi, MAX_BATCH, MAX_CONCURRENT } from "./api.js";
import { GmailStore, type GmailProfile, type GmailLabel } from "./store.js";
import { GmailSubscriptions } from "./subscriptions.js";
import {
  ALL_MAIL,
  HIDDEN_LABELS,
  labelKeyword,
  upstreamId,
  mapMessage,
  partTree,
  parseBlob,
  type GmailMessage,
  type GmailPart,
} from "./message.js";
import { gmailFilter, mailboxFilter } from "./filter.js";
import {
  JmapError,
  accountNotFound,
  invalidArguments,
  unsupportedSort,
} from "../jmap/errors.js";
import type { MethodTable } from "../jmap/router.js";

const hash = (value: unknown) =>
  crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 32);
export const gmailAccountId = (email: string) =>
  "g_" + hash(email.toLowerCase());
const ROLES: Record<string, string> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  SPAM: "junk",
  TRASH: "trash",
};
const MAX_GET = 100;
/**
 * Mailboxes are the whole label set of the account, already materialised in
 * memory, and a client that asks for every folder (`ids: null`, which is what
 * Bulwark sends) has to get every folder. `maxObjectsInGet` bounds how many
 * ids a *caller* may name, not how big the folder list may be - capping the
 * full list at 100 left accounts with more labels (a Workspace mailbox with
 * 124) with no folders at all. Gmail's own ceiling is 10k labels.
 */
const MAX_MAILBOX_GET = 10_000;
const MAX_QUERY = 100;
const MAX_BLOB = 50_000_000;
/** Email properties Gmail's metadata format can answer (plus any `header:` projection). */
/** How long an idle account keeps its label counters; any change moves the cache key first. */
const LABELS_TTL = 10 * 60_000;
const METADATA_PROPERTIES: ReadonlySet<string> = new Set([
  "id",
  "threadId",
  "blobId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "preview",
  "headers",
]);

/**
 * How long a cached message may outlive its last read.
 *
 * Correctness does not rest on this number. Every change Gmail reports through
 * `history.list` evicts the messages it names (see `GmailStore.checkpoint`),
 * and a cursor too old to replay drops the account's cache wholesale, so an
 * entry that is still here is an entry Gmail has said nothing about. What the
 * expiry bounds is how long an untouched entry occupies the per-account
 * budget, which is what ordinarily reclaims space instead.
 *
 * At the previous thirty minutes, opening the client after lunch meant reading
 * the same page from Google again.
 */
const MESSAGE_TTL = 30 * 24 * 60 * 60_000;

export class GmailMail {
  readonly accountId: string;
  private composer: GmailCompose;
  private writeTail: Promise<unknown> = Promise.resolve();
  private queuedWrites = 0;
  private syncFlight?: Promise<void>;
  private flights = new Map<string, Promise<unknown>>();
  /** Messages Gmail delivered during the last incremental sync, for push fan-out. */
  private lastDelivered: string[] = [];
  readonly subscriptions: GmailSubscriptions;
  constructor(
    private email: string,
    private api: Pick<GmailApi, "get"> &
      Partial<Pick<GmailApi, "mutate" | "batch">>,
    private store: GmailStore,
    private writeEnabled = false,
    private composeEnabled = false,
    private aliasesEnabled = false,
    private schedule?: { maxDelayedSend: number; lateTolerance: number },
    private pushEnabled = false,
    private labelTags = true,
  ) {
    this.accountId = gmailAccountId(email);
    this.subscriptions = new GmailSubscriptions(
      email,
      store,
      { warn: () => {} },
      this.accountId,
    );
    this.composer = new GmailCompose({
      email,
      accountId: this.accountId,
      api: api as Pick<GmailApi, "get" | "mutate">,
      store,
      enabled: () => this.canCompose(),
      state: () => this.state(),
      download: (id) => this.download(id),
      labels: () => this.labels(),
      exclusive: (work) => this.exclusive(work),
      ...(aliasesEnabled
        ? { sendAs: (fresh: boolean) => this.sendAs(fresh) }
        : {}),
      ...(schedule ? { schedule } : {}),
    });
  }
  /** New arrivals only: label changes, sends and drafts must never wake a device. */
  private async deliveries(records: HistoryRecord[]): Promise<string[]> {
    const out: string[] = [];
    const unknown: string[] = [];
    for (const [id, labels] of addedMessages(records)) {
      const verdict = isDelivery(labels);
      if (verdict) out.push(id);
      else if (verdict === undefined) unknown.push(id);
    }
    // Older history records omit labelIds; ask Gmail rather than guess, and never for a whole mailbox.
    for (const id of unknown.slice(0, 20)) {
      try {
        const m = await this.api.get<GmailMessage>(
          `messages/${encodeURIComponent(id)}`,
          5,
          { format: "minimal" },
        );
        if (isDelivery(m.labelIds ?? [])) out.push(id);
      } catch {
        // Deleted between the history record and this read: not a delivery.
      }
    }
    return out;
  }
  /** Push/recovery entry point: refresh the profile and run the incremental engine. */
  async pushSync(): Promise<{ changed: boolean; delivered: number }> {
    const before =
      this.store.revision(this.email) +
      ":" +
      (this.store.cursor(this.email) ?? "");
    this.lastDelivered = [];
    const fresh = await this.api.get<GmailProfile>("profile", 1);
    this.store.cache(this.email, "profile", fresh, 30_000);
    await this.profile();
    return {
      changed:
        before !==
        this.store.revision(this.email) +
          ":" +
          (this.store.cursor(this.email) ?? ""),
      delivered: this.lastDelivered.length,
    };
  }
  /**
   * The messages this account has just received, as a push subscriber asked
   * to see them (draft-ietf-jmap-emailpush).
   *
   * Reads through the same cache the arrival warm-up fills, so in the common
   * case answering costs no Gmail call at all. A message that has already
   * gone - moved to Trash, deleted from another client between the history
   * record and this read - is left out: a notification for it would open
   * onto nothing.
   */
  async deliveredEmails(
    properties: string[],
  ): Promise<Record<string, unknown>[]> {
    const ids = [...this.lastDelivered];
    if (ids.length === 0) return [];
    const format = properties.every((p) => METADATA_PROPERTIES.has(p))
      ? "metadata"
      : "full";
    await this.prefetch(ids, format).catch(() => {});
    const tag = await this.tags();
    const out: Record<string, unknown>[] = [];
    for (const id of ids) {
      try {
        const message = await this.message(id, format);
        const record = await mapMessage(
          message,
          { properties },
          (part) => this.bytes(message.id, part),
          tag,
        );
        record.id = "m_" + this.store.originalId(this.email, message.id);
        out.push(record);
      } catch {
        // Gone, or never readable: not something to wake a device for.
      }
    }
    return out;
  }
  /** Current per-type states for a StateChange event. `EmailDelivery` only when mail actually arrived. */
  async states(delivered = false): Promise<Record<string, string>> {
    const email = await this.state();
    return {
      Email: email,
      Thread: email,
      Mailbox: await this.mailboxState(),
      ...(delivered ? { EmailDelivery: email } : {}),
    };
  }
  /** users.watch: Gmail publishes to the topic for at most 7 days; renew daily. */
  async watch(topic: string): Promise<{ expiration: number; history: string }> {
    if (!this.api.mutate) throw new JmapError("accountReadOnly");
    const r = await this.api.mutate<{
      historyId?: string;
      expiration?: string;
    }>("watch", 100, "POST", {
      topicName: topic,
      labelFilterBehavior: "INCLUDE",
    });
    const expiration = Number(r.expiration);
    const history = String(r.historyId ?? "");
    if (!Number.isFinite(expiration) || !/^\d+$/.test(history))
      throw new JmapError("serverFail", "Unexpected watch response");
    this.store.watchSave(this.email, expiration, history);
    return { expiration, history };
  }
  /** Worker entry point: sends due scheduled submissions under the account write lock. */
  runScheduled(now = Date.now()): Promise<void> {
    return this.exclusive(() => this.composer.runDue(now));
  }
  private async cached<T>(
    key: string,
    ttl: number,
    fetch: () => Promise<T>,
  ): Promise<T> {
    const cached = this.store.cached<T>(this.email, key);
    if (cached !== null) return cached;
    const revision = this.store.revision(this.email);
    const flightKey = `${revision}:${key}`;
    const pending = this.flights.get(flightKey);
    if (pending) return pending as Promise<T>;
    if (this.flights.size >= 100)
      throw new JmapError(
        "serverUnavailable",
        "Too many concurrent Gmail reads",
      );
    const task = fetch()
      .then((data) => {
        if (this.store.revision(this.email) === revision)
          this.store.cache(this.email, key, data, ttl);
        return data;
      })
      .finally(() => this.flights.delete(flightKey));
    this.flights.set(flightKey, task);
    return task;
  }
  async profile(): Promise<GmailProfile> {
    const profile = await this.cached("profile", 30_000, () =>
      this.api.get<GmailProfile>("profile", 1),
    );
    if (this.syncFlight) await this.syncFlight;
    const cursor = this.store.cursor(this.email);
    if (cursor === profile.historyId) return profile;
    if (!cursor) {
      this.store.checkpoint(this.email, profile.historyId, [], []);
      return profile;
    }
    // A stale concurrent profile response must not move a persisted cursor backwards.
    if (BigInt(profile.historyId) < BigInt(cursor)) {
      const fresh = await this.api.get<GmailProfile>("profile", 1);
      this.store.cache(this.email, "profile", fresh, 30_000);
      if (BigInt(fresh.historyId) > BigInt(cursor)) return this.profile();
      return { ...fresh, historyId: cursor };
    }
    const revision = this.store.revision(this.email);
    this.syncFlight = (async () => {
      try {
        const history = await readHistory(this.api, cursor);
        this.lastDelivered = await this.deliveries(history.records);
        if (this.store.revision(this.email) === revision) {
          const changed = affected(history.records);
          this.store.checkpoint(
            this.email,
            history.historyId,
            changed.messages,
            changed.threads,
          );
          // What just arrived is what the client reads next. Fetching it here,
          // in one batch, is the difference between a notification the user
          // opens instantly and one that waits on Google. Detached on purpose:
          // nothing about this request depends on it.
          void this.prefetch(
            changed.messages.slice(0, MAX_BATCH),
            "metadata",
          ).catch(() => {});
        }
      } catch (e) {
        if (!(e instanceof JmapError) || e.type !== "cannotCalculateChanges")
          throw e;
        if (this.store.revision(this.email) === revision)
          this.store.checkpoint(this.email, profile.historyId, [], [], true);
      }
    })().finally(() => {
      this.syncFlight = undefined;
    });
    await this.syncFlight;
    return {
      ...profile,
      historyId: this.store.cursor(this.email) ?? profile.historyId,
    };
  }
  async writable(): Promise<boolean> {
    return (
      this.writeEnabled &&
      !!(await this.store.load(this.email))?.credentials.scopes?.includes(
        GMAIL_MODIFY,
      )
    );
  }
  async canCompose(): Promise<boolean> {
    return this.composeEnabled && (await this.writable());
  }
  /** Gmail "Send mail as" settings; readable with gmail.modify. A fresh read bypasses the cache before sending. */
  private async sendAs(fresh: boolean): Promise<SendAs[]> {
    const read = async () =>
      (await this.api.get<{ sendAs?: SendAs[] }>("settings/sendAs", 5))
        .sendAs ?? [];
    if (!fresh) return this.cached("sendAs", 300_000, read);
    const list = await read();
    this.store.cache(this.email, "sendAs", list, 300_000);
    return list;
  }
  async upload(body: Buffer, type: string): Promise<string> {
    if (!(await this.canCompose())) throw new JmapError("accountReadOnly");
    try {
      return this.store.upload(this.email, body, type);
    } catch {
      throw new JmapError("tooLarge", "Upload quota exceeded");
    }
  }
  async state(): Promise<string> {
    const history = (await this.profile()).historyId;
    const revision = this.store.revision(this.email);
    return "g" + history + (revision ? "r" + revision : "");
  }
  async mailboxState(): Promise<string> {
    const records = await this.mailboxes();
    const state = hash(records);
    this.store.mailboxSnapshot(
      this.email,
      state,
      Object.fromEntries(records.map((r) => [r.id as string, hash(r)])),
    );
    return state;
  }
  /**
   * The label set without counters: one Gmail call, whatever the account size.
   * Enough to know which labels exist, what they are called and which role
   * they carry - everything but `messages*`/`threads*`, which only
   * `labels.get` reports.
   */
  async labelList(): Promise<GmailLabel[]> {
    const state = await this.state();
    const data = await this.cached<{ labels?: GmailLabel[] }>(
      "labellist:" + state,
      60_000,
      () => this.api.get<{ labels?: GmailLabel[] }>("labels", 1),
    );
    return data.labels ?? [];
  }
  /**
   * Counters for one label. A folder page and an unread badge each need a
   * single label's numbers; reaching them through {@link labels} costs one
   * Gmail call per label in the account (124 of them on a real Workspace
   * mailbox, ~7.5 s), which is what used to time out a push preview.
   */
  async labelDetail(id: string): Promise<GmailLabel | undefined> {
    const state = await this.state();
    try {
      return await this.cached<GmailLabel>(
        `label:${id}:${state}`,
        60_000,
        () => this.api.get<GmailLabel>(`labels/${encodeURIComponent(id)}`, 1),
      );
    } catch (error) {
      if (error instanceof JmapError && error.type === "notFound")
        return undefined;
      throw error;
    }
  }
  /**
   * Every label with its counters. Gmail reports counters only per label, so
   * this is one read per label; through the batch endpoint they travel 100 to
   * a request instead of 12 at a time - on a Workspace mailbox with 124 labels
   * that is 2 round trips instead of 11, ~3.5 s down to a fraction. Still keep
   * it off the paths that need one label or no counter at all.
   *
   * The cache key carries the account state, which moves with every history
   * record, so counters are never older than the last change Gmail reported;
   * the time limit only bounds how long an idle account keeps the entry.
   */
  async labels(): Promise<GmailLabel[]> {
    const state = await this.state();
    return this.cached("labels:" + state, LABELS_TTL, async () => {
      const listed = await this.labelList();
      const one = (label: GmailLabel) =>
        this.api.get<GmailLabel>(`labels/${encodeURIComponent(label.id)}`, 1);
      if (this.api.batch && listed.length > 1) {
        try {
          const labels: GmailLabel[] = [];
          for (let offset = 0; offset < listed.length; offset += MAX_BATCH) {
            const page = listed.slice(offset, offset + MAX_BATCH);
            const answers = await this.api.batch<GmailLabel>(
              page.map((label) => ({ resource: `labels/${encodeURIComponent(label.id)}` })),
              1,
            );
            // A part that failed on its own is read on its own.
            labels.push(
              ...(await Promise.all(
                page.map((label, index) => answers[index]?.data ?? one(label)),
              )),
            );
          }
          return labels;
        } catch (error) {
          // A batch Google throttled must not fall back to one read per
          // label: that would spend the same exhausted budget again.
          if (error instanceof JmapError && error.type === "serverUnavailable")
            throw error;
        }
      }
      // One in-flight batch per concurrency slot; label detail supplies exact message/thread counts.
      const labels: GmailLabel[] = [];
      for (let offset = 0; offset < listed.length; offset += MAX_CONCURRENT) {
        labels.push(
          ...(await Promise.all(
            listed
              .slice(offset, offset + MAX_CONCURRENT)
              .map((label) =>
                this.api.get<GmailLabel>(
                  `labels/${encodeURIComponent(label.id)}`,
                  1,
                ),
              ),
          )),
        );
      }
      return labels;
    });
  }
  /**
   * Resolves a Gmail label id to the keyword that carries it, for user labels
   * only: system labels are folders and states, which `mapMessage` already
   * reads. Built from the cheap label listing, which is cached per account
   * state, so this costs nothing per message.
   */
  private async tags(): Promise<(labelId: string) => string | null> {
    if (!this.labelTags) return () => null;
    const keywords = new Map<string, string>();
    for (const label of await this.labelList()) {
      const keyword = label.type === "user" ? labelKeyword(label.name) : null;
      if (keyword) keywords.set(label.id, keyword);
    }
    return (id) => keywords.get(id) ?? null;
  }
  private account(args: Record<string, unknown>): void {
    if (args.accountId !== this.accountId) throw accountNotFound();
  }
  private ids(
    args: Record<string, unknown>,
    max: number = MAX_GET,
  ): string[] | null {
    if (args.ids == null) return null;
    if (
      !Array.isArray(args.ids) ||
      args.ids.some((id) => typeof id !== "string")
    )
      throw invalidArguments("ids must be an array of strings or null");
    if (args.ids.length > max) throw new JmapError("requestTooLarge");
    return args.ids as string[];
  }
  private properties(args: Record<string, unknown>): string[] | null {
    if (args.properties == null) return null;
    if (
      !Array.isArray(args.properties) ||
      args.properties.some((p) => typeof p !== "string")
    )
      throw invalidArguments("properties must be strings");
    return args.properties as string[];
  }
  private project(
    record: Record<string, unknown>,
    properties: string[] | null,
  ): Record<string, unknown> {
    if (!properties) return record;
    const result: Record<string, unknown> = { id: record.id };
    for (const key of properties) {
      if (!(key in record))
        throw invalidArguments(`Unsupported property: ${key}`);
      result[key] = record[key];
    }
    return result;
  }
  /**
   * The account's folders. `counts: false` builds them from the cheap label
   * listing, leaving every `*Emails`/`*Threads` figure at zero: that is all a
   * `Mailbox/query` needs (it answers with ids), and it spares an account with
   * many labels one Gmail call per label.
   */
  async mailboxes(
    opts: { counts?: boolean } = {},
  ): Promise<Record<string, unknown>[]> {
    const counts = opts.counts !== false;
    const [labels, profile, writable] = await Promise.all([
      counts ? this.labels() : this.labelList(),
      this.profile(),
      this.writable(),
    ]);
    const unread = labels.find((label) => label.id === "UNREAD");
    const all: GmailLabel = {
      id: ALL_MAIL,
      name: "All mail",
      type: "system",
      messagesTotal: profile.messagesTotal,
      messagesUnread: unread?.messagesTotal ?? 0,
      threadsTotal: profile.threadsTotal,
      threadsUnread: unread?.threadsTotal ?? 0,
    };
    // Gmail names system labels after their ids ("INBOX", "CATEGORY_SOCIAL").
    const names: Record<string, string> = {
      INBOX: "Inbox",
      SENT: "Sent",
      DRAFT: "Drafts",
      SPAM: "Spam",
      TRASH: "Trash",
      CATEGORY_PERSONAL: "Personal",
      CATEGORY_SOCIAL: "Social",
      CATEGORY_PROMOTIONS: "Promotions",
      CATEGORY_UPDATES: "Updates",
      CATEGORY_FORUMS: "Forums",
    };
    const visible = labels.filter((label) => !HIDDEN_LABELS.has(label.id));
    return [all, ...visible].map((label) => ({
      id: label.id === ALL_MAIL ? ALL_MAIL : "l_" + label.id,
      name:
        label.type === "system" && label.name === label.id
          ? (names[label.id] ?? label.name)
          : label.name,
      parentId: null,
      role:
        label.id === ALL_MAIL
          ? writable
            ? "archive"
            : "all"
          : (ROLES[label.id] ?? null),
      sortOrder: label.id === "INBOX" ? 0 : 10,
      totalEmails: label.messagesTotal ?? 0,
      unreadEmails: label.messagesUnread ?? 0,
      totalThreads: label.threadsTotal ?? 0,
      unreadThreads: label.threadsUnread ?? 0,
      isSubscribed:
        (label as { labelListVisibility?: string }).labelListVisibility !==
        "labelHide",
      myRights: {
        mayReadItems: true,
        mayAddItems:
          writable &&
          (label.id === ALL_MAIL ||
            writableLabel(label) ||
            (this.composeEnabled && label.id === "DRAFT")),
        mayRemoveItems:
          writable &&
          label.id !== ALL_MAIL &&
          (writableLabel(label) ||
            (this.composeEnabled && label.id === "DRAFT")),
        maySetSeen: writable,
        maySetKeywords: writable,
        mayCreateChild: false,
        mayRename: writable && label.type === "user",
        mayDelete: writable && label.type === "user",
        maySubmit: writable && this.composeEnabled && label.id === "DRAFT",
      },
    }));
  }
  /**
   * Fills the cache for `ids` with one batch read per hundred messages.
   *
   * `Email/get` asks for a page at a time - fifty messages for a folder view -
   * and reading them one by one is what made opening a folder slow: each
   * message was its own round trip to Google. Here they travel together, and
   * the per-message path that follows finds every one of them cached.
   *
   * Best effort throughout: anything that fails, whole batch or single
   * sub-request, is simply left uncached for {@link message} to fetch and
   * report on in the usual way.
   */
  private async prefetch(
    ids: string[],
    format: "full" | "metadata",
  ): Promise<void> {
    if (!this.api.batch || ids.length < 2) return;
    const key = (id: string) =>
      `${format === "full" ? "message" : "meta"}:v2:${id}`;
    const wanted = [
      ...new Set(
        ids
          .map((id) => this.store.upstreamId(this.email, id))
          .filter(
            (id) =>
              /^[A-Za-z0-9_-]{1,128}$/.test(id) &&
              this.store.cached(this.email, key(id)) === null &&
              // A cached full message already answers a metadata read.
              (format === "full" ||
                this.store.cached(this.email, `message:v2:${id}`) === null),
          ),
      ),
    ];
    for (let offset = 0; offset < wanted.length; offset += MAX_BATCH) {
      const page = wanted.slice(offset, offset + MAX_BATCH);
      const revision = this.store.revision(this.email);
      let answers: { status: number; data?: GmailMessage }[];
      try {
        answers = await this.api.batch<GmailMessage>(
          page.map((id) => ({
            resource: `messages/${encodeURIComponent(id)}`,
            params: { format },
          })),
          5,
        );
      } catch (error) {
        // A batch Google throttled is the one failure that must not fall back
        // to per-message reads: they would spend the same exhausted budget.
        if (error instanceof JmapError && error.type === "serverUnavailable")
          throw error;
        return;
      }
      if (this.store.revision(this.email) !== revision) return;
      for (const [index, id] of page.entries()) {
        const answer = answers[index];
        if (answer?.data)
          this.store.cache(this.email, key(id), answer.data, MESSAGE_TTL);
      }
    }
  }
  /** `metadata` omits bodies and parts: enough for list views, and much smaller to transfer and cache. */
  async message(
    id: string,
    format: "full" | "metadata" = "full",
  ): Promise<GmailMessage> {
    id = this.store.upstreamId(this.email, id);
    await this.state();
    if (format === "metadata") {
      // A cached full message also answers metadata-only reads.
      const full = this.store.cached<GmailMessage>(
        this.email,
        `message:v2:${id}`,
      );
      if (full) return full;
    }
    return this.cached(
      `${format === "full" ? "message" : "meta"}:v2:${id}`,
      MESSAGE_TTL,
      () =>
        this.api.get<GmailMessage>(`messages/${encodeURIComponent(id)}`, 5, {
          format,
        }),
    );
  }
  private async bytes(messageId: string, part: GmailPart): Promise<Buffer> {
    if ((part.body?.size ?? 0) > MAX_BLOB)
      throw new JmapError("tooLarge", "Gmail part exceeds the download limit");
    if (part.body?.data !== undefined)
      return Buffer.from(part.body.data, "base64url");
    if (!part.body?.attachmentId) return Buffer.alloc(0);
    const result = await this.cached(
      `part:${messageId}:${part.body.attachmentId}`,
      60 * 60_000,
      () =>
        this.api.get<{ data: string }>(
          `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body!.attachmentId!)}`,
          5,
        ),
    );
    const bytes = Buffer.from(result.data, "base64url");
    if (bytes.length > MAX_BLOB) throw new JmapError("tooLarge");
    return bytes;
  }
  async download(blob: string): Promise<{ body: Buffer; type: string }> {
    if (blob.startsWith("gu_")) {
      const upload = this.store.uploaded(this.email, blob);
      if (!upload) throw new JmapError("notFound");
      return upload;
    }
    const [id, part] = parseBlob(blob);
    const message = await this.message(id); // proves account ownership / existence even for cached parts.
    if (part === null) {
      if ((message.sizeEstimate ?? 0) > MAX_BLOB)
        throw new JmapError("tooLarge");
      const raw = await this.cached(`raw:${id}`, 60 * 60_000, () =>
        this.api.get<{ raw: string }>(
          `messages/${encodeURIComponent(id)}`,
          5,
          { format: "raw" },
        ),
      );
      const body = Buffer.from(raw.raw, "base64url");
      if (body.length > MAX_BLOB) throw new JmapError("tooLarge");
      return { body, type: "message/rfc822" };
    }
    const p = partTree(message).parts.get(part);
    if (!p) throw new JmapError("notFound");
    return {
      body: await this.bytes(id, p),
      type: p.mimeType ?? "application/octet-stream",
    };
  }
  private async query(
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.account(args);
    // Translating an arbitrary filter into a Gmail search needs every label's
    // name. The folder and unread paths below need one label's counters or
    // none at all, so the full listing - one Gmail call per label - is built
    // only if something really asks for it.
    let search: string | undefined;
    const q = async () =>
      (search ??= gmailFilter(args.filter, await this.labels()));
    const sort = args.sort ?? [{ property: "receivedAt", isAscending: false }];
    if (
      !Array.isArray(sort) ||
      sort.length > 1 ||
      sort.some((s) => !s || s.property !== "receivedAt" || s.collation != null)
    )
      throw unsupportedSort();
    if (
      sort.some(
        (s) =>
          s.isAscending !== undefined && typeof s.isAscending !== "boolean",
      )
    )
      throw invalidArguments("Invalid sort direction");
    const ascending = sort.length > 0 && sort[0].isAscending !== false;
    const limit = args.limit === undefined ? MAX_GET : args.limit;
    if (!Number.isSafeInteger(limit) || (limit as number) < 0)
      throw invalidArguments("Invalid limit");
    if (
      args.collapseThreads !== undefined &&
      typeof args.collapseThreads !== "boolean"
    )
      throw invalidArguments("Invalid collapseThreads");
    const state = await this.state();
    // Common folder view: use exact label/profile counts and fetch only the
    // requested pages. A large Inbox must not require a full account scan.
    const f = args.filter as Record<string, unknown> | undefined;
    // "Unread in a folder" is the shape a notification preview and every unread
    // badge use. Gmail keeps UNREAD as a label, so it lists exactly like a folder
    // and its count is the label's own messagesUnread - no search, no full scan.
    const unreadIn = ((): string | undefined => {
      if (
        !f ||
        f.operator !== "AND" ||
        !Array.isArray(f.conditions) ||
        f.conditions.length !== 2
      )
        return undefined;
      const parts = f.conditions as Record<string, unknown>[];
      const box = parts.find(
        (c) =>
          c && Object.keys(c).length === 1 && typeof c.inMailbox === "string",
      );
      const unread = parts.find(
        (c) => c && Object.keys(c).length === 1 && c.notKeyword === "$seen",
      );
      return box && unread ? (box.inMailbox as string) : undefined;
    })();
    const simple =
      !f ||
      Object.keys(f).length === 0 ||
      (Object.keys(f).length === 1 && typeof f.inMailbox === "string") ||
      unreadIn !== undefined;
    const pos = args.position ?? 0;
    if (
      simple &&
      !ascending &&
      !args.collapseThreads &&
      args.anchor === undefined &&
      Number.isSafeInteger(pos) &&
      (pos as number) >= 0
    ) {
      const box =
        unreadIn ??
        (typeof f?.inMailbox === "string" ? f.inMailbox : undefined);
      // A mailbox id carries the Gmail label id, so one `labels.get` answers
      // "how many (unread) messages are in this folder" without listing the
      // account's other labels.
      const labelId =
        box && box !== ALL_MAIL && /^l_[A-Za-z0-9_-]+$/.test(box)
          ? box.slice(2)
          : undefined;
      const label = labelId ? await this.labelDetail(labelId) : undefined;
      const total = unreadIn
        ? label
          ? label.messagesUnread
          : (await this.labelDetail("UNREAD"))?.messagesTotal
        : label
          ? label.messagesTotal
          : (await this.profile()).messagesTotal;
      if (total !== undefined) {
        // A folder page lists by label id: exact membership that matches the label's counts, with no
        // dependence on search syntax, label names or search-index lag.
        const listing: Record<string, string | string[]> = label
          ? { labelIds: unreadIn ? [label.id, "UNREAD"] : label.id }
          : { q: await q() };
        const count = Math.min(limit as number, MAX_QUERY);
        const wanted = Math.min(total, (pos as number) + count);
        const refs = new Map<string, { id: string; threadId: string }>();
        let token = "";
        const tokens = new Set<string>();
        if (count && (pos as number) < total)
          do {
            const cursor = token;
            const page = await this.cached<{
              messages?: { id: string; threadId: string }[];
              nextPageToken?: string;
            }>(
              // Keyed by account state: a listing that survives here is one
              // no history record has touched, so it cannot go stale.
              `page:${state}:${hash(listing)}:${hash(cursor)}`,
              MESSAGE_TTL,
              () =>
                this.api.get("messages", 5, {
                  ...listing,
                  includeSpamTrash: "true",
                  maxResults: "500",
                  ...(cursor ? { pageToken: cursor } : {}),
                }),
            );
            for (const reference of page.messages ?? [])
              refs.set(reference.id, reference);
            token = page.nextPageToken ?? "";
            if (token && tokens.has(token))
              throw new JmapError(
                "serverUnavailable",
                "Gmail repeated a pagination cursor",
              );
            tokens.add(token);
            if (tokens.size > 2000)
              throw new JmapError(
                "serverUnavailable",
                "Query exceeds the experimental index limit",
              );
          } while (token && refs.size < wanted);
        return {
          accountId: this.accountId,
          // The filter identity, without paying for the search translation on
          // the label path: a folder page and an unread page of the same
          // folder are different queries.
          queryState: hash([
            state,
            label ? ["label", label.id, unreadIn ? "unread" : "all"] : search,
          ]),
          canCalculateChanges: false,
          position: pos,
          ids: [...refs.values()]
            .slice(pos as number, (pos as number) + count)
            .map((r) => "m_" + this.store.originalId(this.email, r.id)),
          ...(args.calculateTotal === true ? { total } : {}),
          ...((limit as number) > MAX_QUERY ? { limit: MAX_QUERY } : {}),
        };
      }
    }
    // Enumerate IDs only: exact totals and reverse/anchor pagination without
    // fetching metadata for the entire mailbox. Never expose resultSizeEstimate as total.
    const gmailQuery = await q();
    const references = await this.cached<{ id: string; threadId: string }[]>(
      `query:${state}:${hash(gmailQuery)}`,
      MESSAGE_TTL,
      async () => {
        const result = new Map<string, { id: string; threadId: string }>();
        let pageToken = "";
        const tokens = new Set<string>();
        do {
          const page = await this.api.get<{
            messages?: { id: string; threadId: string }[];
            nextPageToken?: string;
          }>("messages", 5, {
            q: gmailQuery,
            includeSpamTrash: "true",
            maxResults: "500",
            ...(pageToken ? { pageToken } : {}),
          });
          for (const message of page.messages ?? [])
            result.set(message.id, message);
          pageToken = page.nextPageToken ?? "";
          if (pageToken && tokens.has(pageToken))
            throw new JmapError(
              "serverUnavailable",
              "Gmail repeated a pagination cursor",
            );
          if (pageToken) tokens.add(pageToken);
          if (tokens.size > 2000)
            throw new JmapError(
              "serverUnavailable",
              "Query exceeds the experimental index limit",
            );
        } while (pageToken);
        return [...result.values()];
      },
    );
    const ordered = ascending ? [...references].reverse() : references;
    const seenThreads = new Set<string>();
    const ids = ordered
      .filter((r) => {
        if (!args.collapseThreads) return true;
        if (seenThreads.has(r.threadId)) return false;
        seenThreads.add(r.threadId);
        return true;
      })
      .map((r) => "m_" + this.store.originalId(this.email, r.id));
    let position = args.position ?? 0;
    if (!Number.isSafeInteger(position))
      throw invalidArguments("Invalid position");
    if (args.anchor !== undefined) {
      const anchor = ids.indexOf(String(args.anchor));
      if (anchor < 0) throw new JmapError("anchorNotFound");
      const offset = args.anchorOffset ?? 0;
      if (!Number.isSafeInteger(offset))
        throw invalidArguments("Invalid anchorOffset");
      position = Math.max(0, anchor + (offset as number));
    } else if ((position as number) < 0)
      position = Math.max(0, ids.length + (position as number));
    const actualLimit = Math.min(limit as number, MAX_QUERY);
    return {
      accountId: this.accountId,
      queryState: hash(ids),
      canCalculateChanges: false,
      position,
      ids: ids.slice(position as number, (position as number) + actualLimit),
      ...(args.calculateTotal === true ? { total: ids.length } : {}),
      ...((limit as number) > MAX_QUERY ? { limit: MAX_QUERY } : {}),
    };
  }
  private set(
    kind: "Email" | "Mailbox",
    args: Record<string, unknown>,
  ): Promise<unknown> {
    this.account(args);
    return this.exclusive(() => this.applySet(kind, args));
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    // Reject rather than throw: callers such as the schedule worker chain .catch() onto the result.
    if (this.queuedWrites >= 10)
      return Promise.reject(
        new JmapError("serverUnavailable", "Too many pending updates"),
      );
    this.queuedWrites++;
    const task = this.writeTail.then(work);
    this.writeTail = task.catch(() => {});
    return task.finally(() => {
      this.queuedWrites--;
    });
  }
  private async applySet(
    kind: "Email" | "Mailbox",
    a: Record<string, unknown>,
  ): Promise<unknown> {
    if (!(await this.writable()) || !this.api.mutate)
      throw new JmapError("accountReadOnly");
    const records = (v: unknown): Record<string, unknown> => {
      if (v == null) return {};
      if (typeof v !== "object" || Array.isArray(v))
        throw invalidArguments("Invalid set object");
      return v as Record<string, unknown>;
    };
    const create = records(a.create),
      update = records(a.update),
      destroy = a.destroy ?? [];
    if (!Array.isArray(destroy) || destroy.some((id) => typeof id !== "string"))
      throw invalidArguments("Invalid destroy IDs");
    if (
      Object.keys(create).length + Object.keys(update).length + destroy.length >
      20
    )
      throw new JmapError("requestTooLarge");
    const oldState =
      kind === "Email" ? await this.state() : await this.mailboxState();
    if (a.ifInState != null && a.ifInState !== oldState)
      throw new JmapError("stateMismatch");
    if (
      a.onDestroyRemoveEmails !== undefined &&
      typeof a.onDestroyRemoveEmails !== "boolean"
    )
      throw invalidArguments("Invalid onDestroyRemoveEmails");
    const created: Record<string, unknown> = Object.create(null),
      updated: Record<string, unknown> = Object.create(null);
    const notCreated: Record<string, unknown> = Object.create(null),
      notUpdated: Record<string, unknown> = Object.create(null),
      notDestroyed: Record<string, unknown> = Object.create(null);
    const destroyed: string[] = [];
    const error = (e: unknown) =>
      e instanceof JmapError
        ? e.toMethodError()
        : { type: "serverFail", description: "Gmail update failed" };
    const mutate = async <T>(
      resource: string,
      cost: number,
      method: "POST" | "PATCH" | "DELETE",
      data?: unknown,
    ): Promise<T> => {
      this.store.invalidate(this.email);
      try {
        return await this.api.mutate!<T>(resource, cost, method, data);
      } finally {
        this.store.invalidate(this.email);
      }
    };
    // Fresh label metadata validates membership and prevents editing system labels.
    let labels =
      kind === "Mailbox" || Object.keys(update).length
        ? await this.labels()
        : [];
    const tag = await this.tags();
    for (const [id, input] of Object.entries(create)) {
      try {
        if (kind === "Email") {
          if (!(await this.canCompose()))
            throw new JmapError("forbidden", "Creating mail is not supported");
          created[id] = await this.composer.create(
            input as Record<string, unknown>,
          );
          continue;
        }
        const label = await mutate<GmailLabel>(
          "labels",
          5,
          "POST",
          labelInput(input, true),
        );
        labels = [...labels, label];
        created[id] = {
          id: "l_" + label.id,
          parentId: null,
          role: null,
          isSubscribed: true,
        };
      } catch (e) {
        notCreated[id] = error(e);
      }
    }
    for (const [id, patch] of Object.entries(update)) {
      try {
        if (kind === "Mailbox") {
          const label = labels.find((l) => "l_" + l.id === id);
          if (!label) throw new JmapError("notFound");
          if (label.type !== "user")
            throw new JmapError("forbidden", "System labels are read-only");
          const result = await mutate<GmailLabel>(
            `labels/${encodeURIComponent(label.id)}`,
            5,
            "PATCH",
            labelInput(patch, false),
          );
          labels = labels.map((l) =>
            l.id === label.id ? { ...l, ...result } : l,
          );
          updated[id] = null;
        } else {
          if (!/^m_[A-Za-z0-9_-]{1,128}$/.test(id))
            throw new JmapError("notFound");
          // Read current labels directly: cached metadata may predate a change in Gmail.
          const message = await this.api.get<GmailMessage>(
            `messages/${encodeURIComponent(this.store.upstreamId(this.email, upstreamId(id, "m_")))}`,
            5,
            { format: "minimal" },
          );
          const delta = emailPatch(message, patch, labels);
          const result =
            delta.addLabelIds.length || delta.removeLabelIds.length
              ? await mutate<GmailMessage>(
                  `messages/${encodeURIComponent(message.id)}/modify`,
                  5,
                  "POST",
                  delta,
                )
              : message;
          const mapped = await mapMessage(
            { ...result, internalDate: result.internalDate ?? "0" },
            { properties: ["mailboxIds", "keywords"] },
            async () => Buffer.alloc(0),
            tag,
          );
          updated[id] = {
            mailboxIds: mapped.mailboxIds,
            keywords: mapped.keywords,
          };
        }
      } catch (e) {
        notUpdated[id] = error(e);
      }
    }
    for (const id of destroy) {
      try {
        if (kind === "Email") {
          if (!(await this.canCompose()))
            throw new JmapError(
              "forbidden",
              "Permanent deletion is disabled; move to Trash instead",
            );
          await this.composer.destroy(id);
          destroyed.push(id);
          continue;
        }
        const label = labels.find((l) => "l_" + l.id === id);
        if (!label) throw new JmapError("notFound");
        if (label.type !== "user")
          throw new JmapError("forbidden", "System labels are read-only");
        const detail = await this.api.get<GmailLabel>(
          `labels/${encodeURIComponent(label.id)}`,
          1,
        );
        if ((detail.messagesTotal ?? 0) > 0 && a.onDestroyRemoveEmails !== true)
          throw new JmapError("mailboxHasEmail");
        await mutate(`labels/${encodeURIComponent(label.id)}`, 5, "DELETE");
        destroyed.push(id);
        labels = labels.filter((l) => l.id !== label.id);
      } catch (e) {
        notDestroyed[id] = error(e);
      }
    }
    // Never hide successful writes if the follow-up profile read is temporarily unavailable.
    let newState: string;
    try {
      newState =
        kind === "Email" ? await this.state() : await this.mailboxState();
    } catch {
      newState = "w" + this.store.revision(this.email);
    }
    return {
      accountId: this.accountId,
      oldState,
      newState,
      created: Object.keys(created).length ? created : null,
      updated: Object.keys(updated).length ? updated : null,
      destroyed: destroyed.length ? destroyed : null,
      notCreated: Object.keys(notCreated).length ? notCreated : null,
      notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
      notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
    };
  }
  private async emailChanges(a: Record<string, unknown>): Promise<unknown> {
    this.account(a);
    const oldState = a.sinceState;
    if (typeof oldState !== "string" || !/^g[0-9]+(?:r[0-9]+)?$/.test(oldState))
      throw new JmapError("cannotCalculateChanges");
    const max = a.maxChanges ?? 10000;
    if (!Number.isSafeInteger(max) || (max as number) < 1)
      throw invalidArguments("Invalid maxChanges");
    const current = await this.state();
    if (oldState === current)
      return {
        accountId: this.accountId,
        oldState,
        newState: current,
        hasMoreChanges: false,
        created: [],
        updated: [],
        destroyed: [],
      };
    const start = /^g([0-9]+)/.exec(oldState)![1]!;
    if (start === /^g([0-9]+)/.exec(current)![1])
      throw new JmapError("cannotCalculateChanges");
    const history = await readHistory(this.api, start);
    const delta = emailDelta(history.records, (id) =>
      this.store.originalId(this.email, id),
    );
    if (
      delta.created.length + delta.updated.length + delta.destroyed.length >
      (max as number)
    )
      throw new JmapError(
        "cannotCalculateChanges",
        "Too many changes; reload the current mailbox",
      );
    // Do not claim that a later history cursor is already reflected in local cached reads.
    const changed = affected(history.records);
    this.store.checkpoint(
      this.email,
      history.historyId,
      changed.messages,
      changed.threads,
    );
    return {
      accountId: this.accountId,
      oldState,
      newState:
        "g" +
        history.historyId +
        (this.store.revision(this.email)
          ? "r" + this.store.revision(this.email)
          : ""),
      hasMoreChanges: false,
      ...delta,
    };
  }
  private async mailboxChanges(a: Record<string, unknown>): Promise<unknown> {
    this.account(a);
    const oldState = a.sinceState;
    if (typeof oldState !== "string")
      throw invalidArguments("Missing sinceState");
    const max = a.maxChanges ?? 10000;
    if (!Number.isSafeInteger(max) || (max as number) < 1)
      throw invalidArguments("Invalid maxChanges");
    const before = this.store.mailboxSnapshot(this.email, oldState);
    const newState = await this.mailboxState();
    if (!before) throw new JmapError("cannotCalculateChanges");
    const after = this.store.mailboxSnapshot(this.email, newState)!;
    const created = Object.keys(after).filter((id) => !(id in before)),
      destroyed = Object.keys(before).filter((id) => !(id in after)),
      updated = Object.keys(after).filter(
        (id) => id in before && after[id] !== before[id],
      );
    if (created.length + destroyed.length + updated.length > (max as number))
      throw new JmapError("cannotCalculateChanges");
    return {
      accountId: this.accountId,
      oldState,
      newState,
      hasMoreChanges: false,
      created,
      updated,
      destroyed,
      updatedProperties: null,
    };
  }
  methods(): MethodTable {
    const changes = async (a: Record<string, unknown>) => {
      this.account(a);
      const state = await this.state();
      if (a.sinceState !== state) throw new JmapError("cannotCalculateChanges");
      return {
        accountId: this.accountId,
        oldState: state,
        newState: state,
        hasMoreChanges: false,
        created: [],
        updated: [],
        destroyed: [],
      };
    };
    const readOnly = async (a: Record<string, unknown>) => {
      this.account(a);
      throw new JmapError("accountReadOnly");
    };
    return {
      ...this.composer.methods(),
      ...this.subscriptions.methods(() => this.pushEnabled),
      "Core/echo": async (a) => a,
      "Mailbox/get": async (a) => {
        this.account(a);
        const ids = this.ids(a, MAX_MAILBOX_GET);
        const properties = this.properties(a);
        const records = await this.mailboxes();
        const selected = ids
          ? records.filter((r) => ids.includes(r.id as string))
          : records;
        if (selected.length > MAX_MAILBOX_GET)
          throw new JmapError("requestTooLarge");
        return {
          accountId: this.accountId,
          state: await this.mailboxState(),
          list: selected.map((r) => this.project(r, properties)),
          notFound: (ids ?? []).filter(
            (id) => !records.some((r) => r.id === id),
          ),
        };
      },
      "Mailbox/query": async (a) => {
        this.account(a);
        if (a.sort != null)
          throw new JmapError(
            "unsupportedSort",
            "Mailbox query sorting is not supported yet",
          );
        // Filtering and the id list read names, roles and visibility - never a
        // counter - so this takes the listing that costs one Gmail call.
        const records = mailboxFilter(
          await this.mailboxes({ counts: false }),
          a.filter,
        );
        const position = a.position ?? 0;
        // No caller limit means "every mailbox that matches"; a default of 100
        // silently hid the tail of a large label set from paginating clients.
        const limit = a.limit ?? MAX_MAILBOX_GET;
        if (
          !Number.isSafeInteger(position) ||
          !Number.isSafeInteger(limit) ||
          (position as number) < 0 ||
          (limit as number) < 0
        )
          throw invalidArguments("Invalid mailbox pagination");
        return {
          accountId: this.accountId,
          // A query state tracks the result - the set of matching mailboxes -
          // not their contents, so it is the ids that have to hash here.
          queryState: hash(records.map((r) => r.id)),
          canCalculateChanges: false,
          position,
          ids: records
            .slice(
              position as number,
              (position as number) + Math.min(limit as number, MAX_MAILBOX_GET),
            )
            .map((r) => r.id),
          ...(a.calculateTotal ? { total: records.length } : {}),
        };
      },
      "Email/query": (a) => this.query(a),
      "Email/get": async (a) => {
        this.account(a);
        const properties = this.properties(a);
        // List views ask only for header-derived properties: Gmail's metadata format serves them without bodies.
        const format =
          properties &&
          properties.every(
            (p) => METADATA_PROPERTIES.has(p) || p.startsWith("header:"),
          )
            ? "metadata"
            : "full";
        let ids = this.ids(a);
        if (ids === null) {
          if ((await this.profile()).messagesTotal > MAX_GET)
            throw new JmapError("requestTooLarge");
          ids = (await this.query({ accountId: this.accountId }))
            .ids as string[];
        }
        const list: Record<string, unknown>[] = [];
        const notFound: string[] = [];
        const tag = await this.tags();
        await this.prefetch(
          ids.map((id) => upstreamId(id, "m_")),
          format,
        );
        // Keep the outstanding work bounded even for a large caller-supplied batch.
        for (let i = 0; i < ids.length; i += MAX_CONCURRENT) {
          const batch = await Promise.all(
            ids.slice(i, i + MAX_CONCURRENT).map(async (id) => {
              try {
                const message = await this.message(
                  upstreamId(id, "m_"),
                  format,
                );
                const result = await mapMessage(
                  message,
                  a,
                  (part) => this.bytes(message.id, part),
                  tag,
                );
                result.id =
                  "m_" + this.store.originalId(this.email, message.id);
                return result;
              } catch (error) {
                if (
                  error instanceof JmapError &&
                  (error.type === "notFound" ||
                    (error.type === "invalidArguments" &&
                      !/^m_[A-Za-z0-9_-]{1,128}$/.test(id)))
                ) {
                  notFound.push(id);
                  return null;
                }
                throw error;
              }
            }),
          );
          for (const record of batch) if (record) list.push(record);
        }
        return {
          accountId: this.accountId,
          state: await this.state(),
          list,
          notFound,
        };
      },
      /**
       * Every keyword in the account, with its counts: what a client would
       * otherwise have to walk the whole mailbox to learn.
       *
       * Gmail keeps exactly this - a label knows its own totals - so the walk
       * is one label listing instead of thousands of messages, and the answer
       * covers labels no recent message carries, which a walk would miss
       * entirely. Tags come back named and coloured as Gmail has them, so a
       * client can adopt them as they are rather than guess from an id.
       */
      "Keyword/get": async (a) => {
        this.account(a);
        if (a.ids != null && !Array.isArray(a.ids))
          throw invalidArguments("ids must be an array of strings or null");
        const wanted =
          a.ids == null ? null : new Set((a.ids as unknown[]).map(String));
        const [labels, profile] = await Promise.all([
          this.labels(),
          this.profile(),
        ]);
        const list: Record<string, unknown>[] = [];
        const add = (
          id: string,
          name: string,
          color: string | null,
          total: number,
          unread: number,
          provider: boolean,
        ) => {
          if (wanted && !wanted.has(id)) return;
          list.push({
            id,
            name,
            color,
            total,
            unread,
            isProviderLabel: provider,
            source: "provider",
          });
        };
        for (const label of labels) {
          const keyword = this.labelTags && label.type === "user" ? labelKeyword(label.name) : null;
          if (keyword)
            add(
              keyword,
              label.name,
              label.color?.backgroundColor ?? null,
              label.messagesTotal ?? 0,
              label.messagesUnread ?? 0,
              true,
            );
        }
        // The states Gmail keeps as labels of its own are keywords here, and
        // it knows their counts as exactly as it knows a label's.
        const state = (id: string) => labels.find((l) => l.id === id);
        const unread = state("UNREAD");
        const starred = state("STARRED");
        const important = state("IMPORTANT");
        const drafts = state("DRAFT");
        if (unread)
          add(
            "$seen",
            "$seen",
            null,
            Math.max(0, profile.messagesTotal - (unread.messagesTotal ?? 0)),
            0,
            false,
          );
        if (starred)
          add("$flagged", "$flagged", null, starred.messagesTotal ?? 0, starred.messagesUnread ?? 0, false);
        if (important)
          add("$important", "$important", null, important.messagesTotal ?? 0, important.messagesUnread ?? 0, false);
        if (drafts)
          add("$draft", "$draft", null, drafts.messagesTotal ?? 0, drafts.messagesUnread ?? 0, false);
        return {
          accountId: this.accountId,
          state: await this.mailboxState(),
          totalEmails: profile.messagesTotal,
          list,
          notFound: wanted
            ? [...wanted].filter((id) => !list.some((k) => k.id === id))
            : [],
        };
      },
      "Thread/get": async (a) => {
        this.account(a);
        const ids = this.ids(a);
        const properties = this.properties(a);
        if (ids === null) throw new JmapError("requestTooLarge");
        const list: Record<string, unknown>[] = [];
        const notFound: string[] = [];
        const state = await this.state();
        const read = async (
          id: string,
        ): Promise<Record<string, unknown> | null> => {
          try {
            const revision = this.store.revision(this.email);
            const thread = await this.cached<{
              id: string;
              messages?: GmailMessage[];
            }>(`thread:v2:${id}`, MESSAGE_TTL, () =>
              this.api.get(
                `threads/${encodeURIComponent(upstreamId(id, "t_"))}`,
                10,
                { format: "full" },
              ),
            );
            if (this.store.revision(this.email) === revision)
              for (const message of thread.messages ?? [])
                this.store.cache(
                  this.email,
                  `message:v2:${message.id}`,
                  message,
                  MESSAGE_TTL,
                );
            const messages = [...(thread.messages ?? [])].sort(
              (a, b) => Number(a.internalDate) - Number(b.internalDate),
            );
            return this.project(
              {
                id,
                emailIds: messages.map(
                  (m) => "m_" + this.store.originalId(this.email, m.id),
                ),
              },
              properties,
            );
          } catch (error) {
            if (
              error instanceof JmapError &&
              (error.type === "notFound" ||
                (error.type === "invalidArguments" &&
                  !/^t_[A-Za-z0-9_-]{1,128}$/.test(id)))
            ) {
              notFound.push(id);
              return null;
            }
            throw error;
          }
        };
        // Threads are independent reads: fetch a few at a time and keep the list in request order.
        for (let i = 0; i < ids.length; i += 4)
          for (const record of await Promise.all(ids.slice(i, i + 4).map(read)))
            if (record) list.push(record);
        return { accountId: this.accountId, state, list, notFound };
      },
      "Email/changes": (a) => this.emailChanges(a),
      "Mailbox/changes": (a) => this.mailboxChanges(a),
      "Thread/changes": changes,
      "Email/queryChanges": async (a) => {
        this.account(a);
        throw new JmapError("cannotCalculateChanges");
      },
      "Mailbox/set": (a) => this.set("Mailbox", a),
      "Email/set": (a) => this.set("Email", a),
      "Email/copy": readOnly,
      "SearchSnippet/get": async (a) => {
        this.account(a);
        return {
          accountId: this.accountId,
          list: [],
          notFound: a.emailIds ?? [],
        };
      },
    };
  }
}

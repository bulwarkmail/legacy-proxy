import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { EventSourceHub, type StateChange } from "../jmap/eventsource.js";
import type { AccountRow } from "../state/store.js";
import type { GmailStore } from "./store.js";
import type { GmailMail } from "./mail.js";

const COALESCE_MS = 1_500;
const RECOVERY_MS = 5 * 60_000;
const RENEW_CHECK_MS = 60 * 60_000;
const RENEW_AFTER_MS = 24 * 60 * 60_000;

/** Checks the OIDC token Pub/Sub attaches to authenticated push requests. */
export interface IdTokenVerifier {
  verifyIdToken(options: {
    idToken: string;
    audience: string;
  }): Promise<{
    getPayload(): { email?: string; email_verified?: boolean } | undefined;
  }>;
}

/** Bridges Gmail Pub/Sub notifications to the incremental sync engine and JMAP EventSource streams. */
export class GmailPush {
  private readonly hub = new EventSourceHub();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly streams = new Map<string, number>();
  private readonly timers: NodeJS.Timeout[] = [];
  readonly counters = {
    rejected: 0,
    ignored: 0,
    syncFailures: 0,
    changesPublished: 0,
    notificationsSent: 0,
  };
  constructor(
    private readonly store: GmailStore,
    private readonly account: (email: string) => GmailMail,
    private readonly allowed: { has(email: string): boolean },
    private readonly config: {
      topic: string;
      token?: string;
      audience?: string;
      serviceAccount?: string;
    },
    private readonly log: FastifyBaseLogger,
    private readonly verifier: IdTokenVerifier = new OAuth2Client(),
  ) {}

  /** SSE stream for one Gmail account. Wire format identical to the legacy hub (RFC 8620 §7.3). */
  addStream(
    email: string,
    reply: FastifyReply,
    origin: string | null,
    opts: { types?: string[] | null; closeAfter?: boolean; pingSec?: number },
  ): void {
    this.streams.set(email, (this.streams.get(email) ?? 0) + 1);
    reply.raw.on("close", () => {
      const n = (this.streams.get(email) ?? 1) - 1;
      if (n <= 0) this.streams.delete(email);
      else this.streams.set(email, n);
    });
    this.hub.add(this.row(email), reply, origin, opts);
  }

  /** Pub/Sub push endpoint. Requests are authenticated before anything is read; the hint is persisted before the 204 acknowledgement. */
  async receive(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!(await this.authorized(req))) {
      this.counters.rejected++;
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    const body = req.body as
      { message?: { data?: unknown; messageId?: unknown } } | undefined;
    let hint: { emailAddress?: unknown; historyId?: unknown } = {};
    try {
      hint = JSON.parse(
        Buffer.from(String(body?.message?.data ?? ""), "base64").toString(
          "utf8",
        ),
      );
    } catch {
      /* malformed: acknowledge, never retry */
    }
    const email =
      typeof hint.emailAddress === "string"
        ? hint.emailAddress.toLowerCase()
        : "";
    const history =
      typeof hint.historyId === "string" || typeof hint.historyId === "number"
        ? String(hint.historyId)
        : "";
    if (
      !email ||
      !/^\d+$/.test(history) ||
      !this.allowed.has(email) ||
      !this.store.hasConnection(email)
    ) {
      // Unknown accounts or garbage are acknowledged so Pub/Sub stops redelivering them; nothing about them is logged.
      this.counters.ignored++;
      await reply.code(204).send();
      return;
    }
    this.store.pushRecord(email, history);
    await reply.code(204).send();
    this.schedule(email);
  }

  /**
   * With an audience configured, only a Google-signed OIDC token for the configured service account is accepted
   * (nothing secret appears in URLs or access logs). Otherwise the shared query token is compared in constant time.
   */
  private async authorized(req: FastifyRequest): Promise<boolean> {
    if (this.config.audience) {
      const header = req.headers.authorization ?? "";
      if (!/^Bearer /i.test(header)) return false;
      try {
        const ticket = await this.verifier.verifyIdToken({
          idToken: header.slice(7).trim(),
          audience: this.config.audience,
        });
        const claims = ticket.getPayload();
        return (
          claims?.email_verified === true &&
          claims.email?.toLowerCase() === this.config.serviceAccount
        );
      } catch {
        return false;
      }
    }
    const token = String((req.query as { token?: unknown })?.token ?? "");
    const expected = Buffer.from(this.config.token ?? "");
    return (
      expected.length > 0 &&
      Buffer.byteLength(token) === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), expected)
    );
  }

  /** Coalesce bursts (Gmail fans out one notification per change) into one sync per account. */
  private schedule(email: string): void {
    if (this.pending.has(email)) return;
    this.pending.set(
      email,
      setTimeout(() => {
        this.pending.delete(email);
        void this.sync(email);
      }, COALESCE_MS),
    );
  }

  async sync(email: string): Promise<void> {
    const inflight = this.syncing.get(email);
    if (inflight) {
      await inflight;
      this.schedule(email);
      return;
    } // a change may have landed after the running read started
    const task = (async () => {
      try {
        const mail = this.account(email);
        const { changed, delivered } = await mail.pushSync();
        if (changed || delivered)
          await this.publish(email, mail, delivered > 0);
      } catch (err) {
        this.counters.syncFailures++;
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "gmail push sync failed",
        );
      }
    })().finally(() => this.syncing.delete(email));
    this.syncing.set(email, task);
    await task;
  }

  private async publish(
    email: string,
    mail: GmailMail,
    delivered: boolean,
  ): Promise<void> {
    const states = await mail.states(delivered);
    if (this.streams.has(email)) {
      // Open tabs refresh from the other states; EmailDelivery exists for woken devices.
      const { EmailDelivery: _delivery, ...live } = states;
      const change: StateChange = {
        "@type": "StateChange",
        changed: { [mail.accountId]: live },
      };
      this.hub.publish(this.row(email), change);
      this.counters.changesPublished++;
    }
    // Verified Web Push subscriptions fire with every tab closed.
    this.counters.notificationsSent += await mail.subscriptions.publish(
      mail.accountId,
      states,
      // Only read if some subscriber registered an emailPush config; the
      // messages are usually already cached by the arrival warm-up.
      (properties) => mail.deliveredEmails(properties),
    );
  }

  /** Renew watches daily (Google stops after 7 days) and poll open streams as a safety net for lost notifications. */
  start(): void {
    const renew = async () => {
      for (const email of this.store.connectedEmails()) {
        if (!this.allowed.has(email)) continue;
        const current = this.store.watch(email);
        if (
          current &&
          current.expiration > Date.now() &&
          Date.now() - current.renewedAt < RENEW_AFTER_MS
        )
          continue;
        try {
          await this.account(email).watch(this.config.topic);
        } catch (err) {
          this.store.watchFailed(email);
          this.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "gmail watch renewal failed",
          );
        }
      }
    };
    const recover = async () => {
      for (const email of this.streams.keys()) await this.sync(email);
    };
    void renew();
    this.timers.push(
      setInterval(() => {
        void renew();
      }, RENEW_CHECK_MS),
      setInterval(() => {
        void recover();
      }, RECOVERY_MS),
    );
    for (const t of this.timers) t.unref();
  }
  stop(): void {
    for (const t of this.timers) clearInterval(t);
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }
  stats() {
    return {
      ...this.store.pushStats(),
      ...this.store.subscriptionStats(),
      ...this.counters,
      openStreams: [...this.streams.values()].reduce((a, b) => a + b, 0),
    };
  }

  private row(email: string): AccountRow {
    // The legacy hub keys streams by numeric account id; derive a stable one from the address.
    return {
      id: Number.parseInt(
        crypto.createHash("sha256").update(email).digest("hex").slice(0, 12),
        16,
      ),
      slug: email,
      kind: "gmail",
      host: "",
      username: email,
      vault: Buffer.alloc(0),
      created_at: 0,
    };
  }
}

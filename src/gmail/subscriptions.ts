import crypto from "node:crypto";
import { JmapError } from "../jmap/errors.js";
import type { MethodTable } from "../jmap/router.js";
import type { GmailStore, PushSub } from "./store.js";
import {
  matchesFilter,
  parseEmailPush,
  projectEmail,
  propertiesFor,
  type EmailPushConfig,
} from "./emailpush.js";

const MAX_PER_ACCOUNT = 20;
const DEFAULT_EXPIRES_MS = 90 * 24 * 60 * 60_000;
const MAX_EXPIRES_MS = 365 * 24 * 60 * 60_000;
const TIMEOUT_MS = 5_000;
const MAX_FAILURES = 8;
/** Types this backend can actually report. A subscription asking for anything else never fires. */
export const PUSH_TYPES = [
  "Email",
  "EmailDelivery",
  "Thread",
  "Mailbox",
  "EmailSubmission",
];

const fail = (type: string, description: string): never => {
  throw new JmapError(type, description);
};
const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : fail("invalidProperties", "Expected an object");

/** RFC 8620 §7.2 view. `keys` and the verification code are never echoed back. */
const project = (sub: PushSub) => ({
  id: sub.id,
  deviceClientId: sub.device,
  url: sub.url,
  types: sub.types,
  expires: new Date(sub.expires).toISOString(),
  verified: sub.verified,
  keys: null,
  emailPush: sub.emailPush,
});

export interface StateChange {
  "@type": "StateChange";
  changed: Record<string, Record<string, string>>;
}

/** draft-ietf-jmap-emailpush: the delivery itself, not just the fact of one. */
export interface EmailPushObject {
  "@type": "EmailPush";
  accountId: string;
  emails: Record<string, unknown>[];
  state?: string;
}

/**
 * Web Push fan-out for one Gmail account. Subscriptions point at a relay that
 * forwards to the browser's push service, so the bridge only ever POSTs JSON.
 */
export class GmailSubscriptions {
  constructor(
    private readonly email: string,
    private readonly store: GmailStore,
    private readonly log: { warn(o: unknown, m: string): void },
    /** The one account this connection serves: the only key an emailPush map may carry. */
    private readonly accountId = "",
  ) {}

  private async post(
    sub: PushSub,
    body: unknown,
    kind: "StateChange" | "PushVerification" | "EmailPush",
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-push-type": kind },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      // A push service that has dropped the endpoint says so; stop trying at once.
      if (res.status === 404 || res.status === 410) {
        this.store.unsubscribe(sub.id, sub.email);
        return;
      }
      if (!res.ok) throw new Error("status " + res.status);
      this.store.subscriptionDelivered(sub.id);
    } catch (err) {
      if (this.store.subscriptionFailed(sub.id) >= MAX_FAILURES)
        this.store.unsubscribe(sub.id, sub.email);
      // The URL can carry a device token: log the reason, never the endpoint.
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err), kind },
        "gmail push delivery failed",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verification handshake: the client reads this code from the relay and sends it back. */
  private verify(sub: PushSub): void {
    void this.post(
      sub,
      {
        "@type": "PushVerification",
        pushSubscriptionId: sub.id,
        verificationCode: sub.code,
      },
      "PushVerification",
    );
  }

  /**
   * Notify verified subscribers interested in any of these types.
   *
   * A subscriber that registered an `emailPush` config for this account is
   * told what arrived - sender, subject, ids, whatever it asked for - and is
   * then *not* sent the `EmailDelivery` ping for the same arrival: that ping
   * would only send it back to guessing which message it was, and it would
   * announce a second, different one. When the delivery does not pass that
   * subscriber's filter - junk, by the filter our own client registers -
   * nothing is sent at all, which is the point of having the filter.
   *
   * `deliveries` reads the messages that just arrived, and is called at most
   * once, only if some subscriber is actually waiting for their contents.
   */
  async publish(
    accountId: string,
    states: Record<string, string>,
    deliveries?: (properties: string[]) => Promise<Record<string, unknown>[]>,
  ): Promise<number> {
    const subs = this.store.subscriptions(this.email).filter((s) => s.verified);
    const configs = subs
      .map((sub) => sub.emailPush?.[accountId])
      .filter((config): config is EmailPushConfig => !!config);
    let delivered: Record<string, unknown>[] = [];
    if (deliveries && configs.length > 0) {
      try {
        delivered = await deliveries(propertiesFor(configs));
      } catch (err) {
        // Fall back to the plain ping: a notification that says less is
        // better than a delivery nobody hears about.
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "gmail emailPush read failed",
        );
      }
    }
    let sent = 0;
    for (const sub of subs) {
      const config = sub.emailPush?.[accountId];
      const told = !!config && delivered.length > 0;
      if (config && told) {
        const emails = delivered
          .filter((email) => matchesFilter(config.filter, email))
          .map((email) => projectEmail(email, config.properties));
        if (emails.length > 0) {
          const body: EmailPushObject = {
            "@type": "EmailPush",
            accountId,
            emails,
            ...(states.Email ? { state: states.Email } : {}),
          };
          await this.post(sub, body, "EmailPush");
          sent++;
        }
      }
      const changed = Object.fromEntries(
        Object.entries(states).filter(
          ([type]) =>
            (sub.types === null || sub.types.includes(type)) &&
            !(told && type === "EmailDelivery"),
        ),
      );
      if (!Object.keys(changed).length) continue;
      const body: StateChange = {
        "@type": "StateChange",
        changed: { [accountId]: changed },
      };
      await this.post(sub, body, "StateChange");
      sent++;
    }
    return sent;
  }

  private create(input: unknown): Record<string, unknown> {
    const p = obj(input);
    for (const key of Object.keys(p)) {
      if (
        !["deviceClientId", "url", "types", "expires", "keys", "emailPush"].includes(
          key,
        )
      )
        fail("invalidProperties", "Unsupported property " + key);
    }
    const url = typeof p.url === "string" ? p.url : "";
    // https only: a StateChange names the account and would otherwise travel in clear.
    if (!/^https:\/\//i.test(url) || url.length > 2048)
      fail(
        "invalidProperties",
        "url must be an https URL of at most 2048 characters",
      );
    const device =
      p.deviceClientId === undefined || p.deviceClientId === null
        ? null
        : typeof p.deviceClientId === "string" && p.deviceClientId.length <= 255
          ? p.deviceClientId
          : fail("invalidProperties", "Invalid deviceClientId");
    let types: string[] | null = null;
    if (p.types !== undefined && p.types !== null) {
      if (!Array.isArray(p.types) || p.types.some((t) => typeof t !== "string"))
        fail("invalidProperties", "types must be an array of strings");
      types = p.types as string[];
      if (!types.some((t) => PUSH_TYPES.includes(t)))
        fail(
          "invalidProperties",
          "This account pushes only: " + PUSH_TYPES.join(", "),
        );
    }
    const now = Date.now();
    let expires = now + DEFAULT_EXPIRES_MS;
    if (p.expires !== undefined && p.expires !== null) {
      const parsed =
        typeof p.expires === "string" ? Date.parse(p.expires) : NaN;
      if (!Number.isFinite(parsed))
        fail("invalidProperties", "Invalid expires");
      if (parsed <= now) fail("invalidProperties", "expires is in the past");
      expires = Math.min(parsed, now + MAX_EXPIRES_MS);
    }
    if (this.store.subscriptions(this.email).length >= MAX_PER_ACCOUNT)
      fail("limit", "Too many push subscriptions");
    const emailPush = parseEmailPush(p.emailPush, this.accountId);
    const sub = this.store.subscribe({
      id: "gp_" + crypto.randomBytes(16).toString("hex"),
      email: this.email,
      device,
      url,
      types,
      expires,
      code: crypto.randomBytes(16).toString("hex"),
      createdAt: now,
      emailPush,
    });
    this.verify(sub);
    // Server-set properties only, per §5.3: the client already knows the rest.
    return {
      id: sub.id,
      verified: false,
      expires: new Date(expires).toISOString(),
    };
  }

  private update(id: string, input: unknown): void {
    const sub = this.store.subscription(id);
    if (!sub || sub.email !== this.email)
      fail("notFound", "Unknown subscription");
    const p = obj(input);
    for (const key of Object.keys(p)) {
      if (
        !["verificationCode", "expires", "types", "emailPush"].includes(key)
      )
        fail("invalidProperties", "Property cannot be updated: " + key);
    }
    if (p.verificationCode !== undefined) {
      if (
        typeof p.verificationCode !== "string" ||
        !this.store.verifySubscription(id, p.verificationCode)
      ) {
        fail("invalidProperties", "Wrong verification code");
      }
    }
    if (p.expires !== undefined && p.expires !== null) {
      const parsed =
        typeof p.expires === "string" ? Date.parse(p.expires) : NaN;
      if (!Number.isFinite(parsed) || parsed <= Date.now())
        fail("invalidProperties", "Invalid expires");
      this.store.updateSubscription(id, {
        expires: Math.min(parsed, Date.now() + MAX_EXPIRES_MS),
      });
    }
    if (p.types !== undefined) {
      if (
        p.types !== null &&
        (!Array.isArray(p.types) || p.types.some((t) => typeof t !== "string"))
      )
        fail("invalidProperties", "Invalid types");
      this.store.updateSubscription(id, { types: p.types as string[] | null });
    }
    if (p.emailPush !== undefined) {
      this.store.updateSubscription(id, {
        emailPush: parseEmailPush(p.emailPush, this.accountId),
      });
    }
  }

  /** PushSubscription is not account-scoped: these methods take no accountId. */
  methods(enabled: () => boolean): MethodTable {
    const guard = () => {
      if (!enabled())
        fail(
          "accountReadOnly",
          "Push notifications are not enabled on this bridge",
        );
    };
    const state = () => "push-" + this.store.subscriptions(this.email).length;
    return {
      "PushSubscription/get": async (a) => {
        guard();
        const all = this.store.subscriptions(this.email).map(project);
        const ids = a.ids as string[] | null | undefined;
        if (ids != null && (!Array.isArray(ids) || ids.length > 100))
          fail("invalidArguments", "Invalid ids");
        return {
          state: state(),
          list: ids ? all.filter((s) => ids.includes(s.id)) : all,
          notFound: (ids ?? []).filter((id) => !all.some((s) => s.id === id)),
        };
      },
      "PushSubscription/set": async (a) => {
        guard();
        if (a.ifInState != null)
          fail("stateMismatch", "Conditional updates are unsupported");
        const created: Record<string, unknown> = Object.create(null),
          notCreated: Record<string, unknown> = Object.create(null);
        const updated: Record<string, unknown> = Object.create(null),
          notUpdated: Record<string, unknown> = Object.create(null);
        const destroyed: string[] = [],
          notDestroyed: Record<string, unknown> = Object.create(null);
        const oldState = state();
        const error = (e: unknown) =>
          e instanceof JmapError ? e.toMethodError() : { type: "serverFail" };
        for (const [key, input] of Object.entries(obj(a.create ?? {}))) {
          try {
            created[key] = this.create(input);
          } catch (e) {
            notCreated[key] = error(e);
          }
        }
        for (const [id, input] of Object.entries(obj(a.update ?? {}))) {
          try {
            this.update(id, input);
            updated[id] = null;
          } catch (e) {
            notUpdated[id] = error(e);
          }
        }
        for (const id of (Array.isArray(a.destroy)
          ? a.destroy
          : []) as string[]) {
          if (this.store.unsubscribe(id, this.email)) destroyed.push(id);
          else notDestroyed[id] = { type: "notFound" };
        }
        return {
          oldState,
          newState: state(),
          created: Object.keys(created).length ? created : null,
          notCreated: Object.keys(notCreated).length ? notCreated : null,
          updated: Object.keys(updated).length ? updated : null,
          notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
          destroyed: destroyed.length ? destroyed : null,
          notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
        };
      },
    };
  }
}

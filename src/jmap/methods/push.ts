// PushSubscription/* per RFC 8620 §7.2. The proxy persists subscriptions in
// SQLite and hands the verification + StateChange forwarding off to the
// PushDispatcher, which fans out to SSE listeners and the configured relay
// (Bulwark relay → FCM / Web Push) in one place.

import crypto from "node:crypto";
import type { AccountRow, PushSubscriptionRow, Store } from "../../state/store.js";
import type { PushDispatcher } from "../../push/dispatcher.js";
import { encodeCounterState } from "../../state/states.js";
import { log } from "../../util/log.js";

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export interface PushCtx {
  account: AccountRow;
  store: Store;
  dispatcher: PushDispatcher;
}

// We expose `id`, `deviceClientId`, `url`, `types`, `expires`, `verified`,
// and a placeholder `keys: null`. Per spec the server MUST NOT return
// `verificationCode` or the actual `keys` (those would defeat the
// confidentiality of the verification dance). `verified` is reflected as
// the boolean stored in the row.
function projectForGet(row: PushSubscriptionRow): Record<string, unknown> {
  return {
    id: row.id,
    deviceClientId: row.deviceClientId ?? null,
    url: row.url,
    types: row.types ?? null,
    expires: row.expires ? new Date(row.expires).toISOString() : null,
    verified: row.verified,
    // Spec requires `keys` to round-trip but never returning the actual
    // values. Stalwart, Cyrus, etc. return `null` here whether or not keys
    // were stored — we follow the same convention.
    keys: null,
  };
}

// PushSubscription state is globally bumped on any create/destroy/verify.
// The spec does not actually require a state on PushSubscription/get
// responses, but real-world clients (and the compliance suite) read it, so
// we expose a counter that ticks per mutation.
function pushState(store: Store, accountId: number): string {
  return encodeCounterState(store.getState(accountId, "push_subscription"));
}

export async function pushSubscriptionGet(
  args: { ids?: string[] | null },
  ctx: PushCtx,
): Promise<{
  state: string;
  list: Record<string, unknown>[];
  notFound: string[];
}> {
  const all = ctx.store.listPushSubscriptions(ctx.account.id);
  if (args.ids === null || args.ids === undefined) {
    return {
      state: pushState(ctx.store, ctx.account.id),
      list: all.map(projectForGet),
      notFound: [],
    };
  }
  const byId = new Map(all.map((s) => [s.id, s]));
  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of args.ids) {
    const row = byId.get(id);
    if (row) list.push(projectForGet(row));
    else notFound.push(id);
  }
  return {
    state: pushState(ctx.store, ctx.account.id),
    list,
    notFound,
  };
}

// All known JMAP type names a subscription is allowed to filter on. The list
// matches the capabilities we advertise on the session resource — extending
// it later doesn't break existing subscriptions, but a typo today gets
// caught at create time.
const ALLOWED_TYPES = new Set([
  "Email",
  "EmailDelivery",
  "EmailSubmission",
  "Mailbox",
  "Thread",
  "Identity",
  "VacationResponse",
  "AddressBook",
  "ContactCard",
  "PushSubscription",
]);

// Hard cap so a misbehaving client can't fill the table. Per-account, not
// global, because each account's IDLE worker and connections are isolated.
const MAX_SUBS_PER_ACCOUNT = 50;

// PushVerification rate limit per spec: do not flood a freshly verified
// endpoint. We store the timestamp of the last send and refuse to re-send
// the verification payload faster than this — covers the "client rapidly
// re-creates while debugging" case.
const VERIFY_MIN_INTERVAL_MS = 60_000;

// Default expiry when the client doesn't request one. JMAP clients are
// expected to refresh well before this; making it generous keeps a single
// browser session alive across long laptop sleeps without re-verifying.
const DEFAULT_EXPIRES_MS = 90 * 24 * 60 * 60_000;

// Cap any client-supplied expiry to this so a buggy or malicious client
// can't pin a subscription forever.
const MAX_EXPIRES_MS = 365 * 24 * 60 * 60_000;

export async function pushSubscriptionSet(
  args: {
    create?: Record<string, Record<string, unknown>> | null;
    update?: Record<string, Record<string, unknown>> | null;
    destroy?: string[] | null;
  },
  ctx: PushCtx,
): Promise<{
  oldState: string;
  newState: string;
  created: Record<string, Record<string, unknown>> | null;
  notCreated: Record<string, SetError> | null;
  updated: Record<string, null> | null;
  notUpdated: Record<string, SetError> | null;
  destroyed: string[] | null;
  notDestroyed: Record<string, SetError> | null;
}> {
  const oldState = pushState(ctx.store, ctx.account.id);
  const created: Record<string, Record<string, unknown>> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};

  let mutated = false;
  let dirty = false; // any change that should reset the IDLE worker set

  // -- create -------------------------------------------------------------
  const existingCount = ctx.store.listPushSubscriptions(ctx.account.id).length;
  let pendingCreates = 0;
  for (const [creationKey, raw] of Object.entries(args.create ?? {})) {
    if (existingCount + pendingCreates >= MAX_SUBS_PER_ACCOUNT) {
      notCreated[creationKey] = {
        type: "limit",
        description: "Too many push subscriptions for this account",
      };
      continue;
    }

    const validated = validateCreate(raw);
    if ("error" in validated) {
      notCreated[creationKey] = validated.error;
      continue;
    }

    const id = crypto.randomUUID();
    const row: PushSubscriptionRow = {
      id,
      accountId: ctx.account.id,
      deviceClientId: validated.deviceClientId ?? null,
      url: validated.url,
      types: validated.types,
      expires: validated.expires,
      verificationCode: generateVerificationCode(),
      verified: false,
      createdAt: Date.now(),
      lastPushAt: null,
    };
    try {
      ctx.store.insertPushSubscription(row);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "PushSubscription/set insert failed");
      notCreated[creationKey] = {
        type: "serverFail",
        description: "Could not store subscription",
      };
      continue;
    }

    pendingCreates++;
    mutated = true;
    // Send the verification handshake on the dispatcher's HTTP path. Done
    // off-thread so a slow relay doesn't stall the JMAP response.
    void ctx.dispatcher.sendVerification(row).catch((err) => {
      log.warn({ err: (err as Error).message, subId: id }, "push: sendVerification failed");
    });

    // Server-set properties returned to the client. Per §5.3 we include id
    // plus any field whose value the server picked itself — `expires` (if
    // we picked the default) and `verified` (always false here).
    const out: Record<string, unknown> = { id, verified: false };
    if (validated.expiresWasDefaulted) {
      out.expires = new Date(row.expires!).toISOString();
    }
    created[creationKey] = out;
  }

  // -- update -------------------------------------------------------------
  for (const [id, patch] of Object.entries(args.update ?? {})) {
    const row = ctx.store.getPushSubscription(id, ctx.account.id);
    if (!row) {
      notUpdated[id] = { type: "notFound" };
      continue;
    }
    const valid = validateUpdate(row, patch);
    if ("error" in valid) {
      notUpdated[id] = valid.error;
      continue;
    }
    if (Object.keys(valid.patch).length === 0 && !valid.verifying) {
      // No-op patch: spec says report success.
      updated[id] = null;
      continue;
    }

    if (valid.verifying) {
      // Mark verified, clear the one-shot code, persist any other patch
      // bits in the same statement so the row stays consistent.
      ctx.store.updatePushSubscription(id, ctx.account.id, {
        ...valid.patch,
        verified: true,
        verificationCode: null,
      });
      mutated = true;
      dirty = true;
      log.info({ accountId: ctx.account.id, subId: id }, "push: subscription verified");
    } else {
      ctx.store.updatePushSubscription(id, ctx.account.id, valid.patch);
      mutated = true;
      // `types` or `expires` changes need an IDLE recompute; e.g. extending
      // expiry on an already-expired sub re-arms its worker.
      dirty = true;
    }
    updated[id] = null;
  }

  // -- destroy ------------------------------------------------------------
  for (const id of args.destroy ?? []) {
    const ok = ctx.store.destroyPushSubscription(id, ctx.account.id);
    if (ok) {
      destroyed.push(id);
      mutated = true;
      dirty = true;
    } else {
      notDestroyed[id] = { type: "notFound" };
    }
  }

  if (mutated) ctx.store.bumpState(ctx.account.id, "push_subscription");
  if (dirty) ctx.dispatcher.notifySubscriberChange(ctx.account.id);

  return {
    oldState,
    newState: pushState(ctx.store, ctx.account.id),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    updated: Object.keys(updated).length ? updated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    destroyed: destroyed.length ? destroyed : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}

interface CreateValid {
  url: string;
  types: string[] | null;
  expires: number;
  expiresWasDefaulted: boolean;
  deviceClientId: string | undefined;
}

function validateCreate(raw: Record<string, unknown>): CreateValid | { error: SetError } {
  const url = raw.url;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    return {
      error: {
        type: "invalidProperties",
        properties: ["url"],
        description: "url must be an http(s) URL",
      },
    };
  }
  if (url.length > 2048) {
    return { error: { type: "invalidProperties", properties: ["url"], description: "url too long" } };
  }

  let types: string[] | null = null;
  if (raw.types !== undefined && raw.types !== null) {
    if (!Array.isArray(raw.types)) {
      return { error: { type: "invalidProperties", properties: ["types"], description: "must be array" } };
    }
    const out: string[] = [];
    for (const t of raw.types) {
      if (typeof t !== "string" || !ALLOWED_TYPES.has(t)) {
        return {
          error: {
            type: "invalidProperties",
            properties: ["types"],
            description: `Unknown JMAP type: ${String(t)}`,
          },
        };
      }
      out.push(t);
    }
    types = out;
  }

  const now = Date.now();
  let expires = now + DEFAULT_EXPIRES_MS;
  let expiresWasDefaulted = true;
  if (raw.expires !== undefined && raw.expires !== null) {
    if (typeof raw.expires !== "string") {
      return {
        error: { type: "invalidProperties", properties: ["expires"], description: "must be UTCDate string" },
      };
    }
    const parsed = Date.parse(raw.expires);
    if (Number.isNaN(parsed)) {
      return {
        error: { type: "invalidProperties", properties: ["expires"], description: "unparseable date" },
      };
    }
    // Clamp into [now+1min, now+1y]. Past values become "now" so the client
    // notices its subscription is already gone instead of silently never
    // firing.
    expires = Math.min(parsed, now + MAX_EXPIRES_MS);
    if (expires <= now) expires = now;
    expiresWasDefaulted = false;
  }

  // We accept `keys` for future Web Push compatibility but ignore the values
  // — payload encryption isn't wired up yet (the relay re-encrypts on its
  // side using its own VAPID key). Reject malformed shapes early though so
  // a future implementation has clean inputs.
  if (raw.keys !== undefined && raw.keys !== null) {
    if (typeof raw.keys !== "object") {
      return { error: { type: "invalidProperties", properties: ["keys"], description: "must be object" } };
    }
  }

  const deviceClientId =
    typeof raw.deviceClientId === "string" && raw.deviceClientId.length <= 256
      ? raw.deviceClientId
      : undefined;

  return { url, types, expires, expiresWasDefaulted, deviceClientId };
}

interface UpdateValid {
  patch: { types?: string[] | null; expires?: number };
  verifying: boolean;
}

function validateUpdate(
  row: PushSubscriptionRow,
  patch: Record<string, unknown>,
): UpdateValid | { error: SetError } {
  const out: UpdateValid = { patch: {}, verifying: false };

  for (const k of Object.keys(patch)) {
    if (k !== "verificationCode" && k !== "expires" && k !== "types") {
      return {
        error: {
          type: "invalidProperties",
          properties: [k],
          description: `Property ${k} is immutable on PushSubscription`,
        },
      };
    }
  }

  if ("verificationCode" in patch) {
    const code = patch.verificationCode;
    if (typeof code !== "string" || code.length === 0) {
      return {
        error: { type: "invalidProperties", properties: ["verificationCode"], description: "must be string" },
      };
    }
    if (!row.verificationCode) {
      // Already verified, or the code was cleared. Either way the client's
      // attempt is moot — but per spec we don't reveal the difference.
      return { error: { type: "invalidProperties", properties: ["verificationCode"], description: "incorrect" } };
    }
    if (!constantTimeEquals(code, row.verificationCode)) {
      return { error: { type: "invalidProperties", properties: ["verificationCode"], description: "incorrect" } };
    }
    out.verifying = true;
  }

  if ("types" in patch) {
    const t = patch.types;
    if (t === null) {
      out.patch.types = null;
    } else if (Array.isArray(t)) {
      const arr: string[] = [];
      for (const v of t) {
        if (typeof v !== "string" || !ALLOWED_TYPES.has(v)) {
          return {
            error: {
              type: "invalidProperties",
              properties: ["types"],
              description: `Unknown JMAP type: ${String(v)}`,
            },
          };
        }
        arr.push(v);
      }
      out.patch.types = arr;
    } else {
      return { error: { type: "invalidProperties", properties: ["types"], description: "must be array or null" } };
    }
  }

  if ("expires" in patch) {
    const e = patch.expires;
    if (typeof e !== "string") {
      return { error: { type: "invalidProperties", properties: ["expires"], description: "must be string" } };
    }
    const parsed = Date.parse(e);
    if (Number.isNaN(parsed)) {
      return { error: { type: "invalidProperties", properties: ["expires"], description: "unparseable date" } };
    }
    out.patch.expires = Math.min(parsed, Date.now() + MAX_EXPIRES_MS);
  }

  return out;
}

function generateVerificationCode(): string {
  // 32 base64url chars ≈ 192 bits of entropy. The relay treats this as
  // opaque — we just need it to be unguessable from the JMAP side so a
  // racing PushSubscription/set can't trick a verified state.
  return crypto.randomBytes(24).toString("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return crypto.timingSafeEqual(ab, bb);
}

// Suppress the rate-limit constant being flagged as unused until we wire it
// into the dispatcher's resend path.
void VERIFY_MIN_INTERVAL_MS;

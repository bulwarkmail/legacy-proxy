// Push fan-out: every state bump (Email/set, IDLE arrival, EmailSubmission/set,
// ...) lands here, gets debounced per-account, then mirrored to two channels:
//
//   1. The in-process EventSource hub (RFC 8620 §7.3) so any open browser tab
//      gets a `state` SSE event right away.
//   2. Every verified PushSubscription URL (RFC 8620 §7.2) — typically the
//      Bulwark relay, which forwards to FCM / Web Push for offline clients.
//
// Verification (PushVerification) is also handled here so the create-time POST
// runs on the same retrying HTTP path as StateChange forwards.

import { encodeCounterState, encodeEmailState } from "../state/states.js";
import type { Store, AccountRow, PushSubscriptionRow } from "../state/store.js";
import type { EventSourceHub } from "../jmap/eventsource.js";
import { log } from "../util/log.js";

// Internal store kinds → JMAP type names that share that counter.
// `Email` and `Thread` both ride on the email counter because the IMAP
// notion of "a new message arrived" maps to both. `EmailDelivery` is its
// own counter that only bumps on actual new arrivals (filtered IDLE EXISTS),
// so subscriptions that ask only for EmailDelivery don't fire for flag/move
// mutations.
const KIND_TO_JMAP_TYPES: Record<string, readonly string[]> = {
  email: ["Email", "Thread"],
  email_delivery: ["EmailDelivery"],
  mailbox: ["Mailbox"],
  identity: ["Identity"],
  submission: ["EmailSubmission"],
  vacation: ["VacationResponse"],
};

// Encode the counter the same way the corresponding /get response would, so a
// client receiving a StateChange and then issuing /get sees a matching state
// string. Mismatches don't break correctness (the client just refetches) but
// they cause noisy redundant Email/changes round-trips.
export function stateForKind(store: Store, accountId: number, kind: string): string {
  const counter = store.getState(accountId, kind);
  if (kind === "email") {
    return encodeEmailState({ uidvalidity: 0, modseq: counter });
  }
  if (kind === "submission") {
    return `sub-${counter}`;
  }
  return encodeCounterState(counter);
}

// Resolve the StateChange payload {jmapType: stateString} for a set of bumped
// kinds. If `kinds` is empty we pull every known kind so a manual sweep (e.g.
// a verification POST) carries the full account snapshot.
function buildStateChange(
  store: Store,
  accountId: number,
  kinds: Iterable<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of kinds) {
    const types = KIND_TO_JMAP_TYPES[kind];
    if (!types) continue;
    const state = stateForKind(store, accountId, kind);
    for (const t of types) out[t] = state;
  }
  return out;
}

// We coalesce bumps inside this window so a typical Email/set that bumps
// `email` and `mailbox` back-to-back becomes one push, not two. A short window
// keeps notifications snappy; too long and a slow client thinks the change
// got lost. 150ms is the upper bound a human eye can't perceive as latency.
const COALESCE_MS = 150;

// HTTP timeout for relay POSTs. The relay typically replies in <100ms; we
// wait a bit longer for transient slowness, but never long enough to back up
// the dispatcher queue. Failed pushes drop on the floor — JMAP push has no
// retry contract, the next state bump will deliver fresh state anyway.
const RELAY_TIMEOUT_MS = 5_000;

// PushSubscription URLs that fail repeatedly likely belong to a relay that's
// gone away. After this many consecutive failures we destroy the record so
// the IDLE worker can stop holding a connection on its behalf. 410 / 404
// trigger immediate destruction (matches the relay's own behaviour).
const MAX_CONSECUTIVE_FAILURES = 8;

interface PendingChange {
  kinds: Set<string>;
  timer: NodeJS.Timeout;
}

export class PushDispatcher {
  private pending = new Map<number, PendingChange>();
  private failureCount = new Map<string, number>();
  private accountById: (id: number) => AccountRow | undefined;
  private hooks: { onSubscriberChange?: (accountId: number) => void } = {};

  constructor(
    private store: Store,
    private hub: EventSourceHub,
    accountById: (id: number) => AccountRow | undefined,
  ) {
    this.accountById = accountById;
  }

  // The IDLE manager registers here so we can tell it whose connection list
  // changed when a subscription is created/verified/destroyed.
  setHooks(hooks: { onSubscriberChange?: (accountId: number) => void }): void {
    this.hooks = hooks;
  }

  notifySubscriberChange(accountId: number): void {
    this.hooks.onSubscriberChange?.(accountId);
  }

  // Main entry point used by `Store.setStateListener` and any code path that
  // bumps a counter directly. Schedules a flush; multiple calls inside the
  // coalesce window collapse into one outgoing push.
  onBump(accountId: number, kind: string, _state: number): void {
    const existing = this.pending.get(accountId);
    if (existing) {
      existing.kinds.add(kind);
      return;
    }
    const pending: PendingChange = {
      kinds: new Set([kind]),
      timer: setTimeout(() => {
        this.pending.delete(accountId);
        this.flush(accountId, pending.kinds).catch((err) => {
          log.warn({ err: (err as Error).message, accountId }, "push: flush failed");
        });
      }, COALESCE_MS),
    };
    this.pending.set(accountId, pending);
  }

  // Force-flush an account's pending bumps. Used during shutdown so the last
  // burst of changes still gets a push.
  async flushAll(): Promise<void> {
    const accounts = [...this.pending.keys()];
    for (const accountId of accounts) {
      const p = this.pending.get(accountId);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(accountId);
      await this.flush(accountId, p.kinds);
    }
  }

  private async flush(accountId: number, kinds: Set<string>): Promise<void> {
    const account = this.accountById(accountId);
    if (!account) return;

    const changed = buildStateChange(this.store, accountId, kinds);
    if (Object.keys(changed).length === 0) return;

    const accountIdStr = String(accountId);
    const stateChange = {
      "@type": "StateChange" as const,
      changed: { [accountIdStr]: changed },
    };

    // SSE: send everything that changed. The session-level eventsource URL
    // doesn't filter by type, which matches Stalwart's behaviour and the
    // existing webmail polling fallback.
    this.hub.publish(account, stateChange);

    // Push relay fan-out: filter by each subscription's `types`.
    const subs = this.store.activePushSubscriptions(accountId);
    for (const sub of subs) {
      const filtered = filterChanged(changed, sub.types);
      if (Object.keys(filtered).length === 0) continue;
      const body = {
        "@type": "StateChange",
        changed: { [accountIdStr]: filtered },
      };
      void this.deliver(sub, body, "StateChange");
    }
  }

  // Send the one-shot PushVerification on subscription create. Kept on the
  // dispatcher so the same retry/error-handling path covers verification and
  // ongoing state change forwards.
  async sendVerification(sub: PushSubscriptionRow): Promise<void> {
    if (!sub.verificationCode) return;
    const body = {
      "@type": "PushVerification",
      pushSubscriptionId: sub.id,
      verificationCode: sub.verificationCode,
    };
    await this.deliver(sub, body, "PushVerification");
  }

  private async deliver(
    sub: PushSubscriptionRow,
    body: unknown,
    kind: "StateChange" | "PushVerification",
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
    let status = 0;
    let ok = false;
    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Spec-mandated header so push services / proxies can identify the
          // payload kind without parsing the body.
          "x-push-type": kind,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = res.status;
      ok = res.ok;
      // Drain so keep-alive connections don't hang on to bytes.
      try {
        await res.arrayBuffer();
      } catch {
        // ignore
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message, url: sub.url, kind, subId: sub.id },
        "push: delivery network error",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (ok) {
      this.failureCount.delete(sub.id);
      this.store.updatePushSubscription(sub.id, sub.accountId, { lastPushAt: Date.now() });
      return;
    }

    // 404 / 410: the receiver disowned the subscription (relay teardown,
    // browser unsubscribed). Drop it now — keeping it would just keep IDLE
    // pinned open for nothing.
    if (status === 404 || status === 410) {
      log.info({ subId: sub.id, status, kind }, "push: subscription gone, destroying");
      this.store.destroyPushSubscription(sub.id, sub.accountId);
      this.failureCount.delete(sub.id);
      this.notifySubscriberChange(sub.accountId);
      return;
    }

    const fails = (this.failureCount.get(sub.id) ?? 0) + 1;
    this.failureCount.set(sub.id, fails);
    if (fails >= MAX_CONSECUTIVE_FAILURES) {
      log.warn({ subId: sub.id, status, fails }, "push: too many consecutive failures, destroying");
      this.store.destroyPushSubscription(sub.id, sub.accountId);
      this.failureCount.delete(sub.id);
      this.notifySubscriberChange(sub.accountId);
    } else {
      log.warn({ subId: sub.id, status, fails, kind }, "push: delivery failed");
    }
  }
}

function filterChanged(
  changed: Record<string, string>,
  types: string[] | null,
): Record<string, string> {
  if (!types || types.length === 0) return changed;
  const out: Record<string, string> = {};
  for (const t of types) {
    if (changed[t] !== undefined) out[t] = changed[t];
  }
  return out;
}

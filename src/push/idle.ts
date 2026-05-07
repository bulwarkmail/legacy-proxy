// Holds one dedicated IMAP connection per account that has at least one
// verified PushSubscription. The connection sits in INBOX with IDLE running,
// so EXISTS/EXPUNGE/FETCH-FLAGS untaggeds wake us as soon as the server emits
// them — no client polling, no cron, no second JMAP request. New arrivals
// bump `email_delivery` (the type the webmail subscribes to for system
// notifications); structural changes also bump `email` and `mailbox` so SSE
// clients refresh.
//
// The connection here is separate from the request-path ImapPool: imapflow
// only allows one mailbox-lock at a time, and we can't have a long-running
// IDLE blocking every Email/get the user issues. The dedicated socket also
// means a request-path connection drop never costs us push uptime.

import { ImapFlow } from "imapflow";
import type { Credentials } from "../auth/credentials.js";
import { openCredentials } from "../auth/credentials.js";
import { resolveProvider } from "../auth/providers.js";
import { openImap } from "../imap/client.js";
import type { Store, AccountRow } from "../state/store.js";
import type { AppConfig } from "../util/config.js";
import { log } from "../util/log.js";

// Reconnect backoff. Most disconnects are transient (mid-air NAT timeout,
// server restart), so start aggressive; cap so we don't hammer a server
// that's actually down. The cap is also the worst-case latency a user sees
// for the first push after extended downtime.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

// Most servers force-terminate IDLE after ~29 minutes (RFC 2177). We restart
// IDLE before that to keep the channel alive.
const IDLE_REFRESH_MS = 25 * 60_000;

// imapflow's IDLE helper is fire-and-await: it returns when IDLE ends. We
// kick it off in the background and rotate before the server times us out.
interface Worker {
  client: ImapFlow | null;
  closing: boolean;
  reconnectTimer: NodeJS.Timeout | null;
  refreshTimer: NodeJS.Timeout | null;
  backoffMs: number;
}

export class PushIdleManager {
  private workers = new Map<number, Worker>();

  constructor(
    private cfg: AppConfig,
    private store: Store,
  ) {}

  // Compute the desired set from the DB and converge `workers` onto it.
  // Idempotent — safe to call any time the subscription set changes.
  async sync(): Promise<void> {
    const desired = new Set(this.store.accountsWithActivePushSubs());

    // Drop workers for accounts that no longer need one.
    for (const [accountId, worker] of this.workers) {
      if (!desired.has(accountId)) {
        await this.stop(accountId, worker);
      }
    }

    // Spin up workers for newly active accounts.
    for (const accountId of desired) {
      if (this.workers.has(accountId)) continue;
      this.start(accountId);
    }
  }

  // Hook the dispatcher fires whenever a PushSubscription/set mutation lands.
  // We lazy-sync rather than tracking every transition by hand so the truth
  // always lives in SQLite.
  onSubscriberChange = (_accountId: number): void => {
    void this.sync();
  };

  async closeAll(): Promise<void> {
    for (const [accountId, worker] of this.workers) {
      await this.stop(accountId, worker);
    }
  }

  private start(accountId: number): void {
    const account = this.store.getAccountById(accountId);
    if (!account) return;
    const worker: Worker = {
      client: null,
      closing: false,
      reconnectTimer: null,
      refreshTimer: null,
      backoffMs: RECONNECT_MIN_MS,
    };
    this.workers.set(accountId, worker);
    this.connect(account, worker).catch((err) => {
      log.warn({ accountId, err: (err as Error).message }, "idle: initial connect failed");
      this.scheduleReconnect(account, worker);
    });
  }

  private async stop(accountId: number, worker: Worker): Promise<void> {
    worker.closing = true;
    if (worker.reconnectTimer) clearTimeout(worker.reconnectTimer);
    if (worker.refreshTimer) clearTimeout(worker.refreshTimer);
    if (worker.client) {
      try {
        await worker.client.logout();
      } catch {
        // best effort
      }
      worker.client = null;
    }
    this.workers.delete(accountId);
  }

  private async connect(account: AccountRow, worker: Worker): Promise<void> {
    if (worker.closing) return;
    const provider = resolveProvider(this.cfg, account.kind);
    const creds: Credentials = await openCredentials(this.cfg.vaultKey, account.vault);
    const client = await openImap({ provider, creds });

    // imapflow's `'exists'` event tells us the post-mutation count + the
    // previous count. A higher count is a true new arrival; equal/lower
    // happens on EXPUNGE-driven renumbering and is covered by the expunge
    // handler instead.
    client.on("exists", (ev: { count: number; prevCount: number }) => {
      if (ev.count > ev.prevCount) {
        // New mail arrived. Bump the dedicated counter that the webmail's
        // PushSubscription only opts in to, plus the broader Email/Mailbox
        // counters so SSE-listening tabs refresh right away.
        this.store.bumpState(account.id, "email_delivery");
        this.store.bumpState(account.id, "email");
        this.store.bumpState(account.id, "mailbox");
      } else {
        // EXISTS that didn't grow shouldn't drive a notification, but it
        // does mean the count moved — bump mailbox so cached counts refresh.
        this.store.bumpState(account.id, "mailbox");
      }
    });

    client.on("expunge", () => {
      // Deletes don't deserve a system notification but they do invalidate
      // any in-memory Email/Mailbox state on connected clients.
      this.store.bumpState(account.id, "email");
      this.store.bumpState(account.id, "mailbox");
    });

    client.on("flags", () => {
      // Read/Flagged toggles from another device land here. No EmailDelivery
      // bump (no new mail), but Email state moved.
      this.store.bumpState(account.id, "email");
    });

    client.on("close", () => {
      log.info({ accountId: account.id }, "idle: connection closed");
      if (worker.refreshTimer) clearTimeout(worker.refreshTimer);
      if (worker.client === client) worker.client = null;
      this.scheduleReconnect(account, worker);
    });

    client.on("error", (err: Error) => {
      log.warn({ accountId: account.id, err: err.message }, "idle: connection error");
    });

    // Open INBOX. imapflow returns a lock that other ops would normally need;
    // we hold it for the lifetime of the connection so IDLE never gets
    // interrupted by a mid-flight FETCH on this socket.
    await client.mailboxOpen("INBOX");

    worker.client = client;
    worker.backoffMs = RECONNECT_MIN_MS;
    log.info({ accountId: account.id, host: provider.imap.host }, "idle: connected");

    // Start the IDLE rotation. imapflow runs IDLE automatically when the
    // connection is otherwise quiet, but we explicitly cycle it before the
    // RFC 2177 30-minute server-side timeout would kill us.
    this.scheduleIdleRefresh(account, worker);
  }

  private scheduleIdleRefresh(account: AccountRow, worker: Worker): void {
    if (worker.refreshTimer) clearTimeout(worker.refreshTimer);
    worker.refreshTimer = setTimeout(() => {
      const c = worker.client;
      if (!c || worker.closing) return;
      // A NOOP both bumps the inactivity counter on the server side and
      // forces imapflow to drop+resume IDLE. Any failure here cascades to
      // the close handler, which will reconnect.
      c.noop().catch((err: Error) => {
        log.warn({ accountId: account.id, err: err.message }, "idle: refresh noop failed");
      });
      this.scheduleIdleRefresh(account, worker);
    }, IDLE_REFRESH_MS);
  }

  private scheduleReconnect(account: AccountRow, worker: Worker): void {
    if (worker.closing) return;
    if (worker.reconnectTimer) clearTimeout(worker.reconnectTimer);
    const delay = worker.backoffMs;
    worker.backoffMs = Math.min(worker.backoffMs * 2, RECONNECT_MAX_MS);
    log.info({ accountId: account.id, delayMs: delay }, "idle: scheduling reconnect");
    worker.reconnectTimer = setTimeout(() => {
      worker.reconnectTimer = null;
      this.connect(account, worker).catch((err) => {
        log.warn({ accountId: account.id, err: (err as Error).message }, "idle: reconnect failed");
        this.scheduleReconnect(account, worker);
      });
    }, delay);
  }
}

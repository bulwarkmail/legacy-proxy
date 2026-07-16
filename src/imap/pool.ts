import type { ImapFlow } from "imapflow";
import type { Credentials } from "../auth/credentials.js";
import type { AppConfig } from "../util/config.js";
import { resolveProvider } from "../auth/providers.js";
import { openCredentials } from "../auth/credentials.js";
import { openImap } from "./client.js";
import type { Store, AccountRow } from "../state/store.js";
import { log } from "../util/log.js";

interface PoolEntry {
  client: ImapFlow;
  lastUsed: number;
}

// Skip the sanity-NOOP if the connection was used within this window.
// Every JMAP method funnels through getForAccount, so a per-call NOOP
// adds one IMAP round-trip to every request - visible as multi-second
// latency on slow links. Most servers don't drop idle TCP for tens of
// seconds, so we only NOOP after a meaningful idle gap.
const NOOP_FRESHNESS_MS = 30_000;

// Two connections per account, by role:
//   - "interactive": JMAP method calls (the latency-sensitive path).
//   - "bulk": blob downloads and thread-index scans — operations that can
//     hold the socket for seconds. Splitting them keeps a 20 MB attachment
//     download or a first-time account scan from freezing every other
//     request for the account, since imapflow serializes commands per
//     connection.
export type PoolRole = "interactive" | "bulk";

export class ImapPool {
  private entries = new Map<string, PoolEntry>();

  constructor(
    private cfg: AppConfig,
    private store: Store,
  ) {}

  async getForAccount(account: AccountRow, role: PoolRole = "interactive"): Promise<ImapFlow> {
    const key = `${account.id}:${role}`;
    const existing = this.entries.get(key);
    if (existing && existing.client.usable) {
      const idleMs = Date.now() - existing.lastUsed;
      existing.lastUsed = Date.now();
      if (idleMs < NOOP_FRESHNESS_MS) return existing.client;
      try {
        await existing.client.noop();
        return existing.client;
      } catch {
        this.entries.delete(key);
      }
    }
    const provider = resolveProvider(this.cfg, account.kind);
    const creds: Credentials = await openCredentials(this.cfg.vaultKey, account.vault);
    const client = await openImap({ provider, creds });
    this.attach(account, key, client);
    return client;
  }

  // Hand a live, already-authenticated connection to the pool. The auth paths
  // open a probe connection to validate credentials; adopting it saves the
  // immediately-following JMAP request from paying a second TCP+TLS+LOGIN
  // handshake. If the slot is already occupied the probe is logged out.
  adopt(account: AccountRow, client: ImapFlow): void {
    const key = `${account.id}:interactive`;
    const existing = this.entries.get(key);
    if (existing && existing.client.usable) {
      client.logout().catch(() => {});
      return;
    }
    this.attach(account, key, client);
  }

  private attach(account: AccountRow, key: string, client: ImapFlow): void {
    client.on("close", () => {
      log.warn({ account: account.slug, key }, "imap connection closed");
      this.entries.delete(key);
    });
    client.on("error", (err: Error) => {
      log.warn({ account: account.slug, key, err: err.message }, "imap connection error");
      this.entries.delete(key);
    });
    this.entries.set(key, { client, lastUsed: Date.now() });
  }

  async closeAll(): Promise<void> {
    for (const e of this.entries.values()) {
      try {
        await e.client.logout();
      } catch {
        // best effort
      }
    }
    this.entries.clear();
  }
}

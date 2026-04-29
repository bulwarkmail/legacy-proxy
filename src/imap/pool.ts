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
  busy: number;
}

// Skip the sanity-NOOP if the connection was used within this window.
// Every JMAP method funnels through getForAccount, so a per-call NOOP
// adds one IMAP round-trip to every request - visible as multi-second
// latency on slow links. Most servers don't drop idle TCP for tens of
// seconds, so we only NOOP after a meaningful idle gap.
const NOOP_FRESHNESS_MS = 30_000;

export class ImapPool {
  private entries = new Map<number, PoolEntry>();

  constructor(
    private cfg: AppConfig,
    private store: Store,
  ) {}

  async getForAccount(account: AccountRow): Promise<ImapFlow> {
    const existing = this.entries.get(account.id);
    if (existing && existing.client.usable) {
      const idleMs = Date.now() - existing.lastUsed;
      existing.lastUsed = Date.now();
      if (idleMs < NOOP_FRESHNESS_MS) return existing.client;
      try {
        await existing.client.noop();
        return existing.client;
      } catch {
        this.entries.delete(account.id);
      }
    }
    const provider = resolveProvider(this.cfg, account.kind);
    const creds: Credentials = await openCredentials(this.cfg.vaultKey, account.vault);
    const client = await openImap({ provider, creds });
    client.on("close", () => {
      log.warn({ account: account.slug }, "imap connection closed");
      this.entries.delete(account.id);
    });
    client.on("error", (err: Error) => {
      log.warn({ account: account.slug, err: err.message }, "imap connection error");
      this.entries.delete(account.id);
    });
    this.entries.set(account.id, { client, lastUsed: Date.now(), busy: 0 });
    return client;
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

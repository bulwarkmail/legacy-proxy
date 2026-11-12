import type { FastifyReply } from "fastify";
import type { AccountRow } from "../state/store.js";

// RFC 8620 §7.3 StateChange. Same shape the relay forwards to FCM/Web Push,
// the webmail's SSE listener parses on the wire, and the polling fallback
// synthesises locally when EventSource isn't available — so we mirror it
// exactly. `@type` lets clients distinguish StateChange from PushVerification
// when they're multiplexed on the same channel.
export interface StateChange {
  "@type": "StateChange";
  changed: Record<string, Record<string, string>>;
}

/** The session a stream was opened with, so the stream can end with it. */
export interface StreamSession {
  /** Credential generation the session was issued under. */
  gen: number;
  /** Credential tag of the credentials it was made with. */
  tag?: string;
  /** SHA-256 of the Bearer token, for a stream opened with one. */
  tokenHash?: string;
}

interface Subscriber {
  reply: FastifyReply;
  types: Set<string> | null;
  closeAfter: boolean;
  ping: NodeJS.Timeout;
  session?: StreamSession;
}

/** Open event streams per account; a new one past this closes the oldest. */
export const MAX_STREAMS_PER_ACCOUNT = 10;

export class EventSourceHub {
  private clients = new Map<number, Set<Subscriber>>();
  private streamsListener: ((accountId: number, open: boolean) => void) | null = null;

  constructor(private readonly maxStreamsPerAccount = MAX_STREAMS_PER_ACCOUNT) {}

  /**
   * Called with `open: true` when an account's first stream opens and with
   * `open: false` when its last one closes.
   */
  setStreamsListener(listener: ((accountId: number, open: boolean) => void) | null): void {
    this.streamsListener = listener;
  }

  /** Accounts with at least one open stream. */
  accountsWithStreams(): number[] {
    return [...this.clients.keys()];
  }

  private dropAccountIfEmpty(accountId: number, set: Set<Subscriber>): void {
    if (set.size > 0 || this.clients.get(accountId) !== set) return;
    this.clients.delete(accountId);
    this.streamsListener?.(accountId, false);
  }

  add(
    account: AccountRow,
    reply: FastifyReply,
    origin: string | null,
    opts: { types?: string[] | null; closeAfter?: boolean; pingSec?: number; session?: StreamSession } = {},
  ): void {
    const pingSec = opts.pingSec ?? 30;
    let set = this.clients.get(account.id);
    const first = !set;
    if (!set) {
      set = new Set();
      this.clients.set(account.id, set);
    }
    // A Set iterates in insertion order, so the first entry is the oldest stream.
    for (const oldest of set) {
      if (set.size < this.maxStreamsPerAccount) break;
      set.delete(oldest);
      clearInterval(oldest.ping);
      try {
        oldest.reply.raw.end();
      } catch {
        // already gone
      }
    }
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    // Readable from any origin that authenticates with a header, like every
    // other route. Never with Allow-Credentials: clients read the stream with
    // an Authorization header, not with cookies or credentials the browser holds.
    if (origin) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Vary", "Origin");
    }
    reply.raw.write(`: connected\n\n`);
    const ping = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        // Connection torn down; the close handler below will clean up.
      }
    }, pingSec * 1000);

    const sub: Subscriber = {
      reply,
      types: opts.types && opts.types.length > 0 ? new Set(opts.types) : null,
      closeAfter: opts.closeAfter ?? false,
      ping,
      ...(opts.session ? { session: opts.session } : {}),
    };
    set.add(sub);
    if (first) this.streamsListener?.(account.id, true);

    reply.raw.on("close", () => {
      clearInterval(sub.ping);
      const accountSet = this.clients.get(account.id);
      if (!accountSet?.delete(sub)) return;
      this.dropAccountIfEmpty(account.id, accountSet);
    });
  }

  /**
   * End the account's streams whose session `ended` says may no longer be
   * served. Streams opened without a session are left open.
   */
  closeWhere(accountId: number, ended: (session: StreamSession) => boolean): void {
    const set = this.clients.get(accountId);
    if (!set) return;
    for (const sub of [...set]) {
      if (!sub.session || !ended(sub.session)) continue;
      set.delete(sub);
      clearInterval(sub.ping);
      try {
        sub.reply.raw.end();
      } catch {
        // already gone
      }
    }
    this.dropAccountIfEmpty(accountId, set);
  }

  publish(account: AccountRow, change: StateChange): void {
    const set = this.clients.get(account.id);
    if (!set) return;
    // Per §7.3 the wire format is `event: state\ndata: <json>\n\n`. Inline the
    // JSON since most StateChange payloads are tiny.
    for (const sub of set) {
      const filtered = sub.types ? filterByTypes(change, sub.types) : change;
      if (Object.keys(filtered.changed).length === 0) continue;
      const data = `event: state\ndata: ${JSON.stringify(filtered)}\n\n`;
      try {
        sub.reply.raw.write(data);
      } catch {
        continue;
      }
      if (sub.closeAfter) {
        try {
          sub.reply.raw.end();
        } catch {
          // ignore
        }
      }
    }
  }
}

// Drop accounts whose changed-types are all outside the subscriber's filter.
// We keep the original account ids and rebuild only the per-account map so a
// future multi-account session sees only the slices it asked for.
function filterByTypes(change: StateChange, types: Set<string>): StateChange {
  const out: Record<string, Record<string, string>> = {};
  for (const [accountId, perType] of Object.entries(change.changed)) {
    const slice: Record<string, string> = {};
    for (const [t, state] of Object.entries(perType)) {
      if (types.has(t)) slice[t] = state;
    }
    if (Object.keys(slice).length > 0) out[accountId] = slice;
  }
  return { "@type": "StateChange", changed: out };
}

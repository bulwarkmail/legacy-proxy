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

interface Subscriber {
  reply: FastifyReply;
  types: Set<string> | null;
  closeAfter: boolean;
  ping: NodeJS.Timeout;
}

export class EventSourceHub {
  private clients = new Map<number, Set<Subscriber>>();

  add(
    account: AccountRow,
    reply: FastifyReply,
    origin: string | null,
    opts: { types?: string[] | null; closeAfter?: boolean; pingSec?: number } = {},
  ): void {
    const pingSec = opts.pingSec ?? 30;
    let set = this.clients.get(account.id);
    if (!set) {
      set = new Set();
      this.clients.set(account.id, set);
    }
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    if (origin) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
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
    };
    set.add(sub);

    reply.raw.on("close", () => {
      clearInterval(sub.ping);
      const accountSet = this.clients.get(account.id);
      accountSet?.delete(sub);
      if (accountSet && accountSet.size === 0) this.clients.delete(account.id);
    });
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

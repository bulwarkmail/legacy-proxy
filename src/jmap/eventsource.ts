import type { FastifyReply } from "fastify";
import type { AccountRow } from "../state/store.js";

export interface SsePayload {
  changed: Record<string, Record<string, string>>;
}

export class EventSourceHub {
  private clients = new Map<number, Set<FastifyReply>>();

  add(account: AccountRow, reply: FastifyReply, origin: string | null, pingSec = 30) {
    let set = this.clients.get(account.id);
    if (!set) {
      set = new Set();
      this.clients.set(account.id, set);
    }
    set.add(reply);
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
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), pingSec * 1000);
    reply.raw.on("close", () => {
      clearInterval(ping);
      set?.delete(reply);
    });
  }

  publish(account: AccountRow, payload: SsePayload) {
    const set = this.clients.get(account.id);
    if (!set) return;
    const data = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const r of set) r.raw.write(data);
  }
}

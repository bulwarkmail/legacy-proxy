import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { EventSourceHub, MAX_STREAMS_PER_ACCOUNT } from "../../src/jmap/eventsource.js";
import type { AccountRow } from "../../src/state/store.js";

/** Enough of a Fastify reply for the hub: a raw response that records what happens to it. */
function fakeReply() {
  const raw = Object.assign(new EventEmitter(), {
    headers: {} as Record<string, string>,
    ended: false,
    written: [] as string[],
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    write(chunk: string) {
      this.written.push(chunk);
      return true;
    },
    end() {
      this.ended = true;
      this.emit("close");
    },
  });
  return { raw } as unknown as import("fastify").FastifyReply & { raw: typeof raw };
}

const account = (id: number) => ({ id }) as AccountRow;

describe("event streams per account", () => {
  it("closes the oldest stream when an account opens one more than the limit", () => {
    const hub = new EventSourceHub();
    const replies = Array.from({ length: MAX_STREAMS_PER_ACCOUNT + 1 }, () => fakeReply());
    for (const r of replies) hub.add(account(1), r, null, { pingSec: 300 });

    expect(MAX_STREAMS_PER_ACCOUNT).toBe(10);
    expect(replies.map((r) => r.raw.ended)).toEqual([true, ...new Array(MAX_STREAMS_PER_ACCOUNT).fill(false)]);

    // The ten streams left all still get the account's changes.
    hub.publish(account(1), { "@type": "StateChange", changed: { "1": { Email: "s2" } } });
    expect(replies.slice(1).every((r) => r.raw.written.some((w) => w.startsWith("event: state")))).toBe(true);
    for (const r of replies) r.raw.end();
  });

  it("counts each account on its own", () => {
    const hub = new EventSourceHub(2);
    const a = [fakeReply(), fakeReply()];
    const b = [fakeReply(), fakeReply()];
    for (const r of a) hub.add(account(1), r, null, { pingSec: 300 });
    for (const r of b) hub.add(account(2), r, null, { pingSec: 300 });
    expect([...a, ...b].some((r) => r.raw.ended)).toBe(false);
    for (const r of [...a, ...b]) r.raw.end();
  });
});

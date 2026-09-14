// Email/query on a folder with a few thousand messages used to send every UID
// in one UID FETCH line; servers with a line-length cap rejected it and the
// folder came back empty. These pin the packing and the per-command bound.

import type { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { fetchByUid, uidSets } from "../../src/imap/uids.js";

function expand(sets: string[]): number[] {
  const out: number[] = [];
  for (const set of sets) {
    for (const part of set.split(",")) {
      const [a, b] = part.split(":").map(Number);
      if (b === undefined) out.push(a!);
      else for (let u = a!; u <= b; u++) out.push(u);
    }
  }
  return out;
}

describe("uidSets", () => {
  it("returns nothing for an empty list", () => {
    expect(uidSets([])).toEqual([]);
  });

  it("collapses contiguous runs into ranges", () => {
    expect(uidSets([1, 2, 3, 5, 7, 8])).toEqual(["1:3,5,7:8"]);
  });

  it("sorts and de-duplicates its input", () => {
    expect(uidSets([5, 3, 4, 4, 1])).toEqual(["1,3:5"]);
  });

  it("drops values that are not valid UIDs", () => {
    expect(uidSets([0, -1, Number.NaN, 1.5, 2])).toEqual(["2"]);
  });

  it("keeps a dense folder of any size to a single command", () => {
    const uids = Array.from({ length: 2500 }, (_, i) => 100000 + i);
    expect(uidSets(uids)).toEqual(["100000:102499"]);
  });

  it("splits a sparse set so no command exceeds the byte budget", () => {
    const uids = Array.from({ length: 20000 }, (_, i) => 100000 + i * 2);
    const sets = uidSets(uids);
    expect(sets.length).toBeGreaterThan(1);
    for (const s of sets) expect(s.length).toBeLessThanOrEqual(4000);
    expect(expand(sets)).toEqual(uids);
  });

  it("splits only between parts, never inside one", () => {
    expect(uidSets([1, 3, 5, 7], 3)).toEqual(["1,3", "5,7"]);
    expect(uidSets([123456], 3)).toEqual(["123456"]);
  });
});

describe("fetchByUid", () => {
  it("issues one UID FETCH per set and yields every message", async () => {
    const calls: { range: string; options: unknown }[] = [];
    const client = {
      async *fetch(range: string, _query: unknown, options: unknown) {
        calls.push({ range, options });
        for (const uid of expand([range])) yield { uid, seq: uid };
      },
    } as unknown as ImapFlow;

    const uids = Array.from({ length: 3000 }, (_, i) => 1 + i * 2);
    const seen: number[] = [];
    for await (const msg of fetchByUid(client, uids, { uid: true })) seen.push(msg.uid);

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.options).toEqual({ uid: true });
    expect(seen).toEqual(uids);
  });
});

// The calendar watcher turns CalDAV changes into StateChanges on open event
// streams. Its first look at an account only records the state.

import { expect, it } from "vitest";
import { CalendarWatcher } from "../../src/push/calendar-watch.js";
import type { AccountRow } from "../../src/state/store.js";

function setup(served?: (id: number) => string | undefined) {
  const open = new Set<number>([1]);
  const states = new Map<number, string | null | Error>([[1, "s1"]]);
  const published: [number, string][] = [];
  let checks = 0;
  const watcher = new CalendarWatcher({
    intervalMs: 0,
    accounts: () => [...open],
    accountById: (id) => ({ id }) as AccountRow,
    stateOf: async (a) => {
      checks++;
      const s = states.get(a.id);
      if (s instanceof Error) throw s;
      return s ?? null;
    },
    publish: (a, s) => published.push([a.id, s]),
    served,
  });
  return { watcher, open, states, published, checks: () => checks };
}

it("pushes only when the state moved after the first look", async () => {
  const { watcher, states, published } = setup();
  await watcher.tick();
  expect(published).toEqual([]);
  await watcher.tick();
  expect(published).toEqual([]);
  states.set(1, "s2");
  await watcher.tick();
  expect(published).toEqual([[1, "s2"]]);
  await watcher.tick();
  expect(published).toHaveLength(1);
});

it("forgets an account whose streams closed, and survives a failed check", async () => {
  const { watcher, open, states, published, checks } = setup();
  await watcher.tick();
  open.delete(1);
  states.set(1, "s2");
  await watcher.tick();
  expect(checks()).toBe(1);
  // Reopened: a fresh first look, no push for what changed while it was closed.
  open.add(1);
  await watcher.tick();
  expect(published).toEqual([]);

  states.set(1, new Error("DAV down"));
  await watcher.tick();
  states.set(1, "s3");
  await watcher.tick();
  expect(published).toEqual([[1, "s3"]]);
});


it("pushes a change made between the client's load and the first look", async () => {
  const { watcher, states, published } = setup((id) => (id === 1 ? "s0" : undefined));
  states.set(1, "s1");
  await watcher.tick();
  expect(published).toEqual([[1, "s1"]]);
  await watcher.tick();
  expect(published).toHaveLength(1);
});

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/state/store.js";

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "changelog-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// An IDLE arrival bumps the state without log entries. Before, a log that
// still held an earlier Email/set answered Email/changes with an empty diff
// past the arrival, and a client that trusts it never showed the new mail.
it("cannot replay a period that contains an unlogged state move", () => {
  const s0 = store.recordChanges(1, "email", { created: ["a"] });
  expect(store.entriesSince(1, "email", s0 - 1, s0)).toHaveLength(1);
  const s1 = store.bumpState(1, "email");
  expect(store.entriesSince(1, "email", s0, s1)).toBeNull();
  const s2 = store.recordChanges(1, "email", { created: ["b"] });
  expect(store.entriesSince(1, "email", s0, s2)).toBeNull();
  expect(store.entriesSince(1, "email", s1, s2)).toEqual([{ state: s2, action: "created", id: "b" }]);
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { GmailStore } from "../../src/gmail/store.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
  vi.useRealTimers();
});
function open(limit: number, key = crypto.randomBytes(32), dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-cache-"))) {
  const store = new GmailStore(dir, key, limit);
  cleanup.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir, key };
}

it("evicts the least recently used entries once an account exceeds its cache budget", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  const { store } = open(3_100); // three sealed entries, the fourth evicts one
  const entry = "x".repeat(998); // 1,000 bytes once JSON-encoded
  store.cache("a@example.test", "one", entry, 3_600_000);
  vi.setSystemTime(1_100_000);
  store.cache("a@example.test", "two", entry, 3_600_000);
  vi.setSystemTime(1_200_000);
  store.cache("a@example.test", "three", entry, 3_600_000);
  // Reading "one" and "two" more than a minute later makes them recent again, so "three" is the oldest.
  vi.setSystemTime(1_300_000);
  expect(store.cached("a@example.test", "one")).toBe(entry);
  store.cache("b@example.test", "other", entry, 3_600_000);
  expect(store.cached("a@example.test", "two")).toBe(entry); // other accounts do not count
  vi.setSystemTime(1_400_000);
  store.cache("a@example.test", "four", entry, 3_600_000);
  expect(store.cached("a@example.test", "one")).toBe(entry);
  expect(store.cached("a@example.test", "three")).toBeNull();
  expect(store.cached("a@example.test", "four")).toBe(entry);
});

it("never serves expired entries", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
  const { store } = open(1_000_000);
  store.cache("a@example.test", "short", { v: 1 }, 1_000);
  vi.setSystemTime(1_002_000);
  expect(store.cached("a@example.test", "short")).toBeNull();
});

it("keeps cached mail unreadable without the vault key", () => {
  const { store, dir, key } = open(1_000_000);
  store.cache("a@example.test", "meta:v2:x", { subject: "Quarterly figures" }, 3_600_000);
  store.close();
  const bytes = fs.readFileSync(path.join(dir, "gmail.sqlite3"));
  expect(bytes.includes(Buffer.from("Quarterly figures"))).toBe(false);
  // The same key reads it back; a different one cannot, and drops the row.
  const reopened = open(1_000_000, key, dir).store;
  expect(reopened.cached("a@example.test", "meta:v2:x")).toEqual({ subject: "Quarterly figures" });
  reopened.close();
  const stranger = open(1_000_000, crypto.randomBytes(32), dir).store;
  expect(stranger.cached("a@example.test", "meta:v2:x")).toBeNull();
  expect(stranger.cached("a@example.test", "meta:v2:x")).toBeNull();
});

it("drops mail a history record names, however long its entry had left", () => {
  const { store } = open(1_000_000);
  const email = "a@example.test";
  store.checkpoint(email, "10", [], []);
  store.cache(email, "meta:v2:changed", { subject: "before" }, 30 * 24 * 60 * 60_000);
  store.cache(email, "meta:v2:untouched", { subject: "keep" }, 30 * 24 * 60 * 60_000);
  store.checkpoint(email, "11", ["changed"], []);
  expect(store.cached(email, "meta:v2:changed")).toBeNull();
  expect(store.cached(email, "meta:v2:untouched")).toEqual({ subject: "keep" });
});

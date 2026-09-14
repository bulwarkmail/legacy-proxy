// The blob cache backs /jmap/download. A blobId names an immutable
// (mailbox, uidvalidity, uid, part) tuple, so a hit is always current -- the
// expiry and the size cap exist to bound disk, not to protect correctness.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../../src/state/store.js";

const HOUR = 60 * 60_000;

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "blobcache-"));
  store = new Store(dir);
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("blob cache", () => {
  it("round-trips a body with its content type", () => {
    const body = Buffer.from("attachment bytes");
    store.putCachedBlob({ id: "B1", accountId: 1, ctype: "image/png", body, ttlMs: HOUR });

    const got = store.getCachedBlob("B1", 1);
    expect(got?.ctype).toBe("image/png");
    expect(got?.body.equals(body)).toBe(true);
  });

  it("scopes entries to the owning account", () => {
    store.putCachedBlob({ id: "B1", accountId: 1, ctype: null, body: Buffer.from("x"), ttlMs: HOUR });
    expect(store.getCachedBlob("B1", 2)).toBeNull();
  });

  it("does not serve an expired entry", () => {
    store.putCachedBlob({ id: "B1", accountId: 1, ctype: null, body: Buffer.from("x"), ttlMs: -1 });
    expect(store.getCachedBlob("B1", 1)).toBeNull();
  });

  it("overwrites an existing id rather than failing the insert", () => {
    store.putCachedBlob({ id: "B1", accountId: 1, ctype: "text/plain", body: Buffer.from("old"), ttlMs: HOUR });
    store.putCachedBlob({ id: "B1", accountId: 1, ctype: "text/html", body: Buffer.from("new"), ttlMs: HOUR });

    const got = store.getCachedBlob("B1", 1);
    expect(got?.ctype).toBe("text/html");
    expect(got?.body.toString()).toBe("new");
  });

  it("prunes expired rows and evicts once past the size cap", () => {
    store.putCachedBlob({ id: "dead", accountId: 1, ctype: null, body: Buffer.from("x"), ttlMs: -1 });
    for (let i = 0; i < 8; i++) {
      store.putCachedBlob({
        id: `B${i}`,
        accountId: 1,
        ctype: null,
        body: Buffer.alloc(1024),
        ttlMs: HOUR + i,
      });
    }

    store.pruneBlobCache(4 * 1024);

    expect(store.getCachedBlob("dead", 1)).toBeNull();
    const remaining = (
      store.db.prepare(`SELECT COUNT(*) AS n FROM blob_cache`).get() as { n: number }
    ).n;
    expect(remaining).toBeLessThan(8);
    expect(remaining).toBeGreaterThan(0);
  });

  it("leaves the cache alone while it fits under the cap", () => {
    for (let i = 0; i < 3; i++) {
      store.putCachedBlob({ id: `B${i}`, accountId: 1, ctype: null, body: Buffer.alloc(100), ttlMs: HOUR });
    }
    store.pruneBlobCache(1024 * 1024);
    expect(store.getCachedBlob("B0", 1)).not.toBeNull();
    expect(store.getCachedBlob("B2", 1)).not.toBeNull();
  });
});

// The databases are made readable by their owner only at every start. On a
// volume where that fails, the proxy logs one warning and starts anyway: the
// file mode is a second line of defence, and a proxy that doesn't start after
// an upgrade is the worse outcome.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../src/state/store.js";
import { GmailStore } from "../../src/gmail/store.js";
import { log } from "../../src/util/log.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) f();
});
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-file-mode-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function chmodFails() {
  vi.spyOn(fs, "chmodSync").mockImplementation(() => {
    throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
  });
  return vi.spyOn(log, "warn").mockImplementation(() => undefined);
}

describe("a database whose mode can't be set", () => {
  it("proxy.db: starts with one warning that names the file", () => {
    const dir = tempDir();
    const first = new Store(dir); // the database and its WAL and SHM files exist now
    cleanup.push(() => first.close());
    const warn = chmodFails();
    const store = new Store(dir);
    cleanup.push(() => store.close());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("proxy.db");
    expect(JSON.stringify(warn.mock.calls[0])).toMatch(/owner/);
    // And it works.
    store.upsertAccount({ slug: "generic:pat@corp.test", kind: "generic", host: "imap.test", username: "pat@corp.test", vault: Buffer.alloc(40) });
    expect(store.getAccount("generic:pat@corp.test")?.username).toBe("pat@corp.test");
  });

  it("gmail.sqlite3: starts with one warning that names the file", () => {
    const dir = tempDir();
    const warn = chmodFails();
    const store = new GmailStore(dir, crypto.randomBytes(32));
    cleanup.push(() => store.close());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).toContain("gmail.sqlite3");
    expect(store.connectedEmails()).toEqual([]);
  });

  it("gives no warning when the mode is set", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const dir = tempDir();
    const store = new Store(dir);
    cleanup.push(() => store.close());
    const gmail = new GmailStore(dir, crypto.randomBytes(32));
    cleanup.push(() => gmail.close());
    expect(warn).not.toHaveBeenCalled();
  });
});

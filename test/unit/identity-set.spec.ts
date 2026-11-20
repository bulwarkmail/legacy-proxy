// Identity/set (RFC 8621 §6.3): the login's identity plus identities the user
// creates for other addresses, e.g. aliases of the mailbox.

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type AccountRow } from "../../src/state/store.js";
import { identityChanges, identityGet, identitySet } from "../../src/jmap/methods/identity.js";

let dir: string;
let store: Store;
let account: AccountRow;
let ctx: { account: AccountRow; store: Store };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ident-"));
  store = new Store(dir);
  store.db
    .prepare(`INSERT INTO account(id, slug, kind, host, username, vault, created_at) VALUES (1, 'imap:u', 'imap', 'imap.example.org', 'user@example.org', x'00', 0)`)
    .run();
  account = store.db.prepare(`SELECT * FROM account WHERE id = 1`).get() as AccountRow;
  ctx = { account, store };
});

afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const list = async () => (await identityGet({ accountId: "1", ids: null }, ctx)).list;

it("creates, lists, updates and destroys a further identity", async () => {
  const before = (await identityGet({ accountId: "1", ids: null }, ctx)).state;
  const res = await identitySet(
    { accountId: "1", create: { k1: { email: "alias@example.org", name: "Sales", textSignature: "-- \nSales team" } } },
    ctx,
  );
  const id = res.created!.k1!.id;
  expect(res.created!.k1).toMatchObject({ mayDelete: true });
  expect(await list()).toMatchObject([
    { email: "user@example.org", mayDelete: false },
    { id, email: "alias@example.org", name: "Sales", textSignature: "-- \nSales team", mayDelete: true },
  ]);
  expect(await identityChanges({ accountId: "1", sinceState: before }, ctx)).toMatchObject({ created: [id] });

  // Name and signature can change; the address can't.
  const upd = await identitySet({ accountId: "1", update: { [id]: { name: "Sales EU", email: "alias@example.org" } } }, ctx);
  expect(upd.updated).toEqual({ [id]: null });
  const bad = await identitySet({ accountId: "1", update: { [id]: { email: "other@example.org" } } }, ctx);
  expect(bad.notUpdated![id]).toMatchObject({ type: "invalidProperties", properties: ["email"] });
  expect((await list())[1]).toMatchObject({ name: "Sales EU", email: "alias@example.org" });

  const del = await identitySet({ accountId: "1", destroy: [id, "nope"] }, ctx);
  expect(del.destroyed).toEqual([id]);
  expect(del.notDestroyed).toMatchObject({ nope: { type: "notFound" } });
  expect(await list()).toHaveLength(1);
});

it("refuses an identity without one plain address, and destroying the login's", async () => {
  const res = await identitySet(
    {
      accountId: "1",
      create: { a: { name: "x" }, b: { email: "Someone <x@example.org>" }, c: { email: "a@example.org, b@example.org" } },
      destroy: ["i-1"],
    },
    ctx,
  );
  expect(Object.values(res.notCreated!).map((e) => e.type)).toEqual(["invalidProperties", "invalidProperties", "invalidProperties"]);
  expect(res.notDestroyed).toMatchObject({ "i-1": { type: "forbidden" } });
  expect(await list()).toHaveLength(1);
});

it("still edits the login's identity as before", async () => {
  const res = await identitySet({ accountId: "1", update: { "i-1": { name: "Jane Doe", email: "user@example.org" } } }, ctx);
  expect(res.updated).toEqual({ "i-1": null });
  expect((await list())[0]).toMatchObject({ name: "Jane Doe" });
});

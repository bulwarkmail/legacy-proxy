// Identity/set (RFC 8621 §6.3): the login's identity plus identities the user
// creates for other addresses, e.g. aliases of the mailbox.

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store, type AccountRow } from "../../src/state/store.js";
import { MAX_EXTRA_IDENTITIES, identityChanges, identityGet, identitySet } from "../../src/jmap/methods/identity.js";

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

it("refuses identities past the limit, and forgets them with the account", async () => {
  const create = Object.fromEntries(
    Array.from({ length: MAX_EXTRA_IDENTITIES + 1 }, (_, i) => [`k${i}`, { email: `alias${i}@example.org` }]),
  );
  const res = await identitySet({ accountId: "1", create }, ctx);
  expect(Object.keys(res.created!)).toHaveLength(MAX_EXTRA_IDENTITIES);
  expect(res.notCreated).toMatchObject({ [`k${MAX_EXTRA_IDENTITIES}`]: { type: "overQuota" } });

  store.db.prepare(`DELETE FROM account WHERE id = 1`).run();
  expect(store.listExtraIdentities(1)).toEqual([]);
});

it("keeps the Bcc addresses of the login's identity and of a further one", async () => {
  const res = await identitySet(
    {
      accountId: "1",
      create: { k1: { email: "alias@example.org", bcc: [{ name: "Archive", email: "archive@example.org" }] } },
      update: { "i-1": { bcc: [{ email: "me@example.org" }] } },
    },
    ctx,
  );
  const id = res.created!.k1!.id;
  expect(res.updated).toEqual({ "i-1": null });
  expect(await list()).toMatchObject([
    { id: "i-1", bcc: [{ name: null, email: "me@example.org" }] },
    { id, bcc: [{ name: "Archive", email: "archive@example.org" }] },
  ]);

  // Another property changes, the Bcc stays; null clears it.
  await identitySet({ accountId: "1", update: { "i-1": { name: "Jane Doe" }, [id]: { bcc: null } } }, ctx);
  expect(await list()).toMatchObject([
    { name: "Jane Doe", bcc: [{ name: null, email: "me@example.org" }] },
    { id, bcc: null },
  ]);

  const bad = await identitySet({ accountId: "1", update: { [id]: { bcc: "archive@example.org" }, "i-1": { bcc: [{ name: "x" }] } } }, ctx);
  expect(bad.notUpdated).toMatchObject({
    [id]: { type: "invalidProperties", properties: ["bcc"] },
    "i-1": { type: "invalidProperties", properties: ["bcc"] },
  });
});

it("adds the bcc column to a database that predates it", async () => {
  await identitySet({ accountId: "1", create: { k1: { email: "alias@example.org" } }, update: { "i-1": { name: "Jane Doe" } } }, ctx);
  store.db.exec(`ALTER TABLE identity_settings DROP COLUMN bcc; ALTER TABLE identity_extra DROP COLUMN bcc;`);
  store.db.close();

  store = new Store(dir);
  ctx = { account, store };
  expect(await list()).toMatchObject([
    { name: "Jane Doe", bcc: null },
    { email: "alias@example.org", bcc: null },
  ]);
  const res = await identitySet({ accountId: "1", update: { "i-1": { bcc: [{ email: "me@example.org" }] } } }, ctx);
  expect(res.updated).toEqual({ "i-1": null });
  expect((await list())[0]).toMatchObject({ bcc: [{ name: null, email: "me@example.org" }] });
});

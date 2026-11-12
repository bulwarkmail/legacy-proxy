// imapflow hands an ENVELOPE date it cannot parse back as the raw string, and
// a server can send any INTERNALDATE. One message with such a date, or one that
// can't be mapped for another reason, must not fail Email/get for the messages
// asked for together with it: its date becomes null (receivedAt falls back to
// now, as for a missing INTERNALDATE), and a message that still can't be
// mapped is left out so the caller reports it as notFound.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { dateMs, fetchEmailsBatch, isoDate } from "../../src/imap/fetcher.js";
import { Store } from "../../src/state/store.js";

const BODYSTRUCTURE = '("text" "plain" ("charset" "UTF-8") NIL NIL "7bit" 5 1 NIL NIL NIL NIL)';
const GOOD_DATE = '"Mon, 05 Oct 2026 19:03:15 +0200"';
const GOOD_INTERNALDATE = '"05-Oct-2026 19:03:15 +0200"';

interface FakeMessage {
  uid: number;
  subject: string;
  date?: string;
  internalDate?: string;
  noEnvelope?: boolean;
}

const fetchLine = (seq: number, m: FakeMessage) =>
  `* ${seq} FETCH (UID ${m.uid} FLAGS () RFC822.SIZE 100 INTERNALDATE ${m.internalDate ?? GOOD_INTERNALDATE}` +
  (m.noEnvelope ? "" : ` ENVELOPE (${m.date ?? GOOD_DATE} "${m.subject}" NIL NIL NIL NIL NIL NIL NIL "<m${m.uid}@example.org>")`) +
  ` BODYSTRUCTURE ${BODYSTRUCTURE}` +
  ` BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)] {2}\r\n\r\n)\r\n`;

function startServer(messages: FakeMessage[]): Promise<net.Server> {
  const srv = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd = "", ...rest] = line.split(" ");
        const c = cmd.toUpperCase();
        if (c === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
        else if (c === "SELECT" || c === "EXAMINE")
          sock.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 1] x\r\n* OK [UIDNEXT 99] x\r\n${tag} OK [READ-WRITE] x\r\n`);
        else if (c === "UID" && rest[0]?.toUpperCase() === "FETCH" && line.includes("BODYSTRUCTURE"))
          sock.write(messages.map((m, n) => fetchLine(n + 1, m)).join("") + `${tag} OK\r\n`);
        else if (c === "UID" && rest[0]?.toUpperCase() === "FETCH")
          // The flags-only FETCH for messages served from the cache.
          sock.write(messages.map((m, n) => `* ${n + 1} FETCH (UID ${m.uid} FLAGS ())\r\n`).join("") + `${tag} OK\r\n`);
        else if (c === "LOGOUT") {
          sock.write(`* BYE\r\n${tag} OK\r\n`);
          sock.end();
        } else sock.write(`${tag} OK\r\n`);
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

let server: net.Server | null = null;
let dir: string | null = null;
afterEach(() => {
  server?.close();
  server = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function fetchAll(messages: FakeMessage[], store?: Store, account = { id: 1 }, mailbox = { id: 2, uidvalidity: 1 }) {
  server ??= await startServer(messages);
  const client = new ImapFlow({
    host: "127.0.0.1",
    port: (server.address() as net.AddressInfo).port,
    secure: false,
    auth: { user: "u", pass: "p" },
    logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    return await fetchEmailsBatch(
      client,
      account as never,
      mailbox as never,
      messages.map((m) => m.uid),
      { wantsPreview: false },
      store,
    );
  } finally {
    lock.release();
    await client.logout();
  }
}

const get = (hostileDate: string) =>
  fetchAll([
    { uid: 7, subject: "Hello" },
    { uid: 8, subject: "Hostile", date: hostileDate },
  ]);

describe("a mail with a broken Date header does not break the folder", () => {
  for (const date of [
    '"yesterday-ish"',
    '"Tue, 31 Feb 2026 25:61:61 +9999"',
    '"Mon, 1 Jan 300000 00:00:00 +0000"',
    '"Mon, 1 Jan 275761 00:00:00 +0000"',
    '""',
    "12345",
  ]) {
    it(`still returns both messages for ENVELOPE date ${date}`, async () => {
      const got = await get(date);
      expect(got.get(7)?.subject).toBe("Hello");
      expect(got.get(7)?.sentAt).toBe("2026-10-05T17:03:15.000Z");
      expect(got.get(8)?.subject).toBe("Hostile");
      expect(got.get(8)?.sentAt ?? null).toBeNull();
    });
  }

  it("returns all five messages when two of them have broken dates", async () => {
    const got = await fetchAll([
      { uid: 1, subject: "one" },
      { uid: 2, subject: "two", date: '"yesterday-ish"' },
      { uid: 3, subject: "three" },
      { uid: 4, subject: "four", date: '"Mon, 1 Jan 300000 00:00:00 +0000"' },
      { uid: 5, subject: "five" },
    ]);
    expect([...got.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([1, 3, 5].map((uid) => got.get(uid)?.sentAt)).toEqual(Array(3).fill("2026-10-05T17:03:15.000Z"));
    expect([2, 4].map((uid) => got.get(uid)?.sentAt)).toEqual([null, null]);
  });

  it("gives a message with an unreadable INTERNALDATE a valid receivedAt", async () => {
    const got = await fetchAll([
      { uid: 7, subject: "Hello" },
      { uid: 8, subject: "Odd", internalDate: '"not a date at all"' },
    ]);
    expect(got.get(7)?.receivedAt).toBe("2026-10-05T17:03:15.000Z");
    expect(got.get(8)?.subject).toBe("Odd");
    expect(Number.isNaN(Date.parse(got.get(8)!.receivedAt))).toBe(false);
  });

  it("leaves out a message without an envelope and returns the rest", async () => {
    const got = await fetchAll([
      { uid: 7, subject: "Hello" },
      { uid: 8, subject: "Bare", noEnvelope: true },
    ]);
    expect(got.get(7)?.subject).toBe("Hello");
    expect(got.has(8)).toBe(false);
  });

  it("leaves out a message that can't be mapped for another reason and returns the rest", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-fetch-"));
    const store = new Store(dir);
    try {
      const account = store.upsertAccount({ slug: "generic:u", kind: "generic", host: "h", username: "u", vault: Buffer.from("x") });
      const { id: mailboxId } = store.db
        .prepare(`INSERT INTO mailbox(account_id, name) VALUES(?, 'INBOX') RETURNING id`)
        .get(account.id) as { id: number };
      const mailbox = { id: mailboxId, uidvalidity: 1 };
      const messages = [
        { uid: 7, subject: "Hello" },
        { uid: 8, subject: "Mangled" },
      ];
      // The first read fills the cache; then one cached envelope is damaged.
      expect([...(await fetchAll(messages, store, account, mailbox)).keys()].sort()).toEqual([7, 8]);
      store.db
        .prepare(`UPDATE email_cache SET envelope = ? WHERE account_id = ? AND uid = 8`)
        .run(JSON.stringify({ subject: "Mangled", from: "not a list" }), account.id);

      const got = await fetchAll(messages, store, account, mailbox);
      expect(got.get(7)?.subject).toBe("Hello");
      expect(got.has(8)).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("dateMs and isoDate", () => {
  it.each([
    [new Date("2026-10-05T17:03:15Z"), "2026-10-05T17:03:15.000Z"],
    ["Mon, 05 Oct 2026 19:03:15 +0200", "2026-10-05T17:03:15.000Z"],
    [0, "1970-01-01T00:00:00.000Z"],
    ["0000-01-01T00:00:00Z", "0000-01-01T00:00:00.000Z"],
    ["9999-12-31T23:59:59.999Z", "9999-12-31T23:59:59.999Z"],
  ])("reads %j", (v, iso) => {
    expect(isoDate(v)).toBe(iso);
    expect(dateMs(v)).toBe(Date.parse(iso));
  });

  it.each([
    "yesterday-ish",
    "",
    "12345",
    "Mon, 1 Jan 275761 00:00:00 +0000",
    new Date(NaN),
    8.65e15,
    -1e17,
    NaN,
    null,
    undefined,
    {},
  ])("gives null for %j", (v) => {
    expect(dateMs(v)).toBeNull();
    expect(isoDate(v)).toBeNull();
  });
});

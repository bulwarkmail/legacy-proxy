// Parsing a mail must cost time in proportion to its size. Email/parse runs
// mailparser on an upload, and EmailSubmission/set does when it derives the
// envelope from the headers; both run on the one thread that serves every
// user. The cost checks compare two sizes instead of a stopwatch: four times
// the body may cost at most five times the time, plus a fixed allowance for
// noise. A scan that is quadratic in the size costs sixteen times.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImapFlow } from "imapflow";
import { Store, type AccountRow } from "../../src/state/store.js";
import { sealCredentials } from "../../src/auth/credentials.js";
import { emailParse } from "../../src/jmap/methods/email.js";
import { emailSubmissionSet } from "../../src/jmap/methods/submission.js";
import { encodeEmailId } from "../../src/mapping/ids.js";
import type { AppConfig } from "../../src/util/config.js";

let dir: string;
let store: Store;
let account: AccountRow;
let cfg: AppConfig;
let draftId: string;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-parse-"));
  store = new Store(dir);
  const vaultKey = crypto.randomBytes(32);
  cfg = {
    vaultKey,
    defaultProvider: "generic",
    providers: {
      generic: {
        imap: { host: "imap.test", port: 993 },
        smtp: { host: "127.0.0.1", port: 9, secure: false },
        sieve: null,
        carddav: null,
        auth: { mech: ["PLAIN"] },
      },
    },
  } as unknown as AppConfig;
  account = store.upsertAccount({
    slug: "generic:u",
    kind: "generic",
    host: "h",
    username: "u",
    vault: await sealCredentials(vaultKey, { mech: "PLAIN", username: "u", password: "fake-password" }),
  });
  const row = store.db
    .prepare(`INSERT INTO mailbox(account_id, name) VALUES(?, 'Drafts') RETURNING id`)
    .get(account.id) as { id: number };
  draftId = encodeEmailId({ accountIdx: account.id, mailboxIdx: row.id, uidvalidity: 1, uid: 1 });
});
afterAll(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const SMALL = 40_000;
const NOISE_MS = 300;
let serial = 0;

type Parsed = {
  textBody: { partId: string }[] | null;
  htmlBody: { partId: string }[] | null;
  bodyValues: Record<string, { value: string }> | null;
};

async function parseRaw(raw: Buffer): Promise<Parsed> {
  const id = `Uparse${++serial}`;
  store.putUpload({ id, accountId: account.id, ctype: "message/rfc822", body: raw });
  const res = await emailParse({ accountId: String(account.id), blobIds: [id] }, { account, store });
  expect(Object.keys(res.parsed ?? {}), "the mail was parsed").toEqual([id]);
  return (res.parsed as unknown as Record<string, Parsed>)[id]!;
}

/** Parses a text mail whose body is `unit` repeated to `bytes`; answers the time and the parsed text. */
async function parse(unit: string, bytes: number): Promise<{ ms: number; text: string }> {
  const body = Buffer.from(`From: a@b.example\r\nSubject: x\r\nContent-Type: text/plain\r\n\r\n${unit.repeat(Math.floor(bytes / unit.length))}\r\n`);
  const started = performance.now();
  const parsed = await parseRaw(body);
  const ms = performance.now() - started;
  const values = Object.values(parsed.bodyValues ?? {});
  return { ms, text: values.map((v) => v.value).join("") };
}

const UNITS = [
  ["'mailto:' repeated", "mailto:"],
  ["'http://' repeated", "http://"],
  ["'@' repeated", "@"],
  ["'www.' repeated", "www."],
] as const;

describe("Email/parse costs time in proportion to the mail", () => {
  for (const [what, unit] of UNITS) {
    it(`four times as much of ${what} does not cost sixteen times as long`, async () => {
      // Once to warm up, so module loading is not counted against the small size.
      await parse(unit, 1_000);
      const small = await parse(unit, SMALL);
      const large = await parse(unit, SMALL * 4);
      expect(small.text.startsWith(unit), "the text body is still returned").toBe(true);
      expect(large.ms, `${SMALL} bytes took ${Math.round(small.ms)} ms, ${SMALL * 4} bytes took ${Math.round(large.ms)} ms`).toBeLessThan(small.ms * 5 + NOISE_MS);
    }, 180_000);
  }
});

describe("Email/parse still returns the bodies", () => {
  it("returns 5 MB of ordinary prose as the text body", async () => {
    const sentence = "The committee met on Tuesday and agreed to publish the minutes next week.\r\n";
    const prose = sentence.repeat(Math.ceil(5_000_000 / sentence.length));
    const parsed = await parseRaw(Buffer.from(`From: a@b.example\r\nSubject: minutes\r\nContent-Type: text/plain\r\n\r\n${prose}`));
    expect(parsed.textBody).toEqual([{ partId: "1", type: "text/plain" }]);
    expect(parsed.htmlBody).toBeNull();
    const text = parsed.bodyValues?.["1"]?.value ?? "";
    expect(text.length).toBeGreaterThan(4_900_000);
    expect(text.startsWith("The committee met on Tuesday")).toBe(true);
  }, 60_000);

  it("returns the HTML of an HTML-only mail", async () => {
    const html = '<p>Hello <a href="https://example.com/">there</a></p>';
    const parsed = await parseRaw(Buffer.from(`From: a@b.example\r\nSubject: x\r\nContent-Type: text/html\r\n\r\n${html}\r\n`));
    expect(parsed.htmlBody).toEqual([{ partId: "2", type: "text/html" }]);
    expect(parsed.bodyValues?.["2"]?.value).toContain(html);
  });

  it("returns both bodies of a multipart/alternative mail", async () => {
    const raw = [
      "From: a@b.example",
      "Subject: x",
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Plain see https://example.com/",
      "--b",
      "Content-Type: text/html",
      "",
      "<p>Rich</p>",
      "--b--",
      "",
    ].join("\r\n");
    const parsed = await parseRaw(Buffer.from(raw));
    expect(parsed.bodyValues?.["1"]?.value).toContain("Plain see https://example.com/");
    expect(parsed.bodyValues?.["2"]?.value).toContain("<p>Rich</p>");
  });
});

describe("deriving the envelope costs time in proportion to the mail", () => {
  // Just enough of ImapFlow for fetchRfc822(): hand back the stored draft.
  let draft = Buffer.alloc(0);
  const client = {
    getMailboxLock: async () => ({ release: () => {} }),
    fetchOne: async () => ({ source: draft }),
  } as unknown as ImapFlow;

  // The draft has no recipients, so the submission stops right after the parse
  // and no SMTP connection is made.
  async function derive(unit: string, bytes: number): Promise<number> {
    draft = Buffer.from(`From: a@b.example\r\nSubject: x\r\nContent-Type: text/plain\r\n\r\n${unit.repeat(Math.floor(bytes / unit.length))}\r\n`);
    const started = performance.now();
    const res = await emailSubmissionSet(
      { accountId: String(account.id), create: { s: { emailId: draftId } } },
      { cfg, account, client, store },
    );
    const ms = performance.now() - started;
    expect(res.notCreated?.s?.type).toBe("noRecipients");
    return ms;
  }

  for (const [what, unit] of UNITS) {
    it(`four times as much of ${what} does not cost sixteen times as long`, async () => {
      await derive(unit, 1_000);
      const small = await derive(unit, SMALL);
      const large = await derive(unit, SMALL * 4);
      expect(large, `${SMALL} bytes took ${Math.round(small)} ms, ${SMALL * 4} bytes took ${Math.round(large)} ms`).toBeLessThan(small * 5 + NOISE_MS);
    }, 180_000);
  }
});

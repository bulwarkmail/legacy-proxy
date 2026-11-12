// EmailSubmission/set hands the envelope to nodemailer, which parses every
// address string again. These tests check that the SMTP server only ever gets
// the addresses the EmailSubmission reports, one per envelope entry, and that
// an address that is not plain is refused before anything is sent, on both
// the client envelope and the one derived from the headers.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Store, type AccountRow } from "../../src/state/store.js";
import { sealCredentials } from "../../src/auth/credentials.js";
import { emailSubmissionGet, emailSubmissionSet, isPlainAddress } from "../../src/jmap/methods/submission.js";
import { encodeEmailId } from "../../src/mapping/ids.js";
import { buildRfc822 } from "../../src/mapping/buildMime.js";
import type { AppConfig } from "../../src/util/config.js";

const smtpLines: string[] = [];
/** The message each DATA command carried, as it reached the server. */
const smtpData: string[] = [];
let smtp: net.Server;
let dir: string;
let store: Store;
let account: AccountRow;
let cfg: AppConfig;
let emailId: string;
let draft = Buffer.alloc(0);

beforeAll(async () => {
  smtp = net.createServer((sock) => {
    let buf = "";
    let data = false;
    sock.on("error", () => {});
    sock.write("220 test ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      for (;;) {
        if (data) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          smtpData.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          data = false;
          sock.write("250 queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        smtpLines.push(line);
        const cmd = line.split(" ")[0]!.toUpperCase();
        if (cmd === "EHLO") sock.write("250-test\r\n250-SMTPUTF8\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (cmd === "AUTH") sock.write("235 ok\r\n");
        else if (cmd === "DATA") {
          data = true;
          sock.write("354 go\r\n");
        } else if (cmd === "QUIT") {
          sock.write("221 bye\r\n");
          sock.end();
        } else sock.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  const port = (smtp.address() as net.AddressInfo).port;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-rcpt-"));
  store = new Store(dir);
  const vaultKey = crypto.randomBytes(32);
  cfg = {
    vaultKey,
    defaultProvider: "generic",
    providers: {
      generic: {
        imap: { host: "imap.test", port: 993 },
        smtp: { host: "127.0.0.1", port, secure: false },
        sieve: null,
        carddav: null,
        auth: { mech: ["PLAIN"] },
      },
    },
  } as unknown as AppConfig;
  account = store.upsertAccount({
    slug: "generic:alice@corp.example",
    kind: "generic",
    host: "imap.test",
    username: "alice@corp.example",
    vault: await sealCredentials(vaultKey, { mech: "PLAIN", username: "alice@corp.example", password: "fake-password" }),
  });
  const row = store.db
    .prepare(`INSERT INTO mailbox(account_id, name) VALUES(?, 'Drafts') RETURNING id`)
    .get(account.id) as { id: number };
  emailId = encodeEmailId({ accountIdx: account.id, mailboxIdx: row.id, uidvalidity: 1, uid: 1 });
});
beforeEach(() => {
  smtpLines.length = 0;
  smtpData.length = 0;
});
afterAll(async () => {
  await new Promise<void>((r) => smtp.close(() => r()));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Just enough of ImapFlow for fetchRfc822(): hand back the stored draft.
const client = {
  getMailboxLock: async () => ({ release: () => {} }),
  fetchOne: async () => ({ source: draft }),
} as unknown as ImapFlow;

const CONFUSING = '"attacker@evil.example x"@corp.example';
const rcpts = () => smtpLines.filter((l) => /^RCPT TO:/i.test(l));
const mailFroms = () => smtpLines.filter((l) => /^MAIL FROM:/i.test(l));
const send = (envelope?: Record<string, unknown>) =>
  emailSubmissionSet(
    { accountId: String(account.id), create: { s: { emailId, ...(envelope ? { envelope } : {}) } } },
    { cfg, account, client, store },
  );
const mail = (headers: string) => Buffer.from(`${headers}\r\nSubject: x\r\n\r\nhi\r\n`);

describe("a recipient is delivered to the address the user was shown", () => {
  it("derived envelope: a To header at corp.example is not sent to evil.example", async () => {
    draft = Buffer.from(
      `From: alice@corp.example\r\nTo: ${CONFUSING}\r\nSubject: quarterly numbers\r\nMessage-ID: <1@corp.example>\r\n\r\nconfidential\r\n`,
    );
    await emailSubmissionSet({ accountId: String(account.id), create: { s: { emailId } } }, { cfg, account, client, store });
    expect(rcpts()).not.toContain("RCPT TO:<attacker@evil.example>");
  });

  it("client envelope: the same address in rcptTo is not sent to evil.example", async () => {
    draft = Buffer.from(`From: alice@corp.example\r\nTo: ${CONFUSING}\r\nSubject: x\r\n\r\nconfidential\r\n`);
    await emailSubmissionSet(
      {
        accountId: String(account.id),
        create: { s: { emailId, envelope: { mailFrom: { email: "alice@corp.example" }, rcptTo: [{ email: CONFUSING }] } } },
      },
      { cfg, account, client, store },
    );
    expect(rcpts()).not.toContain("RCPT TO:<attacker@evil.example>");
  });

  it("client envelope: one rcptTo entry is one recipient", async () => {
    draft = Buffer.from(`From: alice@corp.example\r\nTo: bob@corp.example\r\nSubject: x\r\n\r\nhi\r\n`);
    const res = await emailSubmissionSet(
      {
        accountId: String(account.id),
        create: {
          s: { emailId, envelope: { mailFrom: { email: "alice@corp.example" }, rcptTo: [{ email: "bob@corp.example,hidden@evil.example" }] } },
        },
      },
      { cfg, account, client, store },
    );
    expect(rcpts()).not.toContain("RCPT TO:<hidden@evil.example>");
    // Whatever was sent must be what the EmailSubmission object reports.
    const reported = (res.created?.s?.envelope.rcptTo ?? []).map((r) => `RCPT TO:<${r.email}>`);
    expect(rcpts()).toEqual(reported);
  });

  it("refuses an address that is not plain with invalidRecipients naming it, and sends nothing", async () => {
    draft = mail(`From: alice@corp.example\r\nTo: bob@corp.example, ${CONFUSING}`);
    const derived = await send();
    expect(derived.created).toBeNull();
    // Named as the message wrote it, whichever mail library version is installed.
    expect(derived.notCreated?.s).toMatchObject({ type: "invalidRecipients", invalidRecipients: [CONFUSING] });

    const given = await send({
      mailFrom: { email: "alice@corp.example" },
      rcptTo: [{ email: "bob@corp.example" }, { email: "bob@corp.example;carol@corp.example" }, { email: "" }],
    });
    expect(given.notCreated?.s).toMatchObject({
      type: "invalidRecipients",
      invalidRecipients: ["bob@corp.example;carol@corp.example", ""],
    });
    expect(smtpLines).toEqual([]);
  });

  it("holds the sender to the same rule", async () => {
    draft = mail(`From: ${CONFUSING}\r\nTo: bob@corp.example`);
    const derived = await send();
    expect(derived.notCreated?.s?.type).toBe("forbiddenMailFrom");

    draft = mail(`From: alice@corp.example\r\nTo: bob@corp.example`);
    const given = await send({ mailFrom: { email: "<attacker@evil.example>" }, rcptTo: [{ email: "bob@corp.example" }] });
    expect(given.notCreated?.s?.type).toBe("forbiddenMailFrom");
    expect(smtpLines).toEqual([]);
  });

  it("accepts a display name with a comma; the address inside is plain", async () => {
    draft = mail(`From: alice@corp.example\r\nTo: "Doe, Jane" <jane@corp.example>`);
    const res = await send();
    expect(res.created?.s?.envelope.rcptTo).toEqual([{ email: "jane@corp.example" }]);
    expect(rcpts()).toEqual(["RCPT TO:<jane@corp.example>"]);
  });

  it("accepts an internationalised domain and a local part with + and .", async () => {
    draft = mail(`From: alice@corp.example\r\nTo: first.last+tag@corp.example, jörg@bücher.example`);
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(res.created?.s?.envelope.rcptTo).toEqual([{ email: "first.last+tag@corp.example" }, { email: "jörg@bücher.example" }]);
    expect(rcpts()).toHaveLength(2);
    expect(rcpts()[0]).toBe("RCPT TO:<first.last+tag@corp.example>");
  });

  it("sends to each member of a group in a header", async () => {
    draft = mail(`From: alice@corp.example\r\nTo: Team: a@corp.example, b@corp.example;\r\nCc: undisclosed-recipients:;`);
    const res = await send();
    expect(res.created?.s?.envelope.rcptTo).toEqual([{ email: "a@corp.example" }, { email: "b@corp.example" }]);
    expect(rcpts()).toEqual(["RCPT TO:<a@corp.example>", "RCPT TO:<b@corp.example>"]);
  });

  it("refuses a mail without recipients", async () => {
    draft = mail(`From: alice@corp.example`);
    const res = await send();
    expect(res.notCreated?.s?.type).toBe("noRecipients");
    expect(smtpLines).toEqual([]);
  });
});

describe("the envelope derived from the headers", () => {
  it.each([
    ['"Doe, Jane" <jane@corp.example>', ["jane@corp.example"]],
    ['"a@evil.example" <b@corp.example>', ["b@corp.example"]],
    ['"a" b <c@corp.example>', ["c@corp.example"]],
    ["Jane Doe <jane@corp.example>", ["jane@corp.example"]],
    ["Jane Doe < jane@corp.example >", ["jane@corp.example"]],
    ["jane@corp.example (Jane)", ["jane@corp.example"]],
    ["(Jane) jane@corp.example", ["jane@corp.example"]],
    ["=?utf-8?Q?J=C3=B6rg_M=C3=BCller?= <joerg@corp.example>", ["joerg@corp.example"]],
    ["Team: a@corp.example, b@corp.example;", ["a@corp.example", "b@corp.example"]],
    ["a@corp.example,,b@corp.example,", ["a@corp.example", "b@corp.example"]],
    ["a@[192.0.2.1]", ["a@[192.0.2.1]"]],
  ])("sends To: %s to %j", async (to, expected) => {
    draft = mail(`From: alice@corp.example\r\nTo: ${to}`);
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(res.created?.s?.envelope.rcptTo.map((r) => r.email)).toEqual(expected);
    expect(rcpts()).toEqual(expected.map((a) => `RCPT TO:<${a}>`));
  });

  it.each([
    ['"attacker@evil.example x"@corp.example', '"attacker@evil.example x"@corp.example'],
    ['"<attacker@evil.example>"@corp.example', '"<attacker@evil.example>"@corp.example'],
    ['"jane"@corp.example', '"jane"@corp.example'],
    ['a"b"@corp.example', 'a"b"@corp.example'],
    ["attacker@evil.example x@corp.example", "attacker@evil.example x@corp.example"],
    ["<attacker@evil.example>@corp.example", "<attacker@evil.example>@corp.example"],
    ["Jane Doe jane@corp.example", "Jane Doe jane@corp.example"],
    ["jane @ corp.example", "jane @ corp.example"],
    ["jane(x)@corp.example", "jane(x)@corp.example"],
    ["<a@corp.example> b@evil.example", "<a@corp.example> b@evil.example"],
    ["a@corp.example <b@evil.example>", "a@corp.example <b@evil.example>"],
    ["<a@corp.example> <b@evil.example>", "<a@corp.example> <b@evil.example>"],
    ["<@route.example:a@corp.example>", "<@route.example:a@corp.example>"],
    ['"a b" <"c d"@corp.example>', '"c d"@corp.example'],
    ["=?utf-8?Q?a=40evil.example?=", "=?utf-8?Q?a=40evil.example?="],
    ["a@corp.example;b@evil.example", "a@corp.example;b@evil.example"],
    ["Team: a@corp.example", "Team: a@corp.example"],
    ["John", "John"],
    ["<a@corp.example", "<a@corp.example"],
    ["a@corp.example>", "a@corp.example>"],
    ["a@corp.example\r\n\tb@evil.example", "a@corp.example\tb@evil.example"],
  ])("refuses To: %j, naming %j, and sends nothing", async (to, named) => {
    draft = mail(`From: alice@corp.example\r\nTo: ok@corp.example, ${to}`);
    const res = await send();
    expect(res.created).toBeNull();
    expect(res.notCreated?.s).toMatchObject({ type: "invalidRecipients", invalidRecipients: [named] });
    expect(smtpLines).toEqual([]);
  });

  it("reads every To, Cc and Bcc header, unfolded, and nothing from the body", async () => {
    draft = Buffer.from(
      "From: Alice <alice@corp.example>\r\nTo: a@corp.example,\r\n b@corp.example\r\nX-To: x@evil.example\r\n" +
        "Cc: c@corp.example\r\nTo: d@corp.example\r\nBcc: e@corp.example\r\n\r\nTo: body@evil.example\r\n",
    );
    const res = await send();
    expect(res.created?.s?.envelope).toEqual({
      mailFrom: { email: "alice@corp.example" },
      rcptTo: ["a", "b", "d", "c", "e"].map((l) => ({ email: `${l}@corp.example` })),
    });
    expect(mailFroms()).toEqual(["MAIL FROM:<alice@corp.example>"]);
  });

  it("refuses a From that isn't one plain mailbox", async () => {
    for (const from of ["Jane Doe jane@corp.example", "a@corp.example <b@evil.example>", '"x y"@corp.example']) {
      draft = mail(`From: ${from}\r\nTo: bob@corp.example`);
      const res = await send();
      expect(res.notCreated?.s?.type, from).toBe("forbiddenMailFrom");
    }
    expect(smtpLines).toEqual([]);
  });
});

describe("a message built from JSON addresses and sent without an envelope", () => {
  type Addr = { name?: string; email: string };
  // The draft Email/set create makes from the client's JSON addresses.
  const jsonDraft = (to: Addr[]) =>
    buildRfc822(
      {
        from: [{ name: "Alice", email: "alice@corp.example" }],
        to,
        subject: "s",
        bodyValues: { "1": { value: "hi" } },
        textBody: [{ partId: "1" }],
      },
      "corp.example",
    );
  const sent = () => rcpts().map((l) => l.replace(/^RCPT TO:<(.*?)>.*$/i, "$1"));

  it.each<[string, Addr, string]>([
    ["quoted local part holding an address", { email: '"attacker@evil.example x"@corp.example' }, "attacker@evil.example"],
    ["angle brackets in the local part", { email: "<attacker@evil.example>@corp.example" }, "attacker@evil.example"],
    ["space in the local part", { email: "john smith@corp.example" }, "smith@corp.example"],
    ["a name and an address in the email field", { email: "a@corp.example <b@evil.example>" }, "b@evil.example"],
  ])("%s: is sent to that address or refused, never to another mailbox", async (_label, addr, elsewhere) => {
    try {
      draft = await jsonDraft([addr]);
    } catch {
      return; // refused at Email/set: fine
    }
    const res = await send();
    expect(sent(), `To header written: ${String(draft).split(/\r?\n/).find((l) => /^To:/i.test(l))}`).not.toContain(elsewhere);
    if (!res.notCreated) expect(sent()).toEqual([addr.email]);
  });

  it.each<[string, Addr[], string[]]>([
    ["a name with a comma", [{ name: "Doe, Jane", email: "jane@corp.example" }], ["jane@corp.example"]],
    ["non-ASCII names with an @ and an emoji", [{ name: "Jörg @ Work", email: "joerg@corp.example" }, { name: "Team 🚀", email: "ops@corp.example" }], ["joerg@corp.example", "ops@corp.example"]],
    ["a name that looks like an encoded address", [{ name: "=?utf-8?Q?a=40evil.example?=", email: "b@corp.example" }], ["b@corp.example"]],
    ["an internationalised domain", [{ email: "bob@bücher.example" }], ["bob@xn--bcher-kva.example"]],
  ])("%s: is sent to exactly the addresses given", async (_label, to, expected) => {
    draft = await jsonDraft(to);
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(sent()).toEqual(expected);
  });
});

describe("a header the envelope reads is one a reader and the Bcc stripping read too", () => {
  /** What a reader shows as recipients: mailparser over the stored message. */
  async function readerRecipients(raw: Buffer): Promise<string[]> {
    const m = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
    const out: string[] = [];
    type A = { address?: string; group?: A[] };
    const walk = (v: A[]) => {
      for (const a of v) {
        if (a.address) out.push(a.address.toLowerCase());
        if (Array.isArray(a.group)) walk(a.group);
      }
    };
    for (const f of [m.to, m.cc, m.bcc]) {
      if (!f) continue;
      for (const x of Array.isArray(f) ? f : [f]) walk(x.value as A[]);
    }
    return out;
  }
  const sent = () => rcpts().map((l) => l.replace(/^RCPT TO:<(.*?)>.*$/i, "$1").toLowerCase());

  it.each<[string, string]>([
    ["bare CR before a Bcc line", "From: alice@corp.example\r\nTo: bob@corp.example\r\nSubject: hi\rBcc: hidden@evil.example\r\n\r\nbody\r\n"],
    ["LF CR LF ends the header block", "From: alice@corp.example\r\nTo: bob@corp.example\n\r\nBcc: hidden@evil.example\r\n\r\nbody\r\n"],
  ])("%s", async (_label, raw) => {
    draft = Buffer.from(raw);
    const res = await send();
    if (res.notCreated) return; // refusing such a header block is fine
    const shown = await readerRecipients(draft);
    for (const s of sent()) expect(shown, `sent ${s}, reader shows ${JSON.stringify(shown)}`).toContain(s);
    if (sent().includes("hidden@evil.example")) expect(smtpData.join("\n")).not.toContain("hidden@evil.example");
  });

  it.each<[string, string]>([
    ["a bare CR in the Subject", "From: alice@corp.example\r\nTo: bob@corp.example\r\nSubject: a\rb\r\n\r\nbody\r\n"],
    ["CRLF and LF lines mixed", "From: alice@corp.example\r\nTo: bob@corp.example\nSubject: x\r\n\r\nbody\r\n"],
    ["a line of only spaces before a Bcc", "From: alice@corp.example\r\nTo: bob@corp.example\r\n   \r\nBcc: hidden@evil.example\r\n\r\nbody\r\n"],
    ["a line that is neither a field nor a continuation", "From: alice@corp.example\r\nTo: bob@corp.example\r\nnot a header\r\nBcc: hidden@evil.example\r\n\r\nbody\r\n"],
  ])("refuses a header block with %s, also with a client envelope, and sends nothing", async (_label, raw) => {
    draft = Buffer.from(raw);
    expect((await send()).notCreated?.s?.type).toBe("invalidEmail");
    const withEnvelope = await send({ mailFrom: { email: "alice@corp.example" }, rcptTo: [{ email: "bob@corp.example" }] });
    expect(withEnvelope.notCreated?.s?.type).toBe("invalidEmail");
    expect(smtpLines).toEqual([]);
  });

  it("sends a message whose lines all end in LF to the same recipients, without its Bcc on the wire", async () => {
    draft = Buffer.from("From: alice@corp.example\nTo: bob@corp.example\nBcc: carol@corp.example,\n dave@corp.example\nSubject: unix\n\nbody\nBcc: not-a-header@corp.example\n");
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(sent()).toEqual(["bob@corp.example", "carol@corp.example", "dave@corp.example"]);
    const wire = smtpData.join("\n");
    const head = wire.slice(0, wire.indexOf("\r\n\r\n"));
    expect(head).not.toMatch(/^Bcc:/im);
    expect(wire).not.toContain("dave@corp.example");
    expect(head).toMatch(/^To: bob@corp\.example$/m);
    expect(wire.slice(head.length)).toContain("Bcc: not-a-header@corp.example");
  });

  it("leaves a bare CR in the body alone", async () => {
    draft = Buffer.from("From: alice@corp.example\r\nTo: bob@corp.example\r\nSubject: x\r\n\r\nline\rwith CR\r\n");
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(sent()).toEqual(["bob@corp.example"]);
  });
});

describe("a draft saved while a recipient was still being typed", () => {
  const save = (to: { name?: string; email: string }[]) =>
    buildRfc822(
      { from: [{ name: "Alice", email: "alice@corp.example" }], to, subject: "s", bodyValues: { "1": { value: "hi" } }, textBody: [{ partId: "1" }] },
      "corp.example",
    );

  it("is refused when sent without an envelope, naming the text", async () => {
    draft = await save([{ email: "carol@corp.example" }, { email: "bob" }]);
    expect((await send()).notCreated?.s).toMatchObject({ type: "invalidRecipients", invalidRecipients: ["bob"] });
    draft = await save([{ email: "Bob Smith" }]);
    expect((await send()).notCreated?.s).toMatchObject({ type: "invalidRecipients", invalidRecipients: ["<Bob Smith>"] });
    expect(smtpLines).toEqual([]);
  });

  it("is refused when the client's envelope lists every recipient, as the webmail's does", async () => {
    draft = await save([{ email: "carol@corp.example" }, { email: "bob" }]);
    const res = await send({ mailFrom: { email: "alice@corp.example" }, rcptTo: [{ email: "carol@corp.example" }, { email: "bob" }] });
    expect(res.notCreated?.s).toMatchObject({ type: "invalidRecipients", invalidRecipients: ["bob"] });
    expect(smtpLines).toEqual([]);
  });

  it("goes only to the client's envelope when that leaves the text out", async () => {
    draft = await save([{ email: "carol@corp.example" }, { email: "bob" }]);
    const res = await send({ mailFrom: { email: "alice@corp.example" }, rcptTo: [{ email: "carol@corp.example" }] });
    expect(res.notCreated).toBeNull();
    expect(rcpts()).toEqual(["RCPT TO:<carol@corp.example>"]);
  });
});

describe("a refusal names what was refused", () => {
  it("lists the refused header entries in invalidRecipients and in the description", async () => {
    draft = mail(`From: alice@corp.example\r\nTo: ok@corp.example, ${CONFUSING}, John`);
    const err = (await send()).notCreated?.s;
    expect(err).toMatchObject({ type: "invalidRecipients", invalidRecipients: [CONFUSING, "John"] });
    expect(err?.description).toContain(JSON.stringify(CONFUSING));
    expect(err?.description).toContain('"John"');
    expect(err?.description).not.toContain("ok@corp.example");
  });

  it("names client envelope entries as given, spaces included", async () => {
    draft = mail(`From: alice@corp.example\r\nTo: bob@corp.example`);
    const err = (await send({ mailFrom: { email: "alice@corp.example" }, rcptTo: [{ email: " bob@corp.example " }, { email: " bob smith@corp.example" }] }))
      .notCreated?.s;
    expect(err).toMatchObject({ type: "invalidRecipients", invalidRecipients: [" bob smith@corp.example"] });
    expect(err?.description).toContain('" bob smith@corp.example"');
  });

  it("names the refused sender, from the envelope or from the header", async () => {
    draft = mail(`From: alice@corp.example\r\nTo: bob@corp.example`);
    const given = (await send({ mailFrom: { email: "<attacker@evil.example>" }, rcptTo: [{ email: "bob@corp.example" }] })).notCreated?.s;
    expect(given).toMatchObject({ type: "forbiddenMailFrom", mailFrom: "<attacker@evil.example>" });
    expect(given?.description).toContain('"<attacker@evil.example>"');

    draft = mail(`From: Jane Doe jane@corp.example\r\nTo: bob@corp.example`);
    const derived = (await send()).notCreated?.s;
    expect(derived).toMatchObject({ type: "forbiddenMailFrom", mailFrom: "Jane Doe jane@corp.example" });
    expect(derived?.description).toContain('"Jane Doe jane@corp.example"');
    expect(smtpLines).toEqual([]);
  });

  it("keeps the description short for many refused entries", async () => {
    const bad = Array.from({ length: 15 }, (_, i) => ({ email: `user ${i}@corp.example` }));
    draft = mail(`From: alice@corp.example\r\nTo: bob@corp.example`);
    const err = (await send({ mailFrom: { email: "alice@corp.example" }, rcptTo: bad })).notCreated?.s;
    expect(err?.invalidRecipients).toHaveLength(15);
    expect(err?.description).toContain('"user 9@corp.example" and 5 more');
    expect(err?.description).not.toContain("user 10@");
  });
});

describe("the client envelope and the sender", () => {
  beforeEach(() => {
    draft = mail(`From: alice@corp.example\r\nTo: bob@corp.example`);
  });

  it.each<[string, unknown, string]>([
    ["only rcptTo", { rcptTo: [{ email: "carol@corp.example" }] }, "invalidProperties"],
    ["only mailFrom", { mailFrom: { email: "alice@corp.example" } }, "invalidProperties"],
    ["mailFrom without an email", { mailFrom: {}, rcptTo: [{ email: "carol@corp.example" }] }, "invalidProperties"],
    ["an envelope that isn't an object", "alice@corp.example", "invalidProperties"],
    ["an empty rcptTo", { mailFrom: { email: "alice@corp.example" }, rcptTo: [] }, "noRecipients"],
  ])("refuses a client envelope with %s and sends nothing", async (_label, envelope, type) => {
    const err = (await send(envelope as Record<string, unknown>)).notCreated?.s;
    expect(err?.type).toBe(type);
    if (type === "invalidProperties") expect(err?.properties).toEqual(["envelope"]);
    expect(smtpLines).toEqual([]);
  });

  it("takes MAIL FROM from the Sender header when there is one", async () => {
    draft = mail(`From: Alice <alice@corp.example>\r\nSender: Desk <desk@corp.example>\r\nTo: bob@corp.example`);
    const res = await send();
    expect(res.created?.s?.envelope.mailFrom).toEqual({ email: "desk@corp.example" });
    expect(mailFroms()).toEqual(["MAIL FROM:<desk@corp.example>"]);
  });

  it("takes MAIL FROM from Sender when From names several authors", async () => {
    draft = mail(`From: alice@corp.example, carol@corp.example\r\nSender: alice@corp.example\r\nTo: bob@corp.example`);
    expect((await send()).created?.s?.envelope.mailFrom).toEqual({ email: "alice@corp.example" });
  });

  it.each([
    ["two From fields", "From: alice@corp.example\r\nFrom: mallory@corp.example\r\nTo: bob@corp.example"],
    ["two addresses in From and no Sender", "From: alice@corp.example, mallory@corp.example\r\nTo: bob@corp.example"],
    ["two Sender fields", "From: alice@corp.example\r\nSender: a@corp.example\r\nSender: b@corp.example\r\nTo: bob@corp.example"],
  ])("refuses a message with %s", async (_label, headers) => {
    draft = mail(headers);
    expect((await send()).notCreated?.s?.type).toBe("invalidEmail");
    expect(smtpLines).toEqual([]);
  });
});

describe("EmailSubmission ids", () => {
  it("are made by the proxy, whatever the client's creation id holds", async () => {
    draft = mail(`From: alice@corp.example\r\nTo: bob@corp.example`);
    const tempId = 'k"<b>/../x y';
    const res = await emailSubmissionSet(
      { accountId: String(account.id), create: { [tempId]: { emailId } } },
      { cfg, account, client, store },
    );
    const id = res.created?.[tempId]?.id ?? "";
    // RFC 8620 §1.2: 1 to 255 characters of the URL-safe base64 alphabet.
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,255}$/);
    expect(id).not.toContain("<b>");
    const got = await emailSubmissionGet({ accountId: String(account.id), ids: [id] }, { account, store });
    expect(got.list.map((s) => s.id)).toEqual([id]);
  });
});

describe("isPlainAddress", () => {
  it.each(["a@b", "first.last+tag@corp.example", "jörg@bücher.example", "a@[192.0.2.1]", "x!#$%&*/=?^_`{|}~@corp.example"])(
    "accepts %s",
    (a) => expect(isPlainAddress(a)).toBe(true),
  );
  it.each([
    "",
    "@corp.example",
    "a@",
    "a@b@corp.example",
    "a b@corp.example",
    "a,b@corp.example",
    "a;b@corp.example",
    "<a@corp.example>",
    '"a"@corp.example',
    "a\\@corp.example",
    "a(c)@corp.example",
    "team:a@corp.example",
    "a@corp.example\r\nRCPT TO:<b@corp.example>",
    "a\u0000@corp.example",
    "a b@corp.example",
  ])("refuses %j", (a) => expect(isPlainAddress(a)).toBe(false));
});

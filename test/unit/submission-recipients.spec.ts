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
import { Store, type AccountRow } from "../../src/state/store.js";
import { sealCredentials } from "../../src/auth/credentials.js";
import { emailSubmissionSet, isPlainAddress } from "../../src/jmap/methods/submission.js";
import { encodeEmailId } from "../../src/mapping/ids.js";
import type { AppConfig } from "../../src/util/config.js";

const smtpLines: string[] = [];
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
    expect(derived.notCreated?.s).toMatchObject({ type: "invalidRecipients", invalidRecipients: [CONFUSING.replace(/"/g, "")] });

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

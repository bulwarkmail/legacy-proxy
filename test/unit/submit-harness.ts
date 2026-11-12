// Shared by submission specs: a fake SMTP server that records the envelope and
// the DATA, a store with one account, and helpers to send the current draft
// through EmailSubmission/set.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { Store, type AccountRow } from "../../src/state/store.js";
import { sealCredentials } from "../../src/auth/credentials.js";
import { emailSubmissionSet } from "../../src/jmap/methods/submission.js";
import { buildRfc822 } from "../../src/mapping/buildMime.js";
import { encodeEmailId } from "../../src/mapping/ids.js";
import type { AppConfig } from "../../src/util/config.js";

export const smtpLines: string[] = [];
export const smtpData: string[] = [];
const state = { draft: Buffer.alloc(0) } as { draft: Buffer };
let smtp: net.Server;
let dir: string;
let store: Store;
let account: AccountRow;
let cfg: AppConfig;
let emailId: string;

export function useSubmitHarness(): void {
  beforeAll(async () => {
    smtp = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      let data = false;
      sock.on("error", () => {});
      sock.write("220 test ESMTP\r\n");
      sock.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (data) {
            const end = buf.indexOf("\r\n.\r\n");
            if (end < 0) return;
            smtpData.push(buf.subarray(0, end).toString("utf8"));
            buf = buf.subarray(end + 5);
            data = false;
            sock.write("250 queued\r\n");
            continue;
          }
          const nl = buf.indexOf("\r\n");
          if (nl < 0) return;
          const line = buf.subarray(0, nl).toString("utf8");
          buf = buf.subarray(nl + 2);
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-submit-"));
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
}

export function setDraft(raw: Buffer | string): void {
  state.draft = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
}
export function getDraft(): Buffer {
  return state.draft;
}

const client = {
  getMailboxLock: async () => ({ release: () => {} }),
  fetchOne: async () => ({ source: state.draft }),
} as unknown as ImapFlow;

export const rcpts = () =>
  smtpLines.filter((l) => /^RCPT TO:/i.test(l)).map((l) => l.replace(/^RCPT TO:<(.*?)>.*$/i, "$1"));
export const mailFroms = () => smtpLines.filter((l) => /^MAIL FROM:/i.test(l));
export const send = (envelope?: Record<string, unknown>) =>
  emailSubmissionSet(
    { accountId: String(account.id), create: { s: { emailId, ...(envelope ? { envelope } : {}) } } },
    { cfg, account, client, store },
  );

export type Addr = { name?: string; email: string };
/** The draft Email/set create makes from JSON addresses, as the webmail sends them. */
export const jsonDraft = (to: Addr[], extra: { from?: Addr[]; cc?: Addr[]; bcc?: Addr[] } = {}) =>
  buildRfc822(
    {
      from: extra.from ?? [{ name: "Alice", email: "alice@corp.example" }],
      to: to.length ? to : undefined,
      cc: extra.cc,
      bcc: extra.bcc,
      subject: "s",
      bodyValues: { "1": { value: "hi" } },
      textBody: [{ partId: "1" }],
    },
    "corp.example",
  );

/** What a reader shows as recipients: mailparser over the stored draft. */
export async function readerRecipients(raw: Buffer): Promise<string[]> {
  const m = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const out: string[] = [];
  type A = { address?: string; group?: A[] };
  const walk = (v: A[]) => {
    for (const a of v) {
      if (a.address) out.push(a.address);
      if (Array.isArray(a.group)) walk(a.group);
    }
  };
  for (const f of [m.to, m.cc, m.bcc]) {
    if (!f) continue;
    for (const x of Array.isArray(f) ? f : [f]) walk(x.value as A[]);
  }
  return out;
}

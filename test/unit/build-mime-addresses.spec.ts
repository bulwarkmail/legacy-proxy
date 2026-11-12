// Addresses in drafts built from JSON: each property is checked before the
// message is built, a display name never moves the mailbox, verbatim headers
// can't add an address header, and a recipient still being typed is saved as
// text that no reader takes for a mailbox and no submission sends to.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { buildRfc822, headerValues, isPlainAddress, parseAddressList } from "../../src/mapping/buildMime.js";
import { mailFroms, rcpts, send, setDraft, smtpData, useSubmitHarness } from "./submit-harness.js";

useSubmitHarness();

type Addr = { name?: string; email: string };
const base = { subject: "s", bodyValues: { "1": { value: "hi" } }, textBody: [{ partId: "1" }] };
const build = (props: Record<string, unknown>) => buildRfc822({ from: [{ email: "alice@corp.example" }], ...base, ...props } as never, "corp.example");
const header = (raw: Buffer, name: string) =>
  raw.toString("utf8").split(/\r?\n\r?\n/)[0]!.replace(/\r?\n[ \t]/g, " ").split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"));

/** A mailbox: something on each side of one "@". */
const isMailbox = (a: string | undefined) => !!a && /^[^@]+@[^@]+$/.test(a.trim());

/** Every mailbox mailparser reads from the built draft's address headers. */
async function readerMailboxes(raw: Buffer): Promise<string[]> {
  const m = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const out: string[] = [];
  type A = { address?: string; group?: A[] };
  const walk = (v: A[]) => v.forEach((a) => (isMailbox(a.address) && out.push(a.address!), Array.isArray(a.group) && walk(a.group)));
  for (const f of [m.from, m.to, m.cc, m.bcc, m.replyTo]) if (f) for (const x of Array.isArray(f) ? f : [f]) walk(x.value as A[]);
  const sender = m.headers.get("sender") as { value?: A[] } | undefined;
  if (sender?.value) walk(sender.value);
  return out.map((a) => a.toLowerCase());
}

const NOT_ONE_MAILBOX = [
  '"attacker@evil.example x"@corp.example',
  "<attacker@evil.example>@corp.example",
  "john smith@corp.example",
  "a@corp.example <b@evil.example>",
  "a@corp.example, b@evil.example",
  "Team: b@evil.example;",
  "b@evil.example (c@corp.example)",
  "=?utf-8?Q?b=40evil.example?=@corp.example\r\nBcc: x@evil.example",
];

describe("every address property is checked before the message is built", () => {
  for (const property of ["from", "sender", "to", "cc", "bcc", "replyTo"]) {
    it.each(NOT_ONE_MAILBOX)(`${property}: %j is refused with invalidProperties`, async (email) => {
      await expect(build({ [property]: [{ email }] })).rejects.toMatchObject({ type: "invalidProperties" });
    });
  }
});

describe("a display name never moves the mailbox, for the strict parser or for mailparser", () => {
  it.each([
    'x" <b@evil.example>, "y',
    '\\" <b@evil.example>',
    "a\\",
    "<b@evil.example>",
    "b@evil.example",
    "=?utf-8?Q?=3Cb=40evil.example=3E?=",
    "=?utf-8?B?PGJAZXZpbC5leGFtcGxlPg==?=",
    "Jörg <b@evil.example>, ",
    "Jörg\r\nBcc: b@evil.example",
    "x To: b@evil.example",
    "(b@evil.example)",
    "Team: b@evil.example;",
  ])("name %j on bob@corp.example", async (name) => {
    const raw = await build({ to: [{ name, email: "bob@corp.example" }] });
    expect((await readerMailboxes(raw)).sort(), header(raw, "To").join(" | ")).toEqual(["alice@corp.example", "bob@corp.example"]);
    setDraft(raw);
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(rcpts()).toEqual(["bob@corp.example"]);
    expect(smtpData.join("\n")).not.toMatch(/^bcc:/im);
  });
});

describe("a normal send as the webmail makes it", () => {
  it("To, Cc and Bcc with display names: sent to all three, no Bcc on the wire", async () => {
    setDraft(
      await build({
        from: [{ name: "Alice", email: "alice@corp.example" }],
        to: [{ name: "Doe, Jane", email: "jane@corp.example" }],
        cc: [{ name: "Jörg Müller", email: "joerg@corp.example" }],
        bcc: [{ name: "Hidden", email: "hidden@corp.example" }],
      }),
    );
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(rcpts()).toEqual(["jane@corp.example", "joerg@corp.example", "hidden@corp.example"]);
    expect(smtpData.join("\n")).not.toMatch(/^bcc:|hidden@/im);
  });
});

describe("verbatim headers cannot add or replace an address header", () => {
  it.each([
    ["To ", "attacker@evil.example"],
    ["TO\t", "attacker@evil.example"],
    ["To:x", " attacker@evil.example"],
    ["Cc ", "attacker@evil.example"],
    ["Bcc ", "attacker@evil.example"],
    ["Sender ", "mallory@evil.example"],
    ["Reply-To ", "mallory@evil.example"],
  ])("header %j: refused, or nothing goes to another domain", async (name, value) => {
    let raw: Buffer;
    try {
      raw = await build({ to: [{ email: "bob@corp.example" }], headers: [{ name, value }] });
    } catch (e) {
      expect(e).toMatchObject({ type: "invalidProperties" });
      return;
    }
    setDraft(raw);
    const res = await send();
    expect(rcpts().join(" ") + mailFroms().join(" ")).not.toContain("evil.example");
    if (!res.notCreated) expect(rcpts()).toEqual(["bob@corp.example"]);
  });
});

describe("a recipient still being typed: saved as text, never a mailbox anywhere", () => {
  const SAVED: [string, Addr][] = [
    ["a local delivery name", { email: "postmaster" }],
    ["root", { email: "root" }],
    ["a percent path", { email: "user%evil.example" }],
    ["a bang path", { email: "evil.example!user" }],
    ["a B-encoded word that decodes to an address", { email: "=?utf-8?B?YkBldmlsLmV4YW1wbGU=?=" }],
    ["a Q-encoded word that decodes to an address", { email: "=?utf-8?Q?b=40evil.example?=" }],
    ["fullwidth commercial at", { email: "b＠evil.example" }],
    ["small commercial at", { email: "b﹫evil.example" }],
    ["fullwidth comma between two words", { email: "bob，alice" }],
    ["fullwidth colon and semicolon", { email: "Team：bob；" }],
    ["fullwidth angle brackets", { email: "x＜b＠evil.example＞" }],
    ["no-break space", { email: "Bob Smith" }],
    ["ideographic space", { email: "Bob　Smith" }],
    ["right-to-left override", { email: "‮bob" }],
    ["a 3000-character word", { email: "b".repeat(3000) }],
    ["a name that is an address", { name: "b@evil.example", email: "bob" }],
    ["a name in angle-bracket form", { name: "<b@evil.example>", email: "bob" }],
    ["a local part and the @", { email: "jane@" }],
    ["a name and an address up to the @", { name: "Jane Doe", email: "jane@" }],
    ["the @ and a domain", { email: "@corp.example" }],
    ["a name and the @ with a domain", { name: "x", email: "@corp.example" }],
    ["the @ alone", { email: "@" }],
  ];
  it.each(SAVED)("%s: the draft saves, no reader finds a mailbox in it, and it is not sent", async (_label, entry) => {
    const raw = await build({ to: [entry, { name: "Carol", email: "carol@corp.example" }] });
    // carol is the only mailbox any reader may find in To (alice is From)
    expect((await readerMailboxes(raw)).sort(), header(raw, "To").join(" | ")).toEqual(["alice@corp.example", "carol@corp.example"]);
    setDraft(raw);
    const res = await send();
    expect(res.notCreated?.s?.type).toBe("invalidRecipients");
    expect(smtpData).toEqual([]);
  });

  it.each(["postmaster", "root", "user%evil.example", "evil.example!user", "jane@", "@corp.example"])(
    "a client envelope naming %j is refused",
    async (entry) => {
      setDraft("From: alice@corp.example\r\nTo: bob@corp.example\r\n\r\nbody\r\n");
      const res = await send({ mailFrom: { email: "alice@corp.example" }, rcptTo: [{ email: entry }] });
      expect(res.notCreated?.s?.type).toBe("invalidRecipients");
      expect(rcpts()).toEqual([]);
    },
  );

  it("a half-typed From is saved but never becomes MAIL FROM, derived or given", async () => {
    for (const from of ["postmaster", "alice@"]) {
      setDraft(await build({ from: [{ email: from }], to: [{ email: "carol@corp.example" }] }));
      expect((await send()).notCreated?.s?.type, from).toBe("forbiddenMailFrom");
      setDraft("From: alice@corp.example\r\nTo: carol@corp.example\r\n\r\nbody\r\n");
      expect((await send({ mailFrom: { email: from }, rcptTo: [{ email: "carol@corp.example" }] })).notCreated?.s?.type, from).toBe("forbiddenMailFrom");
    }
    expect(smtpData).toEqual([]);
    expect(mailFroms()).toEqual([]);
  });

  it("a draft saved with bob and sent with an envelope that leaves bob out: envelope only, bob stays in To on the wire", async () => {
    setDraft(await build({ to: [{ email: "bob" }, { email: "carol@corp.example" }] }));
    const res = await send({ mailFrom: { email: "alice@corp.example" }, rcptTo: [{ email: "carol@corp.example" }] });
    expect(res.notCreated).toBeNull();
    expect(rcpts()).toEqual(["carol@corp.example"]);
    expect(smtpData.join("\n")).toMatch(/^To: bob, carol@corp\.example/m);
  });
});

describe("text with an @ at one end never joins a neighbouring entry into a mailbox", () => {
  // nodemailer's address parsers: the root copy the proxy sends with, and the
  // copy mailparser carries (its version differs between package sets).
  const require = createRequire(import.meta.url);
  const rootParser = require("nodemailer/lib/addressparser") as (s: string) => { address?: string; group?: unknown[] }[];
  const mailparserParser = createRequire(require.resolve("mailparser"))("nodemailer/lib/addressparser") as typeof rootParser;
  const parserMailboxes = (parse: typeof rootParser, value: string) => {
    const out: string[] = [];
    const walk = (v: { address?: string; group?: unknown[] }[]) =>
      v.forEach((a) => (isMailbox(a.address) && out.push(a.address!.toLowerCase()), Array.isArray(a.group) && walk(a.group as typeof v)));
    walk(parse(value));
    return out;
  };

  it.each<[string, Addr[]]>([
    ["x@ before a domain", [{ email: "x@" }, { email: "evil.example" }]],
    ["a word before @corp.example", [{ email: "attacker" }, { email: "@corp.example" }]],
    ["x@ before @evil.example", [{ email: "x@" }, { email: "@evil.example" }]],
    ["jane@ before a domain with a name", [{ name: "Jane", email: "jane@" }, { name: "Corp", email: "corp.example" }]],
    ["@ alone between two words", [{ email: "a" }, { email: "@" }, { email: "evil.example" }]],
    ["x@ after a long name that folds the line", [{ name: "A".repeat(70), email: "x@" }, { email: "evil.example" }]],
  ])("%s", async (_label, entries) => {
    const raw = await build({ to: [...entries, { name: "Carol", email: "carol@corp.example" }] });
    const to = headerValues(raw, "to");
    const strict = to.flatMap(parseAddressList).map((e) => e.address).filter((a): a is string => a !== null && isPlainAddress(a));
    expect(strict, to.join(" | ")).toEqual(["carol@corp.example"]);
    expect((await readerMailboxes(raw)).sort(), to.join(" | ")).toEqual(["alice@corp.example", "carol@corp.example"]);
    expect(to.flatMap((v) => parserMailboxes(rootParser, v)), to.join(" | ")).toEqual(["carol@corp.example"]);
    expect(to.flatMap((v) => parserMailboxes(mailparserParser, v)), to.join(" | ")).toEqual(["carol@corp.example"]);
    setDraft(raw);
    expect((await send()).notCreated?.s?.type).toBe("invalidRecipients");
    expect(smtpData).toEqual([]);
    expect(rcpts()).toEqual([]);
  });
});

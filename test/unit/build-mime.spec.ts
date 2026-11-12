import { afterEach, describe, expect, it, vi } from "vitest";
import MimeNode from "nodemailer/lib/mime-node/index.js";
import { buildRfc822, headerValues, MissingBlobError, parseAddressList } from "../../src/mapping/buildMime.js";
import type { JmapError } from "../../src/jmap/errors.js";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const blobs: Record<string, { body: Buffer; ctype: string }> = {
  Uimg: { body: PNG, ctype: "image/png" },
  Updf: { body: Buffer.from("%PDF-1.4"), ctype: "application/pdf" },
};
const getBlob = (id: string) => blobs[id] ?? null;

// The shape Bulwark sends: textBody / htmlBody plus an attachments list.
const base = {
  from: [{ email: "a@example.org" }],
  to: [{ email: "b@example.org" }],
  subject: "Bild",
  bodyValues: { text: { value: "Hallo" }, html: { value: '<p>Hallo <img src="cid:img1@webmail"></p>' } },
  textBody: [{ partId: "text", type: "text/plain" }],
  htmlBody: [{ partId: "html", type: "text/html" }],
};

describe("buildRfc822 attachments (RFC 8621 §4.6)", () => {
  it("puts inline images in multipart/related and files in multipart/mixed", async () => {
    const mime = (await buildRfc822({
      ...base,
      attachments: [
        { blobId: "Uimg", type: "image/png", name: "bild.png", disposition: "inline", cid: "img1@webmail" },
        { blobId: "Updf", type: "application/pdf", name: "doc.pdf", disposition: "attachment" },
      ],
    }, "example.org", getBlob)).toString();

    const types = [...mime.matchAll(/^Content-Type: ([\w/-]+)/gm)].map((m) => m[1]);
    expect(types).toEqual(["multipart/mixed", "multipart/related", "multipart/alternative", "text/plain", "text/html", "image/png", "application/pdf"]);
    expect(mime).toContain("Content-ID: <img1@webmail>");
    expect(mime).toMatch(/Content-Disposition: inline; filename=bild\.png/);
    expect(mime).toContain(PNG.toString("base64"));
    expect(mime).toContain(Buffer.from("%PDF-1.4").toString("base64"));
  });

  it("treats inline parts as plain attachments when there is no HTML", async () => {
    const mime = (await buildRfc822({
      ...base,
      htmlBody: null,
      attachments: [{ blobId: "Uimg", type: "image/png", name: "bild.png", disposition: "inline", cid: "img1@webmail" }],
    }, "example.org", getBlob)).toString();
    const types = [...mime.matchAll(/^Content-Type: ([\w/-]+)/gm)].map((m) => m[1]);
    expect(types).toEqual(["multipart/mixed", "text/plain", "image/png"]);
  });

  it("fails instead of sending an empty part for an unknown blob", async () => {
    await expect(buildRfc822({
      ...base,
      attachments: [{ blobId: "Ugone", type: "image/png", disposition: "inline", cid: "x" }],
    }, "example.org", getBlob)).rejects.toBeInstanceOf(MissingBlobError);
  });
});

describe("buildRfc822 addresses", () => {
  afterEach(() => vi.restoreAllMocks());

  const build = (extra: Record<string, unknown>) =>
    buildRfc822({ from: [{ name: "Alice", email: "alice@corp.example" }], subject: "s", textBody: [{ partId: "1" }], bodyValues: { "1": { value: "hi" } }, ...extra }, "corp.example");
  const addresses = (raw: Buffer, header: string) =>
    headerValues(raw, header).flatMap(parseAddressList).map((e) => e.address);

  it.each([
    ["to", '"attacker@evil.example x"@corp.example'],
    ["to", "<attacker@evil.example>@corp.example"],
    ["to", "john smith@corp.example"],
    ["to", "a@corp.example <b@evil.example>"],
    ["cc", "a@corp.example, b@evil.example"],
    ["bcc", "team:a@corp.example"],
    ["replyTo", "a(b)@corp.example"],
    ["sender", '"x"@corp.example'],
    ["from", "alice@corp.example\r\nBcc: b@evil.example"],
    // Text without an "@" that holds address syntax or a line break.
    ["to", "<bob>"],
    ["to", '"bob"'],
    ["to", "team:"],
    ["to", "team: bob;"],
    ["to", "bob, carol"],
    ["cc", "bob\r\nBcc"],
    ["to", "bob carol"],
    ["to", "bob (work)"],
    ["to", "[bob]"],
  ])("refuses %s %j, naming the property and the address", async (property, email) => {
    const err = await build({ [property]: [{ name: "N", email }] }).catch((e: unknown) => e);
    // What the client gets as the SetError.
    const setError = (err as JmapError).toMethodError();
    expect(setError).toMatchObject({ type: "invalidProperties", properties: [property] });
    expect(setError.description).toContain(JSON.stringify(email));
  });

  it.each<[string, { name?: string; email: string }[], (string | null)[]]>([
    ["bob", [{ email: "bob" }], [null]],
    ["Bob Smith", [{ email: "Bob Smith" }], [null]],
    ["a display name and bob", [{ name: "Bob", email: "bob" }], [null]],
    ["a non-ASCII word", [{ email: "müller" }], [null]],
    ["a complete address and a half-typed one", [{ name: "Alice", email: "alice@corp.example" }, { email: "bo" }], ["alice@corp.example", null]],
    ["an empty string", [{ email: "" }], []],
  ])("saves a draft whose To holds %s, the half-typed text as no mailbox", async (_label, to, mailboxes) => {
    const raw = await build({ to });
    const read = headerValues(raw, "to").flatMap(parseAddressList);
    // A mailbox is an address with an "@"; half-typed text reads back as none.
    expect(read.map((e) => (e.address?.includes("@") ? e.address : null))).toEqual(mailboxes);
  });

  it("refuses an address property that isn't a list, and an email that isn't text", async () => {
    const setError = (p: Promise<unknown>) => p.catch((e: unknown) => (e as JmapError).toMethodError());
    expect(await setError(build({ to: "a@corp.example" }))).toMatchObject({ type: "invalidProperties", properties: ["to"] });
    expect(await setError(build({ cc: [{ email: 42 }] }))).toMatchObject({ type: "invalidProperties", properties: ["cc"] });
  });

  it.each([
    ["a comma", "Doe, Jane"],
    ["quotes and a backslash", 'a "b" \\ c'],
    ["non-ASCII and an @", "Jörg Müller @ Work"],
    ["what looks like an encoded word", "=?utf-8?Q?a=40evil.example?="],
    ["an emoji and a comma", "Team 🚀, Ops"],
    ["a line break", "a\r\nBcc: b@evil.example"],
    ["80 non-ASCII letters", "Ä".repeat(80)],
  ])("writes a display name with %s and keeps the mailbox", async (_label, name) => {
    const raw = await build({ to: [{ name, email: "jane@corp.example" }] });
    expect(addresses(raw, "to")).toEqual(["jane@corp.example"]);
    expect(addresses(raw, "bcc")).toEqual([]);
  });

  it("writes every address field, in order, as given", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `Person ${i}`, email: `p${i}@corp.example` }));
    const raw = await build({
      sender: [{ email: "alice@corp.example" }],
      to: many,
      cc: [{ email: "c@corp.example" }],
      bcc: [{ email: "h@corp.example" }],
      replyTo: [{ name: "R", email: "r@corp.example" }],
    });
    expect(addresses(raw, "from")).toEqual(["alice@corp.example"]);
    expect(addresses(raw, "sender")).toEqual(["alice@corp.example"]);
    expect(addresses(raw, "to")).toEqual(many.map((m) => m.email));
    expect(addresses(raw, "cc")).toEqual(["c@corp.example"]);
    expect(addresses(raw, "bcc")).toEqual(["h@corp.example"]);
    expect(addresses(raw, "reply-to")).toEqual(["r@corp.example"]);
  });

  it("takes the domain in any case or IDN form as the same mailbox", async () => {
    const raw = await build({ to: [{ email: "Bob@Bücher.Example" }, { email: "a@[192.0.2.1]" }] });
    expect(addresses(raw, "to")).toEqual(["Bob@xn--bcher-kva.example", "a@[192.0.2.1]"]);
  });

  it("refuses a message whose address header doesn't read back as what it was given", async () => {
    // Stands for any MimeNode version that writes an address differently.
    vi.spyOn(MimeNode.prototype as unknown as { _convertAddresses: (a: unknown) => string }, "_convertAddresses").mockReturnValue(
      "other@evil.example",
    );
    await expect(build({ to: [{ email: "jane@corp.example" }] })).rejects.toMatchObject({ type: "invalidProperties" });
  });
});

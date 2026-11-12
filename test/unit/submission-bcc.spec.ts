import { describe, expect, it } from "vitest";
import { buildRfc822 } from "../../src/mapping/buildMime.js";
import { messageIdOf, stripBccHeader, withFreshMessageId } from "../../src/jmap/methods/submission.js";

describe("Bcc handling", () => {
  it("keeps Bcc in the stored draft so the envelope can be derived from it", async () => {
    const raw = await buildRfc822(
      {
        from: [{ email: "a@example.org" }],
        to: [{ email: "b@example.org" }],
        bcc: [{ email: "hidden@example.org" }],
        subject: "hi",
        textBody: [{ partId: "1" }],
        bodyValues: { "1": { value: "hello" } },
      },
      "example.org",
    );
    expect(raw.toString()).toMatch(/^Bcc: hidden@example\.org\r$/m);
  });

  it("strips Bcc, including folded lines, before SMTP and leaves the body alone", () => {
    const raw = Buffer.from(
      "From: a@example.org\r\nBcc: x@example.org,\r\n y@example.org\r\nTo: b@example.org\r\n\r\nBcc: body line\r\n",
    );
    expect(stripBccHeader(raw).toString()).toBe(
      "From: a@example.org\r\nTo: b@example.org\r\n\r\nBcc: body line\r\n",
    );
  });

  it("keeps the header block terminated when Bcc was the last header", () => {
    const raw = Buffer.from("From: a@example.org\r\nBcc: x@example.org\r\n\r\nbody");
    expect(stripBccHeader(raw).toString()).toBe("From: a@example.org\r\n\r\nbody");
  });

  it("strips every Bcc field of a message whose lines end in LF, and leaves the body alone", () => {
    const raw = Buffer.from("Bcc: a@example.org\nFrom: a@example.org\nBCC : b@example.org,\n\tc@example.org\nTo: d@example.org\n\nBcc: body\n");
    expect(stripBccHeader(raw).toString()).toBe("From: a@example.org\nTo: d@example.org\n\nBcc: body\n");
  });

  it("leaves a message without Bcc unchanged", () => {
    const raw = Buffer.from("From: a@example.org\r\nTo: b@example.org\r\n\r\nbody");
    expect(stripBccHeader(raw).equals(raw)).toBe(true);
  });
});

describe("messageIdOf", () => {
  it("reads the Message-ID header, folded or not, and ignores the body", () => {
    expect(messageIdOf(Buffer.from("From: a@example.org\r\nMessage-ID: <x@example.org>\r\n\r\nbody"))).toBe("<x@example.org>");
    expect(messageIdOf(Buffer.from("message-id:\r\n <y@example.org>\r\n\r\n"))).toBe("<y@example.org>");
    expect(messageIdOf(Buffer.from("From: a@example.org\r\n\r\nMessage-ID: <body@example.org>\r\n"))).toBeNull();
  });
});

describe("withFreshMessageId", () => {
  it("swaps the Message-ID for a new one on the same domain and leaves the rest alone", () => {
    const raw = Buffer.from("From: a@gmail.com\r\nMessage-ID: <draft@gmail.com>\r\nSubject: hi\r\n\r\nMessage-ID: <body@x>\r\n");
    const out = withFreshMessageId(raw).toString();
    const id = messageIdOf(Buffer.from(out));
    expect(id).toMatch(/^<[0-9a-f-]{36}@gmail\.com>$/);
    expect(out.replace(id!, "<ID>")).toBe("From: a@gmail.com\r\nMessage-ID: <ID>\r\nSubject: hi\r\n\r\nMessage-ID: <body@x>\r\n");
  });

  it("replaces a folded Message-ID as a whole", () => {
    const out = withFreshMessageId(Buffer.from("Message-ID:\r\n <draft@example.org>\r\nTo: b@example.org\r\n\r\nbody")).toString();
    expect(out).not.toContain("draft@example.org");
    expect(out).toMatch(/^Message-ID: <[0-9a-f-]{36}@example\.org>\r\nTo: b@example\.org\r\n\r\nbody$/);
  });

  it("leaves a message without Message-ID unchanged", () => {
    const raw = Buffer.from("From: a@example.org\r\n\r\nbody");
    expect(withFreshMessageId(raw).equals(raw)).toBe(true);
  });
});

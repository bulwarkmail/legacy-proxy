// Which messages are sent and which are refused for the line breaks of their
// header block, when a stored message is submitted as it is. The refusals
// record what happens to such messages.
import { describe, expect, it } from "vitest";
import { buildRfc822 } from "../../src/mapping/buildMime.js";
import { rcpts, send, setDraft, smtpData, useSubmitHarness } from "./submit-harness.js";

useSubmitHarness();

const OUTLOOK = [
  "Received: from AM0PR01MB1234.eurprd01.prod.exchangelabs.com (2603:10a6:208:1::1) by",
  " AM0PR01MB5678.eurprd01.prod.exchangelabs.com with HTTPS; Tue, 10 Nov 2026",
  " 09:12:13 +0000",
  "From: Alice Example <alice@corp.example>",
  "To: \"Doe, Jane\" <jane@corp.example>, Bob <bob@corp.example>",
  "CC: Carol <carol@corp.example>",
  "Subject: =?utf-8?B?UXVhcnRhbHN6YWhsZW4gw7xiZXJhcmJlaXRldA==?=",
  "Thread-Topic: Quartalszahlen",
  "Thread-Index: AQHZq3m1c1Yx2Q==",
  "Date: Tue, 10 Nov 2026 09:12:12 +0000",
  "Message-ID: <AM0PR01MB1234ABCD@AM0PR01MB1234.eurprd01.prod.exchangelabs.com>",
  "Content-Language: de-DE",
  "X-MS-Has-Attach: ",
  "X-MS-TNEF-Correlator: ",
  "Content-Type: text/plain; charset=\"utf-8\"",
  "Content-Transfer-Encoding: base64",
  "MIME-Version: 1.0",
  "",
  "SGFsbG8=",
  "",
];

describe("messages that are sent", () => {
  it("an Outlook export (CRLF, folded Received, empty X-MS headers)", async () => {
    setDraft(OUTLOOK.join("\r\n"));
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(rcpts()).toEqual(["jane@corp.example", "bob@corp.example", "carol@corp.example"]);
  });

  it("an Apple Mail export (LF only)", async () => {
    setDraft(OUTLOOK.join("\n"));
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(rcpts()).toHaveLength(3);
  });

  it("a forward with the original attached, whose own header block has a bare CR and mixed line ends", async () => {
    const original = Buffer.from("From: x@other.example\r\nSubject: odd\rX: y\nTo: z@other.example\r\n\r\nbody\r\n", "latin1");
    const raw = await buildRfc822(
      {
        from: [{ email: "alice@corp.example" }],
        to: [{ email: "bob@corp.example" }],
        subject: "Fwd: odd",
        bodyValues: { "1": { value: "see attached" } },
        textBody: [{ partId: "1" }],
        attachments: [{ blobId: "B1", type: "message/rfc822", name: "odd.eml", disposition: "attachment" }],
      },
      "corp.example",
      (id) => (id === "B1" ? { body: original, ctype: "message/rfc822" } : null),
    );
    setDraft(raw);
    const res = await send();
    expect(res.notCreated).toBeNull();
    expect(rcpts()).toEqual(["bob@corp.example"]);
  });
});

describe("messages refused for the line breaks of their header block", () => {
  it.each([
    ["a whitespace-only continuation line (obsolete folding)", "From: alice@corp.example\r\nTo: bob@corp.example\r\nSubject: Hello\r\n \r\n world\r\n\r\nbody\r\n"],
    ["an mbox separator as the first line", "From alice@corp.example Tue Nov 10 09:12:12 2026\r\nFrom: alice@corp.example\r\nTo: bob@corp.example\r\n\r\nbody\r\n"],
    ["one LF-only header added to a CRLF message", "Received: by filter; Tue, 10 Nov 2026 09:12:12 +0000\nFrom: alice@corp.example\r\nTo: bob@corp.example\r\n\r\nbody\r\n"],
  ])("%s", async (_label, raw) => {
    setDraft(raw);
    const res = await send();
    expect(res.notCreated?.s?.type).toBe("invalidEmail");
    expect(smtpData).toEqual([]);
  });
});

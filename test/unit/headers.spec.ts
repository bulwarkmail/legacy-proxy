import { describe, expect, it } from "vitest";
import { headersToEmailHeaders, parseHeaderBlock, projectHeaderProp } from "../../src/imap/headers.js";

describe("projectHeaderProp", () => {
  const parsed = parseHeaderBlock(
    [
      "Received: from relay by mx; Mon, 5 Oct 2026 10:00:01 +0000",
      "Authentication-Results: mx.example.org; dkim=pass",
      "Received: from sender by relay; Mon, 5 Oct 2026 10:00:00 +0000",
      "authentication-results: relay.example.net; spf=fail",
      "From: Alice <alice@example.org>",
      "From: Bob <bob@example.org>, carol@example.org",
      "List-Id: =?UTF-8?Q?Caf=C3=A9?= <cafe.example.org>",
      "List-Unsubscribe: <mailto:u@example.org>, <https://example.org/u>",
      "",
      "body",
    ].join("\r\n"),
  );
  const project = (prop: string) => projectHeaderProp(parsed, prop);

  it("answers :all with the Raw value of every instance in message order", () => {
    expect(project("header:Authentication-Results:all")).toEqual([
      " mx.example.org; dkim=pass",
      " relay.example.net; spf=fail",
    ]);
    expect(project("header:Received:all")).toEqual([
      " from relay by mx; Mon, 5 Oct 2026 10:00:01 +0000",
      " from sender by relay; Mon, 5 Oct 2026 10:00:00 +0000",
    ]);
    expect(project("header:received:asRaw:all")).toEqual(project("header:Received:all"));
  });

  it("answers :all with an empty array when the field is absent", () => {
    expect(project("header:Nope:all")).toEqual([]);
    expect(project("header:Nope:asText:all")).toEqual([]);
    expect(project("header:Nope")).toBeNull();
  });

  it("projects each instance in its form for :all", () => {
    expect(project("header:From:asAddresses:all")).toEqual([
      [{ name: "Alice", email: "alice@example.org" }],
      [{ name: "Bob", email: "bob@example.org" }, { name: null, email: "carol@example.org" }],
    ]);
    expect(project("header:list-id:asText:all")).toEqual(["Café <cafe.example.org>"]);
    expect(project("header:List-Unsubscribe:asURLs:all")).toEqual([["mailto:u@example.org", "https://example.org/u"]]);
  });

  it("answers a form without :all from the last instance only", () => {
    expect(project("header:Authentication-Results")).toBe(" relay.example.net; spf=fail");
    expect(project("header:From:asAddresses")).toEqual([
      { name: "Bob", email: "bob@example.org" },
      { name: null, email: "carol@example.org" },
    ]);
  });
});

describe("headersToEmailHeaders", () => {
  it("returns every header in order with Raw values, keeping parameters", () => {
    const parsed = parseHeaderBlock(
      [
        "From: a@example.org",
        "Content-Type: application/pkcs7-mime; smime-type=signed-data;",
        ' name="smime.p7m"',
        "Received: one",
        "Received: two",
        "",
        "body",
      ].join("\r\n"),
    );
    expect(headersToEmailHeaders(parsed)).toEqual([
      { name: "From", value: " a@example.org" },
      {
        name: "Content-Type",
        value: ' application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"',
      },
      { name: "Received", value: " one" },
      { name: "Received", value: " two" },
    ]);
  });
});

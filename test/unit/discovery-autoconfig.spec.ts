// Reading a Mozilla autoconfig file: only TLS servers, submission on 465 or
// 587, plain host names after %EMAILDOMAIN% is filled in, and user names that
// are the address or its local part.

import { describe, expect, it } from "vitest";
import { parseAutoconfig } from "../../src/auth/discovery.js";

const file = (servers: string) => `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="example.org">
    <domain>example.org</domain>
    <displayName>Example</displayName>
${servers}
  </emailProvider>
</clientConfig>`;

const imap = (host: string, port: number, socketType: string, username = "%EMAILADDRESS%") => `
    <incomingServer type="imap">
      <hostname>${host}</hostname>
      <port>${port}</port>
      <socketType>${socketType}</socketType>
      <username>${username}</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>`;
const smtp = (host: string, port: number, socketType: string, username = "%EMAILADDRESS%") => `
    <outgoingServer type="smtp">
      <hostname>${host}</hostname>
      <port>${port}</port>
      <socketType>${socketType}</socketType>
      <username>${username}</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>`;

describe("parseAutoconfig", () => {
  it("reads the IMAP and SMTP servers of a good file, in the file's order", () => {
    const xml = file(
      imap("imap.example.org", 993, "SSL") +
        `<incomingServer type="pop3"><hostname>pop.example.org</hostname><port>995</port><socketType>SSL</socketType></incomingServer>` +
        imap("imap2.example.org", 143, "STARTTLS") +
        smtp("smtp.example.org", 587, "STARTTLS") +
        smtp("smtp.example.org", 465, "SSL"),
    );
    const offer = parseAutoconfig(xml, "example.org");
    expect(offer.imap).toEqual([
      { host: "imap.example.org", port: 993, secure: true, starttls: false },
      { host: "imap2.example.org", port: 143, secure: false, starttls: true },
    ]);
    expect(offer.smtp).toEqual([
      { host: "smtp.example.org", port: 587, secure: false, starttls: true },
      { host: "smtp.example.org", port: 465, secure: true, starttls: false },
    ]);
    expect(offer.refused).toEqual([]);
  });

  it("refuses a file that offers only plain-text servers", () => {
    const xml = file(
      imap("imap.example.org", 143, "plain") +
        `<incomingServer type="imap"><hostname>imap.example.org</hostname><port>143</port></incomingServer>` +
        smtp("smtp.example.org", 25, "plain") +
        smtp("smtp.example.org", 587, "plain"),
    );
    const offer = parseAutoconfig(xml, "example.org");
    expect(offer.imap).toEqual([]);
    expect(offer.smtp).toEqual([]);
    expect(offer.refused).toHaveLength(4);
    expect(offer.refused.join("\n")).toMatch(/no TLS/);
  });

  it("takes submission only on 465 with implicit TLS or 587 with STARTTLS", () => {
    const xml = file(smtp("smtp.example.org", 25, "STARTTLS") + smtp("smtp.example.org", 587, "SSL") + smtp("smtp.example.org", 2525, "SSL"));
    const offer = parseAutoconfig(xml, "example.org");
    expect(offer.smtp).toEqual([]);
    expect(offer.refused).toHaveLength(3);
  });

  it("fills in %EMAILDOMAIN% and refuses host names that are not plain afterwards", () => {
    const xml = file(
      imap("imap.%EMAILDOMAIN%", 993, "SSL") +
        imap("%EMAILLOCALPART%.example.org", 993, "SSL") +
        imap("10.0.0.5", 993, "SSL") +
        imap("localhost", 993, "SSL") +
        imap("imap.example.org:993", 993, "SSL"),
    );
    const offer = parseAutoconfig(xml, "example.org");
    expect(offer.imap.map((s) => s.host)).toEqual(["imap.example.org"]);
    expect(offer.refused).toHaveLength(4);
  });

  it("logs in with the local part for %EMAILLOCALPART% and refuses other user names", () => {
    const xml = file(
      imap("a.example.org", 993, "SSL", "%EMAILLOCALPART%") +
        imap("b.example.org", 993, "SSL", "%EMAILADDRESS%") +
        imap("c.example.org", 993, "SSL", "admin") +
        imap("d.example.org", 993, "SSL", "%EMAILLOCALPART%@%EMAILDOMAIN%") +
        `<incomingServer type="imap"><hostname>e.example.org</hostname><port>993</port><socketType>SSL</socketType></incomingServer>`,
    );
    const offer = parseAutoconfig(xml, "example.org");
    expect(offer.imap).toEqual([
      { host: "a.example.org", port: 993, secure: true, starttls: false, localPartLogin: true },
      { host: "b.example.org", port: 993, secure: true, starttls: false },
      { host: "e.example.org", port: 993, secure: true, starttls: false },
    ]);
    expect(offer.refused).toHaveLength(2);
  });

  it("ignores servers inside comments and decodes entities", () => {
    const xml = file(`<!-- ${imap("evil.example.net", 993, "SSL")} -->` + imap("imap&#46;example.org", 993, "SSL"));
    expect(parseAutoconfig(xml, "example.org").imap.map((s) => s.host)).toEqual(["imap.example.org"]);
  });

  it("finds nothing in a file that is not autoconfig", () => {
    expect(parseAutoconfig("<html><body>Not found</body></html>", "example.org")).toEqual({ imap: [], smtp: [], refused: [] });
  });
});

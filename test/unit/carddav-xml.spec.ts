import { describe, expect, it } from "vitest";
import {
  splitResponses,
  extractHref,
  textOf,
  hasResourceType,
  pickHref,
} from "../../src/carddav/client.js";

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/dav/addressbook/user@x.io/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>Personal</D:displayname>
        <C:addressbook-description>My contacts</C:addressbook-description>
        <CS:getctag>"abc-123"</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/addressbook/user@x.io/personal/card-1.vcf</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getetag>"etag-card-1"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

describe("CardDAV XML helpers", () => {
  it("splits multistatus into per-response chunks", () => {
    const chunks = splitResponses(MULTISTATUS);
    expect(chunks).toHaveLength(2);
  });

  it("extracts <href> values, decoded", () => {
    const chunks = splitResponses(MULTISTATUS);
    expect(extractHref(chunks[0]!)).toBe("/dav/addressbook/user@x.io/personal/");
    expect(extractHref(chunks[1]!)).toBe("/dav/addressbook/user@x.io/personal/card-1.vcf");
  });

  it("reads element text with textOf", () => {
    const chunks = splitResponses(MULTISTATUS);
    expect(textOf(chunks[0]!, "displayname")).toBe("Personal");
    expect(textOf(chunks[0]!, "addressbook-description")).toBe("My contacts");
    expect(textOf(chunks[0]!, "getctag")).toBe('"abc-123"');
    expect(textOf(chunks[1]!, "getetag")).toBe('"etag-card-1"');
  });

  it("detects an addressbook resourcetype", () => {
    const chunks = splitResponses(MULTISTATUS);
    expect(hasResourceType(chunks[0]!, "addressbook")).toBe(true);
    expect(hasResourceType(chunks[1]!, "addressbook")).toBe(false);
  });

  it("picks an href out of a wrapper element", () => {
    const xml = `<x:multistatus xmlns:x="DAV:"><x:response><x:propstat><x:prop>
      <x:current-user-principal><x:href>/principals/user@x.io/</x:href></x:current-user-principal>
    </x:prop></x:propstat></x:response></x:multistatus>`;
    expect(pickHref(xml, "current-user-principal")).toBe("/principals/user@x.io/");
  });

  it("decodes XML entities and CDATA in element text", () => {
    const xml = `<x:r xmlns:x="DAV:"><x:href>/a/b%20c</x:href><x:n>A &amp; B</x:n><x:m><![CDATA[raw <bytes>]]></x:m></x:r>`;
    expect(textOf(xml, "n")).toBe("A & B");
    expect(textOf(xml, "m")).toBe("raw <bytes>");
  });
});

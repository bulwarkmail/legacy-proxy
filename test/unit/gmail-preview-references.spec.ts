// Gmail snippets arrive HTML-escaped and are decoded into the plain-text
// preview. A numeric character reference becomes a character only when it
// names one: up to U+10FFFF and not a surrogate half. Anything else stays as
// it was written, and decoding never throws.

import { describe, expect, it } from "vitest";
import { snippetPreview } from "../../src/gmail/message.js";

describe("numeric character references in a Gmail snippet", () => {
  it("decodes the ones that name a character", () => {
    expect(snippetPreview("It&#39;s here &#x1F600; &#8364;5")).toBe("It's here \u{1F600} €5");
    expect(snippetPreview("Top &#x10FFFF; end")).toBe("Top \u{10FFFF} end");
  });

  it("leaves a reference past U+10FFFF as text", () => {
    expect(snippetPreview("Invoice &#x110000; attached")).toBe("Invoice &#x110000; attached");
    expect(snippetPreview("Invoice &#1114112; attached")).toBe("Invoice &#1114112; attached");
    expect(snippetPreview("Invoice &#99999999999999999999; attached")).toBe("Invoice &#99999999999999999999; attached");
    expect(snippetPreview("Invoice &#xFFFFFFFFFFFFFFFFFFFF; attached")).toBe("Invoice &#xFFFFFFFFFFFFFFFFFFFF; attached");
  });

  it("leaves a surrogate half and zero as text", () => {
    expect(snippetPreview("a &#xD800; b")).toBe("a &#xD800; b");
    expect(snippetPreview("a &#57343; b")).toBe("a &#57343; b");
    expect(snippetPreview("a &#0; b")).toBe("a &#0; b");
    expect(snippetPreview("a &#x0; b")).toBe("a &#x0; b");
  });

  it("leaves a reference without its closing semicolon as text", () => {
    expect(snippetPreview("a &#x110000 b &#39 c")).toBe("a &#x110000 b &#39 c");
  });
});

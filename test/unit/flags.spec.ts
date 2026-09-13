import { describe, expect, it } from "vitest";
import { flagsToKeywords, keywordsToFlags, keywordToFlag, flagToKeyword } from "../../src/mapping/flags.js";

describe("flags ↔ keywords", () => {
  it("maps system flags both ways", () => {
    expect(flagToKeyword("\\Seen")).toBe("$seen");
    expect(flagToKeyword("\\Flagged")).toBe("$flagged");
    expect(flagToKeyword("$Forwarded")).toBe("$forwarded");
    expect(keywordToFlag("$seen")).toBe("\\Seen");
    expect(keywordToFlag("$flagged")).toBe("\\Flagged");
  });
  it("ignores unknown system flags (\\X) on the way back", () => {
    expect(flagToKeyword("\\Recent")).toBeNull();
  });
  it("preserves user-defined flags case-insensitively", () => {
    expect(flagToKeyword("MyLabel")).toBe("mylabel");
    expect(keywordToFlag("mylabel")).toBe("mylabel");
    expect(keywordToFlag("$label:pink")).toBe("$label:pink");
  });
  it("accepts every atom character, the slash of nested tags included", () => {
    expect(keywordToFlag("$label:red")).toBe("$label:red");
    expect(keywordToFlag("project/2026")).toBe("project/2026");
  });
  it("rejects what neither an IMAP atom nor a JMAP keyword may contain", () => {
    for (const bad of ["bad space", "bad*star", 'bad"quote', "bad(paren", "bad]bracket", "bad%percent", "\\Seen", "tab\there", "accentué", ""]) {
      expect(() => keywordToFlag(bad), bad).toThrow();
    }
    expect(() => keywordToFlag("x".repeat(256))).toThrow();
  });
  it("roundtrips a flag set", () => {
    const flags = ["\\Seen", "\\Flagged", "MyLabel"];
    const kws = flagsToKeywords(flags);
    expect(kws).toEqual({ $seen: true, $flagged: true, mylabel: true });
    const back = keywordsToFlags(kws).sort();
    expect(back).toEqual(["\\Flagged", "\\Seen", "mylabel"]);
  });
});

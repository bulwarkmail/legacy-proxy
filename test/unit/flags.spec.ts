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
  });
  it("rejects unsafe custom keywords", () => {
    expect(() => keywordToFlag("bad space")).toThrow();
    expect(() => keywordToFlag("bad/slash")).toThrow();
  });
  it("roundtrips a flag set", () => {
    const flags = ["\\Seen", "\\Flagged", "MyLabel"];
    const kws = flagsToKeywords(flags);
    expect(kws).toEqual({ $seen: true, $flagged: true, mylabel: true });
    const back = keywordsToFlags(kws).sort();
    expect(back).toEqual(["\\Flagged", "\\Seen", "mylabel"]);
  });
});

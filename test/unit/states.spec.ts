import { describe, expect, it } from "vitest";
import { encodeEmailState, decodeEmailState, encodeCounterState, decodeCounterState } from "../../src/state/states.js";

describe("state codecs", () => {
  it("email state roundtrips", () => {
    const s = { uidvalidity: 1742343, modseq: 999_888 };
    expect(decodeEmailState(encodeEmailState(s))).toEqual(s);
  });
  it("counter state roundtrips", () => {
    expect(decodeCounterState(encodeCounterState(0))).toBe(0);
    expect(decodeCounterState(encodeCounterState(123_456))).toBe(123_456);
  });
  it("rejects malformed input", () => {
    expect(() => decodeCounterState("AAAAAA")).toThrow();
  });
});

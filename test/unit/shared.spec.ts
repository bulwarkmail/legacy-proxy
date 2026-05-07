import { describe, expect, it } from "vitest";
import {
  changesOrCannotCalculate,
  queryChangesOrCannotCalculate,
} from "../../src/jmap/methods/_shared.js";
import { JmapError } from "../../src/jmap/errors.js";

describe("changesOrCannotCalculate", () => {
  it("returns an empty diff when state matches", () => {
    const r = changesOrCannotCalculate("1", "abc", "abc");
    expect(r.created).toEqual([]);
    expect(r.updated).toEqual([]);
    expect(r.destroyed).toEqual([]);
    expect(r.hasMoreChanges).toBe(false);
    expect(r.oldState).toBe("abc");
    expect(r.newState).toBe("abc");
  });
  it("throws cannotCalculateChanges when state has moved", () => {
    expect(() => changesOrCannotCalculate("1", "old", "new")).toThrow(JmapError);
    try {
      changesOrCannotCalculate("1", "old", "new");
    } catch (e) {
      expect((e as JmapError).type).toBe("cannotCalculateChanges");
    }
  });
});

describe("queryChangesOrCannotCalculate", () => {
  it("returns empty added/removed when state matches", () => {
    const r = queryChangesOrCannotCalculate("1", "qs", "qs");
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([]);
  });
  it("throws cannotCalculateChanges when state has moved", () => {
    expect(() => queryChangesOrCannotCalculate("1", "old", "new")).toThrow(JmapError);
  });
});

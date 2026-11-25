import { afterEach, expect, it } from "vitest";
import { applyPatch } from "../../src/jmap/methods/dav.js";

// The ContactCard and CalendarEvent /set handlers apply client
// patches with applyPatch (RFC 8620 §5.3).

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>).polluted;
});

it("refuses a path that reaches a prototype, and changes nothing", () => {
  const target: Record<string, unknown> = { emails: { e1: { address: "a@x.io" } } };
  for (const path of ["__proto__/polluted", "emails/__proto__/polluted", "constructor/prototype/polluted", "emails/e1/__proto__", "prototype"]) {
    expect(() => applyPatch(target, { [path]: "yes" })).toThrow(expect.objectContaining({ type: "invalidPatch" }));
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect(target).toEqual({ emails: { e1: { address: "a@x.io" } } });
});

it("walks only into own properties", () => {
  const inherited = { shared: { kept: 1 } };
  const target = Object.create(inherited) as Record<string, unknown>;
  applyPatch(target, { "shared/added": 2 });
  expect(inherited.shared).toEqual({ kept: 1 });
  expect(Object.hasOwn(target, "shared")).toBe(true);
  expect(target.shared).toEqual({ added: 2 });
});

it("still sets, replaces and removes along a path", () => {
  const target: Record<string, unknown> = { emails: { e1: { address: "a@x.io" } }, name: "A" };
  applyPatch(target, { "emails/e2/address": "b@x.io", "emails/e1": null, name: "B", "a~1b": 1 });
  expect(target).toEqual({ emails: { e2: { address: "b@x.io" } }, name: "B", "a/b": 1 });
});

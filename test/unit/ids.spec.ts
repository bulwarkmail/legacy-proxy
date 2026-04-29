import { describe, it, expect } from "vitest";
import {
  encodeEmailId,
  decodeEmailId,
  encodeMailboxId,
  decodeMailboxId,
  encodeBlobId,
  decodeBlobId,
} from "../../src/mapping/ids.js";

describe("id codecs", () => {
  it("emailId roundtrips", () => {
    const parts = { accountIdx: 7, mailboxIdx: 3, uidvalidity: 1742343, uid: 99812 };
    const enc = encodeEmailId(parts);
    expect(decodeEmailId(enc)).toEqual(parts);
  });
  it("emailId is url-safe", () => {
    const enc = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 3, uid: 4 });
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("mailboxId roundtrips", () => {
    const parts = { accountIdx: 12, mailboxIdx: 4096 };
    expect(decodeMailboxId(encodeMailboxId(parts))).toEqual(parts);
  });
  it("blobId roundtrips with and without partId", () => {
    const eid = encodeEmailId({ accountIdx: 1, mailboxIdx: 2, uidvalidity: 3, uid: 4 });
    expect(decodeBlobId(encodeBlobId(eid))).toEqual({ emailId: eid, partId: null });
    expect(decodeBlobId(encodeBlobId(eid, "1.2"))).toEqual({ emailId: eid, partId: "1.2" });
  });
  it("rejects unknown blob prefix", () => {
    expect(() => decodeBlobId("Xfoo")).toThrow();
  });
});

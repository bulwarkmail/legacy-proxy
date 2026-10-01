import { describe, expect, it, vi } from "vitest";
import { dispatch, SIDE_RESPONSES, type DispatchContext } from "../../src/jmap/router.js";
import * as mailbox from "../../src/jmap/methods/mailbox.js";
import { JmapError } from "../../src/jmap/errors.js";
import { makeLegacyMethods, type LegacyContext } from "../../src/backends/legacy.js";

const MAIL = "urn:ietf:params:jmap:mail";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const context = (methods: DispatchContext["methods"]): DispatchContext => ({
  methods, maxCallsInRequest: 100, sessionState: "backend-state",
});

describe("backend-independent dispatch", () => {
  it("resolves query/get references without any legacy transport or store", async () => {
    const get = vi.fn(async (args) => ({ list: args.ids }));
    const result = await dispatch({ using: [MAIL], methodCalls: [
      ["Email/query", {}, "q"],
      ["Email/get", { "#ids": { resultOf: "q", name: "Email/query", path: "/ids" } }, "g"],
    ] }, context({
      "Email/query": async () => ({ ids: ["gmail-message"] }),
      "Email/get": get,
    }));
    expect(get).toHaveBeenCalledWith({ ids: ["gmail-message"] });
    expect(result.methodResponses[1]).toEqual(["Email/get", { list: ["gmail-message"] }, "g"]);
    expect(result.sessionState).toBe("backend-state");
  });

  it("preserves mutation barriers, creation references and implicit responses", async () => {
    const events: string[] = [];
    const result = await dispatch({ using: [MAIL, SUBMISSION], methodCalls: [
      ["Email/get", {}, "before"],
      ["Email/set", { create: { draft: {} } }, "create"],
      ["EmailSubmission/set", { create: { submission: { emailId: "#draft" } } }, "send"],
      ["Email/get", {}, "after"],
    ] }, context({
      "Email/get": async () => { events.push("read"); return {}; },
      "Email/set": async () => { await Promise.resolve(); events.push("create"); return { created: { draft: { id: "message-1" } } }; },
      "EmailSubmission/set": async (args) => {
        expect(args).toEqual({ create: { submission: { emailId: "message-1" } } });
        events.push("send");
        return { created: { submission: { id: "submission-1" } }, [SIDE_RESPONSES]: [["Email/set", { updated: { "message-1": null } }, ""]] };
      },
    }));
    expect(events).toEqual(["read", "create", "send", "read"]);
    expect(result.createdIds).toEqual({ draft: "message-1", submission: "submission-1" });
    expect(result.methodResponses.map(([name, , id]) => [name, id])).toEqual([
      ["Email/get", "before"], ["Email/set", "create"], ["EmailSubmission/set", "send"], ["Email/set", "send"], ["Email/get", "after"],
    ]);
  });

  it("does not invoke gated methods or inherited object properties", async () => {
    const get = vi.fn(async () => ({}));
    const result = await dispatch({ using: [], methodCalls: [
      ["Email/get", {}, "g"], ["toString", {}, "unknown"],
    ] }, context({ "Email/get": get }));
    expect(get).not.toHaveBeenCalled();
    expect(result.methodResponses.map(([, args]) => args.type)).toEqual(["unknownMethod", "unknownMethod"]);
  });

  it("contains backend errors to their calls", async () => {
    const result = await dispatch({ using: [MAIL], methodCalls: [
      ["Email/query", {}, "bad"], ["Email/get", {}, "good"],
    ] }, context({
      "Email/query": async () => { throw new JmapError("unsupportedFilter", "unsupported"); },
      "Email/get": async () => ({ list: [] }),
    }));
    expect(result.methodResponses[0]?.[1].type).toBe("unsupportedFilter");
    expect(result.methodResponses[1]).toEqual(["Email/get", { list: [] }, "good"]);
  });
});

describe("legacy method binding", () => {
  it("routes Mailbox/get through the interactive IMAP pool with the bound account", async () => {
    const client = {};
    const account = { id: 7 };
    const store = {};
    const get = vi.spyOn(mailbox, "mailboxGet").mockResolvedValue({ accountId: "7", state: "m1", list: [], notFound: [] });
    const withConnection = vi.fn(async (_account, _lane, operation) => operation(client));
    const ctx = { account, store, pool: { withConnection } } as unknown as LegacyContext;
    try {
      const result = await dispatch({ using: [MAIL], methodCalls: [["Mailbox/get", { accountId: "7" }, "m"]] }, context(makeLegacyMethods(ctx)));
      expect(withConnection).toHaveBeenCalledWith(account, "interactive", expect.any(Function));
      expect(get).toHaveBeenCalledWith({ accountId: "7" }, { account, client, store });
      expect(result.methodResponses[0]).toEqual(["Mailbox/get", { accountId: "7", state: "m1", list: [], notFound: [] }, "m"]);
    } finally {
      get.mockRestore();
    }
  });

  it("binds concurrent requests to their own accounts and keeps IMAP lazy", async () => {
    const makeContext = (id: number) => {
      const withConnection = vi.fn();
      const store = {};
      return { ctx: { account: { id }, pool: { withConnection }, store } as unknown as LegacyContext, withConnection };
    };
    const a = makeContext(7);
    const b = makeContext(8);
    // SearchSnippet/get is account-scoped but requires no network connection.
    const results = await Promise.all([a, b].map(async ({ ctx }) => {
      const methods = makeLegacyMethods(ctx);
      return dispatch({ using: [MAIL], methodCalls: [["SearchSnippet/get", { accountId: String(ctx.account.id), emailIds: ["message"] }, "s"]] }, context(methods));
    }));
    expect(results.map((r) => r.methodResponses[0]?.[1].accountId)).toEqual(["7", "8"]);
    expect(a.withConnection).not.toHaveBeenCalled();
    expect(b.withConnection).not.toHaveBeenCalled();
  });
});

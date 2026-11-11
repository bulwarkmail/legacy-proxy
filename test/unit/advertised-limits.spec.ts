// The dispatcher enforces the maxObjectsInGet and maxObjectsInSet the session advertises, for
// every /get and /set method, before the handler runs. The limits are in the dispatch context next
// to maxCallsInRequest, named like the capability properties.

import { describe, expect, it } from "vitest";
import { dispatch, type MethodCall } from "../../src/jmap/router.js";
import { coreCapabilityProps } from "../../src/jmap/capabilities.js";
import type { AppConfig } from "../../src/util/config.js";

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const CONTACTS = "urn:ietf:params:jmap:contacts";
const SUBMISSION = "urn:ietf:params:jmap:submission";
const VACATION = "urn:ietf:params:jmap:vacationresponse";
const USING = [CORE, MAIL, CONTACTS, SUBMISSION, VACATION];

const limits = { maxConcurrentRequests: 10, maxObjectsInGet: 500, maxObjectsInSet: 500, maxSizeUpload: 1, maxSizeRequest: 1, maxCallsInRequest: 64 };
const ids = (n: number) => Array.from({ length: n }, (_, i) => `id${i}`);
const objects = (n: number) => Object.fromEntries(ids(n).map((id) => [id, {}]));

type Handler = (args: Record<string, unknown>) => Promise<unknown>;

/** A dispatcher whose handlers only record that they ran. */
function world(extra: Record<string, Handler> = {}) {
  const ran: string[] = [];
  const names = ["Email/get", "Mailbox/get", "Thread/get", "Identity/get", "ContactCard/get", "AddressBook/get", "EmailSubmission/get", "Email/set", "Mailbox/set", "ContactCard/set", "EmailSubmission/set", "Identity/set"];
  const methods: Record<string, Handler> = {};
  for (const name of names) {
    methods[name] = async () => {
      ran.push(name);
      return { ok: true };
    };
  }
  Object.assign(methods, extra);
  const ctx = {
    methods,
    maxCallsInRequest: limits.maxCallsInRequest,
    maxObjectsInGet: limits.maxObjectsInGet,
    maxObjectsInSet: limits.maxObjectsInSet,
    sessionState: "s1",
  } as unknown as Parameters<typeof dispatch>[1];
  const run = async (calls: MethodCall[]) => (await dispatch({ using: USING, methodCalls: calls }, ctx)).methodResponses;
  return { ran, run };
}

const errorType = (response: unknown) => {
  const [name, body] = response as [string, { type?: string }];
  return name === "error" ? body.type : `no error (${name})`;
};

describe("advertised limits are enforced", () => {
  it("advertises the limits it enforces", () => {
    const props = coreCapabilityProps({ limits } as AppConfig);
    expect(props.maxObjectsInGet).toBe(500);
    expect(props.maxObjectsInSet).toBe(500);
  });

  for (const method of ["Email/get", "Mailbox/get", "Thread/get", "Identity/get", "ContactCard/get", "AddressBook/get", "EmailSubmission/get"]) {
    it(`refuses ${method} with more ids than maxObjectsInGet, before the handler runs`, async () => {
      const { ran, run } = world();
      const [over, at] = await run([
        [method, { accountId: "1", ids: ids(501) }, "over"],
        [method, { accountId: "1", ids: ids(500) }, "at"],
      ]);
      expect(errorType(over)).toBe("requestTooLarge");
      expect(at[0]).toBe(method);
      expect(ran).toEqual([method]);
    });
  }

  for (const method of ["Email/set", "Mailbox/set", "ContactCard/set", "EmailSubmission/set", "Identity/set"]) {
    it(`refuses ${method} with more objects than maxObjectsInSet, counted over create, update and destroy`, async () => {
      const { ran, run } = world();
      const responses = await run([
        [method, { accountId: "1", destroy: ids(501) }, "destroy"],
        [method, { accountId: "1", create: objects(501) }, "create"],
        [method, { accountId: "1", update: objects(501) }, "update"],
        [method, { accountId: "1", create: objects(200), update: objects(200), destroy: ids(101) }, "together"],
        [method, { accountId: "1", create: objects(200), update: objects(200), destroy: ids(100) }, "at"],
      ]);
      expect(responses.slice(0, 4).map(errorType)).toEqual(["requestTooLarge", "requestTooLarge", "requestTooLarge", "requestTooLarge"]);
      expect(responses[4][0]).toBe(method);
      expect(ran).toEqual([method]);
    });
  }

  it("counts ids that arrive through a result reference", async () => {
    const { ran, run } = world({ "Email/query": async () => ({ ids: ids(501) }) });
    const responses = await run([
      ["Email/query", { accountId: "1" }, "q"],
      ["Email/get", { accountId: "1", "#ids": { resultOf: "q", name: "Email/query", path: "/ids" } }, "g"],
    ]);
    expect(errorType(responses[1])).toBe("requestTooLarge");
    expect(ran).toEqual([]);
  });

  it("leaves a get without ids alone (ids: null asks for everything the method allows)", async () => {
    const { ran, run } = world();
    const [response] = await run([["Mailbox/get", { accountId: "1", ids: null }, "all"]]);
    expect(response[0]).toBe("Mailbox/get");
    expect(ran).toEqual(["Mailbox/get"]);
  });
});

describe("the same counts for the methods that take objects under other names", () => {
  const recorder = (ran: string[], name: string): Handler => async () => {
    ran.push(name);
    return { ok: true };
  };

  it("counts SearchSnippet/get emailIds and Email/parse blobIds against maxObjectsInGet", async () => {
    const ran: string[] = [];
    const { run } = world({ "SearchSnippet/get": recorder(ran, "SearchSnippet/get"), "Email/parse": recorder(ran, "Email/parse") });
    const responses = await run([
      ["SearchSnippet/get", { accountId: "1", emailIds: ids(501) }, "s-over"],
      ["Email/parse", { accountId: "1", blobIds: ids(501) }, "p-over"],
      ["SearchSnippet/get", { accountId: "1", emailIds: ids(500) }, "s-at"],
      ["Email/parse", { accountId: "1", blobIds: ids(500) }, "p-at"],
    ]);
    expect(responses.slice(0, 2).map(errorType)).toEqual(["requestTooLarge", "requestTooLarge"]);
    expect(ran).toEqual(["SearchSnippet/get", "Email/parse"]);
  });

  it("counts Email/copy create and Email/import emails against maxObjectsInSet", async () => {
    const ran: string[] = [];
    const { run } = world({ "Email/copy": recorder(ran, "Email/copy"), "Email/import": recorder(ran, "Email/import") });
    const responses = await run([
      ["Email/copy", { accountId: "1", fromAccountId: "2", create: objects(501) }, "c-over"],
      ["Email/import", { accountId: "1", emails: objects(501) }, "i-over"],
      ["Email/copy", { accountId: "1", fromAccountId: "2", create: objects(500) }, "c-at"],
      ["Email/import", { accountId: "1", emails: objects(500) }, "i-at"],
    ]);
    expect(responses.slice(0, 2).map(errorType)).toEqual(["requestTooLarge", "requestTooLarge"]);
    expect(ran).toEqual(["Email/copy", "Email/import"]);
  });
});

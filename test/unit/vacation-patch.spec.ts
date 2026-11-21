// VacationResponse/set applies its update as a patch (RFC 8620 §5.3): what
// the patch does not name stays as the server holds it.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vacationGet, vacationSet } from "../../src/jmap/methods/vacation.js";
import { Store } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";

/** A ManageSieve server that keeps its scripts and the commands it was sent. */
class Server {
  scripts = new Map<string, string>();
  active: string | null = null;
  commands: string[] = [];
  sessions = 0;
  /** When set, what GETSCRIPT answers in place of the script. */
  getAnswer: string | null = null;
  private server!: net.Server;

  async listen(): Promise<number> {
    this.server = net.createServer((sock) => {
      this.sessions += 1;
      sock.on("error", () => {});
      sock.write(`"IMPLEMENTATION" "test"\r\n"SASL" "PLAIN"\r\n"SIEVE" "fileinto vacation date relational"\r\nOK "ready"\r\n`);
      let buf = Buffer.alloc(0);
      let put: { name: string; size: number } | null = null;
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (put) {
            if (buf.length < put.size + 2) return;
            this.scripts.set(put.name, buf.subarray(0, put.size).toString("utf8"));
            buf = buf.subarray(put.size + 2);
            put = null;
            sock.write("OK\r\n");
            continue;
          }
          const i = buf.indexOf("\r\n");
          if (i < 0) return;
          const line = buf.subarray(0, i).toString("utf8");
          buf = buf.subarray(i + 2);
          const verb = line.split(" ")[0]!.toUpperCase();
          const name = /"([^"]*)"/.exec(line)?.[1] ?? "";
          if (verb === "AUTHENTICATE") continue; // the blob follows on the next line
          if (!/^[A-Z]+$/.test(verb) || !["LISTSCRIPTS", "GETSCRIPT", "PUTSCRIPT", "SETACTIVE", "LOGOUT"].includes(verb)) {
            sock.write("OK\r\n"); // the SASL blob
            continue;
          }
          this.commands.push(verb === "LISTSCRIPTS" || verb === "LOGOUT" ? verb : `${verb} "${name}"`);
          if (verb === "PUTSCRIPT") {
            put = { name, size: Number(/\{(\d+)\+\}$/.exec(line)![1]) };
          } else if (verb === "LISTSCRIPTS") {
            for (const n of this.scripts.keys()) sock.write(`"${n}"${this.active === n ? " ACTIVE" : ""}\r\n`);
            sock.write("OK\r\n");
          } else if (verb === "GETSCRIPT" && this.getAnswer !== null) {
            sock.write(this.getAnswer);
          } else if (verb === "GETSCRIPT") {
            const body = this.scripts.get(name);
            sock.write(body === undefined ? 'NO (NONEXISTENT) "no such script"\r\n' : `{${Buffer.byteLength(body)}}\r\n${body}\r\nOK\r\n`);
          } else if (verb === "SETACTIVE") {
            this.active = name === "" ? null : name;
            sock.write("OK\r\n");
          } else {
            sock.end('OK "bye"\r\n');
            return;
          }
        }
      });
    });
    return new Promise<number>((r) => this.server.listen(0, "127.0.0.1", () => r((this.server.address() as net.AddressInfo).port)));
  }

  close(): void {
    this.server.close();
  }
}

const AWAY = {
  isEnabled: true,
  fromDate: "2026-12-24T00:00:00Z",
  toDate: "2027-01-06T00:00:00Z",
  subject: "Away",
  textBody: "Back in January.",
  htmlBody: "<p>Back in January.</p>",
};

describe("VacationResponse/set as a patch", () => {
  let server: Server;
  let dir: string;
  let store: Store;
  let ctx: Parameters<typeof vacationSet>[1];
  let accountId: string;

  beforeEach(async () => {
    server = new Server();
    const port = await server.listen();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-vacation-patch-"));
    store = new Store(dir);
    const account = store.upsertAccount({ slug: "generic:u", kind: "generic", host: "h", username: "u", vault: Buffer.from("x") });
    accountId = String(account.id);
    ctx = {
      account,
      provider: { imap: { host: "h", port: 993 }, smtp: { host: "h", port: 587 }, sieve: { host: "127.0.0.1", port }, carddav: null, auth: { mech: ["PLAIN"] } } as unknown as ProviderConfig,
      creds: { mech: "PLAIN" as const, username: "u", password: "fake-password" },
      store,
    };
  });

  afterEach(() => {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const set = (singleton: Record<string, unknown>) => vacationSet({ accountId, update: { singleton } }, ctx) as Promise<Record<string, unknown>>;
  /** What the server holds, read without the proxy's memory of its last write. */
  const stored = async () => {
    store.bumpState(ctx.account.id, "vacation");
    return (await vacationGet({ accountId }, ctx)).list[0];
  };

  it("switches the responder off and keeps the message and its dates", async () => {
    await set(AWAY);
    const res = await set({ isEnabled: false });
    expect(res.updated).toEqual({ singleton: null });
    expect(await stored()).toEqual({ id: "singleton", ...AWAY, isEnabled: false });
  });

  it("changes the one property it names", async () => {
    await set(AWAY);
    await set({ subject: "Out of office" });
    expect(await stored()).toEqual({ id: "singleton", ...AWAY, subject: "Out of office" });
    expect(server.active).not.toBeNull();
  });

  it("clears a property set to null, and that one only", async () => {
    await set(AWAY);
    await set({ toDate: null, htmlBody: null });
    expect(await stored()).toEqual({ id: "singleton", ...AWAY, toDate: null, htmlBody: null });
  });

  it("answers the next VacationResponse/get with the whole response, not the patch", async () => {
    await set(AWAY);
    await set({ isEnabled: false });
    expect((await vacationGet({ accountId }, ctx)).list[0]).toEqual({ id: "singleton", ...AWAY, isEnabled: false });
  });

  it("reads the stored response for a partial patch, and not for a complete one", async () => {
    await set(AWAY);
    const verbs = () => server.commands.map((c) => c.split(" ")[0]);
    expect(verbs()).toContain("PUTSCRIPT");
    expect(verbs()).not.toContain("GETSCRIPT");
    server.commands = [];
    await set({ isEnabled: false });
    expect(verbs().indexOf("GETSCRIPT")).toBeGreaterThanOrEqual(0);
    expect(verbs().indexOf("GETSCRIPT")).toBeLessThan(verbs().indexOf("PUTSCRIPT"));
  });

  it("starts from a blank response when the server has none", async () => {
    await set({ subject: "Away" });
    expect(await stored()).toEqual({ id: "singleton", isEnabled: false, fromDate: null, toDate: null, subject: "Away", textBody: null, htmlBody: null });
  });

  it("refuses a start that falls after the stored end, and writes nothing", async () => {
    await set(AWAY);
    const before = [...server.scripts];
    const res = await set({ fromDate: "2027-02-01T00:00:00Z" });
    expect(res.updated).toBeNull();
    expect(res.notUpdated).toEqual({ singleton: expect.objectContaining({ type: "invalidProperties", properties: ["fromDate", "toDate"] }) });
    expect(res.newState).toBe(res.oldState);
    expect([...server.scripts]).toEqual(before);
  });

  it("writes nothing when the singleton is not in the update", async () => {
    await set(AWAY);
    const before = [...server.scripts];
    const active = server.active;
    const sessions = server.sessions;
    for (const update of [undefined, null, {}, { other: { isEnabled: false } }]) {
      const res = (await vacationSet({ accountId, update } as Parameters<typeof vacationSet>[0], ctx)) as Record<string, unknown>;
      expect(res.updated).toBeNull();
      expect(res.newState).toBe(res.oldState);
    }
    expect(server.sessions).toBe(sessions);
    expect([...server.scripts]).toEqual(before);
    expect(server.active).toBe(active);
  });

  it("leaves the update alone when it is not an object", async () => {
    await set(AWAY);
    const before = [...server.scripts];
    const res = (await vacationSet({ accountId, update: { singleton: ["isEnabled"] } } as unknown as Parameters<typeof vacationSet>[0], ctx)) as Record<string, unknown>;
    expect(res.updated).toBeNull();
    expect([...server.scripts]).toEqual(before);
  });

  describe("when the stored response cannot be read", () => {
    it.each([
      ["a NO", 'NO "Internal error"\r\n'],
      ["a NO with another response code", 'NO (TRYLATER) "Busy"\r\n'],
      ["a line that is no answer", "* garbage\r\n"],
      ["a body followed by NO", '{5}\r\nkeep;\r\nNO "Read failed"\r\n'],
    ])("fails a partial update on %s, and writes nothing", async (_label, answer) => {
      await set(AWAY);
      const before = [...server.scripts];
      const state = (await vacationGet({ accountId }, ctx)).state;
      server.getAnswer = answer;
      server.commands = [];

      await expect(set({ isEnabled: false })).rejects.toThrow();

      expect(server.commands.some((c) => c.startsWith("PUTSCRIPT") || c.startsWith("SETACTIVE"))).toBe(false);
      expect([...server.scripts]).toEqual(before);
      expect(server.active).not.toBeNull();
      // Neither the state nor what VacationResponse/get remembers moved.
      const after = await vacationGet({ accountId }, ctx);
      expect(after.state).toBe(state);
      expect(after.list[0]).toEqual({ id: "singleton", ...AWAY });
    });

    it("still writes a complete update, which needs no read", async () => {
      await set(AWAY);
      server.getAnswer = 'NO "Internal error"\r\n';
      const res = await set({ ...AWAY, isEnabled: false, subject: "Gone" });
      expect(res.updated).toEqual({ singleton: null });
      server.getAnswer = null;
      expect(await stored()).toEqual({ id: "singleton", ...AWAY, isEnabled: false, subject: "Gone" });
    });

    it("starts from a blank, disabled response when the server says the script is gone", async () => {
      await set(AWAY);
      server.getAnswer = 'NO (NONEXISTENT) "There is no script by that name"\r\n';
      const res = await set({ subject: "Away again" });
      expect(res.updated).toEqual({ singleton: null });
      server.getAnswer = null;
      expect(await stored()).toEqual({ id: "singleton", isEnabled: false, fromDate: null, toDate: null, subject: "Away again", textBody: null, htmlBody: null });
    });

    it("goes on answering VacationResponse/get with a blank response", async () => {
      await set(AWAY);
      server.getAnswer = 'NO "Internal error"\r\n';
      expect(await stored()).toEqual({ id: "singleton", isEnabled: true, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null });
    });
  });

  describe("an id other than the singleton", () => {
    const strangers = { other: { type: "notFound" }, "": { type: "notFound" } };

    it("is notFound, with nothing written and no ManageSieve session", async () => {
      const sessions = server.sessions;
      const res = (await vacationSet({ accountId, update: { other: { isEnabled: true }, "": {} } }, ctx)) as Record<string, unknown>;
      expect(res.updated).toBeNull();
      expect(res.notUpdated).toEqual(strangers);
      expect(res.newState).toBe(res.oldState);
      expect(server.sessions).toBe(sessions);
    });

    it("is notFound next to a singleton that is updated", async () => {
      const res = (await vacationSet({ accountId, update: { singleton: AWAY, other: {}, "": {} } }, ctx)) as Record<string, unknown>;
      expect(res.updated).toEqual({ singleton: null });
      expect(res.notUpdated).toEqual(strangers);
      expect(await stored()).toEqual({ id: "singleton", ...AWAY });
    });

    it("is notFound next to a singleton that is refused", async () => {
      const res = (await vacationSet({ accountId, update: { singleton: { fromDate: "next week" }, other: {}, "": {} } }, ctx)) as Record<string, unknown>;
      expect(res.updated).toBeNull();
      expect(res.notUpdated).toEqual({ ...strangers, singleton: expect.objectContaining({ type: "invalidProperties", properties: ["fromDate"] }) });
    });
  });
});

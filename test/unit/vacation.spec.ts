import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateScript, writeVacation } from "../../src/sieve/vacation.js";
import type { SieveClient } from "../../src/sieve/client.js";
import { vacationSet } from "../../src/jmap/methods/vacation.js";
import { Store } from "../../src/state/store.js";
import type { ProviderConfig } from "../../src/util/config.js";

type Token = { t: "id" | "tag" | "str" | "num" | "punct"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new Error("unterminated comment");
      i = end + 2;
    } else if (c === '"') {
      let s = "";
      for (i++; ; ) {
        if (i >= src.length) throw new Error("unterminated string");
        const ch = src[i]!;
        if (ch === "\\") {
          s += src[i + 1] ?? "";
          i += 2;
        } else if (ch === '"') {
          i++;
          break;
        } else {
          s += ch;
          i++;
        }
      }
      out.push({ t: "str", v: s });
    } else {
      const m = /^(?:([0-9]+[KMG]?)|(:[A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)|([[\](){},;]))/.exec(src.slice(i));
      if (!m) throw new Error(`unexpected ${JSON.stringify(c)} at ${i}`);
      out.push({ t: m[1] ? "num" : m[2] ? "tag" : m[3] ? "id" : "punct", v: m[0] });
      i += m[0].length;
    }
  }
  return out;
}

/**
 * Parses a Sieve script by the grammar of RFC 5228 §8.2 (commands, blocks,
 * tests, test lists, tagged, number and string-list arguments) and answers
 * the commands, tests and required extensions it uses. Throws on anything
 * the grammar doesn't allow.
 */
function parseSieve(src: string): { commands: string[]; tests: string[]; requires: string[] } {
  const toks = tokenize(src);
  let p = 0;
  const used = { commands: [] as string[], tests: [] as string[], requires: [] as string[] };
  const isP = (v: string) => toks[p]?.t === "punct" && toks[p]?.v === v;
  const expectP = (v: string) => {
    if (!isP(v)) throw new Error(`expected ${v} at token ${p} (${JSON.stringify(toks[p])})`);
    p++;
  };
  const stringList = (): string[] => {
    if (toks[p]?.t === "str") return [toks[p++]!.v];
    expectP("[");
    const out: string[] = [];
    for (;;) {
      if (toks[p]?.t !== "str") throw new Error(`expected a string at token ${p}`);
      out.push(toks[p++]!.v);
      if (!isP(",")) break;
      p++;
    }
    expectP("]");
    return out;
  };
  const args = (): string[][] => {
    const lists: string[][] = [];
    for (;;) {
      const tk = toks[p];
      if (tk?.t === "tag" || tk?.t === "num") p++;
      else if (tk?.t === "str" || isP("[")) lists.push(stringList());
      else return lists;
    }
  };
  const test = (): void => {
    const id = toks[p];
    if (id?.t !== "id") throw new Error(`expected a test at token ${p}`);
    p++;
    used.tests.push(id.v);
    args();
    if (isP("(")) testList();
    else if (toks[p]?.t === "id") test();
  };
  const testList = (): void => {
    expectP("(");
    test();
    while (isP(",")) {
      p++;
      test();
    }
    expectP(")");
  };
  const command = (): void => {
    const id = toks[p];
    if (id?.t !== "id") throw new Error(`expected a command at token ${p}`);
    p++;
    used.commands.push(id.v);
    const lists = args();
    if (id.v === "require") used.requires.push(...lists.flat());
    if (isP("(")) testList();
    else if (toks[p]?.t === "id") test();
    if (isP(";")) {
      p++;
      return;
    }
    expectP("{");
    while (!isP("}")) command();
    expectP("}");
  };
  while (p < toks.length) command();
  return used;
}

const DATE_EXTENSIONS = new Set(["fileinto", "vacation", "date", "relational"]);

describe("vacation Sieve script", () => {
  it("emits a vacation action when enabled", () => {
    const s = generateScript({
      isEnabled: true,
      subject: "Out of office",
      textBody: "Back next week.",
      fromDate: null,
      toDate: null,
      htmlBody: null,
    });
    expect(s).toContain('require ["vacation"];');
    expect(s).toContain("vacation");
    expect(s).toContain(":subject \"Out of office\"");
    expect(s).toContain("\"Back next week.\"");
  });

  it("preserves subject/text/html through markers when disabled", () => {
    // The disabled script still carries the user's last-edited fields so
    // re-enabling later doesn't blank them.
    const s = generateScript({
      isEnabled: false,
      subject: "S",
      textBody: "T",
      htmlBody: "<b>H</b>",
      fromDate: "2025-01-01T00:00:00Z",
      toDate: "2025-01-08T00:00:00Z",
    });
    expect(s).toContain("# bulwark-vacation: disabled");
    expect(s).not.toMatch(/^vacation\b/m);
    expect(s).toContain("# bulwark.subject=" + Buffer.from("S").toString("base64"));
    expect(s).toContain("# bulwark.text=" + Buffer.from("T").toString("base64"));
    expect(s).toContain("# bulwark.html=" + Buffer.from("<b>H</b>").toString("base64"));
    expect(s).toContain("# bulwark.from=" + Buffer.from("2025-01-01T00:00:00Z").toString("base64"));
    expect(s).toContain("# bulwark.to=" + Buffer.from("2025-01-08T00:00:00Z").toString("base64"));
  });

  it("escapes embedded quotes and backslashes in body", () => {
    const s = generateScript({
      isEnabled: true,
      textBody: 'He said "hi" \\ then left',
      subject: null,
      htmlBody: null,
      fromDate: null,
      toDate: null,
    });
    expect(s).toContain('"He said \\"hi\\" \\\\ then left"');
  });

  it("the grammar check refuses scripts that don't parse", () => {
    for (const bad of [
      'vacation "x"',
      'if allof (true { vacation "x"; }',
      'if true { vacation "x";',
      'require ["vacation" "date"];',
      'vacation :days 1 "unterminated;',
    ]) {
      expect(() => parseSieve(bad), bad).toThrow();
    }
  });

  it("every script it writes parses as Sieve and requires what it uses", () => {
    const scripts = [
      generateScript({ isEnabled: true, subject: "S", textBody: "T" }),
      generateScript({ isEnabled: false, subject: "S", fromDate: "2026-12-24T00:00:00Z" }),
      generateScript({ isEnabled: true, fromDate: "2026-12-24T00:00:00Z", toDate: "2027-01-06T08:30:00Z" }),
      generateScript({ isEnabled: true, fromDate: "2026-12-24T00:00:00Z", toDate: "2027-01-06T08:30:00Z" }, DATE_EXTENSIONS),
      generateScript({ isEnabled: true, fromDate: "2026-12-24T00:00:00Z" }, DATE_EXTENSIONS),
      generateScript({ isEnabled: true, toDate: "2027-01-06T08:30:00Z" }, DATE_EXTENSIONS),
    ];
    for (const s of scripts) {
      const used = parseSieve(s);
      expect(used.requires, s).toContain("vacation");
      if (used.tests.includes("currentdate")) expect(used.requires, s).toEqual(expect.arrayContaining(["date", "relational"]));
    }
  });
});

describe("vacation start and end date", () => {
  it("does not use the start date as the sender of the auto-reply", () => {
    const script = generateScript({ isEnabled: true, fromDate: "2026-12-24T00:00:00Z", subject: "Away", textBody: "Back in January." });
    expect(script).not.toMatch(/:from\s+"2026-12-24/);
  });

  it("answers only inside the window when the server offers date and relational", () => {
    const s = generateScript(
      { isEnabled: true, fromDate: "2026-12-24T00:00:00Z", toDate: "2027-01-06T08:30:00Z", textBody: "Back in January." },
      DATE_EXTENSIONS,
    );
    expect(s).not.toMatch(/:from\b/);
    expect(s).toContain('require ["vacation", "date", "relational"];');
    expect(s).toContain('currentdate :zone "+0000" :value "gt" "date" "2026-12-24"');
    expect(s).toContain('currentdate :zone "+0000" :value "ge" "time" "00:00:00"');
    expect(s).toContain('currentdate :zone "+0000" :value "lt" "date" "2027-01-06"');
    expect(s).toContain('currentdate :zone "+0000" :value "lt" "time" "08:30:00"');
    const used = parseSieve(s);
    expect(used.commands).toEqual(["require", "if", "vacation"]);
  });

  it("ends the responder at the end date when only that is given", () => {
    const s = generateScript({ isEnabled: true, toDate: "2027-01-06T08:30:00Z" }, DATE_EXTENSIONS);
    expect(s).toContain('"lt" "date" "2027-01-06"');
    expect(s).not.toContain('"gt" "date"');
    expect(parseSieve(s).commands).toEqual(["require", "if", "vacation"]);
  });

  it("has no date test when the server lacks the extensions, and keeps the dates in the markers", () => {
    const s = generateScript(
      { isEnabled: true, fromDate: "2026-12-24T00:00:00Z", toDate: "2027-01-06T08:30:00Z" },
      new Set(["vacation", "date"]),
    );
    const used = parseSieve(s);
    expect(used.tests).not.toContain("currentdate");
    expect(used.requires).toEqual(["vacation"]);
    expect(used.commands).toEqual(["require", "vacation"]);
    expect(s).toContain("# bulwark.from=" + Buffer.from("2026-12-24T00:00:00Z").toString("base64"));
    expect(s).toContain("# bulwark.to=" + Buffer.from("2027-01-06T08:30:00Z").toString("base64"));
  });

  it("refuses a start after the end, and a date that isn't one", () => {
    expect(() =>
      generateScript({ isEnabled: true, fromDate: "2027-01-06T00:00:00Z", toDate: "2026-12-24T00:00:00Z" }, DATE_EXTENSIONS),
    ).toThrow(expect.objectContaining({ type: "invalidProperties" }));
    expect(() => generateScript({ isEnabled: true, fromDate: "next week" })).toThrow(
      expect.objectContaining({ type: "invalidProperties" }),
    );
    expect(() => generateScript({ isEnabled: false, toDate: "+275760-09-13T00:00:00Z" })).toThrow(
      expect.objectContaining({ type: "invalidProperties" }),
    );
  });

  it("asks the server which extensions it offers and writes nothing for a refused window", async () => {
    const written: string[] = [];
    const client = (sieve: string | null) =>
      ({
        capabilities: new Map(sieve === null ? [] : [["SIEVE", sieve]]),
        putScript: async (_name: string, body: string) => void written.push(body),
        setActive: async () => {},
      }) as unknown as SieveClient;
    const v = { isEnabled: true, fromDate: "2026-12-24T00:00:00Z", toDate: "2027-01-06T08:30:00Z" };

    await writeVacation(client("FILEINTO VACATION DATE RELATIONAL"), v);
    expect(written[0]).toContain("currentdate");
    await writeVacation(client("fileinto vacation"), v);
    expect(written[1]).not.toContain("currentdate");
    await writeVacation(client(null), v);
    expect(written[2]).not.toContain("currentdate");
    expect(written.join("\n")).not.toMatch(/:from\b/);

    await expect(writeVacation(client("vacation date relational"), { ...v, fromDate: "2027-02-01T00:00:00Z" })).rejects.toMatchObject({
      type: "invalidProperties",
    });
    expect(written).toHaveLength(3);
  });
});

describe("VacationResponse/set", () => {
  let server: net.Server | null = null;
  let dir: string | null = null;
  afterEach(() => {
    server?.close();
    server = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** A ManageSieve server announcing date and relational; it counts sessions and keeps each PUTSCRIPT body. */
  async function setup() {
    const seen = { sessions: 0, scripts: [] as string[] };
    server = net.createServer((sock) => {
      seen.sessions += 1;
      sock.on("error", () => {});
      sock.write(`"IMPLEMENTATION" "test"\r\n"SASL" "PLAIN"\r\n"SIEVE" "fileinto vacation date relational"\r\nOK "ready"\r\n`);
      let buf = Buffer.alloc(0);
      let literal = 0;
      sock.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          if (literal > 0) {
            if (buf.length < literal + 2) return;
            seen.scripts.push(buf.subarray(0, literal).toString("utf8"));
            buf = buf.subarray(literal + 2);
            literal = 0;
            sock.write("OK\r\n");
            continue;
          }
          const i = buf.indexOf("\r\n");
          if (i < 0) return;
          const line = buf.subarray(0, i).toString("utf8");
          buf = buf.subarray(i + 2);
          const lit = /^PUTSCRIPT "[^"]*" \{(\d+)\+\}$/.exec(line);
          if (lit) {
            literal = Number(lit[1]);
            continue;
          }
          if (line.startsWith("AUTHENTICATE")) continue; // the blob follows on the next line
          if (line.startsWith("LOGOUT")) {
            sock.end('OK "bye"\r\n');
            return;
          }
          sock.write("OK\r\n");
        }
      });
    });
    const port = await new Promise<number>((r) => server!.listen(0, "127.0.0.1", () => r((server!.address() as net.AddressInfo).port)));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lproxy-vacation-"));
    const store = new Store(dir);
    const account = store.upsertAccount({ slug: "generic:u", kind: "generic", host: "h", username: "u", vault: Buffer.from("x") });
    const ctx = {
      account,
      provider: { imap: { host: "h", port: 993 }, smtp: { host: "h", port: 587 }, sieve: { host: "127.0.0.1", port }, carddav: null, auth: { mech: ["PLAIN"] } } as unknown as ProviderConfig,
      creds: { mech: "PLAIN" as const, username: "u", password: "fake-password" },
      store,
    };
    const set = (singleton: Record<string, unknown>) => vacationSet({ accountId: String(account.id), update: { singleton } }, ctx);
    return { seen, set, close: () => store.close() };
  }

  it.each([
    ["a start after the end", { fromDate: "2027-01-06T00:00:00Z", toDate: "2026-12-24T00:00:00Z" }, ["fromDate", "toDate"]],
    ["a start that isn't a date", { fromDate: "next week" }, ["fromDate"]],
    ["an end past the year 9999", { toDate: "+275760-09-13T00:00:00Z" }, ["toDate"]],
  ])("answers %s with a SetError for the singleton, before any ManageSieve session", async (_label, dates, properties) => {
    const { seen, set, close } = await setup();
    try {
      const res = (await set({ isEnabled: true, textBody: "Away", ...dates })) as Record<string, unknown>;
      expect(res.updated).toBeNull();
      expect(res.notUpdated).toEqual({ singleton: expect.objectContaining({ type: "invalidProperties", properties }) });
      expect(res.newState).toBe(res.oldState);
      expect(seen.sessions).toBe(0);
    } finally {
      close();
    }
  });

  it("still saves good dates, with the date window", async () => {
    const { seen, set, close } = await setup();
    try {
      const res = (await set({ isEnabled: true, textBody: "Away", fromDate: "2026-12-24T00:00:00Z", toDate: "2027-01-06T00:00:00Z" })) as Record<string, unknown>;
      expect(res.updated).toEqual({ singleton: null });
      expect(res.newState).not.toBe(res.oldState);
      expect(seen.scripts[0]).toContain('currentdate :zone "+0000" :value "lt" "date" "2027-01-06"');
    } finally {
      close();
    }
  });
});

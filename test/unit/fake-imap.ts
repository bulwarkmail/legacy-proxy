// Test helper: a tiny plain-TCP IMAP server on loopback that knows users and
// passwords and records what it receives, and a loader that boots
// src/server.ts against it. Not a spec; vitest does not pick it up.

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface FakeImap {
  port: number;
  /**
   * user -> password, or the passwords the server accepts for the user (app
   * passwords); change it to simulate a password change on the mail server.
   */
  users: Record<string, string | string[]>;
  /** Every line a client sent, in order. */
  lines: string[];
  logins: number;
  failedLogins: number;
  close(): Promise<void>;
}

export async function startFakeImap(users: Record<string, string | string[]>): Promise<FakeImap> {
  const state: FakeImap = { port: 0, users, lines: [], logins: 0, failedLogins: 0, close: async () => {} };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    let authTag: string | null = null;
    let idleTag: string | null = null;
    const send = (s: string) => sock.write(s + "\r\n");
    const login = (tag: string, user: string, pass: string) => {
      state.logins++;
      const known = state.users[user];
      if (known !== undefined && (Array.isArray(known) ? known.includes(pass) : known === pass)) send(`${tag} OK logged in`);
      else {
        state.failedLogins++;
        send(`${tag} NO [AUTHENTICATIONFAILED] no`);
      }
    };
    // No STARTTLS and no LOGINDISABLED: a server that offers no upgrade.
    send("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS IDLE] ready");
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      for (;;) {
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        state.lines.push(line);
        if (authTag) {
          const tag = authTag;
          authTag = null;
          const p = Buffer.from(line, "base64").toString("utf8").split("\0");
          login(tag, p[1] ?? "", p[2] ?? "");
          continue;
        }
        if (idleTag) {
          if (line.toUpperCase() === "DONE") {
            send(`${idleTag} OK`);
            idleTag = null;
          }
          continue;
        }
        const m = /^(\S+) (?:UID )?(\S+)(?: (.*))?$/.exec(line);
        if (!m) continue;
        const [, tag, cmd, rest = ""] = m as unknown as [string, string, string, string];
        switch (cmd.toUpperCase()) {
          case "CAPABILITY":
            send("* CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS IDLE");
            send(`${tag} OK`);
            break;
          case "AUTHENTICATE": {
            const initial = rest.split(" ")[1];
            if (initial) {
              const p = Buffer.from(initial, "base64").toString("utf8").split("\0");
              login(tag, p[1] ?? "", p[2] ?? "");
            } else {
              authTag = tag;
              sock.write("+ \r\n");
            }
            break;
          }
          case "LOGIN": {
            const a = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest) ?? /^(\S+) (\S+)$/.exec(rest);
            if (a) login(tag, a[1]!.replace(/\\(.)/g, "$1"), a[2]!.replace(/\\(.)/g, "$1"));
            else send(`${tag} BAD`);
            break;
          }
          case "LIST":
            send('* LIST (\\HasNoChildren) "/" "INBOX"');
            send(`${tag} OK`);
            break;
          case "STATUS":
            send('* STATUS "INBOX" (MESSAGES 0 UNSEEN 0 UIDNEXT 1 UIDVALIDITY 1)');
            send(`${tag} OK`);
            break;
          case "SELECT":
          case "EXAMINE":
            send("* 0 EXISTS");
            send("* OK [UIDVALIDITY 1] ok");
            send("* OK [UIDNEXT 1] ok");
            send(`${tag} OK [READ-WRITE] ok`);
            break;
          case "SEARCH":
            send("* SEARCH");
            send(`${tag} OK`);
            break;
          case "IDLE":
            idleTag = tag;
            sock.write("+ idling\r\n");
            break;
          case "LOGOUT":
            send("* BYE");
            send(`${tag} OK`);
            sock.end();
            break;
          default:
            send(`${tag} OK`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  return state;
}

/**
 * Boots the real server (src/server.ts) on a random loopback port with a
 * temporary data directory and one provider, "generic", that points at `imap`.
 * Call once per spec file: the module starts listening when it is imported.
 */
export async function bootProxy(imap: FakeImap): Promise<{ app: import("fastify").FastifyInstance; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-proxy-test-"));
  const providers = {
    generic: {
      imap: { host: "127.0.0.1", port: imap.port, secure: false },
      smtp: { host: "127.0.0.1", port: 1, secure: false },
      sieve: null,
      carddav: null,
      auth: { mech: ["PLAIN"] },
    },
  };
  fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify(providers));
  Object.assign(process.env, {
    PORT: "0",
    LISTEN_HOST: "127.0.0.1",
    PUBLIC_URL: "http://127.0.0.1",
    DATA_DIR: dir,
    PROVIDERS_FILE: path.join(dir, "providers.json"),
    DEFAULT_PROVIDER: "generic",
    VAULT_KEY: crypto.randomBytes(32).toString("base64"),
    SESSION_HMAC_KEY: crypto.randomBytes(32).toString("base64"),
    LOG_LEVEL: "silent",
  });
  delete process.env.GMAIL_OAUTH_CLIENT_FILE;
  const { app } = (await import("../../src/server.js")) as unknown as { app: import("fastify").FastifyInstance };
  await app.ready();
  return { app, dir };
}

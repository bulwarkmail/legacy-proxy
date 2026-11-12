// Test helper: the same small IMAP server as fake-imap.ts, but each login is
// decided by a function, which may take its time and may answer with a
// temporary failure or drop the connection. Plain TCP on 127.0.0.1. Not a
// spec; vitest does not pick it up.

import net from "node:net";

/**
 * "ok" accepts, "no" refuses the credentials, "unavailable" and
 * "contactadmin" answer NO with the UNAVAILABLE or CONTACTADMIN response code
 * (try again later), "drop" closes the connection without an answer.
 */
export type LoginAnswer = "ok" | "no" | "unavailable" | "contactadmin" | "drop";

export interface ScriptedImap {
  port: number;
  /** Every login attempt: user, password, answer, when (epoch ms). */
  attempts: { user: string; pass: string; answer: LoginAnswer; at: number }[];
  decide: (user: string, pass: string) => LoginAnswer | Promise<LoginAnswer>;
  close(): Promise<void>;
}

export async function startScriptedImap(decide: ScriptedImap["decide"]): Promise<ScriptedImap> {
  const state: ScriptedImap = { port: 0, attempts: [], decide, close: async () => {} };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    let authTag: string | null = null;
    let idleTag: string | null = null;
    const send = (s: string) => {
      if (!sock.destroyed) sock.write(s + "\r\n");
    };
    const login = async (tag: string, user: string, pass: string) => {
      const answer = await state.decide(user, pass);
      state.attempts.push({ user, pass, answer, at: Date.now() });
      if (answer === "ok") send(`${tag} OK logged in`);
      else if (answer === "unavailable") send(`${tag} NO [UNAVAILABLE] try again later`);
      else if (answer === "contactadmin") send(`${tag} NO [CONTACTADMIN] try again later`);
      else if (answer === "drop") sock.destroy();
      else send(`${tag} NO [AUTHENTICATIONFAILED] no`);
    };
    send("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS IDLE] ready");
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      for (;;) {
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (authTag) {
          const tag = authTag;
          authTag = null;
          const p = Buffer.from(line, "base64").toString("utf8").split("\0");
          void login(tag, p[1] ?? "", p[2] ?? "");
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
              void login(tag, p[1] ?? "", p[2] ?? "");
            } else {
              authTag = tag;
              sock.write("+ \r\n");
            }
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

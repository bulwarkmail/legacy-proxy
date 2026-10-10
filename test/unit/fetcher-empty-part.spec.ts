import net from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { fetchEmailsBatch } from "../../src/imap/fetcher.js";

const HTML_B64 = Buffer.from("PHA+V2VsY29tZTwvcD4=\r\n"); // <p>Welcome</p>

const BODYSTRUCTURE =
  '(("text" "plain" ("charset" "UTF-8") NIL NIL "base64" 0 0 NIL NIL NIL NIL)' +
  ` ("text" "html" ("charset" "UTF-8") NIL NIL "base64" ${HTML_B64.length} 1 NIL NIL NIL NIL)` +
  ' "alternative" ("boundary" "b") NIL NIL NIL)';

// A minimal IMAP server shaped like Dovecot for a newsletter whose text/plain
// part is empty: BODY[1] comes back as the zero-length literal {0}.
function startServer(): Promise<net.Server> {
  const srv = net.createServer((sock) => {
    sock.write("* OK [CAPABILITY IMAP4rev1] ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, cmd = "", ...rest] = line.split(" ");
        const c = cmd.toUpperCase();
        if (c === "CAPABILITY") sock.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK\r\n`);
        else if (c === "SELECT" || c === "EXAMINE")
          sock.write(`* 1 EXISTS\r\n* OK [UIDVALIDITY 1] x\r\n* OK [UIDNEXT 8] x\r\n${tag} OK [READ-WRITE] x\r\n`);
        else if (c === "UID" && rest[0]?.toUpperCase() === "FETCH") {
          if (line.includes("BODYSTRUCTURE")) {
            sock.write(
              `* 1 FETCH (UID 7 FLAGS () RFC822.SIZE 100 INTERNALDATE "05-Oct-2026 19:03:15 +0200"` +
                ` ENVELOPE (NIL "Your stay" NIL NIL NIL NIL NIL NIL NIL NIL) BODYSTRUCTURE ${BODYSTRUCTURE}` +
                ` BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)] {2}\r\n\r\n)\r\n${tag} OK\r\n`,
            );
          } else {
            sock.write(`* 1 FETCH (UID 7 BODY[1] {0}\r\n BODY[2] {${HTML_B64.length}}\r\n`);
            sock.write(HTML_B64);
            sock.write(`)\r\n${tag} OK\r\n`);
          }
        } else if (c === "LOGOUT") {
          sock.write(`* BYE\r\n${tag} OK\r\n`);
          sock.end();
        } else sock.write(`${tag} OK\r\n`);
      }
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

const account = { id: 1 } as never;
const mailbox = { id: 2, uidvalidity: 1 } as never;
const opts = { fetchTextBodyValues: true, fetchHTMLBodyValues: true, wantsPreview: true };

let server: net.Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

describe("body values", () => {
  it("keeps the HTML part when the text part is an empty {0} literal", async () => {
    server = await startServer();
    const client = new ImapFlow({
      host: "127.0.0.1",
      port: (server.address() as net.AddressInfo).port,
      secure: false,
      auth: { user: "u", pass: "p" },
      logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const email = (await fetchEmailsBatch(client, account, mailbox, [7], opts)).get(7)!;
      expect(email.bodyValues["1"]).toEqual({ value: "", isEncodingProblem: false, isTruncated: false });
      expect(email.bodyValues["2"]).toEqual({ value: "<p>Welcome</p>", isEncodingProblem: false, isTruncated: false });
      expect(email.preview).toBe("Welcome");
    } finally {
      lock.release();
      await client.logout();
    }
  });
});

// LPROXY-15: three response headers that matter when the caller is a web page in somebody's browser.
// Belongs in test/unit/ (it needs sec-fake-imap.ts, the helper the other sec-lproxy specs use).
//
// The proxy authenticates by header, not by cookie. Two things can still make a browser attach
// credentials by itself: its own password prompt (asked for by `WWW-Authenticate: Basic`), after
// which it sends Basic credentials to the proxy's origin on every request, and a response that says
// credentialed cross-origin reads are welcome. And a download served with the type the URL asks for
// must not be sniffed into something else.
//
// The brief's decisions: the event stream never sends Access-Control-Allow-Credentials; a 401 to a
// request that carries an Origin header offers Bearer only; downloads carry nosniff.

import fs from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { bootProxy, startFakeImap, type FakeImap } from "./sec-fake-imap.js";

let imap: FakeImap;
let app: FastifyInstance;
let dir: string;
let token = "";
let accountId = "";

beforeAll(async () => {
  imap = await startFakeImap({ "frank@test.local": "right-password" });
  ({ app, dir } = await bootProxy(imap));
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "frank@test.local", password: "right-password" } });
  expect(login.statusCode).toBe(200);
  ({ token, accountId } = login.json() as { token: string; accountId: string });
}, 60_000);
afterAll(async () => {
  await app?.close();
  await imap?.close();
  // The server keeps proxy.db open until the process ends (Windows refuses the unlink).
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleanup */
  }
});

describe("what the proxy tells a browser (LPROXY-15)", () => {
  it("does not ask a web page's browser for a Basic password", async () => {
    for (const url of ["/jmap/session", "/jmap", `/jmap/download/1/Uxyz/text%2Fplain/x.txt`, "/jmap/eventsource?types=*&closeafter=state&ping=0"]) {
      const res = await app.inject({ method: url === "/jmap" ? "POST" : "GET", url, headers: { origin: "https://other.example" }, payload: url === "/jmap" ? {} : undefined });
      expect(res.statusCode, url).toBe(401);
      expect(String(res.headers["www-authenticate"] ?? ""), url).not.toMatch(/basic/i);
    }
  });

  it("still offers Basic to a client that is not a web page", async () => {
    const res = await app.inject({ method: "GET", url: "/jmap/session" });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers["www-authenticate"])).toMatch(/basic/i);
    expect(String(res.headers["www-authenticate"])).toMatch(/bearer/i);
  });

  it("serves a download as an attachment that must not be sniffed, whatever type the URL asks for", async () => {
    const upload = await app.inject({
      method: "POST",
      url: `/jmap/upload/${accountId}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      payload: Buffer.from("<script>document.title = 'ran'</script>"),
    });
    expect(upload.statusCode).toBeLessThan(300);
    const { blobId } = upload.json() as { blobId: string };
    for (const type of ["text/html", "image/svg+xml", "application/octet-stream"]) {
      const res = await app.inject({
        method: "GET",
        url: `/jmap/download/${accountId}/${blobId}/${encodeURIComponent(type)}/page.html`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, type).toBe(200);
      expect(res.headers["x-content-type-options"], type).toBe("nosniff");
      expect(String(res.headers["content-disposition"]), type).toMatch(/^attachment/);
    }
  });

  it("does not invite credentialed reads of the event stream from another origin", async () => {
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const abort = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/jmap/eventsource?types=*&closeafter=no&ping=0`, {
        headers: { authorization: `Bearer ${token}`, origin: "https://other.example", accept: "text/event-stream" },
        signal: abort.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      // A header-authenticated read from the webmail's own origin still works: the stream answers.
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    } finally {
      abort.abort();
    }
  });
});

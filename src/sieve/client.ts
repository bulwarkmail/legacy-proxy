// Minimal ManageSieve client (RFC 5804). Implements the verbs we need:
// CAPABILITY, AUTHENTICATE PLAIN, LISTSCRIPTS, GETSCRIPT, PUTSCRIPT,
// SETACTIVE, DELETESCRIPT, LOGOUT.
//
// The protocol is line-oriented, NUL-clean, with literals declared as
// `{N+}` (LITERAL+) or `{N}\r\n`. We support both literal forms.

import { TLSSocket, connect as tlsConnect } from "node:tls";
import { Socket, connect as netConnect } from "node:net";
import type { Credentials } from "../auth/credentials.js";
import { assertTransport, transportOf } from "../auth/providers.js";

interface SieveOpts {
  host: string;
  port: number;
  starttls?: boolean;
  secure?: boolean;
  allowPlaintext?: boolean;
  creds: Credentials;
  servername?: string;
  /** How long one command, connecting included, may wait for its answer. */
  timeoutMs?: number;
}

export interface SieveScriptInfo {
  name: string;
  active: boolean;
}

// What a ManageSieve server may send: each command's answer within the
// deadline, a script of at most MAX_SCRIPT_BYTES, and no answer larger than
// that script plus room for its status lines.
const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_SCRIPT_BYTES = 1024 * 1024;
const MAX_ANSWER_BYTES = MAX_SCRIPT_BYTES + 64 * 1024;

export class SieveClient {
  private sock!: Socket | TLSSocket;
  private buf = Buffer.alloc(0);
  // The one read in progress: settled when `ready` holds, or when the
  // connection fails.
  private waiter: { ready: () => boolean; resolve: () => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  // Bytes received for the command in progress.
  private received = 0;
  private capabilities = new Map<string, string>();
  private opts: SieveOpts;
  private readonly timeoutMs: number;

  constructor(opts: SieveOpts) {
    this.opts = opts;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  connect(): Promise<void> {
    return this.withDeadline("connect", () => this.open());
  }

  private async open(): Promise<void> {
    // AUTHENTICATE PLAIN carries the password: it goes only over implicit TLS,
    // a completed STARTTLS, or a plain connection the provider entry allows.
    assertTransport("sieve", this.opts);
    const { secure, starttls } = transportOf("sieve", this.opts);
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.sock = secure
        ? tlsConnect({ host: this.opts.host, port: this.opts.port, servername: this.opts.servername ?? this.opts.host }, () => {
            this.sock.off("error", onErr);
            resolve();
          })
        : netConnect({ host: this.opts.host, port: this.opts.port }, () => {
            this.sock.off("error", onErr);
            resolve();
          });
      this.sock.on("error", onErr);
      this.listen(this.sock);
    });
    await this.readGreeting();
    if (starttls) {
      await this.startTls();
      if (!(this.sock instanceof TLSSocket)) throw new Error("ManageSieve: STARTTLS did not complete");
    }
    await this.authenticate();
  }

  private tryReadLine(): string | null {
    const idx = this.buf.indexOf("\r\n");
    if (idx < 0) return null;
    const line = this.buf.subarray(0, idx).toString("utf8");
    this.buf = this.buf.subarray(idx + 2);
    return line;
  }

  private async readLine(): Promise<string> {
    await this.wait(() => this.buf.indexOf("\r\n") >= 0);
    return this.tryReadLine()!;
  }

  private wait(ready: () => boolean): Promise<void> {
    if (ready()) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<void>((resolve, reject) => {
      this.waiter = { ready, resolve, reject };
    });
  }

  private listen(sock: Socket | TLSSocket): void {
    sock.on("data", this.onData);
    sock.on("error", this.onError);
    sock.on("close", this.onClose);
  }

  private unlisten(sock: Socket | TLSSocket): void {
    sock.off("data", this.onData);
    sock.off("error", this.onError);
    sock.off("close", this.onClose);
  }

  private onData = (chunk: Buffer): void => {
    this.received += chunk.length;
    if (this.received > MAX_ANSWER_BYTES) {
      this.fail(new Error(`ManageSieve: answer larger than ${MAX_ANSWER_BYTES} bytes`));
      return;
    }
    this.buf = Buffer.concat([this.buf, chunk]);
    const w = this.waiter;
    if (w?.ready()) {
      this.waiter = null;
      w.resolve();
    }
  };

  private onError = (e: Error): void => this.fail(e);

  private onClose = (): void => this.fail(new Error("ManageSieve: connection closed"));

  /** Ends the connection; a read still waiting fails with the first error. */
  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(this.failure);
    this.sock?.destroy();
  }

  /** Runs one command: its answer must arrive within the deadline and the size limit. */
  private async withDeadline<T>(what: string, run: () => Promise<T>): Promise<T> {
    this.received = 0;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`ManageSieve: no answer to ${what} within ${this.timeoutMs} ms`);
        this.fail(err);
        reject(err);
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([run(), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readGreeting(): Promise<void> {
    while (true) {
      const line = await this.readLine();
      if (line.startsWith("OK")) return;
      if (line.startsWith("\"")) {
        const m = /^"([^"]+)"(?:\s+"([^"]*)")?/.exec(line);
        if (m && m[1]) this.capabilities.set(m[1].toUpperCase(), m[2] ?? "");
        continue;
      }
      if (line.startsWith("BYE") || line.startsWith("NO")) {
        throw new Error(`SIEVE greeting failed: ${line}`);
      }
    }
  }

  private async startTls(): Promise<void> {
    this.sock.write("STARTTLS\r\n");
    const ack = await this.readLine();
    if (!ack.startsWith("OK")) throw new Error(`STARTTLS rejected: ${ack}`);
    const plain = this.sock as Socket;
    this.unlisten(plain);
    const tls = tlsConnect({
      socket: plain,
      servername: this.opts.servername ?? this.opts.host,
    });
    await new Promise<void>((res, rej) => {
      tls.once("secureConnect", () => res());
      tls.once("error", (e) => rej(e));
    });
    this.sock = tls;
    this.buf = Buffer.alloc(0);
    this.listen(tls);
    this.capabilities.clear();
    await this.readGreeting();
  }

  private async authenticate(): Promise<void> {
    const c = this.opts.creds;
    if (c.mech === "PLAIN" && c.password) {
      const blob = Buffer.from(`\x00${c.username}\x00${c.password}`).toString("base64");
      this.sock.write(`AUTHENTICATE "PLAIN" {${blob.length}+}\r\n${blob}\r\n`);
    } else {
      throw new Error(`unsupported sieve auth mech: ${c.mech}`);
    }
    const line = await this.readLine();
    if (!line.startsWith("OK")) throw new Error(`AUTH failed: ${line}`);
  }

  listScripts(): Promise<SieveScriptInfo[]> {
    return this.withDeadline("LISTSCRIPTS", async () => {
      this.sock.write("LISTSCRIPTS\r\n");
      const out: SieveScriptInfo[] = [];
      while (true) {
        const line = await this.readLine();
        if (line.startsWith("OK")) return out;
        if (line.startsWith("NO") || line.startsWith("BYE")) throw new Error(line);
        const m = /^"([^"]+)"(?:\s+(\S+))?/.exec(line);
        if (m && m[1]) out.push({ name: m[1], active: m[2] === "ACTIVE" });
      }
    });
  }

  putScript(name: string, body: string): Promise<void> {
    return this.withDeadline("PUTSCRIPT", async () => {
      const buf = Buffer.from(body, "utf8");
      this.sock.write(`PUTSCRIPT "${name}" {${buf.length}+}\r\n`);
      this.sock.write(buf);
      this.sock.write("\r\n");
      const line = await this.readLine();
      if (!line.startsWith("OK")) throw new Error(`PUTSCRIPT: ${line}`);
    });
  }

  setActive(name: string): Promise<void> {
    return this.withDeadline("SETACTIVE", async () => {
      this.sock.write(`SETACTIVE "${name}"\r\n`);
      const line = await this.readLine();
      if (!line.startsWith("OK")) throw new Error(`SETACTIVE: ${line}`);
    });
  }

  getScript(name: string): Promise<string> {
    return this.withDeadline("GETSCRIPT", async () => {
      this.sock.write(`GETSCRIPT "${name}"\r\n`);
      const first = await this.readLine();
      const lit = /^\{(\d+)\+?\}$/.exec(first);
      if (!lit || !lit[1]) {
        if (first.startsWith("NO")) throw new Error(first);
        throw new Error(`GETSCRIPT unexpected: ${first}`);
      }
      const n = Number(lit[1]);
      if (n > MAX_SCRIPT_BYTES) {
        const err = new Error(`ManageSieve: script of ${n} bytes is larger than ${MAX_SCRIPT_BYTES}`);
        this.fail(err);
        throw err;
      }
      await this.wait(() => this.buf.length >= n);
      const body = this.buf.subarray(0, n).toString("utf8");
      this.buf = this.buf.subarray(n);
      // consume trailing CRLF
      this.tryReadLine();
      const ok = await this.readLine();
      if (!ok.startsWith("OK")) throw new Error(`GETSCRIPT tail: ${ok}`);
      return body;
    });
  }

  async logout(): Promise<void> {
    try {
      this.sock.write("LOGOUT\r\n");
    } catch {
      /* socket already gone */
    }
    this.sock.destroy();
  }
}

// Minimal ManageSieve client (RFC 5804). Implements the verbs we need:
// CAPABILITY, AUTHENTICATE PLAIN, LISTSCRIPTS, GETSCRIPT, PUTSCRIPT,
// SETACTIVE, DELETESCRIPT, LOGOUT.
//
// The protocol is line-oriented, NUL-clean, with literals declared as
// `{N+}` (LITERAL+) or `{N}\r\n`. We support both literal forms.

import { TLSSocket, connect as tlsConnect } from "node:tls";
import { Socket, connect as netConnect } from "node:net";
import type { Credentials } from "../auth/credentials.js";

interface SieveOpts {
  host: string;
  port: number;
  starttls?: boolean;
  secure?: boolean;
  creds: Credentials;
  servername?: string;
}

export interface SieveScriptInfo {
  name: string;
  active: boolean;
}

export class SieveClient {
  private sock!: Socket | TLSSocket;
  private buf = Buffer.alloc(0);
  private pending: ((line: string) => void) | null = null;
  private capabilities = new Map<string, string>();
  private opts: SieveOpts;

  constructor(opts: SieveOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error) => reject(e);
      this.sock = this.opts.secure
        ? tlsConnect({ host: this.opts.host, port: this.opts.port, servername: this.opts.servername ?? this.opts.host }, () => {
            this.sock.off("error", onErr);
            resolve();
          })
        : netConnect({ host: this.opts.host, port: this.opts.port }, () => {
            this.sock.off("error", onErr);
            resolve();
          });
      this.sock.on("error", onErr);
      this.sock.on("data", (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        if (this.pending) {
          const line = this.tryReadLine();
          if (line !== null) {
            const cb = this.pending;
            this.pending = null;
            cb(line);
          }
        }
      });
    });
    await this.readGreeting();
    if (this.opts.starttls && !(this.sock instanceof TLSSocket)) {
      await this.startTls();
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
    const line = this.tryReadLine();
    if (line !== null) return line;
    return await new Promise<string>((resolve) => {
      this.pending = resolve;
    });
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
    plain.removeAllListeners("data");
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
    this.sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.pending) {
        const line = this.tryReadLine();
        if (line !== null) {
          const cb = this.pending;
          this.pending = null;
          cb(line);
        }
      }
    });
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

  async listScripts(): Promise<SieveScriptInfo[]> {
    this.sock.write("LISTSCRIPTS\r\n");
    const out: SieveScriptInfo[] = [];
    while (true) {
      const line = await this.readLine();
      if (line.startsWith("OK")) return out;
      if (line.startsWith("NO") || line.startsWith("BYE")) throw new Error(line);
      const m = /^"([^"]+)"(?:\s+(\S+))?/.exec(line);
      if (m && m[1]) out.push({ name: m[1], active: m[2] === "ACTIVE" });
    }
  }

  async putScript(name: string, body: string): Promise<void> {
    const buf = Buffer.from(body, "utf8");
    this.sock.write(`PUTSCRIPT "${name}" {${buf.length}+}\r\n`);
    this.sock.write(buf);
    this.sock.write("\r\n");
    const line = await this.readLine();
    if (!line.startsWith("OK")) throw new Error(`PUTSCRIPT: ${line}`);
  }

  async setActive(name: string): Promise<void> {
    this.sock.write(`SETACTIVE "${name}"\r\n`);
    const line = await this.readLine();
    if (!line.startsWith("OK")) throw new Error(`SETACTIVE: ${line}`);
  }

  async getScript(name: string): Promise<string> {
    this.sock.write(`GETSCRIPT "${name}"\r\n`);
    const first = await this.readLine();
    const lit = /^\{(\d+)\+?\}$/.exec(first);
    if (!lit || !lit[1]) {
      if (first.startsWith("NO")) throw new Error(first);
      throw new Error(`GETSCRIPT unexpected: ${first}`);
    }
    const n = Number(lit[1]);
    while (this.buf.length < n) {
      await new Promise<void>((r) => this.sock.once("data", () => r()));
    }
    const body = this.buf.subarray(0, n).toString("utf8");
    this.buf = this.buf.subarray(n);
    // consume trailing CRLF
    this.tryReadLine();
    const ok = await this.readLine();
    if (!ok.startsWith("OK")) throw new Error(`GETSCRIPT tail: ${ok}`);
    return body;
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

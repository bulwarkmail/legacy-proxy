// Test helpers for push deliveries: watch every socket the process opens, let
// connections to loopback through and stop anything else before a packet
// leaves, and answer DNS one way for the address check and another way for
// anyone who resolves the name again when connecting.

import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { vi } from "vitest";

export const PUBLIC = "93.184.216.34";

export const isLoopback = (address: string) =>
  address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

/** Every address a socket of this process tried to connect to. Reset it per test. */
export const attempted: string[] = [];

/** Lets a socket reach loopback and nothing else, and notes where each one wanted to go. */
export function watchSockets(): void {
  const realConnect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...given: unknown[]) {
    // net.connect() hands its arguments on as one array ([options, callback]); tls and direct
    // callers pass them one by one.
    const args = Array.isArray(given[0]) ? [...(given[0] as unknown[])] : given;
    const options = (typeof args[0] === "object" && args[0] !== null ? { ...(args[0] as object) } : { port: args[0], host: args[1] }) as net.TcpSocketConnectOpts & { path?: string };
    if (options.path) return realConnect.apply(this, args as never);
    const host = String(options.host ?? "localhost");
    const stop = () => {
      process.nextTick(() => this.destroy(Object.assign(new Error("test: no connection leaves this machine"), { code: "ECONNREFUSED" })));
      return this;
    };
    if (net.isIP(host)) {
      attempted.push(host);
      return isLoopback(host) ? realConnect.apply(this, args as never) : stop();
    }
    // A name: let whatever lookup the caller chose run, then judge the answer.
    const chosen = (options.lookup ?? dns.lookup) as typeof dns.lookup;
    options.lookup = ((name: string, opts: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address?: unknown, family?: number) => void) => {
      chosen(name, opts, ((err: NodeJS.ErrnoException | null, address: unknown, family?: number) => {
        if (err) return cb(err);
        const list = Array.isArray(address) ? (address as { address: string }[]).map((a) => a.address) : [String(address)];
        attempted.push(...list);
        if (list.every(isLoopback)) return cb(null, address, family);
        cb(Object.assign(new Error("test: no connection leaves this machine"), { code: "ECONNREFUSED" }));
      }) as never);
    }) as never;
    const rest = typeof args[0] === "object" ? args.slice(1) : args.slice(2);
    return realConnect.call(this, options as never, ...(rest as []));
  } as never);
}

/**
 * The check (dns/promises) sees `first`, one address or several, or fails with
 * it; whoever resolves the name again when connecting (dns.lookup) sees `second`.
 */
export function resolveTo(first: string | string[] | Error, second: string): void {
  const answer = (addresses: string[]) => addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
  const check = vi.spyOn(dnsPromises, "lookup");
  if (first instanceof Error) check.mockRejectedValue(first);
  else check.mockResolvedValue(answer(Array.isArray(first) ? first : [first]) as never);
  vi.spyOn(dns, "lookup").mockImplementation(((_host: string, options: unknown, cb?: unknown) => {
    const callback = (typeof options === "function" ? options : cb) as (err: null, address: unknown, family?: number) => void;
    const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    if (all) callback(null, answer([second]));
    else callback(null, second, net.isIPv6(second) ? 6 : 4);
  }) as never);
}

export const notFoundError = () => Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });

export interface LocalServer {
  server: http.Server;
  port: number;
  /** TCP connections it received, whatever was sent on them. */
  connections: number;
  requests: { method: string; url: string; host: string; kind: string; body: string }[];
  close(): Promise<void>;
}

/** A loopback HTTP server that counts connections and records requests; `answer` sets the reply. */
export async function startLocalServer(
  answer: (res: http.ServerResponse) => void = (res) => res.writeHead(200).end("ok"),
): Promise<LocalServer> {
  const local: LocalServer = {
    server: http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        local.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          host: req.headers.host ?? "",
          kind: String(req.headers["x-push-type"] ?? ""),
          body,
        });
        answer(res);
      });
    }),
    port: 0,
    connections: 0,
    requests: [],
    close: () => new Promise<void>((r) => local.server.close(() => r())),
  };
  local.server.on("connection", () => {
    local.connections += 1;
  });
  await new Promise<void>((r) => local.server.listen(0, "127.0.0.1", r));
  local.port = (local.server.address() as AddressInfo).port;
  return local;
}

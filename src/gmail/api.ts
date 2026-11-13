import crypto from "node:crypto";
import type { GoogleClient } from "./connection.js";
import { GmailConnection } from "./connection.js";
import { GmailStore } from "./store.js";
import { GMAIL_MODIFY } from "./config.js";
import { JmapError } from "../jmap/errors.js";
import { currentTrace } from "../jmap/trace.js";
import { log } from "../util/log.js";

/** A write Google never received or explicitly refused: nothing changed upstream, so it is safe to retry. */
export class GmailNotSent extends JmapError {}

/**
 * Quota units a second this bridge lets one account spend. Google refills a
 * per-user budget of 250 a second, so pacing at 200 leaves room for the
 * retries a 429 costs and for a second client on the same mailbox.
 *
 * Costs passed to {@link GmailApi.get} and {@link GmailApi.mutate} are Google's
 * own prices (messages.get and messages.modify 5, threads.get 10,
 * drafts.create 10, messages.import 25, send 100). Overcharging a request buys
 * no safety and only delays it: `messages.get` billed at 20 units reserved
 * 250 ms per message, so opening a 50-message folder waited 12.5 s on this
 * pacer alone.
 */
const UNITS_PER_SECOND = 200;

/** A Google answer slower than this is worth a line of its own in the log. */
const SLOW_UPSTREAM_MS = 3000;

/** In-flight requests per account, high enough that the quota pacer above stays the limit rather than the socket count. */
export const MAX_CONCURRENT = 12;

/**
 * How long a request may wait for one of those slots before it is refused.
 *
 * When Google is slow the slots, not the pacer, are the bottleneck: twelve
 * searches that each run into the 15 s timeout let less than one request a
 * second through, and a queue of two hundred then takes minutes to drain.
 * The clients that filled it stop waiting after 30 s, so whatever is served
 * after that is work nobody reads, still paid for from the account's quota.
 * Refusing early hands the client a `serverUnavailable` it can retry.
 */
export const MAX_QUEUE_WAIT_MS = 10_000;

/** Reads Google accepts in one batch request. */
export const MAX_BATCH = 100;

/**
 * The sub-answers of a `multipart/mixed` batch response, keyed by the index
 * their request carried in `Content-ID`.
 *
 * The transport hands back the body alone, so the boundary is read from the
 * body's own first line rather than from the content type. Google is free to
 * answer out of order, and does, which is why the correlation id matters.
 */
function parseBatch(
  body: string,
): Map<number, { status: number; body: string }> {
  const answers = new Map<number, { status: number; body: string }>();
  // Google prefixes the first boundary with a blank line.
  const start = body.search(/--\S/);
  const end = body.indexOf("\r\n", start);
  const boundary = start < 0 || end < 0 ? "" : body.slice(start, end).trim();
  if (!boundary.startsWith("--")) return answers;
  for (const chunk of body.split(boundary)) {
    const head = chunk.indexOf("\r\n\r\n");
    if (head < 0) continue;
    const id = /content-id:\s*<response-item-(\d+)>/i.exec(chunk.slice(0, head));
    if (!id) continue;
    const inner = chunk.slice(head + 4);
    const status = /^HTTP\/[\d.]+ (\d{3})/.exec(inner);
    const split = inner.indexOf("\r\n\r\n");
    if (!status || split < 0) continue;
    answers.set(Number(id[1]), {
      status: Number(status[1]),
      body: inner.slice(split + 4).trim(),
    });
  }
  return answers;
}

/** Shared per-account quota/concurrency budget, including concurrent JMAP envelopes. */
export class GmailApi {
  private client?: GoogleClient;
  private refreshToken?: string;
  private scopeKey?: string;
  private nextSlot = 0;
  private active = 0;
  private blockedUntil = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private email: string,
    private connection: GmailConnection,
    private store: GmailStore,
  ) {}
  async get<T>(
    resource: string,
    cost: number,
    params: Record<string, string | string[]> = {},
  ): Promise<T> {
    return this.request<T>(resource, cost, params);
  }
  async mutate<T>(
    resource: string,
    cost: number,
    method: "POST" | "PATCH" | "DELETE",
    data?: unknown,
    params: Record<string, string | string[]> = {},
  ): Promise<T> {
    const allowed =
      (method === "POST" &&
        (resource === "labels" ||
          resource === "watch" ||
          resource === "stop" ||
          resource === "messages/import" ||
          /^messages\/[A-Za-z0-9_-]+\/modify$/.test(resource))) ||
      ((method === "PATCH" || method === "DELETE") &&
        /^labels\/[A-Za-z0-9_-]+$/.test(resource));
    const compose =
      this.connection.config?.composeEnabled &&
      ((method === "POST" &&
        (resource === "drafts" || resource === "drafts/send")) ||
        (method === "DELETE" && /^drafts\/[A-Za-z0-9_-]+$/.test(resource)));
    if (!allowed && !compose)
      throw new GmailNotSent("forbidden", "Unsupported Gmail write operation");
    return this.request<T>(resource, cost, params, method, data);
  }
  /**
   * Several reads in one HTTP request through Gmail's batch endpoint.
   *
   * Google prices each sub-request exactly as it prices the standalone call,
   * so the quota cost is the same; what a batch saves is the round trip. Fifty
   * `messages.get` calls opening a folder page cost fifty request/response
   * pairs to Google (and, before this, fifty turns through a four-deep
   * concurrency gate); batched, they cost one.
   *
   * Sub-requests answer independently: a message deleted between the listing
   * and the read fails alone, with its own status, and the rest still arrive.
   * Results are returned in the order asked for, whatever order Google
   * answered in.
   */
  async batch<T>(
    reads: { resource: string; params?: Record<string, string> }[],
    cost: number,
  ): Promise<{ status: number; data?: T }[]> {
    if (!reads.length) return [];
    if (reads.length > MAX_BATCH)
      throw new JmapError("requestTooLarge", "Gmail batch is limited to 100 reads");
    const boundary = "gmapbatch_" + crypto.randomBytes(16).toString("hex");
    const parts = reads.map((read, index) => {
      const path = new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/${read.resource}`,
      );
      for (const [key, value] of Object.entries(read.params ?? {}))
        path.searchParams.append(key, value);
      return (
        `--${boundary}\r\nContent-Type: application/http\r\n` +
        `Content-ID: <item-${index}>\r\n\r\n` +
        `GET ${path.pathname}${path.search}\r\n\r\n`
      );
    });
    const body = parts.join("") + `--${boundary}--\r\n`;
    const text = await this.request<string>(
      "batch",
      cost * reads.length,
      {},
      undefined,
      undefined,
      {
        url: "https://gmail.googleapis.com/batch/gmail/v1",
        data: body,
        contentType: `multipart/mixed; boundary=${boundary}`,
        reads: reads.length,
      },
    );
    const answers = parseBatch(text);
    // Google reports a throttled batch inside the parts, with the envelope
    // still 200: without this the caller would read a uniform refusal as a
    // cache miss and spend the same budget again, one request per message.
    let limited = 0;
    const refused = new Map<string, number>();
    for (const answer of answers.values()) {
      if (answer.status === 429 || answer.status === 403) limited++;
      if (answer.status < 200 || answer.status >= 300) {
        // Google's own words for the refusal: "too many concurrent requests"
        // and "quota exceeded" call for different remedies.
        let why = "";
        try {
          why = String(
            (JSON.parse(answer.body) as { error?: { message?: string } }).error?.message ?? "",
          ).slice(0, 120);
        } catch {
          // Not JSON: the status alone is the reason.
        }
        const key = `${answer.status} ${why}`;
        refused.set(key, (refused.get(key) ?? 0) + 1);
      }
    }
    if (refused.size) {
      const trace = currentTrace();
      if (trace) trace.refused += limited;
      log.info(
        { reads: reads.length, resource: reads[0]!.resource.split("/")[0], refused: Object.fromEntries(refused) },
        "gmail batch parts refused",
      );
    }
    if (limited === reads.length) {
      this.blockedUntil = Math.max(this.blockedUntil, Date.now() + 1000);
      throw new JmapError("serverUnavailable", "Google rate limit; retry later");
    }
    return reads.map((_, index) => {
      const answer = answers.get(index);
      if (!answer) return { status: 500 };
      if (answer.status < 200 || answer.status >= 300)
        return { status: answer.status };
      try {
        return { status: answer.status, data: JSON.parse(answer.body) as T };
      } catch {
        return { status: 500 };
      }
    });
  }
  private async request<T>(
    resource: string,
    cost: number,
    params: Record<string, string | string[]>,
    method?: "POST" | "PATCH" | "DELETE",
    body?: unknown,
    /** A ready-made POST that replaces the `resource`/`params` call, used by {@link batch}: it is a read, and shares this account's credentials, pacing and retries. */
    prepared?: { url: string; data: string; contentType: string; reads: number },
  ): Promise<T> {
    const trace = currentTrace();
    const began = performance.now();
    let net = 0;
    // Every time the request is sent, a retry included: each one is a call
    // Google counts and prices.
    let sends = 0;
    if (this.waiting.length >= 200)
      throw new (method ? GmailNotSent : JmapError)(
        "serverUnavailable",
        "Gmail request queue is full",
      );
    if (this.active >= MAX_CONCURRENT) {
      const admitted = await new Promise<boolean>((resolve) => {
        const admit = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          const at = this.waiting.indexOf(admit);
          if (at >= 0) this.waiting.splice(at, 1);
          resolve(false);
        }, MAX_QUEUE_WAIT_MS);
        this.waiting.push(admit);
      });
      // Not admitted means no slot was handed over: nothing to release below.
      // The wait is booked here, because that `finally` is never reached: a
      // call that queued until it timed out is exactly what the log is for.
      if (!admitted && trace) trace.waitMs += performance.now() - began;
      if (!admitted)
        throw new (method ? GmailNotSent : JmapError)(
          "serverUnavailable",
          "Gmail requests are backed up; retry later",
        );
    } else this.active++;
    // Set right before a write reaches the network: failures before that point never changed Gmail.
    let dispatched = false;
    try {
      const saved = await this.store.load(this.email);
      if (!saved) throw new JmapError("accountNotFound");
      // users.watch/stop only manage push notifications and work with the read-only grant.
      const pushOnly =
        method === "POST" && (resource === "watch" || resource === "stop");
      if (
        method &&
        !pushOnly &&
        (!this.connection.config.writeEnabled ||
          !saved.credentials.scopes?.includes(GMAIL_MODIFY))
      )
        throw new JmapError("accountReadOnly");
      if (
        !this.client ||
        this.refreshToken !== saved.credentials.refreshToken ||
        this.scopeKey !== (saved.credentials.scopes ?? []).join(" ")
      ) {
        this.client = this.connection.createClient();
        this.client.setCredentials({
          access_token: saved.credentials.accessToken,
          refresh_token: saved.credentials.refreshToken,
          expiry_date: saved.credentials.expiresAt,
        });
        this.refreshToken = saved.credentials.refreshToken;
        this.scopeKey = (saved.credentials.scopes ?? []).join(" ");
      }
      const client = this.client;
      await client.getAccessToken();
      await this.store.updateCredentials(
        this.email,
        {
          mech: "XOAUTH2",
          username: this.email,
          accessToken: client.credentials.access_token ?? undefined,
          refreshToken: client.credentials.refresh_token ?? this.refreshToken,
          expiresAt: client.credentials.expiry_date ?? undefined,
          scopes: saved.credentials.scopes,
        },
        this.refreshToken,
      );
      const url = new URL(
        `https://gmail.googleapis.com/gmail/v1/users/me/${resource}`,
      );
      // Gmail expects repeated keys for list parameters such as labelIds.
      for (const [key, value] of Object.entries(params))
        for (const one of Array.isArray(value) ? value : [value])
          url.searchParams.append(key, one);
      for (let attempt = 0; ; attempt++) {
        const slot = Math.max(Date.now(), this.nextSlot);
        this.nextSlot = slot + (cost * 1000) / UNITS_PER_SECOND;
        if (slot > Date.now())
          await new Promise((resolve) =>
            setTimeout(resolve, slot - Date.now()),
          );
        // A sibling request can extend the cooldown while this one is waiting.
        while (this.blockedUntil > Date.now()) {
          const wait = this.blockedUntil - Date.now();
          if (wait > 10_000)
            throw new JmapError(
              "serverUnavailable",
              "Google rate limit; retry later",
            );
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        const sent = performance.now();
        sends++;
        try {
          dispatched = true;
          const { data } = await client.request<T>(
            prepared
              ? {
                  url: prepared.url,
                  // One batch carries up to a hundred reads: it may legitimately
                  // take longer than any single one of them.
                  timeout: 60_000,
                  retry: false,
                  method: "POST",
                  data: prepared.data,
                  headers: { "Content-Type": prepared.contentType },
                  responseType: "text",
                }
              : {
                  url: url.href,
                  timeout: 15_000,
                  retry: false,
                  ...(method
                    ? { method, ...(body === undefined ? {} : { data: body }) }
                    : {}),
                },
          );
          const took = performance.now() - sent;
          net += took;
          if (took >= SLOW_UPSTREAM_MS)
            log.info(
              { resource: resource.split("/")[0], reads: prepared?.reads, ms: Math.round(took) },
              "gmail request slow",
            );
          return data;
        } catch (error) {
          const failedAfter = performance.now() - sent;
          net += failedAfter;
          if (failedAfter >= SLOW_UPSTREAM_MS)
            log.info(
              { resource: resource.split("/")[0], reads: prepared?.reads, ms: Math.round(failedAfter), failed: true },
              "gmail request slow",
            );
          const response = (
            error as {
              response?: {
                status?: number;
                data?: { error?: { errors?: { reason?: string }[] } };
                headers?: { get?: (key: string) => string | null };
              };
            }
          ).response;
          const status = response?.status;
          const reason = response?.data?.error?.errors?.[0]?.reason;
          const rateLimited =
            status === 429 ||
            (status === 403 &&
              (reason === "rateLimitExceeded" ||
                reason === "userRateLimitExceeded"));
          const code =
            (error as { code?: string; cause?: { code?: string } }).code ??
            (error as { cause?: { code?: string } }).cause?.code;
          if (rateLimited) {
            // A refused batch envelope turns away every read it carried.
            if (trace) trace.refused += prepared?.reads ?? 1;
            log.info(
              {
                resource: resource.split("/")[0],
                status,
                reason,
                why: String(
                  (response?.data as { error?: { message?: string } } | undefined)?.error?.message ?? "",
                ).slice(0, 160),
                attempt,
              },
              "gmail rate limited",
            );
          }
          const timedOut = isTimeout(error);
          const networkFailure =
            timedOut ||
            (code !== undefined &&
              [
                "ECONNRESET",
                "ETIMEDOUT",
                "EAI_AGAIN",
                "ENOTFOUND",
                "ECONNREFUSED",
              ].includes(code));
          const temporary =
            networkFailure ||
            rateLimited ||
            (status !== undefined && [500, 502, 503, 504].includes(status));
          if (method) {
            // A 4xx answer means Google refused the write; timeouts, resets and 5xx leave the outcome unknown.
            if (status === 404) throw new GmailNotSent("notFound");
            if (status === 400)
              throw new GmailNotSent(
                "invalidProperties",
                "Google rejected the update",
              );
            if (status === 409) throw new GmailNotSent("alreadyExists");
            if (rateLimited)
              throw new GmailNotSent(
                "serverUnavailable",
                "Google rate limit; retry later",
              );
            if (status === 401)
              throw new GmailNotSent(
                "serverUnavailable",
                "Google authorization expired or was revoked. Reconnect the Google account; the saved draft is retained.",
              );
            if (status !== undefined && status >= 400 && status < 500)
              throw new GmailNotSent(
                "forbidden",
                "Google refused the update; verify account permissions",
              );
            throw new JmapError(
              "serverFail",
              "Google update failed; refresh before retrying",
            );
          }
          if (!temporary) {
            if (status === 403)
              throw new JmapError(
                "serverUnavailable",
                reason === "dailyLimitExceeded"
                  ? "Google daily quota exceeded"
                  : "Google denied access; verify account permissions",
              );
            throw error;
          }
          const retryAfter = response?.headers?.get?.("retry-after");
          const requestedDelay = retryAfter
            ? /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now()
            : 0;
          const delay = Math.max(
            1000 * 2 ** attempt,
            Number.isFinite(requestedDelay) ? requestedDelay : 0,
          );
          this.blockedUntil = Math.max(this.blockedUntil, Date.now() + delay);
          if (attempt >= 2 || delay > 10_000)
            throw new JmapError(
              "serverUnavailable",
              rateLimited
                ? "Google rate limit; retry later"
                : timedOut
                  ? TIMED_OUT
                  : "Google temporarily unavailable; retry later",
            );
        }
      }
    } catch (error) {
      const mapped = sanitize(error);
      if (method && !dispatched && !(mapped instanceof GmailNotSent))
        throw new GmailNotSent(mapped.type, mapped.message);
      throw mapped;
    } finally {
      if (trace) {
        trace.calls += sends;
        trace.reads += (prepared?.reads ?? 1) * sends;
        trace.units += cost * sends;
        trace.netMs += net;
        trace.waitMs += performance.now() - began - net;
      }
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

const TIMED_OUT = "Google did not answer in time; retry later";

/**
 * A request gaxios gave up on after its `timeout`.
 *
 * gaxios 7 enforces the timeout with `AbortSignal.timeout`. Under Node it
 * fetches through node-fetch, which rejects with its own `AbortError` (no
 * `code`), so the GaxiosError carries no code and no response, only that
 * cause; with a native fetch the cause is the signal's DOMException and the
 * GaxiosError's `code` is `"TimeoutError"`. No request here passes a signal
 * of its own, so an abort is always the timeout.
 */
function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; response?: unknown; cause?: { name?: unknown } };
  if (e.code === "TimeoutError") return true;
  return (
    e.response === undefined &&
    (e.cause?.name === "AbortError" || e.cause?.name === "TimeoutError")
  );
}

/** Library errors may contain Authorization headers: never pass them to the dispatcher. */
function sanitize(error: unknown): JmapError {
  if (error instanceof JmapError) return error;
  const status = (error as { response?: { status?: number } }).response?.status;
  if (status === 404) return new JmapError("notFound");
  // Not an authorization problem: telling the user to reconnect for it sends
  // them after the wrong fault.
  if (isTimeout(error)) return new JmapError("serverUnavailable", TIMED_OUT);
  const reason = (error as { response?: { data?: { error?: unknown } } })
    .response?.data?.error;
  if (status === 401 || reason === "invalid_grant")
    return new JmapError(
      "serverUnavailable",
      "Google authorization expired or was revoked. Reconnect the Google account; the saved draft is retained.",
    );
  return new JmapError(
    "serverUnavailable",
    "Gmail request failed; reconnect if authorization expired",
  );
}

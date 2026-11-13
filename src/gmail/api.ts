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
 * What Google gives one user of a project: 6,000 quota units a minute
 * (the limits for Cloud projects created from 1 May 2026; see
 * https://developers.google.com/workspace/gmail/api/reference/quota).
 * `GmailConfig.quotaPerMinute` replaces it for a project with another limit.
 */
export const UNITS_PER_MINUTE = 6000;

/**
 * The share of that this bridge spends in any sixty seconds. The rest is room
 * for a minute that does not start where Google's does and for the retries a
 * refusal costs.
 *
 * Google meters the minute, not the second: a rested account can spend most of
 * it at once (measured 12/11/2026: ~4,950 units inside six seconds passed, the
 * next 2,940 had its tail refused with "Quota exceeded for quota metric 'Total
 * Query Cost' and limit 'Units per minute per user'"). So nothing is trickled
 * out: a request leaves as soon as the last minute's spending leaves it room.
 */
export const BUDGET_SHARE = 0.9;
const WINDOW_MS = 60_000;

/**
 * How long a request waits for budget before it is refused instead. A client
 * stops waiting after thirty seconds; serving it later spends quota on an
 * answer nobody reads. The refusal says when to come back.
 */
export const MAX_BUDGET_WAIT_MS = 20_000;

/**
 * Google's price for one call, in quota units.
 *
 * This is the only place prices live. They used to be passed in by each
 * caller, at the pre-2026 rates (`messages.get` 5, `threads.get` 10): a folder
 * page booked as 750 units really cost 5,000 of the 6,000 a minute holds, so
 * the pacing built on those numbers protected nothing and the second page of a
 * session ran into Google's refusals.
 *
 * `undefined` for a call this table does not know; the caller's figure is
 * used then.
 */
export function quotaCost(
  resource: string,
  method?: "POST" | "PATCH" | "DELETE",
  params: Record<string, string | string[]> = {},
): number | undefined {
  const [head, id, sub] = resource.split("/");
  const format = typeof params.format === "string" ? params.format : undefined;
  // Gmail's default format is `full`.
  const whole = format === undefined || format === "full" || format === "raw" || format === "html";
  if (!method) {
    switch (head) {
      case "profile":
      case "labels":
      case "settings":
        return 1;
      case "history":
        return 2;
      case "messages":
        return id === undefined ? 5 : sub === "attachments" ? 20 : whole ? 60 : 20;
      case "threads":
        return id === undefined ? 10 : format === undefined || format === "full" ? 120 : 40;
      case "drafts":
        return id === undefined ? 5 : whole ? 60 : 20;
    }
    return undefined;
  }
  if (method === "POST") {
    if (head === "watch") return 100;
    if (head === "stop") return 50;
    if (head === "labels") return 5;
    if (head === "drafts") return id === "send" ? 100 : 10;
    if (head === "messages") {
      if (id === "import" || id === "insert") return 25;
      if (id === "send") return 100;
      if (id === "batchModify" || id === "batchDelete") return 50;
      if (sub === "modify" || sub === "untrash") return 5;
      if (sub === "trash") return 20;
    }
    return undefined;
  }
  if (head === "labels") return 5;
  if (method === "DELETE" && (head === "drafts" || head === "messages")) return 10;
  return undefined;
}

/**
 * Batched reads one account has running at Google at a time. Google's own
 * ceiling sits a little above fifty; the few single calls that run alongside
 * are the ones it sometimes turns away, and they go again in a moment.
 */
const READS_AT_ONCE = 50;

/** How often, and after how long, a request refused for crowding goes again. */
const CROWD_RETRIES = 3;
const CROWD_RETRY_MS = 150;

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
 * Message and thread reads sent to Google in one go; a larger batch is sent in
 * turns of this many.
 *
 * Google answers a batch in about a second whether it holds 25 reads or 50,
 * so a page's fifty rows go together: in two turns they took 2.2 s instead of
 * 1.1 (13/11/2026). Near fifty at once it sometimes turns a few away for
 * crowding; those go straight back (see {@link GmailApi.batch}).
 */
export const BATCH_AT_ONCE = 50;

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
  /** What was spent, and when, over the last minute. */
  private spent: { at: number; units: number }[] = [];
  private spentUnits = 0;
  /** Requests take their turn at the budget in arrival order. */
  private admission: Promise<void> = Promise.resolve();
  private active = 0;
  /** Batched reads running at Google right now, and the batches waiting for them to finish. */
  private flying = 0;
  private landing: (() => void)[] = [];
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
    return this.request<T>(resource, quotaCost(resource, undefined, params) ?? cost, params);
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
    return this.request<T>(resource, quotaCost(resource, method, params) ?? cost, params, method, data);
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
    const out: { status: number; data?: T }[] = new Array(reads.length);
    let pending = reads.map((_, index) => index);
    // The whole batch is paid for before any of it is sent: half a page that
    // went out before the budget ran dry is quota spent on a page that fails.
    const began = performance.now();
    await this.reserve(this.batchCost(reads, cost));
    const trace = currentTrace();
    if (trace) trace.waitMs += performance.now() - began;
    let unpaid = false;
    for (let round = 0; ; round++) {
      // Google runs the parts of a batch side by side, and one user may only
      // have so many requests running: of fifty thread reads sent together it
      // turned away between two and eighteen ("Too many concurrent requests
      // for user", 12/11/2026). A page goes at once all the same - see
      // BATCH_AT_ONCE - and the hundred reads a caller may ask for in two turns.
      // Labels answer too fast to pile up: a hundred of them go in one request.
      const atOnce = /^(messages|threads)\//.test(reads[0]!.resource) ? BATCH_AT_ONCE : MAX_BATCH;
      const answers: Awaited<ReturnType<typeof this.batchOnce<T>>> = [];
      for (let offset = 0; offset < pending.length; offset += atOnce) {
        const turn = pending.slice(offset, offset + atOnce).map((index) => reads[index]!);
        await this.enter(turn.length);
        try {
          // Paid for above; and a part Google turned away for crowding was
          // never run, so asking again is not a second purchase.
          answers.push(...(await this.batchOnce<T>(turn, cost, round === 0 || unpaid)));
        } finally {
          this.leave(turn.length);
        }
      }
      const limited: number[] = [];
      let crowded = true;
      pending.forEach((index, at) => {
        const { crowded: tooMany, ...answer } = answers[at]!;
        if (answer.status === 429 || answer.status === 403) {
          limited.push(index);
          crowded &&= tooMany === true;
        }
        out[index] = answer;
      });
      if (!limited.length) return out;
      unpaid = crowded;
      // Google runs a batch's parts side by side and turns some away: a few
      // of a large batch for being too many at once, or the tail of a page
      // for running past the minute's budget. Either way they are asked again
      // together - not one by one, which fails the page they belong to. The
      // crowd is gone the moment the batch returns, so those go straight
      // back; a spent budget is given time first.
      if (!crowded) this.penalize(1000 * 2 ** round);
      if (round >= 2) {
        if (limited.length === reads.length)
          throw new JmapError("serverUnavailable", "Google rate limit; retry later");
        return out;
      }
      pending = limited;
    }
  }
  /**
   * Google said "slow down": hold every request of the account for `ms`.
   *
   * It also means the books here ran ahead of Google's - something else spent
   * from the same user's minute, or a price changed - so a tenth of a minute
   * is written off rather than spent straight into the next refusal.
   */
  private penalize(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + ms);
    this.book(this.perMinute / 10);
  }
  /** The account's quota for a minute, and the part of it spent here. */
  private get perMinute(): number {
    return this.connection.config?.quotaPerMinute ?? UNITS_PER_MINUTE;
  }
  private get budget(): number {
    return Math.floor(this.perMinute * BUDGET_SHARE);
  }
  /**
   * Waits until `reads` more can run at Google without crowding the account.
   *
   * Two batches of fifty running together - a page and the unread section
   * above it, or a page and the one read ahead - had twenty of each turned
   * away ("Too many concurrent requests for user", 13/11/2026). They take
   * turns instead; a batch larger than the limit goes when nothing else runs.
   */
  private async enter(reads: number): Promise<void> {
    while (this.flying > 0 && this.flying + reads > READS_AT_ONCE)
      await new Promise<void>((resolve) => this.landing.push(resolve));
    this.flying += reads;
  }
  private leave(reads: number): void {
    this.flying -= reads;
    for (const wake of this.landing.splice(0)) wake();
  }
  /** Quota units the last minute's spending still leaves. */
  spare(): number {
    const now = Date.now();
    while (this.spent.length && this.spent[0]!.at <= now - WINDOW_MS)
      this.spentUnits -= this.spent.shift()!.units;
    return Math.max(0, this.budget - this.spentUnits);
  }
  private book(units: number): void {
    this.spent.push({ at: Date.now(), units });
    this.spentUnits += units;
  }
  /**
   * Waits until the last minute's spending leaves room for `units`, then books
   * them. Refuses at once when that would take longer than a client waits.
   */
  private reserve(units: number): Promise<void> {
    const turn = this.admission.then(async () => {
      // A single request larger than the budget goes when the minute is clear.
      const need = Math.min(units, this.budget);
      for (;;) {
        const now = Date.now();
        while (this.spent.length && this.spent[0]!.at <= now - WINDOW_MS)
          this.spentUnits -= this.spent.shift()!.units;
        let free = this.budget - this.spentUnits;
        if (free >= need) return this.book(units);
        let wait = 0;
        for (const entry of this.spent) {
          free += entry.units;
          if (free >= need) {
            wait = entry.at + WINDOW_MS - now;
            break;
          }
        }
        if (wait > MAX_BUDGET_WAIT_MS)
          throw new JmapError(
            "serverUnavailable",
            `Gmail's quota for this minute is spent; retry in ${Math.ceil(wait / 1000)} s`,
          );
        await new Promise((resolve) => setTimeout(resolve, wait + 1));
      }
    });
    this.admission = turn.catch(() => {});
    return turn;
  }
  private batchCost(
    reads: { resource: string; params?: Record<string, string> }[],
    cost: number,
  ): number {
    return reads.reduce(
      (sum, read) => sum + (quotaCost(read.resource, undefined, read.params) ?? cost),
      0,
    );
  }
  private async batchOnce<T>(
    reads: { resource: string; params?: Record<string, string> }[],
    cost: number,
    /** Already booked by {@link batch}. */
    prepaid: boolean,
  ): Promise<{ status: number; data?: T; crowded?: boolean }[]> {
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
      this.batchCost(reads, cost),
      {},
      undefined,
      undefined,
      {
        url: "https://gmail.googleapis.com/batch/gmail/v1",
        data: body,
        contentType: `multipart/mixed; boundary=${boundary}`,
        reads: reads.length,
        prepaid,
      },
    );
    const answers = parseBatch(text);
    const crowded = new Set<number>();
    // Google reports a throttled batch inside the parts, with the envelope
    // still 200; {@link batch} asks for the refused ones again.
    let limited = 0;
    const refused = new Map<string, number>();
    for (const [index, answer] of answers) {
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
        if (/concurrent/i.test(why)) crowded.add(index);
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
    return reads.map((_, index) => {
      const answer = answers.get(index);
      if (!answer) return { status: 500 };
      if (answer.status < 200 || answer.status >= 300)
        return { status: answer.status, ...(crowded.has(index) ? { crowded: true } : {}) };
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
    prepared?: { url: string; data: string; contentType: string; reads: number; prepaid: boolean },
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
      let unpaid = false;
      for (let attempt = 0; ; attempt++) {
        // Every attempt is a call Google counts, a retry included - but not
        // one it turned away for crowding, which it never ran.
        if (!(prepared?.prepaid && attempt === 0) && !unpaid) await this.reserve(cost);
        unpaid = false;
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
            const why = String(
              (response?.data as { error?: { message?: string } } | undefined)?.error?.message ?? "",
            ).slice(0, 160);
            // A refused batch envelope turns away every read it carried.
            if (trace) trace.refused += prepared?.reads ?? 1;
            log.info(
              { resource: resource.split("/")[0], status, reason, why, attempt },
              "gmail rate limited",
            );
            // "Too many concurrent requests for user": not a spent budget but
            // a crowd - a page's batch of fifty reads was running. Google did
            // not run this request, a write included, and the crowd is gone
            // in a moment: go again shortly, without holding the account's
            // other requests or writing quota off.
            if (/concurrent/i.test(why) && attempt < CROWD_RETRIES) {
              await new Promise((resolve) =>
                setTimeout(resolve, CROWD_RETRY_MS * (attempt + 1)),
              );
              unpaid = true;
              continue;
            }
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
          // A refusal means Google's minute holds less than the books here say.
          if (rateLimited) this.book(this.perMinute / 10);
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

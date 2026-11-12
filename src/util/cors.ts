import type { FastifyCorsOptions } from "@fastify/cors";

/**
 * How long a browser may reuse a CORS preflight answer, in seconds.
 *
 * Every JMAP call from a web client is a cross-origin POST with a JSON body
 * and an Authorization header, so without `Access-Control-Max-Age` the
 * browser sends an OPTIONS before each one - on one bridge, 8,960 preflights
 * next to 14,939 POSTs in a day. Two hours is Chromium's ceiling; Firefox
 * accepts up to a day and Safari caps lower on its own.
 */
export const CORS_MAX_AGE = 7200;

export const corsOptions: FastifyCorsOptions = {
  origin: true,
  maxAge: CORS_MAX_AGE,
};

/**
 * True for a request a browser made: one with an Origin header (a page's
 * fetch or XHR) or a Sec-Fetch-* header (every request of a current browser,
 * a top-level navigation included). Such a request is offered Bearer only in
 * a 401, so the browser never shows its own password prompt.
 */
export function fromBrowser(headers: Record<string, string | string[] | undefined>): boolean {
  if (headers["origin"] !== undefined) return true;
  return Object.keys(headers).some((name) => name.toLowerCase().startsWith("sec-fetch-"));
}

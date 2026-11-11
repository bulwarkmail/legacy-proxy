// Read/write the vacation autoresponder via ManageSieve. We persist all the
// JMAP-visible fields (subject, textBody, htmlBody, fromDate, toDate) by
// generating a Sieve script with structured marker comments, then parse those
// markers back on read. This keeps state in the user's mail provider rather
// than another local database — the right place for it.

import type { SieveClient } from "./client.js";
import { JmapError } from "../jmap/errors.js";

export interface VacationProps {
  isEnabled: boolean;
  fromDate?: string | null;
  toDate?: string | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}

const SCRIPT_NAME = "bulwark-vacation";

// The instants a UTC date part can write as "yyyy-mm-dd": years 0000 to 9999.
const MIN_DATE_MS = Date.parse("0000-01-01T00:00:00.000Z");
const MAX_DATE_MS = Date.parse("9999-12-31T23:59:59.999Z");

/** A JMAP UTCDate as Sieve "date" and "time" parts in UTC; throws invalidProperties if it isn't one. */
function utcParts(value: string, property: string): { date: string; time: string; ms: number } {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < MIN_DATE_MS || ms > MAX_DATE_MS) {
    throw new JmapError("invalidProperties", `${property} is not a valid date`, { properties: [property] });
  }
  const iso = new Date(ms).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19), ms };
}

// RFC 5260 `currentdate` tests in UTC. The "date" (yyyy-mm-dd) and "time"
// (hh:mm:ss) parts have a fixed width, so comparing them as strings with the
// relational extension (RFC 5231) compares the instants.
function nowAtOrAfter(p: { date: string; time: string }): string {
  return (
    `anyof (currentdate :zone "+0000" :value "gt" "date" "${p.date}", ` +
    `allof (currentdate :zone "+0000" :is "date" "${p.date}", currentdate :zone "+0000" :value "ge" "time" "${p.time}"))`
  );
}

function nowBefore(p: { date: string; time: string }): string {
  return (
    `anyof (currentdate :zone "+0000" :value "lt" "date" "${p.date}", ` +
    `allof (currentdate :zone "+0000" :is "date" "${p.date}", currentdate :zone "+0000" :value "lt" "time" "${p.time}"))`
  );
}

/**
 * The vacation script. `extensions` are the Sieve extensions the server
 * offers. With "date" and "relational" the script answers only from fromDate
 * (inclusive) until toDate (exclusive), as RFC 8621 §8 describes; without
 * them it has no date test and the window is left to the client. The dates
 * are kept in the markers either way. A date that isn't one, or a fromDate
 * after the toDate, is refused with invalidProperties.
 */
export function generateScript(v: VacationProps, extensions: ReadonlySet<string> = new Set()): string {
  const from = v.fromDate ? utcParts(v.fromDate, "fromDate") : null;
  const to = v.toDate ? utcParts(v.toDate, "toDate") : null;
  if (from && to && from.ms > to.ms) {
    throw new JmapError("invalidProperties", "fromDate is after toDate", { properties: ["fromDate", "toDate"] });
  }

  // Markers are stored on dedicated comment lines so re-reading the script
  // can recover what the user typed even when the autoresponder is disabled.
  // We only emit the actual `vacation` action when enabled; otherwise the
  // script contains markers + a no-op so the server still has something to
  // load and `SETACTIVE ""` is what disables it.
  const markers = [
    markerLine("subject", v.subject),
    markerLine("from", v.fromDate),
    markerLine("to", v.toDate),
    markerLine("text", v.textBody),
    markerLine("html", v.htmlBody),
  ];

  if (!v.isEnabled) {
    return [
      'require ["vacation"];',
      "",
      "# bulwark-vacation: disabled",
      ...markers,
      "",
    ].join("\n");
  }

  // RFC 5230 vacation parameters: :days N, :subject "...", :addresses, etc.
  // We only set the fields the JMAP client gave us. (`:from` would be the
  // reply's sender address, so no date goes there.)
  const params: string[] = [":days 1"];
  if (v.subject) params.push(`:subject "${escape(v.subject)}"`);
  const body = v.textBody ?? "I am away.";
  const action = `vacation ${params.join(" ")} "${escape(body)}";`;

  const canTestDates = extensions.has("date") && extensions.has("relational");
  const dateTests = canTestDates
    ? [from ? nowAtOrAfter(from) : null, to ? nowBefore(to) : null].filter((t): t is string => t !== null)
    : [];
  if (dateTests.length === 0) {
    return ['require ["vacation"];', "", "# bulwark-vacation: enabled", ...markers, "", action, ""].join("\n");
  }
  const test = dateTests.length === 1 ? dateTests[0]! : `allof (${dateTests.join(", ")})`;
  return [
    'require ["vacation", "date", "relational"];',
    "",
    "# bulwark-vacation: enabled",
    ...markers,
    "",
    `if ${test} {`,
    `  ${action}`,
    "}",
    "",
  ].join("\n");
}

/** The Sieve extensions the server announced in its SIEVE capability, lowercased. */
function serverExtensions(client: SieveClient): Set<string> {
  // SieveClient keeps the greeting's capabilities in a private map, keyed by
  // the upper-cased capability name. When it can't be read, no extension is
  // assumed and the script has no date test.
  const caps = (client as unknown as { capabilities?: unknown }).capabilities;
  const list = caps instanceof Map ? caps.get("SIEVE") : undefined;
  return new Set(typeof list === "string" ? list.toLowerCase().split(/\s+/).filter(Boolean) : []);
}

function markerLine(key: string, value: string | null | undefined): string {
  if (value == null) return `# bulwark.${key}=`;
  // base64 keeps newlines, semicolons, and quotes from confusing the parser.
  const enc = Buffer.from(value, "utf8").toString("base64");
  return `# bulwark.${key}=${enc}`;
}

function readMarker(script: string, key: string): string | null {
  const re = new RegExp(`^#\\s*bulwark\\.${key}=(.*)$`, "m");
  const m = re.exec(script);
  if (!m || m[1] === undefined) return null;
  const enc = m[1].trim();
  if (!enc) return null;
  try {
    return Buffer.from(enc, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function escape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function readVacation(client: SieveClient): Promise<VacationProps> {
  const list = await client.listScripts();
  const ours = list.find((s) => s.name === SCRIPT_NAME);
  if (!ours) {
    return { isEnabled: false, subject: null, textBody: null, htmlBody: null, fromDate: null, toDate: null };
  }
  let body = "";
  try {
    body = await client.getScript(SCRIPT_NAME);
  } catch {
    // Some servers return NO if the script is empty. Treat as a blank
    // autoresponder so /get doesn't error out.
    return { isEnabled: ours.active, subject: null, textBody: null, htmlBody: null, fromDate: null, toDate: null };
  }
  return {
    isEnabled: ours.active,
    subject: readMarker(body, "subject"),
    textBody: readMarker(body, "text"),
    htmlBody: readMarker(body, "html"),
    fromDate: readMarker(body, "from"),
    toDate: readMarker(body, "to"),
  };
}

export async function writeVacation(client: SieveClient, v: VacationProps): Promise<void> {
  const body = generateScript(v, serverExtensions(client));
  await client.putScript(SCRIPT_NAME, body);
  if (v.isEnabled) {
    await client.setActive(SCRIPT_NAME);
  } else {
    // RFC 5804 §2.8: SETACTIVE with an empty script name deactivates the
    // currently active script. Without this, disabling the responder leaves
    // the server still running our previous script.
    await client.setActive("");
  }
}

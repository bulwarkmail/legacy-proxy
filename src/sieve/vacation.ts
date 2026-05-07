// Read/write the vacation autoresponder via ManageSieve. We persist all the
// JMAP-visible fields (subject, textBody, htmlBody, fromDate, toDate) by
// generating a Sieve script with structured marker comments, then parse those
// markers back on read. This keeps state in the user's mail provider rather
// than another local database — the right place for it.

import type { SieveClient } from "./client.js";

export interface VacationProps {
  isEnabled: boolean;
  fromDate?: string | null;
  toDate?: string | null;
  subject?: string | null;
  textBody?: string | null;
  htmlBody?: string | null;
}

const SCRIPT_NAME = "bulwark-vacation";

export function generateScript(v: VacationProps): string {
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
  // We only set the fields the JMAP client gave us.
  const params: string[] = [":days 1"];
  if (v.subject) params.push(`:subject "${escape(v.subject)}"`);
  if (v.fromDate) params.push(`:from "${escape(v.fromDate)}"`);
  // Sieve has :seconds for sub-day intervals but no :until — we approximate
  // a `toDate` by leaving the responder running (the proxy won't auto-disable
  // it). Date-range gating is best done by the client.
  const body = v.textBody ?? "I am away.";
  return [
    'require ["vacation"];',
    "",
    "# bulwark-vacation: enabled",
    ...markers,
    "",
    `vacation ${params.join(" ")} "${escape(body)}";`,
    "",
  ].join("\n");
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
  const body = generateScript(v);
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

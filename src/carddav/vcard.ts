// vCard 3.0 / 4.0 parser → JSContact (RFC 9553) projection used by JMAP for
// Contacts (RFC 9610), and the reverse serialiser used by ContactCard/set.
// We don't aim for full fidelity - we cover the properties webmail actually
// displays: FN, N, EMAIL, TEL, ORG, TITLE, ADR, NOTE, URL, BDAY, NICKNAME,
// KIND, MEMBER, UID, REV. Anything else is passed through untouched on update.

import { Buffer } from "node:buffer";

export interface JsContact {
  uid: string;
  kind?: "individual" | "group" | "org" | "location" | "device" | "application";
  name?: {
    full?: string;
    components?: Array<{
      kind:
        | "given"
        | "surname"
        | "prefix"
        | "suffix"
        | "additional"
        | "separator"
        | "credential"
        | "title"
        | "middle"
        | "given2"
        | "surname2"
        | "generation";
      value: string;
    }>;
  };
  nicknames?: Record<string, { name: string }>;
  emails?: Record<string, { address: string; contexts?: Record<string, boolean>; pref?: number }>;
  phones?: Record<string, { number: string; contexts?: Record<string, boolean>; features?: Record<string, boolean>; pref?: number }>;
  organizations?: Record<string, { name?: string; units?: Array<{ name: string }> }>;
  titles?: Record<string, { name: string; kind?: "title" | "role" }>;
  addresses?: Record<
    string,
    {
      components?: Array<{ kind: string; value: string }>;
      full?: string;
      contexts?: Record<string, boolean>;
      // Flat fields kept for the webmail UI's legacy reader.
      street?: string;
      locality?: string;
      region?: string;
      postcode?: string;
      country?: string;
    }
  >;
  notes?: Record<string, { note: string }>;
  links?: Record<string, { uri: string; kind?: "contact" | "generic" }>;
  anniversaries?: Record<string, { kind: "birth" | "death" | "wedding" | "other"; date: string | AnniversaryDate }>;
  /** Group membership (KIND:group): map of member UID/URI → true. */
  members?: Record<string, boolean>;
  updated?: string;
  prodId?: string;
}

/** RFC 9553 §1.5.5 date shapes a client may send for anniversaries. */
export type AnniversaryDate =
  | { "@type"?: "Timestamp"; utc: string }
  | { "@type"?: "PartialDate"; year?: number; month?: number; day?: number };

interface ParsedLine {
  name: string;
  params: Record<string, string[]>;
  value: string;
}

/**
 * Parse a vCard 3.0/4.0 text body. Returns one JsContact per `BEGIN:VCARD` /
 * `END:VCARD` block. Tolerant of folded lines (RFC 6350 §3.2), unknown
 * properties, and non-ASCII content.
 */
export function parseVCards(text: string): JsContact[] {
  const lines = unfold(text).split(/\r?\n/);
  const out: JsContact[] = [];
  let current: ParsedLine[] | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VCARD") {
      current = [];
      continue;
    }
    if (upper === "END:VCARD") {
      if (current) out.push(toJsContact(current));
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseLine(line);
    if (parsed) current.push(parsed);
  }
  return out;
}

function unfold(text: string): string {
  // RFC 6350 §3.2: a line wrapped at 75 octets is folded by inserting CRLF
  // followed by a single whitespace. To unfold, drop those join points.
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseLine(line: string): ParsedLine | null {
  // Property syntax:  GROUP.NAME;PARAM=val;PARAM=val:value
  // Values can contain ":" if escaped or inside quoted parameters; we look
  // for the first unquoted ":".
  let i = 0;
  let inQuote = false;
  let colonIdx = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx < 0) return null;

  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const segs = splitUnquoted(head, ";");
  if (segs.length === 0) return null;
  const namePart = segs[0];
  if (!namePart) return null;
  const dot = namePart.indexOf(".");
  const name = (dot >= 0 ? namePart.slice(dot + 1) : namePart).toUpperCase();

  const params: Record<string, string[]> = {};
  for (let s = 1; s < segs.length; s++) {
    const seg = segs[s]!;
    const eq = seg.indexOf("=");
    if (eq < 0) {
      // vCard 2.1 bare type, e.g. "HOME"
      const upper = seg.toUpperCase();
      params["TYPE"] = (params["TYPE"] ?? []).concat(upper);
      continue;
    }
    const k = seg.slice(0, eq).toUpperCase();
    const v = seg.slice(eq + 1);
    const values = splitUnquoted(v, ",").map((x) => stripQuotes(x).toUpperCase());
    params[k] = (params[k] ?? []).concat(values);
  }
  return { name, params, value };
}

function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
    } else if (ch === sep && !inQuote) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function unescapeValue(v: string): string {
  return v.replace(/\\([nN,;:\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function toJsContact(props: ParsedLine[]): JsContact {
  const c: JsContact = { uid: "" };
  const emailIdxByCount: { i: number } = { i: 0 };
  const phoneIdxByCount: { i: number } = { i: 0 };
  const orgIdxByCount: { i: number } = { i: 0 };
  const titleIdxByCount: { i: number } = { i: 0 };
  const adrIdxByCount: { i: number } = { i: 0 };
  const noteIdxByCount: { i: number } = { i: 0 };
  const linkIdxByCount: { i: number } = { i: 0 };
  const nickIdxByCount: { i: number } = { i: 0 };

  for (const p of props) {
    switch (p.name) {
      case "VERSION":
        break;
      case "UID":
        c.uid = unescapeValue(p.value);
        break;
      case "FN": {
        const v = unescapeValue(p.value);
        c.name = c.name ?? {};
        c.name.full = v;
        break;
      }
      case "N": {
        // surname;given;additional;prefix;suffix
        const parts = splitUnquoted(p.value, ";").map(unescapeValue);
        const components: Array<{ kind: "given" | "surname" | "additional" | "prefix" | "suffix"; value: string }> = [];
        const map: Array<{ kind: "given" | "surname" | "additional" | "prefix" | "suffix"; idx: number }> = [
          { kind: "surname", idx: 0 },
          { kind: "given", idx: 1 },
          { kind: "additional", idx: 2 },
          { kind: "prefix", idx: 3 },
          { kind: "suffix", idx: 4 },
        ];
        for (const m of map) {
          const v = parts[m.idx];
          if (v) components.push({ kind: m.kind, value: v });
        }
        if (components.length > 0) {
          c.name = c.name ?? {};
          c.name.components = components;
        }
        break;
      }
      case "NICKNAME": {
        const id = `n${++nickIdxByCount.i}`;
        c.nicknames = c.nicknames ?? {};
        c.nicknames[id] = { name: unescapeValue(p.value) };
        break;
      }
      case "EMAIL": {
        const id = `e${++emailIdxByCount.i}`;
        const types = (p.params["TYPE"] ?? []).map((x) => x.toLowerCase());
        const ctx: Record<string, boolean> = {};
        if (types.includes("home")) ctx["private"] = true;
        if (types.includes("work")) ctx["work"] = true;
        const pref = parseFloat((p.params["PREF"] ?? [])[0] ?? "");
        c.emails = c.emails ?? {};
        c.emails[id] = {
          address: unescapeValue(p.value),
          ...(Object.keys(ctx).length ? { contexts: ctx } : {}),
          ...(Number.isFinite(pref) ? { pref } : {}),
        };
        break;
      }
      case "TEL": {
        const id = `p${++phoneIdxByCount.i}`;
        const types = (p.params["TYPE"] ?? []).map((x) => x.toLowerCase());
        const ctx: Record<string, boolean> = {};
        if (types.includes("home")) ctx["private"] = true;
        if (types.includes("work")) ctx["work"] = true;
        const features: Record<string, boolean> = {};
        if (types.includes("cell") || types.includes("mobile")) features["mobile"] = true;
        if (types.includes("fax")) features["fax"] = true;
        if (types.includes("voice")) features["voice"] = true;
        if (types.includes("text") || types.includes("sms")) features["text"] = true;
        c.phones = c.phones ?? {};
        c.phones[id] = {
          number: unescapeValue(p.value),
          ...(Object.keys(ctx).length ? { contexts: ctx } : {}),
          ...(Object.keys(features).length ? { features } : {}),
        };
        break;
      }
      case "ORG": {
        const id = `o${++orgIdxByCount.i}`;
        const parts = splitUnquoted(p.value, ";").map(unescapeValue).filter(Boolean);
        if (parts.length === 0) break;
        const [name, ...units] = parts;
        c.organizations = c.organizations ?? {};
        c.organizations[id] = {
          ...(name ? { name } : {}),
          ...(units.length ? { units: units.map((u) => ({ name: u })) } : {}),
        };
        break;
      }
      case "TITLE": {
        const id = `t${++titleIdxByCount.i}`;
        c.titles = c.titles ?? {};
        c.titles[id] = { name: unescapeValue(p.value), kind: "title" };
        break;
      }
      case "ROLE": {
        const id = `t${++titleIdxByCount.i}`;
        c.titles = c.titles ?? {};
        c.titles[id] = { name: unescapeValue(p.value), kind: "role" };
        break;
      }
      case "ADR": {
        // pobox;ext;street;locality;region;postcode;country
        const parts = splitUnquoted(p.value, ";").map(unescapeValue);
        const id = `a${++adrIdxByCount.i}`;
        const types = (p.params["TYPE"] ?? []).map((x) => x.toLowerCase());
        const ctx: Record<string, boolean> = {};
        if (types.includes("home")) ctx["private"] = true;
        if (types.includes("work")) ctx["work"] = true;
        const components: Array<{ kind: string; value: string }> = [];
        const street = parts[2] ?? "";
        const locality = parts[3] ?? "";
        const region = parts[4] ?? "";
        const postcode = parts[5] ?? "";
        const country = parts[6] ?? "";
        if (street) components.push({ kind: "name", value: street });
        if (locality) components.push({ kind: "locality", value: locality });
        if (region) components.push({ kind: "region", value: region });
        if (postcode) components.push({ kind: "postcode", value: postcode });
        if (country) components.push({ kind: "country", value: country });
        c.addresses = c.addresses ?? {};
        c.addresses[id] = {
          ...(components.length ? { components } : {}),
          ...(Object.keys(ctx).length ? { contexts: ctx } : {}),
          ...(street ? { street } : {}),
          ...(locality ? { locality } : {}),
          ...(region ? { region } : {}),
          ...(postcode ? { postcode } : {}),
          ...(country ? { country } : {}),
        };
        break;
      }
      case "NOTE": {
        const id = `n${++noteIdxByCount.i}`;
        c.notes = c.notes ?? {};
        c.notes[id] = { note: unescapeValue(p.value) };
        break;
      }
      case "URL": {
        const id = `l${++linkIdxByCount.i}`;
        c.links = c.links ?? {};
        c.links[id] = { uri: unescapeValue(p.value), kind: "generic" };
        break;
      }
      case "BDAY": {
        c.anniversaries = c.anniversaries ?? {};
        c.anniversaries["b1"] = { kind: "birth", date: unescapeValue(p.value) };
        break;
      }
      case "REV":
        c.updated = unescapeValue(p.value);
        break;
      case "PRODID":
        c.prodId = unescapeValue(p.value);
        break;
      case "KIND":
      case "X-ADDRESSBOOKSERVER-KIND": {
        const k = unescapeValue(p.value).toLowerCase();
        if (k === "individual" || k === "group" || k === "org" || k === "location" || k === "device" || k === "application") {
          c.kind = k;
        }
        break;
      }
      case "MEMBER":
      case "X-ADDRESSBOOKSERVER-MEMBER": {
        const uri = unescapeValue(p.value);
        if (!uri) break;
        c.members = c.members ?? {};
        c.members[uri] = true;
        break;
      }
    }
  }
  if (!c.uid) {
    // Some servers don't include UID. Synthesize a stable one from FN/EMAIL.
    const seed = (c.name?.full ?? "") + "|" + (c.emails ? Object.values(c.emails)[0]?.address ?? "" : "");
    c.uid = `urn:vcard:${hashString(seed)}`;
  }
  c.kind = c.kind ?? "individual";
  return c;
}

// ---------------------------------------------------------------------------
// JSContact → vCard 4.0 serialisation (the write path for ContactCard/set).
// ---------------------------------------------------------------------------

/**
 * vCard property names the JSContact projection above models. Everything
 * else in an existing card (PHOTO, X-*, IMPP, GEO, …) is opaque to us and is
 * carried over verbatim on update so we never destroy data we don't
 * understand.
 */
const MANAGED_PROPS = new Set([
  "BEGIN",
  "END",
  "VERSION",
  "PRODID",
  "REV",
  "UID",
  "FN",
  "N",
  "NICKNAME",
  "EMAIL",
  "TEL",
  "ORG",
  "TITLE",
  "ROLE",
  "ADR",
  "NOTE",
  "URL",
  "BDAY",
  "ANNIVERSARY",
  "DEATHDATE",
  "KIND",
  "X-ADDRESSBOOKSERVER-KIND",
  "MEMBER",
  "X-ADDRESSBOOKSERVER-MEMBER",
]);

export const PRODID = "-//Bulwark//legacy-proxy//EN";

export interface SerializeOpts {
  /**
   * The vCard text the card was loaded from. Properties we don't model are
   * copied through unchanged so a round trip through JMAP is lossless for
   * them.
   */
  preserveFrom?: string;
  /** Override REV (defaults to now). Tests pass a fixed value. */
  rev?: string;
}

/** Serialise one JSContact as a vCard 4.0 body (CRLF line endings). */
export function serializeVCard(c: JsContact, opts: SerializeOpts = {}): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:4.0", `PRODID:${escapeValue(PRODID)}`];
  const push = (name: string, params: Record<string, string[] | undefined>, value: string) => {
    let head = name;
    for (const [k, vs] of Object.entries(params)) {
      if (!vs || vs.length === 0) continue;
      head += `;${k}=${vs.map(quoteParam).join(",")}`;
    }
    lines.push(`${head}:${value}`);
  };

  push("UID", {}, escapeValue(c.uid));
  if (c.kind && c.kind !== "individual") push("KIND", {}, c.kind);

  const fn = fullName(c);
  push("FN", {}, escapeValue(fn));

  const comps = c.name?.components ?? [];
  if (comps.length > 0) {
    const pick = (...kinds: string[]) =>
      comps
        .filter((x) => kinds.includes(x.kind))
        .map((x) => x.value)
        .join(",");
    const n = [
      pick("surname", "surname2"),
      pick("given"),
      pick("additional", "middle", "given2"),
      pick("prefix", "title"),
      pick("suffix", "credential", "generation"),
    ];
    push("N", {}, n.map(escapeComponent).join(";"));
  }

  for (const nick of Object.values(c.nicknames ?? {})) {
    if (nick?.name) push("NICKNAME", {}, escapeValue(nick.name));
  }

  for (const e of Object.values(c.emails ?? {})) {
    if (!e?.address) continue;
    push("EMAIL", { TYPE: contextTypes(e.contexts), PREF: prefParam(e.pref) }, escapeValue(e.address));
  }

  for (const p of Object.values(c.phones ?? {})) {
    if (!p?.number) continue;
    const types = contextTypes(p.contexts);
    const f = p.features ?? {};
    if (f["mobile"]) types.push("cell");
    if (f["fax"]) types.push("fax");
    if (f["voice"]) types.push("voice");
    if (f["text"]) types.push("text");
    if (f["pager"]) types.push("pager");
    push("TEL", { TYPE: types, PREF: prefParam(p.pref) }, escapeValue(p.number));
  }

  for (const o of Object.values(c.organizations ?? {})) {
    if (!o) continue;
    const parts = [o.name ?? "", ...(o.units ?? []).map((u) => u.name)];
    if (parts.every((x) => !x)) continue;
    push("ORG", {}, parts.map(escapeComponent).join(";"));
  }

  for (const t of Object.values(c.titles ?? {})) {
    if (!t?.name) continue;
    push(t.kind === "role" ? "ROLE" : "TITLE", {}, escapeValue(t.name));
  }

  for (const a of Object.values(c.addresses ?? {})) {
    if (!a) continue;
    const fields = addressFields(a);
    if (fields.every((x) => !x)) continue;
    const params: Record<string, string[] | undefined> = { TYPE: contextTypes(a.contexts) };
    if (a.full) params["LABEL"] = [a.full];
    push("ADR", params, fields.map(escapeComponent).join(";"));
  }

  for (const n of Object.values(c.notes ?? {})) {
    if (n?.note) push("NOTE", {}, escapeValue(n.note));
  }

  for (const l of Object.values(c.links ?? {})) {
    if (l?.uri) push("URL", {}, escapeValue(l.uri));
  }

  for (const an of Object.values(c.anniversaries ?? {})) {
    if (!an) continue;
    const date = formatDate(an.date);
    if (!date) continue;
    const prop = an.kind === "birth" ? "BDAY" : an.kind === "death" ? "DEATHDATE" : "ANNIVERSARY";
    push(prop, {}, date);
  }

  for (const [uri, on] of Object.entries(c.members ?? {})) {
    if (on && uri) push("MEMBER", {}, escapeValue(uri));
  }

  push("REV", {}, opts.rev ?? new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"));

  if (opts.preserveFrom) {
    for (const raw of unmanagedLines(opts.preserveFrom)) lines.push(raw);
  }

  lines.push("END:VCARD");
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** Lines of an existing vCard whose property we don't model (first VCARD only). */
export function unmanagedLines(text: string): string[] {
  const out: string[] = [];
  let inCard = false;
  for (const raw of unfold(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VCARD") {
      if (inCard) break; // only the first card in the resource
      inCard = true;
      continue;
    }
    if (upper === "END:VCARD") break;
    if (!inCard) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    if (MANAGED_PROPS.has(parsed.name)) continue;
    out.push(line);
  }
  return out;
}

function fullName(c: JsContact): string {
  if (c.name?.full) return c.name.full;
  const comps = c.name?.components ?? [];
  if (comps.length > 0) {
    const order = ["prefix", "title", "given", "given2", "middle", "additional", "surname", "surname2", "suffix", "credential", "generation"];
    const parts = order
      .flatMap((k) => comps.filter((x) => x.kind === k).map((x) => x.value))
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  const org = Object.values(c.organizations ?? {}).find((o) => o?.name)?.name;
  if (org) return org;
  const email = Object.values(c.emails ?? {}).find((e) => e?.address)?.address;
  if (email) return email;
  return "";
}

function contextTypes(ctx?: Record<string, boolean>): string[] {
  const out: string[] = [];
  if (!ctx) return out;
  if (ctx["private"] || ctx["home"]) out.push("home");
  if (ctx["work"]) out.push("work");
  return out;
}

function prefParam(pref?: number): string[] | undefined {
  if (typeof pref !== "number" || !Number.isFinite(pref)) return undefined;
  const v = Math.min(100, Math.max(1, Math.round(pref)));
  return [String(v)];
}

function addressFields(a: NonNullable<JsContact["addresses"]>[string]): string[] {
  // pobox;ext;street;locality;region;postcode;country
  const byKind = (...kinds: string[]) =>
    (a.components ?? [])
      .filter((x) => kinds.includes(x.kind))
      .map((x) => x.value)
      .filter(Boolean)
      .join(" ");
  const street = a.street ?? byKind("name", "street", "number", "block", "direction", "landmark");
  const ext = byKind("apartment", "floor", "building", "room", "subdistrict", "district");
  const pobox = byKind("postOfficeBox");
  const locality = a.locality ?? byKind("locality");
  const region = a.region ?? byKind("region");
  const postcode = a.postcode ?? byKind("postcode");
  const country = a.country ?? byKind("country");
  const fields = [pobox, ext, street, locality, region, postcode, country];
  if (fields.every((x) => !x) && a.full) fields[2] = a.full;
  return fields;
}

function formatDate(d: string | AnniversaryDate | undefined): string | null {
  if (!d) return null;
  if (typeof d === "string") return d.trim() || null;
  if ("utc" in d && d.utc) return d.utc.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const pd = d as { year?: number; month?: number; day?: number };
  const yy = pd.year != null ? String(pd.year).padStart(4, "0") : null;
  const mm = pd.month != null ? String(pd.month).padStart(2, "0") : null;
  const dd = pd.day != null ? String(pd.day).padStart(2, "0") : null;
  if (yy && mm && dd) return `${yy}${mm}${dd}`;
  if (yy && mm) return `${yy}-${mm}`;
  if (mm && dd) return `--${mm}${dd}`;
  if (yy) return yy;
  return null;
}

/** RFC 6350 §3.4: escape backslash, comma, semicolon and newline in a text value. */
export function escapeValue(v: string): string {
  return v
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Like escapeValue, for one field of a structured (`;`-separated) value. */
function escapeComponent(v: string): string {
  return escapeValue(v);
}

function quoteParam(v: string): string {
  const clean = v.replace(/["\r\n]/g, "");
  return /[;:,]/.test(clean) ? `"${clean}"` : clean;
}

/** RFC 6350 §3.2: fold at 75 octets, continuation lines start with a space. */
export function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  let curLen = 0;
  const limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    const budget = out.length === 0 ? limit : limit - 1;
    if (curLen + n > budget) {
      out.push(cur);
      cur = "";
      curLen = 0;
    }
    cur += ch;
    curLen += n;
  }
  if (cur) out.push(cur);
  return out.map((s, i) => (i === 0 ? s : " " + s)).join("\r\n");
}

function hashString(s: string): string {
  // Tiny non-cryptographic hash; only used to give synthesised UIDs some
  // stability. Real UIDs are taken straight from the vCard.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const SYSTEM: ReadonlyArray<[string, string]> = [
  ["$seen", "\\Seen"],
  ["$flagged", "\\Flagged"],
  ["$answered", "\\Answered"],
  ["$draft", "\\Draft"],
  ["$forwarded", "$Forwarded"],
  ["$junk", "$Junk"],
  ["$notjunk", "$NotJunk"],
  ["$phishing", "$Phishing"],
  ["$mdnsent", "$MDNSent"],
];

const KW_TO_FLAG = new Map<string, string>(SYSTEM);
const FLAG_TO_KW = new Map<string, string>(SYSTEM.map(([k, f]) => [f.toLowerCase(), k]));

// A user keyword travels as an IMAP atom (RFC 3501 §9: printable ASCII
// without "(", ")", "{", space, "%", "*", quoted-specials or "]") and the
// JMAP side allows exactly that set (RFC 8621 §4.1.1). ":" and "/" are part
// of it, which Bulwark uses in "$label:red" and in nested tags.
const UNSAFE_FLAG = /[^\x21-\x7e]|[(){%*"\\\]]/;
const MAX_KEYWORD = 255;

export function keywordToFlag(kw: string): string {
  const sys = KW_TO_FLAG.get(kw);
  if (sys) return sys;
  if (kw.length === 0 || kw.length > MAX_KEYWORD || UNSAFE_FLAG.test(kw)) throw new Error(`unsafe keyword: ${kw}`);
  return kw;
}

export function flagToKeyword(flag: string): string | null {
  const sys = FLAG_TO_KW.get(flag.toLowerCase());
  if (sys) return sys;
  if (flag.startsWith("\\")) return null;
  return flag.toLowerCase();
}

export function flagsToKeywords(flags: ReadonlyArray<string>): Record<string, true> {
  const out: Record<string, true> = {};
  for (const f of flags) {
    const k = flagToKeyword(f);
    if (k) out[k] = true;
  }
  return out;
}

export function keywordsToFlags(kws: Record<string, true>): string[] {
  return Object.keys(kws).map(keywordToFlag);
}

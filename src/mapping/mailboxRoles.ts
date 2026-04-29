const SPECIAL_USE: Record<string, string> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
  "\\All": "all",
  "\\Flagged": "flagged",
  "\\Important": "important",
};

const NAME_HEURISTICS: Record<string, string> = {
  inbox: "inbox",
  sent: "sent",
  "sent items": "sent",
  "sent mail": "sent",
  drafts: "drafts",
  draft: "drafts",
  trash: "trash",
  bin: "trash",
  "deleted items": "trash",
  "deleted messages": "trash",
  junk: "junk",
  spam: "junk",
  archive: "archive",
  archives: "archive",
  "all mail": "all",
  starred: "flagged",
  important: "important",
};

export function inferRole(opts: { name: string; specialUse?: string[] | null }): string | null {
  for (const f of opts.specialUse ?? []) {
    const r = SPECIAL_USE[f];
    if (r) return r;
  }
  const last = opts.name.split(/[/.]/).pop()!;
  return NAME_HEURISTICS[last.toLowerCase()] ?? null;
}

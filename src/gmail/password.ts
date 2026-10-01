import fs from "node:fs";
import { loadConfig } from "../util/config.js";
import { loadGmailConfig } from "./config.js";
import { GmailStore } from "./store.js";

// Write the secret to a NEW private file, never to logs or terminal output.
try {
  const cfg = loadConfig();
  const google = loadGmailConfig(cfg.publicUrl);
  const email = process.argv[2]?.toLowerCase();
  const output = process.argv[3];
  if (!google || !email || !output || !google.allowedEmails.has(email)) throw new Error();
  const store = new GmailStore(cfg.dataDir, cfg.vaultKey);
  try {
    const fd = fs.openSync(output, "wx", 0o600);
    try {
      const password = store.issuePassword(email);
      fs.writeFileSync(
        fd,
        JSON.stringify({ serverUrl: cfg.publicUrl, username: email, password }, null, 2) + "\n",
      );
    } finally {
      fs.closeSync(fd);
    }
    console.log("Bridge credentials saved to the requested private file. Previous bridge password revoked.");
  } finally {
    store.close();
  }
} catch {
  console.error("Cannot issue password: supply an allowed connected email and a new writable output path.");
  process.exitCode = 1;
}

import { loadConfig } from "../util/config.js";
import { loadGmailConfig } from "./config.js";
import { GmailStore } from "./store.js";
import { GmailConnection } from "./connection.js";

// Revokes the Google grant and deletes tokens, bridge password, cache and queues for one account.
async function main(): Promise<void> {
  const cfg = loadConfig();
  const google = loadGmailConfig(cfg.publicUrl);
  const email = process.argv[2]?.toLowerCase();
  if (!google || !email) throw new Error("Configure Gmail and supply an email address");
  const store = new GmailStore(cfg.dataDir, cfg.vaultKey);
  try {
    const revoked = await new GmailConnection(google, store).disconnect(email);
    console.log(
      revoked
        ? "Google grant revoked and all bridge data for the account deleted."
        : "Bridge data for the account deleted. Google did not confirm the revocation; remove access at https://myaccount.google.com/permissions.",
    );
  } finally {
    store.close();
  }
}
main().catch(() => {
  // Google errors may contain the request credentials. Never print them.
  console.error("Gmail disconnect failed. Verify the configuration and the email address.");
  process.exitCode = 1;
});

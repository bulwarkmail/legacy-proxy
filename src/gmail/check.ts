import { loadConfig } from "../util/config.js";
import { loadGmailConfig } from "./config.js";
import { GmailStore } from "./store.js";
import { GmailConnection } from "./connection.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const google = loadGmailConfig(cfg.publicUrl);
  const email = process.argv[2];
  if (!google || !email) throw new Error("Configure Gmail and supply an allowed email address");
  const store = new GmailStore(cfg.dataDir, cfg.vaultKey);
  try {
    const snapshot = await new GmailConnection(google, store).refreshSnapshot(email);
    console.log(
      JSON.stringify({
        connected: true,
        labels: snapshot.labels.length,
        messages: snapshot.profile.messagesTotal,
        threads: snapshot.profile.threadsTotal,
      }),
    );
  } finally {
    store.close();
  }
}
main().catch(() => {
  // Google errors may contain the request credentials. Never print them.
  console.error(
    "Gmail check failed. Verify the configuration, then reconnect if consent expired or was revoked.",
  );
  process.exitCode = 1;
});

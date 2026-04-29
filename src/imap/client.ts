import { ImapFlow } from "imapflow";
import type { Credentials } from "../auth/credentials.js";
import type { ProviderConfig } from "../util/config.js";
import { log } from "../util/log.js";

export interface ImapConnOpts {
  provider: ProviderConfig;
  creds: Credentials;
}

export async function openImap(opts: ImapConnOpts): Promise<ImapFlow> {
  const { provider, creds } = opts;
  let auth: { user: string; pass?: string; accessToken?: string };
  if (creds.mech === "XOAUTH2" && creds.accessToken) {
    auth = { user: creds.username, accessToken: creds.accessToken };
  } else if (creds.password) {
    auth = { user: creds.username, pass: creds.password };
  } else {
    throw new Error("openImap: no credentials supplied");
  }
  const client = new ImapFlow({
    host: provider.imap.host,
    port: provider.imap.port,
    secure: provider.imap.secure ?? true,
    auth,
    logger: false,
  });
  await client.connect();
  log.debug({ host: provider.imap.host, mech: creds.mech }, "imap connected");
  return client;
}

export async function withMailbox<T>(
  client: ImapFlow,
  path: string,
  fn: (lock: { release: () => void }) => Promise<T>,
): Promise<T> {
  const lock = await client.getMailboxLock(path);
  try {
    return await fn({ release: () => lock.release() });
  } finally {
    lock.release();
  }
}

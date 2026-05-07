import type { AppConfig, ProviderConfig } from "../util/config.js";
import {
  CONTACTS_CAPABILITY,
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SIEVE_CAPABILITY,
  SUBMISSION_CAPABILITY,
  VACATION_CAPABILITY,
  contactsCapabilityProps,
  coreCapabilityProps,
  mailCapabilityProps,
  submissionCapabilityProps,
} from "./capabilities.js";
import type { AccountRow } from "../state/store.js";

export function buildSession(cfg: AppConfig, account: AccountRow, provider?: ProviderConfig) {
  const accountId = String(account.id);
  const hasContacts = provider?.carddav != null;

  const accountCaps: Record<string, unknown> = {
    [MAIL_CAPABILITY]: mailCapabilityProps(),
    [SUBMISSION_CAPABILITY]: submissionCapabilityProps(),
    [VACATION_CAPABILITY]: {},
    [SIEVE_CAPABILITY]: {},
  };
  if (hasContacts) accountCaps[CONTACTS_CAPABILITY] = contactsCapabilityProps();

  const primaryAccounts: Record<string, string> = {
    [MAIL_CAPABILITY]: accountId,
    [SUBMISSION_CAPABILITY]: accountId,
    [VACATION_CAPABILITY]: accountId,
    [SIEVE_CAPABILITY]: accountId,
  };
  if (hasContacts) primaryAccounts[CONTACTS_CAPABILITY] = accountId;

  // WebSocket capability is held back until we register a /jmap/ws handler.
  // EventSource is fully wired (RFC 8620 §7.3): clients open the
  // `eventSourceUrl` and receive `state` events whenever any account-level
  // counter bumps. PushSubscription/* (§7.2) covers the offline path.
  const capabilities: Record<string, unknown> = {
    [CORE_CAPABILITY]: coreCapabilityProps(cfg),
    [MAIL_CAPABILITY]: mailCapabilityProps(),
    [SUBMISSION_CAPABILITY]: submissionCapabilityProps(),
    [VACATION_CAPABILITY]: {},
    [SIEVE_CAPABILITY]: {},
  };
  if (hasContacts) capabilities[CONTACTS_CAPABILITY] = contactsCapabilityProps();

  return {
    capabilities,
    accounts: {
      [accountId]: {
        name: account.username,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: accountCaps,
      },
    },
    primaryAccounts,
    username: account.username,
    apiUrl: `${cfg.publicUrl}/jmap`,
    downloadUrl: `${cfg.publicUrl}/jmap/download/{accountId}/{blobId}/{type}/{name}`,
    uploadUrl: `${cfg.publicUrl}/jmap/upload/{accountId}`,
    eventSourceUrl: `${cfg.publicUrl}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: `s${account.id}`,
  };
}

import type { AppConfig, ProviderConfig } from "../util/config.js";
import {
  CONTACTS_CAPABILITY,
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SIEVE_CAPABILITY,
  SUBMISSION_CAPABILITY,
  VACATION_CAPABILITY,
  WS_CAPABILITY,
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

  const capabilities: Record<string, unknown> = {
    [CORE_CAPABILITY]: coreCapabilityProps(cfg),
    [MAIL_CAPABILITY]: mailCapabilityProps(),
    [SUBMISSION_CAPABILITY]: submissionCapabilityProps(),
    [VACATION_CAPABILITY]: {},
    [WS_CAPABILITY]: { url: cfg.publicUrl.replace(/^http/, "ws") + "/jmap/ws", supportsPush: true },
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
    downloadUrl: `${cfg.publicUrl}/jmap/download/{accountId}/{blobId}/{name}`,
    uploadUrl: `${cfg.publicUrl}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${cfg.publicUrl}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: `s${account.id}`,
  };
}

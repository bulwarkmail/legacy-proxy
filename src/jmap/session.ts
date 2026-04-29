import type { AppConfig } from "../util/config.js";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SIEVE_CAPABILITY,
  SUBMISSION_CAPABILITY,
  VACATION_CAPABILITY,
  WS_CAPABILITY,
  coreCapabilityProps,
  mailCapabilityProps,
  submissionCapabilityProps,
} from "./capabilities.js";
import type { AccountRow } from "../state/store.js";

export function buildSession(cfg: AppConfig, account: AccountRow) {
  const accountId = String(account.id);
  return {
    capabilities: {
      [CORE_CAPABILITY]: coreCapabilityProps(cfg),
      [MAIL_CAPABILITY]: mailCapabilityProps(),
      [SUBMISSION_CAPABILITY]: submissionCapabilityProps(),
      [VACATION_CAPABILITY]: {},
      [WS_CAPABILITY]: { url: cfg.publicUrl.replace(/^http/, "ws") + "/jmap/ws", supportsPush: true },
      [SIEVE_CAPABILITY]: {},
    },
    accounts: {
      [accountId]: {
        name: account.username,
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          [MAIL_CAPABILITY]: mailCapabilityProps(),
          [SUBMISSION_CAPABILITY]: submissionCapabilityProps(),
          [VACATION_CAPABILITY]: {},
          [SIEVE_CAPABILITY]: {},
        },
      },
    },
    primaryAccounts: {
      [MAIL_CAPABILITY]: accountId,
      [SUBMISSION_CAPABILITY]: accountId,
      [VACATION_CAPABILITY]: accountId,
      [SIEVE_CAPABILITY]: accountId,
    },
    username: account.username,
    apiUrl: `${cfg.publicUrl}/jmap`,
    downloadUrl: `${cfg.publicUrl}/jmap/download/{accountId}/{blobId}/{name}`,
    uploadUrl: `${cfg.publicUrl}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${cfg.publicUrl}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
    state: `s${account.id}`,
  };
}

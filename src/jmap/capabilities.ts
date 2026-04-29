import type { AppConfig } from "../util/config.js";

export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";
export const VACATION_CAPABILITY = "urn:ietf:params:jmap:vacationresponse";
export const WS_CAPABILITY = "urn:ietf:params:jmap:websocket";
export const SIEVE_CAPABILITY = "urn:bulwark:params:jmap:sieve";
export const CONTACTS_CAPABILITY = "urn:ietf:params:jmap:contacts";

export function coreCapabilityProps(cfg: AppConfig) {
  return {
    maxSizeUpload: cfg.limits.maxSizeUpload,
    maxConcurrentUpload: 4,
    maxSizeRequest: cfg.limits.maxSizeRequest,
    maxConcurrentRequests: cfg.limits.maxConcurrentRequests,
    maxCallsInRequest: cfg.limits.maxCallsInRequest,
    maxObjectsInGet: cfg.limits.maxObjectsInGet,
    maxObjectsInSet: cfg.limits.maxObjectsInSet,
    collationAlgorithms: ["i;ascii-numeric", "i;ascii-casemap", "i;unicode-casemap"],
  };
}

export function mailCapabilityProps() {
  return {
    maxMailboxesPerEmail: null,
    maxMailboxDepth: null,
    maxSizeMailboxName: 490,
    maxSizeAttachmentsPerEmail: 50_000_000,
    emailQuerySortOptions: ["receivedAt", "from", "to", "subject", "size"],
    mayCreateTopLevelMailbox: true,
  };
}

export function submissionCapabilityProps() {
  return {
    maxDelayedSend: 0,
    submissionExtensions: {},
  };
}

export function contactsCapabilityProps() {
  return {};
}

import type { AppConfig } from "../util/config.js";

export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";
export const VACATION_CAPABILITY = "urn:ietf:params:jmap:vacationresponse";
export const WS_CAPABILITY = "urn:ietf:params:jmap:websocket";
export const SIEVE_CAPABILITY = "urn:bulwark:params:jmap:sieve";
export const CONTACTS_CAPABILITY = "urn:ietf:params:jmap:contacts";

// Every capability the /jmap endpoint accepts in a request's `using` list
// (RFC 8620 §3.6.1). Must cover everything buildSession can advertise —
// contacts was once missing here, so clients that saw it on the session
// object got a 400 unknownCapability back on their first request (issue #3).
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
  VACATION_CAPABILITY,
  SIEVE_CAPABILITY,
  CONTACTS_CAPABILITY,
]);

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
    // IMAP messages live in exactly one mailbox; expose the cap as 1 so
    // clients don't try to pin a draft into Inbox + Drafts simultaneously.
    maxMailboxesPerEmail: 1,
    maxMailboxDepth: null,
    maxSizeMailboxName: 490,
    maxSizeAttachmentsPerEmail: 50_000_000,
    // Without IMAP SORT, only UID-order (≈ receivedAt) is cheap. The other
    // properties would require fetching headers for every match before
    // sorting; refuse them up front so clients don't pick something we'll
    // bounce with `unsupportedSort`.
    emailQuerySortOptions: ["receivedAt"],
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

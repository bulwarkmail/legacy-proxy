import nodemailer from "nodemailer";
import type { Credentials } from "../auth/credentials.js";
import { assertTransport, transportOf } from "../auth/providers.js";
import type { ProviderConfig } from "../util/config.js";

export interface SubmitResult {
  messageId: string;
  envelope: { from: string; to: string[] };
  accepted: string[];
  rejected: string[];
  response: string;
}

export async function submit(opts: {
  provider: ProviderConfig;
  creds: Credentials;
  envelopeFrom: string;
  rcptTo: string[];
  raw: Buffer;
}): Promise<SubmitResult> {
  const { provider, creds, envelopeFrom, rcptTo, raw } = opts;

  // A plain connection is used only where the provider entry allows it; with
  // `starttls` nodemailer refuses to authenticate unless the upgrade happened.
  assertTransport("smtp", provider.smtp);
  const { secure, starttls } = transportOf("smtp", provider.smtp);
  const transport = nodemailer.createTransport({
    host: provider.smtp.host,
    port: provider.smtp.port,
    secure,
    requireTLS: starttls,
    auth: creds.mech === "XOAUTH2" && creds.accessToken
      ? { type: "OAuth2", user: creds.username, accessToken: creds.accessToken }
      : { user: creds.username, pass: creds.password ?? "" },
  });

  const info = await transport.sendMail({
    raw,
    envelope: { from: envelopeFrom, to: rcptTo },
  });

  return {
    messageId: info.messageId,
    envelope: { from: envelopeFrom, to: rcptTo },
    accepted: info.accepted as string[],
    rejected: info.rejected as string[],
    response: info.response,
  };
}

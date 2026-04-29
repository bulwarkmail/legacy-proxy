import nodemailer from "nodemailer";
import type { Credentials } from "../auth/credentials.js";
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

  const transport = nodemailer.createTransport({
    host: provider.smtp.host,
    port: provider.smtp.port,
    secure: provider.smtp.secure ?? provider.smtp.port === 465,
    requireTLS: provider.smtp.starttls === true,
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

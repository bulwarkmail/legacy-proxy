import nodemailer from "nodemailer";
import type { Credentials } from "../auth/credentials.js";
import { connectHost } from "../auth/discovery.js";
import { assertTransport, loginName, transportOf } from "../auth/providers.js";
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
  const target = await connectHost(provider, provider.smtp);
  const user = loginName(provider.smtp, creds.username);
  const transport = nodemailer.createTransport({
    host: target.host,
    ...(target.servername ? { servername: target.servername } : {}),
    port: provider.smtp.port,
    secure,
    requireTLS: starttls,
    auth: creds.mech === "XOAUTH2" && creds.accessToken
      ? { type: "OAuth2", user, accessToken: creds.accessToken }
      : { user, pass: creds.password ?? "" },
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

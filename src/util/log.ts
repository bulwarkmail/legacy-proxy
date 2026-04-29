import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "password",
      "authorization",
      "*.password",
      "*.authorization",
      "*.xoauth2",
      "*.vault",
      "credentials",
    ],
    remove: true,
  },
});

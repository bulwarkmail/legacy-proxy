import Fastify from "fastify";
import cors from "@fastify/cors";
import { expect, it } from "vitest";
import { CORS_MAX_AGE, corsOptions } from "../../src/util/cors.js";

it("lets the browser reuse a preflight instead of sending one before every JMAP call", async () => {
  const app = Fastify();
  await app.register(cors, corsOptions);
  app.post("/jmap", async () => ({}));
  const reply = await app.inject({
    method: "OPTIONS",
    url: "/jmap",
    headers: {
      origin: "https://webmail.example.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
    },
  });
  expect(reply.statusCode).toBe(204);
  expect(reply.headers["access-control-allow-origin"]).toBe("https://webmail.example.com");
  expect(reply.headers["access-control-max-age"]).toBe(String(CORS_MAX_AGE));
  await app.close();
});

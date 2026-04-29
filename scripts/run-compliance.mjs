#!/usr/bin/env node
// Runs the upstream `jmap-test-suite` against a running legacy-proxy instance.
//
// Prerequisites:
//   1. `compose.test.yml` is up: `docker compose -f compose.test.yml up -d`
//   2. The Stalwart container has a test user created - see
//      `test/integration/stalwart-config/README.md`.
//   3. Python 3.11+ available on PATH.
//
// We clone the suite into `vendor/jmap-test-suite/` if missing and invoke it
// against the proxy. A known-failures allowlist is read from
// `test/compliance/known-failures.txt`.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const VENDOR = path.join(ROOT, "vendor", "jmap-test-suite");
const ALLOW = path.join(ROOT, "test", "compliance", "known-failures.txt");

if (!existsSync(VENDOR)) {
  mkdirSync(path.dirname(VENDOR), { recursive: true });
  console.log("→ cloning jmapio/jmap-test-suite");
  const r = spawnSync(
    "git",
    [
      "clone",
      "--depth",
      "1",
      "https://github.com/jmapio/jmap-test-suite",
      VENDOR,
    ],
    {
      stdio: "inherit",
    },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const url = process.env.PROXY_URL ?? "http://localhost:8080/.well-known/jmap";
const user = process.env.PROXY_USER ?? "test@local";
const pass = process.env.PROXY_PASS ?? "test";

console.log(`→ running compliance suite against ${url}`);
const env = {
  ...process.env,
  JMAP_URL: url,
  JMAP_USER: user,
  JMAP_PASSWORD: pass,
};
const res = spawnSync("python3", ["-m", "pytest", "-q", "--tb=short"], {
  cwd: VENDOR,
  stdio: "inherit",
  env,
});

if (res.status === 0) {
  console.log("✓ compliance suite passed");
  process.exit(0);
}

if (existsSync(ALLOW)) {
  const allowlist = readFileSync(ALLOW, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
  console.warn(
    `⚠ compliance suite reported failures; ${allowlist.length} allow-listed`,
  );
  // If you want a stricter mode: enforce that *only* allow-listed tests failed.
  // For v1 we surface raw exit code and let CI track the trend.
}
process.exit(res.status ?? 1);

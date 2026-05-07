#!/usr/bin/env node
// Runs the upstream jmap-test-suite (TypeScript CLI from jmapio/jmap-test-suite)
// against a running legacy-proxy and triages the result against an allowlist of
// known failures rooted in IMAP-backend limitations.
//
// Steps:
//   1. Load .env.local (PROXY_URL, JMAP_USER_PRIMARY/SECONDARY, JMAP_PASS_*).
//   2. Probe the proxy.
//   3. Clone vendor/jmap-test-suite/ (if missing), npm install, npm run build.
//   4. Generate vendor/jmap-test-suite/config.local.json (gitignored).
//   5. Run `node dist/cli.js -c config.local.json -o report.json`.
//   6. Read report.json, classify failures vs. test/compliance/known-failures.txt.
//   7. Exit 0 if all required tests pass or only allow-listed required tests fail,
//      otherwise exit 1.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "vendor", "jmap-test-suite");
const REPORT = path.join(ROOT, "test", "compliance", "report.json");
const ALLOW = path.join(ROOT, "test", "compliance", "known-failures.txt");
const CONFIG = path.join(VENDOR, "config.local.json");

// ---- env --------------------------------------------------------------------

for (const f of [".env.local", ".env"]) {
  const p = path.join(ROOT, f);
  if (existsSync(p)) {
    try { loadEnvFile(p); } catch { /* ignore parse errors, fall back to process env */ }
  }
}

const PROXY_URL = process.env.PROXY_URL ?? "http://127.0.0.1:8080/.well-known/jmap";
const PRIMARY_USER = process.env.JMAP_USER_PRIMARY;
const PRIMARY_PASS = process.env.JMAP_PASS_PRIMARY;
const SECONDARY_USER = process.env.JMAP_USER_SECONDARY;
const SECONDARY_PASS = process.env.JMAP_PASS_SECONDARY;
const FORCE = process.argv.includes("--force") || process.argv.includes("-f");
const FILTER = argFlag("--filter");
const VERBOSE = process.argv.includes("--verbose");

if (!PRIMARY_USER || !PRIMARY_PASS) {
  fail(
    "missing JMAP_USER_PRIMARY / JMAP_PASS_PRIMARY in env (.env.local or process env).\n" +
    "Add them to .env.local. Optional: JMAP_USER_SECONDARY/JMAP_PASS_SECONDARY enable EmailSubmission tests.",
  );
}

// ---- 1. probe proxy --------------------------------------------------------

await probeProxy(PROXY_URL, PRIMARY_USER, PRIMARY_PASS);

// ---- 2. ensure vendored suite is built -------------------------------------

if (!existsSync(VENDOR)) {
  mkdirSync(path.dirname(VENDOR), { recursive: true });
  log(`→ cloning jmapio/jmap-test-suite into ${rel(VENDOR)}`);
  runOrDie("git", ["clone", "--depth", "1", "https://github.com/jmapio/jmap-test-suite", VENDOR]);
}

if (needsInstall(VENDOR)) {
  log("→ npm install (vendor/jmap-test-suite)");
  runOrDie("npm", ["install", "--no-audit", "--no-fund"], { cwd: VENDOR, shell: true });
}

if (needsBuild(VENDOR)) {
  log("→ npm run build (vendor/jmap-test-suite)");
  runOrDie("npm", ["run", "build"], { cwd: VENDOR, shell: true });
}

// ---- 3. generate config.local.json -----------------------------------------

const config = {
  sessionUrl: PROXY_URL,
  serverInfo: "legacy-proxy",
  users: {
    primary: { username: PRIMARY_USER, password: PRIMARY_PASS },
    ...(SECONDARY_USER && SECONDARY_PASS
      ? { secondary: { username: SECONDARY_USER, password: SECONDARY_PASS } }
      : {}),
  },
  authMethod: "basic",
  timeout: 30000,
  verbose: VERBOSE,
};
writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });

// ---- 4. run the suite ------------------------------------------------------

mkdirSync(path.dirname(REPORT), { recursive: true });

const args = [
  path.join("dist", "cli.js"),
  "-c", path.relative(VENDOR, CONFIG),
  "-o", path.relative(VENDOR, REPORT),
];
if (FORCE) args.push("-f");
if (FILTER) args.push("--filter", FILTER);
if (VERBOSE) args.push("--verbose");

log(`→ running suite against ${PROXY_URL}`);
const run = spawnSync(process.execPath, args, { cwd: VENDOR, stdio: "inherit" });

// upstream exit codes: 0 = all required pass, 1 = required failed, 2 = fatal
if (run.status === 2) {
  fail("upstream suite reported a fatal error (exit 2). See output above.");
}
if (!existsSync(REPORT)) {
  fail(`upstream suite did not produce ${rel(REPORT)} (exit ${run.status}).`);
}

// ---- 5. triage report ------------------------------------------------------

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const allowlist = readAllowlist(ALLOW);

const failed = report.results.filter((r) => r.status === "fail");
const reqFailed = failed.filter((r) => r.required);
const recFailed = failed.filter((r) => !r.required);
const allowed = reqFailed.filter((r) => allowlist.has(r.testId));
const surprises = reqFailed.filter((r) => !allowlist.has(r.testId));
const unusedAllowlist = [...allowlist].filter(
  (id) => !failed.some((r) => r.testId === id),
);

const s = report.summary;
const dur = (report.durationMs / 1000).toFixed(1);
log("");
log("compliance summary");
log("==================");
log(`  total       ${s.total}`);
log(`  passed      ${s.passed}   (required ${s.requiredPassed}, recommended ${s.recommendedPassed})`);
log(`  failed      ${s.failed}   (required ${s.requiredFailed}, recommended ${s.recommendedFailed})`);
log(`  skipped     ${s.skipped}`);
log(`  duration    ${dur}s`);
log(`  report      ${rel(REPORT)}`);

if (surprises.length) {
  log("");
  log(`✗ ${surprises.length} required failure(s) NOT in allowlist:`);
  for (const r of surprises) log(`    ${r.testId} — ${r.name ?? ""}`);
}
if (allowed.length) {
  log("");
  log(`· ${allowed.length} required failure(s) allow-listed:`);
  for (const r of allowed) log(`    ${r.testId}`);
}
if (recFailed.length) {
  log("");
  log(`· ${recFailed.length} recommended failure(s):`);
  for (const r of recFailed) log(`    ${r.testId} — ${r.name ?? ""}`);
}
if (unusedAllowlist.length) {
  log("");
  log(`· ${unusedAllowlist.length} allowlist entr${unusedAllowlist.length === 1 ? "y is" : "ies are"} stale (test passed or not found):`);
  for (const id of unusedAllowlist) log(`    ${id}`);
}

if (surprises.length === 0 && s.requiredFailed >= 0) {
  log("");
  log(s.requiredFailed === 0 ? "✓ all required tests passed" : "✓ all required failures are allow-listed");
  process.exit(0);
}
process.exit(1);

// ---- helpers ---------------------------------------------------------------

function log(msg) { process.stderr.write(msg + "\n"); }

function fail(msg) {
  process.stderr.write(`compliance: ${msg}\n`);
  process.exit(2);
}

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function rel(p) { return path.relative(ROOT, p) || p; }

function needsInstall(dir) {
  return !existsSync(path.join(dir, "node_modules", ".package-lock.json"));
}

function needsBuild(dir) {
  const cli = path.join(dir, "dist", "cli.js");
  if (!existsSync(cli)) return true;
  const builtAt = statSync(cli).mtimeMs;
  const srcDir = path.join(dir, "src");
  if (!existsSync(srcDir)) return true;
  // Cheap check: any .ts under src/ newer than dist/cli.js means we should rebuild.
  const newer = newestMtime(srcDir);
  return newer > builtAt;
}

function newestMtime(dir) {
  let max = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else max = Math.max(max, statSync(p).mtimeMs);
    }
  }
  return max;
}

function runOrDie(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

function readAllowlist(p) {
  if (!existsSync(p)) return new Set();
  return new Set(
    readFileSync(p, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

async function probeProxy(url, user, pass) {
  try {
    const r = await fetch(url, {
      headers: { authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64") },
      redirect: "follow",
    });
    if (!r.ok) fail(`proxy probe ${url} returned HTTP ${r.status}. Is the proxy running and the user valid?`);
  } catch (e) {
    fail(`proxy probe ${url} failed: ${e.message}\nIs the proxy running on PROXY_URL?`);
  }
}

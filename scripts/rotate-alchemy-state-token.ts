#!/usr/bin/env bun
/**
 * Rotate ALCHEMY_STATE_TOKEN — the ONE shared BEARER credential for the account-wide Alchemy state
 * worker (`alchemy-state-service`, ADR 0044 D4/D5). The worker checks this token on every request (it
 * is the worker's `STATE_TOKEN` binding); it is NOT an at-rest encryption key — Alchemy stores state
 * verbatim and encrypts any secret *values* under a separate `ALCHEMY_PASSWORD` this repo does not use.
 * The token lives in THREE copies that must be byte-for-byte identical, or every `bun alchemy.run.ts`
 * fails with `[CloudflareStateStore] The token is invalid` (401):
 *
 *   1. the live worker's `STATE_TOKEN` binding — changes ONLY on a `forceUpdate` deploy;
 *   2. `~/.alchemy/lesto-alchemy-state-token.txt` — the durable local copy operators export;
 *   3. the `ALCHEMY_STATE_TOKEN` GitHub Actions secret — what CI deploys with.
 *
 * Copy #1 does not follow #2/#3, so changing the file or the secret alone silently drifts → 401. That
 * is the footgun that broke the deploy pipeline once. This script derives all three from a single
 * freshly-generated value, in this order:
 *
 *   1. re-key the worker by deploying ONE example with `ALCHEMY_STATE_FORCE_UPDATE=1` (the env-gate in
 *      every `alchemy.run.ts`). Alchemy polls the re-keyed worker with the new token during the
 *      deploy, so a successful deploy IS proof the worker accepts it.
 *   2. write the new token to the local file (mode 600) and set the GitHub secret;
 *   3. dispatch `deploy-examples` as a SMOKE TEST — confirms every app deploys green now that CI's
 *      secret matches the re-keyed worker (NOT a re-encryption: the token is a bearer credential, so
 *      re-keying it changes nothing in stored state).
 *
 * Recovery: `forceUpdate` overwrites the worker's token unconditionally, so re-running this script is
 * always safe and is how you recover from any partial failure (see the runbook).
 *
 *   bun scripts/rotate-alchemy-state-token.ts            # dry-run: print the plan, change nothing
 *   bun scripts/rotate-alchemy-state-token.ts --confirm  # actually rotate
 *
 * Prereqs (local): an `alchemy login` profile (~/.alchemy/credentials) for the CF account, and an
 * authenticated `gh` for the repo. See docs/runbooks/rotate-alchemy-state-token.md.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_NAME = "ALCHEMY_STATE_TOKEN";
const FORCE_ENV = "ALCHEMY_STATE_FORCE_UPDATE";
const WORKFLOW = "deploy-examples.yml";
const STAGE = "prod";
// The account-wide worker is shared by every app, so re-keying through any one example re-keys it for
// all. mcp-auth-openauth is the canonical pick (it deploys under `prod`, the stage CI owns).
const REKEY_EXAMPLE = "examples/mcp-auth-openauth";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tokenFile = join(homedir(), ".alchemy", "lesto-alchemy-state-token.txt");
const confirmed = process.argv.includes("--confirm") || process.argv.includes("-y");

function readCurrentToken(): string | undefined {
  try {
    return readFileSync(tokenFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? process.env,
    input: opts.input,
    // Inherit stdout/stderr so the operator watches the live deploy; keep stdin a pipe when we feed a
    // value (the token) so it never lands in a visible arg or the shell history.
    stdio: [opts.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    encoding: "utf8",
  });
  // spawnSync does NOT throw when the binary is missing — it returns `{ error, status: null }`. Surface
  // the real cause (e.g. an ENOENT "gh not found") instead of an opaque "exited with null".
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited with ${res.status ?? res.signal}`);
  }
}

// Quiet precondition probe: true iff `cmd args` exits 0, with no output shown.
function ok(cmd: string, args: string[]): boolean {
  return spawnSync(cmd, args, { cwd: repoRoot, stdio: "ignore" }).status === 0;
}

const current = readCurrentToken();

if (!confirmed) {
  console.log("Alchemy state-token rotation — DRY RUN (pass --confirm to execute)\n");
  console.log("Would:");
  console.log(`  1. re-key the shared 'alchemy-state-service' worker via ${REKEY_EXAMPLE}`);
  console.log(`     (\`${FORCE_ENV}=1 ALCHEMY_STAGE=${STAGE} bun alchemy.run.ts\`)`);
  console.log(`  2. write a new 32-byte token to ${tokenFile} (mode 600) + set the '${SECRET_NAME}' GitHub secret`);
  console.log(`  3. dispatch '${WORKFLOW}' as a smoke test (all apps deploy green under the new secret)`);
  console.log(`\nCurrent local token: ${current ? `present (${current.length} chars)` : "MISSING"}`);
  console.log("Prereqs: `alchemy login` profile + authenticated `gh`.");
  process.exit(0);
}

// Pre-flight — cheap, reversible checks run BEFORE the irreversible re-key, so the common operator
// slips fail at zero blast radius instead of mid-rotation:
//   - `gh` must be authenticated, or step 2's secret-set would strand CI on the old token;
//   - the tree must be clean, because the re-key redeploys `REKEY_EXAMPLE` to PROD from local
//     working-tree code — a dirty tree would ship uncommitted changes to production. (Untracked files
//     are ignored: this repo always carries scratch; only tracked modifications reach the bundle.)
if (!ok("gh", ["auth", "status"])) {
  console.error("✗ `gh` is not authenticated (`gh auth status` failed). Run `gh auth login`, then re-run.");
  process.exit(1);
}
if (!ok("git", ["diff", "--quiet", "HEAD"])) {
  console.error(`✗ Working tree has uncommitted changes — the re-key redeploys ${REKEY_EXAMPLE} to prod`);
  console.error("  from local code. Commit or stash first, then re-run.");
  process.exit(1);
}

const next = randomBytes(32).toString("hex");
const deployEnv = { ...process.env, [FORCE_ENV]: "1", [SECRET_NAME]: next, ALCHEMY_STAGE: STAGE };

// STEP 1 — re-key the shared worker: the one hard-to-undo step, so it runs first. On success the
// worker accepts `next` (Alchemy polls it with the new token during the deploy). The re-key happens
// early in the deploy, so a failure AFTER it may leave the worker already re-keyed to `next` — which
// this run has not saved. That is recoverable (re-running force-overwrites the worker to a fresh,
// saved token), so the failure message says so instead of claiming nothing changed.
console.log(`[1/3] Re-keying 'alchemy-state-service' via ${REKEY_EXAMPLE} (forceUpdate, stage=${STAGE})…`);
try {
  run("bun", ["alchemy.run.ts"], { cwd: join(repoRoot, REKEY_EXAMPLE), env: deployEnv });
} catch (error) {
  console.error(`\n✗ Re-key deploy failed. The local file + CI secret are UNCHANGED (still the old token).`);
  console.error(`  If deploys start failing with a 401, the worker was re-keyed before the deploy errored —`);
  console.error(`  just re-run this script to rotate to a fresh, saved token.`);
  console.error(`  ${(error as Error).message}`);
  process.exit(1);
}

// STEP 2 — persist the new token locally (mode 600, no trailing newline — the value must match the
// worker binding and the secret exactly; a stray newline would 401) and set the GitHub secret (piped
// via stdin, never an arg). If the secret-set fails, the worker + file already hold the new token, so
// point the operator at the one command that finishes the job.
console.log(`[2/3] Writing ${tokenFile} (mode 600) + setting the '${SECRET_NAME}' secret…`);
mkdirSync(dirname(tokenFile), { recursive: true });
writeFileSync(tokenFile, next, { mode: 0o600 });
chmodSync(tokenFile, 0o600);
try {
  run("gh", ["secret", "set", SECRET_NAME], { input: next });
} catch (error) {
  console.error(`\n✗ Failed to set the GitHub secret — the worker + ${tokenFile} are ALREADY on the new token.`);
  console.error(`  Finish manually:  gh secret set ${SECRET_NAME} < ${tokenFile}`);
  console.error(`  ${(error as Error).message}`);
  process.exit(1);
}

// STEP 3 — dispatch the deploy workflow as a SMOKE TEST: every app should deploy green now that CI's
// secret matches the re-keyed worker. Best-effort — the token is already rotated; a dispatch hiccup
// just means "push to main / dispatch it yourself".
console.log(`[3/3] Dispatching '${WORKFLOW}' as a smoke test (all apps green under the new secret)…`);
try {
  run("gh", ["workflow", "run", WORKFLOW, "--ref", "main"], {});
} catch (error) {
  console.warn(`\n! Could not dispatch ${WORKFLOW} (token IS rotated). Trigger it yourself:`);
  console.warn(`  gh workflow run ${WORKFLOW} --ref main   # or just push to main`);
  console.warn(`  ${(error as Error).message}`);
}

console.log(`\n✓ Rotated. Worker binding, ${tokenFile}, and the '${SECRET_NAME}' secret now agree.`);
console.log(`  Watch it:  gh run list --workflow=${WORKFLOW} --limit 1   →   gh run watch <run-id>`);

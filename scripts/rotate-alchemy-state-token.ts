#!/usr/bin/env bun
/**
 * Rotate ALCHEMY_STATE_TOKEN — the ONE shared secret behind the account-wide Alchemy state worker
 * (`alchemy-state-service`, ADR 0044 D4/D5). The token lives in THREE places that must be byte-for-
 * byte identical, or `bun alchemy.run.ts` fails with a `[CloudflareStateStore] token is invalid` 401:
 *
 *   1. the live `alchemy-state-service` worker's `STATE_TOKEN` binding — the auth + state-encryption
 *      passphrase. It ONLY changes on a `forceUpdate` deploy; setting #2/#3 alone silently drifts.
 *   2. `~/.alchemy/lesto-alchemy-state-token.txt` — the durable local copy operators export.
 *   3. the `ALCHEMY_STATE_TOKEN` GitHub Actions secret — what CI deploys with.
 *
 * Rotating by hand means keeping all three in sync in the right order — the exact footgun that broke
 * the deploy pipeline once already (the worker was re-keyed but the secret was left on the old value).
 * This script does it as one atomic operation, deriving all three from a single freshly-generated
 * value so they CANNOT drift:
 *
 *   1. generate a new 32-byte token;
 *   2. re-key the worker by deploying ONE example with `ALCHEMY_STATE_FORCE_UPDATE=1` (the env-gate in
 *      every `alchemy.run.ts`) — its success IS proof the worker now accepts the new token;
 *   3. write the new token to the local file (mode 600) and set the GitHub secret;
 *   4. dispatch the `deploy-examples` workflow so CI redeploys EVERY sharing app under the new token
 *      — required because the token also encrypts state secrets, so each app must re-encrypt.
 *
 * If step 2 fails, nothing else is touched — the old token stays authoritative everywhere.
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

const SECRET_NAME = "ALCHEMY_STATE_TOKEN";
const FORCE_ENV = "ALCHEMY_STATE_FORCE_UPDATE";
const WORKFLOW = "deploy-examples.yml";
const STAGE = "prod";
// The account-wide worker is shared by every app, so re-keying through any one example re-keys it for
// all. mcp-auth-openauth is the canonical pick (it deploys under `prod`, the stage CI owns).
const REKEY_EXAMPLE = "examples/mcp-auth-openauth";

const repoRoot = new URL("../", import.meta.url).pathname;
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
    // Inherit stdout/stderr so the operator watches the live deploy; keep stdin as a pipe when we
    // feed a value (the token) so it never lands in a visible arg or the shell history.
    stdio: [opts.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` exited with ${res.status ?? res.signal}`);
  }
}

const current = readCurrentToken();

if (!confirmed) {
  console.log("Alchemy state-token rotation — DRY RUN (pass --confirm to execute)\n");
  console.log("Would, as one atomic operation:");
  console.log(`  1. generate a new 32-byte ${SECRET_NAME}`);
  console.log(`  2. re-key the shared 'alchemy-state-service' worker via ${REKEY_EXAMPLE}`);
  console.log(`     (\`${FORCE_ENV}=1 ALCHEMY_STAGE=${STAGE} bun alchemy.run.ts\`)`);
  console.log(`  3. write it to ${tokenFile} (mode 600) and set the '${SECRET_NAME}' GitHub secret`);
  console.log(`  4. dispatch the '${WORKFLOW}' workflow so CI redeploys every app under the new token`);
  console.log(`\nCurrent local token: ${current ? `present (${current.length} chars)` : "MISSING"}`);
  console.log("Prereqs: `alchemy login` profile + authenticated `gh`.");
  process.exit(0);
}

const next = randomBytes(32).toString("hex");
const deployEnv = { ...process.env, [FORCE_ENV]: "1", [SECRET_NAME]: next, ALCHEMY_STAGE: STAGE };

// STEP 1 — re-key the shared worker (the only irreversible-if-half-done step). Do it FIRST: if the
// deploy fails, we abort before touching the local file or the CI secret, so the old token stays
// authoritative in all three places and nothing is left inconsistent.
console.log(`[1/4] Re-keying 'alchemy-state-service' via ${REKEY_EXAMPLE} (forceUpdate, stage=${STAGE})…`);
try {
  run("bun", ["alchemy.run.ts"], { cwd: join(repoRoot, REKEY_EXAMPLE), env: deployEnv });
} catch (error) {
  console.error(`\n✗ Re-key deploy failed — token NOT rotated, everything still on the old value.`);
  console.error(`  ${(error as Error).message}`);
  process.exit(1);
}

// STEP 2 — persist the new token locally (mode 600, no trailing newline: the value must match the
// worker binding and the secret exactly, and a stray newline would 401).
console.log(`[2/4] Writing ${tokenFile} (mode 600)…`);
mkdirSync(dirname(tokenFile), { recursive: true });
writeFileSync(tokenFile, next, { mode: 0o600 });
chmodSync(tokenFile, 0o600);

// STEP 3 — set the GitHub secret (value via stdin, never an arg). If this fails the worker + local
// file are already on the new token, so tell the operator the one manual command left to run.
console.log(`[3/4] Setting the '${SECRET_NAME}' GitHub secret…`);
try {
  run("gh", ["secret", "set", SECRET_NAME], { input: next });
} catch (error) {
  console.error(`\n✗ Failed to set the GitHub secret — worker + ${tokenFile} are ALREADY on the new token.`);
  console.error(`  Finish manually:  gh secret set ${SECRET_NAME} < ${tokenFile}`);
  console.error(`  ${(error as Error).message}`);
  process.exit(1);
}

// STEP 4 — redeploy EVERY sharing app under the new token so each re-encrypts its state secrets.
// Best-effort: the token is already rotated; a dispatch hiccup just means "push to main to redeploy".
console.log(`[4/4] Dispatching '${WORKFLOW}' so CI redeploys all apps under the new token…`);
try {
  run("gh", ["workflow", "run", WORKFLOW, "--ref", "main"], {});
} catch (error) {
  console.warn(`\n! Could not dispatch ${WORKFLOW} (token IS rotated). Trigger a redeploy manually:`);
  console.warn(`  gh workflow run ${WORKFLOW} --ref main   # or just push to main`);
  console.warn(`  ${(error as Error).message}`);
}

console.log(`\n✓ Rotated. Worker binding, ${tokenFile}, and the '${SECRET_NAME}' secret now agree.`);
console.log(`  Watch the redeploy:  gh run watch --workflow=${WORKFLOW}`);

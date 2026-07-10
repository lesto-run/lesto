#!/usr/bin/env bash
# `bun run release:cut` — the ONE scripted way to publish a release. It replaces the
# error-prone 5-step manual dance (touch pause flag; `gh variable set RELEASE_ENABLED
# true`; `gh workflow run release.yml`; watch; set false; rm flag) with a single atomic
# quiesce→arm→dispatch→watch→cleanup run whose cleanup ALWAYS fires.
#
# WHY THIS EXISTS (the 0.1.7 near-miss). The green-CI gate in release.yml is already the
# complete publish gate — it refuses to publish unless ci.yml concluded `success` for the
# exact dispatched SHA, and ci.yml has NO continue-on-error, so a green ci.yml means every
# job passed (typecheck, lint, the 100%-coverage gate, bundler-parity, the whole browser-e2e
# suite, install-proof, import-proof). The 0.1.7 miss was PROCEDURAL, not a gate hole: the
# operator trusted the LOCAL fast-gate set (typecheck/lint/unit/pack-import/pack-boot — which
# OMITS the browser e2e) as the readiness oracle and started the manual arm/dispatch dance on a
# SHA whose ci.yml was actually red. The gate would have refused, but effort was burned and
# RELEASE_ENABLED was left armed. And the manual dance was twice left half-done (a timeout once
# skipped cleanup, leaving the pause flag + the RELEASE_ENABLED token set).
#
# THE FIX, two parts:
#   1. PRECONDITION #1 — ci.yml green for THIS exact HEAD SHA is checked HERE, locally, before
#      anything is armed. It reuses release.yml's exact gate query, so the LOCAL readiness oracle
#      is now identical to the one that actually gates publish — the browser e2e is no longer
#      skippable by trusting the fast-gate set. (The gate in release.yml still runs at publish
#      time; this is the fail-fast copy so we never arm on a red SHA.)
#   2. A trap on EXIT/INT/TERM that ALWAYS disarms RELEASE_ENABLED and removes the pause flag —
#      a Ctrl-C, a timeout, or a failed dispatch can no longer leave the surface armed or main
#      quiesced. Safe-at-rest (RELEASE_ENABLED=false, no pause flag) is restored unconditionally.
#
# WHAT IT DOES NOT DO: it does not bump versions or record changesets — that is the operator's
# job (`bun changeset` / `bun run version`, see RELEASING.md steps 1–4). This script is only the
# final "publish the already-prepared tree" step, and it refuses to run unless the tree is ready.
#
# GATE COVERAGE CAVEAT (folded-in residual): the green-CI precondition enforces ci.yml ONLY.
# Other push-triggered workflows (live-capstone-e2e.yml, deploy-examples.yml) are NOT release-
# blocking — see the RELEASE-GATE INVARIANT comment in .github/workflows/ci.yml. If a check must
# block a release, it has to be a job IN ci.yml.
#
# Usage:
#   bun run release:cut            # interactive: run checks, confirm, then arm+dispatch+watch
#   bun run release:cut --yes      # skip the final confirm (still runs every precondition)
#   bun run release:cut --dry-run  # run every precondition and STOP before arming (mutates nothing)
set -euo pipefail

# --- config -----------------------------------------------------------------
WORKFLOW="release.yml"          # the workflow we dispatch (must match ci.yml's --workflow= gate target)
CI_WORKFLOW="ci.yml"            # the workflow whose green-for-this-SHA is precondition #1
RELEASE_VAR="RELEASE_ENABLED"   # the admin-gated repo variable that arms release.yml
PAUSE_FLAG="$HOME/.studio/.push-main-paused"  # freezes origin/main during the window (push-main.sh honors it)

# --- args -------------------------------------------------------------------
YES="${RELEASE_CUT_YES:-}"      # env escape hatch, same effect as --yes
DRY_RUN=""
for arg in "$@"; do
  case "$arg" in
    --yes | -y) YES=1 ;;
    --dry-run | -n) DRY_RUN=1 ;;
    *) echo "release:cut: unknown argument '$arg' (accepted: --yes/-y, --dry-run/-n)" >&2; exit 2 ;;
  esac
done

# --- helpers ----------------------------------------------------------------
repo_root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

fail() { echo "release:cut: FAILED — $*" >&2; exit 1; }
step() { echo "release:cut: $*"; }

# ---------------------------------------------------------------------------
# PRECONDITIONS — all fail-closed, and ALL run BEFORE any mutation. The trap is
# not installed until they pass, so a precondition failure cannot disarm a state
# it never touched.
# ---------------------------------------------------------------------------

# gh present + authenticated — we must be able to BOTH arm and (critically) disarm.
command -v gh >/dev/null 2>&1 || fail "the GitHub CLI (gh) is not installed — it is required to arm/dispatch/disarm the release."
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated (run 'gh auth login'). Arming without being able to disarm is unsafe — refusing."

# On main. release.yml dispatches --ref main, so the tree we validate must BE main.
branch="$(git symbolic-ref --quiet --short HEAD || echo DETACHED)"
[ "$branch" = "main" ] || fail "not on main (on '$branch'). Releases cut from main only."

# Clean working tree — no uncommitted change can sneak into (or be missing from) the release.
[ -z "$(git status --porcelain)" ] || fail "working tree is not clean. Commit or stash first — CI publishes origin's tree, not your local edits."

# origin/main == HEAD. release.yml checks out ORIGIN at --ref main; if origin lags your HEAD, CI
# silently builds a STALE tree and the green-CI gate then validates the wrong SHA. Fetch, then
# compare HEAD to the fetched main tip (FETCH_HEAD is unambiguous — the exact ref we just fetched).
step "fetching origin/main..."
git fetch --quiet origin main || fail "git fetch origin main failed."
head_sha="$(git rev-parse HEAD)"
origin_sha="$(git rev-parse FETCH_HEAD)"
[ "$head_sha" = "$origin_sha" ] || fail "origin/main ($origin_sha) is not at HEAD ($head_sha). Push (or wait for the push agent) so origin's tip IS your release SHA, then re-run."

# Changesets consumed. After `bun run version` the per-change `.changeset/*.md` files are deleted,
# leaving only README.md (and the non-.md config.json). A leftover .md means the bump was not run
# (or not committed) — publishing now would ship un-versioned packages.
leftover_changesets="$(find .changeset -maxdepth 1 -type f -name '*.md' ! -name 'README.md' 2>/dev/null || true)"
[ -z "$leftover_changesets" ] || fail $'unconsumed changesets remain — run `bun run version` and commit the result first:\n'"$leftover_changesets"

# Versions bumped off the 0.0.0 placeholder. This reuses publish.mjs's OWN assertVersionsBumped and
# the shared publishable-dir filter (pack-public.mjs), so the local check is identical to the one the
# release enforces — no drift. A package sits at 0.0.0 until `changeset version` bumps it; publishing
# an un-bumped package pins npm `latest` to 0.0.0 and desyncs the changeset `fixed` group.
step "verifying every publishable package is bumped off 0.0.0..."
if ! version_info="$(node --input-type=module -e '
  import { readPublicPackageDirs } from "./scripts/lib/pack-public.mjs";
  import { assertVersionsBumped } from "./scripts/publish.mjs";
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  const P = join(process.cwd(), "packages");
  const nodes = readPublicPackageDirs(P).map((dir) => {
    const m = JSON.parse(readFileSync(join(P, dir, "package.json"), "utf8"));
    return { name: m.name, version: m.version };
  });
  assertVersionsBumped(nodes);
  const versions = [...new Set(nodes.map((n) => n.version))].sort();
  process.stdout.write(`${nodes.length} publishable packages @ ${versions.join(", ")}`);
' 2>&1)"; then
  fail "$version_info"
fi

# PRECONDITION #1 — ci.yml concluded `success` for THIS exact SHA. This is the SAME query
# release.yml runs at publish time (gh run list --workflow=ci.yml --event push --commit <sha>),
# lifted here so we fail fast BEFORE arming rather than after burning a dispatched run. `--event
# push` pins it to the push-to-main run (not a stale pull_request run sharing the head SHA).
# Fail-CLOSED: no run / still running / any non-success all abort.
step "checking $CI_WORKFLOW is green for $head_sha..."
if ! ci_result="$(gh run list --workflow="$CI_WORKFLOW" --event push --commit "$head_sha" --limit 1 \
  --json status,conclusion,databaseId \
  --jq 'if length == 0 then "none none 0" else "\(.[0].status) \(.[0].conclusion) \(.[0].databaseId)" end' 2>&1)"; then
  fail "could not query CI status via gh: $ci_result"
fi
ci_status="$(printf '%s' "$ci_result" | cut -d' ' -f1)"
ci_conclusion="$(printf '%s' "$ci_result" | cut -d' ' -f2)"
ci_run_id="$(printf '%s' "$ci_result" | cut -d' ' -f3)"
if [ "$ci_status" = "none" ]; then
  fail "no $CI_WORKFLOW push run found for $head_sha. Push it, let CI run to green, then re-run. (CI is the full gate: browser e2e included — do NOT trust the local fast-gate set as the readiness oracle.)"
fi
if [ "$ci_status" != "completed" ] || [ "$ci_conclusion" != "success" ]; then
  fail "$CI_WORKFLOW for $head_sha is not green (status=$ci_status conclusion=$ci_conclusion, run $ci_run_id). Wait for it to conclude success, then re-run."
fi
step "CI is green for $head_sha (run $ci_run_id)."

# --- summary + confirm ------------------------------------------------------
echo
echo "  Release preflight PASSED:"
echo "    SHA            $head_sha (origin/main == HEAD)"
echo "    surface        $version_info"
echo "    CI             $CI_WORKFLOW run $ci_run_id green"
echo
echo "  Next: quiesce main (pause the push agent), arm $RELEASE_VAR=true, dispatch $WORKFLOW --ref main,"
echo "  watch it to completion, then ALWAYS disarm + un-quiesce (via a trap, even on Ctrl-C/failure)."
echo

if [ -n "$DRY_RUN" ]; then
  step "--dry-run: preconditions passed. Stopping BEFORE arming — nothing was mutated."
  exit 0
fi

if [ -z "$YES" ]; then
  if [ ! -t 0 ]; then
    fail "not a TTY and --yes/-y not given — refusing to arm publishing unattended. Re-run with --yes if intentional."
  fi
  printf "  Publish is IRREVERSIBLE (npm is immutable). Proceed? [y/N] "
  read -r reply
  case "$reply" in
    y | Y | yes | YES) : ;;
    *) fail "aborted by operator — nothing was mutated." ;;
  esac
fi

# ---------------------------------------------------------------------------
# MUTATION PHASE. The trap is installed FIRST, so from here on any exit path —
# success, error under `set -e`, or a signal — runs cleanup and restores
# safe-at-rest (RELEASE_ENABLED=false, no pause flag).
# ---------------------------------------------------------------------------
cleanup() {
  rc=$?
  echo
  step "cleanup: restoring safe-at-rest (disarm $RELEASE_VAR, remove pause flag)..."
  # Disarm is the load-bearing one — leaving RELEASE_ENABLED=true is the exact danger this
  # script exists to prevent. Best-effort so cleanup can't itself abort, but LOUD on failure.
  if ! gh variable set "$RELEASE_VAR" --body false >/dev/null 2>&1; then
    echo "release:cut: ⚠️  FAILED to disarm $RELEASE_VAR — it may still be 'true'. Disarm it MANUALLY now:" >&2
    echo "release:cut:     gh variable set $RELEASE_VAR --body false" >&2
  else
    step "cleanup: $RELEASE_VAR disarmed (false)."
  fi
  rm -f "$PAUSE_FLAG" 2>/dev/null || true
  step "cleanup: pause flag removed; push agent will resume."
  exit "$rc"
}
trap cleanup EXIT INT TERM

# Quiesce: pause origin/main pushes so no new commit advances main mid-run. ci.yml has
# cancel-in-progress:true — a push landing during the window would cancel the release SHA's CI run
# and make the green-CI gate refuse this SHA. (The daemon may still commit LOCALLY; pausing the
# push keeps origin frozen at the release SHA, which is all release.yml's --ref main resolves.)
step "quiescing main: $PAUSE_FLAG"
mkdir -p "$(dirname -- "$PAUSE_FLAG")" 2>/dev/null || true
touch "$PAUSE_FLAG"

# Arm. RELEASE_ENABLED is admin-gated; release.yml's job is skipped unless it is 'true'.
step "arming $RELEASE_VAR=true..."
gh variable set "$RELEASE_VAR" --body true || fail "could not arm $RELEASE_VAR (the trap will still attempt to disarm on exit)."

# Snapshot the newest release.yml run id BEFORE dispatch so we can identify OUR run afterward
# (release.yml is dispatch-only, so nothing else creates a run between snapshot and dispatch).
before_run="$(gh run list --workflow="$WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId // 0' 2>/dev/null || echo 0)"

# Dispatch. --ref main (NOT a bare SHA — workflow_dispatch resolves named refs only; a raw SHA 422s).
# Safe because we asserted origin/main == HEAD above, so 'main' IS the release SHA.
step "dispatching $WORKFLOW --ref main..."
gh workflow run "$WORKFLOW" --ref main || fail "gh workflow run $WORKFLOW failed to dispatch."

# Find the run our dispatch created. databaseId is monotonic, so the first id != the snapshot is ours.
step "waiting for the dispatched run to register..."
run_id=""
for _ in $(seq 1 30); do
  candidate="$(gh run list --workflow="$WORKFLOW" --limit 1 --json databaseId --jq '.[0].databaseId // 0' 2>/dev/null || echo 0)"
  if [ "$candidate" != "0" ] && [ "$candidate" != "$before_run" ]; then
    run_id="$candidate"
    break
  fi
  sleep 2
done
[ -n "$run_id" ] || fail "could not identify the dispatched $WORKFLOW run (it may not have started). Check 'gh run list --workflow=$WORKFLOW'."

# Watch to completion. --exit-status makes gh exit non-zero if the run fails, so `set -e` propagates
# that here → the trap fires → we disarm + un-quiesce even on a failed publish.
step "watching run $run_id (Ctrl-C is safe — cleanup still disarms + un-quiesces)..."
gh run watch "$run_id" --exit-status

step "release run $run_id concluded SUCCESS. Read its publish summary — '0 published, N skipped' when you expected new publishes means CI built a stale tree; investigate, don't assume success."
# EXIT trap now disarms RELEASE_ENABLED and removes the pause flag.

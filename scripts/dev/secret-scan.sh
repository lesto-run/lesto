#!/bin/sh
# Scan an outgoing commit range for likely secrets BEFORE they reach the PUBLIC
# origin — defense-in-depth for the auto-push path (L-e19bda73). The push agent
# (and the interactive hook) publish `main` to a public repo within ~120s with
# no human review, so a secret that lands on `main` is exposed almost at once
# and, once in public git history, is effectively unrecoverable.
#
# Usage:  secret-scan.sh [<range>]        # default range: origin/main..main
# Exit:   0 = clean OR nothing to scan;  2 = likely secret;  3 = scanner error
#         (bad range / gitleaks operational failure) → callers FAIL OPEN visibly.
#
# Prefers `gitleaks` when installed (comprehensive, per-commit, binary-aware,
# example-key allowlisted). The fallback is a curated high-signal pattern scan
# of ADDED lines only, scanned PER-COMMIT (via `git log -p`, so a secret added
# then removed within the range is still caught — it ships in intermediate
# history). It is NOT exhaustive — generic/unprefixed keys and binary/keystore
# blobs pass through; that is gitleaks' and GitHub push-protection's job
# (L-aa78ca28). Matched VALUES are never printed.
set -u

range="${1:-origin/main..main}"
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd) || exit 0
cd "$repo_root" || exit 0

# Distinguish "empty range" (clean → 0) from a FAILED rev-list (bad/missing ref)
# → scanner error (3) so the caller fails OPEN *visibly* instead of silently
# treating an un-scannable range as clean.
if ! revs=$(git rev-list "$range" 2>/dev/null); then
  exit 3
fi
[ -n "$revs" ] || exit 0

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --log-opts="$range" --no-banner --redact >/dev/null 2>&1
  glrc=$?
  case $glrc in
    0) exit 0 ;;
    1)
      echo "secret-scan: gitleaks flagged $range (values redacted; run 'gitleaks git --log-opts=\"$range\" --redact' to locate)." >&2
      exit 2
      ;;
    *)
      echo "secret-scan: gitleaks error rc=$glrc — inconclusive (caller fails open)." >&2
      exit 3
      ;;
  esac
fi

# Fallback: curated, low-false-positive credential shapes (ERE). Scanned per
# commit over ADDED lines; a matched line carrying `EXAMPLE` (AWS docs
# convention) or an inline `secret-scan:allow` / `gitleaks:allow` marker is
# skipped so well-known dummy keys don't wedge the push.
patterns='-----BEGIN[A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{22,}|glpat-[0-9A-Za-z_-]{20}|xox[baprs]-[0-9A-Za-z-]{10,}|sk_live_[0-9A-Za-z]{24,}|rk_live_[0-9A-Za-z]{24,}|sk-ant-api[0-9]{2}-[0-9A-Za-z_-]{24,}|sk-proj-[0-9A-Za-z_-]{24,}|AIza[0-9A-Za-z_-]{35}|npm_[0-9A-Za-z]{36}|-----BEGIN CERTIFICATE-----'

if git log -p --no-color "$range" 2>/dev/null \
  | grep -E '^\+' | grep -vE '^\+\+\+' \
  | grep -Ei -e "$patterns" \
  | grep -qviE -e 'EXAMPLE|secret-scan:allow|gitleaks:allow'; then
  echo "secret-scan: likely secret(s) in the outgoing commits ($range) — values/paths redacted; inspect with 'git log -p $range' or gitleaks before pushing." >&2
  exit 2
fi
exit 0

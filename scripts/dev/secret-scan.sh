#!/bin/sh
# Scan an outgoing commit range for likely secrets BEFORE they reach the PUBLIC
# origin — defense-in-depth for the auto-push path (L-e19bda73). The push agent
# (and the interactive hook) publish `main` to a public repo within ~120s with
# no human review, so a secret that lands on `main` is exposed almost at once
# and, once in public git history, is effectively unrecoverable.
#
# Usage:  secret-scan.sh [<range>]        # default range: origin/main..main
# Exit:   0 = clean OR nothing to scan;  2 = at least one likely secret found.
# Any OTHER exit is a scanner error — callers should treat that as inconclusive
# and FAIL OPEN (a broken scanner must not wedge the push path into drift).
#
# Prefers `gitleaks` when installed (comprehensive, low false positives). The
# fallback is a curated high-signal pattern scan of ADDED lines only — it is not
# exhaustive (that is gitleaks' job); it catches the unambiguous, high-blast
# credential shapes. Matched VALUES are never printed, only the files.
set -u

range="${1:-origin/main..main}"
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd) || exit 0
cd "$repo_root" || exit 0

# Nothing outgoing → nothing to scan (also the steady state: origin == main).
[ -n "$(git rev-list "$range" 2>/dev/null)" ] || exit 0

if command -v gitleaks >/dev/null 2>&1; then
  if gitleaks git --log-opts="$range" --no-banner --redact >/dev/null 2>&1; then
    exit 0
  fi
  echo "secret-scan: gitleaks flagged the outgoing range ($range) — values redacted; run 'gitleaks git --log-opts=\"$range\" --redact' to locate." >&2
  exit 2
fi

# Fallback: curated, low-false-positive credential shapes (ERE). gitleaks does
# the exhaustive job; this is the high-blast subset that must never be public.
patterns='-----BEGIN[A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{36}|github_pat_[0-9A-Za-z_]{22,}|glpat-[0-9A-Za-z_-]{20}|xox[baprs]-[0-9A-Za-z-]{10,}|sk_live_[0-9A-Za-z]{24,}|rk_live_[0-9A-Za-z]{24,}|AIza[0-9A-Za-z_-]{35}|npm_[0-9A-Za-z]{36}|-----BEGIN CERTIFICATE-----'

match_files=""
# Repo paths carry no spaces; word-splitting the name list is safe here and
# keeps the accumulator in THIS shell (a piped `while read` would sub-shell it).
for f in $(git diff --name-only "$range" 2>/dev/null); do
  if git diff --no-color "$range" -- "$f" 2>/dev/null \
    | grep -E '^\+' | grep -vE '^\+\+\+' | grep -qEi -e "$patterns"; then
    match_files="$match_files $f"
  fi
done

if [ -n "$match_files" ]; then
  echo "secret-scan: likely secret(s) in ADDED lines of $range —$match_files (values redacted; inspect before pushing)." >&2
  exit 2
fi
exit 0

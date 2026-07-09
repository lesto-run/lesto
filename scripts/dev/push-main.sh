#!/bin/sh
# Keep origin/main current — the local half of L-f9ac64d8.
#
# WHY THIS EXISTS: the Studio daemon commits to main via `commit-tree` +
# `update-ref`, which does NOT fire git hooks, so the post-commit push hook can
# never cover daemon-authored commits — origin/main once silently fell 51
# commits behind. A LaunchAgent runs this every 120s (see install-push-agent.sh)
# so a fast-forward push happens regardless of who authored the commit.
#
# SAFE BY CONSTRUCTION: `git push` (no --force) is fast-forward-only for the
# remote, so a stale/ahead origin no-ops harmlessly and this can never rewrite
# published history. GIT_TERMINAL_PROMPT=0 stops a backgrounded run from ever
# blocking on a credential prompt (the repo's undrained-child trap).
#
# LOUD ON STALL: a non-FF divergence (rebase / amend / force-pushed origin)
# makes the push REJECT. Left silent (the old `git push --quiet`), that
# re-creates the exact L-f9ac64d8 failure — origin drifts with no signal. So a
# rejection is logged AND raises a rate-limited desktop notification.
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd) || exit 0
cd "$repo_root" || exit 0

# Only ever push main.
[ "$(git symbolic-ref -q --short HEAD 2>/dev/null)" = "main" ] || exit 0

log="${LESTO_PUSH_LOG:-$HOME/.studio/push-main.log}"
mkdir -p "$(dirname -- "$log")" 2>/dev/null || true

# Rotate at ~256 KiB (keep one generation) so a persistent-error loop cannot
# grow the log without bound.
if [ -f "$log" ]; then
  size=$(wc -c < "$log" 2>/dev/null || echo 0)
  [ "${size:-0}" -gt 262144 ] && mv -f "$log" "$log.old" 2>/dev/null || true
fi

out=$(GIT_TERMINAL_PROMPT=0 git push origin main 2>&1)
rc=$?
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '?')

if [ "$rc" -eq 0 ]; then
  # Success: log only a REAL transfer; skip the every-120s "up-to-date" no-op so
  # the log stays quiet when nothing changed.
  case "$out" in
    *up-to-date* | '') : ;;
    *) printf '%s pushed: %s\n' "$ts" "$(printf '%s' "$out" | tr '\n' ' ')" >>"$log" ;;
  esac
  exit 0
fi

# Failure: never fail the agent — the log + notification ARE the signal.
printf '%s STALL rc=%s: %s\n' "$ts" "$rc" "$(printf '%s' "$out" | tr '\n' ' ')" >>"$log"

case "$out" in
  *'[rejected]'* | *non-fast-forward* | *'fetch first'* | *'Updates were rejected'*)
    # Rate-limit the desktop alert to once/hour so a persistent divergence does
    # not fire a notification every 120s.
    stamp="$HOME/.studio/.push-main-alerted"
    now=$(date +%s 2>/dev/null || echo 0)
    last=$(cat "$stamp" 2>/dev/null || echo 0)
    if [ "$((now - last))" -ge 3600 ]; then
      printf '%s' "$now" >"$stamp" 2>/dev/null || true
      osascript -e 'display notification "origin/main push REJECTED (non-fast-forward) — local main diverged; origin is drifting again (L-f9ac64d8). Reconcile manually." with title "Lesto: push-main stalled"' >/dev/null 2>&1 || true
    fi
    ;;
esac
exit 0

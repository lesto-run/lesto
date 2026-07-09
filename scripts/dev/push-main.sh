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
# LOUD ON PERSISTENT FAILURE: a push that keeps failing — for ANY reason (a
# non-FF divergence, but far more likely over weeks unattended: an expired
# credential / dead SSH agent, or a branch-protection / push-protection reject)
# — is the exact silent-drift condition (L-f9ac64d8) this exists to kill. So
# after 3 consecutive failures we raise a throttled (1/hr) desktop alert, and
# every SUCCESS stamps a heartbeat (`~/.studio/.push-main-last-success`) an
# external dead-man check can watch. Set `~/.studio/.push-main-paused` (e.g.
# during a release, see RELEASING.md) to pause pushing without uninstalling.
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 0
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd) || exit 0
cd "$repo_root" || exit 0

# Only ever push main.
[ "$(git symbolic-ref -q --short HEAD 2>/dev/null)" = "main" ] || exit 0

studio_dir="$HOME/.studio"
# Release-window quiesce: a lighter alternative to uninstalling the agent so a
# push can't advance main mid-CI and cancel the release SHA's run (RELEASING.md).
[ -e "$studio_dir/.push-main-paused" ] && exit 0

log="${LESTO_PUSH_LOG:-$studio_dir/push-main.log}"
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
now=$(date +%s 2>/dev/null || echo 0)

fails_file="$studio_dir/.push-main-fails"

if [ "$rc" -eq 0 ]; then
  # Heartbeat for an external dead-man check, and clear the consecutive-fail count.
  printf '%s' "$now" >"$studio_dir/.push-main-last-success" 2>/dev/null || true
  rm -f "$fails_file" 2>/dev/null || true
  # Log only a REAL transfer; skip the every-120s "up-to-date" no-op.
  case "$out" in
    *up-to-date* | '') : ;;
    *) printf '%s pushed: %s\n' "$ts" "$(printf '%s' "$out" | tr '\n' ' ')" >>"$log" ;;
  esac
  exit 0
fi

# Failure: never fail the agent — the log + heartbeat + alert ARE the signal.
printf '%s push FAILED rc=%s: %s\n' "$ts" "$rc" "$(printf '%s' "$out" | tr '\n' ' ')" >>"$log"

# Count CONSECUTIVE failures (sanitize a torn/corrupt stamp so the arithmetic
# below can never abort the script and permanently disable the alert).
fails=$(cat "$fails_file" 2>/dev/null || echo 0)
case $fails in '' | *[!0-9]*) fails=0 ;; esac
fails=$((fails + 1))
printf '%s' "$fails" >"$fails_file" 2>/dev/null || true

# Alert on a PERSISTENT failure (>=3 consecutive ~= 6 min): a transient network
# blip self-heals in one cycle and never alerts. Throttle to 1/hr, and only
# advance the throttle if the banner was actually delivered.
if [ "$fails" -ge 3 ]; then
  stamp="$studio_dir/.push-main-alerted"
  last=$(cat "$stamp" 2>/dev/null || echo 0)
  case $last in '' | *[!0-9]*) last=0 ;; esac
  if [ "$((now - last))" -ge 3600 ]; then
    osascript -e "display notification \"origin/main push has FAILED ${fails}x (rc=${rc}) — origin is drifting (L-f9ac64d8). Likely an expired credential/SSH key, a branch-protection reject, or a non-FF divergence; see ~/.studio/push-main.log.\" with title \"Lesto: push-main stalled\"" >/dev/null 2>&1 &&
      printf '%s' "$now" >"$stamp" 2>/dev/null || true
  fi
fi
exit 0

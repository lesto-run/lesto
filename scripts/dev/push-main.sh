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
# SECRET GATE (L-e19bda73): before pushing to the PUBLIC origin, scan the
# outgoing commits for likely secrets; refuse + alert on a definite hit (a
# secret in public history is unrecoverable). Fail OPEN on scanner error.
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

now=$(date +%s 2>/dev/null || echo 0)
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo '?')

# Rate-limited (1/hr) desktop alert; the throttle only advances if the banner
# was actually delivered. $1 = stamp file, $2 = message (no embedded quotes).
notify() {
  _last=$(cat "$1" 2>/dev/null || echo 0)
  case $_last in '' | *[!0-9]*) _last=0 ;; esac
  [ "$((now - _last))" -ge 3600 ] || return 0
  osascript -e "display notification \"$2\" with title \"Lesto: push-main\"" >/dev/null 2>&1 &&
    printf '%s' "$now" >"$1" 2>/dev/null || true
}

# Pin the exact commit we scan == the commit we push (TOCTOU: a commit landing
# between the scan and the push would otherwise ship UNSCANNED and never be
# re-checked, since a successful push advances origin/main past it). Guard a
# bad/empty rev-parse — `git push origin :refs/heads/main` would DELETE main.
head=$(git rev-parse HEAD 2>/dev/null)
case $head in '' | *[!0-9a-f]*) exit 0 ;; esac

# SECRET GATE. Only a DEFINITE hit (rc=2) blocks; any other non-zero is a
# scanner error → fail OPEN (a broken scanner must not wedge the push path into
# re-creating L-f9ac64d8 drift), but log it so it's visible.
scan_msg=$(sh "$script_dir/secret-scan.sh" "origin/main..$head" 2>&1)
scan_rc=$?
if [ "$scan_rc" -eq 2 ]; then
  printf '%s SECRET-BLOCK: refused to push — %s\n' "$ts" "$(printf '%s' "$scan_msg" | tr '\n' ' ')" >>"$log"
  notify "$studio_dir/.push-main-secret-alerted" \
    "REFUSED to push origin/main — a likely SECRET is in the outgoing commits (L-e19bda73). Remove it from history before it can reach the public remote; see ~/.studio/push-main.log."
  exit 0
elif [ "$scan_rc" -ne 0 ]; then
  printf '%s scan-error rc=%s (failing open): %s\n' "$ts" "$scan_rc" "$(printf '%s' "$scan_msg" | tr '\n' ' ')" >>"$log"
fi

out=$(GIT_TERMINAL_PROMPT=0 git push origin "$head:refs/heads/main" 2>&1)
rc=$?

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
# blip self-heals in one cycle and never alerts.
if [ "$fails" -ge 3 ]; then
  notify "$studio_dir/.push-main-alerted" \
    "origin/main push has FAILED ${fails}x (rc=${rc}) — origin is drifting (L-f9ac64d8). Likely an expired credential/SSH key, a branch-protection reject, or a non-FF divergence; see ~/.studio/push-main.log."
fi
exit 0

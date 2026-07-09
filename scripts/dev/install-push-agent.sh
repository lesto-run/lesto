#!/bin/sh
# Install (or uninstall) the run.lesto.push-main LaunchAgent — the reproducible
# form of L-f9ac64d8's origin-freshness backstop.
#
# The agent and its push logic (push-main.sh, beside this file) are
# version-controlled; only the generated plist is machine-local (it bakes in
# THIS clone's absolute path, which cannot live in the repo). Re-run after a
# fresh clone / on a second machine to reinstate the backstop — otherwise the
# mitigation is invisible and origin silently drifts again (the L-f9ac64d8
# failure mode).
#
# Usage:
#   scripts/dev/install-push-agent.sh              # install / reinstall (idempotent)
#   scripts/dev/install-push-agent.sh --uninstall  # remove
#
# macOS only (launchd). No-op elsewhere.
set -u

label="run.lesto.push-main"
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

if ! command -v launchctl >/dev/null 2>&1; then
  echo "launchctl not found — this backstop is macOS-only. Nothing to do." >&2
  exit 0
fi

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "$domain/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "Uninstalled $label."
  exit 0
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
push_script="$script_dir/push-main.sh"
[ -f "$push_script" ] || {
  echo "missing $push_script" >&2
  exit 1
}
chmod +x "$push_script" 2>/dev/null || true

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.studio"
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$push_script</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin</string>
    <key>GIT_TERMINAL_PROMPT</key>
    <string>0</string>
  </dict>
  <key>StartInterval</key>
  <integer>120</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
PLIST

plutil -lint "$plist" >/dev/null || {
  echo "generated plist failed plutil -lint" >&2
  exit 1
}
launchctl bootout "$domain/$label" 2>/dev/null || true
if ! launchctl bootstrap "$domain" "$plist"; then
  echo "launchctl bootstrap failed — agent NOT loaded. Run from a logged-in desktop session (bootstrap into gui/\$(id -u) needs an active Aqua session), not bare SSH." >&2
  exit 1
fi
repo=$(cd "$script_dir/../.." && pwd)
echo "Installed $label → FF-pushes $repo main to origin every 120s."
echo "Push outcomes: $HOME/.studio/push-main.log (rotated). Remove: $script_dir/install-push-agent.sh --uninstall"

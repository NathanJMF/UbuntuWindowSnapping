#!/usr/bin/env bash
set -euo pipefail
base=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
uuid=keyboard-monitor-snap@local
dest="$HOME/.local/share/gnome-shell/extensions/$uuid"
gjs -m "$base/tests/rules.test.js"
gjs -m "$base/tests/adapter.test.js"
gjs -m "$base/tests/placement.test.js"
gjs -m "$base/tests/lifecycle.test.js"
gjs -m "$base/tests/units.test.js"
glib-compile-schemas --strict "$base/schemas"
mkdir -p "$dest/schemas"
cp "$base/metadata.json" "$base/"*.js "$dest/"
cp "$base/schemas/"* "$dest/schemas/"
# The old experimental patch must never be active alongside this extension.
gnome-extensions disable windows-monitor-snap@local 2>/dev/null || true
python3 - <<'PY'
from gi.repository import Gio
s=Gio.Settings.new('org.gnome.shell')
a=[v for v in s.get_strv('enabled-extensions') if v!='windows-monitor-snap@local']
u='keyboard-monitor-snap@local'
if u not in a: a.append(u)
s.set_strv('enabled-extensions',a)
Gio.Settings.sync()
PY
gsettings set org.gnome.shell.extensions.tiling-assistant enable-tiling-popup false
# Debug logging follows the branch installed: off for main, on for test
# branches. Set live, so no log-out is needed for this change.
branch=$(git -C "$base" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
if [ "$branch" = main ]; then logging=false; else logging=true; fi
GSETTINGS_SCHEMA_DIR="$base/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap debug-logging "$logging"
echo "Debug logging: $logging (branch $branch)"
if gnome-extensions info "$uuid" >/dev/null 2>&1; then
 gnome-extensions enable "$uuid"
 gnome-extensions info "$uuid"
else
 echo 'Installed and enabled for next login. Save your work, then log out and back in.'
fi

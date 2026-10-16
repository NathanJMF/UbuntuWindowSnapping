#!/usr/bin/env bash
set -euo pipefail
uuid=keyboard-monitor-snap@local
gnome-extensions disable "$uuid" 2>/dev/null || true
python3 - <<'PY'
from gi.repository import Gio
s=Gio.Settings.new('org.gnome.shell')
s.set_strv('enabled-extensions',[v for v in s.get_strv('enabled-extensions') if v!='keyboard-monitor-snap@local'])
Gio.Settings.sync()
PY
printf '%s\n' 'Custom keyboard snapping disabled. Mouse snapping and popup preference remain unchanged.'

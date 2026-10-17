# Keyboard window snapping

A GNOME Shell 50 extension for Ubuntu (Wayland) that replaces Super+Arrow with half and quarter snapping, movement between monitors, and a custom animation. Read [RULES.md](RULES.md) for the agreed snapping behaviour. Only the keyboard shortcuts change: Ubuntu's mouse snapping stays as it is, and Tiling Assistant's app-selection popup stays off. Ubuntu Tiling Assistant must stay enabled.

## Files

- `engine.js`: the snapping rules as pure state transitions and work-area geometry.
- `placement.js`: one placement: unmaximize, animate, set the final geometry, confirm it, maximize. Also pure helpers (curves, alignment, durations).
- `extension.js`: shortcuts, per-window sequences, the animation, native-effect handling, and Tiling Assistant restore metadata. It never patches mouse handlers or Tiling Assistant.
- `schemas/`: the four shortcuts, the saved previous bindings, and the debug-logging flag.
- `tests/`: `rules` (snapping rules), `adapter` (the real extension against mocked GNOME APIs), `placement` (placement ordering against a delayed client), and `lifecycle` (timing-sensitive animation behaviour with frame-stepped timelines, tracked signals, cancellable waits, and clients that lag, re-lay out, have minimum sizes, or redraw constantly).
- `install.sh` / `uninstall.sh`.

## Install or update

```bash
# Run from the repository root.
./install.sh
```

It runs every test suite, compiles the schema, installs into `~/.local/share/gnome-shell/extensions`, and enables the extension. New extension code only loads at login on Wayland, so log out and back in after updating.

## How a snap animates

Each snap asks the app once for its final size and animates the window's outline to it along an eased curve, on every display frame. Content is never scaled down: everything is cropped to the moving outline and attached to its fixed edge, or to its top-left when both edges move (crossing monitors).

- **Shrinking.** A snapshot of the window as it was sits underneath, cropped. Once the app has drawn its final layout, the live window fades in on top at its true size. Where it is smaller than the outline, the snapshot shows in the strip.
- **Growing.** The motion starts gently, because nothing larger than the snapshot exists until the app draws. The live window sits underneath at its true size from the start; the snapshot stays on top at its own size and fades out at the handover. A backdrop (the snapshot stretched) fills any corner that neither image reaches, as in a move that gets wider but shorter.
- **Each direction eases separately.** A growing direction starts gently; a shrinking one settles quickly.
- **Handover.** The live window takes over once the app has drawn the final size and then nothing new for 24 ms. Apps that draw a corrected layout shortly after resizing (Claude desktop, about 45 ms later) have that delay learned per window, and the handover waits for it. If neither happens in time, the handover starts at 60% of the motion (75% for apps with a learned follow-up). The fade always ends by 90% of the motion.
- **Minimum sizes.** If the app draws a larger size than requested and Mutter confirms it, the animation smoothly re-aims there.
- **Native state changes.** GNOME's own maximize and unmaximize effects are skipped. The snapshot covers leaving the maximized state, and a snapshot of the landed window covers entering it, until the app's maximized frame settles.
- **Crossings.** Moves between monitors repaint every monitor on each frame.
- **Interruptions.** Pressing again mid-snap continues from what is on screen. Presses made meanwhile are folded into one placement.

After the motion, a window whose app has not yet drawn the final size is held on target for up to 150 ms, then relaxed. Durations scale with travel distance from a 120 ms base, and follow GNOME's animation switch and slow-down factor.

## Debug logging

Off by default. Installing from `main` turns it off; installing from any other branch turns it on. It can be changed at any time without logging out:

```bash
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap debug-logging true
```

With it on, every animation frame and placement stage is logged:

```bash
journalctl -b _COMM=gnome-shell --no-pager --since "-5min" -o cat --grep 'keyboard-monitor-snap@local: (FRAME|TRACE)'
```

## Verify after login

```bash
gnome-extensions info keyboard-monitor-snap@local
```

Expected: Enabled Yes, State ACTIVE. Then check by hand:

1. Each first arrow selects the corresponding half.
2. All four quarter combinations work, in both orders.
3. Repeating Left or Right toward a monitor edge crosses to the adjacent monitor.
4. Repeating Down at the bottommost monitor never minimizes.
5. Pressing Up twice at the topmost monitor maximizes.
6. Dragging with the mouse still uses Ubuntu's snapping, without the popup.
7. Two windows keep independent keyboard positions.

## Tests

```bash
gjs -m tests/rules.test.js
gjs -m tests/adapter.test.js
gjs -m tests/placement.test.js
gjs -m tests/lifecycle.test.js
```

The tests use mocked GNOME APIs. How smooth a snap actually looks has to be judged on screen after logging in, together with the debug logs.

`python3 -I tests/mutations.py` checks the tests themselves: it breaks each guarded behaviour in turn (restoring the sources afterwards) and reports any that no test notices. `tools/analyze-logs.py` summarizes a session's debug logs (handover timing, fades, learned follow-ups, maximize covers, frame gaps, and the frame handler's cost in microseconds) for comparing versions.

## Disable or roll back

```bash
./uninstall.sh
```

The previous Super+Arrow bindings are saved before the extension takes them, and restored when it is disabled. Only bindings still holding the value the extension wrote are restored, and defaults are reset rather than pinned. Numpad bindings and Super+Shift+Arrow are untouched. Nothing outside your home directory is changed.

## History

The design came out of many measured iterations. Tags mark versions confirmed good on screen: `known-good-v17`, `known-good-v23`, `known-good-v24`, `known-good-v28`. Version 29 removed the earlier `live` and `morph` styles and the tuning settings, leaving the reveal animation with its tuned values built in. Versions 18–19 (an approach that broke) remain on `experiment/morph-quiet-handover`. The commit messages give the reasoning and measurements behind each change.

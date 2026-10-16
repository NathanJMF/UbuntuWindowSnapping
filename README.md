# Keyboard window snapping

Project: keyboard window snapping

Read [RULES.md](RULES.md) for the agreed behaviour. The project changes keyboard shortcuts only. Ubuntu's mouse snapping remains enabled, and the app-selection popup stays off.

## Files

- `engine.js`: pure state transitions and work-area geometry.
- `extension.js`: GNOME 50 shortcuts, per-window transactions, confirmed-frame state, and Tiling Assistant restore metadata. Does not patch mouse handlers or Tiling Assistant methods.
- `placement.js`: ordered unmaximize, monitor transfer, resize, and maximize requests with confirmation between stages.
- `schemas/`: the four shortcuts and saved previous bindings.
- `tests/rules.test.js`: 121 assertions for the agreed behaviour.
- `tests/adapter.test.js`: regression checks against the actual extension source with mocked GNOME APIs (maximized windows, monitor crossing, per-window reset and cleanup).
- `install.sh`: test, compile schemas, install locally, retire the old patch, enable for login.
- `uninstall.sh`: disable this extension and restore previous keyboard bindings. The popup stays disabled.

## Install or update

Run as the desktop user, without sudo:

```bash
# Run from the repository root.
./install.sh
```

For a newly installed extension on Wayland, save your work, then log out and back in. After updating an already-loaded extension, also log out and back in to load the new JavaScript.

## Verify after login

```bash
gnome-extensions info keyboard-monitor-snap@local
```

Expected: Enabled Yes and State ACTIVE. The extension requires Ubuntu Tiling Assistant to remain enabled.

Manual acceptance checks:

1. Use a normal resizable window. Test each first arrow: it should select the corresponding half.
2. Test all four quarter combinations in both orders.
3. Repeat Left/Right toward a monitor edge: cross to the adjacent screen and maximize there.
4. At the bottommost monitor, repeat Down: never minimize.
5. At the topmost monitor, press Up twice: maximize locally.
6. Test above/below monitor movement where the monitor arrangement provides it.
7. Drag a window with the mouse: ordinary Ubuntu snapping should still work, without the app-selection popup.
8. Change focus between two windows: their keyboard positions should be independent.

## Tests

```bash
gjs -m tests/rules.test.js
gjs -m tests/adapter.test.js
gjs -m tests/placement.test.js
glib-compile-schemas --strict schemas
```

The pure engine and adapter mock tests pass (223 assertions total). Live keyboard behaviour must be verified after GNOME loads the extension at login; unit tests cannot establish Mutter's actual resizing behaviour.

## Disable / rollback

```bash
./uninstall.sh
```

Previous arrow bindings are saved in the extension's `saved-bindings` setting before it takes ownership, then restored when disabled. Numpad bindings and Super+Shift+Arrow are preserved. This extension does not edit system files or require root.

The source depends on the Ubuntu Tiling Assistant geometry API bundled with this Ubuntu/GNOME 50 installation. If Ubuntu significantly updates that API, the adapter may need updating. The pure rules engine is independent of GNOME.

## Startup and animation correction — 16 October 2026

Live testing found the extension failed at login: Ubuntu Tiling Assistant initializes asynchronously, so our initial dependency check could run too early. The extension now waits for readiness and registers shortcuts once initialization finishes. It also releases bindings if the dependency disappears and reacquires them after recovery. Its watcher is removed on disable. Delayed readiness, recovery and cleanup have regression tests.

GNOME desktop animations and Tiling Assistant tile/untile animations were disabled after visible animation failures. Mouse snapping geometry and handlers are unchanged.

The current GNOME session cached the old failed JavaScript. Its advertised ReloadExtension D-Bus method is not implemented, and toggling it does not recover an ERROR-state extension. Log out and back in to load the corrected source. Verify State ACTIVE and that Tiling Assistant no longer lists Super+Down in tile-bottom-half (the custom extension should own it).

The readiness watcher also compares the dependency keybinding-handler identity, so a full restart between timer ticks triggers shortcut reacquisition. Four additional mock assertions cover this case.

## Quarter-to-side update

Pressing toward an occupied edge from a quarter first expands to the full half on that side. Only a subsequent press can cross monitors. Applies to all four directions, with or without a neighboring monitor. The rules suite covers every quarter/edge pair; the adapter suite checks expansion before crossing.

## Chromium portrait-monitor investigation

The keyboard sequence changes window sizes instead of returning from the portrait screen to the main screen. The root cause is not yet established. Temporary debug-logging records app class, window ID, capabilities, actual/target monitor and geometry, native maximize flags, state validity, and action. It never records window titles or web content. Samples are taken before the key, after the request, and after 250 ms. Disabling the extension removes pending diagnostic timers.

After logging in to load this diagnostic build, reproduce Chromium Right then Right on the portrait screen, waiting a moment between keys. Read the traces with:

```bash
journalctl -b _COMM=gnome-shell --no-pager --grep 'keyboard-monitor-snap@local: TRACE' -n 100
```

Turn logging off after diagnosis:

```bash
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap debug-logging false
```

## Chromium placement correction (version 2)

Live traces established that Chromium can clear TA tiling metadata after a half resize, and can maximize back on the source monitor when movement and maximization requests overlap. Version 2 tracks confirmed actual frames separately from intended layouts, uses no native partial-maximize hints for halves, and confirms monitor transfer before requesting native maximization. It preserves TA mouse restore metadata only after successful placement.

Requests are bounded and canceled by mouse grabs, extension disable, dependency changes, and window closure. Repeated unchanged boundary positions do not issue redundant geometry requests. Known minimum-size dimensions are reused for opposite-side moves only when the previous confirmed frame, monitor, and requested dimensions match. Temporary geometry logging remains available without recording titles or page contents.

Validation: 113 assertions pass (64 rules, 27 adapter mocks, 22 delayed-placement checks). Three review rounds completed; the final round had no actionable findings. Native Chromium/Wayland behaviour still needs live acceptance testing after logging in with version 2.

## Portrait return sequencing correction (version 3)

Live version 2 logs showed correct return-to-main decisions followed by placement timeouts for both Chromium and ChatGPT. The code waited for a destination monitor identity before issuing absolute target geometry. Version 3 clears the old edge constraints, sends monitor intent and absolute target position/size without that intervening wait, then confirms monitor and geometry together before maximizing. Destination edge constraints are applied only after the destination is confirmed.

Wait errors now name the stage (`unmaximize`, `monitor-and-frame`, or `maximize`) and record requested and actual geometry. The added regression models a compositor where only the absolute geometry commit can change the window monitor. Current validation: 123 assertions (64 rules, 27 adapter mocks, 32 delayed-placement assertions). This is not a substitute for the next live login test.

## Opposite-half intermediate full size (version 4)

An opposite arrow from a half now maximizes on the current monitor first; repeating it then selects the opposite half. All four half/opposite-direction pairs follow this rule, whether neighboring monitors exist or not. Quarter combinations and outward monitor crossing are unchanged.

Version 4 validation: 142 checks (81 rules, 29 adapter, 32 delayed placement).

## Quarter intermediate halves (version 5)

An opposite arrow from a quarter now removes that split first, preserving the other axis. Example: bottom-right → Up → right half → Up → top-right. All eight quarter/opposite-direction combinations follow this rule; neighbors do not cause crossing during the intermediate steps. Opposite halves still pass through full size. Outward expansion and monitor crossing rules are unchanged.

Animation preference update: GNOME desktop animations and Tiling Assistant tile/untile animations were restored to enabled. Earlier animation-disable notes above describe historical troubleshooting.

Version 5 validation: 177 checks (113 rules, 32 adapter, 32 delayed placement); independent review returned no findings.

## Entry-half monitor arrivals (version 6)

Crossing Right arrives on the destination's left half; Left arrives on its right half; Down on its top half; Up on its bottom half. Entry halves remain tracked, so existing opposite-half intermediate steps and perpendicular quarter combinations apply immediately. Outward quarters still expand to a full side before crossing. Native geometry placement/confirmation is unchanged, and the monitor-arrival half is applied without a native maximize request.

Version 6 validation: 195 checks (121 rules, 32 adapter, 42 delayed placement).

## Custom keyboard animations (version 7)

Keyboard snaps no longer use GNOME's size-change effect, which stretched a snapshot and redrew the app only at the end. The real window frame is now resized on every compositor frame (120 ms by default, ease-out cubic), so applications reflow continuously while they move and resize, including across monitors. A new size is requested only after the client acknowledges the previous one (or 50 ms passes), so slow clients are not flooded; the exact target is always confirmed afterwards as before.

- Leaving a maximized window: a snapshot covers the frame jump while Mutter unmaximizes, then fades out (120 ms) as the live animation starts.
- Ending full: the frame grows to the work area first, then native maximize is issued with GNOME's zoom effect skipped.
- Animated crossings do not issue a late `move_to_monitor`, which would briefly re-place the window relative to the source monitor.
- Presses during an animation are queued (up to three) and run in order instead of being dropped (superseded in version 8).
- Length: `animation-duration` setting (0 disables). GNOME's global animation switch and slow-down factor are respected. Mouse snapping and Tiling Assistant animations are unchanged.

```bash
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap animation-duration 120
```

Version 7 validation: 223 checks (121 rules, 42 adapter, 60 delayed placement). Live smoothness depends on each application's resize speed and must be checked after logging in.

## Responsiveness (version 8, experiment/animations branch)

- Confirmation checks start immediately and repeat every 16 ms (previously every 25 ms, first check delayed), removing most of the pause after each animation and before an animation starts from a maximized window.
- Animation length scales with distance: the largest edge travel relative to 1000 px scales the base `animation-duration` by its square root, clamped to 0.75x–1.35x. At 120 ms, half → quarter is about 99 ms, half → full about 136 ms, a monitor crossing up to 162 ms.
- A press during an animation interrupts it. All presses made meanwhile (up to three) are applied through the rules from the interrupted placement's intended layout, then the window animates straight from where it is to the final target. Right, Right, Right quickly is one trip.

Validation: 233 checks (121 rules, 48 adapter, 64 delayed placement).

## Smoothing slow applications (version 9, experiment/animations branch)

On Wayland a window's position only changes when the application acknowledges a new size, so slow clients (Chromium, Electron apps) stepped through the animation. Each frame now also transforms the window actor (scale and translation, pivot at the actor origin, as GNOME's own effects do) so that the window's current real frame is drawn exactly at the animation curve's rectangle. A client that keeps up needs no visible transform; a lagging one is stretched slightly between acknowledgements instead of stalling.

- After the motion, a lagging window is held visually on target until its frame catches up, or for at most 150 ms (minimum-size apps never reach the target), then the transform relaxes over 80 ms.
- An interrupted motion keeps its transform, and the next motion starts from the rectangle on screen rather than the lagging real frame, so rapid presses never jump backwards.
- Mouse grabs, extension disable, window close, and failed placements reset the transform immediately.
- Debug logging records a `visual-hold` trace with whether the client caught up and how long it took.

Validation: 245 checks (121 rules, 57 adapter, 67 delayed placement), including a client that trails one request behind.

## Less rubber-banding (version 10, experiment/animations branch)

Version 9 drew lagging windows exactly on the curve by stretching the last committed frame; every commit snapped the stretch back, which read as rubber-banding.

- **Request ahead.** Each window's resize latency (request to committed size) is measured and smoothed. Size requests sample the curve that far ahead (16 ms guess for an unmeasured window, at most 120 ms), so commits land close to where the image is already drawn and little stretch is needed. The curve is now evaluated directly (ease-out cubic) on a linear timeline so it can be sampled ahead.
- **Stretch cap.** The image is never scaled beyond 1 ± `max-stretch` percent (default 6). When capped, the edge that is not moving stays exactly in place (both edges moving: centred), and the image may trail the curve slightly. `0` moves the image only; `100` restores version 9 behaviour. Read at the start of every snap, so it can be tuned live:

```bash
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap max-stretch 6
```

- Interruptions continue from the rectangle actually drawn (after capping).
- Debug traces include the lead and cap used for each animation.

Validation: 259 checks (121 rules, 63 adapter, 75 delayed placement).

## Drawn-geometry correction (version 11, experiment/animations branch)

Version 10 still looked rubbery: traces showed "commits" 2–22 ms after each request for ChatGPT (X11), Chromium and Claude (Wayland), so Mutter's frame rect was changing long before the client had drawn the new size. The image transform and the latency measurement were therefore based on a size the screen did not yet show, scaling the wrong amount on some frames, and the request lead stayed near zero.

The drawn frame is now taken from the window actor's own geometry, which Mutter syncs when the client's new buffer is shown, minus the current shadow/border margins. It drives the image transform, commit/latency detection, and the post-motion hold.

With debug logging on, every animation frame logs a `FRAME` line (curve rectangle, drawn frame, Mutter frame, last request, scale), and `animate` traces record the client type:

```bash
journalctl -b _COMM=gnome-shell --no-pager --since "-5min" -o cat --grep 'keyboard-monitor-snap@local: (FRAME|TRACE)'
```

Validation: 263 checks (121 rules, 67 adapter, 75 delayed placement), including an X11-style client whose frame rect runs ahead of its drawn buffer (fails on version 10).

## Fuller look-ahead and continuous requests (version 12, experiment/animations branch)

Version 11 logs (about 360 snaps on 500/200/144 Hz monitors) showed Chromium and Claude redrawing every 5–9 ms (median), yet in the first half of a snap their content trailed the curve by 80–180 px and hit the stretch cap on 40–77% of frames. Two causes:

- **Look-ahead ignored redraw time.** A drawn frame was requested one lag ago and then stays on screen for a whole redraw interval while the curve moves on. Each window's redraw interval is now measured too, and requests aim at lag + half an interval (centring the error), recomputed every frame as measurements update. Unmeasured windows assume 16 ms lag and 8 ms redraws; the look-ahead is capped at 120 ms.
- **One request at a time.** A new size was only requested after the previous one was drawn (or 50 ms passed), leaving the client idle between redraws. Requests now go out continuously, at most every 4 ms and only when the target changed, so the client always renders the newest target. Up to 64 undrawn requests are tracked for latency matching.

`FRAME` log lines now include the current look-ahead and the number of undrawn requests.

Validation: 271 checks (121 rules, 75 adapter, 75 delayed placement).

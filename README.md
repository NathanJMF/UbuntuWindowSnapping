# Keyboard window snapping

Project: keyboard window snapping

Read [RULES.md](RULES.md) for the agreed behaviour. The project changes keyboard shortcuts only. Ubuntu's mouse snapping remains enabled, and the app-selection popup stays off.

## Files

- `engine.js`: pure state transitions and work-area geometry.
- `extension.js`: GNOME 50 shortcuts, per-window transactions, confirmed-frame state, and Tiling Assistant restore metadata. Does not patch mouse handlers or Tiling Assistant methods.
- `placement.js`: ordered unmaximize, monitor transfer, resize, and maximize requests with confirmation between stages.
- `schemas/`: the four shortcuts and saved previous bindings.
- `tests/rules.test.js`: 121 assertions for the agreed behaviour.
- `tests/lifecycle.test.js`: step-driven timelines, tracked signal connections, cancellable waits and lagging clients for timing-sensitive animation regressions.
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

Debug logging follows the branch: installing from `main` turns it off, and installing from any other branch (such as `experiment/animations`) turns it on. It changes immediately, without logging out. To override it by hand:

```bash
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap debug-logging false
```

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

## One-sided stretch (version 13, experiment/animations branch)

Version 12 felt rubbery again. Its logs showed less lag (first-quarter cap hits down from ~75% to ~50%), but content now landed alternately ahead of and behind the curve: Chromium's image flipped between stretched and squashed about 10 times per snap (median), against 0 in version 11.

- **Look-ahead is the measured lag only** again (no half redraw interval), so drawn content meets the curve and then trails it slightly, always on the same side. Continuous requests from version 12 are kept; they are what reduced the lag. The redraw interval is still measured and logged.
- **Stretch is one-sided.** Per axis, a growing window's image may only be stretched toward the curve and a shrinking window's only compressed. Content that gets ahead is shown at its real size instead of being squashed back, so the image cannot flip direction and its edges never move backwards.

Validation: 278 checks (121 rules, 77 adapter, 80 delayed placement), including a client whose drawn sizes jitter ahead of and behind its requests.

Default stretch cap lowered to 3% after live comparison (version 13): less visible bounce, with YouTube and terminals resizing well. Terminals resized vertically can still show text shifting slightly; this comes from the terminal's own row layout (it also happens when resizing with the mouse), not from the stretch.

## Review fixes (version 14, experiment/animations branch)

An independent code review of version 13 found these, now fixed:

- **Stale hold transform.** `Clutter.Timeline.stop()` emits `stopped`, not `completed`, so a hold interrupted by a new motion never detached its handlers. A quick Up, Left, Down, Left could leave the window drawn about 3% scaled until the next animation. Every exit now goes through one detach.
- **Latency biased low.** Re-sent final targets were "acknowledged" one frame later, pulling a 40 ms lag down to about 25 ms. Commits are now matched only when a new size is drawn, exact sizes are preferred over the 3 px tolerance, a drawn request is never re-sent, same-size moves record no samples, and requested curve time never moves backwards.
- **Window closed mid-motion.** Animations and holds now stop on `unmanaging`, before GNOME's close effect, instead of driving the closing window until its actor is destroyed.
- **Fullscreen and maximized.** Leaving both is two native size changes; GNOME's effect is now suppressed for each until the placement finishes.
- **Cleanups:**
  - A window is marked busy only after its operation is set up.
  - A superseded state is dropped if the follow-up cannot run.
  - Anchors allow 1 px rounding.
  - While a cover fades, the restored floating frame maps exactly onto the curve.
  - Disabling restores only keys that still hold the value the extension wrote, and resets values that equal the default instead of pinning them.
  - The unused `acceptedFrame` path is removed.

The dependency watcher still polls every 500 ms: it also detects a fast Tiling Assistant restart by handler identity, which a state-change signal alone would not.

Validation: 349 checks (121 rules, 77 adapter, 79 delayed placement, 72 lifecycle).

## Conservative look-ahead (version 15, experiment/animations branch)

Version 14 felt rubbery and stuttery again. Against version 13 at the same 3% cap, its logs showed 38–70% more stretch pulses per snap, while frame stalls were rarer (3% of snaps against 11%). The cause was the corrected latency estimate. Version 13 had under-read the lag (look-ahead 2–3 ms), so content almost always trailed the curve. With an accurate mean (5–11 ms) and frame-to-frame jitter, content arrived ahead of the curve on 21% of frames, up from 13%. The one-sided stretch then showed it unstretched, so the visible edge stalled while the curve moved on (10% of moving frames, up from 6%).

The spread of each window's latency samples is now tracked too. Requests aim at the fast end of the measured lag (mean minus twice the typical deviation), so drawn content rarely gets ahead and the image stretches continuously one way. `FRAME` logs include `latency` and `spread`.

Validation: 357 checks (121 rules, 77 adapter, 79 delayed placement, 80 lifecycle). A client with 20–60 ms jittered lag has content ahead of the curve on under 5% of frames; with the version 14 look-ahead the same client was ahead on 22%.

## Second review fixes (version 16, experiment/animations branch)

A second independent review (of version 15) confirmed the version 14–15 fixes and found:

- **Monitor removed mid-placement.** The target monitor index was used after the unmaximize wait and the animation without checking that it still existed. Mutter aborts on an out-of-range index (`g_assert` in its work-area lookup), which on Wayland ends the session. GNOME's `monitors-changed` now cancels every placement and forgets layouts tied to old indices. Every call that takes a monitor index is also guarded, and waits treat a removed target as a cancellation.
- **Bindings lost if taking them failed part way.** All original values are now saved before any key changes, and missing schemas or keys (e.g. after a Tiling Assistant update) are skipped.
- **Restore stopped at the first missing schema.** Each schema and key is restored separately. Entries that cannot be restored stay in `saved-bindings` for a later restore, and `disable()` always finishes its clean-up.
- **Effect skips armed for the whole placement.** GNOME's skip list also governs close and minimize effects, so closing a window mid-snap made it vanish without its effect. Each native call now gets its own counted skip, released once that change has arrived (Mutter emits it inside the call), with any leftover removed when the placement ends.
- **Cleanups:**
  - A press while a maximized window is covered now starts the next motion from where it was seen.
  - Exact mapping from a cover fade is no longer inherited by a later motion.
  - A motion that interrupts the relax ease starts from where the window is drawn.
  - The failure path clears visuals using the known actor.

`tests/lifecycle.test.js` now uses two-check waits with a 2 s timeout, synchronous size-change (with a late variant), monitor removal, missing schemas and keys, and Mutter's restore of the floating frame. Each fix was mutation-checked: removing it makes a test fail. The one exception, leaving the skip handler connected through the animation, makes no behavioural difference because Mutter uses the skip inside the call.

Validation: 431 checks (121 rules, 77 adapter, 79 delayed placement, 154 lifecycle).

## Morph animation style (version 17, experiment/animations branch)

Live resizing is limited by how often each app redraws: Chromium about 200 times a second, Claude about 110, on monitors up to 500 Hz. Each layout stays on screen for several display frames however well the edges are tracked. The `morph` style takes the approach used by macOS window tiling, iPadOS Stage Manager and Android window animations instead:

1. The placement starts with a snapshot of the window as it looks now. From maximized, the unmaximize cover is that snapshot.
2. The app gets a single request for its final size.
3. On every display frame the snapshot moves and scales along the curve. This is pure GPU work, so it runs at the full refresh rate whatever the app's speed.
4. Once the app has drawn its final size, or at 60% of the motion for apps that cannot reach it, the live window is mapped onto the curve and fades in over 70 ms while the snapshot fades out.
5. The live window then holds on target as before, and native maximize still applies for full.

App speed only decides when the fade begins, not how smoothly the window moves. The trade-off: mid-motion the content is visibly scaled, and the old and new layouts are briefly blended.

`animation-style` is `live` (default; versions 7–16 behaviour) or `morph`, read at the start of every snap, so it can be switched without logging out:

```bash
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap animation-style morph
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap animation-style live
```

Validation: 478 checks (121 rules, 77 adapter, 79 delayed placement, 201 lifecycle), including morphs with a lagging client, a minimum-size client, a window closed mid-morph, an interrupted morph, and a morph from maximized. Each morph behaviour was mutation-checked.

## Re-aiming morphs and settled handover (version 20, experiment/animations branch)

Versions 18–19 (parked on `experiment/morph-quiet-handover`) broke window movement. Version 18 read Mutter's frame straight after the size request, assuming it already showed the granted size. For most Wayland clients Mutter only updates it once the client acknowledges, so 68 of 76 morphs aimed at the old size or at the restored floating size: the window was squeezed into the wrong rectangle, then corrected about 250 ms late. The test mock had updated the frame instantly, which hid this.

Version 20, built on version 17:

- **Realistic mock.** In `tests/lifecycle.test.js`, Mutter's frame now changes when the client draws (acknowledges) a size; `frameOnRequest` models X11. Version 18's code fails these tests.
- **Re-aim on what the app draws.** The morph aims at the requested size. If the app then draws a different size that Mutter confirms, the morph re-aims there. The target must sit on the requested edges and be at least the requested size, since a minimum size only enlarges. That rejects a floating size drawn late after unmaximizing. The end point glides to the new target over 40 ms, eased at both ends, so neither position nor speed jumps. An app that never visibly resizes is not re-aimed, because Mutter's frame cannot tell "not answered yet" from "answered with the same size"; it falls back to version 17's hold.
- **Settled handover (from version 19).** The live window takes over only after the app has drawn the final size and then nothing new for 24 ms (window actor `damaged` signal). This skips Chromium's first frame at a new size, which still has the old layout. Constant redraws, such as video, still hand over at 60% of the motion.

`FRAME` logs include `end`, `mutter`, `sized`, `ready` and `sinceDamage`; re-aims log a `morph-reaim` trace.

Validation: 516 checks (121 rules, 77 adapter, 79 delayed placement, 239 lifecycle), including a minimum-size app, a late floating draw, an X11-style frame, a 300 ms app, a re-laying-out app and video. Each behaviour was mutation-checked; the one surviving mutation (dropping the drawn-equals-Mutter-frame check) only removes a redundant guard.

## Crossfade ends before landing (version 21, experiment/animations branch)

A faint, faded-looking frame showed at the end of some morphs. In version 20's logs (67 Claude snaps), waiting for content to settle put the handover a median third of the way into the motion (90th percentile 57%). The fixed 70 ms crossfade then ran past the landing in 25 snaps, leaving the old snapshot half-transparent over the landed window for 7–37 ms. The fade now ends by 90% of the motion: up to 70 ms if there is room, shorter after a late handover, never under 16 ms.

Validation: 518 checks (121 rules, 77 adapter, 79 delayed placement, 241 lifecycle); a late-handover test asserts the snapshot is gone a few frames before the window lands.

## Tunable crossfade (version 22, experiment/animations branch)

Version 21's logs (80 morphs) show the snapshot always gone before landing and the live window never shown before the app drew its final size. The only blended period is the mid-motion crossfade, about 70 ms in which the old snapshot and the new layout overlap, which can read as a faded flash. Its maximum length is now the live `morph-fade` setting (milliseconds, default 70; 0 swaps in one frame at the handover). It still ends by 90% of the motion.

```bash
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap morph-fade 0
```

Validation: 530 checks (121 rules, 77 adapter, 79 delayed placement, 253 lifecycle).

## Covered maximize (version 23, experiment/animations branch)

On top half ↔ full, a panel pinned to the right of Claude desktop jumped left for one frame. Version 22's logs show the morph itself never scaled a vertical-only snap horizontally (60 snaps, zero frames). The likely cause is the app: when GNOME maximizes a window it removes the invisible shadow margin, and Chromium-based apps can present one frame still laid out for the old margin before correcting it.

Maximizing at the end of a snap, in either style, now happens under a snapshot of the landed window, which looks identical to what was already on screen. The snapshot is removed once the app has drawn after the maximize and then nothing new for 24 ms, or after 150 ms at most. A cancelled snap (interruption, mouse grab, disable) now releases its snapshots and effect skips immediately. With debug logging on, each frame the app draws under the cover is logged as `FRAME {"style":"state", drawn, buffer, mutter, mutterBuffer}` to confirm or rule out the offset frame. A `state-cover` trace records whether it settled.

`tests/lifecycle.test.js` adds a client whose first maximized frame is offset, one that does not redraw, a maximize slower than the cover limit, and a grab during the cover. It also has a 60 s watchdog that turns a hung snap into a failure naming the last passed check.

Validation: 572 checks (121 rules, 77 adapter, 79 delayed placement, 295 lifecycle), with the cover's behaviours mutation-checked.

## Learned follow-up frames (version 24, experiment/animations branch)

Version 23's logs (315 snaps, no errors) ruled out the maximize as the source of Claude's occasional one-frame panel shift: under all 88 maximize covers, every frame matched Mutter's geometry, and Claude redrew once (~14 ms). Instead, Claude draws a follow-up frame after its first frame at a new size: in 190 of 207 morphs, 43 ms later (median; 75th percentile 48 ms, 90th 55 ms). The 24 ms quiet rule handed over between the two, so the corrected layout appeared after the handover in 183 morphs, sometimes masked by the crossfade and sometimes not.

The follow-up delay is now learned per window:

- **Observation.** After each morph, draws within 80 ms of the first frame at the final size are recorded. Draws within 3 ms form one burst, and the latest burst is the follow-up. Observation continues after the motion ends, but stops at a maximize, since the redraw for the new state is not a layout follow-up. Same-size moves are not sampled. The estimate rises at once and decays slowly (25% per sample), so one snap without a follow-up does not reset it.
- **Handover.** A window with a learned follow-up of at least 10 ms is handed over after that delay (capped at 60 ms) plus 8 ms without drawing. Its fallback moves from 60% to 75% of the motion. Other windows (terminals, most Chromium pages) keep the 24 ms quiet rule.
- **Logging.** `animate` traces and `FRAME` logs include `followUp`; each sample logs a `follow-up` trace.

The first snap of a new window still learns, so its handover can precede the follow-up.

Validation: 607 checks (121 rules, 77 adapter, 79 delayed placement, 330 lifecycle). Each learning behaviour was mutation-checked: learning, cap, asymmetric decay, ignoring maximize redraws, observing past the motion, and the 75% fallback.

## Typical follow-up and reveal style (version 25, experiment/animations branch)

**Follow-up estimate.** Version 24's estimate rose to any slow sample and drifted to 66 ms for Claude, so its handovers mostly fell back to 75% of the motion, with short (~20 ms) crossfades. The learned delay is now the 75th percentile of the window's last 12 samples (no follow-up counts as 0). One slow or missing follow-up barely moves it, and for Claude it settles near its typical ~45–50 ms.

**Reveal style.** In the morph style the snapshot is scaled to the moving outline, so content visibly stretches or squishes, and the switch to the real layout pops near the end. `animation-style` now also accepts `reveal`. It shares everything with morph (snapshot, single request, re-aim, learned handover, maximize cover) except how content is drawn:

- The snapshot sits under the window and is never scaled down. Along an axis where it is larger than the outline it is cropped by the moving edge; along one where it is smaller (a growing window before the app has drawn) it stretches to fill.
- After the handover the live window fades in on top at its true size, its fixed edge aligned with the outline's, cropped to the outline. Where it is smaller (a shrinking window), the snapshot shows in the remaining strip.
- Clips are removed when a motion ends, is interrupted, or the window closes.

Switch live (no relog):

```bash
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap animation-style reveal
GSETTINGS_SCHEMA_DIR="$PWD/schemas" gsettings set org.gnome.shell.extensions.keyboard-monitor-snap animation-style morph
```

Validation: 684 checks (121 rules, 77 adapter, 79 delayed placement, 407 lifecycle). Reveal and the estimator were mutation-checked: squished snapshot, scaled or uncropped live window, clip left after the motion, snapshot above the window, slowest-sample estimate.

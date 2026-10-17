# Rewrite plan: simpler and cheaper, same behaviour

Branch: `rewrite`, from `main` at version 29 (`known-good-v29`). Nothing on this branch is installed until approved. Installing from it would also turn debug logging on.

## Status (2026-10-17)

| Phase | State |
|---|---|
| 0 Baseline | Done: `tests/mutations.py`, `tools/analyze-logs.py`, frame-handler cost in `FRAME` logs. Version 29's frame cost has not been measured, because that needs an instrumented install. |
| 1 Test infrastructure | Done: `tests/support/gnome.js` (one mock world) and `tests/support/load.js` (loads every module with mocked GNOME imports). |
| 2 Pure modules | Done: `geometry.js`, `handover.js`, `follow-up.js`, `layers.js`, plus a `units` suite. |
| 3 Lifetimes | Done: `scope.js` (`Scope`, `Snap`). |
| 4 Split | Done: `reveal.js`, `visuals.js`, `effects.js`, `follow-up-tracker.js`, `bindings.js`, `trace.js`; `extension.js` went from 1162 to 437 lines. Also fixed: Super+Arrow on the desktop-icons layer timed out after 2 s in version 29. |
| 5 Performance | Partly done: debug flag cached; one geometry read per frame. Deferred: signal-driven waits (gain at most one frame of confirmation latency; real Chromium ordering risk) and targeted crossing repaints (the ghosts turned out to be a layering gap fixed in version 28, so the repaint may not be needed at all). Both should be decided with live measurements. |
| 6 Review and live check | Review done; findings fixed (below). The live check awaits approval. |

All suites pass (754 checks) and the mutation sweep guards every listed behaviour (46), with one known, documented survivor.

### Independent review findings (phase 6), all addressed

- **No regressions** found in the moved logic.
- **Window filter too broad:** the desktop-icons fix also skipped dialogs, utility windows and movable skip-taskbar apps that version 29 snaps. Now only desktop, dock and splash windows, and fixed skip-taskbar windows, are ignored; tests cover both sides.
- **Disable order:** follow-up observations are stopped after placements are cancelled (cancelling can start one).
- **Debug flag:** subscribes to changes before reading the key.
- **Early cancel:** an animation whose snap is already cancelled sets nothing up.
- **Test gaps:** 13 behaviours (present in version 29 too) were not guarded by any test: hold stopped by a new motion or by actor destruction, the growing fade's tail, the final crossing repaint, re-aim restarting the size wait, granted-frame edge check, cancel on close, unregistering cancel hooks (animation and the real wait), timer removal on disable, smooth relax on a rejected window. Each now has a test and a sweep entry. The mocks gained recorded ease durations, restartable timelines and unique timer ids.
- **Cleanups:** `Visuals.clear` renamed `reset` (it overrode `Map.clear`); effects take only `debug`; the `FRAME` `sized` field means the current frame again, as in version 29.

## Goal

Make the extension easier to understand and cheaper per frame **without changing anything you can see**. Version 29 is the reference: every phase must keep its behaviour, its 591 automated checks, and its mutation-sweep results. The live comparison against version 29's logged metrics happens at the end.

Non-goals: new features, new settings, a different animation design.

## What makes it hard to work on today

Measured on version 29 (`extension.js`, 1162 lines):

1. **Two methods do most of the work.** `_reveal` (212 lines) mixes the curve maths, snapshot and backdrop layout, the handover decision (size, quiet period, learned follow-up, fallback), re-aiming, and logging inside one per-frame closure. `_effects` (199 lines) is one closure-object with ten methods (snapshot, backdrop, native-effect skips, the maximize cover and its watch, release) sharing hidden mutable state.
2. **Cleanup is hand-written everywhere.** About 24 `connectObject`/`disconnectObject` sites and four separate timelines (animation, hold, follow-up observation, maximize cover) each have their own stop-and-detach code. Both code reviews found their worst bugs here (a stopped timeline's handlers left connected; a cover never released on cancel).
3. **A snap's state is an ad-hoc object.** The `operation` has 11 fields (`cancelled`, `superseded`, `owner`, `target`, `targetMonitor`, `crossing`, `previousPlacement` and three different cancel hooks) added over time.
4. **`_run` (100 lines)** mixes key folding, tracked-state checks, monitor stepping and error handling.
5. **Tests duplicate the GNOME mocks.** `lifecycle.test.js` (1132 lines) and `adapter.test.js` each build their own fake `Meta`/`Clutter`/`St`/`Settings`/`global`. The handover rules can only be tested through full frame-stepped scenarios.

## Where per-frame time goes today

Each animation frame (up to 500 per second on the main monitor):

- **4 Mutter geometry calls** (`get_frame_rect`/`get_buffer_rect`, each allocating a new rectangle): `_drawnFrame` runs once for the decision and again inside `_showRevealed`.
- **A GSettings read** of `debug-logging` (`get_boolean`) every frame, and again in every `_trace` call.
- **Several closures and objects created** per frame (`align`, `fit`, curve and visual rectangles).
- **When crossing monitors, the whole window layer is repainted** on every monitor, every frame.
- **Between frames, confirmation waits poll** every 16 ms (`_waitForWindow`) rather than reacting to Mutter's signals.

None of this has caused visible problems: frame stalls were rare in the version 16–24 logs. But it is avoidable work on the compositor's main thread, at 500 Hz.

## Target structure

All files are ES modules in the extension directory (GNOME 45+ supports local imports, as `engine.js` and `placement.js` already show).

| File | Responsibility | Notes |
|---|---|---|
| `engine.js` | Snapping rules | Unchanged. |
| `geometry.js` | Pure helpers: `sameFrame`, interpolation, easing, `alignOn`, anchors, `travelDuration`, `visualTransform` | Moved out of `placement.js` and `extension.js`. |
| `placement.js` | The placement stages only | Unchanged logic. |
| `handover.js` | **Pure** state machine: given frame time, drawn size, damage times and the learned follow-up → `waiting`, `fading(progress)` or `done`, and the fade length | Unit-testable without mocks; replaces the inline logic in `_reveal`. |
| `follow-up.js` | **Pure** percentile estimator plus burst detection | The observation timeline stays in the animator. |
| `layers.js` | Where the snapshot, backdrop and live window go for a given outline (crop, align, layer order) | Pure maths returning rectangles; the animator applies them. |
| `reveal.js` | `RevealAnimation` class: one instance per snap; `frame()` reads geometry once, asks `handover`, applies `layers` | Replaces `_reveal`. |
| `effects.js` | `NativeEffects` (counted skips) and `StateCover` (maximize cover) | Split out of `_effects`. |
| `hold.js` | Post-motion hold and relax | |
| `scope.js` | Small cleanup helper: register connections, timelines and timers; `dispose()` releases them all once | Replaces the hand-written detach code. |
| `snap.js` | `Snap` class (was `operation`): target, monitors, one `scope` for everything it starts; `cancel()`/`supersede()` dispose it | |
| `bindings.js` | Taking and restoring the Super+Arrow shortcuts | Moved as is. |
| `trace.js` | Debug logging with the flag cached via `changed::debug-logging`; formatting only when on | |
| `extension.js` | Enable/disable, the dependency watcher, key handling (`_snap`/`_run`), wiring | Expected to shrink to about 300 lines. |

## Performance changes

Each change is applied alone, measured, and dropped if it shows no benefit:

1. **Cache the debug flag** (signal-driven): no GSettings read per frame or per trace.
2. **One geometry read per frame**: read `get_frame_rect`/`get_buffer_rect` and the actor geometry once in `RevealAnimation.frame()` and pass the result down; no per-frame closures; reuse rectangle objects.
3. **Signal-driven confirmation waits**: react to Mutter's `size-changed`, `position-changed` and `notify::maximized-*`, keeping the two-consecutive-checks rule and a slow safety poll. The out-of-order Chromium acknowledgements that shaped the current waits must stay covered, so this is the riskiest change and comes last.
4. **Targeted crossing repaints**: repaint only the union of the previous and current outline (`queue_redraw_with_clip`, if the GNOME 50 typelib exposes it), not every monitor. Only if live logs confirm the ghosts stay gone.

**Baseline first.** Before anything changes, add debug-only timing of the frame handler (microseconds per frame, logged in `FRAME`), so version 29 and the rewrite can be compared on the same snaps.

## Tests

- **Shared mock world**: one `tests/support/gnome.js` providing Mutter, Clutter and St fakes and the frame-stepped clock, used by the adapter and lifecycle suites.
- **Pure unit tests** for `handover.js`, `follow-up.js` and `layers.js` (cheap, exhaustive cases), alongside the existing scenario tests.
- **Keep every lifecycle scenario** as a behavioural golden test. Ported tests must assert the same things; none may be loosened to make a refactor pass.
- **Commit the mutation sweep** (`tests/mutations.py`): one script listing each guarded behaviour and the mutation that must fail a test. It is re-run after each phase, so test strength is checked, not just test pass rates.

## Phases

Each phase is one or more commits on `rewrite`, with every suite passing and the mutation sweep unchanged:

0. **Baseline**: frame-handler timing (debug only); the mutation sweep committed as a script; a log-analysis script capturing version 29's metrics (handover timing, follow-up learning, cover times, frame cost).
1. **Test infrastructure**: extract the shared mock world; no production changes.
2. **Pure modules**: `geometry.js`, `handover.js`, `follow-up.js`, `layers.js`, each with unit tests; `_reveal` calls them.
3. **Lifetime management**: `scope.js` and the `Snap` class; replace the hand-written detach code and the three cancel hooks.
4. **Split the rest**: `reveal.js`, `effects.js`, `hold.js`, `bindings.js`, `trace.js`; `extension.js` becomes wiring.
5. **Performance**: changes 1–4 above, one commit each, with before/after frame-cost numbers.
6. **Review and live check**: an independent code review of the branch; then, after approval, install it, compare live logs against version 29's metrics, and merge if they match.

## Risks

- **Mocks cannot show smoothness.** The final judgement is live, against version 29's logged metrics and by eye. Until then the rewrite stays on its own branch.
- **Signal-driven waits** could reintroduce Chromium ordering problems that polling hid. They come last, with the polling kept as a fallback.
- **Moving code across modules** can subtly change cleanup order (layer stacking, opacity restore). The scenario tests that check signal and handler leaks, opacity, clips and layer order are the guard.

## Open questions

1. Are multiple files fine, rather than one big `extension.js`? (Recommended.)
2. May the debug log format change slightly, for example adding frame cost or renaming fields? The analysis scripts would be updated with it.

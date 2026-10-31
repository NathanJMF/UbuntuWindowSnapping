// Keyboard window snapping: Super+Arrow moves the focused window through
// halves, quarters and monitors (engine.js) with a custom animation
// (reveal.js). This file wires the pieces together: the shortcuts and the
// Tiling Assistant dependency, per-window key handling, and each placement
// (placement.js) with its confirmation waits and Tiling Assistant metadata.
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
// Preserve Ubuntu mouse-tiling restore information after confirmed placement.
// Mouse handlers and Tiling Assistant methods are never monkey-patched.
import {TilingWindowManager as Twm} from 'file:///usr/share/gnome-shell/extensions/tiling-assistant@ubuntu.com/src/extension/tilingWindowManager.js';
import {Rect} from 'file:///usr/share/gnome-shell/extensions/tiling-assistant@ubuntu.com/src/extension/utility.js';
import {Bindings} from './bindings.js';
import {createEffects} from './effects.js';
import {FULL, step, rectangle} from './engine.js';
import {FollowUpTracker} from './follow-up-tracker.js';
import {sameFrame, zoomFor} from './geometry.js';
import {placeWindow} from './placement.js';
import {reveal} from './reveal.js';
import {Snap} from './scope.js';
import {Debug} from './trace.js';
import {Visuals} from './visuals.js';

const UUID = 'tiling-assistant@ubuntu.com';
// Animation length before travel scaling (see travelDuration) and GNOME's
// slow-down factor; GNOME's "animations off" switch disables it.
const ANIMATION_MS = 120;
// Confirmation checks run about once per frame, starting immediately; a
// stage that has not confirmed within WAIT_LIMIT_MS fails the placement.
const SETTLE_POLL_MS = 16;
const WAIT_LIMIT_MS = 2000;
// Presses made while a window animates interrupt it; up to this many are
// combined into the next placement.
const MAX_QUEUED = 3;
const DIRECTIONS = ['left', 'right', 'up', 'down'];
const NEIGHBOR = {left: Meta.DisplayDirection.LEFT, right: Meta.DisplayDirection.RIGHT,
    up: Meta.DisplayDirection.UP, down: Meta.DisplayDirection.DOWN};

export default class KeyboardMonitorSnap extends Extension {
    enable() {
        this._keys = [];
        // Per window: tracked keyboard layout, whether a placement is running,
        // presses waiting to be folded into the next one, the running snap.
        this._states = new WeakMap();
        this._busy = new WeakSet();
        this._queued = new WeakMap();
        this._operations = new Map();
        // Debug-only delayed traces and crossing repaints, removed on disable.
        this._timers = new Set();
        this._enabled = true;
        this._settings = this.getSettings();
        this._debug = new Debug(this._settings, this.uuid, window => this._states.get(window));
        // Modules trace through this, so tests can observe e._debug.trace.
        const trace = (...args) => this._debug.trace(...args);
        this._visuals = new Visuals(trace);
        this._followUps = new FollowUpTracker(trace);
        this._bindings = new Bindings(this._settings, this.uuid);
        // Ubuntu Tiling Assistant enables asynchronously. GNOME may enable us
        // before its imports and handlers have finished initializing.
        this._active = false;
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._syncDependency();
            return GLib.SOURCE_CONTINUE;
        });
        this._syncDependency();
        // Monitor indices change when monitors are added or removed: stop
        // every placement and forget layouts tied to the old indices.
        Main.layoutManager.connectObject('monitors-changed', () => this._monitorsChanged(), this);
        // Manual mouse movement/resizing begins a fresh keyboard sequence.
        this._grabId = global.display.connect('grab-op-begin', (_display, window) => {
            // GNOME can begin a grab with no window (panel and menu clicks).
            if (!window)
                return;
            this._queued.delete(window);
            this._operations.get(window)?.cancel();
            this._visuals.reset(window, false);
            this._states.delete(window);
        });
    }

    disable() {
        this._enabled = false;
        Main.layoutManager.disconnectObject(this);
        // Cancelling can end an animation, which starts a follow-up
        // observation: stop those afterwards.
        this._cancelOperations();
        this._followUps.stopAll();
        this._visuals.resetAll();
        for (const source of this._timers)
            GLib.Source.remove(source);
        this._timers.clear();
        if (this._watchId)
            GLib.Source.remove(this._watchId);
        this._watchId = null;
        if (this._grabId)
            global.display.disconnect(this._grabId);
        this._grabId = null;
        this._debug.dispose();
        try {
            this._releaseBindings();
        } finally {
            this._states = new WeakMap();
            this._queued = new WeakMap();
            this._dependency = null;
        }
    }

    // --- Shortcuts and the Tiling Assistant dependency

    _syncDependency() {
        this._dependency = Main.extensionManager.lookup(UUID);
        if (this._dependencyReady()) {
            // A quick dependency restart can finish between watchdog ticks.
            // Its new handler may have reclaimed the arrows; rebind explicitly.
            if (this._active && this._bindingOwner !== this._dependency.stateObj._keybindingHandler) {
                this._cancelOperations();
                this._releaseBindings();
                this._states = new WeakMap();
            }
            if (!this._active) {
                try {
                    this._activateBindings();
                    this._activationError = false;
                } catch (error) {
                    this._releaseBindings();
                    if (!this._activationError)
                        console.error(`${this.uuid}: ${error.stack ?? error}`);
                    this._activationError = true;
                }
            }
        } else if (this._active) {
            this._cancelOperations();
            this._releaseBindings();
            this._states = new WeakMap();
        }
    }

    _dependencyReady() {
        // GNOME retains stateObj after disabling an extension. Check the live
        // initialized adapter, not just whether its JS object still exists.
        const dependency = this._dependency?.stateObj;
        return dependency?._twm === Twm && Boolean(dependency._keybindingHandler) &&
            Boolean(dependency.settings?.getGioObject());
    }

    _activateBindings() {
        this._bindings.take();
        for (const direction of DIRECTIONS) {
            const key = `snap-${direction}`;
            Main.wm.addKeybinding(key, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL, () => {
                    this._snap(direction).catch(e => console.error(`${this.uuid}: ${e.message ?? e}\n${e.stack ?? ''}`));
                });
            this._keys.push(key);
        }
        this._bindingOwner = this._dependency.stateObj._keybindingHandler;
        this._active = true;
        console.log(`${this.uuid}: keyboard shortcuts active`);
    }

    _releaseBindings() {
        for (const key of this._keys ?? [])
            Main.wm.removeKeybinding(key);
        this._keys = [];
        this._active = false;
        this._bindingOwner = null;
        this._bindings?.restore();
    }

    _monitorsChanged() {
        this._cancelOperations();
        this._queued = new WeakMap();
        this._states = new WeakMap();
    }

    _monitorExists(index) {
        return Number.isInteger(index) && index >= 0 && index < global.display.get_n_monitors();
    }

    _cancelOperations() {
        for (const operation of this._operations?.values() ?? [])
            operation.cancel();
    }

    _animationDuration() {
        const st = St.Settings.get();
        return st.enable_animations ? Math.round(ANIMATION_MS * st.slow_down_factor) : 0;
    }

    // --- Key handling

    // Desktop, dock and splash windows never snap, nor does a fixed window
    // that opts out of the taskbar (Ubuntu's desktop-icons layer: maximized,
    // unmovable, skip-taskbar). Version 29 tried and waited 2 s for an
    // unmaximize that never came. Dialogs, utility windows and movable
    // skip-taskbar app windows still snap.
    _snappable(window) {
        const type = window.get_window_type();
        if (type === Meta.WindowType.DESKTOP || type === Meta.WindowType.DOCK ||
            type === Meta.WindowType.SPLASHSCREEN)
            return false;
        return !(window.skip_taskbar && !window.allows_move());
    }

    async _snap(direction, window = global.display.focus_window) {
        if (!this._dependencyReady() || !window || !this._snappable(window))
            return;
        if (this._busy.has(window)) {
            // Interrupt the running placement; once it unwinds, every queued
            // press is folded into one placement from wherever the window is.
            const queue = this._queued.get(window) ?? [];
            if (queue.length < MAX_QUEUED)
                queue.push(direction);
            this._queued.set(window, queue);
            this._operations.get(window)?.supersede();
            return;
        }
        await this._run(window, [direction]);
    }

    async _run(window, directions) {
        this._debug.trace(window, 'before', {directions});
        const actor = window.get_compositor_private();
        // Mutter can report maximized windows as non-resizable/non-movable.
        // Twm.tile unmaximizes before checking the underlying capabilities.
        const maximized = window.maximizedHorizontally || window.maximizedVertically;
        if (!maximized && (!window.allows_move() || !window.allows_resize())) {
            this._debug.trace(window, 'rejected-capability', {directions});
            this._visuals.reset(window, true);
            // An interrupted placement's intended layout is no longer valid.
            if (this._states.get(window)?.superseded)
                this._states.delete(window);
            return;
        }
        const operation = new Snap(this._dependency.stateObj._keybindingHandler);
        this._busy.add(window);
        this._operations.set(window, operation);
        let intended = null;
        try {
            let state = this._states.get(window);
            // An interrupted placement continues from its intended layout, not
            // from the in-between frame the window is currently showing.
            let superseded = Boolean(state?.superseded);
            if (superseded && !this._monitorExists(state.monitor)) {
                superseded = false;
                state = null;
            }
            let monitor = superseded ? state.monitor : window.get_monitor();
            // A maximization or tile change outside these shortcuts resets the
            // sequence. Pure focus changes preserve each window's sequence.
            const tracked = superseded || (state && state.monitor === monitor &&
                (this._visuals.get(window)?.zoomed || sameFrame(window.get_frame_rect(), state.frame)) &&
                (state.layout.x || state.layout.y
                    ? !Twm.isMaximized(window)
                    : Twm.isMaximized(window)));
            if (!tracked)
                state = {layout: {...FULL}, monitor};
            const startMonitor = monitor;
            let layout = state.layout;
            const crossings = [];
            for (const direction of directions) {
                const neighbor = global.display.get_monitor_neighbor_index(monitor, NEIGHBOR[direction]);
                const result = step(layout, direction, neighbor !== -1);
                layout = result.layout;
                if (result.cross) {
                    monitor = neighbor;
                    crossings.push(result.cross);
                }
            }
            if (!this._monitorExists(monitor))
                throw Object.assign(new Error('Placement cancelled: monitor removed'), {cancelled: true});
            const target = rectangle(layout, window.get_work_area_for_monitor(monitor));
            this._debug.trace(window, 'decision', {directions, tracked: Boolean(tracked), superseded,
                crossings, targetMonitor: monitor, target});
            // At an outer edge, an unchanged accepted half needs no new resize
            // transaction (particularly for minimum-size windows).
            if (tracked && !superseded && monitor === startMonitor && sameFrame(target, state.rect, 0)) {
                this._debug.trace(window, 'unchanged', {directions});
                return;
            }
            if (tracked && !superseded)
                operation.previousPlacement = {monitor: state.monitor, target: state.rect, frame: state.frame};
            intended = {layout, monitor, rect: target};
            const zoomed = this._zoomedFrame(window, target, monitor);
            operation.slot = zoomed ? target : null;
            const applied = await this._place(window, zoomed ?? target, monitor, operation);
            this._states.set(window, {...intended, frame: applied.frame});
            if (!zoomed)
                this._zoom(window, target, applied);
            // No animation ran (real frame already on target) but an
            // interrupted motion left a transform: relax it.
            if (this._visuals.has(window) && !this._visuals.get(window).stopHold)
                this._visuals.reset(window, true);
            this._debug.trace(window, 'after-request', {directions});
            if (this._debug.enabled)
                this._later(250, () => this._debug.trace(window, 'after-settle', {directions}));
        } catch (error) {
            if (operation.superseded && intended) {
                this._states.set(window, {...intended, superseded: true});
            } else {
                this._states.delete(window);
                this._queued.delete(window);
                this._visuals.reset(window, true, actor);
            }
            if (!operation.cancelled && !error.cancelled)
                throw error;
        } finally {
            if (this._operations.get(window) === operation)
                this._operations.delete(window);
            this._busy.delete(window);
        }
        const next = this._queued.get(window)?.splice(0) ?? [];
        if (next.length && this._enabled)
            await this._run(window, next);
    }

    // The frame to ask of a window whose minimum size Mutter already knows
    // will not fit `slot`, so the snap can move straight into the zoom. Null
    // when it fits. Minimum sizes include the shadow.
    _zoomedFrame(window, slot, monitor) {
        const [known, width, height] = window.get_min_size?.() ?? [false];
        if (!known ||
            sameFrame(slot, window.get_work_area_for_monitor(monitor), 0))
            return null;
        const frame = window.get_frame_rect(), buffer = window.get_buffer_rect();
        const zoom = zoomFor({width: width-buffer.width+frame.width,
            height: height-buffer.height+frame.height}, slot);
        return zoom && {x: slot.x, y: slot.y, width: zoom.width, height: zoom.height};
    }

    // Scale a Wayland app that turned out larger than its slot to fit it.
    _zoom(window, slot, {full}) {
        const actor = window.get_compositor_private();
        if (!full && actor)
            this._visuals.zoom(window, actor, slot);
    }

    // Run `callback` once after `ms`; cancelled on disable.
    _later(ms, callback) {
        const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(source);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(source);
    }

    // --- One placement

    async _place(window, target, monitor, operation) {
        operation.targetMonitor = monitor;
        operation.target = target;
        // While a window is drawn shifted across monitors, GNOME may not
        // repaint the area it leaves on the monitor it is officially no longer
        // on, leaving ghost images; crossings repaint every frame.
        const crossing = window.get_monitor() !== monitor;
        const original = window.untiledRect ?? new Rect(window.get_frame_rect());
        Twm.clearTilingProps(window.get_id());
        window.isTiled = false;
        window.tiledRect = null;
        const effects = createEffects(window, {animating: () => this._animationDuration() > 0,
            visuals: this._visuals, followUps: this._followUps, debug: this._debug});
        // A cancelled placement drops its snapshots and skips at once,
        // including a maximize cover the placement is waiting on.
        operation.onCancel(() => effects.release());
        const applied = await placeWindow(window, target, monitor, {
            both: Meta.MaximizeFlags.BOTH,
            previousPlacement: operation.previousPlacement,
            // An interrupted animation continues from what is on screen.
            animate: (from, to, apply) => this._reveal(window,
                this._visuals.get(window)?.rect ?? this._visuals.displayedRect(window) ?? from,
                to, apply, operation, effects, crossing),
            monitorExists: index => this._monitorExists(index),
            effects,
            waitFor: (predicate, stage) => this._waitForWindow(window, predicate, operation, stage),
            clearConstraints: w => {
                if (w.override_constraints) {
                    const none = Meta.WindowConstraint.NONE;
                    w.override_constraints(none, none, none, none);
                }
            },
            constrain: (w, rect, m) => {
                if (!w.override_constraints)
                    return;
                const area = w.get_work_area_for_monitor(m);
                const c = Meta.WindowConstraint;
                w.override_constraints(rect.y === area.y ? c.MONITOR : c.WINDOW,
                    rect.x === area.x ? c.MONITOR : c.WINDOW,
                    rect.x+rect.width === area.x+area.width ? c.MONITOR : c.WINDOW,
                    rect.y+rect.height === area.y+area.height ? c.MONITOR : c.WINDOW);
            },
        });
        if (operation.cancelled || !this._enabled || !this._dependencyReady() ||
            this._dependency.stateObj._keybindingHandler !== operation.owner)
            throw new Error('Placement cancelled');
        // Commit only confirmed geometry. Native partial-maximize hints are
        // intentionally avoided: Chromium can acknowledge them out of order.
        window.untiledRect = original;
        window.isTiled = !applied.full;
        window.tiledRect = applied.full ? null : new Rect(operation.slot ?? target);
        Twm.updateTileGroup([window]);
        Twm.saveTileState(window);
        return applied;
    }

    _reveal(window, from, to, apply, operation, effects, crossing = false) {
        return reveal({window, from, to, slot: operation.slot, apply, snap: operation, effects,
            visuals: this._visuals, followUps: this._followUps, debug: this._debug,
            base: this._animationDuration(), repaint: last => this._repaintCrossing(crossing, last)});
    }

    // Repaint the whole window layer (it includes the backgrounds, so it spans
    // every monitor) during a crossing; at the end, once more a frame later,
    // after the window's final geometry has been drawn.
    _repaintCrossing(crossing, last) {
        if (!crossing)
            return;
        global.window_group.queue_redraw();
        if (last)
            this._later(20, () => global.window_group.queue_redraw());
    }

    // Wait until predicate() holds on two consecutive checks. Rejects when
    // the snap is cancelled, the extension or its dependency goes away, the
    // target monitor disappears, the window closes, or WAIT_LIMIT_MS passes.
    _waitForWindow(window, predicate, operation, stage = 'geometry') {
        this._debug.trace(window, 'wait-start', {stage, targetMonitor: operation.targetMonitor, target: operation.target});
        return new Promise((resolve, reject) => {
            let source = null;
            let finished = false;
            let stable = 0;
            const start = GLib.get_monotonic_time();
            let unregister = () => {};
            const finish = error => {
                if (finished)
                    return;
                finished = true;
                if (source !== null)
                    GLib.Source.remove(source);
                unregister();
                error ? reject(error) : resolve();
            };
            unregister = operation.onCancel(() => finish(new Error('Placement cancelled')));
            const check = () => {
                try {
                    if (operation.cancelled || !this._enabled || !this._dependencyReady() ||
                        (operation.targetMonitor !== undefined && !this._monitorExists(operation.targetMonitor)) ||
                        this._dependency.stateObj._keybindingHandler !== operation.owner ||
                        !window.get_compositor_private()) {
                        finish(new Error('Placement cancelled'));
                    } else {
                        stable = predicate() ? stable+1 : 0;
                        if (stable >= 2) {
                            finish();
                        } else if (GLib.get_monotonic_time()-start > WAIT_LIMIT_MS*1000) {
                            this._debug.trace(window, 'wait-timeout', {stage,
                                targetMonitor: operation.targetMonitor, target: operation.target});
                            finish(new Error(`Placement timed out at ${stage}`));
                        }
                    }
                } catch (error) {
                    finish(error);
                }
                return finished ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
            };
            check();
            if (!finished)
                source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_POLL_MS, check);
        });
    }
}

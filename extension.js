import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
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
import {FULL, step, rectangle} from './engine.js';
import {placeWindow, sameFrame, interpolateRect, travelDuration} from './placement.js';

const UUID = 'tiling-assistant@ubuntu.com';
const COVER_FADE_MS = 120;
// Confirmation checks run about once per frame, starting immediately, so a
// state that is already true settles in one frame instead of two 25 ms polls.
const SETTLE_POLL_MS = 16;
// Presses made while a window animates interrupt it; up to this many are
// combined into the next placement.
const MAX_QUEUED = 3;
const DIRECTIONS = ['left', 'right', 'up', 'down'];
const NEIGHBOR = {left: Meta.DisplayDirection.LEFT, right: Meta.DisplayDirection.RIGHT,
    up: Meta.DisplayDirection.UP, down: Meta.DisplayDirection.DOWN};
const OWNED = {
    'org.gnome.shell.extensions.tiling-assistant': {
        'tile-left-half': '<Super>Left', 'tile-right-half': '<Super>Right',
        'tile-maximize': '<Super>Up', 'tile-top-half': '<Super>Up',
        'tile-bottom-half': '<Super>Down', 'restore-window': '<Super>Down',
    },
    'org.gnome.desktop.wm.keybindings': {
        maximize: '<Super>Up', unmaximize: '<Super>Down', minimize: '<Super>Down',
    },
    'org.gnome.mutter.keybindings': {
        'toggle-tiled-left': '<Super>Left', 'toggle-tiled-right': '<Super>Right',
    },
};

export default class KeyboardMonitorSnap extends Extension {
    enable() {
        this._keys = [];
        this._states = new WeakMap();
        this._busy = new WeakSet();
        this._queued = new WeakMap();
        this._traceTimers = new Set();
        this._operations = new Map();
        this._enabled = true;
        this._settings = this.getSettings();
        // Ubuntu Tiling Assistant enables asynchronously. GNOME may enable
        // us before its imports and handlers have finished initializing.
        this._active = false;
        this._watchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._syncDependency();
            return GLib.SOURCE_CONTINUE;
        });
        this._syncDependency();
        // Manual mouse movement/resizing begins a fresh keyboard sequence.
        this._grabId = global.display.connect('grab-op-begin', (_display, window) => {
            this._queued.delete(window);
            this._operations.get(window)?.cancel();
            this._states.delete(window);
        });
    }
    _activateBindings() {
        this._takeBindings();
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
    _takeBindings() {
        let saved = this._settings.get_string('saved-bindings');
        saved = saved ? JSON.parse(saved) : {};
        for (const [schema, keys] of Object.entries(OWNED)) {
            const settings = new Gio.Settings({schema_id: schema});
            saved[schema] ??= {};
            for (const [key, binding] of Object.entries(keys)) {
                const values = settings.get_strv(key);
                saved[schema][key] ??= values;
                settings.set_strv(key, values.filter(v => v !== binding));
            }
        }
        this._settings.set_string('saved-bindings', JSON.stringify(saved));
    }
    _cancelOperations() {
        for (const operation of this._operations?.values() ?? [])
            operation.cancel();
    }
    _waitForWindow(window, predicate, operation, stage = 'geometry') {
        this._trace(window, 'wait-start', {stage, targetMonitor:operation.targetMonitor, target:operation.target});
        return new Promise((resolve, reject) => {
            let source = null;
            let finished = false;
            let stable = 0;
            const start = GLib.get_monotonic_time();
            const finish = error => {
                if (finished) return;
                finished = true;
                if (source !== null) GLib.Source.remove(source);
                operation.cancelWait = null;
                error ? reject(error) : resolve();
            };
            operation.cancelWait = () => finish(new Error('Placement cancelled'));
            const check = () => {
                try {
                    if (operation.cancelled || !this._enabled || !this._dependencyReady() ||
                        this._dependency.stateObj._keybindingHandler !== operation.owner ||
                        !window.get_compositor_private()) {
                        finish(new Error('Placement cancelled'));
                    } else {
                        stable = predicate() ? stable+1 : 0;
                        if (stable >= 2) finish();
                        else if (GLib.get_monotonic_time()-start > 2000000)
                            {
                                this._trace(window, 'wait-timeout', {stage,
                                    targetMonitor:operation.targetMonitor, target:operation.target});
                                finish(new Error(`Placement timed out at ${stage}`));
                            }
                    }
                } catch (error) { finish(error); }
                return finished ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
            };
            check();
            if (!finished)
                source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SETTLE_POLL_MS, check);
        });
    }
    async _place(window, target, monitor, operation) {
        operation.targetMonitor = monitor;
        operation.target = target;
        const original = window.untiledRect ?? new Rect(window.get_frame_rect());
        Twm.clearTilingProps(window.get_id());
        window.isTiled = false;
        window.tiledRect = null;
        const applied = await placeWindow(window, target, monitor, {
            both: Meta.MaximizeFlags.BOTH,
            previousPlacement: operation.previousPlacement,
            animate: (from, to, apply) => this._animate(window, from, to, apply, operation),
            effects: this._effects(window),
            waitFor: (predicate, stage) => this._waitForWindow(window, predicate, operation, stage),
            clearConstraints: w => {
                if (w.override_constraints) {
                    const none = Meta.WindowConstraint.NONE;
                    w.override_constraints(none, none, none, none);
                }
            },
            constrain: (w, rect, m) => {
                if (!w.override_constraints) return;
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
        window.tiledRect = applied.full ? null : new Rect(target);
        Twm.updateTileGroup([window]);
        Twm.saveTileState(window);
        return applied;
    }
    _animationDuration() {
        const st = St.Settings.get();
        if (!st.enable_animations)
            return 0;
        return Math.round(this._settings.get_int('animation-duration') * st.slow_down_factor);
    }
    // Resize the real frame on every compositor frame so the application
    // redraws continuously. A request is sent only when the client has
    // acknowledged the previous size, or after a short timeout, so slow
    // clients are not flooded; the final target is always sent afterwards.
    _animate(window, from, to, apply, operation) {
        const base = this._animationDuration();
        const actor = window.get_compositor_private();
        if (!base || !actor)
            return Promise.resolve();
        const duration = travelDuration(base, from, to);
        this._trace(window, 'animate', {from, to, duration});
        return new Promise((resolve, reject) => {
            const timeline = new Clutter.Timeline({actor, duration,
                progress_mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            let requested = null;
            let sentAt = 0;
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                operation.cancelAnimation = null;
                timeline.disconnectObject(this);
                actor.disconnectObject(timeline);
                timeline.stop();
                error ? reject(error) : resolve();
            };
            operation.cancelAnimation = () => finish(new Error('Placement cancelled'));
            timeline.connectObject('new-frame', () => {
                const frame = window.get_frame_rect();
                const now = GLib.get_monotonic_time();
                const acknowledged = !requested ||
                    (Math.abs(frame.width-requested.width) <= 3 && Math.abs(frame.height-requested.height) <= 3);
                if (!acknowledged && now-sentAt < 50000)
                    return;
                const rect = interpolateRect(from, to, timeline.get_progress());
                if (requested && sameFrame(rect, requested, 0))
                    return;
                requested = rect;
                sentAt = now;
                apply(rect);
            }, 'completed', () => finish(), this);
            actor.connectObject('destroy', () => finish(new Error('Placement cancelled')), timeline);
            timeline.start();
        });
    }
    // Native maximize/unmaximize transitions are replaced: GNOME's zoom
    // effect is skipped, and a snapshot covers the frame jump while Mutter
    // leaves the maximized state, then fades out as the animation begins.
    _effects(window) {
        const actor = window.get_compositor_private();
        let cover = null;
        let skipped = false;
        let hidden = false;
        const enabled = () => actor && this._animationDuration() > 0;
        return {
            skip: () => {
                if (!enabled()) return;
                Main.wm.skipNextEffect(actor);
                skipped = true;
            },
            cover: rect => {
                if (!enabled() || cover) return;
                let content;
                try {
                    content = actor.paint_to_content(window.get_frame_rect());
                } catch (error) {
                    // No texture yet (e.g. just mapped): animate without a cover.
                    return;
                }
                cover = new St.Widget({content});
                cover.set_position(rect.x, rect.y);
                cover.set_size(rect.width, rect.height);
                global.window_group.add_child(cover);
                global.window_group.set_child_above_sibling(cover, actor);
                actor.opacity = 0;
                hidden = true;
            },
            uncover: () => {
                if (!cover) return;
                const fading = cover;
                cover = null;
                actor.opacity = 255;
                hidden = false;
                fading.ease({opacity: 0, duration: COVER_FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => fading.destroy()});
            },
            release: () => {
                if (cover) {
                    cover.destroy();
                    cover = null;
                }
                if (actor) {
                    if (hidden)
                        actor.opacity = 255;
                    hidden = false;
                    // An unused skip would swallow the next unrelated effect.
                    if (skipped)
                        Main.wm._skippedActors?.delete(actor);
                }
            },
        };
    }
    _trace(window, phase, extra = {}) {
        if (!this._settings?.get_boolean('debug-logging'))
            return;
        try {
            const state = this._states.get(window);
            const frame = window.get_frame_rect();
            const rect = r => r ? {x:r.x, y:r.y, width:r.width, height:r.height} : null;
            console.log(`${this.uuid}: TRACE ${JSON.stringify({
                phase, app:window.get_wm_class(), id:window.get_id(),
                monitor:window.get_monitor(), priorMonitor:state?.monitor,
                priorLayout:state?.layout, nativeMaxH:window.maximizedHorizontally,
                nativeMaxV:window.maximizedVertically, canMove:window.allows_move(),
                canResize:window.allows_resize(), isTiled:window.isTiled,
                tiledRect:rect(window.tiledRect), frame:rect(frame), ...extra,
            })}`);
        } catch (error) {
            // A window can close before the delayed diagnostic sample.
            console.log(`${this.uuid}: TRACE sample unavailable: ${error.message}`);
        }
    }
    async _snap(direction, window = global.display.focus_window) {
        if (!this._dependencyReady() || !window)
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
        this._trace(window, 'before', {directions});
        // Mutter can report maximized windows as non-resizable/non-movable.
        // Twm.tile unmaximizes before checking the underlying capabilities.
        const maximized = window.maximizedHorizontally || window.maximizedVertically;
        if (!maximized && (!window.allows_move() || !window.allows_resize())) {
            this._trace(window, 'rejected-capability', {directions});
            return;
        }
        this._busy.add(window);
        const operation = {owner:this._dependency.stateObj._keybindingHandler, cancelled:false,
            cancel() {this.cancelled=true; this.cancelWait?.(); this.cancelAnimation?.();},
            supersede() {if (!this.cancelled) {this.superseded=true; this.cancel();}}};
        this._operations.set(window, operation);
        let intended = null;
        try {
            let state = this._states.get(window);
            // An interrupted placement continues from its intended layout,
            // not from the in-between frame the window is currently showing.
            const superseded = Boolean(state?.superseded);
            let monitor = superseded ? state.monitor : window.get_monitor();
            // A maximization or tile change outside these shortcuts resets the
            // sequence. Pure focus changes preserve each window's sequence.
            const tracked = superseded || (state && state.monitor === monitor &&
                sameFrame(window.get_frame_rect(), state.frame) &&
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
            const area = window.get_work_area_for_monitor(monitor);
            const target = rectangle(layout, area);
            this._trace(window, 'decision', {directions, tracked:Boolean(tracked), superseded,
                crossings, targetMonitor:monitor, target});
            // At an outer edge, an unchanged accepted half needs no new
            // resize transaction (particularly for minimum-size windows).
            if (tracked && !superseded && monitor === startMonitor && sameFrame(target, state.rect, 0)) {
                this._trace(window, 'unchanged', {directions});
                return;
            }
            if (tracked && !superseded)
                operation.previousPlacement = {monitor:state.monitor, target:state.rect, frame:state.frame};
            intended = {layout, monitor, rect: target};
            const applied = await this._place(window, target, monitor, operation);
            this._states.set(window, {...intended, frame:applied.frame});
            this._trace(window, 'after-request', {directions});
            if (this._settings.get_boolean('debug-logging')) {
                const source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                    this._traceTimers.delete(source);
                    this._trace(window, 'after-settle', {directions});
                    return GLib.SOURCE_REMOVE;
                });
                this._traceTimers.add(source);
            }
        } catch (error) {
            if (operation.superseded && intended) {
                this._states.set(window, {...intended, superseded:true});
            } else {
                this._states.delete(window);
                this._queued.delete(window);
            }
            if (!operation.cancelled) throw error;
        } finally {
            if (this._operations.get(window) === operation)
                this._operations.delete(window);
            this._busy.delete(window);
        }
        const next = this._queued.get(window)?.splice(0) ?? [];
        if (next.length && this._enabled)
            await this._run(window, next);
    }
    _releaseBindings() {
        for (const key of this._keys ?? [])
            Main.wm.removeKeybinding(key);
        if (this._settings) {
            const raw = this._settings.get_string('saved-bindings');
            if (raw) {
                for (const [schema, keys] of Object.entries(JSON.parse(raw))) {
                    const settings = new Gio.Settings({schema_id: schema});
                    for (const [key, values] of Object.entries(keys))
                        settings.set_strv(key, values);
                }
                this._settings.set_string('saved-bindings', '');
            }
        }
        this._keys = [];
        this._active = false;
        this._bindingOwner = null;
    }
    disable() {
        this._enabled = false;
        this._cancelOperations();
        for (const source of this._traceTimers ?? [])
            GLib.Source.remove(source);
        this._traceTimers?.clear();
        if (this._watchId)
            GLib.Source.remove(this._watchId);
        this._watchId = null;
        if (this._grabId)
            global.display.disconnect(this._grabId);
        this._grabId = null;
        this._releaseBindings();
        this._states = new WeakMap();
        this._queued = new WeakMap();
        this._dependency = null;
    }
}

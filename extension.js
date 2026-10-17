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
import {placeWindow, sameFrame, interpolateRect, travelDuration, visualTransform,
    easeOutCubic, anchorFor, growthFor} from './placement.js';

const UUID = 'tiling-assistant@ubuntu.com';
const rect = r => ({x: r.x, y: r.y, width: r.width, height: r.height});
// Start position of something `size` long whose anchor point (0 start edge,
// 1 end edge, 0.5 centre) lines up with that point of the span start..size.
const alignOn = (size, start, span, anchor) => start + anchor*span - anchor*size;
const COVER_FADE_MS = 120;
// Morph style: the live window fades in over this long once the app has
// drawn its final size, or from this fraction of the motion at the latest
// (minimum-size apps never reach the requested size).
// The crossfade lasts up to the morph-fade setting but always ends by
// MORPH_FADE_END of the motion (never shorter than MORPH_MIN_FADE_MS unless
// the setting is lower), so the snapshot never lingers half-transparent
// over a window that has already landed. morph-fade 0 swaps instantly.
const MORPH_MIN_FADE_MS = 16;
const MORPH_FADE_END = 0.9;
const MORPH_READY_LIMIT = 0.6;
// Chromium-based apps often present their first frame at a new size with
// the old layout, then re-lay out a frame or two later. The handover waits
// until the app has drawn the final size and then nothing new for this long.
const MORPH_QUIET_MS = 24;
// Some apps (Claude desktop) draw a follow-up frame about 40-55 ms after
// their first frame at a new size, with the corrected layout. The delay is
// learned per window as the MORPH_FOLLOW_PERCENTILE of its last
// MORPH_FOLLOW_SAMPLES samples (no follow-up counts as 0): follow-ups up to
// MORPH_FOLLOW_WINDOW_MS after the first frame count. A window known to draw one (learned delay of at least
// MORPH_FOLLOW_MIN_MS) is handed over only after that delay (capped at
// MORPH_FOLLOW_CAP_MS) plus MORPH_FOLLOW_QUIET_MS without drawing, and its
// fallback handover moves to MORPH_FOLLOW_READY_LIMIT of the motion.
const MORPH_FOLLOW_WINDOW_MS = 80;
const MORPH_FOLLOW_SAMPLES = 12;
const MORPH_FOLLOW_PERCENTILE = 0.75;
const MORPH_FOLLOW_MIN_MS = 10;
const MORPH_FOLLOW_CAP_MS = 60;
const MORPH_FOLLOW_QUIET_MS = 8;
const MORPH_FOLLOW_READY_LIMIT = 0.75;
// A re-aimed morph glides its end point to the new target over this long
// (eased at both ends), so neither position nor speed jumps.
const MORPH_REAIM_MS = 40;
// Maximizing is covered by a snapshot of the landed window until the app has
// drawn its maximized frame and gone quiet, or this long at most.
const STATE_COVER_MAX_MS = 150;
// Confirmation checks run about once per frame, starting immediately, so a
// state that is already true settles in one frame instead of two 25 ms polls.
const SETTLE_POLL_MS = 16;
// After the motion, a lagging client is held visually on target this long
// while it finishes resizing, then its transform relaxes over RELAX_MS.
const VISUAL_HOLD_MS = 150;
const RELAX_MS = 80;
// Resize acknowledgement latency: smoothing weight for new samples, upper
// bound for the request lead, and the guess for a window not yet measured.
const LATENCY_WEIGHT = 0.4;
const MAX_LEAD_MS = 120;
const DEFAULT_LATENCY_MS = 16;
// Size requests go out continuously so a client always renders the newest
// target, but no more often than this, and at most MAX_PENDING are tracked.
const MIN_REQUEST_GAP_US = 4000;
const MAX_PENDING = 64;
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
        // Window -> {rect, hold}: the on-screen rectangle currently shown by
        // an actor transform, and the post-animation hold timeline.
        this._visuals = new Map();
        // Window -> smoothed milliseconds from a size request until it is
        // drawn, and between successive redraws (diagnostics only).
        this._latency = new WeakMap();
        // Window -> smoothed absolute deviation of latency samples.
        this._latencySpread = new WeakMap();
        this._redraw = new WeakMap();
        // Window -> learned delay (ms) of its follow-up frame after a resize,
        // and the recent samples it is computed from.
        this._followUp = new WeakMap();
        this._followSamples = new WeakMap();
        // Follow-up observations still running after their morph ended, by
        // stop function and by window (to end them before a maximize).
        this._learners = new Set();
        this._learnerByWindow = new WeakMap();
        // Window -> monotonic time until which the image maps exactly.
        this._exactUntil = new WeakMap();
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
        // Monitor indices change when monitors are added or removed: stop
        // every placement and forget layouts tied to the old indices.
        Main.layoutManager.connectObject('monitors-changed', () => this._monitorsChanged(), this);
        // Manual mouse movement/resizing begins a fresh keyboard sequence.
        this._grabId = global.display.connect('grab-op-begin', (_display, window) => {
            this._queued.delete(window);
            this._operations.get(window)?.cancel();
            this._clearVisual(window, false);
            this._states.delete(window);
        });
    }
    _monitorsChanged() {
        this._cancelOperations();
        this._queued = new WeakMap();
        this._states = new WeakMap();
    }
    _monitorExists(index) {
        return Number.isInteger(index) && index >= 0 && index < global.display.get_n_monitors();
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
        // saved-bindings keeps each key's value from before we took it. All
        // originals are stored before any key is changed, so a failure part
        // way through can always be undone. Missing schemas or keys (e.g.
        // after a Tiling Assistant update) are skipped.
        let saved = this._settings.get_string('saved-bindings');
        saved = saved ? JSON.parse(saved) : {};
        const changes = [];
        for (const [schema, keys] of Object.entries(OWNED)) {
            const settings = this._schemaSettings(schema);
            if (!settings)
                continue;
            for (const [key, binding] of Object.entries(keys)) {
                let values;
                try {
                    values = settings.get_strv(key);
                } catch (error) {
                    console.warn(`${this.uuid}: ${schema} ${key} unavailable: ${error.message}`);
                    continue;
                }
                saved[schema] ??= {};
                saved[schema][key] ??= values;
                changes.push(() => settings.set_strv(key, values.filter(v => v !== binding)));
            }
        }
        this._settings.set_string('saved-bindings', JSON.stringify(saved));
        changes.forEach(change => change());
    }
    _schemaSettings(schema) {
        try {
            return new Gio.Settings({schema_id: schema});
        } catch (error) {
            console.warn(`${this.uuid}: ${error.message}`);
            return null;
        }
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
                        (operation.targetMonitor !== undefined && !this._monitorExists(operation.targetMonitor)) ||
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
        const style = this._settings.get_string('animation-style');
        const morph = style === 'morph' || style === 'reveal';
        const effects = this._effects(window, {morph});
        // A cancelled placement drops its snapshots and skips at once,
        // including a maximize cover the placement is waiting on.
        operation.cancelEffects = () => effects.release();
        const applied = await placeWindow(window, target, monitor, {
            both: Meta.MaximizeFlags.BOTH,
            previousPlacement: operation.previousPlacement,
            // An interrupted animation continues from what is on screen.
            animate: (from, to, apply) => {
                const start = this._visuals.get(window)?.rect ?? this._displayedRect(window) ?? from;
                return morph && effects.snapshot()
                    ? this._morph(window, start, to, apply, operation, effects, {reveal: style === 'reveal'})
                    : this._animate(window, start, to, apply, operation);
            },
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
    _maxStretch() {
        return this._settings.get_int('max-stretch') / 100;
    }
    // Resize the real frame on every compositor frame so the application
    // redraws continuously. A request is sent only when the client has
    // acknowledged the previous size, or after a short timeout, so slow
    // clients are not flooded; the final target is always sent afterwards.
    _animate(window, from, to, apply, operation) {
        const base = this._animationDuration();
        const actor = window.get_compositor_private();
        if (!base || !actor) {
            this._clearVisual(window, false);
            return Promise.resolve();
        }
        const duration = travelDuration(base, from, to);
        const anchor = anchorFor(from, to);
        const growth = growthFor(from, to);
        const maxStretch = this._maxStretch();
        this._trace(window, 'animate', {from, to, duration, lead:this._lead(window), maxStretch,
            client: window.get_client_type?.() === Meta.WindowClientType.X11 ? 'x11' : 'wayland'});
        // A previous hold or relax transition is superseded by this motion.
        this._visuals.get(window)?.stopHold?.();
        actor.remove_all_transitions();
        actor.remove_clip?.();
        // Exact mapping belongs to the cover this motion just faded out; a
        // later motion must not inherit it.
        const exactUntil = this._exactUntil.get(window) ?? 0;
        this._exactUntil.delete(window);
        // Same-size moves give no size commits to time.
        const measurable = from.width !== to.width || from.height !== to.height;
        return new Promise((resolve, reject) => {
            // Linear timeline: the curve is evaluated directly so requests can
            // sample it ahead of the frame being drawn.
            const timeline = new Clutter.Timeline({actor, duration});
            // Requests not yet seen drawn, oldest first; the newest request is
            // also kept separately so a drawn one is never sent again.
            const sent = [];
            let lastRequest = null;
            let lastDrawn = null;
            // Curve time requested so far: never moves backwards, even when
            // the latency estimate drops mid-motion.
            let aimed = 0;
            let finished = false;
            const finish = error => {
                if (finished) return;
                finished = true;
                operation.cancelAnimation = null;
                timeline.disconnectObject(this);
                actor.disconnectObject(timeline);
                window.disconnectObject?.(timeline);
                timeline.stop();
                if (!error)
                    this._hold(window, actor, to, {anchor, maxStretch, growth});
                else if (!operation.superseded)
                    this._clearVisual(window, false, actor);
                // A superseded motion keeps its transform: the next placement
                // starts from this on-screen rectangle without a jump.
                error ? reject(error) : resolve();
            };
            operation.cancelAnimation = () => finish(new Error('Placement cancelled'));
            timeline.connectObject('new-frame', () => {
                const elapsed = timeline.get_elapsed_time();
                // What is on screen, not Mutter's frame rect: that can change
                // as soon as a size is requested, long before the client draws it.
                const frame = this._drawnFrame(window, actor).frame;
                const now = GLib.get_monotonic_time();
                // Only a newly drawn size is a commit: the newest request it
                // matches gives one latency sample (older ones were skipped by
                // the client), and the time since the last commit one redraw.
                if (!lastDrawn || lastDrawn.width !== frame.width || lastDrawn.height !== frame.height) {
                    if (lastDrawn && measurable)
                        this._sample(this._redraw, window, (now-lastDrawn.at)/1000);
                    lastDrawn = {width: frame.width, height: frame.height, at: now};
                    // Exact sizes first: late in a motion successive requests
                    // differ by under 3 px, and a loose match would pair the
                    // drawn size with a newer request and under-read the lag.
                    // The tolerance covers clients that adjust sizes slightly.
                    const newest = tolerance => {
                        for (let i = sent.length-1; i >= 0; i--) {
                            if (Math.abs(frame.width-sent[i].rect.width) <= tolerance &&
                                Math.abs(frame.height-sent[i].rect.height) <= tolerance)
                                return i;
                        }
                        return -1;
                    };
                    let acked = newest(0);
                    if (acked === -1)
                        acked = newest(3);
                    if (acked !== -1) {
                        if (measurable)
                            this._sampleLatency(window, (now-sent[acked].at)/1000);
                        sent.splice(0, acked+1);
                    }
                }
                // Ask for the size the curve will reach when the client is
                // expected to draw it.
                aimed = Math.max(aimed, elapsed + this._lead(window));
                const ahead = interpolateRect(from, to, easeOutCubic(aimed/duration));
                if ((!lastRequest || now-lastRequest.at >= MIN_REQUEST_GAP_US) &&
                    !(lastRequest && sameFrame(ahead, lastRequest.rect, 0))) {
                    lastRequest = {rect: ahead, at: now};
                    sent.push(lastRequest);
                    if (sent.length > MAX_PENDING)
                        sent.shift();
                    apply(ahead);
                }
                const curve = interpolateRect(from, to, easeOutCubic(elapsed/duration));
                // While a cover fades, the restored floating frame underneath
                // is mapped exactly onto the curve; the cap applies afterwards.
                const exact = now < exactUntil;
                this._showAt(window, actor, curve, exact
                    ? {anchor, maxStretch: null, growth: {x: 0, y: 0}} : {anchor, maxStretch, growth});
                if (this._settings.get_boolean('debug-logging'))
                    console.log(`${this.uuid}: FRAME ${JSON.stringify({id:window.get_id(), elapsed,
                        curve, drawn:frame, mutter:rect(window.get_frame_rect()), requested:lastRequest?.rect ?? null,
                        lead:Math.round(this._lead(window)*10)/10, pending:sent.length,
                        latency:Math.round((this._latency.get(window) ?? 0)*10)/10,
                        spread:Math.round((this._latencySpread.get(window) ?? 0)*10)/10,
                        redraw:Math.round((this._redraw.get(window) ?? 0)*10)/10,
                        scale:[actor.scale_x, actor.scale_y].map(v => Math.round(v*1000)/1000)})}`);
            }, 'completed', () => finish(), this);
            actor.connectObject('destroy', () => operation.cancel(), timeline);
            // A closing window keeps its actor for GNOME's close effect; stop
            // driving it as soon as it is unmanaged.
            window.connectObject?.('unmanaging', () => operation.cancel(), timeline);
            timeline.start();
        });
    }
    // Snapshot morph: the snapshot taken when the placement began moves along
    // the curve on every display frame, while the app renders its final size
    // once. When that size is drawn, the live window, mapped onto the curve,
    // fades in as the snapshot fades out. App speed only decides when the
    // fade starts, never how smoothly the window moves.
    // Reveal style (reveal: true): content is never scaled down. The snapshot
    // sits under the live window, scaled up only along an axis where it is
    // smaller than the moving outline, and cropped to the outline. After the
    // handover the live window fades in on top at its true size, its fixed
    // edge aligned with the outline, cropped too; where it is smaller (a
    // shrinking window) the snapshot shows in the remaining strip.
    _morph(window, from, to, apply, operation, effects, {reveal = false} = {}) {
        const base = this._animationDuration();
        const actor = window.get_compositor_private();
        const cover = effects.snapshot();
        if (!base || !actor || !cover)
            return this._animate(window, from, to, apply, operation);
        const duration = travelDuration(base, from, to);
        const exact = {anchor: anchorFor(from, to), maxStretch: null, growth: {x: 0, y: 0}};
        this._trace(window, 'animate', {from, to, duration, style: reveal ? 'reveal' : 'morph',
            followUp: Math.round(this._followUp.get(window) ?? 0),
            client: window.get_client_type?.() === Meta.WindowClientType.X11 ? 'x11' : 'wayland'});
        this._visuals.get(window)?.stopHold?.();
        actor.remove_all_transitions();
        actor.remove_clip?.();
        this._exactUntil.delete(window);
        const startSize = this._drawnFrame(window, actor).frame;
        // The snapshot's own size, before any scaling.
        const natural = {width: cover.width, height: cover.height};
        if (reveal)
            global.window_group.set_child_below_sibling(cover, actor);
        // One request for the final size; nothing in between.
        apply(to);
        return new Promise((resolve, reject) => {
            const timeline = new Clutter.Timeline({actor, duration});
            // The curve eases from `from` towards an end point. A re-aim
            // glides that end point from its current value to the new target
            // (smoothstep, finishing before the motion does), so the window's
            // position and speed both stay continuous.
            let end = to;
            let glide = null;
            const smoothstep = u => u <= 0 ? 0 : u >= 1 ? 1 : u*u*(3-2*u);
            const endAt = elapsed => glide
                ? interpolateRect(glide.from, end, smoothstep((elapsed-glide.at)/glide.ms)) : end;
            const curveAt = elapsed => interpolateRect(from, endAt(elapsed), easeOutCubic(elapsed/duration));
            // Elapsed time when the live window began to fade in, and how long
            // that fade lasts (read once per snap; live-tunable).
            const fadeLimit = this._settings.get_int('morph-fade');
            let fadeFrom = null;
            let fadeMs = fadeLimit;
            // When the app last drew anything (the snapshot counts as drawn),
            // when it first drew the final size, and every draw since.
            let lastDamage = GLib.get_monotonic_time();
            let sizedAt = null;
            const draws = [];
            // Learned follow-up delay for this window (see MORPH_FOLLOW_*).
            const followUp = this._followUp.get(window) ?? 0;
            const follows = followUp >= MORPH_FOLLOW_MIN_MS;
            const followWait = Math.min(followUp, MORPH_FOLLOW_CAP_MS);
            const readyLimit = follows ? MORPH_FOLLOW_READY_LIMIT : MORPH_READY_LIMIT;
            let finished = false;
            const sameSize = (a, b) => Math.abs(a.width-b.width) <= 3 && Math.abs(a.height-b.height) <= 3;
            // Mutter's frame, once the app has acknowledged the request, is
            // the size it was granted (e.g. widened to a minimum width). Only
            // trusted on the requested edges, and only if at least the
            // requested size: a minimum only ever enlarges. That rejects a
            // late-drawn floating size after unmaximizing, which can look
            // like an answer.
            const granted = () => {
                const g = rect(window.get_frame_rect());
                const aligned = (at, size) => Math.abs(g[at]-to[at]) <= 3 ||
                    Math.abs(g[at]+g[size]-to[at]-to[size]) <= 3;
                return g.width >= to.width-3 && g.height >= to.height-3 &&
                    aligned('x', 'width') && aligned('y', 'height') ? g : null;
            };
            const reaim = (elapsed, target, why) => {
                const current = endAt(elapsed);
                glide = {from: current, at: elapsed,
                    ms: Math.max(1, Math.min(MORPH_REAIM_MS, duration-elapsed))};
                end = target;
                sizedAt = null;
                this._trace(window, 'morph-reaim', {why, elapsed, from:current, to:target});
            };
            const finish = error => {
                if (finished) return;
                finished = true;
                operation.cancelAnimation = null;
                timeline.disconnectObject(this);
                actor.disconnectObject(timeline);
                window.disconnectObject?.(timeline);
                const elapsed = timeline.get_elapsed_time();
                timeline.stop();
                this._observeFollowUp(window, actor, sizedAt, draws, from, to);
                if (!error) {
                    // The live window takes over; an unfinished fade completes
                    // on its own while the hold keeps the window on target.
                    // In reveal style the snapshot is underneath and now fully
                    // hidden by the opaque window at its final size.
                    actor.opacity = 255;
                    actor.remove_clip?.();
                    this._showAt(window, actor, end, exact);
                    effects.dropCover(reveal ? 0 : fadeFrom === null ? Math.min(fadeLimit, MORPH_MIN_FADE_MS)
                        : Math.max(0, fadeMs-(elapsed-fadeFrom)));
                    this._hold(window, actor, end, exact);
                } else if (!operation.superseded) {
                    this._clearVisual(window, false, actor);
                }
                error ? reject(error) : resolve();
            };
            operation.cancelAnimation = () => finish(new Error('Placement cancelled'));
            timeline.connectObject('new-frame', () => {
                const elapsed = timeline.get_elapsed_time();
                const now = GLib.get_monotonic_time();
                const drawn = this._drawnFrame(window, actor).frame;
                const late = elapsed >= readyLimit*duration;
                // Re-aim at the size the app really takes, once it has drawn a
                // new size that Mutter confirms. Mutter's frame alone cannot
                // tell "not answered yet" from "answered with the old size",
                // so an app that never visibly resizes is not re-aimed.
                if (fadeFrom === null && !sameSize(drawn, end) && !sameSize(drawn, startSize)) {
                    const g = granted();
                    if (g && sameSize(drawn, g) && !sameSize(g, end))
                        reaim(elapsed, g, 'drawn');
                }
                const curve = curveAt(elapsed);
                if (reveal) {
                    // Scale up only where the snapshot is smaller; crop the rest.
                    const width = Math.max(natural.width, curve.width);
                    const height = Math.max(natural.height, curve.height);
                    const x = alignOn(width, curve.x, curve.width, exact.anchor.x);
                    const y = alignOn(height, curve.y, curve.height, exact.anchor.y);
                    cover.set_position(x, y);
                    cover.set_size(width, height);
                    cover.set_clip(curve.x-x, curve.y-y, curve.width, curve.height);
                } else {
                    cover.set_position(curve.x, curve.y);
                    cover.set_size(curve.width, curve.height);
                }
                const sized = sameSize(drawn, end);
                if (sized && sizedAt === null)
                    sizedAt = lastDamage;
                // Hand over once the content is final: after the learned
                // follow-up frame for windows that draw one, otherwise after
                // MORPH_QUIET_MS without drawing.
                const ready = sized && (follows
                    ? now-sizedAt >= (followWait+MORPH_FOLLOW_QUIET_MS)*1000 &&
                      now-lastDamage >= MORPH_FOLLOW_QUIET_MS*1000
                    : now-lastDamage >= MORPH_QUIET_MS*1000);
                if (fadeFrom === null && (ready || late)) {
                    fadeFrom = elapsed;
                    fadeMs = Math.max(Math.min(fadeLimit, MORPH_MIN_FADE_MS),
                        Math.min(fadeLimit, MORPH_FADE_END*duration-elapsed));
                }
                if (fadeFrom !== null && reveal) {
                    // The live window fades in on top, unscaled and cropped;
                    // the snapshot underneath stays until the motion ends.
                    const f = fadeMs <= 0 ? 1 : Math.min(1, (elapsed-fadeFrom)/fadeMs);
                    actor.opacity = Math.round(255*f);
                    this._showRevealed(window, actor, curve, exact.anchor);
                } else if (fadeFrom !== null) {
                    actor.opacity = 255;
                    this._showAt(window, actor, curve, exact);
                    cover.opacity = fadeMs <= 0 ? 0
                        : Math.round(255*(1-Math.min(1, (elapsed-fadeFrom)/fadeMs)));
                } else {
                    // Still covered: remember what is on screen for interruptions.
                    const visual = this._visuals.get(window) ?? {};
                    visual.rect = curve;
                    this._visuals.set(window, visual);
                }
                if (this._settings.get_boolean('debug-logging'))
                    console.log(`${this.uuid}: FRAME ${JSON.stringify({id:window.get_id(), style:reveal ? 'reveal' : 'morph', elapsed,
                        curve, end, drawn, mutter:rect(window.get_frame_rect()), sized, ready, fadeFrom,
                        sinceDamage:Math.round((now-lastDamage)/1000), cover:cover.opacity, fadeMs, followUp,
                        sinceSized:sizedAt === null ? null : Math.round((now-sizedAt)/1000),
                        scale:[actor.scale_x, actor.scale_y].map(v => Math.round(v*1000)/1000)})}`);
            }, 'completed', () => finish(), this);
            actor.connectObject('destroy', () => operation.cancel(),
                'damaged', () => {
                    lastDamage = GLib.get_monotonic_time();
                    if (draws.length < 64)
                        draws.push(lastDamage);
                }, timeline);
            window.connectObject?.('unmanaging', () => operation.cancel(), timeline);
            timeline.start();
        });
    }
    // Finish observing the follow-up window after the morph has ended: keep
    // recording draws until MORPH_FOLLOW_WINDOW_MS after the first frame at
    // the final size, then learn. Stops quietly if the window closes.
    // A maximize ends the observation early: the app's redraw for the new
    // state is not a layout follow-up. Then only a follow-up already seen
    // is learned.
    _observeFollowUp(window, actor, sizedAt, draws, from, to) {
        if (sizedAt === null || (from.width === to.width && from.height === to.height))
            return;
        const remaining = Math.ceil((sizedAt + MORPH_FOLLOW_WINDOW_MS*1000 - GLib.get_monotonic_time())/1000);
        if (remaining <= 0) {
            this._learnFollowUp(window, sizedAt, draws, from, to, true);
            return;
        }
        const timeline = new Clutter.Timeline({actor, duration: remaining});
        const stop = () => {
            this._learners.delete(stop);
            if (this._learnerByWindow.get(window) === interrupt)
                this._learnerByWindow.delete(window);
            timeline.disconnectObject(this);
            actor.disconnectObject(timeline);
            window.disconnectObject?.(timeline);
            timeline.stop();
        };
        const interrupt = () => {
            stop();
            this._learnFollowUp(window, sizedAt, draws, from, to, false);
        };
        this._learners.add(stop);
        this._learnerByWindow.set(window, interrupt);
        actor.connectObject('damaged', () => {
            if (draws.length < 64)
                draws.push(GLib.get_monotonic_time());
        }, 'destroy', stop, timeline);
        window.connectObject?.('unmanaging', stop, timeline);
        timeline.connectObject('completed', () => {
            stop();
            this._learnFollowUp(window, sizedAt, draws, from, to, true);
        }, this);
        timeline.start();
    }
    // After a morph: how long after its first frame at the final size did the
    // app keep drawing? Draws within 3 ms form one burst; the latest burst
    // starting within MORPH_FOLLOW_WINDOW_MS is the follow-up. No sample is
    // taken for same-size moves, or when the window ended before a missing
    // follow-up could be ruled out. The estimate is a percentile of recent
    // samples: one slow or missing follow-up barely moves it.
    _learnFollowUp(window, sizedAt, draws, from, to, complete) {
        if (sizedAt === null || (from.width === to.width && from.height === to.height))
            return;
        let follow = null;
        let burst = null;
        for (const at of draws) {
            if (at <= sizedAt+1000)
                continue;
            if (burst === null || at-burst.last > 3000)
                burst = {start: at};
            burst.last = at;
            const delay = (burst.start-sizedAt)/1000;
            if (delay <= MORPH_FOLLOW_WINDOW_MS)
                follow = delay;
        }
        if (follow === null && !complete)
            return;
        follow ??= 0;
        const samples = this._followSamples.get(window) ?? [];
        samples.push(follow);
        if (samples.length > MORPH_FOLLOW_SAMPLES)
            samples.shift();
        this._followSamples.set(window, samples);
        const sorted = [...samples].sort((a, b) => a-b);
        this._followUp.set(window, sorted[Math.min(sorted.length-1,
            Math.floor(MORPH_FOLLOW_PERCENTILE*sorted.length))]);
        this._trace(window, 'follow-up', {sample: Math.round(follow), learned: Math.round(this._followUp.get(window))});
    }
    // The window frame as currently drawn: the actor's own geometry (synced
    // only when the client's new buffer is shown) minus Mutter's current
    // shadow/border margins. Falls back to Mutter's rects before first paint.
    _drawnFrame(window, actor) {
        const frame = window.get_frame_rect();
        const buffer = window.get_buffer_rect();
        if (!(actor.width > 0 && actor.height > 0))
            return {frame: rect(frame), buffer: rect(buffer)};
        const left = frame.x-buffer.x, top = frame.y-buffer.y;
        const right = buffer.x+buffer.width-frame.x-frame.width;
        const bottom = buffer.y+buffer.height-frame.y-frame.height;
        const drawn = {x: actor.x, y: actor.y, width: actor.width, height: actor.height};
        return {buffer: drawn, frame: {x: drawn.x+left, y: drawn.y+top,
            width: drawn.width-left-right, height: drawn.height-top-bottom}};
    }
    // Where a window is drawn while a transform is still easing back to
    // identity (the relax after a hold), or null when it has none.
    _displayedRect(window) {
        const actor = window.get_compositor_private();
        if (!actor || (actor.scale_x === 1 && actor.scale_y === 1 &&
            actor.translation_x === 0 && actor.translation_y === 0))
            return null;
        const {frame, buffer} = this._drawnFrame(window, actor);
        return {
            x: Math.round(buffer.x + actor.translation_x + (frame.x-buffer.x)*actor.scale_x),
            y: Math.round(buffer.y + actor.translation_y + (frame.y-buffer.y)*actor.scale_y),
            width: Math.round(frame.width*actor.scale_x),
            height: Math.round(frame.height*actor.scale_y),
        };
    }
    _sample(map, window, ms) {
        const previous = map.get(window);
        map.set(window, previous === undefined ? ms : previous + LATENCY_WEIGHT*(ms-previous));
    }
    _sampleLatency(window, ms) {
        const mean = this._latency.get(window);
        if (mean !== undefined)
            this._sample(this._latencySpread, window, Math.abs(ms-mean));
        this._sample(this._latency, window, ms);
    }
    // Aim requests at the fast end of the client's measured lag (mean minus
    // twice its typical deviation), so drawn content almost never arrives
    // ahead of the curve and the image stretches continuously, one way.
    // Content ahead is shown unstretched (one-sided rule), which stalls the
    // visible edge: aiming at the mean (version 14) did that on ~10% of
    // frames; aiming further (version 12) also flipped the stretch.
    _lead(window) {
        const mean = this._latency.get(window) ?? DEFAULT_LATENCY_MS;
        const spread = this._latencySpread.get(window) ?? 0;
        return Math.min(MAX_LEAD_MS, Math.max(0, mean - 2*spread));
    }
    // Show the live window unscaled, its drawn frame aligned to `rect` at the
    // anchor (the edge that does not move), cropped to `rect`.
    _showRevealed(window, actor, rect, anchor) {
        const {frame} = this._drawnFrame(window, actor);
        const x = alignOn(frame.width, rect.x, rect.width, anchor.x);
        const y = alignOn(frame.height, rect.y, rect.height, anchor.y);
        actor.set_pivot_point(0, 0);
        actor.scale_x = 1;
        actor.scale_y = 1;
        actor.translation_x = x-frame.x;
        actor.translation_y = y-frame.y;
        // The clip is in the actor's own (untransformed) coordinates.
        actor.set_clip(rect.x-actor.x-actor.translation_x, rect.y-actor.y-actor.translation_y,
            rect.width, rect.height);
        const visual = this._visuals.get(window) ?? {};
        visual.rect = {...rect};
        this._visuals.set(window, visual);
    }
    // Draw the window actor so its current real frame appears at `rect`,
    // within the stretch cap. Remembers what was actually drawn.
    _showAt(window, actor, rect, shape = {}) {
        const drawn = this._drawnFrame(window, actor);
        const t = visualTransform(drawn.frame, drawn.buffer, rect, shape);
        actor.set_pivot_point(0, 0);
        actor.scale_x = t.scale_x;
        actor.scale_y = t.scale_y;
        actor.translation_x = t.translation_x;
        actor.translation_y = t.translation_y;
        const visual = this._visuals.get(window) ?? {};
        visual.rect = {x: Math.round(t.drawn.x), y: Math.round(t.drawn.y),
            width: Math.round(t.drawn.width), height: Math.round(t.drawn.height)};
        this._visuals.set(window, visual);
    }
    // Keep a lagging client visually on target until its frame catches up,
    // or VISUAL_HOLD_MS passes (minimum-size apps never reach it), then relax.
    _hold(window, actor, target, shape) {
        const visual = this._visuals.get(window);
        if (!visual)
            return;
        const hold = new Clutter.Timeline({actor, duration: VISUAL_HOLD_MS});
        const started = GLib.get_monotonic_time();
        // Clutter.Timeline.stop() emits 'stopped', not 'completed': every
        // way out of the hold goes through detach to drop its handlers.
        const detach = () => {
            hold.disconnectObject(this);
            actor.disconnectObject(hold);
            window.disconnectObject?.(hold);
            hold.stop();
            if (visual.stopHold === detach)
                visual.stopHold = null;
        };
        visual.stopHold = detach;
        const end = caughtUp => {
            detach();
            this._trace(window, 'visual-hold', {caughtUp, ms:Math.round((GLib.get_monotonic_time()-started)/1000)});
            this._clearVisual(window, !caughtUp, actor);
        };
        const gone = () => {
            detach();
            this._clearVisual(window, false, actor);
        };
        hold.connectObject('new-frame', () => {
            if (sameFrame(this._drawnFrame(window, actor).frame, target, 1))
                end(true);
            else
                this._showAt(window, actor, target, shape);
        }, 'completed', () => end(false), this);
        actor.connectObject('destroy', gone, hold);
        window.connectObject?.('unmanaging', gone, hold);
        hold.start();
    }
    // `actor` is passed where known: an unmanaged window may no longer
    // report its actor while GNOME's close effect still shows it.
    _clearVisual(window, smooth, actor = window.get_compositor_private()) {
        const visual = this._visuals.get(window);
        if (!visual)
            return;
        this._visuals.delete(window);
        visual.stopHold?.();
        if (!actor)
            return;
        actor.remove_clip?.();
        const identity = {scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0};
        if (smooth) {
            actor.ease({...identity, duration: RELAX_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            actor.remove_all_transitions();
            Object.assign(actor, identity);
        }
    }
    // Native maximize/unmaximize transitions are replaced: GNOME's zoom
    // effect is skipped, and a snapshot covers the frame jump while Mutter
    // leaves the maximized state, then fades out as the animation begins.
    _effects(window, {morph = false} = {}) {
        const actor = window.get_compositor_private();
        let cover = null;
        let hidden = false;
        // Skips requested and not yet used by a size change. GNOME's handler
        // (connected first) uses one per change; when several changes are
        // pending at once, ours re-arms the next. The same skip list also
        // governs close/minimize effects, so skips are disarmed as soon as
        // the native change they cover has been confirmed.
        let pending = 0;
        let handler = null;
        // Snapshot covering a native state change (maximize) and its watch.
        let stateCover = null;
        let stateWatch = null;
        const enabled = () => actor && this._animationDuration() > 0;
        const endState = () => {
            const watch = stateWatch;
            stateWatch = null;
            if (watch) {
                watch.timeline.disconnectObject(this);
                actor.disconnectObject(watch.timeline);
                watch.timeline.stop();
                watch.waiting?.();
            }
            if (stateCover) {
                stateCover.destroy();
                stateCover = null;
                actor.opacity = 255;
            }
        };
        const disarm = () => {
            if (pending > 0)
                Main.wm._skippedActors?.delete(actor);
            pending = 0;
            if (handler !== null)
                global.window_manager.disconnect(handler);
            handler = null;
        };
        // Mutter emits size-change inside the native call, so skips are
        // normally used by the time its wait resolves; one still pending
        // means the change has not arrived yet and stays armed until release.
        const settle = () => {
            if (pending === 0)
                disarm();
        };
        return {
            skip: () => {
                if (!enabled()) return;
                pending++;
                Main.wm.skipNextEffect(actor);
                handler ??= global.window_manager.connect('size-change', (_wm, changed) => {
                    if (changed !== actor || pending === 0)
                        return;
                    pending--;
                    if (pending > 0)
                        Main.wm.skipNextEffect(actor);
                });
            },
            settle,
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
                // An interrupted motion's snapshot starts where it was seen.
                const at = this._visuals.get(window)?.rect ?? this._displayedRect(window) ?? rect;
                cover.set_position(at.x, at.y);
                cover.set_size(at.width, at.height);
                global.window_group.add_child(cover);
                global.window_group.set_child_above_sibling(cover, actor);
                actor.opacity = 0;
                hidden = true;
                // If this placement is interrupted before it animates, the
                // next one starts from where the window was seen.
                const visual = this._visuals.get(window) ?? {};
                visual.rect ??= {...rect};
                this._visuals.set(window, visual);
            },
            // In morph mode the snapshot is the animation's starting image;
            // the morph fades it out itself.
            coversAll: morph,
            snapshot: () => cover,
            coverState: () => {
                // The app's redraw for the new state is not a follow-up.
                this._learnerByWindow.get(window)?.();
                if (!enabled() || stateCover) return;
                let content;
                try {
                    content = actor.paint_to_content(window.get_frame_rect());
                } catch (error) {
                    return;
                }
                const at = this._visuals.get(window)?.rect ?? this._displayedRect(window) ??
                    rect(window.get_frame_rect());
                stateCover = new St.Widget({content});
                stateCover.set_position(at.x, at.y);
                stateCover.set_size(at.width, at.height);
                global.window_group.add_child(stateCover);
                global.window_group.set_child_above_sibling(stateCover, actor);
                actor.opacity = 0;
                // Watch what the app draws from now on. The outcome is
                // recorded as it happens, so it does not matter whether
                // uncoverState is called before or after the time limit.
                const timeline = new Clutter.Timeline({actor, duration: STATE_COVER_MAX_MS});
                const watch = {timeline, lastDamage: GLib.get_monotonic_time(), damages: 0,
                    started: GLib.get_monotonic_time(), expired: false, waiting: null};
                stateWatch = watch;
                const settled = () => watch.damages > 0 &&
                    GLib.get_monotonic_time()-watch.lastDamage >= MORPH_QUIET_MS*1000;
                watch.finish = done => {
                    if (stateWatch !== watch) return;
                    this._trace(window, 'state-cover', {settled: done, damages: watch.damages,
                        ms: Math.round((GLib.get_monotonic_time()-watch.started)/1000)});
                    endState();
                };
                actor.connectObject('damaged', () => {
                    watch.lastDamage = GLib.get_monotonic_time();
                    watch.damages++;
                    if (this._settings.get_boolean('debug-logging')) {
                        const drawn = this._drawnFrame(window, actor);
                        console.log(`${this.uuid}: FRAME ${JSON.stringify({id:window.get_id(), style:'state',
                            ms:Math.round((watch.lastDamage-watch.started)/1000), drawn:drawn.frame,
                            buffer:drawn.buffer, mutter:rect(window.get_frame_rect()),
                            mutterBuffer:rect(window.get_buffer_rect())})}`);
                    }
                }, timeline);
                timeline.connectObject('new-frame', () => {
                    if (watch.waiting && settled())
                        watch.finish(true);
                }, 'completed', () => {
                    watch.expired = true;
                    if (watch.waiting)
                        watch.finish(false);
                }, this);
                timeline.start();
            },
            // Resolves once the app has drawn after the state change and then
            // nothing new for MORPH_QUIET_MS, or once STATE_COVER_MAX_MS has
            // passed, or when the placement ends some other way.
            uncoverState: () => new Promise(resolve => {
                const watch = stateWatch;
                if (!watch) {
                    resolve();
                    return;
                }
                watch.waiting = resolve;
                if (watch.expired)
                    watch.finish(false);
                else if (watch.damages > 0 && GLib.get_monotonic_time()-watch.lastDamage >= MORPH_QUIET_MS*1000)
                    watch.finish(true);
            }),
            dropCover: ms => {
                if (!cover) return;
                const fading = cover;
                cover = null;
                actor.opacity = 255;
                hidden = false;
                if (ms <= 0) {
                    fading.destroy();
                    return;
                }
                fading.ease({opacity: 0, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => fading.destroy()});
            },
            uncover: () => {
                if (!cover || morph) return;
                const fading = cover;
                cover = null;
                actor.opacity = 255;
                hidden = false;
                this._exactUntil.set(window, GLib.get_monotonic_time() + COVER_FADE_MS*1000);
                fading.ease({opacity: 0, duration: COVER_FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => fading.destroy()});
            },
            release: () => {
                endState();
                if (cover) {
                    cover.destroy();
                    cover = null;
                }
                if (actor) {
                    if (hidden)
                        actor.opacity = 255;
                    hidden = false;
                    disarm();
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
            const maybeRect = r => r ? rect(r) : null;
            console.log(`${this.uuid}: TRACE ${JSON.stringify({
                phase, app:window.get_wm_class(), id:window.get_id(),
                monitor:window.get_monitor(), priorMonitor:state?.monitor,
                priorLayout:state?.layout, nativeMaxH:window.maximizedHorizontally,
                nativeMaxV:window.maximizedVertically, canMove:window.allows_move(),
                canResize:window.allows_resize(), isTiled:window.isTiled,
                tiledRect:maybeRect(window.tiledRect), frame:maybeRect(frame), ...extra,
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
        const actor = window.get_compositor_private();
        // Mutter can report maximized windows as non-resizable/non-movable.
        // Twm.tile unmaximizes before checking the underlying capabilities.
        const maximized = window.maximizedHorizontally || window.maximizedVertically;
        if (!maximized && (!window.allows_move() || !window.allows_resize())) {
            this._trace(window, 'rejected-capability', {directions});
            this._clearVisual(window, true);
            // An interrupted placement's intended layout is no longer valid.
            if (this._states.get(window)?.superseded)
                this._states.delete(window);
            return;
        }
        const owner = this._dependency.stateObj._keybindingHandler;
        this._busy.add(window);
        const operation = {owner, cancelled:false,
            cancel() {this.cancelled=true; this.cancelWait?.(); this.cancelAnimation?.(); this.cancelEffects?.();},
            supersede() {if (!this.cancelled) {this.superseded=true; this.cancel();}}};
        this._operations.set(window, operation);
        let intended = null;
        try {
            let state = this._states.get(window);
            // An interrupted placement continues from its intended layout,
            // not from the in-between frame the window is currently showing.
            let superseded = Boolean(state?.superseded);
            if (superseded && !this._monitorExists(state.monitor)) {
                superseded = false;
                state = null;
            }
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
            if (!this._monitorExists(monitor))
                throw Object.assign(new Error('Placement cancelled: monitor removed'), {cancelled: true});
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
            // No animation ran (real frame already on target) but an
            // interrupted motion left a transform: relax it.
            if (this._visuals.has(window) && !this._visuals.get(window).stopHold)
                this._clearVisual(window, true);
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
                this._clearVisual(window, true, actor);
            }
            if (!operation.cancelled && !error.cancelled) throw error;
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
        this._keys = [];
        this._active = false;
        this._bindingOwner = null;
        if (!this._settings)
            return;
        const raw = this._settings.get_string('saved-bindings');
        if (!raw)
            return;
        // Entries that cannot be restored now (schema or key missing) stay
        // saved for a later restore; everything else is restored.
        const remaining = {};
        for (const [schema, keys] of Object.entries(JSON.parse(raw))) {
            const failed = this._restoreSchema(schema, keys);
            if (Object.keys(failed).length)
                remaining[schema] = failed;
        }
        this._settings.set_string('saved-bindings',
            Object.keys(remaining).length ? JSON.stringify(remaining) : '');
    }
    // Put back only keys still holding the value we wrote; a key the user
    // changed meanwhile is theirs. A saved value equal to the default is
    // reset rather than written, so it keeps following the system default.
    // Returns the entries that could not be restored.
    _restoreSchema(schema, keys) {
        const settings = this._schemaSettings(schema);
        if (!settings)
            return keys;
        const failed = {};
        const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
        for (const [key, values] of Object.entries(keys)) {
            try {
                const binding = OWNED[schema]?.[key];
                const ours = binding ? values.filter(v => v !== binding) : values;
                if (!same(settings.get_strv(key), ours))
                    continue;
                const fallback = settings.get_default_value?.(key)?.deepUnpack?.();
                if (Array.isArray(fallback) && same(fallback, values))
                    settings.reset(key);
                else
                    settings.set_strv(key, values);
            } catch (error) {
                console.warn(`${this.uuid}: cannot restore ${schema} ${key}: ${error.message}`);
                failed[key] = values;
            }
        }
        return failed;
    }
    disable() {
        this._enabled = false;
        for (const stop of [...(this._learners ?? [])])
            stop();
        Main.layoutManager.disconnectObject(this);
        this._cancelOperations();
        for (const window of [...(this._visuals?.keys() ?? [])])
            this._clearVisual(window, false);
        for (const source of this._traceTimers ?? [])
            GLib.Source.remove(source);
        this._traceTimers?.clear();
        if (this._watchId)
            GLib.Source.remove(this._watchId);
        this._watchId = null;
        if (this._grabId)
            global.display.disconnect(this._grabId);
        this._grabId = null;
        try {
            this._releaseBindings();
        } finally {
            this._states = new WeakMap();
            this._queued = new WeakMap();
            this._dependency = null;
        }
    }
}

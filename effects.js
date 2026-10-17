// Everything a placement shows besides the window itself: the snapshot the
// animation starts from (which also covers leaving the maximized state), the
// backdrop, GNOME's own size-change effects (skipped), and the snapshot that
// covers entering the maximized state until the app's frame settles.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {rect} from './geometry.js';
import {QUIET_MS} from './handover.js';
import {Scope} from './scope.js';
import {drawnFrame} from './visuals.js';

// Maximizing is covered until the app has drawn its maximized frame and
// gone quiet, or this long at most.
export const STATE_COVER_MAX_MS = 150;

// window: the placed window. animating(): whether animations are on.
// visuals: the Visuals map (where the window is drawn). followUps: the
// FollowUpTracker. trace(window, phase, extra) and log(text) when debugging.
export function createEffects(window, {animating, visuals, followUps, trace, debug}) {
    const actor = window.get_compositor_private();
    let cover = null;
    let backdrop = null;
    let hidden = false;
    // Skips requested and not yet used by a size change. GNOME's handler
    // (connected first) uses one per change; when several changes are pending
    // at once, ours re-arms the next. The same skip list also governs close
    // and minimize effects, so skips are disarmed as soon as the native change
    // they cover has been confirmed.
    let pending = 0;
    let handler = null;
    // Snapshot covering a native state change (maximize) and its watch.
    let stateCover = null;
    let stateWatch = null;
    const enabled = () => actor && animating();
    // Where the window is seen: an interrupted motion's last rectangle, a
    // relax still easing, or `fallback`.
    const seenAt = fallback => visuals.get(window)?.rect ?? visuals.displayedRect(window) ?? fallback;
    const snapshot = at => {
        let content;
        try {
            content = actor.paint_to_content(window.get_frame_rect());
        } catch (error) {
            // No texture yet (e.g. just mapped).
            return null;
        }
        const widget = new St.Widget({content});
        widget.set_position(at.x, at.y);
        widget.set_size(at.width, at.height);
        global.window_group.add_child(widget);
        global.window_group.set_child_above_sibling(widget, actor);
        actor.opacity = 0;
        return widget;
    };
    const endState = () => {
        const watch = stateWatch;
        stateWatch = null;
        if (watch) {
            watch.scope.dispose();
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
    return {
        // Skip GNOME's effect for the next native size change.
        skip() {
            if (!enabled())
                return;
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
        // Mutter emits size-change inside the native call, so skips are
        // normally used by the time its wait resolves; one still pending
        // means the change has not arrived yet and stays armed until release.
        settle() {
            if (pending === 0)
                disarm();
        },
        // The snapshot the animation starts from, taken where the window is
        // seen. The animation (or, if this placement is interrupted before it
        // animates, the next one) starts where it is.
        cover(frame) {
            if (!enabled() || cover)
                return;
            const at = seenAt(frame);
            cover = snapshot(at);
            if (!cover)
                return;
            hidden = true;
            const visual = visuals.get(window) ?? {};
            visual.rect ??= {...at};
            visuals.set(window, visual);
        },
        snapshot: () => cover,
        // A second layer with the snapshot's image, under the window,
        // stretched to fill the outline wherever no crisp image reaches.
        backdrop() {
            if (!cover || backdrop)
                return backdrop;
            backdrop = new St.Widget({content: cover.content});
            global.window_group.add_child(backdrop);
            global.window_group.set_child_below_sibling(backdrop, actor);
            return backdrop;
        },
        dropBackdrop() {
            backdrop?.destroy();
            backdrop = null;
        },
        // Cover entering the maximized state with a snapshot of the landed
        // window, and watch what the app draws from now on. The outcome is
        // recorded as it happens, so it does not matter whether uncoverState
        // is called before or after the time limit.
        coverState() {
            followUps.interrupt(window);
            if (!enabled() || stateCover)
                return;
            stateCover = snapshot(seenAt(rect(window.get_frame_rect())));
            if (!stateCover)
                return;
            const scope = new Scope();
            const timeline = scope.timeline(new Clutter.Timeline({actor, duration: STATE_COVER_MAX_MS}));
            const watch = {scope, lastDamage: GLib.get_monotonic_time(), damages: 0,
                started: GLib.get_monotonic_time(), expired: false, waiting: null};
            stateWatch = watch;
            const settled = () => watch.damages > 0 &&
                GLib.get_monotonic_time()-watch.lastDamage >= QUIET_MS*1000;
            watch.finish = done => {
                if (stateWatch !== watch)
                    return;
                trace(window, 'state-cover', {settled: done, damages: watch.damages,
                    ms: Math.round((GLib.get_monotonic_time()-watch.started)/1000)});
                endState();
            };
            scope.connect(actor, 'damaged', () => {
                watch.lastDamage = GLib.get_monotonic_time();
                watch.damages++;
                if (debug.enabled) {
                    const drawn = drawnFrame(window, actor);
                    debug.frame({id: window.get_id(), style: 'state',
                        ms: Math.round((watch.lastDamage-watch.started)/1000), drawn: drawn.frame,
                        buffer: drawn.buffer, mutter: rect(window.get_frame_rect()),
                        mutterBuffer: rect(window.get_buffer_rect())});
                }
            });
            scope.connect(timeline, 'new-frame', () => {
                if (watch.waiting && settled())
                    watch.finish(true);
            }, 'completed', () => {
                watch.expired = true;
                if (watch.waiting)
                    watch.finish(false);
            });
            timeline.start();
        },
        // Resolves once the app has drawn after the state change and then
        // nothing new for QUIET_MS, or once STATE_COVER_MAX_MS has passed, or
        // when the placement ends some other way.
        uncoverState: () => new Promise(resolve => {
            const watch = stateWatch;
            if (!watch) {
                resolve();
                return;
            }
            watch.waiting = resolve;
            if (watch.expired)
                watch.finish(false);
            else if (watch.damages > 0 && GLib.get_monotonic_time()-watch.lastDamage >= QUIET_MS*1000)
                watch.finish(true);
        }),
        // Hand the snapshot over: fade it out over `ms` (0: remove at once).
        dropCover(ms) {
            if (!cover)
                return;
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
        // Remove everything this placement showed and disarm its skips.
        release() {
            endState();
            backdrop?.destroy();
            backdrop = null;
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

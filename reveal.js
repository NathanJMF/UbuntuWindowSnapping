// The snap animation. The window's outline moves along an eased path on every
// display frame while the app is asked once for its final size. Content is
// never scaled down; everything is cropped to the moving outline and attached
// to its fixed edge (top-left when both edges move); see layers.js.
// Shrinking: the snapshot taken when the placement began sits under the live
// window; at the handover the live window fades in on top at its true size.
// Growing: the motion starts gently; the live window is shown underneath at
// its true size from the start, the snapshot stays on top at its own size and
// fades out at the handover, and a backdrop fills any corner neither reaches.
// The handover waits for the app's final layout (handover.js).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {sameSize, rect, travelDuration, EasedPath} from './geometry.js';
import {Handover} from './handover.js';
import {contentAnchor, snapshotLayout} from './layers.js';
import {Scope} from './scope.js';
import {drawnFrame} from './visuals.js';

// A re-aimed animation glides its end point to the new target over this long
// (eased at both ends), so neither position nor speed jumps.
const REAIM_MS = 40;

function placeWidget(widget, layout) {
    widget.set_position(layout.x, layout.y);
    widget.set_size(layout.width, layout.height);
    widget.set_clip(layout.clip.x, layout.clip.y, layout.clip.width, layout.clip.height);
}

// Mutter's frame, once the app has acknowledged the request, is the size it
// was granted (e.g. widened to a minimum width). Only trusted on the requested
// edges, and only if at least the requested size: a minimum only ever
// enlarges. That rejects a late-drawn floating size after unmaximizing, which
// can look like an answer.
function grantedFrame(window, to) {
    const g = rect(window.get_frame_rect());
    const aligned = (at, size) => Math.abs(g[at]-to[at]) <= 3 ||
        Math.abs(g[at]+g[size]-to[at]-to[size]) <= 3;
    return g.width >= to.width-3 && g.height >= to.height-3 &&
        aligned('x', 'width') && aligned('y', 'height') ? g : null;
}

// Animate `window` from the on-screen rectangle `from` to `to`. apply(rect)
// requests the window's geometry; base is the animation length in ms before
// travel scaling (0: no animation). Resolves when the motion ends; rejects if
// the snap is cancelled. Without a snapshot the window is simply placed.
export function reveal({window, from, to, apply, snap, effects, visuals, followUps, debug, base, repaint}) {
    const actor = window.get_compositor_private();
    const cover = effects.snapshot();
    if (!base || !actor || !cover)
        return Promise.resolve();
    const path = new EasedPath(from, to, travelDuration(base, from, to));
    const anchor = contentAnchor(from, to);
    const growing = path.growing;
    const followUp = followUps.get(window);
    debug.trace(window, 'animate', {from, to, duration: path.duration, followUp: Math.round(followUp),
        client: window.get_client_type() === Meta.WindowClientType.X11 ? 'x11' : 'wayland'});
    visuals.get(window)?.stopHold?.();
    actor.remove_all_transitions();
    actor.remove_clip();
    const startSize = drawnFrame(window, actor).frame;
    // The snapshot's own size, before any scaling.
    const natural = {width: cover.width, height: cover.height};
    let backdrop = null;
    if (growing) {
        global.window_group.set_child_above_sibling(cover, actor);
        backdrop = effects.backdrop();
        actor.opacity = 255;
    } else {
        global.window_group.set_child_below_sibling(cover, actor);
    }
    // One request for the final size; nothing in between.
    apply(to);
    return new Promise((resolve, reject) => {
        const scope = new Scope();
        const timeline = scope.timeline(new Clutter.Timeline({actor, duration: path.duration}));
        const handover = new Handover(path.duration, followUp);
        // When the app last drew anything (the snapshot counts as drawn), and
        // every draw since the animation began.
        let lastDamage = GLib.get_monotonic_time();
        const draws = [];
        let finished = false;
        let unregister = () => {};
        const finish = error => {
            if (finished)
                return;
            finished = true;
            unregister();
            const elapsed = timeline.get_elapsed_time();
            scope.dispose();
            repaint(true);
            followUps.observe(window, actor, handover.sizedAt, draws, from, to);
            if (!error) {
                // The live window takes over at its final size; a growing
                // move's unfinished fade completes on its own (a shrinking
                // move's snapshot is underneath and now fully hidden), while
                // the hold keeps the window on target.
                actor.opacity = 255;
                actor.remove_clip();
                visuals.showAt(window, actor, path.end, anchor);
                effects.dropBackdrop();
                effects.dropCover(growing ? handover.remaining(elapsed) : 0);
                visuals.hold(window, actor, path.end, anchor);
            } else if (!snap.superseded) {
                // A superseded motion keeps its transform: the next one starts
                // from what is on screen.
                visuals.clear(window, false, actor);
            }
            error ? reject(error) : resolve();
        };
        unregister = snap.onCancel(() => finish(new Error('Placement cancelled')));
        scope.connect(timeline, 'new-frame', () => {
            const now = GLib.get_monotonic_time();
            repaint(false);
            const elapsed = timeline.get_elapsed_time();
            const drawn = drawnFrame(window, actor).frame;
            // Re-aim at the size the app really takes, once it has drawn a new
            // size that Mutter confirms. Mutter's frame alone cannot tell "not
            // answered yet" from "answered with the old size", so an app that
            // never visibly resizes is not re-aimed.
            if (!handover.started && !sameSize(drawn, path.end) && !sameSize(drawn, startSize)) {
                const g = grantedFrame(window, to);
                if (g && sameSize(drawn, g) && !sameSize(g, path.end)) {
                    const was = path.retarget(elapsed, g, REAIM_MS);
                    handover.resetSized();
                    debug.trace(window, 'reaim', {why: 'drawn', elapsed, from: was, to: g});
                }
            }
            const outline = path.at(elapsed);
            if (growing) {
                placeWidget(cover, snapshotLayout(outline, natural, anchor, false));
                if (backdrop)
                    placeWidget(backdrop, snapshotLayout(outline, natural, anchor, true));
            } else {
                placeWidget(cover, snapshotLayout(outline, natural, anchor, true));
            }
            const fade = handover.update({elapsed, now, sized: sameSize(drawn, path.end), lastDamage});
            if (growing) {
                // Live window underneath at its true size throughout; the
                // snapshot on top fades out from the handover.
                visuals.showRevealed(window, actor, outline, anchor);
                if (fade !== null)
                    cover.opacity = Math.round(255*(1-fade));
            } else if (fade !== null) {
                // The live window fades in on top, unscaled and cropped; the
                // snapshot underneath stays until the motion ends.
                actor.opacity = Math.round(255*fade);
                visuals.showRevealed(window, actor, outline, anchor);
            } else {
                // Still covered: remember what is on screen for interruptions.
                const visual = visuals.get(window) ?? {};
                visual.rect = outline;
                visuals.set(window, visual);
            }
            if (debug.enabled) {
                debug.frame({id: window.get_id(), elapsed,
                    curve: outline, end: path.end, drawn, mutter: rect(window.get_frame_rect()),
                    sized: handover.sizedAt !== null, ready: handover.ready, fadeFrom: handover.fadeFrom,
                    fadeMs: handover.fadeMs, sinceDamage: Math.round((now-lastDamage)/1000), cover: cover.opacity,
                    followUp, sinceSized: handover.sizedAt === null ? null : Math.round((now-handover.sizedAt)/1000),
                    growing, anchor, cost: GLib.get_monotonic_time()-now,
                    scale: [actor.scale_x, actor.scale_y].map(v => Math.round(v*1000)/1000)});
            }
        }, 'completed', () => finish());
        scope.connect(actor, 'destroy', () => snap.cancel(),
            'damaged', () => {
                lastDamage = GLib.get_monotonic_time();
                if (draws.length < 64)
                    draws.push(lastDamage);
            });
        scope.connect(window, 'unmanaging', () => snap.cancel());
        timeline.start();
    });
}

// What each window actor currently shows: the transform and clip applied by
// an animation, and the hold that keeps a lagging window on target after it.
// A Map from window to {rect, stopHold}: rect is the on-screen rectangle the
// actor is drawn at; stopHold ends a running hold.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {sameFrame, rect, visualTransform, zoomFor} from './geometry.js';
import {revealedWindowLayout} from './layers.js';
import {Scope} from './scope.js';

// After the motion, a lagging client is held on target this long while it
// finishes resizing, then its transform relaxes over RELAX_MS.
export const VISUAL_HOLD_MS = 150;
export const RELAX_MS = 80;

// The window frame as currently drawn: the actor's own geometry (synced only
// when the client's new buffer is shown) minus Mutter's current shadow and
// border margins. Falls back to Mutter's rects before the first paint.
export function drawnFrame(window, actor) {
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

export class Visuals extends Map {
    // trace(window, phase, extra): debug trace.
    constructor(trace) {
        super();
        this._trace = trace;
    }

    _remember(window, rectangle) {
        const visual = this.get(window) ?? {};
        visual.rect = rectangle;
        this.set(window, visual);
    }

    // Where a window is drawn while a transform is still easing back to
    // identity (the relax after a hold), or null when it has none.
    displayedRect(window) {
        const actor = window.get_compositor_private();
        if (!actor || (actor.scale_x === 1 && actor.scale_y === 1 &&
            actor.translation_x === 0 && actor.translation_y === 0))
            return null;
        const {frame, buffer} = drawnFrame(window, actor);
        return {
            x: Math.round(buffer.x + actor.translation_x + (frame.x-buffer.x)*actor.scale_x),
            y: Math.round(buffer.y + actor.translation_y + (frame.y-buffer.y)*actor.scale_y),
            width: Math.round(frame.width*actor.scale_x),
            height: Math.round(frame.height*actor.scale_y),
        };
    }

    // Show the live window unscaled, its drawn frame aligned to `outline` at
    // the anchor, cropped to `outline`. `frame` is the drawn frame if the
    // caller has just read it (saves Mutter calls on every animation frame).
    showRevealed(window, actor, outline, anchor, frame = drawnFrame(window, actor).frame) {
        const layout = revealedWindowLayout(frame, {x: actor.x, y: actor.y}, outline, anchor);
        actor.set_pivot_point(0, 0);
        actor.scale_x = 1;
        actor.scale_y = 1;
        actor.translation_x = layout.translationX;
        actor.translation_y = layout.translationY;
        actor.set_clip(layout.clip.x, layout.clip.y, layout.clip.width, layout.clip.height);
        this._remember(window, {...outline});
    }

    // Draw the window so its current real frame appears exactly at `target`
    // (scaled if the app has not reached it yet).
    showAt(window, actor, target, anchor) {
        const drawn = drawnFrame(window, actor);
        const t = visualTransform(drawn.frame, drawn.buffer, target, anchor);
        actor.set_pivot_point(0, 0);
        actor.scale_x = t.scale_x;
        actor.scale_y = t.scale_y;
        actor.translation_x = t.translation_x;
        actor.translation_y = t.translation_y;
        this._remember(window, {x: Math.round(t.drawn.x), y: Math.round(t.drawn.y),
            width: Math.round(t.drawn.width), height: Math.round(t.drawn.height)});
    }

    // Keep a lagging client on target until its frame catches up, or
    // VISUAL_HOLD_MS passes (minimum-size apps never reach it), then relax.
    hold(window, actor, target, anchor) {
        const visual = this.get(window);
        if (!visual)
            return;
        const scope = new Scope();
        const timeline = scope.timeline(new Clutter.Timeline({actor, duration: VISUAL_HOLD_MS}));
        const started = GLib.get_monotonic_time();
        // Every way out of the hold goes through detach.
        const detach = () => {
            scope.dispose();
            if (visual.stopHold === detach)
                visual.stopHold = null;
        };
        visual.stopHold = detach;
        const end = caughtUp => {
            detach();
            this._trace(window, 'visual-hold', {caughtUp, ms: Math.round((GLib.get_monotonic_time()-started)/1000)});
            this.reset(window, !caughtUp, actor);
        };
        const gone = () => {
            detach();
            this.reset(window, false, actor);
        };
        scope.connect(timeline, 'new-frame', () => {
            if (sameFrame(drawnFrame(window, actor).frame, target, 1))
                end(true);
            else
                this.showAt(window, actor, target, anchor);
        }, 'completed', () => end(false));
        scope.connect(actor, 'destroy', gone);
        scope.connect(window, 'unmanaging', gone);
        timeline.start();
    }

    // Draw the window evenly scaled so its width fills `outline`. Shorter
    // than the outline until the app has drawn the height asked of it, but
    // never squished.
    showZoomed(window, actor, outline, {frame} = drawnFrame(window, actor)) {
        const scale = outline.width/frame.width;
        actor.remove_clip();
        this.showAt(window, actor, {...outline, height: frame.height*scale}, {x: 0, y: 0});
        this.get(window).rect = {...outline};
    }

    // Keep a window that will not fit `slot` evenly scaled into it, asking
    // for the frame that fills the slot at that scale. Ends like a hold: a
    // new motion stops it, anything else resets the window. Returns whether
    // the window is zoomed.
    zoom(window, actor, slot) {
        const zoom = zoomFor(rect(window.get_frame_rect()), slot);
        if (!zoom)
            return false;
        const visual = this.get(window) ?? {};
        visual.stopHold?.();
        this.set(window, visual);
        const scope = new Scope();
        const detach = () => {
            scope.dispose();
            if (visual.stopHold === detach)
                visual.stopHold = null;
            visual.zoomed = false;
        };
        visual.stopHold = detach;
        visual.zoomed = true;
        const show = () => {
            if (window.maximizedHorizontally || window.maximizedVertically || window.fullscreen) {
                this.reset(window, false, actor);
                return;
            }
            this.showZoomed(window, actor, slot);
        };
        scope.connect(window, 'size-changed', show, 'position-changed', show);
        // Mutter's frame changes before the app's new image is shown.
        scope.connect(actor, 'notify::width', show, 'notify::height', show);
        scope.connect(window, 'unmanaging', () => this.reset(window, false, actor));
        scope.connect(actor, 'destroy', () => this.reset(window, false, actor));
        window.move_resize_frame(true, slot.x, slot.y, zoom.width, zoom.height);
        show();
        this._trace(window, 'zoom', {slot, scale: zoom.scale, asked: {width: zoom.width, height: zoom.height}});
        return true;
    }

    // Drop the window's visual state and return its actor to normal,
    // smoothly or at once (reset, not clear: Map.clear empties the map).
    // `actor` is passed where known: an unmanaged window may no longer
    // report its actor while GNOME's close effect still shows it.
    reset(window, smooth, actor = window.get_compositor_private()) {
        const visual = this.get(window);
        if (!visual)
            return;
        this.delete(window);
        visual.stopHold?.();
        if (!actor)
            return;
        actor.remove_clip();
        const identity = {scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0};
        if (smooth) {
            actor.ease({...identity, duration: RELAX_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        } else {
            actor.remove_all_transitions();
            Object.assign(actor, identity);
        }
    }

    resetAll() {
        for (const window of [...this.keys()])
            this.reset(window, false);
    }
}

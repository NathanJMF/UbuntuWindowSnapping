// Explicit placement sequence: native Wayland requests are asynchronous.
export function sameFrame(a, b, tolerance = 3) {
    return Boolean(a && b) && ['x','y','width','height'].every(k => Math.abs(a[k]-b[k]) <= tolerance);
}
export function frameCopy(r) {
    return {x:r.x, y:r.y, width:r.width, height:r.height};
}
function centeredIn(frame, area) {
    const cx = frame.x + frame.width/2, cy = frame.y + frame.height/2;
    return cx >= area.x && cx < area.x+area.width && cy >= area.y && cy < area.y+area.height;
}
// Eased intermediate frame between two rectangles (t from 0 to 1).
export function interpolateRect(from, to, t) {
    const at = k => Math.round(from[k] + (to[k]-from[k]) * t);
    return {x:at('x'), y:at('y'), width:at('width'), height:at('height')};
}
// Animation curve (ease-out cubic). Evaluated directly, not by the timeline,
// so the same curve can be sampled ahead of the current time.
export function easeOutCubic(t) {
    const x = Math.min(1, Math.max(0, t));
    return 1 - (1-x)**3;
}
// Per axis, which point of the window stays put: 0 = start edge, 1 = end
// edge, 0.5 = centre (both edges move, e.g. across monitors).
export function anchorFor(from, to) {
    const axis = (start, size) => {
        if (from[start] === to[start]) return 0;
        if (from[start]+from[size] === to[start]+to[size]) return 1;
        return 0.5;
    };
    return {x: axis('x', 'width'), y: axis('y', 'height')};
}
// Actor transform that shows a window whose real frame is `frame` (inside
// its buffer rect, where the actor sits) at the on-screen rectangle
// `visual`. Scaling pivots at the actor origin, as in GNOME's own effects.
// maxStretch limits scaling to 1 +/- maxStretch (0 = move only; null =
// unlimited); the anchor point then lands exactly on the visual's.
// Returns the transform and the rectangle actually drawn.
export function visualTransform(frame, buffer, visual, {maxStretch = null, anchor = {x:0, y:0}} = {}) {
    const axis = (start, size, a) => {
        let scale = frame[size] > 0 ? visual[size] / frame[size] : 1;
        if (maxStretch !== null)
            scale = Math.min(1+maxStretch, Math.max(1-maxStretch, scale));
        const target = visual[start] + a*visual[size];
        const local = frame[start] - buffer[start] + a*frame[size];
        const translation = target - buffer[start] - local*scale;
        const drawnSize = frame[size]*scale;
        return {scale, translation, drawn: target - a*drawnSize, drawnSize};
    };
    const x = axis('x', 'width', anchor.x);
    const y = axis('y', 'height', anchor.y);
    return {
        scale_x: x.scale, scale_y: y.scale, translation_x: x.translation, translation_y: y.translation,
        drawn: {x: x.drawn, y: y.drawn, width: x.drawnSize, height: y.drawnSize},
    };
}
// Longer moves take a little longer: the largest edge travel, relative to
// 1000 px, scales the base length by its square root within [0.75, 1.35].
export function travelDuration(base, from, to) {
    const travel = Math.max(Math.abs(from.x-to.x), Math.abs(from.y-to.y),
        Math.abs(from.x+from.width-to.x-to.width), Math.abs(from.y+from.height-to.y-to.height));
    return Math.round(base * Math.min(1.35, Math.max(0.75, Math.sqrt(travel/1000))));
}
// animate(from, to, apply) drives real frame changes so the client redraws
// at every intermediate size. effects hides native maximize transitions.
export async function placeWindow(window, target, monitor, {waitFor, both, constrain, clearConstraints,
    acceptedFrame = null, previousPlacement = null, animate = null, effects = null}) {
    const full = sameFrame(target, window.get_work_area_for_monitor(monitor), 0);
    // acceptedFrame must come from a prior confirmed placement of this same
    // target; it cannot be inferred from an arbitrary oversized current frame.
    if (acceptedFrame && window.get_monitor() === monitor &&
        sameFrame(window.get_frame_rect(), acceptedFrame) &&
        (full ? window.maximizedHorizontally && window.maximizedVertically
              : !window.maximizedHorizontally && !window.maximizedVertically))
        return {frame:frameCopy(window.get_frame_rect()), full};
    try {
        return await placeStages(window, target, monitor, full,
            {waitFor, both, constrain, clearConstraints, previousPlacement, animate, effects});
    } finally {
        effects?.release();
    }
}
async function placeStages(window, target, monitor, full, {waitFor, both, constrain, clearConstraints,
    previousPlacement, animate, effects}) {
    // Where the window visibly is now; the animation starts here even if
    // unmaximizing restores an older floating frame underneath the cover.
    const start = frameCopy(window.get_frame_rect());
    if (window.fullscreen || window.maximizedHorizontally || window.maximizedVertically) {
        effects?.cover(start);
        effects?.skip();
    }
    if (window.fullscreen)
        window.unmake_fullscreen();
    window.unminimize();
    if (window.maximizedHorizontally || window.maximizedVertically) {
        if (window.get_maximized)
            window.unmaximize(window.get_maximized());
        else if (window.unmaximize.length === 0)
            window.unmaximize();
        else
            window.unmaximize(both);
    }
    await waitFor(() => !window.maximizedHorizontally && !window.maximizedVertically && !window.fullscreen, 'unmaximize');
    if (!window.allows_move() || !window.allows_resize())
        throw new Error('Window cannot move or resize after unmaximizing');
    const before = frameCopy(window.get_frame_rect());
    // Old monitor-edge constraints can keep a window attached to its source.
    // Absolute geometry must be sent before waiting for destination identity:
    // some compositors assign the monitor only when that geometry commits.
    clearConstraints?.(window);
    let animated = false;
    // Reuse a size only when this window already confirmed it for the same
    // requested dimensions on the same monitor. This supports opposite-side
    // movement of minimum-size apps without guessing whether a resize landed.
    const knownSize = !full && previousPlacement?.monitor === monitor &&
        sameFrame(before, previousPlacement.frame) &&
        target.width === previousPlacement.target.width &&
        target.height === previousPlacement.target.height;
    const appliedTarget = knownSize
        ? {...target, width:before.width, height:before.height} : target;
    effects?.uncover();
    if (animate && !sameFrame(start, appliedTarget, 0)) {
        await animate(start, appliedTarget, rect =>
            window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height));
        animated = true;
    }
    // After an animated crossing the frame already sits on the destination;
    // a late move_to_monitor would briefly re-place it relative to the source.
    if (window.get_monitor() !== monitor && !(animated && centeredIn(window.get_frame_rect(),
        window.get_work_area_for_monitor(monitor))))
        window.move_to_monitor(monitor);
    if (window.get_monitor() !== monitor || !sameFrame(window.get_frame_rect(), appliedTarget)) {
        window.move_frame(true, appliedTarget.x, appliedTarget.y);
        window.move_resize_frame(true, appliedTarget.x, appliedTarget.y, appliedTarget.width, appliedTarget.height);
    }
    let previous = null;
    let stable = 0;
    // Exact targets, or a changed and stable constrained frame, confirm a resize.
    // Keep intended halves separate from an app's accepted minimum dimensions.
    await waitFor(() => {
        const frame = window.get_frame_rect();
        const onMonitor = window.get_monitor() === monitor;
        if (onMonitor && sameFrame(frame, appliedTarget))
            return true;
        const positioned = (Math.abs(frame.x-target.x) <= 3 || Math.abs(frame.x+frame.width-target.x-target.width) <= 3) &&
            (Math.abs(frame.y-target.y) <= 3 || Math.abs(frame.y+frame.height-target.y-target.height) <= 3);
        const constrained = frame.width >= target.width-3 && frame.height >= target.height-3;
        stable = previous && sameFrame(previous, frame, 0) ? stable+1 : 0;
        previous = frameCopy(frame);
        const sizeChanged = Math.abs(frame.width-before.width) > 3 || Math.abs(frame.height-before.height) > 3;
        // Checks run about every 16 ms; eight stable samples keep the
        // original ~125 ms guard for minimum-size clients.
        return onMonitor && positioned && constrained && sizeChanged && stable >= 8;
    }, 'monitor-and-frame');
    constrain?.(window, target, monitor);
    if (full) {
        // Never issue maximize while a move_to_monitor is still pending.
        // The frame already fills the work area, so skip GNOME's zoom effect.
        effects?.skip();
        if (window.maximize.length === 0)
            window.maximize();
        else
            window.maximize(both);
        await waitFor(() => window.get_monitor() === monitor &&
            window.maximizedHorizontally && window.maximizedVertically &&
            sameFrame(window.get_frame_rect(), target), 'maximize');
    }
    return {frame: frameCopy(window.get_frame_rect()), full};
}

// Explicit placement sequence: native Wayland requests are asynchronous.
export function sameFrame(a, b, tolerance = 3) {
    return Boolean(a && b) && ['x','y','width','height'].every(k => Math.abs(a[k]-b[k]) <= tolerance);
}
export function frameCopy(r) {
    return {x:r.x, y:r.y, width:r.width, height:r.height};
}
export async function placeWindow(window, target, monitor, {waitFor, both, constrain, acceptedFrame = null, previousPlacement = null}) {
    const full = sameFrame(target, window.get_work_area_for_monitor(monitor), 0);
    // acceptedFrame must come from a prior confirmed placement of this same
    // target; it cannot be inferred from an arbitrary oversized current frame.
    if (acceptedFrame && window.get_monitor() === monitor &&
        sameFrame(window.get_frame_rect(), acceptedFrame) &&
        (full ? window.maximizedHorizontally && window.maximizedVertically
              : !window.maximizedHorizontally && !window.maximizedVertically))
        return {frame:frameCopy(window.get_frame_rect()), full};
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
    await waitFor(() => !window.maximizedHorizontally && !window.maximizedVertically && !window.fullscreen);
    if (!window.allows_move() || !window.allows_resize())
        throw new Error('Window cannot move or resize after unmaximizing');
    if (window.get_monitor() !== monitor) {
        window.move_to_monitor(monitor);
        await waitFor(() => window.get_monitor() === monitor);
    }
    constrain?.(window, target, monitor);
    const before = frameCopy(window.get_frame_rect());
    // Reuse a size only when this window already confirmed it for the same
    // requested dimensions on the same monitor. This supports opposite-side
    // movement of minimum-size apps without guessing whether a resize landed.
    const knownSize = !full && previousPlacement?.monitor === monitor &&
        sameFrame(before, previousPlacement.frame) &&
        target.width === previousPlacement.target.width &&
        target.height === previousPlacement.target.height;
    const appliedTarget = knownSize
        ? {...target, width:before.width, height:before.height} : target;
    if (!sameFrame(before, appliedTarget)) {
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
        return onMonitor && positioned && constrained && sizeChanged && stable >= 5;
    });
    if (full) {
        // Never issue maximize while a move_to_monitor is still pending.
        if (window.maximize.length === 0)
            window.maximize();
        else
            window.maximize(both);
        await waitFor(() => window.get_monitor() === monitor &&
            window.maximizedHorizontally && window.maximizedVertically &&
            sameFrame(window.get_frame_rect(), target));
    }
    return {frame: frameCopy(window.get_frame_rect()), full};
}

// One placement: unmaximize, animate, set and confirm the final geometry,
// maximize. Native Wayland requests are asynchronous, so each stage waits
// for Mutter to confirm the previous one.
import {sameFrame, rect as frameCopy} from './geometry.js';

function centeredIn(frame, area) {
    const cx = frame.x + frame.width/2, cy = frame.y + frame.height/2;
    return cx >= area.x && cx < area.x+area.width && cy >= area.y && cy < area.y+area.height;
}
// animate(from, to, apply) runs the animation; apply requests a frame.
// effects: snapshot, native-effect skips and the maximize cover.
// monitorExists(index) guards every call that takes a monitor index: Mutter
// aborts on an index that no longer exists (monitor unplugged mid-placement).
export async function placeWindow(window, target, monitor, {waitFor, both, constrain, clearConstraints,
    previousPlacement = null, animate = null, effects = null, monitorExists = null}) {
    const checkMonitor = () => {
        if (monitorExists && !monitorExists(monitor))
            throw Object.assign(new Error('Placement cancelled: monitor removed'), {cancelled: true});
    };
    checkMonitor();
    const full = sameFrame(target, window.get_work_area_for_monitor(monitor), 0);
    try {
        return await placeStages(window, target, monitor, full,
            {waitFor, both, constrain, clearConstraints, previousPlacement, animate, effects, checkMonitor});
    } finally {
        effects?.release();
    }
}
async function placeStages(window, target, monitor, full, {waitFor, both, constrain, clearConstraints,
    previousPlacement, animate, effects, checkMonitor}) {
    // Where the window visibly is now; the animation starts here even if
    // unmaximizing restores an older floating frame underneath the cover.
    const start = frameCopy(window.get_frame_rect());
    // The snapshot is the animation's starting image; it also covers the
    // frame jump while a window leaves the maximized state.
    effects?.cover(start);
    // Each native state change gets its own effect skip, armed only around
    // the call and its wait, so close/minimize effects are not swallowed.
    if (window.fullscreen) {
        effects?.skip();
        window.unmake_fullscreen();
    }
    window.unminimize();
    if (window.maximizedHorizontally || window.maximizedVertically) {
        effects?.skip();
        if (window.get_maximized)
            window.unmaximize(window.get_maximized());
        else if (window.unmaximize.length === 0)
            window.unmaximize();
        else
            window.unmaximize(both);
    }
    await waitFor(() => !window.maximizedHorizontally && !window.maximizedVertically && !window.fullscreen, 'unmaximize');
    effects?.settle?.();
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
    if (animate && !sameFrame(start, appliedTarget, 0)) {
        await animate(start, appliedTarget, rect =>
            window.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height));
        animated = true;
    }
    // After an animated crossing the frame already sits on the destination;
    // a late move_to_monitor would briefly re-place it relative to the source.
    checkMonitor();
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
    checkMonitor();
    constrain?.(window, target, monitor);
    if (full) {
        // Never issue maximize while a move_to_monitor is still pending.
        // The frame already fills the work area, so skip GNOME's zoom effect.
        // Apps may draw one frame laid out for the unmaximized margins when
        // the state flips; a snapshot of the landed window covers that until
        // the app's maximized frame has settled.
        effects?.coverState?.();
        effects?.skip();
        if (window.maximize.length === 0)
            window.maximize();
        else
            window.maximize(both);
        await waitFor(() => window.get_monitor() === monitor &&
            window.maximizedHorizontally && window.maximizedVertically &&
            sameFrame(window.get_frame_rect(), target), 'maximize');
        await effects?.uncoverState?.();
    }
    return {frame: frameCopy(window.get_frame_rect()), full};
}

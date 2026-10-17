// Where the animation's layers go for a given outline. Pure.
//
// Content is never scaled down: everything is cropped to the outline and
// aligned on its anchor (the edge that stays put; top-left when both edges
// move). Layers, bottom to top:
// - shrinking: the snapshot (at least the outline's size), then the live
//   window fading in on top at its true size;
// - growing: a backdrop (the snapshot stretched to fill the outline, seen
//   only where neither crisp image reaches), the live window at its true
//   size, then the snapshot at its own size fading out.
import {alignOn, anchorFor} from './geometry.js';

// Anchor for the animation: the fixed edge, or top-left when both move.
export function contentAnchor(from, to) {
    const fixed = anchorFor(from, to);
    return {x: fixed.x === 0.5 ? 0 : fixed.x, y: fixed.y === 0.5 ? 0 : fixed.y};
}

// A snapshot of size `natural` placed for `outline`: fill stretches it up
// (never down) to cover the outline. Returns its rectangle and its clip in
// its own coordinates.
export function snapshotLayout(outline, natural, anchor, fill) {
    const width = fill ? Math.max(natural.width, outline.width) : natural.width;
    const height = fill ? Math.max(natural.height, outline.height) : natural.height;
    const x = alignOn(width, outline.x, outline.width, anchor.x);
    const y = alignOn(height, outline.y, outline.height, anchor.y);
    return {x, y, width, height,
        clip: {x: outline.x-x, y: outline.y-y, width: outline.width, height: outline.height}};
}

// The live window unscaled: frame is its drawn frame and actorAt the actor's
// own (untransformed) position, both in stage coordinates. Returns the
// actor's translation and its clip in its own coordinates.
export function revealedWindowLayout(frame, actorAt, outline, anchor) {
    const translationX = alignOn(frame.width, outline.x, outline.width, anchor.x)-frame.x;
    const translationY = alignOn(frame.height, outline.y, outline.height, anchor.y)-frame.y;
    return {translationX, translationY,
        clip: {x: outline.x-actorAt.x-translationX, y: outline.y-actorAt.y-translationY,
            width: outline.width, height: outline.height}};
}

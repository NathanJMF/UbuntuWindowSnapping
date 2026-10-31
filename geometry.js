// Pure geometry: rectangles, easing, alignment and the animation path.
// Rectangles are plain {x, y, width, height} objects in stage coordinates.

export function rect(r) {
    return {x: r.x, y: r.y, width: r.width, height: r.height};
}

export function sameFrame(a, b, tolerance = 3) {
    return Boolean(a && b) && ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k]-b[k]) <= tolerance);
}

export function sameSize(a, b, tolerance = 3) {
    return Math.abs(a.width-b.width) <= tolerance && Math.abs(a.height-b.height) <= tolerance;
}

// Rectangle between two rectangles (t from 0 to 1), rounded to pixels.
export function interpolateRect(from, to, t) {
    const at = k => Math.round(from[k] + (to[k]-from[k]) * t);
    return {x: at('x'), y: at('y'), width: at('width'), height: at('height')};
}

export function easeOutCubic(t) {
    const x = Math.min(1, Math.max(0, t));
    return 1 - (1-x)**3;
}

// Gentle start: little happens in the first frames.
export function easeInOutCubic(t) {
    const x = Math.min(1, Math.max(0, t));
    return x < 0.5 ? 4*x**3 : 1 - (-2*x+2)**3/2;
}

export function smoothstep(u) {
    return u <= 0 ? 0 : u >= 1 ? 1 : u*u*(3-2*u);
}

// Per axis, which point of the window stays put: 0 = start edge, 1 = end
// edge, 0.5 = centre (both edges move, e.g. across monitors). 1 px
// tolerance: an interrupted motion starts from a rounded rectangle.
export function anchorFor(from, to) {
    const axis = (start, size) => {
        if (Math.abs(from[start]-to[start]) <= 1)
            return 0;
        if (Math.abs(from[start]+from[size]-to[start]-to[size]) <= 1)
            return 1;
        return 0.5;
    };
    return {x: axis('x', 'width'), y: axis('y', 'height')};
}

// Start position of something `size` long whose anchor point (0 start edge,
// 1 end edge, 0.5 centre) lines up with that point of the span.
export function alignOn(size, start, span, anchor) {
    return start + anchor*span - anchor*size;
}

// Actor transform that shows a window whose real frame is `frame` (inside
// its buffer rect, where the actor sits) exactly at the on-screen rectangle
// `visual`, with the anchor point fixed. Scaling pivots at the actor origin,
// as in GNOME's own effects. Returns the transform and the rectangle drawn.
export function visualTransform(frame, buffer, visual, anchor = {x: 0, y: 0}) {
    const axis = (start, size, a) => {
        const scale = frame[size] > 0 ? visual[size] / frame[size] : 1;
        const target = visual[start] + a*visual[size];
        const local = frame[start] - buffer[start] + a*frame[size];
        const drawnSize = frame[size]*scale;
        return {scale, translation: target - buffer[start] - local*scale, drawn: target - a*drawnSize, drawnSize};
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

// The animated outline: from `from` to an end point over `duration` ms. Each
// direction eases on its own (a growing one starts gently, a shrinking one
// settles quickly). retarget() glides the end point to a new target over up
// to `ms` (smoothstep, finishing before the motion does), so neither the
// position nor the speed of the outline jumps.
export class EasedPath {
    constructor(from, to, duration) {
        this.from = from;
        this.end = to;
        this.duration = duration;
        this.growX = to.width > from.width+3;
        this.growY = to.height > from.height+3;
        this.easeX = this.growX ? easeInOutCubic : easeOutCubic;
        this.easeY = this.growY ? easeInOutCubic : easeOutCubic;
        this._glide = null;
    }

    get growing() {
        return this.growX || this.growY;
    }

    endAt(elapsed) {
        const glide = this._glide;
        return glide ? interpolateRect(glide.from, this.end, smoothstep((elapsed-glide.at)/glide.ms)) : this.end;
    }

    at(elapsed) {
        const target = this.endAt(elapsed);
        const t = elapsed/this.duration;
        const ex = this.easeX(t), ey = this.easeY(t);
        const from = this.from;
        return {
            x: Math.round(from.x+(target.x-from.x)*ex), width: Math.round(from.width+(target.width-from.width)*ex),
            y: Math.round(from.y+(target.y-from.y)*ey), height: Math.round(from.height+(target.height-from.height)*ey),
        };
    }

    // Returns the end point the glide starts from.
    retarget(elapsed, target, ms) {
        const current = this.endAt(elapsed);
        this._glide = {from: current, at: elapsed, ms: Math.max(1, Math.min(ms, this.duration-elapsed))};
        this.end = target;
        return current;
    }
}

// Below this an app is too small to use; it keeps its real size instead.
export const MIN_ZOOM = 0.5;

// An app that stays larger than its slot (its own minimum size) is shown
// evenly scaled to fit. Returns the scale and the frame to ask for, so that
// at that scale it fills the slot both ways; null when it fits or would be
// too small.
export function zoomFor(frame, slot) {
    const scale = Math.min(slot.width/frame.width, slot.height/frame.height);
    if (frame.width-slot.width <= 3 && frame.height-slot.height <= 3)
        return null;
    if (scale < MIN_ZOOM)
        return null;
    return {scale, width: Math.round(slot.width/scale), height: Math.round(slot.height/scale)};
}

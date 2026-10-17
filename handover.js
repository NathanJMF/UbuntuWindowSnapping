// When the live window takes over from the snapshot. Pure: fed the frame
// time, whether the app has drawn the final size, and when it last drew.

// Hand over once the app has drawn the final size and then nothing new for
// QUIET_MS. Chromium-based apps often present their first frame at a new
// size with the old layout and re-lay out a frame or two later.
export const QUIET_MS = 24;
// A window known to draw a follow-up frame with the corrected layout
// (learned delay of at least FOLLOW_MIN_MS; Claude desktop about 45 ms) is
// handed over only after that delay, capped at FOLLOW_CAP_MS, plus
// FOLLOW_QUIET_MS without drawing.
export const FOLLOW_MIN_MS = 10;
export const FOLLOW_CAP_MS = 60;
export const FOLLOW_QUIET_MS = 8;
// Without a confirmed final layout the handover starts at this fraction of
// the motion anyway (minimum-size and very slow apps); later for windows
// with a learned follow-up.
export const READY_LIMIT = 0.6;
export const FOLLOW_READY_LIMIT = 0.75;
// The crossfade lasts up to FADE_MS but always ends by FADE_END of the
// motion, and is never shorter than MIN_FADE_MS, so the snapshot never
// lingers over a window that has landed.
export const FADE_MS = 70;
export const MIN_FADE_MS = 16;
export const FADE_END = 0.9;

export class Handover {
    // duration: motion length (ms); followUp: the window's learned delay (ms).
    constructor(duration, followUp = 0) {
        this.duration = duration;
        this.follows = followUp >= FOLLOW_MIN_MS;
        this.followWait = Math.min(followUp, FOLLOW_CAP_MS);
        this.readyLimit = this.follows ? FOLLOW_READY_LIMIT : READY_LIMIT;
        // Monotonic time (us) of the draw that first showed the final size.
        this.sizedAt = null;
        // Elapsed time (ms) when the fade began, and its length.
        this.fadeFrom = null;
        this.fadeMs = FADE_MS;
        this.ready = false;
    }

    get started() {
        return this.fadeFrom !== null;
    }

    // The target changed (re-aim): wait for the new final size.
    resetSized() {
        this.sizedAt = null;
    }

    // One animation frame. elapsed: ms into the motion; now and lastDamage:
    // monotonic us; sized: the app has drawn the final size. Returns the
    // fade's progress (0..1), or null before the handover.
    update({elapsed, now, sized, lastDamage}) {
        if (sized && this.sizedAt === null)
            this.sizedAt = lastDamage;
        this.ready = sized && (this.follows
            ? now-this.sizedAt >= (this.followWait+FOLLOW_QUIET_MS)*1000 &&
              now-lastDamage >= FOLLOW_QUIET_MS*1000
            : now-lastDamage >= QUIET_MS*1000);
        if (this.fadeFrom === null && (this.ready || elapsed >= this.readyLimit*this.duration)) {
            this.fadeFrom = elapsed;
            this.fadeMs = Math.max(MIN_FADE_MS, Math.min(FADE_MS, FADE_END*this.duration-elapsed));
        }
        return this.progress(elapsed);
    }

    progress(elapsed) {
        return this.fadeFrom === null ? null : Math.min(1, (elapsed-this.fadeFrom)/this.fadeMs);
    }

    // Fade time left after the motion has ended at `elapsed`.
    remaining(elapsed) {
        return this.fadeFrom === null ? MIN_FADE_MS : Math.max(0, this.fadeMs-(elapsed-this.fadeFrom));
    }
}

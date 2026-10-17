// Learning a window's follow-up frame: how long after its first frame at a
// new size does the app draw again (with the corrected layout)? Pure.

// Draws up to FOLLOW_WINDOW_MS after the first frame at the final size count.
export const FOLLOW_WINDOW_MS = 80;
// The learned delay is the FOLLOW_PERCENTILE of the last FOLLOW_SAMPLES
// samples (a snap without a follow-up counts as 0), so one slow or missing
// follow-up barely moves it.
export const FOLLOW_SAMPLES = 12;
export const FOLLOW_PERCENTILE = 0.75;

// sizedAt: monotonic time (us) of the first draw at the final size; draws:
// monotonic times of every draw seen. Draws within 3 ms form one burst; the
// latest burst starting within FOLLOW_WINDOW_MS is the follow-up. Returns
// its delay in ms, 0 when the whole window was observed without one, or
// null when observation stopped early without one (nothing to learn).
export function followUpDelay(sizedAt, draws, complete) {
    let follow = null;
    let burst = null;
    for (const at of draws) {
        if (at <= sizedAt+1000)
            continue;
        if (burst === null || at-burst.last > 3000)
            burst = {start: at};
        burst.last = at;
        const delay = (burst.start-sizedAt)/1000;
        if (delay <= FOLLOW_WINDOW_MS)
            follow = delay;
    }
    if (follow === null && !complete)
        return null;
    return follow ?? 0;
}

// Add a sample to `samples` (kept to the last FOLLOW_SAMPLES) and return the
// learned delay.
export function learnFollowUp(samples, delay) {
    samples.push(delay);
    if (samples.length > FOLLOW_SAMPLES)
        samples.shift();
    const sorted = [...samples].sort((a, b) => a-b);
    return sorted[Math.min(sorted.length-1, Math.floor(FOLLOW_PERCENTILE*sorted.length))];
}

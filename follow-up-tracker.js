// Per-window follow-up learning (see follow-up.js for the rules): keeps each
// window's learned delay, and keeps watching a window's draws after its
// animation has ended until the observation window closes.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import {FOLLOW_WINDOW_MS, followUpDelay, learnFollowUp} from './follow-up.js';
import {Scope} from './scope.js';

export class FollowUpTracker {
    // trace(window, phase, extra): debug trace.
    constructor(trace) {
        this._trace = trace;
        // Window -> learned delay (ms), and the samples it comes from.
        this.learned = new WeakMap();
        this.samples = new WeakMap();
        // Observations still running: their stop functions, and by window
        // the function that ends one early (before a maximize).
        this._running = new Set();
        this._interrupts = new WeakMap();
    }

    get(window) {
        return this.learned.get(window) ?? 0;
    }

    // After an animation: record draws until FOLLOW_WINDOW_MS after the first
    // frame at the final size (sizedAt, monotonic us), then learn. Stops
    // quietly if the window closes.
    observe(window, actor, sizedAt, draws, from, to) {
        if (sizedAt === null || (from.width === to.width && from.height === to.height))
            return;
        const remaining = Math.ceil((sizedAt + FOLLOW_WINDOW_MS*1000 - GLib.get_monotonic_time())/1000);
        if (remaining <= 0) {
            this.learn(window, sizedAt, draws, from, to, true);
            return;
        }
        const scope = new Scope();
        const timeline = scope.timeline(new Clutter.Timeline({actor, duration: remaining}));
        const stop = () => {
            this._running.delete(stop);
            if (this._interrupts.get(window) === interrupt)
                this._interrupts.delete(window);
            scope.dispose();
        };
        const interrupt = () => {
            stop();
            this.learn(window, sizedAt, draws, from, to, false);
        };
        this._running.add(stop);
        this._interrupts.set(window, interrupt);
        scope.connect(actor, 'damaged', () => {
            if (draws.length < 64)
                draws.push(GLib.get_monotonic_time());
        }, 'destroy', stop);
        scope.connect(window, 'unmanaging', stop);
        scope.connect(timeline, 'completed', () => {
            stop();
            this.learn(window, sizedAt, draws, from, to, true);
        });
        timeline.start();
    }

    // A maximize is about to make the app redraw for its new state, which is
    // not a layout follow-up: end the observation, learning only a follow-up
    // already seen.
    interrupt(window) {
        this._interrupts.get(window)?.();
    }

    learn(window, sizedAt, draws, from, to, complete) {
        if (sizedAt === null || (from.width === to.width && from.height === to.height))
            return;
        const delay = followUpDelay(sizedAt, draws, complete);
        if (delay === null)
            return;
        const samples = this.samples.get(window) ?? [];
        this.samples.set(window, samples);
        this.learned.set(window, learnFollowUp(samples, delay));
        this._trace(window, 'follow-up', {sample: Math.round(delay), learned: Math.round(this.learned.get(window))});
    }

    stopAll() {
        for (const stop of [...this._running])
            stop();
    }
}

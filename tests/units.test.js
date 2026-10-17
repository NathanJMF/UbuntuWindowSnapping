// Unit tests for the pure modules: the handover decision, follow-up
// learning, layer layout and the animation path.
import {Handover, QUIET_MS, FOLLOW_CAP_MS, FOLLOW_QUIET_MS, FADE_MS, MIN_FADE_MS} from '../handover.js';
import {followUpDelay, learnFollowUp, FOLLOW_SAMPLES} from '../follow-up.js';
import {contentAnchor, snapshotLayout, revealedWindowLayout} from '../layers.js';
import {EasedPath, sameSize} from '../geometry.js';
import {Scope, Snap} from '../scope.js';
import {Debug} from '../trace.js';

let count = 0;
function assert(value, message) {
    count++;
    if (!value)
        throw new Error(message);
}
const ms = n => n*1000;

// Run a handover frame by frame (every 2 ms) until it starts; return the
// elapsed time it started at. sizedAt/drawsAt: ms into the motion.
function startOf(handover, {sizedAt = null, drawsAt = []} = {}) {
    for (let elapsed = 0; elapsed <= handover.duration; elapsed += 2) {
        const now = ms(elapsed);
        const sized = sizedAt !== null && elapsed >= sizedAt;
        const last = Math.max(0, ...[sizedAt ?? 0, ...drawsAt].filter(t => t <= elapsed));
        const fade = handover.update({elapsed, now, sized, lastDamage: ms(last)});
        if (fade !== null)
            return elapsed;
    }
    return null;
}

// --- Handover
{
    // No follow-up: drawn at 20 ms, quiet for 24 ms -> 44 ms.
    const h = new Handover(100);
    assert(startOf(h, {sizedAt: 20}) === 20+QUIET_MS, 'hands over once drawn and quiet');
    assert(h.fadeMs === Math.min(FADE_MS, 0.9*100-44), 'fade ends by 90% of the motion');
    assert(h.progress(44) === 0 && h.progress(44+h.fadeMs) === 1, 'progress runs 0 to 1 over the fade');
}
{
    // A redraw at 30 ms restarts the quiet period.
    const h = new Handover(200);
    assert(startOf(h, {sizedAt: 20, drawsAt: [30]}) === 30+QUIET_MS, 'a later draw delays the handover');
}
{
    // Never drawn: falls back at 60%.
    const h = new Handover(100);
    assert(startOf(h) === 60, 'falls back at 60% of the motion');
    assert(h.fadeMs === Math.max(MIN_FADE_MS, Math.min(FADE_MS, 90-60)), 'late fade is shortened, not below the minimum');
    assert(h.remaining(80) === h.fadeMs-20, 'remaining fade after the motion');
    assert(new Handover(100).remaining(100) === MIN_FADE_MS, 'no handover yet: a minimum fade remains');
}
{
    // Learned follow-up of 45 ms: wait 45 + 8 after the first draw (frames
    // every 2 ms, so the first draw is at 21 ms to land on a frame).
    const h = new Handover(200, 45);
    assert(startOf(h, {sizedAt: 21, drawsAt: [66]}) === 21+45+FOLLOW_QUIET_MS, 'waits for the learned follow-up');
    assert(new Handover(100, 45).readyLimit === 0.75, 'follow-up windows fall back at 75%');
    assert(startOf(new Handover(100, 45)) === 76, 'follow-up fallback at 75% (first 2 ms frame past it)');
}
{
    // A 70 ms follow-up is capped at 60.
    const h = new Handover(300, 70);
    assert(startOf(h, {sizedAt: 20}) === 20+FOLLOW_CAP_MS+FOLLOW_QUIET_MS, 'learned wait capped');
    assert(new Handover(100, 5).follows === false, 'a tiny follow-up is not a follow-up');
}
{
    // Re-aim: the size must be drawn again.
    const h = new Handover(200);
    h.update({elapsed: 10, now: ms(10), sized: true, lastDamage: ms(10)});
    h.resetSized();
    assert(h.sizedAt === null, 'reset waits for the new final size');
    h.update({elapsed: 30, now: ms(30), sized: true, lastDamage: ms(30)});
    assert(h.sizedAt === ms(30), 'new first draw recorded');
}

// --- Follow-up learning
{
    const at = t => ms(t);
    assert(followUpDelay(at(0), [at(0.5), at(43), at(44), at(45)], true) === 43, 'burst start after the first frame');
    assert(followUpDelay(at(0), [at(20), at(50)], true) === 50, 'the latest burst within the window');
    assert(followUpDelay(at(0), [at(90)], true) === 0, 'a draw after the window is not a follow-up');
    assert(followUpDelay(at(0), [], true) === 0, 'a full window without draws: no follow-up');
    assert(followUpDelay(at(0), [], false) === null, 'stopped early without draws: nothing learned');
    const samples = [];
    for (const d of [44, 43, 45, 44, 42, 46])
        learnFollowUp(samples, d);
    assert(learnFollowUp(samples, 0) >= 44, 'one missing follow-up barely moves the estimate');
    assert(learnFollowUp(samples, 76) <= 46, 'one slow follow-up does not drag it up');
    for (let i = 0; i < 20; i++)
        learnFollowUp(samples, 10);
    assert(samples.length === FOLLOW_SAMPLES && learnFollowUp(samples, 10) === 10, 'only recent samples count');
}

// --- Layers
{
    const half = {x: 0, y: 0, width: 500, height: 800}, full = {x: 0, y: 0, width: 1000, height: 800};
    assert(JSON.stringify(contentAnchor(half, full)) === '{"x":0,"y":0}', 'left edge fixed: left anchor');
    assert(contentAnchor({x: 500, y: 0, width: 500, height: 800}, full).x === 1, 'right edge fixed: right anchor');
    assert(contentAnchor(half, {x: 1500, y: 0, width: 500, height: 800}).x === 0, 'both edges move: top-left');

    const outline = {x: 100, y: 0, width: 700, height: 800};
    const crop = snapshotLayout(outline, {width: 1000, height: 800}, {x: 0, y: 0}, true);
    assert(crop.width === 1000 && crop.x === 100 && crop.clip.width === 700 && crop.clip.x === 0,
        'larger snapshot: own size, cropped to the outline');
    const right = snapshotLayout(outline, {width: 1000, height: 800}, {x: 1, y: 0}, true);
    assert(right.x+right.width === 800 && right.clip.x === 300, 'right anchor: right edges aligned');
    const stretched = snapshotLayout(outline, {width: 500, height: 800}, {x: 0, y: 0}, true);
    assert(stretched.width === 700, 'fill stretches a smaller snapshot up to the outline');
    const crisp = snapshotLayout(outline, {width: 500, height: 800}, {x: 0, y: 0}, false);
    assert(crisp.width === 500 && crisp.clip.width === 700, 'without fill a smaller snapshot keeps its size');

    // Live window drawn at x=1000 (20 px shadow margin), shown at an outline
    // starting at x=600: translated -400, clip in the actor's coordinates.
    const live = revealedWindowLayout({x: 1000, y: 50, width: 900, height: 700}, {x: 980, y: 30},
        {x: 600, y: 50, width: 500, height: 700}, {x: 0, y: 0});
    assert(live.translationX === -400 && live.translationY === 0, 'aligned to the outline top-left');
    assert(live.clip.x === 600-980+400 && live.clip.width === 500, 'clipped to the outline');
}

// --- Path
{
    const from = {x: 0, y: 0, width: 200, height: 1000}, to = {x: 500, y: 0, width: 500, height: 800};
    const path = new EasedPath(from, to, 100);
    assert(path.growX && !path.growY && path.growing, 'mixed move: width grows, height shrinks');
    const early = path.at(25);
    const widthDone = (early.width-200)/300, heightDone = (1000-early.height)/200;
    assert(heightDone > widthDone+0.2, 'shrinking direction settles faster');
    assert(sameSize(path.at(100), to, 0) && path.at(100).x === 500, 'ends exactly on target');
    // Re-aim mid-way: no jump in position.
    const before = path.at(40);
    path.retarget(40, {x: 500, y: 0, width: 700, height: 800}, 40);
    const after = path.at(40);
    assert(before.x === after.x && before.width === after.width, 're-aim keeps the current position');
    assert(path.at(100).width === 700, 'and arrives at the new target');
}

// --- Lifetimes
{
    const order = [];
    const scope = new Scope();
    scope.add(() => order.push('first'));
    scope.add(() => order.push('second'));
    const timeline = {stopped: 0, stop() {this.stopped++;}, connectObject(...args) {this.tracker = args.at(-1);},
        disconnectObject(tracker) {if (tracker === this.tracker) this.tracker = null;}};
    scope.timeline(timeline, 'new-frame', () => {});
    scope.dispose();
    scope.dispose();
    assert(order.join() === 'second,first', 'released newest first');
    assert(timeline.stopped === 1 && timeline.tracker === null, 'timeline stopped and disconnected, once');
    let late = false;
    scope.add(() => {late = true;});
    assert(late, 'registering on a disposed scope releases at once');
}
{
    const order = [];
    const snap = new Snap({});
    snap.onCancel(() => order.push('effects'));
    const unregister = snap.onCancel(() => order.push('wait'));
    snap.onCancel(() => order.push('animation'));
    unregister();
    snap.supersede();
    snap.cancel();
    assert(snap.cancelled && snap.superseded, 'superseding cancels');
    assert(order.join() === 'animation,effects', 'hooks run once, newest first, unregistered ones skipped');
    let immediate = false;
    snap.onCancel(() => {immediate = true;});
    assert(immediate, 'a hook registered after cancelling runs at once');
    const cancelled = new Snap({});
    cancelled.cancel();
    cancelled.supersede();
    assert(!cancelled.superseded, 'an already cancelled snap is not marked superseded');
}

// --- Debug flag: cached, follows the setting, stops listening on dispose
{
    const settings = {value: false, handler: null,
        get_boolean() {return this.value;},
        connectObject(signal, handler) {if (signal === 'changed::debug-logging') this.handler = handler;},
        disconnectObject() {this.handler = null;}};
    const debug = new Debug(settings, 'test', () => null);
    assert(debug.enabled === false, 'starts from the setting');
    settings.value = true;
    assert(debug.enabled === false, 'cached between changes');
    settings.handler();
    assert(debug.enabled === true, 'follows a change of the setting');
    debug.dispose();
    assert(settings.handler === null, 'stops listening when disposed');
}

print(`PASS: ${count} unit assertions`);

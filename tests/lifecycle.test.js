// Timing-sensitive regressions with step-driven mocks: timelines advance one
// frame per step and stop() emits 'stopped' (not 'completed'), signal
// connections are tracked so leaks show, waits honour cancellation, clients
// draw requested sizes after a fixed latency, and a GNOME-like size-change
// handler counts native effects. The shipped 3% stretch cap is used.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {anchorFor} from '../placement.js';
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const text = new TextDecoder().decode(GLib.file_get_contents(`${root}/extension.js`)[1]);
const setup = `
export const mock = {widgets:[], later:[], missingKeys:new Set(), missingSchemas:new Set(), lateUnmaximize:0, halfEase:false, lateSizeChange:false, monitors:2, invalidMonitorCalls:[], clock:0, ints:{'animation-duration':120,'max-stretch':3,'morph-fade':70}, timelines:[], focus:null,
 neighbor:-1, bindings:new Map(), values:new Map(), defaults:new Map(), resets:[], handler:{}, grab:null,
 timers:new Map(), pending:[], nativeEffects:0, skippedEffects:0};
export function signals(o) {
 o._h = [];
 o.connectObject = function (...args) {
  const tracker = args.pop();
  for (let i = 0; i+1 < args.length; i += 2) this._h.push({sig:args[i], fn:args[i+1], tracker});
 };
 o.disconnectObject = function (tracker) {this._h = this._h.filter(h => h.tracker !== tracker);};
 o.connect = function (sig, fn) {const id = Symbol(sig); this._h.push({sig, fn, tracker:id}); return id;};
 o.disconnect = function (id) {this._h = this._h.filter(h => h.tracker !== id);};
 o.emit = function (sig, ...args) {for (const h of [...this._h]) if (h.sig === sig) h.fn(this, ...args);};
 return o;
}
class Settings {
 constructor({schema_id}={}) {
  if (mock.missingSchemas.has(schema_id)) throw new Error(\`GSettings schema \${schema_id} not found\`);
  this.schema = schema_id ?? 'custom';
 }
 get_strv(k) {
  if (mock.missingKeys.has(this.schema+':'+k)) throw new Error(\`GSettings key \${k} not found\`);
  return mock.values.get(this.schema+':'+k) ?? mock.defaults.get(this.schema+':'+k) ?? [];
 }
 set_strv(k, v) {mock.values.set(this.schema+':'+k, v);}
 get_default_value(k) {const d = mock.defaults.get(this.schema+':'+k); return d ? {deepUnpack:() => [...d]} : null;}
 reset(k) {mock.values.delete(this.schema+':'+k); mock.resets.push(this.schema+':'+k);}
 get_boolean() {return false;}
 get_int(k) {return mock.ints[k] ?? 0;}
 get_string(k) {return mock.values.get(this.schema+':'+k) ?? '';}
 set_string(k, v) {mock.values.set(this.schema+':'+k, v);}
}
const Gio = {Settings};
const GLib = {PRIORITY_DEFAULT:0, SOURCE_CONTINUE:true, SOURCE_REMOVE:false, get_monotonic_time:() => mock.clock,
 timeout_add:(p, ms, cb) => {const id = mock.timers.size+100; mock.timers.set(id, cb); return id;},
 Source:{remove:id => mock.timers.delete(id)}};
class Extension {getSettings() {return new Settings();}}
const Meta = {WindowClientType:{WAYLAND:0, X11:1}, DisplayDirection:{LEFT:0, RIGHT:1, UP:2, DOWN:3},
 KeyBindingFlags:{IGNORE_AUTOREPEAT:1}, MaximizeFlags:{BOTH:3}};
const Shell = {ActionMode:{NORMAL:1}};
const St = {Settings:{get:() => ({enable_animations:true, slow_down_factor:1})},
 // Snapshot widgets record where they were drawn and whether they are gone.
 Widget:class {
  constructor() {this.opacity = 255; this.destroyed = false; this.moves = []; mock.widgets.push(this);}
  set_position(x, y) {this.x = x; this.y = y;}
  set_size(width, height) {this.width = width; this.height = height; this.moves.push({x:this.x, y:this.y, width, height});}
  ease(p) {if ('opacity' in p) this.opacity = p.opacity; p.onStopped?.();}
  destroy() {this.destroyed = true; this.opacityAtDestroy = this.opacity;}
 }};
class Timeline {
 constructor({duration}) {signals(this); this.duration = duration; this.elapsed = 0; mock.timelines.push(this);}
 get_elapsed_time() {return this.elapsed;}
 start() {this.running = true;}
 stop() {if (this.stopped) return; this.stopped = true; this.emit('stopped');}
 tick(ms) {
  if (!this.running || this.stopped) return;
  this.elapsed = Math.min(this.duration, this.elapsed+ms);
  this.emit('new-frame');
  if (this.elapsed >= this.duration && !this.stopped) {this.stopped = true; this.emit('completed');}
 }
}
const Clutter = {Timeline, AnimationMode:{EASE_OUT_QUAD:2}};
const Main = {layoutManager:signals({}), extensionManager:{lookup:() => ({stateObj:{_twm:Twm, _keybindingHandler:mock.handler,
  settings:{getGioObject:() => ({})}}})},
 wm:{_skippedActors:new Set(), skipNextEffect(a) {this._skippedActors.add(a);},
  addKeybinding:k => mock.bindings.set(k, 1), removeKeybinding:k => mock.bindings.delete(k)}};
class Rect {constructor(r) {Object.assign(this, r);}}
const Twm = {clearTilingProps() {}, updateTileGroup() {}, saveTileState() {},
 isMaximized:w => w.maximizedHorizontally && w.maximizedVertically};
globalThis.global = {window_manager:signals({}), window_group:{add_child() {}, set_child_above_sibling() {}},
 display:{get focus_window() {return mock.focus;}, get_monitor_neighbor_index:() => mock.neighbor,
  get_n_monitors:() => mock.monitors,
  connect:(n, cb) => {mock.grab = cb; return 1;}, disconnect() {}}};
mock.skipped = Main.wm._skippedActors;
export const layout = Main.layoutManager;
// GNOME Shell's own handler is connected first and consumes skips.
global.window_manager.connect('size-change', (_wm, actor) => {
 if (Main.wm._skippedActors.delete(actor)) mock.skippedEffects++;
 else mock.nativeEffects++;
});
`;
const folder = GLib.dir_make_tmp('keyboard-snap-lifecycle-XXXXXX');
const path = `${folder}/lifecycle.js`;
const local = text.match(/^import [^;]* from '\.\/[^']*';$/gm).map(line =>
    line.replace(/'\.\/(.*)'/, (_m, f) => `'${Gio.File.new_for_path(`${root}/${f}`).get_uri()}'`)).join('\n');
GLib.file_set_contents(path, local + '\n' + setup + text.replace(/^import [^;]*;\n/gm, ''));
let count = 0;
function assert(v, msg) {count++; if (!v) throw new Error(msg);}
try {
const {default:Ext, mock, signals, layout} = await import(Gio.File.new_for_path(path).get_uri());
const AREAS = [{x:0, y:0, width:1000, height:800}, {x:1000, y:0, width:1000, height:800}];
// A client that draws each requested size `lag` ms after the request.
function makeWindow({frame = {x:100, y:100, width:600, height:400}, lag = 40, maximized = false, fullscreen = false} = {}) {
    const w = signals({maximizedHorizontally:maximized, maximizedVertically:maximized, fullscreen,
        frame:{...frame}, drawn:{...frame}, queue:[], requests:[], unmanaged:false, resizable:true});
    w.actor = signals({opacity:255, scale_x:1, scale_y:1, translation_x:0, translation_y:0,
        set_pivot_point() {}, remove_all_transitions() {}, paint_to_content:() => ({}),
        ease(p) {
            const keys = ['scale_x','scale_y','translation_x','translation_y'].filter(k => k in p);
            if (mock.halfEase) {for (const k of keys) this[k] = (this[k]+p[k])/2; return;}
            for (const k of keys) this[k] = p[k];
            p.onStopped?.();
        }});
    for (const k of ['x','y','width','height'])
        Object.defineProperty(w.actor, k, {get:() => w.drawn[k]});
    // Mutter emits size-change inside the native call; mock.lateSizeChange
    // delivers it on a later step instead.
    const sizeChange = () => {
        const emit = () => global.window_manager.emit('size-change', w.actor);
        if (mock.lateSizeChange) mock.later.push(emit); else emit();
    };
    Object.assign(w, {
        get_compositor_private() {return this.unmanaged ? null : this.actor;}, get_id:() => 1,
        get_frame_rect() {return {...this.frame};}, get_buffer_rect() {return {...this.frame};},
        allows_move() {return true;}, allows_resize() {return this.resizable;}, unminimize() {},
        get_monitor() {const cx = this.frame.x+this.frame.width/2; return cx >= 1000 && mock.monitors > 1 ? 1 : 0;},
        // Mutter aborts on an index past the monitor count; record it instead.
        get_work_area_for_monitor:m => {if (m >= mock.monitors) mock.invalidMonitorCalls.push(`work_area(${m})`); return {...AREAS[m]};},
        move_frame() {}, move_to_monitor(m) {if (m >= mock.monitors) mock.invalidMonitorCalls.push(`move_to_monitor(${m})`);},
        unmake_fullscreen() {this.fullscreen = false; sizeChange();},
        unmaximize() {
            // Mutter restores the saved floating frame on unmaximize; with
            // floatingLag the app draws it that much later.
            const apply = () => {
                this.maximizedHorizontally = this.maximizedVertically = false;
                if (!this.floating) return;
                this.frame = {...this.floating};
                if (this.floatingLag) this.queue.push({due:mock.clock + this.floatingLag*1000, r:{...this.floating}});
                else this.drawn = {...this.floating};
            };
            sizeChange();
            // lateUnmaximize: the state change lands that many steps later.
            if (!mock.lateUnmaximize) {apply(); return;}
            let left = mock.lateUnmaximize;
            const tick = () => {if (--left <= 0) apply(); else mock.later.push(tick);};
            mock.later.push(tick);
        },
        maximize() {this.maximizedHorizontally = this.maximizedVertically = true;
            this.frame = this.get_work_area_for_monitor(this.get_monitor()); this.drawn = {...this.frame}; sizeChange();},
        // Wayland: Mutter's frame changes when the client acknowledges a size,
        // which is when it draws it (after its lag). frameOnRequest models
        // X11, where the frame changes at once. Size limits (minWidth) are
        // applied to what the client draws.
        move_resize_frame(u, x, y, width, height) {
            const granted = {x, y, width:Math.max(this.minWidth ?? 0, width), height};
            this.requests.push({x, y, width, height});
            if (this.frameOnRequest) this.frame = {...granted};
            const lag = typeof this.lag === 'function' ? this.lag() : this.lag;
            const due = Math.max(mock.clock + lag*1000, this.queue.at(-1)?.due ?? 0);
            this.queue.push({due, r:granted});
        },
    });
    w.lag = lag;
    return w;
}
const e = new Ext();
e.enable();
// Waits poll on each step and honour cancellation like the real one.
const waitFor = (w, p, op) => new Promise((resolve, reject) => {
    let done = false;
    let stable = 0;
    // The real wait gives up after 2 s; so does this one (simulated clock).
    const deadline = mock.clock + 2000000;
    op.cancelWait = () => {if (!done) {done = true; op.cancelWait = null; reject(new Error('Placement cancelled'));}};
    const poll = () => {
        if (done) return;
        if (op.cancelled) {done = true; reject(new Error('Placement cancelled')); return;}
        if (mock.clock > deadline) {done = true; reject(new Error('Placement timed out')); return;}
        // Like the real wait: true on two consecutive checks.
        if (p()) {
            if (stable++ >= 1) {done = true; op.cancelWait = null; resolve(); return;}
        } else {
            stable = 0;
        }
        mock.later.push(poll);
    };
    poll();
});
e._waitForWindow = waitFor;
const flush = async () => {
    for (let i = 0; i < 30; i++) {
        await Promise.resolve();
        const due = mock.pending.splice(0);
        due.forEach(f => f());
    }
};
let win = null;
const step = async (ms = 4) => {
    mock.clock += ms*1000;
    // Every drawn frame damages the actor. A `relayout` client (Chromium)
    // first shows the old layout at a new size and re-lays out that many ms
    // later; a `video` client redraws on every step.
    while (win && win.queue.length && mock.clock >= win.queue[0].due) {
        const r = win.queue.shift().r;
        const resized = r.width !== win.drawn.width || r.height !== win.drawn.height;
        win.drawn = r;
        win.frame = {...r};
        if (resized && win.relayout) {
            win.content = 'stale';
            win.relayoutAt = mock.clock + win.relayout*1000;
        } else if (resized) {
            win.content = 'laid-out';
        }
        win.actor.emit('damaged');
    }
    if (win?.relayoutAt && mock.clock >= win.relayoutAt) {
        win.relayoutAt = null;
        win.content = 'laid-out';
        win.actor.emit('damaged');
    }
    if (win?.video)
        win.actor.emit('damaged');
    for (const t of [...mock.timelines]) t.tick(ms);
    mock.timelines = mock.timelines.filter(t => !t.stopped);
    mock.later.splice(0).forEach(f => f());
    await flush();
};
const settle = async (ms = 1500) => {for (let t = 0; t < ms; t += 4) await step(4);};
const press = async dir => {
    const p = e._snap(dir).catch(error => {throw new Error(`snap ${dir} failed: ${error.message}`);});
    await flush();
    return p;
};
const clean = (w, label, {busy = true} = {}) => {
    assert(w.actor.scale_x === 1 && w.actor.scale_y === 1 && w.actor.translation_x === 0 && w.actor.translation_y === 0,
        `${label}: actor transform back to identity`);
    assert(!e._visuals.has(w), `${label}: no visual state left`);
    assert(w.actor._h.length === 0, `${label}: no actor signal handlers left`);
    assert(w._h.length === 0, `${label}: no window signal handlers left`);
    if (busy)
        assert(!e._busy.has(w), `${label}: window not busy`);
};
const fresh = opts => {
    const w = makeWindow(opts);
    win = w; mock.focus = w; mock.neighbor = -1;
    e._states.delete(w); e._latency.delete(w); e._redraw.delete(w);
    return w;
};

// 1. A hold stopped by a new motion must detach; previously its handlers
// stayed connected and a later press could leave the window scaled.
{
    const w = fresh();
    const live = () => Boolean(e._visuals.get(w)?.stopHold);
    const up = press('up');
    for (let i = 0; i < 200 && !live(); i++) await step(4);
    assert(live(), 'hold running after Up');
    const left = press('left');
    for (let i = 0; i < 5; i++) await step(4);
    const down = press('down');
    for (let i = 0; i < 200 && !(w.frame.width === 500 && w.frame.height === 800); i++) await step(2);
    const last = press('left');
    await settle();
    w.drawn = {...w.frame};
    await settle(300);
    await Promise.all([up, left, down, last]);
    assert(w.frame.width === 500 && w.frame.height === 800, 'Up, Left, Down, Left ends on the left half');
    clean(w, 'interrupted hold');
}

// 2. Latency matches the client's real 40 ms lag; samples are taken only on
// new drawn sizes, so re-sent targets cannot pull the estimate down.
{
    const w = fresh({frame:{x:0, y:0, width:500, height:800}});
    e._states.set(w, {layout:{x:'left', y:null}, monitor:0, rect:{x:0, y:0, width:500, height:800}, frame:{x:0, y:0, width:500, height:800}});
    const samples = [];
    const real = e._sample.bind(e);
    e._sample = (map, win_, ms) => {if (map === e._latency) samples.push(ms); real(map, win_, ms);};
    for (const dir of ['right', 'right', 'left', 'left', 'right', 'right']) {
        const p = press(dir);
        await settle(600);
        await p;
    }
    e._sample = real;
    assert(samples.length >= 10, 'latency sampled during motions');
    assert(samples.every(ms => ms >= 39 && ms <= 45), `every latency sample near 40 ms (got ${samples.map(Math.round)})`);
    assert(Math.abs(e._lead(w)-40) <= 5, 'look-ahead converges on the real lag');
    clean(w, 'latency');
}

// 2b. A client whose lag jitters (20-60 ms): the look-ahead aims at the
// fast end, so drawn content rarely gets ahead of the curve.
{
    let seed = 7;
    const rand = () => (seed = (seed*1103515245 + 12345) % 2147483648) / 2147483648;
    const w = fresh({frame:{x:0, y:0, width:500, height:800}, lag:() => 20 + 40*rand()});
    e._states.set(w, {layout:{x:'left', y:null}, monitor:0, rect:{x:0, y:0, width:500, height:800}, frame:{x:0, y:0, width:500, height:800}});
    let ahead = 0, frames = 0;
    const real = e._showAt.bind(e);
    e._showAt = (w_, actor, r, shape) => {
        real(w_, actor, r, shape);
        // Growing or shrinking width: content ahead means past the curve.
        if (shape.growth?.x) {
            frames++;
            if (shape.growth.x*(w_.drawn.width - r.width) > 1) ahead++;
        }
    };
    for (const dir of ['right', 'right', 'left', 'left', 'right', 'right', 'left', 'left']) {
        const p = press(dir);
        await settle(600);
        await p;
    }
    e._showAt = real;
    assert(e._latencySpread.get(w) > 3, 'lag variation measured');
    assert(e._lead(w) < e._latency.get(w), 'look-ahead aims below the mean lag');
    assert(frames > 50 && ahead/frames < 0.05, `content ahead of the curve on under 5% of frames (${ahead}/${frames})`);
    clean(w, 'jittery lag');
}

// 3. Same-size moves (crossing between equal monitors) give no samples.
{
    const w = fresh({frame:{x:500, y:0, width:500, height:800}});
    mock.neighbor = 1;
    e._states.set(w, {layout:{x:'right', y:null}, monitor:0, rect:{x:500, y:0, width:500, height:800}, frame:{x:500, y:0, width:500, height:800}});
    e._latency.set(w, 40);
    const samples = [];
    const real = e._sample.bind(e);
    e._sample = (map, win_, ms) => {samples.push(ms); real(map, win_, ms);};
    const p = press('right');
    await settle(600);
    await p;
    e._sample = real;
    assert(w.frame.x === 1000 && w.frame.width === 500, 'right half crosses to the next monitor\'s left half');
    assert(samples.length === 0, 'a same-size crossing records no latency or redraw samples');
    assert(e._latency.get(w) === 40, 'estimate untouched by a pure move');
    clean(w, 'same-size crossing');
}

// 4. Requests never move backwards when the estimate drops mid-motion.
{
    const w = fresh({frame:{x:0, y:0, width:500, height:800}});
    e._states.set(w, {layout:{x:'left', y:null}, monitor:0, rect:{x:0, y:0, width:500, height:800}, frame:{x:0, y:0, width:500, height:800}});
    e._latency.set(w, 80);
    const p = press('right');
    for (let i = 0; i < 6; i++) await step(4);
    e._latency.set(w, 0);
    await settle(600);
    await p;
    const widths = w.requests.map(r => r.width);
    assert(widths.every((v, i) => i === 0 || v >= widths[i-1]), `growing requests stay monotonic after a latency drop (${widths})`);
    clean(w, 'monotonic requests');
}

// 5. Closing mid-motion stops all driving at once, without an error.
{
    const w = fresh();
    const p = press('left');
    for (let i = 0; i < 6; i++) await step(4);
    assert(w.requests.length > 0, 'motion under way');
    w.unmanaged = true;
    w.emit('unmanaging');
    const before = w.requests.length;
    await settle(300);
    let failed = null;
    await p.catch(error => {failed = error;});
    assert(!failed, 'a window closed mid-motion is not reported as an error');
    assert(w.requests.length === before, 'no requests after the window is unmanaged');
    clean(w, 'closed mid-motion');
}

// 6. Closing during the hold detaches it.
{
    const w = fresh();
    const p = press('left');
    for (let i = 0; i < 300 && !e._visuals.get(w)?.stopHold; i++) await step(4);
    assert(e._visuals.get(w)?.stopHold, 'hold running');
    w.unmanaged = true;
    w.emit('unmanaging');
    // The confirmation wait may still be finishing; visuals must be clean now.
    clean(w, 'closed during hold, immediately', {busy:false});
    await settle(300);
    await p;
    clean(w, 'closed during hold');
}

// 7. A maximized fullscreen window: both native changes are skipped, and
// nothing is left armed afterwards.
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true, fullscreen:true});
    mock.nativeEffects = mock.skippedEffects = 0;
    mock.lateSizeChange = true;
    const p = press('left');
    await settle(600);
    await p;
    assert(w.frame.width === 500 && !w.fullscreen, 'fullscreen maximized -> left half');
    assert(mock.nativeEffects === 0, 'no native GNOME size-change effect ran');
    assert(mock.skippedEffects === 2, 'unfullscreen and unmaximize effects both skipped');
    assert(globalThis.global.window_manager._h.length === 1, 'only GNOME\'s own size-change handler remains');
    assert(!mock.skipped.has(w.actor), 'no effect skip left armed after the placement');
    mock.lateSizeChange = false;
    clean(w, 'fullscreen');
}

// 8. Presses in separate ticks interrupt a real wait or animation; the
// window ends where all presses lead, from a single final trip.
{
    const w = fresh();
    const p1 = press('left');
    for (let i = 0; i < 4; i++) await step(4);
    const p2 = press('right');
    await step(4);
    const p3 = press('right');
    await settle(800);
    await Promise.all([p1, p2, p3]);
    assert(w.frame.x === 500 && w.frame.width === 500, 'Left, Right, Right in quick succession ends on the right half');
    clean(w, 'folded presses');
}

// 9. A stale superseded state is dropped when the follow-up cannot run.
{
    const w = fresh();
    e._states.set(w, {layout:{x:'left', y:null}, monitor:0, rect:{x:0, y:0, width:500, height:800}, superseded:true});
    w.resizable = false;
    await e._run(w, ['right']);
    assert(!e._states.has(w), 'superseded state cleared when the window rejects resizing');
}

// 10. The cover fade maps the restored floating frame exactly; the cap
// applies afterwards.
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true});
    const shapes = [];
    const real = e._showAt.bind(e);
    e._showAt = (w_, actor, r, shape) => {shapes.push({at:mock.clock, cap:shape.maxStretch}); real(w_, actor, r, shape);};
    const start = mock.clock;
    const p = press('left');
    await settle(600);
    await p;
    e._showAt = real;
    assert(shapes.some(s => s.cap === null && s.at-start < 120000), 'exact mapping while the cover fades');
    assert(shapes.filter(s => s.at-start > 140000).every(s => s.cap === 0.03), 'shipped 3% cap afterwards');
    clean(w, 'cover fade');
}

// 11. Disable restores only keys still holding what we wrote, and resets
// keys whose saved value is the default.
{
    const wm = 'org.gnome.desktop.wm.keybindings';
    const ta = 'org.gnome.shell.extensions.tiling-assistant';
    const mutter = 'org.gnome.mutter.keybindings';
    e.disable();
    mock.values.clear(); mock.defaults.clear(); mock.resets = [];
    mock.defaults.set(`${wm}:maximize`, ['<Super>Up']);
    mock.defaults.set(`${ta}:tile-left-half`, ['<Super>Left']);
    mock.values.set(`${ta}:tile-left-half`, ['<Super>Left', '<Super>KP_4']);
    mock.defaults.set(`${mutter}:toggle-tiled-left`, ['<Super>Left']);
    const f = new Ext();
    f.enable();
    assert(mock.bindings.size === 4, 'shortcuts taken');
    assert(JSON.stringify(mock.values.get(`${wm}:maximize`)) === '[]', 'native Up removed while enabled');
    mock.values.set(`${mutter}:toggle-tiled-left`, ['<Super>q']);
    f.disable();
    assert(mock.resets.includes(`${wm}:maximize`) && !mock.values.has(`${wm}:maximize`), 'default value restored by reset, not pinned');
    assert(JSON.stringify(mock.values.get(`${ta}:tile-left-half`)) === '["<Super>Left","<Super>KP_4"]', 'customised value written back');
    assert(JSON.stringify(mock.values.get(`${mutter}:toggle-tiled-left`)) === '["<Super>q"]', 'a key the user changed meanwhile is left alone');
    // Later tests use the main instance again.
    mock.values.clear(); mock.defaults.clear();
    e.enable();
    e._waitForWindow = waitFor;
}

// 12. Anchors tolerate the 1 px rounding of an interrupted start.
{
    const a = anchorFor({x:300, y:0, width:701, height:800}, {x:500, y:0, width:500, height:800});
    assert(a.x === 1, 'right edge within 1 px still anchors right');
}
// 13. A monitor removed mid-crossing: GNOME's monitors-changed cancels the
// placement before any call with the stale index (Mutter would abort).
for (const signal of [true, false]) {
    const w = fresh({frame:{x:500, y:0, width:500, height:800}});
    mock.monitors = 2; mock.neighbor = 1; mock.invalidMonitorCalls = [];
    e._states.set(w, {layout:{x:'right', y:null}, monitor:0, rect:{x:500, y:0, width:500, height:800}, frame:{x:500, y:0, width:500, height:800}});
    let failed = null;
    const p = e._snap('right').catch(error => {failed = error;});
    await flush();
    await step(4);
    const idle = makeWindow();
    e._states.set(idle, {layout:{x:'left', y:null}, monitor:1, rect:{x:1000, y:0, width:500, height:800}, frame:{x:1000, y:0, width:500, height:800}});
    mock.monitors = 1;
    if (signal) layout.emit('monitors-changed');
    if (signal) assert(!e._states.has(idle), 'layouts tied to old monitor indices are forgotten');
    // Longer than the 2 s wait timeout, so a stuck placement fails instead of hanging.
    await settle(2500);
    await p;
    const label = signal ? 'with monitors-changed' : 'index guard alone';
    assert(mock.invalidMonitorCalls.length === 0, `${label}: no call with a removed monitor index (${mock.invalidMonitorCalls})`);
    assert(!failed, `${label}: removal treated as cancellation, not an error`);
    clean(w, label);
    mock.monitors = 2;
}

// 14. Taking bindings with a key missing: every available original is saved
// before anything changes, and all of them come back on disable.
{
    const ta = 'org.gnome.shell.extensions.tiling-assistant';
    const wm = 'org.gnome.desktop.wm.keybindings';
    e.disable();
    mock.values.clear(); mock.defaults.clear(); mock.resets = [];
    mock.values.set(`${ta}:tile-left-half`, ['<Super>Left']);
    mock.values.set(`${wm}:maximize`, ['<Super>Up']);
    mock.missingKeys = new Set([`${ta}:restore-window`]);
    const f = new Ext();
    f.enable();
    assert(mock.bindings.size === 4, 'shortcuts taken despite a missing key');
    assert(JSON.stringify(mock.values.get(`${ta}:tile-left-half`)) === '[]', 'available keys taken');
    f.disable();
    assert(JSON.stringify(mock.values.get(`${ta}:tile-left-half`)) === '["<Super>Left"]', 'key before the missing one restored');
    assert(JSON.stringify(mock.values.get(`${wm}:maximize`)) === '["<Super>Up"]', 'key after the missing one restored');
    mock.missingKeys = new Set();
}

// 15. A schema removed while enabled: disable still restores every other
// schema, does not throw, and keeps the unrestorable entries for later.
{
    const ta = 'org.gnome.shell.extensions.tiling-assistant';
    const wm = 'org.gnome.desktop.wm.keybindings';
    mock.values.clear(); mock.defaults.clear();
    mock.values.set(`${ta}:tile-left-half`, ['<Super>Left']);
    mock.values.set(`${wm}:maximize`, ['<Super>Up']);
    const f = new Ext();
    f.enable();
    mock.missingSchemas = new Set([ta]);
    mock.values.set(`${wm}:minimize`, []);
    mock.missingKeys = new Set([`${wm}:minimize`]);
    let threw = null;
    try {f.disable();} catch (error) {threw = error;}
    assert(!threw, 'disable does not throw when a schema has gone');
    assert(JSON.stringify(mock.values.get(`${wm}:maximize`)) === '["<Super>Up"]', 'other schemas restored');
    const kept = JSON.parse(mock.values.get('custom:saved-bindings') || '{}');
    assert(kept[ta]?.['tile-left-half'] && kept[wm]?.minimize && !kept[wm].maximize,
        'only unrestorable entries stay saved (missing schema, failing key)');
    mock.missingSchemas = new Set();
    mock.missingKeys = new Set();
    const g = new Ext();
    g.enable();
    g.disable();
    assert(JSON.stringify(mock.values.get(`${ta}:tile-left-half`)) === '["<Super>Left"]', 'restored once the schema is back');
    assert(!mock.values.get('custom:saved-bindings'), 'nothing left saved');
    e.enable();
    e._waitForWindow = waitFor;
}

// 16. Skips are armed only around native calls: during the animation a
// close or minimize effect would run normally; none is left afterwards.
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true});
    const p = press('left');
    let armedWhileAnimating = 0, animatingFrames = 0;
    for (let i = 0; i < 60; i++) {
        await step(4);
        if (w.requests.length) {animatingFrames++; if (mock.skipped.has(w.actor)) armedWhileAnimating++;}
    }
    await settle(600);
    await p;
    assert(animatingFrames > 5 && armedWhileAnimating === 0, `no skip armed while animating (${armedWhileAnimating}/${animatingFrames})`);
    assert(!mock.skipped.has(w.actor), 'no skip left afterwards');
    clean(w, 'skip window');
}

// 17. A second press while a maximized window is still covered: the window
// is visible again and the next motion starts where it was seen.
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true});
    w.floating = {x:100, y:100, width:600, height:400};
    mock.lateUnmaximize = 2;
    const froms = [];
    const real = e._animate.bind(e);
    e._animate = (w_, from, ...rest) => {froms.push({...from}); return real(w_, from, ...rest);};
    const p1 = press('left');
    assert(w.actor.opacity === 0, 'cover hides the window while it unmaximizes');
    // Step until Mutter has restored the floating frame, then press again
    // while the unmaximize wait is still confirming it.
    for (let i = 0; i < 10 && w.maximizedHorizontally; i++) await step(4);
    assert(!w.maximizedHorizontally && w.frame.width === 600, 'floating frame restored under the cover');
    const p2 = press('down');
    await settle(800);
    await Promise.all([p1, p2]);
    e._animate = real;
    mock.lateUnmaximize = 0;
    assert(w.actor.opacity === 255, 'window visible after an interrupted cover');
    assert(froms.length === 1 && froms[0].x === 0 && froms[0].width === 1000 && froms[0].height === 800,
        `motion starts from the covered rectangle (${JSON.stringify(froms)})`);
    assert(w.frame.width === 500 && w.frame.height === 400 && w.frame.y === 400, 'Left, Down from maximized ends bottom-left');
    clean(w, 'interrupted cover');
}

// 17b. A mouse grab while covered and before the size change arrives: the
// unused skip is disarmed and the window is visible again.
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true});
    mock.lateSizeChange = true;
    mock.lateUnmaximize = 4;
    const p = press('left');
    assert(mock.skipped.has(w.actor) && w.actor.opacity === 0, 'skip armed and window covered');
    mock.grab(null, w);
    await flush();
    await p;
    assert(!mock.skipped.has(w.actor), 'cancelled placement leaves no skip to swallow a close effect');
    assert(w.actor.opacity === 255, 'cancelled placement leaves the window visible');
    await settle(100);
    mock.lateSizeChange = false;
    mock.lateUnmaximize = 0;
    clean(w, 'grab while covered');
}

// 18. A superseded hold's timeline is stopped, not just disconnected.
{
    const w = fresh();
    const p1 = press('up');
    for (let i = 0; i < 200 && !e._visuals.get(w)?.stopHold; i++) await step(4);
    const holds = mock.timelines.filter(t => t.duration === 150);
    assert(holds.length === 1, 'one hold timeline running');
    const p2 = press('left');
    for (let i = 0; i < 3; i++) await step(4);
    assert(holds[0].stopped, 'interrupted hold timeline stopped');
    await settle(800);
    await Promise.all([p1, p2]);
    clean(w, 'stopped hold');
}

// 19. A press during the relax ease starts from where the window is drawn.
{
    const w = fresh({frame:{x:0, y:0, width:500, height:800}, lag:0});
    w.drawn = {...w.frame};
    e._states.set(w, {layout:{x:'left', y:null}, monitor:0, rect:{x:0, y:0, width:500, height:800}, frame:{x:0, y:0, width:500, height:800}});
    e._visuals.set(w, {rect:{x:0, y:0, width:520, height:800}});
    e._hold(w, w.actor, {x:0, y:0, width:500, height:800}, {anchor:{x:0, y:0}, maxStretch:0.06, growth:{x:1, y:0}});
    mock.halfEase = true;
    w.actor.scale_x = 1.04;
    e._clearVisual(w, true, w.actor);
    mock.halfEase = false;
    const displayed = e._displayedRect(w);
    assert(displayed && displayed.width === 510, 'relax half way is drawn 510 px wide');
    const froms = [];
    const real = e._animate.bind(e);
    e._animate = (w_, from, ...rest) => {froms.push({...from}); return real(w_, from, ...rest);};
    const p = press('right');
    await settle(800);
    await p;
    e._animate = real;
    assert(froms[0].width === 510, 'motion starts from the drawn, half-relaxed rectangle');
    clean(w, 'interrupted relax');
}

// 20. Exact mapping from a cover fade is not inherited by the next motion.
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true});
    const caps = [];
    const real = e._showAt.bind(e);
    let second = false;
    e._showAt = (w_, actor, r, shape) => {if (second) caps.push(shape.maxStretch); real(w_, actor, r, shape);};
    const p1 = press('left');
    for (let i = 0; i < 6; i++) await step(4);
    second = true;
    const p2 = press('down');
    await settle(800);
    await Promise.all([p1, p2]);
    e._showAt = real;
    assert(caps.length > 3 && caps.every(c => c === 0.03), 'an interrupting motion uses the 3% cap from its first frame');
    clean(w, 'exact mapping scope');
}
// ---- Morph style ----
const morphStyle = on => mock.values.set('custom:animation-style', on ? 'morph' : 'live');
const halfState = w => e._states.set(w, {layout:{x:'left', y:null}, monitor:0,
    rect:{x:0, y:0, width:500, height:800}, frame:{x:0, y:0, width:500, height:800}});

// 21. Left half -> Right -> full with a 40 ms client: the snapshot follows
// the curve every frame, the app gets one request, and the live window only
// appears once it has drawn the final size.
{
    morphStyle(true);
    const w = fresh({frame:{x:0, y:0, width:500, height:800}});
    halfState(w);
    mock.widgets = [];
    const start = mock.clock;
    const samples = [];
    const p = press('right');
    for (let i = 0; i < 60; i++) {
        await step(4);
        samples.push({at:(mock.clock-start)/1000, opacity:w.actor.opacity, drawnFull:w.drawn.width === 1000});
    }
    await settle(600);
    await p;
    const snap = mock.widgets[0];
    assert(mock.widgets.length === 1, 'one snapshot per placement');
    const widths = snap.moves.map(m => m.width);
    assert(widths.length > 20 && widths.every((v, i) => i === 0 || v >= widths[i-1]), 'snapshot grows along the curve every frame');
    assert(widths.at(-1) === 1000, 'snapshot reaches the target size');
    assert(w.requests.length === 1 && w.requests[0].width === 1000, 'the app receives a single request for its final size');
    assert(samples.filter(s => !s.drawnFull).every(s => s.opacity === 0), 'live window hidden until the app has drawn the final size');
    assert(samples.some(s => s.drawnFull && s.opacity === 255), 'live window shown once drawn');
    assert(snap.destroyed && snap.opacityAtDestroy === 0, 'snapshot faded out, not cut');
    assert(w.maximizedHorizontally && w.maximizedVertically, 'morph to full still maximizes natively');
    clean(w, 'morph');
}

// Watch a morph: when the live window first shows, its content then, the
// snapshot's path, re-aims, and the hold target.
async function watchMorph(w, dir, {stepMs = 4, steps = 80} = {}) {
    mock.widgets = [];
    const result = {shownAt:null, content:null, reaims:[], holds:[], goneAt:null, landedAt:null};
    const realTrace = e._trace.bind(e), realHold = e._hold.bind(e);
    e._trace = (w_, phase, extra) => {if (phase === 'morph-reaim') result.reaims.push(extra); realTrace(w_, phase, extra);};
    // The hold starts on the motion's last frame: that is when it lands.
    e._hold = (w_, actor, target, shape) => {
        result.holds.push({...target});
        result.landedAt ??= (mock.clock-start)/1000;
        realHold(w_, actor, target, shape);
    };
    const start = mock.clock;
    const p = press(dir);
    for (let i = 0; i < steps; i++) {
        await step(stepMs);
        if (result.shownAt === null && w.actor.opacity === 255 && e._visuals.has(w)) {
            result.shownAt = (mock.clock-start)/1000;
            result.content = w.content;
        }
        // When the snapshot first became fully transparent (or was removed).
        const snap = mock.widgets[0];
        if (result.goneAt === null && snap && (snap.opacity === 0 || snap.destroyed))
            result.goneAt = (mock.clock-start)/1000;
    }
    await settle(800);
    await p;
    e._trace = realTrace; e._hold = realHold;
    result.moves = mock.widgets[0]?.moves ?? [];
    return result;
}
const fullState = w => e._states.set(w, {layout:{x:null, y:null}, monitor:0, rect:{...AREAS[0]}, frame:{...AREAS[0]}});
// Largest change in per-frame speed of the snapshot's width: smooth easing
// changes it by a pixel or two, a jump shows as a spike.
const maxJump = moves => {
    const speed = moves.slice(1).map((m, i) => m.width-moves[i].width);
    return Math.max(...speed.slice(1).map((v, i) => Math.abs(v-speed[i])));
};

// 22. A minimum-size app (700 px) asked for 500 px: once it draws 700 px,
// the morph re-aims there smoothly, hands over after the content goes
// quiet, and holds at 700 px, so nothing is squeezed and relaxed afterwards.
{
    const w = fresh({frame:{...AREAS[0]}, lag:20});
    w.minWidth = 700;
    fullState(w);
    const r = await watchMorph(w, 'left', {stepMs:2, steps:120});
    assert(r.reaims.length === 1 && r.reaims[0].why === 'drawn' && r.reaims[0].to.width === 700,
        `re-aimed at the drawn 700 px (${JSON.stringify(r.reaims)})`);
    assert(r.moves.at(-1).width === 700, 'snapshot ends at the granted 700 px');
    assert(maxJump(r.moves) <= 12, `snapshot path continuous through the re-aim (largest speed change ${maxJump(r.moves)} px/frame)`);
    // Drawn at 20 ms, quiet for 24 ms: about 44 ms (60% of 90 ms is 54 ms).
    assert(r.shownAt !== null && r.shownAt >= 42 && r.shownAt <= 50, `handover once drawn and quiet (at ${r.shownAt} ms)`);
    assert(r.holds.length === 1 && r.holds[0].width === 700, 'hold at the granted size: no squeeze and relax');
    assert(mock.widgets.every(x => x.destroyed), 'snapshot gone');
    clean(w, 'morph minimum size');
}

// 22a. From maximized, the app draws its restored floating size only after
// the morph has started. That is not an answer to the request and must not
// be re-aimed at (it sits on the target's top-left edges).
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true, lag:30});
    w.floating = {x:0, y:0, width:600, height:400};
    w.floatingLag = 12;
    const r = await watchMorph(w, 'left', {stepMs:2, steps:120});
    assert(r.reaims.length === 0, `no re-aim at the late floating size (${JSON.stringify(r.reaims)})`);
    assert(r.moves.at(-1).width === 500 && r.moves.at(-1).height === 800, 'snapshot ends at the left half');
    clean(w, 'morph late floating');
}

// 22b. An X11-style app, whose Mutter frame changes at once: nothing to
// re-aim, and the snapshot still ends at the requested size.
{
    const w = fresh({frame:{...AREAS[0]}, lag:30});
    w.frameOnRequest = true;
    fullState(w);
    const r = await watchMorph(w, 'left');
    assert(r.reaims.length === 0, 'no re-aim when the granted size is the requested one');
    assert(r.moves.at(-1).width === 500, 'snapshot ends at the requested size');
    clean(w, 'morph X11 frame');
}

// 22c. A very slow app (300 ms): the live window fades in at 60% anyway.
{
    const w = fresh({frame:{...AREAS[0]}, lag:300});
    fullState(w);
    const r = await watchMorph(w, 'left');
    // Full -> left half lasts 90 ms; 60% is 54 ms.
    assert(r.shownAt !== null && r.shownAt <= 62, `slow app: handover at 60% of the motion (at ${r.shownAt} ms)`);
    assert(r.reaims.length === 0 && r.moves.at(-1).width === 500,
        'slow app: no re-aim at the unanswered old size; snapshot ends at the requested size');
    // Handover at 54 ms of a 90 ms motion: the fade must end by 90% of it,
    // a few frames before landing, not run 70 ms past it.
    assert(r.goneAt !== null && r.goneAt <= r.landedAt-6,
        `late handover: snapshot gone before the window lands (gone ${r.goneAt} ms, landed ${r.landedAt} ms)`);
    clean(w, 'morph slow app');
}

// 22d. Chromium-style relayout: the first frame at the new size still has
// the old layout; the handover waits for the re-laid-out frame. A 240 ms
// base (180 ms motion, fallback at 108 ms) keeps the two apart.
{
    mock.ints['animation-duration'] = 240;
    const w = fresh({frame:{x:0, y:0, width:500, height:800}, lag:20});
    w.relayout = 10;
    halfState(w);
    const r = await watchMorph(w, 'right', {stepMs:2, steps:120});
    mock.ints['animation-duration'] = 120;
    assert(r.content === 'laid-out', `handed over only after the re-layout (saw ${r.content})`);
    // Drawn at 20 ms, re-laid out at 30 ms, then 24 ms quiet: about 54 ms.
    assert(r.shownAt >= 52 && r.shownAt <= 60, `handover once content went quiet (at ${r.shownAt} ms)`);
    clean(w, 'morph relayout');
}

// 22e. Constant redraws (video): never quiet, so the handover is at 60%.
{
    mock.ints['animation-duration'] = 240;
    const w = fresh({frame:{x:0, y:0, width:500, height:800}, lag:20});
    w.video = true;
    halfState(w);
    const r = await watchMorph(w, 'right', {stepMs:2, steps:120});
    w.video = false;
    mock.ints['animation-duration'] = 120;
    assert(r.shownAt >= 106 && r.shownAt <= 112, `video: handover at 60% of the motion (at ${r.shownAt} ms)`);
    // 180 ms motion: the fade ends by 90% of it, well before landing.
    assert(r.goneAt !== null && r.goneAt <= r.landedAt-14,
        `video: snapshot gone before the window lands (gone ${r.goneAt} ms, landed ${r.landedAt} ms)`);
    clean(w, 'morph video');
}

// 22f. morph-fade 0: the snapshot is swapped for the live window in one
// frame at the handover; 30: the fade lasts about 30 ms.
for (const [fade, label] of [[0, 'instant swap'], [30, '30 ms fade']]) {
    mock.ints['morph-fade'] = fade;
    const w = fresh({frame:{...AREAS[0]}, lag:20});
    fullState(w);
    const r = await watchMorph(w, 'left', {stepMs:2, steps:120});
    mock.ints['morph-fade'] = 70;
    const span = r.goneAt-r.shownAt;
    assert(fade === 0 ? span === 0 : span >= 26 && span <= 34, `${label}: snapshot gone ${span} ms after the handover`);
    clean(w, `morph ${label}`);
}

// 23. Closing mid-morph removes the snapshot and stops driving the window.
{
    const w = fresh({frame:{x:0, y:0, width:500, height:800}});
    halfState(w);
    mock.widgets = [];
    const p = press('right');
    for (let i = 0; i < 4; i++) await step(4);
    w.unmanaged = true;
    w.emit('unmanaging');
    await settle(300);
    let failed = null;
    await p.catch(error => {failed = error;});
    assert(!failed && mock.widgets.every(x => x.destroyed), 'closed mid-morph: no error, snapshot removed');
    clean(w, 'morph closed');
}

// 24. Interrupting a morph continues from the drawn rectangle and leaves no
// snapshot behind.
{
    const w = fresh({frame:{x:0, y:0, width:500, height:800}});
    halfState(w);
    mock.widgets = [];
    const p1 = press('right');
    for (let i = 0; i < 5; i++) await step(4);
    const seen = {...e._visuals.get(w).rect};
    const p2 = press('right');
    await settle(800);
    await Promise.all([p1, p2]);
    assert(w.frame.x === 500 && w.frame.width === 500, 'left half, Right, Right ends on the right half');
    const second = mock.widgets[1];
    assert(second && second.moves[0].x === seen.x && second.moves[0].width === seen.width,
        'second snapshot starts where the first motion was interrupted');
    assert(mock.widgets.every(x => x.destroyed), 'all snapshots removed');
    clean(w, 'morph interrupted');
}

// 25. From maximized, the unmaximize cover is the morph's snapshot.
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true});
    w.floating = {x:100, y:100, width:600, height:400};
    mock.widgets = [];
    const p = press('left');
    await settle(800);
    await p;
    assert(mock.widgets.length === 1, 'one snapshot covers both the unmaximize and the morph');
    assert(mock.widgets[0].moves[0].width === 1000 && mock.widgets[0].moves.at(-1).width === 500, 'snapshot morphs from full to the left half');
    clean(w, 'morph from maximized');
}

// 26. Live style is unchanged: no snapshot for a window that is not maximized.
{
    morphStyle(false);
    const w = fresh({frame:{x:0, y:0, width:500, height:800}});
    halfState(w);
    mock.widgets = [];
    const p = press('right');
    await settle(600);
    await p;
    assert(mock.widgets.length === 0 && w.requests.length > 3, 'live style: no snapshot, continuous requests');
    clean(w, 'live style');
}
print(`PASS: ${count} lifecycle assertions`);
} finally {GLib.unlink(path); GLib.rmdir(folder);}

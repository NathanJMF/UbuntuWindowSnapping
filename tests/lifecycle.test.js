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
export const mock = {clock:0, ints:{'animation-duration':120,'max-stretch':3}, timelines:[], focus:null,
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
 constructor({schema_id}={}) {this.schema = schema_id ?? 'custom';}
 get_strv(k) {return mock.values.get(this.schema+':'+k) ?? mock.defaults.get(this.schema+':'+k) ?? [];}
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
 Widget:class {set_position() {} set_size() {} ease({onStopped}) {onStopped?.();} destroy() {}}};
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
const Main = {extensionManager:{lookup:() => ({stateObj:{_twm:Twm, _keybindingHandler:mock.handler,
  settings:{getGioObject:() => ({})}}})},
 wm:{_skippedActors:new Set(), skipNextEffect(a) {this._skippedActors.add(a);},
  addKeybinding:k => mock.bindings.set(k, 1), removeKeybinding:k => mock.bindings.delete(k)}};
class Rect {constructor(r) {Object.assign(this, r);}}
const Twm = {clearTilingProps() {}, updateTileGroup() {}, saveTileState() {},
 isMaximized:w => w.maximizedHorizontally && w.maximizedVertically};
globalThis.global = {window_manager:signals({}), window_group:{add_child() {}, set_child_above_sibling() {}},
 display:{get focus_window() {return mock.focus;}, get_monitor_neighbor_index:() => mock.neighbor,
  connect:(n, cb) => {mock.grab = cb; return 1;}, disconnect() {}}};
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
const {default:Ext, mock, signals} = await import(Gio.File.new_for_path(path).get_uri());
const AREAS = [{x:0, y:0, width:1000, height:800}, {x:1000, y:0, width:1000, height:800}];
// A client that draws each requested size `lag` ms after the request.
function makeWindow({frame = {x:100, y:100, width:600, height:400}, lag = 40, maximized = false, fullscreen = false} = {}) {
    const w = signals({maximizedHorizontally:maximized, maximizedVertically:maximized, fullscreen,
        frame:{...frame}, drawn:{...frame}, queue:[], requests:[], unmanaged:false, resizable:true});
    w.actor = signals({opacity:255, scale_x:1, scale_y:1, translation_x:0, translation_y:0,
        set_pivot_point() {}, remove_all_transitions() {}, paint_to_content:() => ({}),
        ease(p) {for (const k of ['scale_x','scale_y','translation_x','translation_y']) if (k in p) this[k] = p[k]; p.onStopped?.();}});
    for (const k of ['x','y','width','height'])
        Object.defineProperty(w.actor, k, {get:() => w.drawn[k]});
    const sizeChange = () => mock.pending.push(() => global.window_manager.emit('size-change', w.actor));
    Object.assign(w, {
        get_compositor_private() {return this.unmanaged ? null : this.actor;}, get_id:() => 1,
        get_frame_rect() {return {...this.frame};}, get_buffer_rect() {return {...this.frame};},
        allows_move() {return true;}, allows_resize() {return this.resizable;}, unminimize() {},
        get_monitor() {const cx = this.frame.x+this.frame.width/2; return cx >= 1000 ? 1 : 0;},
        get_work_area_for_monitor:m => ({...AREAS[m]}), move_frame() {}, move_to_monitor() {},
        unmake_fullscreen() {this.fullscreen = false; sizeChange();},
        unmaximize() {this.maximizedHorizontally = this.maximizedVertically = false; sizeChange();},
        maximize() {this.maximizedHorizontally = this.maximizedVertically = true;
            this.frame = this.get_work_area_for_monitor(this.get_monitor()); this.drawn = {...this.frame}; sizeChange();},
        move_resize_frame(u, x, y, width, height) {
            this.frame = {x, y, width, height};
            this.requests.push({...this.frame});
            this.queue.push({at:mock.clock, r:{...this.frame}});
        },
    });
    w.lag = lag;
    return w;
}
const e = new Ext();
e.enable();
// Waits poll on each step and honour cancellation like the real one.
e._waitForWindow = (w, p, op) => new Promise((resolve, reject) => {
    let done = false;
    op.cancelWait = () => {if (!done) {done = true; op.cancelWait = null; reject(new Error('Placement cancelled'));}};
    const poll = () => {
        if (done) return;
        if (op.cancelled) {done = true; reject(new Error('Placement cancelled')); return;}
        if (p()) {done = true; op.cancelWait = null; resolve();} else mock.pending.push(poll);
    };
    poll();
});
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
    while (win && win.queue.length && mock.clock-win.queue[0].at >= win.lag*1000)
        win.drawn = win.queue.shift().r;
    for (const t of [...mock.timelines]) t.tick(ms);
    mock.timelines = mock.timelines.filter(t => !t.stopped);
    await flush();
};
const settle = async (ms = 1500) => {for (let t = 0; t < ms; t += 4) await step(4);};
const press = async dir => {
    const p = e._snap(dir).catch(error => {throw new Error(`snap ${dir} failed: ${error.message}`);});
    await flush();
    return p;
};
const clean = (w, label) => {
    assert(w.actor.scale_x === 1 && w.actor.scale_y === 1 && w.actor.translation_x === 0 && w.actor.translation_y === 0,
        `${label}: actor transform back to identity`);
    assert(!e._visuals.has(w), `${label}: no visual state left`);
    assert(w.actor._h.length === 0, `${label}: no actor signal handlers left`);
    assert(w._h.length === 0, `${label}: no window signal handlers left`);
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
    await settle(300);
    await p;
    clean(w, 'closed during hold');
}

// 7. A maximized fullscreen window: both native changes are skipped, and
// nothing is left armed afterwards.
{
    const w = fresh({frame:{...AREAS[0]}, maximized:true, fullscreen:true});
    mock.nativeEffects = mock.skippedEffects = 0;
    const p = press('left');
    await settle(600);
    await p;
    assert(w.frame.width === 500 && !w.fullscreen, 'fullscreen maximized -> left half');
    assert(mock.nativeEffects === 0, 'no native GNOME size-change effect ran');
    assert(mock.skippedEffects === 2, 'unfullscreen and unmaximize effects both skipped');
    assert(globalThis.global.window_manager._h.length === 1, 'only GNOME\'s own size-change handler remains');
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
}

// 12. Anchors tolerate the 1 px rounding of an interrupted start.
{
    const a = anchorFor({x:300, y:0, width:701, height:800}, {x:500, y:0, width:500, height:800});
    assert(a.x === 1, 'right edge within 1 px still anchors right');
}
print(`PASS: ${count} lifecycle assertions`);
} finally {GLib.unlink(path); GLib.rmdir(folder);}

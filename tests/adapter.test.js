// Load the actual extension with only its GNOME imports replaced by mocks.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {sameFrame} from '../placement.js';
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const text = new TextDecoder().decode(GLib.file_get_contents(`${root}/extension.js`)[1]);
const setup = `
export const mock = {ints:{'animation-duration':250,'max-stretch':100}, animations:false, frames:[], skipped:[], covers:0, focus:null, neighbor:-1, bindings:new Map(), grab:null, tiles:[], values:new Map(), dependencyEnabled:true, timers:new Map(), handler:{}};
class Settings {
 constructor({schema_id}={}) {this.schema=schema_id??'custom';}
 get_strv(k) {return mock.values.get(this.schema+':'+k)??[];}
 set_strv(k,v) {mock.values.set(this.schema+':'+k,v);}
 get_boolean(k) {return false;}
 get_int(k) {return mock.ints[k]??0;}
 get_string(k) {return mock.values.get(this.schema+':'+k)??'';}
 set_string(k,v) {mock.values.set(this.schema+':'+k,v);}
}
const Gio={Settings};
const GLib={PRIORITY_DEFAULT:0,SOURCE_CONTINUE:true,get_monotonic_time:(()=>{let t=0;return ()=>t+=60000;})(),
 timeout_add:(p,ms,cb)=>{const id=mock.timers.size+1;mock.timers.set(id,cb);return id;},
 Source:{remove:id=>mock.timers.delete(id)}};
class Extension {getSettings(){return new Settings();}}
const Meta={WindowClientType:{WAYLAND:0,X11:1},DisplayDirection:{LEFT:0,RIGHT:1,UP:2,DOWN:3},KeyBindingFlags:{IGNORE_AUTOREPEAT:1},MaximizeFlags:{BOTH:3}};
const Shell={ActionMode:{NORMAL:1}};
const St={Settings:{get:()=>({enable_animations:mock.animations,slow_down_factor:1})},
 Widget:class{constructor(){mock.covers++;} set_position(){} set_size(){} ease({onStopped}){onStopped?.();} destroy(){}}};
// Timeline frames run synchronously; progress is already eased by the mode.
class Timeline {
 constructor({actor,duration}) {this.actor=actor;this.duration=duration;this.handlers={};this.progress=0;}
 connectObject(...args) {for(let i=0;i+1<args.length;i+=2)if(typeof args[i+1]==='function')this.handlers[args[i]]=args[i+1];}
 disconnectObject() {this.handlers={};}
 get_elapsed_time() {return this.progress*this.duration;}
 stop() {this.stopped=true;}
 start() {
  const frames=[0.25,0.5,0.75,1];
  const run=from=>{
   for (let i=from;i<frames.length;i++) {
    if(this.stopped)return;
    // A paused timeline lets a test press keys mid-motion.
    if(mock.pauseAt===i&&this.duration>150){mock.pauseAt=null;mock.resume=()=>run(i);return;}
    this.progress=frames[i];this.handlers['new-frame']?.();
   }
   if(!this.stopped)this.handlers.completed?.();
  };
  run(0);
 }
}
const Clutter={Timeline,AnimationMode:{EASE_OUT_CUBIC:1,EASE_OUT_QUAD:2}};
const Main={extensionManager:{lookup:()=>({get stateObj(){return mock.dependencyEnabled ? {_twm:Twm,_keybindingHandler:mock.handler,settings:{getGioObject:()=>({})}} : {};}})},wm:{
 skipNextEffect:a=>mock.skipped.push(a),_skippedActors:new Set(),
 addKeybinding:(k,s,f,m,cb)=>mock.bindings.set(k,cb),removeKeybinding:k=>mock.bindings.delete(k)}};
class Rect {constructor(r){Object.assign(this,r);} equal(r){return ['x','y','width','height'].every(k=>this[k]===r[k]);}}
const Twm={clearTilingProps:()=>{},updateTileGroup:()=>{},saveTileState:()=>{},isMaximized:w=>w.maximizedHorizontally&&w.maximizedVertically,
 async tile(w,r,{monitorNr}) {
  mock.tiles.push({window:w,rect:r,monitor:monitorNr});
  w.monitor=monitorNr;
  const a=w.get_work_area_for_monitor(monitorNr);
  const full=new Rect(a).equal(r);
  w.maximizedHorizontally=full;w.maximizedVertically=full;w.isTiled=!full;w.tiledRect=full?null:r;
 }};
globalThis.global={window_group:{add_child(){},set_child_above_sibling(){}},display:{get focus_window(){return mock.focus;},
 get_monitor_neighbor_index:()=>mock.neighbor,connect:(n,cb)=>{mock.grab=cb;return 1;},disconnect:()=>{mock.grab=null;}}};
`;
const folder = GLib.dir_make_tmp('keyboard-snap-tests-XXXXXX');
const path = `${folder}/adapter.js`;
// Local modules keep the extension's own import lists; GNOME imports are mocked.
const local = text.match(/^import [^;]* from '\.\/[^']*';$/gm).map(line =>
 line.replace(/'\.\/(.*)'/, (_m, f) => `'${Gio.File.new_for_path(`${root}/${f}`).get_uri()}'`)).join('\n');
GLib.file_set_contents(path, local + '\n' + setup + text.replace(/^import [^;]*;\n/gm,''));
let count=0;
function assert(v,msg){count++;if(!v)throw new Error(msg);}
function window(maximized=false){const w={monitor:0,maximizedHorizontally:maximized,maximizedVertically:maximized,
 frame:{x:0,y:0,width:1000,height:800},
 actor:{opacity:255,scale_x:1,scale_y:1,translation_x:0,translation_y:0,
  connectObject(){},disconnectObject(){},paint_to_content:()=>({}),set_pivot_point(){},remove_all_transitions(){},
  ease(p){for(const k of ['scale_x','scale_y','translation_x','translation_y','opacity'])if(k in p)this[k]=p[k];p.onStopped?.();}},
 get_buffer_rect(){return {...this.frame};},
 get_compositor_private(){return this.actor;},
 get_id(){return 1;},get_frame_rect(){return {...this.frame};},
 allows_move(){return !this.maximizedHorizontally;},allows_resize(){return !this.maximizedHorizontally;},
 unminimize(){},unmaximize(){this.maximizedHorizontally=false;this.maximizedVertically=false;},
 maximize(){this.maximizedHorizontally=true;this.maximizedVertically=true;this.frame=this.get_work_area_for_monitor(this.monitor);},
 move_to_monitor(m){this.monitor=m;},move_frame(u,x,y){this.frame.x=x;this.frame.y=y;},
 move_resize_frame(u,x,y,width,height){this.frame={x,y,width,height};this.frames?.push({x,y,width,height});this.recordPlacement(this);},
 get_monitor(){return this.monitor;},get_work_area_for_monitor(m){return {x:m*1000,y:0,width:1000,height:800};}};
 for(const k of ['x','y','width','height'])Object.defineProperty(w.actor,k,{get:()=>(w.drawn??w.frame)[k]});
 return w;}
try {
 const {default:Extension,mock}=await import(Gio.File.new_for_path(path).get_uri());
 function createExtension(){
  const e=new Extension();
  // Geometry is immediate in this adapter mock; placement.test.js exercises
  // asynchronous/native acknowledgement ordering separately.
  e._waitForWindow=async(w,p,op)=>{for(let i=0;i<20;i++){if(op.cancelled)throw new Error('Placement cancelled');if(p())return;}throw new Error('mock geometry did not settle');};
  e.enable();return e;
 }
 const e=createExtension();
 const a=window(true);a.recordPlacement=w=>mock.tiles.push(w);mock.focus=a;
 await e._snap('left');
 assert(mock.tiles.length===1,'initially maximized window must snap');
 assert(a.tiledRect.width===500,'maximized -> left half');
 a.isTiled=false;a.tiledRect=null;
 mock.neighbor=1;await e._snap('left');
 assert(a.monitor===1&&!a.maximizedHorizontally&&a.tiledRect.x===1500&&a.tiledRect.width===500,'crossing left arrives on destination right half');
 await e._snap('down');
 assert(a.tiledRect.height===400&&a.tiledRect.width===500&&a.tiledRect.x===1500,'destination entry half remains tracked for quarter snapping');
 mock.neighbor=-1;await e._snap('left');await e._snap('left');
 const b=window();mock.grab(null,b);
 assert(e._states.has(a),'dragging B preserves A history');
 mock.neighbor=0;await e._snap('left');
 assert(a.monitor===1&&a.tiledRect.height===800&&a.tiledRect.width===500,'quarter expands to full side before crossing');
 await e._snap('left');
 assert(a.monitor===0&&!a.maximizedHorizontally&&a.tiledRect.x===500,'A still crosses into entry half after dragging B');
 await e._snap('left');mock.grab(null,a);
 assert(!e._states.has(a),'dragging A clears A history');
 await e._snap('left');
 assert(!a.maximizedHorizontally&&a.monitor===0,'after dragging A, first Left starts fresh');
 const fixed=window();fixed.recordPlacement=w=>mock.tiles.push(w);fixed.allows_resize=()=>false;mock.focus=fixed;
 const before=mock.tiles.length;await e._snap('left');
 assert(mock.tiles.length===before,'non-resizable non-maximized window stays untouched');
 // App maximize changes native flags but may retain TA tiled metadata.
 mock.focus=a;mock.neighbor=1;
 a.maximizedHorizontally=true;a.maximizedVertically=true;
 await e._snap('left');
 assert(a.monitor===0&&!a.maximizedHorizontally,'app maximize resets stale half history');
 await e._snap('right');
 assert(a.monitor===0&&a.maximizedHorizontally&&a.maximizedVertically,'opposite arrow from left half goes full locally');
 await e._snap('right');
 assert(a.monitor===0&&a.tiledRect.x===500&&a.tiledRect.width===500,'next opposite arrow selects right half locally');
 await e._snap('down');
 assert(a.tiledRect.x===500&&a.tiledRect.y===400&&a.tiledRect.height===400,'right half plus Down becomes bottom-right quarter');
 await e._snap('up');
 assert(a.monitor===0&&a.tiledRect.x===500&&a.tiledRect.y===0&&a.tiledRect.height===800,'bottom-right plus Up expands to right half');
 await e._snap('up');
 assert(a.monitor===0&&a.tiledRect.x===500&&a.tiledRect.y===0&&a.tiledRect.height===400,'next Up becomes top-right quarter without crossing');
 // Presses during a running placement are queued, not dropped.
 mock.neighbor=-1;
 const first=e._snap('down');const second=e._snap('down');
 assert(e._queued.get(a)?.length===1,'press during placement is queued');
 await first;await second;
 assert(a.monitor===0&&a.tiledRect.x===500&&a.tiledRect.y===400&&a.tiledRect.height===400,'top-right, Down, queued Down: right half then bottom-right');
 assert(!e._queued.get(a)?.length,'queue drained');
 // Animated placement: real intermediate frames, native effects skipped,
 // snapshot cover only while leaving the maximized state.
 mock.animations=true;a.frames=mock.frames=[];mock.skipped=[];mock.covers=0;
 await e._snap('up');await e._snap('up');a.maximizedHorizontally=a.maximizedVertically=true;a.frame={x:0,y:0,width:1000,height:800};
 a.frames=mock.frames=[];mock.skipped=[];mock.covers=0;
 await e._snap('left');
 const steps=mock.frames.filter(f=>f.width!==500&&f.width!==1000);
 assert(steps.length>=2,'animation sends intermediate real frame sizes');
 assert(steps.every((f,i)=>i===0||f.width<=steps[i-1].width),'intermediate widths shrink monotonically toward the half');
 assert(mock.frames.at(-1).width===500&&a.tiledRect.width===500,'animation ends on the exact target');
 assert(mock.skipped.length===1&&mock.covers===1,'unmaximize uses a cover and skips GNOME effect');
 assert(a.actor.opacity===255,'window visible after cover released');
 a.frames=mock.frames=[];mock.skipped=[];mock.covers=0;
 await e._snap('right');
 assert(a.maximizedHorizontally&&mock.skipped.length===1&&mock.covers===0,'half -> full skips the maximize zoom with no cover');
 assert(mock.frames.some(f=>f.width>500&&f.width<1000),'half -> full grows through real intermediate sizes');
 // Lagging client: the real frame trails one request behind, yet every
 // animation frame shows the window exactly on the curve.
 {
  const d=window();d.recordPlacement=()=>{};mock.focus=d;mock.neighbor=-1;
  let pending=null;
  d.move_resize_frame=function(u,x,y,width,height){if(pending)this.frame=pending;pending={x,y,width,height};};
  d.move_frame=function(){};
  const realWait=e._waitForWindow;
  e._waitForWindow=async(w,p,op)=>{if(pending){w.frame=pending;pending=null;}return realWait(w,p,op);};
  const shown=[];const realShow=e._showAt.bind(e);
  e._showAt=(w,actor,rect)=>{realShow(w,actor,rect);const f=w.get_frame_rect(),b=w.get_buffer_rect();
   shown.push({rect,x:b.x+actor.translation_x+(f.x-b.x)*actor.scale_x,width:f.width*actor.scale_x,scaled:actor.scale_x!==1});};
  await e._snap('left');
  assert(shown.length>=4,'each animation frame positions the image');
  assert(shown.every(v=>Math.abs(v.x-v.rect.x)<1e-6&&Math.abs(v.width-v.rect.width)<1e-6),'image sits exactly on the curve despite client lag');
  assert(shown.some(v=>v.scaled),'lag is compensated by scaling the image');
  assert(d.actor.scale_x===1&&d.actor.translation_x===0,'transform relaxed to identity afterwards');
  assert(!e._visuals.has(d),'no visual state left behind');
  assert(d.tiledRect.width===500&&d.frame.width===500,'lagging client still confirmed on target');
  e._waitForWindow=realWait;e._showAt=realShow;
 }
 // Latency is learned from commits; later motions request ahead of the
 // frame being drawn. With a stretch cap the image never scales past it and
 // the fixed edge stays exactly in place.
 {
  const h=window();h.recordPlacement=()=>{};mock.focus=h;mock.neighbor=-1;
  let pending=null;const requests=[];
  h.move_resize_frame=function(u,x,y,width,height){if(pending)this.frame=pending;pending={x,y,width,height};requests.push({...pending});};
  h.move_frame=function(){};
  const realWait=e._waitForWindow;
  e._waitForWindow=async(w,p,op)=>{if(pending){w.frame=pending;pending=null;}return realWait(w,p,op);};
  const shown=[];const realShow=e._showAt.bind(e);
  e._showAt=(w,actor,rect,anchor,cap)=>{realShow(w,actor,rect,anchor,cap);shown.push({rect,scale:actor.scale_x,drawn:{...e._visuals.get(w).rect}});};
  await e._snap('left');
  assert(e._latency.get(h)>0,'commit latency measured from a lagging client');
  requests.length=0;shown.length=0;
  mock.ints['max-stretch']=6;
  await e._snap('right');
  assert(requests[0].width>shown[0].rect.width,'first request leads the drawn curve toward the target');
  assert(shown.every(v=>Math.abs(v.scale-1)<=0.06+1e-9),'image stretch stays within the 6% cap');
  assert(shown.every(v=>v.drawn.x===0),'left edge stays fixed while growing to full');
  assert(h.maximizedHorizontally&&h.actor.scale_x===1&&!e._visuals.has(h),'capped motion still ends full with identity transform');
  mock.ints['max-stretch']=0;shown.length=0;
  await e._snap('left');
  assert(shown.length&&shown.every(v=>v.scale===1),'cap 0 only moves the image');
  mock.ints['max-stretch']=100;
  e._waitForWindow=realWait;e._showAt=realShow;
 }
 // X11-style client: Mutter's frame rect jumps to each request at once, but
 // the actor keeps drawing the previous buffer until the client repaints.
 // The image must follow what is drawn, and latency comes from repaints.
 {
  const x=window();x.recordPlacement=()=>{};mock.focus=x;mock.neighbor=-1;
  x.drawn={...x.frame};
  x.move_resize_frame=function(u,px,py,width,height){this.drawn={...this.frame};this.frame={x:px,y:py,width,height};};
  x.move_frame=function(){};
  const realWait=e._waitForWindow;
  e._waitForWindow=async(w,p,op)=>{w.drawn={...w.frame};return realWait(w,p,op);};
  const shown=[];const realShow=e._showAt.bind(e);
  e._showAt=(w,actor,r,anchor,cap)=>{realShow(w,actor,r,anchor,cap);
   shown.push({r,x:actor.x+actor.translation_x+0*actor.scale_x,width:actor.width*actor.scale_x,stale:actor.width!==w.frame.width});};
  e._latency.delete(x);
  await e._snap('left');
  assert(shown.some(v=>v.stale),'test drives frames where Mutter is ahead of the drawn buffer');
  assert(shown.every(v=>Math.abs(v.x-v.r.x)<1e-6&&Math.abs(v.width-v.r.width)<1e-6),'image placed from drawn geometry, exactly on the curve');
  assert(e._latency.get(x)>0,'latency measured from repaints, not frame-rect updates');
  assert(x.actor.scale_x===1&&!e._visuals.has(x),'transform cleared after X11-style motion');
  e._waitForWindow=realWait;e._showAt=realShow;
 }
 // Interrupt mid-motion: the transform is kept and the next motion starts
 // from the rectangle on screen, not from the lagging real frame.
 {
  const g=window();g.recordPlacement=()=>{};mock.focus=g;mock.neighbor=-1;g.frame={x:0,y:0,width:1000,height:800};
  const froms=[];const realAnimate=e._animate.bind(e);
  e._animate=(w,from,to,apply,op)=>{froms.push({...from});return realAnimate(w,from,to,apply,op);};
  mock.pauseAt=2;
  const first=e._snap('left');
  for(let i=0;i<10&&!mock.resume;i++)await Promise.resolve();
  assert(mock.resume,'first motion paused mid-way');
  const onScreen={...e._visuals.get(g).rect};
  e._snap('right');
  await first;
  assert(froms.length===2&&sameFrame(froms[1],onScreen,0),'second motion starts from the on-screen rectangle');
  assert(g.maximizedHorizontally&&!e._visuals.has(g)&&g.actor.scale_x===1,'interrupted left then right ends full, transform cleared');
  mock.resume=null;e._animate=realAnimate;
 }
 mock.animations=false;
 // Interrupting: hold the first placement open, press Right twice, then
 // release. Both presses fold into one placement straight to the right half.
 {
  const c=window();c.recordPlacement=()=>{};mock.focus=c;mock.neighbor=-1;
  const realWait=e._waitForWindow;let release;const gate=new Promise(r=>release=r);let held=true;
  e._waitForWindow=async(w,p,op)=>{if(held){held=false;await gate;}return realWait(w,p,op);};
  const realPlace=e._place.bind(e);const targets=[];
  const outcomes=[];e._place=(w,t,m,op)=>{targets.push({...t});const r=realPlace(w,t,m,op);r.then(()=>outcomes.push('done'),()=>outcomes.push('cancelled'));return r;};
  const first=e._snap('left');
  await Promise.resolve();
  e._snap('right');e._snap('right');
  assert(e._queued.get(c)?.length===2,'presses during placement wait to be folded');
  release();await first;
  assert(targets.length===2,'interrupted placement plus one folded placement, no intermediate full');
  assert(targets[0].width===500&&targets[0].x===0,'first target was the left half');
  assert(outcomes.join()==='cancelled,done','first placement was interrupted, not completed');
  assert(c.tiledRect.x===500&&c.tiledRect.width===500&&!c.maximizedHorizontally,'left, right, right lands directly on the right half');
  assert(!e._states.get(c).superseded&&e._states.get(c).layout.x==='right','folded result is the tracked state');
  e._waitForWindow=realWait;e._place=realPlace;mock.focus=a;
 }
 const beforeDependency=mock.tiles.length;
 mock.dependencyEnabled=false;
 await e._snap('left');
 assert(mock.tiles.length===beforeDependency,'runtime dependency loss prevents adapter calls');
 e.disable();
 assert(mock.bindings.size===0,'disable releases all four shortcuts');
 assert(mock.grab===null,'disable disconnects grab signal');
 assert(mock.timers.size===0,'disable removes readiness watcher');
 const inactive=createExtension();
 assert(mock.bindings.size===0,'delayed dependency cannot claim shortcuts');
 assert(mock.timers.size===1,'delayed dependency is watched without startup error');
 mock.dependencyEnabled=true;
 [...mock.timers.values()][0]();
 assert(mock.bindings.size===4,'delayed dependency activation registers all arrows');
 mock.focus=window(true);mock.focus.recordPlacement=w=>mock.tiles.push(w);mock.neighbor=-1;
 await inactive._snap('down');
 assert(mock.focus.tiledRect.y===400,'delayed activation Down selects bottom half');
 await inactive._snap('down');
 assert(mock.focus.tiledRect.y===400&&!mock.focus.maximizedHorizontally,'repeat Down stays bottom');
 mock.dependencyEnabled=false;
 [...mock.timers.values()][0]();
 assert(mock.bindings.size===0,'dependency loss restores shortcut ownership');
 mock.dependencyEnabled=true;
 [...mock.timers.values()][0]();
 assert(mock.bindings.size===4,'dependency recovery reclaims arrows');
 // Simulate an entire TA restart between watcher ticks: ready at both
 // checkpoints, but a new handler and native shortcuts restored by TA.
 const oldHandler=mock.handler;mock.handler={};
 mock.values.set('org.gnome.desktop.wm.keybindings:maximize',['<Super>Up']);
 mock.values.set('org.gnome.mutter.keybindings:toggle-tiled-left',['<Super>Left']);
 [...mock.timers.values()][0]();
 assert(inactive._bindingOwner===mock.handler&&inactive._bindingOwner!==oldHandler,'fast restart detected by handler identity');
 assert(mock.bindings.size===4,'fast restart re-registers all custom shortcuts');
 assert(mock.values.get('org.gnome.desktop.wm.keybindings:maximize').length===0,'fast restart removes restored native Up');
 assert(mock.values.get('org.gnome.mutter.keybindings:toggle-tiled-left').length===0,'fast restart removes restored native Left');
 inactive.disable();
 assert(mock.timers.size===0&&mock.bindings.size===0,'disable cleans watcher and shortcuts after recovery');
 print(`PASS: ${count} GNOME adapter mock assertions`);
} finally {GLib.unlink(path);GLib.rmdir(folder);}

// The real extension against the shared mock world (tests/support/gnome.js)
// with animations off and immediate geometry: snapping rules end to end,
// per-window state, dependency handling and shortcut ownership.
import {mock} from './support/gnome.js';
import {loadExtension} from './support/load.js';
let count=0;
function assert(v,msg){count++;if(!v)throw new Error(msg);}
// Geometry is immediate here; placement.test.js and lifecycle.test.js cover
// delayed, out-of-order and animated behaviour.
Object.assign(mock, {animations:false, autoClock:5000, tiles:[]});
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
 const {default:Extension}=await loadExtension();
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
} finally {}

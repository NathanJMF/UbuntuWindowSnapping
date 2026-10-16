// Load the actual extension with only its GNOME imports replaced by mocks.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_path();
const text = new TextDecoder().decode(GLib.file_get_contents(`${root}/extension.js`)[1]);
const setup = `
import {FULL, step, rectangle} from '${Gio.File.new_for_path(root+'/engine.js').get_uri()}';
import {placeWindow, sameFrame} from '${Gio.File.new_for_path(root+'/placement.js').get_uri()}';
export const mock = {focus:null, neighbor:-1, bindings:new Map(), grab:null, tiles:[], values:new Map(), dependencyEnabled:true, timers:new Map(), handler:{}};
class Settings {
 constructor({schema_id}={}) {this.schema=schema_id??'custom';}
 get_strv(k) {return mock.values.get(this.schema+':'+k)??[];}
 set_strv(k,v) {mock.values.set(this.schema+':'+k,v);}
 get_boolean(k) {return false;}
 get_string(k) {return mock.values.get(this.schema+':'+k)??'';}
 set_string(k,v) {mock.values.set(this.schema+':'+k,v);}
}
const Gio={Settings};
const GLib={PRIORITY_DEFAULT:0,SOURCE_CONTINUE:true,
 timeout_add:(p,ms,cb)=>{const id=mock.timers.size+1;mock.timers.set(id,cb);return id;},
 Source:{remove:id=>mock.timers.delete(id)}};
class Extension {getSettings(){return new Settings();}}
const Meta={DisplayDirection:{LEFT:0,RIGHT:1,UP:2,DOWN:3},KeyBindingFlags:{IGNORE_AUTOREPEAT:1},MaximizeFlags:{BOTH:3}};
const Shell={ActionMode:{NORMAL:1}};
const Main={extensionManager:{lookup:()=>({get stateObj(){return mock.dependencyEnabled ? {_twm:Twm,_keybindingHandler:mock.handler,settings:{getGioObject:()=>({})}} : {};}})},wm:{
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
globalThis.global={display:{get focus_window(){return mock.focus;},
 get_monitor_neighbor_index:()=>mock.neighbor,connect:(n,cb)=>{mock.grab=cb;return 1;},disconnect:()=>{mock.grab=null;}}};
`;
const folder = GLib.dir_make_tmp('keyboard-snap-tests-XXXXXX');
const path = `${folder}/adapter.js`;
GLib.file_set_contents(path, setup + text.replace(/^import .*;\n/gm,''));
let count=0;
function assert(v,msg){count++;if(!v)throw new Error(msg);}
function window(maximized=false){return {monitor:0,maximizedHorizontally:maximized,maximizedVertically:maximized,
 frame:{x:0,y:0,width:1000,height:800},
 get_id(){return 1;},get_frame_rect(){return {...this.frame};},
 allows_move(){return !this.maximizedHorizontally;},allows_resize(){return !this.maximizedHorizontally;},
 unminimize(){},unmaximize(){this.maximizedHorizontally=false;this.maximizedVertically=false;},
 maximize(){this.maximizedHorizontally=true;this.maximizedVertically=true;this.frame=this.get_work_area_for_monitor(this.monitor);},
 move_to_monitor(m){this.monitor=m;},move_frame(u,x,y){this.frame.x=x;this.frame.y=y;},
 move_resize_frame(u,x,y,width,height){this.frame={x,y,width,height};this.recordPlacement(this);},
 get_monitor(){return this.monitor;},get_work_area_for_monitor(m){return {x:m*1000,y:0,width:1000,height:800};}};}
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

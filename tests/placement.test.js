import {placeWindow,sameFrame,interpolateRect,travelDuration,visualTransform,easeOutCubic,anchorFor} from '../placement.js';
let assertions=0;
function assert(value,message){assertions++;if(!value)throw new Error(message);}
function environment({monitor=2,minWidth=0,cancelAt=Infinity,resizeDelay=4,geometryAssignsMonitor=false}={}) {
 const areas=[{x:1080,y:249,width:2560,height:1355},{x:3640,y:249,width:2560,height:1355},{x:0,y:32,width:1080,height:1835}];
 const e={tick:0,pending:[],events:[]};
 const schedule=(delay,apply)=>e.pending.push({at:e.tick+delay,apply});
 const w={monitor,frame:{...areas[monitor]},maximizedHorizontally:true,maximizedVertically:true,
  fullscreen:false,
  get_frame_rect(){return {...this.frame};},get_monitor(){return this.monitor;},
  get_work_area_for_monitor(m){return {...areas[m]};},unminimize(){},
  allows_move(){return !this.maximizedHorizontally;},allows_resize(){return !this.maximizedHorizontally;},
  unmaximize(){e.events.push('unmaximize');schedule(3,()=>{this.maximizedHorizontally=false;this.maximizedVertically=false;e.events.push('unmaximize-acked');});},
  move_to_monitor(m){
   assert(!this.maximizedHorizontally,'must unmaximize before monitor request');
   e.requestedMonitor=m;e.events.push('move-request');
   if(!geometryAssignsMonitor)schedule(4,()=>{this.monitor=m;this.frame={...areas[m]};e.events.push('move-acked');});
  },
  move_frame(user,x,y){schedule(2,()=>{this.frame.x=x;this.frame.y=y;});},
  move_resize_frame(user,x,y,width,height){
   assert(!this.maximizedHorizontally&&!this.maximizedVertically,'half placement has no native maximize hints');
   e.events.push('resize-request');schedule(resizeDelay,()=>{this.frame={x,y,width:Math.max(minWidth,width),height};if(geometryAssignsMonitor){const cx=x+width/2,cy=y+height/2;const m=areas.findIndex(a=>cx>=a.x&&cx<a.x+a.width&&cy>=a.y&&cy<a.y+a.height);if(m!==-1&&m!==this.monitor){this.monitor=m;e.events.push('move-acked');}}e.events.push('resize-acked');});
  },
  maximize(){
   e.events.push('maximize-request');schedule(3,()=>{this.maximizedHorizontally=true;this.maximizedVertically=true;this.frame={...areas[this.monitor]};e.events.push('maximize-acked');});
  },
 };
 const waitFor=async predicate=>{
  let stable=0;
  for(let i=0;i<40;i++){
   e.tick++;
   if(e.tick>=cancelAt)throw new Error('cancelled');
   for(const t of [...e.pending])if(t.at<=e.tick){e.pending.splice(e.pending.indexOf(t),1);t.apply();}
   stable=predicate()?stable+1:0;
   if(stable>=2)return;
   await Promise.resolve();
  }
  throw new Error('timeout');
 };
 return {e,w,waitFor,areas};
}
{
 const {e,w,waitFor,areas}=environment();
 const r=await placeWindow(w,areas[0],0,{waitFor,both:3});
 assert(r.full&&w.monitor===0,'portrait -> main crossing arrives full');
 assert(e.events.indexOf('move-acked')<e.events.indexOf('maximize-request'),'monitor confirmed before maximize request');
 assert(e.events.indexOf('resize-acked')<e.events.indexOf('maximize-request'),'requested target resize confirmed before maximize');
 assert(sameFrame(r.frame,areas[0]),'returned frame is confirmed target frame');
}
{
 const {w,waitFor}=environment({monitor:2,minWidth:680,resizeDelay:20});
 const target={x:540,y:32,width:540,height:1835};
 const r=await placeWindow(w,target,2,{waitFor,both:3});
 assert(!r.full,'portrait constrained right half is not full');
 assert(r.frame.width===680,'records accepted minimum width, not requested width');
 assert(r.frame.x===540,'constrained half remains at intended edge');
 assert(!w.maximizedHorizontally&&!w.maximizedVertically,'no partial-maximize flags to race with Chromium');
 const repeated=await placeWindow(w,target,2,{waitFor,both:3,acceptedFrame:r.frame});
 assert(sameFrame(repeated.frame,r.frame),'previous confirmed constrained placement can be reused');
 const leftTarget={x:0,y:32,width:540,height:1835};
 const opposite=await placeWindow(w,leftTarget,2,{waitFor,both:3,
   previousPlacement:{monitor:2,target,frame:r.frame}});
 assert(opposite.frame.x===0&&opposite.frame.width===680,'constrained right -> left keeps confirmed size and waits for position');
 const rightAgain=await placeWindow(w,target,2,{waitFor,both:3,
   previousPlacement:{monitor:2,target:leftTarget,frame:opposite.frame}});
 assert(rightAgain.frame.x===540&&rightAgain.frame.width===680,'constrained left -> right also works');
}
{
 const {e,w,waitFor,areas}=environment({monitor:2,cancelAt:5});
 let cancelled=false;
 try{await placeWindow(w,areas[0],0,{waitFor,both:3});}catch(error){cancelled=error.message==='cancelled';}
 assert(cancelled,'pending placement cancellation propagates');
 assert(!e.events.includes('maximize-request'),'cancelled move cannot issue maximize');
}
{
 const {w,waitFor}=environment({monitor:0});
 const r=await placeWindow(w,{x:2360,y:249,width:1280,height:1355},0,{waitFor,both:3});
 assert(r.frame.x===2360&&r.frame.width===1280,'delayed right half commits correct side');
 const l=await placeWindow(w,{x:1080,y:249,width:1280,height:1355},0,{waitFor,both:3});
 assert(l.frame.x===1080,'same-monitor right -> left waits for position acknowledgement');
}
{
 const {e,w,waitFor,areas}=environment({monitor:2,geometryAssignsMonitor:true});
 const stages=[];
 const r=await placeWindow(w,areas[0],0,{both:3,
  clearConstraints:()=>e.events.push('clear-constraints'),
  constrain:()=>{assert(w.monitor===0,'destination constraints apply only after monitor confirmed');e.events.push('target-constraints');},
  waitFor:async(p,stage)=>{stages.push(stage);return waitFor(p);}});
 assert(r.full&&w.monitor===0,'portrait return succeeds when only absolute geometry assigns the monitor');
 assert(e.events.indexOf('clear-constraints')<e.events.indexOf('move-request'),'source constraints cleared before transfer');
 assert(e.events.indexOf('resize-request')<e.events.indexOf('move-acked'),'absolute target sent before standalone monitor acknowledgement');
 assert(e.events.indexOf('move-acked')<e.events.indexOf('maximize-request'),'maximize still waits for monitor and frame together');
 assert(stages.join(',')==='unmaximize,monitor-and-frame,maximize','each wait has an explicit diagnostic stage');
}
for (const [source,dest,target] of [
 [2,0,{x:1080,y:249,width:1280,height:1355}],
 [0,2,{x:540,y:32,width:540,height:1835}],
]) {
 const {e,w,waitFor}=environment({monitor:source,geometryAssignsMonitor:true,resizeDelay:20});
 const result=await placeWindow(w,target,dest,{waitFor,both:3});
 assert(w.monitor===dest&&sameFrame(result.frame,target),'cross-monitor half lands on the requested destination edge');
 assert(!result.full&&!w.maximizedHorizontally&&!w.maximizedVertically,'cross-monitor half does not maximize');
 assert(!e.events.includes('maximize-request'),'half arrival issues no native maximize request');
}
{
 const r=interpolateRect({x:0,y:0,width:100,height:50},{x:100,y:10,width:50,height:50},0.5);
 assert(r.x===50&&r.y===5&&r.width===75&&r.height===50,'interpolated midpoint frame');
}
{
 const half={x:0,y:0,width:1280,height:1355};
 assert(travelDuration(120,half,{x:0,y:0,width:1280,height:677})===99,'half -> quarter (678 px) ~0.82x');
 assert(travelDuration(120,half,{x:0,y:0,width:2560,height:1355})===136,'half -> full (1280 px) ~1.13x');
 assert(travelDuration(120,half,{x:3640,y:0,width:1280,height:1355})===162,'monitor crossing clamps to 1.35x');
 assert(travelDuration(0,half,{x:3640,y:0,width:1280,height:1355})===0,'disabled stays disabled');
}
{
 // Frame (with 20 px shadow margin in its buffer) shown at a lagging visual rect.
 const frame={x:100,y:100,width:400,height:300},buffer={x:80,y:80,width:440,height:340};
 const visual={x:300,y:150,width:800,height:600};
 const t=visualTransform(frame,buffer,visual);
 const screen=(lx,ly)=>({x:buffer.x+t.translation_x+lx*t.scale_x,y:buffer.y+t.translation_y+ly*t.scale_y});
 const tl=screen(20,20),br=screen(420,320);
 assert(tl.x===300&&tl.y===150,'frame top-left maps to visual top-left');
 assert(br.x===1100&&br.y===750,'frame bottom-right maps to visual bottom-right');
 const id=visualTransform(frame,buffer,frame);
 assert(id.scale_x===1&&id.scale_y===1&&id.translation_x===0&&id.translation_y===0,'caught-up client needs no transform');
}
{
 assert(easeOutCubic(0)===0&&easeOutCubic(1)===1&&easeOutCubic(2)===1&&Math.abs(easeOutCubic(0.5)-0.875)<1e-9,'ease-out cubic curve');
 const half={x:0,y:0,width:1280,height:1355};
 const a1=anchorFor(half,{x:0,y:0,width:2560,height:1355});
 assert(a1.x===0&&a1.y===0,'left edge fixed: anchor left');
 const a2=anchorFor({x:1280,y:0,width:1280,height:1355},{x:0,y:0,width:2560,height:1355});
 assert(a2.x===1,'right edge fixed: anchor right');
 assert(anchorFor(half,{x:3640,y:249,width:1280,height:1355}).x===0.5,'both edges move: anchor centre');
 const frame={x:100,y:100,width:400,height:300},buffer={x:80,y:80,width:440,height:340};
 const visual={x:100,y:100,width:800,height:300};
 const capped=visualTransform(frame,buffer,visual,{maxStretch:0.06,anchor:{x:0,y:0}});
 assert(Math.abs(capped.scale_x-1.06)<1e-9,'stretch capped at +6%');
 assert(Math.abs(capped.drawn.x-100)<1e-9&&Math.abs(capped.drawn.width-424)<1e-9,'capped image keeps the anchored left edge');
 const right=visualTransform(frame,buffer,visual,{maxStretch:0.06,anchor:{x:1,y:0}});
 assert(Math.abs(right.drawn.x+right.drawn.width-900)<1e-9,'right anchor keeps the visual right edge');
 const still=visualTransform(frame,buffer,visual,{maxStretch:0,anchor:{x:0.5,y:0}});
 assert(still.scale_x===1&&Math.abs(still.drawn.x+200-500)<1e-9,'cap 0 moves only, centred on the visual');
}
function effectsLog(log){return {cover:()=>log.push('cover'),skip:()=>log.push('skip'),uncover:()=>log.push('uncover'),release:()=>log.push('release')};}
// Animation waits for each intermediate frame like a live client would.
function animator(e,w,waitFor,log){return async(from,to,apply)=>{
 log.push('animate');
 for(const t of [0.3,0.7,1]){const r=interpolateRect(from,to,t);apply(r);await waitFor(()=>sameFrame(w.get_frame_rect(),r,0));}
};}
{
 const {e,w,waitFor,areas}=environment({monitor:0});
 const log=[];const target={x:1080,y:249,width:1280,height:1355};
 const r=await placeWindow(w,target,0,{waitFor,both:3,effects:effectsLog(log),animate:animator(e,w,waitFor,log)});
 assert(sameFrame(r.frame,target)&&!r.full,'animated maximized -> left half lands exactly');
 assert(log.join(',')==='cover,skip,uncover,animate,release','cover before unmaximize, released after');
 const widths=e.events.filter(x=>x==='resize-request').length;
 assert(widths===3,'intermediate frames requested; landed target is not re-sent');
}
{
 const {e,w,waitFor,areas}=environment({monitor:0});
 w.maximizedHorizontally=false;w.maximizedVertically=false;w.frame={x:1080,y:249,width:1280,height:1355};
 const log=[];
 const r=await placeWindow(w,areas[0],0,{waitFor,both:3,effects:effectsLog(log),animate:animator(e,w,waitFor,log)});
 assert(r.full&&w.maximizedHorizontally,'animated half -> full maximizes at the end');
 assert(log.join(',')==='uncover,animate,skip,release','half -> full needs no cover; maximize effect skipped');
 assert(e.events.lastIndexOf('resize-acked')<e.events.indexOf('maximize-request'),'maximize only after animated frame fills work area');
}
{
 const {e,w,waitFor,areas}=environment({monitor:0,geometryAssignsMonitor:true});
 w.maximizedHorizontally=false;w.maximizedVertically=false;w.frame={x:1080,y:249,width:1280,height:1355};
 const target={x:0,y:32,width:540,height:1835};const log=[];
 const r=await placeWindow(w,target,2,{waitFor,both:3,effects:effectsLog(log),animate:animator(e,w,waitFor,log)});
 assert(w.monitor===2&&sameFrame(r.frame,target),'animated crossing lands on destination half');
 assert(!e.events.includes('move-request'),'animated crossing sends no late move_to_monitor jump');
}
print(`PASS: ${assertions} delayed placement assertions`);

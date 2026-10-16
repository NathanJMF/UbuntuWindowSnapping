import {placeWindow,sameFrame} from '../placement.js';
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
   e.events.push('resize-request');schedule(resizeDelay,()=>{this.frame={x,y,width:Math.max(minWidth,width),height};if(geometryAssignsMonitor&&e.requestedMonitor!==undefined){this.monitor=e.requestedMonitor;e.events.push('move-acked');}e.events.push('resize-acked');});
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
print(`PASS: ${assertions} delayed placement assertions`);

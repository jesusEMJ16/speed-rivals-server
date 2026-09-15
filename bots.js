'use strict';
// Server-owned racers. Shared decision brain and canonical distance conversion;
// no human client owns a bot, so host departure cannot freeze the other racers.
const Brain=require('./lib/bot-brain'),Core=require('./lib/race-core');
const lanes=[72,180,288],Y=592,styles=Object.keys(Brain.profiles);
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const models=[{car:'clasico',lives:3,vel:1,turbo:1,regen:1,pow:1,steer:1},{car:'tanque',lives:4,vel:.8,turbo:.85,regen:.85,pow:.85,steer:.85},{car:'nitro',lives:2,vel:1.05,turbo:1.6,regen:1.25,pow:1.6,steer:1,heat:true}];
const attackTypes=['oil','cones','rayo','emp','gancho','prisa'];
function create(count,seed,mode){
 return Brain.selectRoster(seed,count).map((entry,i)=>{
  const rng=Brain.random(seed^Math.imul(i+1,0x9e3779b9)),model=models[Math.floor(rng()*models.length)],lives=mode==='subita'?1:model.lives;
  return {id:'bot-'+seed+'-'+i,isBot:true,name:entry.name,language:entry.language,connected:true,ws:null,alive:true,d:0,lane:i%3,x:lanes[i%3],
   loadout:{car:model.car},model,rng,brain:Brain.create(seed+i,styles[i%styles.length],true),elapsed:0,base:70,speed:112,
   lives,maxLives:lives,invuln:0,shield:0,slow:0,attackSlowT:0,attackSlowStrength:.5,lockT:0,trouble:0,heat:0,meter:100,boostT:0,boostIntent:false,
   item:null,itemAge:0,lastBotAttack:-10,obs:[],pickups:[],spawnAcc:0,nextGap:420,coins:0};
 });
}
function receive(b,kind){
 if(!b?.alive||!attackTypes.includes(kind))return false;
 if(b.shield&&['rayo','gancho','prisa'].includes(kind)){b.shield=0;b.invuln=Math.max(b.invuln,.35);return true;}
 if(kind==='oil'||kind==='cones'){
  for(let k=0;k<(kind==='cones'?3:1);k++)b.obs.push({t:kind==='oil'?'oil':'cone',x:lanes[b.lane],y:-170-k*95,w:kind==='oil'?64:26,h:kind==='oil'?38:30});
 }else if(kind==='emp'){b.shield=0;b.boostT=0;b.boostIntent=false;b.meter=Math.min(15,b.meter);b.trouble=Math.max(b.trouble,1);}
 else{b.attackSlowT=Math.max(b.attackSlowT,kind==='rayo'?2.5:kind==='prisa'?3:1.8);b.attackSlowStrength=kind==='rayo'?.5:kind==='prisa'?.45:.55;if(kind==='gancho')b.lockT=Math.max(b.lockT,.4);}
 return true;
}
function spawn(b,mode){
 const lane=Math.floor(b.rng()*3),safe=(lane+1+Math.floor(b.rng()*2))%3;
 for(let l=0;l<3;l++)if(l!==safe&&(l===lane||b.rng()<.55)){
  const oil=b.rng()<.16;b.obs.push({t:oil?'oil':'car',x:lanes[l],y:-90-b.rng()*120,w:oil?64:40,h:oil?38:74,own:oil?0:b.speed*.15});
 }
 if(mode==='normal'&&b.rng()<.3){const pool=[...attackTypes,'shield','shield','vida'];b.pickups.push({kind:'item',item:pool[Math.floor(b.rng()*pool.length)],x:lanes[Math.floor(b.rng()*3)],y:-180});}
}
function tick(b,dt,mode,players,emit){
 if(!b.alive)return;
 b.elapsed+=dt;for(const key of ['invuln','slow','attackSlowT','lockT','trouble'])b[key]=Math.max(0,b[key]-dt);
 if(mode!=='normal'){b.item=null;b.itemAge=0;}else if(b.item)b.itemAge+=dt;
 const rivals=players.filter(p=>p!==b&&p.alive&&p.connected).map(p=>({id:p.id,distance:p.d,shield:p.shield,boostT:p.boostT,alive:true}));
 const decision=Brain.tick(b.brain,dt,{lane:b.lane,x:b.x,y:Y,lanes,width:38,height:66,laneSpd:b.model.steer,speed:b.speed,obstacles:b.obs,pickups:b.pickups,
  meter:b.meter,boostT:b.boostT,heat:b.heat,slow:Math.max(b.slow,b.attackSlowT),trouble:b.trouble,shield:b.shield,lives:b.lives,maxLives:b.maxLives,item:b.item,itemAge:b.itemAge,distance:b.d,rivals});
 if(decision){
  if(!b.lockT)b.lane=decision.lane;b.boostIntent=decision.boost;
  if(decision.useItem&&b.item&&b.elapsed-b.lastBotAttack>=.75){
   const kind=b.item;
   if(kind==='shield'){b.shield=1;b.item=null;}
   else if(kind==='vida'){b.lives=Math.min(b.maxLives,b.lives+1);b.item=null;}
   else if(emit(b,kind,decision.target)){b.item=null;b.lastBotAttack=b.elapsed;}
   if(!b.item)b.itemAge=0;
  }
 }
 const boost=b.boostIntent&&b.meter>0&&!b.trouble;
 b.boostT=clamp(b.boostT+(boost?2:-3)*dt,0,1);b.meter=clamp(b.meter+(boost?-20/b.model.turbo:24*b.model.regen)*dt,0,100);
 if(b.model.heat){b.heat=Math.max(0,b.heat+(boost?dt:-dt));if(b.heat>=2.5){b.heat=0;b.trouble=1.2;b.boostIntent=false;}}
 b.base=Math.min(700*b.model.vel+70,b.base+5*dt);
 const kmh=Math.min(700*b.model.vel+300,b.base+120*b.model.pow*b.boostT)*Math.min(b.slow>0?.6:1,b.attackSlowT>0?b.attackSlowStrength:1)*(b.trouble>0?.65:1);
 b.speed=Core.worldSpeed(kmh);b.d+=b.speed*dt;b.spawnAcc+=b.speed*dt;
 if(b.spawnAcc>=b.nextGap){b.spawnAcc=0;spawn(b,mode);b.nextGap=Math.max(260,b.speed*(.8-.45*clamp(b.elapsed/100,0,1))*(.9+b.rng()*.3));}
 const previousX=b.x;b.x=Core.approach(b.x,lanes[b.lane],14*b.model.steer,dt);
 for(const o of b.obs){const oldY=o.y;o.y+=(b.speed+(o.own||0))*dt;
  if(o.hit||!Core.sweptOverlap(previousX,Y,b.x,Y,32,58,o.x,oldY,o.x,o.y,o.w,o.h))continue;
  if(o.t==='oil'){o.hit=true;b.slow=1.2;}
  else if(!b.invuln){o.hit=true;b.invuln=b.shield?1.4:2;if(b.shield)b.shield=0;else{b.lives--;b.slow=1.3;b.boostIntent=false;if(b.lives<=0){b.alive=false;b.item=null;b.boostT=0;break;}}}
 }
 b.obs=b.obs.filter(o=>o.y<940);
 if(!b.alive)return;
 for(const p of b.pickups){const oldY=p.y;p.y+=b.speed*dt;
  if(!b.item&&Core.sweptOverlap(previousX,Y,b.x,Y,64,92,p.x,oldY,p.x,p.y,0,0)){b.item=p.item;b.itemAge=0;p.taken=true;}
 }
 b.pickups=b.pickups.filter(p=>!p.taken&&p.y<840);
}
function advance(room,until,emit){
 const end=Math.min(until,room.endsAt);let steps=0;
 while(room.botTime<end&&steps++<100){const dt=Math.min(50,end-room.botTime)/1000;
  for(const b of room.players)if(b.isBot)tick(b,dt,room.mode,room.players,emit);
  room.botTime+=dt*1000;
 }
}
module.exports={create,receive,tick,advance};

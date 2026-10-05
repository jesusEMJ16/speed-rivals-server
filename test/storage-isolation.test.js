'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),WS=require('ws');
const {createServer}=require('../server');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=1800,label='condition'){
 const stop=Date.now()+ms;while(Date.now()<stop){const value=fn();if(value)return value;await pause(5);}throw Error('Timed out: '+label);
}
function memoryStorage(){
 let value=null,gate=null;const pending=new Set();
 return {
  async load(){return value&&structuredClone(value);},
  async save(next){const hold=gate;gate=null;if(hold){hold.entered=true;pending.add(hold);try{await hold.promise;}finally{pending.delete(hold);}if(hold.fail)throw Error('Deliberate isolated write failure');}value=structuredClone(next);},
  block(){assert.equal(gate,null);let release;const hold={entered:false,fail:false,promise:new Promise(r=>release=r),release(){release();}};gate=hold;return hold;},
  releaseAll(){if(gate){gate.release();gate=null;}for(const hold of pending)hold.release();},
  get value(){return value;}
 };
}
async function boot(t,options={}){
 const storage=memoryStorage(),sockets=[];
 const app=createServer({port:0,host:'127.0.0.1',redis:null,storage,countdownMs:15,durationMs:2000,queueWaitMs:20,tickMs:10,storageRetryMs:20,...options});await app.ready;
 t.after(async()=>{storage.releaseAll();for(const ws of sockets)ws.terminate();await app.close();});
 async function socket(){
  const ws=new WS('ws://127.0.0.1:'+app.address().port),inbox=[];sockets.push(ws);ws.on('message',raw=>inbox.push(JSON.parse(raw)));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  return {ws,inbox,send:m=>ws.send(JSON.stringify(m)),async read(type,pred=()=>true,ms=1800){return until(()=>{const i=inbox.findIndex(m=>m.type===type&&pred(m));return i<0?null:inbox.splice(i,1)[0];},ms,type);}};
 }
 async function guest(name,token){const s=await socket();s.send({type:'hello',protocol:2,name,token});s.welcome=await s.read('welcome');return s;}
 async function pair(name,{priv=true}={}){const a=await guest(name+' A'),b=await guest(name+' B');a.send({type:'create',mode:'normal',priv});const {code}=await a.read('created');b.send({type:'joinroom',code});await b.read('joined');a.send({type:'startRace'});const start=await a.read('start');await b.read('start');await until(()=>Date.now()>=start.startAt);return {a,b,code,start};}
 return {app,storage,socket,guest,pair};
}
async function blockedHello(env){const hold=env.storage.block(),slow=await env.socket();slow.send({type:'hello',protocol:2,name:'Slow profile'});await until(()=>hold.entered);return {hold,slow};}

test('a ping responds while another guest save is blocked',async t=>{
 const env=await boot(t),a=await env.guest('Active');await blockedHello(env);
 a.send({type:'ping',sentAt:123});assert.equal((await a.read('pong',m=>m.sentAt===123,300)).sentAt,123);
});

test('human state is accepted while another guest save is blocked',async t=>{
 const env=await boot(t),{a,code,start}=await env.pair('Live');await blockedHello(env);
 a.send({type:'st',matchId:start.matchId,seq:1,d:25,lane:0,alive:true});
 await until(()=>env.app.rooms.get(code).players.find(p=>p.id===a.welcome.id).d===25,300,'human distance accepted');
});

test('server bots advance while another guest save is blocked',async t=>{
 const env=await boot(t),a=await env.guest('Human');a.send({type:'joinpub'});const {code}=await a.read('joined');const start=await a.read('start');
 await until(()=>Date.now()>=start.startAt);const R=env.app.rooms.get(code);await until(()=>R.botTime>R.startAt);await blockedHello(env);const before=R.botTime;
 await until(()=>R.botTime>=before+100,400,'bot simulation advanced');assert(R.players.some(p=>p.isBot&&p.d>0));
});

test('another room accepts state and finishes simulation while the first result save is blocked',async t=>{
 const env=await boot(t),first=await env.pair('First'),second=await env.pair('Second'),hold=env.storage.block();
 for(const s of [first.a,first.b])s.send({type:'st',matchId:first.start.matchId,seq:1,d:10,lane:1,alive:false});await until(()=>hold.entered);
 second.a.send({type:'st',matchId:second.start.matchId,seq:1,d:30,lane:0,alive:false});second.b.send({type:'st',matchId:second.start.matchId,seq:1,d:5,lane:1,alive:false});
 const R=env.app.rooms.get(second.code);await until(()=>R.players.find(p=>p.id===second.a.welcome.id).d===30,300,'second room state');
 await until(()=>R.finishing,300,'second room result queued');assert.equal(second.a.inbox.some(m=>m.type==='end'),false,'saved results wait for their ordered commit');
 hold.release();await first.a.read('end');const end=await second.a.read('end');assert.equal(end.rank[0].id,second.a.welcome.id);assert.equal(end.rank[0].d,30);
});

test('a deadline with more than five seconds of bot backlog completes bounded catch-up before saving',async t=>{
 const env=await boot(t,{durationMs:6500}),a=await env.guest('Deadline');a.send({type:'joinpub'});const {code}=await a.read('joined');await a.read('start');const R=env.app.rooms.get(code);
 // Reproduce a delayed first tick without stalling the test process or wall clock.
 R.startAt=Date.now()-6500;R.endsAt=R.startAt+6500;R.botTime=R.startAt;
 const end=await a.read('end');assert.equal(R.botTime,R.endsAt,'all race time must be simulated before standings freeze');assert.equal(end.saved,true);
});

test('concurrent profile updates and two pending finishes retain every change and award CP once',async t=>{
 const env=await boot(t),first=await env.pair('One',{priv:false}),second=await env.pair('Two',{priv:false});const {hold,slow}=await blockedHello(env);
 first.a.send({type:'stats',name:'Renamed racer'});second.a.send({type:'score',mode:'normal',km:1,time:40});
 for(const pair of [first,second]){pair.a.send({type:'st',matchId:pair.start.matchId,seq:1,d:20,lane:1,alive:false});pair.b.send({type:'st',matchId:pair.start.matchId,seq:1,d:5,lane:1,alive:false});}
 await until(()=>env.app.rooms.get(second.code).players.find(p=>p.id===second.a.welcome.id).d===20,300,'concurrent live state');hold.release();await slow.read('welcome');
 const ends=await Promise.all([first.a.read('end'),second.a.read('end')]);await until(()=>env.storage.value.profiles[first.a.welcome.id].name==='Renamed racer'&&env.storage.value.profiles[second.a.welcome.id].best1p===1000);
 assert.equal(Object.keys(env.storage.value.profiles).length,5);assert.equal(Object.keys(env.storage.value.matches).length,2);
 for(const pair of [first,second]){const p=env.storage.value.profiles[pair.a.welcome.id];assert.equal(p.cp,40);assert.equal(p.races,1);assert.equal(p.wins,1);assert.equal(env.storage.value.profiles[pair.b.welcome.id].cp,25);}
 const again=await env.guest('Renamed racer',first.a.welcome.token);assert.equal((await again.read('end')).matchId,ends[0].matchId);assert.equal(again.welcome.profile.races,1);
});

test('failed pending results freeze ranks, fail readiness closed, and recover without duplicate CP',async t=>{
 const env=await boot(t),{a,b,code,start}=await env.pair('Recovery',{priv:false}),hold=env.storage.block();hold.fail=true;
 a.send({type:'st',matchId:start.matchId,seq:1,d:20,lane:0,alive:false});b.send({type:'st',matchId:start.matchId,seq:1,d:5,lane:1,alive:false});await until(()=>hold.entered);
 b.send({type:'leave'});await b.read('left',()=>true,300);a.send({type:'st',matchId:start.matchId,seq:2,d:100,lane:0,alive:false});assert.equal((await a.read('err',()=>true,300)).code,'INVALID_STATE');
 const recovery=env.storage.block();hold.release();await a.read('err',m=>m.code==='STORAGE_UNAVAILABLE');assert.equal(a.inbox.some(m=>m.type==='end'),false);await until(()=>recovery.entered);
 assert.equal((await fetch('http://127.0.0.1:'+env.app.address().port+'/ready')).status,503);recovery.release();
 const end=await a.read('end');assert.equal(end.rank.find(p=>p.id===a.welcome.id).d,20);assert.equal(end.rank.find(p=>p.id===b.welcome.id).d,5);assert.equal(end.saved,true);
 const value=env.storage.value;assert.equal(value.profiles[a.welcome.id].races,1);assert.equal(value.profiles[a.welcome.id].cp,40);assert.equal(Object.keys(value.matches).length,1);assert.equal(env.app.rooms.get(code).racing,false);
});

test('a socket keeps hello before matchmaking while its ping bypasses its pending authentication save',async t=>{
 const env=await boot(t),hold=env.storage.block(),s=await env.socket();s.send({type:'hello',protocol:2,name:'Queued authentication'});s.send({type:'joinpub',mode:'subita'});await until(()=>hold.entered);
 s.send({type:'ping',sentAt:456});assert.equal((await s.read('pong',m=>m.sentAt===456,300)).sentAt,456);assert.equal(s.inbox.some(m=>m.type==='joined'||m.code==='AUTH_REQUIRED'),false);
 hold.release();await s.read('welcome');await s.read('joined');assert.equal(s.inbox.some(m=>m.code==='AUTH_REQUIRED'),false);
});

test('shutdown awaits accepted socket commands and both pending room saves',async t=>{
 const env=await boot(t),first=await env.pair('Shutdown one',{priv:false}),second=await env.pair('Shutdown two',{priv:false}),{hold,slow}=await blockedHello(env);
 first.a.send({type:'stats',name:'Saved before shutdown'});second.a.send({type:'score',mode:'subita',km:.5,time:30});
 for(const pair of [first,second])for(const s of [pair.a,pair.b])s.send({type:'st',matchId:pair.start.matchId,seq:1,d:5,lane:1,alive:false});
 await until(()=>env.app.rooms.get(first.code).finishing&&env.app.rooms.get(second.code).finishing);
 let closed=false;const close=env.app.close().then(()=>closed=true);await pause(25);assert.equal(closed,false,'shutdown must await the in-flight write');
 hold.release();await close;assert.equal(Object.keys(env.storage.value.profiles).length,5);assert.equal(Object.keys(env.storage.value.matches).length,2);
 assert.equal(env.storage.value.profiles[first.a.welcome.id].name,'Saved before shutdown');assert.equal(env.storage.value.profiles[second.a.welcome.id].bestSub,500);
 for(const pair of [first,second])for(const s of [pair.a,pair.b])assert.equal(env.storage.value.profiles[s.welcome.id].races,1);
 assert.equal(slow.ws.readyState,WS.CLOSED);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const WS=require('ws'),{createServer}=require('../server');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),CP=[40,25,15,8,0,-8,-15,-22,-30];
function seeded(cps){
 const data={version:2,profiles:{},tokens:{},matches:{},updatedAt:123},tokens=[];
 cps.forEach((cp,i)=>{const id='friendly-'+i,token=crypto.randomBytes(32).toString('base64url');tokens.push(token);data.tokens[crypto.createHash('sha256').update(token).digest('hex')]=id;data.profiles[id]={id,name:'Pilot '+i,cp,races:7,wins:3,bestVs:1,best1p:123,bestSub:50,bestSup:80};});return {data,tokens};
}
async function boot(t,cps=[100,50],opts={}){
 const {prepare,...serverOptions}=opts,seed=seeded(cps);prepare?.(seed.data);let value=structuredClone(seed.data),failNextResult=false;
 const storage={async load(){return structuredClone(value)},async save(v){if(failNextResult&&Object.keys(v.matches).length>Object.keys(value.matches).length){failNextResult=false;throw Error('local deliberate failure');}value=structuredClone(v);}};
 const app=createServer({port:0,host:'127.0.0.1',storage,countdownMs:20,durationMs:1000,tickMs:5,disconnectGraceMs:1000,storageRetryMs:20,...serverOptions});await app.ready;t.after(()=>app.close());
 return {app,url:'ws://127.0.0.1:'+app.address().port,tokens:seed.tokens,before:seed.data,storage,getData:()=>value,failResult:()=>failNextResult=true};
}
async function guest(t,url,index,token){const ws=new WS(url),inbox=[];ws.on('message',raw=>inbox.push(JSON.parse(raw)));await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});t.after(()=>ws.terminate());
 const s={ws,inbox,send:m=>ws.send(JSON.stringify(m)),async read(type,pred=()=>true){const end=Date.now()+2500;while(Date.now()<end){const i=inbox.findIndex(m=>m.type===type&&pred(m));if(i>=0)return inbox.splice(i,1)[0];await pause(5);}throw Error('Missing '+type);}};s.send({type:'hello',protocol:2,name:'Pilot '+index,token});s.welcome=await s.read('welcome');return s;
}
async function manual(t,env,priv=true){const drivers=[];for(let i=0;i<env.tokens.length;i++)drivers.push(await guest(t,env.url,i,env.tokens[i]));const host=drivers[0];host.send({type:'create',priv,mode:'normal'});const {code}=await host.read('created');for(const d of drivers.slice(1)){d.send({type:'joinroom',code});await d.read('joined');}return {drivers,host,code};}
async function run(drivers,zero=false){drivers[0].send({type:'startRace'});const starts=await Promise.all(drivers.map(d=>d.read('start')));for(const s of starts)assert.deepEqual(s,starts[0]);await pause(30);for(const [i,d] of drivers.entries())d.send({type:'st',matchId:starts[0].matchId,seq:1,d:zero?0:90-i*10,lane:i%3,alive:false});const ends=await Promise.all(drivers.map(d=>d.read('end')));for(const e of ends)assert.deepEqual(e,ends[0]);return {start:starts[0],end:ends[0]};}
function official(p){const {cp,races,wins,bestVs,best1p,bestSub,bestSup}=p;return {cp,races,wins,bestVs,best1p,bestSub,bestSup};}

test('three private zero-metre races cannot inflate CP or official race statistics',async t=>{
 const env=await boot(t,[0,0]),{drivers}=await manual(t,env);
 for(let i=0;i<3;i++){const {end}=await run(drivers,true);assert(end.rank.every(p=>p.cpDelta===0),'zero-distance private matches must award no CP');assert.equal(end.ranked,false);}
 for(const [id,p] of Object.entries(env.getData().profiles))assert.deepEqual(official(p),official(env.before.profiles[id]));assert.equal(Object.keys(env.getData().matches).length,3);
});
test('private two-person match retains official values, publishes friendly status and preserves positional XP',async t=>{
 const env=await boot(t),{drivers,code}=await manual(t,env);assert.equal(drivers[0].welcome.features?.privateFriendly,true,'welcome advertises friendly private rooms before their creation');const lobby=await drivers[0].read('room',m=>m.p.length===2);assert.equal(lobby.ranked,false);const {start,end}=await run(drivers);assert.equal(start.ranked,false);assert.equal(end.ranked,false);assert.equal(end.saved,true);
 assert.deepEqual(end.rank.map(p=>({cp:p.cpTotal,delta:p.cpDelta,xp:p.passXpDelta})),[{cp:100,delta:0,xp:360},{cp:50,delta:0,xp:225}]);assert.equal(env.app.rooms.get(code).ranked,false);
 for(const [id,p] of Object.entries(env.getData().profiles)){assert.deepEqual(official(p),official(env.before.profiles[id]));assert.equal(p.lastMatchId,end.matchId);}
});
test('private nine-person standings preserve CP including old negative positions and XP respects the CP ceiling',async t=>{
 const cps=[999999995,50,50,50,50,50,50,50,50],env=await boot(t,cps),{drivers}=await manual(t,env),{end}=await run(drivers);
 assert.equal(end.ranked,false);assert.deepEqual(end.rank.map(p=>p.cpDelta),Array(9).fill(0));assert.deepEqual(end.rank.map(p=>p.cpTotal),cps);assert.deepEqual(end.rank.map(p=>p.passXpDelta),[45,225,135,72,0,0,0,0,0]);
 for(const [id,p] of Object.entries(env.getData().profiles))assert.deepEqual(official(p),official(env.before.profiles[id]));
});
test('public manual two-person race keeps CP statistics and the existing capped XP reward',async t=>{
 const env=await boot(t,[999999995,50]),{drivers}=await manual(t,env,false);const lobby=await drivers[0].read('room',m=>m.p.length===2);assert.equal(lobby.ranked,true);const {start,end}=await run(drivers);assert.equal(start.ranked,true);assert.equal(end.ranked,true);assert.deepEqual(end.rank.map(p=>p.cpDelta),[5,25]);assert.deepEqual(end.rank.map(p=>p.passXpDelta),[45,225]);
 assert.equal(env.getData().profiles['friendly-0'].cp,1e9);assert.equal(env.getData().profiles['friendly-0'].races,8);assert.equal(env.getData().profiles['friendly-0'].wins,4);assert.equal(env.getData().profiles['friendly-0'].bestVs,90*.03);assert.equal(env.getData().profiles['friendly-1'].races,8);
});
test('VS9 automatic queue stays ranked and computes XP from each effective CP delta',async t=>{
 const env=await boot(t,[100,50],{queueWaitMs:30,durationMs:100}),drivers=[];for(let i=0;i<2;i++)drivers.push(await guest(t,env.url,i,env.tokens[i]));for(const d of drivers){d.send({type:'joinpub',mode:'normal'});await d.read('joined');}const start=await drivers[0].read('start');assert.equal(start.ranked,true);const end=await drivers[0].read('end');assert.equal(end.ranked,true);assert.equal(end.rank.length,9);
 end.rank.forEach((p,i)=>{if(p.id.startsWith('bot-')){assert.equal(p.cpDelta,0);assert.equal(p.passXpDelta,0);}else {const before=env.before.profiles[p.id].cp;assert.equal(p.cpTotal,Math.max(0,Math.min(1e9,before+CP[i])));assert.equal(p.passXpDelta,Math.max(0,p.cpDelta)*9);assert.equal(env.getData().profiles[p.id].races,8);}});
});
test('privacy changes in the lobby determine the next race and cannot change a started race',async t=>{
 const env=await boot(t),{drivers,host}=await manual(t,env,false);host.send({type:'setpriv',priv:true});assert.equal((await host.read('room',m=>m.priv===true)).ranked,false);host.send({type:'startRace'});const start=await host.read('start');await drivers[1].read('start');assert.equal(start.ranked,false);host.send({type:'setpriv',priv:false});assert.equal((await host.read('err')).code,'RACE_ACTIVE');await pause(30);for(const d of drivers)d.send({type:'st',matchId:start.matchId,seq:1,d:0,lane:0,alive:false});const end=await host.read('end');await drivers[1].read('end');assert.equal(end.ranked,false);
 host.send({type:'setpriv',priv:false});assert.equal((await host.read('room',m=>m.priv===false)).ranked,true);const publicResult=await run(drivers);assert.equal(publicResult.end.ranked,true);assert.equal(publicResult.end.rank.reduce((n,p)=>n+p.cpDelta,0),65);
});
test('private durable retry and reconnection replay one friendly receipt without changing existing statistics',async t=>{
 const env=await boot(t),{drivers}=await manual(t,env);drivers[0].send({type:'startRace'});const start=await drivers[0].read('start');await drivers[1].read('start');await pause(30);env.failResult();for(const d of drivers)d.send({type:'st',matchId:start.matchId,seq:1,d:90,lane:0,alive:false});assert.equal((await drivers[0].read('err')).code,'STORAGE_UNAVAILABLE');assert.equal(drivers[0].inbox.some(m=>m.type==='end'),false);const end=await drivers[0].read('end');assert.equal(end.ranked,false);await drivers[1].read('end');
 drivers[0].ws.terminate();await pause(20);const again=await guest(t,env.url,0,env.tokens[0]);assert.deepEqual(await again.read('end'),end);assert.deepEqual(official(env.getData().profiles['friendly-0']),official(env.before.profiles['friendly-0']));assert.equal(Object.keys(env.getData().matches).length,1);
 await env.app.close();const second=createServer({port:0,host:'127.0.0.1',storage:env.storage,tickMs:5});await second.ready;t.after(()=>second.close());const returned=await guest(t,'ws://127.0.0.1:'+second.address().port,0,env.tokens[0]);assert.deepEqual(await returned.read('end'),end);assert.equal(returned.welcome.profile.cp,100);assert.equal(returned.welcome.profile.races,7);
});
test('old competitive receipts and accumulated profile data survive unchanged without retrospective migration',async t=>{
 const old={type:'end',matchId:'old-match',rank:[{id:'friendly-0',name:'Pilot 0',d:10,cpDelta:40,cpTotal:100}],roomRank:[{id:'friendly-0',name:'Pilot 0',cp:100}],serverTime:100,saved:true};
 const env=await boot(t,[100,50],{prepare(data){data.matches[old.matchId]=structuredClone(old);data.profiles['friendly-0'].lastMatchId=old.matchId;}}),{drivers}=await manual(t,env);
 assert.deepEqual(await drivers[0].read('end'),old);assert.deepEqual(env.getData(),env.before,'startup and existing identity hello must not migrate stored results');const {end}=await run(drivers);
 assert.equal(end.ranked,false);assert.deepEqual(env.getData().matches[old.matchId],old);assert.equal(env.getData().profiles['friendly-0'].cp,100);assert.equal(env.getData().profiles['friendly-0'].races,7);assert.equal(env.getData().profiles['friendly-0'].lastMatchId,end.matchId);
});

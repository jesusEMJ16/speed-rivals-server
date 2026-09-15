'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const WebSocket=require('ws');
const {createServer,cleanName}=require('../server');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function boot(t,opts={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-v2-'));
 const app=createServer({port:0,host:'127.0.0.1',dataFile:path.join(dir,'v2.json'),redis:null,countdownMs:25,durationMs:2000,tickMs:10,disconnectGraceMs:70,pickupCooldownMs:30,attackCooldownMs:20,...opts});
 await app.ready;
 t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {app,url:'ws://127.0.0.1:'+app.address().port,dir};
}
async function socket(url){
 const ws=new WebSocket(url),inbox=[];ws.on('message',x=>inbox.push(JSON.parse(x)));
 await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});
 return {ws,inbox,send:m=>ws.send(JSON.stringify(m)),async read(type,pred=()=>true){
  const deadline=Date.now()+1600;while(Date.now()<deadline){const i=inbox.findIndex(m=>m.type===type&&pred(m));if(i>=0)return inbox.splice(i,1)[0];await pause(5);}throw Error('Missing '+type+'; received '+JSON.stringify(inbox));
 }};
}
async function guest(url,name='Guest',token){const s=await socket(url);s.send({type:'hello',protocol:2,name,token});s.welcome=await s.read('welcome');return s;}
async function pair(url){const a=await guest(url,'阿娜'),b=await guest(url,'Jesús');a.send({type:'create',roomName:'Team',priv:true,mode:'normal'});const {code}=await a.read('created');b.send({type:'joinroom',code});await b.read('joined');return {a,b,code};}
async function start(a,b){a.send({type:'startRace'});const m=await a.read('start');assert.deepEqual(await b.read('start'),m);await pause(35);return m;}
test('Unicode names survive and no v1 ranking writes are permitted',async t=>{
 assert.equal(cleanName('  Jesús 東京  '),'Jesús 東京');
 const {url}=await boot(t),s=await socket(url);s.send({type:'stats',cp:999999});assert.equal((await s.read('err')).code,'AUTH_REQUIRED');
 s.send({type:'hello',protocol:1});assert.equal((await s.read('err')).code,'INVALID_VERSION');
 s.send({type:'hello',protocol:2,name:'東京'});const w=await s.read('welcome');assert.equal(w.profile.name,'東京');
 s.send({type:'stats',name:'Renée',cp:99999,bestVs:999999});await s.read('profiles');s.send({type:'score',km:999});assert.equal((await s.read('err')).code,'INVALID_STATE');
 s.send({type:'getstats'});const p=(await s.read('profiles')).profiles.find(p=>p.id===w.id);assert.equal(p.cp,0);assert.equal(p.bestVs,0);assert.equal(p.name,'Renée');
});
test('nine real humans start one clock and tenth waits; modes have distinct queues',async t=>{
 const {url,app}=await boot(t),all=[];
 for(let i=0;i<10;i++){const s=await guest(url,'P'+i);all.push(s);s.send({type:'joinpub',mode:'normal'});s.joined=await s.read('joined');}
 const starts=await Promise.all(all.slice(0,9).map(s=>s.read('start')));for(const m of starts)assert.deepEqual(m,starts[0]);assert.equal(starts[0].endsAt-starts[0].startAt,2000);
 assert.notEqual(all[9].joined.code,all[0].joined.code);assert.equal(app.rooms.get(all[0].joined.code).players.length,9);
 const other=await guest(url);other.send({type:'joinpub',mode:'subita'});assert.notEqual((await other.read('joined')).code,all[9].joined.code);
});
test('manual room host controls, listing, cancellation, and late joins',async t=>{
 const {url}=await boot(t),{a,b,code}=await pair(url),c=await guest(url);
 c.send({type:'list'});assert.equal((await c.read('rooms')).rooms.length,0);
 b.send({type:'setpriv',priv:false});assert.equal((await b.read('err')).code,'NOT_HOST');a.send({type:'setpriv',priv:false});await a.read('room',m=>m.priv===false);
 c.send({type:'list'});assert.equal((await c.read('rooms')).rooms[0].code,code);
 const m=await start(a,b);c.send({type:'joinroom',code});assert.equal((await c.read('err')).code,'RACE_ACTIVE');
 a.send({type:'leave'});await a.read('left');b.send({type:'st',matchId:m.matchId,seq:1,d:0,lane:1,alive:false});const end=await b.read('end');assert.equal(end.rank.length,2);
});
test('authoritative state, inventory, complete ranking, and exactly-once persistence across restart',async t=>{
 const {url,app,dir}=await boot(t),{a,b}=await pair(url),m=await start(a,b);
 a.send({type:'st',matchId:m.matchId,seq:1,d:1e9,lane:1,alive:true});assert.equal((await a.read('err')).code,'INVALID_STATE');
 a.send({type:'atk',matchId:m.matchId,seq:2,kind:'rayo'});assert.equal((await a.read('err')).code,'INVALID_STATE');
 a.send({type:'pickup',matchId:m.matchId,seq:3,kind:'rayo'});assert.equal((await a.read('inventory')).item,'rayo');
 a.send({type:'atk',matchId:m.matchId,seq:4,kind:'rayo',from:b.welcome.id});assert.equal((await b.read('atk')).from,a.welcome.id);
 a.send({type:'atk',matchId:m.matchId,seq:5,kind:'rayo'});assert.equal((await a.read('err')).code,'INVALID_STATE');
 a.send({type:'st',matchId:m.matchId,seq:6,d:10,lane:0,alive:false});await pause(15);
 a.send({type:'st',matchId:m.matchId,seq:7,d:20,lane:0,alive:true});assert.equal((await a.read('err')).code,'INVALID_STATE');
 b.send({type:'st',matchId:m.matchId,seq:1,d:5,lane:1,alive:false});const ea=await a.read('end'),eb=await b.read('end');assert.deepEqual(ea,eb);assert.equal(ea.rank[0].id,a.welcome.id);assert.equal(ea.rank[1].cpTotal,25);assert.equal(ea.saved,true);
 a.send({type:'st',matchId:m.matchId,seq:8,d:40,lane:0,alive:false});assert.equal((await a.read('err')).code,'INVALID_STATE');
 await app.close();const second=await boot(t,{dataFile:path.join(dir,'v2.json')});const again=await guest(second.url,'阿娜',a.welcome.token);
 assert.equal(again.welcome.id,a.welcome.id);assert.equal(again.welcome.profile.cp,40);assert.equal(again.welcome.profile.races,1);assert.equal((await again.read('end')).matchId,m.matchId);
});
test('disconnect retains standings and reconnect is a spectator without duplicate racers',async t=>{
 const {url,app}=await boot(t),{a,b,code}=await pair(url),m=await start(a,b);a.ws.terminate();await pause(15);
 const again=await guest(url,'阿娜',a.welcome.token);const room=await again.read('room');assert.equal(room.spectating,true);assert.equal(room.p.length,2);assert.equal(room.p.find(p=>p.id===again.welcome.id).alive,false);
 again.send({type:'st',matchId:m.matchId,seq:1,d:200,lane:1,alive:true});assert.equal((await again.read('err')).code,'INVALID_STATE');
 b.send({type:'st',matchId:m.matchId,seq:1,d:1,lane:1,alive:false});assert.equal((await again.read('end')).rank.length,2);assert.equal(app.rooms.get(code).players.length,2);
});
test('failed durable commit sends no saved result and readiness fails closed until retry',async t=>{
 let fail=false,value=null;const storage={async load(){return value;},async save(v){if(fail)throw Error('disk unavailable');value=structuredClone(v);}};
 const {url,app}=await boot(t,{storage}),{a,b}=await pair(url),m=await start(a,b);fail=true;
 a.send({type:'st',matchId:m.matchId,seq:1,d:0,lane:1,alive:false});b.send({type:'st',matchId:m.matchId,seq:1,d:0,lane:1,alive:false});assert.equal((await a.read('err')).code,'STORAGE_UNAVAILABLE');assert.equal(a.inbox.some(m=>m.type==='end'),false);
 assert.equal((await fetch('http://127.0.0.1:'+app.address().port+'/ready')).status,503);fail=false;
 const e=await a.read('end');assert.equal(e.saved,true);assert.equal(e.rank[0].cpTotal,40);assert.equal(value.profiles[a.welcome.id].races,1);
});
test('leaving an unfinished race cannot mutate retained standings by joining a new lobby',async t=>{
 const {url}=await boot(t),{a,b}=await pair(url),m=await start(a,b);
 a.send({type:'st',matchId:m.matchId,seq:1,d:10,lane:1,alive:true});await pause(10);a.send({type:'leave'});await a.read('left');
 a.send({type:'create',mode:'normal'});assert.equal((await a.read('err')).code,'RACE_ACTIVE');
 b.send({type:'st',matchId:m.matchId,seq:1,d:1,lane:1,alive:false});const end=await b.read('end');assert.equal(end.rank.find(p=>p.id===a.welcome.id).d,10);
});
test('duplicate sequences, reverse distances, invalid lanes, and wrong match IDs fail',async t=>{
 const {url}=await boot(t),{a,b}=await pair(url),m=await start(a,b);
 a.send({type:'st',matchId:m.matchId,seq:1,d:10,lane:1,alive:true});await pause(10);
 for(const extra of [{seq:1,d:11},{seq:2,d:0},{seq:3,lane:9},{seq:4,matchId:'other'}]){a.send({type:'st',matchId:m.matchId,seq:1,d:10,lane:1,alive:true,...extra});assert.equal((await a.read('err')).code,'INVALID_STATE');}
 a.send({type:'pickup',matchId:m.matchId,seq:5,kind:'oil'});await a.read('inventory');a.send({type:'pickup',matchId:m.matchId,seq:6,kind:'emp'});assert.equal((await a.read('err')).code,'INVALID_STATE');
 a.send({type:'atk',matchId:m.matchId,seq:7,kind:'oil'});await b.read('atk');a.send({type:'atk',matchId:m.matchId,seq:7,kind:'oil'});assert.equal((await a.read('err')).code,'INVALID_STATE');
});
test('host transfers on disconnect and lobby slots expire after grace',async t=>{
 const {url,app}=await boot(t),{a,b,code}=await pair(url);a.ws.terminate();const room=await b.read('room',r=>r.host===b.welcome.id);assert.equal(room.p.length,2);await pause(110);assert.equal(app.rooms.get(code).players.length,1);
 b.send({type:'startRace'});assert.equal((await b.read('err')).code,'INVALID_STATE');b.send({type:'leave'});await b.read('left');assert.equal(app.rooms.size,0);
});
test('server deadline finishes all connected live racers without client finish messages',async t=>{
 const {url}=await boot(t,{durationMs:90}),{a,b}=await pair(url),m=await start(a,b);const e=await a.read('end');assert.equal(e.matchId,m.matchId);assert.equal(e.rank.length,2);assert.ok(e.serverTime>=m.endsAt);
});
test('production without configured durable storage and corrupt storage fail readiness',async t=>{
 for(const opts of [{production:true,redis:null,dataFile:undefined},{storage:{async load(){return {version:1};},async save(){throw Error('must not overwrite corrupt data');}}}]){
  const app=createServer({port:0,host:'127.0.0.1',...opts});t.after(()=>app.close());await assert.rejects(app.ready);while(!app.address())await pause(5);
  assert.equal((await fetch('http://127.0.0.1:'+app.address().port+'/ready')).status,503);assert.equal((await fetch('http://127.0.0.1:'+app.address().port+'/health')).status,200);
 }
});
test('invite landing safely exposes a code and only configured web link',async t=>{
 const {app}=await boot(t,{webPlayUrl:'https://example.test/play?x="<bad>"'}),base='http://127.0.0.1:'+app.address().port;
 const res=await fetch(base+'/invite/AB12CD'),html=await res.text();assert.equal(res.status,200);assert.match(html,/AB12CD/);assert.match(html,/room=AB12CD/);assert.doesNotMatch(html,/<bad>/);assert.ok(res.headers.get('content-security-policy'));assert.equal((await fetch(base+'/invite/%3Cscript%3E')).status,404);
});
test('reconnect after offline finish replays saved result even while lobby slot is retained',async t=>{
 const {url}=await boot(t,{durationMs:80,disconnectGraceMs:1000}),{a,b}=await pair(url),m=await start(a,b);a.ws.terminate();await b.read('end');
 const again=await guest(url,'阿娜',a.welcome.token);assert.equal((await again.read('end')).matchId,m.matchId);assert.equal(again.welcome.profile.races,1);
});
test('Upstash adapter writes one separate v2 key and leaves historical keys alone',async t=>{
 const rows=new Map([['sr:rank',[{name:'Legacy',km:99}]],['sr:prof',[{name:'Legacy',cp:999}]]]);const calls=[];
 const redis={async get(key){calls.push(['get',key]);return rows.get(key)??null;},async set(key,v){calls.push(['set',key]);rows.set(key,structuredClone(v));}};
 const {url}=await boot(t,{redis});const a=await guest(url);assert.equal(a.welcome.profile.cp,0);assert.ok(calls.every(c=>c[1]==='sr:v2:state'));assert.equal(rows.get('sr:prof')[0].cp,999);
});
test('loadout accepts only bounded owner metadata and cannot alter race power or opponents',async t=>{
 const {url}=await boot(t),{a,b}=await pair(url),m=await start(a,b);
 a.send({type:'loadout',car:'nitro',llanta:'ll_est',gadget:null,abil:'ab_vel',id:b.welcome.id,cp:999999,alive:false,item:'emp'});
 const room=await b.read('room',r=>r.p.find(p=>p.id===a.welcome.id)?.car==='nitro'),own=room.p.find(p=>p.id===a.welcome.id),other=room.p.find(p=>p.id===b.welcome.id);
 assert.equal(own.llanta,'ll_est');assert.equal(own.abil,'ab_vel');assert.equal(own.gadget,null);assert.equal(own.cp,0);assert.equal(own.alive,true);assert.equal(other.car,null);
 for(const car of ['x'.repeat(33),'<script>',{power:999},100]){a.send({type:'loadout',car});assert.equal((await a.read('err')).code,'INVALID_STATE');}
 a.send({type:'atk',matchId:m.matchId,seq:1,kind:'emp'});assert.equal((await a.read('err')).code,'INVALID_STATE');
});
test('unchanged guest hello and redundant stats reuse already durable profiles without more writes',async t=>{
 let writes=0,value=null;const storage={async load(){return value;},async save(v){writes++;value=structuredClone(v);}};
 const {url}=await boot(t,{storage}),a=await guest(url,'Renée');const afterGuest=writes;
 for(let i=0;i<4;i++){a.send({type:'stats',name:'Renée',cp:999999,bestVs:999999});const p=(await a.read('profiles')).profiles.find(p=>p.id===a.welcome.id);assert.equal(p.cp,0);assert.equal(p.bestVs,0);}
 assert.equal(writes,afterGuest);a.ws.terminate();await pause(10);const again=await guest(url,'Renée',a.welcome.token);assert.equal(again.welcome.id,a.welcome.id);assert.equal(writes,afterGuest);
 again.send({type:'stats',name:'東京'});assert.equal((await again.read('profiles')).profiles.find(p=>p.id===a.welcome.id).name,'東京');assert.equal(writes,afterGuest+1);
});
test('bundled play serves only explicit public files and invitation defaults to the bundled game',async t=>{
 const publicDir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-public-'));t.after(()=>fs.rmSync(publicDir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(publicDir,'index.html'),'<!doctype html><h1>Bundled game</h1>');fs.writeFileSync(path.join(publicDir,'privacy.html'),'<h1>Privacy</h1>');fs.writeFileSync(path.join(publicDir,'noto-latin-OFL.txt'),'Font license');fs.writeFileSync(path.join(publicDir,'private.json'),'SECRET');fs.writeFileSync(path.join(publicDir,'unknown-OFL.txt'),'SECRET');
 const {app}=await boot(t,{publicDir}),base='http://127.0.0.1:'+app.address().port;
 const game=await fetch(base+'/play/?room=ABC123');assert.equal(game.status,200);assert.match(game.headers.get('content-type'),/text\/html/);assert.equal(game.headers.get('x-content-type-options'),'nosniff');assert.equal(game.headers.get('x-frame-options'),null);assert.match(await game.text(),/Bundled game/);
 assert.equal((await fetch(base+'/play/privacy.html')).status,200);const license=await fetch(base+'/play/noto-latin-OFL.txt');assert.equal(license.status,200);assert.match(license.headers.get('content-type'),/text\/plain/);
 for(const p of ['/play/private.json','/play/unknown-OFL.txt','/play/../server.js','/play/%2e%2e%2fserver.js','/play/%2findex.html','/play/noto-chinese-OFL.txt'])assert.equal((await fetch(base+p)).status,404,p);
 assert.equal((await fetch(base+'/play/',{method:'POST'})).status,405);const invite=await(await fetch(base+'/invite/ABC123')).text();assert.match(invite,/href="\/play\/\?room=ABC123"/);
});
test('expired disconnected entrant can rejoin the same manual room after its result closes',async t=>{
 const {url,app}=await boot(t,{disconnectGraceMs:35}),{a,b,code}=await pair(url),m=await start(a,b);
 a.ws.terminate();await pause(70);b.send({type:'st',matchId:m.matchId,seq:1,d:1,lane:1,alive:false});await b.read('end');assert.equal(app.rooms.get(code).players.length,1);
 const again=await guest(url,'阿娜',a.welcome.token);await again.read('end');again.send({type:'joinroom',code});await again.read('joined');const room=await again.read('room');assert.equal(room.p.length,2);assert.ok(room.p.some(p=>p.id===a.welcome.id));
});

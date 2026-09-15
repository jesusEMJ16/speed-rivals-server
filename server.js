'use strict';
const fs=require('node:fs/promises'), path=require('node:path'), http=require('node:http'), crypto=require('node:crypto');
const {WebSocketServer}=require('ws');
const Bots=require('./bots');
const MAX=9,LANES=3,DUR=120000,COUNTDOWN=2450;
// Public Google Play app-signing certificate supplied by the app owner.
const ANDROID_RELEASE_CERT_SHA256='13:04:44:D7:36:92:7D:A8:65:2E:AC:4F:28:E5:E3:7B:76:09:3B:93:61:D7:96:8B:AD:16:1A:73:78:21:19:38';
const MODES=['normal','subita','supervivencia'];
const ATTACKS=['oil','cones','rayo','emp','gancho','prisa'];
const PUBLIC_FILES=['index.html','privacy.html','chakrapetch-OFL.txt','racingsansone-OFL.txt','noto-latin-OFL.txt','noto-korean-OFL.txt','noto-japanese-OFL.txt','noto-devanagari-OFL.txt','noto-chinese-OFL.txt','noto-bengali-OFL.txt','noto-arabic-OFL.txt'];
const RANK_CP=[40,25,15,8,0,-8,-15,-22,-30];
const COLS=['#3aa0ff','#ffd23f','#8be04a','#ff7ab6','#c9d4de','#ff9040','#e05ec0','#7ae0d0','#ffa07a'];
function cleanName(v){return typeof v==='string'?Array.from(v.normalize('NFC').replace(/[\p{Cc}\p{Cf}<>&"']/gu,'').replace(/\s+/gu,' ').trim()).slice(0,24).join(''):'';}
function badName(v){return !cleanName(v);}
function sanitizeName(v){return cleanName(v)||'Player';}
function sanitizeRoom(v){return cleanName(v)||'SALA';}
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const empty=()=>({version:2,profiles:{},tokens:{},matches:{},updatedAt:0});
function validData(v){
 if(!v||v.version!==2||!v.profiles||!v.tokens||!v.matches||Array.isArray(v.profiles))throw Error('Invalid v2 storage');
 for(const [id,p] of Object.entries(v.profiles))if(p.id!==id||!Number.isFinite(p.cp)||p.cp<0||!Number.isFinite(p.races))throw Error('Invalid profile');
 return v;
}
function fileStorage(file){return {
 async load(){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
 async save(value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';let h;
  try{h=await fs.open(tmp,'wx',0o600);await h.writeFile(JSON.stringify(value));await h.sync();await h.close();h=null;await fs.rename(tmp,file);}finally{if(h)await h.close();await fs.rm(tmp,{force:true}).catch(()=>{});}
 }
};}
function storageFor(o){
 if(o.storage)return o.storage;
 let redis=o.redis;
 if(redis===undefined&&process.env.UPSTASH_REDIS_REST_URL&&process.env.UPSTASH_REDIS_REST_TOKEN){const {Redis}=require('@upstash/redis');redis=new Redis({url:process.env.UPSTASH_REDIS_REST_URL,token:process.env.UPSTASH_REDIS_REST_TOKEN});}
 if(redis){const key=o.storageKey||process.env.SR_STORAGE_KEY||'sr:v2:state';if(['sr:prof','sr:rank'].includes(key))throw Error('Legacy storage keys are read-only');return {load:()=>redis.get(key),save:v=>redis.set(key,v)};}
 const file=o.dataFile||process.env.SR_DATA_FILE;
 if((o.production??process.env.NODE_ENV==='production')&&!file)throw Error('Production requires Upstash or SR_DATA_FILE on persistent disk');
 return fileStorage(path.resolve(file||'data/online-v2.json'));
}
function createServer(options={}){
 const rooms=new Map(),sessions=new Map();let data=empty(),storage,storageReady=false,storageError=null,closing=false,closePromise,queue=Promise.resolve();
 const now=()=>Date.now(), countdown=options.countdownMs??COUNTDOWN,duration=options.durationMs??DUR,grace=options.disconnectGraceMs??15000;
 const maxSpeed=options.maxDistancePerSecond??5000,burst=options.distanceBurst??240,queueWait=options.queueWaitMs??15000;
 const pickupCooldown=options.pickupCooldownMs??3500,attackCooldown=options.attackCooldownMs??750;
 function enqueue(fn){const job=queue.then(fn);queue=job.catch(()=>{});return job;}
 function send(ws,m){if(ws?.readyState===1&&ws.bufferedAmount<262144)ws.send(JSON.stringify(m));}
 function err(ws,code,msg=code){send(ws,{type:'err',code,msg});}
 function publicProfile(p){return {id:p.id,name:p.name,cp:p.cp,bestVs:p.bestVs,wins:p.wins,races:p.races};}
 function profiles(){return Object.values(data.profiles).map(publicProfile).sort((a,b)=>b.cp-a.cp||b.bestVs-a.bestVs||a.id.localeCompare(b.id));}
 function stats(ws,type='profiles'){const rows=profiles();send(ws,{type,...(type==='rank'?{rank:rows}:{profiles:rows}),source:'online',season:'v2',updatedAt:data.updatedAt});}
 async function commit(next){try{await storage.save(next);data=next;storageReady=true;storageError=null;}catch(e){storageReady=false;storageError=e;throw e;}}
 function needsStorage(ws){if(!storageReady){err(ws,'STORAGE_UNAVAILABLE');return false;}return true;}
 function roomPayload(R,p){return {type:'room',id:p.id,code:R.code,queue:!R.manual,racing:R.racing,mode:R.mode,host:R.host,manual:R.manual,priv:R.priv,roomName:R.name,matchId:R.matchId,seed:R.seed,startAt:R.startAt,endsAt:R.endsAt,serverTime:now(),spectating:!!p.spectating,p:R.players.map(q=>({id:q.id,name:data.profiles[q.id]?.name||q.name,col:q.col,d:q.d,lane:q.lane,alive:q.alive,connected:q.connected,cp:data.profiles[q.id]?.cp||0,car:q.loadout?.car??null,llanta:q.loadout?.llanta??null,gadget:q.loadout?.gadget??null,abil:q.loadout?.abil??null}))};}
 function broadcast(R){for(const p of R.players)if(p.R===R)send(p.ws,roomPayload(R,p));}
 function host(R){if(!R.players.some(p=>!p.isBot&&p.id===R.host&&p.connected&&p.R===R))R.host=R.players.find(p=>!p.isBot&&p.connected&&p.R===R)?.id||null;}
 function detach(p){const R=p.R;if(!R)return;p.R=null;p.spectating=false;
  if(R.racing){p.alive=false;p.item=null;}else R.players=R.players.filter(q=>q!==p);
  host(R);if(!R.players.length)rooms.delete(R.code);else broadcast(R);
 }
 function makeRoom(manual,mode,name,priv){let code;do{code=crypto.randomBytes(4).toString('hex').slice(0,6).toUpperCase();}while(rooms.has(code));const R={code,name:sanitizeRoom(name),priv:!!priv,manual,mode,host:null,players:[],racing:false,queueAt:now()+queueWait};rooms.set(code,R);return R;}
 function join(p,R,type){if(R.racing)return err(p.ws,'RACE_ACTIVE');if(p.R===R){send(p.ws,{type,code:R.code,queue:!R.manual});return broadcast(R);}if(R.players.length>=MAX)return err(p.ws,'ROOM_FULL');
  if(p.R?.racing)return err(p.ws,'RACE_ACTIVE','Leave the current race first');detach(p);p.R=R;p.d=0;p.alive=true;p.lane=R.players.length%LANES;p.spectating=false;p.col=COLS[R.players.length];R.players.push(p);host(R);send(p.ws,{type,code:R.code,queue:!R.manual});broadcast(R);if(!R.manual&&R.players.length===MAX&&R.players.every(q=>q.connected))startRace(R);
 }
 function startRace(R){if(R.racing||!storageReady)return;R.racing=true;R.finishing=false;R.matchId=crypto.randomUUID();R.seed=crypto.randomInt(1,1e9);R.startAt=now()+countdown;R.endsAt=R.startAt+duration;R.nextRetry=0;R.botTime=R.startAt;
  if(!R.manual&&R.players.length<MAX){for(const b of Bots.create(MAX-R.players.length,R.seed,R.mode)){b.R=R;b.col=COLS[R.players.length];R.players.push(b);}}
  for(const [i,p] of R.players.entries()){p.activeMatch=R;p.d=0;p.lane=i%LANES;p.alive=true;p.seq=-1;p.item=null;p.spectating=false;p.lastPickup=R.startAt-pickupCooldown;p.lastAttack=R.startAt-attackCooldown;p.distanceBudget=burst;p.lastStateAt=R.startAt;}
  const m={type:'start',matchId:R.matchId,seed:R.seed,mode:R.mode,startAt:R.startAt,endsAt:R.endsAt,serverTime:now()};for(const p of R.players)send(p.ws,m);broadcast(R);
 }
 async function finishRace(R){if(!R.racing||R.finishing||now()<R.nextRetry)return;R.finishing=true;
  try{let end=data.matches[R.matchId];if(!end){const next=structuredClone(data);const rank=[...R.players].sort((a,b)=>b.d-a.d||a.id.localeCompare(b.id)).map((p,i)=>{if(p.isBot)return {id:p.id,name:p.name,d:p.d,cpDelta:0,cpTotal:0};const pr=next.profiles[p.id],before=pr.cp;pr.cp=Math.max(0,Math.min(1e9,pr.cp+RANK_CP[i]));pr.races++;if(i===0)pr.wins++;pr.bestVs=Math.max(pr.bestVs,p.d*.03);pr.lastMatchId=R.matchId;return {id:p.id,name:pr.name,d:p.d,cpDelta:pr.cp-before,cpTotal:pr.cp};});
    end={type:'end',matchId:R.matchId,rank,roomRank:rank.map(p=>({id:p.id,name:p.name,cp:p.cpTotal})),serverTime:now(),saved:true};next.matches[R.matchId]=end;next.updatedAt=now();await commit(next);}
   R.racing=false;R.lastEnd=end;for(const p of R.players){send(p.ws,end);p.activeMatch=null;p.item=null;p.spectating=false;}
   R.players=R.players.filter(p=>{if(p.isBot||p.R!==R)return false;if(p.connected||now()-p.disconnectedAt<grace)return true;p.R=null;return false;});host(R);broadcast(R);if(!R.players.length)rooms.delete(R.code);
  }catch(e){R.nextRetry=now()+500;for(const p of R.players)err(p.ws,'STORAGE_UNAVAILABLE','Result pending durable storage; retrying');}finally{R.finishing=false;}
 }
 function raceAction(p,m){const R=p.R,t=now();if(!R?.racing||R.finishing||R.nextRetry>0||m.matchId!==R.matchId||t<R.startAt||t>=R.endsAt||!p.alive||p.spectating||!Number.isSafeInteger(m.seq)||m.seq<=p.seq){err(p.ws,'INVALID_STATE');return null;}p.seq=m.seq;return R;}
 async function hello(ws,m){if(ws.player)return err(ws,'INVALID_STATE');if(m.protocol!==2)return err(ws,'INVALID_VERSION');if(!needsStorage(ws))return;
  let token=m.token,id;
  if(token!==undefined&&token!==null&&token!==''){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||(id=data.tokens[hash(token)])===undefined)return err(ws,'INVALID_TOKEN','Unknown guest token');}
  else token=crypto.randomBytes(32).toString('base64url');
  const requestedName=cleanName(m.name);
  if(!id||(requestedName&&requestedName!==data.profiles[id].name)){
   const next=structuredClone(data);if(!id){id=crypto.randomUUID();next.tokens[hash(token)]=id;next.profiles[id]={id,name:sanitizeName(m.name),cp:0,bestVs:0,wins:0,races:0};}else next.profiles[id].name=requestedName;
   next.updatedAt=now();await commit(next);
  }
  let p=sessions.get(id);if(!p){p={id,name:data.profiles[id].name,connected:true,ws,R:null,d:0,lane:1,alive:true};sessions.set(id,p);}else{if(p.ws&&p.ws!==ws){p.ws.player=null;p.ws.close(4001,'Session replaced');}if(p.R?.racing){p.alive=false;p.spectating=true;p.item=null;}p.ws=ws;p.connected=true;}
  ws.player=p;send(ws,{type:'welcome',protocol:2,id,token,profile:publicProfile(data.profiles[id]),serverTime:now()});if(p.R){host(p.R);broadcast(p.R);if(!p.R.manual&&!p.R.racing&&!p.R.lastEnd&&p.R.players.length===MAX&&p.R.players.every(q=>q.connected))startRace(p.R);}if(!p.R?.racing&&data.profiles[id].lastMatchId){const last=data.matches[data.profiles[id].lastMatchId];if(last)send(ws,last);}
 }
 async function message(ws,m){if(!m||typeof m!=='object'||Array.isArray(m)||typeof m.type!=='string')return err(ws,'INVALID_STATE');
  if(m.type==='ping')return send(ws,{type:'pong',sentAt:m.sentAt,serverTime:now()});if(m.type==='hello')return hello(ws,m);
  const p=ws.player;if(!p)return err(ws,'AUTH_REQUIRED');if(p.ws!==ws)return err(ws,'AUTH_REQUIRED');
  if(m.type==='getstats')return stats(ws);if(m.type==='getrank')return stats(ws,'rank');
  if(m.type==='stats'){if(!needsStorage(ws))return;const name=cleanName(m.name);if(!name||name===data.profiles[p.id].name)return stats(ws);const next=structuredClone(data);next.profiles[p.id].name=name;next.updatedAt=now();await commit(next);if(p.R)broadcast(p.R);return stats(ws);}
  if(m.type==='score')return err(ws,'INVALID_STATE','Only completed v2 races award online records');
  if(m.type==='list')return send(ws,{type:'rooms',rooms:[...rooms.values()].filter(R=>R.manual&&!R.priv&&!R.racing&&R.players.length).map(R=>({code:R.code,name:R.name,roomName:R.name,mode:R.mode,n:R.players.length,max:MAX}))});
  if(m.type==='leave'){detach(p);return send(ws,{type:'left'});}
  if(['joinpub','create','joinroom'].includes(m.type)){
   if(!needsStorage(ws))return;if(p.activeMatch?.racing)return err(ws,'RACE_ACTIVE');
   if(m.type==='joinroom'){const R=rooms.get(String(m.code||'').toUpperCase());return R?join(p,R,'joined'):err(ws,'ROOM_NOT_FOUND');}
   const mode=m.mode||'normal';if(!MODES.includes(mode))return err(ws,'INVALID_STATE');
   if(m.type==='create')return join(p,makeRoom(true,mode,m.roomName,m.priv),'created');
   let R=[...rooms.values()].find(r=>!r.manual&&!r.racing&&!r.lastEnd&&r.mode===mode&&r.players.length<MAX);
   if(!R){R=makeRoom(false,mode,'Public queue',false);R.queueAt-=Math.min(queueWait,Math.max(0,Number.isFinite(m.waitedMs)?m.waitedMs:0));}return join(p,R,'joined');
  }
  const R=p.R;if(!R)return err(ws,'INVALID_STATE');
  if(m.type==='loadout'){
   const next={...p.loadout};
   for(const key of ['car','llanta','gadget','abil'])if(Object.hasOwn(m,key)){
    const value=m[key];if(value!==null&&(typeof value!=='string'||!/^[a-z0-9_]{1,32}$/.test(value)))return err(ws,'INVALID_STATE');next[key]=value;
   }
   p.loadout=next;return broadcast(R);
  }
  if(['setmode','setpriv','startRace'].includes(m.type)){
   if(!R.manual||R.host!==p.id)return err(ws,'NOT_HOST');if(R.racing)return err(ws,'RACE_ACTIVE');
   if(m.type==='setmode'){if(!MODES.includes(m.mode))return err(ws,'INVALID_STATE');R.mode=m.mode;}
   if(m.type==='setpriv')R.priv=!!m.priv;
   if(m.type==='startRace'){if(R.players.length<2||!R.players.every(q=>q.connected))return err(ws,'INVALID_STATE');if(needsStorage(ws))startRace(R);return;}return broadcast(R);
  }
  if(m.type==='st'){if(!raceAction(p,m))return;const elapsed=Math.max(0,now()-p.lastStateAt)/1000,budget=Math.min(burst+maxSpeed*.5,p.distanceBudget+elapsed*maxSpeed);
   if(typeof m.d!=='number'||!Number.isFinite(m.d)||m.d<p.d||m.d-p.d>budget||m.d>(now()-R.startAt)/1000*maxSpeed+burst||!Number.isInteger(m.lane)||m.lane<0||m.lane>=LANES||typeof m.alive!=='boolean')return err(ws,'INVALID_STATE');
   p.distanceBudget=budget-(m.d-p.d);p.lastStateAt=now();p.d=m.d;p.lane=m.lane;p.alive=m.alive;if(!p.alive)p.item=null;return;
  }
  if(m.type==='pickup'||m.type==='atk'){if(!raceAction(p,m))return;const kind=m.kind==='cone'?'cones':m.kind;if(!ATTACKS.includes(kind)||R.mode!=='normal')return err(ws,'INVALID_STATE');
   if(m.type==='pickup'){if(p.item||now()-p.lastPickup<pickupCooldown)return err(ws,'INVALID_STATE');p.item=kind;p.lastPickup=now();return send(ws,{type:'inventory',matchId:R.matchId,item:kind});}
   if(p.item!==kind||now()-p.lastAttack<attackCooldown)return err(ws,'INVALID_STATE');const candidates=R.players.filter(q=>q!==p&&q.alive&&q.connected&&q.R===R);if(!candidates.length)return err(ws,'INVALID_STATE');p.item=null;p.lastAttack=now();send(ws,{type:'inventory',matchId:R.matchId,item:null});
   deliverAttack(R,p,kind,candidates);return;
  }
  err(ws,'INVALID_STATE');
 }
 function deliverAttack(R,p,kind,candidates,preferred){
  const targets=['rayo','emp'].includes(kind)?candidates:[candidates.find(q=>q.id===preferred)||candidates.sort((a,b)=>Math.abs(a.d-p.d)-Math.abs(b.d-p.d)||a.id.localeCompare(b.id))[0]];
  const attack={type:'atk',matchId:R.matchId,eventId:crypto.randomUUID(),kind,from:p.id};
  for(const q of targets)if(q){if(q.isBot)Bots.receive(q,kind);else send(q.ws,attack);}
 }
 function webPlayUrl(code){const fallback='/play/?room='+encodeURIComponent(code),raw=options.webPlayUrl||process.env.SR_WEB_PLAY_URL;if(!raw)return fallback;try{const u=new URL(raw);if(!['https:','http:'].includes(u.protocol))return fallback;u.searchParams.set('room',code);return u.href;}catch{return fallback;}}
 const escape=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const httpServer=http.createServer((req,res)=>{const route=(req.url||'').split('?')[0];
  if(route==='/.well-known/assetlinks.json'){
   if(req.method!=='GET'){res.writeHead(405,{'allow':'GET'});return res.end();}
   const fingerprints=String(options.androidCertSha256??process.env.SR_ANDROID_CERT_SHA256??ANDROID_RELEASE_CERT_SHA256).split(',').map(s=>s.trim().toUpperCase());
   const valid=fingerprints.length>0&&fingerprints.every(s=>/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s));
   res.writeHead(valid?200:503,{'content-type':'application/json; charset=utf-8','cache-control':valid?'public, max-age=300':'no-store','x-content-type-options':'nosniff'});
   return res.end(JSON.stringify(valid?[{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:'solutions.moncadastudio.speedrivals',sha256_cert_fingerprints:[...new Set(fingerprints)]}}]:[]));
  }
  const publicName=route==='/play/'?'index.html':PUBLIC_FILES.find(name=>route==='/play/'+name);
  if(publicName){
   if(req.method!=='GET'){res.writeHead(405,{'allow':'GET'});return res.end();}
   // Exact names only: URL text never becomes a filesystem path.
   fs.readFile(path.join(options.publicDir||path.join(__dirname,'public'),publicName)).then(content=>{
    res.writeHead(200,{'content-type':publicName.endsWith('.html')?'text/html; charset=utf-8':'text/plain; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-cache'});res.end(content);
   }).catch(error=>{res.writeHead(error.code==='ENOENT'?404:500);res.end();});return;
  }
  if(['/','/health','/ready'].includes(route)){res.writeHead(route==='/ready'&&!storageReady?503:200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({ok:route==='/ready'?storageReady:true,ready:storageReady,protocol:2,season:'v2',profiles:Object.keys(data.profiles).length,rooms:rooms.size}));}
  const invite=/^\/invite\/([A-Za-z0-9]{6})$/.exec(route);if(invite){const code=invite[1].toUpperCase(),url=webPlayUrl(code);res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Speed Rivals invitation</title><style>body{font:1.2rem system-ui;background:#101727;color:#fff;max-width:34rem;margin:12vh auto;padding:2rem}strong{display:block;font-size:3rem;letter-spacing:.2em}a{color:#65d6ff}</style><h1>Speed Rivals</h1><p>Join this room with its code:</p><strong>'+code+'</strong><p>Open Speed Rivals on web or Android, then enter the room code.</p>'+(url?'<p><a href="'+escape(url)+'">Play on web</a></p>':'')+'</html>');}
  res.writeHead(404);res.end();
 });
 const wss=new WebSocketServer({server:httpServer,maxPayload:4096});
 wss.on('connection',ws=>{ws.isAlive=true;ws.windowAt=now();ws.messages=0;ws.on('pong',()=>ws.isAlive=true);
  ws.on('message',raw=>{if(now()-ws.windowAt>=1000){ws.windowAt=now();ws.messages=0;}if(++ws.messages>80){if(ws.messages===81)err(ws,'RATE_LIMIT');if(ws.messages>160)ws.close(1008,'Rate limit');return;}let m;try{m=JSON.parse(String(raw));}catch{return err(ws,'INVALID_STATE');}enqueue(()=>message(ws,m)).catch(()=>err(ws,'STORAGE_UNAVAILABLE'));});
  ws.on('close',()=>enqueue(()=>{const p=ws.player;if(!p||p.ws!==ws)return;p.ws=null;p.connected=false;p.disconnectedAt=now();if(p.R){host(p.R);broadcast(p.R);}}));ws.on('error',()=>{});
 });
 const listening=new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(options.port??process.env.PORT??8787,options.host,resolve);});
 const initialized=enqueue(async()=>{try{storage=storageFor(options);const v=await storage.load();data=v===null?empty():validData(v);await commit(data);}catch(e){storageError=e;storageReady=false;throw e;}});
 const ready=Promise.all([listening,initialized]).then(()=>undefined);ready.catch(()=>{});
 const tick=setInterval(()=>{if(closing)return;enqueue(async()=>{for(const R of rooms.values()){
   for(const p of [...R.players])if(!p.connected&&now()-p.disconnectedAt>=grace){if(R.racing){p.alive=false;p.item=null;}else detach(p);}
   if(!R.manual&&!R.racing&&!R.lastEnd&&now()>=R.queueAt&&storageReady){
    for(const p of [...R.players])if(!p.connected)detach(p);
    if(R.players.length)startRace(R);
   }
   if(R.racing&&now()>=R.startAt&&!R.finishing&&!R.nextRetry){
    Bots.advance(R,now(),(b,kind,target)=>{const candidates=R.players.filter(p=>p!==b&&p.alive&&p.connected&&p.R===R);if(!candidates.length||R.mode!=='normal')return false;deliverAttack(R,b,kind,candidates,target);return true;});
    if(!R.players.some(p=>!p.isBot&&p.R===R&&(p.connected||now()-p.disconnectedAt<grace)))for(const b of R.players)if(b.isBot)b.alive=false;
   }
   if(R.racing){if(now()>=R.endsAt||(now()>=R.startAt&&R.players.every(p=>!p.alive)))await finishRace(R);else if(now()-(R.lastBroadcast||0)>=120){R.lastBroadcast=now();broadcast(R);}}
  }}).catch(()=>{});},options.tickMs??100);
 const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue;}ws.isAlive=false;ws.ping();}},options.heartbeatMs??20000);
 function close(){if(closePromise)return closePromise;closing=true;clearInterval(tick);clearInterval(heartbeat);closePromise=(async()=>{await queue;for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>httpServer.close(r));})();return closePromise;}
 return {wss,rooms,httpServer,address:()=>httpServer.address(),ready,close};
}
if(require.main===module){const app=createServer();app.ready.then(()=>console.log('Speed Rivals v2 listening on '+app.address().port)).catch(e=>console.error('Readiness failed: '+e.message));for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>app.close().then(()=>process.exit()));}
module.exports={createServer,cleanName,badName,sanitizeName,sanitizeRoom,constants:{MAX,LANES,DUR,COUNTDOWN}};

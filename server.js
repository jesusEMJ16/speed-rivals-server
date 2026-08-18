'use strict';

const fs=require('node:fs');
const {WebSocketServer}=require('ws');

const MAX=9,LANES=3,DUR=120000;
const RANK_CP=[40,25,15,8,0,-8,-15,-22,-30];
const COLS=['#3aa0ff','#ffd23f','#8be04a','#ff7ab6','#c9d4de','#ff9040','#e05ec0','#7ae0d0','#ffa07a'];
const BOTNAMES=['RAYO','NITRA','KEKO','MORA','PIXEL','RUDO','LAJEFA','VEGA','SOMBRA','COHETE','PISTON','DIESEL','NEON','MISIL','CENTELLA','GACEL','TIGRE','KART'];
const BAD_PARTS=['PUT','VERG','MIER','CULO','PENE','PITO','JODE','MAME','TETA','SEXO','PORN','XXX','FUCK','SHIT','BITCH','NAZI','KKK','HITL'];
const BAD_EXACT=['ADMIN','MOD','NULL','UNDEF','BOT','CPU','SERVER','SPEED'];

function unMojibake(value){
 try{return decodeURIComponent(escape(value));}catch(e){return value;}
}
function cleanName(value){
 if(typeof value!=='string')return '';
 const ascii=unMojibake(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z]/g,'').slice(0,6).toLowerCase();
 return ascii?ascii[0].toUpperCase()+ascii.slice(1):'';
}
function badName(value){
 const name=cleanName(value),upper=name.toUpperCase();
 return !name||BAD_EXACT.includes(upper)||BAD_PARTS.some(part=>upper.includes(part));
}
function randomName(){
 const letters='abcdefghijklmnopqrstuvwxyz';let out='P';
 for(let i=0;i<5;i++)out+=letters[(Math.random()*letters.length)|0];
 return out;
}
function sanitizeName(value){return badName(value)?randomName():cleanName(value);}
function sanitizeRoom(value){
 const text=typeof value==='string'?value:'';
 return text.replace(/[<>&"']/g,'').replace(/\s+/g,' ').trim().slice(0,24)||'SALA';
}
function int(value,min,max){return Math.max(min,Math.min(max,Number.isFinite(+value)?Math.trunc(+value):min));}
function readJson(file,fallback){try{const value=JSON.parse(fs.readFileSync(file,'utf8'));return Array.isArray(value)?value:fallback;}catch(e){return fallback;}}
function writeJson(file,value){try{fs.writeFileSync(file,JSON.stringify(value));}catch(e){/* Persistence is optional in ephemeral hosts. */}}

function createServer(options={}){
 const port=options.port??process.env.PORT??8787;
 const rankFile=options.rankFile||'rank.json',profilesFile=options.profilesFile||'profiles.json';
 let RANK=readJson(rankFile,[]),PROF=readJson(profilesFile,[]);
 const rooms=new Map();let serial=0;
 const wss=new WebSocketServer({port,maxPayload:16384});

 function send(ws,message){if(ws&&ws.readyState===ws.OPEN){try{ws.send(JSON.stringify(message));}catch(e){}}}
 function profile(name){
  const safe=sanitizeName(name);let p=PROF.find(row=>row.name===safe);
  if(!p){p={name:safe,cp:0,best1p:0};PROF.push(p);}
  p.cp=int(p.cp,0,1000000);p.best1p=int(p.best1p,0,1000000);return p;
 }
 function getRoom(code){
  const key=String(code||'PUB').toUpperCase();
  if(!rooms.has(key))rooms.set(key,{code:key,name:key==='PUB'?'PARTIDA PUBLICA':'SALA '+key,priv:false,manual:key!=='PUB',host:null,mode:'normal',players:[],bots:[],cp:{},racing:false,seed:0,tEnd:0,searchStart:0,lastTick:Date.now()});
  return rooms.get(key);
 }
 function makeCode(){let code;do{code=Math.random().toString(36).slice(2,8).toUpperCase();}while(rooms.has(code));return code;}
 function roomPayload(R,p){
  const humans=R.players.map(q=>({id:q.id,name:q.name,col:q.col,d:Math.round(q.d),lane:q.lane,alive:q.alive,cp:R.cp[q.id]||0}));
  const bots=R.bots.map(b=>({id:b.id,name:b.name,col:b.col,d:Math.round(b.d),lane:b.lane,alive:b.alive,cp:0}));
  return {type:'room',id:p.id,racing:R.racing,code:R.code,mode:R.mode,host:R.host,manual:R.manual,priv:R.priv,roomName:R.name,p:humans.concat(bots)};
 }
 function broadcastRoom(R){R.players.forEach(p=>send(p.ws,roomPayload(R,p)));}
 function leave(p){
  const R=p.R;if(!R)return;
  R.players=R.players.filter(q=>q!==p);delete R.cp[p.id];p.R=null;
  if(R.host===p.id)R.host=R.players[0]?.id||null;
  if(!R.players.length){R.racing=false;R.bots=[];R.searchStart=0;}
  broadcastRoom(R);
 }
 function join(p,R,name){
  if(p.R===R)return true;
  if(R.racing||R.players.length>=MAX){send(p.ws,{type:'full'});return false;}
  leave(p);p.R=R;p.name=sanitizeName(name||p.name);p.alive=true;p.d=0;p.lane=R.players.length%LANES;
  R.players.push(p);R.cp[p.id]=profile(p.name).cp;
  if(!R.host&&R.manual)R.host=p.id;
  broadcastRoom(R);return true;
 }
 function startRace(R){
  if(R.racing||!R.players.length)return;
  R.racing=true;R.seed=(Math.random()*1e9)|0;R.tEnd=Date.now()+DUR;R.lastTick=Date.now();R.searchStart=0;
  R.players.forEach((p,i)=>{p.alive=true;p.d=0;p.lane=i%LANES;});
  R.bots=[];
  if(!R.manual)for(let i=R.players.length;i<MAX;i++)R.bots.push({id:'bot'+i,name:BOTNAMES[(Math.random()*BOTNAMES.length)|0],col:COLS[i%COLS.length],d:0,lane:i%LANES,alive:true,skill:.7+Math.random()*.3});
  R.players.forEach(p=>send(p.ws,{type:'start',seed:R.seed,mode:R.mode}));
  broadcastRoom(R);
 }
 function finishRace(R){
  if(!R.racing)return;
  R.racing=false;
  const rank=[...R.players,...R.bots].sort((a,b)=>b.d-a.d);
  R.players.forEach(p=>{
   const pos=rank.findIndex(q=>q.id===p.id),delta=RANK_CP[pos]||0,pr=profile(p.name);
   pr.cp=Math.max(0,pr.cp+delta);R.cp[p.id]=pr.cp;
   send(p.ws,{type:'end',rank:rank.map(q=>({id:q.id,name:q.name,d:Math.round(q.d)})),roomRank:rank.map(q=>({name:q.name,cp:q.id.startsWith('bot')?0:(R.cp[q.id]||0)}))});
  });
  writeJson(profilesFile,PROF);R.bots=[];broadcastRoom(R);
 }
 function publicRooms(){return [...rooms.values()].filter(R=>R.code!=='PUB'&&!R.priv&&!R.racing&&R.players.length).map(R=>({code:R.code,name:R.name,n:R.players.length,max:MAX}));}

 const tick=setInterval(()=>{
  const now=Date.now();
  for(const R of rooms.values()){
   if(!R.racing&&!R.manual&&R.players.length){
    if(!R.searchStart)R.searchStart=now;
    if(R.players.length>=MAX||now-R.searchStart>=15000)startRace(R);
   }
   if(R.racing){
    const dt=Math.min(.5,(now-R.lastTick)/1000);R.lastTick=now;
    R.bots.forEach(b=>{if(b.alive)b.d+=(260+b.skill*340)*dt;});
    if(now>=R.tEnd||R.players.every(p=>!p.alive))finishRace(R);
    else broadcastRoom(R);
   }
  }
 },250);

 wss.on('connection',ws=>{
  const p={id:'p'+(++serial).toString(36),ws,name:randomName(),col:COLS[serial%COLS.length],R:null,d:0,lane:1,alive:true};
  ws.on('message',raw=>{
   let m;try{m=JSON.parse(String(raw));}catch(e){return;}
   if(!m||typeof m.type!=='string')return;
   if(m.type==='getrank')return send(ws,{type:'rank',rank:RANK});
   if(m.type==='getstats')return send(ws,{type:'profiles',profiles:PROF});
   if(m.type==='stats'){
    const pr=profile(m.name);pr.cp=int(m.cp,0,1000000);pr.best1p=int(m.best1p,0,1000000);p.name=pr.name;writeJson(profilesFile,PROF);return send(ws,{type:'profiles',profiles:PROF});
   }
   if(m.type==='list')return send(ws,{type:'rooms',rooms:publicRooms()});
   if(m.type==='create'){
    const R=getRoom(makeCode());R.name=sanitizeRoom(m.roomName);R.priv=!!m.priv;R.manual=true;
    if(join(p,R,m.name)){R.host=p.id;send(ws,{type:'created',code:R.code});broadcastRoom(R);}return;
   }
   if(m.type==='joinpub'){
    const R=getRoom('PUB');if(join(p,R,m.name)){send(ws,{type:'joined',code:R.code});if(!R.searchStart)R.searchStart=Date.now();broadcastRoom(R);}return;
   }
   if(m.type==='joinroom'){
    const R=rooms.get(String(m.code||'').toUpperCase());if(!R)return send(ws,{type:'err',msg:'Sala no encontrada'});
    if(join(p,R,m.name)){send(ws,{type:'joined',code:R.code});broadcastRoom(R);}return;
   }
   if(m.type==='leave'){leave(p);return send(ws,{type:'left'});}
   const R=p.R;if(!R)return;
   if(m.type==='setmode'&&R.host===p.id&&!R.racing&&['normal','subita','supervivencia'].includes(m.mode)){R.mode=m.mode;return broadcastRoom(R);}
   if(m.type==='setpriv'&&R.host===p.id&&!R.racing){R.priv=!!m.priv;return broadcastRoom(R);}
   if(m.type==='startRace'&&R.host===p.id&&R.manual&&!R.racing&&R.players.length>=2)return startRace(R);
   if(m.type==='st'&&R.racing){p.d=Math.max(p.d,int(m.d,0,10000000));p.lane=int(m.lane,0,LANES-1);p.alive=!!m.alive;return;}
   if(m.type==='atk'&&R.racing){R.players.filter(q=>q!==p&&q.alive).forEach(q=>send(q.ws,{type:'atk',kind:String(m.kind||''),from:p.id}));return;}
   if(m.type==='score'){
    const item={name:sanitizeName(m.name),km:Math.max(0,Math.min(10000,+m.km||0)),time:int(m.time,0,3600),pts:int(m.pts,0,1000000)};
    if(item.km<=0||item.time<=0||item.km*1000>item.time*500)return;
    RANK.push(item);RANK.sort((a,b)=>b.km-a.km||b.pts-a.pts);RANK=RANK.slice(0,100);writeJson(rankFile,RANK);return send(ws,{type:'rank',rank:RANK});
   }
  });
  ws.on('close',()=>leave(p));
 });
 const close=async()=>{clearInterval(tick);for(const client of wss.clients){try{client.close();}catch(e){}}return new Promise(resolve=>wss.close(resolve));};
 return {wss,rooms,address:()=>wss.address(),close};
}

if(require.main===module){const app=createServer();app.wss.on('listening',()=>console.log('SPEED RIVALS online en puerto '+app.address().port));}

module.exports={createServer,cleanName,badName,sanitizeName,sanitizeRoom,constants:{MAX,LANES,DUR}};

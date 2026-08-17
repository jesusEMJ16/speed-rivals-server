// server.js -> npm i ws && node server.js  (PORT auto en hosting)
const {WebSocketServer}=require('ws');
const fs=require('fs');
const crypto=require('crypto');

const MAX=9,DUR=120,MTR=0.03,LANES=3,RANKCP=[40,25,15,8,0,-8,-15,-22,-30];
const COLS=['#3aa0ff','#ffd23f','#8be04a','#ff7ab6','#c9d4de','#ff9040','#e05ec0','#7ae0d0','#ffa07a'];
const BAD_NAME_PARTS=['PUT','VERG','MIER','CULO','PENE','PITO','JODE','MAME','TETA','SEXO','PORN','XXX','FUCK','SHIT','BITCH','NAZI','KKK','HITL'];
const BAD_NAME_EXACT=['ADMIN','MOD','NULL','UNDEF','BOT','CPU','SERVER','SPEED'];

const cleanName=n=>{
 if(typeof n!=='string')return '';
 const s=n.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z]/g,'').slice(0,6).toLowerCase();
 return s?s[0].toUpperCase()+s.slice(1):'';
};
const badName=n=>{
 const u=(n||'').toUpperCase();
 return !n||n.length>6||BAD_NAME_EXACT.includes(u)||BAD_NAME_PARTS.some(b=>u.includes(b));
};
const randomName=()=>{
 const A='abcdefghijklmnopqrstuvwxyz';
 let n='P';
 for(let i=0;i<5;i++)n+=A[(Math.random()*A.length)|0];
 return n;
};
const sanitizeName=n=>{
 const s=cleanName(n);
 return badName(s)?randomName():s;
};
const sanitizeRoom=n=>typeof n!=='string'?'SALA':n.replace(/[<>"'&]/g,'').trim().slice(0,14)||'SALA';
const send=(ws,o)=>{
 if(ws.readyState===1)try{ws.send(JSON.stringify(o));}catch(e){}
};
function readArray(file){
 try{
  const r=JSON.parse(fs.readFileSync(file,'utf8'));
  return Array.isArray(r)?r:[];
 }catch(e){return [];}
}
function writeJson(file,data){
 try{fs.writeFileSync(file,JSON.stringify(data));}catch(e){}
}

function createServer(opts={}){
 const PORT=opts.port??process.env.PORT??8787;
 const rankFile=opts.rankFile||process.env.RANK_FILE||'rank.json';
 const profilesFile=opts.profilesFile||process.env.PROFILES_FILE||'profiles.json';
 const wss=new WebSocketServer({port:PORT,maxPayload:16384});
 let GLOBAL=readArray(rankFile),PROF=readArray(profilesFile);
 const saveRank=()=>writeJson(rankFile,GLOBAL);
 const saveProf=()=>writeJson(profilesFile,PROF);
 const rooms=new Map();
 const getRoom=c=>{
  if(!rooms.has(c))rooms.set(c,{code:c,name:c==='PUB'?'PUBLICA':c,priv:false,players:[],racing:false,seed:0,tEnd:0,cp:{},cpName:{}});
  return rooms.get(c);
 };
 getRoom('PUB');
 const newCode=()=>{
  let c;
  do{c=Math.random().toString(36).slice(2,6).toUpperCase();}while(rooms.has(c));
  return c;
 };
 const timers=[
  setInterval(()=>{
   wss.clients.forEach(ws=>{
    if(ws.isAlive===false)return ws.terminate();
    ws.isAlive=false;
    ws.ping(()=>{});
   });
  },30000),
  setInterval(()=>{
   rooms.forEach(R=>{
    R.players.forEach(p=>send(p.ws,{type:'room',id:p.id,racing:R.racing,code:R.code,p:R.players.map(q=>({id:q.id,name:q.name,col:q.col,d:Math.round(q.d),lane:q.lane,alive:q.alive}))}));
    const al=R.players.filter(p=>p.alive);
    if(!R.racing&&R.players.length>=2){
     R.racing=true;
     R.seed=(Math.random()*1e9)|0;
     R.tEnd=Date.now()+DUR*1000;
     R.players.forEach((p,i)=>{p.alive=true;p.d=0;p.lane=i%LANES;});
     R.players.forEach(p=>send(p.ws,{type:'start',seed:R.seed}));
    }
    else if(R.racing&&(Date.now()>R.tEnd||al.length<=1)){
     const rank=[...R.players].sort((a,b)=>b.d-a.d);
     rank.forEach((p,i)=>{
      const cp=RANKCP[i]||0;
      if(cp){R.cp[p.id]=Math.max(0,(R.cp[p.id]||0)+cp);R.cpName[p.id]=p.name;}
     });
     const roomRank=Object.keys(R.cp).map(id=>({name:R.cpName[id],cp:R.cp[id]})).sort((a,b)=>b.cp-a.cp);
     R.players.forEach(p=>send(p.ws,{type:'end',code:R.code,rank:rank.map(q=>({id:q.id,name:q.name,d:Math.round(q.d*MTR)})),roomRank}));
     R.racing=false;
    }
    if(R.code!=='PUB'&&!R.players.length)rooms.delete(R.code);
   });
  },120)
 ];

 wss.on('connection',ws=>{
  ws.isAlive=true;
  ws.on('pong',()=>{ws.isAlive=true;});
  const p={ws,id:crypto.randomBytes(4).toString('hex'),name:'PILOTO',col:COLS[0],d:0,lane:1,alive:true,R:null,msgT:0,msgC:0};
  function join(R,name){
   if(p.R)leave();
   p.name=sanitizeName(name);
   p.R=R;
   p.col=COLS[R.players.length%COLS.length];
   p.d=0;
   p.lane=1;
   p.alive=true;
   R.players.push(p);
  }
  function leave(){
   if(p.R){
    p.R.players=p.R.players.filter(q=>q!==p);
    if(!p.R.players.length)p.R.racing=false;
    p.R=null;
   }
  }
  ws.on('message',e=>{
   const now=Date.now();
   if(now-p.msgT<2000){p.msgC++;if(p.msgC>20)return;}
   else{p.msgT=now;p.msgC=1;}
   let m;
   try{m=JSON.parse(e);}catch(err){return;}
   if(!m||typeof m!=='object')return;
   if(m.type==='list'){
    const l=[];
    rooms.forEach(R=>{if(!R.priv)l.push({code:R.code,name:R.name,n:R.players.length,max:MAX});});
    send(ws,{type:'rooms',rooms:l});
   }
   if(m.type==='create'){
    const R=getRoom(newCode());
    R.priv=!!m.priv;
    R.name=sanitizeRoom(m.roomName)||('SALA '+R.code);
    join(R,m.name);
    send(ws,{type:'created',code:R.code});
   }
   if(m.type==='joinroom'){
    const R=rooms.get(String(m.code||'').toUpperCase());
    if(!R)return send(ws,{type:'err',msg:'Sala no encontrada'});
    if(R.players.length>=MAX)return send(ws,{type:'full'});
    join(R,m.name);
    send(ws,{type:'joined',code:R.code});
   }
   if(m.type==='joinpub'){
    const R=getRoom('PUB');
    if(R.players.length>=MAX)return send(ws,{type:'full'});
    join(R,m.name);
    send(ws,{type:'joined',code:'PUB'});
   }
   if(m.type==='stats'){
    const name=sanitizeName(m.name);
    let pr=PROF.find(x=>x.name===name);
    if(!pr){pr={name};PROF.push(pr);}
    pr.cp=Math.max(0,Math.min(1e6,m.cp|0));
    pr.best1p=Math.max(0,Math.min(1e6,m.best1p|0));
    saveProf();
    send(ws,{type:'profiles',profiles:PROF});
   }
   if(m.type==='getstats')send(ws,{type:'profiles',profiles:PROF});
   if(m.type==='getrank'&&!p.R)return send(ws,{type:'rank',rank:GLOBAL});
   if(!p.R)return;
   const R=p.R;
   if(m.type==='st'){
    if(typeof m.d!=='number'||!isFinite(m.d)||m.d<0||m.d-p.d>600)return;
    if(!Number.isInteger(m.lane)||m.lane<0||m.lane>=LANES)return;
    if(typeof m.alive!=='boolean')return;
    p.d=m.d;
    p.lane=m.lane;
    p.alive=m.alive;
   }
   if(m.type==='atk'&&R.racing&&p.alive){
    const v=new Set(['oil','cone','rayo','prisa','emp','gancho']);
    const k=v.has(m.kind)?m.kind:'oil';
    const t=R.players.filter(q=>q!==p&&q.alive);
    if(t.length)send(t[(Math.random()*t.length)|0].ws,{type:'atk',kind:k,from:p.id});
   }
   if(m.type==='score'&&R.code==='PUB'){
    if(typeof m.km!=='number'||!isFinite(m.km)||m.km<0||m.km>500)return;
    GLOBAL.push({name:sanitizeName(m.name),time:Math.max(0,Math.min(3600,m.time|0)),km:+m.km||0,pts:Math.max(0,Math.min(1e6,m.pts|0))});
    GLOBAL.sort((a,b)=>b.km-a.km);
    GLOBAL=GLOBAL.slice(0,50);
    saveRank();
    send(ws,{type:'rank',rank:GLOBAL});
   }
   if(m.type==='getrank')send(ws,{type:'rank',rank:R.code==='PUB'?GLOBAL:Object.keys(R.cp).map(id=>({name:R.cpName[id],cp:R.cp[id]})).sort((a,b)=>b.cp-a.cp)});
  });
  ws.on('close',()=>leave());
  ws.on('error',e=>console.error('ws',p.id,e.message));
 });
 wss.on('error',e=>console.error('wss',e.message));

 return {
  wss,
  rooms,
  get globalRank(){return GLOBAL;},
  get profiles(){return PROF;},
  address:()=>wss.address(),
  close:()=>new Promise(resolve=>{
   timers.forEach(clearInterval);
   wss.clients.forEach(client=>client.terminate());
   wss.close(()=>resolve());
  })
 };
}

if(require.main===module){
 const app=createServer();
 process.on('uncaughtException',e=>console.error('uncaught',e));
 app.wss.on('listening',()=>console.log('SPEED RIVALS online en puerto '+app.address().port));
}

module.exports={
 createServer,
 cleanName,
 badName,
 sanitizeName,
 sanitizeRoom,
 constants:{MAX,DUR,MTR,LANES,RANKCP}
};

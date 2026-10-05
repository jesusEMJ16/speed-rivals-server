const test=require('node:test'),assert=require('node:assert/strict'),WS=require('ws');
const {createServer}=require('../server');
test('connection time also shortens an existing public queue without extending its deadline',async()=>{
 const app=createServer({port:0,redis:null,storage:{async load(){return null;},async save(){}},tickMs:20});
 const sockets=[];
 async function client(name){
  const ws=new WS('ws://127.0.0.1:'+app.address().port),inbox=[];sockets.push(ws);
  ws.on('message',raw=>inbox.push(JSON.parse(raw)));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const wait=async type=>{const stop=Date.now()+2000;while(Date.now()<stop){const message=inbox.find(m=>m.type===type);if(message)return message;await new Promise(r=>setTimeout(r,5));}throw Error('Missing '+type);};
  ws.send(JSON.stringify({type:'hello',protocol:2,name}));await wait('welcome');return {ws,wait};
 }
 try{
  await app.ready;const a=await client('First'),b=await client('Slow connection');
  a.ws.send(JSON.stringify({type:'joinpub',mode:'normal',waitedMs:0}));const first=await a.wait('joined'),room=app.rooms.get(first.code),original=room.queueAt;
  b.ws.send(JSON.stringify({type:'joinpub',mode:'normal',waitedMs:8500}));const second=await b.wait('joined');
  assert.equal(second.code,first.code);assert.ok(room.queueAt<original-7000,'elapsed connection time must count even for an existing queue');
  assert.ok(room.queueAt-Date.now()<=700,'only the remaining portion of nine seconds may be queued');
 }finally{for(const socket of sockets)socket.terminate();await app.close();}
});

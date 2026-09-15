'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Bots=require('../bots');
test('server racers have finite monotonic distance and modes never create forbidden inventory',()=>{
 for(const mode of ['normal','subita','supervivencia']){
  const bots=Bots.create(8,1456,mode),before=new Map();let attacks=0;
  for(let i=0;i<1200;i++)for(const b of bots){
   const previous=before.get(b.id)||0;Bots.tick(b,.05,mode,bots,()=>{attacks++;return true;});
   assert(Number.isFinite(b.d)&&b.d>=previous);assert(b.d<=1600*1.6*(i+1)*.05);assert(b.lane>=0&&b.lane<3);
   assert(b.obs.length<80);assert(b.pickups.length<30);if(mode!=='normal')assert.equal(b.item,null);before.set(b.id,b.d);
  }
  assert(bots.every(b=>b.d>0));if(mode!=='normal')assert.equal(attacks,0);
 }
});
test('server racers collect before attacking, respond to attacks and stop advancing after death',()=>{
 const [b,c]=Bots.create(2,454,'normal');let attacks=0;
 for(let i=0;i<12;i++)Bots.tick(b,.05,'normal',[b,c],()=>{attacks++;return true;});assert.equal(attacks,0);
 b.pickups=[{kind:'item',item:'rayo',x:b.x,y:592}];Bots.tick(b,.05,'normal',[b,c],()=>{attacks++;return true;});assert.equal(b.item,'rayo');
 for(let i=0;i<30;i++)Bots.tick(b,.05,'normal',[b,c],()=>{attacks++;return true;});assert.equal(attacks,1);assert.equal(b.item,null);
 b.shield=1;Bots.receive(b,'rayo');assert.equal(b.shield,0);assert.equal(b.attackSlowT,0);
 Bots.receive(b,'rayo');assert.equal(b.attackSlowT,2.5);Bots.receive(b,'emp');assert(b.meter<=15);
 b.lives=1;b.invuln=0;b.obs=[{t:'car',x:b.x,y:592,w:40,h:74}];Bots.tick(b,.05,'normal',[b,c],()=>false);assert.equal(b.alive,false);
 const distance=b.d;Bots.tick(b,1,'normal',[b,c],()=>{throw Error('dead racer attacked');});assert.equal(b.d,distance);
});

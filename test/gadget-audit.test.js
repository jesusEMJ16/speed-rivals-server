const test=require('node:test'),assert=require('node:assert/strict'),Bots=require('../bots');

test('server bots use turbo locally for 2.5 seconds instead of emitting an invalid attack',()=>{
 for(const fps of [30,60,120]){
  const [b]=Bots.create(1,415,'normal');b.model={...b.model,heat:false,regen:0};b.item='turbo';b.itemAge=1;b.meter=60;b.nextGap=1e9;b.brain.wait=0;
  let attacks=0;
  Bots.tick(b,1/fps,'normal',[b],()=>{attacks++;return false;});
  assert.equal(attacks,0,'beneficial turbo must never emit an attack');assert.equal(b.item,null);assert.equal(b.boostT,1);
  b.brain.wait=10;b.boostIntent=false;const meter=b.meter;
  for(let i=0;i<fps*2;i++)Bots.tick(b,1/fps,'normal',[b],()=>{throw Error('unexpected attack');});
  assert.equal(b.boostT,1);assert.equal(b.meter,meter);
  for(let i=0;i<fps;i++)Bots.tick(b,1/fps,'normal',[b],()=>{throw Error('unexpected attack');});
  assert.equal(b.itemBoostT,0);assert.equal(b.boostT,0);
 }
});
test('server EMP also clears active gadget turbo so it cannot restart next tick',()=>{
 const [b]=Bots.create(1,415,'normal');b.itemBoostT=2;b.boostT=1;b.meter=90;b.brain.wait=10;
 Bots.receive(b,'emp');assert.equal(b.itemBoostT,0);assert.equal(b.boostT,0);
 Bots.tick(b,.05,'normal',[b],()=>false);assert.equal(b.boostT,0);
});
test('normal server bot roads can naturally provide the turbo their brain knows how to use',()=>{
 const [b]=Bots.create(1,415,'normal'),randoms=[0,0,.5,0,.99,.1,.65,0];
 b.rng=()=>randoms.shift()??.5;b.brain.wait=10;b.nextGap=0;
 Bots.tick(b,.01,'normal',[b],()=>false);
 assert.equal(b.pickups.length,1);assert.equal(b.pickups[0].item,'turbo');
});

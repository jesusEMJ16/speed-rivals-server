(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.BotBrain=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  // Fictional AI aliases, not identities or claims of connected human players.
  const groups={
    es:['Centella','Brisa','Cometa','Zorro','Cobalto','Trueno'],
    en:['Ember','Swift','Drift','Flint','Blaze','Comet'],
    pt:['Faísca','Vento','Falcão','Maré','Luar','Raio'],
    fr:['Éclair','Plume','Renard','Aurore','Foudre','Braise'],
    de:['Blitz','Falke','Funke','Sturm','Wolke','Fuchs'],
    ru:['Искра','Ветер','Сокол','Волна','Гром','Лиса'],
    zh:['流星','闪电','疾风','赤狐','苍鹰','晨光'],
    ja:['流星丸','稲妻','疾風丸','紅狐','隼丸','朝霧'],
    ko:['번개','혜성','바람','여우','매','새벽'],
    hi:['बिजली','आँधी','बाज़','चिंगारी','किरण','लहर'],
    bn:['ঝড়','বাজ','শিখা','তরঙ্গ','ধূমকেতু','ভোর'],
    ar:['برق','صقر','نسيم','شهاب','موج','شرارة'],
    ur:['چمک','آندھی','شعلہ','موجیں','شاہین','کرن'],
    id:['Kilat','Bara','Bayu','Elang','Ombak','Fajar']
  };
  const roster=Object.entries(groups).flatMap(([language,names])=>names.map(name=>Object.freeze({name,language})));
  const names=Object.freeze(roster.map(r=>r.name));
  function random(seed){return function(){seed|=0;seed=seed+0x6D2B79F5|0;let t=Math.imul(seed^seed>>>15,1|seed);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
  function shuffle(values,rng){const result=values.slice();for(let i=result.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;}
  function selectRoster(seed,count){
    const rng=random(seed),languages=shuffle(Object.keys(groups),rng);
    return languages.slice(0,Math.max(0,Math.min(8,Math.floor(count)||0))).map(language=>({language,name:groups[language][Math.floor(rng()*groups[language].length)]}));
  }
  const profiles=Object.freeze({
    cautious:{reaction:.34,jitter:.12,horizon:2.4,dwell:.8,coin:1.1,item:1.9,reserve:48,boostHorizon:2.1,heatLimit:1.65},
    aggressive:{reaction:.23,jitter:.12,horizon:1.7,dwell:.52,coin:.6,item:1.5,reserve:24,boostHorizon:1.35,heatLimit:2.05},
    collector:{reaction:.3,jitter:.14,horizon:2.1,dwell:.7,coin:2.2,item:3.1,reserve:42,boostHorizon:1.8,heatLimit:1.8},
    tactician:{reaction:.27,jitter:.12,horizon:2.3,dwell:.65,coin:1,item:2.6,reserve:35,boostHorizon:1.9,heatLimit:1.8},
    balanced:{reaction:.29,jitter:.14,horizon:2,dwell:.65,coin:1.2,item:2,reserve:35,boostHorizon:1.7,heatLimit:1.85}
  });
  function create(seed,style,hard){
    const rng=random(seed),p=profiles[style]||profiles.balanced;
    const reaction=Math.max(.2,p.reaction-(hard?.03:0));
    return {style:profiles[style]?style:'balanced',profile:p,rng,reaction,wait:reaction+rng()*p.jitter,commit:0,tie:rng()<.5?-1:1};
  }
  // Check the time interval in which each obstacle overlaps the driver's Y.
  // Testing its entry/midpoint/exit also detects obstacles swept through on a lane change.
  function danger(view,lane,horizon,speedMultiplier,nextStep){
    const goal=view.lanes[lane],start=Number.isFinite(view.x)?view.x:view.lanes[view.lane],response=14*(view.laneSpd||1);
    const position=t=>{
      if(!nextStep||t<=nextStep.after)return goal+(start-goal)*Math.exp(-response*t);
      const atTurn=goal+(start-goal)*Math.exp(-response*nextStep.after),end=view.lanes[nextStep.lane];
      return end+(atTurn-end)*Math.exp(-response*(t-nextStep.after));
    };
    let earliest=Infinity,risk=0;
    for(const obstacle of view.obstacles||[]){
      if(obstacle.hit)continue;
      const velocity=Math.max(1,(view.speed||0)*(speedMultiplier||1)+(obstacle.own||0));
      const halfH=((view.height||66)+(obstacle.h||30))/2;
      const enter=(view.y-halfH-obstacle.y)/velocity,leave=(view.y+halfH-obstacle.y)/velocity;
      if(leave<0||enter>horizon)continue;
      const from=Math.max(0,enter),to=Math.min(horizon,leave);
      const halfW=((view.width||38)+(obstacle.w||30))/2;
      const samples=[from,(from+to)/2,to];
      if(nextStep)for(const t of [nextStep.after,nextStep.after+.08])if(t>=from&&t<=to)samples.push(t);
      const collision=samples.some(t=>Math.abs(position(t)-obstacle.x)<halfW);
      if(collision){earliest=Math.min(earliest,from);risk+=1+(horizon-from)*3;}
    }
    return {time:earliest,risk};
  }
  function urgency(threat){return Number.isFinite(threat.time)?-1000/(1+threat.time)-threat.risk:0;}
  function routeDanger(brain,view,lane){
    const horizon=brain.profile.horizon;
    let best=danger(view,lane,horizon);
    // Plan one more adjacent move after another real reaction interval.
    // Only the first move is issued; the next decision rechecks the entire road.
    const after=brain.reaction+brain.profile.jitter;
    for(const next of [lane-1,lane+1])if(next>=0&&next<view.lanes.length){
      const route=danger(view,lane,horizon,1,{lane:next,after});
      if(urgency(route)>urgency(best))best=route;
    }
    return best;
  }
  function targetFor(view){
    let target=null,best=Infinity;
    for(const rival of view.rivals||[]){
      if(rival.alive===false)continue;
      const gap=(rival.distance||0)-(view.distance||0);
      if(Math.abs(gap)>Math.max(700,(view.speed||0)*5))continue;
      const score=Math.abs(gap)+(gap<0?250:0)+(rival.shield?180:0);
      if(score<best){best=score;target=rival;}
    }
    return target;
  }
  function decide(brain,view){
    const p=brain.profile,current=danger(view,view.lane,p.horizon),emergency=current.time<.8;
    let best=view.lane,bestScore=-Infinity;
    for(let lane=Math.max(0,view.lane-1);lane<=Math.min(view.lanes.length-1,view.lane+1);lane++){
      if(lane!==view.lane&&brain.commit>0&&!emergency)continue;
      const direct=danger(view,lane,p.horizon),threat=routeDanger(brain,view,lane);
      // First-impact urgency dominates obstacle count: two distant cars must
      // never make a lane look worse than a car we would hit immediately.
      let score=urgency(threat)-Math.min(5,direct.risk)*.3+(lane===view.lane?.65:0);
      if(!Number.isFinite(direct.time)){
        for(const pickup of view.pickups||[]){
          const time=(view.y-pickup.y)/Math.max(1,view.speed||0);
          if(time<0||time>p.horizon||Math.abs(pickup.x-view.lanes[lane])>35)continue;
          if(pickup.kind==='item'&&view.item)continue;
          score+=(pickup.kind==='item'?p.item:p.coin)/(1+time*.4);
        }
      }
      score+=lane===view.lane?0:(lane-view.lane)*brain.tie*.001;
      if(score>bestScore){bestScore=score;best=lane;}
    }
    if(best!==view.lane)brain.commit=p.dwell;
    const boostRoad=danger(view,view.lane,p.boostHorizon,1.35);
    const reserve=view.boostT>.1?Math.max(12,p.reserve*.4):p.reserve;
    const boost=best===view.lane&&!Number.isFinite(boostRoad.time)&&(view.meter||0)>reserve&&
      (view.heat||0)<p.heatLimit&&!(view.trouble>0)&&!(view.slow>0);
    const target=targetFor(view),ready=(view.itemAge||0)>=.6;
    let useItem=false;
    if(ready&&view.item){
      if(view.item==='shield')useItem=!view.shield&&current.time<1.2;
      else if(view.item==='vida')useItem=view.lives<view.maxLives;
      else if(view.item==='turbo')useItem=boost&&(view.meter||0)<75;
      else if(view.item==='reloj')useItem=boost;
      else if(view.item==='rampa')useItem=danger({...view,obstacles:(view.obstacles||[]).filter(o=>['oil','spike','cone'].includes(o.t))},view.lane,.65).time<.65;
      else if(view.item==='magnet')useItem=(view.pickups||[]).some(pickup=>pickup.kind==='coin'&&pickup.y<view.y&&view.y-pickup.y<Math.max(250,(view.speed||0)*2));
      else if(view.item==='emp')useItem=!!target&&(view.rivals||[]).some(r=>r.alive!==false&&(r.shield||r.boostT>.3));
      else useItem=!!target&&!emergency;
    }
    return {lane:best,boost,useItem,target:target?target.id:null};
  }
  function tick(brain,dt,view){
    const step=Math.max(0,dt||0);brain.commit=Math.max(0,brain.commit-step);brain.wait-=step;
    if(brain.wait>0)return null;
    brain.wait+=brain.reaction+brain.rng()*brain.profile.jitter;
    return decide(brain,view);
  }
  return {roster:Object.freeze(roster),names,profiles,random,selectRoster,create,danger,decide,tick};
});

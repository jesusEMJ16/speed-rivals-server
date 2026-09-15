(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaceCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  return {
    // Canonical world-v2 distance: the original 800px reference viewport.
    // Only rendering and collision coordinates depend on the current height.
    worldSpeed(kmh) { return (Number.isFinite(kmh)?kmh:0)*800*.002; },
    worldToScreen(distance,height=800) { return distance*(Number.isFinite(height)&&height>0?height:800)/800; },
    screenToWorld(distance,height=800) { return distance*800/(Number.isFinite(height)&&height>0?height:800); },
    // Relative swept AABB: detect contact anywhere in the frame, including
    // objects which have already passed the player by the time we render.
    sweptOverlap(ax0,ay0,ax1,ay1,aw,ah,bx0,by0,bx1,by1,bw,bh) {
      let enter=0,leave=1;
      for(const [offset,velocity,radius] of [
        [ax0-bx0,(ax1-ax0)-(bx1-bx0),(aw+bw)/2],
        [ay0-by0,(ay1-ay0)-(by1-by0),(ah+bh)/2]
      ]) {
        if(Math.abs(velocity)<1e-9){if(Math.abs(offset)>=radius)return false;continue;}
        const a=(-radius-offset)/velocity,b=(radius-offset)/velocity;
        enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));
        if(enter>=leave)return false;
      }
      return true;
    },
    beginSwipe(id, x, y) { return {id, x, y, laneUsed: false, verticalUsed: false}; },
    moveSwipe(gesture, id, x, y) {
      if (!gesture || gesture.id !== id) return null;
      const dx = x - gesture.x, dy = y - gesture.y;
      const lane = !gesture.laneUsed && Math.abs(dx) >= 28 ? Math.sign(dx) : 0;
      const vertical = !gesture.verticalUsed && Math.abs(dy) >= 44 ? -Math.sign(dy) : 0;
      if (!lane && !vertical) return null;
      if(lane)gesture.laneUsed=true;
      if(vertical)gesture.verticalUsed=true;
      return {lane, vertical};
    },
    approach(value, target, response, dt) {
      return value + (target - value) * (1 - Math.exp(-response * Math.max(0, dt)));
    },
    trackNearMiss(obstacle, x, y, width, height, ineligible) {
      if (obstacle.nm) return false;
      const dx = Math.abs(obstacle.x - x), dy = obstacle.y - y;
      const halfWidth = (width + obstacle.w) / 2;
      const halfHeight = (height + obstacle.h) / 2;
      if (Math.abs(dy) < halfHeight) {
        if (ineligible || dx < halfWidth) { obstacle.nm = 1; return false; }
        if (dx <= halfWidth + 22) obstacle.closePass = true;
      }
      if (dy > halfHeight) {
        obstacle.nm = 1;
        return !!obstacle.closePass && !ineligible;
      }
      return false;
    },
    nitroState(state) {
      if (state.trouble > 0) return 'cooling';
      if (state.turboLock) return 'release';
      if (state.meter <= 1) return 'charging';
      if (state.boostT > .12) return 'active';
      return 'ready';
    }
  };
});

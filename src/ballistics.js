// =============================================================================
// ballistics.js — bullets as real projectiles.
//
// Many shooters use "hitscan" (an instant ray). Realistic shooters (ARMA,
// Squad, Battlefield) simulate each round: it has velocity, falls under
// gravity, takes time to arrive, and can punch through thin cover. Each frame
// we move every bullet one step and ray-test only that short segment.
// =============================================================================
import * as THREE from 'three';

const G = 9.81;
const TRACER_LEN = 9;
const _dir = new THREE.Vector3(), _a = new THREE.Vector3(), _head = new THREE.Vector3(), _tail = new THREE.Vector3();
const _pt = new THREE.Vector3(), _ab = new THREE.Vector3(), _ap = new THREE.Vector3();

export class Ballistics {
  constructor(world, effects, audio) {
    this.world = world;
    this.effects = effects;
    this.audio = audio;
    this.bullets = [];
    // Things bullets can hit besides the world. Each has
    // raycast(origin, dir, maxDist, team) -> { dist, point, zone, entity } | null
    this.targets = [];
    this.listener = null;     // () => player's head position, for near-miss cracks
    this.onNearMiss = null;   // (distance) => void
    this.onWorldImpact = null;
  }

  // origin/dir in world space. visualOffset = muzzle - origin, so the tracer
  // appears to leave the barrel even though the bullet starts at the eye.
  // shooter: who fired (the AI uses it to know who to fight back against).
  // replica: a co-op squadmate's bullet, replayed here so we see it. It
  //   flies, leaves tracers and holes, but can't hurt anyone, because the
  //   squadmate's own computer decides what it hit (see coop.js).
  fire({ origin, dir, speed, damage, team, penetration = 0, tracer = false, visualOffset = null, falloff = null, headMul = 4, limbMul = 0.7, shooter = null, replica = false }) {
    this.bullets.push({
      pos: origin.clone(),
      start: origin.clone(),
      vel: dir.clone().multiplyScalar(speed),
      damage, team, pen: penetration, falloff, headMul, limbMul, shooter, replica,
      age: 0,
      tracer: tracer ? this.effects.acquireTracer() : null,
      visOffset: visualOffset ? visualOffset.clone() : null,
      nearMissDone: false,
    });
  }

  clear() {
    for (const b of this.bullets) this.effects.releaseTracer(b.tracer);
    this.bullets.length = 0;
  }

  update(dt) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      if (!this._step(b, dt)) {
        this.effects.releaseTracer(b.tracer);
        this.bullets[i] = this.bullets[this.bullets.length - 1];
        this.bullets.pop();
      }
    }
  }

  _damageAt(b) {
    if (!b.falloff) return b.damage;
    const d = b.pos.distanceTo(b.start), f = b.falloff;
    if (d <= f.start) return b.damage;
    const t = Math.min(1, (d - f.start) / (f.end - f.start));
    return b.damage * (1 - t * (1 - f.min));
  }

  // Returns false when the bullet is finished.
  _step(b, dt) {
    b.age += dt;
    if (b.age > 3 || b.pos.y < -2) return false;
    b.vel.y -= G * dt;
    const speed = b.vel.length();
    _dir.copy(b.vel).divideScalar(speed);
    let remaining = speed * dt;
    _a.copy(b.pos);

    for (let guard = 0; remaining > 0 && guard < 4; guard++) {
      const wh = this.world.raycastAll(b.pos, _dir, remaining)[0] || null;
      let target = null;
      for (const t of this.targets) {
        const r = t.raycast(b.pos, _dir, remaining, b.team);
        if (r && (!target || r.dist < target.dist)) target = r;
      }

      if (target && (!wh || target.dist <= wh.dist)) {
        b.pos.addScaledVector(_dir, target.dist);
        if (!b.replica) {
          target.entity.onBulletHit({
            damage: this._damageAt(b), zone: target.zone, point: target.point.clone(),
            dir: _dir.clone(), team: b.team, headMul: b.headMul, limbMul: b.limbMul,
            from: b.start.clone(), shooter: b.shooter,
          });
        }
        if (!target.entity.isPlayer) {
          this.effects.blood(target.point, _dir);
          this.audio.impact(target.point, 'flesh');
        }
        return false;
      }

      if (wh) {
        const surface = wh.collider.surface;
        _pt.copy(b.pos).addScaledVector(_dir, wh.dist);
        this.effects.impact(_pt, wh.normal, surface);
        this.audio.impact(_pt, surface);
        if (this.onWorldImpact) this.onWorldImpact(_pt, b.team, b);
        // Penetration: thin/soft things (wood, sheet metal, canvas) can be shot through.
        if (wh.collider.pen <= b.pen) {
          b.pen -= wh.collider.pen;
          b.damage *= 0.6;
          b.vel.multiplyScalar(0.75);
          const exitDist = wh.exit + 0.01;
          b.pos.addScaledVector(_dir, exitDist);
          _pt.copy(_dir).negate();
          this.effects.decal(b.pos, _dir, 0.06); // exit hole on the far side
          remaining -= exitDist;
          continue;
        }
        return false;
      }
      b.pos.addScaledVector(_dir, remaining);
      remaining = 0;
    }

    // Near miss: closest point of this frame's path to the listener's head.
    if (b.team === 'enemy' && !b.nearMissDone && this.listener) {
      const head = this.listener();
      _ab.subVectors(b.pos, _a);
      _ap.subVectors(head, _a);
      const t = Math.max(0, Math.min(1, _ap.dot(_ab) / Math.max(1e-6, _ab.lengthSq())));
      _pt.copy(_a).addScaledVector(_ab, t);
      const d = _pt.distanceTo(head);
      if (d < 2.5) {
        b.nearMissDone = true;
        this.audio.whiz(_pt);
        if (this.onNearMiss) this.onNearMiss(d);
      }
    }

    if (b.tracer) {
      _head.copy(b.pos);
      if (b.visOffset) _head.addScaledVector(b.visOffset, Math.max(0, 1 - b.age / 0.08));
      const len = Math.min(TRACER_LEN, b.pos.distanceTo(b.start));
      _tail.copy(_head).addScaledVector(_dir, -len);
      this.effects.drawTracer(b.tracer, _head, _tail, b.team === 'player' ? 0.02 : 0.035);
    }
    return true;
  }
}

// =============================================================================
// campaign/escort.js — a person the squad has to keep alive (an "escort" or
// VIP). Mission 2's Dr. Elise Marr.
//
//   captive  kneeling where she's held, until someone cuts her free
//   follow   stays close to the NEAREST squad member, using the same
//            navigation grid as the enemy AI (nav.js). Far behind, she runs;
//            once she's caught up she crouches, so she's a smaller target.
//
// Enemies can see and shoot her. To the AI she looks like any other target
// (enemy.js reads pos, eyePosition, height, crouched and alive), and enemy
// bullets test her hit boxes through raycast(), like EnemyManager.raycast.
//
// Co-op: only the HOST runs her (Escort). Everyone else draws an
// EscortPuppet that copies the host's snapshots, like the enemy puppets in
// coop.js.
// =============================================================================
import * as THREE from 'three';
import { Interpolator, LERP, ANGLE, STEP, r2, r3 } from '../net.js';
import { NET } from '../config.js';

const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
const angleDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
const _c = new THREE.Vector3(), _w = new THREE.Vector3();

const RUN = 4.6, WALK = 2.4;   // she keeps up with a jogging squad; sprint and she falls behind
const NEAR = 2.8, FAR = 9;     // stop within NEAR metres of her leader; run if further than FAR

export class Escort {
  // sys = { scene, world, nav, factory, audio }; look = an avatar (avatar.js)
  constructor(sys, { look, name }) {
    Object.assign(this, sys);
    this.name = name;
    this.body = this.factory.create({ avatar: look });
    this.root = this.body.root;
    this.scene.add(this.root);
    for (const m of this.body.hitMeshes) m.userData.vip = this;
    this.raycaster = new THREE.Raycaster();
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.radius = 0.3; this.height = 1.8; this.onGround = true;
    this._eye = new THREE.Vector3();
    this.reset(new THREE.Vector3(), 0, 'captive');
  }

  // Put her somewhere: state 'captive' (kneeling, waiting) or 'follow'
  reset(pos, yaw, state, health = 100) {
    this.pos.copy(pos);
    this.pos.y = this.world.groundHeight(pos.x, pos.z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.state = state;
    this.health = health;
    this.alive = true;
    this.deathT = -1;
    this.crouch = state === 'captive' ? 1 : 0;
    this.flinch = 0;
    this.path = null; this.pathIdx = 0; this.repath = 0; this.stuck = 0;
    this.speed = 0;
    this.walkPhase = 0;
    this.root.visible = true;
    this.root.rotation.x = 0;
  }

  // ---- what the enemy AI reads (same fields as the player / a Teammate)
  get crouched() { return this.crouch > 0.5; }
  get prone() { return false; }
  get horizontalSpeed() { return this.speed; }
  get eyePosition() { return this._eye.set(this.pos.x, this.pos.y + (this.crouched ? 1.05 : 1.62), this.pos.z); }
  get targetable() { return this.alive && this.state === 'follow'; } // nobody shoots a hostage tied to a chair
  // The AI picks the nearest target it can see, but treats her as 2.5x further
  // away than she is: they shoot at the squad first. (Escort missions where
  // every enemy goes straight for the VIP are no fun.)
  get aiWeight() { return 2.5; }

  // ---- bullets (enemy team only: the squad's bullets pass her by)
  raycast(origin, dir, maxDist) {
    if (!this.alive) return null;
    _c.set(this.pos.x, this.pos.y + 0.9, this.pos.z).sub(origin);
    const t = THREE.MathUtils.clamp(_c.dot(dir), 0, maxDist);
    if (_w.copy(dir).multiplyScalar(t).distanceToSquared(_c) > 1.44) return null; // nowhere near her
    this.raycaster.set(origin, dir);
    this.raycaster.far = maxDist;
    const hit = this.raycaster.intersectObjects(this.body.hitMeshes, false)[0];
    return hit ? { dist: hit.distance, point: hit.point, zone: hit.object.userData.zone, entity: this } : null;
  }

  onBulletHit(info) {
    if (!this.alive) return;
    const mul = info.zone === 'head' ? 2.2 : info.zone === 'limb' ? 0.6 : 1;
    this.health -= info.damage * mul * 0.7; // a little tougher than she looks: escort missions shouldn't end in one burst
    this.flinch = 1;
    this.onHurt?.();
    if (this.health <= 0) { this.health = 0; this.alive = false; this.deathT = 0; this.path = null; this.onDeath?.(); }
  }

  // ---- every frame (host / solo)
  // members = the squad: [{ pos, alive }]
  update(dt, members) {
    this.flinch = Math.max(0, this.flinch - dt * 5);
    if (!this.alive) {
      this.deathT = Math.min(1, this.deathT + dt * 1.6);
      this._animate(dt, 0);
      return;
    }
    let want = null, dist = 0;
    if (this.state === 'follow') {
      for (const m of members) {
        if (!m.alive) continue;
        const d = m.pos.distanceTo(this.pos);
        if (!want || d < dist) { want = m.pos; dist = d; }
      }
    }
    if (want && dist > NEAR) {
      if ((this.repath -= dt) <= 0 || !this.path) {
        this.repath = 0.5;
        const p = this.nav.findPath(this.pos, want);
        // Ground only: she won't climb a ladder after you (stop at the foot)
        const cut = p ? p.findIndex((w) => w.ladder) : -1;
        this.path = p && cut !== 0 ? (cut > 0 ? p.slice(0, cut) : p) : null;
        this.pathIdx = 0;
      }
    } else this.path = null;

    // Walk the path (like Enemy._followPath)
    let speed = 0;
    if (this.path && this.pathIdx < this.path.length) {
      const wp = this.path[this.pathIdx];
      const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z, d = Math.hypot(dx, dz);
      if (d < 0.35) this.pathIdx++;
      else {
        speed = dist > FAR ? RUN : WALK;
        this.vel.x = (dx / d) * speed;
        this.vel.z = (dz / d) * speed;
        this.yaw += THREE.MathUtils.clamp(angleDiff(this.yaw, yawTo(dx, dz)), -8 * dt, 8 * dt);
      }
    }
    if (!speed) { this.vel.x *= 0.7; this.vel.z *= 0.7; }
    if (want && !speed) this.yaw += THREE.MathUtils.clamp(angleDiff(this.yaw, yawTo(want.x - this.pos.x, want.z - this.pos.z)), -4 * dt, 4 * dt);
    this.vel.y -= 9.81 * dt;
    this.world.moveBody(this, dt, 0.45);
    this.speed = Math.hypot(this.vel.x, this.vel.z);

    // Crouch while captive, and when she's stopped next to you
    const low = this.state === 'captive' || (this.state === 'follow' && this.speed < 0.5);
    this.crouch += ((low ? 1 : 0) - this.crouch) * Math.min(1, dt * 5);

    const before = Math.floor(this.walkPhase / Math.PI);
    this.walkPhase += (this.speed * dt * Math.PI) / 0.8;
    if (Math.floor(this.walkPhase / Math.PI) !== before && this.speed > 0.5) this.audio.enemyFootstep(this.pos, this.speed > 3 ? 1 : 0.5);
    this._animate(dt, this.speed);
  }

  _animate(dt, speed) {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.body.animate(dt, { speed, crouch: this.crouch, aiming: 0, aimPitch: 0, deathT: this.alive ? -1 : this.deathT, flinch: this.flinch, climb: 0, climbPhase: 0 });
  }

  // On the wire (co-op): [x, y, z, yaw, speed, crouch, alive, health, following]
  pack() {
    return [r2(this.pos.x), r2(this.pos.y), r2(this.pos.z), r3(this.yaw), r2(this.speed), r2(this.crouch), this.alive ? 1 : 0, Math.round(this.health), this.state === 'follow' ? 1 : 0];
  }

  dispose() { this.scene.remove(this.root); this.body.setAvatar(null); }
}

// =============================================================================
// The escort as seen by a co-op friend: copies the host's snapshots.
const MODES = [LERP, LERP, LERP, ANGLE, LERP, LERP, STEP, STEP, STEP];

export class EscortPuppet {
  constructor({ scene, factory, audio }, { look, name }, clock) {
    Object.assign(this, { scene, audio, clock, name });
    this.body = factory.create({ avatar: look });
    this.root = this.body.root;
    scene.add(this.root);
    this.interp = new Interpolator(MODES);
    this.pos = new THREE.Vector3();
    this.alive = true;
    this.health = 100;
    this.state = 'captive';
    this.deathT = -1;
    this.walkPhase = 0;
  }

  push(T, v) {
    this.interp.push(T, v);
    this.health = v[7];
    this.state = v[8] ? 'follow' : 'captive';
  }

  update(dt) {
    const s = this.interp.sample(this.clock.now() - NET.interpDelay);
    if (!s) return;
    this.pos.set(s[0], s[1], s[2]);
    const alive = s[6] === 1;
    if (!alive && this.alive) this.deathT = 0;
    this.alive = alive;
    if (!alive) this.deathT = Math.min(1, this.deathT + dt * 1.6);
    else this.deathT = -1;
    const before = Math.floor(this.walkPhase / Math.PI);
    this.walkPhase += (s[4] * dt * Math.PI) / 0.8;
    if (Math.floor(this.walkPhase / Math.PI) !== before && s[4] > 0.5) this.audio.enemyFootstep(this.pos, s[4] > 3 ? 1 : 0.5);
    this.root.position.copy(this.pos);
    this.root.rotation.y = s[3];
    this.body.animate(dt, { speed: alive ? s[4] : 0, crouch: s[5], aiming: 0, aimPitch: 0, deathT: alive ? -1 : this.deathT, flinch: 0, climb: 0, climbPhase: 0 });
  }

  dispose() { this.scene.remove(this.root); this.body.setAvatar(null); }
}

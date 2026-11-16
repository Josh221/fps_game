// =============================================================================
// enemy.js — enemy soldier AI.
//
// Each soldier runs a small FINITE STATE MACHINE:
//
//   idle / patrol --(hears something)--> alert (investigate)
//         |                                   |
//         +------(sees you long enough)-------+--> combat --(lost you)--> alert
//
// Perception is gradual: an "awareness" meter fills faster when you're close,
// moving, standing or already suspected — so crouching at range lets you
// sneak. In combat they take cover, peek, fire in bursts, reload behind cover,
// get suppressed by near misses, and share your position with friends.
//
// In co-op there are several players. The manager hands every soldier a list
// of TARGETS (you plus your squadmates; see teammate.js), and each soldier
// fights whichever one he's spotted. The AI only reads a few fields from a
// target (pos, eyePosition, height, crouched, horizontalSpeed, alive), so it
// doesn't care whether that's you or a friend on another computer.
//
// LADDERS: a path may contain a ladder step (nav.js "off-mesh links"). The
// soldier walks to the foot (or the roof landing), slings his rifle and
// climbs — taking turns if a friend is already on it. Climb up onto a roof
// and he'll follow you up there; he can't shoot while his hands are full.
//
// GUNS: not everyone carries the same one. issueFor() rolls each soldier's
// gun and spare magazines from his network id (config.js ENEMY_ISSUE), and he
// fires it its own way: an LMG gunner in long bursts, a marksman a shot or two
// at a time. When he's killed, what he carried is yours to take (loot.js).
// =============================================================================
import * as THREE from 'three';
import { AI, DIFFICULTY, ENEMY_ISSUE } from './config.js';
import { mulberry32 } from './textures.js';

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _eye = new THREE.Vector3(), _threatEye = new THREE.Vector3();
const _dir = new THREE.Vector3(), _muz = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const _origin = new THREE.Vector3(), _off = new THREE.Vector3(), _c = new THREE.Vector3();
const rand = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const angleDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
const yawTo = (dx, dz) => Math.atan2(-dx, -dz); // yaw that faces direction (dx, dz); matches the camera convention

// What soldier #id carries: his gun (an ENEMY_ISSUE entry, with AI's numbers
// for anything it leaves out), how full its magazine is and how many rounds
// are in his pouches. Rolled from his id, so the host and every co-op friend
// get the same answer without sending it.
export function issueFor(id) {
  const r = mulberry32(((id | 0) * 2654435761) >>> 0);
  const total = ENEMY_ISSUE.reduce((n, g) => n + g.share, 0);
  let x = r() * total, i = 0;
  while (i < ENEMY_ISSUE.length - 1 && x >= ENEMY_ISSUE[i].share) x -= ENEMY_ISSUE[i++].share;
  const g = ENEMY_ISSUE[i], mag = g.mag ?? AI.magSize, [s0, s1] = g.spare ?? [1, 3];
  return {
    index: i, gun: g.gun, mag, reload: g.reload ?? AI.reloadTime,
    rpm: g.rpm ?? AI.rpm, burst: g.burst ?? [AI.burstMin, AI.burstMax], damage: g.damage ?? 1, spread: g.spread ?? 1,
    magLeft: Math.max(1, Math.round(mag * (0.25 + r() * 0.75))), // what's still in his gun when he drops it
    spare: mag * (s0 + Math.floor(r() * (s1 - s0 + 1))),        // rounds in his pouches
  };
}

class Enemy {
  constructor(mgr, spawn) {
    this.mgr = mgr;
    this.body = mgr.factory.create({ seed: mgr.nextNetId + 1 }); // which soldier model: from the id he's about to get, so co-op friends see the same face
    this.issue = issueFor(mgr.nextNetId + 1);                   // and which gun (the same way)
    this.body.setGun(mgr.factory.issueGun(this.issue.gun));
    this.root = this.body.root;
    mgr.scene.add(this.root);
    for (const m of this.body.hitMeshes) m.userData.enemy = this;

    this.pos = spawn.pos.clone();
    if (spawn.role !== 'sentry' && !spawn.keepY) this.pos.y = mgr.world.groundHeight(this.pos.x, this.pos.z);
    this.vel = new THREE.Vector3();
    this.radius = 0.3; this.height = 1.8; this.onGround = true;
    this.home = this.pos.clone();
    this.role = spawn.role || 'guard';
    this.yaw = spawn.yaw ?? Math.random() * Math.PI * 2;
    this.homeYaw = this.yaw;
    this.lookYaw = this.yaw;

    this.health = AI.health;
    this.alive = true;
    this.deathT = -1;
    this.deadTime = 0;

    this.state = this.role === 'patrol' ? 'patrol' : 'idle';
    this.awareness = 0;
    this.lastKnown = null;
    this.lastSeenTime = -99;
    this.canSee = false;
    this.perceptionTimer = Math.random() * AI.perceptionInterval;

    this.path = null; this.pathIdx = 0; this.moveTarget = null; this.speedMode = 'walk';
    this.arrived = false; this.stuckTimer = 0; this.stuckCount = 0; this.lastPos = this.pos.clone();
    this.waitTimer = rand(0.5, 3); this.alertTimer = 0; this.lookTimer = rand(2, 5);

    this.crouch = 0; this.wantCrouch = false;
    this.aimTime = 0; this.reaction = rand(AI.reactionMin, AI.reactionMax) * mgr.difficulty.reaction;
    this.burstLeft = 0; this.fireTimer = 0; this.ammo = this.issue.mag; this.reloadTimer = 0;
    this.cover = null; this.coverTimer = 0; this.peek = false; this.coverSearchTimer = 0;
    this.suppression = 0;
    this.grenades = 1;     // each soldier carries one frag
    this.dodgeT = 0;       // > 0 while running from a grenade
    this.blindT = 0;       // > 0 while flashbanged (can't see, can't fight)
    this.lastFiredAt = -99; // radar: when he last fired (seconds, performance.now() clock)
    this.walkPhase = 0; this.flinch = 0; this.aimPitch = 0; this.aiming = 0; this.speed = 0;
    this.climb = null;       // on a ladder: { L, dir (+1 up / -1 down), phase, t, from }
    this.climbT = 0; this.climbPhase = 0; // climbing pose blend and rung rhythm (animation)
    this.pendingDest = null; // a new destination that waits until he's off the ladder
    this.target = null; // the player (you or a squadmate) he's fighting

    // Counterattack waves are told roughly where the defenders are
    const t = spawn.assault ? mgr.randomTarget() : null;
    if (t) {
      this.state = 'alert';
      this.lastKnown = t.pos.clone();
      this.awareness = 0.6;
    }
    this._applyTransform();
  }

  get eyeHeight() { return 1.62 - 0.55 * this.crouch; }

  // ------------------------------------------------------------------ perception
  // With several players around, watch the one that matters most: whoever
  // we're already fighting while he's still in view, otherwise the nearest
  // one we can actually see.
  perceive(targets, dt) {
    this.canSee = false;
    if (this.blindT > 0) return; // flashbanged: sees nothing but white
    _eye.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    let player = null, best = Infinity, dx = 0, dz = 0, dist = 0, off = 0;
    const range = this.mgr.sightRange || AI.sightRange; // a campaign mission in thick fog shortens it (campaign/director.js)
    for (const p of targets) {
      if (!p.alive) continue;
      const head = p.eyePosition;
      const tx = head.x - _eye.x, tz = head.z - _eye.z;
      const d = Math.hypot(tx, tz);
      if (d > range) continue;
      const o = Math.abs(angleDiff(this.yaw, yawTo(tx, tz)));
      if (o > AI.fov / 2 && d > AI.closeSense) continue;
      const score = (p === this.target ? d * 0.5 : d) * (p.aiWeight || 1); // don't flip-flop between targets; aiWeight > 1 = less of a priority (a campaign escort)
      if (score >= best) continue;
      _c.set(p.pos.x, p.pos.y + p.height * 0.6, p.pos.z);
      if (!this.mgr.world.lineOfSight(_eye, head) && !this.mgr.world.lineOfSight(_eye, _c)) continue;
      if (d > 3 && this.mgr.world.smokeBlocks(_eye, head)) continue; // can't see through a smoke screen
      player = p; best = score; dx = tx; dz = tz; dist = d; off = o;
    }
    if (!player) return;
    this.canSee = true;
    this.target = player;

    let rate = 1.6 * Math.min(4, 25 / Math.max(dist, 1));
    if (player.prone) rate *= 0.35 * (1 - 0.6 * (this.mgr.level.concealAt?.(player.pos.x, player.pos.z) || 0)); // lying flat (in grass: nearly invisible)
    if (player.crouched) rate *= 0.55 * (1 - 0.5 * (this.mgr.level.concealAt?.(player.pos.x, player.pos.z) || 0)); // low in tall grass
    if (player.horizontalSpeed > 4) rate *= 1.6;
    else if (player.horizontalSpeed < 0.3) rate *= 0.7;
    if (off > 0.7) rate *= 0.5; // peripheral vision is worse
    if (this.state === 'alert') rate *= 2.5;
    if (this.state === 'combat') rate *= 10;
    this.awareness = Math.min(1, this.awareness + rate * dt);

    if (this.awareness >= 1) {
      this.lastKnown = player.pos.clone();
      this.lastSeenTime = this.mgr.time;
      if (this.state !== 'combat') this.enterCombat();
    } else if (this.awareness > 0.35 && this.state !== 'combat') {
      this.lookYaw = yawTo(dx, dz); // "huh?" — turns to look, stops walking
      this.stopMoving();
      this.waitTimer = Math.max(this.waitTimer, 1.5);
    }
  }

  hear(pos, kind) {
    if (!this.alive || this.state === 'combat' || this.surrendered) return;
    const d = pos.distanceTo(this.pos);
    // We hear WHERE, but not exactly: error grows with distance
    this.lastKnown = pos.clone().add(new THREE.Vector3(gauss() * d * 0.08, 0, gauss() * d * 0.08));
    this.awareness = Math.max(this.awareness, kind === 'gunshot' ? 0.7 : 0.45);
    this.lookYaw = yawTo(pos.x - this.pos.x, pos.z - this.pos.z);
    if (this.state !== 'alert') {
      this.state = 'alert';
      this.alertTimer = 0;
      this.arrived = false;
      this.stopMoving();
      this.waitTimer = rand(0.4, 1.2); // a moment to react before moving
    }
  }

  suppress(amount) {
    this.suppression = Math.min(1, this.suppression + amount);
    this.coverSearchTimer = 0;
  }

  // A flashbang went off where we could see it (grenades.js checked line of
  // sight). near: 1 = right next to us .. 0 = at the edge of its range.
  // Looking straight at it blinds us for longest; with our back to it, only
  // the bang gets us, briefly.
  flash(pos, near) {
    if (!this.alive) return;
    const dx = pos.x - this.pos.x, dz = pos.z - this.pos.z;
    const facing = 1 - Math.min(1, Math.abs(angleDiff(this.yaw, yawTo(dx, dz))) / 2); // 1 = facing it, 0 = more than ~115° away
    let t = 5 * near * (0.2 + 0.8 * facing);
    if (Math.hypot(dx, dz) < 3) t = Math.max(t, 2.5);
    if (t < 0.4) return;
    this.blindT = Math.max(this.blindT, t);
    this.aimTime = 0;      // has to find his target all over again afterwards
    this.burstLeft = 0;
    this.flinch = 1;
    this.suppress(1);
    if (this.state !== 'combat') this.hear(pos, 'gunshot'); // knows roughly where it came from
  }

  // A live grenade landed near us: drop everything and run away from it.
  dodge(from) {
    if (!this.alive) return;
    this.suppress(1);
    if (this.role === 'sentry') { this.wantCrouch = true; return; } // stuck up a tower: get low
    if (this.state !== 'combat') this.hear(from, 'gunshot');
    const away = _v.subVectors(this.pos, from).setY(0);
    if (away.lengthSq() < 0.01) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    away.normalize();
    this._releaseCover();
    this.setDestination(this.pos.clone().addScaledVector(away, 10), 'run');
    this.dodgeT = 2.8;
  }

  // Lob a grenade at where we last saw the enemy (only when he's hiding).
  _throwGrenade() {
    const mgr = this.mgr, cfg = mgr.grenadeCfg;
    this.grenades--;
    mgr.grenadeCooldown = cfg.aiCooldown;
    const o = new THREE.Vector3(this.pos.x, this.pos.y + 1.75, this.pos.z);
    const t = this.lastKnown.clone().add(new THREE.Vector3(gauss() * 1.5, 0.2, gauss() * 1.5));
    // Ballistic launch speed for a fixed angle: v² = g·d² / (2·cos²θ·(d·tanθ − Δy))
    const dx = t.x - o.x, dz = t.z - o.z, d = Math.hypot(dx, dz), dy = t.y - o.y;
    let th = 0.75, den = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) - dy);
    if (den <= 0) { th = 1.05; den = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) - dy); }
    const v = Math.min(22, Math.sqrt(Math.max(1, (9.81 * d * d) / Math.max(0.1, den))));
    const vel = new THREE.Vector3((dx / d) * v * Math.cos(th), v * Math.sin(th), (dz / d) * v * Math.cos(th));
    this.lookYaw = yawTo(dx, dz);
    this.flinch = 0.7; // the throwing motion
    mgr.onThrowGrenade(this, o, vel, cfg.aiFuse);
  }

  enterCombat() {
    this.state = 'combat';
    this.aimTime = 0;
    const d = this.lastKnown ? this.lastKnown.distanceTo(this.pos) : 20;
    this.reaction = rand(AI.reactionMin, AI.reactionMax) * (1 + d / 120) * this.mgr.difficulty.reaction;
    this.coverSearchTimer = rand(0, 0.6);
    this.mgr.alertNearby(this, this.lastKnown);
  }

  // ------------------------------------------------------------------ movement
  setDestination(p, mode) {
    if (this.climb) { this.pendingDest = { p: p.clone(), mode }; return; } // finish the ladder first
    this.speedMode = mode;
    if (this.moveTarget && this.path && this.moveTarget.distanceTo(p) < 1) return;
    this.path = this.mgr.nav.findPath(this.pos, p);
    this.pathIdx = 0;
    this.arrived = false;
    this.stuckTimer = 0;
    this.moveTarget = this.path ? p.clone() : null;
  }

  stopMoving() { this.path = null; this.moveTarget = null; }

  _followPath(dt) {
    if (this.climb) { this._climbLadder(dt); return; }
    if (!this.path || this.role === 'sentry') { this.vel.x *= 0.8; this.vel.z *= 0.8; return; }
    const wp = this.path[this.pathIdx];
    const dx = wp.x - this.pos.x, dz = wp.z - this.pos.z, d = Math.hypot(dx, dz);
    if (d < 0.35) {
      if (wp.ladder) { // at the foot (or the top) of a ladder: climb it, or wait for a friend to get off
        if (!this._startClimb(wp.ladder, wp.dir)) { this.vel.x = this.vel.z = 0; this.stuckTimer = 0; this.lookYaw = wp.ladder.yaw; }
        return;
      }
      if (++this.pathIdx >= this.path.length) { this.stopMoving(); this.arrived = true; }
      return;
    }
    let speed = this.speedMode === 'run' ? AI.runSpeed : AI.walkSpeed;
    if (this.crouch > 0.5) speed *= 0.5;
    this.vel.x = (dx / d) * speed;
    this.vel.z = (dz / d) * speed;
    if (this.state !== 'combat' || !this.canSee) this.lookYaw = yawTo(dx, dz);

    // stuck? re-plan, and give up after a few tries
    this.stuckTimer += dt;
    if (this.stuckTimer > 1) {
      if (this.pos.distanceTo(this.lastPos) < 0.3) {
        if (++this.stuckCount > 2) { this.stopMoving(); this.stuckCount = 0; }
        else if (this.moveTarget) { const t = this.moveTarget; this.moveTarget = null; this.setDestination(t, this.speedMode); }
      } else this.stuckCount = 0;
      this.lastPos.copy(this.pos);
      this.stuckTimer = 0;
    }
  }

  // ------------------------------------------------------------------ ladders
  // Three phases, all scripted (no physics), like the player's vault:
  //   'onto'  from the roof, step out through the gap and down onto the rungs
  //   'climb' hand over hand along the ladder
  //   'over'  at the top, pull up and over onto the roof
  _startClimb(L, dir) {
    if (L.user && L.user !== this && L.user.alive && L.user.climb) return false; // one at a time
    L.user = this;
    this.climb = { L, dir, phase: dir > 0 ? 'climb' : 'onto', t: 0, from: this.pos.clone() };
    this.vel.set(0, 0, 0);
    this._releaseCover();
    return true;
  }

  _climbLadder(dt) {
    const c = this.climb, L = c.L, p = this.pos;
    const ease = (t) => t * t * (3 - 2 * t);
    this.yaw = this.lookYaw = L.yaw; // face the wall
    this.vel.set(0, 0, 0);
    if (c.phase === 'onto' || c.phase === 'over') {
      c.t = Math.min(1, c.t + dt / 0.8);
      const to = c.phase === 'onto' ? _v.set(L.cx, L.y1 - 1.0, L.cz) : L.top;
      // stepping on: out first, then down; pulling over: up first, then in
      const h = ease(c.phase === 'onto' ? Math.min(1, c.t / 0.6) : Math.max(0, (c.t - 0.4) / 0.6));
      const v = ease(c.phase === 'onto' ? Math.max(0, (c.t - 0.3) / 0.7) : Math.min(1, c.t / 0.6));
      p.set(c.from.x + (to.x - c.from.x) * h, c.from.y + (to.y - c.from.y) * v, c.from.z + (to.z - c.from.z) * h);
      if (c.t >= 1) {
        if (c.phase === 'onto') { c.phase = 'climb'; return; }
        this._endClimb();
      }
      return;
    }
    // On the rungs: stay on the climbing line, move up or down
    p.x = L.cx; p.z = L.cz;
    const dy = c.dir * AI.climbSpeed * dt;
    p.y += dy;
    const before = Math.floor(this.climbPhase / Math.PI);
    this.climbPhase += (Math.abs(dy) * Math.PI) / 0.3; // one hand-and-foot move per 30 cm rung
    if (Math.floor(this.climbPhase / Math.PI) !== before) this.mgr.audio.enemyFootstep(p, 0.35);
    if (c.dir > 0 && p.y >= L.y1 - 0.9) { c.phase = 'over'; c.t = 0; c.from.copy(p); }
    if (c.dir < 0) {
      const ground = Math.max(L.y0, this.mgr.world.groundHeight(L.cx, L.cz));
      if (p.y <= ground) { p.y = ground; this._endClimb(); }
    }
  }

  _endClimb() {
    const L = this.climb.L;
    if (L.user === this) L.user = null;
    this.climb = null;
    this.vel.set(0, 0, 0);
    this.onGround = true;
    this.lastPos.copy(this.pos);
    this.stuckTimer = 0;
    if (this.path && ++this.pathIdx >= this.path.length) { this.stopMoving(); this.arrived = true; }
    if (this.pendingDest) { const d = this.pendingDest; this.pendingDest = null; this.setDestination(d.p, d.mode); }
  }

  // ------------------------------------------------------------------ states
  _idle(dt) {
    if (this.role !== 'sentry' && this.pos.distanceTo(this.home) > 1.5 && !this.path) this.setDestination(this.home, 'walk');
    if (!this.path && (this.lookTimer -= dt) <= 0) {
      this.lookTimer = rand(3, 7);
      this.lookYaw = this.homeYaw + rand(-1.1, 1.1);
    }
  }

  _patrol(dt) {
    if (this.path) return;
    if ((this.waitTimer -= dt) > 0) {
      if ((this.lookTimer -= dt) <= 0) { this.lookTimer = rand(1.5, 3); this.lookYaw = this.yaw + rand(-1.2, 1.2); }
      return;
    }
    const pts = this.mgr.level.patrolPoints.filter((p) => p.distanceTo(this.pos) > 6 && p.distanceTo(this.pos) < 45);
    if (pts.length) this.setDestination(pts[(Math.random() * pts.length) | 0], 'walk');
    this.waitTimer = rand(2, 5);
  }

  _alert(dt) {
    this.alertTimer += dt;
    if (this.lastKnown) this.lookYaw = this.path ? this.lookYaw : yawTo(this.lastKnown.x - this.pos.x, this.lastKnown.z - this.pos.z);
    if ((this.waitTimer -= dt) > 0) return;
    if (this.role === 'sentry') { if (this.alertTimer > 15) this._calmDown(); return; }
    if (!this.path && !this.arrived && this.lastKnown) {
      this.setDestination(this.lastKnown, 'run');
      if (!this.path) this.arrived = true;
    }
    if (this.arrived) {
      // search the area: sweep left and right
      if ((this.lookTimer -= dt) <= 0) { this.lookTimer = rand(1, 2); this.lookYaw = this.yaw + rand(-1.6, 1.6); }
      if (this.alertTimer > 25) this._calmDown();
    }
  }

  _calmDown() {
    this.state = this.role === 'patrol' ? 'patrol' : 'idle';
    this.awareness = 0.3;
    this.arrived = false;
  }

  _combat(dt) {
    const mgr = this.mgr;
    const seeing = this.canSee;
    const player = this.target; // may be null or dead; then we go on where we last saw someone
    if (seeing) { this.lastKnown.copy(player.pos); this.lastSeenTime = mgr.time; }
    const threat = player?.alive ? player.pos : this.lastKnown;
    const since = mgr.time - this.lastSeenTime;
    const toX = this.lastKnown.x - this.pos.x, toZ = this.lastKnown.z - this.pos.z;
    const dist = Math.hypot(toX, toZ);
    if (seeing || since < 2 || !this.path) this.lookYaw = yawTo(toX, toZ);

    this.aimTime = seeing ? this.aimTime + dt : Math.max(0, this.aimTime - dt * 2);

    // --- shooting ---
    if (this.reloadTimer > 0) {
      if ((this.reloadTimer -= dt) <= 0) this.ammo = this.issue.mag;
    } else if (seeing && !this.climb && this.aimTime > this.reaction && Math.abs(angleDiff(this.yaw, this.lookYaw)) < 0.2 && player.alive) {
      this.fireTimer -= dt;
      if (this.burstLeft <= 0 && this.fireTimer <= 0) this.burstLeft = Math.round(rand(...this.issue.burst));
      if (this.burstLeft > 0 && this.fireTimer <= 0) {
        this._shoot(player, dist);
        this.burstLeft--;
        this.fireTimer = this.burstLeft > 0 ? 60 / this.issue.rpm : rand(AI.burstPauseMin, AI.burstPauseMax) * (1 + this.suppression);
        if (--this.ammo <= 0) { this.reloadTimer = this.issue.reload; this.burstLeft = 0; }
      }
    }

    // --- grenade: flush a player out of the cover he's been hiding behind ---
    if (!seeing && this.grenades > 0 && since > 2.5 && since < 12 && dist > 9 && dist < 32 && mgr.canThrowGrenade()) this._throwGrenade();

    if (this.role === 'sentry') {
      this.wantCrouch = this.reloadTimer > 0 || this.suppression > 0.7;
      if (!seeing && since > AI.loseTargetTime * 2) { this.state = 'alert'; this.alertTimer = 0; }
      return;
    }
    if (!seeing && since > AI.loseTargetTime) { // lost you: go hunting
      this.state = 'alert';
      this.alertTimer = 0;
      this.arrived = false;
      this.waitTimer = 0;
      this._releaseCover();
      return;
    }

    // --- cover behaviour ---
    if (this.cover) {
      _v.subVectors(threat, this.cover.pos);
      const protects = this.cover.normal.dot(_v) < -0.3 * _v.length();
      if (!protects) { this._releaseCover(); return; }
      if (this.cover.pos.distanceTo(this.pos) < 0.6) {
        this.stopMoving();
        if ((this.coverTimer -= dt) <= 0) {
          this.peek = !this.peek;
          this.coverTimer = this.peek ? rand(1.6, 3.2) : rand(0.8, 2.0) * (1 + this.suppression * 1.5);
        }
        this.wantCrouch = !this.peek || this.reloadTimer > 0 || this.suppression > 0.8;
      } else {
        this.wantCrouch = false;
        if (!this.path) this.setDestination(this.cover.pos, 'run');
        if (!this.path) this._releaseCover();
      }
      return;
    }

    if ((this.coverSearchTimer -= dt) <= 0) {
      this.coverSearchTimer = rand(1.2, 2.2);
      const eye = player?.alive ? player.eyePosition : _threatEye.set(threat.x, threat.y + 1.6, threat.z);
      const c = dist > 7 ? mgr.findCover(this, eye) : null;
      if (c) {
        this.cover = c;
        c.owner = this;
        this.peek = false;
        this.coverTimer = rand(0.6, 1.4);
        this.setDestination(c.pos, 'run');
        return;
      }
    }
    // No cover: advance if far away, otherwise hold and shoot; hunt if we can't see you
    if (seeing && dist > 45) {
      this.wantCrouch = false;
      if (!this.path) this.setDestination(this.lastKnown, 'run');
    } else if (seeing) {
      this.stopMoving();
      this.wantCrouch = dist > 22 || this.reloadTimer > 0;
    } else if (!this.path) {
      this.wantCrouch = false;
      this.setDestination(this.lastKnown, 'run');
    }
  }

  _releaseCover() {
    if (this.cover && this.cover.owner === this) this.cover.owner = null;
    this.cover = null;
  }

  _shoot(player, dist) {
    const mgr = this.mgr;
    _origin.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    // aim at the chest, occasionally the head
    const aimY = Math.random() < 0.12 ? player.height - 0.12 : player.height * 0.62;
    _dir.set(player.pos.x, player.pos.y + aimY, player.pos.z).sub(_origin).normalize();
    let spread = AI.baseSpread * (1 + dist / 30);
    spread *= this.aimTime < 2 ? 1.9 - this.aimTime * 0.45 : 1;   // first shots are hurried
    if (player.horizontalSpeed > 3) spread *= 1.5;
    if (this.health < 50) spread *= 1.3;
    spread *= 1 + this.suppression * 1.5;
    spread *= mgr.difficulty.spread * this.issue.spread;
    _right.set(-_dir.z, 0, _dir.x).normalize();
    _up.crossVectors(_right, _dir);
    _dir.addScaledVector(_right, gauss() * spread).addScaledVector(_up, gauss() * spread).normalize();
    _origin.addScaledVector(_dir, 0.35);

    this.body.muzzleWorld(_muz);
    const tracer = Math.random() < 0.3;
    mgr.ballistics.fire({
      origin: _origin, dir: _dir, speed: AI.muzzleVelocity, damage: AI.damage * this.issue.damage * mgr.difficulty.damage, team: 'enemy',
      penetration: 0.8, tracer, visualOffset: _off.subVectors(_muz, _origin), headMul: AI.headMul,
    });
    mgr.effects.muzzleFlash(_muz, true, 0.4);
    mgr.audio.gunshot(_muz.clone(), this.issue.gun.id, false);
    mgr.onShoot?.(this, _origin, _dir, tracer); // co-op: everyone else sees this shot too
    this.lastFiredAt = performance.now() / 1000;  // shows on enemy radar ("when firing" mode)
  }

  // ------------------------------------------------------------------ damage
  // info.shooter is whoever fired (you or a squadmate), when known.
  onBulletHit(info) {
    if (!this.alive) return;
    const mul = info.zone === 'head' ? info.headMul : info.zone === 'limb' ? info.limbMul : 1;
    this.health -= info.damage * mul;
    this.flinch = 1;
    const killed = this.health <= 0;
    this.mgr.onHit?.(this, info.zone, killed, info);
    if (killed) { this._die(info); return; }
    this.suppress(0.6);
    this.aimTime *= 0.3; // getting hit ruins your aim
    if (this.state !== 'combat') {
      this.lastKnown = (info.shooter?.pos || info.from || this.mgr.player.pos).clone();
      if (info.shooter) this.target = info.shooter;
      this.awareness = 1;
      this.enterCombat();
    }
  }

  _die(info) {
    this.alive = false;
    this.state = 'dead';
    this.deathT = 0;
    this.stopMoving();
    this._releaseCover();
    this.mgr.onKill?.(this, info.zone === 'head', info);
  }

  // ------------------------------------------------------------------ main update
  update(dt, targets) {
    if (!this.alive) {
      // Shot off a ladder: let go of it and drop to the ground
      if (this.climb) { if (this.climb.L.user === this) this.climb.L.user = null; this.climb = null; this.onGround = false; }
      if (!this.onGround) { this.vel.set(0, this.vel.y - 9.81 * dt, 0); this.mgr.world.moveBody(this, dt, 0); }
      this.deadTime += dt;
      this.deathT = Math.min(1, this.deathT + dt * 1.6);
      this._animate(dt);
      return;
    }
    if (this.surrendered) { this._surrendered(dt); return; }
    if ((this.perceptionTimer -= dt) <= 0) {
      this.perceive(targets, AI.perceptionInterval);
      this.perceptionTimer += AI.perceptionInterval;
    }
    if (this.state !== 'combat' && !this.canSee) this.awareness = Math.max(0, this.awareness - 0.05 * dt);
    this.suppression = Math.max(0, this.suppression - dt * 0.35);
    this.flinch = Math.max(0, this.flinch - dt * 5);

    if (this.blindT > 0) { // flashbanged: stops, hunches over and turns about blindly
      this.blindT -= dt;
      this.wantCrouch = true;
      this.stopMoving();
      if ((this.lookTimer -= dt) <= 0) { this.lookTimer = rand(0.3, 0.9); this.lookYaw = this.yaw + rand(-1.4, 1.4); }
    } else if (this.dodgeT > 0) { this.dodgeT -= dt; this.wantCrouch = false; } // running from a grenade
    else switch (this.state) {
      case 'idle': this.wantCrouch = false; this._idle(dt); break;
      case 'patrol': this.wantCrouch = false; this._patrol(dt); break;
      case 'alert': this.wantCrouch = false; this._alert(dt); break;
      case 'combat': this._combat(dt); break;
    }

    this._followPath(dt);
    if (!this.climb) { // on a ladder the climb moves him; no gravity
      this.vel.y -= 9.81 * dt;
      this.mgr.world.moveBody(this, dt, 0.45);
    }

    // turn the body toward where we want to look
    const turn = angleDiff(this.yaw, this.lookYaw);
    const maxTurn = AI.turnRate * (this.state === 'combat' ? 1.4 : 0.6) * dt;
    this.yaw += THREE.MathUtils.clamp(turn, -maxTurn, maxTurn);

    // footsteps you can hear
    const speed = (this.speed = Math.hypot(this.vel.x, this.vel.z));
    const before = Math.floor(this.walkPhase / Math.PI);
    this.walkPhase += (speed * dt * Math.PI) / 0.8;
    if (Math.floor(this.walkPhase / Math.PI) !== before && speed > 0.5) this.mgr.audio.enemyFootstep(this.pos, speed > 3 ? 1 : 0.5);

    this._animate(dt, speed);
  }

  // Campaign: a commander who has given up (campaign/director.js sets
  // `surrendered`). He kneels with his rifle down and does nothing at all
  // until someone restrains him. Shoot him now and he still dies.
  _surrendered(dt) {
    if (this.climb) { if (this.climb.L.user === this) this.climb.L.user = null; this.climb = null; }
    this.state = 'surrender';
    this.target = null;
    this.stopMoving();
    this._releaseCover();
    this.wantCrouch = true;
    this.vel.x = this.vel.z = 0;
    this.vel.y -= 9.81 * dt;
    this.mgr.world.moveBody(this, dt, 0.45);
    this.flinch = Math.max(0, this.flinch - dt * 5);
    this._animate(dt, 0);
  }

  _animate(dt, speed = 0) {
    this._applyTransform();
    const climbing = !!this.climb && this.alive;
    this.climbT += ((climbing ? 1 : 0) - this.climbT) * Math.min(1, dt * 8);
    this.crouch += ((this.wantCrouch && this.alive && !climbing ? 1 : 0) - this.crouch) * Math.min(1, dt * 6);
    const combatAim = this.alive && !climbing && this.state === 'combat' && (this.canSee || this.mgr.time - this.lastSeenTime < 2);
    this.aiming += ((combatAim || (this.state === 'alert' && !climbing) ? 1 : 0) - this.aiming) * Math.min(1, dt * 5);
    const aimAt = this.target?.alive && this.canSee ? this.target.pos : this.lastKnown;
    if (combatAim && aimAt) {
      const dy = aimAt.y + 1.2 - (this.pos.y + this.eyeHeight);
      const dh = Math.hypot(aimAt.x - this.pos.x, aimAt.z - this.pos.z);
      this.aimPitch = Math.atan2(dy, dh);
    } else this.aimPitch *= 0.9;
    this.body.animate(dt, {
      speed, crouch: this.crouch, aimPitch: this.aimPitch,
      aiming: this.alive ? Math.max(0.0, this.aiming) : 0, deathT: this.deathT, flinch: this.flinch,
      climb: this.climbT, climbPhase: this.climbPhase,
    });
  }

  _applyTransform() {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
  }

  dispose() {
    this.mgr.scene.remove(this.root);
    this._releaseCover();
    if (this.climb?.L.user === this) this.climb.L.user = null;
  }
}

// =============================================================================
export class EnemyManager {
  constructor({ scene, world, nav, ballistics, effects, audio, level, M, player, factory }) {
    Object.assign(this, { scene, world, nav, ballistics, effects, audio, level, M, player, factory });
    this.enemies = [];
    this.targets = [player]; // who the AI can fight; main.js passes the list each frame
    this.time = 0;
    this.nextNetId = 0;      // every soldier gets a number, so co-op messages can name him
    this.onKill = null;      // (enemy, headshot, info)
    this.onHit = null;       // (enemy, zone, killed, info)
    this.onShoot = null;     // (enemy, origin, dir, tracer)
    this.difficulty = DIFFICULTY.regular; // set from the menu or the co-op lobby
    this.raycaster = new THREE.Raycaster();
    this._candidates = [];
  }

  spawn(spawn) {
    const e = new Enemy(this, spawn);
    e.netId = ++this.nextNetId;
    this.enemies.push(e);
    return e;
  }

  byNetId(id) { return this.enemies.find((e) => e.netId === id); }

  randomTarget() {
    const alive = this.targets.filter((t) => t.alive);
    return alive.length ? alive[(Math.random() * alive.length) | 0] : null;
  }

  clear() {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
  }

  get aliveCount() { return this.enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0); }

  // Bullet target interface. Cheap sphere test first, then exact mesh test.
  raycast(origin, dir, maxDist, team) {
    if (team === 'enemy') return null;
    const cand = this._candidates;
    cand.length = 0;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      _c.set(e.pos.x, e.pos.y + 0.9, e.pos.z).sub(origin);
      const t = THREE.MathUtils.clamp(_c.dot(dir), 0, maxDist);
      _w.copy(dir).multiplyScalar(t);
      if (_w.distanceToSquared(_c) < 1.44) for (const m of e.body.hitMeshes) cand.push(m);
    }
    if (!cand.length) return null;
    this.raycaster.set(origin, dir);
    this.raycaster.near = 0;
    this.raycaster.far = maxDist;
    const hit = this.raycaster.intersectObjects(cand, false)[0];
    if (!hit) return null;
    return { dist: hit.distance, point: hit.point, zone: hit.object.userData.zone, entity: hit.object.userData.enemy };
  }

  // Tell friends within radio range where you are.
  alertNearby(source, pos) {
    if (!pos) return;
    for (const e of this.enemies) {
      if (e === source || !e.alive || e.state === 'combat') continue;
      if (e.pos.distanceTo(source.pos) < AI.alertRadius) e.hear(pos, 'callout');
    }
  }

  hearNoise(pos, radius, kind) {
    for (const e of this.enemies) if (e.alive && e.pos.distanceTo(pos) < radius) e.hear(pos, kind);
  }

  // Your bullets landing near them = suppression (they keep their heads down).
  // `from` = where the shooter is, so they know which way to look.
  onImpact(point, from = this.player.pos) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = point.distanceTo(_c.set(e.pos.x, e.pos.y + 1, e.pos.z));
      if (d < 3) {
        e.suppress(0.35 * (1 - d / 3) + 0.1);
        if (e.state !== 'combat') { e.hear(from, 'gunshot'); }
      }
    }
  }

  // eye = the head of whoever we're hiding from
  findCover(enemy, eye) {
    // Up on a roof he holds it (the parapet is his cover) rather than climbing down to hide
    if (this.nav.levelAt?.(enemy.pos)) return null;
    let best = null, bestScore = Infinity;
    for (const c of this.level.coverPoints) {
      if (c.owner && c.owner !== enemy && c.owner.alive) continue;
      const d = c.pos.distanceTo(enemy.pos);
      if (d > 22) continue;
      _v.subVectors(eye, c.pos);
      _v.y = 0;
      const pd = _v.length();
      if (pd < 6) continue;
      if (c.normal.dot(_v) > -0.3 * pd) continue;          // must be between us and the player
      _w.set(c.pos.x, 0.95, c.pos.z);
      if (this.world.lineOfSight(eye, _w)) continue;        // crouched head must be hidden
      let score = d + Math.abs(pd - 25) * 0.3;
      _w.y = 1.6;
      if (!this.world.lineOfSight(eye, _w)) score += 6;     // prefer spots we can shoot from when standing
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  // targets = everyone the AI can fight (see the top of this file)
  // Grenade hooks (main.js sets onThrowGrenade and grenadeCfg)
  canThrowGrenade() { return !!this.onThrowGrenade && this.grenadeCooldown <= 0; }
  dodgeGrenade(pos, radius) {
    for (const e of this.enemies) if (e.alive && e.dodge && e.pos.distanceTo(pos) < radius) e.dodge(pos);
  }

  update(dt, targets = [this.player]) {
    this.targets = targets;
    this.time += dt;
    this.grenadeCooldown = Math.max(0, (this.grenadeCooldown || 0) - dt);
    for (const e of this.enemies) e.update(dt, targets);

    // Keep soldiers from overlapping each other and the player
    const alive = this.enemies.filter((e) => e.alive);
    for (let i = 0; i < alive.length; i++) {
      const a = alive[i];
      for (let j = i + 1; j < alive.length; j++) {
        const b = alive[j];
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz);
        if (d > 0.001 && d < 0.6 && Math.abs(a.pos.y - b.pos.y) < 1.5) {
          const push = (0.6 - d) / 2 / d;
          a.pos.x -= dx * push; a.pos.z -= dz * push;
          b.pos.x += dx * push; b.pos.z += dz * push;
        }
      }
    }
    if (targets.includes(this.player)) this.pushPlayerOut(alive, this.player);

    // Remove old bodies
    const dead = this.enemies.filter((e) => !e.alive).sort((a, b) => b.deadTime - a.deadTime);
    while (dead.length > 18 || (dead.length && dead[0].deadTime > 90)) {
      const e = dead.shift();
      e.dispose();
      this.enemies.splice(this.enemies.indexOf(e), 1);
    }
  }

  // Nudge the local player out of any soldier he's walking into.
  pushPlayerOut(list, player) {
    if (!player.alive) return;
    for (const a of list) {
      if (!a.alive) continue;
      const dx = player.pos.x - a.pos.x, dz = player.pos.z - a.pos.z, d = Math.hypot(dx, dz);
      if (d > 0.001 && d < 0.6 && Math.abs(a.pos.y - player.pos.y) < 1.5) {
        const ox = player.pos.x, oz = player.pos.z;
        player.pos.x += (dx / d) * (0.6 - d);
        player.pos.z += (dz / d) * (0.6 - d);
        if (this.world.bodyBlocked(player.pos, player.radius, player.height)) { player.pos.x = ox; player.pos.z = oz; }
      }
    }
  }
}

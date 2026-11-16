// =============================================================================
// player.js — first-person movement, stances, vaulting, stamina, health, camera.
//
// Movement uses "velocity approaches target speed" with different rates on the
// ground vs in the air, so you have weight and momentum but no air-strafing.
// Compare with Quake's PM_Accelerate / PM_Friction in bg_pmove.c.
//
// STANCES (like ARMA / Squad / Battlefield):
//   stand  — full speed, can sprint and jump
//   crouch — slower, steadier aim, smaller target          [C]
//   prone  — crawl, steadiest aim, hardest to see or hit   [Z]
//   Space rises one level (prone -> crouch -> stand) instead of jumping.
//   Changing stance takes time; you can't shoot while dropping prone.
//
// VAULTING / MANTLING: Space in front of waist-high cover hops over it (and
// keeps your running speed); in front of a window you dive through low; in
// front of a chest-high ledge you climb up onto it. While it plays, the game
// moves you along a scripted path (no physics) — the same trick as the
// "traversal" animations in modern shooters. A HUD prompt says when you can.
//
// LADDERS: walk into one to grab it, W/S to climb, Shift to hurry, Space to
// let go. At the top you pull yourself over onto the roof; from the roof,
// walk toward the ladder to turn round and climb down. (See ladder.js.)
//
// FALLING: hit the ground faster than ~7.5 m/s (a ~3 m drop) and it hurts,
// and leaves you limping. Land crouched to soften it.
// =============================================================================
import * as THREE from 'three';
import { PLAYER as P } from './config.js';
import { LADDER, ladderLocal } from './ladder.js';

const _wish = new THREE.Vector3(), _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const STANCE = {
  stand: { height: P.standHeight, eye: P.standEye },
  crouch: { height: P.crouchHeight, eye: P.crouchEye },
  prone: { height: P.proneHeight, eye: P.proneEye },
};

export class Player {
  constructor(world, camera, audio) {
    this.world = world;
    this.camera = camera;
    this.audio = audio;
    this.sensitivity = 1;
    this.fov = P.baseFov;
    this.onDamaged = null; // (amount, fromPos)
    this.onNoise = null;   // (pos, radius) footsteps enemies can hear
    this.onDeath = null;
    this.isPlayer = true;
    // Loadout effects (see loadout.js resolveLoadout): weight and armour
    this.kit = { speedMul: 1, staminaMul: 1, armor: { torso: 1, blast: 1 } };
    this.swayMul = 1;   // set by the weapon (heavier guns / scopes sway more)
    this.braced = false; // bipod deployed (set by the weapon)
    this.reset(new THREE.Vector3(), 0);
  }

  reset(pos, yaw) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.radius = P.radius;
    this.height = P.standHeight;
    this.onGround = false;
    this.yaw = yaw;
    this.pitch = 0;
    this.recoilDebt = 0;      // part of the recoil climb that will recover automatically
    this.stance = 'stand';
    this.stanceBusy = 0;      // seconds left in a stance change (can't shoot)
    this.crouchT = 0;         // 0 = standing, 1 = crouched (smoothed, for animation)
    this.proneT = 0;          // 0..1 prone (smoothed)
    this.lean = 0;            // -1 left .. 1 right (smoothed)
    this.eyeY = P.standEye;
    this.landDip = 0;         // camera dip after a hard landing
    this.shakeAmt = 0;        // camera shake from nearby explosions
    this.vault = null;        // active vault/mantle move
    this.ladder = null;       // the ladder you're on (ladder.js), or null
    this.ladderCooldown = 0;  // just let go: don't grab it again straight away
    this.ladderHoldDown = false; // stepped on from the roof holding W: W keeps going down until released
    this.climbT = 0;          // 0..1 smoothed "on a ladder" (gun slung)
    this.climbPhase = 0;      // rung rhythm (sounds, camera sway)
    this.limp = 0;            // seconds left limping after a hard landing
    this.hint = '';           // what you can do here, for the HUD ("[SPACE] VAULT")
    this._hintT = 0;
    this.stamina = P.staminaMax;
    this.staminaCooldown = 0;
    this.health = P.maxHealth;
    this.alive = true;
    this.deathT = 0;
    this.sprinting = false;
    this.sprintAmount = 0;
    this.crawling = 0;        // 0..1: prone and moving (weapon lowered)
    this.holdingBreath = false;
    this.outOfBreath = false; // held it until it ran out: gasping, can't hold again yet
    this.horizontalSpeed = 0;
    this.bobPhase = 0;
    this.lastLookDX = 0; this.lastLookDY = 0;
    this.adsFactor = 0;
    this.adsFov = 52;
    this.bandages = P.bandages;
    this.bandaging = false;
    this.bandageT = 0;
    this.lastDamageTime = -99;
    this.time = 0;
    this.swayX = 0; this.swayY = 0;
  }

  setKit({ speedMul, staminaMul, armor }) { this.kit = { speedMul, staminaMul, armor }; }

  // Something solid at chest height just in front to rest a bipod on (crouched behind cover)
  canBrace() {
    const eye = this.pos.y + this.eyeY, fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    for (let d = 0.35; d <= 0.8; d += 0.15) {
      const x = this.pos.x + fx * d, z = this.pos.z + fz * d;
      for (const c of this.world._collect(x - 0.1, eye - 0.55, z - 0.1, x + 0.1, eye - 0.08, z + 0.1)) {
        if (c.solid && c.max.y > eye - 0.5 && c.max.y < eye - 0.08) return true;
      }
    }
    return false;
  }

  get crouched() { return this.stance === 'crouch'; }
  get prone() { return this.stance === 'prone'; }
  // True while you physically can't shoot: changing stance, vaulting, crawling
  get weaponBlocked() { return this.stanceBusy > 0 || !!this.vault || !!this.ladder || this.crawling > 0.5; }

  // Reuses one vector (asked for many times per frame by the AI). Treat as read-only.
  get eyePosition() { return (this._eye || (this._eye = new THREE.Vector3())).set(this.pos.x, this.pos.y + this.eyeY, this.pos.z); }

  addRecoil(pitch, yaw, recovery) {
    this.pitch = Math.min(1.5, this.pitch + pitch);
    this.yaw -= yaw;
    this.recoilDebt += pitch * recovery;
  }

  // Is there room for this stance where we stand?
  _fits(stance) { return !this.world.bodyBlocked(this.pos, this.radius, STANCE[stance].height); }

  setStance(stance) {
    if (stance === this.stance || !this._fits(stance)) return false;
    const toProne = stance === 'prone', fromProne = this.stance === 'prone';
    this.stanceBusy = toProne ? P.proneTime : fromProne ? P.proneTime * 0.8 : 0;
    this.stance = stance;
    this.height = STANCE[stance].height;
    if (toProne || fromProne) this.audio.reload('cloth');
    return true;
  }

  update(dt, input) {
    this.time += dt;
    if (!this.alive) { this._deathCam(dt); return; }
    this.stanceBusy = Math.max(0, this.stanceBusy - dt);

    // ---------------- look ----------------
    const { dx, dy } = input.consumeMouse();
    // Aiming down sights lowers sensitivity in proportion to zoom, so the
    // world moves under your crosshair at the same speed.
    const zoom = this.camera.fov / this.fov;
    const sens = P.mouseSensitivity * this.sensitivity * zoom;
    this.yaw -= dx * sens;
    // Lying down you can't look straight up or down into the dirt
    const pitchMin = this.prone ? -0.55 : -1.5, pitchMax = this.prone ? 0.9 : 1.5;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens, pitchMin, pitchMax);
    this.lastLookDX = dx; this.lastLookDY = dy;
    if (this.recoilDebt > 0) { // recoil recovery: the muzzle settles part-way back down on its own
      const r = Math.min(this.recoilDebt, (this.recoilDebt * 9 + 0.01) * dt);
      this.pitch -= r;
      this.recoilDebt -= r;
    }

    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    this.ladderCooldown = Math.max(0, this.ladderCooldown - dt);
    this.limp = Math.max(0, this.limp - dt);
    const climbing = !!this.ladder || !!this.vault?.ladder || !!this.vault?.fromLadder;
    this.climbT = lerp(this.climbT, climbing ? 1 : 0, Math.min(1, dt * 8));

    // A vault/mantle in progress drives the body; everything else waits.
    if (this.vault) { this.hint = ''; this._updateVault(dt); this._updateCamera(dt); return; }
    // So does climbing a ladder.
    if (this.ladder) { this._updateLadder(dt, input); this._updateCamera(dt); return; }

    // ---------------- stance input ----------------
    if (input.wasPressed('KeyC')) this.setStance(this.crouched ? 'stand' : 'crouch');
    if (input.wasPressed('KeyZ') && this.onGround) {
      if (this.prone) this.setStance('stand') || this.setStance('crouch');
      else this.setStance('prone');
    }
    const leanTarget = this.prone ? 0 : (input.isDown('KeyE') ? 1 : 0) - (input.isDown('KeyQ') ? 1 : 0);

    // ---------------- movement input ----------------
    const fwdIn = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const sideIn = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    const shift = input.isDown('ShiftLeft') || input.isDown('ShiftRight');
    // Holding your breath (Shift while aiming) steadies the gun but burns
    // stamina fast. Hold it until it runs out and you gasp for air: you can't
    // hold it again until you've let go of Shift and got some breath back.
    const holdIn = shift && this.adsFactor > 0.8;
    if (this.outOfBreath && !shift && this.stamina >= P.holdBreathRecover) this.outOfBreath = false;
    if (this.holdingBreath && holdIn && this.stamina <= 0) this.outOfBreath = true;
    this.holdingBreath = holdIn && !this.outOfBreath && (this.holdingBreath || this.stamina > P.holdBreathMin);
    // Sprinting never cuts out: as stamina runs low it just slows to a jog (see speed below).
    const wantSprint = shift && fwdIn > 0 && this.adsFactor < 0.2 && !this.bandaging;
    if (wantSprint && this.stance !== 'stand' && this.stanceBusy === 0) this.setStance('stand'); // sprinting gets you up
    this.sprinting = wantSprint && this.stance === 'stand' && this.onGround && this.limp <= 0; // can't run on jarred legs
    this.sprintAmount = lerp(this.sprintAmount, this.sprinting ? 1 : 0, Math.min(1, dt * 8));

    this.crouchT = lerp(this.crouchT, this.crouched ? 1 : 0, Math.min(1, dt * 10));
    this.proneT = lerp(this.proneT, this.prone ? 1 : 0, Math.min(1, dt * 4));

    // A tiring sprint eases from full speed down to a heavy jog as stamina runs out.
    const fresh = Math.min(1, this.stamina / P.sprintFadeAt);
    const sprintSpeed = lerp(P.sprintWindedSpeed, P.sprintSpeed, fresh * fresh * (3 - 2 * fresh));
    let speed = this.sprinting ? sprintSpeed : this.prone ? P.proneSpeed : this.crouched ? P.crouchSpeed : P.walkSpeed;
    speed *= lerp(1, P.adsSpeedMul, this.adsFactor);
    if (this.bandaging) speed *= 0.4;
    if (this.health < 30) speed *= 0.85; // wounded
    if (this.stanceBusy > 0) speed *= 0.3;
    if (this.limp > 0) speed *= 0.65; // hurt your legs landing a fall
    speed *= this.kit.speedMul; // what you carry slows you down

    _wish.set(0, 0, 0).addScaledVector(_fwd, fwdIn).addScaledVector(_right, sideIn);
    if (_wish.lengthSq() > 0) _wish.normalize();
    if (fwdIn < 0) speed *= 0.8; // backpedalling is slower

    const accel = this.onGround ? P.groundAccel : P.airAccel;
    const k = Math.min(1, accel * dt);
    this.vel.x = lerp(this.vel.x, _wish.x * speed, k);
    this.vel.z = lerp(this.vel.z, _wish.z * speed, k);

    // ---------------- ladders: walk into one to grab it ----------------
    if (this._tryLadder(fwdIn, input)) { this._updateCamera(dt); return; }

    // ---------------- Space: get up, vault, or jump ----------------
    if (input.wasPressed('Space') && this.onGround && this.stanceBusy === 0) {
      if (this.prone) this.setStance('crouch');
      else if (this.crouched) this.setStance('stand') || this._tryVault();
      else if (!this._tryVault() && this.stamina > P.jumpCost * 0.5) {
        this.vel.y = P.jumpVelocity * (this.stamina > P.jumpCost ? 1 : 0.7);
        this.stamina = Math.max(0, this.stamina - P.jumpCost);
        this.staminaCooldown = P.staminaDelay;
      }
      if (this.vault) { this._updateCamera(dt); return; }
    }
    this.vel.y -= P.gravity * dt;

    // ---------------- collide & move ----------------
    const landing = this.world.moveBody(this, dt, this.onGround ? P.stepHeight : 0);
    if (landing > P.fallDamageMinSpeed) this._hardLanding(landing);
    else if (landing > 2.5) {
      const surface = this.world.surfaceUnder(this.pos);
      if (this.audio.land) this.audio.land(landing, surface); else this.audio.footstep(1.4, surface);
      this.landDip = Math.min(0.22, this.landDip + landing * 0.028); // knees absorb the landing
    }
    this.horizontalSpeed = Math.hypot(this.vel.x, this.vel.z);
    this.crawling = lerp(this.crawling, this.prone && this.horizontalSpeed > 0.25 ? 1 : 0, Math.min(1, dt * 6));

    // ---------------- stamina ----------------
    if (this.sprinting && this.horizontalSpeed > 1) {
      this.stamina = Math.max(0, this.stamina - P.sprintDrain * dt * this.kit.staminaMul);
      this.staminaCooldown = P.staminaDelay;
    } else if (this.holdingBreath) {
      this.stamina = Math.max(0, this.stamina - P.holdBreathDrain * dt);
      this.staminaCooldown = P.staminaDelay;
    } else if ((this.staminaCooldown -= dt) <= 0) {
      this.stamina = Math.min(P.staminaMax, this.stamina + P.staminaRegen * dt * (this.prone ? 1.5 : 1));
    }

    // ---------------- footsteps (also tell nearby enemies) ----------------
    // Just pushed off for a jump? (Walking off a ledge isn't a jump: no upward speed.)
    if (this._wasOnGround && !this.onGround && this.vel.y > 1.5) this.audio.jump?.(this.world.surfaceUnder(this.pos));
    this._wasOnGround = this.onGround;
    if (this.onGround && this.horizontalSpeed > 0.3) {
      const stride = this.sprinting ? 1.05 : this.prone ? 0.45 : this.crouched ? 0.55 : 0.8;
      const before = Math.floor(this.bobPhase / Math.PI);
      this.bobPhase += (this.horizontalSpeed * dt * Math.PI) / stride;
      if (Math.floor(this.bobPhase / Math.PI) !== before) {
        if (this.prone) this.audio.crawl();
        else {
          // Left, right, left... and the heavier your kit (slower speedMul), the more it rattles.
          this.footSide = -(this.footSide || 1);
          this.audio.footstep(this.sprinting ? 1.2 : this.crouched ? 0.35 : 0.75, this.world.surfaceUnder(this.pos),
            { side: this.footSide, gear: 1 / this.kit.speedMul });
        }
        if (this.onNoise) this.onNoise(this.pos, this.sprinting ? 16 : this.prone ? 1.5 : this.crouched ? 3 : 8);
      }
    }

    // ---------------- bandage ----------------
    if (input.wasPressed('KeyH') && !this.bandaging && this.bandages > 0 && this.health < P.maxHealth) {
      this.bandaging = true;
      this.bandageT = 0;
      this.audio.reload('cloth');
    }
    if (this.bandaging) {
      this.bandageT += dt;
      if (this.bandageT >= P.bandageTime) {
        this.bandaging = false;
        this.bandages--;
        this.health = Math.min(P.maxHealth, this.health + P.bandageHeal);
        this.limp = 0; // strapped up: walking normally again
        this.audio.reload('cloth');
      }
    }

    // ---------------- lean (blocked by walls) ----------------
    let lt = leanTarget;
    if (lt !== 0) {
      const eye = this.pos.y + STANCE[this.stance].eye;
      const hx = this.pos.x + _right.x * P.leanOffset * lt, hz = this.pos.z + _right.z * P.leanOffset * lt;
      if (this.world.boxBlocked(hx - 0.15, eye - 0.15, hz - 0.15, hx + 0.15, eye + 0.15, hz + 0.15)) lt = 0;
    }
    this.lean = lerp(this.lean, lt, Math.min(1, dt * 7));

    // ---------------- weapon sway while aiming ----------------
    // Your aim drifts with breathing; more when tired, hurt or moving.
    const tired = 1 - this.stamina / P.staminaMax;
    const brace = this.braced ? 0.15 : this.prone ? 0.3 : this.crouched ? 0.6 : 1;
    const swayAmp = this.adsFactor * (this.holdingBreath ? 0.08 : 1) * (0.0012 + tired * 0.004 + (this.health < 40 ? 0.002 : 0)) * brace * this.swayMul;
    this.swayX = Math.sin(this.time * 0.9) * Math.cos(this.time * 0.37) * swayAmp;
    this.swayY = Math.sin(this.time * 1.3 + 1) * swayAmp * 0.8;

    this._updateHint(dt);
    this._updateCamera(dt);
  }

  // ---------------------------------------------------------------- vaulting
  // The LEDGE at (x, z): climb the stack of solid boxes rising from your feet
  // there, and report its top plus the underside of whatever is next above it.
  // A window gives { top: sill, ceil: lintel }; a crate in the open gives
  // ceil = Infinity; a doorway (nothing at foot level) gives null.
  _ledgeAt(x, z, feet) {
    const cs = this.world._collect(x - 0.12, feet + 0.05, z - 0.12, x + 0.12, feet + P.mantleMax + 2.5, z + 0.12)
      .filter((c) => c.solid && c.surface !== 'cloth')
      .sort((a, b) => a.min.y - b.min.y);
    if (!cs.length || cs[0].min.y > feet + 0.3) return null;
    let top = cs[0].max.y, i = 1;
    while (i < cs.length && cs[i].min.y <= top + 0.05) top = Math.max(top, cs[i++].max.y);
    return { top, ceil: i < cs.length ? cs[i].min.y : Infinity };
  }

  // Probe the world in front of you. Returns a plan for _startVault, or null.
  // (Also run a few times a second for the HUD prompt, so it doesn't change anything.)
  _planVault() {
    const w = this.world, p = this.pos, feet = p.y;
    // 1) The nearest obstacle within arm's reach, and its ledge
    let hit = -1, ledge = null;
    for (let d = 0.35; d <= 0.95 && hit < 0; d += 0.15) {
      ledge = this._ledgeAt(p.x + _fwd.x * d, p.z + _fwd.z * d, feet);
      if (ledge) hit = d;
    }
    if (!ledge) return null;
    const { top, ceil } = ledge, rise = top - feet, gap = ceil - top;
    if (rise < P.vaultMin || rise > P.mantleMax || gap < P.windowGap) return null;
    const window = gap < P.standHeight; // an opening you have to get low to fit through
    // Room above the top to get your body over it?
    const ox = p.x + _fwd.x * hit, oz = p.z + _fwd.z * hit;
    if (w.boxBlocked(ox - 0.2, top + 0.02, oz - 0.2, ox + 0.2, top + Math.min(1.0, gap - 0.05), oz + 0.2)) return null;

    // 2) VAULT: low enough, with the far side within reach -> hurdle it, or dive through
    if (rise <= P.vaultMax) {
      for (let d = hit + 0.1; d <= hit + 1.3; d += 0.1) {
        const x = p.x + _fwd.x * d, z = p.z + _fwd.z * d;
        if (w.boxBlocked(x - 0.1, top - 0.12, z - 0.1, x + 0.1, top - 0.02, z + 0.1)) continue; // still on top of it
        // Found the far edge: land a little beyond it. If the far side drops away
        // (a parapet on a roof!) you go over and FALL the rest — fall damage and all.
        const lx = p.x + _fwd.x * (d + 0.5), lz = p.z + _fwd.z * (d + 0.5);
        const land = new THREE.Vector3(lx, Math.max(w.groundHeight(lx, lz), feet - 0.6), lz);
        for (const c of w._collect(lx - 0.3, land.y - 0.5, lz - 0.3, lx + 0.3, top, lz + 0.3)) if (c.solid && c.max.y <= top - 0.05) land.y = Math.max(land.y, c.max.y);
        if (w.bodyBlocked(land, this.radius, P.crouchHeight)) break;
        // Is the way over clear? Sample boxes along the line, so this works at an angle too.
        const clear = window ? gap - 0.1 : 0.9;
        let blocked = false;
        for (let s = 0; s <= 1.001 && !blocked; s += 0.25) {
          const sx = lerp(ox, lx, s), sz = lerp(oz, lz, s);
          blocked = w.boxBlocked(sx - 0.15, top + 0.04, sz - 0.15, sx + 0.15, top + clear, sz + 0.15);
        }
        if (blocked) break;
        const apex = top + (window ? 0.1 : 0.18);
        return {
          kind: 'vault', to: land, apex, dur: P.vaultTime + (d - hit) * 0.15,
          endStance: w.bodyBlocked(land, this.radius, P.standHeight) ? 'crouch' : 'stand',
          // Through a window you go over low and head first: keep your eyes under the top of the opening
          eye: window ? THREE.MathUtils.clamp(ceil - apex - 0.2, 0.45, P.standEye - 0.1) : undefined,
          label: window ? 'VAULT THROUGH' : 'VAULT',
        };
      }
    }
    // 3) MANTLE: climb up onto the top (needs room to at least crouch there)
    const mx = p.x + _fwd.x * (hit + 0.4), mz = p.z + _fwd.z * (hit + 0.4);
    const up = new THREE.Vector3(mx, top + 0.01, mz);
    const stance = !w.bodyBlocked(up, this.radius, P.standHeight) ? 'stand' : !w.bodyBlocked(up, this.radius, P.crouchHeight) ? 'crouch' : null;
    if (!stance) return null;
    const apex = top + 0.05;
    return {
      kind: 'mantle', to: up, apex, dur: P.mantleTime * (0.6 + rise / P.mantleMax * 0.6), endStance: stance,
      eye: window ? THREE.MathUtils.clamp(ceil - apex - 0.2, 0.45, P.standEye - 0.25) : undefined,
      label: 'CLIMB UP',
    };
  }

  // Space pressed: vault if we can. A hurdle at a run is quicker and keeps your momentum.
  _tryVault() {
    const plan = this._planVault();
    if (!plan) return false;
    const fast = plan.kind === 'vault' && this.horizontalSpeed > P.walkSpeed;
    this._startVault(plan.kind, plan.to, plan.apex, plan.dur * (fast ? 0.8 : 1), {
      endStance: plan.endStance, eye: plan.eye,
      exitSpeed: plan.kind === 'vault' ? Math.min(this.horizontalSpeed, P.sprintSpeed) * 0.85 : 0,
    });
    return true;
  }

  // opts: endStance, eye (camera height override), exitSpeed (keep running after),
  //       cost (stamina), ladder (grab this ladder at the end), yaw (turn to face this),
  //       fromLadder (climbing off a ladder: gun stays slung)
  _startVault(kind, to, apex, dur, opts = {}) {
    const { endStance = 'stand', cost = kind === 'vault' ? 8 : 16 } = opts;
    this.vault = {
      kind, t: 0, dur, from: this.pos.clone(), to, apex, endStance, dir: _fwd.clone(), yaw0: this.yaw,
      eye: opts.eye, exitSpeed: opts.exitSpeed || 0, ladder: opts.ladder || null, yaw1: opts.yaw, fromLadder: !!opts.fromLadder,
    };
    this.vel.set(0, 0, 0);
    this.stance = 'stand';
    this.height = P.standHeight;
    this.stamina = Math.max(0, this.stamina - cost);
    this.staminaCooldown = P.staminaDelay;
    this.audio.reload('cloth');
    this.audio.footstep(1.1, opts.ladder || opts.fromLadder ? 'metal' : this.world.surfaceUnder(this.pos));
  }

  _updateVault(dt) {
    const v = this.vault;
    v.t += dt / v.dur;
    const t = Math.min(1, v.t);
    if (v.kind === 'vault') {
      // up quickly, over the top, then down to the landing spot
      const h = ease(Math.min(1, t * 1.25));
      this.pos.x = lerp(v.from.x, v.to.x, ease(t));
      this.pos.z = lerp(v.from.z, v.to.z, ease(t));
      const upY = lerp(v.from.y, v.apex, Math.sin(Math.min(1, t * 1.6) * Math.PI / 2));
      this.pos.y = t < 0.62 ? upY : lerp(v.apex, v.to.y, ease((t - 0.62) / 0.38));
      this.landDip = Math.sin(t * Math.PI) * 0.12 * h;
    } else if (v.kind === 'ontoLadder') {
      // step out through the gap in the parapet, then lower yourself onto the rungs
      const out = ease(Math.min(1, t / 0.55)), down = ease(Math.max(0, (t - 0.3) / 0.7));
      this.pos.x = lerp(v.from.x, v.to.x, out);
      this.pos.z = lerp(v.from.z, v.to.z, out);
      this.pos.y = lerp(v.from.y, v.to.y, down);
      this.landDip = Math.sin(t * Math.PI) * 0.1;
    } else {
      // hands on the ledge: pull up first, then roll forward onto it
      const up = ease(Math.min(1, t / 0.65)), fwd = ease(Math.max(0, (t - 0.45) / 0.55));
      this.pos.y = lerp(v.from.y, v.apex, up);
      this.pos.x = lerp(v.from.x, v.to.x, fwd);
      this.pos.z = lerp(v.from.z, v.to.z, fwd);
      this.landDip = Math.sin(t * Math.PI) * 0.35;
    }
    if (v.yaw1 !== undefined) { // turn round to face the ladder (the short way)
      let d = v.yaw1 - v.yaw0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw = v.yaw0 + d * ease(Math.min(1, t / 0.7));
    }
    this.horizontalSpeed = 0;
    if (v.t >= 1) {
      this.pos.copy(v.to);
      this.vault = null;
      if (v.ladder) { this._grabLadder(v.ladder); return; }
      this.onGround = true;
      this.stance = v.endStance;
      this.height = STANCE[this.stance].height;
      // A hurdle keeps your momentum: carry on the way you went over
      if (v.exitSpeed > 0) { this.vel.x = v.dir.x * v.exitSpeed; this.vel.z = v.dir.z * v.exitSpeed; }
      this.audio.footstep(1.2, this.world.surfaceUnder(this.pos));
      if (this.onNoise) this.onNoise(this.pos, 10);
    }
  }

  // ---------------------------------------------------------------- ladders
  // Grab a ladder by walking into it, as in Source or Call of Duty: from the
  // bottom (facing it, pushing forward; or jumping at it), or from the roof
  // (walking toward the opening it comes up through).
  _tryLadder(fwdIn, input) {
    if (this.ladderCooldown > 0 || this.prone || this.stanceBusy > 0) return false;
    for (const L of this.world.ladders) {
      const { along, out } = ladderLocal(L, this.pos.x, this.pos.z);
      if (Math.abs(along) > 0.45) continue;
      const feet = this.pos.y;
      const facing = _fwd.x * -L.nx + _fwd.z * -L.nz; // 1 = looking straight at the wall
      if (out > 0 && out < 1.0 && feet > L.y0 - 0.5 && feet < L.y1 - 1.0 && fwdIn > 0 && facing > 0.5) {
        this._grabLadder(L);
        return true;
      }
      if (this.onGround && out > -1.5 && out < 0.3 && Math.abs(feet - L.y1) < 0.4 && _wish.x * L.nx + _wish.z * L.nz > 0.6) {
        // Turn round and step down onto the top rungs (a short scripted move, like a vault)
        this.ladderHoldDown = input.isDown('KeyW');
        this._startVault('ontoLadder', new THREE.Vector3(L.cx, L.y1 - 1.1, L.cz), L.y1, 0.75, { ladder: L, yaw: L.yaw, cost: 0 });
        return true;
      }
    }
    return false;
  }

  _grabLadder(L) {
    this.ladder = L;
    this.vel.set(0, 0, 0);
    this.onGround = false;
    this.stance = 'stand';
    this.height = P.standHeight;
    this.sprinting = false;
    this.bandaging = false; // both hands on the rungs
    this.audio.footstep(0.6, 'metal');
  }

  // On a ladder: W climbs (or goes down if you look down at your feet), S goes
  // down, Shift hurries (costs stamina), Space lets go. Both hands are on the
  // rungs, so the gun is slung and you can't shoot.
  _updateLadder(dt, input) {
    const L = this.ladder;
    this.hint = '[W/S] CLIMB · [SHIFT] FASTER · [SPACE] LET GO';
    this.sprinting = false;
    this.horizontalSpeed = 0;
    this.sprintAmount = lerp(this.sprintAmount, 0, Math.min(1, dt * 8));
    this.crouchT = lerp(this.crouchT, 0, Math.min(1, dt * 10));
    this.proneT = lerp(this.proneT, 0, Math.min(1, dt * 4));
    this.lean = lerp(this.lean, 0, Math.min(1, dt * 7));
    this.swayX = this.swayY = 0;

    if (input.wasPressed('Space')) { // let go: push off backwards and drop
      this.ladder = null;
      this.ladderCooldown = 0.6;
      this.vel.set(L.nx * 2.2, 1.2, L.nz * 2.2);
      return;
    }
    const w = input.isDown('KeyW'), s = input.isDown('KeyS');
    if (!w) this.ladderHoldDown = false;
    let climb = w ? (this.ladderHoldDown || this.pitch < -0.75 ? -1 : 1) : 0;
    if (s) climb = -1;
    const fast = (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && this.stamina > 5 && climb !== 0;
    const speed = P.ladderSpeed * (fast ? P.ladderSprintMul : 1) * this.kit.speedMul * (this.limp > 0 ? 0.7 : 1);

    // Reached the top: pull yourself over onto the roof (the mantle move)
    if (climb > 0 && this.pos.y >= L.y1 - 0.9) {
      this.ladder = null;
      this._startVault('mantle', L.top.clone(), L.y1 + 0.05, 0.8, { cost: 4, fromLadder: true });
      return;
    }
    // Stay on the climbing line and move up/down. moveBody stops us at the
    // ground or under anything overhead.
    this.vel.set((L.cx - this.pos.x) * 10, climb * speed, (L.cz - this.pos.z) * 10);
    this.world.moveBody(this, dt, 0);
    if (climb < 0 && this.onGround) { this.ladder = null; this.ladderCooldown = 0.4; return; } // stepped off at the bottom

    if (fast) {
      this.stamina = Math.max(0, this.stamina - P.sprintDrain * dt * this.kit.staminaMul);
      this.staminaCooldown = P.staminaDelay;
    } else if ((this.staminaCooldown -= dt) <= 0) this.stamina = Math.min(P.staminaMax, this.stamina + P.staminaRegen * dt * 0.5);

    // A clank on every rung (enemies nearby can hear it too)
    const before = Math.floor(this.climbPhase / Math.PI);
    this.climbPhase += (Math.abs(this.vel.y) * dt * Math.PI) / LADDER.rung;
    if (Math.floor(this.climbPhase / Math.PI) !== before) {
      this.audio.footstep(fast ? 0.7 : 0.45, 'metal');
      if (this.onNoise) this.onNoise(this.pos, fast ? 10 : 6);
    }
  }

  // ---------------------------------------------------------------- falling
  // Fall damage grows with impact speed (numbers in config.js). Landing in a
  // crouch spreads the shock through bent knees, as paratroopers are taught,
  // and a hard landing leaves you limping for a while (a bandage fixes it).
  _hardLanding(speed) {
    let dmg = (speed - P.fallDamageMinSpeed) * P.fallDamagePerMs;
    if (this.crouched) dmg *= P.fallCrouchMul;
    const surface = this.world.surfaceUnder(this.pos);
    if (this.audio.land) this.audio.land(speed, surface); else this.audio.footstep(1.6, surface);
    this.landDip = Math.min(0.45, this.landDip + 0.12 + dmg * 0.004);
    this.limp = Math.max(this.limp, Math.min(12, dmg * P.fallLimpPerDamage));
    this.vel.x *= 0.2; this.vel.z *= 0.2; // the impact stops you dead
    this.stamina = Math.max(0, this.stamina - dmg * 0.5);
    this.staminaCooldown = P.staminaDelay;
    if (this.onNoise) this.onNoise(this.pos, 14);
    this.takeDamage(dmg, null, 'fall');
    if (this.alive) this.onFall?.(dmg);
  }

  // ---------------------------------------------------------------- HUD hint
  // What could you do right here? ("[SPACE] VAULT", "[W] CLIMB LADDER"...)
  // Checked a few times a second, not every frame: the vault probe isn't free.
  _updateHint(dt) {
    if ((this._hintT -= dt) > 0) return;
    this._hintT = 0.12;
    this.hint = '';
    if (!this.onGround || this.prone || this.stanceBusy > 0) return;
    for (const L of this.world.ladders) {
      const { along, out } = ladderLocal(L, this.pos.x, this.pos.z);
      if (Math.abs(along) > 0.6) continue;
      const facing = _fwd.x * -L.nx + _fwd.z * -L.nz;
      if (out > 0 && out < 1.6 && this.pos.y > L.y0 - 0.5 && this.pos.y < L.y1 - 1 && facing > 0.3) { this.hint = '[W] CLIMB LADDER'; return; }
      if (out > -2 && out < 0.3 && Math.abs(this.pos.y - L.y1) < 0.4) { this.hint = facing < 0 ? '[W] CLIMB DOWN' : '[S] CLIMB DOWN'; return; }
    }
    const plan = this._planVault();
    if (plan) this.hint = `[SPACE] ${plan.label}`;
  }

  // A nearby explosion rattles the camera (amount 0..1+)
  shake(amount) { this.shakeAmt = Math.min(1.5, this.shakeAmt + amount); }

  // 0..1 how far the gun is lowered for a vault, or slung for a ladder
  get vaultAmount() { return Math.max(this.vault ? Math.sin(Math.min(1, this.vault.t) * Math.PI) : 0, this.climbT); }

  // ---------------------------------------------------------------- camera
  _updateCamera(dt) {
    const v = this.vault;
    const targetEye = v ? v.eye ?? P.standEye - (v.kind === 'mantle' ? 0.25 : 0.1) : STANCE[this.stance].eye;
    // Smooth the eye height (stairs, stance changes). Going prone is slower;
    // ducking for a dive through a window has to be quick.
    this.eyeY = lerp(this.eyeY, targetEye, Math.min(1, dt * (v?.eye ? 22 : this.prone || this.proneT > 0.05 ? 4.5 : 12)));
    if (this.stepped) this.eyeY -= this.stepped * 0.8;
    this.landDip = Math.max(0, this.landDip - dt * 0.6);

    const cam = this.camera;
    const bobAmp = this.onGround ? Math.min(1, this.horizontalSpeed / 6) * (1 - this.adsFactor * 0.8) : 0;
    const bobY = Math.abs(Math.sin(this.bobPhase)) * (this.prone ? 0.02 : 0.035) * bobAmp * (this.prone ? 3 : 1);
    const crawlRoll = this.prone ? Math.sin(this.bobPhase) * 0.03 * this.crawling : 0;
    const climbRoll = this.ladder ? Math.sin(this.climbPhase) * 0.012 : 0; // hand over hand up the rungs
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    cam.position.set(this.pos.x, this.pos.y + this.eyeY - bobY - this.landDip - Math.abs(this.lean) * 0.06, this.pos.z)
      .addScaledVector(_right, this.lean * P.leanOffset);
    cam.rotation.order = 'YXZ';
    const vaultTilt = v ? Math.sin(Math.min(1, v.t) * Math.PI) * (v.kind === 'mantle' ? -0.18 : v.kind === 'ontoLadder' ? -0.12 : 0.06) : 0;
    cam.rotation.set(this.pitch + this.swayY + vaultTilt - this.landDip * 0.4, this.yaw + this.swayX, -this.lean * P.leanAngle + crawlRoll + climbRoll);

    if (this.shakeAmt > 0) { // explosion shake: random jolts that die away
      const s = this.shakeAmt * this.shakeAmt;
      cam.rotation.x += (Math.random() - 0.5) * 0.06 * s;
      cam.rotation.y += (Math.random() - 0.5) * 0.04 * s;
      cam.rotation.z += (Math.random() - 0.5) * 0.05 * s;
      cam.position.y += (Math.random() - 0.5) * 0.05 * s;
      this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.4);
    }

    // Zoom when aiming
    const fov = lerp(this.fov, this.adsFov, this.adsFactor);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  _deathCam(dt) {
    // Killed on a ladder, mid-vault or in the air: the body drops to the ground
    if (this.ladder || this.vault) { this.ladder = null; this.vault = null; this.onGround = false; }
    this.hint = '';
    if (!this.onGround) {
      this.vel.x = 0; this.vel.z = 0;
      this.vel.y -= P.gravity * dt;
      this.world.moveBody(this, dt, 0);
    }
    this.deathT = Math.min(1, this.deathT + dt * 1.5);
    const t = this.deathT * this.deathT;
    const cam = this.camera;
    cam.position.y = lerp(cam.position.y, this.pos.y + 0.25, t * 0.2);
    cam.rotation.z = lerp(cam.rotation.z, 1.2, t * 0.1);
    cam.rotation.x = lerp(cam.rotation.x, -0.2, t * 0.1);
  }

  // ---------------------------------------------------------------- damage
  // Bullets call this through the ballistics "target" interface (see main.js)
  onBulletHit(info) {
    const head = info.zone === 'head', armour = this.kit.armor.torso;
    const mul = head ? 2.2 : armour; // body armour stops part of torso hits
    // With armour on, most body hits land on the plate (you hear it), the rest on arms and legs.
    const kind = head ? 'head' : armour < 1 && Math.random() < 0.6 ? 'armor' : 'body';
    this.takeDamage(info.damage * mul, info.point.clone().addScaledVector(info.dir, -10), kind);
  }

  // fromPos: roughly where it came from (null = no direction, e.g. a fall).
  // kind: 'body' | 'armor' | 'head' | 'blast' | 'fall' (sound and screen effects).
  takeDamage(amount, fromPos, kind = fromPos ? 'blast' : 'fall') {
    if (!this.alive) return;
    this.health -= amount;
    this.lastDamageTime = this.time;
    this.bandaging = false;
    this.audio.hurt(amount, kind);
    // Flinch: getting hit throws your aim and jolts your view
    this.pitch += (Math.random() - 0.3) * 0.04;
    this.yaw += (Math.random() - 0.5) * 0.04;
    this.shake(Math.min(0.55, 0.15 + amount / 60));
    if (this.onDamaged) this.onDamaged(amount, fromPos, kind);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.deathT = 0;
      this.audio.death?.();
      if (this.onDeath) this.onDeath();
    }
  }

  // Hit boxes for enemy bullets. Standing/crouching: body + head stacked.
  // Prone: you're lying along the direction you face, head in front.
  raycastHitbox(origin, dir, maxDist) {
    const x = this.pos.x, y = this.pos.y, z = this.pos.z;
    let boxes;
    if (this.prone) {
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const hx = Math.abs(fx) * 0.85 + Math.abs(fz) * 0.28, hz = Math.abs(fz) * 0.85 + Math.abs(fx) * 0.28;
      const cx = x - fx * 0.35, cz = z - fz * 0.35; // body lies behind the head
      boxes = [
        { zone: 'body', min: [cx - hx, y, cz - hz], max: [cx + hx, y + 0.42, cz + hz] },
        { zone: 'head', min: [x + fx * 0.2 - 0.13, y + 0.05, z + fz * 0.2 - 0.13], max: [x + fx * 0.2 + 0.13, y + 0.38, z + fz * 0.2 + 0.13] },
      ];
    } else {
      const r = 0.26, h = this.height, head = 0.28;
      boxes = [
        { zone: 'body', min: [x - r, y, z - r], max: [x + r, y + h - head, z + r] },
        { zone: 'head', min: [x - 0.13, y + h - head, z - 0.13], max: [x + 0.13, y + h, z + 0.13] },
      ];
    }
    let best = null;
    for (const b of boxes) {
      let tmin = 0, tmax = maxDist, ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        const o = a === 0 ? origin.x : a === 1 ? origin.y : origin.z;
        const d = a === 0 ? dir.x : a === 1 ? dir.y : dir.z;
        if (Math.abs(d) < 1e-9) { if (o < b.min[a] || o > b.max[a]) ok = false; continue; }
        let t1 = (b.min[a] - o) / d, t2 = (b.max[a] - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
        if (tmin > tmax) ok = false;
      }
      if (ok && (!best || tmin < best.dist)) best = { dist: tmin, zone: b.zone };
    }
    if (!best) return null;
    return { dist: best.dist, zone: best.zone, point: origin.clone().addScaledVector(dir, best.dist), entity: this };
  }
}

// =============================================================================
// weapon.js — weapon logic: ammo, fire rate, fire modes, reloads, aiming,
// spread, recoil, bolt-action cycling and bipods. The viewmodel only DRAWS
// the gun; this file decides what the gun DOES. Keeping the two apart is
// standard (Quake: g_weapon.c on the server for logic, cg_weapons.c on the
// client for visuals).
//
// Weapons come from your LOADOUT (loadout.js): the base gun's numbers from
// config.js with every attachment's modifiers already applied.
// =============================================================================
import * as THREE from 'three';
import { buildWeapon } from './loadout.js';

const _dir = new THREE.Vector3(), _origin = new THREE.Vector3(), _muzzle = new THREE.Vector3();
const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _off = new THREE.Vector3();
const _eject = new THREE.Vector3(), _ev = new THREE.Vector3();
const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
const lerp = (a, b, t) => a + (b - a) * t;

export class WeaponSystem {
  constructor({ viewmodel, ballistics, effects, audio, sunDir }) {
    this.vm = viewmodel;
    this.ballistics = ballistics;
    this.effects = effects;
    this.audio = audio;
    this.sunDir = sunDir;
    this.onShot = null; // (position, loudness) — lets enemies hear you
    this.onFire = null; // (origin, dir, weaponId, tracer, suppressed) — co-op: show your shot to your squad
    this.cfgs = { primary: buildWeapon({ id: 'rifle' }), secondary: buildWeapon({ id: 'pistol' }) };
    this.reset();
  }

  // A new loadout (built weapon configs). Rebuilds the guns you see.
  setLoadout({ primary, secondary }) {
    this.cfgs = { primary, secondary };
    this.vm.setLoadout(this.cfgs);
    this.reset();
  }

  reset() {
    this.state = {};
    // zoom = the power your scope is set to; zoomNow = the power you see right now
    // (it glides towards zoom, like a real magnification ring being turned)
    for (const [slot, cfg] of Object.entries(this.cfgs)) {
      const zoom = cfg.optic?.zoom || 1;
      this.state[slot] = { cfg, mag: cfg.magSize, reserve: cfg.reserve, mode: 0, zoom, zoomNow: zoom };
    }
    this.currentId = 'primary';
    this.vm.setWeapon('primary');
    this.ads = 0;
    this.cooldown = 0;
    this.bloom = 0;
    this.reloadT = -1;
    this.reloadDur = 1;
    this.reloadEmpty = false;
    this.reloadEvents = new Set();
    this.switchT = 0;
    this.switchTarget = null;
    this.spread = 0;
    this.boltT = -1;         // >= 0 while working the bolt (bolt-action)
    this.boltEvents = new Set();
    this.bipodDeployed = false;
    this.handsBusy = false;  // set while you're throwing a grenade
    this.shotsFired = 0;
  }

  get cur() { return this.state[this.currentId]; }
  // Looking through a magnified scope (the HUD shows the scope picture; the gun model is hidden)
  get scoped() { return this.ads > 0.85 && (this.cur.cfg.optic?.zoom || 1) > 1; }

  refill() {
    for (const st of Object.values(this.state)) st.reserve = st.cfg.reserve;
    this.audio.reload('magIn');
  }

  startReload() {
    const st = this.cur, cfg = st.cfg;
    if (this.reloadT >= 0 || this.switchTarget || this.boltT >= 0 || st.reserve <= 0 || st.mag > cfg.magSize) return;
    this.reloadEmpty = st.mag === 0;
    this.reloadDur = this.reloadEmpty ? cfg.reloadEmptyTime : cfg.reloadTime;
    this.reloadT = 0;
    this.reloadEvents.clear();
    this.ads = Math.min(this.ads, 0.3);
    this.audio.reload('cloth');
  }

  // Turn a variable scope's magnification ring by some wheel notches
  // (positive = zoom in). Each notch clicks to the next power marked on the
  // ring, and the scope stays where you left it, just like a real one.
  _turnZoomRing(steps, notches) {
    const st = this.cur;
    const here = Math.max(0, steps.indexOf(st.zoom));
    const next = Math.max(0, Math.min(steps.length - 1, here + notches));
    if (next === here) return; // already at the end of the ring
    st.zoom = steps[next];
    this.audio.reload('mode'); // a small detent click
  }

  _finishReload() {
    const st = this.cur;
    const chambered = st.mag > 0 ? 1 : 0;   // tactical reload keeps one round in the chamber (30+1)
    st.reserve += st.mag - chambered;       // rounds in the old mag go back into your pouches
    st.mag = chambered;
    const take = Math.min(st.reserve, st.cfg.magSize);
    st.mag += take;
    st.reserve -= take;
    this.reloadT = -1;
  }

  update(dt, input, player, camera) {
    const canAct = player.alive && !player.bandaging;
    player.weaponSlot = this.currentId === 'secondary' ? 1 : 0; // co-op: squadmates see which gun you hold
    this.cooldown -= dt;

    // --- switching weapons (lower, swap, raise) ---
    let want = null;
    if (input.wasPressed('Digit1')) want = 'primary';
    if (input.wasPressed('Digit2')) want = 'secondary';
    // The mouse wheel turns the zoom ring while you aim with a variable scope,
    // and swaps weapons the rest of the time. The wheel counts +1 per notch
    // scrolled DOWN, so scrolling up (negative) zooms in.
    const wheel = input.consumeWheel(), zoomSteps = this.cur.cfg.optic?.zoomSteps;
    if (wheel && zoomSteps && canAct && input.isDown('Mouse2') && !this.switchTarget) this._turnZoomRing(zoomSteps, -wheel);
    else if (wheel) want = this.currentId === 'primary' ? 'secondary' : 'primary';
    if (canAct && want && want !== this.currentId && !this.switchTarget) {
      this.switchTarget = want;
      this.reloadT = -1;
      this.boltT = -1;
      this.audio.reload('switch');
    }
    if (this.switchTarget) {
      this.switchT += dt / 0.3;
      if (this.switchT >= 1) {
        this.switchT = 1;
        this.currentId = this.switchTarget;
        this.switchTarget = null;
        this.vm.setWeapon(this.currentId);
        this.bloom = 0;
      }
    } else if (this.switchT > 0) {
      this.switchT = Math.max(0, this.switchT - dt / 0.3);
    }

    const st = this.cur, cfg = st.cfg;
    this.bloom = Math.max(0, this.bloom - cfg.bloomRecovery * dt);

    // --- fire mode / reload input ---
    if (canAct && input.wasPressed('KeyV') && cfg.modes.length > 1) {
      st.mode = (st.mode + 1) % cfg.modes.length;
      this.audio.reload('mode');
    }
    if (canAct && input.wasPressed('KeyR')) this.startReload();
    if (this.reloadT >= 0) {
      if (!canAct) this.reloadT = -1;
      else {
        this.reloadT += dt;
        const p = this.reloadT / this.reloadDur, ev = this.reloadEvents;
        if (p > 0.18 && !ev.has('out')) { ev.add('out'); this.audio.reload('magOut'); }
        if (p > 0.6 && !ev.has('in')) { ev.add('in'); this.audio.reload('magIn'); }
        if (this.reloadEmpty && p > 0.78 && !ev.has('bolt')) { ev.add('bolt'); this.audio.reload('bolt'); }
        if (p >= 1) this._finishReload();
      }
    }

    // --- bolt-action: work the bolt after every shot ---
    if (this.boltT >= 0) {
      this.boltT += dt / cfg.boltTime;
      const ev = this.boltEvents;
      if (this.boltT > 0.25 && !ev.has('open')) { // bolt back: the empty case flies out
        ev.add('open');
        this.audio.reload('bolt');
        this.vm.ejectWorld(camera, _eject);
        _right.setFromMatrixColumn(camera.matrixWorld, 0);
        _ev.copy(_right).multiplyScalar(1.6).add(_up.set(0, 1.4, 0)).add(player.vel);
        this.effects.ejectShell(_eject, _ev);
      }
      if (this.boltT >= 1) this.boltT = -1;
    }

    // --- bipod: deploys when you're prone, or crouched with something to rest on ---
    this.bipodDeployed = !!cfg.bipod && (player.prone || (player.crouched && player.canBrace?.()));
    player.braced = this.bipodDeployed;

    // --- aim down sights ---
    // busy = something else has your hands (throwing a grenade, vaulting, crawling, getting down)
    const busy = player.weaponBlocked || this.handsBusy;
    const ready = this.reloadT < 0 && this.switchT === 0 && this.boltT < 0 && player.sprintAmount < 0.25 && !busy;
    const wantAds = canAct && input.isDown('Mouse2') && this.reloadT < 0 && this.switchT === 0 && !player.sprinting && !busy;
    this.ads = approach(this.ads, wantAds ? 1 : 0, dt / cfg.adsTime);
    player.adsFactor = this.ads;
    const zoom = cfg.optic?.zoom || 1;
    // Glide towards the set power. Easing the RATIO (not the difference) makes
    // 3x->4x feel as quick as 9x->12x.
    st.zoomNow *= Math.pow(st.zoom / st.zoomNow, Math.min(1, dt * 10));
    player.adsFov = zoom > 1 ? player.fov / st.zoomNow : cfg.adsFov;
    player.swayMul = cfg.swayMul * (zoom > 1 ? 1.4 : 1); // magnified optics show every tremor

    // --- current spread (also drives the crosshair size) ---
    const moveFrac = Math.min(1, player.horizontalSpeed / 6.2);
    let spread = lerp(cfg.hipSpread, cfg.adsSpread, this.ads)
      + cfg.moveSpread * moveFrac * (1 - this.ads * 0.6)
      + this.bloom * (1 - this.ads * 0.6);
    if (player.crouched) spread *= 0.8;
    if (player.prone) spread *= 0.5; // rifle rested on the ground
    if (this.bipodDeployed) spread *= 0.6;
    if (!player.onGround) spread += 0.06;
    this.spread = spread;

    // --- trigger ---
    const auto = cfg.modes[st.mode] === 'AUTO';
    const trigger = auto ? input.isDown('Mouse0') : input.wasPressed('Mouse0');
    if (canAct && ready && trigger && this.cooldown <= 0) {
      if (st.mag > 0) this._fire(player, camera, cfg, st);
      else if (input.wasPressed('Mouse0')) this.audio.dryFire();
    }

    this.vm.update(dt, {
      ads: this.ads,
      speed: player.horizontalSpeed,
      sprint: player.sprintAmount,
      onGround: player.onGround,
      bobPhase: player.bobPhase,
      lookDX: player.lastLookDX,
      lookDY: player.lastLookDY,
      reload: this.reloadT >= 0 ? this.reloadT / this.reloadDur : -1,
      reloadEmpty: this.reloadEmpty,
      switchT: this.switchT,
      steady: player.holdingBreath ? 1 : 0,
      lower: Math.max(player.crawling, player.vaultAmount, Math.min(1, player.stanceBusy * 3), this.handsBusy ? 1 : 0),
      prone: player.proneT,
      bolt: this.boltT,
      bipod: this.bipodDeployed ? 1 : 0,
      sunDir: this.sunDir,
      mainCamera: camera,
    });
  }

  _fire(player, camera, cfg, st) {
    st.mag--;
    this.cooldown = 60 / cfg.rpm;
    this.shotsFired++;

    // Random point inside the spread cone (uniform over a disc)
    camera.getWorldDirection(_dir);
    _right.setFromMatrixColumn(camera.matrixWorld, 0);
    _up.setFromMatrixColumn(camera.matrixWorld, 1);
    const r = this.spread * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
    _dir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
    this.bloom = Math.min(cfg.bloomMax, this.bloom + cfg.bloomPerShot);

    camera.getWorldPosition(_origin);
    this.vm.muzzleWorld(camera, _muzzle);
    const tracer = cfg.tracerEvery > 0 && st.mag % cfg.tracerEvery === 0;
    this.ballistics.fire({
      origin: _origin, dir: _dir, speed: cfg.muzzleVelocity, damage: cfg.damage, team: 'player',
      penetration: cfg.penetration, tracer, visualOffset: _off.subVectors(_muzzle, _origin),
      falloff: { start: cfg.falloffStart, end: cfg.falloffEnd, min: cfg.minDamageMul },
      headMul: cfg.headMul, limbMul: cfg.limbMul, shooter: player,
    });
    if (this.onFire) this.onFire(_origin, _dir, cfg.id, tracer, cfg.suppressed);

    // Recoil kicks the CAMERA (where you aim), not just the gun model
    const rk = (this.ads > 0.5 ? cfg.adsRecoilMul : 1) * (player.prone ? 0.6 : player.crouched ? 0.85 : 1) * (this.bipodDeployed ? 0.35 : 1);
    player.addRecoil(cfg.recoilPitch * rk * (0.85 + Math.random() * 0.3), cfg.recoilYaw * rk * (Math.random() * 2 - 0.8), cfg.recoilRecovery);

    this.vm.fireKick(this.ads, cfg);
    this.effects.flashLight(_muzzle, cfg.suppressed ? 3 : 25);
    _ev.copy(_dir);
    this.effects.muzzleSmoke(_muzzle, _ev);
    this.audio.gunshot(null, cfg.id, true, cfg.suppressed);

    if (cfg.boltTime) { // bolt-action: the case comes out when you work the bolt
      this.boltT = 0;
      this.boltEvents.clear();
    } else { // spent brass flies out of the ejection port to the right
      this.vm.ejectWorld(camera, _eject);
      _ev.copy(_right).multiplyScalar(2 + Math.random()).addScaledVector(_up, 1.2 + Math.random() * 0.6).add(player.vel);
      this.effects.ejectShell(_eject, _ev);
    }

    if (this.onShot) this.onShot(_origin.clone(), cfg.loudness);
  }

  hudState() {
    const st = this.cur, cfg = st.cfg;
    return {
      name: cfg.tag ? `${cfg.name} · ${cfg.tag}` : cfg.name,
      mode: cfg.modes[st.mode] + (this.bipodDeployed ? ' · BIPOD' : ''),
      mag: st.mag,
      magSize: cfg.magSize,
      reserve: st.reserve,
      reloading: this.reloadT >= 0,
      ads: this.scoped ? 1 : this.ads,
      spread: this.spread,
      scoped: this.scoped,
    };
  }
}

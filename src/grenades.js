// =============================================================================
// grenades.js — every grenade: cooking, throwing, bouncing, sticking,
// exploding, smoke screens, flashbangs and decoys.
//
// You carry two pouches (picked in the armory, see loadout.js EQUIPMENT):
//   G  LETHAL   x2   frag | sticky | impact | claymore
//   X  TACTICAL x1   smoke | flashbang | decoy
//
//   Hold the key -> pull the pin. For "cookable" types the spoon flies off and
//                   the fuse starts burning in your hand; hold a frag too long
//                   and it goes off there.
//   Release      -> throw.
//
// A grenade is a little physics object: gravity pulls it down, and every
// substep we ray-test the short path it travels. When it hits something we
// REFLECT its velocity off the surface normal, keeping only part of the speed
// (bounce) and sliding speed (friction), so it skips, rolls and stops. The
// types only differ in what happens on a hit and when the fuse runs out:
//   frag    bounces; blast when the 4 s fuse ends
//   sticky  stops dead on the first thing it touches (a soldier too: it rides
//           along on him); blast 2.5 s after the throw
//   impact  blast the instant it hits something, once it has flown far enough
//           to arm (so it can't go off in your face)
//   smoke   pours out a cloud for ~30 s that the AI can't see through
//   flash   a blinding flash and a deafening bang: anyone who SEES it is
//           blinded for a few seconds (longer if close / looking right at it)
//   decoy   lies there faking bursts of rifle fire, so enemies go and look
//   claymore isn't thrown: you PLANT it facing where you look. When an enemy
//           walks into the zone in front of it, it blasts a fan of steel
//           balls forward (see "claymores" below)
//
// Lethal blasts: damage falls off with distance and is BLOCKED by cover (we
// ray-test from the blast to each soldier's chest).
//
// Co-op: every computer simulates every grenade (see coop.js), but only the
// host decides what happens to enemies (damagesEnemies), and each computer
// applies damage / blindness only to its own player.
// =============================================================================
import * as THREE from 'three';
import { GRENADE as G } from './config.js';

const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3(), _p = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();
const RADIUS = 0.04;

// Every type. slot: which pouch (and key). fuse: seconds. cook: true = the
// fuse starts when you pull the pin (holding burns it); false = it only starts
// when you let go. blast: { radius m, damage at the centre } for lethal ones.
export const TYPES = {
  frag: { slot: 'lethal', label: 'FRAG', fuse: G.fuse, cook: true, blast: { radius: G.radius, damage: G.damage } },
  sticky: { slot: 'lethal', label: 'STICKY', fuse: 2.5, cook: false, sticks: true, blast: { radius: 8, damage: 200 } },
  // fuse here = the back-up self-destruct if it never hits anything hard
  impact: { slot: 'lethal', label: 'IMPACT', fuse: 4, cook: false, onImpact: true, armAfter: 0.18, blast: { radius: 8.5, damage: 190 } },
  // placed, not thrown: see "claymores" further down
  claymore: { slot: 'lethal', label: 'CLAYMORE', fuse: 0, cook: false, placed: true },
  smoke: { slot: 'tactical', label: 'SMOKE', fuse: 1.6, cook: true },
  flash: { slot: 'tactical', label: 'FLASHBANG', fuse: 1.5, cook: true },
  decoy: { slot: 'tactical', label: 'DECOY', fuse: 2.0, cook: false },
};
const KEYS = { lethal: 'KeyG', tactical: 'KeyX' };
const SMOKE = { duration: 30, radius: 6.5, grow: 3.5 };
const FLASH = { range: 20, blindMax: 5, close: 3 };      // m, s, m
const DECOY = { duration: 12, heard: 110 };               // s, m (same as a rifle shot)
// Claymore (modelled loosely on the M18A1): 700 steel balls blasted out in a
// 60° fan. The real one is deadly to 50 m; we use game-sized distances.
const CLAYMORE = {
  arm: 1.5,                    // s after planting before it can be tripped (time to step away)
  sense: 3.5,                  // m: the "tripwire" zone in front of it...
  senseCos: Math.cos(0.9),     // ...within ~50° either side of straight ahead
  delay: 0.15,                 // s from trip to bang (the click you might just hear)
  range: 18, damage: 260,      // the fan: lethal to ~10 m, hurts to 18 m
  arcCos: Math.cos(0.55),      // fan half-angle ~32° (so ~64° wide)
  back: 2.5, backDamage: 110,  // blast danger all round when close (behind too: don't hug your own claymore)
};

// What each one looks like. 'ball' = a round body, 'can' = a cylinder.
// Bands follow NATO-style markings (yellow = high explosive).
const LOOKS = {
  frag: { shape: 'ball', color: 0x4b5232 },                                     // M67-style
  sticky: { shape: 'ball', color: 0x8b8372, scaleY: 1.12, band: 0x2a2a26 },     // charge wrapped in an adhesive sock
  impact: { shape: 'ball', color: 0x3d4636, scaleY: 1.3, r: 0.027, band: 0xc9a227 },
  smoke: { shape: 'can', color: 0x56603e, band: 0xd8d4c8 },                     // M18-style
  flash: { shape: 'can', color: 0x46494b, band: 0x141618, bands: 3, metal: 0.7 }, // M84-style perforated tube
  decoy: { shape: 'can', color: 0x26282a, band: 0xd06a1c, h: 0.09 },
};
const _mats = {};
function lookMaterials(kind) {
  if (_mats[kind]) return _mats[kind];
  const L = LOOKS[kind];
  return (_mats[kind] = {
    body: new THREE.MeshStandardMaterial({ color: L.color, roughness: 0.6, metalness: L.metal ?? 0.3 }),
    band: L.band ? new THREE.MeshStandardMaterial({ color: L.band, roughness: 0.8 }) : null,
    steel: _mats.steel || (_mats.steel = new THREE.MeshStandardMaterial({ color: 0x7d7f7a, roughness: 0.4, metalness: 0.9 })),
  });
}

// M18A1-style claymore: a curved olive case on two pairs of scissor legs, with
// FRONT TOWARD ENEMY moulded into the convex face (yes, the real one says that).
// The model faces -Z, like the camera, so rotation.y = yaw points it.
let _claymoreMats = null;
function claymoreModel() {
  if (!_claymoreMats) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 100;
    const x = c.getContext('2d');
    x.fillStyle = '#4a4f33'; x.fillRect(0, 0, 256, 100);
    x.font = 'bold 21px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = '#33371f'; x.fillText('FRONT TOWARD ENEMY', 129, 52); // "embossed": dark edge...
    x.fillStyle = '#6a7049'; x.fillText('FRONT TOWARD ENEMY', 128, 50); // ...and lighter raised letters
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    _claymoreMats = {
      body: new THREE.MeshStandardMaterial({ color: 0x4a4f33, roughness: 0.75, metalness: 0.05 }),
      front: new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.05 }),
      steel: lookMaterials('frag').steel,
    };
  }
  const M = _claymoreMats, g = new THREE.Group();
  const geo = new THREE.BoxGeometry(0.216, 0.083, 0.035, 8, 1, 1);
  const p = geo.attributes.position; // bend it: the middle bulges towards the enemy
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + p.getX(i) * p.getX(i) * 1.6);
  geo.computeVertexNormals();
  const body = new THREE.Mesh(geo, [M.body, M.body, M.body, M.body, M.body, M.front]); // last = the -Z face
  body.position.y = 0.085;
  g.add(body);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { // scissor legs, splayed out
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.07, 5), M.steel);
    leg.position.set(sx * 0.075, 0.03, sz * 0.012);
    leg.rotation.set(sz * 0.35, 0, -sx * 0.2);
    g.add(leg);
  }
  for (const sx of [-1, 1]) { // detonator wells on top
    const well = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.012, 8), M.body);
    well.position.set(sx * 0.045, 0.132, 0);
    g.add(well);
  }
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

function grenadeModel(kind) {
  if (kind === 'claymore') return claymoreModel();
  const L = LOOKS[kind] || LOOKS.frag, M = lookMaterials(kind in LOOKS ? kind : 'frag');
  const g = new THREE.Group();
  const can = L.shape === 'can', r = L.r || (can ? 0.03 : 0.032), h = L.h || 0.11;
  const body = can ? new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 14), M.body) : new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), M.body);
  if (L.scaleY) body.scale.y = L.scaleY;
  const top = can ? h / 2 + 0.01 : r * (L.scaleY || 1) + 0.004;
  const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.011, 0.025, 10), M.steel);
  fuse.position.y = top;
  const spoon = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.06, 0.004), M.steel);
  spoon.position.set(r * 0.7 + 0.004, top - 0.022, 0);
  spoon.rotation.z = -0.35;
  g.add(body, fuse, spoon);
  for (let i = 0; i < (L.band ? L.bands || 1 : 0); i++) {
    const band = can ? new THREE.Mesh(new THREE.CylinderGeometry(r + 0.0006, r + 0.0006, 0.012, 14), M.band)
      : new THREE.Mesh(new THREE.CylinderGeometry(r * 1.01, r * 1.01, 0.01, 14), M.band);
    band.position.y = can ? (L.bands ? (i - 1) * 0.03 : 0.02) : 0;
    g.add(band);
  }
  g.traverse((o) => { o.castShadow = true; });
  return g;
}

export class Grenades {
  // sys = { scene, world, effects, audio, enemies, player, camera, weapons, vmScene, glove }
  constructor(sys) {
    Object.assign(this, sys);
    this.types = TYPES;
    this.live = [];
    this.smokes = [];             // active smoke screens { pos, t }
    this.decoys = [];             // decoys faking gunfire { pos, t, next, burst, mesh }
    this.mines = [];              // planted claymores { pos, dir, team, age, trig, mesh }
    this.world.smokes = [];       // what the AI checks: { pos, r }
    this.kit = { lethal: 'frag', tactical: 'smoke', lethalCount: G.count, tacticalCount: 1 }; // what your loadout carries
    this.counts = { lethal: 0, tactical: 0 };
    this.refill();
    this.damagesEnemies = true;   // false on co-op friends: the host decides
    this.onThrow = null;          // (g) a grenade was created here — co-op sends it to the squad
    this.onExplode = null;        // (pos) for AI hearing/suppression
    this.onMineFired = null;      // (pos) host: a claymore went off — co-op tells the squad
    this.cooking = false;         // the pin is out and it's in your hand
    this.cookSlot = 'lethal';
    this.cookKind = 'frag';
    this.cookT = 0;
    this.throwT = 0;              // > 0 just after a throw (arm follow-through)
    this.blindT = 0;              // > 0 while YOU are flashbanged
    this.blindDur = 1;
    this.blindPeak = 1;

    this.pools = {};
    for (const kind of Object.keys(TYPES)) {
      this.pools[kind] = [];
      for (let i = 0; i < (kind === 'frag' ? 10 : 6); i++) {
        const m = grenadeModel(kind);
        m.visible = false;
        this.scene.add(m);
        this.pools[kind].push(m);
      }
    }

    // The grenade in your hand (drawn in the viewmodel scene)
    this.hand = new THREE.Group();
    this.held = {};
    for (const kind of Object.keys(TYPES)) this.hand.add((this.held[kind] = grenadeModel(kind)));
    // (sys.glove: the viewmodel's shared glove material, so it matches the glove colour you picked)
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.08), sys.glove || new THREE.MeshStandardMaterial({ color: 0x2f2a22, roughness: 0.9 }));
    glove.position.set(0.012, -0.03, 0.02);
    this.hand.add(glove);
    this.hand.visible = false;
    this.vmScene.add(this.hand);

    // Flashbanged: the whole screen goes white, then fades back. It sits just
    // above the HUD (you can't read your ammo either) but below the menus.
    this.whiteout = document.createElement('div');
    this.whiteout.id = 'whiteout';
    this.whiteout.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none';
    const hud = document.getElementById('hud');
    if (hud) hud.after(this.whiteout); else document.body.appendChild(this.whiteout);
  }

  get count() { return this.counts.lethal; } // (older code reads .count)

  // kit = { lethal: 'frag', tactical: 'smoke', lethalCount: 2, tacticalCount: 1 }
  setKit(kit) {
    const ok = (k, slot) => Object.hasOwn(TYPES, k) && TYPES[k].slot === slot;
    this.kit = { ...kit, lethal: ok(kit.lethal, 'lethal') ? kit.lethal : 'frag', tactical: ok(kit.tactical, 'tactical') ? kit.tactical : 'smoke' };
    this.refill();
  }
  refill() { this.counts = { lethal: this.kit.lethalCount, tactical: this.kit.tacticalCount }; }
  reset() {
    this.refill();
    this.cooking = false;
    this.throwT = 0;
    this.weapons.handsBusy = false;
    this.hand.visible = false;
    for (const g of this.live) g.mesh.visible = false;
    this.live.length = 0;
    this.smokes.length = 0;
    this.world.smokes.length = 0;
    for (const d of this.decoys) d.mesh.visible = false;
    this.decoys.length = 0;
    for (const m of this.mines) m.mesh.visible = false;
    this.mines.length = 0;
    this.blindT = 0;
    this.whiteout.style.opacity = '0';
  }

  // ------------------------------------------------------------------ throwing
  spawn({ origin, vel, fuse, team, shooter = null, remote = false, kind = 'frag' }) {
    if (!Object.hasOwn(TYPES, kind)) kind = 'frag';
    if (TYPES[kind].placed) return this._placeMine({ origin, dir: vel, team, shooter, remote, kind }); // (vel = which way it faces)
    const pool = this.pools[kind];
    const mesh = pool.find((m) => !m.visible) || pool[0];
    mesh.visible = true;
    mesh.position.copy(origin);
    const g = { kind, mesh, pos: origin.clone(), vel: vel.clone(), fuse, team, shooter, age: 0, rest: false, warned: false, remote, boom: false, stuck: null, stuckAt: null, spin: new THREE.Vector3(Math.random() * 20, Math.random() * 20, Math.random() * 20) };
    this.live = this.live.filter((x) => x.mesh !== mesh);
    this.decoys = this.decoys.filter((d) => d.mesh !== mesh);
    this.live.push(g);
    if (!remote) this.onThrow?.({ origin: origin.clone(), vel: vel.clone(), fuse, team, kind });
    return g;
  }

  // A grenade someone else threw (co-op). Same physics here.
  spawnRemote({ origin, vel, fuse, team, shooter = null, kind = 'frag' }) {
    return this.spawn({ origin, vel, fuse, team, shooter, remote: true, kind });
  }

  // Local player input: hold to pull the pin (and cook), release to throw.
  updatePlayer(dt, input, active) {
    const p = this.player, w = this.weapons;
    if (this.throwT > 0) {
      this.throwT -= dt;
      if (this.throwT <= 0) { w.handsBusy = false; this.hand.visible = false; }
    }
    if (!this.cooking && active && p.alive && !p.vault && !p.ladder && this.throwT <= 0) { // (not while both hands are on a ladder)
      const slot = input.wasPressed(KEYS.lethal) ? 'lethal' : input.wasPressed(KEYS.tactical) ? 'tactical' : null;
      if (slot && this.counts[slot] > 0) {
        this.cooking = true;
        this.cookSlot = slot;
        this.cookKind = this.kit[slot];
        this.cookT = 0;
        w.handsBusy = true;
        w.reloadT = -1;          // throwing interrupts a reload
        this.audio.pin();
      }
    }
    if (this.cooking) {
      const T = TYPES[this.cookKind];
      this.cookT += dt;
      if (!p.alive) { this.cooking = false; return; }
      if (T.cook && this.cookT >= T.fuse) { // held it too long: it goes off in your hand
        this.cooking = false;
        this.counts[this.cookSlot]--;
        this.hand.visible = false;
        w.handsBusy = false;
        const at = p.eyePosition.clone();
        if (this.cookKind === 'smoke') at.setY(p.pos.y + 0.1); // the canister drops at your feet
        this._detonate({ kind: this.cookKind, pos: at, team: 'player', shooter: p });
        return;
      }
      if (!input.isDown(KEYS[this.cookSlot]) || !active) { if (T.placed) this._plant(); else this._throw(); }
    }
    this._animateHand(dt);
  }

  // How long until the one in your hand goes off (only for cookable types)
  get cookLeft() { const T = TYPES[this.cookKind]; return T.cook ? Math.max(0, T.fuse - this.cookT) : null; }

  _throw() {
    const p = this.player, cam = this.camera, kind = this.cookKind, T = TYPES[kind];
    this.cooking = false;
    this.counts[this.cookSlot]--;
    cam.getWorldDirection(_fwd);
    _right.setFromMatrixColumn(cam.matrixWorld, 0);
    _up.setFromMatrixColumn(cam.matrixWorld, 1);
    const origin = cam.position.clone().addScaledVector(_fwd, 0.35).addScaledVector(_right, 0.15).addScaledVector(_up, -0.05);
    // aim a little above the crosshair: grenades are lobbed, not fired
    const dir = _fwd.clone().addScaledVector(_up, Math.tan(G.lobAngle)).normalize();
    const speed = G.throwSpeed * (p.prone ? 0.55 : p.crouched ? 0.85 : 1);
    const vel = dir.multiplyScalar(speed).add(_v.set(p.vel.x, 0, p.vel.z).multiplyScalar(0.6));
    // Don't start inside a wall (e.g. throwing point-blank at cover)
    const hit = this.world.raycast(cam.position, _d.subVectors(origin, cam.position).normalize(), cam.position.distanceTo(origin));
    if (hit) origin.copy(hit.point).addScaledVector(hit.normal, 0.08);
    const fuse = T.cook ? T.fuse - this.cookT : T.fuse;
    this.spawn({ origin, vel, fuse, team: 'player', shooter: p, kind });
    this.audio.throwWhoosh();
    this.throwT = 0.35;
  }

  // Viewmodel: grenade raised while cooking, swung forward on the throw
  _animateHand() {
    const h = this.hand;
    for (const [kind, m] of Object.entries(this.held)) m.visible = kind === this.cookKind;
    if (this.cooking) {
      h.visible = true;
      const wob = Math.sin(this.cookT * 3) * 0.004;
      h.position.set(0.16, -0.13 + wob, -0.32);
      h.rotation.set(-0.3, 0.4, 0.2);
    } else if (this.throwT > 0 && TYPES[this.cookKind].placed) { // reaching down to set it on the ground
      const t = 1 - this.throwT / 0.45;
      h.visible = t < 0.6;
      h.position.set(0.12, -0.13 - t * 0.3, -0.32 - t * 0.15);
      h.rotation.set(-0.3 + t * 0.6, 0, 0);
    } else if (this.throwT > 0) {
      const t = 1 - this.throwT / 0.35;
      h.visible = t < 0.5;
      h.position.set(0.16 - t * 0.1, -0.13 + t * 0.15, -0.32 - t * 0.35);
      h.rotation.set(-0.3 - t * 1.4, 0.4, 0.2);
    } else h.visible = false;
  }

  // ------------------------------------------------------------------ physics
  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const g = this.live[i], T = TYPES[g.kind];
      g.age += dt;
      g.fuse -= dt;
      if (g.stuck) { // a sticky riding on a soldier
        g.pos.copy(g.stuck.pos).add(g.stuckAt);
      } else if (!g.rest) {
        const steps = Math.ceil(dt / (1 / 120));
        for (let s = 0; s < steps && !g.rest; s++) this._step(g, dt / steps);
        g.mesh.rotation.x += g.spin.x * dt;
        g.mesh.rotation.y += g.spin.y * dt;
        g.mesh.rotation.z += g.spin.z * dt;
      }
      g.mesh.position.copy(g.pos);
      // Soldiers near where a lethal grenade is coming down run for it (the host's AI only)
      if (T.blast && !g.warned && this.damagesEnemies && (g.rest || g.stuck || g.age > 0.9)) {
        g.warned = true;
        if (g.team === 'player') this.enemies.dodgeGrenade(g.pos, Math.min(8, T.blast.radius * 0.75));
      }
      if (g.fuse <= 0 || g.boom) {
        this.live.splice(i, 1);
        g.mesh.visible = false;
        this._detonate(g);
      }
    }
    this._updateSmoke(dt);
    this._updateDecoys(dt);
    this._updateMines(dt);
    this._updateBlind(dt);
  }

  _step(g, dt) {
    const T = TYPES[g.kind];
    g.vel.y -= 9.81 * dt;
    const len = g.vel.length() * dt;
    if (len < 1e-5) return;
    _d.copy(g.vel).normalize();
    const hit = this.world.raycast(g.pos, _d, len + RADIUS);
    if (!hit) {
      g.pos.addScaledVector(g.vel, dt);
      // Sticky / impact thrown by a player: did it fly into an enemy soldier?
      if ((T.sticks || T.onImpact) && g.team === 'player') {
        const e = this._soldierAt(g.pos);
        if (e && T.sticks) { // it rides along on him until it goes off
          g.stuck = e;
          g.stuckAt = g.pos.clone().sub(e.pos);
          g.rest = true;
          this.audio.grenadeBounce(g.pos);
        } else if (e && g.age >= T.armAfter) { // impact: armed, and it hit him
          g.boom = true;
          g.rest = true;
        }
      }
      return;
    }
    _n.copy(hit.normal);
    const vn = g.vel.dot(_n);
    if (T.sticks) { // stops dead wherever it touches
      g.pos.copy(hit.point).addScaledVector(_n, RADIUS * 0.6);
      g.vel.set(0, 0, 0);
      g.rest = true;
      this.audio.grenadeBounce(hit.point);
      return;
    }
    if (T.onImpact && g.age >= T.armAfter) { // armed: goes off on the hit
      g.pos.copy(hit.point).addScaledVector(_n, 0.06);
      g.boom = true;
      g.rest = true;
      return;
    }
    // Bounce: split velocity into "into the surface" and "along it"
    if (vn < -2.5) this.audio.grenadeBounce(hit.point);
    g.vel.addScaledVector(_n, -vn).multiplyScalar(G.friction).addScaledVector(_n, -vn * G.bounce);
    g.pos.copy(hit.point).addScaledVector(_n, RADIUS + 0.002);
    g.spin.multiplyScalar(0.6);
    if (_n.y > 0.6 && g.vel.length() < 0.5) { g.rest = true; g.vel.set(0, 0, 0); }
  }

  // The enemy soldier whose body (a rough upright cylinder) contains `pos`, if any.
  // On co-op friends these are the puppets, so a sticky looks right there too.
  _soldierAt(pos) {
    for (const e of this.enemies.enemies) {
      if (!e.alive) continue;
      const dy = pos.y - e.pos.y;
      if (dy < 0.1 || dy > 1.75) continue;
      if ((pos.x - e.pos.x) ** 2 + (pos.z - e.pos.z) ** 2 < 0.36 * 0.36) return e;
    }
    return null;
  }

  // The fuse ran out (or it hit something, or you held it too long)
  _detonate(g) {
    if (g.kind === 'smoke') this._popSmoke(g);
    else if (g.kind === 'flash') this._flashbang(g);
    else if (g.kind === 'decoy') this._startDecoy(g);
    else this.explode(g);
  }

  // ------------------------------------------------------------------ smoke
  _popSmoke(g) {
    const s = { pos: g.pos.clone(), t: 0, emit: 0, zone: { pos: g.pos.clone().setY(g.pos.y + 1.2), r: 0 } };
    this.smokes.push(s);
    this.world.smokes.push(s.zone);
    this.audio.smokePop?.(g.pos);
  }

  _updateSmoke(dt) {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.t += dt;
      // the cloud grows, holds, then thins out
      const grow = Math.min(1, s.t / SMOKE.grow), fade = Math.min(1, (SMOKE.duration - s.t) / 5);
      s.zone.r = SMOKE.radius * grow * Math.max(0, fade);
      // keep pouring smoke while the canister burns (~22 s)
      if (s.t < SMOKE.duration - 8) {
        s.emit += dt * (s.t < 3 ? 34 : 11);
        while (s.emit >= 1) { s.emit--; this.effects.smokePuff(s.pos, SMOKE.radius * grow); }
      }
      if (s.t >= SMOKE.duration) {
        this.smokes.splice(i, 1);
        this.world.smokes.splice(this.world.smokes.indexOf(s.zone), 1);
      }
    }
  }

  // ------------------------------------------------------------------ flashbang
  // A real stun grenade (like the M84) has no shrapnel. Its magnesium charge
  // makes a flash of millions of candela and a ~170 dB bang. What it does to
  // you depends on whether your eyes could SEE it (line of sight), how close
  // it was and how directly you were looking at it.
  _flashbang(g) {
    const pos = _p.copy(g.pos).setY(g.pos.y + 0.15);
    this.effects.flashbang?.(pos);
    this.audio.flashbang?.(pos);
    this.onExplode?.(pos.clone());  // the AI hears it
    // Enemies (host / solo only): each one works out how badly from its own facing
    if (this.damagesEnemies) {
      for (const e of this.enemies.enemies) {
        if (!e.alive || !e.flash) continue;
        const eye = _v.set(e.pos.x, e.pos.y + (e.eyeHeight ?? 1.6), e.pos.z);
        const d = eye.distanceTo(pos);
        if (d > FLASH.range || !this.world.lineOfSight(pos, eye)) continue;
        e.flash(pos, 1 - d / FLASH.range);
      }
    }
    // You (every computer handles its own player). The thrower too: look away!
    const p = this.player;
    if (!p.alive) return;
    const eye = p.eyePosition, d = eye.distanceTo(pos);
    if (d > FLASH.range || !this.world.lineOfSight(pos, eye)) return;
    this.camera.getWorldDirection(_fwd);
    const look = _fwd.dot(_d.subVectors(pos, eye).normalize()); // 1 = staring right at it, -1 = back turned
    const facing = THREE.MathUtils.smoothstep(look, -0.3, 0.85);
    let blind = FLASH.blindMax * (1 - d / FLASH.range) * (0.12 + 0.88 * facing);
    if (d < FLASH.close) blind = Math.max(blind, 1.6);  // that close it fills your vision whichever way you look
    if (blind < 0.3) return;
    this.blindDur = this.blindT = Math.max(this.blindT, blind);
    this.blindPeak = Math.min(1, 0.35 + blind / 2.5);
    p.shake?.(0.4);
  }

  _updateBlind(dt) {
    if (this.blindT <= 0) return;
    this.blindT = Math.max(0, this.blindT - dt);
    // solid white for the first ~40%, then your eyes slowly recover
    const a = this.blindPeak * Math.min(1, this.blindT / (this.blindDur * 0.6));
    this.whiteout.style.opacity = a.toFixed(3);
  }

  // ------------------------------------------------------------------ decoy
  _startDecoy(g) {
    g.mesh.visible = true; // it's still lying there, rattling away
    g.mesh.position.copy(g.pos);
    this.decoys.push({ pos: g.pos.clone(), t: 0, next: 0.2, burst: 0, mesh: g.mesh });
  }

  // Bursts of 1-4 "shots" with random pauses, like someone firing from cover.
  _updateDecoys(dt) {
    for (let i = this.decoys.length - 1; i >= 0; i--) {
      const d = this.decoys[i];
      d.t += dt;
      d.next -= dt;
      if (d.next <= 0 && d.t < DECOY.duration) {
        if (d.burst <= 0) d.burst = 1 + Math.floor(Math.random() * 4);
        this.audio.gunshot(d.pos, 'rifle', false, false);
        this.effects.flashLight(_v.copy(d.pos).setY(d.pos.y + 0.2), 4); // little firecracker pops
        if (this.damagesEnemies) this.enemies.hearNoise(d.pos, DECOY.heard, 'gunshot');
        d.burst--;
        d.next = d.burst > 0 ? 0.08 + Math.random() * 0.05 : 0.6 + Math.random() * 1.8;
      }
      if (d.t >= DECOY.duration + 1) {
        d.mesh.visible = false;
        this.decoys.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------------ claymores
  // Plant one ~0.7 m in front of your feet, on the ground, facing where you look.
  _plant() {
    const p = this.player;
    this.cooking = false;
    this.counts[this.cookSlot]--;
    this.camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    const feet = _p.copy(p.pos).setY(p.pos.y + 0.3);
    const wall = this.world.raycast(feet, _fwd, 0.85); // not through a wall you're standing against
    const spot = feet.clone().addScaledVector(_fwd, wall ? Math.max(0, wall.dist - 0.15) : 0.7);
    const ground = this.world.raycast(spot.setY(spot.y + 0.3), _d.set(0, -1, 0), 2.5);
    const at = ground ? ground.point : p.pos.clone();
    this._placeMine({ origin: at, dir: _fwd, team: 'player', shooter: p, remote: false, kind: this.cookKind });
    this.audio.reload('cloth');
    this.throwT = 0.45;
  }

  _placeMine({ origin, dir, team, shooter, remote, kind }) {
    const pool = this.pools[kind];
    let mesh = pool.find((m) => !m.visible);
    if (!mesh) { // too many out: the oldest one is taken back
      const old = this.mines.shift();
      mesh = old ? old.mesh : pool[0];
    }
    const fwd = new THREE.Vector3(dir.x, 0, dir.z);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const m = { kind, mesh, pos: origin.clone(), dir: fwd, team, shooter, age: 0, trig: -1, remote };
    mesh.position.copy(m.pos);
    mesh.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0); // same yaw convention as the camera
    mesh.visible = true;
    this.mines.push(m);
    if (!remote) this.onThrow?.({ origin: m.pos.clone(), vel: fwd.clone(), fuse: 0, team, kind });
    return m;
  }

  _updateMines(dt) {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      m.age += dt;
      if (m.trig >= 0) { // tripped: a split second, then it fires
        if ((m.trig -= dt) <= 0) {
          this.mines.splice(i, 1);
          this._fireClaymore(m);
          this.onMineFired?.(m.pos);
        }
        continue;
      }
      // Only the host (or solo) decides when one is tripped: it knows where
      // the enemies really are. It then tells the squad (coop.js 'mx').
      if (!this.damagesEnemies || m.team !== 'player' || m.age < CLAYMORE.arm) continue;
      if (this._tripped(m)) { m.trig = CLAYMORE.delay; this.audio.grenadeBounce(m.pos); }
    }
  }

  // Is an enemy in the zone in front of it? (Only enemies: your squad knows
  // where its own claymores are.)
  _tripped(m) {
    for (const e of this.enemies.enemies) {
      if (!e.alive) continue;
      _v.set(e.pos.x - m.pos.x, 0, e.pos.z - m.pos.z);
      const h = _v.length();
      if (h > CLAYMORE.sense || h < 0.05 || Math.abs(e.pos.y - m.pos.y) > 1.5) continue;
      if (_v.dot(m.dir) / h < CLAYMORE.senseCos) continue; // beside or behind it
      if (!this.world.lineOfSight(_p.copy(m.pos).setY(m.pos.y + 0.2), _v.set(e.pos.x, e.pos.y + 0.6, e.pos.z))) continue;
      return true;
    }
    return false;
  }

  // Co-op friends: the host says the claymore at `pos` went off
  mineFiredAt(pos) {
    let best = null, bestD = 1;
    for (const m of this.mines) { const d = m.pos.distanceTo(pos); if (d < bestD) { bestD = d; best = m; } }
    if (!best) return;
    this.mines.splice(this.mines.indexOf(best), 1);
    this._fireClaymore(best);
  }

  _fireClaymore(m) {
    m.mesh.visible = false;
    const origin = _p.copy(m.pos).setY(m.pos.y + 0.12);
    this.effects.claymore?.(origin, m.dir, m.pos);
    this.audio.explosion(m.pos);
    this.onExplode?.(m.pos.clone());
    // Enemies (host / solo only)
    if (this.damagesEnemies && m.team === 'player') {
      for (const e of this.enemies.enemies) {
        if (!e.alive) continue;
        const chest = _v.set(e.pos.x, e.pos.y + 1.0, e.pos.z);
        if (chest.distanceTo(origin) < 25) e.suppress?.(1);
        const dmg = this._claymoreDamage(m, origin, chest);
        if (dmg > 0) e.onBulletHit({ damage: dmg, zone: 'torso', headMul: 1, limbMul: 1, point: chest.clone(), dir: chest.clone().sub(origin).normalize(), explosive: true, from: origin.clone(), shooter: m.shooter });
      }
    }
    // You (every computer only hurts its own player). Standing in front of your own claymore is a bad idea.
    const p = this.player;
    if (p.alive) {
      const chest = _v.set(p.pos.x, p.pos.y + p.height * 0.55, p.pos.z);
      const d = chest.distanceTo(origin);
      const armour = p.kit?.armor?.blast ?? 1;
      const dmg = this._claymoreDamage(m, origin, chest) * (p.prone ? 0.5 : 1) * armour; // the fan mostly flies over a prone body
      if (dmg > 0) p.takeDamage(dmg, origin.clone());
      p.shake?.(Math.max(0, 1.2 - d / 25));
    }
  }

  // The steel balls fly out in a fan in front: deadly well out to ~10 m.
  // Behind and beside it only the blast itself is dangerous, and only close up.
  _claymoreDamage(m, from, to) {
    _d.subVectors(to, from);
    const d = _d.length(), h = Math.hypot(_d.x, _d.z);
    const ahead = h > 0.01 ? (_d.x * m.dir.x + _d.z * m.dir.z) / h : 1;
    let dmg = 0;
    // in the fan: within its width, and not far above or below it (it's ~2 m tall at 10 m)
    if (ahead >= CLAYMORE.arcCos && d < CLAYMORE.range && Math.abs(_d.y) < 0.3 * h + 1.2) dmg = CLAYMORE.damage * Math.pow(1 - d / CLAYMORE.range, 1.3);
    if (d < CLAYMORE.back) dmg = Math.max(dmg, CLAYMORE.backDamage * Math.pow(1 - d / CLAYMORE.back, 1.5));
    if (dmg <= 0 || !this.world.lineOfSight(from, to)) return 0;
    return dmg;
  }

  // ------------------------------------------------------------------ boom
  explode(g) {
    const pos = g.pos, B = (TYPES[g.kind] || TYPES.frag).blast || TYPES.frag.blast;
    // Find the ground/wall normal under the blast for the scorch mark
    const down = this.world.raycast(_p.copy(pos).setY(pos.y + 0.3), _d.set(0, -1, 0), 1.5);
    this.effects.explosion(pos, down ? down.normal : _n.set(0, 1, 0), down ? down.point : pos);
    this.audio.explosion(pos);
    this.onExplode?.(pos);
    const origin = _p.copy(pos).setY(pos.y + 0.25);

    // Enemies (host / solo only)
    if (this.damagesEnemies && g.team === 'player') {
      for (const e of this.enemies.enemies) {
        if (!e.alive) continue;
        const chest = _v.set(e.pos.x, e.pos.y + 1.0, e.pos.z);
        const d = e === g.stuck ? 0 : chest.distanceTo(origin); // a sticky ON you is the worst place to be
        if (d > B.radius + 6) continue;
        e.suppress?.(1);
        const dmg = e === g.stuck ? B.damage : this._damageAt(d, origin, chest, B);
        if (dmg > 0) e.onBulletHit({ damage: dmg, zone: 'torso', headMul: 1, limbMul: 1, point: chest.clone(), dir: chest.clone().sub(origin).normalize(), explosive: true, from: origin.clone(), shooter: g.shooter });
      }
    }
    // You (every computer only hurts its own player)
    const p = this.player;
    if (p.alive) {
      const chest = _v.set(p.pos.x, p.pos.y + p.height * 0.55, p.pos.z);
      const d = chest.distanceTo(origin);
      const diff = g.team === 'enemy' ? (this.enemies.difficulty?.damage ?? 1) : 1; // enemy grenades follow the difficulty setting
      const armour = p.kit?.armor?.blast ?? 1; // plates stop some fragments
      const dmg = this._damageAt(d, origin, chest, B) * (p.prone ? 0.6 : 1) * diff * armour; // lying flat: fragments fly over you
      if (dmg > 0) p.takeDamage(dmg, origin.clone());
      p.shake?.(Math.max(0, 1.2 - d / 25));
    }
  }

  // Falls off steeply with distance; zero if something solid is in between.
  _damageAt(d, from, to, B = TYPES.frag.blast) {
    if (d >= B.radius) return 0;
    if (!this.world.lineOfSight(from, to)) return 0;
    return B.damage * Math.pow(1 - d / B.radius, 1.8);
  }

  // Live lethal grenades near you, for the HUD warning icon
  near(pos, range = 10) { return this.live.filter((g) => TYPES[g.kind].blast && g.pos.distanceTo(pos) < range); }
}

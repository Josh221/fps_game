// =============================================================================
// teammate.js — another player in your squad, drawn as a friendly soldier.
//
// Their computer sends their state 20 times a second. We blend between those
// updates (see Interpolator in net.js) and drive the same skinned soldier the
// enemies use, in a different uniform. The HUD draws a name tag over them.
//
// They carry the guns from their loadout and wear their own look (avatar.js):
// the lobby's room state tells us their kit (setKit), and each update says
// which gun is in their hands.
//
// On the HOST, a Teammate is also something the enemy AI can see and shoot
// at. It has the same fields the AI reads from the local Player: pos,
// eyePosition, height, crouched, horizontalSpeed and alive. So enemy.js
// doesn't care whether a target is you or a friend.
// =============================================================================
import * as THREE from 'three';
import { Interpolator, LERP, ANGLE, STEP, r2, r3 } from './net.js';
import { PLAYER, NET } from './config.js';
import { buildGun } from './gunsmith.js';
import { buildWeapon, decodeWeapons } from './loadout.js';
import { decodeAvatar } from './avatar.js';

// A player's state on the wire. One flat array keeps messages small:
//   [x, y, z, yaw, pitch, crouch, speed, ads, alive, health, deployed, prone, slot, lean, climb]
// slot: 0 = primary, 1 = sidearm in hand
// lean: -1 (Q, left) .. 1 (E, right)
// climb: 0..1 on a ladder (climbing pose, gun slung)
const MODES = [LERP, LERP, LERP, ANGLE, LERP, LERP, LERP, LERP, STEP, STEP, STEP, LERP, STEP, LERP, LERP];

export function packPlayer(p, deployed) {
  return [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r3(p.yaw), r3(p.pitch), r2(p.crouchT), r2(p.horizontalSpeed),
    r2(p.adsFactor), p.alive ? 1 : 0, Math.max(0, Math.round(p.health)), deployed ? 1 : 0, r2(p.proneT || 0), p.weaponSlot ? 1 : 0,
    r2(p.lean || 0), r2(p.climbT || 0)];
}

export class Teammate {
  constructor({ scene, factory, audio, id, name, clock }) {
    Object.assign(this, { scene, factory, audio, id, name, clock });
    this.body = factory.create({ tint: NET.friendlyTint });
    this.root = this.body.root;
    this.root.visible = false; // until they deploy
    scene.add(this.root);
    this.interp = new Interpolator(MODES);

    // What the AI sees: the NEWEST update, not the blended one we draw. The AI
    // aims where you are now, not where you were 100 ms ago.
    this.pos = new THREE.Vector3();
    this.alive = false;
    this.deployed = false;
    this.crouched = false;
    this.prone = false;
    this.height = PLAYER.standHeight;
    this.horizontalSpeed = 0;
    this.health = 100;
    this._eye = new THREE.Vector3();

    // Drawing state
    this.shown = false;      // deployed, in the blended (drawn) state
    this.shownAlive = false;
    this.crouchShown = 0;
    this.proneShown = 0;
    this.deathT = -1;
    this.aiming = 0.4;
    this.walkPhase = 0;
    this.lastShot = -99;
    this.time = 0;
    this.kitW = '';     // their guns as text (loadout.js encodeWeapons)
    this.kitA = '';     // their look as text (avatar.js encodeAvatar)
    this.guns = null;   // { primary, secondary } models, or null = the default rifle
  }

  // Their kit from the room state: build the two guns they carry and put on
  // their look (each only when it changes)
  setKit(kit) {
    const a = typeof kit?.a === 'string' ? kit.a : '';
    if (a !== this.kitA) {
      this.kitA = a;
      this.body.setAvatar(decodeAvatar(a)); // (no look sent = the plain friendly uniform)
    }
    const w = typeof kit?.w === 'string' ? kit.w : '';
    if (w === this.kitW) return;
    this.kitW = w;
    this._disposeGuns();
    const lo = decodeWeapons(w);
    if (lo) this.guns = { primary: this._makeGun(lo.primary), secondary: this._makeGun(lo.secondary) };
    this.body.setGun(this.guns?.primary || this.body.defaultGun);
  }

  _makeGun(w) {
    const cfg = buildWeapon(w);
    const gun = buildGun(this.factory.M, cfg, { hands: false });
    gun.group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    gun.kind = cfg.base === 'pistol' ? 'pistol' : 'long';
    return gun;
  }

  _disposeGuns() {
    for (const g of Object.values(this.guns || {})) g.group.traverse((o) => o.geometry?.dispose());
    this.guns = null;
  }

  get eyePosition() { return this._eye.set(this.pos.x, this.pos.y + (this.prone ? PLAYER.proneEye : this.crouched ? PLAYER.crouchEye : PLAYER.standEye), this.pos.z); }

  // A network update. t is the sender's clock; s is packPlayer()'s array.
  push(t, s) {
    this.interp.push(t, s);
    this.pos.set(s[0], s[1], s[2]);
    this.crouched = s[5] > 0.5;
    this.prone = (s[11] || 0) > 0.5;
    this.height = this.prone ? PLAYER.proneHeight : this.crouched ? PLAYER.crouchHeight : PLAYER.standHeight;
    this.horizontalSpeed = s[6];
    this.health = s[9];
    this.deployed = s[10] === 1;
    this.alive = s[8] === 1 && this.deployed;
  }

  get latest() { return this.interp.latest; }

  // Called when this player fires: shoulder the rifle for a moment.
  fired() { this.lastShot = this.time; }

  muzzleWorld(out) { return this.body.muzzleWorld(out); }

  update(dt) {
    this.time += dt;
    const s = this.interp.sample(this.clock.now() - NET.interpDelay);
    this.shown = !!s && s[10] === 1;
    this.root.visible = this.shown;
    if (!this.shown) return;

    const alive = s[8] === 1;
    if (alive && !this.shownAlive) { this.deathT = -1; this.root.rotation.x = 0; } // (re)deployed
    if (!alive && this.shownAlive) this.deathT = 0;                                  // just went down
    this.shownAlive = alive;
    if (!alive) this.deathT = Math.min(1, Math.max(0, this.deathT) + dt * 1.6);

    // On a ladder: hands and feet move one rung (30 cm) per half cycle of the climbing pose
    const climb = alive ? s[14] || 0 : 0; // (older clients send no climb value -> 0)
    this.climbPhase = (this.climbPhase || 0) + (Math.abs(s[1] - this.root.position.y) * Math.PI) / 0.3;
    this.root.position.set(s[0], s[1], s[2]);
    this.root.rotation.y = s[3];
    const speed = alive ? s[6] : 0;
    this.crouchShown = s[5];
    this.proneShown = s[11] || 0;

    // The gun in their hands; a bipod folds down when they lie prone
    if (this.guns) {
      const gun = s[12] === 1 ? this.guns.secondary : this.guns.primary;
      this.body.setGun(gun);
      if (gun.bipod) for (const leg of gun.bipod.children.slice(1)) leg.rotation.x = -1.35 * Math.min(1, this.proneShown * 1.2);
    }

    // Rifle shouldered when aiming or just fired, at the ready otherwise, lowered when sprinting
    const want = Math.max(s[7], this.time - this.lastShot < 1.2 ? 1 : 0, speed > 4.5 ? 0 : 0.4);
    this.aiming += (want - this.aiming) * Math.min(1, dt * 8);

    // Footsteps you can hear (same rhythm as the enemies)
    const before = Math.floor(this.walkPhase / Math.PI);
    this.walkPhase += (speed * dt * Math.PI) / 0.8;
    if (Math.floor(this.walkPhase / Math.PI) !== before && speed > 0.5) this.audio.enemyFootstep(this.root.position, speed > 3 ? 1 : 0.5);

    this.body.animate(dt, {
      speed, crouch: s[5], prone: s[11] || 0, aimPitch: s[4], aiming: alive ? this.aiming : 0,
      lean: alive ? s[13] || 0 : 0, // (an older client sends no lean: s[13] is undefined/NaN -> 0)
      deathT: alive ? -1 : this.deathT, flinch: 0,
      climb, climbPhase: this.climbPhase,
    });
  }

  dispose() { this.scene.remove(this.root); this._disposeGuns(); this.body.setAvatar(null); }
}

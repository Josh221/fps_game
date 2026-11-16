// =============================================================================
// viewmodel.js — the weapon and hands you see in first person.
//
// FPS games draw the gun in a SEPARATE pass with its own camera and a cleared
// depth buffer, so the barrel never pokes through walls. Everything that makes
// a gun feel alive — sway, bob, recoil, reload, working the bolt — is
// procedural animation: springs and sine waves layered on top of a base pose.
//
// The guns themselves are built by gunsmith.js from your loadout (base gun +
// attachments), so every optic and muzzle device you pick shows up here.
//
// YOUR ARMS are a whole soldier (character.js), the same model, sleeves and
// gloves your squad sees, standing with his right eye exactly on the camera.
// His head is folded away (you're inside it). Every frame, after the gun has
// swayed, bobbed and kicked, inverse kinematics puts his hands back on it:
// the firing hand round the pistol grip, the support hand under the handguard
// (or on the magazine during a reload, or the bolt handle while you cycle a
// bolt-action), fingers curled round. Because the body has real proportions,
// the gun ends up exactly as big as it would look in your own hands.
// =============================================================================
import * as THREE from 'three';
import { makeFlashTexture } from './textures.js';
import { buildGun } from './gunsmith.js';
import { buildWeapon } from './loadout.js';
import { GRIPS, placeHand } from './character.js';

const lerp = (a, b, t) => a + (b - a) * t;
const _grip = new THREE.Vector3(), _fore = new THREE.Vector3(), _hold = new THREE.Vector3(), _gq = new THREE.Quaternion();
const _pole = new THREE.Vector3(), _sh = new THREE.Vector3();
// How the body stands behind the gun: turned a little side-on (left shoulder
// forward, the way people stand to shoot) and leaning into it
const STANCE_YAW = -0.42, STANCE_FWD = 0.06;
const ease = (t) => t * t * (3 - 2 * t);
const smooth = (e0, e1, x) => ease(Math.min(1, Math.max(0, (x - e0) / (e1 - e0))));

// Critically damped spring: snaps back to 0 without wobbling forever.
class Spring {
  constructor(k = 320) { this.k = k; this.c = 2 * Math.sqrt(k); this.x = 0; this.v = 0; }
  update(dt) { this.v += (-this.k * this.x - this.c * this.v) * dt; this.x += this.v * dt; return this.x; }
}

export class ViewModel {
  constructor(M) {
    this.M = M;
    this.scene = new THREE.Scene();
    this.baseFov = 64;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 0.01, 10);
    this.scene.add(new THREE.HemisphereLight(0xcfd8e0, 0x5a4a38, 0.9));
    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    this.scene.add(this.sun, this.sun.target);
    this.flashLight = new THREE.PointLight(0xffa850, 0, 2, 2);
    this.scene.add(this.flashLight);
    this.flashTex = makeFlashTexture();
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.models = {};
    this.current = null;
    this.currentSlot = 'primary';
    this.setLoadout({ primary: buildWeapon({ id: 'rifle' }), secondary: buildWeapon({ id: 'pistol' }) });

    this.kickBack = new Spring(260);
    this.kickPitch = new Spring(220);
    this.kickRoll = new Spring(200);
    this.swayX = 0; this.swayY = 0;
    this.flashT = 0;
    this.time = 0;
    this.bipodOut = 0;
    this._q = new THREE.Quaternion();
  }

  // Rebuild both guns from built weapon configs { primary, secondary }
  setLoadout(cfgs) {
    for (const m of Object.values(this.models)) this.root.remove(m.group);
    this.models = {};
    for (const [slot, cfg] of Object.entries(cfgs)) {
      const m = buildGun(this.M, cfg, { hands: false, flashTex: this.flashTex }); // (the hands are the soldier's own: see attachArms)
      m.group.visible = false;
      this.root.add(m.group);
      this.models[slot] = m;
      // Where the magazine is, in its own space (its group's origin isn't on it):
      // the support hand reaches here during a reload
      m.mag.updateMatrixWorld(true);
      const inv = m.mag.matrixWorld.clone().invert(), box = new THREE.Box3();
      m.mag.traverse((o) => { if (o.isMesh) { o.geometry.computeBoundingBox(); box.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld))); } });
      m.magCenter = box.isEmpty() ? new THREE.Vector3() : new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y + (box.max.y - box.min.y) * 0.4, (box.min.z + box.max.z) / 2);
    }
    this.current = null;
    this.setWeapon(this.models[this.currentSlot] ? this.currentSlot : 'primary');
  }

  setWeapon(slot) {
    if (!this.models[slot]) slot = 'primary';
    for (const [k, m] of Object.entries(this.models)) m.group.visible = k === slot; // (the shader warm-up shows them all)
    this.currentSlot = slot;
    this.current = this.models[slot];
    this.current.group.visible = true;
  }

  setAspect(a) { this.camera.aspect = a; this.camera.updateProjectionMatrix(); }

  // ------------------------------------------------------------------ arms
  // factory = character.js SoldierFactory; avatar = your look (avatar.js)
  attachArms(factory, avatar) {
    this.arms = factory.create({ avatar });
    this.arms.gunHolder.visible = false; // he holds OUR gun, not his own
    this.scene.add(this.arms.root);
    this._standArms();
  }

  // A new look (it can be another soldier model, which rebuilds the bones)
  dressArms(avatar) {
    if (!this.arms) return;
    this.arms.setAvatar(avatar);
    this._standArms();
  }

  _standArms() {
    const b = this.arms, rig = b.rig;
    for (const [n, a] of Object.entries(b.actions)) { a.setEffectiveWeight(n === 'idle' ? 1 : 0); a.time = 0; }
    b.mixer.update(0); // the clips' standing pose; from here on we move the arms ourselves
    b.bones.Bip01_Head.scale.setScalar(0.001); // the camera is inside his head: fold it away
    for (const n of ['Bip01_L_Thigh', 'Bip01_R_Thigh']) b.bones[n].scale.setScalar(0.001); // (never in view)
    b.root.rotation.set(0, STANCE_YAW, 0);
    const eye = rig.eye.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), STANCE_YAW);
    b.root.position.copy(eye).negate().add(new THREE.Vector3(0, 0, -STANCE_FWD)); // right eye on the camera
    b.root.updateMatrixWorld(true);
    this._shoulders = ['Right', 'Left'].map((sd) => b.bones[`Bip01_${sd[0]}_UpperArm`].getWorldPosition(new THREE.Vector3()));
  }

  // Hands on the gun, wherever the gun is this frame
  _poseArms(s) {
    const b = this.arms, rig = b.rig, m = this.current, g = m.group;
    for (const n in rig.idleArm) b.bones[n].quaternion.copy(rig.idleArm[n]);
    b.root.updateMatrixWorld(true);
    g.updateMatrixWorld(true);
    g.getWorldQuaternion(_gq);
    g.localToWorld(_grip.copy(m.grip));
    g.localToWorld(_fore.copy(m.fore));
    const pistol = m.cfg.base === 'pistol', vgrip = m.fore.y - m.grip.y < -0.06 && !pistol;
    // Firing hand: on the grip, or on the bolt handle while working a bolt-action
    _hold.copy(_grip);
    let k = 0;
    if (m.bolt && s.bolt >= 0) {
      k = Math.sin(Math.min(1, s.bolt) * Math.PI);
      _hold.lerp(m.bolt.getWorldPosition(_sh), k);
    }
    _pole.copy(this._shoulders[0]).add(_sh.set(0.35, -0.55, 0.25));
    placeHand(b.bones, rig.hands, 'Right', _hold, GRIPS.trigger, _gq, _pole);
    // Support hand: on the handguard (or foregrip, or cupping a pistol); during
    // a reload it goes down to the magazine, rides it out and back in
    let r = 0;
    if (s.reload >= 0) { const p = s.reload; r = smooth(0.08, 0.2, p) * (1 - smooth(0.62, 0.78, p)); }
    _hold.copy(_fore);
    if (r > 0) _hold.lerp(m.mag.localToWorld(_sh.copy(m.magCenter)), r);
    _pole.copy(this._shoulders[1]).add(_sh.set(-0.2, -0.65, 0.05));
    placeHand(b.bones, rig.hands, 'Left', _hold, pistol ? GRIPS.cup : vgrip ? GRIPS.vgrip : GRIPS.handguard, _gq, _pole);
  }

  // Recoil "feel" scales with the gun's real recoil numbers
  fireKick(ads, cfg) {
    const k = (ads > 0.5 ? 0.55 : 1) * (this.bipodOut > 0.5 ? 0.35 : 1);
    const pistol = cfg.base === 'pistol';
    const r = Math.min(2.5, cfg.recoilPitch / 0.0105);
    this.kickBack.v += (pistol ? 0.9 : 1.2 + r * 0.4) * k;
    this.kickPitch.v += (pistol ? 9 : 2.2 + r * 1.5) * k;
    this.kickRoll.v += (Math.random() - 0.5) * 4 * k;
    const f = this.current.flash;
    f.visible = true;
    f.rotation.z = Math.random() * Math.PI;
    f.userData.base ??= f.scale.x;
    f.scale.setScalar(f.userData.base * (0.8 + Math.random() * 0.5));
    this.flashT = 0.035;
    this.flashLight.position.copy(this.current.muzzle.position).applyMatrix4(this.current.group.matrix);
    this.flashLight.intensity = cfg.suppressed ? 0.4 : 3;
  }

  // Convert a point on the gun to world space (the viewmodel camera sits at
  // the origin of its scene, so gun-scene coords == main-camera local coords).
  toWorld(obj, mainCamera, out) {
    this.root.updateMatrixWorld(true);
    obj.getWorldPosition(out);
    return mainCamera.localToWorld(out);
  }
  muzzleWorld(cam, out) { return this.toWorld(this.current.muzzle, cam, out); }
  ejectWorld(cam, out) { return this.toWorld(this.current.eject, cam, out); }

  // s = { ads, speed, sprint, onGround, bobPhase, lookDX, lookDY, reload, reloadEmpty, switchT,
  //       steady, lower, prone, bolt (0..1 working the bolt, -1 none), bipod (0..1), sunDir, mainCamera }
  update(dt, s) {
    this.time += dt;
    const m = this.current, g = m.group;
    const a = ease(s.ads);
    const pos = new THREE.Vector3().lerpVectors(m.hip, m.ads, a);
    const rot = new THREE.Euler(0, 0, 0);

    // Mouse sway: the gun lags behind your view a little (inertia)
    const swayMul = 1 - a * 0.7;
    this.swayX = lerp(this.swayX, THREE.MathUtils.clamp(-s.lookDX * 0.0004, -0.06, 0.06), Math.min(1, dt * 9));
    this.swayY = lerp(this.swayY, THREE.MathUtils.clamp(s.lookDY * 0.0004, -0.06, 0.06), Math.min(1, dt * 9));
    rot.y += this.swayX * 1.4 * swayMul;
    rot.x += this.swayY * 1.4 * swayMul;
    pos.x += this.swayX * 0.25 * swayMul;

    // Breathing (reduced when holding breath = steady)
    const breath = (1 - a * 0.6) * (1 - s.steady * 0.9);
    pos.y += Math.sin(this.time * 1.7) * 0.0018 * breath;
    rot.x += Math.sin(this.time * 1.7 + 0.6) * 0.004 * breath;
    rot.y += Math.sin(this.time * 0.9) * 0.003 * breath;

    // Walk bob: figure-8 synced to footsteps
    const amp = Math.min(1, s.speed / 6) * (s.onGround ? 1 : 0.2) * (1 - a * 0.85);
    pos.x += Math.sin(s.bobPhase) * 0.012 * amp;
    pos.y -= Math.abs(Math.cos(s.bobPhase)) * 0.014 * amp;
    rot.z += Math.sin(s.bobPhase) * 0.02 * amp;

    // Sprint pose: rifle swung across the chest, muzzle down
    const sp = ease(s.sprint);
    pos.x += 0.03 * sp; pos.y -= 0.05 * sp; pos.z += 0.03 * sp;
    rot.x -= 0.35 * sp; rot.y += 0.75 * sp; rot.z += 0.3 * sp;

    // Recoil springs
    pos.z += this.kickBack.update(dt) * 0.03;
    rot.x += this.kickPitch.update(dt) * 0.01;
    rot.z += this.kickRoll.update(dt) * 0.01;

    // Reload: tilt the gun, drop the mag, insert a fresh one
    if (m.magRest === undefined) m.magRest = m.mag.position.y;
    m.mag.position.y = m.magRest;
    if (s.reload >= 0) {
      const p = s.reload;
      const tilt = smooth(0, 0.15, p) * (1 - smooth(0.85, 1, p));
      rot.z += 0.5 * tilt; rot.x += 0.18 * tilt; pos.y -= 0.035 * tilt; pos.x -= 0.02 * tilt;
      const out = smooth(0.15, 0.32, p) * (1 - smooth(0.38, 0.58, p));
      m.mag.position.y -= out * 0.28;
      if (p > 0.58 && p < 0.66) pos.y += Math.sin(((p - 0.58) / 0.08) * Math.PI) * 0.01; // seat it
      if (s.reloadEmpty && p > 0.74 && p < 0.84) rot.x += Math.sin(((p - 0.74) / 0.1) * Math.PI) * 0.05; // bolt release
    }

    // Bolt-action: lift the handle, pull it back, push it forward, lock it down
    if (m.bolt) {
      const b = s.bolt ?? -1;
      const lift = b >= 0 ? smooth(0, 0.2, b) * (1 - smooth(0.75, 0.95, b)) : 0;
      const pull = b >= 0 ? smooth(0.2, 0.42, b) * (1 - smooth(0.5, 0.72, b)) : 0;
      m.bolt.rotation.z = lift * 1.2;
      m.bolt.userData.z0 ??= m.bolt.position.z;
      m.bolt.position.z = m.bolt.userData.z0 + pull * 0.09;
      if (b >= 0) rot.z -= 0.12 * Math.sin(b * Math.PI); // cant the rifle while cycling
    }

    // Bipod legs swing down when deployed
    this.bipodOut = lerp(this.bipodOut, s.bipod || 0, Math.min(1, dt * 8));
    if (m.bipod) for (const leg of m.bipod.children.slice(1)) leg.rotation.x = -this.bipodOut * 1.35;

    // Hands busy (crawling, vaulting, getting down, throwing): rifle tipped down and in
    const low = ease(Math.min(1, s.lower || 0));
    pos.y -= 0.13 * low; pos.x -= 0.03 * low; pos.z += 0.04 * low;
    rot.x -= 0.55 * low; rot.y += 0.35 * low; rot.z += 0.5 * low;
    pos.y -= 0.015 * (s.prone || 0); // prone: resting on the forearms

    // Weapon switch: lower out of view, swap, raise
    pos.y -= ease(s.switchT) * 0.3;
    rot.x -= ease(s.switchT) * 0.7;

    g.position.copy(pos);
    g.rotation.copy(rot);
    if (this.arms) this._poseArms(s);

    // Light the gun from the real sun direction (converted into camera space)
    this._q.copy(s.mainCamera.quaternion).invert();
    this.sun.position.copy(s.sunDir).applyQuaternion(this._q).multiplyScalar(5);

    // Slight zoom on the viewmodel when aiming
    const fov = lerp(this.baseFov, m.adsFov, a);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }

    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) { m.flash.visible = false; this.flashLight.intensity = 0; }
    }
  }
}

// =============================================================================
// character.js — soldiers: realistic, skinned, animated people.
//
// THE MODELS come from the Microsoft Rocketbox avatar library (MIT licence;
// tools/fetch-characters.mjs downloads and converts them). Four soldiers in
// combat kit, so a squad or a patrol isn't four copies of one man. Each is a
// SKINNED mesh: ~15,000 triangles bound to a skeleton of 80 bones, including
// every finger joint. Moving a bone bends the mesh around it.
//
// THE SKELETON is a 3ds Max "Biped" (bones named Bip01_Pelvis,
// Bip01_L_UpperArm...). The game calls bones by plain names (Hips, LeftArm...)
// and BONE below translates. The animation clips (idle, walk, run) were
// motion-captured on the same skeleton, so they play on all four soldiers
// with no retargeting. An AnimationMixer blends them by speed.
//
// The clips don't hold a rifle, so we LAYER poses on top, like an animation
// graph in Unreal or Unity:
//   • ARMS: two-bone inverse kinematics (IK). Given where the hand must be,
//     the shoulder-elbow-wrist triangle has exactly one solution once you say
//     which way the elbow points (the "pole"). Then the hand is turned so the
//     palm wraps the grip, and the fingers curl round it. Poses are solved
//     once per soldier and kind of gun, from that soldier's own eye and
//     shoulder positions, so a gun sits where it would on a real person.
//   • a kneeling pose for cover, built from a few joint rotations;
//   • spine bends to aim up/down, lean, prone, climbing, falling dead.
// Hit boxes ride on the bones, so headshots land where the head really is.
//
// The same solver poses YOUR arms in first person (viewmodel.js): the same
// model, sleeves and gloves your squad sees, with your hands on the gun.
// =============================================================================
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Wardrobe } from './avatar.js';
import { buildGun } from './gunsmith.js';
import { buildWeapon } from './loadout.js';
import { mulberry32 } from './textures.js';

// The game's names for the bones it uses -> the Biped skeleton's names
export const BONE = {
  Root: 'Bip01', Hips: 'Bip01_Pelvis', Spine: 'Bip01_Spine', Spine1: 'Bip01_Spine1', Spine2: 'Bip01_Spine2', Neck: 'Bip01_Neck', Head: 'Bip01_Head',
  LeftShoulder: 'Bip01_L_Clavicle', LeftArm: 'Bip01_L_UpperArm', LeftForeArm: 'Bip01_L_Forearm', LeftHand: 'Bip01_L_Hand',
  RightShoulder: 'Bip01_R_Clavicle', RightArm: 'Bip01_R_UpperArm', RightForeArm: 'Bip01_R_Forearm', RightHand: 'Bip01_R_Hand',
  LeftUpLeg: 'Bip01_L_Thigh', LeftLeg: 'Bip01_L_Calf', LeftFoot: 'Bip01_L_Foot',
  RightUpLeg: 'Bip01_R_Thigh', RightLeg: 'Bip01_R_Calf', RightFoot: 'Bip01_R_Foot',
  LeftEye: 'Bip01_LEye', RightEye: 'Bip01_REye',
};
export const B = (n) => BONE[n];
const SIDES = { Left: 'L', Right: 'R' };
// Arm bones: the pose layer owns these (and the fingers); the clips own the rest
const ARM_BONES = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'].map(B);
const FINGER_BONES = [];
for (const s of ['L', 'R']) for (let f = 0; f < 5; f++) for (const j of ['', '1', '2']) FINGER_BONES.push(`Bip01_${s}_Finger${f}${j}`);
const LEG_BONES = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'].map(B);
const SPINE_BONES = ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head'].map(B);
const RIGHT = new THREE.Vector3(1, 0, 0); // a soldier faces -z, so +x is his right
const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const LEAN_ROLL = 0.6;   // how far the spine bends sideways at full lean (rad, ~34°)
const LEAN_SHIFT = 0.1;  // how far the body slides sideways at full lean (m)
const PARTS = ['body', 'head', 'helmet', 'equipment'];
// Clip speeds: how fast the walk and run were filmed (m/s), measured from how
// far their root bone travels per loop. Playing a clip faster or slower in
// proportion to the soldier's real speed keeps the feet from sliding.
const WALK_SPEED = 1.01, RUN_SPEED = 2.88;

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _qc = new THREE.Quaternion();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _eLie = new THREE.Euler();

// ---------------------------------------------------------------- loading
// Everything for the soldiers: models, textures and clips (assets/characters/rocketbox/).
export async function loadSoldiers(base = 'assets/characters/rocketbox/') {
  const manifest = await (await fetch(`${base}manifest.json`)).json();
  // The FBX files still name the original TGA textures. We ship converted
  // JPEGs instead and attach them ourselves, so tell the loader not to fetch them.
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga$/i, { setPath() { return this; }, load: () => new THREE.Texture() });
  const fbx = new FBXLoader(manager);
  const texLoader = new THREE.TextureLoader();
  const tex = (url, srgb) => texLoader.loadAsync(url).then((t) => { t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 4; return t; });
  const soldiers = await Promise.all(manifest.soldiers.map(async (s) => {
    const dir = `${base}${s.dir}/`;
    const [scene, ...maps] = await Promise.all([fbx.loadAsync(base + s.fbx), ...PARTS.flatMap((p) => [tex(dir + s.parts[p].map, true), tex(dir + s.parts[p].normal, false)])]);
    const textures = Object.fromEntries(PARTS.map((p, i) => [p, { map: maps[i * 2], normal: maps[i * 2 + 1] }]));
    return { name: s.name, scene, textures };
  }));
  const clips = {};
  await Promise.all(Object.entries(manifest.anims).map(async ([id, file]) => { clips[id] = cleanClip((await fbx.loadAsync(base + file)).animations[0], id); }));
  // Every clip keeps the hips where the idle keeps them: straight over the feet
  const home = rootXZ(clips.idle);
  for (const c of Object.values(clips)) pinRoot(c, home);
  return { soldiers, clips };
}

// Keep only what moves: each bone's rotation, plus the root bone's position
// (the body bobbing up and down). Bones never change length or scale, and
// dropping those tracks makes every soldier's animation 3x cheaper to update.
//
// ROOT MOTION: a walk was filmed walking forwards, so the root bone travels
// ~1.2 m per stride (a run, ~2 m) and jumps back when the clip loops. The game
// moves the soldier itself, so that travel has to go, or every soldier lurches
// forward and snaps back each stride. Keep the up-and-down bob and pin the
// forward/sideways position ("in place" animation) — to where the IDLE holds
// the hips, over the feet. (Not the clip's own average: a run that travels 2 m
// averages 1 m ahead of where it started, which would draw a running soldier a
// metre away from where he really is, sliding back as he slows to a walk.)
function cleanClip(clip, name) {
  clip.name = name;
  clip.tracks = clip.tracks.filter((t) => {
    const [node, prop] = t.name.split('.');
    if (!node.startsWith('Bip01') || node === 'Bip01_Footsteps') return false;
    return prop === 'quaternion' || (prop === 'position' && node === 'Bip01');
  });
  return clip;
}

// The average forward/sideways position of a clip's root bone
function rootXZ(clip) {
  const root = clip?.tracks.find((t) => t.name === 'Bip01.position');
  if (!root) return null;
  const v = root.values, n = v.length / 3;
  let x = 0, z = 0;
  for (let i = 0; i < n; i++) { x += v[i * 3]; z += v[i * 3 + 2]; }
  return { x: x / n, z: z / n };
}

function pinRoot(clip, home) {
  const root = clip.tracks.find((t) => t.name === 'Bip01.position');
  const at = home || rootXZ(clip);
  if (!root || !at) return;
  const v = root.values;
  for (let i = 0; i < v.length; i += 3) { v[i] = at.x; v[i + 2] = at.z; }
}

// ---------------------------------------------------------------- pose helpers
// Rotate a bone by a WORLD-space rotation (keeps the math readable).
function rotateWorld(bone, axis, angle) {
  _q.setFromAxisAngle(axis, angle);
  bone.parent.getWorldQuaternion(_q2);
  const local = _q3.copy(_q2).invert().multiply(_q).multiply(_q2);
  bone.quaternion.premultiply(local);
  bone.updateMatrixWorld(true);
}

// Turn a bone so its world direction `from` becomes `to` (both world vectors).
function aimBone(bone, from, to) {
  _q.setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  bone.parent.getWorldQuaternion(_q2);
  bone.quaternion.premultiply(_q3.copy(_q2).invert().multiply(_q).multiply(_q2));
  bone.updateMatrixWorld(true);
}

// TWO-BONE IK: put the end of upper->lower->end on `target`, with the middle
// joint (elbow) bending towards `pole`. The law of cosines gives the elbow's
// angle from the three lengths; the pole picks which way round.
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _e = new THREE.Vector3(), _n = new THREE.Vector3();
export function twoBoneIK(upper, lower, end, target, pole) {
  upper.getWorldPosition(_a); lower.getWorldPosition(_b); end.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b), l2 = _b.distanceTo(_c);
  _t.subVectors(target, _a);
  const d = THREE.MathUtils.clamp(_t.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
  _t.normalize();
  // how far along shoulder->target the elbow sits, and how far out from that line
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), out = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  _n.subVectors(pole, _a); _n.addScaledVector(_t, -_n.dot(_t)); // pole direction, square to the shoulder->target line
  if (_n.lengthSq() < 1e-8) _n.set(0, -1, 0).addScaledVector(_t, -_t.y);
  _n.normalize();
  _e.copy(_a).addScaledVector(_t, along).addScaledVector(_n, out); // where the elbow goes
  aimBone(upper, _v1.subVectors(_b, _a), _v2.subVectors(_e, _a));
  lower.getWorldPosition(_b); end.getWorldPosition(_c);
  _v3.copy(_a).addScaledVector(_t, d); // the reachable point on the way to the target
  aimBone(lower, _v1.subVectors(_c, _b), _v2.subVectors(_v3, _b));
}

// Reaching far (the support hand out along a rifle's handguard), people roll
// the shoulder forward: the collarbone swings towards the target, up to ~20°.
const _r1 = new THREE.Vector3(), _r2 = new THREE.Vector3(), _r3 = new THREE.Vector3(), _r4 = new THREE.Vector3();
function reachShoulder(clav, upper, lower, end, target) {
  clav.getWorldPosition(_r1); upper.getWorldPosition(_r2); lower.getWorldPosition(_r3); end.getWorldPosition(_r4);
  const reach = _r2.distanceTo(_r3) + _r3.distanceTo(_r4), d = _r2.distanceTo(target);
  if (d < reach * 0.88) return;
  const from = _r2.sub(_r1), to = _r3.subVectors(target, _r1), len = from.length();
  const ang = Math.min(0.35, from.angleTo(to), ((d - reach * 0.88) / len) * 0.9);
  _r4.crossVectors(from, to).normalize();
  if (_r4.lengthSq() > 0.5) rotateWorld(clav, _r4, ang);
}

// ---------------------------------------------------------------- hands
// Each hand's axes in its own bone space, measured once from the model:
//   F  along the hand, from the wrist to the middle knuckle
//   P  out of the palm
// They let us say "fingers that way, palm facing this way" in world terms.
function measureHand(t, side) {
  const s = SIDES[side];
  const hand = t.getObjectByName(`Bip01_${s}_Hand`);
  const p = (n) => t.getObjectByName(n).getWorldPosition(new THREE.Vector3());
  const wrist = p(`Bip01_${s}_Hand`), mid = p(`Bip01_${s}_Finger2`), index = p(`Bip01_${s}_Finger1`), pinky = p(`Bip01_${s}_Finger4`);
  const F = mid.clone().sub(wrist).normalize();
  const across = pinky.clone().sub(index).normalize();
  // index -> little finger, crossed with the hand's direction, points out of the palm (mirrored for the left hand)
  const P = side === 'Right' ? F.clone().cross(across) : across.clone().cross(F);
  P.addScaledVector(F, -P.dot(F)).normalize();
  const inv = hand.getWorldQuaternion(new THREE.Quaternion()).invert();
  const local = { F: F.applyQuaternion(inv), P: P.applyQuaternion(inv), len: wrist.distanceTo(mid) };
  // which way each finger bends: test a small turn about the hand's side axis
  const fingers = [];
  for (let f = 0; f < 5; f++) fingers.push([0, 1, 2].map((j) => t.getObjectByName(`Bip01_${s}_Finger${f}${j ? j : ''}`).name));
  return { ...local, fingers };
}

// Turn the hand so F and P point along fWorld / pWorld
const _ma = new THREE.Matrix4(), _mb = new THREE.Matrix4(), _qh = new THREE.Quaternion();
function orientHand(hand, H, fWorld, pWorld) {
  const f = _v1.copy(fWorld).normalize(), p = _v2.copy(pWorld).addScaledVector(f, -pWorld.dot(f)).normalize(), c = _v3.crossVectors(f, p);
  _ma.makeBasis(f, p, c); // world: where we want the axes
  const lc = _v4.crossVectors(H.F, H.P);
  _mb.makeBasis(H.F, H.P, lc).transpose(); // hand space -> those axes
  _qh.setFromRotationMatrix(_ma.multiply(_mb)); // the hand's world rotation
  hand.parent.getWorldQuaternion(_q2);
  hand.quaternion.copy(_q2.invert().multiply(_qh));
  hand.updateMatrixWorld(true);
}

// Curl the fingers towards the palm. curl = [thumb, index, middle, ring, little] (radians per joint)
// Turning about F x P swings a finger from pointing along F towards the palm.
const _ax = new THREE.Vector3(), _qf = new THREE.Quaternion();
function curlFingers(bones, H, curl) {
  bones[H.handName].getWorldQuaternion(_qf);
  for (let f = 0; f < 5; f++) {
    for (let j = 0; j < 3; j++) {
      const bone = bones[H.fingers[f][j]];
      if (f === 0) { // the thumb rolls in across the palm, about the hand's own axis
        _ax.copy(H.F).applyQuaternion(_qf).normalize();
        rotateWorld(bone, _ax, (H.side === 'Right' ? 1 : -1) * curl[0] * (j ? 0.5 : 1));
      } else {
        _ax.crossVectors(H.F, H.P).applyQuaternion(_qf).normalize();
        rotateWorld(bone, _ax, curl[f] * (j === 0 ? 0.85 : j === 1 ? 1.1 : 0.8));
      }
    }
  }
}

// How each hand holds each kind of gun, in the GUN's frame (barrel -z, up +y, right +x):
//   f / p   which way the hand and the palm face
//   curl    finger curls (thumb, index, middle, ring, little)
//   off     from the wrist to the point the hand closes round (hand frame: along F, along P)
export const GRIPS = {
  // firing hand on a pistol grip: palm against its right side, fingers wrapping round the front, finger along the trigger
  trigger: { f: [-0.12, -0.55, -0.83], p: [-1, 0.05, -0.1], curl: [0.55, 0.5, 1.35, 1.4, 1.35], off: [0.065, 0.035] },
  // support hand under a rifle's handguard: palm up, fingers curling up its right side, thumb along the left
  handguard: { f: [0.62, 0.0, -0.78], p: [0.1, 1, 0.05], curl: [0.2, 1.05, 1.15, 1.2, 1.2], off: [0.07, 0.04] },
  // support hand round a vertical foregrip: like holding a torch
  vgrip: { f: [0.1, -0.35, -0.93], p: [-1, 0, 0.1], curl: [0.6, 1.4, 1.45, 1.45, 1.4], off: [0.06, 0.035] },
  // support hand on a pistol: cupping the firing hand from the left
  cup: { f: [0.35, -0.55, -0.76], p: [0.9, 0.1, -0.2], curl: [0.4, 1.1, 1.2, 1.25, 1.25], off: [0.05, 0.05] },
  // climbing: hands round a ladder rung (soldier frame)
  rung: { f: [0, 0.75, -0.66], p: [0, -0.1, -1], curl: [0.4, 1.3, 1.35, 1.35, 1.3], off: [0.07, 0.03] },
};

// Put one hand on a point: the arm by two-bone IK, then the hand turned to
// hold (grip = GRIPS entry, laid out in `frame`, a world rotation) and the
// fingers curled. bones = a soldier's bones by name; hands = Rig.hands.
export function placeHand(bones, hands, side, point, grip, frame, pole) {
  const H = hands[side];
  const f = _pf.set(...grip.f).normalize().applyQuaternion(frame), p = _pp.set(...grip.p).normalize().applyQuaternion(frame);
  p.addScaledVector(f, -p.dot(f)).normalize();
  const wrist = _pw.copy(point).addScaledVector(f, -grip.off[0]).addScaledVector(p, -grip.off[1]); // the hand closes round `point`
  reachShoulder(bones[B(`${side}Shoulder`)], bones[B(`${side}Arm`)], bones[B(`${side}ForeArm`)], bones[B(`${side}Hand`)], wrist);
  twoBoneIK(bones[B(`${side}Arm`)], bones[B(`${side}ForeArm`)], bones[B(`${side}Hand`)], wrist, pole);
  orientHand(bones[B(`${side}Hand`)], H, f, p);
  curlFingers(bones, H, grip.curl);
}
const _pf = new THREE.Vector3(), _pp = new THREE.Vector3(), _pw = new THREE.Vector3();

// One rig per soldier model: its measurements and its cached poses
class Rig {
  constructor(variant, clips) {
    const t = SkeletonUtils.clone(variant.scene);
    this.t = t;
    const mixer = new THREE.AnimationMixer(t);
    mixer.clipAction(clips.idle).play();
    mixer.update(0);
    // Facing: the soldier in the files faces +z; the game's soldiers face -z
    this.holder = new THREE.Group();
    t.scale.setScalar(0.01); // centimetres -> metres
    t.rotation.y = Math.PI;
    this.holder.add(t);
    this.holder.updateMatrixWorld(true);
    this.bones = {};
    t.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
    const bone = (n) => this.bones[B(n)] || this.bones[n];
    const wp = (n) => bone(n).getWorldPosition(new THREE.Vector3());
    this.eye = wp('RightEye').add(new THREE.Vector3(0, 0, -0.02)); // the right eye, at the front of the eyeball
    this.idleArm = Object.fromEntries([...ARM_BONES, ...FINGER_BONES].map((n) => [n, this.bones[n].quaternion.clone()]));
    this.idleBody = Object.fromEntries([...LEG_BONES, ...SPINE_BONES].map((n) => [n, this.bones[n].quaternion.clone()])); // (a dead soldier goes limp towards this)
    this.hands = { Right: measureHand(t, 'Right'), Left: measureHand(t, 'Left') };
    this.hands.Right.side = 'Right'; this.hands.Right.handName = B('RightHand');
    this.hands.Left.side = 'Left'; this.hands.Left.handName = B('LeftHand');
    // Rest pose of the bones that carry gear (avatar.js lays gear out around this pose)
    this.restInv = { Head: bone('Head').matrixWorld.clone().invert(), Spine2: bone('Spine2').matrixWorld.clone().invert() };
    this.spineInv = this.restInv.Spine2;

    // --- hit boxes: world-space boxes in the idle pose -> bone-local transforms
    const boxes = [];
    const seg = (a, b, w, zone) => {
      const pa = wp(a), pb = wp(b), len = pa.distanceTo(pb);
      const q = new THREE.Quaternion().setFromUnitVectors(UP, pb.clone().sub(pa).normalize());
      boxes.push({ bone: B(a), zone, size: [w, len, w], world: new THREE.Matrix4().compose(pa.clone().add(pb).multiplyScalar(0.5), q, ONE) });
    };
    const head = wp('Head');
    boxes.push({ bone: B('Head'), zone: 'head', size: [0.22, 0.27, 0.25], world: new THREE.Matrix4().makeTranslation(head.x, head.y + 0.09, head.z - 0.01) });
    const chest = wp('Spine1').add(wp('Neck')).multiplyScalar(0.5);
    boxes.push({ bone: B('Spine1'), zone: 'torso', size: [0.42, wp('Neck').y - wp('Spine').y + 0.06, 0.3], world: new THREE.Matrix4().makeTranslation(chest.x, chest.y, chest.z) });
    const hips = wp('Hips');
    boxes.push({ bone: B('Hips'), zone: 'torso', size: [0.38, 0.24, 0.28], world: new THREE.Matrix4().makeTranslation(hips.x, hips.y - 0.02, hips.z) });
    for (const s of ['Left', 'Right']) {
      seg(`${s}Arm`, `${s}ForeArm`, 0.12, 'limb');
      seg(`${s}ForeArm`, `${s}Hand`, 0.1, 'limb');
      seg(`${s}UpLeg`, `${s}Leg`, 0.17, 'limb');
      seg(`${s}Leg`, `${s}Foot`, 0.13, 'limb');
    }
    this.hitboxes = boxes.map((b) => {
      const inv = this.bones[b.bone].matrixWorld.clone().invert();
      return { bone: b.bone, zone: b.zone, size: b.size, local: inv.multiply(b.world) };
    });

    this.dims = this._measure();
    this.poses = new Map();
    // --- climbing a ladder: hands round rungs ~35 cm in front, one high, one low
    const sh = wp('RightArm');
    this.climbArms = [
      this._hands(new THREE.Vector3(0.2, sh.y + 0.05, -0.33), new THREE.Vector3(-0.2, sh.y + 0.37, -0.33)),
      this._hands(new THREE.Vector3(0.2, sh.y + 0.37, -0.33), new THREE.Vector3(-0.2, sh.y + 0.05, -0.33)),
    ];

    // --- kneeling pose: left foot planted forward, right knee on the ground
    const root = bone('Root'), rootRest = root.position.clone();
    rotateWorld(bone('LeftUpLeg'), RIGHT, 1.35);
    rotateWorld(bone('LeftLeg'), RIGHT, -1.45);
    rotateWorld(bone('RightUpLeg'), RIGHT, -0.15);
    rotateWorld(bone('RightLeg'), RIGHT, -1.45);
    rotateWorld(bone('RightFoot'), RIGHT, 0.9);
    this.holder.updateMatrixWorld(true);
    const footY = Math.min(wp('LeftFoot').y - 0.07, wp('RightLeg').y - 0.06); // shin bone sits a few cm above the ground
    const local = new THREE.Vector3(0, -footY, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(root.parent.matrixWorld.clone().invert()));
    this.kneelRoot = rootRest.clone().add(local);
    this.kneelLegs = Object.fromEntries(LEG_BONES.map((n) => [n, this.bones[n].quaternion.clone()]));
    mixer.update(0); // (back to standing)

    // --- crumpled (a body with no room to fall): both knees down, sitting back towards the heels
    rotateWorld(bone('LeftUpLeg'), RIGHT, 0.75);
    rotateWorld(bone('LeftLeg'), RIGHT, -2.2);
    rotateWorld(bone('LeftFoot'), RIGHT, 0.9);
    rotateWorld(bone('RightUpLeg'), RIGHT, 0.55);
    rotateWorld(bone('RightLeg'), RIGHT, -2.0);
    rotateWorld(bone('RightFoot'), RIGHT, 0.9);
    this.holder.updateMatrixWorld(true);
    const lowY = Math.min(wp('LeftLeg').y, wp('RightLeg').y, wp('LeftFoot').y, wp('RightFoot').y) - 0.06;
    this.crumpleRoot = rootRest.clone().add(new THREE.Vector3(0, -lowY, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(root.parent.matrixWorld.clone().invert())));
    this.crumpleLegs = Object.fromEntries(LEG_BONES.map((n) => [n, this.bones[n].quaternion.clone()]));
    mixer.update(0);
    mixer.stopAllAction();
  }

  // Where the helmet is, and the back of the torso, standing at rest: the
  // wardrobe fits headsets, tape and backpacks to them (avatar.js)
  _measure() {
    let skin = null;
    this.t.traverse((o) => { if (o.isSkinnedMesh) skin = o; });
    const mats = [].concat(skin.material), geo = skin.geometry, index = geo.index.array;
    const v = new THREE.Vector3(), helmet = new THREE.Box3(), seen = new Uint8Array(geo.attributes.position.count);
    let backZ = 0, chestZ = 0;
    const neck = this.bones[B('Neck')].getWorldPosition(new THREE.Vector3()), hips = this.bones[B('Hips')].getWorldPosition(new THREE.Vector3());
    for (const g of geo.groups) {
      const part = mats[g.materialIndex]?.name;
      if (!['helmet', 'body', 'equipment'].includes(part)) continue;
      for (let i = g.start; i < g.start + g.count; i++) {
        const vi = index[i];
        if (seen[vi]) continue;
        seen[vi] = 1;
        skin.getVertexPosition(vi, v).applyMatrix4(skin.matrixWorld);
        if (part === 'helmet') helmet.expandByPoint(v);
        else if (Math.abs(v.x) < 0.14 && v.y > hips.y + 0.15 && v.y < neck.y - 0.05) { backZ = Math.max(backZ, v.z); chestZ = Math.min(chestZ, v.z); }
      }
    }
    const eye = (n) => this.bones[B(n)].getWorldPosition(new THREE.Vector3());
    // The right shoulder POCKET: the hollow just inside the shoulder joint, where a
    // rifle's butt goes. How far forward is the body (plate carrier and all) there?
    const sh = eye('RightArm');
    let pocketZ = 0, slingZ = 0;
    for (const g of geo.groups) {
      if (!['body', 'equipment'].includes(mats[g.materialIndex]?.name)) continue;
      for (let i = g.start; i < g.start + g.count; i++) {
        skin.getVertexPosition(index[i], v).applyMatrix4(skin.matrixWorld);
        if (v.x > sh.x - 0.13 && v.x < sh.x - 0.02 && v.y > sh.y - 0.12 && v.y < sh.y + 0.03) pocketZ = Math.min(pocketZ, v.z);
        if (v.x > -0.05 && v.x < 0.15 && v.y > sh.y - 0.3 && v.y < sh.y - 0.05) slingZ = Math.min(slingZ, v.z);
      }
    }
    return { helmet, backZ, chestZ, eyeL: eye('LeftEye'), eyeR: eye('RightEye'), neckY: neck.y, shoulder: sh, pocketZ, slingZ };
  }

  _reset() {
    for (const n of [...ARM_BONES, ...FINGER_BONES]) this.bones[n].quaternion.copy(this.idleArm[n]);
    this.holder.updateMatrixWorld(true);
  }

  _snapshot() { return Object.fromEntries([...ARM_BONES, ...FINGER_BONES].map((n) => [n, this.bones[n].quaternion.clone()])); }

  placeHand(side, point, grip, frame, pole) { placeHand(this.bones, this.hands, side, point, grip, frame, pole); }

  // Arm pose with each hand on a ladder rung (soldier at the origin facing -z)
  _hands(right, left) {
    this._reset();
    const q = new THREE.Quaternion();
    this.placeHand('Right', right, GRIPS.rung, q, new THREE.Vector3(0.6, 0.6, 0.4));
    this.placeHand('Left', left, GRIPS.rung, q, new THREE.Vector3(-0.6, 0.6, 0.4));
    return this._snapshot();
  }

  // Arm and gun poses for one way of holding a gun, solved once and cached.
  //   kind:  'long' (shouldered rifle, SMG, LMG...) or 'pistol' (arms out, two hands)
  //   fore:  where the support hand goes, relative to the firing hand's grip
  //   vgrip: the support hand holds a vertical foregrip
  // Poses are in Spine2's space (soldier facing -z), so they bend with the spine.
  pose(kind, fore, vgrip = false, butt = null) {
    const key = `${kind}:${fore.x.toFixed(2)},${fore.y.toFixed(2)},${fore.z.toFixed(2)}:${vgrip}:${butt ? butt.z.toFixed(2) : '-'}`;
    if (this.poses.has(key)) return this.poses.get(key);
    const e = this.eye, D = this.dims;
    // A pistol: where the grip is, from the eye (at arm's length when aiming).
    const at = (dx, dy, dz, pitch) => new THREE.Matrix4().compose(new THREE.Vector3(e.x + dx, e.y + dy, e.z + dz), new THREE.Quaternion().setFromAxisAngle(RIGHT, pitch), ONE);
    // A long gun pivots on its BUTT: the butt pad sits in the shoulder pocket,
    // just in front of the plate carrier, and the gun hangs off it: level when
    // aiming, muzzle down at the low ready, hanging on its sling to climb.
    // (Placing it by the grip instead swings the stock into the shoulder.)
    const b = butt || new THREE.Vector3(0, 0.055, 0.275);
    const fromButt = (bx, by, bz, pitch, yaw = 0) => {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
      const grip = new THREE.Vector3(bx, by, bz).sub(b.clone().applyQuaternion(q)); // grip = butt - (butt offset, turned with the gun)
      return new THREE.Matrix4().compose(grip, q, ONE);
    };
    const px = D.shoulder.x - 0.075, py = D.shoulder.y + 0.015, pz = D.pocketZ - 0.012;
    const long = kind !== 'pistol';
    const aimW = long ? fromButt(px + 0.01, py + 0.075, pz, 0, 0.04) : at(-0.01, -0.09, -0.46, 0); // butt high in the pocket, cheek on the stock
    const lowW = long ? fromButt(px - 0.01, py - 0.04, pz - 0.01, -0.72, 0.1) : at(0.03, -0.42, -0.3, -0.75);
    const slungW = long ? fromButt(0.06, D.shoulder.y - 0.06, D.slingZ - 0.03, -1.45) : at(0.17, -0.75, 0.08, -1.5);
    const decompose = (m) => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(); this.spineInv.clone().multiply(m).decompose(p, q, s); return { p, q, s }; };
    const R = this.bones[B('RightArm')].getWorldPosition(new THREE.Vector3()), L = this.bones[B('LeftArm')].getWorldPosition(new THREE.Vector3());
    const solve = (gunWorld) => {
      this._reset();
      const q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
      gunWorld.decompose(pos, q, sc);
      // elbows: the firing elbow down and out, the support elbow down and under the gun
      this.placeHand('Right', pos, GRIPS.trigger, q, R.clone().add(new THREE.Vector3(0.35, -0.6, 0.1)));
      const support = fore.clone().applyMatrix4(gunWorld);
      this.placeHand('Left', support, kind === 'pistol' ? GRIPS.cup : vgrip ? GRIPS.vgrip : GRIPS.handguard, q, L.clone().add(new THREE.Vector3(-0.15, -0.7, -0.1)));
      return this._snapshot();
    };
    const p = { gunAim: decompose(aimW), gunLow: decompose(lowW), gunSling: decompose(slungW), armAim: solve(aimW), armLow: solve(lowW) };
    this._reset();
    this.poses.set(key, p);
    return p;
  }
}

// ---------------------------------------------------------------- materials
// Each part of a soldier gets a PBR material with its colour and normal maps.
const ROUGH = { body: 0.92, head: 0.6, helmet: 0.8, equipment: 0.85 };
function partOf(name) { return PARTS.find((p) => name.toLowerCase().endsWith(`_${p}`)) || null; }

// The enemies' rifle: the gunsmith's carbine, merged into one mesh per
// material and SHARED by every soldier carrying it (a few draw calls per
// soldier, instead of the ~60 separate parts a detailed gun is made of).
function sharedRifle(M) {
  const g = buildGun(M, buildWeapon({ id: 'rifle' }), { hands: false });
  g.group.updateMatrixWorld(true);
  const byMat = new Map();
  g.group.traverse((o) => {
    if (!o.isMesh || !o.visible || o.material.transparent) return;
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    const list = byMat.get(o.material) || [];
    list.push(geo.index ? geo.toNonIndexed() : geo);
    byMat.set(o.material, list);
  });
  const parts = [...byMat].map(([mat, geos]) => ({ geo: mergeGeometries(geos), mat }));
  return { parts, muzzle: g.muzzle.position.clone(), grip: g.grip.clone(), fore: g.fore.clone(), butt: g.butt.clone() };
}

// The gloves are part of the uniform texture, but we want to colour them on
// their own (your glove choice; first person shows them big). The skin
// WEIGHTS say which bones move each vertex: triangles moved only by the hand
// and finger bones are the gloves, so they get a material of their own.
function splitGloves(mesh, gloves) {
  const geo = mesh.geometry, si = geo.attributes.skinIndex, sw = geo.attributes.skinWeight;
  const hand = mesh.skeleton.bones.map((b) => /_(L|R)_(Hand|Finger)/.test(b.name));
  const handW = new Float32Array(si.count);
  for (let v = 0; v < si.count; v++) for (let k = 0; k < 4; k++) if (hand[si.getComponent(v, k)]) handW[v] += sw.getComponent(v, k);
  const index = geo.index ? geo.index.array : null, at = (i) => (index ? index[i] : i);
  const mats = [].concat(mesh.material), body = mats.findIndex((m) => m.name === 'body');
  const out = [], groups = [], glove = [];
  for (const g of geo.groups) {
    const keep = [];
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const tri = [at(i), at(i + 1), at(i + 2)];
      (g.materialIndex === body && tri.every((v) => handW[v] > 0.5) ? glove : keep).push(...tri);
    }
    if (keep.length) { groups.push([out.length, keep.length, g.materialIndex]); out.push(...keep); }
  }
  groups.push([out.length, glove.length, mats.length]);
  out.push(...glove);
  geo.setIndex(out);
  geo.clearGroups();
  for (const [start, count, m] of groups) geo.addGroup(start, count, m);
  mesh.material = [...mats, gloves];
}

// ---------------------------------------------------------------- the factory
export class SoldierFactory {
  // kit = loadSoldiers(); tint = this map's enemy uniform colour
  constructor(kit, M, tint) {
    this.kit = kit;
    this.M = M;
    this.clips = kit.clips;
    this.variants = kit.soldiers.map((v) => {
      const mats = {};
      for (const p of PARTS) mats[p] = new THREE.MeshStandardMaterial({ name: p, map: v.textures[p].map, normalMap: v.textures[p].normal, roughness: ROUGH[p], metalness: 0 });
      mats.extra = new THREE.MeshStandardMaterial({ name: 'extra', color: 0x2a2b28, roughness: 0.6, metalness: 0.3 });
      mats.gloves = mats.body.clone();
      mats.gloves.name = 'gloves';
      // Swap the file's materials for ours, part by part
      v.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.material = [].concat(o.material).map((m) => mats[partOf(m.name)] || mats.extra);
        if (o.isSkinnedMesh) splitGloves(o, mats.gloves);
        o.castShadow = o.receiveShadow = true;
        o.frustumCulled = false;
      });
      return { ...v, mats, rig: null };
    });
    this.tint = tint ?? null; // this map's enemy uniform (the wardrobe recolours the camo)
    this._rifle = null;
  }

  get count() { return this.variants.length; }

  // A soldier model's rig (measured the first time it's needed)
  rig(i) {
    const v = this.variants[i];
    return (v.rig ??= new Rig(v, this.clips));
  }

  // The wardrobe paints uniforms and builds gear (avatar.js); made when first needed
  get wardrobe() { return (this._wardrobe ??= new Wardrobe(this)); }

  // A new soldier.
  //   variant  which of the soldier models (0..count-1); default: picked by `seed`, or soldier 0
  //   tint     a uniform colour (co-op squadmates' plain uniform)
  //   avatar   a custom look (avatar.js), worn over that; its `soldier` picks the model
  create({ tint, avatar, variant, seed } = {}) {
    if (variant === undefined) variant = seed !== undefined ? Math.abs(seed | 0) % this.count : 0;
    const body = new SoldierBody(this, Math.max(0, Math.min(this.count - 1, variant | 0)));
    body.baseTint = tint ?? this.tint;
    body.seed = seed; // (enemies: their network id, so a death looks the same to everyone in co-op)
    body.setAvatar(avatar || null);
    return body;
  }

  // The enemies' rifle (built once, shared)
  rifle() {
    const r = (this._rifle ??= sharedRifle(this.M));
    const group = new THREE.Group();
    for (const p of r.parts) { const m = new THREE.Mesh(p.geo, p.mat); m.castShadow = true; group.add(m); }
    const muzzle = new THREE.Object3D(); muzzle.position.copy(r.muzzle); group.add(muzzle);
    return { group, muzzle, grip: r.grip, fore: r.fore, butt: r.butt, kind: 'long' };
  }
}

const hitMat = new THREE.MeshBasicMaterial({ visible: false });

// ---------------------------------------------------------------- one soldier
export class SoldierBody {
  constructor(factory, variant) {
    this.f = factory;
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ'; // yaw first, then the death fall happens in the soldier's own frame
    this.model = new THREE.Group(); // tilts for prone, slides for lean
    this.root.add(this.model);
    this.hitMeshes = [];
    this.look = null;  // the custom look being worn (avatar.js), if any
    this.gear = [];
    this.gunHolder = new THREE.Group();
    this.defaultGun = factory.rifle();
    this._build(variant);
    this.setGun(this.defaultGun);
    this.deathT = -1;
  }

  // (Re)build the skinned soldier for a model (a new look can pick another one)
  _build(variant) {
    if (this.mesh) this.model.remove(this.mesh);
    const f = this.f, v = f.variants[variant];
    this.variant = variant;
    this.rig = f.rig(variant);
    const fbx = SkeletonUtils.clone(v.scene);
    fbx.scale.setScalar(0.01);
    fbx.rotation.y = Math.PI;
    this.mesh = fbx;
    this.model.add(fbx);
    this.bones = {};
    fbx.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
    this.skin = null;
    fbx.traverse((o) => { if (o.isSkinnedMesh) this.skin = o; });
    this.baseMats = [].concat(this.skin.material);
    this.rootBone = this.bones[B('Root')];

    this.mixer = new THREE.AnimationMixer(fbx);
    this.actions = {};
    for (const n of ['idle', 'walk', 'run']) {
      const a = this.mixer.clipAction(f.clips[n]);
      a.play();
      a.setEffectiveWeight(n === 'idle' ? 1 : 0);
      a.time = Math.random() * a.getClip().duration;
      this.actions[n] = a;
    }

    // Hit boxes on the bones (keeping what the game tagged them with, e.g. which enemy they belong to)
    const tags = this.hitMeshes[0] ? { ...this.hitMeshes[0].userData } : {};
    delete tags.zone;
    for (const m of this.hitMeshes) m.removeFromParent();
    const fresh = this.rig.hitboxes.map((h) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(...h.size), hitMat);
      m.matrixAutoUpdate = false;
      m.matrix.copy(h.local);
      Object.assign(m.userData, tags, { zone: h.zone });
      this.bones[h.bone].add(m);
      return m;
    });
    this.hitMeshes.length = 0;
    this.hitMeshes.push(...fresh);

    // The gun rides in a holder on the upper back that animate() poses every
    // frame; whatever gun sits inside has its grip at the holder's origin.
    this.bones[B('Spine2')].add(this.gunHolder);
    if (this.gunSpec) this.pose = this._poseFor(this.gunSpec);
  }

  _poseFor(g) {
    const fore = g.fore.clone().sub(g.grip);
    return this.rig.pose(g.kind, fore, !!g.vgrip || fore.y < -0.06, g.butt ? g.butt.clone().sub(g.grip) : null);
  }

  // g = { group, muzzle, grip, fore, kind } (gunsmith.buildGun's result + kind)
  setGun(g) {
    if (this.gun === g.group) return;
    if (this.gun) this.gun.removeFromParent(); // (from his hands, or from the ground if he's dead)
    this.gun = g.group;
    this.gun.position.copy(g.grip).negate();
    this.gunHolder.add(this.gun);
    this.muzzle = g.muzzle;
    this.gunSpec = g;
    this.pose = this._poseFor(g);
  }

  muzzleWorld(out) { return this.muzzle.getWorldPosition(out); }

  // Wear a custom look (avatar.js); null puts the plain uniform back on.
  // Call setAvatar(null) before throwing a body away, to free its painted textures.
  setAvatar(avatar) { this.f.wardrobe.dress(this, avatar); }

  // s = { speed, crouch (0..1), prone (0..1), aiming (0..1), aimPitch, deathT (-1 alive), flinch,
  //       lean (-1 left .. 1 right; co-op squadmates peeking with Q / E),
  //       climb (0..1 on a ladder), climbPhase (radians, advances one π per rung) }
  animate(dt, s) {
    if (s.deathT >= 0) { this._dying(dt, s); return; }
    if (this.dead) this._revive();
    const A = this.actions, rig = this.rig;
    const pr = s.prone || 0;
    if (pr > 0.3) s = { ...s, speed: 0 }; // no crawl clip: lie still and slide
    if (s.deathT < 0) {
      // Locomotion blend: idle -> walk -> run by speed, each clip played at a
      // rate that matches the speed so the feet don't slide
      // (a short walk -> run blend: the two have different strides, and a long
      // mix of them makes the legs scissor)
      const wRun = THREE.MathUtils.clamp((s.speed - 2.0) / 0.6, 0, 1);
      const wWalk = THREE.MathUtils.clamp(s.speed / 0.6, 0, 1) * (1 - wRun);
      A.idle.setEffectiveWeight(1 - Math.max(wWalk, wRun));
      A.walk.setEffectiveWeight(wWalk);
      A.run.setEffectiveWeight(wRun);
      A.walk.timeScale = THREE.MathUtils.clamp(s.speed / WALK_SPEED, 0.6, 1.7);
      A.run.timeScale = THREE.MathUtils.clamp(s.speed / RUN_SPEED, 0.75, 1.9);
      this.mixer.update(dt);
    }

    // Arms (and fingers): low ready blended to aiming
    const P = this.pose, a = s.aiming, bones = this.bones;
    for (const n in P.armLow) bones[n].quaternion.slerpQuaternions(P.armLow[n], P.armAim[n], a);
    const r = this.gunHolder;
    r.position.lerpVectors(P.gunLow.p, P.gunAim.p, a);
    r.quaternion.slerpQuaternions(P.gunLow.q, P.gunAim.q, a);
    r.scale.copy(P.gunAim.s);

    // Climbing a ladder: hand over hand (swing between the two IK poses in
    // time with the rungs) with the gun slung. The legs step further down.
    const cl = s.deathT < 0 ? s.climb || 0 : 0, ph = s.climbPhase || 0;
    if (cl > 0.01) {
      const k = (Math.sin(ph) + 1) / 2; // 0 = left hand high .. 1 = right hand high
      for (const n in rig.climbArms[0]) bones[n].quaternion.slerp(_qc.slerpQuaternions(rig.climbArms[0][n], rig.climbArms[1][n], k), cl);
      r.position.lerp(P.gunSling.p, cl);
      r.quaternion.slerp(P.gunSling.q, cl);
    }

    // Kneel behind cover
    const c = s.crouch;
    if (c > 0.01) {
      for (const n of LEG_BONES) bones[n].quaternion.slerp(rig.kneelLegs[n], c);
      this.rootBone.position.lerp(rig.kneelRoot, c);
    }

    this.root.updateMatrixWorld(true);
    if (s.deathT < 0) {
      // Aim up/down by bending the spine (arms and rifle follow: they hang off it)
      const right = _v1.set(1, 0, 0).applyQuaternion(this.root.quaternion);
      // prone: the body lies flat, so the upper back arches up to bring the rifle level
      const pitch = s.aimPitch * a - s.flinch * 0.3 + c * 0.15 + pr * 1.3;
      rotateWorld(bones[B('Spine')], right, pitch * 0.3);
      rotateWorld(bones[B('Spine1')], right, pitch * 0.35);
      rotateWorld(bones[B('Spine2')], right, pitch * 0.35);
      // Cheek on the stock when aiming a long gun: the head dips and leans in
      if (this.gunSpec?.kind !== 'pistol') rotateWorld(bones[B('Head')], right, -0.16 * a);
      // Ladder steps: each knee comes up in turn, opposite to the high hand
      if (cl > 0.01) {
        for (const [side, off] of [['Left', 0], ['Right', Math.PI]]) {
          const lift = (Math.sin(ph + off) + 1) / 2;
          rotateWorld(bones[B(`${side}UpLeg`)], right, (0.25 + lift * 0.8) * cl);
          rotateWorld(bones[B(`${side}Leg`)], right, -(0.3 + lift * 1.1) * cl);
        }
      }
    }

    // Lean (peeking round a corner): bend the spine sideways about the way the
    // soldier faces, and keep the head nearer level, as people do when they peek.
    const lean = s.deathT < 0 ? s.lean || 0 : 0;
    if (Math.abs(lean) > 0.01) {
      const fwd = _v2.set(0, 0, -1).applyQuaternion(this.root.quaternion);
      const roll = lean * LEAN_ROLL; // + tips the top toward his right (+x)
      rotateWorld(bones[B('Spine')], fwd, roll * 0.4);
      rotateWorld(bones[B('Spine1')], fwd, roll * 0.35);
      rotateWorld(bones[B('Spine2')], fwd, roll * 0.25);
      rotateWorld(bones[B('Head')], fwd, -roll * 0.65);
    }

    // Prone: tip the whole body forward onto the ground, head ending up where
    // the player's head is (the model's origin is at the feet, so slide it back)
    this.model.rotation.set(-1.45 * pr, 0, 0);
    this.model.position.set(LEAN_SHIFT * lean, 0.14 * pr, 1.3 * pr);
  }

  // ------------------------------------------------------------------ death
  // A procedural collapse (a "fake ragdoll"): over about a second the knees
  // buckle, the body falls backwards or forwards with a twist, the arms and
  // head go limp, and he ends up lying flat. The gun drops out of his hands
  // and falls to the ground beside him. Each death picks its own direction,
  // twist and sprawl, so a firefight doesn't leave rows of identical bodies.
  // (Real ragdolls simulate every limb with a physics engine; this gets most
  // of the look for a few rotations.)
  _dying(dt, s) {
    const rig = this.rig, bones = this.bones;
    if (!this.dead) {
      // In co-op the host and each friend animate this death separately; seeding
      // the dice with the soldier's network id makes them all see the same fall
      this.deaths = (this.deaths || 0) + 1;
      const r = this.seed !== undefined ? mulberry32(((this.seed | 0) * 7919 + this.deaths) >>> 0) : Math.random;
      this.dead = {
        t: s.deathT >= 1 ? 3 : 0, // already dead when we first saw him (joined late): no fall, just lying there
        from: Object.fromEntries([...ARM_BONES, ...FINGER_BONES, ...LEG_BONES, ...SPINE_BONES].map((n) => [n, bones[n].quaternion.clone()])),
        rootFrom: this.rootBone.position.clone(),
        startPitch: this.model.rotation.x, startPos: this.model.position.clone(),
        fall: this._fallWay((s.prone || 0) > 0.5, r),
        roll: (r() - 0.5) * 0.5, twist: (r() - 0.5) * 0.8,
        spread: [0.1 + r() * 0.45, 0.1 + r() * 0.45], head: (r() < 0.5 ? -1 : 1) * (0.35 + r() * 0.45),
        knee: 0.5 + r() * 0.4,
      };
      this._dropGun(r);
    }
    const D = this.dead;
    D.t += dt;
    const k = Math.min(1, D.t / 1.05);
    const sm = (a, b) => { const t = Math.min(1, Math.max(0, (k - a) / (b - a))); return t * t * (3 - 2 * t); };
    // Limbs: arms, fingers, spine and head relax towards the standing rest pose
    // (lying down, that's arms along the body); the knees buckle, then mostly straighten
    const W = D.fall, slump = W.way === 'slump';
    const limp = sm(0, 0.45), buckle = (slump ? sm(0, 0.5) : sm(0, 0.3) * D.knee), settle = slump ? 0 : sm(0.55, 1);
    for (const n in rig.idleArm) bones[n].quaternion.slerpQuaternions(D.from[n], rig.idleArm[n], limp);
    for (const n of SPINE_BONES) bones[n].quaternion.slerpQuaternions(D.from[n], rig.idleBody[n], sm(0, 0.5));
    if (slump) {
      for (const n of LEG_BONES) bones[n].quaternion.slerpQuaternions(D.from[n], rig.crumpleLegs[n], buckle);
      this.rootBone.position.lerpVectors(D.rootFrom, rig.crumpleRoot, buckle);
    } else {
      for (const n of LEG_BONES) bones[n].quaternion.slerpQuaternions(D.from[n], rig.kneelLegs[n], buckle).slerp(rig.idleBody[n], settle * 0.75);
      this.rootBone.position.lerpVectors(D.rootFrom, rig.kneelRoot, buckle * (1 - settle) * 0.6);
    }
    // The fall: accelerating, like anything toppling under gravity. Backwards
    // and forwards tip about x, sideways about z; a slump just sags forward where he kneels.
    const f = sm(0.08, 0.85) ** 2;
    const flat = (Math.PI / 2) * 0.98, side = W.way === 'left' || W.way === 'right';
    const pitchTo = W.way === 'back' ? flat : W.way === 'front' ? -flat : W.way === 'slump' ? -0.1 : 0;
    const rollTo = W.way === 'left' ? flat : W.way === 'right' ? -flat : 0;
    this.model.rotation.set(D.startPitch + (pitchTo - D.startPitch) * f, D.twist * f, rollTo * f + (side ? 0 : D.roll * f));
    // lying flat, his back (or his chest and plate carrier, or his shoulder) keeps him off the ground
    const lift = slump ? 0 : W.way === 'back' ? 0.11 : 0.15;
    this.model.position.set(D.startPos.x * (1 - f), D.startPos.y + lift * sm(0.55, 0.9), D.startPos.z);
    this.root.updateMatrixWorld(true);
    // Once he's down the arms sprawl a little from his sides, and the head rolls over
    this.model.getWorldQuaternion(_q3);
    const fwd = _v2.set(0, 0, -1).applyQuaternion(_q3).normalize(), right = _v3.set(1, 0, 0).applyQuaternion(_q3).normalize();
    const sprawl = slump ? 0 : sm(0.6, 1);
    rotateWorld(bones[B('LeftArm')], fwd, D.spread[0] * sprawl);
    rotateWorld(bones[B('RightArm')], fwd, -D.spread[1] * sprawl);
    rotateWorld(bones[B('Head')], fwd, D.head * sm(0.2, 0.9));
    // Boxed in (a corner, a narrow ledge): he crumples onto both knees, sinks
    // back towards his heels and folds forward, chin on his chest
    if (slump) {
      const fold = sm(0.15, 0.75);
      rotateWorld(bones[B('Spine')], right, -0.3 * fold);
      rotateWorld(bones[B('Spine1')], right, -0.3 * fold);
      rotateWorld(bones[B('Spine2')], right, -0.2 * fold);
      rotateWorld(bones[B('Head')], right, -0.5 * fold);
    }
    this._gunFall(dt);
  }

  // Which way can he fall? A body that falls straight through a wall or onto
  // a concrete barrier looks broken, so look for room first: about 1.8 m of
  // clear space at body height, with a floor under it (roofs have edges).
  // Lying prone he just goes face down; boxed in, he crumples where he is.
  _fallWay(prone, r) {
    if (prone) return { way: 'front' };
    const w = this.f.world;
    const ways = r() < 0.6 ? ['back', 'front', 'left', 'right'] : ['front', 'back', 'right', 'left'];
    if (!w) return { way: ways[0] };
    this.root.updateMatrixWorld(true);
    const o = this.root.getWorldPosition(new THREE.Vector3()), q = this.root.getWorldQuaternion(new THREE.Quaternion());
    const DIR = { back: [0, 0, 1], front: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0] };
    const roomy = (way) => {
      const d = new THREE.Vector3(...DIR[way]).applyQuaternion(q);
      for (const dist of [0.5, 1.0, 1.45, 1.85]) {
        const x = o.x + d.x * dist, z = o.z + d.z * dist, ground = w.groundHeight(x, z);
        if (w.boxBlocked(x - 0.15, o.y + 0.12, z - 0.15, x + 0.15, o.y + 0.6, z + 0.15)) return false; // something in the way
        if (ground > o.y + 0.45) return false;                                                     // a bank of earth
        const floor = ground > o.y - 0.4 || w.boxBlocked(x - 0.1, o.y - 0.3, z - 0.1, x + 0.1, o.y + 0.02, z + 0.1);
        if (!floor) return false;                                                                  // a drop: the edge of a roof
      }
      return true;
    };
    const way = ways.find(roomy);
    return { way: way || 'slump' };
  }

  // Let go of the gun: it stays where it was in the world, now on its own
  _dropGun(r) {
    const g = this.gun;
    if (!g || g.parent !== this.gunHolder) return;
    this.root.updateMatrixWorld(true);
    this.root.attach(g); // (the root stays upright while the body falls, so the gun falls on its own)
    this.gunDrop = { v: 0, side: r() < 0.5 ? 1 : -1, slide: 0.4 + r() * 0.6 };
    if (this.dead.t >= 3) this._gunFall(10); // already lying there
  }

  // The dropped gun falls, turns onto its side and comes to rest on the ground
  _gunFall(dt) {
    const g = this.gun, G = this.gunDrop;
    if (!G || g.parent !== this.root || G.rest) return;
    for (let left = dt; left > 1e-4; left -= 1 / 60) {
      const h = Math.min(left, 1 / 60);
      G.v -= 9.81 * h;
      g.position.y = Math.max(0.035, g.position.y + G.v * h);
      _v1.set(0, 0, -1).applyQuaternion(g.quaternion); // where the barrel points: it lands lying along that
      _q.setFromEuler(_eLie.set(0, Math.atan2(-_v1.x, -_v1.z), G.side * Math.PI / 2, 'YXZ'));
      g.quaternion.slerp(_q, Math.min(1, h * 5));
      g.position.addScaledVector(_v1.setY(0), G.slide * h); // a little skid forwards as it drops
      if (g.position.y <= 0.035) { G.v = 0; G.slide *= Math.max(0, 1 - h * 8); }
    }
    if (g.position.y <= 0.035 && g.quaternion.angleTo(_q) < 0.02 && G.slide < 0.01) G.rest = true;
  }

  // Alive again (a squadmate respawning, the escort at a checkpoint): gun back in his hands
  _revive() {
    if (this.gun && this.gun.parent !== this.gunHolder) {
      this.gunHolder.add(this.gun);
      this.gun.position.copy(this.gunSpec.grip).negate();
      this.gun.quaternion.identity();
    }
    this.gunDrop = null;
    this.dead = null;
    this.root.rotation.x = 0;
    this.model.rotation.set(0, 0, 0);
  }
}

// =============================================================================
// gundrop.js — a gun falling to the ground: it flies, tumbles, clatters,
// skids and comes to rest lying on its side.
//
// Used for the gun a soldier lets go of when he's killed (character.js) and
// the gun you drop when you pick up another one (loot.js). It's RIGID-BODY
// physics cut down to what a dropped gun needs:
//   • gravity, and a spin that turns it end over end while it's in the air;
//   • the floor under it (terrain, or the top of a roof or crate: world.floorBelow)
//     — a hard landing bounces a little, then friction skids it to a stop;
//   • walls: it bounces back off them instead of going through;
//   • the body it fell from (a "capsule", a fat line): it slides off him onto
//     the ground beside him, so it doesn't end up hidden underneath;
//   • on the ground it rolls over onto whichever side it was already turning towards.
//
// FIXED TIME STEP: the simulation always moves in steps of 1/120 s, however
// long the frame took (the leftover time waits for the next frame). Physics
// stepped by the frame time behaves differently at 30 and 144 FPS; fixed
// steps don't, so in co-op every computer drops a gun the same way.
// =============================================================================
import * as THREE from 'three';

const STEP = 1 / 120;
const REST_Y = 0.035;   // lying on its side, the gun's origin (in the receiver) sits this high
const GRAVITY = 9.81;
const FRICTION = 5;     // m/s² of slowing while it skids along the ground (a friction coefficient of ~0.5)
const _w = new THREE.Vector3(), _bar = new THREE.Vector3(), _side = new THREE.Vector3();
const _q = new THREE.Quaternion(), _lie = new THREE.Quaternion(), _e = new THREE.Euler();

export class GunDrop {
  // obj    the gun (an Object3D), already a child of `frame`
  // frame  what it moves in: the scene, or a soldier's root (which only ever turns about y)
  // vel    starting velocity (m/s, in the frame);  spin  angular velocity (rad/s, in the frame)
  // avoid  optional { a, b, r }: the body it fell from, as a capsule on the ground (in the frame)
  constructor(obj, frame, world, { vel, spin, avoid = null }) {
    Object.assign(this, { obj, frame, world, avoid });
    this.vel = vel.clone();
    this.spin = spin.clone();
    this.side = 0;     // which side it lies on: +1 / -1 (picked when it lands)
    this.rest = false; // stopped: nothing more to do
    this.acc = 0;      // time not simulated yet (less than one step)
    this.age = 0;
  }

  // Advance by dt seconds. (A soldier who was already dead when you arrived
  // drops his gun with a single update(10): it's lying there when you first see it.)
  update(dt) {
    if (this.rest) return;
    this.acc += Math.min(dt, 10);
    while (this.acc >= STEP && !this.rest) { this.acc -= STEP; this._step(STEP); }
  }

  // The frame moved (a body sliding down off a ladder): look at the floor again
  wake() { this.rest = false; }

  _step(h) {
    const p = this.obj.position, v = this.vel, frame = this.frame;
    this.age += h;
    v.y -= GRAVITY * h;

    // Sideways first: if that would put it inside a wall, bounce back off it
    const ox = p.x, oz = p.z;
    p.x += v.x * h; p.z += v.z * h;
    if (this._blocked(p)) { p.x = ox; p.z = oz; v.x *= -0.3; v.z *= -0.3; }

    // Then down onto whatever's below it
    p.y += v.y * h;
    _w.copy(p).applyMatrix4(frame.matrixWorld);
    const below = this.world ? this.world.floorBelow(_w.x, _w.y + 0.25, _w.z) : _w.y - p.y; // (no world: the frame's own floor)
    const floor = below - (_w.y - p.y); // in the frame (it never tilts, so heights just shift)
    let grounded = false;
    if (p.y <= floor + REST_Y) {
      p.y = floor + REST_Y;
      grounded = true;
      if (v.y < -1.2) { // a clatter: a small hop, and the spin and slide half gone
        v.y *= -0.22;
        v.x *= 0.6; v.z *= 0.6;
        this.spin.multiplyScalar(0.5);
        grounded = false;
      } else v.y = 0;
    }

    // Lying in the body's footprint: slide out to its side
    if (this.avoid && p.y < floor + 0.45) this._offBody(p, v, h);

    if (grounded) {
      // Friction: a steady slowing until it stops (unlike drag, it really does stop)
      const sp = Math.hypot(v.x, v.z), slow = Math.max(0, sp - FRICTION * h);
      if (sp > 0) { v.x *= slow / sp; v.z *= slow / sp; }
      this._settle(h);
    } else {
      // In the air: tumble
      const w = this.spin, a = w.length();
      if (a > 1e-5) this.obj.quaternion.premultiply(_q.setFromAxisAngle(_bar.copy(w).divideScalar(a), a * h));
    }
  }

  // On the ground: tip over onto its side, barrel level, still spinning a
  // little about the vertical as it skids
  _settle(h) {
    const q = this.obj.quaternion, w = this.spin;
    if (!this.side) { // the side that's already lower is the one it lands on
      _side.set(1, 0, 0).applyQuaternion(q);
      this.side = _side.y > 0 ? 1 : -1;
    }
    w.x *= Math.max(0, 1 - 14 * h); w.z *= Math.max(0, 1 - 14 * h);
    w.y *= Math.max(0, 1 - 5 * h);
    _bar.set(0, 0, -1).applyQuaternion(q); // where the barrel points
    const yaw = Math.atan2(-_bar.x, -_bar.z) + w.y * h;
    _lie.setFromEuler(_e.set(0, yaw, this.side * Math.PI / 2, 'YXZ'));
    q.slerp(_lie, Math.min(1, h * 10));
    const still = Math.hypot(this.vel.x, this.vel.z) < 0.01 && Math.abs(w.y) < 0.05;
    if ((still && q.angleTo(_lie) < 0.02) || this.age > 8) { q.copy(_lie); this.vel.set(0, 0, 0); this.rest = true; }
  }

  // Inside the capsule round the body: push out sideways (a few cm per step, so
  // it slides rather than jumps) and stop it moving further in
  _offBody(p, v, h) {
    const { a, b, r } = this.avoid;
    const abx = b.x - a.x, abz = b.z - a.z, len2 = abx * abx + abz * abz || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2));
    const cx = a.x + abx * t, cz = a.z + abz * t;
    let dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
    if (d >= r) return;
    if (d < 1e-4) { dx = -abz; dz = abx; d = Math.hypot(dx, dz) || 1; } // dead on the centre line: out to one side
    const nx = dx / d, nz = dz / d, push = Math.min(r - d, 4 * h);
    const ox = p.x, oz = p.z;
    p.x += nx * push; p.z += nz * push;
    if (this._blocked(p)) { p.x = ox; p.z = oz; return; } // against a wall: let it lie on him
    const vn = v.x * nx + v.z * nz;
    if (vn < 0) { v.x -= vn * nx; v.z -= vn * nz; }
  }

  _blocked(p) {
    if (!this.world) return false;
    _w.copy(p).applyMatrix4(this.frame.matrixWorld);
    return this.world.boxBlocked(_w.x - 0.05, _w.y + 0.02, _w.z - 0.05, _w.x + 0.05, _w.y + 0.12, _w.z + 0.05);
  }
}

// =============================================================================
// campaign/props.js — the things a mission adds to a map: a laptop, a weapons
// cache, a demolition charge, a radio jammer. And the big bang when a charge
// goes off.
//
// They're built from plain boxes and cylinders, in code, like the guns in
// gunsmith.js. A mission lists them in its `props` (story.js); actions show,
// hide or blow them up. Every computer in a co-op squad builds the same
// props, and the host's mission state says which are visible (see director.js).
//
// The cache and the jammer are solid: they get a collider in the world while
// they exist, so they stop bullets and you can't walk through them.
// =============================================================================
import * as THREE from 'three';

const std = (color, more) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1, ...more });
const MAT = {
  crate: std(0x6b5638), olive: std(0x4a5232), dark: std(0x1d1f1c, { roughness: 0.5, metalness: 0.4 }), grey: std(0x5b5f5c, { metalness: 0.5, roughness: 0.55 }),
  tarp: std(0x3f4a30, { side: THREE.DoubleSide }), steel: std(0x8a8d8c, { metalness: 0.8, roughness: 0.35 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x0b1a26, emissive: 0x3d8fd6, emissiveIntensity: 1.6, roughness: 0.3 }),
  red: new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2010, emissiveIntensity: 0 }),
  green: new THREE.MeshStandardMaterial({ color: 0x003000, emissive: 0x30ff40, emissiveIntensity: 0 }),
};

function box(parent, mat, w, h, d, x, y, z, rx = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
}

// Each builder makes a group standing on y = 0 and returns { group, size: [w, h, d] (collider, or null), light }
const BUILD = {
  // A field laptop sitting open on a supply crate
  laptop(M) {
    const g = new THREE.Group();
    box(g, M.wood || MAT.crate, 0.8, 0.5, 0.55, 0, 0.25, 0);
    box(g, MAT.dark, 0.38, 0.025, 0.27, 0, 0.513, 0.02);
    const screen = box(g, MAT.dark, 0.38, 0.26, 0.015, 0, 0.64, -0.12, -0.25);
    const glow = box(screen, MAT.screen, 0.34, 0.21, 0.004, 0, 0, 0.009); // the lit display, on the lid's face
    glow.castShadow = false;
    return { group: g, size: null, light: null };
  },
  // Crates of stolen weapons under a tarp
  cache(M) {
    const g = new THREE.Group(), wood = M.wood || MAT.crate;
    for (const [x, z] of [[-0.45, -0.32], [0.45, -0.32], [-0.45, 0.32], [0.45, 0.32]]) box(g, wood, 0.86, 0.55, 0.6, x, 0.275, z);
    box(g, MAT.olive, 1.1, 0.4, 0.5, 0.1, 0.75, -0.05);
    box(g, MAT.olive, 0.7, 0.35, 0.45, -0.3, 0.725, 0.3);
    box(g, MAT.tarp, 1.9, 0.03, 1.35, 0, 0.97, 0, 0.05);
    for (const s of [-1, 1]) box(g, MAT.tarp, 1.9, 0.6, 0.03, 0, 0.66, s * 0.67);
    return { group: g, size: [1.9, 1.0, 1.35], light: null };
  },
  // A demolition charge: an olive block, wires and a blinking red light
  charge() {
    const g = new THREE.Group();
    box(g, MAT.olive, 0.3, 0.16, 0.1, 0, 0.55, 0);
    box(g, MAT.dark, 0.1, 0.06, 0.04, 0.05, 0.66, 0.02);
    const led = box(g, MAT.red.clone(), 0.025, 0.025, 0.025, 0.09, 0.66, 0.045);
    return { group: g, size: null, light: led };
  },
  // A radio jammer: a steel cabinet with antennas
  jammer() {
    const g = new THREE.Group();
    box(g, MAT.grey, 0.9, 1.1, 0.55, 0, 0.55, 0);
    box(g, MAT.dark, 0.7, 0.25, 0.02, 0, 0.85, 0.28);
    for (const x of [-0.3, 0, 0.3]) {
      const a = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 1.4, 6), MAT.steel);
      a.position.set(x, 1.8, -0.1);
      g.add(a);
    }
    const led = box(g, MAT.green.clone(), 0.04, 0.04, 0.02, 0.32, 0.98, 0.285);
    return { group: g, size: [0.9, 1.1, 0.55], light: led };
  },
};

export class MissionProps {
  // sys = { scene, world, effects, audio, grenades, M }
  constructor(sys) {
    Object.assign(this, sys);
    this.items = [];   // { id, kind, group, collider, light, pos, visible }
    this.fires = [];   // smoke columns left by explosions { pos, t }
    this.t = 0;
  }

  // Build a mission's props (story.js `props`)
  build(list = []) {
    this.clear();
    for (const p of list) {
      const make = BUILD[p.kind];
      if (!make) { console.warn('Unknown mission prop', p.kind); continue; }
      const { group, size, light } = make(this.M);
      const [x, z, yaw = 0] = p.at;
      const y = p.y ?? this.world.groundHeight(x, z);
      group.position.set(x, y, z);
      group.rotation.y = yaw;
      this.scene.add(group);
      const item = { id: p.id, kind: p.kind, group, size, light, pos: new THREE.Vector3(x, y, z), yaw, collider: null, visible: true };
      this.items.push(item);
      this._setVisible(item, !p.hidden);
    }
  }

  get(id) { return this.items.find((i) => i.id === id) || null; }

  // Visibility as a bitmask (one bit per prop), for the co-op mission state
  get mask() { return this.items.reduce((m, it, i) => m | (it.visible ? 1 << i : 0), 0); }
  set mask(m) { this.items.forEach((it, i) => this._setVisible(it, !!(m & (1 << i)))); }

  show(id, v = true) { const it = this.get(id); if (it) this._setVisible(it, v); }

  _setVisible(it, v) {
    if (it.visible === v) return;
    it.visible = v;
    it.group.visible = v;
    if (it.size && v && !it.collider) {
      // An axis-aligned box: turned 90°, swap width and depth
      const [w, h, d] = it.size, turned = Math.abs(Math.sin(it.yaw)) > 0.7;
      const hx = (turned ? d : w) / 2, hz = (turned ? w : d) / 2;
      it.collider = this.world.add(new THREE.Vector3(it.pos.x - hx, it.pos.y, it.pos.z - hz), new THREE.Vector3(it.pos.x + hx, it.pos.y + h, it.pos.z + hz),
        { surface: 'wood', pen: 0.6, cover: true });
    } else if (!v && it.collider) {
      const i = this.world.colliders.indexOf(it.collider);
      if (i >= 0) this.world.colliders.splice(i, 1);
      it.collider = null;
    }
  }

  // A demolition charge on this prop goes off: three blasts close together,
  // so it sounds and looks bigger than a grenade, then a column of smoke. The
  // blasts are real grenade explosions (grenades.js): anyone too close is hurt.
  boom(id) {
    const it = this.get(id);
    const pos = (it ? it.pos : new THREE.Vector3()).clone().setY((it?.pos.y || 0) + 0.6);
    if (it) this._setVisible(it, false);
    const blast = (dx, dz) => this.grenades?.explode({ pos: pos.clone().add(new THREE.Vector3(dx, 0, dz)), kind: 'frag', team: 'player', shooter: null });
    blast(0, 0);
    setTimeout(() => blast(0.8, -0.5), 140);
    setTimeout(() => blast(-0.7, 0.6), 330);
    this.fires.push({ pos, t: 0 });
  }

  // Every frame, on every computer: blinking lights, smoke from wrecks
  update(dt) {
    this.t += dt;
    for (const it of this.items) {
      if (!it.light || !it.visible) continue;
      const fast = it.kind === 'charge';
      it.light.material.emissiveIntensity = Math.sin(this.t * (fast ? 14 : 4)) > (fast ? 0 : 0.6) ? 4 : 0;
    }
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.t += dt;
      if (f.t > 75) { this.fires.splice(i, 1); continue; }
      f.acc = (f.acc || 0) + dt;
      const every = f.t < 20 ? 0.25 : 0.6;
      while (f.acc > every) { f.acc -= every; this.effects.smokePuff(f.pos, 1.2); }
    }
  }

  clear() {
    for (const it of this.items) {
      this._setVisible(it, false);
      this.scene.remove(it.group);
      it.group.traverse((o) => o.geometry?.dispose());
    }
    this.items = [];
    this.fires = [];
  }
}

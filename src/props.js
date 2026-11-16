// =============================================================================
// props.js — places glTF models (crates, barrels, barriers, sandbags...).
//
// Maps call add('Barrel_01', x, z, {...}) as many times as they like; nothing
// is drawn until finalize(), which turns every placement of the same model
// into ONE InstancedMesh per sub-mesh. 300 barrels = a couple of draw calls.
// Each placement also registers a collision box so you can hide behind it.
// =============================================================================
import * as THREE from 'three';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

export class Props {
  constructor(scene, world, assets, rand = Math.random) {
    this.scene = scene;
    this.world = world;
    this.assets = assets;
    this.rand = rand;
    this.defs = new Map();
    this.placed = new Map();
  }

  // texCap: models listed here get their textures shrunk to this size (px).
  // A 1024² texture costs ~5 MB of GPU memory with mipmaps; a vase or a chair
  // never fills enough of the screen to need it, so 512² (4x smaller) looks
  // the same and keeps memory and loading hitches down.
  async load(ids, { texCap = {} } = {}) {
    await Promise.all(ids.map((id) => this._define(id, texCap[id])));
  }

  async _define(id, cap) {
    if (this.defs.has(id)) return this.defs.get(id);
    const gltf = await this.assets.model(id);
    if (cap) await shrinkTextures(gltf.scene, cap);
    gltf.scene.updateMatrixWorld(true);
    const parts = [], box = new THREE.Box3();
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      parts.push({ geometry: o.geometry, material: o.material, matrix: o.matrixWorld.clone() });
      box.expandByObject(o);
    });
    // Normalise: centred on x/z, resting on y = 0
    const fix = new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    for (const p of parts) p.matrix.premultiply(fix);
    const def = { id, parts, size: box.getSize(new THREE.Vector3()) };
    this.defs.set(id, def);
    return def;
  }

  size(id) { return this.defs.get(id).size; }

  // opts: y (default = ground), rotY, scale (number or [x,y,z]), tilt [x,z], collide, cover, pen, surface, shadow
  add(id, x, z, opts = {}) {
    const def = this.defs.get(id);
    if (!def) throw new Error(`Prop not loaded: ${id}`);
    const y = opts.y ?? this.world.groundHeight(x, z);
    const sc = Array.isArray(opts.scale) ? opts.scale : [opts.scale ?? 1, opts.scale ?? 1, opts.scale ?? 1];
    _e.set(opts.tilt?.[0] || 0, opts.rotY || 0, opts.tilt?.[1] || 0);
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(sc[0], sc[1], sc[2]));
    if (!this.placed.has(id)) this.placed.set(id, []);
    this.placed.get(id).push({ matrix: _m.clone(), shadow: opts.shadow ?? true });

    if (opts.collide !== false) {
      const b = new THREE.Box3(new THREE.Vector3(-def.size.x / 2, 0, -def.size.z / 2), new THREE.Vector3(def.size.x / 2, def.size.y, def.size.z / 2)).applyMatrix4(_m);
      // The box is for walking into; bullets and sight lines also test the model's
      // real triangles (world.js "two-phase ray tests"), so a shot only hits what you see
      this.world.add(b.min, b.max, { cover: !!opts.cover, pen: opts.pen ?? Infinity, surface: opts.surface || 'wood', shape: this._shape(def, _m) });
    }
    return def.size.y * sc[1];
  }

  // A sandbag wall between two points on an axis-aligned line, laid like
  // bricks from individual sack models. layers ≈ 0.16 m each.
  sandbags(x0, z0, x1, z1, { layers = 6, y } = {}) {
    const def = this.defs.get('cement_bag');
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    const len = alongX ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
    const pitch = def.size.x * 0.92, rowH = def.size.y * 0.82;
    const ax = Math.min(x0, x1), az = Math.min(z0, z1);
    const base = y ?? Math.min(this.world.groundHeight(x0, z0), this.world.groundHeight(x1, z1), this.world.groundHeight((x0 + x1) / 2, (z0 + z1) / 2));
    const r = this.rand, bags = this.placed.get('cement_bag')?.length || 0;
    for (let l = 0; l < layers; l++) {
      const off = (l % 2) * pitch * 0.5;
      const n = Math.floor((len - off) / pitch + 0.001);
      for (let i = 0; i < n; i++) {
        const t = off + pitch * (i + 0.5);
        const x = alongX ? ax + t : x0, z = alongX ? z0 : az + t;
        this.add('cement_bag', x + (r() - 0.5) * 0.03, z + (r() - 0.5) * 0.05, {
          y: base + l * rowH - 0.02, rotY: (alongX ? 0 : Math.PI / 2) + (r() - 0.5) * 0.12,
          scale: [0.97 + r() * 0.08, 0.9 + r() * 0.2, 0.95 + r() * 0.1], tilt: [(r() - 0.5) * 0.06, (r() - 0.5) * 0.06], collide: false,
        });
      }
    }
    const t = def.size.z / 2, top = base + layers * rowH + def.size.y * 0.2;
    const min = alongX ? new THREE.Vector3(ax, base, z0 - t) : new THREE.Vector3(x0 - t, base, az);
    const max = alongX ? new THREE.Vector3(ax + len, top, z0 + t) : new THREE.Vector3(x0 + t, top, az + len);
    // one box for the wall, but every sack's real shape for bullets: shots skim the rounded top
    const shape = this.placed.get('cement_bag').slice(bags).flatMap((it) => this._shape(def, it.matrix));
    this.world.add(min, max, { cover: true, surface: 'sand', shape });
  }

  // A placed model's triangles, for the world's narrow-phase ray tests
  _shape(def, placement) {
    return def.parts.map((p) => ({ geometry: p.geometry, matrix: new THREE.Matrix4().multiplyMatrices(placement, p.matrix) }));
  }

  // One InstancedMesh per model part — two if some placements asked for
  // shadow: false (furniture indoors, where the sun never reaches anyway, so
  // drawing it into the shadow map would be wasted work).
  finalize() {
    for (const [id, all] of this.placed) {
      const def = this.defs.get(id);
      for (const shadow of [true, false]) {
        const list = all.filter((it) => it.shadow === shadow);
        if (!list.length) continue;
        for (const part of def.parts) {
          const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
          list.forEach((it, i) => im.setMatrixAt(i, _m.multiplyMatrices(it.matrix, part.matrix)));
          im.instanceMatrix.needsUpdate = true;
          im.computeBoundingSphere();
          im.castShadow = shadow;
          im.receiveShadow = true;
          this.scene.add(im);
        }
      }
    }
  }
}

// Downscale every texture of a loaded model to at most `cap` pixels wide.
async function shrinkTextures(root, cap) {
  const done = new Set();
  const jobs = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const mat of [o.material].flat()) {
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        const tex = mat[key];
        const img = tex?.image;
        if (!img || done.has(tex) || !(img.width > cap)) continue;
        done.add(tex);
        const k = cap / Math.max(img.width, img.height);
        jobs.push(createImageBitmap(img, {
          resizeWidth: Math.round(img.width * k), resizeHeight: Math.round(img.height * k),
          resizeQuality: 'medium', premultiplyAlpha: 'none',
        }).then((small) => { tex.image = small; tex.needsUpdate = true; }).catch(() => { /* keep full size */ }));
      }
    }
  });
  await Promise.all(jobs);
}

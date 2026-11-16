// =============================================================================
// builder.js — reusable "prefabs" for building maps.
//
// Level designers rarely place raw boxes; they place prefabs (a building, a
// tower, a sandbag wall) that build their own visuals AND their own collision
// so the two never disagree. Materials (M) are photo-scanned PBR sets chosen
// per map; small objects (crates, barrels, sandbags) come from props.js.
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxGeo } from './textures.js';
import { addLadder } from './ladder.js';

// "World-space" UVs: texture coordinates come from where each vertex IS in the
// world (in metres / tile size), not from 0..1 per box. A wall built from many
// boxes (pieces between windows and doors) then shows ONE continuous texture
// with no seams or jumps at each piece — the same trick as "world-aligned
// textures" in Unreal or triplanar mapping. Each face reads the two world axes
// that lie flat on it (a +x face uses z and y, a +y face uses x and z...).
function worldUV(geo, cx, cy, cz, tile) {
  const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx, y = pos.getY(i) + cy, z = pos.getZ(i) + cz;
    const ax = Math.abs(nor.getX(i)), ay = Math.abs(nor.getY(i));
    if (ax > 0.5) uv.setXY(i, z / tile, y / tile);
    else if (ay > 0.5) uv.setXY(i, x / tile, z / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  uv.needsUpdate = true;
}

export class Builder {
  // M: materials by role { wall, floor, roof, trim, wood, metal, container: [..], canvas, concrete, glass }
  constructor(scene, world, M, props, rand) {
    Object.assign(this, { scene, world, M, props, rand });
    this.animated = [];
    this.statics = [];
    this.buildings = []; // a record of every building() — decor.js reads it to furnish and dress them
  }

  add(mesh, shadows = true, isStatic = true) {
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    if (isStatic) this.statics.push(mesh);
    return mesh;
  }

  // Merge every static piece that shares a material into ONE mesh. A town of
  // thousands of wall segments becomes a few dozen draw calls — the same idea
  // as "static batching" in Unity or merged actors in Unreal.
  finalize() {
    const groups = new Map();
    for (const m of this.statics) {
      const key = `${m.material.uuid}|${m.castShadow}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const geos = list.map((m) => {
        m.updateMatrixWorld(true);
        const g = m.geometry.index ? m.geometry.clone() : m.geometry.clone();
        g.applyMatrix4(m.matrixWorld);
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
        return g.index ? g : g;
      });
      const indexed = geos.every((g) => g.index), plain = geos.every((g) => !g.index);
      if (!indexed && !plain) continue;
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, list[0].material);
      mesh.castShadow = list[0].castShadow;
      mesh.receiveShadow = true;
      for (const m of list) this.scene.remove(m);
      this.scene.add(mesh);
    }
    this.statics.length = 0;
  }

  // Axis-aligned box. (x, z) = centre, y = BOTTOM. opts: collide, cover, pen, surface, castShadow
  box(x, y, z, w, h, d, mat, opts = {}) {
    const geo = boxGeo(w, h, d, mat.userData.tile || 1);
    worldUV(geo, x, y + h / 2, z, mat.userData.tile || 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y + h / 2, z);
    this.add(mesh, opts.castShadow ?? true);
    if (opts.collide !== false) this.world.addMesh(mesh, { pen: opts.pen, cover: opts.cover, surface: opts.surface });
    return mesh;
  }

  // Straight wall from a0 to a1 along `axis`, with door/window holes.
  // opening = { at, w, bottom, top } along the wall. frame = material for frames (optional).
  wall(axis, a0, a1, fixed, thick, y0, height, mat, openings = [], opts = {}) {
    const seg = (s, e, b, t) => {
      if (e - s < 0.01 || t - b < 0.01) return;
      const len = e - s, c = (s + e) / 2;
      if (axis === 'x') this.box(c, y0 + b, fixed, len, t - b, thick, mat, opts);
      else this.box(fixed, y0 + b, c, thick, t - b, len, mat, opts);
    };
    let cur = a0;
    for (const o of [...openings].sort((p, q) => p.at - q.at)) {
      const s = o.at - o.w / 2, e = o.at + o.w / 2;
      seg(cur, s, 0, height);
      if (o.bottom > 0) seg(s, e, 0, o.bottom);
      if (o.top < height) seg(s, e, o.top, height);
      cur = e;
      if (opts.frame) this._frame(axis, o, fixed, thick, y0, opts.frame);
    }
    seg(cur, a1, 0, height);
  }

  // Wooden/metal frame around an opening + a sill under windows (visual only).
  _frame(axis, o, fixed, thick, y0, mat) {
    const f = 0.07, d = thick + 0.06;
    const piece = (along, w, b, h) => (axis === 'x'
      ? this.box(along, y0 + b, fixed, w, h, d, mat, { collide: false })
      : this.box(fixed, y0 + b, along, d, h, w, mat, { collide: false }));
    piece(o.at - o.w / 2 + f / 2, f, o.bottom, o.top - o.bottom);
    piece(o.at + o.w / 2 - f / 2, f, o.bottom, o.top - o.bottom);
    piece(o.at, o.w, o.top - f, f);
    if (o.bottom > 0) {
      const sill = axis === 'x'
        ? this.box(o.at, y0 + o.bottom - 0.05, fixed, o.w + 0.16, 0.05, thick + 0.16, mat, { collide: false })
        : this.box(fixed, y0 + o.bottom - 0.05, o.at, thick + 0.16, 0.05, o.w + 0.16, mat, { collide: false });
      sill.castShadow = true;
    }
  }

  // Building with 1–2 floors. doors/windows: { n:[...], s:[...], e:[...], w:[...] }
  // (n/s take x positions, e/w take z). Upper floors repeat the window layout.
  // stairs (2 floors): { x, z, dir: 'x'|'z' } = where the staircase starts, climbing toward +dir.
  building(o) {
    const { x0, x1, z0, z1, y0 = 0, h = 3.3, floors = 1, thick = 0.3, doors = {}, windows = {}, interior = [], stairs, roof: hasRoof = true } = o;
    const parapet = hasRoof ? (o.parapet ?? 0.9) : 0;
    const wallH = o.wallHeights; // optional per-side heights for ruins: { n, s, e, w }
    const wallMat = o.wall || this.M.wall, frameMat = o.frame ?? this.M.trim;
    const door = (d) => (typeof d === 'number' ? { at: d, w: 1.4, bottom: 0, top: 2.2 } : { w: 1.4, bottom: 0, top: 2.2, ...d });
    const win = (at) => ({ at, w: 1.2, bottom: 0.95, top: 2.1 });
    const t2 = thick / 2;
    const wallOpts = { ...(o.wallOpts || {}), frame: frameMat };
    for (let f = 0; f < floors; f++) {
      const fy = y0 + f * h;
      const ops = (side) => [...(f === 0 ? (doors[side] || []).map(door) : []), ...(windows[side] || []).map(win)];
      const hh = (side) => (wallH ? wallH[side] : h);
      this.wall('x', x0, x1, z0 + t2, thick, fy, hh('n'), wallMat, ops('n'), wallOpts);
      this.wall('x', x0, x1, z1 - t2, thick, fy, hh('s'), wallMat, ops('s'), wallOpts);
      this.wall('z', z0 + thick, z1 - thick, x0 + t2, thick, fy, hh('w'), wallMat, ops('w'), wallOpts);
      this.wall('z', z0 + thick, z1 - thick, x1 - t2, thick, fy, hh('e'), wallMat, ops('e'), wallOpts);
    }
    for (const iw of interior) this.wall(iw.axis, iw.a0, iw.a1, iw.fixed, 0.2, y0, h, wallMat, (iw.doors || []).map(door), { frame: frameMat });

    // Floors: ground-floor finish, upper slabs (with a stairwell hole), roof + parapet
    const ix0 = x0 + thick, ix1 = x1 - thick, iz0 = z0 + thick, iz1 = z1 - thick;
    this.box((ix0 + ix1) / 2, y0, (iz0 + iz1) / 2, ix1 - ix0, 0.03, iz1 - iz0, this.M.floor, { collide: false, castShadow: false });
    this.world.addFloor?.(ix0, iz0, ix1, iz1, y0, this.M.floor.userData.surface); // so footsteps hear the floor, not the dirt under it
    let hole = null;
    if (floors > 1 && stairs) hole = this._stairs(stairs, y0, h);
    for (let f = 1; f <= (hasRoof ? floors : floors - 1); f++) {
      const sy = y0 + f * h - 0.22;
      const roof = f === floors;
      const mat = roof ? this.M.roof : this.M.floor;
      // Upper floors stop 2 cm inside the outer wall face: if the slab's edge
      // sat exactly ON the wall surface, the two would flicker against each
      // other ("z-fighting") and show a grey stripe around the building.
      const e = 0.02;
      if (!roof && hole) this._slabWithHole(x0 + e, x1 - e, z0 + e, z1 - e, sy, 0.22, mat, hole);
      else if (!roof) this.box((x0 + x1) / 2, sy, (z0 + z1) / 2, x1 - x0 - 2 * e, 0.22, z1 - z0 - 2 * e, mat);
      else this.box((x0 + x1) / 2, sy, (z0 + z1) / 2, x1 - x0 + 0.2, 0.25, z1 - z0 + 0.2, mat);
      // A "string course": the stone band real builders run along the facade
      // where each floor meets the next. Visual only.
      if (!roof && this.M.band && !wallH) {
        const bm = this.M.band, by = y0 + f * h - 0.24, bt = 0.06;
        this.box((x0 + x1) / 2, by, z0, x1 - x0 + bt * 2, 0.2, bt * 2, bm, { collide: false });
        this.box((x0 + x1) / 2, by, z1, x1 - x0 + bt * 2, 0.2, bt * 2, bm, { collide: false });
        this.box(x0, by, (z0 + z1) / 2, bt * 2, 0.2, z1 - z0, bm, { collide: false });
        this.box(x1, by, (z0 + z1) / 2, bt * 2, 0.2, z1 - z0, bm, { collide: false });
      }
    }
    // Roof ladders: ladder: { side: 'n'|'s'|'e'|'w', at } (or a list of them).
    // The ladder runs up the OUTSIDE of that wall, through a gap in the parapet.
    const ladders = hasRoof && !wallH ? [].concat(o.ladder || []) : [];
    if (parapet > 0) {
      const ry = y0 + floors * h;
      const gap = (side) => ladders.filter((l) => l.side === side).map((l) => ({ at: l.at, w: 1.0, bottom: 0, top: parapet }));
      this.wall('x', x0 - 0.1, x1 + 0.1, z0 + 0.05, 0.2, ry, parapet, wallMat, gap('n'));
      this.wall('x', x0 - 0.1, x1 + 0.1, z1 - 0.05, 0.2, ry, parapet, wallMat, gap('s'));
      this.wall('z', z0 + 0.15, z1 - 0.15, x0 + 0.05, 0.2, ry, parapet, wallMat, gap('w'));
      this.wall('z', z0 + 0.15, z1 - 0.15, x1 - 0.05, 0.2, ry, parapet, wallMat, gap('e'));
    }
    if (ladders.length) {
      // The roof is a "deck" the AI can walk on once it has climbed up (nav.js)
      const deck = { minX: x0, maxX: x1, minZ: z0, maxZ: z1, y: y0 + floors * h + 0.03 };
      for (const l of ladders) {
        const [nx, nz] = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] }[l.side];
        const fx = l.side === 'w' ? x0 : l.side === 'e' ? x1 : l.at;   // a point on the outer wall face
        const fz = l.side === 'n' ? z0 : l.side === 's' ? z1 : l.at;
        const gy = this.world.groundHeight(fx + nx * 0.5, fz + nz * 0.5);
        addLadder(this, { x: fx, z: fz, nx, nz, y0: Math.min(y0, gy), y1: deck.y, deck, wallThick: thick });
      }
    }
    // Dark plinth along the base: real buildings get dirty where they meet the ground
    if (this.M.plinth) {
      const pm = this.M.plinth;
      this.box((x0 + x1) / 2, y0 - 0.3, z0 - 0.01, x1 - x0 + 0.06, 0.6, 0.06, pm, { collide: false, castShadow: false });
      this.box((x0 + x1) / 2, y0 - 0.3, z1 + 0.01, x1 - x0 + 0.06, 0.6, 0.06, pm, { collide: false, castShadow: false });
      this.box(x0 - 0.01, y0 - 0.3, (z0 + z1) / 2, 0.06, 0.6, z1 - z0, pm, { collide: false, castShadow: false });
      this.box(x1 + 0.01, y0 - 0.3, (z0 + z1) / 2, 0.06, 0.6, z1 - z0, pm, { collide: false, castShadow: false });
    }

    // Remember what was built (openings per side and floor, stairs, roof) so
    // decor.js can later add doors, shutters, furniture... without guessing.
    const openings = {};
    for (const side of ['n', 's', 'e', 'w']) {
      openings[side] = [];
      for (let f = 0; f < floors; f++) {
        if (f === 0) for (const d of (doors[side] || []).map(door)) openings[side].push({ ...d, floor: 0, door: true });
        for (const at of windows[side] || []) openings[side].push({ ...win(at), floor: f, door: false });
      }
    }
    const desc = { ...o, x0, x1, z0, z1, y0, h, floors, thick, parapet, hasRoof, ruined: !!wallH, openings, stairsHole: hole, interior };
    this.buildings.push(desc);
    return desc;
  }

  // Straight staircase climbing one floor. Returns the hole to cut in the slab above.
  _stairs({ x, z, dir = 'x', width = 1.2 }, y0, h) {
    const n = Math.ceil(h / 0.21), rise = h / n, run = 0.28;
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) * run, top = (i + 1) * rise;
      if (dir === 'x') this.box(x + a, y0, z, run, top, width, this.M.concrete);
      else this.box(x, y0, z + a, width, top, run, this.M.concrete);
    }
    const L = n * run;
    return dir === 'x' ? { minX: x - 0.2, maxX: x + L, minZ: z - width / 2, maxZ: z + width / 2 } : { minX: x - width / 2, maxX: x + width / 2, minZ: z - 0.2, maxZ: z + L };
  }

  _slabWithHole(x0, x1, z0, z1, y, t, mat, hole) {
    const parts = [
      [x0, x1, z0, hole.minZ], [x0, x1, hole.maxZ, z1],
      [x0, hole.minX, hole.minZ, hole.maxZ], [hole.maxX, x1, hole.minZ, hole.maxZ],
    ];
    for (const [a0, a1, b0, b1] of parts) {
      if (a1 - a0 > 0.01 && b1 - b0 > 0.01) this.box((a0 + a1) / 2, y, (b0 + b1) / 2, a1 - a0, t, b1 - b0, mat);
    }
  }

  // A wall of vertical logs (one InstancedMesh) with gate gaps. gaps = centres of 5 m openings.
  palisade(axis, a0, a1, fixed, y0, h, mat, gaps = []) {
    const r = 0.17, step = r * 1.9, rnd = this.rand;
    const segs = [];
    let cur = a0;
    for (const at of [...gaps].sort((p, q) => p - q)) { segs.push([cur, at - 2.5]); cur = at + 2.5; }
    segs.push([cur, a1]);
    const geo = new THREE.CylinderGeometry(r * 0.92, r * 1.05, 1, 10);
    geo.translate(0, 0.5, 0);
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * 2.5); // bark repeats up the log
    const mats = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
    for (const [a, b] of segs) {
      if (b - a < 0.2) continue;
      for (let t = a + r; t <= b - r; t += step) {
        const x = axis === 'x' ? t : fixed + (rnd() - 0.5) * 0.05, z = axis === 'x' ? fixed + (rnd() - 0.5) * 0.05 : t;
        const gy = Math.min(y0, this.world.groundHeight(x, z)) - 0.4;
        e.set((rnd() - 0.5) * 0.04, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.04);
        m.compose(p.set(x, gy, z), q.setFromEuler(e), s.set(0.9 + rnd() * 0.25, y0 - gy + h + (rnd() - 0.5) * 0.4, 0.9 + rnd() * 0.25));
        mats.push(m.clone());
      }
      const lo = axis === 'x' ? new THREE.Vector3(a, y0 - 1, fixed - r) : new THREE.Vector3(fixed - r, y0 - 1, a);
      const hi = axis === 'x' ? new THREE.Vector3(b, y0 + h, fixed + r) : new THREE.Vector3(fixed + r, y0 + h, b);
      this.world.add(lo, hi, { surface: 'wood', pen: 1.2 });
    }
    const im = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((mm, i) => im.setMatrixAt(i, mm));
    im.computeBoundingSphere();
    im.castShadow = im.receiveShadow = true;
    this.scene.add(im);
  }

  // Guard tower with stairs and a sandbagged platform. stairDir = -1 / +1 (x side).
  tower(cx, cz, stairDir, y0 = 0) {
    const M = this.M, half = 1.6, top = y0 + 4.5, rt = 0.3;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      this.box(cx + sx * (half - 0.15), y0 - 0.3, cz + sz * (half - 0.15), 0.25, top - y0 + 0.1, 0.25, M.wood);
      this.box(cx + sx * (half - 0.1), top, cz + sz * (half - 0.1), 0.12, 2.4, 0.12, M.wood);
    }
    this.box(cx, top - 0.2, cz, half * 2, 0.2, half * 2, M.wood);
    // sandbag parapet (gap where the stairs arrive)
    const e = half - 0.35;
    this.props.sandbags(cx - e, cz - e, cx + e, cz - e, { layers: 6, y: top });
    this.props.sandbags(cx - e, cz + e, cx + e, cz + e, { layers: 6, y: top });
    this.props.sandbags(cx - stairDir * e, cz - e + 0.3, cx - stairDir * e, cz + e - 0.3, { layers: 6, y: top });
    this.props.sandbags(cx + stairDir * e, cz - e + 0.3, cx + stairDir * e, cz - 0.7, { layers: 6, y: top });
    this.props.sandbags(cx + stairDir * e, cz + 0.7, cx + stairDir * e, cz + e - 0.3, { layers: 6, y: top });
    this.box(cx, top + 2.4, cz, half * 2 + 0.6, 0.1, half * 2 + 0.6, M.roofMetal || M.metal);
    const n = 18, rise = (top - y0) / n, run = 0.35, edge = cx + stairDir * half;
    for (let i = 0; i < n; i++) {
      this.box(edge + stairDir * (n - i - 0.5) * run, y0 - 0.3, cz, run, (i + 1) * rise + 0.3, 1.2, M.wood);
    }
    return new THREE.Vector3(cx, top, cz);
  }

  // Military cargo truck (procedural). alongX: length runs along x; cab toward -length.
  truck(x, z, alongX, y0 = this.world.groundHeight(x, z)) {
    const M = this.M;
    const place = (l, y, w, h, len, mat, opts) => (alongX ? this.box(x + l, y0 + y, z, len, h, w, mat, opts) : this.box(x, y0 + y, z + l, w, h, len, mat, opts));
    place(-2.7, 0.55, 2.3, 1.9, 1.8, M.metal);
    place(-3.62, 1.5, 1.9, 0.75, 0.04, M.glass, { collide: false });
    place(0.4, 0.55, 2.4, 0.35, 4.6, M.metal);
    place(0.4, 0.9, 2.4, 1.9, 4.6, M.canvas, { pen: 0.1, surface: 'cloth' });
    const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.35, 20);
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.92 });
    for (const l of [-2.7, 0.2, 1.6]) for (const s of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, rubber);
      if (alongX) { w.rotation.x = Math.PI / 2; w.position.set(x + l, y0 + 0.5, z + s * 1.05); }
      else { w.rotation.z = Math.PI / 2; w.position.set(x + s * 1.05, y0 + 0.5, z + l); }
      this.add(w);
    }
  }

  // Canvas tent: triangular prism along z.
  tent(x, z, w = 4, len = 6, h = 2.6) {
    const y0 = this.world.groundHeight(x, z);
    const geo = new THREE.CylinderGeometry(1, 1, len, 3, 1);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this.M.canvas);
    mesh.scale.set(w / 1.732, h / 1.5, 1);
    mesh.position.set(x, y0 + (0.5 * h) / 1.5, z);
    this.add(mesh);
    this.world.add(new THREE.Vector3(x - w / 2, y0, z - len / 2), new THREE.Vector3(x + w / 2, y0 + h * 0.75, z + len / 2), { surface: 'cloth', pen: 0.05 });
  }

  container(x, z, alongX, color = 0, y) {
    const mats = this.M.containers;
    const mat = mats[color % mats.length];
    const y0 = y ?? this.world.groundHeight(x, z);
    return alongX ? this.box(x, y0, z, 6.06, 2.59, 2.44, mat, { pen: 0.6, surface: 'metal' }) : this.box(x, y0, z, 2.44, 2.59, 6.06, mat, { pen: 0.6, surface: 'metal' });
  }

  rubble(x, z, count) {
    const r = this.rand, y0 = this.world.groundHeight(x, z);
    for (let i = 0; i < count; i++) {
      const s = 0.25 + r() * 0.55;
      const m = this.box(x + (r() - 0.5) * 3, y0 - 0.1, z + (r() - 0.5) * 3, s * 1.4, s * 0.7, s, this.M.concrete, { collide: s * 0.7 > 0.3 });
      m.rotation.set((r() - 0.5) * 0.5, r() * Math.PI, (r() - 0.5) * 0.5);
    }
  }

  // Flag that waves in the wind (vertices animated each frame).
  flag(x, z, colors = ['#2f3524', '#7a1f1a', '#d8d2bd']) {
    const y0 = this.world.groundHeight(x, z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 8, 10), this.M.metal);
    pole.position.set(x, y0 + 4, z);
    this.add(pole);
    this.world.add(new THREE.Vector3(x - 0.1, y0, z - 0.1), new THREE.Vector3(x + 0.1, y0 + 8, z + 0.1), { surface: 'metal' });
    const c = document.createElement('canvas');
    c.width = 160; c.height = 100;
    const g = c.getContext('2d');
    g.fillStyle = colors[0]; g.fillRect(0, 0, 160, 100);
    g.fillStyle = colors[1]; g.fillRect(0, 38, 160, 24);
    g.fillStyle = colors[2]; g.beginPath(); g.moveTo(0, 0); g.lineTo(55, 50); g.lineTo(0, 100); g.fill();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(1.6, 1.0, 16, 8);
    geo.translate(0.8, 0, 0);
    const base = geo.attributes.position.array.slice();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 1 }));
    mesh.position.set(x + 0.05, y0 + 7.4, z);
    this.add(mesh, true, false);
    const pos = geo.attributes.position;
    this.animated.push((t) => {
      for (let i = 0; i < pos.count; i++) {
        const bx = base[i * 3], by = base[i * 3 + 1], k = bx / 1.6;
        pos.setZ(i, Math.sin(bx * 4 - t * 7 + by * 1.5) * 0.12 * k + Math.sin(bx * 9 - t * 11) * 0.03 * k);
        pos.setY(i, by - k * k * 0.08);
      }
      pos.needsUpdate = true;
      geo.computeVertexNormals();
    });
  }
}

// Auto-generate spots where a soldier can crouch behind low cover. Each spot
// stores the outward normal: the cover protects against threats from the
// OPPOSITE side.
export function computeCoverPoints(world) {
  const pts = [], off = 0.6;
  const along = (len) => { const n = Math.max(1, Math.round(len / 1.6)); return Array.from({ length: n }, (_, i) => (i + 0.5) / n); };
  for (const c of world.colliders) {
    if (!c.cover) continue;
    const sx = c.max.x - c.min.x, sz = c.max.z - c.min.z;
    const spot = (x, z, nx, nz) => {
      const g = world.groundHeight(x, z), h = c.max.y - g;
      if (h > 0.8 && h < 1.5 && c.min.y < g + 0.2) pts.push({ pos: new THREE.Vector3(x, g, z), normal: new THREE.Vector3(nx, 0, nz) });
    };
    for (const t of along(sx)) { const x = c.min.x + sx * t; spot(x, c.min.z - off, 0, -1); spot(x, c.max.z + off, 0, 1); }
    for (const t of along(sz)) { const z = c.min.z + sz * t; spot(c.min.x - off, z, -1, 0); spot(c.max.x + off, z, 1, 0); }
  }
  return pts;
}

// =============================================================================
// world.js — the collision world.
//
// Rendering and physics are separate. What you SEE is triangles; what you
// COLLIDE with is (a) a list of axis-aligned boxes (AABBs) for buildings and
// props, and (b) the terrain heightfield. Quake did the same split with its BSP
// "clip hulls"; modern engines use simplified collision meshes.
//
// TWO-PHASE RAY TESTS (bullets, sight lines, grenades): a box only
// approximates a prop. A concrete barrier is narrower at the top than the
// bottom, a sandbag wall has a rounded top, a barrel is round, and a box
// round a turned crate is bigger than the crate. So a collider can carry the
// prop's real SHAPE (its triangles). The cheap box test runs first (the
// "broad phase"); only when a ray enters a box with a shape is it tested
// against those triangles (the "narrow phase"), and it only counts if it
// touches what you can see. Walking still uses the boxes: they're cheaper,
// and nobody notices a few centimetres of air at a barrier's edge with their feet.
// =============================================================================
import * as THREE from 'three';

const _ray = new THREE.Ray(), _local = new THREE.Ray(), _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tc = new THREE.Vector3();
const _hit = new THREE.Vector3(), _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3(), _sn = new THREE.Vector3(), _losDir = new THREE.Vector3();

const EPS = 0.0005;
const MAX_WALK_SLOPE = 1.25; // rise/run (~51°) — steeper hillsides can't be climbed

export class World {
  constructor() {
    this.colliders = [];
    this.terrain = null;
    this._scratch = [];
    this.smokes = [];  // smoke screens { pos, r } (filled by grenades.js)
    this.ladders = []; // climbable ladders (ladder.js) — not colliders, a movement mode
    this.decks = [];   // raised walkable areas the ladders lead to (roofs), for the AI's nav
    this.floors = [];  // floor finishes with no collider (you walk on the terrain under them) — for footstep sounds
  }

  // A floor you can't collide with (e.g. a building's ground floor, laid
  // over the terrain) but whose surface you should HEAR when walking on it.
  addFloor(x0, z0, x1, z1, y, surface) {
    if (surface) this.floors.push({ x0, z0, x1, z1, y, surface });
  }

  // Is (x, z) within r metres of a ladder's foot, its climbing line or its
  // landing on the roof? Map decoration uses this to keep ladders clear.
  nearLadder(x, z, r = 1) {
    for (const L of this.ladders) {
      for (const p of [L.foot, L.top]) if (Math.hypot(x - p.x, z - p.z) < r) return L;
      if (Math.hypot(x - L.cx, z - L.cz) < r) return L;
    }
    return null;
  }

  // pen = penetration cost (Infinity = bulletproof). cover = AI may hide behind it.
  // shape = the thing's real triangles for ray tests: [{ geometry, matrix (its world matrix) }]
  add(min, max, opts = {}) {
    const c = {
      min: min.clone(),
      max: max.clone(),
      surface: opts.surface || 'concrete',
      pen: opts.pen ?? Infinity,
      cover: !!opts.cover,
      solid: opts.solid ?? true, // false = blocks movement only (invisible map edge)
      shape: opts.shape || null,
    };
    this.colliders.push(c);
    return c;
  }

  addMesh(mesh, opts = {}) {
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    const surface = opts.surface || mesh.material?.userData?.surface;
    // An unturned box IS its own collider; anything else keeps its real shape for bullets
    const e = mesh.matrixWorld.elements, square = Math.abs(e[1]) + Math.abs(e[2]) + Math.abs(e[4]) + Math.abs(e[6]) + Math.abs(e[8]) + Math.abs(e[9]) < 1e-4;
    const exact = mesh.geometry?.type === 'BoxGeometry' && square;
    return this.add(box.min, box.max, { ...opts, surface, shape: exact ? null : [{ geometry: mesh.geometry, matrix: mesh.matrixWorld.clone() }] });
  }

  // The box rays are tested against: for a collider with a shape, big enough
  // to hold all of the shape too (a rock can bulge a little past its walking box)
  _rayBounds(c) {
    if (!c.shape) return c;
    if (!c.rayBox) {
      c.rayBox = new THREE.Box3(c.min.clone(), c.max.clone());
      for (const s of c.shape) {
        s.inv = s.matrix.clone().invert();
        if (!s.geometry.boundingBox) s.geometry.computeBoundingBox();
        s.box = s.geometry.boundingBox.clone().applyMatrix4(s.matrix);
        c.rayBox.union(s.box);
      }
    }
    return c.rayBox;
  }

  // Where a ray first touches a collider's real shape, between dist t0 and t1
  // (or null: it passes through the box but misses the thing itself)
  _shapeHit(c, origin, dir, t0, t1) {
    _ray.set(origin, dir);
    this._rayBounds(c);
    let best = Infinity;
    for (const s of c.shape) {
      const r = this._rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, s.box);
      if (!r || r.tmin > Math.min(t1, best) || r.tmax < t0) continue;
      _local.copy(_ray).applyMatrix4(s.inv);
      const pos = s.geometry.attributes.position, idx = s.geometry.index, n = idx ? idx.count : pos.count;
      for (let i = 0; i < n; i += 3) {
        const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, cc = idx ? idx.getX(i + 2) : i + 2;
        _ta.fromBufferAttribute(pos, a); _tb.fromBufferAttribute(pos, b); _tc.fromBufferAttribute(pos, cc);
        if (!_local.intersectTriangle(_ta, _tb, _tc, false, _hit)) continue;
        const d = _hit.applyMatrix4(s.matrix).distanceTo(origin);
        if (d < t0 - 0.01 || d > t1 || d >= best) continue;
        best = d;
        _e1.subVectors(_tb, _ta); _e2.subVectors(_tc, _ta);
        _sn.crossVectors(_e1, _e2).transformDirection(s.matrix); // the face's direction in the world
      }
    }
    if (best === Infinity) return null;
    if (_sn.dot(dir) > 0) _sn.negate(); // facing the shot
    return { dist: best, normal: _sn.clone() };
  }

  groundHeight(x, z) { return this.terrain ? this.terrain.heightAt(x, z) : 0; }

  // What are you standing on? (footstep sounds) The top of a box right under
  // your feet, then a floor finish (addFloor), otherwise the terrain's dominant texture.
  surfaceUnder(p) {
    let best = null, top = -Infinity;
    for (const c of this._collect(p.x - 0.15, p.y - 0.12, p.z - 0.15, p.x + 0.15, p.y + 0.02, p.z + 0.15)) {
      if (c.solid && c.max.y > top) { top = c.max.y; best = c; }
    }
    if (best && Math.abs(top - p.y) < 0.12) return best.surface;
    for (const f of this.floors) {
      if (p.x > f.x0 && p.x < f.x1 && p.z > f.z0 && p.z < f.z1 && Math.abs(p.y - f.y) < 0.5) return f.surface;
    }
    return this.terrain ? this.terrain.surfaceAt(p.x, p.z) : 'dirt';
  }

  // --- overlap queries -------------------------------------------------------
  _collect(minX, minY, minZ, maxX, maxY, maxZ) {
    const out = this._scratch;
    out.length = 0;
    for (const c of this.colliders) {
      if (minX < c.max.x && maxX > c.min.x && minY < c.max.y && maxY > c.min.y && minZ < c.max.z && maxZ > c.min.z) out.push(c);
    }
    return out;
  }

  boxBlocked(minX, minY, minZ, maxX, maxY, maxZ) {
    return this._collect(minX, minY, minZ, maxX, maxY, maxZ).length > 0;
  }

  bodyBlocked(p, r, h) {
    return this.boxBlocked(p.x - r, p.y, p.z - r, p.x + r, p.y + h, p.z + r);
  }

  _bodyHits(p, r, h) {
    return this._collect(p.x - r, p.y, p.z - r, p.x + r, p.y + h, p.z + r);
  }

  // --- character movement ----------------------------------------------------
  // Moves one axis at a time and pushes back out of anything it hits — this
  // "axis-separated" approach naturally lets you slide along walls.
  // body = { pos (feet), vel, radius, height, onGround }. Returns impact speed on landing.
  moveBody(body, dt, stepHeight = 0) {
    const p = body.pos, v = body.vel, r = body.radius, h = body.height;
    const wasGround = body.onGround;
    body.onGround = false;
    body.stepped = 0;
    let landed = 0;

    for (const axis of ['x', 'z']) {
      const delta = v[axis] * dt;
      if (delta === 0) continue;
      const before = p[axis];
      const gBefore = this.groundHeight(p.x, p.z);
      p[axis] += delta;

      // Terrain too steep to walk up?
      if (this.terrain) {
        const g = this.groundHeight(p.x, p.z);
        if (g > p.y + 0.02 && (g - gBefore) / Math.abs(delta) > MAX_WALK_SLOPE) { p[axis] = before; v[axis] = 0; continue; }
      }

      const hits = this._bodyHits(p, r, h);
      if (!hits.length) continue;
      // Stair stepping: if what we bumped is short enough, climb onto it.
      if (wasGround && stepHeight > 0) {
        let top = -Infinity;
        for (const c of hits) top = Math.max(top, c.max.y);
        const rise = top - p.y;
        if (rise > 0 && rise <= stepHeight) {
          const oldY = p.y;
          p.y = top + 0.001;
          if (!this.bodyBlocked(p, r, h)) { body.stepped = rise; continue; }
          p.y = oldY;
        }
      }
      let limit = delta > 0 ? Infinity : -Infinity;
      for (const c of this._bodyHits(p, r, h)) {
        if (delta > 0) limit = Math.min(limit, c.min[axis] - r - EPS);
        else limit = Math.max(limit, c.max[axis] + r + EPS);
      }
      p[axis] = limit;
      v[axis] = 0;
    }

    p.y += v.y * dt;
    const hits = this._bodyHits(p, r, h);
    if (hits.length) {
      if (v.y <= 0) {
        let top = -Infinity;
        for (const c of hits) top = Math.max(top, c.max.y);
        p.y = top;
        landed = -v.y;
        v.y = 0;
        body.onGround = true;
      } else {
        let bottom = Infinity;
        for (const c of hits) bottom = Math.min(bottom, c.min.y);
        p.y = bottom - h - EPS;
        v.y = 0;
      }
    }
    const g = this.groundHeight(p.x, p.z);
    if (p.y < g) {
      if (v.y < 0) landed = Math.max(landed, -v.y);
      p.y = g;
      v.y = 0;
      body.onGround = true;
    }

    // Ground snap: stay glued to the floor walking DOWN stairs or slopes instead
    // of briefly "falling" every few centimetres.
    if (!body.onGround && wasGround && v.y <= 0 && stepHeight > 0) {
      const reach = stepHeight + 0.25;
      let floor = this.terrain && p.y - g <= reach ? g : -Infinity;
      const oldY = p.y;
      p.y -= reach;
      for (const c of this._bodyHits(p, r, h)) if (c.max.y <= oldY + EPS) floor = Math.max(floor, c.max.y);
      p.y = oldY;
      if (floor > -Infinity) { p.y = floor; v.y = 0; body.onGround = true; }
    }
    return landed;
  }

  // --- ray queries (bullets, line of sight) ----------------------------------
  // Slab test: intersect the ray with the 3 pairs of parallel planes of a box.
  _rayBox(ox, oy, oz, dx, dy, dz, c) {
    let tmin = -Infinity, tmax = Infinity, axis = -1;
    const o = [ox, oy, oz], d = [dx, dy, dz];
    const mn = [c.min.x, c.min.y, c.min.z], mx = [c.max.x, c.max.y, c.max.z];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) {
        if (o[a] < mn[a] || o[a] > mx[a]) return null;
        continue;
      }
      const inv = 1 / d[a];
      let t1 = (mn[a] - o[a]) * inv, t2 = (mx[a] - o[a]) * inv;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) { tmin = t1; axis = a; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (tmax < 0) return null;
    return { tmin, tmax, axis, sign: axis >= 0 ? -Math.sign(d[axis]) : 0 };
  }

  _terrainHit(origin, dir, maxDist) {
    if (!this.terrain) return null;
    const t = this.terrain.raycast(origin, dir, maxDist);
    if (!t) return null;
    return { dist: t.dist, exit: Infinity, normal: t.normal, collider: { surface: this.terrain.surfaceAt(t.point.x, t.point.z), pen: Infinity } };
  }

  // All boxes the ray passes through, nearest first, with entry/exit distances
  // (exit - entry = thickness, used for bullet penetration).
  raycastAll(origin, dir, maxDist) {
    const hits = [];
    for (const c of this.colliders) {
      if (!c.solid) continue;
      const r = this._rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, this._rayBounds(c));
      if (!r || r.tmin > maxDist) continue;
      let entry = Math.max(0, r.tmin);
      const normal = new THREE.Vector3();
      if (c.shape) { // narrow phase: did it touch the real thing?
        const h = this._shapeHit(c, origin, dir, entry, Math.min(r.tmax, maxDist));
        if (!h) continue;
        entry = h.dist;
        normal.copy(h.normal);
      } else if (r.axis >= 0) normal.setComponent(r.axis, r.sign);
      else normal.copy(dir).negate();
      hits.push({ dist: entry, exit: r.tmax, normal, collider: c });
    }
    const t = this._terrainHit(origin, dir, maxDist);
    if (t) hits.push(t);
    hits.sort((a, b) => a.dist - b.dist);
    return hits;
  }

  raycast(origin, dir, maxDist) {
    const hit = this.raycastAll(origin, dir, maxDist).find((h) => h.dist > 0 || h.exit > 0);
    if (!hit) return null;
    return { dist: hit.dist, point: origin.clone().addScaledVector(dir, hit.dist), normal: hit.normal, collider: hit.collider };
  }

  // True if the line a->b passes through a smoke cloud. Clouds are squashed
  // spheres (wider than tall), so we scale the vertical axis before a plain
  // closest-point-on-segment test.
  smokeBlocks(a, b) {
    for (const s of this.smokes) {
      if (s.r < 0.8) continue;
      const k = 1.8; // vertical squash
      const abx = b.x - a.x, aby = (b.y - a.y) * k, abz = b.z - a.z;
      const apx = s.pos.x - a.x, apy = (s.pos.y - a.y) * k, apz = s.pos.z - a.z;
      const len2 = abx * abx + aby * aby + abz * abz;
      const t = len2 > 0 ? Math.min(1, Math.max(0, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
      const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
      if (dx * dx + dy * dy + dz * dz < s.r * s.r * 0.8) return true;
    }
    return false;
  }

  // True if nothing solid sits between a and b.
  lineOfSight(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    const ix = dx / len, iy = dy / len, iz = dz / len;
    for (const c of this.colliders) {
      if (!c.solid) continue;
      const r = this._rayBox(a.x, a.y, a.z, ix, iy, iz, this._rayBounds(c));
      if (!r || r.tmin < 0 || r.tmin >= len) continue;
      if (c.shape) { _losDir.set(ix, iy, iz); if (!this._shapeHit(c, a, _losDir, r.tmin, Math.min(r.tmax, len))) continue; } // (only the real shape blocks the view)
      return false;
    }
    if (this.terrain && this.terrain.raycast(a, { x: ix, y: iy, z: iz }, len)) return false;
    return true;
  }
}

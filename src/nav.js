// =============================================================================
// nav.js — pathfinding for enemy soldiers.
//
// The ground is split into a grid of 0.5 m cells. A cell is "blocked" if a
// collider would stop a soldier standing there. A* search then finds the
// cheapest chain of free cells between two points. Big engines use navigation
// MESHES (Recast/Detour in Unreal/Unity/Godot) — same idea, smarter shapes.
// =============================================================================
import * as THREE from 'three';

const SQRT2 = Math.SQRT2;

export class NavGrid {
  // floorY: build the grid on a flat floor at this height (a roof) instead of
  // on the terrain. Everything else works the same.
  constructor(world, { minX = -105, maxX = 105, minZ = -105, maxZ = 105, cell = 0.5, agentRadius = 0.35, floorY = null } = {}) {
    this.world = world;
    this.minX = minX; this.minZ = minZ;
    this.floorY = floorY;
    this.cell = cell;
    this.w = Math.ceil((maxX - minX) / cell);
    this.h = Math.ceil((maxZ - minZ) / cell);
    this.agentRadius = agentRadius;
    const n = this.w * this.h;
    this.blocked = new Uint8Array(n);
    // A* working arrays, reused between searches (a "stamp" marks which entries are valid this search)
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.search = 0;
    this.build();
  }

  // Rasterise every obstacle into the grid (inflated by the soldier's radius).
  // Only things between knee and head height (above the local ground) block
  // walking. Terrain steeper than ~37° is blocked too.
  build() {
    const r = this.agentRadius, c = this.cell, world = this.world;
    this.blocked.fill(0);
    for (const col of world.colliders) {
      const x0 = Math.max(0, Math.floor((col.min.x - r - this.minX) / c));
      const x1 = Math.min(this.w - 1, Math.floor((col.max.x + r - this.minX) / c));
      const z0 = Math.max(0, Math.floor((col.min.z - r - this.minZ) / c));
      const z1 = Math.min(this.h - 1, Math.floor((col.max.z + r - this.minZ) / c));
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const wx = this.minX + (x + 0.5) * c, wz = this.minZ + (z + 0.5) * c;
          if (!(wx > col.min.x - r && wx < col.max.x + r && wz > col.min.z - r && wz < col.max.z + r)) continue;
          const g = this.floorY ?? world.groundHeight(wx, wz);
          if (col.max.y > g + 0.46 && col.min.y < g + 1.7) this.blocked[z * this.w + x] = 1;
        }
      }
    }
    if (world.terrain && this.floorY === null) {
      const n = new THREE.Vector3();
      for (let z = 0; z < this.h; z++) {
        for (let x = 0; x < this.w; x++) {
          const i = z * this.w + x;
          if (this.blocked[i]) continue;
          world.terrain.normalAt(this.minX + (x + 0.5) * c, this.minZ + (z + 0.5) * c, n);
          if (n.y < 0.8) this.blocked[i] = 1;
        }
      }
    }
  }

  toCell(x, z) {
    const cx = Math.floor((x - this.minX) / this.cell), cz = Math.floor((z - this.minZ) / this.cell);
    if (cx < 0 || cz < 0 || cx >= this.w || cz >= this.h) return -1;
    return cz * this.w + cx;
  }

  cellCenter(i, out = new THREE.Vector3()) {
    const x = i % this.w, z = (i / this.w) | 0;
    return out.set(this.minX + (x + 0.5) * this.cell, 0, this.minZ + (z + 0.5) * this.cell);
  }

  walkable(x, z) {
    const i = this.toCell(x, z);
    return i >= 0 && !this.blocked[i];
  }

  // Closest free cell (spiral search) — used when a target sits inside an obstacle.
  nearestWalkable(x, z, maxRings = 8) {
    const i0 = this.toCell(x, z);
    if (i0 >= 0 && !this.blocked[i0]) return i0;
    const cx = Math.floor((x - this.minX) / this.cell), cz = Math.floor((z - this.minZ) / this.cell);
    for (let ring = 1; ring <= maxRings; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.h) continue;
          const i = nz * this.w + nx;
          if (!this.blocked[i]) return i;
        }
      }
    }
    return -1;
  }

  // Walk the grid along a straight line; true if every cell is free.
  clearLine(ax, az, bx, bz) {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(dist / (this.cell * 0.5));
    for (let s = 0; s <= steps; s++) {
      const t = steps ? s / steps : 0;
      if (!this.walkable(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  // A* search. Returns an array of Vector3 waypoints (y = 0) or null.
  findPath(from, to, maxNodes = 30000) {
    const start = this.nearestWalkable(from.x, from.z);
    const goal = this.nearestWalkable(to.x, to.z);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [this.cellCenter(goal)];

    const W = this.w;
    const stamp = ++this.search;
    const gx = goal % W, gz = (goal / W) | 0;
    const heur = (i) => { // octile distance: exact for 8-way grids without obstacles
      const dx = Math.abs((i % W) - gx), dz = Math.abs(((i / W) | 0) - gz);
      return (dx + dz + (SQRT2 - 2) * Math.min(dx, dz)) * this.cell;
    };

    // Binary min-heap of [f, index]
    const heapF = [], heapI = [];
    const push = (f, i) => {
      let k = heapF.length;
      heapF.push(f); heapI.push(i);
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (heapF[p] <= heapF[k]) break;
        [heapF[p], heapF[k]] = [heapF[k], heapF[p]];
        [heapI[p], heapI[k]] = [heapI[k], heapI[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heapI[0];
      const lf = heapF.pop(), li = heapI.pop();
      if (heapF.length) {
        heapF[0] = lf; heapI[0] = li;
        let k = 0;
        for (;;) {
          const l = 2 * k + 1, r = l + 1;
          let m = k;
          if (l < heapF.length && heapF[l] < heapF[m]) m = l;
          if (r < heapF.length && heapF[r] < heapF[m]) m = r;
          if (m === k) break;
          [heapF[m], heapF[k]] = [heapF[k], heapF[m]];
          [heapI[m], heapI[k]] = [heapI[k], heapI[m]];
          k = m;
        }
      }
      return top;
    };

    this.g[start] = 0;
    this.stamp[start] = stamp;
    this.parent[start] = -1;
    push(heur(start), start);
    let expanded = 0;

    while (heapF.length) {
      const cur = pop();
      if (this.closed[cur] === stamp) continue;
      this.closed[cur] = stamp;
      if (cur === goal) return this._buildPath(start, goal, from);
      if (++expanded > maxNodes) return null;

      const cx = cur % W, cz = (cur / W) | 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dz) continue;
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= W || nz >= this.h) continue;
          const ni = nz * W + nx;
          if (this.blocked[ni] || this.closed[ni] === stamp) continue;
          // No cutting corners diagonally past an obstacle
          if (dx && dz && (this.blocked[cz * W + nx] || this.blocked[nz * W + cx])) continue;
          const ng = this.g[cur] + (dx && dz ? SQRT2 : 1) * this.cell;
          if (this.stamp[ni] !== stamp || ng < this.g[ni]) {
            this.stamp[ni] = stamp;
            this.g[ni] = ng;
            this.parent[ni] = cur;
            push(ng + heur(ni), ni);
          }
        }
      }
    }
    return null;
  }

  // Walk back through parents, then "string-pull": drop any waypoint we can
  // skip with a straight clear line. Turns a jagged grid path into natural moves.
  _buildPath(start, goal, from) {
    const cells = [];
    for (let i = goal; i !== -1; i = this.parent[i]) cells.push(i);
    cells.reverse();
    const pts = cells.map((i) => this.cellCenter(i));
    const out = [];
    let anchor = new THREE.Vector3(from.x, 0, from.z);
    let k = 0;
    while (k < pts.length - 1) {
      let far = k + 1;
      for (let j = pts.length - 1; j > k + 1; j--) {
        if (this.clearLine(anchor.x, anchor.z, pts[j].x, pts[j].z)) { far = j; break; }
      }
      out.push(pts[far]);
      anchor = pts[far];
      k = far;
    }
    if (!out.length) out.push(pts[pts.length - 1]);
    return out;
  }
}

// =============================================================================
// Navigation — the ground grid PLUS raised "decks" (flat roofs) joined to it by
// ladders.
//
// One flat grid can't describe a roof above a street: both share the same
// (x, z). So each roof gets its own small grid, and every ladder is an
// OFF-MESH LINK: "from this cell on the ground you can reach that cell on the
// roof, by climbing". Recast/Detour (Unreal, Unity, Godot) call them exactly
// that; Unreal's level designers place them as "Nav Link Proxies".
//
// A path that changes level is stitched together from pieces:
//   roof grid -> [ladder down] -> ground grid -> [ladder up] -> other roof grid
// The ladder step is a waypoint with `.ladder` and `.dir` (+1 up, -1 down);
// the soldier walks to it, then climbs (enemy.js _followPath).
// =============================================================================
export class Navigation {
  constructor(world, bounds) {
    this.world = world;
    this.ground = new NavGrid(world, bounds);
    // A grid per deck, a little inside its edges so nobody walks off the side
    for (const d of world.decks) {
      d.grid = new NavGrid(world, { minX: d.minX + 0.2, maxX: d.maxX - 0.2, minZ: d.minZ + 0.2, maxZ: d.maxZ - 0.2, floorY: d.y });
    }
  }

  // The ground grid answers the old single-level questions (cover points, spawns)
  walkable(x, z) { return this.ground.walkable(x, z); }

  // Which level is this point on? A deck if it's roughly on that roof
  // (heard noises come with some error, so allow a margin), else the ground (null).
  levelAt(p) {
    let best = null, bestD = 1.5;
    for (const d of this.world.decks) {
      if (p.y < d.y - 0.7 || p.y > d.y + 2.5) continue;
      const dx = Math.max(d.minX - p.x, 0, p.x - d.maxX), dz = Math.max(d.minZ - p.z, 0, p.z - d.maxZ);
      const dist = Math.hypot(dx, dz);
      if (dist <= bestD) { best = d; bestD = dist; }
    }
    return best;
  }

  // The deck's ladder that makes the trip shortest (most roofs have just one)
  _bestLadder(deck, from, to) {
    let best = null, bestCost = Infinity;
    for (const L of deck.ladders || []) {
      const cost = Math.hypot(from.x - L.foot.x, from.z - L.foot.z) + Math.hypot(to.x - L.top.x, to.z - L.top.z);
      if (cost < bestCost) { best = L; bestCost = cost; }
    }
    return best;
  }

  _ladderStep(L, dir) {
    const end = dir > 0 ? L.foot : L.top;  // walk here first, then climb
    const wp = new THREE.Vector3(end.x, 0, end.z);
    wp.ladder = L;
    wp.dir = dir;
    return wp;
  }

  // Same contract as NavGrid.findPath: an array of waypoints, or null.
  findPath(from, to, maxNodes) {
    const a = this.levelAt(from), b = this.levelAt(to);
    if (a === b) return (a ? a.grid : this.ground).findPath(from, to, maxNodes);
    const out = [];
    let start = from;
    if (a) { // on a roof: walk to its ladder and climb down first
      const L = this._bestLadder(a, from, to);
      const p = L && a.grid.findPath(from, L.top, maxNodes);
      if (!p) return null;
      out.push(...p, this._ladderStep(L, -1));
      start = L.foot;
    }
    if (b) { // going up onto a roof: walk to its ladder, climb, then cross the roof
      const L = this._bestLadder(b, start, to);
      const p = L && this.ground.findPath(start, L.foot, maxNodes);
      const q = p && b.grid.findPath(L.top, to, maxNodes);
      if (!q) return null;
      out.push(...p, this._ladderStep(L, +1), ...q);
    } else {
      const p = this.ground.findPath(start, to, maxNodes);
      if (!p) return null;
      out.push(...p);
    }
    return out;
  }
}

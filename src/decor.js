// =============================================================================
// decor.js — SET DRESSING: the small things that make a level feel lived in.
//
// Level art is built in two passes. "Blockout" (greybox) makes the playable
// shapes — walls, floors, cover — that's builder.js. Then "set dressing" fills
// the spaces with what people leave behind: doors, shutters, curtains,
// furniture, shop signs, posters, grime, litter, wires, camo nets...
// It barely changes how the level PLAYS, but it's most of how it LOOKS.
//
// Rules this file follows:
//  - DETERMINISM. It has its OWN seeded random stream, so every co-op player
//    gets identical furniture (some of it stops bullets), and adding a chair
//    here never moves a tree that the map's `rand` places afterwards.
//  - Solid things (sofas, tables, doors) register colliders; small clutter
//    (vases, frames, chairs, litter) doesn't, so it never blocks paths or
//    lines of sight with something you can't see.
//  - Furniture stays out of doorways, stairs and the spots the AI uses.
//  - Batching. Models are instanced by props.js; every procedural piece goes
//    through builder.add(), and builder.finalize() merges each material into
//    ONE mesh. Hundreds of shutters = one draw call.
//  - No new image files: shop signs, posters, rugs, curtains and grime are
//    painted at startup on <canvas> elements (like textures.js does for camo).
// =============================================================================
import * as THREE from 'three';
import { mulberry32 } from './textures.js';

const TAU = Math.PI * 2;

// Poly Haven models (CC0) this file can place, grouped by theme. A map asks for
// the themes it uses with decor.load([...]); they load with textures shrunk to
// 512 px (see props.js) because none of them ever fills the screen.
export const DECOR_MODELS = {
  home: ['painted_wooden_table', 'painted_wooden_chair_01', 'painted_wooden_chair_02', 'painted_wooden_cabinet',
    'painted_wooden_cabinet_02', 'painted_wooden_shelves', 'painted_wooden_sofa', 'painted_wooden_nightstand',
    'vintage_day_bed', 'WoodenTable_01', 'sofa_02', 'Television_01', 'potted_plant_04',
    'Shelf_01', 'fancy_picture_frame_01', 'wall_clock', 'plastic_monobloc_chair_01', 'painted_wooden_stool'],
  street: ['metal_trash_can', 'trashbag', 'utility_box_01', 'water_manhole_cover', 'planter_pot_clay',
    'outdoor_table_chair_set_01', 'painted_wooden_bench', 'potted_plant_04'],
  military: ['steel_frame_shelves_01', 'metal_office_desk', 'security_light', 'worn_metal_rack', 'barrel_stove',
    'plastic_monobloc_chair_01', 'painted_wooden_table', 'Television_01', 'wall_clock'],
  camp: ['stone_fire_pit', 'wooden_picnic_table'],
};

// Furniture catalogue: real sizes in metres (measured from the models), with
// the front facing +Z. w = width along the wall, d = depth, h = height.
// levels = heights of the shelf boards (for putting goods on them).
const FURN = {
  sofa: { id: 'sofa_02', w: 1.81, d: 0.82, h: 0.71, pen: 0.5, surface: 'cloth' },
  sofaWood: { id: 'painted_wooden_sofa', w: 2.45, d: 0.79, h: 1.28, cover: true },
  sideboard: { id: 'painted_wooden_cabinet', w: 1.19, d: 0.62, h: 1.18, cover: true, top: 1.18 },
  wardrobe: { id: 'painted_wooden_cabinet_02', w: 0.85, d: 0.62, h: 2.18, scale: 0.85 },
  shelves: { id: 'painted_wooden_shelves', w: 0.51, d: 0.37, h: 1.13, cover: true },
  bookcase: { w: 1.0, d: 0.34, h: 1.95 },         // procedural, with rows of books (see _bookcase)
  tallShelf: { id: 'Shelf_01', w: 1.0, d: 0.26, h: 2.08, levels: [0.55, 0.84, 1.12, 1.42] },
  steelShelf: { id: 'steel_frame_shelves_01', scale: 0.1, w: 1.1, d: 0.5, h: 2.14, levels: [0.61, 1.13, 1.63], pen: 0.3, surface: 'metal' },
  rack: { id: 'worn_metal_rack', w: 0.92, d: 0.6, h: 1.9, levels: [0.42, 0.92, 1.42], pen: 0.3, surface: 'metal' },
  bed: { id: 'vintage_day_bed', w: 1.97, d: 0.85, h: 1.13, pen: 0.3, surface: 'cloth' },
  night: { id: 'painted_wooden_nightstand', w: 0.5, d: 0.51, h: 0.62, top: 0.62 },
  lowTable: { id: 'WoodenTable_01', w: 1.8, d: 0.66, h: 0.55, top: 0.55 },
  desk: { id: 'metal_office_desk', w: 2.0, d: 0.95, h: 0.79, top: 0.79, cover: true, pen: 0.3, surface: 'metal' },
  table: { id: 'painted_wooden_table', w: 2.41 * 0.8, d: 1.14 * 0.8, h: 0.96 * 0.8, scale: 0.8, cover: true, top: 0.77 },
  cot: { w: 0.8, d: 1.95, h: 0.45 },            // procedural (see _cot)
  locker: { w: 0.9, d: 0.45, h: 1.8 },          // procedural steel locker
  crate: { id: 'wooden_military_crate', w: 1.24, d: 0.52, h: 0.46, cover: false, pen: 0.45 },
  workbench: { w: 2.0, d: 0.8, h: 0.9 },        // procedural
  counter: { w: 2.2, d: 0.65, h: 1.0 },         // procedural
};
const CHAIRS = ['painted_wooden_chair_01', 'painted_wooden_chair_02'];

// Paint colours for doors and shutters (faded, sun-bleached)
const PAINTS = [0x4f6b52, 0x3f6170, 0x7a4a32, 0xb8b0a0, 0x5d7f86, 0x6b5a3a, 0x8a3a2c, 0x46504a];
const FABRICS = [[0xd9cfb8, 0xb39b78, 'stripes'], [0x8a3a35, 0xc8a070, 'dots'], [0xc0a050, 0x8a6a30, 'plain'], [0x5a6a80, 0xd0d4d8, 'stripes'], [0x6a7350, 0xc8c0a0, 'dots']];
const AWNINGS = [[0x2f6a45, 0xe8e2d0], [0xa8382e, 0xeee6d6], [0x2f4f7a, 0xe0d8c0], [0xc08a2a, 0x3a3a34]];
const SHOPS = ['BAKERY', 'PHARMACY', 'CAFE', 'TAILOR', 'HARDWARE', 'GROCERY', 'BARBER', 'HOTEL', 'BOOKS', 'BUTCHER', 'MARKET', 'RADIO & TV'];

// -----------------------------------------------------------------------------
// Little canvas helpers
// -----------------------------------------------------------------------------
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return [c, c.getContext('2d')];
}
function toTex(c, { srgb = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
const css = (hex, a = 1) => { const c = new THREE.Color(hex); return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`; };
// An irregular blob — chipped paint, dirt splashes, leaves
function blob(g, x, y, r, rnd, n = 7) {
  g.beginPath();
  for (let i = 0; i < n; i++) { const a = (i / n) * TAU, rr = r * (0.55 + rnd() * 0.7); g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  g.closePath();
  g.fill();
}
// Speckles, rust runs and faded edges: makes painted things look old
function weather(g, x, y, w, h, rnd, amount = 1) {
  for (let i = 0; i < 70 * amount; i++) {
    g.fillStyle = rnd() < 0.6 ? `rgba(40,30,20,${0.08 + rnd() * 0.18})` : `rgba(255,250,240,${0.06 + rnd() * 0.12})`;
    blob(g, x + rnd() * w, y + rnd() * h, 0.6 + rnd() * 2.6, rnd, 5);
  }
  for (let i = 0; i < 4 * amount; i++) {
    const rx = x + rnd() * w, gr = g.createLinearGradient(0, y, 0, y + h * (0.4 + rnd() * 0.6));
    gr.addColorStop(0, 'rgba(120,60,20,0.35)');
    gr.addColorStop(1, 'rgba(120,60,20,0)');
    g.fillStyle = gr;
    g.fillRect(rx, y, 1 + rnd() * 2.5, h);
  }
  const vg = g.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.3, x + w / 2, y + h / 2, Math.max(w, h) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, `rgba(30,20,10,${0.25 * amount})`);
  g.fillStyle = vg;
  g.fillRect(x, y, w, h);
}
// font = '[italic] [bold] family' — CSS wants style and weight BEFORE the size
function text(g, str, cx, cy, maxW, size, font, color, { stroke = null, lw = 0 } = {}) {
  const pre = font.match(/^((italic|bold|normal)\s+)*/)[0];
  g.font = `${pre}${size}px ${font.slice(pre.length)}`;
  const k = Math.min(1, maxW / g.measureText(str).width);
  g.save();
  g.translate(cx, cy);
  g.scale(k, 1);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.strokeText(str, 0, 0); }
  g.fillStyle = color;
  g.fillText(str, 0, 0);
  g.restore();
}

// A texture ATLAS: many small pictures packed into one big canvas, so every
// sign (or every decal) in the level can share ONE material — and so be
// merged into one mesh. Each add() returns the UV rectangle of its picture.
class Atlas {
  constructor(size, height = size) {
    [this.c, this.g] = canvas(size, height);
    this.size = size;
    this.height = height;
    this.x = 0; this.y = 0; this.row = 0;
    this.cells = {};
  }
  add(name, w, h, draw) {
    const pad = 4, S = this.size;
    if (this.x + w + pad > S) { this.x = 0; this.y += this.row + pad; this.row = 0; }
    const x = this.x, y = this.y;
    if (y + h > this.height) console.warn(`decor: atlas full, "${name}" won't show`);
    this.x += w + pad;
    this.row = Math.max(this.row, h);
    const g = this.g;
    g.save();
    g.beginPath(); g.rect(x, y, w, h); g.clip();
    g.translate(x, y);
    draw(g, w, h);
    g.restore();
    // canvas y runs down, texture v runs up
    const H = this.height;
    this.cells[name] = { u0: x / S, u1: (x + w) / S, v0: 1 - (y + h) / H, v1: 1 - y / H, aspect: w / h };
    return this.cells[name];
  }
}

// Map a PlaneGeometry's 0..1 UVs onto an atlas cell (optionally a horizontal slice of it)
function setUV(geo, cell, f0 = 0, f1 = 1) {
  const uv = geo.attributes.uv;
  const u0 = cell.u0 + (cell.u1 - cell.u0) * f0, u1 = cell.u0 + (cell.u1 - cell.u0) * f1;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), cell.v0 + uv.getY(i) * (cell.v1 - cell.v0));
}

// One outside wall of a building: where it is and which way it faces.
//   at(a, off) = the point `a` metres along the wall, `off` metres OUT from its
//                outer face (negative = into the wall / the room)
//   rot        = the Y rotation that turns an object's +Z (its front) outward
function wallOf(d, side) {
  const out = { n: [0, -1], s: [0, 1], w: [-1, 0], e: [1, 0] }[side];
  const alongX = side === 'n' || side === 's';
  const face = side === 'n' ? d.z0 : side === 's' ? d.z1 : side === 'w' ? d.x0 : d.x1;
  const a0 = alongX ? d.x0 : d.z0, a1 = alongX ? d.x1 : d.z1;
  const at = (a, off = 0) => (alongX ? [a, face + out[1] * off] : [face + out[0] * off, a]);
  return { side, out, alongX, a0, a1, len: a1 - a0, at, rot: Math.atan2(out[0], out[1]) };
}

export class Decor {
  // seed: any number — the same seed gives the same dressing on every computer
  constructor({ scene, world, builder, props, M, seed = 1 }) {
    Object.assign(this, { scene, world, b: builder, P: props, M });
    this.rand = mulberry32(seed);
    this.keep = [];            // AI spots: { x, z, y? } — furniture keeps 1.4 m away
    this._mats = new Map();
    this._paint();
  }

  async load(themes) {
    const ids = [...new Set(themes.flatMap((t) => DECOR_MODELS[t]))];
    await this.P.load(ids, { texCap: Object.fromEntries(ids.map((id) => [id, 512])) });
  }

  keepClear(points) { for (const p of points) this.keep.push(p); }

  // ---- random helpers (all from this file's own seeded stream) ------------
  r(a, b) { return a + (b - a) * this.rand(); }
  pick(list) { return list[(this.rand() * list.length) | 0]; }
  chance(p) { return this.rand() < p; }
  has(id) { return this.P.defs.has(id); }

  // ---- materials (made once, on first use) --------------------------------
  mat(key, make) {
    if (!this._mats.has(key)) this._mats.set(key, make());
    return this._mats.get(key);
  }
  get iron() { return this.mat('iron', () => new THREE.MeshStandardMaterial({ color: 0x2c2b29, roughness: 0.6, metalness: 0.7 })); }
  get steel() { return this.mat('steel', () => new THREE.MeshStandardMaterial({ color: 0x8e9294, roughness: 0.45, metalness: 0.8 })); }
  get glass() {
    return this.mat('glass', () => new THREE.MeshStandardMaterial({
      color: 0x5f7880, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.1,
    }));
  }
  get decalMat() {
    return this.mat('decal', () => new THREE.MeshStandardMaterial({
      map: toTex(this.decals.c), transparent: true, depthWrite: false, roughness: 0.95,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }));
  }
  get sign() { return this.mat('sign', () => new THREE.MeshStandardMaterial({ map: toTex(this.signs.c), roughness: 0.75, alphaTest: 0.5, side: THREE.DoubleSide })); }
  get cardboard() { return this.mat('cardboard', () => new THREE.MeshStandardMaterial({ map: this._cardboardTex(), roughness: 0.95 })); }
  get lampGlass() { return this.mat('lampGlass', () => new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffc070, emissiveIntensity: 0.6, roughness: 0.3 })); }
  // Every painted door, shutter and cupboard front shares ONE material: their
  // pictures live side by side in an atlas (this.paints) and each piece's UVs
  // point at its own picture. Same for all fabrics (this.cloths): curtains,
  // rugs, awnings, bedding, laundry. One material = one merged mesh = one draw.
  get paint() { return this.mat('paint', () => new THREE.MeshStandardMaterial({ map: toTex(this.paints.c), roughness: 0.85 })); }
  get cloth() {
    return this.mat('cloth', () => new THREE.MeshStandardMaterial({
      map: toTex(this.cloths.c), roughness: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
  }
  get ceramic() { return this.mat('ceramic', () => new THREE.MeshStandardMaterial({ color: 0xe6e0d2, roughness: 0.25 })); }
  get terracotta() { return this.mat('terracotta', () => new THREE.MeshStandardMaterial({ color: 0x9c5a3c, roughness: 0.9 })); }
  door(i) { return this.paints.cells[`door${i % PAINTS.length}`]; }
  shutter(i) { return this.paints.cells[`shutter${i % PAINTS.length}`]; }
  fabric(i) { return this.cloths.cells[`fabric${i % FABRICS.length}`]; }

  // ===========================================================================
  // Low-level placement: every piece goes through builder.add() so it gets
  // merged with everything else of the same material at the end.
  // ===========================================================================

  // Box with ordinary 0..1 UVs on each face (so a door texture shows ONCE per
  // door), rotated rotY about its centre. y = bottom.
  piece(w, h, d, mat, x, y, z, rotY = 0, { shadow = true, collide = false, pen = 0.4, surface = 'wood', solid = true, tiltX = 0, cell = null } = {}) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (cell) setUV(geo, cell);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y + h / 2, z);
    m.rotation.set(tiltX, rotY, 0, 'YXZ');
    this.b.add(m, shadow);
    if (collide) this.world.addMesh(m, { pen, surface, solid });
    return m;
  }

  // Flat rectangle facing +Z (turned by rotY; tiltX = -PI/2 lays it on the floor).
  // cell = atlas cell (or null for the whole texture). y = CENTRE.
  quad(w, h, mat, x, y, z, rotY = 0, { cell = null, f0 = 0, f1 = 1, tiltX = 0, shadow = false } = {}) {
    const geo = new THREE.PlaneGeometry(w, h);
    if (cell) setUV(geo, cell, f0, f1);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(tiltX, rotY, 0, 'YXZ');
    this.b.add(m, shadow);
    return m;
  }

  cylinder(r, h, mat, x, y, z, { seg = 8, shadow = true, rz = 0, rx = 0, collide = false, surface = 'metal' } = {}) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, 0, rz);
    this.b.add(m, shadow);
    if (collide) this.world.addMesh(m, { surface });
    return m;
  }

  // A decal: a picture from the decal atlas stuck on a wall (or the floor)
  decal(name, w, h, x, y, z, rotY, opts = {}) {
    return this.quad(w, h, this.decalMat, x, y, z, rotY, { cell: this.decals.cells[name], ...opts });
  }

  // A flat sign plate from the sign atlas (double-sided picture)
  signPlate(name, w, x, y, z, rotY) {
    const cell = this.signs.cells[name];
    return this.quad(w, w / cell.aspect, this.sign, x, y, z, rotY, { cell, shadow: true });
  }

  // Is there anything solid in this box (props, tanks, walls...) or a ladder
  // next to it? Ladders have no collider, so world.nearLadder() asks for them.
  blocked(x0, y0, z0, x1, y1, z1) {
    if (this.world.boxBlocked(x0, y0, z0, x1, y1, z1)) return true;
    const r = Math.max(x1 - x0, z1 - z0) / 2 + 1.2;
    return !!this.world.nearLadder?.((x0 + x1) / 2, (z0 + z1) / 2, r);
  }

  // ===========================================================================
  // BUILDINGS — call for each descriptor in builder.buildings.
  // style = {
  //   rooms:  room type per floor: 'living' | 'bedroom' | 'shop' | 'office' |
  //           'barracks' | 'workshop' | 'bunker' (e.g. ['shop', 'bedroom'])
  //   front:  side facing the street ('n' | 's' | 'e' | 'w') — gets the shop
  //           sign, awning, balcony, house number...
  //   glass:  chance a window still has its glass      (default 0.6)
  //   shutters, curtains, grime, roof (clutter), pitched (tiled roof) — booleans
  //   civil:  false for military buildings (no house numbers, posters, pot plants)
  //   shop:   shop name for the sign; balcony: true to add one
  // }
  // ===========================================================================
  building(d, style = {}) {
    d._spans = {}; // wall stretches already used, per side+floor (so things don't overlap)
    const st = { glass: 0.6, shutters: false, curtains: true, grime: true, roof: true, civil: true, ...style };
    st.paint = st.paint ?? ((this.rand() * PAINTS.length) | 0);
    st.fabric = (this.rand() * FABRICS.length) | 0;
    if (d.ruined) { this._ruin(d); return; }
    this._doors(d, st);
    this._windows(d, st);
    if (st.grime) this._grime(d);
    this._coping(d);
    if (st.front) this._frontage(d, st);
    if (st.shop && st.front) this._shopfront(d, st);
    if (st.balcony && st.front && d.floors > 1) this._balcony(d, st.front, st);
    if (st.drainpipe !== false) this._drainpipe(d, st.front || 'n');
    if (st.pitched && d.floors === 1 && d.hasRoof) this._pitchedRoof(d);
    else if (st.roof && d.hasRoof) this._roofClutter(d);
    this._ceilings(d);
    const rooms = st.rooms || [];
    for (let f = 0; f < d.floors; f++) if (rooms[f]) this.furnish(d, f, rooms[f], st);
  }

  // ---- ceilings -------------------------------------------------------------
  // Indoors, the underside of a floor slab faces DOWN, away from the sky, so it
  // renders almost black. Real ceilings are lit by sunlight bouncing off the
  // floor and walls ("global illumination"), which this renderer doesn't
  // compute. The cheap fix games have always used: a pale plaster ceiling with
  // a little self-glow (emissive) standing in for that bounced light.
  _ceilings(d) {
    const mat = this.mat('ceiling', () => new THREE.MeshStandardMaterial({ color: 0xd9d1c4, roughness: 0.95, emissive: 0x3a3630 }));
    const t = d.thick, x0 = d.x0 + t, x1 = d.x1 - t, z0 = d.z0 + t, z1 = d.z1 - t;
    for (let f = 0; f < d.floors; f++) {
      if (f === d.floors - 1 && !d.hasRoof) continue;
      const y = d.y0 + (f + 1) * d.h - 0.22 - 0.025;
      const hole = f === 0 && d.floors > 1 ? d.stairsHole : null;
      const parts = hole
        ? [[x0, x1, z0, hole.minZ], [x0, x1, hole.maxZ, z1], [x0, hole.minX, hole.minZ, hole.maxZ], [hole.maxX, x1, hole.minZ, hole.maxZ]]
        : [[x0, x1, z0, z1]];
      for (const [a0, a1, b0, b1] of parts) {
        const lo0 = Math.max(a0, x0), hi0 = Math.min(a1, x1), lo1 = Math.max(b0, z0), hi1 = Math.min(b1, z1);
        if (hi0 - lo0 > 0.05 && hi1 - lo1 > 0.05) this.b.box((lo0 + hi0) / 2, y, (lo1 + hi1) / 2, hi0 - lo0, 0.02, hi1 - lo1, mat, { collide: false, castShadow: false });
      }
    }
  }

  // Record that [lo, hi] along a wall (on one floor) is taken.
  _take(d, side, floor, lo, hi) { (d._spans[side + floor] ||= []).push([lo, hi]); }
  // Is [lo, hi] free: inside the wall, clear of openings, ladders and things already placed?
  _free(d, side, floor, lo, hi, gap = 0.1, except = null) {
    const W = wallOf(d, side);
    if (lo < W.a0 + 0.15 || hi > W.a1 - 0.15) return false;
    return this._clear(d, side, floor, lo, hi, gap, except);
  }
  // Same, but without the wall-ends check (for things AT a corner, like a rain pipe)
  _clear(d, side, floor, lo, hi, gap = 0.1, except = null) {
    for (const o of d.openings[side]) if (o !== except && o.floor === floor && lo < o.at + o.w / 2 + gap && hi > o.at - o.w / 2 - gap) return false;
    for (const l of [].concat(d.ladder || [])) if (l.side === side && lo < l.at + 1.0 && hi > l.at - 1.0) return false;
    for (const [a, b] of d._spans[side + floor] || []) if (lo < b + gap && hi > a - gap) return false;
    return true;
  }

  // ---- doors: a painted wooden leaf, swung open into the room ---------------
  _doors(d, st) {
    for (const side of ['n', 's', 'e', 'w']) {
      const W = wallOf(d, side);
      for (const o of d.openings[side]) {
        if (!o.door || o.w > 1.8) continue;
        const lw = o.w - 0.1, lh = o.top - 0.06;
        const s = this.chance(0.5) ? 1 : -1;                     // hinge on the left or right jamb
        const [hx, hz] = W.at(o.at + s * (o.w / 2 - 0.06), -(d.thick - 0.04));
        const ang = Math.PI / 2 + (this.rand() - 0.5) * 0.3;      // open ~90°, into the room
        const A = W.alongX ? [1, 0] : [0, 1], N = [-W.out[0], -W.out[1]];
        const dx = -s * A[0] * Math.cos(ang) + N[0] * Math.sin(ang), dz = -s * A[1] * Math.cos(ang) + N[1] * Math.sin(ang);
        const cx = hx + dx * lw / 2, cz = hz + dz * lw / 2;
        const rot = Math.atan2(-dz, dx);
        this.piece(lw, lh, 0.05, this.paint, cx, d.y0 + 0.01, cz, rot, { collide: true, pen: 0.3, surface: 'wood', cell: this.door(st.paint) });
        // handle on both faces, near the free edge
        const ex = hx + dx * (lw - 0.08), ez = hz + dz * (lw - 0.08);
        this.piece(0.12, 0.03, 0.12, this.iron, ex, d.y0 + 1.0, ez, rot, { shadow: false });
      }
    }
  }

  // ---- windows: glazing bars, glass, shutters, curtains, a plant -------------
  _windows(d, st) {
    for (const side of ['n', 's', 'e', 'w']) {
      const W = wallOf(d, side);
      for (const o of d.openings[side]) {
        if (o.door) continue;
        const fy = d.y0 + o.floor * d.h, yb = fy + o.bottom, yt = fy + o.top, ww = o.w, hh = yt - yb;
        // glazing bars + glass sit a third of the way into the wall
        const [gx, gz] = W.at(o.at, -d.thick * 0.33);
        const trim = this.M.trim || this.M.wood;
        if (st.glass > 0) {
          this.piece(0.05, hh, 0.05, trim, gx, yb, gz, W.rot, { shadow: false });
          this.piece(ww, 0.05, 0.05, trim, gx, yb + hh * 0.62, gz, W.rot, { shadow: false });
          if (this.chance(st.glass)) this.quad(ww - 0.08, hh - 0.08, this.glass, gx, yb + hh / 2, gz, W.rot);
        }
        // open shutters, flat against the wall either side of the window
        const lw = ww / 2 + 0.02;
        if (st.shutters && this._free(d, side, o.floor, o.at - ww / 2 - lw - 0.02, o.at - ww / 2 - 0.01, 0.05, o)
          && this._free(d, side, o.floor, o.at + ww / 2 + 0.01, o.at + ww / 2 + lw + 0.02, 0.05, o)) {
          for (const s of [-1, 1]) {
            const tilt = 0.12 + this.rand() * 0.25; // not perfectly flat: hinges sag
            const A = W.alongX ? [1, 0] : [0, 1];
            const dx = s * A[0] * Math.cos(tilt) + W.out[0] * Math.sin(tilt), dz = s * A[1] * Math.cos(tilt) + W.out[1] * Math.sin(tilt);
            const [hx, hz] = W.at(o.at + s * (ww / 2 + 0.01), 0.03);
            this.piece(lw, hh, 0.035, this.paint, hx + dx * lw / 2, yb, hz + dz * lw / 2, Math.atan2(-dz, dx), { shadow: true, cell: this.shutter(st.paint) });
          }
          this._take(d, side, o.floor, o.at - ww / 2 - lw - 0.05, o.at + ww / 2 + lw + 0.05);
        }
        // curtains hanging inside, pulled to the sides
        if (st.curtains && this.chance(0.5)) {
          const [rx, rz] = W.at(o.at, -(d.thick + 0.07));
          this.piece(ww + 0.4, 0.025, 0.025, this.iron, rx, yt + 0.12, rz, W.rot, { shadow: false });
          const ch = hh + 0.35, cell = this.fabric(st.fabric);
          for (const s of [-1, 1]) {
            if (this.chance(0.25)) continue;
            const cw = ww * (0.28 + this.rand() * 0.2);
            const A = W.alongX ? [1, 0] : [0, 1], off = s * (ww / 2 + 0.2 - cw / 2);
            this._curtain(cw, ch, cell, rx + A[0] * off, yt + 0.12 - ch / 2, rz + A[1] * off, W.rot);
          }
        }
        // a potted plant on the inner sill now and then
        if (st.curtains && this.chance(0.12)) {
          const [px, pz] = W.at(o.at + (this.rand() - 0.5) * ww * 0.6, -d.thick * 0.72);
          this._plant(px, yb, pz, 0.8);
        }
      }
    }
  }

  // A curtain: a plane with folds (sine waves) baked into its vertices
  _curtain(w, h, cell, x, y, z, rotY) {
    const geo = new THREE.PlaneGeometry(w, h, 10, 1);
    const pos = geo.attributes.position;
    const ph = this.rand() * TAU;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin(pos.getX(i) * 22 + ph) * 0.035);
    setUV(geo, cell);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, this.cloth);
    m.position.set(x, y, z);
    m.rotation.y = rotY;
    this.b.add(m, false);
  }

  // ---- grime: dirt splashed up from the ground, streaks under sills, drips ----
  _grime(d) {
    const top = d.y0 + d.floors * d.h;
    for (const side of ['n', 's', 'e', 'w']) {
      const W = wallOf(d, side), mid = (W.a0 + W.a1) / 2;
      const f0 = this.rand() * 0.5, f1 = Math.min(1, f0 + W.len / 9);
      let [x, z] = W.at(mid, 0.012);
      this.decal('dirtUp', W.len + 0.02, 1.1, x, d.y0 + 0.55, z, W.rot, { f0, f1 });
      if (d.parapet > 0) {
        [x, z] = W.at(mid, 0.065);
        this.decal('drip', W.len + 0.18, d.parapet * 0.95, x, top + d.parapet * 0.52, z, W.rot, { f0, f1 });
      } else {
        this.decal('drip', W.len, 0.7, x, top - 0.36, z, W.rot, { f0, f1 });
      }
      for (const o of d.openings[side]) {
        if (o.door) continue;
        const yb = d.y0 + o.floor * d.h + o.bottom - 0.06, hgt = Math.min(1.4, yb - d.y0 - 0.05);
        if (hgt < 0.3) continue;
        [x, z] = W.at(o.at, 0.014);
        this.decal('streak', o.w * 0.95, hgt, x, yb - hgt / 2, z, W.rot);
      }
    }
  }

  // ---- coping: the stone cap along the top of a roof parapet ----------------
  _coping(d) {
    if (!(d.parapet > 0) || !d.hasRoof) return;
    const y = d.y0 + d.floors * d.h + d.parapet, mat = this.M.band || this.M.concrete;
    const ladders = [].concat(d.ladder || []);
    const run = (side, axis, a0, a1, fixed) => {
      const cuts = ladders.filter((l) => l.side === side).map((l) => [l.at - 0.5, l.at + 0.5]).sort((p, q) => p[0] - q[0]);
      let cur = a0;
      for (const [s, e] of [...cuts, [a1, a1]]) {
        if (s - cur > 0.05) {
          const c = (cur + s) / 2;
          if (axis === 'x') this.b.box(c, y, fixed, s - cur, 0.06, 0.3, mat, { collide: false });
          else this.b.box(fixed, y, c, 0.3, 0.06, s - cur, mat, { collide: false });
        }
        cur = Math.max(cur, e);
      }
    };
    run('n', 'x', d.x0 - 0.12, d.x1 + 0.12, d.z0 + 0.05);
    run('s', 'x', d.x0 - 0.12, d.x1 + 0.12, d.z1 - 0.05);
    run('w', 'z', d.z0 + 0.2, d.z1 - 0.2, d.x0 + 0.05);
    run('e', 'z', d.z0 + 0.2, d.z1 - 0.2, d.x1 - 0.05);
  }

  // ---- a rain pipe down one corner ------------------------------------------
  _drainpipe(d, side) {
    const W = wallOf(d, side);
    const top = d.y0 + d.floors * d.h + (d.parapet || 0) - 0.12;
    const tries = this.chance(0.5) ? [W.a0 + 0.24, W.a1 - 0.24] : [W.a1 - 0.24, W.a0 + 0.24];
    for (const a of tries) {
      let ok = true;
      for (let f = 0; f < d.floors; f++) ok &&= this._clear(d, side, f, a - 0.12, a + 0.12, 0.02);
      if ([].concat(d.ladder || []).some((l) => l.side === side && Math.abs(l.at - a) < 1.3)) ok = false;
      if (!ok) continue;
      const [x, z] = W.at(a, 0.08), len = top - (d.y0 + 0.2);
      const mat = this.M.metal || this.iron;
      this.cylinder(0.045, len, mat, x, d.y0 + 0.2 + len / 2, z, { seg: 8 });
      const [hx, hz] = W.at(a, 0.11);
      this.piece(0.22, 0.2, 0.2, mat, hx, top - 0.1, hz, W.rot);                            // hopper head
      const [sx, sz] = W.at(a, 0.16);
      this.cylinder(0.045, 0.25, mat, sx, d.y0 + 0.16, sz, { seg: 8, rx: W.alongX ? -Math.PI / 4 * W.out[1] : 0, rz: W.alongX ? 0 : Math.PI / 4 * W.out[0] }); // shoe kicks outward
      for (let y = d.y0 + 1.4; y < top - 0.6; y += 1.8) this.piece(0.12, 0.04, 0.1, this.iron, x, y, z, W.rot, { shadow: false });
      for (let f = 0; f < d.floors; f++) this._take(d, side, f, a - 0.15, a + 0.15);
      return;
    }
  }

  // ---- the street side: house number, lamp, meter box, posters, plants, AC ---
  _frontage(d, st) {
    const side = st.front, W = wallOf(d, side);
    const door = d.openings[side].find((o) => o.door);
    if (door) {
      const s = this.chance(0.5) ? 1 : -1;
      // house number + a lamp beside the door
      let a = door.at + s * (door.w / 2 + 0.32);
      if (this._free(d, side, 0, a - 0.15, a + 0.15, 0.05)) {
        const [x, z] = W.at(a, 0.015);
        if (st.civil) this.signPlate(`num${(this.rand() * 12) | 0}`, 0.22, x, d.y0 + 1.95, z, W.rot);
        if (this.chance(0.45)) {
          const [lx, lz] = W.at(a, 0.08);
          this.piece(0.16, 0.06, 0.16, this.iron, lx, d.y0 + 2.42, lz, W.rot, { shadow: false });
          this.piece(0.12, 0.2, 0.12, this.lampGlass, lx, d.y0 + 2.22, lz, W.rot, { shadow: false });
          this.piece(0.15, 0.03, 0.15, this.iron, lx, d.y0 + 2.2, lz, W.rot, { shadow: false });
        }
        this._take(d, side, 0, a - 0.15, a + 0.15);
      }
      // electricity meter box on the other side
      a = door.at - s * (door.w / 2 + 0.45);
      if (this.chance(0.4) && this._free(d, side, 0, a - 0.2, a + 0.2, 0.05)) {
        const [x, z] = W.at(a, 0.07);
        this.piece(0.34, 0.44, 0.14, this.steel, x, d.y0 + 1.35, z, W.rot);
        this._take(d, side, 0, a - 0.2, a + 0.2);
      }
      // potted agave by the door (the little succulent model, scaled up)
      if (st.civil && this.chance(0.4) && this.has('potted_plant_04')) {
        const a2 = door.at + s * (door.w / 2 + 0.5);
        if (this._free(d, side, 0, a2 - 0.25, a2 + 0.25, 0)) {
          const [x, z] = W.at(a2, 0.3);
          if (!this.blocked(x - 0.25, d.y0 + 0.1, z - 0.25, x + 0.25, d.y0 + 1, z + 0.25)) {
            this.P.add('potted_plant_04', x, z, { y: d.y0, scale: 2.3 + this.rand() * 0.8, rotY: this.rand() * TAU, collide: false });
          }
        }
      }
    }
    // posters and graffiti on bare wall (any side, ground floor)
    const n = st.civil ? (this.rand() * 3.2) | 0 : 0;
    for (let i = 0; i < n; i++) {
      const sd = this.chance(0.6) ? side : this.pick(['n', 's', 'e', 'w']);
      const Wd = wallOf(d, sd), graffiti = this.chance(0.4);
      const w = graffiti ? 1.3 + this.rand() * 0.8 : 0.5 + this.rand() * 0.15, h = graffiti ? w * 0.5 : w * 1.38;
      const a = this.r(Wd.a0 + w / 2 + 0.3, Wd.a1 - w / 2 - 0.3);
      if (!this._free(d, sd, 0, a - w / 2, a + w / 2, 0.15)) continue;
      const [x, z] = Wd.at(a, 0.016 + i * 0.002);
      const y = d.y0 + (graffiti ? 0.5 + this.rand() * 0.5 + h / 2 : 1.25 + this.rand() * 0.5 + h / 2);
      this.decal(graffiti ? `graf${(this.rand() * 6) | 0}` : `poster${(this.rand() * 6) | 0}`, w, h, x, y, z, Wd.rot);
      this._take(d, sd, 0, a - w / 2, a + w / 2);
    }
    // a wall-mounted air conditioner beside an upper window
    if (d.floors > 1 && this.chance(0.25) && this.has('exterior_aircon_unit')) {
      const Wd = wallOf(d, side);
      for (const o of d.openings[side]) {
        if (o.floor !== 1 || o.door) continue;
        const a = o.at + (o.w / 2 + 0.6);
        if (!this._free(d, side, 1, a - 0.52, a + 0.52, 0.05)) continue;
        const [x, z] = Wd.at(a, 0.12);
        this.P.add('exterior_aircon_unit', x, z, { y: d.y0 + d.h + 0.4, rotY: Wd.rot, scale: 0.55, collide: false });
        this._take(d, side, 1, a - 0.52, a + 0.52);
        break;
      }
    }
  }

  // ---- shop: sign board, striped awning, goods outside ----------------------
  _shopfront(d, st) {
    const side = st.front, W = wallOf(d, side);
    const door = d.openings[side].find((o) => o.door);
    if (!door) return;
    const bw = Math.min(3.2, W.len - 1.2), a = Math.min(Math.max(door.at, W.a0 + bw / 2 + 0.3), W.a1 - bw / 2 - 0.3);
    // sign board above the door (between the door top and the next floor/parapet)
    let [x, z] = W.at(a, 0.04);
    const sy = d.y0 + 2.42;
    this.piece(bw, 0.6, 0.06, this.M.trim || this.M.wood, x, sy, z, W.rot);
    [x, z] = W.at(a, 0.075);
    const name = typeof st.shop === 'string' ? st.shop : this.pick(SHOPS);
    this.quad(bw - 0.12, 0.5, this.sign, x, sy + 0.3, z, W.rot, { cell: this.signs.cells[`shop:${name}`] || this.signs.cells[`shop:${SHOPS[0]}`], shadow: false });
    // awning: a sloping striped canvas, its valance (front flap) and two iron arms
    const aw = Math.min(bw, door.w + 1.6), out = 1.15, drop = 0.38;
    const slope = Math.atan2(drop, out), sl = Math.hypot(out, drop);
    const mat = this.cloth, cell = this.cloths.cells[`awning${(this.rand() * AWNINGS.length) | 0}`];
    [x, z] = W.at(door.at, out / 2);
    this.piece(aw, 0.02, sl, mat, x, d.y0 + 2.36 - drop / 2, z, W.rot, { tiltX: slope, cell });
    [x, z] = W.at(door.at, out);
    this.piece(aw, 0.22, 0.01, mat, x, d.y0 + 2.36 - drop - 0.22, z, W.rot, { cell });
    for (const s of [-1, 1]) {
      [x, z] = W.at(door.at + s * (aw / 2 - 0.05), out / 2);
      this.piece(0.025, 0.025, sl, this.iron, x, d.y0 + 2.34 - drop / 2, z, W.rot, { tiltX: slope, shadow: false });
    }
    this._take(d, side, 0, a - bw / 2, a + bw / 2);
    // goods stacked outside, against the wall, beside the door
    for (const s of [-1, 1]) {
      if (!this.chance(0.6)) continue;
      const a2 = door.at + s * (door.w / 2 + 0.75);
      if (a2 < W.a0 + 0.5 || a2 > W.a1 - 0.5) continue;
      const [gx, gz] = W.at(a2, 0.3);
      if (this.blocked(gx - 0.45, d.y0 + 0.05, gz - 0.3, gx + 0.45, d.y0 + 1, gz + 0.3)) continue;
      let y = d.y0;
      for (let k = 0; k < 1 + ((this.rand() * 3) | 0); k++) {
        const bw2 = 0.35 + this.rand() * 0.25, bh = 0.22 + this.rand() * 0.18;
        this.piece(bw2, bh, 0.35 + this.rand() * 0.15, this.cardboard, gx + (this.rand() - 0.5) * 0.12, y, gz, W.rot + (this.rand() - 0.5) * 0.4);
        y += bh;
      }
    }
    if (this.chance(0.5) && this.has('plastic_monobloc_chair_01')) {
      const a3 = door.at - (door.w / 2 + 0.7) * (this.chance(0.5) ? 1 : -1);
      const [cx, cz] = W.at(a3, 0.6);
      if (!this.blocked(cx - 0.35, d.y0 + 0.05, cz - 0.35, cx + 0.35, d.y0 + 1, cz + 0.35)) {
        this.P.add('plastic_monobloc_chair_01', cx, cz, { y: d.y0, rotY: W.rot + (this.rand() - 0.5) * 1.2, collide: false });
      }
    }
  }

  // ---- balcony: concrete slab, iron railing, brackets ----------------------
  _balcony(d, side, st) {
    const W = wallOf(d, side);
    const wins = d.openings[side].filter((o) => o.floor === 1 && !o.door);
    for (const o of wins.sort(() => this.rand() - 0.5)) {
      const bw = 2.4, dep = 0.95;
      // room on the upper floor (this window itself is fine) and nothing hung below it
      if (!this._free(d, side, 1, o.at - bw / 2, o.at + bw / 2, 0.1, o) || !this._clear(d, side, 0, o.at - bw / 2, o.at + bw / 2, -10)) continue;
      const top = d.y0 + d.h;
      const [cx, cz] = W.at(o.at, dep / 2);
      if (W.alongX) this.b.box(cx, top - 0.16, cz, bw, 0.16, dep, this.M.band || this.M.concrete, { surface: 'concrete' });
      else this.b.box(cx, top - 0.16, cz, dep, 0.16, bw, this.M.band || this.M.concrete, { surface: 'concrete' });
      // railing: front + two sides (picture of iron bars with see-through gaps)
      const rail = this.mat('railing', () => new THREE.MeshStandardMaterial({ map: this._railTex(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.6 }));
      let [x, z] = W.at(o.at, dep - 0.03);
      this.quad(bw - 0.04, 1.0, rail, x, top + 0.5, z, W.rot, { shadow: true });
      this.piece(bw, 0.04, 0.05, this.iron, x, top + 1.0, z, W.rot);
      this.world.add(...this._aabb(x, z, W, bw, 0.06, top, top + 1.05), { solid: false });
      const A = W.alongX ? [1, 0] : [0, 1];
      for (const s of [-1, 1]) {
        [x, z] = W.at(o.at, dep / 2);
        x += A[0] * s * (bw / 2 - 0.02); z += A[1] * s * (bw / 2 - 0.02);
        this.quad(dep, 1.0, rail, x, top + 0.5, z, W.rot + Math.PI / 2, { shadow: true });
        this.piece(0.05, 0.04, dep, this.iron, x, top + 1.0, z, W.rot);
        this.world.add(...this._aabb(x, z, W, 0.06, dep, top, top + 1.05), { solid: false });
        // brackets under the slab
        [x, z] = W.at(o.at + s * (bw / 2 - 0.3), 0.3);
        this.piece(0.1, 0.25, 0.6, this.M.band || this.M.concrete, x, top - 0.41, z, W.rot);
      }
      // a few pots on the balcony
      if (this.has('planter_pot_clay')) {
        for (let k = 0; k < 2; k++) {
          [x, z] = W.at(o.at + (k ? 1 : -1) * (bw / 2 - 0.35), dep - 0.3);
          this.P.add('planter_pot_clay', x, z, { y: top, scale: 1.4, rotY: this.rand() * TAU, collide: false });
          if (this.has('potted_plant_04')) this.P.add('potted_plant_04', x, z, { y: top + 0.05, scale: 1.8, rotY: this.rand() * TAU, collide: false });
        }
      }
      this._take(d, side, 1, o.at - bw / 2, o.at + bw / 2);
      this._take(d, side, 0, o.at - bw / 2, o.at + bw / 2); // nothing tall right under it either
      return;
    }
  }

  // Axis-aligned box (min, max) for something w wide (along the wall) and dp deep
  _aabb(x, z, W, w, dp, y0, y1) {
    const hx = (W.alongX ? w : dp) / 2, hz = (W.alongX ? dp : w) / 2;
    return [new THREE.Vector3(x - hx, y0, z - hz), new THREE.Vector3(x + hx, y1, z + hz)];
  }

  // ---- pitched tile roof (single-storey houses) -----------------------------
  // Sits on top of the parapet like a real roof sits on the wall tops: two
  // sloping planes of clay tiles, triangular gable walls at the ends, a ridge
  // cap and fascia boards along the eaves.
  _pitchedRoof(d) {
    const top = d.y0 + d.h + d.parapet;
    // Anything already on the roof (water tank, AC unit) or a ladder up to it? Then keep it flat.
    if (this.world.boxBlocked(d.x0 + 0.3, d.y0 + d.h + 0.05, d.z0 + 0.3, d.x1 - 0.3, d.y0 + d.h + 2.5, d.z1 - 0.3)
      || [].concat(d.ladder || []).length) { this._roofClutter(d); return; }
    const alongX = d.x1 - d.x0 >= d.z1 - d.z0;
    const ov = 0.35, pitch = 0.5; // 0.5 rad ≈ 29°
    const x0 = d.x0 - 0.12 - ov, x1 = d.x1 + 0.12 + ov, z0 = d.z0 - 0.12 - ov, z1 = d.z1 + 0.12 + ov;
    const L = alongX ? x1 - x0 : z1 - z0, S = alongX ? z1 - z0 : x1 - x0;   // ridge length, span
    const run = S / 2, rise = run * Math.tan(pitch), slope = run / Math.cos(pitch);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, eaveY = top - ov * Math.tan(pitch);
    const tiles = this.M.tiles || this.M.roof, tile = tiles.userData.tile || 2;
    for (const s of [-1, 1]) {
      const geo = new THREE.BoxGeometry(L, 0.08, slope);
      const uv = geo.attributes.uv, pos = geo.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + L / 2) / tile, (pos.getZ(i) + slope / 2) / tile);
      const m = new THREE.Mesh(geo, tiles);
      // centre of this slope: halfway between the eave and the ridge
      const off = s * run / 2;
      m.position.set(alongX ? cx : cx + off, eaveY + rise / 2 + 0.04, alongX ? cz + off : cz);
      // tip it about the ridge so it falls away from the middle (YXZ: tilt, then turn)
      m.rotation.set(s * pitch, alongX ? 0 : Math.PI / 2, 0, 'YXZ');
      this.b.add(m);
      // fascia board along this eave
      const fx = alongX ? cx : cx + s * (run - 0.02), fz = alongX ? cz + s * (run - 0.02) : cz;
      this.piece(alongX ? L : 0.05, 0.2, alongX ? 0.05 : L, this.M.trim || this.M.wood, fx, eaveY - 0.18, fz, 0);
    }
    // ridge cap
    this.piece(alongX ? L + 0.04 : 0.3, 0.14, alongX ? 0.3 : L + 0.04, tiles, cx, eaveY + rise + 0.02, cz, 0);
    // gable triangles (wall material) at both ends, filling under the slopes
    const wall = d.wall || this.M.wall;
    const wt = wall.userData.tile || 2;
    for (const e of [-1, 1]) {
      const end = alongX ? (e < 0 ? d.x0 - 0.05 : d.x1 + 0.05) : (e < 0 ? d.z0 - 0.05 : d.z1 + 0.05);
      const half = (alongX ? d.z1 - d.z0 : d.x1 - d.x0) / 2 + 0.1;
      const h = (half - 0.02) * Math.tan(pitch);   // just under the tiles
      // A triangle, written out by hand: 3 corners, twice (one copy facing out,
      // one facing in) so it's solid from both sides. It must be INDEXED like
      // the boxes, or builder.finalize() couldn't merge it with them.
      const tri = alongX
        ? [[end, top - 0.02, cz - half], [end, top - 0.02, cz + half], [end, top + h, cz]]
        : [[cx - half, top - 0.02, end], [cx + half, top - 0.02, end], [cx, top + h, end]];
      const pos = [...tri.flat(), ...tri.flat()];
      const nrm = alongX ? [1, 0, 0] : [0, 0, 1];
      const nor = [...Array(3).fill(nrm.map((v) => v * e)).flat(), ...Array(3).fill(nrm.map((v) => -v * e)).flat()];
      const uv = [...tri, ...tri].flatMap((p) => [(alongX ? p[2] : p[0]) / wt, p[1] / wt]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      // winding decides which side is the front: flip it for the inner copy
      const out = (alongX ? e > 0 : e < 0);
      geo.setIndex(out ? [0, 2, 1, 3, 4, 5] : [0, 1, 2, 3, 5, 4]);
      this.b.add(new THREE.Mesh(geo, wall));
    }
    // a chimney on some
    if (this.chance(0.5)) {
      const t = this.r(-0.3, 0.3) * L;
      const chx = alongX ? cx + t : cx + run * 0.35, chz = alongX ? cz + run * 0.35 : cz + t;
      this.b.box(chx, top - 0.3, chz, 0.5, rise + 0.9, 0.5, wall, { collide: false });
      this.b.box(chx, top + rise + 0.6, chz, 0.62, 0.08, 0.62, this.M.band || this.M.concrete, { collide: false });
    }
    // One collider for the whole roof: bullets stop, nobody walks up there
    this.world.add(new THREE.Vector3(x0 + ov, top - 0.1, z0 + ov), new THREE.Vector3(x1 - ov, top + rise * 0.7, z1 - ov), { surface: 'concrete', pen: 0.6 });
    d.pitched = true;
  }

  // ---- roof clutter on flat roofs: satellite dish, aerial, laundry, chairs ---
  _roofClutter(d) {
    const top = d.y0 + d.floors * d.h;
    const ladders = [].concat(d.ladder || []).map((l) => wallOf(d, l.side).at(l.at, -1.2));
    const clear = (x, z, r, h = 1.8) => !this.blocked(x - r, top + 0.1, z - r, x + r, top + h, z + r)
      && ladders.every(([lx, lz]) => Math.hypot(lx - x, lz - z) > r + 1.8);
    const corners = [[d.x0 + 1.1, d.z0 + 1.1], [d.x1 - 1.1, d.z0 + 1.1], [d.x0 + 1.1, d.z1 - 1.1], [d.x1 - 1.1, d.z1 - 1.1]].sort(() => this.rand() - 0.5);
    let used = 0;
    if (this.chance(0.45)) {
      const c = corners.find(([x, z]) => clear(x, z, 0.6)); if (c) { this._dish(c[0], top, c[1]); corners.splice(corners.indexOf(c), 1); used++; }
    }
    if (this.chance(0.25)) {
      const c = corners.find(([x, z]) => clear(x, z, 0.5, 2.8)); if (c) { this._aerial(c[0], top, c[1]); corners.splice(corners.indexOf(c), 1); used++; }
    }
    if (d.floors > 1 && this.chance(0.3)) this._laundry(d, top, clear);
    if (this.chance(0.2) && this.has('plastic_monobloc_chair_01')) {
      const c = corners.find(([x, z]) => clear(x, z, 0.5));
      if (c) this.P.add('plastic_monobloc_chair_01', c[0], c[1], { y: top, rotY: this.rand() * TAU, collide: false });
    }
    if (this.chance(0.2) && this.has('old_tyre')) {
      const c = corners.find(([x, z]) => clear(x, z, 0.5));
      if (c) this.P.add('old_tyre', c[0], c[1], { y: top + 0.32, rotY: this.rand() * TAU, tilt: [Math.PI / 2, 0], collide: false });
    }
    return used;
  }

  _dish(x, y, z) {
    const white = this.mat('dish', () => new THREE.MeshStandardMaterial({ color: 0xd8d6d0, roughness: 0.5, metalness: 0.2, side: THREE.DoubleSide }));
    this.cylinder(0.03, 1.1, this.steel, x, y + 0.55, z, { seg: 6 });
    this.piece(0.3, 0.03, 0.3, this.steel, x, y, z, 0);
    const yaw = this.rand() * TAU;
    // the dish: a shallow slice of a sphere, tipped up toward the sky
    const geo = new THREE.SphereGeometry(0.55, 16, 6, 0, TAU, 0, 0.62);
    const m = new THREE.Mesh(geo, white);
    m.position.set(x, y + 1.1, z);
    m.rotation.set(-1.15, yaw, 0, 'YXZ');
    m.position.add(new THREE.Vector3(Math.sin(yaw) * 0.25, 0.1, Math.cos(yaw) * 0.25));
    this.b.add(m);
    // the arm holding the receiver
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.6, 5), this.steel);
    arm.position.set(x + Math.sin(yaw) * 0.45, y + 1.4, z + Math.cos(yaw) * 0.45);
    arm.rotation.set(0.8, yaw, 0, 'YXZ');
    this.b.add(arm, false);
  }

  _aerial(x, y, z) {
    this.cylinder(0.025, 2.6, this.steel, x, y + 1.3, z, { seg: 6 });
    const yaw = this.rand() * Math.PI;
    for (let k = 0; k < 4; k++) this.piece(1.1 - k * 0.15, 0.015, 0.015, this.steel, x, y + 1.8 + k * 0.22, z, yaw, { shadow: false });
    this.piece(0.015, 0.015, 1.3, this.steel, x, y + 2.45, z, yaw, { shadow: false });
  }

  _laundry(d, top, clear) {
    const alongX = d.x1 - d.x0 > d.z1 - d.z0;
    const c = alongX ? (d.z0 + d.z1) / 2 + this.r(-1, 1) : (d.x0 + d.x1) / 2 + this.r(-1, 1);
    const a0 = (alongX ? d.x0 : d.z0) + 1.5, a1 = a0 + Math.min(4, (alongX ? d.x1 - d.x0 : d.z1 - d.z0) - 3);
    const P = (a) => (alongX ? [a, c] : [c, a]);
    if (!clear(...P(a0), 0.3, 1.8) || !clear(...P(a1), 0.3, 1.8) || !clear(...P((a0 + a1) / 2), 0.3, 1.8)) return;
    for (const a of [a0, a1]) { const [x, z] = P(a); this.cylinder(0.025, 1.75, this.steel, x, top + 0.875, z, { seg: 5 }); }
    const [mx, mz] = P((a0 + a1) / 2);
    this.piece(alongX ? a1 - a0 : 0.01, 0.01, alongX ? 0.01 : a1 - a0, this.iron, mx, top + 1.7, mz, 0, { shadow: false });
    // clothes: fabric rectangles of various sizes hanging from the line
    for (let a = a0 + 0.35; a < a1 - 0.3; a += 0.35 + this.rand() * 0.45) {
      const w = 0.3 + this.rand() * 0.45, h = 0.35 + this.rand() * 0.55;
      const [x, z] = P(a + w / 2);
      this._curtain(w, h, this.fabric((this.rand() * FABRICS.length) | 0), x, top + 1.7 - h / 2, z, alongX ? 0 : Math.PI / 2);
      a += w;
    }
  }

  // ---- any prop standing against the outside of a wall (utility box, bins...)
  // Finds a free stretch of the ground floor wall; returns false if none.
  againstWall(d, side, id, w, dep, opts = {}) {
    if (!this.has(id)) return false;
    const W = wallOf(d, side);
    for (let k = 0; k < 8; k++) {
      const a = this.r(W.a0 + w / 2 + 0.4, W.a1 - w / 2 - 0.4);
      if (!this._free(d, side, 0, a - w / 2, a + w / 2, 0.15)) continue;
      const [x, z] = W.at(a, dep / 2 + 0.03);
      if (this.blocked(x - w / 2, d.y0 + 0.1, z - w / 2, x + w / 2, d.y0 + 1.2, z + w / 2)) continue;
      this.P.add(id, x, z, { y: d.y0, rotY: W.rot, ...opts });
      this._take(d, side, 0, a - w / 2, a + w / 2);
      return true;
    }
    return false;
  }

  // ---- a ruined house: scorch marks, a few wrecked bits of furniture --------
  _ruin(d) {
    for (const side of ['n', 's', 'e', 'w']) {
      if (!this.chance(0.6)) continue;
      const W = wallOf(d, side), a = this.r(W.a0 + 1.5, W.a1 - 1.5);
      const [x, z] = W.at(a, 0.015);
      const s = 1.6 + this.rand() * 1.2;
      this.decal('scorch', s, s, x, d.y0 + 0.4 + s * 0.4, z, W.rot);
    }
    const cx = (d.x0 + d.x1) / 2, cz = (d.z0 + d.z1) / 2;
    this.decal('scorch', 4, 4, cx + this.r(-1, 1), d.y0 + 0.05, cz + this.r(-1, 1), this.rand() * TAU, { tiltX: -Math.PI / 2 });
    const junk = ['painted_wooden_chair_01', 'painted_wooden_chair_02', 'painted_wooden_cabinet', 'painted_wooden_nightstand', 'WoodenTable_01'].filter((id) => this.has(id));
    for (let i = 0; i < 4 && junk.length; i++) {
      const x = this.r(d.x0 + 1, d.x1 - 1), z = this.r(d.z0 + 1, d.z1 - 1);
      this.P.add(this.pick(junk), x, z, { y: d.y0 - 0.05, rotY: this.rand() * TAU, tilt: [(this.rand() - 0.5) * 0.6, (this.rand() - 0.5) * 0.6], collide: false });
    }
  }

  // ===========================================================================
  // INTERIORS
  // A room is the floor rectangle inside the walls. Its "faces" are the inner
  // wall surfaces (plus both sides of any interior wall). `occ` is a list of
  // rectangles already taken — doorways, stairs, AI spots, furniture — so new
  // pieces only go where they fit and nobody's path gets blocked.
  // ===========================================================================
  furnish(d, f, kind, st = {}) {
    const R = this._room(d, f);
    const fn = { living: this._living, bedroom: this._bedroom, shop: this._shop, office: this._office, barracks: this._barracks, workshop: this._workshop, bunker: this._bunker }[kind];
    if (fn) fn.call(this, R, st);
  }

  _room(d, f) {
    const t = d.thick, y = d.y0 + f * d.h + (f === 0 ? 0.03 : 0);
    const R = { d, f, y, x0: d.x0 + t, x1: d.x1 - t, z0: d.z0 + t, z1: d.z1 - t, faces: [], occ: [], tall: [], hung: [] };
    const face = (side, axis, fixed, a0, a1, nx, nz, ops) => R.faces.push({ side, axis, fixed, a0, a1, nx, nz, ops, rot: Math.atan2(nx, nz) });
    const ops = (side) => d.openings[side].filter((o) => o.floor === f);
    face('n', 'x', R.z0, R.x0, R.x1, 0, 1, ops('n'));
    face('s', 'x', R.z1, R.x0, R.x1, 0, -1, ops('s'));
    face('w', 'z', R.x0, R.z0, R.z1, 1, 0, ops('w'));
    face('e', 'z', R.x1, R.z0, R.z1, -1, 0, ops('e'));
    if (f === 0) {
      for (const iw of d.interior || []) {
        const dr = (iw.doors || []).map((v) => ({ at: typeof v === 'number' ? v : v.at, w: 1.4, bottom: 0, top: 2.2, door: true }));
        if (iw.axis === 'x') {
          face('i', 'x', iw.fixed - 0.1, iw.a0, iw.a1, 0, -1, dr); face('i', 'x', iw.fixed + 0.1, iw.a0, iw.a1, 0, 1, dr);
          R.occ.push([iw.a0, iw.fixed - 0.1, iw.a1, iw.fixed + 0.1]);
        } else {
          face('i', 'z', iw.fixed - 0.1, iw.a0, iw.a1, -1, 0, dr); face('i', 'z', iw.fixed + 0.1, iw.a0, iw.a1, 1, 0, dr);
          R.occ.push([iw.fixed - 0.1, iw.a0, iw.fixed + 0.1, iw.a1]);
        }
      }
    }
    // keep 1.7 m clear in front of every doorway
    for (const F of R.faces) for (const o of F.ops) if (o.door) R.occ.push(this._rect(F, o.at - o.w / 2 - 0.35, o.at + o.w / 2 + 0.35, 0, 1.7));
    // stairs (and the landing at the top)
    const s = d.stairs;
    if (s && d.floors > 1) {
      const L = Math.ceil(d.h / 0.21) * 0.28, w = (s.width || 1.2) / 2 + 0.35;
      const [b, e] = f === 0 ? [-1.4, L + 0.3] : [-0.5, L + 1.5];
      R.occ.push(s.dir === 'x' ? [s.x + b, s.z - w, s.x + e, s.z + w] : [s.x - w, s.z + b, s.x + w, s.z + e]);
    }
    // spots the AI stands on, and the middle of the ground floor
    for (const k of this.keep) {
      const kf = k.y !== undefined && k.y > d.y0 + 1 ? Math.round((k.y - d.y0) / d.h) : 0;
      if (kf === f && k.x > d.x0 && k.x < d.x1 && k.z > d.z0 && k.z < d.z1) R.occ.push([k.x - 1.4, k.z - 1.4, k.x + 1.4, k.z + 1.4]);
    }
    if (f === 0) {
      const cx = d.x0 + (d.x1 - d.x0) * 0.55, cz = (d.z0 + d.z1) / 2;
      R.occ.push([cx - 1.6, cz - 1.4, cx + 1.6, cz + 1.4]);
    }
    return R;
  }

  // Rectangle in front of a face: from a0..a1 along it, d0..d1 metres into the room
  _rect(F, a0, a1, d0, d1) {
    if (F.axis === 'x') { const p = F.fixed + F.nz * d0, q = F.fixed + F.nz * d1; return [a0, Math.min(p, q), a1, Math.max(p, q)]; }
    const p = F.fixed + F.nx * d0, q = F.fixed + F.nx * d1;
    return [Math.min(p, q), a0, Math.max(p, q), a1];
  }
  _fits(R, r) {
    if (r[0] < R.x0 - 0.01 || r[2] > R.x1 + 0.01 || r[1] < R.z0 - 0.01 || r[3] > R.z1 + 0.01) return false;
    if (R.occ.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])) return false;
    // and nothing the map already put in the room (a parked truck, crates, a door leaf...)
    return !this.world.boxBlocked(r[0] + 0.02, R.y + 0.1, r[1] + 0.02, r[2] - 0.02, R.y + 1.6, r[3] - 0.02);
  }
  // Point `dist` metres into the room from face F at `a` along it
  _pt(F, a, dist) { return F.axis === 'x' ? [a, F.fixed + F.nz * dist] : [F.fixed + F.nx * dist, a]; }

  // Find a free stretch of wall for `it` (w along the wall, d deep).
  // Tall things never stand in front of a window; nothing stands in a doorway.
  _wallSpot(R, it, { faces = R.faces, tries = 14, at = null, F: fixedF = null, gap = 0.03 } = {}) {
    for (let k = 0; k < tries; k++) {
      const F = fixedF || this.pick(faces);
      if (F.a1 - F.a0 < it.w + 0.2) continue;
      const a = at ?? this.r(F.a0 + 0.06 + it.w / 2, F.a1 - 0.06 - it.w / 2);
      const lo = a - it.w / 2, hi = a + it.w / 2;
      if (F.ops.some((o) => lo < o.at + o.w / 2 + 0.1 && hi > o.at - o.w / 2 - 0.1 && (o.door || it.h > o.bottom - 0.05))) { if (at !== null) return null; continue; }
      const rect = this._rect(F, lo, hi, 0, it.d + gap);
      if (!this._fits(R, rect)) { if (at !== null) return null; continue; }
      R.occ.push(rect);
      if (it.h > 1.2) R.tall.push([F, lo, hi]);
      const [x, z] = this._pt(F, a, it.d / 2 + gap);
      return { x, z, rot: F.rot, F, a };
    }
    return null;
  }

  // Put a catalogue piece at a spot found by _wallSpot
  _put(R, key, s, { rot = 0, collide = true } = {}) {
    const it = FURN[key];
    this.P.add(it.id, s.x, s.z, {
      y: R.y, rotY: s.rot + rot, scale: it.scale, collide, cover: !!it.cover, pen: it.pen ?? 0.4, surface: it.surface || 'wood', shadow: false,
    });
  }

  // A picture, clock or map on a bare stretch of wall at eye height
  _hang(R, kind) {
    const sizes = { frame: [0.6, 0.46], clock: [0.32, 0.32], map: [1.4, 1.0], board: [1.2, 0.8] };
    const [w, h] = sizes[kind];
    for (let k = 0; k < 10; k++) {
      const F = this.pick(R.faces);
      if (F.a1 - F.a0 < w + 0.6) continue;
      const a = this.r(F.a0 + w / 2 + 0.3, F.a1 - w / 2 - 0.3), lo = a - w / 2 - 0.1, hi = a + w / 2 + 0.1;
      if (F.ops.some((o) => lo < o.at + o.w / 2 && hi > o.at - o.w / 2)) continue;
      if (R.tall.some(([G, l, r]) => G === F && lo < r && hi > l)) continue;
      if (R.hung.some(([G, l, r]) => G === F && lo < r && hi > l)) continue;
      R.hung.push([F, lo, hi]);
      const yc = R.y + (kind === 'map' || kind === 'board' ? 1.55 : 1.5 + this.rand() * 0.3);
      if (kind === 'frame' || kind === 'clock') {
        const id = kind === 'frame' ? 'fancy_picture_frame_01' : 'wall_clock';
        if (!this.has(id)) return;
        const [x, z] = this._pt(F, a, kind === 'clock' ? 0.035 : 0.02);
        this.P.add(id, x, z, { y: yc - h / 2, rotY: F.rot + (this.rand() - 0.5) * 0.04, collide: false, shadow: false });
      } else {
        const [x, z] = this._pt(F, a, 0.02);
        this.piece(w + 0.06, h + 0.06, 0.02, this.M.trim || this.M.wood, x, yc - h / 2 - 0.03, z, F.rot, { shadow: false });
        const [x2, z2] = this._pt(F, a, 0.032);
        this.quad(w, h, this.sign, x2, yc, z2, F.rot, { cell: this.signs.cells[kind] });
      }
      return;
    }
  }

  _rug(R, x, z, w, d) {
    const i = (this.rand() * 3) | 0;
    this.quad(Math.min(w, d), Math.max(w, d), this.cloth, x, R.y + 0.006, z, w > d ? Math.PI / 2 : 0, { tiltX: -Math.PI / 2, cell: this.cloths.cells[`rug${i}`] });
  }

  // A table with chairs round it, free-standing, with room to walk around it
  _dining(R, { chair = this.pick(CHAIRS), rug = 0.6 } = {}) {
    const T = FURN.table, alongX = this.chance(0.5);
    const hx = alongX ? T.w / 2 + 0.15 : T.d / 2 + 0.6, hz = alongX ? T.d / 2 + 0.6 : T.w / 2 + 0.15;
    if (R.x1 - R.x0 < 2 * (hx + 0.75) || R.z1 - R.z0 < 2 * (hz + 0.75)) return false;
    for (let k = 0; k < 24; k++) {
      const x = this.r(R.x0 + hx + 0.75, R.x1 - hx - 0.75), z = this.r(R.z0 + hz + 0.75, R.z1 - hz - 0.75);
      const pad = [x - hx - 0.6, z - hz - 0.6, x + hx + 0.6, z + hz + 0.6];
      if (!this._fits(R, pad)) continue;
      R.occ.push(pad);
      const rot = (alongX ? 0 : Math.PI / 2) + (this.rand() - 0.5) * 0.1;
      this.P.add(T.id, x, z, { y: R.y, rotY: rot, scale: T.scale, cover: true, pen: 0.4, surface: 'wood', shadow: false });
      for (const s of [-1, 1]) {
        for (const k2 of [-0.5, 0.5]) {
          if (this.chance(0.2) || !this.has(chair)) continue;
          const pull = 0.55 + this.rand() * 0.3, along = k2 + (this.rand() - 0.5) * 0.15;
          const cx = x + (alongX ? along : s * pull), cz = z + (alongX ? s * pull : along);
          const face = alongX ? (s > 0 ? Math.PI : 0) : -s * Math.PI / 2;
          this.P.add(chair, cx, cz, { y: R.y, rotY: face + (this.rand() - 0.5) * 0.5, collide: false, shadow: false });
        }
      }
      if (this.chance(0.55)) this._tableTop(x + this.r(-0.3, 0.3), R.y + T.top, z + this.r(-0.15, 0.15), alongX ? 0 : Math.PI / 2);
      if (this.chance(rug)) this._rug(R, x, z, (alongX ? T.w : T.d) + 1.2, (alongX ? T.d : T.w) + 1.2);
      return true;
    }
    return false;
  }

  // Goods on shelf boards: cardboard boxes and tins
  _stock(R, s, it, { cans = true } = {}) {
    const A = [Math.cos(s.rot), -Math.sin(s.rot)]; // the shelf's width direction
    for (const lv of it.levels || []) {
      let a = -it.w / 2 + 0.06;
      while (a < it.w / 2 - 0.12) {
        if (this.chance(0.25)) { a += 0.15 + this.rand() * 0.2; continue; }
        const useCan = cans && this.chance(0.35);
        const bw = useCan ? 0.17 : 0.12 + this.rand() * 0.22;
        if (a + bw > it.w / 2 - 0.04) break;
        const px = s.x + A[0] * (a + bw / 2), pz = s.z + A[1] * (a + bw / 2);
        if (useCan) this._tins(px, R.y + lv, pz, s.rot, 2);
        else this.piece(bw, 0.1 + this.rand() * 0.14, Math.min(it.d - 0.06, 0.18 + this.rand() * 0.2), this.cardboard, px, R.y + lv, pz, s.rot + (this.rand() - 0.5) * 0.15, { shadow: false });
        a += bw + 0.02 + this.rand() * 0.06;
      }
    }
  }

  _living(R, st) {
    // a sofa with a low table in front, maybe on a rug
    const sofaKey = this.has('sofa_02') && this.chance(0.5) ? 'sofa' : 'sofaWood';
    let s = this._wallSpot(R, FURN[sofaKey]);
    if (s) {
      this._put(R, sofaKey, s);
      const T = FURN.lowTable, dist = FURN[sofaKey].d + 0.45;
      const rect = this._rect(s.F, s.a - T.w / 2, s.a + T.w / 2, dist, dist + T.d);
      if (this.chance(0.7) && this._fits(R, rect)) {
        R.occ.push(rect);
        const [x, z] = this._pt(s.F, s.a, dist + T.d / 2);
        this._put(R, 'lowTable', { x, z, rot: s.rot }, { collide: true });
        if (this.chance(0.5)) this._rug(R, x, z, 2.4, 1.7);
      }
    }
    // sideboard with a TV or a vase on it
    s = this._wallSpot(R, FURN.sideboard);
    if (s) {
      this._put(R, 'sideboard', s);
      if (this.chance(0.5) && this.has('Television_01')) this.P.add('Television_01', s.x, s.z, { y: R.y + FURN.sideboard.top, rotY: s.rot + (this.rand() - 0.5) * 0.3, collide: false, shadow: false });
      else this._tableTop(s.x, R.y + FURN.sideboard.top, s.z, s.rot);
    }
    // tall storage
    for (let i = 0; i < 1 + (this.rand() < 0.5 ? 1 : 0); i++) {
      const key = this.pick(['wardrobe', 'bookcase', 'bookcase', 'tallShelf', 'shelves']);
      s = this._wallSpot(R, FURN[key]);
      if (s && key === 'bookcase') this._bookcase(R, s);
      else if (s) { this._put(R, key, s); if (FURN[key].levels) this._stock(R, s, FURN[key], { cans: false }); }
    }
    this._kitchen(R);
    const dined = this._dining(R);
    if (!dined && this.chance(0.7)) this._rug(R, (R.x0 + R.x1) / 2, (R.z0 + R.z1) / 2, 2.4, 3.4);
    if (this.chance(0.6)) { s = this._wallSpot(R, { w: 0.6, d: 0.6, h: 1.0 }); if (s) this.P.add(this.pick(CHAIRS), s.x, s.z, { y: R.y, rotY: s.rot + (this.rand() - 0.5) * 0.8, collide: false, shadow: false }); }
    if (this.chance(0.5)) { s = this._wallSpot(R, { w: 0.45, d: 0.45, h: 1.6 }); if (s) this._floorLamp(R, s); }
    for (let i = 0; i < 2 + ((this.rand() * 2) | 0); i++) this._hang(R, 'frame');
    if (this.chance(0.35)) this._hang(R, 'clock');
    if (this.chance(0.35)) {
      s = this._wallSpot(R, { w: 0.5, d: 0.5, h: 0.7 });
      if (s) this._plant(s.x, R.y, s.z, 2.4);
    }
  }

  // ---- small procedural things (a few dozen triangles each, instead of the
  // thousands a scanned vase or plant model costs — they're tiny on screen)

  // Something on a table: a vase, a pot plant or a few tins
  _tableTop(x, y, z, rot) {
    const k = this.rand();
    if (k < 0.4) this._vase(x, y, z);
    else if (k < 0.75) this._plant(x, y, z, 0.8);
    else this._tins(x, y, z, rot, 3);
  }

  // Food tins in a row: little cylinders wrapped in a label from the sign atlas
  _tins(x, y, z, rot, n) {
    const ax = Math.cos(rot), az = -Math.sin(rot);
    for (let k = 0; k < n; k++) {
      const h = this.chance(0.5) ? 0.1 : 0.06, geo = new THREE.CylinderGeometry(0.037, 0.037, h, 8);
      setUV(geo, this.signs.cells[`tin${(this.rand() * 4) | 0}`]);
      const m = new THREE.Mesh(geo, this.sign);
      const o = (k - (n - 1) / 2) * 0.08;
      m.position.set(x + ax * o, y + h / 2, z + az * o);
      m.rotation.y = this.rand() * TAU;
      this.b.add(m, false);
    }
  }

  // A glazed vase, turned on a "lathe": a side profile spun round the y axis
  _vase(x, y, z) {
    const s = 0.8 + this.rand() * 0.6;
    const prof = [[0, 0], [0.06, 0], [0.085, 0.06], [0.09, 0.14], [0.06, 0.24], [0.035, 0.29], [0.045, 0.33], [0.04, 0.335]]
      .map(([r, h]) => new THREE.Vector2(r * s, h * s));
    const m = new THREE.Mesh(new THREE.LatheGeometry(prof, 10), this.ceramic);
    m.position.set(x, y, z);
    this.b.add(m, false);
  }

  // Pot plant: a clay pot and a few crossed leaf cards (leaf picture with
  // see-through gaps, from the sign atlas). s = size (1 ≈ 30 cm tall).
  _plant(x, y, z, s = 1) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.065 * s, 0.13 * s, 8), this.terracotta);
    pot.position.set(x, y + 0.065 * s, z);
    this.b.add(pot, false);
    const cell = this.signs.cells.leaves, yaw = this.rand() * Math.PI;
    for (let k = 0; k < 3; k++) {
      const geo = new THREE.PlaneGeometry(0.34 * s, 0.3 * s);
      setUV(geo, cell);
      const m = new THREE.Mesh(geo, this.sign);
      m.position.set(x, y + 0.12 * s + 0.15 * s, z);
      m.rotation.y = yaw + k * Math.PI / 3;
      this.b.add(m, false);
    }
  }

  // Bookcase: a wooden carcass with shelves of books (spines from the atlas)
  _bookcase(R, s) {
    const B = FURN.bookcase, wood = this.M.trim || this.M.wood;
    const ax = Math.cos(s.rot), az = -Math.sin(s.rot), fx = Math.sin(s.rot), fz = Math.cos(s.rot);
    const at = (a, f) => [s.x + ax * a + fx * f, s.z + az * a + fz * f];
    for (const e of [-1, 1]) { const [x, z] = at(e * (B.w / 2 - 0.015), 0); this.piece(0.03, B.h, B.d, wood, x, R.y, z, s.rot, { shadow: false }); }
    let [x, z] = at(0, -B.d / 2 + 0.008);
    this.piece(B.w, B.h, 0.015, wood, x, R.y, z, s.rot, { shadow: false });                          // back
    const shelves = [0.04, 0.42, 0.8, 1.18, 1.56, B.h - 0.03];
    for (const y of shelves) { [x, z] = at(0, 0); this.piece(B.w - 0.04, 0.025, B.d - 0.02, wood, x, R.y + y, z, s.rot, { shadow: false }); }
    for (const y of shelves.slice(0, -1)) {
      let a = -B.w / 2 + 0.05;
      while (a < B.w / 2 - 0.08) {
        if (this.chance(0.12)) { a += 0.08 + this.rand() * 0.15; continue; }       // a gap
        const bw = 0.025 + this.rand() * 0.03, bh = 0.18 + this.rand() * 0.14, bd = 0.15 + this.rand() * 0.06;
        if (a + bw > B.w / 2 - 0.04) break;
        [x, z] = at(a + bw / 2, B.d / 2 - bd / 2 - 0.02);
        this.piece(bw, Math.min(bh, 0.35), bd, this.sign, x, R.y + y + 0.025, z, s.rot, { shadow: false, cell: this.signs.cells[`book${(this.rand() * 8) | 0}`] });
        a += bw + 0.003;
      }
    }
    this.world.add(...this._aabbRot(s.x, s.z, s.rot, B.w, B.d, R.y, R.y + B.h), { pen: 0.6, surface: 'wood' });
  }

  // Kitchen run: painted cupboards with a stone worktop, a sink and a shelf above
  _kitchen(R) {
    const K = { w: 2.4, d: 0.62, h: 0.92 };
    const s = this._wallSpot(R, K);
    if (!s) return;
    const ax = Math.cos(s.rot), az = -Math.sin(s.rot), fx = Math.sin(s.rot), fz = Math.cos(s.rot);
    const paint = (this.rand() * PAINTS.length) | 0;
    this.piece(K.w, K.h - 0.06, K.d - 0.04, this.M.trim || this.M.wood, s.x - fx * 0.02, R.y, s.z - fz * 0.02, s.rot, { shadow: false });
    for (let k = 0; k < 4; k++) {
      const o = (k - 1.5) * 0.6;
      this.piece(0.56, 0.7, 0.02, this.paint, s.x + ax * o + fx * 0.3, R.y + 0.1, s.z + az * o + fz * 0.3, s.rot, { shadow: false, cell: this.door(paint) });
    }
    this.piece(K.w + 0.04, 0.05, K.d + 0.02, this.M.band || this.M.concrete, s.x, R.y + K.h - 0.06, s.z, s.rot, { shadow: false });
    this.piece(0.5, 0.012, 0.38, this.steel, s.x + ax * 0.5, R.y + K.h - 0.005, s.z + az * 0.5, s.rot, { shadow: false });     // sink
    this.cylinder(0.015, 0.3, this.steel, s.x + ax * 0.5 - fx * 0.22, R.y + K.h + 0.14, s.z + az * 0.5 - fz * 0.22, { seg: 5, shadow: false }); // tap
    this._tins(s.x - ax * 0.6, R.y + K.h - 0.01, s.z - az * 0.6, s.rot + 0.3, 3);
    this.world.add(...this._aabbRot(s.x, s.z, s.rot, K.w, K.d, R.y, R.y + K.h), { cover: true, pen: 0.4, surface: 'wood' });
    // a shelf above it, unless that would cross a window
    const lo = s.a - 0.7, hi = s.a + 0.7;
    if (!s.F.ops.some((o) => lo < o.at + o.w / 2 && hi > o.at - o.w / 2)) {
      const [x, z] = this._pt(s.F, s.a, 0.14);
      this.piece(1.4, 0.03, 0.26, this.M.wood, x, R.y + 1.62, z, s.rot, { shadow: false });
      for (let k = 0; k < 4; k++) if (this.chance(0.7)) this.piece(0.14 + this.rand() * 0.1, 0.12 + this.rand() * 0.14, 0.14, this.cardboard, x + ax * (k - 1.5) * 0.32, R.y + 1.65, z + az * (k - 1.5) * 0.32, s.rot, { shadow: false });
      R.hung.push([s.F, lo, hi]);
    }
  }

  // Standard lamp: a thin pole on a round foot under a fabric shade
  _floorLamp(R, s) {
    this.cylinder(0.14, 0.03, this.iron, s.x, R.y + 0.015, s.z, { seg: 10, shadow: false });
    this.cylinder(0.015, 1.45, this.iron, s.x, R.y + 0.73, s.z, { seg: 5, shadow: false });
    const sg = new THREE.CylinderGeometry(0.14, 0.22, 0.26, 12, 1, true);
    setUV(sg, this.fabric(2));
    const shade = new THREE.Mesh(sg, this.cloth);
    shade.position.set(s.x, R.y + 1.5, s.z);
    this.b.add(shade, false);
  }

  _bedroom(R) {
    const beds = 1 + (this.chance(0.4) ? 1 : 0);
    for (let i = 0; i < beds; i++) {
      const s = this._wallSpot(R, FURN.bed);
      if (!s) continue;
      this._put(R, 'bed', s);
      // bedside table at one end
      for (const e of [this.chance(0.5) ? 1 : -1]) {
        const a = s.a + e * (FURN.bed.w / 2 + FURN.night.w / 2 + 0.05);
        const n = this._wallSpot(R, FURN.night, { F: s.F, at: a });
        if (n) {
          this._put(R, 'night', n);
          if (this.chance(0.5)) this._tableTop(n.x, R.y + FURN.night.top, n.z, n.rot);
        }
      }
    }
    let s = this._wallSpot(R, FURN.wardrobe);
    if (s) this._put(R, 'wardrobe', s);
    if (this.chance(0.5)) { s = this._wallSpot(R, FURN.shelves); if (s) this._put(R, 'shelves', s); }
    if (this.chance(0.6)) { s = this._wallSpot(R, { w: 0.5, d: 0.55, h: 0.95 }); if (s && this.has(CHAIRS[0])) this.P.add(this.pick(CHAIRS), s.x, s.z, { y: R.y, rotY: s.rot + (this.rand() - 0.5) * 0.6, collide: false, shadow: false }); }
    if (this.chance(0.5)) this._dining(R, { rug: 0.3 });
    else if (this.chance(0.7)) this._rug(R, (R.x0 + R.x1) / 2 + this.r(-1, 1), (R.z0 + R.z1) / 2 + this.r(-1, 1), 2.2, 3.0);
    this._hang(R, 'frame');
    if (this.chance(0.3)) this._hang(R, 'clock');
  }

  _shop(R) {
    // a counter facing the street door, shelves of stock round the walls
    const door = R.faces.flatMap((F) => F.ops.filter((o) => o.door).map((o) => [F, o]))[0];
    if (door) {
      const [F, o] = door;
      const C = FURN.counter;
      for (const s of [1, -1]) {
        const a = o.at + s * (o.w / 2 + 0.5 + C.w / 2), dist = 2.4;
        const rect = this._rect(F, a - C.w / 2, a + C.w / 2, dist, dist + C.d);
        if (!this._fits(R, [rect[0] - 0.5, rect[1] - 0.5, rect[2] + 0.5, rect[3] + 0.5])) continue;
        R.occ.push(rect);
        const [x, z] = this._pt(F, a, dist + C.d / 2);
        this.piece(C.w, C.h - 0.05, C.d, this.M.trim || this.M.wood, x, R.y, z, F.rot, { collide: true, pen: 0.4, shadow: false });
        this.piece(C.w + 0.08, 0.05, C.d + 0.1, this.M.wood, x, R.y + C.h - 0.05, z, F.rot, { shadow: false });
        if (this.has('Television_01') && this.chance(0.4)) this.P.add('Television_01', x, z, { y: R.y + C.h, rotY: F.rot + Math.PI + 0.3, scale: 0.6, collide: false, shadow: false });
        // the shopkeeper's stool behind the counter
        const [sx, sz] = this._pt(F, a + this.r(-0.5, 0.5), dist + C.d + 0.45);
        if (this.has('painted_wooden_stool')) this.P.add('painted_wooden_stool', sx, sz, { y: R.y, rotY: this.rand() * TAU, collide: false, shadow: false });
        break;
      }
    }
    for (let i = 0; i < 4; i++) {
      const key = this.pick(['tallShelf', 'tallShelf', 'bookcase', 'shelves']);
      const s = this._wallSpot(R, FURN[key]);
      if (s && key === 'bookcase') this._bookcase(R, s);
      else if (s) { this._put(R, key, s); this._stock(R, s, FURN[key]); }
    }
    // boxes of stock on the floor
    for (let i = 0; i < 3; i++) {
      const s = this._wallSpot(R, { w: 0.6, d: 0.5, h: 0.6 });
      if (!s) continue;
      let y = R.y;
      for (let k = 0; k < 1 + ((this.rand() * 3) | 0); k++) {
        const h = 0.25 + this.rand() * 0.2;
        this.piece(0.45 + this.rand() * 0.15, h, 0.4, this.cardboard, s.x, y, s.z, s.rot + (this.rand() - 0.5) * 0.3, { shadow: false });
        y += h;
      }
    }
    this._hang(R, 'clock');
  }

  // A soldier's camp bed: steel frame, olive canvas, a blanket and a pillow
  _cot(R, s) {
    const C = FURN.cot, along = s.rot; // cot runs away from the wall
    const fwd = [Math.sin(along), Math.cos(along)];
    const cx = s.x, cz = s.z;
    this.piece(0.78, 0.06, 1.95, this.iron, cx, R.y + 0.36, cz, along, { shadow: false });
    for (const [lx, lz] of [[-0.36, -0.9], [0.36, -0.9], [-0.36, 0.9], [0.36, 0.9]]) {
      const x = cx + Math.cos(along) * lx + Math.sin(along) * lz, z = cz - Math.sin(along) * lx + Math.cos(along) * lz;
      this.piece(0.04, 0.36, 0.04, this.iron, x, R.y, z, along, { shadow: false });
    }
    this.piece(0.72, 0.07, 1.86, this.M.canvas || this.cardboard, cx, R.y + 0.42, cz, along, { shadow: false });
    this.piece(0.74, 0.06, 1.1, this.cloth, cx + fwd[0] * 0.35, R.y + 0.47, cz + fwd[1] * 0.35, along + (this.rand() - 0.5) * 0.1, { shadow: false, cell: this.cloths.cells.blanket });
    this.piece(0.5, 0.1, 0.32, this.cloth, cx - fwd[0] * 0.72, R.y + 0.48, cz - fwd[1] * 0.72, along, { shadow: false, cell: this.cloths.cells.pillow });
    this.world.add(...this._aabbRot(cx, cz, along, 0.8, 1.95, R.y, R.y + 0.5), { surface: 'cloth', pen: 0.2 });
  }

  // Steel locker (procedural)
  _locker(R, s) {
    const m = this.mat('locker', () => new THREE.MeshStandardMaterial({ color: 0x5a6250, roughness: 0.5, metalness: 0.6 }));
    this.piece(0.9, 1.8, 0.45, m, s.x, R.y, s.z, s.rot, { collide: true, pen: 0.3, surface: 'metal', shadow: false });
    const [x, z] = [s.x + Math.sin(s.rot) * 0.23, s.z + Math.cos(s.rot) * 0.23];
    this.piece(0.02, 1.6, 0.01, this.iron, x, R.y + 0.1, z, s.rot, { shadow: false });
  }

  _barracks(R) {
    const n = 3 + ((this.rand() * 5) | 0);
    for (let i = 0; i < n; i++) {
      const s = this._wallSpot(R, FURN.cot, { tries: 10 });
      if (!s) continue;
      this._cot(R, s);
      // footlocker at the end of the cot
      const [x, z] = this._pt(s.F, s.a, FURN.cot.d + 0.28);
      const rect = this._rect(s.F, s.a - 0.4, s.a + 0.4, FURN.cot.d + 0.05, FURN.cot.d + 0.5);
      if (this.chance(0.7) && this._fits(R, rect)) {
        R.occ.push(rect);
        this.piece(0.75, 0.38, 0.42, this.M.wood, x, R.y, z, s.rot, { shadow: false });
      }
    }
    for (let i = 0; i < 2; i++) { const s = this._wallSpot(R, FURN.locker); if (s) this._locker(R, s); }
    if (this.has('steel_frame_shelves_01')) { const s = this._wallSpot(R, FURN.steelShelf); if (s) { this._put(R, 'steelShelf', s); this._stock(R, s, FURN.steelShelf); } }
    this._dining(R, { chair: 'plastic_monobloc_chair_01', rug: 0 });
    this._hang(R, 'clock');
  }

  _office(R) {
    for (let i = 0; i < 2 + (this.chance(0.5) ? 1 : 0); i++) {
      const s = this._wallSpot(R, FURN.desk);
      if (!s) continue;
      this._put(R, 'desk', s);
      const top = R.y + FURN.desk.top;
      if (this.has('Television_01') && this.chance(0.5)) this.P.add('Television_01', s.x + (this.rand() - 0.5) * 1, s.z + (this.rand() - 0.5) * 0.1, { y: top, rotY: s.rot, scale: 0.75, collide: false, shadow: false });
      if (this.has('ammo_box') && this.chance(0.6)) this.P.add('ammo_box', s.x + (this.rand() - 0.5) * 1.2, s.z, { y: top, rotY: s.rot + this.rand(), collide: false, shadow: false });
      if (this.has('medical_box') && this.chance(0.3)) this.P.add('medical_box', s.x + (this.rand() - 0.5) * 1.2, s.z, { y: top, rotY: s.rot + this.rand(), collide: false, shadow: false });
      // chair pulled up to the desk, facing the wall
      if (this.has('plastic_monobloc_chair_01')) {
        const [cx, cz] = this._pt(s.F, s.a + (this.rand() - 0.5) * 0.6, FURN.desk.d + 0.35);
        this.P.add('plastic_monobloc_chair_01', cx, cz, { y: R.y, rotY: s.rot + Math.PI + (this.rand() - 0.5) * 0.6, collide: false, shadow: false });
      }
    }
    for (let i = 0; i < 2; i++) {
      const key = this.has('steel_frame_shelves_01') ? 'steelShelf' : 'tallShelf';
      const s = this._wallSpot(R, FURN[key]);
      if (s) { this._put(R, key, s); this._stock(R, s, FURN[key], { cans: false }); }
    }
    for (let i = 0; i < 2; i++) { const s = this._wallSpot(R, FURN.crate); if (s) this._put(R, 'crate', s); }
    this._hang(R, 'map');
    if (this.chance(0.6)) this._hang(R, 'board');
    this._hang(R, 'clock');
  }

  _workshop(R) {
    for (let i = 0; i < 3; i++) {
      if (!this.has('worn_metal_rack')) break;
      const s = this._wallSpot(R, FURN.rack);
      if (s) { this._put(R, 'rack', s); this._stock(R, s, FURN.rack, { cans: false }); }
    }
    // workbench: thick wooden top on steel legs, with clutter on it
    const s = this._wallSpot(R, FURN.workbench);
    if (s) {
      const W = FURN.workbench;
      this.piece(W.w, 0.08, W.d, this.M.wood, s.x, R.y + W.h - 0.08, s.z, s.rot, { shadow: false });
      for (const e of [-1, 1]) {
        const x = s.x + Math.cos(s.rot) * e * (W.w / 2 - 0.08), z = s.z - Math.sin(s.rot) * e * (W.w / 2 - 0.08);
        this.piece(0.06, W.h - 0.08, W.d - 0.1, this.iron, x, R.y, z, s.rot, { shadow: false });
      }
      this.world.add(...this._aabbRot(s.x, s.z, s.rot, W.w, W.d, R.y, R.y + W.h), { cover: true, pen: 0.4, surface: 'wood' });
      if (this.has('ammo_box')) this.P.add('ammo_box', s.x + 0.4, s.z, { y: R.y + W.h, rotY: s.rot + 1.2, collide: false, shadow: false });
      if (this.has('metal_jerrycan_green')) this.P.add('metal_jerrycan_green', s.x - 0.5, s.z, { y: R.y + W.h, rotY: s.rot, collide: false, shadow: false });
    }
    // tyres stacked flat
    if (this.has('old_tyre')) {
      const t = this._wallSpot(R, { w: 0.7, d: 0.7, h: 0.8 });
      if (t) for (let k = 0; k < 2 + ((this.rand() * 3) | 0); k++) this.P.add('old_tyre', t.x, t.z, { y: R.y + 0.3 + k * 0.17, rotY: this.rand() * TAU, tilt: [Math.PI / 2, 0], collide: false, shadow: false });
    }
    for (let i = 0; i < 2; i++) { const c = this._wallSpot(R, FURN.crate); if (c) this._put(R, 'crate', c); }
    this._hang(R, 'board');
  }

  _bunker(R) {
    for (let i = 0; i < 2 + (this.chance(0.5) ? 1 : 0); i++) { const s = this._wallSpot(R, FURN.cot, { tries: 10 }); if (s) this._cot(R, s); }
    for (let i = 0; i < 2; i++) { const s = this._wallSpot(R, FURN.crate); if (s) this._put(R, 'crate', s); }
    if (this.has('steel_frame_shelves_01')) { const s = this._wallSpot(R, FURN.steelShelf); if (s) { this._put(R, 'steelShelf', s); this._stock(R, s, FURN.steelShelf); } }
    const s = this._wallSpot(R, FURN.desk);
    if (s) {
      this._put(R, 'desk', s);
      if (this.has('Television_01')) this.P.add('Television_01', s.x, s.z, { y: R.y + FURN.desk.top, rotY: s.rot, scale: 0.7, collide: false, shadow: false });
      if (this.has('plastic_monobloc_chair_01')) {
        const [cx, cz] = this._pt(s.F, s.a, FURN.desk.d + 0.35);
        this.P.add('plastic_monobloc_chair_01', cx, cz, { y: R.y, rotY: s.rot + Math.PI + (this.rand() - 0.5) * 0.6, collide: false, shadow: false });
      }
    }
    this._hang(R, 'map');
  }

  // AABB of a w x d rectangle centred at x,z and turned by rot (which is always a multiple of 90° here)
  _aabbRot(x, z, rot, w, d, y0, y1) {
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    const hx = (w * c + d * s) / 2, hz = (w * s + d * c) / 2;
    return [new THREE.Vector3(x - hx, y0, z - hz), new THREE.Vector3(x + hx, y1, z + hz)];
  }

  // ===========================================================================
  // STREETS
  // ===========================================================================

  // Kerb stones along a line (visual only: 12 cm is below the step height)
  kerb(x0, z0, x1, z1, y = 0) {
    const mat = this.M.kerb || this.M.concrete, len = Math.hypot(x1 - x0, z1 - z0);
    for (let t = 0; t < len - 0.01; t += 2) {
      const l = Math.min(2, len - t) - 0.02, m = (t + l / 2) / len;
      const x = x0 + (x1 - x0) * m, z = z0 + (z1 - z0) * m;
      const gy = y || this.world.groundHeight(x, z);
      if (Math.abs(x1 - x0) > Math.abs(z1 - z0)) this.b.box(x, gy - 0.05, z, l, 0.17, 0.2, mat, { collide: false, castShadow: false });
      else this.b.box(x, gy - 0.05, z, 0.2, 0.17, l, mat, { collide: false, castShadow: false });
    }
  }

  // Painted road markings: dashed centre line from (x0,z0) to (x1,z1)
  roadDashes(x0, z0, x1, z1, { dash = 3, gap = 6, width = 0.14 } = {}) {
    const len = Math.hypot(x1 - x0, z1 - z0), dx = (x1 - x0) / len, dz = (z1 - z0) / len, rot = Math.atan2(dx, dz);
    for (let t = 0; t < len - dash; t += dash + gap) {
      const x = x0 + dx * (t + dash / 2), z = z0 + dz * (t + dash / 2);
      this.decal('paint', width, dash, x, this.world.groundHeight(x, z) + 0.02, z, rot, { tiltX: -Math.PI / 2 });
    }
  }

  // Zebra crossing centred at (x, z); `alongX` = the road runs along x
  zebra(x, z, alongX, roadW = 9, stripeL = 2.6) {
    for (let s = -roadW / 2 + 0.5; s <= roadW / 2 - 0.4; s += 1.0) {
      const px = alongX ? x : x + s, pz = alongX ? z + s : z;
      this.decal('paint', 0.5, stripeL, px, this.world.groundHeight(px, pz) + 0.02, pz, alongX ? Math.PI / 2 : 0, { tiltX: -Math.PI / 2 });
    }
  }

  // Street lamp: steel pole, curved arm, lamp head. rotY = direction the arm points.
  streetLamp(x, z, rotY) {
    const y0 = this.world.groundHeight(x, z), H = 6.2;
    if (this.blocked(x - 0.3, y0 + 0.1, z - 0.3, x + 0.3, y0 + 2, z + 0.3)) return false;
    const pole = this.iron;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, H, 10), pole);
    m.position.set(x, y0 + H / 2, z);
    this.b.add(m);
    this.cylinder(0.16, 0.5, pole, x, y0 + 0.25, z, { seg: 10 });
    const dx = Math.sin(rotY), dz = Math.cos(rotY);
    this.piece(0.05, 0.05, 1.5, pole, x + dx * 0.7, y0 + H - 0.1, z + dz * 0.7, rotY, { tiltX: -0.12 });
    this.piece(0.28, 0.12, 0.55, pole, x + dx * 1.45, y0 + H - 0.05, z + dz * 1.45, rotY);
    this.piece(0.22, 0.04, 0.45, this.lampGlass, x + dx * 1.45, y0 + H - 0.09, z + dz * 1.45, rotY, { shadow: false });
    this.world.add(new THREE.Vector3(x - 0.12, y0, z - 0.12), new THREE.Vector3(x + 0.12, y0 + H, z + 0.12), { surface: 'metal' });
    return true;
  }

  // Road sign on a pole (name = cell in the sign atlas). rotY = direction it faces.
  roadSign(x, z, rotY, name, { size = 0.65, h = 2.2 } = {}) {
    const y0 = this.world.groundHeight(x, z);
    if (this.blocked(x - 0.2, y0 + 0.1, z - 0.2, x + 0.2, y0 + 2, z + 0.2)) return false;
    this.cylinder(0.035, h + size / 2, this.steel, x, y0 + (h + size / 2) / 2, z, { seg: 6 });
    const cell = this.signs.cells[name];
    this.quad(size, size / cell.aspect, this.sign, x + Math.sin(rotY) * 0.045, y0 + h, z + Math.cos(rotY) * 0.045, rotY, { cell, shadow: true });
    this.world.add(new THREE.Vector3(x - 0.06, y0, z - 0.06), new THREE.Vector3(x + 0.06, y0 + h, z + 0.06), { surface: 'metal' });
    return true;
  }

  // Board sign on two posts (military: CHECKPOINT, FOB...). rotY = facing.
  boardSign(x, z, rotY, name, { w = 2.2, h = 1.5 } = {}) {
    const y0 = this.world.groundHeight(x, z), cell = this.signs.cells[name], bh = w / cell.aspect;
    const ax = Math.cos(rotY), az = -Math.sin(rotY);
    for (const s of [-1, 1]) this.piece(0.1, h + bh, 0.1, this.M.wood, x + ax * s * (w / 2 - 0.15), y0 - 0.2, z + az * s * (w / 2 - 0.15), rotY);
    this.piece(w, bh, 0.04, this.M.wood, x, y0 + h - 0.05, z, rotY);
    this.quad(w - 0.06, bh - 0.06, this.sign, x + Math.sin(rotY) * 0.03, y0 + h - 0.05 + bh / 2, z + Math.cos(rotY) * 0.03, rotY, { cell, shadow: false });
    this.world.add(...this._aabbRot(x, z, rotY, w, 0.15, y0, y0 + h + bh), { surface: 'wood', pen: 0.3 });
  }

  // Bins, bags and boxes in an alley corner. rotY = the way the group faces.
  trash(x, z, rotY) {
    const y0 = this.world.groundHeight(x, z);
    if (this.blocked(x - 1, y0 + 0.1, z - 1, x + 1, y0 + 1.2, z + 1)) return false;
    const ax = Math.cos(rotY), az = -Math.sin(rotY);
    if (this.has('metal_trash_can') && this.chance(0.6)) {
      this.P.add('metal_trash_can', x, z, { rotY, cover: false, pen: 0.3, surface: 'metal' });
    }
    if (this.has('trashbag')) {
      for (let k = 0; k < 1 + ((this.rand() * 3) | 0); k++) {
        const t = 1.15 + k * 0.45 + this.rand() * 0.1;
        this.P.add('trashbag', x + ax * t, z + az * t, { rotY: this.rand() * TAU, scale: 0.8 + this.rand() * 0.4, collide: false });
      }
    }
    if (this.chance(0.5)) this.piece(0.5, 0.35, 0.4, this.cardboard, x - ax * 1.25, y0, z - az * 1.25, rotY + this.rand(), { tiltX: (this.rand() - 0.5) * 0.3 });
    return true;
  }

  // Paper scraps, wrappers and leaves on the ground (looks only, fixed count)
  litter(area, count, ok = () => true) {
    for (let i = 0; i < count; i++) {
      const x = this.r(area.minX, area.maxX), z = this.r(area.minZ, area.maxZ);
      if (!ok(x, z)) continue;
      const s = 0.12 + this.rand() * 0.18;
      this.decal(`litter${(this.rand() * 4) | 0}`, s, s, x, this.world.groundHeight(x, z) + 0.015, z, this.rand() * TAU, { tiltX: -Math.PI / 2 });
    }
  }

  // Dark oil stains under every parked car of a props model
  oilUnder(id) {
    const list = this.P.placed.get(id) || [];
    const p = new THREE.Vector3();
    for (const it of list) {
      p.setFromMatrixPosition(it.matrix);
      const s = 1.2 + this.rand() * 1.0;
      this.decal('oil', s, s * 1.3, p.x + this.r(-0.4, 0.4), p.y + 0.012, p.z + this.r(-0.8, 0.8), this.rand() * TAU, { tiltX: -Math.PI / 2 });
    }
  }

  // Still water in a fountain basin
  water(x, y, z, r) {
    const m = this.mat('water', () => new THREE.MeshStandardMaterial({ color: 0x2d3e3c, roughness: 0.06, metalness: 0.2, transparent: true, opacity: 0.88, envMapIntensity: 1.4 }));
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(r, 32), m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    this.b.add(mesh, false, false);
  }

  // ===========================================================================
  // MILITARY
  // ===========================================================================

  // Concertina (razor) wire: coils along a line. onGround coils block movement
  // (but not bullets or sight — you can shoot through wire).
  razorWire(x0, z0, x1, z1, y = null, { blockMove = false, r = 0.38 } = {}) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (!this._wireGeo) {
      // one 2 m piece of coil: a helix of thin tube, reused for every piece
      const pts = [], loops = 9;
      for (let i = 0; i <= loops * 18; i++) {
        const t = i / (loops * 18), a = t * loops * TAU;
        pts.push(new THREE.Vector3(t * 2 - 1, Math.sin(a) * r + (Math.sin(a * 0.5) * 0.03), Math.cos(a) * r));
      }
      this._wireGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), loops * 18, 0.007, 3, false);
      this._wire = [];
    }
    const n = Math.max(1, Math.round(len / 2)), rot = Math.atan2(-(z1 - z0), x1 - x0);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      const gy = y ?? this.world.groundHeight(x, z) + r;
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x, gy, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(this.rand() * 0.3, rot, (this.rand() - 0.5) * 0.06, 'YXZ')), new THREE.Vector3(len / n / 2, 1, 1));
      this._wire.push(m);
      // one movement blocker per piece, so it follows the ground on slopes
      if (blockMove) {
        const hx = Math.abs(x1 - x0) / n / 2 + r * 0.8, hz = Math.abs(z1 - z0) / n / 2 + r * 0.8;
        this.world.add(new THREE.Vector3(x - hx, gy - r, z - hz), new THREE.Vector3(x + hx, gy + r, z + hz), { solid: false });
      }
    }
  }

  // HESCO barrier: wire-mesh cages lined with fabric and filled with earth.
  hesco(x, z, alongX, n = 2, h = 1.37) {
    const y0 = this.world.groundHeight(x, z) - 0.05, s = 1.06;
    const side = this.mat('hesco', () => new THREE.MeshStandardMaterial({ map: this._hescoTex(), roughness: 1 }));
    const top = this.mat('hescoTop', () => new THREE.MeshStandardMaterial({ color: 0x8a7a5c, roughness: 1 }));
    for (let i = 0; i < n; i++) {
      const o = (i - (n - 1) / 2) * s;
      const cx = alongX ? x + o : x, cz = alongX ? z : z + o;
      this.piece(1.0, h, 1.0, side, cx, y0, cz, 0, { shadow: true });
      this.piece(0.94, 0.04, 0.94, top, cx, y0 + h - 0.02, cz, 0, { shadow: false });
    }
    const hx = alongX ? n * s / 2 : 0.5, hz = alongX ? 0.5 : n * s / 2;
    this.world.add(new THREE.Vector3(x - hx, y0, z - hz), new THREE.Vector3(x + hx, y0 + h, z + hz), { cover: true, surface: 'sand' });
  }

  // Camouflage net on poles, sagging between them. Looks only: it hides from
  // the sky, not from bullets.
  camoNet(cx, cz, w, d, h, palette, rotY = 0) {
    const y0 = this.world.groundHeight(cx, cz);
    const key = `net${palette.join()}`;
    const mat = this.mat(key, () => new THREE.MeshStandardMaterial({ map: this._netTex(palette), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1 }));
    const geo = new THREE.PlaneGeometry(w, d, 16, 12);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getX(i) / w + 0.5, v = pos.getZ(i) / d + 0.5;
      const sag = Math.sin(u * Math.PI) * Math.sin(v * Math.PI);          // 0 at the edges, 1 in the middle
      const peak = Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.02);   // centre pole lifts it
      const edge = Math.min(u, 1 - u, v, 1 - v) < 0.06 ? -0.25 : 0;        // loose edges hang down
      pos.setY(i, -0.35 * sag + 0.7 * peak + edge + (this.rand() - 0.5) * 0.06);
      uv.setXY(i, pos.getX(i) / 2.5, pos.getZ(i) / 2.5);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.position.set(cx, y0 + h, cz);
    m.rotation.y = rotY;
    this.b.add(m);
    // poles at the corners and one in the middle
    const c = Math.cos(rotY), s = Math.sin(rotY);
    for (const [px, pz, ph] of [[-w / 2 + 0.2, -d / 2 + 0.2, h - 0.05], [w / 2 - 0.2, -d / 2 + 0.2, h - 0.05], [-w / 2 + 0.2, d / 2 - 0.2, h - 0.05], [w / 2 - 0.2, d / 2 - 0.2, h - 0.05], [0, 0, h + 0.65]]) {
      const x = cx + px * c + pz * s, z = cz - px * s + pz * c;
      const gy = this.world.groundHeight(x, z);
      if (this.blocked(x - 0.1, gy + 0.1, z - 0.1, x + 0.1, gy + 1.8, z + 0.1)) continue; // something's in the way (a truck)
      this.cylinder(0.04, ph + y0 - gy, this.M.wood, x, gy + (ph + y0 - gy) / 2, z, { seg: 6 });
    }
  }

  // Floodlight mast: steel pole with two lamp heads. rotY = where they point.
  floodlight(x, z, rotY, H = 6.5) {
    const y0 = this.world.groundHeight(x, z);
    if (this.blocked(x - 0.3, y0 + 0.1, z - 0.3, x + 0.3, y0 + 2, z + 0.3)) return false;
    this.cylinder(0.09, H, this.steel, x, y0 + H / 2, z, { seg: 8 });
    this.piece(1.4, 0.08, 0.08, this.steel, x, y0 + H - 0.15, z, rotY + Math.PI / 2);
    const ax = Math.cos(rotY + Math.PI / 2), az = -Math.sin(rotY + Math.PI / 2);
    if (this.has('security_light')) {
      for (const s of [-1, 1]) this.P.add('security_light', x + ax * s * 0.55 + Math.sin(rotY) * 0.15, z + az * s * 0.55 + Math.cos(rotY) * 0.15, { y: y0 + H - 0.75, rotY, scale: 1.4, tilt: [0.35, 0], collide: false });
    }
    this.piece(0.4, 0.5, 0.25, this.steel, x - Math.sin(rotY) * 0.15, y0 + 1.1, z - Math.cos(rotY) * 0.15, rotY);  // junction box
    this.world.add(new THREE.Vector3(x - 0.12, y0, z - 0.12), new THREE.Vector3(x + 0.12, y0 + H, z + 0.12), { surface: 'metal' });
    return true;
  }

  // Water tank on a steel stand
  waterTank(x, z) {
    const y0 = this.world.groundHeight(x, z);
    if (this.blocked(x - 1.2, y0 + 0.1, z - 1.2, x + 1.2, y0 + 2, z + 1.2)) return false;
    for (const [dx, dz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) this.piece(0.1, 2.2, 0.1, this.steel, x + dx, y0, z + dz, 0);
    this.piece(1.8, 0.1, 1.8, this.steel, x, y0 + 2.2, z, 0);
    const tank = this.mat('tank', () => new THREE.MeshStandardMaterial({ color: 0x3e4a3a, roughness: 0.7, metalness: 0.1 }));
    this.cylinder(0.85, 1.6, tank, x, y0 + 3.1, z, { seg: 18 });
    for (const [dx, dz] of [[-0.8, -0.8], [0.8, 0.8]]) this.world.add(new THREE.Vector3(x + dx - 0.06, y0, z + dz - 0.06), new THREE.Vector3(x + dx + 0.06, y0 + 2.2, z + dz + 0.06), { surface: 'metal' });
    this.world.add(new THREE.Vector3(x - 0.9, y0 + 2.2, z - 0.9), new THREE.Vector3(x + 0.9, y0 + 3.9, z + 0.9), { surface: 'metal', pen: 0.3 });
    return true;
  }

  // Wooden walkway planks over mud, following a list of [x, z] points
  duckboards(points) {
    for (let i = 0; i < points.length - 1; i++) {
      const [x0, z0] = points[i], [x1, z1] = points[i + 1];
      const len = Math.hypot(x1 - x0, z1 - z0), rot = Math.atan2(x1 - x0, z1 - z0);
      for (let t = 0.3; t < len; t += 0.32) {
        const x = x0 + (x1 - x0) * t / len, z = z0 + (z1 - z0) * t / len, gy = this.world.groundHeight(x, z);
        this.piece(0.9, 0.04, 0.26, this.M.wood, x, gy + 0.04, z, rot + (this.rand() - 0.5) * 0.06, { shadow: false });
      }
      for (const s of [-1, 1]) {
        const cx = (x0 + x1) / 2 + Math.cos(rot) * s * 0.36, cz = (z0 + z1) / 2 - Math.sin(rot) * s * 0.36;
        this.piece(0.08, 0.06, len, this.M.wood, cx, this.world.groundHeight(cx, cz) - 0.01, cz, rot, { shadow: false });
      }
    }
  }

  // Campfire ring with log benches round it
  campfire(x, z) {
    const y0 = this.world.groundHeight(x, z);
    if (this.has('stone_fire_pit')) this.P.add('stone_fire_pit', x, z, { collide: false });
    this.decal('scorch', 1.4, 1.4, x, y0 + 0.03, z, 0, { tiltX: -Math.PI / 2 });
    // kindling stacked like a tipi: each stick leans in toward the middle
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * TAU, stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.75, 5), this.M.log || this.M.wood);
      stick.position.set(x + Math.cos(a) * 0.16, y0 + 0.32, z + Math.sin(a) * 0.16);
      stick.quaternion.setFromAxisAngle(new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), 0.45);
      this.b.add(stick);
    }
    // three logs to sit on, lying round the fire (tangent to the circle)
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * TAU + 0.4, bx = x + Math.cos(a) * 2.1, bz = z + Math.sin(a) * 2.1;
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 2.0, 10), this.M.log || this.M.wood);
      log.rotation.set(0, Math.PI / 2 - a, Math.PI / 2, 'YXZ');
      log.position.set(bx, this.world.groundHeight(bx, bz) + 0.18, bz);
      this.b.add(log);
    }
  }

  // Stencilled words on a wall (decal). rotY = facing.
  stencil(name, x, y, z, rotY, w = 1.6) {
    const cell = this.decals.cells[name];
    this.decal(name, w, w / cell.aspect, x, y, z, rotY);
  }

  // Must be called after props.finalize()-style batching of the wire pieces
  finish() {
    if (this._wire?.length) {
      const mat = this.mat('wire', () => new THREE.MeshStandardMaterial({ color: 0x9a9a94, roughness: 0.35, metalness: 0.9 }));
      const im = new THREE.InstancedMesh(this._wireGeo, mat, this._wire.length);
      this._wire.forEach((m, i) => im.setMatrixAt(i, m));
      im.computeBoundingSphere();
      im.castShadow = true;
      this.scene.add(im);
    }
  }

  // ===========================================================================
  // TEXTURES — painted on canvases at startup
  // ===========================================================================
  _paint() {
    const rnd = mulberry32(90210);
    this._trnd = rnd;
    this.signs = new Atlas(1024, 2048);
    this.decals = new Atlas(1024);
    this._paintSigns(rnd);
    this._paintDecals(rnd);
    // painted wood and cloth atlases (see `get paint()` / `get cloth()`)
    const fit = (fn, NW, NH) => (g, w, h) => { g.scale(w / NW, h / NH); fn(g); };
    this.paints = new Atlas(1024);
    PAINTS.forEach((hex, i) => this.paints.add(`door${i}`, 128, 256, fit((g) => this._woodPaintTex(g, 'door', hex), 256, 512)));
    PAINTS.forEach((hex, i) => this.paints.add(`shutter${i}`, 64, 128, fit((g) => this._woodPaintTex(g, 'shutter', hex), 128, 256)));
    this.cloths = new Atlas(1024);
    FABRICS.forEach(([a, b, style], i) => this.cloths.add(`fabric${i}`, 128, 128, fit((g) => this._fabricTex(g, a, b, style), 128, 128)));
    for (let i = 0; i < 3; i++) this.cloths.add(`rug${i}`, 256, 384, fit((g) => this._rugTex(g, i), 256, 384));
    AWNINGS.forEach(([a, b], i) => this.cloths.add(`awning${i}`, 128, 64, fit((g) => this._stripeTex(g, a, b), 128, 64)));
    this.cloths.add('blanket', 64, 64, fit((g) => this._fabricTex(g, 0x4b5238, 0x3c4230, 'plain'), 128, 128));
    this.cloths.add('pillow', 32, 32, (g, w, h) => { g.fillStyle = '#cfc8b4'; g.fillRect(0, 0, w, h); });
  }

  // (each painter draws at its own "native" size; the atlas scales it into its cell)
  _woodPaintTex(g, kind, hex) {
    const rnd = this._trnd, door = kind === 'door';
    const W = door ? 256 : 128, H = door ? 512 : 256;
    g.fillStyle = css(hex); g.fillRect(0, 0, W, H);
    for (let i = 0; i < 220; i++) { // brush strokes / grain
      g.fillStyle = rnd() < 0.5 ? `rgba(0,0,0,${0.03 + rnd() * 0.05})` : `rgba(255,255,255,${0.03 + rnd() * 0.05})`;
      g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 10 + rnd() * 60);
    }
    if (door) {
      for (let x = 64; x < W; x += 64) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(x - 1, 0, 3, H); }
      for (const [py, ph] of [[36, 190], [262, 210]]) {
        g.fillStyle = 'rgba(0,0,0,0.07)'; g.fillRect(30, py, W - 60, ph);
        g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(30, py, W - 60, 5); g.fillRect(30, py, 5, ph);
        g.fillStyle = 'rgba(0,0,0,0.32)'; g.fillRect(30, py + ph - 5, W - 60, 5); g.fillRect(W - 35, py, 5, ph);
      }
      g.fillStyle = '#c8b070'; g.beginPath(); g.arc(W - 32, 252, 7, 0, TAU); g.fill();
      g.fillStyle = '#222'; g.fillRect(W - 34, 266, 4, 9);
    } else {
      g.strokeStyle = 'rgba(0,0,0,0.4)'; g.lineWidth = 3; g.strokeRect(7, 7, W - 14, H - 14);
      for (let y = 16; y < H - 16; y += 11) {
        const gr = g.createLinearGradient(0, y, 0, y + 11);
        gr.addColorStop(0, 'rgba(255,255,255,0.25)'); gr.addColorStop(0.7, 'rgba(0,0,0,0.04)'); gr.addColorStop(1, 'rgba(0,0,0,0.5)');
        g.fillStyle = gr; g.fillRect(13, y, W - 26, 11);
      }
    }
    for (let i = 0; i < (door ? 40 : 22); i++) { // chipped paint: grey old wood shows through, near edges and low down
      g.fillStyle = `rgba(${95 + rnd() * 25},${84 + rnd() * 18},${68 + rnd() * 14},${0.45 + rnd() * 0.35})`;
      const edge = rnd() < 0.6, x = edge ? (rnd() < 0.5 ? rnd() * 10 : W - rnd() * 10) : rnd() * W;
      blob(g, x, Math.sqrt(rnd()) * H, (door ? 1.5 : 1) + rnd() * (door ? 6 : 3), rnd);
    }
    const dg = g.createLinearGradient(0, H * 0.55, 0, H);
    dg.addColorStop(0, 'rgba(60,45,30,0)'); dg.addColorStop(1, 'rgba(60,45,30,0.45)');
    g.fillStyle = dg; g.fillRect(0, 0, W, H);
  }

  _fabricTex(g, a, b, style) {
    const rnd = this._trnd;
    g.fillStyle = css(a); g.fillRect(0, 0, 128, 128);
    if (style === 'stripes') { g.fillStyle = css(b, 0.85); for (let x = 0; x < 128; x += 32) { g.fillRect(x + 4, 0, 10, 128); g.fillRect(x + 18, 0, 3, 128); } }
    if (style === 'dots') {
      for (let y = 8; y < 128; y += 32) for (let x = 8; x < 128; x += 32) {
        const ox = (y / 32) % 2 ? 16 : 0;
        g.fillStyle = css(b, 0.9);
        for (let k = 0; k < 5; k++) { const ang = k / 5 * TAU; g.beginPath(); g.arc(x + ox + Math.cos(ang) * 4, y + Math.sin(ang) * 4, 3, 0, TAU); g.fill(); }
      }
    }
    for (let y = 0; y < 128; y += 2) { g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.04})`; g.fillRect(0, y, 128, 1); }
    for (let x = 0; x < 128; x += 2) { g.fillStyle = `rgba(255,255,255,${0.02 + rnd() * 0.03})`; g.fillRect(x, 0, 1, 128); }
  }

  _rugTex(g, i) {
    const rnd = this._trnd;
    const pal = [[0x7a2420, 0x1f2a44, 0xd8b878, 0xe8dcc0], [0x253a5a, 0x8a2a24, 0xd0b070, 0xe0d4b8], [0xb07a30, 0x5a2a20, 0x2a3a40, 0xe8dcc0]][i % 3].map((h) => css(h));
    g.fillStyle = pal[0]; g.fillRect(0, 0, 256, 384);
    g.lineWidth = 16; g.strokeStyle = pal[1]; g.strokeRect(18, 18, 220, 348);
    g.lineWidth = 4; g.strokeStyle = pal[2]; g.strokeRect(32, 32, 192, 320); g.strokeRect(8, 8, 240, 368);
    g.fillStyle = pal[2];
    for (let k = 0; k < 24; k++) { g.beginPath(); g.arc(18 + (k % 2) * 220, 30 + k * 14, 3, 0, TAU); g.fill(); }
    const diamond = (cx, cy, rx, ry, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(cx, cy - ry); g.lineTo(cx + rx, cy); g.lineTo(cx, cy + ry); g.lineTo(cx - rx, cy); g.fill(); };
    diamond(128, 192, 70, 110, pal[1]); diamond(128, 192, 48, 76, pal[2]); diamond(128, 192, 26, 40, pal[0]); diamond(128, 192, 10, 16, pal[3]);
    for (const [x, y] of [[60, 70], [196, 70], [60, 314], [196, 314]]) diamond(x, y, 18, 18, pal[1]);
    for (let k = 0; k < 600; k++) { g.fillStyle = `rgba(255,240,220,${rnd() * 0.08})`; g.fillRect(rnd() * 256, rnd() * 384, 2, 2); }
    g.fillStyle = pal[3]; for (let x = 4; x < 252; x += 4) { g.fillRect(x, 0, 2, 6); g.fillRect(x, 378, 2, 6); }
    const wear = g.createRadialGradient(128, 192, 20, 128, 192, 200);
    wear.addColorStop(0, 'rgba(230,220,200,0.18)'); wear.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = wear; g.fillRect(0, 0, 256, 384);
  }

  _stripeTex(g, a, b) {
    for (let x = 0; x < 128; x += 16) { g.fillStyle = css((x / 16) % 2 ? b : a); g.fillRect(x, 0, 16, 64); }
    const gr = g.createLinearGradient(0, 0, 0, 64); gr.addColorStop(0, 'rgba(255,255,255,0.12)'); gr.addColorStop(1, 'rgba(60,40,20,0.25)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 64);
    weather(g, 0, 0, 128, 64, this._trnd, 0.5);
  }

  _cardboardTex() {
    const rnd = this._trnd, [c, g] = canvas(128, 128);
    g.fillStyle = '#a5804f'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '60,40,20' : '220,190,140'},${rnd() * 0.12})`; g.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 3, 1 + rnd() * 3); }
    g.fillStyle = 'rgba(200,170,120,0.6)'; g.fillRect(0, 56, 128, 16);                // packing tape
    g.fillStyle = 'rgba(30,25,20,0.7)'; g.font = 'bold 13px Arial, sans-serif'; g.fillText('↑↑  FRAGILE', 18, 30);
    g.strokeStyle = 'rgba(30,25,20,0.5)'; g.lineWidth = 2; g.strokeRect(16, 86, 46, 26);
    g.strokeStyle = 'rgba(40,25,10,0.35)'; g.lineWidth = 4; g.strokeRect(0, 0, 128, 128);
    return toTex(c);
  }

  _hescoTex() {
    const rnd = this._trnd, [c, g] = canvas(256, 256);
    g.fillStyle = '#b3a481'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2500; i++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '70,60,40' : '230,220,190'},${rnd() * 0.1})`; g.fillRect(rnd() * 256, rnd() * 256, 2, 2); }
    // pillowing: each mesh cell bulges, lighter in the middle
    for (let y = 0; y < 256; y += 32) for (let x = 0; x < 256; x += 32) {
      const gr = g.createRadialGradient(x + 16, y + 16, 2, x + 16, y + 16, 24);
      gr.addColorStop(0, 'rgba(255,250,230,0.12)'); gr.addColorStop(1, 'rgba(40,30,20,0.18)');
      g.fillStyle = gr; g.fillRect(x, y, 32, 32);
    }
    g.strokeStyle = 'rgba(55,55,52,0.9)'; g.lineWidth = 3;
    for (let k = 0; k <= 256; k += 32) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 256); g.moveTo(0, k); g.lineTo(256, k); g.stroke(); }
    g.strokeStyle = 'rgba(200,200,190,0.5)'; g.lineWidth = 1;
    for (let k = 1; k <= 256; k += 32) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k, 256); g.moveTo(0, k); g.lineTo(256, k); g.stroke(); }
    const dg = g.createLinearGradient(0, 170, 0, 256); dg.addColorStop(0, 'rgba(80,60,40,0)'); dg.addColorStop(1, 'rgba(80,60,40,0.5)');
    g.fillStyle = dg; g.fillRect(0, 0, 256, 256);
    return toTex(c);
  }

  _netTex(palette) {
    const rnd = this._trnd, [c, g] = canvas(256, 256);
    g.clearRect(0, 0, 256, 256);
    // the net's cords
    g.strokeStyle = 'rgba(40,40,30,1)'; g.lineWidth = 1.5;
    for (let k = 0; k < 256; k += 16) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 64, 256); g.moveTo(0, k); g.lineTo(256, k + 64); g.stroke(); }
    // cut fabric "leaves" in the camo colours, with gaps between them
    for (let i = 0; i < 520; i++) {
      g.fillStyle = css(palette[(rnd() * palette.length) | 0]);
      blob(g, rnd() * 256, rnd() * 256, 5 + rnd() * 9, rnd, 4 + ((rnd() * 3) | 0));
    }
    // holes (alpha cut-outs)
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 160; i++) blob(g, rnd() * 256, rnd() * 256, 2 + rnd() * 6, rnd, 5);
    g.globalCompositeOperation = 'source-over';
    return toTex(c, { repeat: true });
  }

  _railTex() {
    const [c, g] = canvas(256, 128);
    g.clearRect(0, 0, 256, 128);
    g.fillStyle = '#2b2a28';
    g.fillRect(0, 0, 256, 8); g.fillRect(0, 116, 256, 8); g.fillRect(0, 96, 256, 4);
    for (let x = 6; x < 256; x += 16) g.fillRect(x, 0, 4, 128);
    g.strokeStyle = '#2b2a28'; g.lineWidth = 3;
    for (let x = 14; x < 256; x += 32) { g.beginPath(); g.arc(x, 104, 6, 0, TAU); g.stroke(); }
    return toTex(c);
  }

  // ---- the sign atlas: shop signs, house numbers, road and military signs ---
  _paintSigns(rnd) {
    const A = this.signs;
    const boards = [['#1d3a2a', '#e8d8a8'], ['#5a1e18', '#f0e2c0'], ['#e8e0cc', '#1e2a44'], ['#1e2a44', '#f2e8d0'], ['#c8a040', '#2a1c10'], ['#f0ece2', '#8a2420']];
    const fonts = ['bold Georgia, serif', 'bold "Arial Black", Arial, sans-serif', 'bold "Courier New", monospace', 'italic bold Georgia, serif'];
    SHOPS.forEach((name, i) => A.add(`shop:${name}`, 320, 64, (g, w, h) => {
      const [bg, fg] = boards[i % boards.length];
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.strokeStyle = fg; g.lineWidth = 3; g.strokeRect(6, 6, w - 12, h - 12);
      text(g, name, w / 2, h / 2 + 2, w - 40, 40, fonts[i % fonts.length], fg);
      if (name === 'PHARMACY') { g.fillStyle = '#2a9a4a'; g.fillRect(16, 20, 24, 8); g.fillRect(24, 12, 8, 24); }
      weather(g, 0, 0, w, h, rnd, 1);
    }));
    for (let i = 0; i < 12; i++) A.add(`num${i}`, 64, 48, (g, w, h) => {
      g.fillStyle = '#f2efe6'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#1f3f7a'; g.fillRect(3, 3, w - 6, h - 6);
      g.strokeStyle = '#f2efe6'; g.lineWidth = 2; g.strokeRect(6, 6, w - 12, h - 12);
      text(g, String(3 + i * 4), w / 2, h / 2 + 1, w - 16, 30, 'bold Arial, sans-serif', '#f2efe6');
      weather(g, 0, 0, w, h, rnd, 0.5);
    });
    // road signs (transparent outside the shape; the sign material uses alphaTest)
    A.add('stop', 128, 128, (g, w) => {
      g.fillStyle = '#eee'; g.beginPath();
      for (let k = 0; k < 8; k++) { const a = (k + 0.5) / 8 * TAU; g.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62); }
      g.fill();
      g.fillStyle = '#b8231c'; g.beginPath();
      for (let k = 0; k < 8; k++) { const a = (k + 0.5) / 8 * TAU; g.lineTo(64 + Math.cos(a) * 56, 64 + Math.sin(a) * 56); }
      g.fill();
      text(g, 'STOP', 64, 66, 96, 38, 'bold Arial, sans-serif', '#fff');
      weather(g, 10, 10, w - 20, w - 20, rnd, 0.6);
    });
    A.add('noentry', 128, 128, (g) => {
      g.fillStyle = '#eee'; g.beginPath(); g.arc(64, 64, 62, 0, TAU); g.fill();
      g.fillStyle = '#c0261e'; g.beginPath(); g.arc(64, 64, 57, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.fillRect(22, 54, 84, 20);
      weather(g, 14, 14, 100, 100, rnd, 0.5);
    });
    A.add('warn', 128, 128, (g) => {
      g.fillStyle = '#c0261e'; g.beginPath(); g.moveTo(64, 4); g.lineTo(124, 118); g.lineTo(4, 118); g.fill();
      g.fillStyle = '#f4f0e6'; g.beginPath(); g.moveTo(64, 24); g.lineTo(108, 108); g.lineTo(20, 108); g.fill();
      text(g, '!', 64, 78, 40, 56, 'bold Arial, sans-serif', '#111');
    });
    A.add('arrow', 128, 128, (g) => {
      g.fillStyle = '#eee'; g.beginPath(); g.arc(64, 64, 62, 0, TAU); g.fill();
      g.fillStyle = '#1f4f9a'; g.beginPath(); g.arc(64, 64, 57, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.moveTo(64, 22); g.lineTo(96, 60); g.lineTo(74, 60); g.lineTo(74, 104); g.lineTo(54, 104); g.lineTo(54, 60); g.lineTo(32, 60); g.fill();
    });
    A.add('mines', 128, 128, (g) => {
      g.fillStyle = '#c0261e'; g.beginPath(); g.moveTo(64, 2); g.lineTo(126, 64); g.lineTo(64, 126); g.lineTo(2, 64); g.fill();
      text(g, 'DANGER', 64, 48, 80, 20, 'bold Arial, sans-serif', '#fff');
      text(g, 'MINES', 64, 76, 80, 26, 'bold Arial, sans-serif', '#fff');
      weather(g, 20, 20, 88, 88, rnd, 0.8);
    });
    // military boards
    const board = (name, w, h, bg, fg, lines, font = 'bold "Arial Black", Arial, sans-serif') => A.add(name, w, h, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.strokeStyle = fg; g.lineWidth = 4; g.strokeRect(5, 5, w - 10, h - 10);
      lines.forEach(([t, s], k) => text(g, t, w / 2, h * (k + 1) / (lines.length + 1) + 2, w - 44, s, font, fg));
      weather(g, 0, 0, w, h, rnd, 1.3);
    });
    board('checkpoint', 320, 128, '#b8231c', '#f4efe2', [['CHECKPOINT', 44], ['STOP — SHOW ID', 24]]);
    board('stopHand', 256, 128, '#e8e0cc', '#a01c16', [['STOP', 64]], 'bold "Courier New", monospace');
    board('noentryBoard', 320, 128, '#f0ece2', '#1a1a1a', [['NO ENTRY', 42], ['AUTHORISED PERSONNEL ONLY', 18]]);
    board('fob', 320, 160, '#3a4228', '#e8e0c8', [['FOB PINEWOOD', 40], ['2ND BN · ECHO COY', 20], ['SLOW — 10 KM/H', 18]]);
    board('hq', 192, 64, '#2c3324', '#e8e0c8', [['HQ / OPS', 34]]);
    board('motorpool', 256, 64, '#2c3324', '#e8e0c8', [['MOTOR POOL', 30]]);
    board('armory', 256, 64, '#2c3324', '#e8e0c8', [['ARMORY', 34]]);
    // a topographic map with contour lines, grid and unit markings
    A.add('map', 280, 200, (g, w, h) => {
      g.fillStyle = '#e8e2cc'; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(120,170,110,0.35)'; for (let i = 0; i < 6; i++) blob(g, rnd() * w, rnd() * h, 20 + rnd() * 40, rnd, 9);
      for (let hill = 0; hill < 3; hill++) {
        const hx = 40 + rnd() * (w - 80), hy = 30 + rnd() * (h - 60);
        g.strokeStyle = 'rgba(150,90,40,0.7)'; g.lineWidth = 1;
        for (let r = 8; r < 70; r += 8) { g.beginPath(); for (let k = 0; k <= 24; k++) { const a = k / 24 * TAU, rr = r * (0.8 + 0.3 * Math.sin(a * 3 + hill)); g.lineTo(hx + Math.cos(a) * rr * 1.3, hy + Math.sin(a) * rr); } g.stroke(); }
      }
      g.strokeStyle = 'rgba(40,60,120,0.6)'; g.lineWidth = 2; g.beginPath(); g.moveTo(0, h * 0.7); g.bezierCurveTo(w * 0.3, h * 0.5, w * 0.6, h * 0.95, w, h * 0.6); g.stroke();
      g.strokeStyle = 'rgba(30,30,30,0.25)'; g.lineWidth = 1;
      for (let x = 0; x < w; x += 35) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
      for (let y = 0; y < h; y += 35) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      for (let i = 0; i < 5; i++) { const x = rnd() * w, y = rnd() * h; g.strokeStyle = i < 3 ? '#b01818' : '#1838a0'; g.lineWidth = 2; g.strokeRect(x, y, 14, 10); }
      g.strokeStyle = '#b01818'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(w * 0.2, h * 0.85); g.lineTo(w * 0.55, h * 0.4); g.lineTo(w * 0.5, h * 0.52); g.moveTo(w * 0.55, h * 0.4); g.lineTo(w * 0.42, h * 0.45); g.stroke();
    });
    // tin labels, book spines, a leafy plant (see-through between the leaves)
    [['#b8231c', '#f0e0b0'], ['#1f4f9a', '#f2efe6'], ['#2f6a45', '#e8d8a8'], ['#c8a040', '#2a1c10']].forEach(([a, b], i) => A.add(`tin${i}`, 64, 32, (g, w, h) => {
      g.fillStyle = '#9a9c9e'; g.fillRect(0, 0, w, h);
      g.fillStyle = a; g.fillRect(0, 5, w, h - 10);
      g.fillStyle = b; g.fillRect(0, 12, w, 8);
    }));
    ['#6a1e1a', '#1e3a5a', '#2c4a2c', '#5a4a2a', '#3a2a4a', '#8a6a3a', '#1a1a1a', '#7a3a1a'].forEach((c, i) => A.add(`book${i}`, 16, 64, (g, w, h) => {
      g.fillStyle = c; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(220,190,110,0.8)'; g.fillRect(0, 6, w, 2); g.fillRect(0, h - 9, w, 2); g.fillRect(4, 20, w - 8, 14);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, 0, 2, h); g.fillRect(w - 2, 0, 2, h);
    }));
    A.add('leaves', 128, 112, (g, w, h) => {
      for (let i = 0; i < 26; i++) {
        const a = -Math.PI / 2 + (rnd() - 0.5) * 2.4, len = 30 + rnd() * 40;
        g.save(); g.translate(w / 2 + (rnd() - 0.5) * 10, h - 4); g.rotate(a + Math.PI / 2);
        g.fillStyle = css([0x3f6a2e, 0x4f7a34, 0x2f5a26, 0x5e8a3e][i % 4]);
        g.beginPath(); g.ellipse(0, -len / 2, 4 + rnd() * 4, len / 2, 0, 0, TAU); g.fill();
        g.restore();
      }
    });
    A.add('board', 240, 160, (g, w, h) => {
      g.fillStyle = '#f2f2ee'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(30,60,160,0.75)'; g.lineWidth = 2;
      for (let i = 0; i < 7; i++) { g.beginPath(); let x = 16; const y = 20 + i * 19; g.moveTo(x, y); while (x < 30 + rnd() * 180) { x += 4 + rnd() * 6; g.lineTo(x, y + (rnd() - 0.5) * 4); } g.stroke(); }
      g.strokeStyle = 'rgba(180,30,30,0.8)'; g.beginPath(); g.arc(w * 0.75, h * 0.6, 22, 0, TAU); g.stroke();
      g.fillStyle = 'rgba(0,0,0,0.05)'; for (let i = 0; i < 6; i++) blob(g, rnd() * w, rnd() * h, 10 + rnd() * 20, rnd);
    });
  }

  // ---- the decal atlas: grime, posters, graffiti, road paint, litter -------
  _paintDecals(rnd) {
    const A = this.decals;
    // dirt splashed up from the ground: dark at the bottom, patchy, fading up
    A.add('dirtUp', 512, 64, (g, w, h) => {
      for (let x = 0; x < w; x += 2) {
        const k = 0.55 + 0.45 * Math.sin(x * 0.02 + Math.sin(x * 0.007) * 3) * Math.sin(x * 0.05);
        const gr = g.createLinearGradient(0, h, 0, h * (0.1 + (1 - k) * 0.5));
        gr.addColorStop(0, `rgba(58,46,34,${0.55 * k + 0.15})`); gr.addColorStop(1, 'rgba(58,46,34,0)');
        g.fillStyle = gr; g.fillRect(x, 0, 2, h);
      }
      for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(50,40,30,${rnd() * 0.25})`; blob(g, rnd() * w, h - Math.pow(rnd(), 2) * h, 0.5 + rnd() * 2, rnd, 5); }
    });
    // streak under a window sill
    A.add('streak', 128, 128, (g, w, h) => {
      for (let x = 0; x < w; x += 3) {
        const len = h * (0.3 + rnd() * 0.7), a = 0.08 + rnd() * 0.22;
        const gr = g.createLinearGradient(0, 0, 0, len);
        gr.addColorStop(0, `rgba(45,38,30,${a})`); gr.addColorStop(1, 'rgba(45,38,30,0)');
        g.fillStyle = gr; g.fillRect(x, 0, 2 + rnd() * 3, len);
      }
      const edge = g.createLinearGradient(0, 0, w, 0);
      edge.addColorStop(0, 'rgba(0,0,0,1)'); edge.addColorStop(0.15, 'rgba(0,0,0,0)'); edge.addColorStop(0.85, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,1)');
      g.globalCompositeOperation = 'destination-out'; g.fillStyle = edge; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'source-over';
    });
    // rain drips down from a roof edge
    A.add('drip', 512, 64, (g, w, h) => {
      const top = g.createLinearGradient(0, 0, 0, h * 0.35); top.addColorStop(0, 'rgba(40,36,30,0.28)'); top.addColorStop(1, 'rgba(40,36,30,0)');
      g.fillStyle = top; g.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 2 + rnd() * 4) {
        const len = h * Math.pow(rnd(), 1.5), gr = g.createLinearGradient(0, 0, 0, len);
        gr.addColorStop(0, `rgba(40,36,30,${0.06 + rnd() * 0.18})`); gr.addColorStop(1, 'rgba(40,36,30,0)');
        g.fillStyle = gr; g.fillRect(x, 0, 1.5 + rnd() * 2.5, len);
      }
    });
    // scorch (blast / fire) mark
    A.add('scorch', 256, 256, (g, w) => {
      const gr = g.createRadialGradient(w / 2, w / 2, 5, w / 2, w / 2, w / 2);
      gr.addColorStop(0, 'rgba(10,8,6,0.9)'); gr.addColorStop(0.45, 'rgba(20,16,12,0.65)'); gr.addColorStop(1, 'rgba(20,16,12,0)');
      g.fillStyle = gr; g.fillRect(0, 0, w, w);
      for (let i = 0; i < 40; i++) { const a = rnd() * TAU, r = 30 + rnd() * 90; g.fillStyle = `rgba(15,12,10,${0.2 + rnd() * 0.3})`; blob(g, w / 2 + Math.cos(a) * r, w / 2 + Math.sin(a) * r, 4 + rnd() * 12, rnd); }
    });
    A.add('oil', 128, 128, (g, w) => {
      for (let i = 0; i < 6; i++) {
        const x = w / 2 + (rnd() - 0.5) * 50, y = w / 2 + (rnd() - 0.5) * 60, r = 12 + rnd() * 30;
        const gr = g.createRadialGradient(x, y, 1, x, y, r);
        gr.addColorStop(0, 'rgba(14,12,10,0.55)'); gr.addColorStop(1, 'rgba(14,12,10,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, w);
      }
    });
    // worn white road paint
    A.add('paint', 32, 64, (g, w, h) => {
      g.fillStyle = 'rgba(232,228,214,0.85)'; g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 90; i++) { g.fillStyle = `rgba(0,0,0,${0.3 + rnd() * 0.7})`; blob(g, rnd() * w, rnd() * h, 0.5 + rnd() * 2.5, rnd, 5); }
      g.globalCompositeOperation = 'source-over';
    });
    // posters: paper, printed, faded, edges torn
    const posters = [
      ['#d8c070', '#2a1c10', ['CIRCUS', 'SAT · SUN', 'TICKETS 5']],
      ['#e8e4d8', '#a01c16', ['VOTE', '★ 14 ★', 'FOR THE FUTURE']],
      ['#2a3a5a', '#f0d070', ['THE LAST', 'SUMMER', 'CINEMA ROYAL']],
      ['#f0ece0', '#1a1a1a', ['MISSING', '(dog)', 'REWARD']],
      ['#c83a2a', '#fff2d8', ['FRESH', 'LEMONADE', 'ICE COLD']],
      ['#3a5a3a', '#f0e8d0', ['CONCERT', 'AT THE', 'TOWN HALL']],
    ];
    posters.forEach(([bg, fg, lines], i) => A.add(`poster${i}`, 128, 176, (g, w, h) => {
      g.fillStyle = bg; g.fillRect(4, 4, w - 8, h - 8);
      if (i === 3) { g.fillStyle = '#6a5a48'; blob(g, w / 2, 86, 24, rnd, 10); }
      if (i === 2) { g.fillStyle = 'rgba(255,200,120,0.4)'; g.beginPath(); g.arc(w / 2, 96, 30, 0, TAU); g.fill(); }
      lines.forEach((t, k) => text(g, t, w / 2, [36, i === 3 ? 130 : 92, 150][k], w - 20, [30, 22, 13][k], 'bold Arial, sans-serif', fg));
      weather(g, 4, 4, w - 8, h - 8, rnd, 1.2);
      g.fillStyle = 'rgba(255,250,235,0.18)'; g.fillRect(0, 0, w, h); // sun-faded
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 12; k++) { g.fillStyle = '#000'; blob(g, rnd() < 0.5 ? (rnd() < 0.5 ? 0 : w) : rnd() * w, rnd() < 0.5 ? rnd() * h : (rnd() < 0.5 ? 0 : h), 4 + rnd() * 14, rnd, 6); }
      if (rnd() < 0.6) { g.beginPath(); g.moveTo(w, h * 0.55); g.lineTo(w * 0.55, h); g.lineTo(w, h); g.fill(); }
      g.globalCompositeOperation = 'source-over';
    }));
    // graffiti: sprayed tags (soft edges = overspray)
    const tags = [['ZETA', '#2a6ad0'], ['NO WAR', '#c0261e'], ['K7', '#1a1a1a'], ['FREEDOM', '#2a8a3a'], ['RAF 99', '#8a2aa0'], ['→', '#1a1a1a']];
    tags.forEach(([t, col], i) => A.add(`graf${i}`, 256, 128, (g, w, h) => {
      g.save();
      g.translate(w / 2, h / 2); g.rotate((rnd() - 0.5) * 0.25);
      g.shadowColor = col; g.shadowBlur = 6;
      g.font = `${i % 2 ? 'bold' : 'italic bold'} ${t.length > 4 ? 46 : 70}px "Arial Black", Arial, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 7; g.strokeStyle = i === 2 || i === 5 ? 'rgba(240,240,240,0.0)' : 'rgba(250,250,250,0.85)';
      g.strokeText(t, 0, 0);
      g.fillStyle = col; g.fillText(t, 0, 0);
      g.restore();
      for (let k = 0; k < 4; k++) { const x = w * (0.2 + rnd() * 0.6), len = 6 + rnd() * 26; g.fillStyle = col; g.globalAlpha = 0.7; g.fillRect(x, h * 0.62, 2, len); g.globalAlpha = 1; } // paint runs
    }));
    // stencils
    const stencils = [['CHECKPOINT AHEAD', '#1a1a1a'], ['NO PARKING', '#a01c16'], ['WATER →', '#1a1a1a'], ['07', '#e8e2d0'], ['HQ', '#e8e2d0'], ['A-12', '#1a1a1a']];
    stencils.forEach(([t, col], i) => A.add(`sten${i}`, 256, 64, (g, w, h) => {
      text(g, t, w / 2, h / 2 + 2, w - 12, 46, 'bold "Courier New", monospace', col);
      g.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < 60; k++) { g.fillStyle = `rgba(0,0,0,${0.3 + rnd() * 0.6})`; blob(g, rnd() * w, rnd() * h, 0.5 + rnd() * 2, rnd, 5); }
      g.globalCompositeOperation = 'source-over';
    }));
    // litter: paper scraps, a wrapper, dead leaves
    for (let i = 0; i < 4; i++) A.add(`litter${i}`, 48, 48, (g) => {
      if (i < 2) { g.fillStyle = i ? '#bdb6a4' : '#a89f88'; g.beginPath(); g.moveTo(8 + rnd() * 8, 6); g.lineTo(40, 10 + rnd() * 8); g.lineTo(36 + rnd() * 6, 42); g.lineTo(6, 38); g.fill(); g.fillStyle = 'rgba(30,30,30,0.4)'; for (let k = 0; k < 5; k++) g.fillRect(12, 14 + k * 5, 18 + rnd() * 8, 1.5); }
      else if (i === 2) { g.fillStyle = '#c03a2a'; g.fillRect(10, 16, 28, 16); g.fillStyle = '#f0e0a0'; g.fillRect(16, 20, 14, 8); }
      else { for (let k = 0; k < 5; k++) { g.fillStyle = css([0x8a6a3a, 0x7a5a2a, 0x9a7a4a][k % 3]); g.save(); g.translate(10 + rnd() * 28, 10 + rnd() * 28); g.rotate(rnd() * TAU); g.beginPath(); g.ellipse(0, 0, 7, 3.5, 0, 0, TAU); g.fill(); g.restore(); } }
    });
  }
}

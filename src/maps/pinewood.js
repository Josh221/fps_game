// =============================================================================
// maps/pinewood.js — "PINEWOOD": a hilltop firebase in a misty pine forest.
// You start in the valley to the south and fight uphill through the trees.
// Dense forest = short sight lines, lots of trunk cover, ambushes.
// =============================================================================
import * as THREE from 'three';
import { makeNoise, fbm, applyFlats } from '../terrain.js';
import { Grass, Forest, placeRocks } from '../vegetation.js';
import { computeCoverPoints } from '../builder.js';
import { Decor } from '../decor.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const noise = makeNoise(4242);

const BASE_H = 14; // the firebase plateau height
const FLATS = [
  { x: 0, z: -10, w: 64, d: 56, h: BASE_H, blend: 34 }, // hilltop plateau
  { x: 0, z: 92, w: 30, d: 20, h: 0, blend: 22 },       // valley start
];

// Winding dirt track from the valley up to the gate
const trackX = (z) => Math.sin(z * 0.045) * 14 + Math.sin(z * 0.11) * 4;
const trackW = (x, z) => (z > 16 && z < 115 ? 1 - smooth(2.5, 5, Math.abs(x - trackX(z))) : 0);

function height(x, z) {
  const r = Math.hypot(x, z);
  let h = fbm(noise, x * 0.011, z * 0.011, 5) * 10;
  h += (1 - smooth(20, 120, Math.hypot(x, z + 10))) * 9;          // the big hill
  h += Math.max(0, fbm(noise, x * 0.005 + 20, z * 0.005, 4)) * 45 * smooth(120, 300, r);
  h -= smooth(40, 110, z) * 7;                                     // valley to the south
  const t = trackW(x, z);
  if (t > 0) h += (fbm(noise, 3.3, z * 0.01, 3) * 3 + BASE_H * (1 - smooth(20, 100, z)) - h) * t * 0.6;
  return applyFlats(h, x, z, FLATS);
}

const inBase = (x, z) => Math.abs(x) < 30 && Math.abs(z + 10) < 26;

function splat(x, z, h, slope) {
  const rock = Math.max(smooth(0.35, 0.6, slope), smooth(0.6, 0.85, (noise(x * 0.05, z * 0.05) + 1) / 2) * 0.6);
  const mud = Math.max(trackW(x, z) * 1.5, inBase(x, z) ? 0.9 : 0, smooth(0.0, 0.5, noise(x * 0.03 + 7, z * 0.03)) * 0.6);
  return [1, mud * 2, rock * 2.5];
}

// Bunker, building and tent footprints [x0, z0, x1, z1]: no grass grows indoors
const ROOFED = [[-22, -28, -10, -20], [8, -6, 20, 4], [-6, -32, 6, -22], [7.75, -23.5, 12.25, -16.5], [-16, -9, -12, -3], [-6, 3, -2, 9]];
const roofed = (x, z) => ROOFED.some(([x0, z0, x1, z1]) => x > x0 && x < x1 && z > z0 && z < z1);

function grassDensity(x, z) {
  if (roofed(x, z)) return 0;
  if (trackW(x, z) > 0.2) return 0.05;
  if (inBase(x, z)) return 0.15;
  const n = smooth(-0.4, 0.3, noise(x * 0.04 + 9, z * 0.04));
  return 0.95 * n;
}

export default {
  id: 'pinewood',
  name: 'PINEWOOD',
  blurb: 'Hilltop firebase in a misty pine forest. Fight uphill through the trees.',
  sky: { hdri: 'kloofendal_misty_morning_puresky', exposure: 1.05, sunScale: 1.2, envIntensity: 1, fogDensity: 0.0075, fogColorScale: 0.9, groundColor: 0x4a5040 },
  grade: { saturation: 0.88, contrast: 1.1, tint: 0xf0f6ff, vignette: 0.38 },
  soldierTint: 0x8f9670,
  objective: 'TAKE THE HILLTOP FIREBASE',
  terrain: {
    layers: [['sparse_grass', 3], ['brown_mud_leaves_01', 3], ['aerial_rocks_02', 5]],
    surfaces: ['grass', 'dirt', 'rock'],
    height, splat,
  },
  materials: {
    wall: ['brown_planks_05', { surface: 'wood', tile: 1.4, color: 0x9a8a78 }],
    floor: ['brown_planks_05', { surface: 'wood', tile: 1.2 }],
    roof: ['brown_planks_05', { surface: 'wood', tile: 1.4, color: 0x7a6a5a }],
    concrete: ['brushed_concrete', { surface: 'concrete' }],
    bunker: ['concrete_slab_wall', { surface: 'concrete', color: 0xa0a098 }],
    trim: ['brown_planks_05', { surface: 'wood', tile: 1.5, color: 0x6a5a48 }],
    wood: ['brown_planks_05', { surface: 'wood', tile: 1.2 }],
    log: ['bark_brown_02', { surface: 'wood', tile: 1.5 }],
    metal: ['green_metal_rust', { surface: 'metal', tile: 1.5 }],
    roofMetal: ['corrugated_iron_02', { surface: 'metal', color: 0x8a8a80 }],
    canvas: ['hessian_230', { surface: 'cloth', color: 0x6a7448, tile: 0.8, side: THREE.DoubleSide }],
    rock: ['aerial_rocks_02', { surface: 'rock', tile: 4 }],
    containers: [['container_side', { map: null, color: 0x4b5a3a, surface: 'metal', tile: 2.4 }]],
  },
  props: ['cement_bag', 'wooden_military_crate', 'wooden_crate_02', 'ammo_box', 'medical_box', 'Barrel_01', 'barrel_03',
    'metal_jerrycan_green', 'portable_generator', 'propane_tank', 'tree_stump_01', 'dead_tree_trunk'],
  navBounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 105 },
  testViews: [[trackX(80), 0, 80, 0.2, 0.08], [0, 0, 28, 0, 0.05], [-14, 0, -12, -0.6, 0], [20, 0, -30, 2.4, -0.15, 4.6], [-60, 0, 30, 0.8, 0.05]],

  async build({ scene, world, terrain, builder: b, props: P, M, rand, decoRand, quality }) {
    const Y = BASE_H;
    const g = (x, z) => world.groundHeight(x, z);

    // ---------------------------------------------------- log palisade around the firebase
    const palisade = (axis, a0, a1, fixed, gaps = []) => b.palisade(axis, a0, a1, fixed, Y, 2.8, M.log, gaps);
    palisade('x', -30, 30, 16, [trackX(16)]);   // south (gate where the track arrives)
    palisade('x', -30, 30, -36, [0]);           // north gate
    palisade('z', -35.8, 15.8, -30, [-10]);
    palisade('z', -35.8, 15.8, 30, [-18]);

    // ---------------------------------------------------- bunkers & buildings
    b.building({ x0: -22, x1: -10, z0: -28, z1: -20, y0: Y, h: 2.5, wall: M.bunker, frame: M.trim, parapet: 0,
      doors: { e: [-24] }, windows: { s: [-19, -13], n: [-16], w: [-24] } });
    P.sandbags(-22.2, -19.4, -10, -19.4, { layers: 4, y: Y });
    b.building({ x0: 8, x1: 20, z0: -6, z1: 4, y0: Y, h: 2.5, wall: M.bunker, frame: M.trim, parapet: 0,
      ladder: { side: 's', at: 14 }, // up onto the bunker roof, facing the slope you attack from
      doors: { w: [-1] }, windows: { s: [11, 17], e: [-1], n: [14] } });
    b.building({ x0: -6, x1: 6, z0: -32, z1: -22, y0: Y, h: 3, floors: 2, stairs: { x: -5.2, z: -30.9, dir: 'x' }, wall: M.wall, frame: M.trim,
      ladder: { side: 'e', at: -29.5 }, // roof access
      doors: { s: [3] }, windows: { s: [-3], n: [-3, 3], e: [-27], w: [-25] } });
    const towerA = b.tower(-24, 8, 1, Y);
    const towerB = b.tower(25, -30, -1, Y);
    b.tent(10, -20, 4.5, 7);
    b.tent(-14, -6, 4, 6);
    b.tent(-4, 6, 4, 6);
    b.container(18, 10, false, 0, Y);
    b.truck(-18, 6, true, Y);
    b.flag(0, -12, ['#3a4228', '#1d2a3a', '#d8d2bd']);

    // radio mast with guy wires
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 14, 8), M.metal);
    mast.position.set(14, Y + 7, -16);
    b.add(mast, true, false);
    world.add(V(13.85, Y, -16.15), V(14.15, Y + 14, -15.85), { surface: 'metal' });
    const wireMat = new THREE.LineBasicMaterial({ color: 0x222222 });
    for (const [dx, dz] of [[5, 5], [-5, 5], [5, -5], [-5, -5]]) {
      const geo = new THREE.BufferGeometry().setFromPoints([V(14, Y + 13.5, -16), V(14 + dx, Y, -16 + dz)]);
      scene.add(new THREE.Line(geo, wireMat));
    }

    // ---------------------------------------------------- sandbag positions
    for (const [x0, z0, x1, z1] of [[-6, 12, 2, 12], [8, 12, 14, 12], [-28, -2, -28, 6], [27.5, -10, 27.5, -2], [-6, -34, 6, -34],
      [-14, 2, -8, 2], [4, -14, 10, -14], [-20, -14, -20, -8]]) {
      P.sandbags(x0, z0, x1, z1, { layers: 6 });
    }
    // forward positions on the slope (enemy outposts)
    for (const [x0, z0, x1, z1] of [[trackX(40) - 6, 40, trackX(40) - 1, 40], [trackX(55) + 3, 55, trackX(55) + 8, 55], [-30, 35, -24, 35], [30, 30, 36, 30]]) {
      P.sandbags(x0, z0, x1, z1, { layers: 6 });
    }

    // ---------------------------------------------------- crates, barrels, clutter
    const crate = (x, z, rot = 0, stack = true) => {
      P.add('wooden_military_crate', x, z, { rotY: rot, cover: true, pen: 0.45 });
      if (stack) P.add('wooden_crate_02', x, z, { y: g(x, z) + 0.46, rotY: rot + 0.1, cover: true, pen: 0.45 });
    };
    crate(-2, -4); crate(12, -12, 1.4); crate(-16, -30, 0.3); crate(22, 2, 1.57, false); crate(-25, -24); crate(4, 0, 0.2, false);
    for (const [x, z, id] of [[16, -24, 'Barrel_01'], [16.7, -24.4, 'barrel_03'], [-12, 10, 'Barrel_01'], [-26, -15, 'barrel_03'], [7, -2, 'Barrel_01']]) {
      P.add(id, x, z, { rotY: rand() * 6, cover: true, pen: 0.5, surface: 'metal' });
    }
    P.add('portable_generator', 11.5, -15.5, { rotY: 0.5, surface: 'metal' });
    for (let i = 0; i < 5; i++) P.add('metal_jerrycan_green', 15 + i * 0.4, -25.5, { collide: false });
    P.add('propane_tank', -9, -21, { surface: 'metal' });

    const ammo = (x, z) => {
      P.add('wooden_military_crate', x, z, { cover: true, pen: 0.45 });
      const y = g(x, z) + 0.46;
      P.add('ammo_box', x - 0.25, z, { y, rotY: 0.2, collide: false });
      P.add('ammo_box', x + 0.2, z, { y, rotY: -0.3, collide: false });
      P.add('medical_box', x, z - 0.12, { y, rotY: 1.6, collide: false });
      return V(x, g(x, z), z);
    };
    const ammoCrates = [ammo(4, 96), ammo(-3, -6)];

    // ---------------------------------------------------- set dressing (decor.js)
    // Furnished bunkers and ops building, a campfire and mess table, camo
    // nets, duckboards over the mud, floodlights, wire and signs. Own seeded
    // random stream: identical for every co-op player.
    const decor = new Decor({ scene, world, builder: b, props: P, M, seed: 2207 });
    await decor.load(['military', 'camp']);
    decor.keepClear([{ x: -16, z: -24 }, { x: 14, z: -1 }, { x: 0, z: -30 }, { x: 0, z: -27, y: Y + 3 }]);
    const [bunkerW, bunkerE, ops] = b.buildings;
    const mil = { glass: 0, curtains: false, shutters: false, civil: false };
    decor.building(bunkerW, { ...mil, front: 's', rooms: ['bunker'] });
    decor.building(bunkerE, { ...mil, front: 'w', rooms: ['bunker'] });
    decor.building(ops, { ...mil, glass: 0.25, front: 's', rooms: ['office', 'barracks'] });
    decor.signPlate('hq', 1.0, 3, Y + 2.55, -21.96, 0);
    decor.signPlate('armory', 1.1, 7.96, Y + 1.75, 0.6, -Math.PI / 2);

    // campfire, mess table and a stove between the tents
    if (!decor.blocked(-11.5, Y + 0.1, -17.5, -6.5, Y + 1.2, -12.5)) decor.campfire(-9, -15);
    if (!decor.blocked(2.8, Y + 0.1, -20.6, 5.2, Y + 0.9, -17.4)) P.add('wooden_picnic_table', 4, -19, { pen: 0.4, surface: 'wood' });
    if (!decor.blocked(1, Y + 0.1, -17.6, 2.2, Y + 0.9, -16.4)) P.add('barrel_stove', 1.6, -17, { surface: 'metal', pen: 0.5 });
    // duckboards over the mud: HQ door to the tents, west bunker to the fire
    decor.duckboards([[3, -21.2], [3, -16], [-4.7, -12], [-4.7, 2.4]]);
    decor.duckboards([[-9.2, -24], [-7.2, -24], [-7.2, -17.5], [-4.7, -12]]);
    // camo nets over the truck and the container
    const woodland = [0x3e4a2c, 0x56603a, 0x2c3324, 0x6a6244];
    decor.camoNet(-18, 6, 9, 5.5, 3.4, woodland);
    decor.camoNet(18, 10, 5.5, 8.5, 3.3, woodland);
    // floodlights in two corners, wire along the south palisade, signs
    decor.floodlight(-27, 13, 2.36);
    decor.floodlight(27, -33, -0.79);
    const gx = trackX(16);
    decor.razorWire(-29.5, 17.6, gx - 3.4, 17.6, null, { blockMove: true });
    decor.razorWire(gx + 3.4, 17.6, 29.5, 17.6, null, { blockMove: true });
    decor.boardSign(gx + 5.6, 19.2, 0, 'fob', { w: 2.4, h: 1.3 });
    for (const [x, z, r] of [[-33, -20, -Math.PI / 2], [33, 5, Math.PI / 2], [-12, -39, Math.PI], [20, -39, Math.PI]]) decor.roadSign(x, z, r, 'mines', { size: 0.55, h: 1.1 });
    decor.litter({ minX: -28, maxX: 28, minZ: -34, maxZ: 14 }, 120);
    decor.finish();

    // fallen logs and stumps in the forest = natural cover
    for (const [x, z, r] of [[-20, 60, 0.4], [26, 52, 1.9], [-42, 20, 2.6], [40, -50, 0.9]]) P.add('dead_tree_trunk', x, z, { rotY: r, cover: true, surface: 'wood', pen: 1.5, scale: 1.3 });
    for (const [x, z] of [[-12, 70], [18, 40], [-34, -8], [38, 12], [-8, 48], [30, 72]]) P.add('tree_stump_01', x, z, { rotY: x, surface: 'wood', cover: true });

    // ---------------------------------------------------- forest
    const trees = [];
    const plant = (n, inner, outer, base) => {
      let guard = 0, placed = 0;
      while (placed < n && guard++ < n * 30) {
        const x = (rand() - 0.5) * 2 * outer, z = (rand() - 0.5) * 2 * outer;
        const m = Math.max(Math.abs(x), Math.abs(z));
        if (m < inner || m > outer) continue;
        if (Math.abs(x) < 38 && z > -46 && z < 26) continue;               // clearing around the base
        if (Math.abs(x - trackX(z)) < 7 && z > 10 && z < 120) continue;   // keep the track open
        if (Math.abs(x) < 20 && z > 82 && z < 110) continue;             // start area
        const kind = rand();
        trees.push({ x, z, s: kind < 0.6 ? 0.85 + rand() * 0.35 : 0.6 + rand() * 0.3, variant: base + (kind < 0.6 ? 0 : kind < 0.85 ? 1 : 2) });
        placed++;
      }
    };
    // Fixed counts, the same on every graphics preset: trunks in the play area
    // are solid (they stop bullets and hide you), so every player in a co-op
    // game must have the same trees in the same places.
    plant(240, 0, 116, 0);    // play area: dense, full detail
    plant(340, 116, 380, 3);  // horizon: lower detail
    const forest = new Forest(scene, world, terrain, [
      { preset: 'Pine Medium', seed: 3, detail: 0.6 },
      { preset: 'Pine Small', seed: 8, detail: 0.6 },
      { preset: 'Aspen Medium', seed: 2, leafTint: 0xa8c070, detail: 0.8 },
      { preset: 'Pine Medium', seed: 13, far: true },
      { preset: 'Pine Small', seed: 21, far: true },
      { preset: 'Aspen Medium', seed: 4, leafTint: 0xa8c070, far: true },
    ], trees, { units: 0.33, leafShadows: quality.leafShadows });

    const area = { minX: -112, maxX: 112, minZ: -112, maxZ: 112 };
    // Grass is looks-only and its amount follows the graphics preset, so it uses
    // decoRand, not rand (see main.js): the trees and rocks after it stay put.
    const grass = new Grass(scene, {
      terrain, area, rand: decoRand, count: Math.round(42000 * quality.grass), density: grassDensity, height: [0.3, 0.75],
      colors: [0x5c6e3a, 0x6b7a40, 0x4f6234, 0x7a8048, 0x667040],
    });

    const rocks = [];
    for (let i = 0; i < 90; i++) {
      const x = (rand() - 0.5) * 230, z = (rand() - 0.5) * 230;
      if (inBase(x, z) || trackW(x, z) > 0) continue;
      rocks.push({ x, z, s: 0.5 + Math.pow(rand(), 2) * 2.4, sy: 0.6 + rand() * 0.4, variant: i });
    }
    placeRocks(scene, world, terrain, M.rock, rocks, { seed: 99 });

    const B = 114, H = 300;
    world.add(V(-B - 5, -50, -B - 5), V(B + 5, H, -B), { solid: false });
    world.add(V(-B - 5, -50, B), V(B + 5, H, B + 5), { solid: false });
    world.add(V(-B - 5, -50, -B), V(-B, H, B), { solid: false });
    world.add(V(B, -50, -B), V(B + 5, H, B), { solid: false });

    return {
      objective: 'TAKE THE HILLTOP FIREBASE',
      playerSpawn: { pos: V(0, 0, 96), yaw: 0 },
      enemySpawns: [
        { pos: towerA.clone(), role: 'sentry', keepY: true },
        { pos: towerB.clone(), role: 'sentry', keepY: true },
        { pos: V(trackX(40) - 3.5, 0, 39), role: 'guard' },
        { pos: V(trackX(55) + 5.5, 0, 54), role: 'guard' },
        { pos: V(-2, 0, 11), role: 'guard' },
        { pos: V(-20, 0, 40), role: 'patrol' },
        { pos: V(22, 0, 45), role: 'patrol' },
        { pos: V(-16, 0, -24), role: 'guard' },
        { pos: V(0, Y + 3, -27), role: 'sentry', keepY: true },
        { pos: V(14, 0, -1), role: 'guard' },
        { pos: V(-27, 0, 34), role: 'guard' },
        { pos: V(13.5, 0, -18), role: 'patrol' }, // beside the tent at (10, -20), not inside it
      ],
      assaultSpawns: [V(0, 0, -85), V(-70, 0, -40), V(70, 0, -30), V(-80, 0, 20), V(80, 0, 10), V(-30, 0, -90)],
      patrolPoints: [V(0, 0, 0), V(-15, 0, -10), V(15, 0, -20), V(0, 0, -30), V(-20, 0, 40), V(22, 0, 45), V(trackX(60), 0, 60),
        V(-40, 0, 10), V(40, 0, -5), V(-25, 0, -45), V(25, 0, -45), V(trackX(30), 0, 30)],
      ammoCrates,
      coverPoints: () => computeCoverPoints(world),
      concealAt: grassDensity,
      update: (t, cam) => { grass.update(t, cam); forest.update(t, cam); for (const f of b.animated) f(t); },
    };
  },
};

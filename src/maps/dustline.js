// =============================================================================
// maps/dustline.js — "DUSTLINE": a walled compound in dry, rolling hills.
// Midday sun, dry grass, scattered trees. You attack from the south road.
//
// A map module is pure data + a build() function: what sky, what textures,
// how the ground is shaped, and where every building and crate goes.
// =============================================================================
import * as THREE from 'three';
import { makeNoise, fbm, applyFlats } from '../terrain.js';
import { Grass, Forest, placeRocks } from '../vegetation.js';
import { computeCoverPoints } from '../builder.js';
import { Decor } from '../decor.js';
import { addLadder } from '../ladder.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const noise = makeNoise(1337);

const FLATS = [
  { x: 0, z: 0, w: 106, d: 106, h: 0, blend: 24 },    // compound pad
  { x: 0, z: 76, w: 34, d: 30, h: 0.6, blend: 26 },   // assault start
];

function height(x, z) {
  const r = Math.hypot(x, z);
  let h = fbm(noise, x * 0.0085, z * 0.0085, 5) * 9;
  h += Math.max(0, fbm(noise, x * 0.004 + 50, z * 0.004, 4)) * 34 * smooth(110, 260, r);
  h += smooth(220, 400, r) * 30;
  // the road follows a smoothed version of the ground
  const road = (1 - smooth(4, 12, Math.abs(x))) * smooth(48, 60, Math.abs(z));
  if (road > 0) h += (fbm(noise, 7.7, z * 0.006, 3) * 4 - h) * road;
  return applyFlats(h, x, z, FLATS);
}

const inside = (x, z) => Math.abs(x) < 50 && Math.abs(z) < 50;
const roadW = (x, z) => (1 - smooth(3, 5, Math.abs(x))) * (Math.abs(z) > 47 ? 1 : 0);

function splat(x, z, h, slope) {
  const rock = Math.max(smooth(0.3, 0.55, slope), smooth(0.55, 0.8, (noise(x * 0.04, z * 0.04) + 1) / 2) * 0.7 * (inside(x, z) ? 0 : 1));
  const yard = inside(x, z) ? smooth(-0.1, 0.4, noise(x * 0.06 + 3, z * 0.06)) * 0.8 : 0;
  return [1, Math.max(roadW(x, z), yard) * 2.5, rock * 2];
}

// Building and tent footprints [x0, z0, x1, z1]: no grass grows indoors
const ROOFED = [[-16, -38, 4, -24], [-44, -12, -32, 14], [24, -34, 42, -16], [-26, 30, -22, 36], [-26, 39, -22, 45]];
const roofed = (x, z) => ROOFED.some(([x0, z0, x1, z1]) => x > x0 && x < x1 && z > z0 && z < z1);

function grassDensity(x, z) {
  if (roadW(x, z) > 0.1 || roofed(x, z)) return 0;
  if (inside(x, z)) return 0.04;
  const patch = smooth(-0.3, 0.35, noise(x * 0.035 + 9, z * 0.035));
  const rocky = smooth(0.55, 0.8, (noise(x * 0.04, z * 0.04) + 1) / 2);
  return 0.8 * patch * (1 - rocky);
}

export default {
  id: 'dustline',
  name: 'DUSTLINE',
  blurb: 'Walled compound in dry hills. Midday. Assault from the south road.',
  sky: { hdri: 'kloofendal_48d_partly_cloudy_puresky', exposure: 0.9, sunScale: 1, envIntensity: 1, fogDensity: 0.0017, groundColor: 0x6f655a },
  soldierTint: 0xd8c8a8,
  grade: { saturation: 0.95, contrast: 1.08, tint: 0xfff4e6 },
  terrain: {
    layers: [['dry_ground_01', 4], ['gravel_road', 3], ['dry_ground_rocks', 4]],
    surfaces: ['dirt', 'dirt', 'rock'],
    height, splat,
  },
  materials: {
    wall: ['concrete_slab_wall', { surface: 'concrete' }],
    plaster: ['clay_plaster', { surface: 'concrete' }],
    floor: ['concrete_floor_worn_001', { surface: 'concrete' }],
    roof: ['brushed_concrete', { surface: 'concrete' }],
    concrete: ['brushed_concrete', { surface: 'concrete' }],
    plinth: ['concrete_floor_worn_001', { color: 0x6e665a }],
    trim: ['brown_planks_05', { surface: 'wood', tile: 1.5 }],
    wood: ['brown_planks_05', { surface: 'wood', tile: 1.2 }],
    metal: ['green_metal_rust', { surface: 'metal', tile: 1.5 }],
    roofMetal: ['corrugated_iron_02', { surface: 'metal' }],
    shed: ['corrugated_iron_02', { surface: 'metal', color: 0xb8b8b0, metalness: 0.45 }], // less mirror-like: not black in shade
    canvas: ['hessian_230', { surface: 'cloth', color: 0x7d8458, tile: 0.8, side: THREE.DoubleSide }],
    rock: ['cliff_side', { surface: 'rock', tile: 3, color: 0xb4aca0 }],
    containers: [
      ['container_side', { map: null, color: 0x8a3a2a, surface: 'metal', tile: 2.4 }],
      ['container_side', { map: null, color: 0x34506a, surface: 'metal', tile: 2.4 }],
      ['container_side', { map: null, color: 0x55613f, surface: 'metal', tile: 2.4 }],
      ['container_side', { map: null, color: 0x9a8a66, surface: 'metal', tile: 2.4 }],
    ],
  },
  props: ['cement_bag', 'wooden_military_crate', 'wooden_crate_02', 'ammo_box', 'Barrel_01', 'Barrel_02', 'barrel_03',
    'metal_jerrycan_green', 'portable_generator', 'old_tyre', 'propane_tank', 'concrete_road_barrier_02', 'medical_box'],
  navBounds: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
  // [x, unused, z, yaw, pitch, height offset] — camera spots used by the automated screenshot test
  testViews: [[0, 0, 58, 0, 0], [-6, 0, 30, -0.4, 0.02], [-3, 0, -27, 0.9, 0.05], [42, 0, 42, 2.4, -0.25, 4.6], [-40, 0, 70, -0.9, 0.02], [30, 0, 95, 2.7, 0.03]],

  async build({ scene, world, terrain, builder: b, props: P, M, rand, decoRand, quality }) {
    // ---------------------------------------------------- perimeter wall
    const WH = 3.2, WT = 0.5;
    const gate = { at: 0, w: 8, bottom: 0, top: WH };
    b.wall('x', -50, 50, 50, WT, -0.4, WH + 0.4, M.wall, [gate]);
    b.wall('x', -50, 50, -50, WT, -0.4, WH + 0.4, M.wall, [gate]);
    b.wall('z', -49.75, 49.75, 50, WT, -0.4, WH + 0.4, M.wall, [{ at: 10, w: 4, bottom: 0, top: WH + 0.4 }]);
    b.wall('z', -49.75, 49.75, -50, WT, -0.4, WH + 0.4, M.wall, [{ at: -20, w: 1.4, bottom: 0, top: 2.6 }]);
    for (const z of [50, -50]) for (const x of [-4.4, 4.4]) b.box(x, -0.4, z, 0.8, 4.2, 0.8, M.concrete);
    b.rubble(51.6, 10, 10);
    b.rubble(48.4, 10, 7);

    // ---------------------------------------------------- buildings
    b.building({ x0: -16, x1: 4, z0: -38, z1: -24, h: 3.4, floors: 2, stairs: { x: -15.2, z: -36.8, dir: 'x' },
      ladder: { side: 'w', at: -27 }, // roof access up the west wall
      doors: { s: [-10, 0], e: [-31] }, windows: { s: [-13.5, -3, 2], n: [-11, -1], w: [-31], e: [-27] },
      interior: [{ axis: 'z', a0: -37.7, a1: -24.3, fixed: -6, doors: [-31] }] });
    b.building({ x0: -44, x1: -32, z0: -12, z1: 14, h: 3.2, wall: M.plaster,
      doors: { e: [-6, 8] }, windows: { e: [-10, 3.5, 11.5], w: [-6, -1, 5, 10], n: [-38], s: [-38] },
      interior: [{ axis: 'x', a0: -43.7, a1: -32.3, fixed: 1, doors: [-38] }] });
    b.building({ x0: 24, x1: 42, z0: -34, z1: -16, h: 5.5, thick: 0.15, wall: M.shed, parapet: 0, frame: null,
      doors: { w: [{ at: -25, w: 5, top: 4.3 }], s: [38] }, windows: { e: [-25] }, wallOpts: { pen: 0.3 } });

    const towerSE = b.tower(42, 42, -1);
    const towerNW = b.tower(-42, -42, 1);

    b.container(8, 6, true, 0);
    b.container(8, 6, true, 1, 2.59);
    // A ladder bolted to the stacked containers: a perch overlooking the yard
    const stackTop = 2.59 * 2;
    addLadder(b, { x: 9.6, z: 6 + 1.22, nx: 0, nz: 1, y0: world.groundHeight(9.6, 7.7), y1: stackTop, wallThick: 0,
      deck: { minX: 8 - 3.03, maxX: 8 + 3.03, minZ: 6 - 1.22, maxZ: 6 + 1.22, y: stackTop } });
    b.container(-20, 22, false, 2);
    b.container(18, 28, true, 1);
    b.container(-26, -44, true, 0);
    b.container(-33, 40, false, 3);
    b.truck(20, -4, false);
    b.truck(33, -25, true);

    // ---------------------------------------------------- sandbags & barriers
    P.sandbags(-3.5, 41, 3.5, 41);
    P.sandbags(-3.9, 38, -3.9, 40.7);
    P.sandbags(3.9, 38, 3.9, 40.7);
    P.sandbags(-10, 14, -4, 14);
    P.sandbags(-10.3, 10, -10.3, 13.7);
    P.sandbags(12, 18, 17, 18);
    P.sandbags(-10, -20, -2, -20);
    P.sandbags(24, 6, 30, 6);
    P.sandbags(-22, -5, -22, 0);
    P.sandbags(-12, 63, -6, 63);
    P.sandbags(14, 58, 18, 58);
    for (const [x, z] of [[-2.4, 56], [2.4, 59.5], [-6, -56], [6, -58], [-0.8, 56], [0.8, 59.5]]) {
      P.add('concrete_road_barrier_02', x, z, { cover: true, surface: 'concrete' });
    }

    // ---------------------------------------------------- crates, barrels, clutter
    const crates = (x, z, rot = 0, two = true) => {
      P.add('wooden_military_crate', x, z, { rotY: rot, cover: true, pen: 0.45, surface: 'wood' });
      if (two) P.add('wooden_crate_02', x + (rand() - 0.5) * 0.1, z, { y: world.groundHeight(x, z) + 0.46, rotY: rot + (rand() - 0.5) * 0.2, cover: true, pen: 0.45, surface: 'wood' });
    };
    crates(-18, 2); crates(-18, 3.1, 0, false); crates(4, -13, Math.PI / 2); crates(24, 17); crates(-27, -30);
    crates(12, 38, 0.2); crates(30, -31); crates(37, -20, Math.PI / 2); crates(-14, 30); crates(-30, 30, 0.1); crates(30, 40);
    for (const [x, z, id] of [[-28, -20, 'Barrel_01'], [-27.3, -20.6, 'Barrel_02'], [-28.4, -19.2, 'barrel_03'], [26, -12, 'Barrel_01'],
      [26.7, -12.5, 'barrel_03'], [-14, 36.2, 'Barrel_02'], [-14.7, 35.6, 'Barrel_01'], [44, 30, 'barrel_03'], [-36, 20, 'Barrel_01']]) {
      P.add(id, x, z, { rotY: rand() * 6, cover: true, pen: 0.5, surface: 'metal' });
    }
    P.add('portable_generator', 22, -14, { rotY: 0.4, surface: 'metal' });
    P.add('portable_generator', -30, -8, { rotY: 1.2, surface: 'metal' });
    for (let i = 0; i < 6; i++) P.add('metal_jerrycan_green', -29 + i * 0.42, -21.5, { rotY: (rand() - 0.5) * 0.3, surface: 'metal', collide: false });
    for (const [x, z] of [[21, -10], [21.6, -10.4], [-21, 26], [36, 10]]) P.add('old_tyre', x, z, { rotY: rand() * 6, collide: false });
    for (const [x, z] of [[-30.5, -7], [-30, -7.4]]) P.add('propane_tank', x, z, { surface: 'metal' });

    b.tent(-24, 33);
    b.tent(-24, 42);
    b.flag(-13, -17);

    // Ammo crates: a military crate with ammo cans on top
    const ammo = (x, z) => {
      P.add('wooden_military_crate', x, z, { cover: true, pen: 0.45 });
      const y = world.groundHeight(x, z) + 0.46;
      P.add('ammo_box', x - 0.25, z, { y, rotY: 0.2, collide: false });
      P.add('ammo_box', x + 0.2, z + 0.05, { y, rotY: -0.3, collide: false });
      P.add('medical_box', x, z - 0.12, { y, rotY: 1.6, collide: false });
      return V(x, world.groundHeight(x, z), z);
    };
    const ammoCrates = [ammo(-4, 68), ammo(2, -6)];

    // ---------------------------------------------------- set dressing (decor.js)
    // Furnished rooms (ops room, barracks, workshop), razor wire on the walls,
    // HESCO barriers, camo nets, floodlights, signs. Own seeded random stream:
    // identical for every co-op player.
    const decor = new Decor({ scene, world, builder: b, props: P, M, seed: 1958 });
    await decor.load(['military', 'camp']);
    // AI spots inside the buildings: furniture keeps clear of them
    decor.keepClear([{ x: -10, z: -31 }, { x: -3, z: -30 }, { x: -38, z: -5 }, { x: -38, z: 8 }, { x: 32, z: -20 }, { x: 33, z: -29 }, { x: 1, z: -31, y: 3.4 }]);
    const [hq, barracks, shed] = b.buildings;
    const mil = { glass: 0.3, curtains: false, shutters: false, civil: false };
    decor.building(hq, { ...mil, front: 's', rooms: ['office', 'barracks'] });
    decor.building(barracks, { ...mil, front: 'e', rooms: ['barracks'] });
    decor.building(shed, { ...mil, glass: 0, front: 'w', roof: false, drainpipe: false, rooms: ['workshop'] });
    decor.signPlate('hq', 1.0, -10, 2.62, -23.95, 0);
    decor.signPlate('armory', 1.2, -31.95, 2.6, 8, Math.PI / 2);
    decor.signPlate('motorpool', 2.2, 23.9, 4.72, -25, -Math.PI / 2);

    // razor wire along the top of the perimeter wall (gaps at the gates)
    const top = 3.2 + 0.28;
    for (const z of [50, -50]) { decor.razorWire(-49.7, z, -4.9, z, top, { r: 0.3 }); decor.razorWire(4.9, z, 49.7, z, top, { r: 0.3 }); }
    decor.razorWire(50, -49.5, 50, 7.8, top, { r: 0.3 }); decor.razorWire(50, 12.2, 50, 49.5, top, { r: 0.3 });
    decor.razorWire(-50, -49.5, -50, -20.9, top, { r: 0.3 }); decor.razorWire(-50, -19.1, -50, 49.5, top, { r: 0.3 });
    // and coils on the ground outside the south wall: they stop you walking
    // (and the AI pathing) but not bullets — leaving the road as the way in
    decor.razorWire(-40, 53.6, -13, 53.6, null, { blockMove: true });
    decor.razorWire(13, 53.6, 40, 53.6, null, { blockMove: true });

    // HESCO barriers flanking both gates, inside
    for (const z of [45.8, -45.8]) for (const x of [-7.5, 7.5]) if (!decor.blocked(x - 1.2, 0.1, z - 0.6, x + 1.2, 1.4, z + 0.6)) decor.hesco(x, z, true, 2);

    // camo nets: over the truck, the crates by the west sandbags, the mess area
    const desert = [0xa89a72, 0x8a7a58, 0x6e6448, 0xbcae88];
    decor.camoNet(20, -4, 5.5, 9.5, 3.4, desert);
    decor.camoNet(-19, 3, 6, 6, 2.9, desert);
    decor.camoNet(-17.5, 38.5, 6, 7, 2.8, desert);
    if (!decor.blocked(-18.6, 0.1, 37, -16.4, 0.8, 40)) P.add('wooden_picnic_table', -17.5, 38.5, { pen: 0.4, surface: 'wood' });
    if (!decor.blocked(-21.2, 0.1, 35.4, -20, 0.9, 36.6)) P.add('barrel_stove', -20.6, 36, { surface: 'metal', pen: 0.5 });
    decor.waterTank(-38.5, 21);

    // floodlights at two corners and the gates
    decor.floodlight(-46, 46, 2.36);
    decor.floodlight(46, -46, -0.79);
    decor.floodlight(8.6, 47.4, 0);
    decor.floodlight(-8.6, -47.4, Math.PI);

    // signs: checkpoint boards at the gates, minefield warnings outside the walls
    decor.boardSign(-7.6, 54.6, 0, 'checkpoint', { w: 2.6 });
    decor.boardSign(7.4, 57.4, 0, 'stopHand', { w: 1.6 });
    decor.boardSign(7.6, -54.6, Math.PI, 'noentryBoard', { w: 2.6 });
    for (const [x, z, r] of [[-56, 4, -Math.PI / 2], [-56, -30, -Math.PI / 2], [56, -24, Math.PI / 2], [56, 30, Math.PI / 2], [-30, -56, Math.PI]]) decor.roadSign(x, z, r, 'mines', { size: 0.55, h: 1.1 });
    decor.stencil('sten0', -16, 1.7, 50.27, 0, 3.6);
    decor.stencil('sten3', 5.2, 1.4, 7.24, 0, 1.0);
    decor.stencil('sten5', 16, 1.3, 29.24, 0, 1.4);
    decor.stencil('sten1', 4.02, 1.5, -30, Math.PI / 2, 2.2);
    // oil under the trucks, litter round the yard
    for (const [x, z] of [[20, -4], [33, -25], [20, -1]]) decor.decal('oil', 1.8, 2.4, x, world.groundHeight(x, z) + 0.02, z, decor.r(0, 6.28), { tiltX: -Math.PI / 2 });
    decor.litter({ minX: -48, maxX: 48, minZ: -48, maxZ: 48 }, 260);
    decor.finish();

    // ---------------------------------------------------- nature
    const area = { minX: -112, maxX: 112, minZ: -112, maxZ: 112 };
    // Grass is looks-only and its amount follows the graphics preset, so it uses
    // decoRand, not rand (see main.js): the trees and rocks after it stay put.
    const grass = new Grass(scene, {
      terrain, area, rand: decoRand, count: Math.round(45000 * quality.grass), density: grassDensity, height: [0.25, 0.7],
      colors: [0xa89868, 0x9a8858, 0x8c8a58, 0xb0a070, 0x7e7a48],
    });

    const trees = [];
    let guard = 0;
    while (trees.length < 230 && guard++ < 6000) {
      const a = rand() * Math.PI * 2, r = 58 + Math.pow(rand(), 0.8) * 300;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.max(Math.abs(x), Math.abs(z)) < 58) continue;              // nothing inside the walls
      if (Math.abs(x) < 12 && Math.abs(z) > 45) continue;                 // keep the road clear
      if (Math.abs(x) < 30 && z > 50 && z < 105) continue;                // keep the start area open
      const near = Math.max(Math.abs(x), Math.abs(z)) < 112;
      if (near && rand() > 0.35) continue;                                // sparse inside the play area
      const big = rand() < 0.4;
      trees.push({ x, z, s: big ? 0.38 + rand() * 0.2 : 0.5 + rand() * 0.35, variant: (near ? 0 : 2) + (big ? 1 : 0) });
    }
    const forest = new Forest(scene, world, terrain, [
      { preset: 'Oak Small', seed: 11, leafTint: 0xb8b880 },
      { preset: 'Oak Medium', seed: 5, leafTint: 0xa8a870 },
      { preset: 'Oak Small', seed: 23, leafTint: 0xb8b880, far: true },
      { preset: 'Oak Medium', seed: 9, leafTint: 0xa8a870, far: true },
    ], trees, { leafShadows: quality.leafShadows });

    const rocks = [];
    for (let i = 0; i < 70; i++) {
      const x = (rand() - 0.5) * 220, z = (rand() - 0.5) * 220;
      if (Math.max(Math.abs(x), Math.abs(z)) < 56 || roadW(x, z) > 0 || Math.abs(x) < 8) continue;
      rocks.push({ x, z, s: 0.5 + Math.pow(rand(), 2) * 2.2, sy: 0.6 + rand() * 0.4, variant: i });
    }
    for (const [x, z, s] of [[-20, 72, 1.5], [15, 84, 1.3], [30, 66, 1.8], [-36, 60, 1.4], [46, 78, 1.6], [-10, 92, 1.2], [8, 104, 1.6], [-48, 88, 2.0]]) {
      rocks.push({ x, z, s, sy: 0.75, variant: Math.round(x) });
    }
    placeRocks(scene, world, terrain, M.rock, rocks);

    // Invisible walls at the edge of the playable area
    const B = 114, H = 200;
    world.add(V(-B - 5, -50, -B - 5), V(B + 5, H, -B), { solid: false });
    world.add(V(-B - 5, -50, B), V(B + 5, H, B + 5), { solid: false });
    world.add(V(-B - 5, -50, -B), V(-B, H, B), { solid: false });
    world.add(V(B, -50, -B), V(B + 5, H, B), { solid: false });

    return {
      playerSpawn: { pos: V(0, 0, 76), yaw: 0 },
      enemySpawns: [
        { pos: towerSE.clone(), role: 'sentry', keepY: true },
        { pos: towerNW.clone(), role: 'sentry', keepY: true },
        { pos: V(0, 0, 39.6), role: 'guard' },
        { pos: V(-12, 0, 22), role: 'patrol' },
        { pos: V(16, 0, -8), role: 'patrol' },
        { pos: V(-38, 0, -5), role: 'guard' },
        { pos: V(-10, 0, -31), role: 'guard' },
        { pos: V(32, 0, -20), role: 'patrol' },
        { pos: V(-24, 0, 8), role: 'patrol' },
        { pos: V(1, 3.4, -31), role: 'sentry', keepY: true },
        { pos: V(20, 0, 22), role: 'guard' },
        { pos: V(-8, 0, 12.5), role: 'guard' },
      ],
      assaultSpawns: [V(0, 0, -80), V(-15, 0, -86), V(15, 0, -82), V(80, 0, 10), V(86, 0, -4), V(-80, 0, -20), V(-70, 0, -70)],
      patrolPoints: [V(0, 0, 25), V(-12, 0, 20), V(-16, 0, 4), V(0, 0, -10), V(15, 0, -10), V(18, 0, 12), V(10, 0, 32),
        V(-28, 0, -2), V(-25, 0, -36), V(14, 0, -42), V(36, 0, -6), V(34, 0, 24), V(-34, 0, 26), V(0, 0, -44), V(-3, 0, -30), V(-38, 0, 8), V(33, 0, -29)],
      ammoCrates,
      coverPoints: () => computeCoverPoints(world),
      concealAt: grassDensity,
      animated: [grass, forest],
      update: (t, cam) => { grass.update(t, cam); forest.update(t, cam); for (const f of b.animated) f(t); },
    };
  },
};

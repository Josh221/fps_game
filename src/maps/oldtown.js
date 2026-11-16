// =============================================================================
// maps/oldtown.js — "OLD TOWN": close-quarters fighting in a small town at
// golden hour. Houses line a main street and a cross street around a market
// plaza; some are two storeys with stairs, some are ruins. Enemies hold a
// checkpoint, the plaza, buildings and rooftops.
//
// The town is GENERATED from a few rules (row of houses along each street,
// random widths/floors/materials) rather than placed by hand — the same idea
// as procedural city tools (e.g. Houdini, CityEngine) at a tiny scale.
// =============================================================================
import * as THREE from 'three';
import { makeNoise, fbm, applyFlats } from '../terrain.js';
import { Grass, Forest } from '../vegetation.js';
import { computeCoverPoints } from '../builder.js';
import { Decor } from '../decor.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const noise = makeNoise(777);

const STREET = 5, SETBACK = 6.6;
const FLATS = [{ x: 0, z: 0, w: 190, d: 230, h: 0, blend: 40 }];

function height(x, z) {
  const r = Math.hypot(x, z);
  let h = fbm(noise, x * 0.006, z * 0.006, 5) * 10;
  h += Math.max(0, fbm(noise, x * 0.004 + 9, z * 0.004, 4)) * 40 * smooth(140, 320, r);
  return applyFlats(h, x, z, FLATS);
}

const isMain = (x, z) => Math.abs(x) < STREET && Math.abs(z) < 125;
const isCross = (x, z) => Math.abs(z) < STREET && Math.abs(x) < 100;
const isPlaza = (x, z) => Math.abs(x) < 16 && Math.abs(z) < 16;
const isWalk = (x, z) => (Math.abs(x) < SETBACK && Math.abs(z) < 125) || (Math.abs(z) < SETBACK && Math.abs(x) < 100);

function splat(x, z) {
  const road = isMain(x, z) || isCross(x, z) ? 1 : 0;
  const cobble = isPlaza(x, z) || (isWalk(x, z) && !road) ? 1 : 0;
  return [1, road * 4 * (1 - cobble), cobble * 4];
}

export default {
  id: 'oldtown',
  name: 'OLD TOWN',
  blurb: 'Street fight through a small town at golden hour. Rooftops, alleys, ruins.',
  sky: { hdri: 'qwantani_late_afternoon_puresky', exposure: 1.0, sunScale: 1.1, envIntensity: 0.9, fogDensity: 0.0028, groundColor: 0x6a5e52 },
  grade: { saturation: 1.0, contrast: 1.1, tint: 0xfff0e0 },
  soldierTint: 0xb0aca0,
  terrain: {
    layers: [['dry_ground_01', 4], ['asphalt_02', 4], ['cobblestone_floor_03', 2.4]],
    surfaces: ['dirt', 'asphalt', 'concrete'],
    height, splat,
  },
  materials: {
    plaster: [
      ['beige_wall_001', { surface: 'concrete', color: 0xf2e6d2 }],
      ['clay_plaster', { surface: 'concrete', color: 0xf0dcc0 }],
      ['damaged_plaster', { surface: 'concrete' }],
      ['brick_wall_005', { surface: 'concrete', tile: 1.6 }],
      ['beige_wall_001', { surface: 'concrete', color: 0xd8cbb8 }],
    ],
    wall: ['beige_wall_001', { surface: 'concrete' }],
    floor: ['concrete_floor_worn_001', { surface: 'concrete' }],
    roof: ['brushed_concrete', { surface: 'concrete', color: 0xb8b0a4 }],
    concrete: ['brushed_concrete', { surface: 'concrete' }],
    plinth: ['concrete_floor_worn_001', { color: 0x5e584e }],
    band: ['clay_plaster', { surface: 'concrete', color: 0xfff4e6 }],       // pale stone: bands, copings, kerbs, balconies
    tiles: ['roof_07', { surface: 'concrete', color: 0xe8b090 }],             // clay roof tiles (pitched roofs)
    trim: ['brown_planks_05', { surface: 'wood', tile: 1.5, color: 0x8a7458 }],
    wood: ['brown_planks_05', { surface: 'wood', tile: 1.2 }],
    metal: ['rusty_metal_02', { surface: 'metal', tile: 1.2 }],
    roofMetal: ['corrugated_iron_02', { surface: 'metal' }],
    canvas: ['hessian_230', { surface: 'cloth', color: 0xb07a50, tile: 0.8, side: THREE.DoubleSide }],
    canvas2: ['hessian_230', { surface: 'cloth', color: 0x5a7a8a, tile: 0.8, side: THREE.DoubleSide }],
    containers: [['container_side', { map: null, color: 0x7a3a2a, surface: 'metal', tile: 2.4 }]],
  },
  props: ['cement_bag', 'wooden_military_crate', 'wooden_crate_02', 'ammo_box', 'medical_box', 'Barrel_01', 'barrel_03', 'covered_car',
    'concrete_road_barrier_02', 'plastic_crate_03', 'cardboard_box_01', 'exterior_aircon_unit', 'propane_tank', 'old_tyre'],
  navBounds: { minX: -100, maxX: 100, minZ: -115, maxZ: 115 },
  testViews: [[0, 0, 78, 0, 0.02], [0, 0, 22, 0.3, 0], [10, 0, -8, 2.2, 0], [-3, 0, -60, 3.1, 0.02], [30, 0, 1, 1.57, 0.02]],

  async build({ scene, world, terrain, builder: b, props: P, M, rand, decoRand, quality }) {
    const footprints = [];
    const roofSpots = [];
    const interiorSpots = [];

    // ---------------------------------------------------- houses
    const H = 3.1;
    function house(x0, z0, x1, z1, facing, opts = {}) {
      const floors = opts.floors ?? (rand() < 0.45 ? 2 : 1);
      const wall = M.plaster[(rand() * M.plaster.length) | 0];
      const w = x1 - x0, d = z1 - z0;
      const doors = { n: [], s: [], e: [], w: [] }, windows = { n: [], s: [], e: [], w: [] };
      const along = (side) => (side === 'n' || side === 's' ? [x0, x1] : [z0, z1]);
      const doorAt = {};
      for (const side of [facing, ...(rand() < 0.5 ? [{ n: 's', s: 'n', e: 'w', w: 'e' }[facing]] : [])]) {
        const [a, c] = along(side);
        doorAt[side] = (a + c) / 2 + (rand() - 0.5) * Math.max(0, c - a - 4);
        doors[side].push(doorAt[side]);
      }
      for (const side of ['n', 's', 'e', 'w']) {
        const [a, c] = along(side);
        for (let t = a + 1.6; t < c - 1.2; t += 2.6 + rand() * 0.8) {
          if (doorAt[side] !== undefined && Math.abs(t - doorAt[side]) < 1.6) continue;
          if (rand() < 0.85) windows[side].push(t);
        }
      }
      // Stairs run along x by the north wall (or south wall if the door is on the north)
      let stairs;
      if (floors > 1) {
        const sz = facing === 'n' || doorAt.n !== undefined ? z1 - 0.3 - 0.75 : z0 + 0.3 + 0.75;
        stairs = { x: x0 + 0.6, z: sz, dir: 'x' };
        for (const side of ['n', 's']) windows[side] = windows[side].filter((t) => t > x0 + 5.6); // keep the stair wall clear at ground level
      }
      // Roof access: every two-storey house gets a ladder (so any rooftop
      // sentry can be reached), and about a third of the one-storey ones. It
      // runs up the alley-side wall a metre from the street corner, where you
      // can spot it from the street. That side also keeps the rooftop water
      // tank and AC unit (below) off the landing. Chosen by a hash of the
      // position rather than rand(), so the rest of the town is unchanged.
      const hash = (Math.imul(Math.round(x0 * 10), 73856093) ^ Math.imul(Math.round(z0 * 10), 19349663)) >>> 0;
      let ladder;
      if (!opts.ruined && (floors === 2 || hash % 100 < 35)) {
        const [side, at] = { w: ['n', x0 + 1.0], e: ['s', x1 - 1.0], n: ['w', z0 + 1.0], s: ['e', z1 - 1.0] }[facing];
        ladder = { side, at };
        windows[side] = windows[side].filter((t) => Math.abs(t - at) > 1.35); // no window behind the ladder
      }
      // About half the one-storey houses without a ladder get a pitched clay
      // tile roof (built by decor.js). Same hash trick: no rand() is used.
      const pitched = !opts.ruined && floors === 1 && !ladder && (hash >>> 8) % 100 < 55;
      const ruined = opts.ruined;
      b.building({
        x0, x1, z0, z1, h: H, floors, wall, doors, windows, stairs, ladder, pitched, roof: !ruined,
        wallHeights: ruined ? { n: 1.2 + rand() * 2, s: 2 + rand() * 1.5, e: 0.8 + rand() * 2.2, w: 1.5 + rand() * 1.8 } : undefined,
      });
      footprints.push([x0 - 0.3, z0 - 0.3, x1 + 0.3, z1 + 0.3]);
      if (ruined) { b.rubble((x0 + x1) / 2, (z0 + z1) / 2, 14); return; }
      if (floors === 2) roofSpots.push(V((x0 + x1) / 2 + (rand() - 0.5) * 2, floors * H + 0.05, (z0 + z1) / 2 + (rand() - 0.5) * 2));
      interiorSpots.push(V(x0 + w * 0.6, 0, z0 + d * 0.5));
      // rooftop clutter: water tank, AC unit
      const top = floors * H;
      // (a pitched roof has no flat top for them, but rand() is still called
      // the same number of times so the houses after this one don't move)
      if (rand() < 0.6 && !pitched) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 1.1, 16), M.metal);
        tank.position.set(x0 + 1.2, top + 0.55, z1 - 1.2);
        b.add(tank);
        world.add(V(x0 + 0.65, top, z1 - 1.75), V(x0 + 1.75, top + 1.1, z1 - 0.65), { surface: 'metal', pen: 0.5 });
      }
      if (rand() < 0.5) {
        const rotY = rand() < 0.5 ? 0 : Math.PI;
        if (!pitched) P.add('exterior_aircon_unit', x1 - 1.4, z0 + 1.2, { y: top, rotY, surface: 'metal', scale: 0.8 });
      }
    }

    // Rows of houses along both sides of a street. axis 'z' = main street.
    function row(axis, side, from, to) {
      let t = from;
      while (t < to - 7) {
        const w = Math.min(to - t, 8 + rand() * 5), d = 8 + rand() * 3.5;
        const ruined = rand() < 0.1;
        if (axis === 'z') {
          const x0 = side > 0 ? SETBACK : -SETBACK - d;
          house(x0, t, x0 + d, t + w, side > 0 ? 'w' : 'e', { ruined });
        } else {
          const z0 = side > 0 ? SETBACK : -SETBACK - d;
          house(t, z0, t + w, z0 + d, side > 0 ? 'n' : 's', { ruined });
        }
        t += w + 2 + rand() * 3.5; // alley
      }
    }
    for (const s of [-1, 1]) {
      row('z', s, -104, -19);
      row('z', s, 19, 88);
      row('x', s, -92, -23);
      row('x', s, 23, 92);
    }

    // ---------------------------------------------------- plaza: fountain + market
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 2.8, 0.7, 28), M.concrete);
    basin.position.set(0, 0.35, 0);
    b.add(basin);
    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 2.2, 14), M.concrete);
    column.position.set(0, 1.1, 0);
    b.add(column);
    world.add(V(-2.6, 0, -2.6), V(2.6, 0.7, 2.6), { cover: true, surface: 'concrete', shape: [{ geometry: basin.geometry, matrix: new THREE.Matrix4().makeTranslation(0, 0.35, 0) }] }); // round, for bullets
    world.add(V(-0.4, 0, -0.4), V(0.4, 2.2, 0.4), { surface: 'concrete' });

    const stall = (x, z, rot, cloth) => {
      const along = rot === 0;
      const W = 3, D = 2;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const px = x + (along ? sx * W / 2 : sz * D / 2), pz = z + (along ? sz * D / 2 : sx * W / 2);
        b.box(px, 0, pz, 0.07, 2.3, 0.07, M.metal, { collide: false });
      }
      b.box(x, 2.3, z, along ? W + 0.4 : D + 0.4, 0.04, along ? D + 0.4 : W + 0.4, cloth, { collide: false });
      b.box(x, 0, z, along ? W - 0.2 : 0.9, 0.9, along ? 0.9 : W - 0.2, M.wood, { cover: true, pen: 0.4, surface: 'wood' });
      P.add('plastic_crate_03', x + (along ? 0.6 : 0.2), z + (along ? 0.1 : 0.6), { y: 0.9, rotY: rand(), collide: false });
      P.add('cardboard_box_01', x - (along ? 0.7 : 0.1), z - (along ? 0.1 : 0.7), { y: 0.9, rotY: rand(), collide: false });
      P.add('plastic_crate_03', x + (along ? 1.0 : -1.4), z + (along ? 1.4 : 1.0), { rotY: rand(), surface: 'wood', cover: false });
    };
    stall(-9, -11, 0, M.canvas); stall(-3, -11.5, 0, M.canvas2); stall(9, 11, 0, M.canvas); stall(10.5, -4, 1, M.canvas2); stall(-10.5, 6, 1, M.canvas);

    // ---------------------------------------------------- street furniture: cars, poles + wires, barriers
    for (let i = 0; i < 16; i++) {
      const s = rand() < 0.5 ? -1 : 1;
      let z = -100 + rand() * 185;
      if (Math.abs(z) < 22) z += 30 * Math.sign(z || 1);
      P.add('covered_car', s * 3.5, z, { rotY: (s > 0 ? 0 : Math.PI) + (rand() - 0.5) * 0.15, cover: false, pen: 0.6, surface: 'metal' });
    }
    for (let i = 0; i < 6; i++) {
      const s = rand() < 0.5 ? -1 : 1, x = (rand() < 0.5 ? -1 : 1) * (28 + rand() * 55);
      P.add('covered_car', x, s * 3.4, { rotY: Math.PI / 2 + (s > 0 ? 0 : Math.PI), pen: 0.6, surface: 'metal' });
    }
    // wooden power poles with sagging wires (a catenary-ish curve between poles)
    const wireMat = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
    let prev = null;
    for (let z = -104; z <= 92; z += 15) {
      if (Math.abs(z) < 14) { prev = null; continue; }
      const x = 5.9;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 8.5, 8), M.wood);
      pole.position.set(x, 4.25, z);
      b.add(pole);
      b.box(x, 7.6, z, 1.6, 0.1, 0.12, M.wood, { collide: false }); // crossbar
      world.add(V(x - 0.15, 0, z - 0.15), V(x + 0.15, 8.5, z + 0.15), { surface: 'wood' });
      if (prev !== null) {
        for (const off of [-0.7, 0, 0.7]) {
          const pts = [];
          for (let k = 0; k <= 12; k++) {
            const t = k / 12;
            pts.push(V(x + off, 7.7 - Math.sin(t * Math.PI) * 0.55, prev + (z - prev) * t));
          }
          scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireMat));
        }
      }
      prev = z;
    }

    // Enemy checkpoint on the main street + plaza positions
    for (const [x0, z0, x1, z1] of [[-4.5, 70, -0.5, 70], [1, 73, 4.5, 73], [-4.6, 70, -4.6, 72.5], [-6, 16.5, -1, 16.5], [2, 17, 7, 17],
      [-17, -6, -17, -1], [16.8, 2, 16.8, 7], [-4, -70, 4, -70], [-16, 16, -12, 16]]) {
      P.sandbags(x0, z0, x1, z1, { layers: 6 });
    }
    for (const [x, z, r] of [[-2.5, 64, 0], [2.6, 61, 0], [-1, -64, 0], [3.5, -76, 0.3], [0, 98, 0], [-3.4, 92, 0.2]]) {
      P.add('concrete_road_barrier_02', x, z, { rotY: r, cover: true, surface: 'concrete' });
    }
    for (const [x, z, id] of [[4.2, 68, 'Barrel_01'], [-4.4, 74.5, 'barrel_03'], [12, -14, 'Barrel_01'], [-13, 13, 'barrel_03'], [6, 58, 'Barrel_01']]) {
      P.add(id, x, z, { rotY: rand() * 6, cover: true, pen: 0.5, surface: 'metal' });
    }
    for (const [x, z] of [[4.5, 80], [4.7, 80.6], [-14.5, -14]]) P.add('old_tyre', x, z, { rotY: rand(), collide: false });

    const ammo = (x, z) => {
      P.add('wooden_military_crate', x, z, { cover: true, pen: 0.45 });
      P.add('ammo_box', x - 0.25, z, { y: 0.46, rotY: 0.2, collide: false });
      P.add('ammo_box', x + 0.2, z, { y: 0.46, rotY: -0.3, collide: false });
      P.add('medical_box', x, z - 0.12, { y: 0.46, rotY: 1.6, collide: false });
      return V(x, 0, z);
    };
    const ammoCrates = [ammo(-3.6, 100), ammo(13.5, -13.5)];

    // ---------------------------------------------------- set dressing (decor.js)
    // Doors, shutters, curtains, furniture, shop fronts, balconies, tiled
    // roofs, signs, kerbs, road paint, bins, litter... Decor has its own seeded
    // random stream, so all of this is identical for every co-op player and
    // doesn't shift the trees placed below.
    const decor = new Decor({ scene, world, builder: b, props: P, M, seed: 4711 });
    await decor.load(['home', 'street']);
    for (const d of b.buildings) {
      // which wall faces the street (houses sit SETBACK metres from the centre line)
      const front = Math.abs(d.x0 - SETBACK) < 0.01 ? 'w' : Math.abs(d.x1 + SETBACK) < 0.01 ? 'e' : Math.abs(d.z0 - SETBACK) < 0.01 ? 'n' : 's';
      const central = Math.abs((d.x0 + d.x1) / 2) < 60 && Math.abs((d.z0 + d.z1) / 2) < 70;
      const shop = !d.ruined && decor.chance(central ? 0.45 : 0.15);
      decor.building(d, {
        front, shop, shutters: decor.chance(0.55),
        balcony: d.floors > 1 && decor.chance(0.45),
        pitched: d.pitched,
        rooms: [shop ? 'shop' : 'living', 'bedroom'],
      });
      if (d.ruined) continue;
      // bins in the alley beside the house (on the side without the ladder)
      const alley = { w: ['n', 's'], e: ['s', 'n'], n: ['w', 'e'], s: ['e', 'w'] }[front];
      const side = d.ladder?.side === alley[0] ? alley[1] : alley[0];
      if (decor.chance(0.35)) {
        const a = { w: d.x0 + 1.7, e: d.x1 - 1.7, n: d.z0 + 1.7, s: d.z1 - 1.7 }[front];
        const [x, z] = side === 'n' ? [a, d.z0 - 0.4] : side === 's' ? [a, d.z1 + 0.4] : side === 'w' ? [d.x0 - 0.4, a] : [d.x1 + 0.4, a];
        decor.trash(x, z, { n: Math.PI, s: 0, w: -Math.PI / 2, e: Math.PI / 2 }[side]);
      }
      if (decor.chance(0.12)) decor.againstWall(d, front, 'utility_box_01', 0.55, 0.45, { surface: 'metal', pen: 0.3 });
    }

    // streets: kerbs, centre lines, zebra crossings, manholes, lamps, signs
    for (const s of [-1, 1]) {
      decor.kerb(s * STREET, -122, s * STREET, -16.5); decor.kerb(s * STREET, 16.5, s * STREET, 122);
      decor.kerb(-100, s * STREET, -16.5, s * STREET); decor.kerb(16.5, s * STREET, 100, s * STREET);
      decor.roadDashes(0, s * 18.5, 0, s * 121);
      decor.roadDashes(s * 18.5, 0, s * 99, 0);
      decor.zebra(0, s * 20.6, false, 9);
      decor.zebra(s * 20.6, 0, true, 9);
    }
    for (const [x, z] of [[1.6, -95], [-1.6, -46], [1.6, 44], [-1.4, 84], [-60, 1.5], [55, -1.5], [-86, -1.4]]) P.add('water_manhole_cover', x, z, { collide: false });
    for (let z = -100; z <= 92; z += 24) if (Math.abs(z) > 22) decor.streetLamp(-5.55, z, Math.PI / 2);
    for (let x = -90; x <= 90; x += 22) if (Math.abs(x) > 22) decor.streetLamp(x, -5.55, 0);
    decor.roadSign(4.6, 23, 0, 'stop');
    decor.roadSign(-4.6, -23, Math.PI, 'arrow');
    decor.roadSign(23, -4.6, Math.PI / 2, 'noentry');
    decor.roadSign(-23, 4.6, -Math.PI / 2, 'stop');
    decor.roadSign(4.6, 86, 0, 'warn');
    decor.oilUnder('covered_car');
    decor.litter({ minX: -100, maxX: 100, minZ: -122, maxZ: 122 }, 2600, (x, z) => isWalk(x, z) || isPlaza(x, z));

    // the plaza: water in the fountain, benches round it, a cafe's tables
    decor.water(0, 0.712, 0, 2.38);
    for (const [x, z, r] of [[0, 7, Math.PI], [0, -7, 0], [7, 0, -Math.PI / 2], [-7, 0, Math.PI / 2]]) {
      if (!decor.blocked(x - 0.7, 0.1, z - 0.7, x + 0.7, 1, z + 0.7)) P.add('painted_wooden_bench', x, z, { rotY: r, cover: true, pen: 0.4, surface: 'wood' });
    }
    for (const [x, z] of [[-6.5, 10], [-4.2, 11.6], [6.2, -9.5], [3.8, -8.4]]) {
      if (!decor.blocked(x - 0.6, 0.1, z - 1, x + 0.6, 1, z + 1)) P.add('outdoor_table_chair_set_01', x, z, { rotY: decor.r(0, 6.28), collide: false });
    }
    decor.finish();

    // ---------------------------------------------------- greenery
    const inFootprint = (x, z) => footprints.some((f) => x > f[0] && x < f[2] && z > f[1] && z < f[3]);
    const density = (x, z) => {
      if (isWalk(x, z) || isPlaza(x, z) || inFootprint(x, z)) return 0;
      const town = Math.abs(x) < 95 && Math.abs(z) < 108;
      return (town ? 0.25 : 0.7) * smooth(-0.3, 0.4, noise(x * 0.05, z * 0.05));
    };
    // Grass is looks-only and its amount follows the graphics preset, so it uses
    // decoRand, not rand (see main.js): the trees and rocks after it stay put.
    const grass = new Grass(scene, {
      terrain, area: { minX: -112, maxX: 112, minZ: -118, maxZ: 118 }, rand: decoRand, count: Math.round(30000 * quality.grass), density, height: [0.25, 0.6],
      colors: [0x8a8a50, 0x9a9258, 0x7a7a48, 0xa09a60],
    });
    const trees = [];
    for (const [x, z] of [[-13, -14.5], [14, 14.5], [13.5, -14.5], [-14, 14]]) trees.push({ x, z, s: 0.35, variant: 0 });
    let guard = 0;
    while (trees.length < 260 && guard++ < 8000) {
      const x = (rand() - 0.5) * 700, z = (rand() - 0.5) * 700;
      const near = Math.abs(x) < 115 && Math.abs(z) < 120;
      if (near && (isWalk(x, z) || inFootprint(x, z) || Math.abs(x) < 95 && Math.abs(z) < 108)) continue;
      trees.push({ x, z, s: 0.4 + rand() * 0.35, variant: near ? 1 : 2 });
    }
    const forest = new Forest(scene, world, terrain, [
      { preset: 'Oak Small', seed: 31, leafTint: 0xc8d090 },
      { preset: 'Oak Medium', seed: 12, leafTint: 0xc0c888 },
      { preset: 'Oak Medium', seed: 5, leafTint: 0xb8c080, far: true },
    ], trees, { leafShadows: quality.leafShadows });

    const Bd = 114, Ht = 200;
    world.add(V(-Bd - 5, -50, -122), V(Bd + 5, Ht, -117), { solid: false });
    world.add(V(-Bd - 5, -50, 117), V(Bd + 5, Ht, 122), { solid: false });
    world.add(V(-Bd - 5, -50, -117), V(-Bd, Ht, 117), { solid: false });
    world.add(V(Bd, -50, -117), V(Bd + 5, Ht, 117), { solid: false });

    // ---------------------------------------------------- enemies
    const shuffled = (a) => a.map((v) => [rand(), v]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
    const roofs = shuffled(roofSpots).slice(0, 3).map((p) => ({ pos: p, role: 'sentry', keepY: true }));
    const insides = shuffled(interiorSpots.filter((p) => p.z < 60)).slice(0, 3).map((p) => ({ pos: p, role: 'guard' }));
    return {
      objective: 'CLEAR THE TOWN',
      playerSpawn: { pos: V(0, 0, 104), yaw: 0 },
      enemySpawns: [
        { pos: V(-2.5, 0, 69), role: 'guard' },
        { pos: V(2.6, 0, 72), role: 'guard' },
        ...roofs.slice(0, 1),
        { pos: V(-3, 0, 15.5), role: 'guard' },
        { pos: V(0, 0, 40), role: 'patrol' },
        ...insides.slice(0, 1),
        { pos: V(12, 0, -2), role: 'patrol' },
        ...roofs.slice(1),
        ...insides.slice(1),
        { pos: V(-18, 0, -3), role: 'guard' },
        { pos: V(0, 0, -69), role: 'guard' },
      ],
      assaultSpawns: [V(0, 0, -108), V(-85, 0, 0), V(85, 0, 0), V(-60, 0, -100), V(60, 0, -100), V(0, 0, -95)],
      // Every point must be somewhere a soldier can stand: (0, 4.5) is the north
      // rim of the fountain (its basin fills ±2.6 m round the plaza centre), and
      // (0, 25) is the street's centre line, clear of the cars parked at x = ±3.5.
      patrolPoints: [V(0, 0, 40), V(0, 0, 4.5), V(12, 0, -2), V(-12, 0, 2), V(0, 0, -40), V(40, 0, 0), V(-40, 0, 0), V(0, 0, 60),
        V(0, 0, -80), V(70, 0, 0), V(-70, 0, 0), V(0, 0, 25)],
      ammoCrates,
      coverPoints: () => computeCoverPoints(world),
      concealAt: (x, z) => density(x, z) * 0.5,
      update: (t, cam) => { grass.update(t, cam); forest.update(t, cam); for (const f of b.animated) f(t); },
    };
  },
};

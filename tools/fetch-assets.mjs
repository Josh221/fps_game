// =============================================================================
// tools/fetch-assets.mjs — downloads the game's art assets.
//
//   node tools/fetch-assets.mjs
//
// Every asset comes from Poly Haven (https://polyhaven.com), which publishes
// photo-scanned textures, models and HDR skies under CC0: free for any use,
// no attribution required (we credit them anyway in assets/CREDITS.md).
//
// Real studios have an "asset pipeline" like this: a manifest of what the game
// needs, and a script that fetches/converts it, so nobody commits 100 MB of
// binaries by hand and anyone can rebuild the asset folder from scratch.
// =============================================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCharacters } from './fetch-characters.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const API = 'https://api.polyhaven.com';
const UA = { 'User-Agent': 'operation-dustline-asset-fetch' };

// --- Manifest -----------------------------------------------------------------
// PBR texture sets: colour (diff), normal (nor_gl), and ARM = AO/Roughness/Metal packed in R/G/B
export const TEXTURES = {
  // terrain
  dry_ground_01: '2k', coast_sand_01: '2k', aerial_rocks_02: '2k', sparse_grass: '2k',
  forrest_ground_01: '2k', brown_mud_leaves_01: '2k', leafy_grass: '2k', gravel_road: '2k',
  rocky_terrain_02: '2k', dry_ground_rocks: '2k',
  // structures
  concrete_slab_wall: '1k', brushed_concrete: '1k', concrete_floor_worn_001: '1k',
  clay_plaster: '1k', damaged_plaster: '1k', beige_wall_001: '1k', brick_wall_005: '1k',
  container_side: '1k', corrugated_iron_02: '1k', brown_planks_05: '1k', bark_brown_02: '1k',
  green_metal_rust: '1k', rusty_metal_02: '1k', roof_07: '1k', asphalt_02: '1k',
  cobblestone_floor_03: '1k', metal_plate: '1k', hessian_230: '1k', cliff_side: '1k',
};

// glTF models (crates, barrels, sandbags, vehicles, a real pistol...)
export const MODELS = {
  wooden_military_crate: '1k', wooden_crate_02: '1k', ammo_box: '1k', medical_box: '1k',
  Barrel_01: '1k', Barrel_02: '1k', barrel_03: '1k', metal_jerrycan_green: '1k',
  portable_generator: '1k', old_tyre: '1k', propane_tank: '1k', cement_bag: '1k',
  concrete_road_barrier_02: '1k', covered_car: '1k', cardboard_box_01: '1k',
  plastic_crate_03: '1k', exterior_aircon_unit: '1k', tree_stump_01: '1k',
  dead_tree_trunk: '1k', namaqualand_boulder_05: '1k',
  service_pistol: '2k', bolt_action_rifle_7_62: '2k',
  // set dressing (decor.js): furniture and home clutter for house interiors...
  painted_wooden_table: '1k', painted_wooden_chair_01: '1k', painted_wooden_chair_02: '1k',
  painted_wooden_cabinet: '1k', painted_wooden_cabinet_02: '1k', painted_wooden_shelves: '1k',
  painted_wooden_sofa: '1k', painted_wooden_nightstand: '1k', painted_wooden_stool: '1k',
  painted_wooden_bench: '1k', vintage_day_bed: '1k', WoodenTable_01: '1k', sofa_02: '1k',
  Television_01: '1k', potted_plant_04: '1k', Shelf_01: '1k',
  fancy_picture_frame_01: '1k', wall_clock: '1k',
  plastic_monobloc_chair_01: '1k',
  // ...streets...
  metal_trash_can: '1k', trashbag: '1k', utility_box_01: '1k',
  water_manhole_cover: '1k', planter_pot_clay: '1k', outdoor_table_chair_set_01: '1k',
  // ...and military camps
  steel_frame_shelves_01: '1k', metal_office_desk: '1k', security_light: '1k', worn_metal_rack: '1k',
  barrel_stove: '1k', stone_fire_pit: '1k', wooden_picnic_table: '1k',
};

// Sky-only HDR environments: they light the whole scene and form the sky
export const HDRIS = {
  kloofendal_48d_partly_cloudy_puresky: '2k', // Dustline: hot, clear midday
  kloofendal_misty_morning_puresky: '2k',     // Pinewood: misty forest morning
  qwantani_late_afternoon_puresky: '2k',      // Old Town: golden hour
};

// Non-Poly Haven files (the soldiers come from tools/fetch-characters.mjs)
export const EXTRA = {};

// --- Downloader -----------------------------------------------------------------
async function json(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function download(url, dest) {
  if (await exists(dest)) return 'cached';
  await fs.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) throw new Error(`${r.status}`);
      await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
      return 'ok';
    } catch (e) {
      if (attempt === 3) throw new Error(`${url}: ${e.message}`);
    }
  }
}

// Run tasks with limited parallelism
async function pool(tasks, n = 6) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < tasks.length) { const t = tasks[i++]; results.push(await t()); }
  }));
  return results;
}

async function main() {
  const credits = [];
  const jobs = [];

  for (const [id, res] of Object.entries(TEXTURES)) {
    const [files, info] = await Promise.all([json(`${API}/files/${id}`), json(`${API}/info/${id}`)]);
    const dir = path.join(ROOT, 'textures', id);
    const pick = (key) => files[key]?.[res]?.jpg?.url;
    for (const [key, name] of [['Diffuse', 'diff.jpg'], ['nor_gl', 'normal.jpg'], ['arm', 'arm.jpg']]) {
      const url = pick(key);
      if (url) jobs.push(() => download(url, path.join(dir, name)));
    }
    // real-world size in metres, so the game can tile the texture at true scale
    const meta = { name: info.name, size: (info.dimensions || [2000, 2000]).slice(0, 2).map((v) => v / 1000) };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
    credits.push(`- Texture **${info.name}** — https://polyhaven.com/a/${id} (CC0)`);
  }

  for (const [id, res] of Object.entries(MODELS)) {
    const [files, info] = await Promise.all([json(`${API}/files/${id}`), json(`${API}/info/${id}`)]);
    const g = files.gltf?.[res]?.gltf;
    if (!g) { console.warn('no gltf for', id); continue; }
    const dir = path.join(ROOT, 'models', id);
    jobs.push(() => download(g.url, path.join(dir, `${id}.gltf`)));
    for (const [rel, f] of Object.entries(g.include || {})) jobs.push(() => download(f.url, path.join(dir, rel)));
    credits.push(`- Model **${info.name}** — https://polyhaven.com/a/${id} (CC0)`);
  }

  for (const [id, res] of Object.entries(HDRIS)) {
    const files = await json(`${API}/files/${id}`);
    const url = files.hdri?.[res]?.hdr?.url;
    jobs.push(() => download(url, path.join(ROOT, 'hdri', `${id}.hdr`)));
    credits.push(`- HDRI **${id}** — https://polyhaven.com/a/${id} (CC0)`);
  }

  for (const [rel, url] of Object.entries(EXTRA)) {
    jobs.push(() => download(url, path.join(ROOT, rel)));
  }
  credits.push('- Soldiers **Military_Male_01/03/04, Military_Female_01** and their animations — Microsoft Rocketbox avatar library (https://github.com/microsoft/Microsoft-Rocketbox), MIT licence: see assets/characters/rocketbox/LICENSE.md');
  credits.push('- Trees generated at runtime with **EZ-Tree** by Daniel Greenheck (MIT) — https://github.com/dgreenheck/ez-tree');

  console.log(`Downloading ${jobs.length} files...`);
  let done = 0;
  await pool(jobs.map((j) => async () => { const r = await j(); if (++done % 20 === 0) console.log(`  ${done}/${jobs.length}`); return r; }));

  console.log('Downloading the soldiers (Rocketbox)...');
  await fetchCharacters();
  await fs.writeFile(path.join(ROOT, 'CREDITS.md'), `# Asset credits\n\nAll Poly Haven assets are CC0 (public domain).\n\n${credits.join('\n')}\n`);
  console.log('Done. Assets are in', ROOT);
}

main().catch((e) => { console.error(e); process.exit(1); });

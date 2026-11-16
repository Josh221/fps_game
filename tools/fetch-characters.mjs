// =============================================================================
// tools/fetch-characters.mjs — downloads the soldiers and their animations.
//
//   node tools/fetch-characters.mjs        (npm run assets runs it too)
//
// The soldiers come from the Microsoft Rocketbox avatar library
// (https://github.com/microsoft/Microsoft-Rocketbox), released under the MIT
// licence: realistic, rigged human characters made by a professional studio,
// with a library of motion-captured animations on the SAME skeleton (a 3ds
// Max "Biped": bones named "Bip01 Pelvis", "Bip01 L UpperArm"...). Same
// skeleton means the animations play on every character with no retargeting.
//
// The originals ship as FBX models plus 2048 x 2048 uncompressed TGA textures
// (12 MB each, 15 per soldier). A browser game can't download that, so this is
// the CONVERT half of an asset pipeline: shrink every texture to 1024 x 1024
// and save it as a JPEG (~0.3 MB), using macOS's built-in `sips` tool, or as a
// PNG written by this script elsewhere. A manifest.json tells the game what's
// where (src/character.js).
// =============================================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'characters', 'rocketbox');
const RAW = 'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets';
const UA = { 'User-Agent': 'operation-dustline-asset-fetch' };
const SIZE = 1024;

// The soldiers in combat kit (helmet, plate carrier): [folder, texture prefix]
export const SOLDIERS = [
  ['Military_Male_01', 'sm002'],
  ['Military_Male_03', 'sm004'],
  ['Military_Male_04', 'sm005'],
  ['Military_Female_01', 'sf003'],
];
const PARTS = ['body', 'head', 'helmet', 'equipment'];
// Animations: "static" files play in place; "xy" files had their forward
// movement taken out (motion extraction), so a walk cycle walks on the spot
// and the game moves the soldier itself.
export const ANIMS = {
  idle: 'all_animations_max_motextr_static/m_idle_neutral_01.max.fbx',
  walk: 'all_animations_max_motextr_xy/m_walk_neutral_01.max.fbx',
  run: 'all_animations_max_motextr_xy/m_run_neutral_01.max.fbx',
  crouch: 'all_animations_max_motextr_static/m_crouch_idle.max.fbx',
};

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

async function download(url, dest) {
  if (await exists(dest)) return false;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
      return true;
    } catch (err) { if (i === 2) throw err; }
  }
}

// ---------------------------------------------------------------- texture conversion
const hasSips = (() => { try { execFileSync('sips', ['--help'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// TGA -> smaller JPEG (macOS) or PNG (anywhere). Returns the file name written.
async function convert(tga, outBase) {
  if (hasSips) {
    const out = `${outBase}.jpg`;
    if (!(await exists(out))) execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', '-Z', String(SIZE), tga, '--out', out], { stdio: 'ignore' });
    return path.basename(out);
  }
  const out = `${outBase}.png`;
  if (!(await exists(out))) await fs.writeFile(out, encodePNG(downscale(decodeTGA(await fs.readFile(tga)), SIZE)));
  return path.basename(out);
}

// An uncompressed or RLE 24/32-bit TGA -> { w, h, rgb } (top row first)
function decodeTGA(b) {
  const idLen = b[0], type = b[2], w = b.readUInt16LE(12), h = b.readUInt16LE(14), bpp = b[16] / 8, topFirst = (b[17] & 0x20) !== 0;
  const px = Buffer.alloc(w * h * bpp);
  let p = 18 + idLen;
  if (type === 2) b.copy(px, 0, p, p + px.length);
  else if (type === 10) { // run-length encoded
    for (let o = 0; o < px.length;) {
      const c = b[p++], n = (c & 0x7f) + 1;
      if (c & 0x80) { for (let k = 0; k < n; k++, o += bpp) b.copy(px, o, p, p + bpp); p += bpp; } else { b.copy(px, o, p, p + n * bpp); p += n * bpp; o += n * bpp; }
    }
  } else throw new Error(`TGA type ${type} not supported`);
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sy = topFirst ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (sy * w + x) * bpp, d = (y * w + x) * 3;
      rgb[d] = px[s + 2]; rgb[d + 1] = px[s + 1]; rgb[d + 2] = px[s]; // BGR -> RGB
    }
  }
  return { w, h, rgb };
}

// Box filter down to `size` (the textures are powers of two)
function downscale(img, size) {
  const k = Math.max(1, Math.round(img.w / size)), w = Math.floor(img.w / k), h = Math.floor(img.h / k);
  const rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += img.rgb[((y * k + j) * img.w + x * k + i) * 3 + c];
    rgb[(y * w + x) * 3 + c] = Math.round(s / (k * k));
  }
  return { w, h, rgb };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function encodePNG({ w, h, rgb }) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); // filter 0 per row
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- main
export async function fetchCharacters() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rocketbox-'));
  const manifest = { soldiers: [], anims: {}, licence: 'MIT (Microsoft Rocketbox)' };
  try {
    for (const [name, code] of SOLDIERS) {
      const dir = path.join(OUT, name);
      await fs.mkdir(dir, { recursive: true });
      console.log(`  ${name}`);
      await download(`${RAW}/Avatars/Professions/${name}/Export/${name}.fbx`, path.join(dir, `${name}.fbx`));
      const parts = {};
      for (const part of PARTS) {
        parts[part] = {};
        for (const [kind, file] of [['map', `${code}_${part}_color${part === 'head' ? '' : '_acu'}`], ['normal', `${code}_${part}_normal`]]) { // (clothing comes in ACU camo; the face doesn't)
          const tga = path.join(tmp, `${file}.tga`);
          const out = path.join(dir, file);
          if (!(await exists(`${out}.jpg`)) && !(await exists(`${out}.png`))) await download(`${RAW}/Avatars/Professions/${name}/Textures/${file}.tga`, tga);
          parts[part][kind] = await convert(tga, out);
          await fs.rm(tga, { force: true });
        }
      }
      manifest.soldiers.push({ name, code, fbx: `${name}/${name}.fbx`, dir: name, parts });
    }
    for (const [id, rel] of Object.entries(ANIMS)) {
      await download(`${RAW}/Animations/${rel}`, path.join(OUT, 'anims', `${id}.fbx`));
      manifest.anims[id] = `anims/${id}.fbx`;
    }
    await download('https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/LICENSE.md', path.join(OUT, 'LICENSE.md'));
    await fs.writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log('Downloading the Rocketbox soldiers and animations...');
  fetchCharacters().then(() => console.log('Done:', OUT), (e) => { console.error(e); process.exit(1); });
}

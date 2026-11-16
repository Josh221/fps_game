// =============================================================================
// textures.js — procedural (code-generated) textures: camo, decals, flashes.
//
// We have no art files, so every surface is *generated* from noise at startup.
// The same idea (procedural generation) is used by tools like Substance
// Designer. Each texture also produces a NORMAL MAP from its height values,
// which fakes small bumps so sunlight catches every pebble and sandbag seam.
// =============================================================================
import * as THREE from 'three';

// --- Seeded random number generator (same seed => same textures every run) ---
export function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Tileable value noise: wraps at `period` so textures repeat seamlessly ---
// (periodY lets the grid be finer in one direction: stretched noise that still tiles)
class TileNoise {
  constructor(seed, period, periodY = period) {
    this.period = period;
    this.periodY = periodY;
    const rnd = mulberry32(seed);
    this.v = new Float32Array(period * periodY);
    for (let i = 0; i < this.v.length; i++) this.v[i] = rnd();
  }
  sample(x, y) {
    const p = this.period, q = this.periodY;
    const xi = Math.floor(x), yi = Math.floor(y);
    const fx = x - xi, fy = y - yi;
    const x0 = ((xi % p) + p) % p, y0 = ((yi % q) + q) % q;
    const x1 = (x0 + 1) % p, y1 = (y0 + 1) % q;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = this.v[y0 * p + x0], b = this.v[y0 * p + x1];
    const c = this.v[y1 * p + x0], d = this.v[y1 * p + x1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  }
}

// Fractal Brownian motion: several noise octaves stacked (big blobs + fine detail).
// stretchY > 1 makes features that many times thinner vertically (tiger stripes).
function fbm(seed, baseFreq, octaves, stretchY = 1) {
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push(new TileNoise(seed + o * 101, baseFreq << o, (baseFreq * stretchY) << o));
  return (u, v) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (const n of layers) {
      sum += n.sample(u * n.period, v * n.periodY) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

const mix = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// Runs `fn(u, v, out)` for every pixel. out = [r, g, b, height] in 0..1.
function buildTexture(size, fn, normalStrength = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const height = normalStrength ? new Float32Array(size * size) : null;
  const out = [0, 0, 0, 0];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[3] = 0;
      fn(x / size, y / size, out);
      const i = (y * size + x) * 4;
      img.data[i] = Math.min(255, Math.max(0, out[0] * 255));
      img.data[i + 1] = Math.min(255, Math.max(0, out[1] * 255));
      img.data[i + 2] = Math.min(255, Math.max(0, out[2] * 255));
      img.data[i + 3] = 255;
      if (height) height[y * size + x] = out[3];
    }
  }
  ctx.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return { map, normalMap: height ? heightToNormal(height, size, normalStrength) : null };
}

// Sobel-style slope of the height field -> tangent-space normal map.
function heightToNormal(h, size, strength) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)], r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
      let nx = -(r - l) * strength, ny = (d - u) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas); // normal maps stay linear (no sRGB)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Camouflage: layered noise thresholds, each layer a paint colour.
export function camoTexture(seed, palette) { return patternTexture(seed, palette, 'blob'); }

// The same idea in different STYLES — only the way the noise is read changes:
//   'blob'    soft blobs (woodland, desert, multi-terrain, arctic)
//   'tiger'   noise 4x finer vertically -> long horizontal brush strokes
//   'digital' noise read on a coarse grid -> blocky "pixel" camo
// A one-colour palette gives plain cloth (just the weave). Used by paint.js
// for gun finishes, uniforms and gear.
export function patternTexture(seed, palette, style = 'blob') {
  const layers = palette.slice(1).map((_, i) => (style === 'tiger' ? fbm(seed + i * 17, 2, 4, 4) : fbm(seed + i * 17, 6, 4)));
  const cloth = fbm(seed + 99, 128, 1);
  const grid = 64; // digital: 64 "pixels" across the tile
  return buildTexture(256, (u, v, o) => {
    const su = style === 'digital' ? Math.floor(u * grid) / grid : u;
    const sv = style === 'digital' ? Math.floor(v * grid) / grid : v;
    let c = palette[0];
    layers.forEach((f, i) => { if (f(su, sv) > (style === 'tiger' && i === layers.length - 1 ? 0.6 : 0.55)) c = palette[i + 1]; });
    const w = 0.88 + cloth(u, v) * 0.18;
    o[0] = c[0] * w; o[1] = c[1] * w; o[2] = c[2] * w;
    o[3] = cloth(u, v) * 0.4;
  }, 1.5);
}

// Wood grain: the same stretched noise as tiger stripes, but much more
// stretched (long fibres), turned into growth rings with a sine wave.
export function woodTexture(seed) {
  const grain = fbm(seed, 2, 4, 8), fibre = fbm(seed + 7, 4, 3, 32);
  return buildTexture(256, (u, v, o) => {
    const f = fibre(u, v);
    const ring = 0.5 + 0.5 * Math.sin((grain(u, v) * 7 + f * 0.5) * Math.PI * 2);
    const t = ring * 0.65 + f * 0.35;
    o[0] = mix(0.19, 0.4, t); o[1] = mix(0.1, 0.23, t); o[2] = mix(0.05, 0.12, t); // dark to light walnut
    o[3] = t * 0.5;
  }, 0.8);
}

// ----------------------------------------------------------------------------
// Small sprite textures (drawn with the 2D canvas API)
// ----------------------------------------------------------------------------
export function makeBulletHoleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(8,8,8,1)');
  grad.addColorStop(0.25, 'rgba(25,22,20,0.95)');
  grad.addColorStop(0.5, 'rgba(60,55,50,0.45)');
  grad.addColorStop(1, 'rgba(60,55,50,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(20,20,20,0.5)';
  for (let i = 0; i < 6; i++) { // little cracks / spall marks
    const a = Math.random() * Math.PI * 2;
    g.beginPath();
    g.moveTo(32 + Math.cos(a) * 6, 32 + Math.sin(a) * 6);
    g.lineTo(32 + Math.cos(a) * (12 + Math.random() * 14), 32 + Math.sin(a) * (12 + Math.random() * 14));
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeFlashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.translate(64, 64);
  for (let i = 0; i < 7; i++) { // star-shaped flash petals
    g.rotate((Math.PI * 2) / 7 + Math.random() * 0.3);
    const len = 40 + Math.random() * 22;
    const grad = g.createLinearGradient(0, 0, len, 0);
    grad.addColorStop(0, 'rgba(255,240,200,1)');
    grad.addColorStop(1, 'rgba(255,140,40,0)');
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(0, -7); g.lineTo(len, 0); g.lineTo(0, 7); g.fill();
  }
  const core = g.createRadialGradient(0, 0, 0, 0, 0, 26);
  core.addColorStop(0, 'rgba(255,255,235,1)');
  core.addColorStop(1, 'rgba(255,170,60,0)');
  g.fillStyle = core;
  g.fillRect(-64, -64, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ----------------------------------------------------------------------------
// BoxGeometry with UVs scaled to world size, so a 10 m wall repeats its
// texture instead of stretching one copy across the whole face.
// Face order in BoxGeometry: +x, -x, +y, -y, +z, -z (4 vertices each).
// ----------------------------------------------------------------------------
export function boxGeo(w, h, d, tile = 1) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * dims[f][0]) / tile, (uv.getY(k) * dims[f][1]) / tile);
    }
  }
  return g;
}

// ----------------------------------------------------------------------------
// Materials for gear (gloves, guns, camo sleeves). World surfaces now use
// photo-scanned PBR textures from Poly Haven (see assets.js / materials.js).
// ----------------------------------------------------------------------------
export function createGearMaterials() {
  const camo = camoTexture(401, [[0.32, 0.34, 0.24], [0.22, 0.25, 0.17], [0.4, 0.36, 0.26], [0.14, 0.14, 0.12]]);
  const camoMat = new THREE.MeshStandardMaterial({ map: camo.map, normalMap: camo.normalMap, roughness: 0.95 });
  camoMat.userData.tile = 0.6;
  return {
    camoWood: camoMat,
    skin: new THREE.MeshStandardMaterial({ color: 0x9a7056, roughness: 0.75 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x2f2a22, roughness: 0.9 }),
    gunBlack: new THREE.MeshStandardMaterial({ color: 0x1b1c1c, roughness: 0.45, metalness: 0.7 }),
    gunPolymer: new THREE.MeshStandardMaterial({ color: 0x252623, roughness: 0.7, metalness: 0.1 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.95 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.3, metalness: 1 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0d1114, roughness: 0.05, metalness: 0.9 }),
  };
}

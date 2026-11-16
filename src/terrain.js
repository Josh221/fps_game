// =============================================================================
// terrain.js — heightfield terrain with texture splatting.
//
// A heightfield is a grid of heights. The map supplies a height function
// (noise hills + flattened building pads); we sample it on a 2 m grid, build a
// mesh, and answer "how high is the ground at (x, z)?" for movement and bullets.
//
// Texture SPLATTING: every vertex stores three weights (e.g. dirt / sand /
// rock). The shader blends three full PBR texture sets by those weights —
// rock on steep slopes, sand in hollows, and so on. A second, larger-scale
// sample of each texture is mixed in to hide repetition ("anti-tiling").
// =============================================================================
import * as THREE from 'three';
import { mulberry32 } from './textures.js';

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------- noise
// Classic 2D gradient (Perlin) noise, seeded. Returns roughly -1..1.
export function makeNoise(seed = 1) {
  const rand = mulberry32(seed);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
      case 4: return x; case 5: return -x; case 6: return y; default: return -y;
    }
  };
  return (x, y) => {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = fade(xf), v = fade(yf);
    const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1], ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 0.7;
  };
}

export function fbm(noise, x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp; amp *= gain; freq *= lacunarity;
  }
  return sum / norm;
}

// Blend the height toward h inside rectangles (building pads, roads, trenches).
// zone = { x, z, w, d, h, blend } — w/d = size, blend = falloff distance.
export function applyFlats(height, x, z, zones) {
  for (const f of zones) {
    const dx = Math.max(Math.abs(x - f.x) - f.w / 2, 0), dz = Math.max(Math.abs(z - f.z) - f.d / 2, 0);
    const t = 1 - smooth(0, f.blend, Math.hypot(dx, dz));
    if (t > 0) height += (f.h - height) * t;
  }
  return height;
}

// ---------------------------------------------------------------- terrain
export class Terrain {
  // opts: { size, spacing, height(x,z), splat(x,z,h,slope)->[w0,w1,w2], layers:[set,set,set], surfaces:[...], tint }
  constructor(opts) {
    this.size = opts.size ?? 800;
    this.spacing = opts.spacing ?? 2;
    this.n = Math.round(this.size / this.spacing) + 1;
    this.half = this.size / 2;
    this.surfaces = opts.surfaces || ['dirt', 'dirt', 'rock'];
    this.heights = new Float32Array(this.n * this.n);
    const n = this.n;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        this.heights[iz * n + ix] = opts.height(-this.half + ix * this.spacing, -this.half + iz * this.spacing);
      }
    }
    this.splatFn = opts.splat;
    this.mesh = this._buildMesh(opts);
  }

  _buildMesh(opts) {
    const n = this.n;
    const geo = new THREE.PlaneGeometry(this.size, this.size, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2); // rows now run from z = -half to +half
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.heights[i]);
    geo.computeVertexNormals();
    const nor = geo.attributes.normal;
    const splat = new Float32Array(pos.count * 3);
    this.weights = splat;
    for (let i = 0; i < pos.count; i++) {
      const slope = Math.acos(Math.min(1, nor.getY(i)));
      const w = this.splatFn(pos.getX(i), pos.getZ(i), pos.getY(i), slope);
      splat[i * 3] = w[0]; splat[i * 3 + 1] = w[1]; splat[i * 3 + 2] = w[2];
    }
    geo.setAttribute('splat', new THREE.BufferAttribute(splat, 3));
    const mesh = new THREE.Mesh(geo, createSplatMaterial(opts.layers, opts.tint));
    mesh.receiveShadow = true;
    mesh.castShadow = true; // hills shadow valleys
    return mesh;
  }

  // Height exactly matching the rendered triangles (same diagonal split as PlaneGeometry).
  heightAt(x, z) {
    const n = this.n, s = this.spacing;
    const gx = (x + this.half) / s, gz = (z + this.half) / s;
    const ix = Math.max(0, Math.min(n - 2, Math.floor(gx))), iz = Math.max(0, Math.min(n - 2, Math.floor(gz)));
    const fx = Math.min(1, Math.max(0, gx - ix)), fz = Math.min(1, Math.max(0, gz - iz));
    const H = this.heights;
    const ha = H[iz * n + ix], hb = H[(iz + 1) * n + ix], hc = H[(iz + 1) * n + ix + 1], hd = H[iz * n + ix + 1];
    if (fx + fz <= 1) return ha + (hd - ha) * fx + (hb - ha) * fz;
    return hc + (hb - hc) * (1 - fx) + (hd - hc) * (1 - fz);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = this.spacing * 0.5;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  // Which texture layer dominates here (for bullet impact effects/sounds)
  surfaceAt(x, z) {
    const n = this.n, s = this.spacing;
    const ix = Math.round((x + this.half) / s), iz = Math.round((z + this.half) / s);
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return this.surfaces[0];
    const i = (iz * n + ix) * 3, w = this.weights;
    const k = w[i] >= w[i + 1] && w[i] >= w[i + 2] ? 0 : w[i + 1] >= w[i + 2] ? 1 : 2;
    return this.surfaces[k];
  }

  weightAt(x, z, layer) {
    const n = this.n, s = this.spacing;
    const ix = Math.round((x + this.half) / s), iz = Math.round((z + this.half) / s);
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return 0;
    const i = (iz * n + ix) * 3, w = this.weights;
    return w[i + layer] / Math.max(1e-4, w[i] + w[i + 1] + w[i + 2]);
  }

  // Ray march + bisection. Returns { dist, point, normal } or null.
  raycast(o, d, maxDist) {
    let t = 0, prev = 0;
    let above = o.y - this.heightAt(o.x, o.z);
    if (above < 0) return null; // started underground
    while (t < maxDist) {
      prev = t;
      t = Math.min(maxDist, t + Math.max(0.4, above * 0.5));
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      above = y - this.heightAt(x, z);
      if (above <= 0) {
        let lo = prev, hi = t;
        for (let k = 0; k < 10; k++) {
          const m = (lo + hi) / 2;
          if (o.y + d.y * m - this.heightAt(o.x + d.x * m, o.z + d.z * m) > 0) lo = m; else hi = m;
        }
        const point = new THREE.Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi);
        return { dist: hi, point, normal: this.normalAt(point.x, point.z) };
      }
      if (t >= maxDist) break;
    }
    return null;
  }
}

// ---------------------------------------------------------------- material
// Patches MeshStandardMaterial's shader so all its lighting features (sun,
// shadows, sky light, fog) keep working, but colour/normal/roughness/AO come
// from three blended texture sets.
function createSplatMaterial(layers, tint = 0xffffff) {
  const mat = new THREE.MeshStandardMaterial({ map: layers[0].map, normalMap: layers[0].normalMap, roughness: 1, metalness: 0, color: tint });
  const tiles = new THREE.Vector3(layers[0].size, layers[1].size, layers[2].size);
  mat.onBeforeCompile = (shader) => {
    layers.forEach((l, i) => {
      shader.uniforms[`tC${i}`] = { value: l.map };
      shader.uniforms[`tN${i}`] = { value: l.normalMap };
      shader.uniforms[`tA${i}`] = { value: l.arm };
    });
    shader.uniforms.uTiles = { value: tiles };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 splat;\nvarying vec3 vSplat;\nvarying vec3 vTPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSplat = splat;\nvTPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        uniform sampler2D tC0, tC1, tC2, tN0, tN1, tN2, tA0, tA1, tA2;
        uniform vec3 uTiles;
        varying vec3 vSplat; varying vec3 vTPos;
        float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float tNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y);
        }
        vec3 tLayer(sampler2D t, vec2 uv, float tile, float n) {
          // near-scale sample blended with a rotated far-scale sample hides tiling
          vec3 a = texture2D(t, uv / tile).rgb;
          vec3 b = texture2D(t, mat2(0.8, -0.6, 0.6, 0.8) * uv / (tile * 3.7)).rgb;
          return mix(a, b, n * 0.55);
        }`)
      .replace('#include <map_fragment>', /* glsl */ `
        vec3 tW = max(vSplat, 0.0); tW /= max(tW.x + tW.y + tW.z, 1e-4);
        vec2 tUV = vec2(vTPos.x, -vTPos.z);
        float tN = tNoise(tUV * 0.04) * 0.7 + tNoise(tUV * 0.15) * 0.3;
        vec3 tCol = tLayer(tC0, tUV, uTiles.x, tN) * tW.x + tLayer(tC1, tUV, uTiles.y, tN) * tW.y + tLayer(tC2, tUV, uTiles.z, tN) * tW.z;
        tCol *= 0.85 + tN * 0.3; // large-scale brightness variation
        diffuseColor.rgb *= tCol;
        vec3 tArm = texture2D(tA0, tUV / uTiles.x).rgb * tW.x + texture2D(tA1, tUV / uTiles.y).rgb * tW.y + texture2D(tA2, tUV / uTiles.z).rgb * tW.z;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * tArm.g;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <normal_fragment_maps>', THREE.ShaderChunk.normal_fragment_maps.replace(
        'texture2D( normalMap, vNormalMapUv ).xyz',
        '(texture2D(tN0, tUV / uTiles.x).xyz * tW.x + texture2D(tN1, tUV / uTiles.y).xyz * tW.y + texture2D(tN2, tUV / uTiles.z).xyz * tW.z)'))
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= tArm.r;\nreflectedLight.indirectSpecular *= tArm.r;');
  };
  mat.customProgramCacheKey = () => 'terrain-splat-v1';
  return mat;
}

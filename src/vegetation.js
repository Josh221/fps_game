// =============================================================================
// vegetation.js — grass, trees and rocks, all drawn with INSTANCING.
//
// Instancing = one geometry drawn thousands of times in a single draw call,
// each copy with its own position/rotation/scale/colour. It's how games put
// 40,000 grass clumps on screen. We also split instances into spatial CHUNKS
// so the camera can skip (frustum-cull) chunks that are off screen.
// =============================================================================
import * as THREE from 'three';
import { Tree } from '@dgreenheck/ez-tree';
import { makeNoise } from './terrain.js';

const CHUNK = 40; // metres

// Set by main.js from the graphics preset before a map is built.
//  a2c: "alpha to coverage" — with MSAA on, cut-out edges of grass/leaves are
//       smoothed across the 4 samples instead of a hard on/off test. Hard
//       alpha-test edges are what made foliage shimmer and crawl.
export const VegetationSettings = { a2c: false, leafShadowRange: 45 };

// Group instance transforms into chunks, then build one InstancedMesh per chunk.
function chunkedInstances(scene, geometry, material, items, opts = {}) {
  const chunks = new Map();
  for (const it of items) {
    const key = `${Math.floor(it.matrix.elements[12] / CHUNK)},${Math.floor(it.matrix.elements[14] / CHUNK)}`;
    if (!chunks.has(key)) chunks.set(key, []);
    chunks.get(key).push(it);
  }
  const meshes = [];
  for (const list of chunks.values()) {
    const m = new THREE.InstancedMesh(geometry, material, list.length);
    list.forEach((it, i) => { m.setMatrixAt(i, it.matrix); if (it.color) m.setColorAt(i, it.color); });
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    m.castShadow = !!opts.castShadow;
    m.receiveShadow = opts.receiveShadow ?? true;
    if (opts.noAO) m.userData.noAO = true;
    scene.add(m);
    meshes.push(m);
  }
  return meshes;
}

// ---------------------------------------------------------------- grass
function grassTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  for (let i = 0; i < 46; i++) {
    const x = 20 + Math.random() * 216, h = 120 + Math.random() * 130, lean = (Math.random() - 0.5) * 70, w = 3 + Math.random() * 4;
    const grad = g.createLinearGradient(0, 256, 0, 256 - h);
    grad.addColorStop(0, 'rgb(90,90,90)');
    grad.addColorStop(1, `rgb(${215 + Math.random() * 40},${215 + Math.random() * 40},${200 + Math.random() * 40})`);
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x - w, 256);
    g.quadraticCurveTo(x + lean * 0.3, 256 - h * 0.6, x + lean, 256 - h);
    g.quadraticCurveTo(x + lean * 0.3 + w * 0.5, 256 - h * 0.6, x + w, 256);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function grassGeometry() {
  // 3 crossed quads, each with a front AND back face so both sides light like the ground
  const pos = [], uv = [], idx = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI, cx = Math.cos(a) * 0.35, cz = Math.sin(a) * 0.35;
    const base = pos.length / 3;
    pos.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

export class Grass {
  // opts: { terrain, area:{minX,maxX,minZ,maxZ}, count, density(x,z)->0..1, colors:[hex], height:[min,max], rand }
  constructor(scene, opts) {
    this.uniforms = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uFade: { value: opts.fade ?? 55 } };
    const mat = new THREE.MeshStandardMaterial({ map: grassTexture(), alphaTest: 0.45, roughness: 0.95, metalness: 0 });
    mat.alphaToCoverage = VegetationSettings.a2c;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime, uFade;\nuniform vec3 uCam;')
        .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
          vec4 gBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float gWind = sin(uTime * 1.6 + gBase.x * 0.31 + gBase.z * 0.23) * 0.5 + sin(uTime * 3.3 + gBase.x * 1.1) * 0.15;
          transformed.x += gWind * 0.14 * uv.y * uv.y;
          transformed.z += gWind * 0.06 * uv.y * uv.y;
          // shrink clumps into the ground with distance instead of popping
          transformed *= 1.0 - smoothstep(uFade * 0.6, uFade, distance(gBase.xz, uCam.xz));`);
    };
    mat.customProgramCacheKey = () => 'grass-v1';

    const { terrain, area, rand } = opts;
    const items = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const colors = opts.colors.map((h) => new THREE.Color(h));
    let tries = 0;
    while (items.length < opts.count && tries++ < opts.count * 6) {
      const x = area.minX + rand() * (area.maxX - area.minX), z = area.minZ + rand() * (area.maxZ - area.minZ);
      if (rand() > opts.density(x, z)) continue;
      const h = opts.height[0] + rand() * (opts.height[1] - opts.height[0]);
      q.setFromAxisAngle(up, rand() * Math.PI);
      m.compose(p.set(x, terrain.heightAt(x, z) - 0.03, z), q, s.set(0.8 + rand() * 0.6, h, 0.8 + rand() * 0.6));
      const c = colors[(rand() * colors.length) | 0].clone().multiplyScalar(0.8 + rand() * 0.35);
      items.push({ matrix: m.clone(), color: c });
    }
    this.meshes = chunkedInstances(scene, grassGeometry(), mat, items, { castShadow: false, noAO: true });
  }

  update(t, camPos) {
    this.uniforms.uTime.value = t;
    this.uniforms.uCam.value.copy(camPos);
  }
}

// ---------------------------------------------------------------- trees
// EZ-Tree ships Phong materials, which ignore the sky lighting (image-based
// lighting) that everything else uses — so leaves rendered nearly black. We
// swap in physically based materials and add our own wind.
// Wind for leaves, shared by the colour material AND the shadow material so
// the shadows sway with the leaves instead of sitting still underneath them.
function leafWind(shader, uniforms) {
  shader.uniforms.uTime = uniforms.uTime;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nuniform float uTime;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 lw = transformed;
      #ifdef USE_INSTANCING
        lw = (instanceMatrix * vec4(transformed, 1.0)).xyz;
      #endif
      float sway = sin(uTime * 1.2 + lw.x * 0.15 + lw.z * 0.11) * 0.6 + sin(uTime * 2.3 + lw.y * 0.4) * 0.3;
      float flutter = sin(uTime * 7.0 + position.x * 3.0 + position.z * 2.0) * 0.12;
      transformed.xz += (sway * 0.006 * position.y + flutter) * vec2(1.0, 0.6);`);
}

function leafDepthMaterial(src, uniforms) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: src.map, alphaTest: src.alphaTest || 0.5, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => leafWind(shader, uniforms);
  m.customProgramCacheKey = () => 'leaf-depth-v1';
  return m;
}

function leafMaterial(src, uniforms) {
  const m = new THREE.MeshStandardMaterial({ map: src.map, color: src.color, alphaTest: src.alphaTest || 0.5, side: THREE.DoubleSide, roughness: 0.8, metalness: 0 });
  m.alphaToCoverage = VegetationSettings.a2c;
  m.onBeforeCompile = (shader) => {
    leafWind(shader, uniforms);
    // leaves are thin cards: light both faces the same way (no back-face flip)
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>',
      THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
  };
  m.customProgramCacheKey = () => 'leaf-v3';
  return m;
}

// Point leaf normals outward from the crown (and a bit up), so the canopy is
// shaded like one soft volume instead of thousands of randomly-lit cards.
function canopyNormals(geo) {
  geo.computeBoundingBox();
  const c = geo.boundingBox.getCenter(new THREE.Vector3());
  const pos = geo.attributes.position, nor = geo.attributes.normal, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).sub(c).normalize().multiplyScalar(0.7);
    v.y += 0.5;
    v.normalize();
    nor.setXYZ(i, v.x, v.y, v.z);
  }
  nor.needsUpdate = true;
}

// EZ-Tree generates a tree from parameters. We generate a few variants once,
// then instance them hundreds of times. "far" variants have fewer leaves and
// rounder branches — a simple level of detail (LOD) system.
export class Forest {
  // variants: [{ preset, seed, far, tint }]; trees: [{ x, z, s, variant }]
  constructor(scene, world, terrain, variants, trees, { units = 0.3, playRadius = 115, leafShadows = true } = {}) {
    this.uniforms = { uTime: { value: 0 } };
    this.leafShadows = leafShadows;
    this.leafChunks = [];
    const built = variants.map((v) => {
      const tree = new Tree();
      tree.loadPreset(v.preset);
      tree.options.seed = v.seed;
      if (v.leafTint) tree.options.leaves.tint = v.leafTint;
      if (v.barkTint) tree.options.bark.tint = v.barkTint;
      if (v.detail) { // trim triangles while keeping the silhouette
        tree.options.leaves.count = Math.max(4, Math.round(tree.options.leaves.count * v.detail));
        tree.options.leaves.size /= Math.sqrt(v.detail);
        for (const k of Object.keys(tree.options.branch.segments)) tree.options.branch.segments[k] = Math.max(3, Math.round(tree.options.branch.segments[k] * v.detail));
      }
      if (v.far) { // coarser branches far away, slightly bigger leaves so crowns stay full
        tree.options.leaves.size *= 1.15;
        for (const k of Object.keys(tree.options.branch.segments)) tree.options.branch.segments[k] = Math.max(3, Math.round(tree.options.branch.segments[k] * 0.5));
      }
      tree.generate();
      const bark = tree.branchesMesh.material;
      tree.branchesMesh.material = new THREE.MeshStandardMaterial({
        map: bark.map, normalMap: bark.normalMap, aoMap: bark.aoMap, roughnessMap: bark.roughnessMap,
        color: bark.color, roughness: 1, metalness: 0,
      });
      const leafSrc = tree.leavesMesh.material;
      tree.leavesMesh.material = leafMaterial(leafSrc, this.uniforms);
      tree.leavesMesh.userData.depth = leafDepthMaterial(leafSrc, this.uniforms);
      canopyNormals(tree.leavesMesh.geometry);
      const meshes = [tree.branchesMesh, tree.leavesMesh];
      const trunkR = (tree.options.branch.radius?.[0] ?? 1.2) * 0.8;
      // The trunk's own triangles, for bullets: EZ-Tree builds the trunk first,
      // so it's the first sections x segments quads of the bark mesh (it leans and curves)
      const barkGeo = tree.branchesMesh.geometry, ob = tree.options.branch;
      const trunk = new THREE.BufferGeometry();
      trunk.setAttribute('position', barkGeo.attributes.position);
      trunk.setIndex(Array.from(barkGeo.index.array.subarray(0, ob.sections[0] * ob.segments[0] * 6)));
      return { meshes, trunkR, far: !!v.far, trunk };
    });

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const byVariant = built.map(() => []);
    // A trunk tapers, leans and curves; its walking box doesn't. Bullets test the
    // trunk's real triangles instead, so shots past a tree only hit the wood you see.
    for (const t of trees) {
      const y = terrain ? terrain.heightAt(t.x, t.z) - 0.3 : 0;
      const sc = t.s * units;
      q.setFromAxisAngle(up, (t.x * 13.37 + t.z * 7.1) % (Math.PI * 2));
      m.compose(p.set(t.x, y, t.z), q, s.set(sc, sc, sc));
      byVariant[t.variant].push({ matrix: m.clone() });
      // Solid trunk inside the playable area (bullets thud into it, you can hide behind it)
      if (Math.max(Math.abs(t.x), Math.abs(t.z)) < playRadius) {
        const r = Math.max(0.18, built[t.variant].trunkR * sc);
        world.add(new THREE.Vector3(t.x - r, y, t.z - r), new THREE.Vector3(t.x + r, y + 6, t.z + r),
          { surface: 'wood', pen: 2, cover: false, shape: [{ geometry: built[t.variant].trunk, matrix: m.clone() }] });
      }
    }
    built.forEach((b, vi) => {
      if (!byVariant[vi].length) return;
      for (const mesh of b.meshes) {
        const isLeaves = mesh === b.meshes[1];
        const chunks = chunkedInstances(scene, mesh.geometry, mesh.material, byVariant[vi], { castShadow: !isLeaves, noAO: isLeaves });
        if (isLeaves) for (const c of chunks) { c.customDepthMaterial = mesh.userData.depth; this.leafChunks.push(c); }
      }
    });
  }

  // Leaf shadows are the most expensive shadows in the game (thousands of
  // alpha-tested cards drawn a second time into the shadow map), so on High
  // only the chunks of trees near you cast them.
  update(t, camPos) {
    this.uniforms.uTime.value = t;
    if (!this.leafShadows || !camPos) return;
    const r = VegetationSettings.leafShadowRange + CHUNK;
    for (const c of this.leafChunks) c.castShadow = c.boundingSphere.center.distanceTo(camPos) < r;
  }
}

// ---------------------------------------------------------------- rocks
// Lumpy boulders: a sphere pushed in and out by noise, textured with a
// "triplanar" projection (the texture is projected from 3 sides and blended,
// so there's no stretching or UV seams on an irregular shape).
function rockGeometry(seed) {
  const noise = makeNoise(seed);
  // Low-poly sphere + noise, then split into flat facets: reads as fractured stone
  const g = new THREE.IcosahedronGeometry(1, 2);
  const pos = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const r = 1 + noise(v.x * 1.1 + 3, v.y * 1.1 + v.z * 0.7) * 0.45 + Math.abs(noise(v.x * 3 + v.z * 2.3, v.y * 3)) * 0.2;
    v.multiplyScalar(r);
    v.y = v.y > 0 ? v.y * 0.8 : v.y * 0.35; // flatter bottom, sits in the ground
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals(); // icosahedrons are non-indexed, so this gives flat facets
  return g;
}

export function triplanar(material, scale = 1) {
  const m = material.clone();
  m.normalMap = null;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = { value: 1 / scale };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        mat4 triM = modelMatrix;
        #ifdef USE_INSTANCING
          triM = modelMatrix * instanceMatrix;
        #endif
        vTriPos = (triM * vec4(transformed, 1.0)).xyz;
        vTriNrm = normalize(mat3(triM) * objectNormal);`);
    const tri = (tex, ch) => `(texture2D(${tex}, vTriPos.zy * uTriScale)${ch} * tw.x + texture2D(${tex}, vTriPos.xz * uTriScale)${ch} * tw.y + texture2D(${tex}, vTriPos.xy * uTriScale)${ch} * tw.z)`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTriScale;\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;')
      .replace('#include <map_fragment>', `vec3 tw = pow(abs(vTriNrm), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
        diffuseColor.rgb *= ${tri('map', '.rgb')};
        vec3 triArm = ${tri('roughnessMap', '.rgb')};`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * triArm.g;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= triArm.r;');
  };
  m.customProgramCacheKey = () => `triplanar-${scale}`;
  return m;
}

// rocks: [{ x, z, s, sy (vertical squash), variant }]
export function placeRocks(scene, world, terrain, material, rocks, { variants = 5, seed = 7 } = {}) {
  const geos = Array.from({ length: variants }, (_, i) => rockGeometry(seed + i * 31));
  const mat = triplanar(material, material.userData.tile || 3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const per = geos.map(() => []);
  for (const r of rocks) {
    const sy = r.sy ?? 0.8;
    const y = terrain.heightAt(r.x, r.z);
    e.set(0, (r.x * 3.1 + r.z) % 6.28, 0);
    q.setFromEuler(e);
    m.compose(p.set(r.x, y - r.s * 0.15, r.z), q, s.set(r.s, r.s * sy, r.s * (0.8 + ((r.x * 7) % 0.4))));
    per[((Math.round(r.variant) % variants) + variants) % variants].push({ matrix: m.clone() });
    const top = y + r.s * sy * 0.75 - r.s * 0.15;
    const half = r.s * 0.75;
    world.add(new THREE.Vector3(r.x - half, y - 1, r.z - half), new THREE.Vector3(r.x + half, top, r.z + half),
      { surface: 'rock', cover: top - y > 0.8 && top - y < 1.5, shape: [{ geometry: geos[((Math.round(r.variant) % variants) + variants) % variants], matrix: m.clone() }] }); // (bullets test the real rock)
  }
  geos.forEach((g, i) => { if (per[i].length) chunkedInstances(scene, g, mat, per[i], { castShadow: true }); });
}

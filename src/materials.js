// =============================================================================
// materials.js — builds a map's material palette from photo-scanned textures.
//
// Maps describe materials by ROLE ("wall", "floor", "roof"...) and pick a
// Poly Haven texture for each. Builders only ever ask for roles, so the same
// building code makes a concrete bunker in one map and a plaster house in another.
// =============================================================================
import * as THREE from 'three';
import { createGearMaterials } from './textures.js';

// spec: { role: 'texture_id' | ['texture_id', opts] | [ [id, opts], [id, opts] ] (a list) }
export async function loadMaterials(assets, spec) {
  const M = createGearMaterials();
  const load = (v) => {
    const [id, opts] = Array.isArray(v) ? v : [v, {}];
    return assets.pbr(id, opts);
  };
  await Promise.all(Object.entries(spec).map(async ([role, v]) => {
    M[role] = Array.isArray(v) && Array.isArray(v[0]) ? await Promise.all(v.map(load)) : await load(v);
  }));

  // Weapon finishes: anodised metal and polymer, both with fine scratches/wear
  // from a scanned metal plate, repeated small so the detail is gun-scale.
  const plate = await assets.textureSet('metal_plate');
  const small = (t, n) => { const c = t.clone(); c.repeat.set(n, n); c.needsUpdate = true; return c; };
  // Roughness is kept fairly high and the bump detail subtle: shiny metal with
  // fine bumps makes single-pixel highlights that sparkle ("specular aliasing").
  M.gunBlack = new THREE.MeshStandardMaterial({
    color: 0x2e2f30, map: small(plate.map, 6), normalMap: small(plate.normalMap, 6),
    roughness: 0.55, metalness: 0.8, normalScale: new THREE.Vector2(0.15, 0.15),
  });
  M.gunPolymer = new THREE.MeshStandardMaterial({
    color: 0x262724, normalMap: small(plate.normalMap, 9),
    roughness: 0.85, metalness: 0.05, normalScale: new THREE.Vector2(0.12, 0.12),
  });
  return M;
}

// Re-skin the sandbag model: the scanned bag has cement-brand print on it,
// so we keep its wrinkly normal map but swap the colour for hessian cloth.
export async function sandbagMaterial(assets, props, tint = 0xd2c29c) {
  const set = await assets.textureSet('hessian_230');
  const map = set.map.clone();
  map.repeat.set(3, 3);
  map.needsUpdate = true;
  for (const part of props.defs.get('cement_bag').parts) {
    part.material = part.material.clone();
    part.material.map = map;
    part.material.color = new THREE.Color(tint);
    part.material.roughness = 1;
    part.material.metalness = 0;
    part.material.metalnessMap = null;
  }
}

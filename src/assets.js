// =============================================================================
// assets.js — loads and caches textures, PBR materials, glTF models and HDR skies.
//
// Every request goes through a cache, so asking for the same thing twice
// returns the same object (one GPU upload, shared by everything that uses it).
// Progress is reported so the menu can show a loading bar.
// =============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

export class Assets {
  constructor(renderer) {
    this.maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    this.texLoader = new THREE.TextureLoader();
    this.gltfLoader = new GLTFLoader();
    this.rgbeLoader = new RGBELoader();
    this.cache = new Map();
    this.loaded = 0;
    this.total = 0;
    this.onProgress = null;
  }

  _once(key, make) {
    if (!this.cache.has(key)) {
      this.total++;
      const p = make().finally(() => { this.loaded++; this.onProgress?.(this.loaded, this.total); });
      this.cache.set(key, p);
    }
    return this.cache.get(key);
  }

  texture(url, srgb = false) {
    return this._once(`tex:${url}`, async () => {
      const t = await this.texLoader.loadAsync(url);
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = this.maxAniso;
      return t;
    });
  }

  // The three maps of a Poly Haven texture set + its real-world size in metres.
  textureSet(id) {
    return this._once(`set:${id}`, async () => {
      const base = `assets/textures/${id}/`;
      const [map, normalMap, arm, meta] = await Promise.all([
        this.texture(base + 'diff.jpg', true),
        this.texture(base + 'normal.jpg'),
        this.texture(base + 'arm.jpg'),
        fetch(base + 'meta.json').then((r) => r.json()),
      ]);
      return { map, normalMap, arm, size: meta.size[0] || 2 };
    });
  }

  // A physically based material. ARM = Ambient occlusion / Roughness / Metalness
  // packed into the R/G/B channels, which is exactly how three.js reads them.
  async pbr(id, opts = {}) {
    const set = await this.textureSet(id);
    const { tile, surface, ...matOpts } = opts;
    const m = new THREE.MeshStandardMaterial({
      map: set.map, normalMap: set.normalMap,
      aoMap: set.arm, roughnessMap: set.arm, metalnessMap: set.arm,
      roughness: 1, metalness: 1, aoMapIntensity: 1,
      ...matOpts,
    });
    m.userData.tile = tile ?? set.size;      // metres per texture repeat
    m.userData.surface = surface || 'concrete';
    return m;
  }

  model(id) {
    return this._once(`model:${id}`, () => this.gltfLoader.loadAsync(`assets/models/${id}/${id}.gltf`));
  }

  gltf(url) {
    return this._once(`gltf:${url}`, () => this.gltfLoader.loadAsync(url));
  }

  hdr(id) {
    return this._once(`hdr:${id}`, () => this.rgbeLoader.loadAsync(`assets/hdri/${id}.hdr`));
  }
}

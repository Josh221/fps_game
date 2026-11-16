// =============================================================================
// render.js — the rendering pipeline.
//
//  1. HDR sky (a real photographed sky) lights the scene ("image-based lighting")
//  2. The SUN is found inside that photo, removed from the ambient light and
//     turned into a shadow-casting directional light of the same strength and
//     colour — so sunlight and shadows are physically consistent with the sky.
//  3. Post-processing chain (like a film camera / colour grade):
//       world -> GTAO (ambient occlusion: contact shadows in corners & creases)
//             -> viewmodel (gun drawn on top, own depth)
//             -> bloom (bright muzzle flashes & tracers glow)
//             -> tone mapping (HDR -> screen) -> grade (contrast, vignette, grain)
// =============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// minScale = how far dynamic resolution may drop the render size to hold the frame rate
export const QUALITY = {
  low: { pixelRatio: 1, ao: false, bloom: false, shadowSize: 2048, shadowRadius: 45, grass: 0.35, msaa: 0, leafShadows: false, minScale: 0.6 },
  medium: { pixelRatio: 1, ao: true, bloom: true, shadowSize: 4096, shadowRadius: 60, grass: 0.7, msaa: 4, leafShadows: false, minScale: 0.7 },
  high: { pixelRatio: 1.5, ao: true, bloom: true, shadowSize: 4096, shadowRadius: 65, grass: 0.9, msaa: 4, leafShadows: true, minScale: 0.7 },
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uFrame: { value: 0 },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uSunVis: { value: 0 },
    uAspect: { value: 1.6 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.03 },
    uSaturation: { value: 1.0 },
    uContrast: { value: 1.06 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uHurt: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uFrame, uVignette, uGrain, uSaturation, uContrast, uHurt, uSunVis, uAspect; uniform vec3 uTint; uniform vec2 uSun;
    varying vec2 vUv;
    // "Hash without sine" (Dave Hoskins): stable on every GPU. The classic
    // fract(sin(x) * 43758.5) hash breaks down when x gets large and shows
    // crawling patterns — that was the grain bug.
    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSaturation * (1.0 - uHurt * 0.75)); // badly hurt = colour drains away
      c.rgb = (c.rgb - 0.5) * uContrast + 0.5;
      c.rgb *= uTint;
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.8, 0.2, dot(d, d) * (1.6 + uHurt));
      c.rgb *= mix(1.0 - uVignette, 1.0, v);
      // Lens flare: a soft glow around the sun plus faint "ghost" rings on the
      // line from the sun through the centre of the lens (real camera lenses do this).
      if (uSunVis > 0.001) {
        vec2 sd = vUv - uSun; sd.x *= uAspect;
        vec3 flare = vec3(1.0, 0.9, 0.75) * (exp(-length(sd) * 16.0) * 0.4 + exp(-length(sd) * 4.0) * 0.06);
        vec2 axis = vec2(0.5) - uSun;
        for (int i = 0; i < 4; i++) {
          float fi = float(i);
          vec2 gd = vUv - (uSun + axis * (0.7 + fi * 0.42)); gd.x *= uAspect;
          float r = 0.025 + fi * 0.018;
          flare += mix(vec3(0.5, 0.7, 1.0), vec3(1.0, 0.7, 0.4), fi / 3.0) * smoothstep(r, r * 0.55, length(gd)) * 0.045;
        }
        c.rgb += flare * uSunVis;
      }
      c.rgb += (hash12(gl_FragCoord.xy + uFrame * vec2(37.0, 17.0)) - 0.5) * uGrain; // film grain, new pattern each frame
      gl_FragColor = c;
    }`,
};

const _v = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3();

export class GameRenderer {
  constructor(container, qualityName = 'medium') {
    this.q = QUALITY[qualityName] || QUALITY.medium;
    this.qualityName = qualityName;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' }));
    this.basePixelRatio = Math.min(window.devicePixelRatio, this.q.pixelRatio);
    this.scale = 1;            // dynamic resolution scale (1 = full)
    this._miss = 0;            // how often we're missing the frame-time target (smoothed 0..1)
    this._lastChange = 0;
    this._raiseWait = 5;       // seconds of smooth frames before trying a higher resolution
    r.setPixelRatio(this.basePixelRatio);
    r.setSize(window.innerWidth, window.innerHeight);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(r.domElement);
    this.sunDir = new THREE.Vector3(0.4, 0.6, 0.5).normalize();
    this.sun = null;
  }

  // ---------------------------------------------------------------- sky & sun
  // Scan the HDR photo for the sun: very bright pixels. Sum their energy
  // (radiance x solid angle) to get the sun's real intensity and colour, then
  // clamp them so the ambient light doesn't contain the sun twice.
  setupSky(scene, hdr, { exposure = 1, sunScale = 1, envIntensity = 1, fogDensity = 0.0025, fogColorScale = 1, groundColor = 0x5a5040 } = {}) {
    const img = hdr.image, W = img.width, H = img.height;
    const src = img.data;
    const half = src instanceof Uint16Array;
    const read = (i) => (half ? THREE.DataUtils.fromHalfFloat(src[i]) : src[i]);
    const lum = new Float32Array(W * H);
    let maxL = 0;
    for (let p = 0; p < W * H; p++) {
      const L = 0.2126 * read(p * 4) + 0.7152 * read(p * 4 + 1) + 0.0722 * read(p * 4 + 2);
      lum[p] = L;
      if (L > maxL) maxL = L;
    }
    const thresh = Math.max(40, maxL * 0.02);
    const E = new THREE.Vector3(), dir = new THREE.Vector3();
    let horizon = new THREE.Vector3(), hn = 0;
    const clamped = half ? new Uint16Array(src) : new Float32Array(src);
    const dPhi = (2 * Math.PI) / W, dTheta = Math.PI / H;
    for (let y = 0; y < H; y++) {
      const elev = (0.5 - (y + 0.5) / H) * Math.PI; // row 0 = straight up
      const omega = dPhi * dTheta * Math.cos(elev);
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (Math.abs(elev) < 0.05) { horizon.x += read(p * 4); horizon.y += read(p * 4 + 1); horizon.z += read(p * 4 + 2); hn++; }
        if (lum[p] <= thresh) continue;
        const k = 1 - thresh / lum[p]; // fraction of this pixel that is "sun"
        const r = read(p * 4) * k, g = read(p * 4 + 1) * k, b = read(p * 4 + 2) * k;
        E.x += r * omega; E.y += g * omega; E.z += b * omega;
        const az = ((x + 0.5) / W - 0.5) * 2 * Math.PI; // matches three.js equirect mapping
        const w = (0.2126 * r + 0.7152 * g + 0.0722 * b) * omega;
        dir.x += Math.cos(az) * Math.cos(elev) * w;
        dir.y += Math.sin(elev) * w;
        dir.z += Math.sin(az) * Math.cos(elev) * w;
        const s = thresh / lum[p];
        for (let c = 0; c < 3; c++) {
          const v = read(p * 4 + c) * s;
          clamped[p * 4 + c] = half ? THREE.DataUtils.toHalfFloat(v) : v;
        }
      }
    }
    if (dir.lengthSq() > 0) this.sunDir.copy(dir).normalize();
    if (this.sunDir.y < 0.05) { this.sunDir.y = 0.05; this.sunDir.normalize(); }
    const sunLum = 0.2126 * E.x + 0.7152 * E.y + 0.0722 * E.z;

    // "Sky-only" HDRIs have nothing below the horizon, so ceilings and the
    // undersides of things would get no light. Real ground reflects light:
    // radiance = albedo x (sun + sky irradiance) / pi. Paint that in.
    let skyE = 0;
    for (let y = 0; y < H / 2; y++) {
      const elev = (0.5 - (y + 0.5) / H) * Math.PI, w = dPhi * dTheta * Math.cos(elev) * Math.sin(elev);
      for (let x = 0; x < W; x++) skyE += Math.min(lum[y * W + x], thresh) * w;
    }
    const ground = new THREE.Color(groundColor);
    const gL = (sunLum * Math.max(0, this.sunDir.y) + skyE) / Math.PI;
    for (let y = Math.floor(H / 2); y < H; y++) {
      const elev = (0.5 - (y + 0.5) / H) * Math.PI;
      const b = Math.min(1, -elev / 0.08); // fade in just below the horizon
      for (let x = 0; x < W; x++) {
        const p = y * W + x;
        for (let c = 0; c < 3; c++) {
          const orig = half ? THREE.DataUtils.fromHalfFloat(clamped[p * 4 + c]) : clamped[p * 4 + c];
          const v = orig * (1 - b) + gL * [ground.r, ground.g, ground.b][c] * b;
          clamped[p * 4 + c] = half ? THREE.DataUtils.toHalfFloat(v) : v;
        }
      }
    }

    // Ambient/reflections from the sun-less sky
    const envTex = new THREE.DataTexture(clamped, W, H, THREE.RGBAFormat, hdr.type);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.LinearSRGBColorSpace;
    envTex.flipY = hdr.flipY;
    envTex.needsUpdate = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    scene.environment = pmrem.fromEquirectangular(envTex).texture;
    scene.environmentIntensity = envIntensity;
    envTex.dispose();
    pmrem.dispose();
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.background = hdr;

    // The sun as a real light (a bit of a floor so overcast maps still get soft shadows)
    const sunColor = new THREE.Color(E.x, E.y, E.z);
    if (sunLum > 0) sunColor.multiplyScalar(1 / Math.max(E.x, E.y, E.z)); else sunColor.set(1, 1, 1);
    const sun = (this.sun = new THREE.DirectionalLight(sunColor, Math.max(0.6, sunLum) * sunScale));
    sun.castShadow = true;
    sun.shadow.mapSize.set(this.q.shadowSize, this.q.shadowSize);
    const R = this.q.shadowRadius;
    Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 600 });
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);

    // Fog tinted with the real horizon colour, so distant hills melt into the sky
    if (hn) horizon.multiplyScalar(1 / hn);
    const fogColor = new THREE.Color(horizon.x, horizon.y, horizon.z).multiplyScalar(fogColorScale);
    scene.fog = new THREE.FogExp2(fogColor, fogDensity);
    this.renderer.toneMappingExposure = exposure;
    return { sunIntensity: sun.intensity, sunDir: this.sunDir.clone() };
  }

  // Keep a tight shadow box centred on the player, snapped to whole shadow-map
  // texels so shadow edges don't shimmer as you walk.
  updateShadow(focus) {
    if (!this.sun) return;
    const R = this.q.shadowRadius, texel = (2 * R) / this.q.shadowSize;
    const L = this.sunDir;
    _right.crossVectors(L, THREE.Object3D.DEFAULT_UP).normalize();
    _up.crossVectors(_right, L).normalize();
    const a = Math.round(focus.dot(_right) / texel) * texel;
    const b = Math.round(focus.dot(_up) / texel) * texel;
    const c = focus.dot(L);
    _v.copy(_right).multiplyScalar(a).addScaledVector(_up, b).addScaledVector(L, c);
    this.sun.target.position.copy(_v);
    this.sun.position.copy(_v).addScaledVector(L, 300);
    this.sun.target.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- post chain
  setupPost(scene, camera, vmScene, vmCamera) {
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.q.msaa });
    const composer = (this.composer = new EffectComposer(r, target));
    composer.setPixelRatio(r.getPixelRatio());
    composer.setSize(window.innerWidth, window.innerHeight);

    composer.addPass(new RenderPass(scene, camera));

    // Ambient occlusion is soft and low-frequency, so computing it at HALF
    // resolution (a quarter of the pixels) looks nearly identical and is ~4x cheaper.
    const gtao = (this.gtao = new GTAOPass(scene, camera, size.x >> 1, size.y >> 1));
    const fullSetSize = gtao.setSize.bind(gtao);
    gtao.setSize = (w, h) => fullSetSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1.5, scale: 1.2, samples: 16 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 10, rings: 3, samples: 16 }); // more denoise = no blotchy crawl
    gtao.blendIntensity = 0.9;
    // Leaves and grass are alpha-cut cards: exclude them from the AO depth pass
    gtao.overrideVisibility = function () {
      const cache = (this._visCache = new Map());
      this.scene.traverse((o) => {
        if (o.userData.noAO || o.isPoints || o.isLine || o.isSprite) { cache.set(o, o.visible); o.visible = false; }
      });
    };
    gtao.restoreVisibility = function () { for (const [o, v] of this._visCache) o.visible = v; };
    gtao.enabled = this.q.ao;
    composer.addPass(gtao);

    const vm = (this.vmPass = new RenderPass(vmScene, vmCamera));
    vm.clear = false;
    vm.clearDepth = true;
    composer.addPass(vm);

    // High threshold: only genuinely hot things (flashes, tracers, the sun) glow —
    // not tiny specular glints, which would otherwise sparkle and flicker.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x >> 1, size.y >> 1), 0.22, 0.45, 4.0);
    this.bloom.enabled = this.q.bloom;
    composer.addPass(this.bloom);

    composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    composer.addPass(this.grade);
  }

  setGrade({ saturation, contrast, tint, vignette } = {}) {
    const u = this.grade.uniforms;
    if (saturation !== undefined) u.uSaturation.value = saturation;
    if (contrast !== undefined) u.uContrast.value = contrast;
    if (tint) u.uTint.value.set(tint);
    if (vignette !== undefined) u.uVignette.value = vignette;
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(window.innerWidth, window.innerHeight);
  }

  // ---------------------------------------------------------------- dynamic resolution
  // Consoles do this constantly: if frames are taking too long, render fewer
  // pixels (the image is stretched back to full size). When frames are fast
  // again for a while, step back up. Changes are rare (each one reallocates buffers).
  setScale(s) {
    this.scale = s;
    this.renderer.setPixelRatio(this.basePixelRatio * s);
    this.resize();
  }

  updateDynamicResolution(frameTime, target, now) {
    const missed = frameTime > target * 1.3 ? 1 : 0; // a missed display refresh
    this._miss = this._miss * 0.94 + missed * 0.06;
    this._ft = (this._ft ?? target) * 0.9 + frameTime * 0.1; // smoothed frame time
    const since = now - this._lastChange;
    if (this._miss > 0.3 && since > 1.5 && this.scale > this.q.minScale + 0.001) {
      // GPU time scales roughly with pixel count (scale²), so estimate the
      // scale that fits the budget and jump straight there: one resize, not three.
      const guess = this.scale * Math.sqrt(target / this._ft) * 0.95;
      const next = Math.max(this.q.minScale, Math.min(this.scale - 0.1, Math.round(guess * 20) / 20));
      this.setScale(next);
      // if we only just stepped UP, wait longer before trying again (stops ping-ponging)
      if (since < this._raiseWait + 3) this._raiseWait = Math.min(40, this._raiseWait * 2);
      this._lastChange = now;
      this._miss = 0.15;
    } else if (this._miss < 0.02 && since > this._raiseWait && this.scale < 1) {
      this.setScale(Math.min(1, this.scale + 0.1));
      this._lastChange = now;
    }
  }

  // Where is the sun on screen, and can we see it? (cheap: one ray toward it)
  updateFlare(camera, world, dt) {
    const u = this.grade.uniforms;
    _v.copy(camera.position).addScaledVector(this.sunDir, 1000).project(camera);
    let target = 0;
    if (_v.z < 1 && Math.abs(_v.x) < 1.3 && Math.abs(_v.y) < 1.3) {
      _right.copy(camera.position).addScaledVector(this.sunDir, 400);
      if (world.lineOfSight(camera.position, _right)) target = Math.min(1, this.sun.intensity / 4) * (1 - Math.max(0, Math.hypot(_v.x, _v.y) - 0.3) / 1.2);
      u.uSun.value.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    }
    u.uSunVis.value += (Math.max(0, target) - u.uSunVis.value) * Math.min(1, dt * 10);
    u.uAspect.value = camera.aspect;
  }

  render(dt, { showViewmodel = true, hurt = 0 } = {}) {
    this.frames = (this.frames || 0) + 1;
    this.grade.uniforms.uFrame.value = (this.grade.uniforms.uFrame.value + 1) % 64;
    this.grade.uniforms.uHurt.value = hurt;
    this.vmPass.enabled = showViewmodel;
    this.composer.render(dt);
  }
}

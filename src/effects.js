// =============================================================================
// effects.js — particles, bullet holes, tracers, muzzle flashes, brass.
//
// The golden rule of game VFX: NEVER create/destroy objects mid-fight. Every
// effect here comes from a POOL that is allocated once and recycled. Creating
// (or adding/removing lights) at runtime causes stutters — in Three.js, a
// change in the number of lights even forces every shader to recompile.
// =============================================================================
import * as THREE from 'three';
import { makeBulletHoleTexture, makeFlashTexture } from './textures.js';

// ---------------------------------------------------------------------------
// GPU particle system: thousands of soft dots drawn in ONE draw call.
// ---------------------------------------------------------------------------
class Particles {
  // fade: 'out' = start opaque and fade away (sparks, dust); 'smoke' = fade in,
  // hold, then thin out slowly (smoke screens)
  constructor(scene, max, additive, fade = 'out') {
    this.max = max;
    this.fade = fade;
    this.count = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    // simulation-only data
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    const attr = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', attr(this.pos, 3));
    geo.setAttribute('pColor', attr(this.col, 3));
    geo.setAttribute('pSize', attr(this.size, 1));
    geo.setAttribute('pAlpha', attr(this.alpha, 1));
    this.geo = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uBillow: { value: fade === 'smoke' ? 1 : 0 } },
      vertexShader: /* glsl */ `
        attribute vec3 pColor; attribute float pSize; attribute float pAlpha;
        uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = max(1.5, pSize * uScale / -mv.z);   // world-size -> pixels
          vColor = pColor; vAlpha = pAlpha;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uBillow;
        varying vec3 vColor; varying float vAlpha;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) { // smooth value noise
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          if (d > 1.0) discard;
          vec3 col = vColor;
          float a = vAlpha * (1.0 - d * d);
          if (uBillow > 0.5) {
            // smoke: lumpy edges (noise seeded by the puff's colour) and a
            // sunlit top / shaded underside, so a cloud of puffs looks billowy
            vec2 q = gl_PointCoord * 3.0 + vColor.r * 61.0;
            float n = vnoise(q) * 0.6 + vnoise(q * 2.3) * 0.4;
            a *= smoothstep(0.15, 0.75, n + 0.45 - d * 0.45);
            col *= mix(1.18, 0.78, gl_PointCoord.y);
          }
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(p, v, color, s0, s1, alpha, life, gravity = 0, drag = 0) {
    if (this.count >= this.max) return;
    const i = this.count++, i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha;
    this.size[i] = s0; this.alpha[i] = alpha;
    this.life[i] = 0; this.maxLife[i] = life;
    this.grav[i] = gravity; this.drag[i] = drag;
  }

  _copy(d, s) { // move particle s into slot d (swap-remove keeps the array packed)
    for (let k = 0; k < 3; k++) {
      this.pos[d * 3 + k] = this.pos[s * 3 + k];
      this.vel[d * 3 + k] = this.vel[s * 3 + k];
      this.col[d * 3 + k] = this.col[s * 3 + k];
    }
    for (const a of [this.size, this.alpha, this.life, this.maxLife, this.s0, this.s1, this.a0, this.grav, this.drag]) a[d] = a[s];
  }

  update(dt) {
    for (let i = 0; i < this.count;) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) { this._copy(i, --this.count); continue; }
      const t = this.life[i] / this.maxLife[i], i3 = i * 3;
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i3 + 1] -= this.grav[i] * dt;
      this.vel[i3] *= damp; this.vel[i3 + 1] *= damp; this.vel[i3 + 2] *= damp;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.alpha[i] = this.fade === 'smoke' ? this.a0[i] * Math.min(1, t * 8) * Math.min(1, (1 - t) * 2.2) : this.a0[i] * (1 - t);
      i++;
    }
    for (const name of ['position', 'pColor', 'pSize', 'pAlpha']) this.geo.attributes[name].needsUpdate = true;
    this.geo.setDrawRange(0, this.count);
  }
}

// Colours per surface: [dust, debris]
const SURFACE = {
  dirt: [0x8a7458, 0x4a3b2a],
  sand: [0xa8946c, 0x6b5a3e],
  concrete: [0xa29d94, 0x77736b],
  wood: [0x9a7a52, 0x6b4f2e],
  metal: [0x6f6f6a, 0x444444],
  cloth: [0x6d6d52, 0x45452f],
  rock: [0x8d867c, 0x5e5a54],
  grass: [0x77704e, 0x4a4630],
  asphalt: [0x5a5856, 0x333333],
};

const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color();

export class Effects {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.audio = null;
    this.dust = new Particles(scene, 3000, false);
    this.sparks = new Particles(scene, 800, true);
    this.smoke = new Particles(scene, 1400, false, 'smoke');

    // Bullet-hole decals (ring buffer: the oldest hole is reused)
    const holeTex = makeBulletHoleTexture();
    this.decalMat = new THREE.MeshStandardMaterial({ map: holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, roughness: 1 });
    this.decals = [];
    this.decalIdx = 0;
    const decalGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 250; i++) {
      const m = new THREE.Mesh(decalGeo, this.decalMat);
      m.visible = false;
      m.receiveShadow = true;
      scene.add(m);
      this.decals.push(m);
    }

    // Tracers: a stretched glowing box from head to tail
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    tracerGeo.translate(0, 0, 0.5);
    this.tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 3.5, 1.2), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.tracerPool = [];
    for (let i = 0; i < 60; i++) {
      const m = new THREE.Mesh(tracerGeo, this.tracerMat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracerPool.push(m);
    }

    // Muzzle flash sprites + a FIXED pool of point lights (never added/removed)
    const flashTex = makeFlashTexture();
    this.flashes = [];
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: new THREE.Color(7, 5, 3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.visible = false;
      scene.add(s);
      this.flashes.push({ sprite: s, t: 0 });
    }
    this.flashIdx = 0;
    this.lights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 16, 2);
      scene.add(l);
      this.lights.push({ light: l, t: 0 });
    }
    this.lightIdx = 0;

    // Ejected brass casings
    const shellGeo = new THREE.CylinderGeometry(0.0048, 0.0048, 0.045, 6);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, roughness: 0.3, metalness: 1 });
    this.shells = [];
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(shellGeo, brass);
      m.visible = false;
      scene.add(m);
      this.shells.push({ mesh: m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), floor: 0, life: 0, bounced: false });
    }
    this.shellIdx = 0;
  }

  // Dust motes: tiny specks drifting in the air around you, the way sunlit
  // dust looks in any real outdoor shot. They live in a box that follows the
  // camera and wrap around its edges.
  _initMotes() {
    const n = 260, pos = new Float32Array(n * 3);
    this.moteVel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) pos[i * 3 + k] = (Math.random() - 0.5) * 16;
      this.moteVel[i * 3] = (Math.random() - 0.5) * 0.15;
      this.moteVel[i * 3 + 1] = (Math.random() - 0.4) * 0.06;
      this.moteVel[i * 3 + 2] = (Math.random() - 0.5) * 0.15;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.motes = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff2d8, size: 0.018, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.motes.frustumCulled = false;
    this.motesOrigin = new THREE.Vector3();
    this.scene.add(this.motes);
  }

  _updateMotes(dt) {
    if (!this.camera) return;
    if (!this.motes) this._initMotes();
    const p = this.motes.geometry.attributes.position, a = p.array, c = this.camera.position, v = this.moteVel;
    const cam = [c.x, c.y, c.z];
    for (let i = 0; i < a.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        a[i + k] += v[i + k] * dt;
        const rel = a[i + k] - cam[k];
        if (rel > 8) a[i + k] -= 16; else if (rel < -8) a[i + k] += 16; // wrap around the camera
      }
    }
    p.needsUpdate = true;
  }

  // A puff of grey smoke drifting from the barrel after a shot
  muzzleSmoke(pos, dir) {
    for (let i = 0; i < 3; i++) {
      _c.setRGB(0.55, 0.55, 0.53);
      _v.copy(dir).multiplyScalar(0.6 + Math.random() * 0.8).add(_p.set((Math.random() - 0.5) * 0.3, 0.25 + Math.random() * 0.2, (Math.random() - 0.5) * 0.3));
      this.dust.spawn(pos, _v, _c, 0.06, 0.55 + Math.random() * 0.3, 0.16, 1 + Math.random() * 0.8, -0.25, 1.5);
    }
  }

  setPixelScale(px) {
    this.dust.material.uniforms.uScale.value = px;
    this.sparks.material.uniforms.uScale.value = px;
    this.smoke.material.uniforms.uScale.value = px;
  }

  // Random direction in a cone around `normal` (spread 0..1)
  _scatter(normal, spread, speed) {
    _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(spread * 2);
    return _v.add(normal).normalize().multiplyScalar(speed * (0.5 + Math.random()));
  }

  impact(point, normal, surface = 'concrete') {
    const [dustHex, debrisHex] = SURFACE[surface] || SURFACE.concrete;
    const big = surface === 'dirt' || surface === 'sand' || surface === 'grass';
    for (let i = 0; i < (big ? 10 : 7); i++) {
      _c.setHex(dustHex).multiplyScalar(0.85 + Math.random() * 0.3);
      this.dust.spawn(point, this._scatter(normal, 0.6, big ? 2.2 : 1.6), _c, 0.08, big ? 0.9 : 0.6, 0.55, 0.7 + Math.random() * 0.8, 0.6, 2.5);
    }
    for (let i = 0; i < 7; i++) {
      _c.setHex(debrisHex);
      this.dust.spawn(point, this._scatter(normal, 0.8, 5), _c, 0.025, 0.02, 1, 0.5 + Math.random() * 0.4, 9.8, 0.5);
    }
    if (surface === 'metal') {
      for (let i = 0; i < 12; i++) {
        _c.setRGB(4, 1.8, 0.5);
        this.sparks.spawn(point, this._scatter(normal, 0.9, 7), _c, 0.03, 0.01, 1, 0.2 + Math.random() * 0.3, 9.8, 0.8);
      }
    }
    this.decal(point, normal, surface === 'dirt' || surface === 'sand' ? 0.07 : 0.055);
  }

  blood(point, dir) {
    for (let i = 0; i < 9; i++) {
      _c.setRGB(0.22, 0.02, 0.015);
      _p.copy(dir).multiplyScalar(1.5);
      this.dust.spawn(point, this._scatter(_p.normalize(), 0.7, 2.5), _c, 0.05, 0.35, 0.8, 0.35 + Math.random() * 0.25, 2, 3);
    }
  }

  // Frag grenade: white-hot flash, fragments, a rolling dust column, dirt
  // thrown up, and a scorch mark left on the ground.
  explosion(pos, normal, ground) {
    const up = _p.set(0, 1, 0);
    const c = new THREE.Color();
    for (let i = 0; i < 26; i++) { // fireball
      c.setRGB(7, 3.2 + Math.random(), 1).multiplyScalar(0.6 + Math.random() * 0.6);
      this.sparks.spawn(pos, this._scatter(up, 1.2, 9), c, 0.5, 2.2, 1, 0.1 + Math.random() * 0.15, 0, 7);
    }
    for (let i = 0; i < 40; i++) { // hot fragments
      c.setRGB(6, 2.4, 0.6);
      this.sparks.spawn(pos, this._scatter(up, 1.6, 26), c, 0.045, 0.02, 1, 0.25 + Math.random() * 0.4, 9.8, 0.4);
    }
    for (let i = 0; i < 55; i++) { // dust and smoke, drifting up and spreading
      const grey = 0.32 + Math.random() * 0.22;
      c.setRGB(grey * 1.05, grey, grey * 0.88);
      const v = this._scatter(up, 1.1, 4.5);
      this.dust.spawn(pos, v, c, 0.8, 5 + Math.random() * 3, 0.75, 2.5 + Math.random() * 3, -0.35, 1.3);
    }
    for (let i = 0; i < 34; i++) { // clods of dirt
      c.setHex(0x3e3528);
      this.dust.spawn(pos, this._scatter(up, 0.8, 11), c, 0.07, 0.06, 1, 1 + Math.random() * 0.8, 9.8, 0.2);
    }
    this.muzzleFlash(_v.copy(pos).addScaledVector(up, 0.5), false, 5);
    this.flashLight(_v, 900);
    if (ground) this.decal(ground, normal, 2.6); // scorch
  }

  // Flashbang: no fireball or fragments, just a blinding white burst of
  // burning magnesium and a little puff of grey smoke.
  flashbang(pos) {
    const up = _p.set(0, 1, 0), c = new THREE.Color();
    for (let i = 0; i < 30; i++) {
      c.setRGB(9, 9, 8.4);
      this.sparks.spawn(pos, this._scatter(up, 1.6, 7), c, 0.25, 1.4, 1, 0.05 + Math.random() * 0.08, 0, 8);
    }
    for (let i = 0; i < 14; i++) {
      const g = 0.55 + Math.random() * 0.15;
      c.setRGB(g, g, g);
      this.dust.spawn(pos, this._scatter(up, 1.2, 1.5), c, 0.4, 2.4, 0.5, 1.5 + Math.random() * 1.5, -0.2, 1.5);
    }
    this.flashLight(_v.copy(pos).addScaledVector(up, 0.4), 3000);
  }

  // Claymore: a flash, then a flat FAN of hot steel balls and a wall of dust
  // blasted forward (dir), instead of the round burst of a grenade.
  claymore(pos, dir, ground) {
    const up = _p.set(0, 1, 0), c = new THREE.Color(), fan = new THREE.Vector3();
    const turn = (a, speed, lift) => { // dir rotated a radians about the vertical
      const cs = Math.cos(a), sn = Math.sin(a);
      return fan.set(dir.x * cs + dir.z * sn, 0, -dir.x * sn + dir.z * cs).multiplyScalar(speed).setY(lift);
    };
    for (let i = 0; i < 16; i++) { // flash
      c.setRGB(7, 3.2 + Math.random(), 1).multiplyScalar(0.6 + Math.random() * 0.5);
      this.sparks.spawn(pos, this._scatter(up, 1.2, 5), c, 0.4, 1.8, 1, 0.08 + Math.random() * 0.1, 0, 7);
    }
    for (let i = 0; i < 70; i++) { // steel balls: fast, flat, ~60° wide
      c.setRGB(6, 2.6, 0.7);
      this.sparks.spawn(pos, turn((Math.random() - 0.5) * 1.1, 45 + Math.random() * 30, Math.random() * 4), c, 0.04, 0.02, 1, 0.15 + Math.random() * 0.25, 2, 0.1);
    }
    for (let i = 0; i < 45; i++) { // dust and smoke thrown forward
      const grey = 0.34 + Math.random() * 0.2;
      c.setRGB(grey * 1.05, grey, grey * 0.88);
      this.dust.spawn(pos, turn((Math.random() - 0.5) * 1.2, 3 + Math.random() * 6, 0.4 + Math.random() * 1.6), c, 0.7, 4 + Math.random() * 3, 0.7, 2 + Math.random() * 2.5, -0.3, 1.4);
    }
    this.flashLight(_v.copy(pos).addScaledVector(up, 0.4), 900);
    if (ground) this.decal(ground, up, 1.4); // scorch where it stood
  }

  // One billow of a smoke screen. Puffs spawn around the canister, roll
  // outward, swell to several metres and hang there — a few hundred of them
  // overlapping make a wall you can't see through.
  smokePuff(pos, r) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * Math.max(0.3, r * 0.65);
    _p.set(pos.x + Math.cos(a) * d, pos.y + 0.4 + Math.random() * Math.max(0.4, r * 0.35), pos.z + Math.sin(a) * d);
    _v.set(Math.cos(a) * (0.4 + Math.random() * 0.9), 0.15 + Math.random() * 0.3, Math.sin(a) * (0.4 + Math.random() * 0.9));
    const g = 0.48 + Math.random() * 0.2; // light and dark billows give it depth
    _c.setRGB(g, g * 0.99, g * 0.96);
    this.smoke.spawn(_p, _v, _c, 2.2, 5.5 + Math.random() * 3, 0.75, 9 + Math.random() * 5, -0.02, 0.5);
  }

  decal(point, normal, size) {
    const m = this.decals[this.decalIdx];
    this.decalIdx = (this.decalIdx + 1) % this.decals.length;
    m.position.copy(point).addScaledVector(normal, 0.004);
    _p.copy(point).add(normal);
    m.lookAt(_p);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size * (0.8 + Math.random() * 0.4));
    m.visible = true;
  }

  muzzleFlash(pos, withLight = true, size = 0.5) {
    const f = this.flashes[this.flashIdx];
    this.flashIdx = (this.flashIdx + 1) % this.flashes.length;
    f.sprite.position.copy(pos);
    f.sprite.scale.setScalar(size * (0.8 + Math.random() * 0.5));
    f.sprite.material.rotation = Math.random() * Math.PI * 2;
    f.sprite.visible = true;
    f.t = 0.04;
    if (withLight) this.flashLight(pos, 30);
  }

  flashLight(pos, intensity) {
    const l = this.lights[this.lightIdx];
    this.lightIdx = (this.lightIdx + 1) % this.lights.length;
    l.light.position.copy(pos);
    l.light.intensity = intensity;
    l.t = 0.05;
  }

  acquireTracer() {
    const m = this.tracerPool.find((t) => !t.visible);
    if (m) m.visible = true;
    return m || null;
  }

  drawTracer(m, head, tail, width = 0.025) {
    const len = head.distanceTo(tail);
    if (len < 0.01) return;
    m.position.copy(head);
    m.lookAt(tail);
    m.scale.set(width, width, len);
  }

  releaseTracer(m) { if (m) m.visible = false; }

  ejectShell(pos, vel) {
    const s = this.shells[this.shellIdx];
    this.shellIdx = (this.shellIdx + 1) % this.shells.length;
    s.mesh.position.copy(pos);
    s.mesh.visible = true;
    s.vel.copy(vel);
    s.spin.set(Math.random() * 30, Math.random() * 30, Math.random() * 30);
    const hit = this.world.raycast(pos, new THREE.Vector3(0, -1, 0), 20);
    s.floor = hit ? hit.point.y + 0.005 : 0.005;
    s.life = 6;
    s.bounced = false;
  }

  update(dt) {
    this._updateMotes(dt);
    this.dust.update(dt);
    this.sparks.update(dt);
    this.smoke.update(dt);
    for (const f of this.flashes) if (f.t > 0 && (f.t -= dt) <= 0) f.sprite.visible = false;
    for (const l of this.lights) {
      if (l.t > 0) { l.t -= dt; if (l.t <= 0) l.light.intensity = 0; }
    }
    for (const s of this.shells) {
      if (!s.mesh.visible) continue;
      s.life -= dt;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      if (s.vel.lengthSq() < 0.0001 && s.mesh.position.y <= s.floor + 0.001) continue; // at rest
      s.vel.y -= 9.81 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      if (s.mesh.position.y < s.floor) {
        s.mesh.position.y = s.floor;
        if (!s.bounced && this.audio) this.audio.shell(s.mesh.position);
        s.bounced = true;
        s.vel.y *= -0.3;
        s.vel.x *= 0.5; s.vel.z *= 0.5;
        s.spin.multiplyScalar(0.5);
        if (Math.abs(s.vel.y) < 0.3) { s.vel.set(0, 0, 0); s.mesh.rotation.x = Math.PI / 2; }
      }
    }
  }
}

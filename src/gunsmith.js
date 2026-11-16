// =============================================================================
// gunsmith.js — builds a 3D gun from a weapon config (base gun + attachments).
//
// Used for the first-person viewmodel AND the armory preview. Every gun is
// made from side-profile shapes extruded sideways with bevelled edges, plus
// cylinders and rounded boxes. Attachments are separate parts placed on the
// rail, the muzzle or under the handguard, so swapping a part in the armory
// rebuilds the gun with that part.
//
// SIGHT ALIGNMENT: every sight (iron, red dot, scope...) is built so its
// aiming point sits on one line, height SY above the bore. The aim-down-sights
// pose moves the gun so that line passes through the camera — so the reticle
// lands exactly on the centre of the screen.
// =============================================================================
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { ATTACHMENTS } from './loadout.js';
import { PAINTS, paintTexture } from './paint.js';
import { woodTexture } from './textures.js';

const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const Z0 = 0.12; // u (metres forward from the back of the receiver) maps to z = Z0 - u

// ---------------------------------------------------------------- helpers
function maker(group) {
  const add = (geo, mat, parent = group) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };
  const box = (w, h, d, mat, x, y, z, parent = group, r = 0.003) => {
    const m = add(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), mat, parent);
    m.position.set(x, y, z);
    return m;
  };
  const cyl = (r, len, mat, x, y, z, parent = group, seg = 18, r2 = r) => {
    const m = add(new THREE.CylinderGeometry(r2, r, len, seg), mat, parent);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    return m;
  };
  // Side-profile shape (u forward, v up) extruded sideways with bevelled edges
  const profile = (pts, width, mat, { bevel = 0.003, x = 0, parent = group } = {}) => {
    const s = new THREE.Shape();
    pts.forEach(([u, v], i) => (i ? s.lineTo(u, v) : s.moveTo(u, v)));
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.001, width - bevel * 2), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 });
    g.translate(0, 0, -(width - bevel * 2) / 2);
    g.rotateY(Math.PI / 2);
    g.translate(x, 0, Z0);
    g.computeVertexNormals();
    return add(g, mat, parent);
  };
  // Capsule stretched between two points (forearm/sleeve)
  const limb = (from, to, r, mat) => {
    const g = new THREE.CapsuleGeometry(r, Math.max(0.01, from.distanceTo(to) - r * 2), 4, 12);
    g.rotateX(Math.PI / 2);
    const m = add(g, mat);
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.lookAt(to);
    return m;
  };
  return { add, box, cyl, profile, limb };
}

function hand(box, M, x, y, z, rotX = 0, rotZ = 0, parent) {
  const h = new THREE.Group();
  h.position.set(x, y, z);
  h.rotation.set(rotX, 0, rotZ);
  box(0.05, 0.085, 0.07, M.glove, 0, 0, 0, h, 0.012);
  box(0.052, 0.022, 0.06, M.glove, 0.0, 0.03, -0.045, h, 0.009).rotation.x = 0.5;
  box(0.05, 0.022, 0.058, M.glove, 0.0, 0.005, -0.05, h, 0.009).rotation.x = 0.7;
  box(0.048, 0.02, 0.052, M.glove, 0.0, -0.02, -0.048, h, 0.009).rotation.x = 0.9;
  box(0.02, 0.02, 0.05, M.glove, -0.03, 0.02, -0.02, h, 0.008).rotation.y = 0.5;
  parent.add(h);
  return h;
}

export function flashMesh(tex) {
  const mat = new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(7, 4.8, 3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const g = new THREE.Group();
  const front = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.14), mat);
  const side = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.08), mat);
  side.rotation.y = Math.PI / 2;
  side.position.z = -0.07;
  g.add(front, side);
  g.visible = false;
  return g;
}

// Reticle textures for the red dot and holographic sights (drawn once)
const reticles = {};
function reticleTexture(type) {
  if (reticles[type]) return reticles[type];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const glow = (r, a) => { const gr = g.createRadialGradient(64, 64, 0, 64, 64, r); gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(1, 'rgba(255,255,255,0)'); return gr; };
  g.fillStyle = glow(type === 'holo' ? 6 : 7, 1);
  g.fillRect(0, 0, 128, 128);
  if (type === 'holo') { // 65 MOA ring around the dot
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 2.2;
    g.beginPath(); g.arc(64, 64, 44, 0, Math.PI * 2); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return (reticles[type] = t);
}

// Walnut wood (the 'Walnut wood' finish; the bolt-action's default). The
// texture's grain runs along u, which is along the gun on the side faces.
let woodMat = null;
function walnut() {
  if (woodMat) return woodMat;
  const t = woodTexture(17);
  t.map.repeat.set(3, 3);
  t.normalMap.repeat.set(3, 3);
  return (woodMat = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.3, 0.3), roughness: 0.5, metalness: 0 }));
}

// The paint job: three materials per (finish, metal) pair, shared by all guns.
//   metal: receiver, barrel, rail and optics (anodised, coated or bare steel)
//   furn:  furniture — stock, pistol grip, handguard (wood for 'walnut')
//   poly:  other polymer parts — magazines, foregrips (painted, or black next to wood)
const finishes = new Map();
function finish(M, camo, metalId) {
  const key = `${camo}|${metalId}`;
  if (finishes.has(key)) return finishes.get(key);
  const mt = ATTACHMENTS.metal[metalId] || ATTACHMENTS.metal.black;
  const metal = M.gunBlack.clone();
  metal.color.set(mt.colors[0]);
  // The black finish keeps the scanned plate's grime; it's too dark to tint, so
  // coloured finishes drop it and keep only its fine scratches (the normal map)
  if (metalId !== 'black') metal.map = null;
  if (mt.metalness !== undefined) metal.metalness = mt.metalness;
  if (mt.roughness !== undefined) metal.roughness = mt.roughness;
  const fin = ATTACHMENTS.camo[camo] || ATTACHMENTS.camo.black;
  let poly = M.gunPolymer;
  if (!fin.wood) {
    const paint = PAINTS[fin.paint];
    poly = M.gunPolymer.clone();
    if (paint.pattern) { // camo: the shared pattern, tiled small enough for a gun
      const tex = paintTexture(fin.paint).map.clone();
      tex.repeat.set(8, 8);
      tex.needsUpdate = true;
      poly.map = tex;
      poly.color.set(0xffffff);
    } else poly.color.set(paint.color);
  }
  const f = { metal, poly, furn: fin.wood ? walnut() : poly };
  finishes.set(key, f);
  return f;
}

// The lit reticle's colour (an HDR colour: brighter than white makes it glow)
const reticleGlow = (cfg) => new THREE.Color(...(ATTACHMENTS.reticle[cfg.reticle] || ATTACHMENTS.reticle.red).glow);

// ---------------------------------------------------------------- per-gun geometry
// Lengths in metres along u. railTop = top of the accessory rail (optics sit on it).
// Real guns' sizes, so a gun is the right size in a soldier's hands:
//   rifle  an M4-type carbine: 14.5" barrel (0.37 m), ~0.86 m overall with the stock out
//   smg    MP5-sized: ~0.66 m          dmr  M110-sized: ~1.07 m
//   lmg    M249-sized: ~1.03 m         bolt M24-sized: ~1.1 m
const BODY = {
  rifle: { recv: 0.21, recvH: 0.03, guard: { short: 0.38, std: 0.44, long: 0.52 }, barrelEnd: { short: 0.48, std: 0.58, long: 0.66 }, barrelR: 0.0085, railTop: 0.0475 },
  smg: { recv: 0.18, recvH: 0.028, guard: { short: 0.24, std: 0.28, long: 0.33 }, barrelEnd: { short: 0.29, std: 0.34, long: 0.41 }, barrelR: 0.008, railTop: 0.0455 },
  dmr: { recv: 0.26, recvH: 0.036, guard: { short: 0.48, std: 0.53, long: 0.6 }, barrelEnd: { short: 0.66, std: 0.74, long: 0.84 }, barrelR: 0.01, railTop: 0.0535 },
  lmg: { recv: 0.3, recvH: 0.04, guard: { short: 0.46, std: 0.5, long: 0.55 }, barrelEnd: { short: 0.62, std: 0.7, long: 0.8 }, barrelR: 0.012, railTop: 0.0575 },
  bolt: { recv: 0.24, recvH: 0.022, guard: { short: 0.6, std: 0.62, long: 0.66 }, barrelEnd: { short: 0.72, std: 0.78, long: 0.86 }, barrelR: 0.0095, railTop: 0.034 },
};
// The stock behind the receiver is drawn 0.315 m long; real ones are ~0.27 m
// (a carbine stock half way out). STOCK shortens everything behind u = 0.
const STOCK = 0.86;
const stockPts = (pts) => pts.map(([u, v]) => [u < 0 ? u * STOCK : u, v]);

// Build the gun. Returns everything the viewmodel animates.
export function buildGun(M, cfg, { hands = true, flashTex = null } = {}) {
  if (cfg.base === 'pistol') return buildPistol(M, cfg, { hands, flashTex });
  const g = new THREE.Group();
  const { box, cyl, profile, limb } = maker(g);
  const F = finish(M, cfg.camo, cfg.metal), metal = F.metal, poly = F.furn;
  const B = BODY[cfg.base], barrel = cfg.barrel || 'std';
  const guardEnd = B.guard[barrel], barrelEnd = B.barrelEnd[barrel];
  const z = (u) => Z0 - u;
  const top = B.recvH;

  // --- receiver & body
  if (cfg.base === 'bolt') {
    profile(stockPts([[-0.33, -0.07], [-0.12, -0.03], [0.0, -0.03], [0.02, -0.06], [0.06, -0.07], [0.1, -0.035], [0.62, -0.025], [0.62, 0.0], [0.0, 0.004], [-0.12, -0.0], [-0.33, 0.02]]), 0.045, poly, { bevel: 0.007 }); // one-piece wooden stock
    cyl(0.017, 0.24, metal, 0, 0.012, z(0.12));                          // round receiver
    const boltG = new THREE.Group(); boltG.position.set(0.018, 0.012, z(0.2)); g.add(boltG);
    box(0.04, 0.007, 0.008, metal, 0.02, 0, 0, boltG, 0.002);              // bolt handle
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), metal); knob.position.set(0.042, -0.004, 0); boltG.add(knob);
    g.userData.bolt = boltG;
    box(0.022, 0.03, 0.07, metal, 0, -0.03, z(0.14));                      // trigger guard / floorplate
  } else {
    const recvBot = cfg.base === 'lmg' ? -0.03 : -0.012;
    profile([[0, recvBot], [B.recv, recvBot], [B.recv, top], [0.03, top + 0.002], [0.0, top - 0.008]], cfg.base === 'lmg' ? 0.06 : 0.046, metal);
    profile([[0.02, -0.012], [B.recv * 0.82, -0.012], [B.recv * 0.82, -0.04], [B.recv * 0.6, -0.058], [B.recv * 0.34, -0.058], [B.recv * 0.24, -0.044], [0.02, -0.038]], 0.044, metal); // lower + magwell
    profile([[0.0, -0.036], [0.036, -0.036], [0.022, -0.135], [-0.018, -0.13]], 0.03, F.furn, { bevel: 0.006 }); // pistol grip
    profile([[0.028, -0.04], [0.075, -0.04], [0.075, -0.048], [0.028, -0.06], [0.02, -0.05]], 0.012, metal, { bevel: 0.002 });
    box(0.003, 0.016, 0.048, M.rubber, 0.0235, 0.008, z(B.recv * 0.48), g, 0.001);           // ejection port
    box(0.03, 0.012, 0.022, metal, 0, top, z(-0.012));                                        // charging handle
    if (cfg.base === 'lmg') box(0.062, 0.012, 0.2, metal, 0, top + 0.006, z(0.15), g, 0.003); // feed cover
    // handguard (with M-LOK slots) + top rail along receiver and handguard
    const gb = cfg.base === 'dmr' ? -0.034 : -0.03, gt = top + 0.004;
    profile([[B.recv, gb], [guardEnd, gb], [guardEnd, gt - 0.006], [guardEnd - 0.01, gt], [B.recv + 0.01, gt], [B.recv, gt - 0.006]], cfg.base === 'smg' ? 0.05 : 0.058, F.furn, { bevel: 0.006 });
    for (let u = B.recv + 0.04; u < guardEnd - 0.03; u += 0.045) for (const sx of [-1, 1]) box(0.003, 0.009, 0.028, M.rubber, sx * 0.0285, 0.0, z(u), g, 0.001);
    const railLen = guardEnd - 0.015;
    box(0.024, 0.01, railLen, metal, 0, B.railTop - 0.009, z(railLen / 2 + 0.0));
    for (let u = 0.01; u < railLen - 0.005; u += 0.019) box(0.027, 0.005, 0.009, metal, 0, B.railTop - 0.0025, z(u), g, 0.001);
  }
  // barrel + gas block
  const barrelStart = cfg.base === 'bolt' ? 0.24 : guardEnd - 0.02;
  cyl(B.barrelR, barrelEnd - barrelStart, metal, 0, cfg.base === 'bolt' ? 0.012 : 0, z((barrelStart + barrelEnd) / 2), g, 16);
  const boreY = cfg.base === 'bolt' ? 0.012 : 0;

  // --- muzzle device
  const mz = cfg.attachments.muzzle;
  let muzzleU = barrelEnd + 0.05;
  if (mz === 'suppressor') { cyl(0.019, 0.17, M.rubber, 0, boreY, z(barrelEnd + 0.08), g, 20); muzzleU = barrelEnd + 0.165; }
  else if (mz === 'compensator') { cyl(0.014, 0.055, metal, 0, boreY, z(barrelEnd + 0.025)); for (const k of [0, 1, 2]) box(0.012, 0.004, 0.006, M.rubber, 0, boreY + 0.013, z(barrelEnd + 0.012 + k * 0.014), g, 0.001); muzzleU = barrelEnd + 0.055; }
  else if (mz === 'brake') { box(0.034, 0.024, 0.06, metal, 0, boreY, z(barrelEnd + 0.03), g, 0.004); for (const k of [0, 1, 2]) for (const sx of [-1, 1]) box(0.004, 0.012, 0.007, M.rubber, sx * 0.017, boreY, z(barrelEnd + 0.012 + k * 0.016), g, 0.001); muzzleU = barrelEnd + 0.06; }
  else { cyl(0.012, 0.05, metal, 0, boreY, z(barrelEnd + 0.025)); for (const k of [0, 1, 2]) box(0.026, 0.003, 0.006, M.rubber, 0, boreY, z(barrelEnd + 0.008 + k * 0.012), g, 0.001); }

  // --- stock
  const st = cfg.stock || 'std';
  if (cfg.base !== 'bolt') {
    const S = STOCK;
    cyl(0.0145, 0.17 * S, metal, 0, 0.0, z(-0.085 * S)); // buffer tube
    if (st === 'light') { // skeleton stock: an outline, not a solid
      box(0.012, 0.012, 0.2 * S, F.poly, 0, 0.018, z(-0.2 * S)); box(0.012, 0.012, 0.22 * S, F.poly, 0, -0.05, z(-0.19 * S)).rotation.x = -0.18;
      box(0.04, 0.09, 0.016, M.rubber, 0, -0.018, z(-0.3 * S));
    } else {
      const fixed = st === 'heavy' || cfg.base === 'dmr' || cfg.base === 'lmg';
      profile(stockPts(fixed
        ? [[-0.32, 0.028], [-0.1, 0.028], [-0.1, -0.012], [-0.2, -0.05], [-0.32, -0.07]]
        : [[-0.3, 0.024], [-0.1, 0.024], [-0.1, -0.012], [-0.2, -0.042], [-0.3, -0.062]]), fixed ? 0.046 : 0.042, F.furn, { bevel: 0.006 });
      profile([[-0.315 * S, 0.026], [-0.3 * S, 0.026], [-0.3 * S, -0.066], [-0.315 * S, -0.066]], 0.046, M.rubber, { bevel: 0.004 }); // butt pad
      if (st === 'heavy') box(0.036, 0.018, 0.12, F.furn, 0, 0.036, z(-0.2 * S), g, 0.006); // cheek riser
    }
  } else if (st === 'heavy') box(0.04, 0.02, 0.12, M.rubber, 0, 0.026, z(-0.2 * STOCK), g, 0.006);

  // --- magazine (own group: the reload animation drops it)
  const mag = new THREE.Group();
  mag.position.set(0, -0.06, -0.045);
  g.add(mag);
  const mt = cfg.mag || 'std';
  const magU = cfg.base === 'bolt' ? 0.14 : B.recv * 0.45;
  const mpos = (u) => Z0 - u + 0.045; // mag group is offset; place parts in its frame
  if (cfg.base === 'lmg') {
    box(0.08, 0.1, 0.12, F.poly, -0.03, -0.01, mpos(magU), mag, 0.01); // belt box
    if (mt === 'fast') box(0.03, 0.01, 0.06, M.rubber, -0.03, 0.045, mpos(magU), mag, 0.003);
  } else if (mt === 'drum') {
    cyl(0.068, 0.05, F.poly, 0, -0.07, mpos(magU), mag, 24).rotation.set(0, 0, Math.PI / 2); // disc on its side
    box(0.03, 0.05, 0.05, F.poly, 0, -0.01, mpos(magU), mag, 0.005);
  } else if (cfg.base === 'bolt') {
    box(0.024, mt === 'ext' ? 0.06 : 0.02, 0.06, metal, 0, mt === 'ext' ? -0.02 : 0.01, mpos(magU), mag, 0.003);
  } else {
    const len = mt === 'ext' ? 1.45 : 1;
    if (cfg.base === 'rifle') {
      const pts = [[0.088, -0.045], [0.138, -0.045], [0.148, -0.1], [0.168, -0.17], [0.12, -0.182], [0.1, -0.11]];
      const m = profile(pts.map(([u, v]) => [u, -0.045 + (v + 0.045) * len + 0.06]), 0.024, F.poly, { bevel: 0.003, parent: mag });
      m.position.z += 0.045;
    } else { // straight mags: SMG (slim 9 mm) and DMR (fat 7.62)
      const w = cfg.base === 'dmr' ? 0.072 : 0.036, h = (cfg.base === 'dmr' ? 0.1 : 0.13) * len;
      box(0.026, h, w, F.poly, 0, -h / 2 + 0.03, mpos(magU), mag, 0.004).rotation.x = cfg.base === 'dmr' ? 0.08 : 0.04;
    }
    if (mt === 'fast') box(0.03, 0.012, 0.02, M.rubber, 0, -0.1 * len, mpos(magU) - 0.02, mag, 0.003);
  }

  // --- underbarrel
  const ub = cfg.attachments.underbarrel || 'none';
  const ubU = guardEnd - 0.09, ubY = cfg.base === 'bolt' ? -0.03 : -0.03;
  if (ub === 'vgrip') cyl(0.014, 0.075, F.poly, 0, ubY - 0.04, z(ubU)).rotation.set(0, 0, 0);
  if (ub === 'agrip') profile([[ubU - 0.04, ubY], [ubU + 0.04, ubY], [ubU - 0.02, ubY - 0.035]], 0.03, F.poly, { bevel: 0.004 });
  if (ub === 'bipod') {
    const legs = new THREE.Group();
    legs.position.set(0, ubY - 0.005, z(guardEnd - 0.03));
    box(0.04, 0.014, 0.03, metal, 0, 0, 0, legs, 0.003);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(sx * 0.016, -0.004, 0);
      cyl(0.0045, 0.2, metal, 0, 0, 0.1, leg, 8); // folded: lies back along the handguard
      legs.add(leg);
    }
    g.add(legs);
    g.userData.bipod = legs;
  }

  // --- sights
  const optic = cfg.optic;
  let SY, rearU;
  if (!optic) {
    if (cfg.base === 'bolt') {
      SY = 0.052;
      box(0.004, SY - 0.02, 0.006, metal, 0, (SY + 0.02) / 2 - 0.002 + 0.0, z(barrelEnd - 0.03), g, 0.0005).position.y = SY - (SY - 0.02) / 2;
      box(0.012, 0.016, 0.01, metal, 0, 0.022, z(barrelEnd - 0.03));
      box(0.006, 0.012, 0.006, metal, -0.006, SY - 0.004, z(0.3), g, 0.0005); box(0.006, 0.012, 0.006, metal, 0.006, SY - 0.004, z(0.3), g, 0.0005);
      box(0.03, 0.02, 0.03, metal, 0, 0.03, z(0.3));
      rearU = 0.3;
    } else {
      SY = B.railTop + 0.0275;
      // folding front sight (post tip exactly at SY) and rear aperture
      profile([[guardEnd - 0.06, B.railTop], [guardEnd - 0.015, B.railTop], [guardEnd - 0.03, B.railTop + 0.022], [guardEnd - 0.045, B.railTop + 0.022]], 0.024, metal, { bevel: 0.002 });
      box(0.0035, 0.03, 0.005, metal, 0, SY - 0.015, z(guardEnd - 0.037), g, 0.0005);
      for (const sx of [-1, 1]) box(0.004, 0.03, 0.01, metal, sx * 0.01, SY - 0.012, z(guardEnd - 0.037), g, 0.001);
      profile([[0.02, B.railTop], [0.065, B.railTop], [0.06, B.railTop + 0.015], [0.03, B.railTop + 0.015]], 0.03, metal, { bevel: 0.002 });
      for (const sx of [-1, 1]) box(0.004, 0.022, 0.008, metal, sx * 0.011, SY - 0.004, z(0.045), g, 0.001);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0055, 0.0014, 8, 24), metal);
      ring.position.set(0, SY, z(0.045));
      g.add(ring);
      rearU = 0.045;
    }
  } else {
    const base = B.railTop;
    SY = base + optic.height;
    rearU = buildOptic(g, M, metal, cfg.attachments.optic, optic, base, SY, cfg.base === 'bolt', reticleGlow(cfg));
  }

  // --- hands & sleeves (where the support hand goes is also used by the
  // third-person soldier in character.js, so it's worked out either way)
  // (about 60 cm in front of the butt on a carbine: where a real support hand reaches)
  const leftU = ub === 'vgrip' ? ubU : cfg.base === 'bolt' ? 0.38 : Math.min(guardEnd - 0.1, B.recv + 0.14);
  const leftY = ub === 'vgrip' ? ubY - 0.06 : -0.045;
  if (hands) {
    hand(box, M, cfg.base === 'bolt' ? 0.004 : 0.006, cfg.base === 'bolt' ? -0.07 : -0.085, z(-0.005), -0.25, 0, g);
    hand(box, M, -0.012, leftY, z(leftU), ub === 'vgrip' ? -0.1 : 0.1, ub === 'vgrip' ? 0.2 : 0.5, g);
    limb(V3(0.012, -0.11, z(-0.03)), V3(0.13, -0.27, z(-0.32)), 0.036, M.camoWood);
    limb(V3(-0.03, leftY - 0.03, z(leftU - 0.03)), V3(-0.2, -0.25, z(leftU - 0.32)), 0.035, M.camoWood);
  }

  const muzzle = new THREE.Object3D(); muzzle.position.set(0, boreY, z(muzzleU)); g.add(muzzle);
  const eject = new THREE.Object3D(); eject.position.set(0.03, 0.012, z(cfg.base === 'bolt' ? 0.18 : B.recv * 0.48)); g.add(eject);
  const flash = flashTex ? flashMesh(flashTex) : new THREE.Group();
  flash.position.copy(muzzle.position);
  flash.scale.setScalar(mz === 'brake' ? 1.4 : mz === 'suppressor' ? 0.12 : 1);
  g.add(flash);

  // Aim-down-sights pose: put the sight line through the camera, with the
  // rear sight / eyepiece the right distance from the eye.
  const relief = optic ? optic.relief : 0.235;
  const ads = new THREE.Vector3(0, -SY, -(relief + z(rearU)));
  const zoom = optic?.zoom || 1;
  // grip / fore: where the firing hand and the support hand hold the gun
  // hip: the butt in the shoulder pocket, gun under the right side of the face (a real low carry)
  return { group: g, mag, muzzle, eject, flash, hip: new THREE.Vector3(0.11, -0.185, -0.31), ads, adsFov: zoom > 1 ? 40 : 50, bolt: g.userData.bolt || null, bipod: g.userData.bipod || null, cfg,
    grip: V3(0, -0.075, Z0), fore: V3(-0.012, leftY, z(leftU)),
    // butt: the middle of the butt pad, which goes in the shoulder (character.js poses the gun from it)
    butt: cfg.base === 'bolt' ? V3(0, -0.025, z(-0.33 * STOCK)) : V3(0, -0.02, z(-0.315 * STOCK)) };
}

// Optics sit on the rail; returns u of the rear (eye) end.
function buildOptic(g, M, metal, id, optic, base, SY, boltMount, glow) {
  const { box, cyl } = maker(g);
  const z = (u) => Z0 - u;
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2a30, roughness: 0.05, metalness: 1, transparent: true, opacity: 0.35, depthWrite: false }); // (no depth: the reticle sits behind it)
  const ret = (type, u, size) => { // the glowing reticle, on the sight line
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: reticleTexture(type), color: glow, transparent: true, depthWrite: false, toneMapped: false }));
    m.position.set(0, SY, z(u));
    m.renderOrder = 5;
    g.add(m);
  };
  if (boltMount) { // scope rings on the round receiver
    for (const u of [0.04, 0.2]) box(0.028, SY - base + 0.01, 0.016, metal, 0, (SY + base) / 2 - 0.004, z(u), g, 0.003);
  }
  if (id === 'reddot') {
    box(0.024, 0.012, 0.04, metal, 0, base + 0.006, z(0.07), g, 0.003);
    // an OPEN tube, so you can look through it
    const tubeMat = metal.clone(); tubeMat.side = THREE.DoubleSide;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.045, 24, 1, true), tubeMat);
    tube.rotation.x = Math.PI / 2; tube.position.set(0, SY, z(0.07)); g.add(tube);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.0145, 24), glass); lens.position.set(0, SY, z(0.047)); g.add(lens);
    ret('dot', 0.093, 0.05);
    return 0.047;
  }
  if (id === 'holo') {
    box(0.034, 0.014, 0.085, metal, 0, base + 0.007, z(0.075), g, 0.004);                    // base / battery box
    for (const sx of [-1, 1]) box(0.004, 0.034, 0.05, metal, sx * 0.019, SY - 0.002, z(0.085), g, 0.002); // hood sides
    box(0.042, 0.004, 0.05, metal, 0, SY + 0.016, z(0.085), g, 0.002);                       // hood top
    const win = new THREE.Mesh(new THREE.PlaneGeometry(0.034, 0.028), glass); win.position.set(0, SY, z(0.06)); g.add(win);
    ret('holo', 0.11, 0.045);
    return 0.06;
  }
  if (id === 'acog') {
    box(0.03, 0.012, 0.06, metal, 0, base + 0.006, z(0.07), g, 0.003);
    box(0.034, 0.03, 0.09, metal, 0, SY - 0.002, z(0.075), g, 0.008);
    cyl(0.019, 0.03, metal, 0, SY, z(0.14), g, 24, 0.016);  // objective
    cyl(0.014, 0.025, metal, 0, SY, z(0.0), g, 20, 0.016);  // eyepiece
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.013, 20), glass); lens.position.set(0, SY, z(-0.013)); g.add(lens);
    return -0.013;
  }
  // sniper scope (3-12x): tube, objective bell, eyepiece, turrets
  const tubeStart = -0.07, tubeEnd = 0.24;
  if (!boltMount) for (const u of [0.02, 0.17]) box(0.026, SY - base + 0.008, 0.016, metal, 0, (SY + base) / 2 - 0.002, z(u), g, 0.003);
  cyl(0.0135, tubeEnd - tubeStart, metal, 0, SY, z((tubeStart + tubeEnd) / 2), g, 24);
  cyl(0.023, 0.07, metal, 0, SY, z(tubeEnd + 0.03), g, 28, 0.0135);
  cyl(0.019, 0.07, metal, 0, SY, z(tubeStart - 0.02), g, 24, 0.0135);
  cyl(0.009, 0.02, metal, 0, SY + 0.018, z(0.09), g, 14).rotation.set(0, 0, 0);
  cyl(0.009, 0.02, metal, 0.018, SY, z(0.09), g, 14).rotation.set(0, 0, Math.PI / 2);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.017, 24), glass); lens.position.set(0, SY, z(tubeStart - 0.056)); g.add(lens);
  return tubeStart - 0.056;
}

// ---------------------------------------------------------------- pistol
function buildPistol(M, cfg, { hands, flashTex }) {
  const g = new THREE.Group();
  const { box, cyl, profile, limb } = maker(g);
  const F = finish(M, cfg.camo, cfg.metal), metal = F.metal, poly = F.poly;
  const optic = cfg.optic;
  let SY = 0.034;
  profile([[0.0, 0.0], [0.19, 0.0], [0.19, 0.024], [0.185, 0.03], [0.006, 0.03], [0.0, 0.026]], 0.027, metal, { bevel: 0.003 });
  for (let i = 0; i < 7; i++) box(0.0285, 0.022, 0.002, M.rubber, 0, 0.014, Z0 - 0.012 - i * 0.006, g, 0.0005);
  profile([[0.01, -0.024], [0.18, -0.024], [0.18, 0.001], [0.01, 0.001]], 0.025, poly, { bevel: 0.003 });
  profile([[0.0, -0.022], [0.05, -0.022], [0.035, -0.125], [-0.015, -0.122], [-0.01, -0.05]], 0.03, F.furn, { bevel: 0.007 }); // grip
  profile([[0.05, -0.022], [0.1, -0.022], [0.1, -0.03], [0.055, -0.045]], 0.01, poly, { bevel: 0.002 });
  cyl(0.0055, 0.006, M.rubber, 0, 0.012, Z0 - 0.19);
  let rearU = 0.008;
  if (optic) { // slide-mounted mini red dot: base plate + open window frame
    SY = 0.05;
    box(0.024, 0.006, 0.035, metal, 0, 0.033, Z0 - 0.06, g, 0.002);
    for (const sx of [-1, 1]) box(0.003, 0.026, 0.03, metal, sx * 0.0115, 0.048, Z0 - 0.06, g, 0.001);
    box(0.026, 0.003, 0.03, metal, 0, 0.0615, Z0 - 0.06, g, 0.001);
    const glass = new THREE.MeshStandardMaterial({ color: 0x1a2a30, roughness: 0.05, metalness: 1, transparent: true, opacity: 0.35, depthWrite: false }); // (no depth: the reticle sits behind it)
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.016), glass); lens.position.set(0, SY, Z0 - 0.045); g.add(lens);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.04), new THREE.MeshBasicMaterial({ map: reticleTexture('dot'), color: reticleGlow(cfg), transparent: true, depthWrite: false, toneMapped: false }));
    m.position.set(0, SY, Z0 - 0.078); m.renderOrder = 5; g.add(m);
    rearU = 0.045;
  } else {
    box(0.004, 0.006, 0.006, metal, 0, SY - 0.003, Z0 - 0.18, g, 0.0005);
    box(0.006, 0.008, 0.006, metal, -0.006, SY - 0.002, Z0 - 0.008, g, 0.0005);
    box(0.006, 0.008, 0.006, metal, 0.006, SY - 0.002, Z0 - 0.008, g, 0.0005);
  }
  let muzzleZ = Z0 - 0.2;
  if (cfg.suppressed) { cyl(0.015, 0.13, M.rubber, 0, 0.012, Z0 - 0.26, g, 18); muzzleZ = Z0 - 0.325; }
  const mag = new THREE.Group();
  mag.position.set(0, -0.03, 0.03);
  box(0.024, 0.11, 0.045, metal, 0, -0.06, Z0 - 0.035 - 0.03, mag).rotation.x = -0.25;
  if (cfg.mag === 'ext') box(0.03, 0.03, 0.05, poly, 0, -0.125, Z0 - 0.045, mag, 0.004);
  g.add(mag);
  if (hands) {
    hand(box, M, 0.004, -0.07, Z0 - 0.02, -0.2, 0, g);
    hand(box, M, -0.026, -0.075, Z0 - 0.03, -0.2, 0.25, g);
    limb(V3(0.012, -0.095, Z0 + 0.0), V3(0.12, -0.25, Z0 + 0.26), 0.034, M.camoWood);
    limb(V3(-0.03, -0.095, Z0 - 0.01), V3(-0.14, -0.25, Z0 + 0.25), 0.034, M.camoWood);
  }
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.012, muzzleZ); g.add(muzzle);
  const eject = new THREE.Object3D(); eject.position.set(0.016, 0.022, Z0 - 0.08); g.add(eject);
  const flash = flashTex ? flashMesh(flashTex) : new THREE.Group();
  flash.position.copy(muzzle.position);
  flash.scale.setScalar(cfg.suppressed ? 0.08 : 0.6);
  g.add(flash);
  // a two-handed pistol is held out at nearly straight arms: ~0.5 m from the eye
  const relief = optic ? 0.46 : 0.44;
  return { group: g, mag, muzzle, eject, flash, hip: new THREE.Vector3(0.08, -0.2, -0.42), ads: new THREE.Vector3(0, -SY, -(relief + (Z0 - rearU))), adsFov: 54, bolt: null, bipod: null, cfg,
    grip: V3(0, -0.07, Z0 - 0.02), fore: V3(-0.022, -0.08, Z0 - 0.025) };
}

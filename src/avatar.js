// =============================================================================
// avatar.js — your soldier's look: which soldier, armour, uniform, markings,
// eyewear, gloves and gear. Your squad sees it in co-op; in first person you
// see your own sleeves and gloves.
//
// The look is one small plain object, saved in localStorage and sent to your
// squad as short text (like your guns, see loadout.js encodeWeapons):
//   { armour: 'ranger', uniform: 'woodland', markings: 'none', visor: 'smoke',
//     gloves: 'black', head: 'headset', back: 'none', soldier: 'm1' }
//   -> "ranger.woodland.none.smoke.black.headset.none.m1"
// New choices only ever go on the END, so an older message still reads.
//
// HOW A UNIFORM IS RECOLOURED
// Each soldier's clothes are painted in "ACU" digital camo: three greys and
// greens in little squares. To dress him in desert, woodland or black, we look
// at every pixel of the clothing textures ONCE: is it cloth (grey-green, not
// very colourful), and is it one of the dark, middle or light squares of the
// pattern? Then each look paints a copy where the dark squares take the new
// pattern's darkest colour and so on, keeping each pixel's own brightness, so
// folds, seams and stitching survive. The same pass paints over the badges and
// flag patch, and leaves the boots, buckles and skin alone.
// Games that let you recolour gear usually ship a hand-painted MASK texture
// for this; we work the mask out from the colours instead.
//
// GEAR (helmet tape, glasses, headset, night vision, backpack, radio) is built
// from simple shapes, like the guns in gunsmith.js, and fitted to each
// soldier's measured helmet and back (character.js Rig._measure), then hung
// on a bone (the head or the upper back) so it moves with the body.
// =============================================================================
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { PAINTS, PAINT_IDS, paintTexture } from './paint.js';

const paints = () => Object.fromEntries(PAINT_IDS.map((id) => [id, { name: PAINTS[id].name, paint: id }]));

// Every slot and its options. Order matters: it's the order on the wire.
export const AVATAR = {
  armour: { name: 'Armour', desc: 'Helmet cover, plate carrier pouches and kit.', options: paints() },
  uniform: { name: 'Uniform', desc: 'Combat shirt, trousers and plate carrier. Also your sleeves in first person.', options: paints() },
  markings: {
    name: 'Markings', desc: 'A band of coloured tape round the helmet. Real units use it to tell squads apart at a glance.',
    options: {
      none: { name: 'None', desc: 'No tape.' },
      red: { name: 'Red', color: 0xa8231b }, orange: { name: 'Orange', color: 0xd0621c }, yellow: { name: 'Yellow', color: 0xd4b02a },
      white: { name: 'White', color: 0xdcdcd4 }, blue: { name: 'Blue', color: 0x2c5cb4 }, green: { name: 'Green', color: 0x3d9438 },
      black: { name: 'Black', color: 0x1c1c1c },
    },
  },
  visor: { // (called "visor" on the wire, from an older soldier model; it's your eyewear now)
    name: 'Eyewear', desc: 'Ballistic glasses.',
    options: {
      smoke: { name: 'Smoked glasses', desc: 'Dark tinted lenses.', lens: 0x16181a },
      silver: { name: 'Silver mirror', mirror: 0x8f969c },
      gold: { name: 'Gold mirror', mirror: 0xa47a32 },
      blue: { name: 'Blue mirror', mirror: 0x2d5488 },
      none: { name: 'None', desc: 'No glasses.' },
    },
  },
  gloves: {
    name: 'Gloves', desc: 'The gloves on your hands, also in first person.',
    options: {
      black: { name: 'Black', color: 0x2a2724 }, coyote: { name: 'Coyote', color: 0x6e5636 }, od: { name: 'OD green', color: 0x4a4f38 },
      tan: { name: 'Tan', color: 0x9c865f }, grey: { name: 'Grey', color: 0x55585a },
    },
  },
  head: {
    name: 'Head', desc: 'Kit fixed to your helmet.',
    options: {
      none: { name: 'Bare helmet' },
      headset: { name: 'Comms headset', desc: 'Hearing protection with a radio mic.' },
      nvg: { name: 'Night vision', desc: 'Goggles flipped up on a helmet mount, battery pack on the back.' },
      both: { name: 'Headset + NVG', desc: 'Both.' },
    },
  },
  back: {
    name: 'Back', desc: 'What you carry on your back.',
    options: {
      none: { name: 'Nothing' },
      pack: { name: 'Assault pack', desc: 'A day pack, in your uniform pattern.' },
      radio: { name: 'Radio', desc: 'A manpack radio with a whip antenna. You\'re the squad\'s radio operator.' },
    },
  },
  // Which soldier you are: the four soldier models (character.js), in that order
  soldier: {
    name: 'Soldier', desc: 'Who you are: face, build and the kit each soldier came with.',
    options: {
      m1: { name: 'Soldier 1', desc: 'Goggles on the helmet.', variant: 0 },
      m2: { name: 'Soldier 2', desc: 'Sunglasses, elbow and knee pads.', variant: 1 },
      m3: { name: 'Soldier 3', desc: 'Night-vision mount, full pouches.', variant: 2 },
      f1: { name: 'Soldier 4', desc: 'Radio and pouches.', variant: 3 },
    },
  },
};
export const AVATAR_SLOTS = Object.keys(AVATAR);
export const DEFAULT_AVATAR = { armour: 'ranger', uniform: 'woodland', markings: 'none', visor: 'smoke', gloves: 'black', head: 'headset', back: 'none', soldier: 'm1' };

// Anything missing or unknown becomes the default, so a garbled look from
// the network (or an old save) can only ever produce a legal soldier.
export function normalizeAvatar(a) {
  return Object.fromEntries(AVATAR_SLOTS.map((k) => [k, AVATAR[k].options[a?.[k]] ? a[k] : DEFAULT_AVATAR[k]]));
}
export const encodeAvatar = (a) => AVATAR_SLOTS.map((k) => normalizeAvatar(a)[k]).join('.');
export function decodeAvatar(text) {
  if (typeof text !== 'string' || !text) return null;
  const parts = text.split('.');
  return normalizeAvatar(Object.fromEntries(AVATAR_SLOTS.map((k, i) => [k, parts[i]])));
}

export function randomAvatar() {
  const pick = (k) => { const ids = Object.keys(AVATAR[k].options); return ids[Math.floor(Math.random() * ids.length)]; };
  return normalizeAvatar(Object.fromEntries(AVATAR_SLOTS.map((k) => [k, pick(k)])));
}

const KEY = 'dustline.avatar';
export function loadAvatar() { try { return normalizeAvatar(JSON.parse(localStorage.getItem(KEY))); } catch { return { ...DEFAULT_AVATAR }; } }
export function saveAvatar(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* storage unavailable */ } }

// First person: the arms you see are a real soldier (viewmodel.js), dressed
// with setAvatar. This also repaints the shared sleeve and glove materials
// that the armory's simple preview hands use.
export function dressFirstPerson(M, avatar) {
  const a = normalizeAvatar(avatar);
  const cloth = paintTexture(a.uniform);
  M.camoWood.map = cloth.map;
  M.camoWood.normalMap = cloth.normalMap;
  M.camoWood.color.set(0xffffff);
  M.glove.color.set(AVATAR.gloves.options[a.gloves].color);
}

// ---------------------------------------------------------------- the recolour
// A paint (or a plain colour) as three tones, darkest first, as 0..255 RGB
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
function tones(paintId, hex) {
  const p = paintId ? PAINTS[paintId] : null;
  if (p?.pattern) {
    const cols = p.pattern.palette.map((c) => c.map((v) => v * 255)).sort((a, b) => lum(a) - lum(b));
    return [cols[0], cols[Math.floor((cols.length - 1) / 2)], cols[cols.length - 1]];
  }
  const c = rgb(p ? p.color : hex);
  const k = (f) => c.map((v) => Math.min(255, v * f));
  // a plain paint keeps a little mottling; a faction colour (hex) is a light
  // tint, so it's darkened to read as a real uniform rather than white
  return p ? [k(0.72), k(0.92), k(1.12)] : [k(0.48), k(0.64), k(0.8)];
}

// Sort the pixels of one clothing texture: which are cloth, which of the
// pattern's three tones each is, and its brightness within that tone. Once per texture.
function analyse(image) {
  const W = image.width, H = image.height;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(image, 0, 0);
  const src = g.getImageData(0, 0, W, H).data;
  const n = W * H, band = new Uint8Array(n), shade = new Float32Array(n), Ls = [];
  for (let p = 0; p < n; p++) {
    const r = src[p * 4], gr = src[p * 4 + 1], b = src[p * 4 + 2];
    const max = Math.max(r, gr, b), min = Math.min(r, gr, b), sat = max ? (max - min) / max : 0;
    const L = 0.299 * r + 0.587 * gr + 0.114 * b;
    let hue = 0;
    if (max > min) hue = max === r ? 60 * (((gr - b) / (max - min) + 6) % 6) : max === gr ? 60 * ((b - r) / (max - min) + 2) : 60 * ((r - gr) / (max - min) + 4);
    const boot = hue > 18 && hue < 55 && sat > 0.2 && L > 70;       // tan leather: boots, straps
    const badge = sat > 0.42 && L > 40;                              // flag and unit patches: paint over them
    const cloth = (sat < 0.24 && L > 28 && L < 235 && !boot) || badge;
    if (!cloth) continue;
    band[p] = 1; // (1..3 once sorted below)
    shade[p] = L;
    if ((p & 7) === 0) Ls.push(L);
  }
  Ls.sort((a, b) => a - b);
  const t1 = Ls[Math.floor(Ls.length * 0.36)] || 90, t2 = Ls[Math.floor(Ls.length * 0.7)] || 150;
  const sum = [0, 0, 0], cnt = [0, 0, 0];
  for (let p = 0; p < n; p++) {
    if (!band[p]) continue;
    const L = shade[p], k = L < t1 ? 0 : L < t2 ? 1 : 2;
    band[p] = k + 1;
    sum[k] += L; cnt[k]++;
  }
  const mean = sum.map((s, k) => (cnt[k] ? s / cnt[k] : 128));
  for (let p = 0; p < n; p++) if (band[p]) shade[p] = Math.min(1.45, Math.max(0.55, shade[p] / mean[band[p] - 1]));
  return { W, H, src, band, shade };
}

const analyses = new WeakMap(); // texture image -> its analysis
function recolour(tex, three) {
  const img = tex.image;
  if (!analyses.has(img)) analyses.set(img, analyse(img));
  const { W, H, src, band, shade } = analyses.get(img);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const out = g.createImageData(W, H), d = out.data;
  d.set(src);
  for (let p = 0; p < W * H; p++) {
    const k = band[p];
    if (!k) continue;
    const c = three[k - 1], s = shade[p], i = p * 4;
    d[i] = Math.min(255, c[0] * s); d[i + 1] = Math.min(255, c[1] * s); d[i + 2] = Math.min(255, c[2] * s);
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(canvas);
  for (const k of ['flipY', 'wrapS', 'wrapT', 'anisotropy']) t[k] = tex[k];
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------- wardrobe
// One per SoldierFactory. Paints looks and builds gear for SoldierBody.setAvatar.
// A look's textures are big (1024 x 1024), so each look is shared by everyone
// wearing it. When nobody wears it any more it's kept for a while (you might
// switch back), and thrown away once more than SPARE unworn looks pile up.
const SPARE = 6;
export class Wardrobe {
  constructor(factory) {
    this.f = factory;
    this.looks = new Map(); // key -> { key, mats: { part -> material }, users, own: [textures] }
    this.unworn = [];
    this.mats = {
      dark: new THREE.MeshStandardMaterial({ color: 0x1e1f1c, roughness: 0.65, metalness: 0.25 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.9 }),
      lens: new THREE.MeshStandardMaterial({ color: 0x1d3328, roughness: 0.08, metalness: 0.9 }),
    };
    this.cloth = new Map();
    this.tapes = new Map();
    this.lenses = new Map();
  }

  // Put a look on a body. avatar = null: the plain uniform in the body's base
  // colour (an enemy's faction colours, or the friendly squad colour).
  dress(body, avatar) {
    const a = avatar && normalizeAvatar(avatar);
    if (a) {
      const v = AVATAR.soldier.options[a.soldier].variant;
      if (v !== body.variant && v < this.f.count) body._build(v);
    }
    const look = this._acquire(body.variant, a, body.baseTint); // (before letting go of the old one: they may be the same)
    if (body.look) this._release(body.look);
    body.look = look;
    body.skin.material = body.baseMats.map((m) => look.mats[m.name] || m);
    for (const g of body.gear) { g.removeFromParent(); g.traverse((o) => o.geometry?.dispose()); }
    body.gear = a ? this._gear(body, a) : [];
  }

  _acquire(variant, a, tint) {
    const key = a ? `${variant}|${a.armour}.${a.uniform}.${a.gloves}` : `${variant}|tint ${tint ?? 'none'}`;
    let look = this.looks.get(key);
    if (!look) {
      const base = this.f.variants[variant].mats, own = [];
      const paint = (part, three) => {
        const m = base[part].clone();
        m.map = recolour(base[part].map, three);
        own.push(m.map);
        return m;
      };
      const mats = {};
      if (a) {
        const uni = tones(a.uniform), arm = tones(a.armour);
        mats.body = paint('body', uni);
        mats.helmet = paint('helmet', arm);
        mats.equipment = paint('equipment', arm);
        mats.gloves = this._gloves(base.gloves, AVATAR.gloves.options[a.gloves].color);
      } else if (tint !== null && tint !== undefined) {
        const t = tones(null, tint);
        mats.body = paint('body', t);
        mats.helmet = paint('helmet', t);
        mats.equipment = paint('equipment', t);
        mats.gloves = this._gloves(base.gloves, 0x2f2d29);
      } else mats.gloves = this._gloves(base.gloves, 0x3a3b33);
      look = { key, mats, users: 0, own };
      this.looks.set(key, look);
    }
    if (look.users++ === 0) this.unworn = this.unworn.filter((l) => l !== look);
    return look;
  }

  _release(look) {
    if (--look.users > 0) return;
    this.unworn.push(look);
    while (this.unworn.length > SPARE) {
      const old = this.unworn.shift();
      for (const t of old.own) t.dispose();
      for (const m of Object.values(old.mats)) m.dispose();
      this.looks.delete(old.key);
    }
  }

  // Gloves: the original glove pixels (grey-green, about 40% bright) tinted to the colour
  _gloves(base, hex) {
    const m = base.clone();
    m.color.set(hex).multiplyScalar(1 / 0.42);
    m.roughness = 0.85;
    return m;
  }

  _clothMat(id) {
    if (!this.cloth.has(id)) {
      const t = paintTexture(id);
      this.cloth.set(id, new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughness: 0.95 }));
    }
    return this.cloth.get(id);
  }

  _tape(hex) {
    if (!this.tapes.has(hex)) this.tapes.set(hex, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.55 }));
    return this.tapes.get(hex);
  }

  _lens(id) {
    if (!this.lenses.has(id)) {
      const o = AVATAR.visor.options[id];
      this.lenses.set(id, o.mirror
        ? new THREE.MeshStandardMaterial({ color: o.mirror, metalness: 1, roughness: 0.18 }) // a mirror coating reflects the sky
        : new THREE.MeshStandardMaterial({ color: o.lens, metalness: 0.4, roughness: 0.1 }));
    }
    return this.lenses.get(id);
  }

  // ------------------------------------------------------------ gear
  // Gear is laid out around the soldier standing in his rest pose at the
  // origin, facing -z, in metres, using that soldier's measurements: his
  // helmet's box and eyes (dims.helmet, dims.eyeL/R) and the back of his
  // torso (dims.backZ). mount() then re-expresses it in the bone's own space,
  // so it follows the head or back through every animation.
  _gear(body, a) {
    const out = [], M = this.mats, rig = body.rig, D = rig.dims, hb = D.helmet;
    const mount = (bone, build) => {
      const holder = new THREE.Group();
      rig.restInv[bone].decompose(holder.position, holder.quaternion, holder.scale);
      build(holder);
      holder.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      body.bones[bone === 'Head' ? 'Bip01_Head' : 'Bip01_Spine2'].add(holder);
      out.push(holder);
    };
    const box = (parent, mat, w, h, d, x, y, z, r = 0.01) => {
      const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const cyl = (parent, mat, r, len, x, y, z, seg = 16) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, seg), mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };
    const cx = (hb.min.x + hb.max.x) / 2, cz = (hb.min.z + hb.max.z) / 2;
    const hw = (hb.max.x - hb.min.x) / 2, hd = (hb.max.z - hb.min.z) / 2;
    const eyeY = (D.eyeL.y + D.eyeR.y) / 2, eyeZ = Math.min(D.eyeL.z, D.eyeR.z);

    // Helmet tape: a flat band round the helmet, a third of the way up
    const mark = AVATAR.markings.options[a.markings];
    if (mark.color !== undefined) mount('Head', (h) => {
      const y = hb.min.y + (hb.max.y - hb.min.y) * 0.55;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.022, 28, 1, true), this._tape(mark.color));
      band.material.side = THREE.DoubleSide;
      band.scale.set(hw * 0.97, 1, hd * 0.97);
      band.position.set(cx, y, cz);
      h.add(band);
    });

    // Ballistic glasses over the eyes (soldier 2 already wears sunglasses)
    if (AVATAR.visor.options[a.visor].name !== 'None' && body.variant !== 1) mount('Head', (h) => {
      const lens = this._lens(a.visor), gap = Math.abs(D.eyeR.x - D.eyeL.x);
      for (const e of [D.eyeL, D.eyeR]) {
        const l = box(h, lens, 0.05, 0.03, 0.006, e.x, e.y + 0.002, eyeZ - 0.022, 0.006);
        l.rotation.y = (e.x > 0 ? -1 : 1) * 0.18; // wrapping round the face
      }
      box(h, M.dark, gap + 0.06, 0.008, 0.008, (D.eyeL.x + D.eyeR.x) / 2, eyeY + 0.019, eyeZ - 0.022, 0.003); // top of the frame
      for (const sx of [-1, 1]) box(h, M.dark, 0.006, 0.008, 0.1, cx + sx * (gap / 2 + 0.042), eyeY + 0.016, eyeZ + 0.03, 0.003); // arms back to the ears
    });

    if (a.head === 'headset' || a.head === 'both') mount('Head', (h) => {
      const y = eyeY - 0.035, z = eyeZ + 0.09; // over the ears
      for (const sx of [-1, 1]) {
        cyl(h, M.dark, 0.042, 0.034, cx + sx * (hw + 0.005), y, z, 20).rotation.z = Math.PI / 2;
        cyl(h, M.rubber, 0.031, 0.01, cx + sx * (hw + 0.024), y, z, 16).rotation.z = Math.PI / 2;
      }
      const boom = cyl(h, M.rubber, 0.005, 0.11, cx + hw - 0.01, y - 0.04, z - 0.07, 8); // mic boom round to the mouth
      boom.rotation.set(Math.PI / 2, -0.5, 0);
      box(h, M.rubber, 0.022, 0.016, 0.02, cx + hw * 0.55, y - 0.055, eyeZ - 0.035, 0.006);
    });

    if (a.head === 'nvg' || a.head === 'both') mount('Head', (h) => {
      const fz = hb.min.z, top = hb.max.y;
      box(h, M.dark, 0.05, 0.04, 0.02, cx, top - 0.06, fz + 0.012, 0.004).rotation.x = -0.6;   // shroud on the helmet front
      box(h, M.dark, 0.03, 0.03, 0.04, cx, top - 0.03, fz + 0.002, 0.005).rotation.x = 0.5;    // mount arm
      for (const sx of [-1, 1]) { // the two tubes, flipped up and back over the helmet's brow
        const tube = cyl(h, M.dark, 0.017, 0.065, cx + sx * 0.027, top - 0.005, fz + 0.01, 14);
        tube.rotation.x = 1.0;
        const lens = cyl(h, M.lens, 0.0145, 0.004, cx + sx * 0.027, top + 0.022, fz + 0.03, 14);
        lens.rotation.x = 1.0;
      }
      box(h, M.dark, 0.075, 0.045, 0.03, cx, top - 0.07, hb.max.z - 0.005, 0.008).rotation.x = 0.85; // battery: a counterweight on the back
    });

    const by = D.neckY - 0.28, bz = D.backZ; // middle of the back
    if (a.back === 'pack') mount('Spine2', (s) => {
      const cloth = this._clothMat(a.uniform);
      box(s, cloth, 0.3, 0.36, 0.13, 0, by, bz + 0.065, 0.03);          // main bag
      box(s, cloth, 0.31, 0.06, 0.14, 0, by + 0.175, bz + 0.065, 0.025);  // lid
      box(s, cloth, 0.22, 0.15, 0.05, 0, by - 0.07, bz + 0.15, 0.02);     // front pocket
      for (const sx of [-1, 1]) box(s, M.rubber, 0.022, 0.32, 0.012, sx * 0.09, by + 0.01, bz + 0.135, 0.004); // compression straps
    });
    if (a.back === 'radio') mount('Spine2', (s) => {
      const cloth = this._clothMat(a.uniform);
      box(s, cloth, 0.24, 0.3, 0.11, 0, by, bz + 0.055, 0.025);           // radio pouch
      box(s, M.dark, 0.2, 0.06, 0.09, 0, by + 0.175, bz + 0.055, 0.01);   // radio head: knobs and connectors
      for (const kx of [-0.05, 0.02]) cyl(s, M.rubber, 0.011, 0.025, kx, by + 0.215, bz + 0.055, 10);
      const antenna = cyl(s, M.rubber, 0.0035, 0.8, 0.07, by + 0.6, bz + 0.09, 6); // whip antenna
      antenna.rotation.x = 0.12;
    });
    return out;
  }
}

// =============================================================================
// loadout.js — weapons, attachments, classes and kit weight (the "gunsmith").
//
// DATA-DRIVEN DESIGN: an attachment is just a list of stat modifiers. A
// suppressor multiplies loudness by 0.3 and velocity by 0.95; an extended mag
// multiplies capacity by 1.5 and reload time by 1.15. buildWeapon() starts
// from the base gun in config.js and applies each chosen attachment in turn.
// Games like Call of Duty's Gunsmith and Battlefield's weapon customisation
// work the same way, with much bigger tables.
//
// WEIGHT: everything you carry has a weight (kg). More weight = slower and
// tires you faster (like Insurgency / ARMA). Armour protects your torso but
// is heavy.
// =============================================================================
import { WEAPONS } from './config.js';
import { PAINTS, PAINT_IDS } from './paint.js';

// Each modifier: ['stat', '*', 1.2] multiplies, ['stat', '+', 0.3] adds, ['flag', '=', value] sets.
export const ATTACHMENTS = {
  optic: {
    iron: { name: 'Iron sights', desc: 'Folding iron sights. Fast and simple.', mods: [] },
    reddot: { name: 'Red dot 1x', tag: 'RDS', desc: 'A lit dot on a lens. Faster target pick-up.', mods: [['adsTime', '+', 0.015], ['weight', '+', 0.15]], optic: { type: 'dot', zoom: 1, height: 0.034, relief: 0.32 } },
    holo: { name: 'Holographic 1x', tag: 'HOLO', desc: 'Ring and dot reticle. Great up close.', mods: [['adsTime', '+', 0.02], ['weight', '+', 0.3]], optic: { type: 'holo', zoom: 1, height: 0.036, relief: 0.3 } },
    acog: { name: 'Prism 3x', tag: '3X', desc: '3x magnified combat optic.', mods: [['adsTime', '+', 0.07], ['weight', '+', 0.45], ['moveSpread', '*', 1.1]], optic: { type: 'scope', zoom: 3, reticle: 'chevron', height: 0.042, relief: 0.08 } },
    // A VARIABLE-POWER scope: zoom is where the magnification ring starts, and
    // zoomSteps are the powers marked on the ring. Scroll while aiming to turn it.
    scope: { name: 'Sniper scope 3-12x', tag: '3-12X', desc: 'Variable 3-12x scope: scroll while aiming to zoom. Long range only; sway is magnified too.', mods: [['adsTime', '+', 0.14], ['weight', '+', 0.8], ['hipSpread', '*', 1.15]], optic: { type: 'scope', zoom: 6, zoomSteps: [3, 4, 5, 6, 8, 10, 12], reticle: 'mildot', height: 0.052, relief: 0.09 } },
  },
  muzzle: {
    std: { name: 'Flash hider', desc: 'Standard. Hides some of the flash.', mods: [] },
    suppressor: { name: 'Suppressor', desc: 'Much quieter: enemies hear you from a third of the distance. Slightly slower bullets.', mods: [['loudness', '*', 0.3], ['muzzleVelocity', '*', 0.95], ['damage', '*', 0.95], ['adsTime', '+', 0.02], ['weight', '+', 0.4], ['suppressed', '=', true]] },
    compensator: { name: 'Compensator', desc: 'Vents gas upward: less muzzle climb, louder.', mods: [['recoilPitch', '*', 0.8], ['loudness', '*', 1.15], ['weight', '+', 0.12]] },
    brake: { name: 'Muzzle brake', desc: 'Cuts side-to-side kick. Big flash and blast.', mods: [['recoilYaw', '*', 0.55], ['recoilPitch', '*', 0.92], ['loudness', '*', 1.2], ['weight', '+', 0.15]] },
  },
  barrel: {
    short: { name: 'Short barrel', desc: 'Handier, but less range and velocity.', mods: [['muzzleVelocity', '*', 0.88], ['falloffStart', '*', 0.7], ['falloffEnd', '*', 0.75], ['adsTime', '*', 0.88], ['moveSpread', '*', 0.85], ['adsSpread', '*', 1.2], ['weight', '+', -0.3], ['barrel', '=', 'short']] },
    std: { name: 'Standard barrel', desc: 'Balanced.', mods: [] },
    long: { name: 'Long barrel', desc: 'More velocity, range and precision. Slower to handle.', mods: [['muzzleVelocity', '*', 1.08], ['falloffStart', '*', 1.3], ['falloffEnd', '*', 1.3], ['adsSpread', '*', 0.8], ['adsTime', '*', 1.12], ['weight', '+', 0.4], ['barrel', '=', 'long']] },
  },
  underbarrel: {
    none: { name: 'None', desc: '', mods: [] },
    vgrip: { name: 'Vertical grip', desc: 'Pull the muzzle down: less vertical recoil.', mods: [['recoilPitch', '*', 0.85], ['weight', '+', 0.15]] },
    agrip: { name: 'Angled grip', desc: 'Faster aiming, a little less sideways kick.', mods: [['adsTime', '*', 0.88], ['recoilYaw', '*', 0.85], ['weight', '+', 0.12]] },
    bipod: { name: 'Bipod', desc: 'Deploys when prone, or crouched behind cover: recoil and sway nearly gone.', mods: [['adsTime', '*', 1.05], ['weight', '+', 0.4], ['bipod', '=', true]] },
  },
  magazine: {
    std: { name: 'Standard mag', desc: '', mods: [] },
    ext: { name: 'Extended mag', desc: '+50% rounds. Heavier, slower reload.', mods: [['magSize', '*', 1.5], ['reloadTime', '*', 1.15], ['reloadEmptyTime', '*', 1.15], ['adsTime', '*', 1.05], ['weight', '+', 0.3], ['mag', '=', 'ext']] },
    fast: { name: 'Fast mag', desc: 'Pull tab and flared well: 20% faster reloads.', mods: [['reloadTime', '*', 0.8], ['reloadEmptyTime', '*', 0.8], ['mag', '=', 'fast']] },
    drum: { name: 'Drum mag', desc: 'Huge capacity. Heavy and slow.', mods: [['magSize', '*', 2.5], ['reloadTime', '*', 1.5], ['reloadEmptyTime', '*', 1.5], ['adsTime', '*', 1.12], ['moveSpread', '*', 1.15], ['weight', '+', 1.0], ['mag', '=', 'drum']] },
  },
  stock: {
    std: { name: 'Standard stock', desc: '', mods: [] },
    heavy: { name: 'Heavy stock', desc: 'Steadier: less recoil and sway, slower aiming.', mods: [['recoilPitch', '*', 0.88], ['swayMul', '*', 0.8], ['adsTime', '*', 1.08], ['weight', '+', 0.3], ['stock', '=', 'heavy']] },
    light: { name: 'Skeleton stock', desc: 'Light and fast, but more recoil and sway.', mods: [['adsTime', '*', 0.88], ['swayMul', '*', 1.25], ['recoilPitch', '*', 1.08], ['weight', '+', -0.25], ['stock', '=', 'light']] },
  },
  ammo: {
    fmj: { name: 'FMJ', desc: 'Full metal jacket: the standard round.', mods: [] },
    ap: { name: 'Armour-piercing', desc: 'Punches through more cover. Slightly less damage.', mods: [['penetration', '*', 1.6], ['damage', '*', 0.92]] },
    hp: { name: 'Hollow-point', desc: 'More damage to soldiers, almost no penetration.', mods: [['damage', '*', 1.15], ['penetration', '*', 0.35], ['limbMul', '*', 1.1]] },
  },
  // --- COSMETIC slots: they change how a gun LOOKS, never how it shoots
  // (no mods). Finishes come from the shared paint shop (paint.js).
  camo: {
    ...Object.fromEntries(PAINT_IDS.map((id) => [id, { name: PAINTS[id].name, desc: '', mods: [], paint: id }])),
    walnut: { name: 'Walnut wood', desc: 'Oiled wooden stock, grip and handguard.', mods: [], colors: [0x5a3a22], wood: true },
  },
  metal: { // receiver, barrel and optics: anodising or a ceramic coating ("Cerakote")
    black: { name: 'Black anodised', desc: '', mods: [], colors: [0x2e2f30] },
    gunmetal: { name: 'Gunmetal', desc: '', mods: [], colors: [0x4f5357], metalness: 0.85, roughness: 0.45 },
    grey: { name: 'Sniper grey', desc: 'Matte ceramic coating.', mods: [], colors: [0x666a6c], metalness: 0.35, roughness: 0.7 },
    fde: { name: 'FDE coating', desc: 'Matte ceramic coating.', mods: [], colors: [0x6e604a], metalness: 0.3, roughness: 0.7 },
    od: { name: 'OD coating', desc: 'Matte ceramic coating.', mods: [], colors: [0x434835], metalness: 0.3, roughness: 0.7 },
    bronze: { name: 'Burnt bronze', desc: '', mods: [], colors: [0x5c4128], metalness: 0.75, roughness: 0.5 },
    stainless: { name: 'Stainless steel', desc: 'Bare polished steel. Shiny.', mods: [], colors: [0x8c9093], metalness: 1, roughness: 0.4 },
  },
  reticle: { // the lit dot/ring/chevron. glow > 1 = brighter than white, so bloom makes it shine
    red: { name: 'Red', desc: 'Lights the red dot, holo, pistol dot and 3x chevron.', mods: [], colors: [0xff3b1f], glow: [2.2, 0.12, 0.08] },
    green: { name: 'Green', desc: 'Eyes are most sensitive to green: easy to see in daylight.', mods: [], colors: [0x4dff3b], glow: [0.35, 2.2, 0.25] },
    amber: { name: 'Amber', desc: 'Stands out against green foliage.', mods: [], colors: [0xffb21f], glow: [2.2, 1.0, 0.06] },
    cyan: { name: 'Cyan', desc: 'Stands out against sand and sunsets.', mods: [], colors: [0x3bd8ff], glow: [0.12, 1.5, 2.2] },
  },
};

export const SLOT_NAMES = { optic: 'Optic', muzzle: 'Muzzle', barrel: 'Barrel', underbarrel: 'Underbarrel', magazine: 'Magazine', stock: 'Stock', ammo: 'Ammo', camo: 'Finish', metal: 'Metal', reticle: 'Reticle' };
export const COSMETIC = ['camo', 'metal', 'reticle']; // looks only: the armory groups them as "PAINT"

// Every gun takes every paint job. The bolt-action comes in wood by default.
const PAINT_JOB = { camo: [...PAINT_IDS, 'walnut'], metal: Object.keys(ATTACHMENTS.metal), reticle: Object.keys(ATTACHMENTS.reticle) };
const WOOD_FIRST = { ...PAINT_JOB, camo: ['walnut', ...PAINT_IDS] };

// What each gun can take, its weight and the look of its body (used by viewmodel.js).
export const GUNS = {
  rifle: { label: '5.56 Carbine', role: 'Rifleman', slot: 'primary', weight: 3.4, desc: 'Versatile 5.56 carbine. Good at every range.',
    allow: { optic: ['iron', 'reddot', 'holo', 'acog'], muzzle: ['std', 'suppressor', 'compensator', 'brake'], barrel: ['short', 'std', 'long'], underbarrel: ['none', 'vgrip', 'agrip'], magazine: ['std', 'ext', 'fast', 'drum'], stock: ['std', 'heavy', 'light'], ammo: ['fmj', 'ap', 'hp'], ...PAINT_JOB } },
  smg: { label: '9mm SMG', role: 'Close quarters', slot: 'primary', weight: 2.9, desc: 'Fast-firing and light. Deadly in buildings, weak at range.',
    allow: { optic: ['iron', 'reddot', 'holo'], muzzle: ['std', 'suppressor', 'compensator'], barrel: ['short', 'std', 'long'], underbarrel: ['none', 'vgrip', 'agrip'], magazine: ['std', 'ext', 'fast', 'drum'], stock: ['std', 'heavy', 'light'], ammo: ['fmj', 'ap', 'hp'], ...PAINT_JOB } },
  dmr: { label: '7.62 DMR', role: 'Marksman', slot: 'primary', weight: 4.6, desc: 'Semi-auto battle rifle. Two body shots kill. Strong recoil.',
    allow: { optic: ['iron', 'reddot', 'acog', 'scope'], muzzle: ['std', 'suppressor', 'compensator', 'brake'], barrel: ['std', 'long'], underbarrel: ['none', 'vgrip', 'bipod'], magazine: ['std', 'ext', 'fast'], stock: ['std', 'heavy', 'light'], ammo: ['fmj', 'ap', 'hp'], ...PAINT_JOB } },
  lmg: { label: '5.56 LMG', role: 'Support', slot: 'primary', weight: 7.9, desc: '100-round belt box. Lay down suppressing fire. Heavy.',
    allow: { optic: ['iron', 'reddot', 'holo', 'acog'], muzzle: ['std', 'suppressor', 'compensator'], barrel: ['short', 'std', 'long'], underbarrel: ['none', 'vgrip', 'bipod'], magazine: ['std', 'fast'], stock: ['std', 'heavy'], ammo: ['fmj', 'ap', 'hp'], ...PAINT_JOB } },
  bolt: { label: '7.62 Bolt-action', role: 'Sniper', slot: 'primary', weight: 4.8, desc: 'One body shot kills. Work the bolt between every shot.',
    allow: { optic: ['iron', 'acog', 'scope'], muzzle: ['std', 'suppressor', 'brake'], barrel: ['std', 'long'], underbarrel: ['none', 'bipod'], magazine: ['std', 'ext'], stock: ['std', 'heavy'], ammo: ['fmj', 'ap', 'hp'], ...WOOD_FIRST } },
  pistol: { label: '9mm Sidearm', role: 'Sidearm', slot: 'secondary', weight: 0.9, desc: 'Reliable sidearm for when the rifle runs dry.',
    allow: { optic: ['iron', 'reddot'], muzzle: ['std', 'suppressor'], magazine: ['std', 'ext'], ammo: ['fmj', 'ap', 'hp'], ...PAINT_JOB } },
};

// GRENADES: two pouches, like most military shooters.
//   LETHAL   [G] — you carry LETHAL_COUNT of the type you pick (they hurt people)
//   TACTICAL [X] — you carry TACTICAL_COUNT (they change the fight without killing)
// How each type behaves (fuse, blast, sticking...) lives in grenades.js TYPES.
// weight = what the whole pouch weighs.
export const LETHAL_COUNT = 2, TACTICAL_COUNT = 1;
export const EQUIPMENT = {
  lethal: {
    frag: { name: 'Frag', desc: 'Bounces and rolls. 4 s fuse: hold G to cook it so it can\'t be dodged.', weight: 0.8 },
    sticky: { name: 'Sticky', desc: 'Sticks to the first thing it hits, soldiers included. Goes off 2.5 s after the throw. Smaller blast.', weight: 0.9 },
    impact: { name: 'Impact', desc: 'Explodes the moment it hits something (arms after a few metres). No cooking, smaller blast.', weight: 0.7 },
    claymore: { name: 'Claymore', desc: 'Directional mine: hold G, release to plant it facing where you look. Fires when an enemy walks in front of it. Deadly ahead, safe-ish behind. Heavy.', weight: 3.2 },
  },
  tactical: {
    smoke: { name: 'Smoke', desc: 'A 30 s smoke screen. The enemy can\'t see through it.', weight: 0.5 },
    flash: { name: 'Flashbang', desc: 'Blinds and deafens anyone who sees it go off, for a few seconds. Including you: look away!', weight: 0.4 },
    decoy: { name: 'Decoy', desc: 'Lands, then fakes bursts of rifle fire for 12 s. Enemies go to investigate.', weight: 0.4 },
  },
  armor: {
    none: { name: 'No armour', desc: 'Fastest. No protection.', weight: 0, torso: 1, blast: 1 },
    light: { name: 'Light plates', desc: 'Torso hits do 20% less. Some weight.', weight: 3.5, torso: 0.8, blast: 0.9 },
    heavy: { name: 'Heavy plates', desc: 'Torso hits do 40% less, blasts 25% less. Slow.', weight: 8.5, torso: 0.6, blast: 0.75 },
  },
};

const BASE_KIT_KG = 8; // helmet, webbing, water, first aid

export const CLASSES = {
  rifleman: { name: 'Rifleman', loadout: { primary: { id: 'rifle', mods: { optic: 'reddot', underbarrel: 'vgrip' } }, secondary: { id: 'pistol', mods: {} }, lethal: 'frag', tactical: 'smoke', armor: 'light' } },
  marksman: { name: 'Marksman', loadout: { primary: { id: 'dmr', mods: { optic: 'acog', barrel: 'long' } }, secondary: { id: 'pistol', mods: {} }, lethal: 'impact', tactical: 'smoke', armor: 'light' } },
  support: { name: 'Support', loadout: { primary: { id: 'lmg', mods: { optic: 'holo', underbarrel: 'bipod' } }, secondary: { id: 'pistol', mods: {} }, lethal: 'frag', tactical: 'smoke', armor: 'heavy' } },
  cqb: { name: 'Close Quarters', loadout: { primary: { id: 'smg', mods: { optic: 'holo', muzzle: 'suppressor', barrel: 'short', underbarrel: 'agrip' } }, secondary: { id: 'pistol', mods: { muzzle: 'suppressor' } }, lethal: 'frag', tactical: 'flash', armor: 'light' } },
  sniper: { name: 'Sniper', loadout: { primary: { id: 'bolt', mods: { optic: 'scope', muzzle: 'suppressor', underbarrel: 'bipod' } }, secondary: { id: 'pistol', mods: { muzzle: 'suppressor' } }, lethal: 'sticky', tactical: 'decoy', armor: 'none' } },
};

// Fill in any missing slot with the first allowed option (the default)
export function normalizeWeapon(w) {
  const gun = GUNS[w?.id] ? w.id : 'rifle';
  const mods = {};
  for (const [slot, options] of Object.entries(GUNS[gun].allow)) {
    const want = w?.mods?.[slot];
    mods[slot] = options.includes(want) ? want : slot === 'barrel' && options.includes('std') ? 'std' : options[0];
  }
  return { id: gun, mods };
}

export function normalizeLoadout(lo) {
  const cls = CLASSES[lo?.cls] ? lo.cls : 'rifleman';
  const base = CLASSES[cls].loadout;
  const primary = normalizeWeapon(lo?.primary || base.primary);
  if (GUNS[primary.id].slot !== 'primary') Object.assign(primary, normalizeWeapon(base.primary));
  return {
    cls,
    primary,
    secondary: normalizeWeapon(lo?.secondary || base.secondary),
    // (older saves had one "grenades" choice instead; they get the class's pair)
    lethal: Object.hasOwn(EQUIPMENT.lethal, lo?.lethal ?? '') ? lo.lethal : base.lethal,
    tactical: Object.hasOwn(EQUIPMENT.tactical, lo?.tactical ?? '') ? lo.tactical : base.tactical,
    armor: EQUIPMENT.armor[lo?.armor] ? lo.armor : base.armor,
  };
}

export function classLoadout(cls) {
  return normalizeLoadout({ cls, ...JSON.parse(JSON.stringify(CLASSES[cls].loadout)) });
}

// Base gun + attachments -> the final stats the weapon code uses.
export function buildWeapon(w) {
  const { id, mods } = normalizeWeapon(w);
  const cfg = { ...WEAPONS[id], weight: GUNS[id].weight, attachments: { ...mods }, base: id, optic: null, suppressed: false, bipod: false, barrel: 'std', mag: 'std', stock: 'std' };
  for (const [slot, choice] of Object.entries(mods)) {
    const a = ATTACHMENTS[slot][choice];
    if (a.optic) cfg.optic = a.optic;
    for (const [stat, op, v] of a.mods) {
      if (op === '*') cfg[stat] *= v;
      else if (op === '+') cfg[stat] += v;
      else cfg[stat] = v;
    }
  }
  cfg.magSize = Math.round(cfg.magSize);
  cfg.camo = mods.camo || 'black';     // paint jobs (gunsmith.js draws them)
  cfg.metal = mods.metal || 'black';
  cfg.reticle = mods.reticle || 'red';
  const optic = mods.optic ? ATTACHMENTS.optic[mods.optic].tag || '' : '';
  cfg.tag = [optic, cfg.suppressed ? 'SUPP' : ''].filter(Boolean).join(' · ');
  return cfg;
}

// Your guns as short text for the network, so squadmates can draw them:
//   "rifle.acog.suppressor.std.vgrip.std.std.fmj.woodland.black.red/pistol.iron.std.std.fmj.black.black.red"
// gun id, then one part per slot in the order of GUNS[id].allow.
export function encodeWeapons(lo) {
  const one = (w) => [w.id, ...Object.keys(GUNS[w.id].allow).map((slot) => w.mods[slot])].join('.');
  return `${one(lo.primary)}/${one(lo.secondary)}`;
}

// The reverse. Everything is checked against the tables (normalizeLoadout),
// so a garbled or made-up string can only ever produce a legal loadout.
export function decodeWeapons(text) {
  if (typeof text !== 'string' || !text.includes('/')) return null;
  const one = (part) => {
    const [id, ...parts] = part.split('.');
    if (!GUNS[id]) return null;
    return { id, mods: Object.fromEntries(Object.keys(GUNS[id].allow).map((slot, i) => [slot, parts[i]])) };
  };
  const [p, s] = text.split('/');
  const primary = one(p), secondary = one(s);
  if (!primary || !secondary) return null;
  const L = normalizeLoadout({ primary, secondary });
  return { primary: L.primary, secondary: L.secondary };
}

// Everything the game needs from a loadout: built weapons, grenades, armour, movement.
export function resolveLoadout(lo) {
  const L = normalizeLoadout(lo);
  const primary = buildWeapon(L.primary), secondary = buildWeapon(L.secondary);
  const armor = EQUIPMENT.armor[L.armor];
  const nadesKg = EQUIPMENT.lethal[L.lethal].weight + EQUIPMENT.tactical[L.tactical].weight;
  const weight = BASE_KIT_KG + primary.weight + secondary.weight + nadesKg + armor.weight;
  return {
    loadout: L, primary, secondary,
    grenades: { lethal: L.lethal, tactical: L.tactical, lethalCount: LETHAL_COUNT, tacticalCount: TACTICAL_COUNT },
    armor,
    weight,
    // ~17 kg (a typical rifleman) is "normal"; heavier slows you and drains stamina faster
    speedMul: Math.max(0.82, Math.min(1.06, 1.14 - weight * 0.0085)),
    staminaMul: Math.max(0.8, weight / 17),
  };
}

// 0–100 bars for the armory screen
export function weaponStats(cfg) {
  const c = (v) => Math.max(0, Math.min(100, Math.round(v)));
  return {
    Damage: c(cfg.damage / 1.15),
    Range: c((cfg.falloffEnd / 7) * (cfg.muzzleVelocity / 880)),
    'Fire rate': c(cfg.base === 'bolt' ? 6 : cfg.rpm / 10),
    Accuracy: c(100 - cfg.hipSpread * 900 - cfg.adsSpread * 9000 - cfg.moveSpread * 300),
    Control: c(100 - cfg.recoilPitch * 1500 - cfg.recoilYaw * 1200),
    Handling: c(100 - (cfg.adsTime - 0.12) * 220),
    Mobility: c(100 - (cfg.weight - 1) * 9),
    Stealth: c(100 - cfg.loudness / 2.4),
  };
}

const KEY = 'dustline.loadout';
export function loadSaved() { try { return normalizeLoadout(JSON.parse(localStorage.getItem(KEY))); } catch { return classLoadout('rifleman'); } }
export function save(lo) { try { localStorage.setItem(KEY, JSON.stringify(lo)); } catch { /* storage unavailable */ } }

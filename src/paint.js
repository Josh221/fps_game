// =============================================================================
// paint.js — the paint shop: colours and camo patterns, shared by gun
// finishes (loadout.js / gunsmith.js) and your soldier (avatar.js).
//
// A paint is either SOLID (one colour) or a PATTERN (camo). Patterns aren't
// image files: textures.js generates each one from a few paint colours and
// some noise, once, the first time something asks for it. Because guns,
// uniforms, armour and backpacks all draw from this one list, "woodland" is
// the same woodland everywhere.
//
// Real games do the same thing with "camo" or "skin" tables: a name, a price
// and a texture, applied to whatever material slot the item exposes.
// =============================================================================
import { patternTexture } from './textures.js';

// color: the main colour (sRGB hex). Solids use it directly; for patterns it's
//        the colour the menus and the minimap use as a stand-in.
// pattern: { seed, style: 'blob' | 'tiger' | 'digital', palette: [[r,g,b] 0..1, ...] }
export const PAINTS = {
  black: { name: 'Black', color: 0x262724 },
  sand: { name: 'Sand', color: 0xb19c76 },
  fde: { name: 'Flat dark earth', color: 0x8a7656 },
  coyote: { name: 'Coyote brown', color: 0x74583a },
  od: { name: 'OD green', color: 0x56603e },
  ranger: { name: 'Ranger green', color: 0x464d3c },
  urban: { name: 'Urban grey', color: 0x6e7072 },
  woodland: { name: 'Woodland', color: 0x4a4c34, pattern: { seed: 411, style: 'blob', palette: [[0.32, 0.34, 0.24], [0.22, 0.25, 0.17], [0.4, 0.36, 0.26], [0.14, 0.14, 0.12]] } },
  desert: { name: 'Desert', color: 0x9a8a68, pattern: { seed: 311, style: 'blob', palette: [[0.62, 0.55, 0.42], [0.5, 0.42, 0.3], [0.38, 0.33, 0.24], [0.7, 0.64, 0.5]] } },
  multi: { name: 'Multi-terrain', color: 0x857656, pattern: { seed: 521, style: 'blob', palette: [[0.58, 0.52, 0.39], [0.44, 0.44, 0.3], [0.42, 0.32, 0.21], [0.66, 0.6, 0.47], [0.2, 0.17, 0.12]] } },
  tiger: { name: 'Tiger stripe', color: 0x4c4c34, pattern: { seed: 611, style: 'tiger', palette: [[0.43, 0.43, 0.29], [0.27, 0.31, 0.19], [0.33, 0.26, 0.17], [0.08, 0.08, 0.07]] } },
  digital: { name: 'Digital', color: 0x6b6c5c, pattern: { seed: 711, style: 'digital', palette: [[0.47, 0.47, 0.41], [0.33, 0.35, 0.28], [0.58, 0.56, 0.47], [0.24, 0.24, 0.21]] } },
  arctic: { name: 'Arctic', color: 0xc8cccc, pattern: { seed: 811, style: 'blob', palette: [[0.85, 0.87, 0.87], [0.63, 0.65, 0.67], [0.92, 0.93, 0.94], [0.4, 0.42, 0.44]] } },
};
export const PAINT_IDS = Object.keys(PAINTS);

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

// The paint as a texture: { map, normalMap } (made once, then shared).
// A solid paint gives plain cloth in that colour — sleeves and backpacks
// still look like fabric.
const textures = new Map();
export function paintTexture(id) {
  const p = PAINTS[id] || PAINTS.black;
  if (!textures.has(id)) {
    const pat = p.pattern || { seed: 901, style: 'blob', palette: [rgb(p.color)] };
    textures.set(id, patternTexture(pat.seed, pat.palette, pat.style));
  }
  return textures.get(id);
}

// The pattern's pixels, for painting it onto another texture (avatar.js)
const pixels = new Map();
export function paintPixels(id) {
  if (!pixels.has(id)) {
    const c = paintTexture(id).map.image; // the canvas it was drawn on
    pixels.set(id, { size: c.width, data: c.getContext('2d').getImageData(0, 0, c.width, c.height).data });
  }
  return pixels.get(id);
}

// CSS background for a swatch in the menus: the real pattern, shrunk down
const swatches = new Map();
export function swatchCss(id) {
  const p = PAINTS[id];
  if (!p) return '#000';
  if (!p.pattern) return `#${p.color.toString(16).padStart(6, '0')}`;
  if (!swatches.has(id)) swatches.set(id, `url(${paintTexture(id).map.image.toDataURL()}) 0 0 / 64px 64px`);
  return swatches.get(id);
}

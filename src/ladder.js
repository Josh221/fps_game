// =============================================================================
// ladder.js — fixed steel ladders: the prefab you see, and the data that lets
// players AND enemy soldiers climb them.
//
// A ladder is not a collider. You can't stand on rungs in this game (or in
// most shooters): touching the ladder switches you into a different MOVEMENT
// MODE where W/S move you up and down and gravity is off (see player.js
// _updateLadder). Quake 3, Source and Unreal all do it this way: a "ladder
// volume" in front of the ladder, not physics on every rung.
//
// For the AI, a ladder is an "off-mesh link" (see nav.js): a one-step
// connection between two places the path-finder can't otherwise join — the
// street at the ladder's foot and the roof at its top.
//
// The numbers follow real fixed ladders (OSHA/EN ISO 14122): rungs every 30 cm,
// rails ~16 cm off the wall, and the rails carry on about a metre above the
// roof as hand-holds so you can step off safely ("walk-through" extension).
// =============================================================================
import * as THREE from 'three';

export const LADDER = {
  rung: 0.3,        // rung spacing (m)
  halfWidth: 0.25,  // rails sit 25 cm either side of the centre line
  standoff: 0.17,   // rails/rungs this far off the wall
  climbLine: 0.5,   // a climber's body centre this far off the wall
  landing: 1.0,     // where you end up on the roof: this far INSIDE the wall face
  extension: 1.05,  // rails go this far above the roof (hand-holds)
};

// One painted-steel material for every ladder (sharing it lets Builder.finalize
// merge all ladders on a map into one draw call).
let steel = null;
const steelMat = () => (steel ??= new THREE.MeshStandardMaterial({ color: 0x4a4e44, metalness: 0.55, roughness: 0.6 }));

// Build a ladder up the outside of a wall and register it with the world.
//   (x, z)   a point on the wall's OUTER face, at the ladder's centre
//   (nx, nz) the face's outward normal (axis-aligned: one of ±x, ±z)
//   y0       ground at the foot; y1 = the floor you climb onto (roof top)
//   deck     the walkable area at the top (nav.js builds a little grid on it):
//            { minX, maxX, minZ, maxZ, y }
//   wallThick how thick the wall/edge under the landing is (for the hand-holds)
export function addLadder(builder, { x, z, nx, nz, y0, y1, deck, wallThick = 0.3 }) {
  const world = builder.world, mat = steelMat();
  const L = LADDER;
  // "along" = the horizontal direction ACROSS the ladder (rail to rail)
  const ax = -nz, az = nx;
  const at = (out, along) => [x + nx * out + ax * along, z + nz * out + az * along];
  // A box positioned in the ladder's own frame (out from the wall, along it, height).
  // Ladder walls are always axis-aligned, so we just swap width/depth when it faces x.
  const part = (out, along, y, sizeAlong, h, sizeOut) => {
    const [px, pz] = at(out, along);
    const w = nx !== 0 ? sizeOut : sizeAlong, d = nx !== 0 ? sizeAlong : sizeOut;
    builder.box(px, y, pz, w, h, d, mat, { collide: false });
  };

  const top = y1 + L.extension;
  for (const s of [-1, 1]) {
    const along = s * L.halfWidth;
    part(L.standoff, along, y0 - 0.05, 0.05, top - y0 + 0.05, 0.06);             // rail (flat steel bar)
    // walk-through: the rail bends over the edge and comes back down onto the roof
    const reach = L.standoff + wallThick + 0.35;
    part(L.standoff - reach / 2 + 0.03, along, top - 0.05, 0.05, 0.05, reach);  // over the top
    part(L.standoff - reach + 0.03, along, y1, 0.05, top - y1, 0.05);            // down to the roof
    // brackets bolting the rail to the wall, every couple of metres
    for (let y = y0 + 0.6; y < y1 - 0.3; y += 2.1) part(L.standoff / 2, along, y, 0.04, 0.06, L.standoff);
  }
  // Rungs from just off the ground to the landing (none above it: you step off there)
  for (let y = y0 + L.rung; y <= y1 + 0.02; y += L.rung) part(L.standoff, 0, y - 0.015, L.halfWidth * 2, 0.03, 0.03);

  // ---- the data the game climbs with ----
  const [cx, cz] = at(L.climbLine, 0);
  const [tx, tz] = at(-L.landing, 0);
  const ladder = {
    x, z, nx, nz, y0, y1, deck,
    cx, cz,                                   // the climbing line: where a climber's body is
    yaw: Math.atan2(nx, nz),                  // the yaw that faces the wall (camera convention)
    foot: new THREE.Vector3(cx, y0, cz),      // where you step on at the bottom
    top: new THREE.Vector3(tx, y1, tz),       // where you step off at the top
    user: null,                               // the soldier climbing it right now (AI takes turns)
  };
  world.ladders.push(ladder);
  if (deck && !world.decks.includes(deck)) world.decks.push(deck);
  if (deck) (deck.ladders ??= []).push(ladder);
  return ladder;
}

// Ladder geometry relative to a position: how far along the ladder (rail to
// rail) and how far out from the wall a point is. Both the player and the
// HUD hint use this to ask "am I standing at the ladder?"
export function ladderLocal(L, x, z) {
  const dx = x - L.x, dz = z - L.z;
  return { along: dx * -L.nz + dz * L.nx, out: dx * L.nx + dz * L.nz };
}

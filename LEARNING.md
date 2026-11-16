# Learning guide: how an FPS is built

This guide walks through the game one system at a time. For each system it names the file in this
project, explains the core idea, points to the code that does the same job in shooters whose source
was released legally, and suggests an exercise.

## Why study released source instead of decompiling?

Decompiling a commercial game gives you machine-generated code. It has no comments and no original
names, and the optimiser has reshuffled it. You spend most of your time guessing what `sub_4A3F10`
does. It also usually breaks the game's licence, and you can't legally reuse anything you find.

Several classic shooters had their **full original source code released** (most under the GPL),
with the real names and the developers' own comments. That is far better material to learn from:

| Game | Where to get it | Why it's worth reading |
|---|---|---|
| **Wolfenstein: Enemy Territory** | `github.com/etlegacy/etlegacy` | Team-based WWII army shooter with classes, objectives, prone, leaning and sprint stamina. The closest match to this project. |
| **Quake III Arena** | `github.com/ioquake/ioq3` | The engine ET was built on. Smaller, and the cleanest place to start. |
| **AssaultCube** | `github.com/assaultcube/AC` | Small modern-military shooter in C++. Very readable. |
| **Half-Life 2 / Source SDK** | `github.com/ValveSoftware/source-sdk-2013` | Valve's official game code, including weapons, NPC AI and movement. |

Start with ioquake3 `code/game/bg_pmove.c` (player movement). It's about 2,000 lines and is the
single most influential piece of FPS code ever written. ET: Legacy has its own version at
`src/game/bg_pmove.c`, with sprint, prone and lean added.

---

## 1. The game loop: `src/main.js`

Every game is a loop that runs about 60 times a second:

```
read input → update player → update weapon → update AI → move bullets → update effects → draw
```

**Key idea:** `dt` (delta time) is the number of seconds since the last frame. Every movement is
multiplied by `dt`, so the game runs at the same speed at 30 FPS or 144 FPS. We also clamp `dt` to
0.05 s, so a hitch doesn't teleport bullets through walls.

**Compare with:** ioquake3 `code/qcommon/common.c` (the `Com_Frame` function) and ET: Legacy
`src/game/g_main.c` (the `G_RunFrame` function).

**Try this:** log `dt` every frame, then open a heavy website in another tab. What happens to it?

## 2. Input: `src/input.js`

Games **poll** input once per frame, asking "is W held right now?", instead of acting inside event
handlers. Pointer lock hides the cursor and gives raw mouse movement.

**Try this:** add a key to toggle a walk/run mode.

## 3. Collision and movement: `src/world.js`, `src/player.js`

What you see (triangles) and what you collide with (here, boxes) are **separate**.

`moveBody()` moves along X, then Z, then Y. On each axis, if the body ends up inside a box it is
pushed back out. That gives you sliding along walls for free. Walking up stairs works by trying to
"step up" when you hit something short. Walking down stairs works by snapping to the floor below.

The player doesn't jump straight to full speed. Velocity moves toward the target speed at a set
rate, which gives weight and momentum, and air control is very low.

**Compare with:**
- ioquake3 `code/game/bg_pmove.c` (`PM_Accelerate`, `PM_Friction`, `PM_WalkMove`)
- ioquake3 `code/game/bg_slidemove.c` (`PM_StepSlideMove`, the same stair trick)
- ioquake3 `code/qcommon/cm_trace.c` (collision traces)
- ET: Legacy `src/game/bg_pmove.c` (`PM_UpdateLean`, prone, sprint)

**Try this:** set `airAccel` to 10 in [src/config.js](src/config.js) and play. You've just added
Quake-style air control.

## 4. Raycasting: `src/world.js` (`_rayBox`)

A ray is a line shot from a point. The **slab test** clips the ray against the three pairs of
parallel planes that make up a box. Rays power bullets, enemy line of sight, the lean-into-wall
check and finding the floor under ejected brass. Almost every FPS question ("can X see Y?",
"what did I hit?") is a raycast.

**Two phases: box first, then the real shape.** A box only approximates most things. A concrete
barrier is narrower at the top than the bottom, a sandbag wall has a rounded top, barrels and
rocks are round, a tree trunk leans and tapers, and a box round a turned crate is up to 40% bigger
than the crate. With boxes alone, more than half the shots aimed just past the edge of cover hit
empty air that counted as solid. That's worst when you're crouched close behind cover, shooting
over it. So props, sandbag walls, rocks and trunks also carry their real triangles (`shape`):
- **Broad phase:** the cheap slab test says which boxes a ray enters.
- **Narrow phase:** only those rays are tested triangle by triangle against what you can see.

Walking still uses the boxes, which are cheaper and good enough for feet. Every physics engine
works this way (PhysX, Havok, Bullet, Source's VPhysics). Measured in this game:
- **Phantom hits:** from ~60% to ~1% of shots past the edge of cover.
- **Frame time:** no measurable change in a firefight. Only about one bullet a frame enters a box.

## 5. Weapons: `src/weapon.js` (logic) and `src/viewmodel.js` (visuals)

Logic and visuals are split, the same way Quake split them between the server and the client.

- **Fire rate:** `cooldown = 60 / rpm`.
- **Spread:** a random point inside a cone. The cone gets bigger when you move, jump or fire
  continuously (bloom), and smaller when you aim or crouch.
- **Recoil:** kicks the camera's pitch. Part of it is stored as `recoilDebt` and recovers on its
  own; the rest you pull down with the mouse.
- **Reload:** a timer, with sounds triggered at set fractions of it. Tactical and empty reloads
  have different lengths.
- **Viewmodel:** drawn in a **second render pass** with the depth buffer cleared, so the gun never
  clips into walls. Sway, bob and recoil are springs and sine waves added on top of a base pose.

**Compare with:** ioquake3 `code/game/g_weapon.c` (`Bullet_Fire`) and `code/cgame/cg_weapons.c`
(muzzle flash, `CG_MachineGunEjectBrass`). View bob is in `code/cgame/cg_view.c`
(`CG_OffsetFirstPersonView`).

**Try this:** add a third weapon (a shotgun firing 8 pellets per shot) by adding an entry to
`WEAPONS` in config.js and looping `ballistics.fire` 8 times.

## 6. Ballistics: `src/ballistics.js`

Quake used **hitscan**: an instant infinite ray. Realistic shooters simulate each bullet as a
**projectile**. Every frame we apply gravity, then raycast only the short segment the bullet travels
that frame (about 14 m at 880 m/s). Penetration compares the material's `pen` cost against the
bullet's remaining power. The near-miss crack checks how close the bullet's path came to your head.

**Try this:** set `muzzleVelocity` to 150 and watch the bullets drop and lag behind your aim.

## 7. Enemy AI: `src/enemy.js`, `src/nav.js`

- **Finite state machine:** each soldier is in one state (`idle`, `patrol`, `alert` or `combat`)
  and specific events move it to another.
- **Perception:** an awareness meter fills based on distance, your stance and your movement.
  This is what makes sneaking possible.
- **Pathfinding:** A* search over a 0.5 m grid, then "string-pulling" to straighten the path.
  Real engines use **navmeshes** (Recast/Detour) instead, but the search is the same A*.
- **Cover:** cover spots are generated automatically next to low objects. A spot is good if your
  line of sight to a crouching head there is blocked.
- **Squad behaviour:** soldiers share your last known position with friends within radio range.

**Compare with:** ioquake3 `code/game/ai_dmq3.c` (bot combat decisions) and `code/botlib/`
(AAS, Quake's navigation system). The Source SDK's `game/server/ai_*.cpp` files are much more advanced,
with schedules, tasks and squads.

**Try this:** give soldiers a grenade. When you've been behind the same cover for more than
5 seconds, throw one at `lastKnown`.

## 8. Rendering: `src/render.js`

- **PBR materials** (`MeshStandardMaterial`): each surface has a color map, a normal map for
  surface bumps, and an "ARM" map that packs ambient occlusion, roughness and metalness into the
  red, green and blue channels. Unreal and Unity use the same channel-packing trick.
- **Image-based lighting:** a photographed HDR sky is turned into an environment map (with
  `PMREMGenerator`) that lights every surface with soft sky light and reflections.
- **Extracting the sun from the sky:** `setupSky()` scans the HDR image for very bright pixels and
  adds up their energy (brightness × the patch of sky each pixel covers). That gives a directional
  light whose intensity, color and direction match the photo. It then clamps those pixels so the
  sun isn't counted twice in the ambient light.
- **Ground bounce:** the sky images have no ground in them, so ceilings would be black. Real ground
  reflects light, so we paint in brightness = ground reflectivity × (sun + sky light) / π below the
  horizon.
- **A shadow map that follows you:** one high-resolution shadow map moves with the player. Its
  position snaps to whole shadow-map pixels so shadow edges don't flicker as you walk.
- **Post-processing chain:**
  world → GTAO ambient occlusion → gun → bloom → tone mapping → color grade.
  It is drawn into a higher-precision buffer (half-float) so bright things like muzzle flashes can
  glow.

- **Keeping it smooth** (each of these fixed a real stutter or flicker in this project):
  - *Dynamic resolution:* when frames miss the display's refresh, render fewer pixels. GPU time
    scales roughly with pixel count, so the game estimates the right scale and jumps there in
    one step.
  - *Frame pacing:* an even 50 FPS feels smoother than a rate that bounces between 100 and 60,
    hence the "half rate" option.
  - *Half-resolution ambient occlusion:* a quarter of the pixels, and almost no visible difference.
  - *Alpha to coverage:* with MSAA, cut-out grass and leaf edges are blended across the 4 samples
    instead of switching hard on and off, which is what made foliage shimmer.
  - *Specular aliasing:* shiny metal with fine bumps makes single-pixel glints that sparkle, so
    the gun is a little rougher and smoother than "real".
  - *Shader pre-warming:* every material is compiled during loading, so your first shot
    doesn't freeze the game.
  - *Sine-free hashing:* the old film-grain noise used `sin()` of large numbers, which loses
    precision on GPUs and shows crawling patterns.
  - *Touch the DOM less:* the HUD only writes a value when it actually changed.

**Compare with:** Unreal's lighting setup (a Sky Light plus a Directional Light) and its
post-process volume. Unreal's "Dynamic Resolution" and "r.ScreenPercentage" settings do the same
job as the dynamic resolution here.

**Try this:** in [src/maps/dustline.js](src/maps/dustline.js), change `hdri` to
`qwantani_late_afternoon_puresky`. The sun direction, shadows and color all update automatically.

## 9. Audio and feeling hurt: `src/audio.js`, `src/hud.js`

A gunshot is layered from a high crack, a mid body and a low thump, plus reverb.
3D positioning uses HRTF panning. Distant sounds are delayed by `distance / 343` seconds and
lose their high frequencies, which is why far gunfire sounds like a dull thud.

**Footsteps (the "foley" bus).** Foley is the film word for body sounds: boots, cloth, kit.
Your own foley gets its own mixer bus, with almost no outdoor echo, because your feet are right
under your ears.
- **A footstep is two hits:** the heel strikes, then the toe rolls down 45–85 ms later, over a
  low thud of body weight. The surface adds its character: gravel crunch (dozens of tiny random
  clicks), grass swish, hollow wood knock (sometimes a creak), and the uneven ring of a steel plate.
- **Baked takes:** the recipes run once at load inside an `OfflineAudioContext`, which renders
  audio as fast as the CPU can, with no speakers involved. That gives 8 "recorded" takes per
  surface. Each step picks a take it didn't play last time and nudges its pitch and volume, the
  same trick games use with real recordings. Identical samples in a row sound like a machine.
- **Left and right feet** are panned slightly apart. Soft (crouched) steps lose their top end.
  Your kit rattles on each step, more when you run and when your loadout is heavier.
- **Other soldiers** use the same takes, placed in 3D, on whatever surface *they* stand on.
  Running soldiers also rattle their kit, so you can hear someone charging round a corner.
- **Rooms:** four times a second the audio checks for a roof over your head. Indoors, a
  short small-room reverb (early reflections plus a ~0.8 s decay) fades in on your own sounds,
  so boots and gunshots sound boxy inside a building.
- **Breathing.** Sprinting doesn't make you pant: as stamina runs low the sprint just eases
  down to a heavy jog. Holding your breath to aim is a sharp inhale, silence, then an exhale
  when you let go. Hold it until it runs out and you **gasp** for air (a long, ragged inhale with
  a little voice in it), then catch your breath with a few short, deep breaths. You can't hold
  it again until you've let go of Shift and got some stamina back.

**Getting hit.** The feedback is layered, as in big shooters:
1. **Sound:** a dull body slap, a ceramic "tok" if your armour plate took it, a grunt, and your
   hearing dulled for a moment (a low-pass filter on the master bus). A headshot rings your ears.
2. **Screen:** a quick red flash, blood-red edges that fade over ~2 s, and a blood splatter
   painted on a canvas at the screen edge facing the shooter.
3. **Direction:** a red arc around the crosshair pointing at the shooter. It's recomputed every
   frame from their position, so it swings round as you turn to face them.
4. **Staying hurt:** below 70 HP the edges stay red, and below 35 they pulse at the same rate as
   the heartbeat you hear while the colour drains (render.js `uHurt`). Death muffles everything.

*In an engine:* Unreal uses **Physical Materials** to tag surfaces and **MetaSounds/Sound Cues**
with a Random node for takes; Unity uses an array of AudioClips with `PlayOneShot` plus an
**AudioReverbZone**. For damage, Unreal fades a **post-process material** weight and Unity a
Volume weight, the same idea as our CSS overlays.

## 10. The asset pipeline: `tools/fetch-assets.mjs`, `src/assets.js`

Studios don't hand-copy art into a project. A manifest lists what the game needs, and a script
fetches and organizes it. Each texture set also stores its real-world size in metres, so a 4 m
ground texture tiles at the right scale. At runtime `assets.js` caches every request, so ten
buildings using the same concrete upload it to the GPU once.

**Try this:** add a Poly Haven texture ID to the manifest, run `npm run assets`, and use it in a
map's `materials`.

## 11. Terrain: `src/terrain.js`

- **Heightfield:** a grid of heights sampled every 2 m from a noise function (fractal Perlin
  noise). Flat building pads are blended in with `applyFlats()`.
- **Collision that matches the visuals:** `heightAt()` splits each grid cell into triangles the
  same way the mesh does, so your feet sit exactly on the ground you see.
- **Texture splatting:** each vertex stores three weights, and the shader blends three full PBR
  texture sets: rock on steep slopes, gravel on roads, and so on. Each texture is also sampled a
  second time at a larger, rotated scale to hide repeating patterns.
- **Shader patching:** instead of writing a lighting shader from scratch, `onBeforeCompile` swaps a
  few chunks of three.js's own standard shader. Shadows, fog and sky lighting keep working.

**Compare with:** Unreal's Landscape material layers and Unity's Terrain layers.

## 12. Vegetation and instancing: `src/vegetation.js`, `src/props.js`

- **Instancing:** one geometry drawn thousands of times in a single draw call. The grass, trees,
  boulders, sandbags, crates and barrels all use it.
- **Chunks:** instances are grouped into 40 m cells so the camera can skip cells that are off screen.
- **Wind:** grass and leaves bend in the vertex shader. Only the tips move, scaled by height.
- **Level of detail:** distant trees are generated with fewer, bigger leaves and coarser branches.
  Grass shrinks into the ground with distance instead of popping out.
- **Foliage lighting:** leaf normals point outward from the crown, so a tree shades like one soft
  volume.

**Compare with:** Unreal's Foliage tool and Hierarchical Instanced Static Meshes, and SpeedTree.

## 13. Characters: `src/character.js`, `src/avatar.js`, `src/viewmodel.js`

- **The models:** four soldiers from Microsoft's Rocketbox avatar library (MIT licence), made by a
  professional studio for research and games. `tools/fetch-characters.mjs` is the CONVERT step of
  an asset pipeline: the originals have 2048 x 2048 uncompressed TGA textures (12 MB each), so it
  shrinks them to 1024 x 1024 JPEGs (~0.3 MB) and writes a `manifest.json` the game reads.
- **Skinning:** each soldier is ~15,000 triangles bound to an 80-bone "Biped" skeleton, fingers and
  all. Every animation clip (idle, walk, run) was motion-captured on that same skeleton, so all four
  soldiers share the clips with no retargeting. `AnimationMixer` blends them by speed, each played
  at a rate matched to the speed so the feet don't slide. Only rotation tracks are kept (bones
  never stretch, so dropping position and scale tracks makes updates ~3x cheaper), plus the root
  bone's position for the bob of each step.
- **Root motion:** the walk and run were filmed moving forwards, so their root bone travels ~1.2 m
  or ~2 m per loop and jumps back when the clip repeats. The game already moves the soldier, so
  `cleanClip` removes that travel ("in-place" animation). It pins the hips over the feet, where
  the idle holds them. Pinning them to each clip's own average instead put a running soldier a
  metre ahead of where he really was, sliding back as he slowed down. Engines call the opposite
  approach "root motion": the clip's travel moves the character, and the code follows the animation.
- **Dying** (`_dying`, `_startDeath`): a "fake ragdoll". Real ragdolls simulate every limb with a
  physics engine. Here a dead soldier goes limp over about a second: arms and head slerp to
  hanging, the knees buckle, and the whole body tips over about his feet with gravity's ease-in
  (the angle grows as t²). What stops every body looking the same is a handful of dice:
  - **Which way.** The killing shot's direction (`killDir`, set in `enemy.js`) knocks him that way,
    give or take 40°; sometimes his legs just go and he drops any old way. The fall can be at any
    angle, so it's a rotation about a horizontal axis at right angles to it: `axis = up × dir`.
  - **The twist.** On the way down he also turns about his own length (a quaternion applied
    *before* the tip-over, `model.quaternion = tilt × spin`), whichever way is the shorter turn to
    lying on his back or his front, never quite square. Which side faces up decides how far he's
    lifted off the ground (his back, his plate carrier or his shoulder).
  - **The sprawl.** Arms by his sides, flung out or past his head, elbows bent or straight; legs
    apart, maybe one knee drawn up; a bend in the back; the head turned. The trick that keeps
    limbs on the ground: lying down, "out from his side" means *across the ground*, so the limbs
    turn about the world's vertical axis. A limb that's lying flat stays flat whatever angle it
    turns through.
  - **The gun.** He lets go straight away, part way down (his arms stay on it until then) or as he
    hits the ground. It keeps the speed his hands had, plus a toss, and `gundrop.js` takes over
    (see section 17).
  `_roomToFall` checks there's 1.85 m of clear floor that way first, so bodies don't fall through
  walls, onto barriers or off roofs, trying further and further round. Boxed in, he crumples onto
  his knees instead. In co-op every player animates the death separately: the dice are seeded with
  the soldier's network id, and the host's `kill` message carries the shot's direction. Note that
  **every die is rolled up front**, before anything that might take a different branch on another
  computer (the same rule as building the level; see section 15).
- **Layered poses with two-bone IK:** the clips don't hold a rifle. Given where a hand must be,
  the shoulder-elbow-wrist triangle has exactly one shape (the law of cosines gives the elbow
  angle from the three lengths). A "pole" point chooses which way the elbow sticks out. Then the
  hand is turned so the palm faces the grip, and each finger joint rotates towards the palm. All
  of this sits in `GRIPS`: a firing hand on a pistol grip, a support hand under a handguard,
  round a foregrip, cupping a pistol. A long gun is posed from its BUTT: the butt pad goes in the
  shoulder pocket, just in front of that soldier's plate carrier (measured from his mesh), and the
  gun hangs off it: level to aim, muzzle down at the low ready. Posing it by the grip instead
  swings the stock straight into the shoulder.
- **Reaching:** a support hand far out along a long gun is beyond the arm's straight reach. Real
  people roll the shoulder forward, so `reachShoulder` swings the collarbone towards the target
  first.
- **First-person arms** (`viewmodel.js`) are the same model in your look, standing with his right
  eye on the camera and his head folded away. Every frame, after the gun has swayed and kicked, the
  same IK puts the hands back on it. During a reload the support hand rides the magazine, and on
  the bolt-action the firing hand works the bolt. Because the arms are real length, a gun only
  fits if it's real size: the gunsmith's guns are built to real dimensions (`BODY` in
  `gunsmith.js`), with the stock in the shoulder pocket.
- **Recolouring uniforms without a mask** (`avatar.js`): the clothes are ACU digital camo. Each
  pixel is sorted once (cloth or not; dark, middle or light square), then any paint is mapped onto
  those three tones, keeping each pixel's brightness. **Gloves** get their own material, found from
  the skin weights: triangles moved only by hand and finger bones are the gloves.
- **Hitboxes on bones:** invisible boxes ride on the head, chest, limbs and so on, so bullet damage
  depends on where the body actually is in that frame of the animation.

**Compare with:** Unreal's Animation Blueprints (blend spaces, layered blend per bone, Two Bone IK,
"FABRIK" and hand IK for weapons) and Unity's Animator with IK passes and Animation Rigging. Many
shooters draw separate arms-only models in first person. Using the full body ("true first person")
is what games like Arma do, so what you see matches what your squad sees.

**Try this:**
- Change how the firing hand holds the grip: edit `GRIPS.trigger` in `character.js` (`f` is the
  way the hand points, `p` the way the palm faces, `curl` how far each finger bends). Then look at
  your hands in first person.
- Make the AI hold their rifles higher at the low ready: the `lowW` line in `Rig.pose`.
- Make deaths slower and heavier: change `dur` (seconds) in `_startDeath`. Or make the arms
  sprawl wider: the numbers in its `arm()` (out from the side, then the elbow bend, in radians).
- Add a fifth soldier: add a Rocketbox military folder to `SOLDIERS` in
  `tools/fetch-characters.mjs`, run `npm run characters`, and add an option to `AVATAR.soldier`.

## 14. Procedural maps: `src/maps/*.js`, `src/builder.js`

Each map is data plus a `build()` function. Builder "prefabs" create both the visuals and the
collision, and support doors, windows, frames, a second floor with stairs, roofs with parapets,
and ruins. Old Town is generated from rules rather than placed by hand. When building is done,
`builder.finalize()` merges every static piece that shares a material into one mesh. Thousands of
wall segments become a few dozen draw calls, like "static batching" in Unity.

**Try this:** make a fourth map. Copy [src/maps/dustline.js](src/maps/dustline.js), change the
sky, textures and layout, and add it to [src/maps/index.js](src/maps/index.js).

---

## 15. Multiplayer: `server/server.mjs`, `src/net.js`, `src/coop.js`, `src/lobby.js`, `src/teammate.js`

Netcode comes down to one question: **which computer decides what?** That's called *authority*.
Every other choice follows from the answer.

**The lobby lives on the server.** Who's in the room, who's ready, the map, the settings and
whether a mission is running are all kept in `server.mjs`. Every change goes out to everyone as one
`room` message, and `lobby.js` simply draws whatever arrived. The lobby can't live in the host's
browser, because it has to survive pages reloading. Maps are built when the page loads, so changing
map means *everyone reloads*. To make that work, each player gets a secret **token** when they join
and keeps it in `sessionStorage`. Coming back with it within a minute (after a map change, a
refresh or a Wi-Fi drop) gives you your old slot, with the same id and name. Steam lobbies and Epic
Online Services provide exactly this for commercial games; Unreal calls it "sessions".

**Topology.** The host's browser is a **listen server**: it's a player *and* it runs the game
rules. `server/server.mjs` is only a relay. It forwards messages between players and never
simulates anything. Unreal's listen servers work the same way, and so does hosting a Source game
from the main menu. A **dedicated server** would run the AI here instead, with no player attached.
That's what competitive games use, because then no player's computer can be trusted with the rules.

**Who owns what in this game:**

| Thing | Decided by | Everyone else sees |
|---|---|---|
| Lobby: players, ready flags, map, mission rules (difficulty, length, enemy radar), mission running | the server (the host chooses) | the `room` message |
| The level: buildings, crates, trees, rocks | nobody: every computer builds the same one from the map's seed | — |
| Enemy AI, enemy health, waves | the host | "puppets" that copy the host's snapshots (`EnemyPuppet` in coop.js) |
| Your movement, ammo, health | your computer | a `Teammate`, blended between updates |
| Whether your bullet hit an enemy | your computer, sent to the host as a "hit report" | a replica bullet that can't hurt anyone |
| Whether an enemy bullet hit you | your computer | the same bullet, harmless to them |
| Who picks up a gun or ammo off a body | the host (a friend asks with `lq` and waits) | an `lt` message: who took what (loot.js) |

**Same level on every computer.** The level is never sent over the network. Each browser builds
it itself with a *seeded* random number generator (`mulberry32` in textures.js): the same seed gives
the same numbers, so it gives the same buildings, trees and rocks. That only holds if every
computer asks for the **same numbers in the same order**. The trap: grass amount follows the
graphics preset, so a Low player drew fewer random numbers for grass, and every tree and rock
placed *after* the grass landed somewhere else. Tree trunks stop bullets, so a Low player and a
High player were fighting in different forests. The fix (main.js) is a second seeded stream,
`decoRand`, for looks-only scatter whose amount can vary. Anything solid only ever uses `rand`, and
never depends on the preset. Lockstep RTS games (Age of Empires, StarCraft) live or die by this
rule: one extra `random()` call on one computer and the two games drift apart for good.

**Mission rules are room settings.** Difficulty, mission length and the enemy radar change what
players *know* and *face*. If each player picked their own radar, one could see every enemy while
the others saw none. So they're stored once, in the server's room, and `coop.js` applies the
room's values on every computer (`_setRoom`). Personal settings like mouse sensitivity, field of view
and graphics stay in each browser.

**Snapshots and interpolation.** Twenty times a second the host sends one message listing every
soldier's position. Updates arrive unevenly, so everyone else is drawn **100 ms in the past**,
blended between the two updates either side of that moment (`Interpolator` in net.js). Quake 3
does exactly this: see ioquake3 `code/server/sv_snapshot.c` (building snapshots),
`code/cgame/cg_snapshot.c` and `CG_InterpolateEntityPosition` in `code/cgame/cg_ents.c`. In
Source the same settings are called `cl_updaterate` and `cl_interp`.

**Clock sync.** To blend correctly you need to know what time it is on the sender's computer.
`RemoteClock` uses the trick most games use: the fastest message you've seen gives the best
estimate of the difference between the two clocks.

**Voice chat: `src/voice.js`.** Game data goes through the host, but voice goes **directly between
browsers** with WebRTC, one link per pair of players (a "mesh"). To set up a link, the two browsers
swap an *offer*, an *answer* and some *ICE candidates* (addresses to try). That exchange is called
**signalling**, and it travels over our lobby server as `sig` messages. Then the audio flows
peer-to-peer. A **STUN** server tells each browser its public address, so links can cross home
routers. Very strict networks need a **TURN** relay instead, which costs bandwidth, so this game has
none. Your microphone always sends, but while you're not talking it sends silence. Push-to-talk just
switches a copy of the mic track on and off, so nothing has to be renegotiated. Real games do the
same with Vivox (Unreal, Fortnite) or Steam Voice. The extra rule in a browser is that microphones
need a **secure context** (`https://` or localhost), which is why the server also speaks HTTPS.

**Client-side hit detection vs lag compensation.** Here your own computer decides whether you hit
something, so "if it was under my crosshair, it hit" always holds, even with lag. The weakness is
that a cheater could send fake hit reports. Source keeps the server in charge instead and uses
**lag compensation**: when your shot arrives, the server *rewinds* every other player to where
they were on your screen (your latency plus the interpolation delay), checks the hit there, then
puts them back. Read Valve's "Source Multiplayer Networking" and "Lag compensation" pages on the
Valve Developer Community wiki.

**What this skips (and real games add):**
- **Client-side prediction.** You own your movement here, so it never waits for the network. When
  the server owns movement (Quake 3, Source, every competitive shooter), your computer predicts
  your movement immediately and corrects it when the server's answer comes back. See ioquake3
  `code/cgame/cg_predict.c`.
- **UDP.** WebSockets run over TCP, which delivers everything in order. One lost packet therefore
  delays all the ones behind it, which is fine on good connections. Real shooters use UDP and simply
  ignore old snapshots. Browsers can do this with WebRTC data channels or WebTransport.
- **Delta compression and binary messages.** Our messages are readable JSON (up to about 2 KB per
  snapshot). Quake 3 sends only what *changed* since the last snapshot the client confirmed,
  packed into bits (`code/qcommon/msg.c`, `MSG_WriteDeltaEntity`).

**In engines:** Unreal calls this **replication**. Actors have a *role*: `ROLE_Authority` (the
host's copy of an enemy), `ROLE_SimulatedProxy` (a puppet or a teammate) and
`ROLE_AutonomousProxy` (you). Values marked `Replicated` are sent automatically, and RPCs
(`Server`, `Client`, `NetMulticast` functions) send events like our `sh` and `ht` messages. Godot
has `MultiplayerSynchronizer`, `MultiplayerSpawner` and `@rpc`. Unity has Netcode for
GameObjects (`NetworkTransform` interpolates for you).

**Try this:**
1. Set `NET.interpDelay` to 0 in [src/config.js](src/config.js) and watch squadmates stutter. Then
   set `NET.sendRate` to 5 and see how far behind they fall.
2. **Validate hit reports.** In `_friendHit` (coop.js), reject a hit if the enemy is more than
   300 m from the shooter, or if `world.lineOfSight` says there's a wall between them. That's the
   first step toward a cheat-resistant server.
3. Add friendly fire. Hint: make `Teammate` a ballistics target on the shooter's computer, and send
   the damage to its owner with a new message type.
4. **Check the level matches.** In the browser console, fingerprint every solid box:
   `game.world.colliders.reduce((h, c) => h + c.min.x * 3.1 + c.min.z * 7.7 + c.max.y, 0)`.
   Run it on Low and on High (Settings → Graphics): the number is the same. Then, in a map file,
   give the grass `rand` instead of `decoRand` and try again: the number changes, because the trees
   and rocks moved.
4. **Proximity voice:** instead of an `<audio>` element per player, route each voice through a
   `PannerNode` at that teammate's position (like the gunshots in audio.js). Then friends far away
   sound quiet and come from the right direction.
5. Add a lobby setting. For example, a "Respawn time" choice: add it to `applySettings` in
   server.mjs, add a `<select>` to the lobby in index.html and lobby.js, and read
   `coop.room.respawn` where main.js uses `NET.respawnTime`.

---

## 16. Tactical movement and gear: `src/player.js`, `src/grenades.js`, `src/minimap.js`

**Stances and vaulting** (`player.js`):
- A stance is a small state machine (stand, crouch, prone). Each stance has its own collision
  height, eye height, speed and accuracy.
- Changing stance checks there's headroom first (`bodyBlocked`), and takes time (`stanceBusy`),
  so you can't drop prone and shoot in the same instant. The AI also finds prone players harder
  to see, especially in grass.
- **Vaulting** probes the world in front of you: is there an obstacle within reach, how high is
  its top, is there room above it, and where is its far side? Then a *scripted move* takes over
  for half a second, and the game moves you along a curve instead of using physics. Modern games
  do the same with "traversal" or "motion warping" animations.

**Grenades** (`grenades.js`):
- A grenade is a projectile with **collision response**. Each 1/120 s step ray-tests the short
  path ahead. On a hit, the velocity splits into the part *into* the surface (reversed and
  reduced by `bounce`) and the part *along* it (reduced by `friction`).
- That's the same impulse maths as any physics engine, done by hand.
- Explosion damage falls off with distance and needs line of sight to your chest, so cover
  really matters.
- **Six types, one system** (`TYPES` in `grenades.js`): they all share the same flight code,
  and only differ in two moments: what happens on a **hit** and what happens when the **fuse**
  ends. That's data-driven design again (like the attachments), the same idea as Call of Duty's
  lethal and tactical slots:
  - frag: bounce on a hit; blast on fuse.
  - sticky: on a hit, stop (velocity = 0). If the hit was a soldier, keep the offset from his
    feet and copy his position every frame, so it rides along on him.
  - impact: on a hit, blast now, but only once `age >= armAfter`. Real impact fuses arm after a
    few metres of flight for exactly this reason: so they can't kill the thrower.
  - smoke, flashbang and decoy: on fuse, start a cloud, a flash, or a fake firefight.
- **Hitting a soldier** (`_soldierAt`): the grenade's position is tested against an upright
  cylinder around each enemy, 0.36 m in radius and 1.75 m tall. Bullets need exact hitboxes; a
  thrown grenade doesn't.
- **Flashbang** (`_flashbang`, `enemy.js` `flash`): three questions decide how blinded you are:
  - Could your eyes see it? Use the line-of-sight test. A wall in the way means it only
    deafens you.
  - How close was it?
  - Were you looking at it? Take the dot product of where you look and the direction to the
    flash: 1 means staring at it, −1 means your back is turned.

  Blinded enemies skip perception entirely (`perceive` returns early), so they can't see you,
  can't aim and stop to crouch. Your own blindness is a white `<div>` over the screen. It stays
  solid for the first 40% of the time, then fades. Your hearing goes through the same
  `deafen()` used for nearby explosions.
- **Decoy:** it calls the same `enemies.hearNoise()` a real gunshot does. The AI can't tell the
  difference, because to the AI a gunshot is just a position and a loudness.
- **Claymore** (`_plant`, `_tripped`, `_claymoreDamage`): a mine is just a position plus a
  facing direction `dir`.
  - **The trigger:** an enemy is "in front" when the dot product of `dir` and the (flat)
    direction to him is above cos 50°, and he's within 3.5 m.
  - **The blast:** it uses the same test with a narrower angle (cos 32°) and a longer range.
    So "directional" damage is two dot products and a distance check, the same maths as a
    vision cone.
  - **Co-op:** only the HOST decides when a claymore is tripped, because it knows where the
    enemies really are. It then sends one `mx` message ("the claymore at this spot went off"),
    and every other computer sets off its own copy. When one computer must make the call and
    tell the others, that's called **authority**.

**Enemy grenades** (`enemy.js`, `_throwGrenade`):
- The AI solves projectile motion for a fixed launch angle θ: v² = g·d² / (2·cos²θ·(d·tanθ − Δy)).
  That gives the throw speed to land at a target d metres away and Δy metres higher.
- The same formula appears in every "lob a projectile at the player" AI.

**Minimap and radar** (`minimap.js`):
- The map background is the level itself, rendered once from straight above with an orthographic
  camera, which has no perspective.
- Each frame a 2D canvas draws that photo rotated by your yaw. Markers are then drawn in the same
  rotated coordinate system, so the "world → minimap" maths is done by the canvas transform.
- The radar modes are just different rules for which enemies to draw. "When firing" reads the
  `lastFiredAt` timestamp each enemy records when he shoots.

**Spotting:** find the enemy whose direction is closest to your crosshair (the angle between two
vectors), check line of sight, and mark him. In co-op, that mark is sent to the squad.
Line of sight is tested to **three points** on his body (head, chest, hips, lower when he
crouches), and seeing any one is enough. An early version tested one fixed chest-height point.
In Old Town that missed about a third of enemies whose head showed over a wall or window ledge.
It also let you spot a man crouched fully behind cover, because the point floated above his head.
One-point visibility checks are a classic bug; Unreal's AI Perception has the same
"which points can I see?" problem.

**Compare with:** ET: Legacy's `bg_pmove.c` (prone and leaning: `PM_UpdateLean`, prone checks) and
`g_missile.c` (grenade bounce: `G_BounceMissile`). Battlefield's Q-spotting and Call of Duty's
radar pings are exactly these mechanics.

## 17. Loadouts and attachments: `src/loadout.js`, `src/gunsmith.js`, `src/armory.js`, `src/scope.js`

**Data-driven design** (`loadout.js`):
- An attachment is not code. It's a list of **stat modifiers**:

  ```js
  suppressor: { mods: [['loudness', '*', 0.3], ['muzzleVelocity', '*', 0.95], ['suppressed', '=', true]] }
  ```

- `buildWeapon()` copies the base gun from `config.js`, then applies each chosen part's
  modifiers in turn. The rest of the game only ever sees the finished numbers. `weapon.js`
  doesn't know suppressors exist. It just reads `cfg.loudness`.
- To add a new part, you add one line of data. Call of Duty's Gunsmith and Battlefield's
  customisation work the same way, with much bigger tables.
- **Allow lists.** Each gun lists which parts it accepts (`GUNS.lmg.allow`), so a bolt-action
  can't take a drum mag.

**Kit weight:** every gun, part, grenade and armour plate has a weight. `resolveLoadout()` adds
them up and turns the total into a speed multiplier and a stamina-drain multiplier, which
`player.js` applies. One number ties together dozens of choices: the trade-off is the game design.

**Procedural gun models** (`gunsmith.js`):
- Each gun is built from simple shapes. A profile (a 2D outline) is extruded for receivers and
  stocks, and boxes and cylinders make up the rest.
- Every part has a fixed mount point: the rail top for optics, the barrel end for muzzle
  devices, the magazine well for mags.
- **Sight alignment** is the important bit. Each optic reports where its rear lens is, and the
  ADS pose moves the whole gun so that the optic's centre line passes exactly through the
  camera. That's why every optic you fit lines up.
- **Gotcha:** a transparent lens must not write depth (`depthWrite: false`). If it does, the
  glowing reticle drawn behind it fails the depth test and vanishes.

**Squadmates' guns** (`teammate.js`, `character.js`):
- Your guns travel as a short text string, for example
  `smg.holo.suppressor.short.agrip.std.std.fmj.black/pistol.iron.suppressor.std.fmj.black`.
  That's the gun id, then one part per slot (`encodeWeapons` / `decodeWeapons` in `loadout.js`).
- The string rides in the lobby's room state, so everyone gets it, including players who join
  later. The receiver checks every part against the tables, so a garbled string can only ever
  produce a legal gun.
- Which gun is in your hands is one extra number in each 20 Hz player update.
- The third-person soldier uses the same `buildGun()` model as your first-person view. The gun
  sits in a holder with its grip at the origin.
- The arms are solved with IK once per way of holding a gun, and cached. A long gun has its
  support hand on the handguard, and the SMG's is much closer than an LMG's. A pistol is held
  out at arm's length with both hands.

**Comparing options** (`armory.js`): to show what a part would change, the armory builds the gun
twice, with and without it, and compares `weaponStats()` of both. The UI never computes a stat
itself, so the screen can never disagree with what happens in game.

**Scopes** (`scope.js`): games don't render the inside of a scope tube. When you're fully aimed
in, they:
- hide the gun;
- divide the field of view by the zoom (6x = one sixth of the FOV);
- draw a flat picture over the screen: a black mask with a round hole and a reticle.

The "scope shadow" (the black ring sliding as you sway) is just that mask moved by the
viewmodel's sway values.

**Variable zoom** (`weapon.js` `_turnZoomRing`): the sniper scope's optic has a list of powers,
`zoomSteps: [3, 4, 5, 6, 8, 10, 12]`, like the numbers printed on a real scope's magnification
ring. While you hold right mouse, each wheel notch moves one step. Two details:
- each gun's state remembers its setting (`zoom`), so the scope stays where you left it;
- the view doesn't jump. `zoomNow` eases towards `zoom` by a fraction of the RATIO each frame
  (`zoomNow *= (zoom / zoomNow) ^ (dt * 10)`), so 3x to 4x takes as long as 9x to 12x.
  Easing the difference instead would make the high-power steps feel sluggish.

Mouse sensitivity already scales with the field of view (`player.js`), so 12x automatically
turns slower than 3x. Sway is an angle, so a narrower view makes it look bigger on screen with
no extra code. That's the real trade-off of high magnification. Unreal and Unity do zoom the same
way: change the camera's FOV (`SetFieldOfView` / `Camera.fieldOfView`).

**Smoke** (`grenades.js`, `world.js` `smokeBlocks`):
- A smoke cloud is two things. One is what you see: hundreds of soft, lumpy particles. The
  other is what the AI checks: an invisible squashed sphere.
- `smokeBlocks(a, b)` finds the closest point on the line from a to b to the sphere's centre.
  If it's inside the sphere, the AI's line of sight is blocked.
- This is a classic split in games: the rendering and the gameplay logic are separate models
  of the same thing.

**Taking from the fallen** (`loot.js`, `gundrop.js`):
- **What they carry.** `ENEMY_ISSUE` in config.js lists the enemy's guns as ordinary loadout
  entries, `{ id: 'dmr', mods: { optic: 'acog' } }`, plus how the AI fires each (rpm, burst
  length, damage). `issueFor(id)` in enemy.js rolls a soldier's gun and spare magazines from his
  network id, so every co-op computer works out the same answer without sending it. Because they
  are real loadout entries, a gun you pick up is built by the same `buildWeapon()` as one from the
  armory. Nothing about it is special.
- **Calibres.** Each gun in `GUNS` has a `cal`. Ammo off a body only goes into a gun of the same
  calibre, up to that gun's normal reserve. One field gives you a reason to look at what the dead
  man was carrying.
- **Picking what you mean.** Everything within reach gets a score: the angle between where you're
  looking and the thing, plus a little for distance. The lowest wins. It's the same test as an
  aim-assist cone or "use" in Half-Life. Taking ammo is a press, but swapping a gun is a *hold*
  (0.4 s), because a press is too easy to do by accident. The hold only counts on the gun you
  pressed at, so holding F after a swap can't swap you straight back.
- **A dropped gun** (`gundrop.js`) is a tiny rigid-body simulation: gravity, a spin, a floor
  (`world.floorBelow`: terrain, or the top of a roof or a crate), bounces off walls, friction that
  really stops it (a fixed slowing, not a percentage), and a capsule round the body so the gun
  slides off him rather than ending up hidden underneath. It runs on a **fixed time step**
  (1/120 s, with the leftover time carried to the next frame). Physics stepped by the frame time
  behaves differently at 30 and 144 FPS, while fixed steps behave the same everywhere. Box2D,
  PhysX and Unity's `FixedUpdate` all work this way.

**Try this:**
- Add a new attachment, such as a laser that cuts hip-fire spread (`['hipSpread', '*', 0.7]`).
  Add it to `ATTACHMENTS.underbarrel` and to a gun's allow list. You don't need any other code.
- Add a shotgun: a `WEAPONS` entry with a `pellets` count, and make `weapon.js` fire that many
  bullets with spread.

## 18. Cosmetics: paint jobs and your soldier: `src/paint.js`, `src/avatar.js`, `src/armory.js`

**Cosmetic slots are just data with no stat modifiers** (`loadout.js`):
- The gun finish, metal and reticle colour are ordinary attachment slots whose `mods` list is
  empty. `buildWeapon()` applies nothing, so they can never change how a gun shoots.
- They ride in the same network string as your attachments, so squadmates see your paint for
  free: `rifle.reddot.std.std.vgrip.std.std.fmj.woodland.bronze.green/...`.
- **One paint library for everything** (`paint.js`). Gun finishes, armour, uniforms and backpacks
  all draw from one list, so "woodland" looks the same on all of them. Games keep camo tables
  the same way.

**Camo is noise** (`textures.js` `patternTexture`):
- Each pattern stacks a few layers of noise. Wherever a layer's value is above a threshold, it
  paints its colour on top. Only the way the noise is read changes between styles:
  - **Blob** (woodland, desert): plain noise.
  - **Tiger stripe:** noise that is 4x finer vertically than horizontally, so the blobs
    become long brush strokes.
  - **Digital:** noise read on a coarse grid, so the blobs come out blocky.
- **Wood grain** uses the same trick. The noise is stretched even further into long fibres,
  then put through a sine wave to make growth rings.

**Recolouring a character with a tint mask** (`avatar.js`):
- The soldier has ONE colour texture, an **atlas**: every part of the body unwrapped flat onto
  one image, with tan plates, olive cloth, a black undersuit and red stripes.
- Games that let you recolour armour (Halo, Destiny, Rainbow Six) ship a second **mask**
  texture, where an artist painted which pixels are plates, which are cloth and so on. A shader
  mixes in your colours.
- We have no mask, so `analyseAtlas()` works one out once from the colours themselves. Each
  pixel is converted to hue, saturation and brightness:
  - orange-ish, bright pixels are plates;
  - yellow-green pixels are cloth;
  - strongly saturated red pixels are stripes.
- Each look is painted onto a copy of the atlas. A masked pixel takes the new colour, or that
  spot of the camo pattern, times **how light it was compared with the average of its part**.
  That ratio keeps the original shading, seams and paint chips, so the repaint still looks worn.
- The dark-brown paint chips on the plates are too dark to count as "plate", so they stay as
  they were. That's why a black or arctic soldier still looks scuffed.
- **Sharing:** a painted atlas is 1024x1024, so everyone wearing the same look shares one copy
  (reference counting). A few unworn looks are kept in case you switch back.

**Attaching gear to bones:**
- The headset, NVGs, backpack and radio are boxes and cylinders, like the guns.
- They're laid out in metres around the soldier's rest pose. The numbers come from measuring
  the skinned mesh: the helmet's sides are at x = ±0.095 and the back of the torso is at
  z = +0.2.
- Each piece then goes into a holder that's a child of a bone (`Head` or `Spine2`). The
  holder's transform is the **inverse of that bone's rest-pose world matrix**, so the gear
  starts exactly where it was laid out and then follows the bone through every animation.
- **Gotcha:** this model's bones are in centimetres, scaled by 0.01. The inverse matrix
  contains the ×100 that undoes it, which is why you can lay gear out in metres.

**First person:** you can't see your own body. `dressFirstPerson()` instead swaps the texture and
colour of the shared sleeve and glove materials the viewmodel uses. They're shared, so every gun's
hands change instantly.

**The look on the wire:** another short string in the lobby state,
`ranger.woodland.none.smoke.black.headset.none` (`encodeAvatar`). Like the guns, every part is
checked against the tables when it's decoded.

**Try this:**
- Add a new camo pattern: one entry in `PAINTS` with a palette and a style. It appears on guns,
  armour, uniforms and backpacks with no other code.
- Add a boonie hat or a different backpack to `_gear()` in `avatar.js`, as a new option in
  `AVATAR.head` or `AVATAR.back`.
- Show each squadmate's markings colour on their name tag or minimap dot.

## 19. Ladders, windows and falling: `src/ladder.js`, `src/player.js`, `src/nav.js`, `src/enemy.js`

**A ladder is a movement mode, not physics** (`ladder.js`, `player.js` `_updateLadder`):
- Nobody simulates feet on rungs. In front of each ladder is an invisible "ladder volume". Walk
  into it facing the ladder and you switch into a different movement mode: gravity off, W/S move
  you up and down, and you're pulled onto the climbing line. Quake 3 (`PM_LadderMove`), Source
  (`CGameMovement::LadderMove`) and Unreal (`MOVE_Custom`) all do it this way.
- The two ends are **scripted moves**, the same tool as vaulting. At the top you pull yourself
  over onto the roof (the mantle move). On the roof, walk toward the opening and the game steps
  you out, turns you round and puts your hands on the top rungs.
- Both hands are on the rungs, so the gun is slung (`weaponBlocked`) and grenades are off.
- Real numbers: rungs every 30 cm, rails 16 cm off the wall, and rails that carry on ~1 m above
  the roof as hand-holds. That's how fixed ladders are built (OSHA / EN ISO 14122), and it's why
  you can see where the ladder comes out on the roof.

**Off-mesh links: how the AI climbs** (`nav.js` `Navigation`):
- The nav grid is flat, and a roof sits above a street at the same (x, z), so one grid can't hold
  both. Each roof gets its own small grid (a "deck"), and each ladder becomes an **off-mesh
  link**: "from this ground cell you can reach that roof cell, by climbing".
- A path that changes level is stitched from pieces: roof grid → ladder down → ground grid →
  ladder up → roof grid. The ladder step is just a waypoint tagged `.ladder`; when the soldier
  reaches it, `enemy.js` switches him into climbing (`_startClimb`, `_climbLadder`).
- Recast/Detour (Unreal, Unity, Godot) use exactly this name. In Unreal, designers place links as
  "Nav Link Proxies" for ladders, jumps and vaults.
- Soldiers take turns on a ladder (`L.user`), can't shoot while climbing, and when shot they
  let go and fall. A soldier who hears you on a roof walks to the ladder and comes up after you.
- **Animation:** the climbing pose is two IK solutions (left hand high, right hand high) on the
  rung positions. `character.js` swings between them in time with the rungs while the knees
  step up in turn, the same "solve once, blend" trick as the rifle poses.

**Vaulting through windows** (`player.js` `_ledgeAt`, `_planVault`):
- The first vault probe took the *highest* thing in front of you. At a window that's the wall
  above it, so window vaults never worked. The probe now climbs the **stack** of boxes rising from
  your feet. The top of that stack is the ledge (the sill), and the bottom of the next box up is
  the ceiling (the lintel). If the gap between them is at least 75 cm, you can dive through.
- In that gap the camera has to stay under the lintel, so a window vault overrides the eye height
  (`vault.eye`): you go through low and head first.
- The "is the way clear?" test now samples small boxes along the vault line, instead of one big
  box from start to end. The big box fills the whole corner when you approach at an angle, and
  its min/max came out backwards when you vaulted toward −x or −z.
- A hurdle at a run keeps ~85% of your speed (`exitSpeed`). The HUD prompt ("[SPACE] VAULT",
  "VAULT THROUGH", "CLIMB UP") runs the same planner a few times a second.

**Falling** (`player.js` `_hardLanding`):
- `moveBody` returns how fast you hit the ground. A drop of h metres gives v = √(2gh): ~7.7 m/s
  from 3 m, ~11 m/s from a 6 m roof. Damage starts at 7.5 m/s and rises 16 HP per m/s, so a
  two-storey roof costs about half your health and ~9.5 m kills you.
- Landing **crouched** takes a third off: bent knees, as in the paratrooper's parachute landing
  fall. A bad landing also leaves you **limping**: slower, no sprinting, until a bandage strap-up
  (H) or a few seconds pass.
- Vaulting a roof parapet doesn't carry you safely to the ground: you go over and then *fall*,
  fall damage and all.

**Compare with:** Source's `gamemovement.cpp` (`LadderMove`, `CheckFalling`, and
`PLAYER_FATAL_FALL_SPEED`, which defines fall damage exactly this way), Recast/Detour's
`dtOffMeshConnection`, and ET: Legacy's `bg_pmove.c` (`PM_CrashLand`).

**Try this:**
- Add `ladder: { side, at }` to another building in a map file. Its roof becomes a deck the AI
  can path to, with no other code.
- Let soldiers *slide* down ladders when in a hurry (feet on the rails): a faster descent while
  `state === 'combat'`.
- Give roof decks their own cover points along the parapets, so soldiers up there crouch and peek
  like they do behind sandbags.

## 20. Set dressing: `src/decor.js`

Level art is built in two passes. The **blockout** (greybox) makes the playable shapes: walls,
floors, cover. That's `builder.js`. Then **set dressing** fills the spaces with what people leave
behind: doors, shutters, curtains, furniture, shop signs, posters, grime, litter, wires, camo nets.
It hardly changes how a level plays, but it's most of how it looks. Unreal and Unity level artists
spend most of their time here.

**How it fits in:**
- `builder.building()` returns a *descriptor* (openings per side and floor, stairs, roof) and keeps
  it in `builder.buildings`. Each map runs a decor pass over that list. Decor never guesses where a
  window is.
- Rooms are furnished by a small **layout solver**. The room keeps a list of taken rectangles:
  doorways, stairs, AI spots and furniture already placed. A piece only goes against a stretch of
  wall where it fits. Tall pieces never stand in front of a window, and nothing blocks a doorway.
- Exteriors get doors swung open into the room, glazing bars and glass, open shutters, curtains,
  rain pipes, meter boxes, house numbers, posters and graffiti, shop signs with striped awnings,
  balconies, satellite dishes, laundry lines and clay-tile pitched roofs.

**The rules it follows:**
- **Determinism.** Decor has its own seeded random stream. Every co-op player gets the same sofa in
  the same place, and that matters because a sofa stops bullets. Adding a chair never moves a tree
  placed later by the map's `rand`. Nothing depends on the graphics preset.
- **Collision is a choice.** Sofas, tables, doors and HESCO barriers get colliders. Vases, frames,
  chairs and litter don't, so they never block a path or a line of sight with something too small
  to see. Razor wire on the ground uses `solid: false`, which blocks walking but lets bullets and
  eyes through, the same as real wire.
- **Triangle budget.** A scanned vase is 10,000 triangles. A tin of beans is 1,300. On screen they
  are a dozen pixels. Small things are built in code instead: a vase is a `LatheGeometry` (a side
  profile spun round an axis, about 160 triangles), a pot plant is a clay cylinder plus three
  crossed "leaf cards", and a bookcase is boxes with books whose spines come from a texture. Real
  games do the same with LODs (levels of detail) and "cards".
- **Draw calls.** Every door and shutter paint lives in ONE texture **atlas**, as do all fabrics
  (curtains, rugs, awnings, bedding) and all signs. Each piece's UVs point at its own picture, so
  hundreds of pieces share one material. `builder.finalize()` merges them into one mesh: one draw
  call.
- **No new art files.** Shop signs, posters, rugs, curtains, grime streaks and the camo net are
  painted on `<canvas>` at startup.

**Two small "quality" tricks worth knowing:**
- **World-space UVs** (`worldUV()` in `builder.js`). A wall made of many boxes (the pieces
  between windows) used to restart its texture at every box, so seams showed. Now each vertex takes
  its texture coordinate from where it *is* in the world, and the plaster runs on unbroken. Unreal
  calls this "world-aligned textures".
- **Fake bounced light.** A ceiling faces down, away from the sky, so it rendered nearly black.
  Real ceilings are lit by sunlight bouncing off the floor ("global illumination"), which this
  renderer doesn't compute. Decor gives each ceiling a pale panel with a little emissive glow
  instead. Games have always done this; Unreal's Lumen is the modern way to compute it for real.

**Try this:**
- Add a room type: a café with the `outdoor_table_chair_set_01` model indoors, or a classroom.
  Write `_cafe(R)` beside `_living(R)` and list it in `furnish()`.
- Add a new shop to `SHOPS` in `decor.js`. Its sign is painted automatically.
- Give Dustline's HQ a satellite dish on the roof: `decor._dish(x, y, z)`.
- Watch the cost: press F12, then, with the game running, run
  `game.renderer.renderer.info.render` in the console. You'll see the triangles and draw calls of
  the last pass.

---

## 21. Missions and story: `src/campaign/`

A campaign is the same game systems (soldiers, guns, maps) arranged into a sequence of
**objectives** with a story told on top. Almost nothing new happens in the 3D world. What's new is a
layer that decides *what should happen next*.

**Data, not code.** Every mission lives in `story.js` as plain data: where you start, named groups
of enemy soldiers, a list of objectives, the radio dialogue, the briefing. The **director**
(`director.js`) is the engine that reads it. To change a mission you change the data, not the
engine. Real studios split the work the same way:
- **Wolfenstein: Enemy Territory** has a `.script` file per map: `trigger`, `wm_announce` and
  `wm_objective_status` lines that the game interprets. In ET: Legacy's source, read
  `src/game/g_script.c` and `g_script_actions.c`: that's the interpreter.
- **Source** (Half-Life 2) wires entities together with *inputs and outputs* in the Hammer editor:
  a `trigger_once` fires an output, which calls an input on a `logic_relay`, which spawns soldiers.
  The triggers and actions in `story.js` work the same way.
- **Arma's** mission editor has triggers, waypoints and "task" objectives. **Unreal** uses
  Blueprints and Level Sequences. Same idea, with a visual editor.

**Objectives are small state machines.** Each type (`goto`, `clear`, `observe`, `use`, `hold`,
`timer`, `hvt`, `escort`) only answers "is it done yet?" every frame, from the game's state:
- `clear` counts the living soldiers in its groups;
- `hold` adds time only while someone is inside the zone;
- `use` adds progress while someone holds F within 2 m of the site.

When it's done, the director runs the objective's `done` actions (spawn the next group, play a
radio call, show a demolition charge) and starts the next one. Actions can be delayed (`after: 3`),
which gives you pacing: a radio call a moment after an explosion, not on top of it.

**Triggers** are one-off rules that sit outside the objective list: "when the escort reaches the
square, send in a counterattack", "when someone gets close to Kade's house, he taunts you". The
**alarm** is a special trigger: it fires the first time any enemy goes into combat. That's how
stealth works. Mission 1's bonus fails, and a quick-reaction force comes down the hill.

**Checkpoints are snapshots.** When an objective starts, the director copies everything that
matters: which props are visible, the alarm, the escort's position and health, which commanders
are already dead. `retry()` puts those values back, clears the soldiers, and starts the objective
again, running its `retry` actions to bring back the enemies that matter. Games call this
**save/restore of game state**. A real save system writes the same snapshot to disk.

**Making the AI fit the story** took only three small hooks in `enemy.js`:
- `home`: a guard walks back to his post when he's idle. Set it somewhere else and he walks
  there. That's how the courier walks down the track.
- `sightRange`: fog in mission 1 cuts how far they can see, so the weather matters.
- `surrendered`: a badly wounded commander kneels and stops fighting.

An attack is just an `alert` with a position: "you heard something over there, go and look". The
escort is a target with `aiWeight = 2.5`. The AI treats her as 2.5 times further away than she is,
so they go for the squad first. Escort missions where every enemy goes straight for the VIP are
famous for being miserable.

**Co-op: one director.** Only the host runs it, for the same reason only the host runs the AI (see
chapter 15). Everyone else needs three things:
1. **The mission state**: objective, progress, bonus goals, the escort's position. It rides inside
   the host's snapshot, 20 times a second, so a friend who joins late is in sync within one update.
2. **One-off moments**: radio calls, explosions, "objective complete". These go as events. If you
   miss one (you were in the lobby), the state still catches you up.
3. **The other way round**: when a friend holds F on a charge, their computer sends `act` messages,
   "I'm using site #0 right now", several times a second. The host counts them, after checking the
   friend is really standing there. The friend's progress bar comes back in the next snapshot.

**The radio** uses the browser's own text-to-speech (`speechSynthesis`). Each character asks for a
male or female English voice, then gets their own pitch and speed. It's crude next to recorded
actors, but the script stays editable text, and that's how many games prototype dialogue before
the voice actors come in. While the jammer is up in mission 4, lines lose words at random:
`garble()` in `radio.js`.

**Try this:**
- Change mission 1's courier so he walks somewhere else: edit his `to` in `story.js`.
- Add a trigger to mission 3: when someone reaches the motor pool, Raven warns about a sniper on
  the HQ roof, and a `sentry` group spawns there.
- Write a sixth mission. Copy one in `MISSIONS`, change its map, its groups and its objectives.
  Check your positions in the console: `game.director.load('your-id'); game.director.pointsToCheck()`.
  Then stand on each one and make sure you're not inside a wall.
- Add a new objective type, `defuse`: like `use`, but the charge explodes if a timer runs out
  first. You need a case in `_objective()`, a line in `hudHtml()` and one in `markers()`.

---

## 22. Going public: `server/server.mjs` (section 5), `src/coop.js`, `src/voice.js`

On your Wi-Fi, everyone who connects is a friend. On the internet, anyone can connect: bored
people, scripts that scan every address, and players who'd like to see what breaks. Every online
game protects itself in the same few ways, and this server now has a small version of each.
(README: "Hosting publicly" has the setup.)

**1. Trust boundaries: never trust what crosses one.** A *trust boundary* is anywhere data arrives
from someone else. This game has three:

- **Browser → server.** The server already cleaned names and chat (`cleanName`, `cleanText`), and
  now it also limits how *much* anyone can send.
- **Host → friends.** In a listen server the host's browser is the game's authority. That makes it
  the most dangerous sender: a stranger can host. If their message ends up in `innerHTML`, any
  `<img onerror=…>` they slip in runs as code *in your browser*. That's **XSS**, cross-site
  scripting. Two places did this: a campaign "mission failed" reason, and the wave number in the
  snapshot (which the objective panel turns into HTML). Now the reason goes through `esc()`, and
  snapshots go through `.map(Number)`, so text can't get in. The rule: show other people's text with
  `textContent`, which the lobby, chat, kill feed and scoreboard already did, and treat numbers as
  numbers.
- **Internet → your files.** The old file server sent *anything* in the project folder except
  hidden files: the server's own code, `node_modules`, your notes. Now it uses an **allow-list**
  (`PUBLIC_FILES`), so a new file stays private until you decide otherwise. It checks the path
  **after** resolving it, because `/src/..%2Fserver.mjs` decodes to `/src/../server.mjs`, which
  starts with `src/` but isn't in it. Path tricks like this are one of the oldest web attacks
  (*path traversal*).

**2. Rate limits: the token bucket.** Each connection has two buckets, one of message tokens and
one of byte tokens. They refill at a steady rate up to a maximum (`LIMITS` in `server.mjs`), and
every message must pay from both. Normal play never empties them; a flood does, and then messages
are dropped, just as a router drops packets. A short burst (a firefight) is fine, because the bucket
was full. Steam's servers, Cloudflare and AWS all limit traffic like this. The byte bucket matters
most here: the server copies each host message to every friend, so without it one room could fill
your home upload. The limits were set by **measuring** the worst real case first: a full squad,
20 enemies, everyone firing. That host peaked at about 290 messages and 100 KB in one second, so
the limits are about double that.

**Per-address limits** (connections, new lobbies, wrong room codes) work the same way, counted per
visitor. A 4-letter code from 24 letters has 331,776 possibilities, which a script could try in
minutes. 20 wrong guesses per 10 minutes makes that take years.

**Server-wide limits come from your hardware, not from fairness.** Per-visitor limits stop one
person from hogging the server, but 40 people each staying under them can still swamp it. So the
whole server has a cap too: `MAX_ROOMS` games (default 5). It was sized by load-testing: each full
room in a heavy firefight needs about 0.7 Mbit/s of upload, and the CPU barely notices. So
`MAX_ROOMS` is just your upload speed divided by 0.7. With few places, a connection that sits there
without joining a game is closed after 15 seconds; otherwise a script could hold every place
without playing. Real game servers do the same with a player cap per server and a login timeout,
and add more servers when they're full.

**3. Who is this, really?** Through a tunnel, every connection seems to come from the tunnel
program on the server itself. Cloudflare adds the visitor's real address in a header
(`CF-Connecting-IP`). But anyone can *write* that header, so `clientIp()` only believes it when
the connection really came from a proxy we run, on this machine or the local network. Getting this
wrong either puts every player into one shared limit, or lets anyone dodge the limits with a fake
header.

**4. Caching: let the edge do the heavy lifting.** Each player needs about 100 MB of textures. From
a home connection that's slow, and it doesn't grow with more players. A **CDN** (content delivery
network, here Cloudflare) keeps copies in data centres near the players. The server tells it what
may be copied with `Cache-Control`: `s-maxage=604800` means "Cloudflare may keep this for a week",
and `no-cache` means "check with me every time". Code stays `no-cache`, so an update shows up on the
next reload. Commercial games do the same with patch CDNs (Steam's content servers, Akamai).

**5. NAT traversal: STUN and TURN.** Voice goes browser to browser (`voice.js`). Home routers hide
computers behind one public address (NAT), so each browser first asks a **STUN** server "what's my
public address?" and they try to reach each other there. Some networks still block that, and then
a **TURN** server relays the audio. The relay costs bandwidth, so it needs a password. The server
makes one that **expires** (`ownTurn()` or `refreshCloudflareTurn()`), and the secret it's made from
never leaves the server. That's the same pattern as the short-lived login tokens most web services
use. `iceTransportPolicy: 'relay'` sends *everything* through the relay, so players never learn each
other's IP address. Console games often do this to stop players from attacking each other's
connections.

**In the source games:** Quake III's server limits how often each client can send commands
(`sv_floodProtect`) and has an anti-flood check on connections (`SVC_RateLimit` in ioquake3's
`code/server/sv_main.c`). Source games do the same with `sv_maxrate` and connection rate limits.
Unreal and Unity Netcode limit per-connection bandwidth. Matchmaking services (Steam Datagram
Relay, Epic Online Services) relay traffic the way TURN does, partly to hide players' IP addresses.

**Try this:**
- Run `HOST=127.0.0.1 npm start` and try opening the game from your phone on the same Wi-Fi. Why
  doesn't it load?
- Open `http://localhost:8000/server/server.mjs` and then `http://localhost:8000/src/main.js`. Find
  the line that decides which one you get.
- Lower `LIMITS.msgRate` to 30 and play co-op. Watch the server log, and what happens to your
  friend's movement on your screen. That's why limits are set by measuring first.
- A wrong code gets "No game with that code", but a real code for a full room gets "That game is
  full". So a guesser learns which codes exist. Does that matter for an unlisted game? Change it so
  both say the same thing, and think about what an honest player loses.

---

## Where to go next

This project teaches the **systems**. To build a full game, use an engine that gives you an
editor, an animation pipeline, a physics engine and networking:

1. **Godot 4.** Free and open source, with a small download. A good next step from here: the same
   ideas, plus a visual editor. Its "First Person Shooter" tutorials map closely onto these files.
2. **Unreal Engine 5.** The industry standard for realistic military shooters, used for Squad,
   Ready or Not and Insurgency: Sandstorm. Free until you earn $1M. It's heavier to learn, and its
   full C++ source is readable on GitHub once you link an Epic account.
3. **Unity.** Its "FPS Microgame" template is a good place to read complete game code.

**What still separates this from a AAA game:** hand-authored animations (crouch-walk, reloads,
deaths), ragdoll physics, baked lighting for interiors, artist-made weapons, and destructible
objects. Unreal gives you most of these out of the box. You now know what each one is for.

**Suggested path:** finish two or three of the "Try this" exercises here. Then read ET: Legacy's
`bg_pmove.c` and `g_weapon.c` alongside `player.js` and `weapon.js` in this project. After that,
rebuild this game in Godot from scratch. You'll find you already understand every piece.

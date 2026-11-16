// =============================================================================
// config.js — every gameplay number in one place.
//
// Real games keep tuning data separate from code so designers can tweak feel
// without touching logic (Quake used .cfg/cvars, modern engines use data
// assets). All units are SI: metres, seconds, metres/second, radians.
// =============================================================================

export const PLAYER = {
  radius: 0.3,            // collision cylinder radius (approximated as a box)
  standHeight: 1.8,
  crouchHeight: 1.2,
  proneHeight: 0.6,
  standEye: 1.65,
  crouchEye: 1.05,
  proneEye: 0.32,
  proneSpeed: 0.9,        // crawling
  proneTime: 0.65,        // seconds to get down / up (can't shoot meanwhile)

  vaultMin: 0.45,         // obstacle heights (m above your feet) you can vault over...
  vaultMax: 1.3,
  mantleMax: 2.2,         // ...or climb up onto
  vaultTime: 0.5,
  mantleTime: 0.95,
  windowGap: 0.75,        // a gap at least this tall above a ledge can be dived through (windows)
  ladderSpeed: 1.7,       // climbing a ladder (m/s)...
  ladderSprintMul: 1.5,   // ...faster holding Shift, which costs stamina

  walkSpeed: 3.4,         // ~12 km/h brisk combat walk
  sprintSpeed: 6.2,       // ~22 km/h sprint with kit
  sprintWindedSpeed: 4.3, // out of stamina, Shift is just a heavy jog...
  sprintFadeAt: 35,       // ...and below this much stamina the sprint slows toward it
  crouchSpeed: 1.7,
  adsSpeedMul: 0.55,      // moving while aiming down sights is slower
  groundAccel: 11,        // how quickly velocity reaches target speed (1/s)
  airAccel: 1.2,          // very little air control — no bunny hopping
  jumpVelocity: 3.7,      // ~0.7 m jump with a loadout
  gravity: 9.81,
  stepHeight: 0.45,       // max ledge you can walk up (stairs)

  maxHealth: 100,
  staminaMax: 100,
  sprintDrain: 13,        // per second
  jumpCost: 16,
  staminaRegen: 14,
  staminaDelay: 1.2,      // seconds before stamina regenerates
  holdBreathDrain: 22,
  holdBreathMin: 15,      // stamina needed to start holding your breath
  holdBreathRecover: 30,  // after gasping (held it too long), stamina needed to hold it again

  leanAngle: 0.2,         // camera roll when leaning (rad)
  leanOffset: 0.42,       // sideways head offset when leaning (m)

  // Falling: impact speed from a drop of h metres is sqrt(2·g·h).
  fallDamageMinSpeed: 7.5,  // m/s impact speed before fall damage (a ~2.9 m drop)
  fallDamagePerMs: 16,      // so a 6 m roof (~11 m/s) costs ~55 health, ~9.5 m is fatal
  fallCrouchMul: 0.65,      // land crouched ("bend your knees and roll") to take a third less
  fallLimpPerDamage: 0.12,  // seconds limping per point of fall damage (a bandage ends it)

  bandages: 3,
  bandageTime: 3.2,
  bandageHeal: 40,

  baseFov: 75,
  mouseSensitivity: 0.0021, // radians per pixel at sensitivity 1.0
};

export const WEAPONS = {
  rifle: {
    id: 'rifle',
    name: '5.56 CARBINE',
    rpm: 800,
    modes: ['AUTO', 'SEMI'],
    magSize: 30,
    reserve: 150,
    reloadTime: 2.2,        // tactical reload (round still chambered)
    reloadEmptyTime: 2.9,   // empty reload (must release the bolt)
    muzzleVelocity: 880,    // m/s — bullets are real projectiles with drop
    damage: 36,
    falloffStart: 80,       // metres before damage starts dropping
    falloffEnd: 300,
    minDamageMul: 0.65,
    headMul: 4.0,
    limbMul: 0.65,
    penetration: 1.0,       // can punch through thin cover (see ballistics.js)
    hipSpread: 0.032,       // radians (~1.8°) cone when firing from the hip
    adsSpread: 0.0012,
    moveSpread: 0.035,      // extra spread at full sprint speed
    bloomPerShot: 0.004,
    bloomMax: 0.03,
    bloomRecovery: 0.08,    // per second
    recoilPitch: 0.0105,    // muzzle climb per shot (rad)
    recoilYaw: 0.0045,
    recoilRecovery: 0.55,   // fraction of climb that recovers by itself
    adsRecoilMul: 0.75,
    adsTime: 0.24,
    adsFov: 52,
    tracerEvery: 4,         // every 4th round is a tracer, like a real belt/mag mix
    loudness: 160,          // metres at which enemies hear the shot
    swayMul: 1.0,
  },
  pistol: {
    id: 'pistol',
    name: '9MM SIDEARM',
    rpm: 420,
    modes: ['SEMI'],
    magSize: 15,
    reserve: 45,
    reloadTime: 1.5,
    reloadEmptyTime: 1.9,
    muzzleVelocity: 370,
    damage: 26,
    falloffStart: 25,
    falloffEnd: 80,
    minDamageMul: 0.5,
    headMul: 4.0,
    limbMul: 0.7,
    penetration: 0.35,
    hipSpread: 0.026,
    adsSpread: 0.004,
    moveSpread: 0.02,
    bloomPerShot: 0.008,
    bloomMax: 0.03,
    bloomRecovery: 0.12,
    recoilPitch: 0.026,
    recoilYaw: 0.008,
    recoilRecovery: 0.8,
    adsRecoilMul: 0.8,
    adsTime: 0.16,
    adsFov: 62,
    tracerEvery: 0,
    loudness: 100,
    swayMul: 1.3,
  },
  // ---- added with the loadout system (see loadout.js for attachments) ----
  smg: {
    id: 'smg', name: '9MM SMG', rpm: 900, modes: ['AUTO', 'SEMI'], magSize: 30, reserve: 180,
    reloadTime: 2.0, reloadEmptyTime: 2.5, muzzleVelocity: 400, damage: 25, falloffStart: 20, falloffEnd: 70,
    minDamageMul: 0.55, headMul: 3.5, limbMul: 0.75, penetration: 0.35, hipSpread: 0.022, adsSpread: 0.003,
    moveSpread: 0.02, bloomPerShot: 0.003, bloomMax: 0.03, bloomRecovery: 0.12, recoilPitch: 0.0062, recoilYaw: 0.004,
    recoilRecovery: 0.6, adsRecoilMul: 0.8, adsTime: 0.17, adsFov: 58, tracerEvery: 0, loudness: 110, swayMul: 1.1,
  },
  dmr: {
    id: 'dmr', name: '7.62 DMR', rpm: 300, modes: ['SEMI'], magSize: 20, reserve: 100,
    reloadTime: 2.5, reloadEmptyTime: 3.2, muzzleVelocity: 840, damage: 58, falloffStart: 150, falloffEnd: 450,
    minDamageMul: 0.75, headMul: 4.0, limbMul: 0.7, penetration: 1.4, hipSpread: 0.04, adsSpread: 0.0007,
    moveSpread: 0.04, bloomPerShot: 0.01, bloomMax: 0.04, bloomRecovery: 0.1, recoilPitch: 0.021, recoilYaw: 0.006,
    recoilRecovery: 0.5, adsRecoilMul: 0.8, adsTime: 0.3, adsFov: 48, tracerEvery: 0, loudness: 200, swayMul: 1.0,
  },
  lmg: {
    id: 'lmg', name: '5.56 LMG', rpm: 750, modes: ['AUTO'], magSize: 100, reserve: 200,
    reloadTime: 5.6, reloadEmptyTime: 6.4, muzzleVelocity: 900, damage: 34, falloffStart: 90, falloffEnd: 320,
    minDamageMul: 0.65, headMul: 4.0, limbMul: 0.65, penetration: 1.1, hipSpread: 0.05, adsSpread: 0.002,
    moveSpread: 0.06, bloomPerShot: 0.003, bloomMax: 0.035, bloomRecovery: 0.06, recoilPitch: 0.0115, recoilYaw: 0.0065,
    recoilRecovery: 0.5, adsRecoilMul: 0.75, adsTime: 0.38, adsFov: 52, tracerEvery: 4, loudness: 180, swayMul: 1.3,
  },
  bolt: {
    id: 'bolt', name: '7.62 BOLT-ACTION', rpm: 600, modes: ['BOLT'], magSize: 5, reserve: 30,
    reloadTime: 3.0, reloadEmptyTime: 3.6, muzzleVelocity: 820, damage: 110, falloffStart: 250, falloffEnd: 700,
    minDamageMul: 0.8, headMul: 4.0, limbMul: 0.7, penetration: 1.8, hipSpread: 0.06, adsSpread: 0.0003,
    moveSpread: 0.05, bloomPerShot: 0, bloomMax: 0, bloomRecovery: 0.1, recoilPitch: 0.045, recoilYaw: 0.01,
    recoilRecovery: 0.4, adsRecoilMul: 0.8, adsTime: 0.34, adsFov: 50, tracerEvery: 0, loudness: 220, swayMul: 1.0,
    boltTime: 1.15,         // working the bolt between shots
  },
};

// Frag grenade (modelled loosely on the M67: ~0.4 kg, 4–5 s fuse, lethal radius
// ~5 m, wounding to ~15 m). Hold G to cook (start the fuse), release to throw.
export const GRENADE = {
  count: 2,               // carried; refilled at ammo crates
  fuse: 4.0,              // seconds after the spoon flies
  throwSpeed: 15,         // m/s overarm
  lobAngle: 0.18,         // rad added above where you look (natural throwing arc)
  radius: 11,             // m, damage falls to 0 here
  damage: 220,            // at the centre; lethal within ~4 m in the open
  bounce: 0.32,           // fraction of speed kept after hitting something
  friction: 0.72,         // fraction of sideways speed kept per bounce
  aiCooldown: 9,          // seconds between any two enemy grenades
  aiFuse: 3.4,
};

// Minimap / radar
export const RADAR = {
  range: 70,              // metres shown from the centre of the minimap
  firedShowTime: 2.5,     // seconds an enemy stays on radar after firing
  spotTime: 7,            // seconds a spotted enemy stays marked
  spotCone: 0.06,         // rad: how close to your crosshair someone must be to spot him
  spotRange: 150,
};

export const AI = {
  health: 100,
  walkSpeed: 1.6,
  runSpeed: 4.2,
  climbSpeed: 1.4,          // up/down ladders (m/s); can't shoot while climbing
  turnRate: 5.0,            // rad/s body rotation
  sightRange: 110,
  fov: 2.1,                 // ~120° vision cone
  closeSense: 4,            // metres: notices you behind it at this range
  perceptionInterval: 0.15, // seconds between vision checks (staggered per soldier)
  reactionMin: 0.45,        // seconds after spotting before first shot
  reactionMax: 0.8,
  rpm: 650,
  burstMin: 3,
  burstMax: 6,
  burstPauseMin: 0.6,
  burstPauseMax: 1.6,
  baseSpread: 0.03,         // radians — how accurate a well-settled shot is
  damage: 19,               // 5–6 body hits to kill the player
  headMul: 2.2,
  muzzleVelocity: 850,
  alertRadius: 28,          // soldiers share your position with friends within this range
  loseTargetTime: 5,        // seconds without seeing you before they go hunting
  magSize: 30,
  reloadTime: 2.6,
};

export const GAME = {
  firstWave: 7,
  waveGrowth: 2,
  maxAlive: 16,
  waveDelay: 6,             // seconds between waves
  corpseLimit: 18,
  missionLengths: [0, 5, 10], // waves to survive for victory; 0 = endless (menu & lobby choices)
  coopScale: 0.35,          // co-op: each extra squadmate adds 35% more enemies per wave...
  coopMaxAlive: 20,         // ...up to this many at once (the host's computer runs them all)
};

export const NET = {
  sendRate: 20,             // network updates per second, each way (Source's default is 20–66)
  interpDelay: 0.1,         // seconds: other soldiers are drawn this far in the past (see net.js)
  respawnTime: 10,          // co-op: seconds before a fallen player rejoins, if anyone's still standing
  friendlyTint: 0x5f7390,   // squadmates' uniform colour (enemy colours are set per map)
  countdown: 3,             // seconds between the host pressing START and everyone deploying
};

// Difficulty: picked in the co-op lobby, or under Settings for solo play.
// Each value multiplies a number from AI (above) or the wave size.
export const DIFFICULTY = {
  recruit: { name: 'Recruit', damage: 0.6, spread: 1.4, reaction: 1.35, enemies: 0.75 },
  regular: { name: 'Regular', damage: 1.0, spread: 1.0, reaction: 1.0, enemies: 1.0 },
  veteran: { name: 'Veteran', damage: 1.4, spread: 0.75, reaction: 0.75, enemies: 1.25 },
};

// Voice chat (voice.js). STUN servers help two browsers find a direct route
// to each other across home routers; these are free public ones.
export const VOICE = {
  pttKey: 'KeyB',           // hold to talk
  talkThreshold: 0.015,     // microphone level that counts as "talking" (open mic, indicators)
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

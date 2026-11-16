// =============================================================================
// main.js — loads a map, boots every system, and runs the GAME LOOP.
//
// Loading: the chosen map lists its sky, textures and models; we fetch them
// all in parallel (with a progress readout), then build terrain -> structures
// -> props -> vegetation -> AI navigation.
//
// Every frame:  input -> player -> weapon -> AI -> bullets -> effects -> render
//
// Co-op (see coop.js and lobby.js): players meet in a LOBBY, the host starts a
// mission, and everyone who's ready deploys. Then three things change here:
// friends' computers don't run the AI or the waves (the host does); the world
// keeps running while you're paused, because your friends are still fighting;
// and when you die you respawn after a delay, unless the whole squad is down.
//
// Two ways to play (the tabs on the main menu):
//   CAMPAIGN  the story missions in src/campaign/. A MissionDirector runs the
//             mission's objectives instead of the waves. Solo or co-op.
//   COMBAT    pick a map, take it, hold it against waves of counterattacks.
// =============================================================================
import * as THREE from 'three';
import { PLAYER, GAME, NET, DIFFICULTY } from './config.js';
import { Input } from './input.js';
import { mulberry32 } from './textures.js';
import { Assets } from './assets.js';
import { GameRenderer, QUALITY } from './render.js';
import { loadMaterials, sandbagMaterial } from './materials.js';
import { World } from './world.js';
import { Terrain } from './terrain.js';
import { Props } from './props.js';
import { Builder } from './builder.js';
import { Navigation } from './nav.js';
import { Effects } from './effects.js';
import { AudioSystem } from './audio.js';
import { Ballistics } from './ballistics.js';
import { ViewModel } from './viewmodel.js';
import { WeaponSystem } from './weapon.js';
import { Player } from './player.js';
import { EnemyManager } from './enemy.js';
import { SoldierFactory, loadSoldiers } from './character.js';
import { HUD } from './hud.js';
import { MAPS, getMap } from './maps/index.js';
import { VegetationSettings } from './vegetation.js';
import { CoopSession } from './coop.js';
import { LobbyUI, VoiceBars, renderGameList, lengthName, chatLineTo } from './lobby.js';
import { VoiceChat } from './voice.js';
import { Grenades } from './grenades.js';
import { Tactical, MODES as RADAR_MODES } from './minimap.js';
import { GRENADE } from './config.js';
import { Armory } from './armory.js';
import { dressFirstPerson } from './avatar.js';
import { ScopeOverlay } from './scope.js';
import { resolveLoadout } from './loadout.js';
import { MissionDirector } from './campaign/director.js';
import { Radio } from './campaign/radio.js';
import { CampaignHud } from './campaign/hud.js';
import { MISSIONS, CAMPAIGN, missionById } from './campaign/story.js';
import { renderMissionList, renderBriefing, renderDebrief, saveResult, unlocked, loadProgress, nextMission } from './campaign/screens.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// Stands in for the keyboard and mouse while you're in a menu but the co-op world keeps running
const IDLE_INPUT = { isDown: () => false, wasPressed: () => false, consumeMouse: () => ({ dx: 0, dy: 0 }), consumeWheel: () => 0 };
const deployBtn = $('deploy');
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

window.addEventListener('error', (e) => {
  deployBtn.textContent = 'ERROR — open the browser console';
  console.error(e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  deployBtn.textContent = 'LOAD ERROR — open the browser console';
  console.error(e.reason);
});

// ---------------------------------------------------------------- display refresh rate
// Measured right away, while nothing heavy is being drawn: the gap between
// animation frames is the display's refresh interval. We take a low percentile
// (ignoring slow frames) and snap to a real refresh rate.
const refresh = { hz: 60, known: false, onKnown: null };
{
  const gaps = [];
  let last = 0;
  const measure = (t) => {
    if (last) gaps.push(t - last);
    last = t;
    if (gaps.length < 60 && t < 6000) { requestAnimationFrame(measure); return; }
    const sorted = gaps.filter((g) => g > 2).sort((a, b) => a - b);
    const ms = sorted.length ? sorted[Math.floor(sorted.length * 0.2)] : 1000 / 60;
    const rates = [30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180, 240];
    refresh.hz = rates.reduce((best, r) => (Math.abs(1000 / r - ms) < Math.abs(1000 / best - ms) ? r : best), 60);
    refresh.known = true;
    refresh.onKnown?.();
  };
  requestAnimationFrame(measure);
}

// ---------------------------------------------------------------- menu: maps & quality
const params = new URLSearchParams(location.search);
// CAMPAIGN or COMBAT, and the campaign mission you picked. In the campaign the
// mission decides the map, so we load that map straight away.
let menuMode = store.get('dustline.mode', 'campaign') === 'combat' ? 'combat' : 'campaign';
const firstOpenMission = () => { const p = loadProgress(); return MISSIONS.find((m, i) => unlocked(i, p) && !p.done[m.id]) || MISSIONS[MISSIONS.length - 1]; };
let picked = missionById(params.get('mission')) || missionById(store.get('dustline.mission')) || firstOpenMission();
if (!unlocked(MISSIONS.indexOf(picked))) picked = firstOpenMission();
const mapId = params.get('map') || (menuMode === 'campaign' ? picked.map : store.get('dustline.map', 'dustline'));
const joinParam = (params.get('join') || '').toUpperCase(); // invite links: ?map=pinewood&join=ABCD
const qualityName = store.get('dustline.quality', 'medium');
let fpsMode = store.get('dustline.fpsmode', 'auto'); // 'full' = every display refresh, 'half' = every other one, 'auto' = full unless it can't keep up
let halfRate = fpsMode === 'half';

function buildMenu(current) {
  const box = $('maps');
  box.innerHTML = '';
  for (const m of MAPS) {
    const b = document.createElement('button');
    b.className = 'map-card' + (m.id === current.id ? ' active' : '');
    b.innerHTML = `<b>${m.name}</b><span>${m.blurb}</span>`;
    b.onclick = () => {
      if (m.id === current.id) return;
      store.set('dustline.map', m.id);
      location.search = `?map=${m.id}`;
    };
    box.appendChild(b);
  }
  const q = $('quality');
  q.value = qualityName;
  q.onchange = () => { store.set('dustline.quality', q.value); location.reload(); };
  const f = $('fpsmode');
  f.value = fpsMode;
  f.onchange = () => { fpsMode = f.value; halfRate = fpsMode === 'half'; store.set('dustline.fpsmode', fpsMode); };
}

async function init() {
  const map = getMap(mapId);
  buildMenu(map);
  setMenuMode(menuMode); // campaign or combat tab (more is wired up once the map has loaded)
  await new Promise((r) => setTimeout(r, 30)); // let the menu paint

  // ------------------------------------------------------------ renderer & assets
  const R = new GameRenderer($('game'), qualityName);
  const quality = QUALITY[qualityName] || QUALITY.medium;
  const assets = new Assets(R.renderer);
  assets.onProgress = (l, t) => { deployBtn.textContent = `LOADING ${map.name} ${Math.round((l / t) * 100)}%`; };

  const [hdr, layerSets, M, soldierKit] = await Promise.all([
    assets.hdr(map.sky.hdri),
    Promise.all(map.terrain.layers.map(([id, tile]) => assets.textureSet(id).then((s) => ({ ...s, size: tile ?? s.size })))),
    loadMaterials(assets, map.materials),
    loadSoldiers(), // the soldiers: models, textures and animations (character.js)
  ]);
  deployBtn.textContent = 'BUILDING WORLD…';
  await new Promise((r) => setTimeout(r, 0));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(PLAYER.baseFov, window.innerWidth / window.innerHeight, 0.05, 1500);
  R.setupSky(scene, hdr, map.sky);

  // ------------------------------------------------------------ world
  const world = new World();
  const terrain = new Terrain({ size: 800, spacing: 2, height: map.terrain.height, splat: map.terrain.splat, layers: layerSets, surfaces: map.terrain.surfaces, tint: map.terrain.tint });
  scene.add(terrain.mesh);
  world.terrain = terrain;

  // Two seeded random streams. "Seeded" means the same seed always gives the
  // same numbers, so every computer builds exactly the same level. Co-op
  // depends on that: tree trunks and rocks stop bullets and hide players.
  //   rand      everything that shapes the level: buildings, crates, trees, rocks
  //   decoRand  looks-only scatter whose AMOUNT depends on the graphics preset
  //             (grass). It needs its own stream: if it shared `rand`, a Low
  //             player's fewer grass blades would use up fewer numbers, and
  //             every tree and rock placed afterwards would land somewhere else.
  const rand = mulberry32(map.seed ?? 1234);
  const decoRand = mulberry32(((map.seed ?? 1234) ^ 0x5bd1e995) >>> 0);
  const props = new Props(scene, world, assets, rand);
  await props.load(map.props);
  if (map.props.includes('cement_bag')) await sandbagMaterial(assets, props);
  VegetationSettings.a2c = quality.msaa > 0; // smooth foliage edges when MSAA is on
  const builder = new Builder(scene, world, M, props, rand);
  const level = await map.build({ scene, world, terrain, builder, props, M, rand, decoRand, quality, assets });
  props.finalize();
  builder.finalize();

  const nav = new Navigation(world, map.navBounds); // the ground, plus roofs reached by ladders
  const cover = typeof level.coverPoints === 'function' ? level.coverPoints() : level.coverPoints;
  level.coverPoints = cover.filter((c) => nav.walkable(c.pos.x, c.pos.z));
  for (const p of level.patrolPoints) p.y = world.groundHeight(p.x, p.z);
  level.playerSpawn.pos.y = world.groundHeight(level.playerSpawn.pos.x, level.playerSpawn.pos.z);

  // ------------------------------------------------------------ systems
  const input = new Input(R.renderer.domElement);
  const audio = new AudioSystem();
  const hud = new HUD();
  const effects = new Effects(scene, world);
  effects.audio = audio;
  effects.camera = camera; // dust motes float around you
  const ballistics = new Ballistics(world, effects, audio);
  const vm = new ViewModel(M);
  vm.scene.environment = scene.environment;
  vm.sun.color.copy(R.sun.color);
  vm.sun.intensity = Math.min(6, R.sun.intensity * 0.7);
  const player = new Player(world, camera, audio);
  const weapons = new WeaponSystem({ viewmodel: vm, ballistics, effects, audio, sunDir: R.sunDir });
  const factory = new SoldierFactory(soldierKit, M, map.soldierTint);
  factory.world = world; // (dead bodies look for room to fall into)
  const enemies = new EnemyManager({ scene, world, nav, ballistics, effects, audio, level, M, player, factory });

  R.setupPost(scene, camera, vm.scene, vm.camera);
  if (map.grade) R.setGrade(map.grade);

  // ------------------------------------------------------------ game state
  // state:    'menu' | 'lobby' (co-op) | 'playing' | 'paused' | 'dead' (solo result screen) | 'lost' (disconnected)
  // deployed: you're in the fight. In co-op the world also runs while you're in the lobby.
  // over:     the mission just ended (won or wiped out); waiting to leave it
  // maxWaves: waves to survive for victory (0 = endless)
  // mode:     'waves' (COMBAT) or 'campaign' (a story mission, run by the director below)
  const game = { state: 'menu', wave: 0, between: false, waveTimer: 0, prompt: '', deployed: false, over: false, respawnT: 0, maxWaves: 0, startedAt: 0, mode: 'waves' };
  const stats = { kills: 0, headshots: 0, hits: 0, time: 0 };
  const coop = new CoopSession({ scene, world, factory, player, weapons, enemies, ballistics, effects, audio, game, mapId: map.id });
  const voice = (coop.voice = new VoiceChat(coop)); // squad voice chat (voice.js)

  // Grenades + tactical HUD (minimap, radar, spotting). Enemies throw grenades
  // through enemies.onThrowGrenade; co-op sends throws and spots to the squad.
  const grenades = new Grenades({ scene, world, effects, audio, enemies, player, camera, weapons, vmScene: vm.scene, glove: M.glove });
  const tactical = new Tactical({ R, scene, world, level, player, enemies, coop, grenades, camera, audio, map });
  enemies.grenadeCfg = GRENADE;
  enemies.onThrowGrenade = (e, origin, vel, fuse) => grenades.spawn({ origin, vel, fuse, team: 'enemy', shooter: null });
  grenades.onExplode = (pos) => { if (!coop.isClient) { enemies.hearNoise(pos, 250, 'gunshot'); enemies.onImpact?.(pos); } };
  coop.attachExtras?.({ grenades, spotting: tactical, minimap: tactical });

  // Campaign: the mission director runs story missions (campaign/director.js),
  // the radio plays their dialogue, and the campaign HUD draws objective
  // markers, banners and the title card.
  const director = new MissionDirector({ scene, world, nav, enemies, player, coop, grenades, effects, audio, factory, M, weapons, camera, game, R });
  const radio = new Radio(audio);
  const chud = new CampaignHud(audio);
  coop.mission = tactical.mission = director;

  // Loadouts: the armory screen edits your kit; applyLoadout() issues it.
  // Mid-mission changes wait for the next ammo crate or respawn (no free refills).
  const armory = new Armory(M, factory);
  const scope = new ScopeOverlay();
  let pendingLoadout = false, warmed = false;
  function applyLoadout() {
    const kit = resolveLoadout(armory.loadout);
    weapons.setLoadout({ primary: kit.primary, secondary: kit.secondary });
    grenades.setKit(kit.grenades);
    player.setKit({ speedMul: kit.speedMul, staminaMul: kit.staminaMul, armor: kit.armor });
    pendingLoadout = false;
    armory.markIssued();         // squadmates see the guns you actually carry,
    coop.setKit(armory.kitInfo); // not ones still waiting for an ammo crate
    if (warmed) { // compile the new guns' shaders now, not on the first frame you see them
      for (const m of Object.values(vm.models)) m.group.visible = true;
      R.renderer.compile(vm.scene, vm.camera);
      vm.setWeapon(weapons.currentId);
    }
  }
  armory.canApplyNow = () => !(game.deployed && player.alive);
  armory.onChange = () => {
    if (armory.canApplyNow()) applyLoadout(); else pendingLoadout = true;
    coop.setKit(armory.kitInfo); // co-op: show your squad your new class
  };
  // Your soldier's look (avatar.js) is cosmetic, so it applies at once, even mid-mission:
  // your sleeves and gloves in first person, and what your squad sees.
  armory.onAvatar = () => { dressFirstPerson(M, armory.avatar); vm.dressArms(armory.avatar); coop.setKit(armory.kitInfo); };
  dressFirstPerson(M, armory.avatar);
  vm.attachArms(factory, armory.avatar); // your arms in first person: a real soldier in your look (viewmodel.js)
  coop.setKit(armory.kitInfo);
  applyLoadout();

  // Wire the systems together with callbacks (keeps modules independent)
  ballistics.targets.push(enemies, {
    raycast: (o, d, max, team) => (team === 'player' || !player.alive || !game.deployed ? null : player.raycastHitbox(o, d, max)),
  }, director.bulletTarget); // (the campaign's escort, when there is one)
  ballistics.listener = () => camera.position;
  ballistics.onNearMiss = (d) => hud.suppressed(0.2 + (2.5 - d) * 0.15);
  ballistics.onWorldImpact = (pt, team, b) => { if (team === 'player' && !coop.isClient) enemies.onImpact(pt, b.shooter?.pos); };
  // The AI only lives on the host, so friends send their noises there.
  weapons.onShot = (pos, loudness) => { if (!coop.isClient) enemies.hearNoise(pos, loudness, 'gunshot'); };
  weapons.onFire = (origin, dir, weaponId, tracer, suppressed) => coop.sendShot(origin, dir, weaponId, tracer, suppressed);
  player.onNoise = (pos, radius) => { if (coop.isClient) coop.sendNoise(pos, radius); else enemies.hearNoise(pos, radius, 'footstep'); };
  enemies.onShoot = (e, origin, dir, tracer) => { if (coop.isHost) coop.sendEnemyShot(e, origin, dir, tracer); };
  // Getting hurt: red flash, blood at the edge, an arc pointing at the shooter (hud.js)
  player.onDamaged = (amount, from, kind) => hud.damage(amount, from, kind);
  audio.world = world; // so sounds know what's underfoot (enemy steps) and overhead (indoor echo)

  // Hits and kills. info.shooter says whose bullet it was; only YOUR hits
  // get a hit marker. In co-op the host also tells everyone who got the kill.
  const mine = (info) => !info?.shooter || info.shooter === player;
  const confirmKill = (headshot) => {
    stats.kills++;
    if (headshot) stats.headshots++;
    hud.killfeed(headshot ? 'HEADSHOT — HOSTILE DOWN' : 'HOSTILE DOWN', headshot);
  };
  enemies.onHit = (e, zone, killed, info) => {
    if (!mine(info)) return;
    stats.hits++;
    coop.noteHit();
    hud.hitmarker(killed);
    audio.hitmarker(killed);
  };
  enemies.onKill = (e, headshot, info) => {
    if (coop.isHost) coop.sendKill(info?.shooter, headshot);
    if (mine(info)) confirmKill(headshot);
    else hud.killfeed(`${info.shooter.name} — HOSTILE DOWN`, false);
  };
  coop.onKill = (byMe, headshot, name) => {
    if (!byMe) { hud.killfeed(`${name} — HOSTILE DOWN`, false); return; }
    hud.hitmarker(true);
    audio.hitmarker(true);
    confirmKill(headshot);
  };

  // ------------------------------------------------------------ game rules
  // Everyone the AI can fight: just you in solo; your whole squad in co-op;
  // plus a campaign escort once she's on the move.
  const squadTargets = () => {
    const list = coop.aiTargets(game.deployed);
    return game.mode === 'campaign' ? list.concat(director.extraTargets()) : list;
  };

  // Where you (re)spawn: the map's start, or in the campaign the current checkpoint
  function spawnLocalPlayer() {
    const s = game.mode === 'campaign' && director.data ? director.spawnPoint() : level.playerSpawn, pos = s.pos.clone();
    if (coop.online) { // spread the squad out so nobody spawns inside a friend
      pos.x += (((coop.myId - 1) % 4) - 1.5) * 1.5;
      pos.y = world.groundHeight(pos.x, pos.z);
      if (world.bodyBlocked(pos, PLAYER.radius, PLAYER.standHeight)) pos.copy(s.pos);
    }
    player.reset(pos, s.yaw);
  }

  // Mission settings (difficulty, length, enemy radar): solo uses the menu's
  // row; co-op uses the lobby's, which the host sets for the whole squad. The
  // menu's choices are also what a new lobby starts with when you host.
  const diffSel = $('difficulty'), lengthSel = $('mission-length'), radarSel = $('radar-mode');
  for (const [id, d] of Object.entries(DIFFICULTY)) diffSel.append(new Option(d.name, id));
  for (const w of GAME.missionLengths) lengthSel.append(new Option(lengthName(w), w));
  for (const [id, name] of Object.entries(RADAR_MODES)) radarSel.append(new Option(name, id));
  diffSel.value = store.get('dustline.difficulty', 'regular');
  lengthSel.value = store.get('dustline.waves', '0');
  radarSel.value = store.get('dustline.radar', 'fire');
  if (!radarSel.value) radarSel.value = 'fire'; // an old or unknown saved value
  diffSel.onchange = () => store.set('dustline.difficulty', diffSel.value);
  lengthSel.onchange = () => store.set('dustline.waves', lengthSel.value);
  radarSel.onchange = () => store.set('dustline.radar', radarSel.value);
  const soloSettings = () => ({ difficulty: diffSel.value, waves: +lengthSel.value, radar: radarSel.value });

  function startGame() {
    // Campaign mission or waves? Co-op: the room decides. Solo: the menu's tab.
    const wantCampaign = coop.online ? coop.room?.mode === 'campaign' : menuMode === 'campaign';
    game.mode = wantCampaign && director.data ? 'campaign' : 'waves';
    if (game.mode !== 'campaign' && director.live) director.stop();
    spawnLocalPlayer();
    if (pendingLoadout) applyLoadout();
    weapons.reset();
    grenades.reset();
    ballistics.clear();
    radio.clear();
    chud.clearBanners();
    Object.assign(stats, { kills: 0, headshots: 0, hits: 0, time: 0 });
    Object.assign(game, { deployed: true, over: false, respawnT: 0 });
    // Enemy radar: the room's in co-op (the same for the whole squad), else the menu's
    tactical.mode = coop.online ? coop.room?.radar || 'fire' : radarSel.value;
    if (coop.isClient) { // the host runs the mission; we just drop into it
      game.maxWaves = coop.room?.waves || 0;
      if (game.mode === 'campaign') { director.join(); missionIntro(); } else hud.message('JOINING YOUR SQUAD', 3);
      return;
    }
    const settings = coop.online ? coop.room : soloSettings();
    enemies.difficulty = DIFFICULTY[settings.difficulty] || DIFFICULTY.regular;
    game.maxWaves = settings.waves || 0;
    game.startedAt = performance.now();
    coop.resetScores();
    enemies.clear();
    game.wave = 0;
    game.between = false;
    if (game.mode === 'campaign') { director.start(); missionIntro(); return; }
    nextWave();
  }

  // A campaign mission begins: fade in from black, with its title card
  function missionIntro() {
    const m = director.data, n = MISSIONS.indexOf(m) + 1;
    chud.fadeIn(2.8);
    chud.titleCard([m.title, m.time, m.place], `${CAMPAIGN.title} · MISSION ${n} OF ${MISSIONS.length}`);
    radio.hold(4.5); // the first radio call comes in as the title card finishes
  }

  const waveText = (n, max) => (n === 1 ? level.objective || 'ASSAULT THE OBJECTIVE'
    : `${max && n === max ? 'FINAL WAVE' : `WAVE ${n}${max ? ` OF ${max}` : ''}`}<br><small>COUNTERATTACK INBOUND</small>`);

  function nextWave() {
    game.wave++;
    game.between = false;
    // Bigger waves on harder difficulties, and for bigger squads
    const squad = coop.online ? Math.max(1, coop.squadSize(game.deployed)) : 1;
    const base = (GAME.firstWave + (game.wave - 1) * GAME.waveGrowth) * enemies.difficulty.enemies * (1 + GAME.coopScale * (squad - 1));
    const n = Math.min(coop.online ? GAME.coopMaxAlive : GAME.maxAlive, Math.round(base));
    hud.message(waveText(game.wave, game.maxWaves), 4);
    coop.broadcast({ t: 'ev', k: 'wave', n: game.wave });
    if (game.wave === 1) {
      level.enemySpawns.slice(0, n).forEach((s) => enemies.spawn(s));
      return;
    }
    // Reinforce the garrison only at posts nobody in the squad is near or can see
    const alive = squadTargets().filter((p) => p.alive);
    const garrison = level.enemySpawns
      .filter((s) => {
        const head = s.pos.clone().setY(world.groundHeight(s.pos.x, s.pos.z) + 1.5);
        return alive.every((p) => s.pos.distanceTo(p.pos) > 35 && !world.lineOfSight(p.eyePosition, head));
      })
      .sort(() => Math.random() - 0.5);
    const g = Math.min(garrison.length, Math.floor(n / 2));
    garrison.slice(0, g).forEach((s) => enemies.spawn(s));
    for (let i = g; i < n; i++) {
      const a = level.assaultSpawns[i % level.assaultSpawns.length];
      enemies.spawn({ pos: a.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)), role: 'patrol', assault: true });
    }
  }

  function areaSecure() {
    player.bandages = Math.min(PLAYER.bandages, player.bandages + 1);
    hud.message(`AREA SECURE<br><small>Next wave in ${GAME.waveDelay}s — resupply at an ammo crate [F]</small>`, GAME.waveDelay - 1);
  }

  const WON_TEXT = 'MISSION ACCOMPLISHED<br><small>The objective is held</small>';

  // Waves: run by solo players and the co-op host. (A campaign mission runs its
  // own objectives instead.)
  function waveRules(dt) {
    if (game.mode === 'campaign') { director.update(dt); return; }
    if (game.wave === 0 || game.over) return;
    if (!game.between && enemies.aliveCount === 0) {
      if (game.maxWaves && game.wave >= game.maxWaves) { missionWon(); return; }
      game.between = true;
      game.waveTimer = GAME.waveDelay;
      if (game.deployed) areaSecure();
      coop.broadcast({ t: 'ev', k: 'secure' });
    }
    const someoneUp = coop.online ? coop.squadAlive(game.deployed) : player.alive;
    if (game.between && someoneUp && (game.waveTimer -= dt) <= 0) nextWave();
  }

  // Every wave beaten. Solo: show the result. Co-op host: tell the squad, then close the mission.
  function missionWon() {
    game.over = true;
    hud.message(WON_TEXT, 4);
    if (coop.online) { coop.broadcast({ t: 'ev', k: 'won' }); setTimeout(() => endMission('won'), 4000); }
    else setTimeout(() => showResult('MISSION ACCOMPLISHED'), 3000);
  }

  // Co-op host: end the mission and send everyone back to the lobby with the after-action report.
  function endMission(result) {
    if (!coop.isHost || !coop.missionRunning) return;
    const report = coop.report(game.wave, (performance.now() - game.startedAt) / 1000);
    if (game.mode === 'campaign' && director.data) { // which mission, its stars and bonus goals (the lobby shows the debrief)
      const r = director.result();
      Object.assign(report, { mission: director.data.id, stars: result === 'won' ? r.stars : 0, bonus: director.data.bonus.map((b) => (r.bonus[b.id] ? 1 : 0)) });
    }
    coop.endMission(result, report);
  }

  // ------------------------------------------------------------ campaign: how a mission ends
  director.onRadio = (key, jammed) => { if (game.deployed) radio.say(director.data, key, jammed); };
  director.onBanner = (kind, o, text) => {
    if (!game.deployed) return;
    if (kind === 'new') chud.announce('NEW OBJECTIVE', o.text);
    else if (kind === 'done') chud.announce('OBJECTIVE COMPLETE', o.text, 2.5);
    else if (kind === 'step') chud.announce('✓', text, 2);
  };
  // Won: everyone saves their progress. Solo: the debrief. Co-op: back to the lobby, which shows it.
  director.onWon = (r) => {
    game.over = true;
    saveResult(r);
    if (!game.deployed) return;
    hud.message(`MISSION ACCOMPLISHED<br><small>${r.title}</small>`, 5);
    if (coop.isHost) setTimeout(() => endMission('won'), 7000);
    else if (!coop.online) setTimeout(() => showDebrief(r), 5000);
  };
  // Failed (squad wiped out, escort killed). Solo: the result screen, with a
  // retry. Co-op: the host restarts the checkpoint for everyone after a moment.
  director.onFailed = (why) => {
    if (!game.deployed) return;
    if (coop.online) {
      game.over = true;
      // esc(): in co-op, `why` is text sent by the host's browser, so it can't be trusted as HTML
      hud.message(`MISSION FAILED<br><small>${esc(why)} — back to the last checkpoint…</small>`, 5);
      if (coop.isHost) setTimeout(() => { if (director.state === 'failed' && coop.missionRunning) retryCheckpoint(); }, 5500);
    } else {
      hud.message(`MISSION FAILED<br><small>${esc(why)}</small>`, 3);
      setTimeout(() => showResult('MISSION FAILED', why), 2500);
    }
  };
  director.onRetry = () => { ballistics.clear(); grenades.reset(); respawnAtCheckpoint(); }; // co-op friend: the host restarted

  // Solo / co-op host: back to the start of the current objective
  function retryCheckpoint() {
    ballistics.clear();
    grenades.reset();
    radio.clear();
    chud.clearBanners();
    director.retry();
    respawnAtCheckpoint();
  }

  // Every computer: put our soldier back at the checkpoint, fresh
  function respawnAtCheckpoint() {
    if (!game.deployed) return;
    spawnLocalPlayer();
    if (pendingLoadout) applyLoadout();
    weapons.reset();
    grenades.reset();
    Object.assign(game, { over: false, respawnT: 0 });
    chud.fadeIn(1.6);
    hud.message('BACK AT THE CHECKPOINT', 2.5);
  }

  // Solo: the debrief screen after a won mission
  function showDebrief(r) {
    if (game.state === 'lost' || coop.online || !game.deployed) return;
    game.state = 'dead';
    document.exitPointerLock();
    const acc = weapons.shotsFired ? Math.round((stats.hits / weapons.shotsFired) * 100) : 0;
    renderDebrief(r, { kills: stats.kills, acc });
    showPanel('debrief');
    hud.show(false);
  }

  // Co-op: respawn after a delay; the mission fails only when everyone is down.
  function respawnRules(dt) {
    if (!coop.online || !game.deployed || game.over) return;
    if (coop.isHost && game.mode === 'campaign' && director.running && !coop.squadAlive(true)) {
      director.squadWiped(); // -> director.onFailed: restart from the checkpoint
      return;
    }
    if (coop.isHost && game.mode !== 'campaign' && game.wave > 0 && !coop.squadAlive(true)) {
      game.over = true;
      hud.message('SQUAD WIPED OUT', 3);
      setTimeout(() => endMission('failed'), 2500);
      return;
    }
    if (player.alive || game.respawnT <= 0) return;
    const before = Math.ceil(game.respawnT);
    game.respawnT -= dt;
    if (game.respawnT <= 0) {
      spawnLocalPlayer();
      if (pendingLoadout) applyLoadout();
      weapons.reset();
      grenades.reset();
      hud.message('BACK IN THE FIGHT', 2);
    } else if (Math.ceil(game.respawnT) !== before) {
      hud.message(`KILLED IN ACTION<br><small>Reinforcing in ${Math.ceil(game.respawnT)}s</small>`, 1.5);
    }
  }

  // Game events from the host (friends only)
  coop.onEvent = (ev) => {
    if (ev.k === 'cm') { director.onEvent(ev); return; } // campaign mission moments
    if (!game.deployed) return;
    if (ev.k === 'wave') hud.message(waveText(+ev.n | 0, coop.room?.waves), 4); // a number, never HTML from the host
    else if (ev.k === 'secure') areaSecure();
    else if (ev.k === 'won') { game.over = true; hud.message(WON_TEXT, 4); }
  };

  function showPanel(id) {
    $('overlay').classList.toggle('hidden', !id);
    $('overlay').classList.toggle('in-lobby', ['lobby', 'briefing', 'debrief'].includes(id)); // (no controls list under these)
    for (const p of ['menu', 'lobby', 'paused', 'dead', 'netlost', 'briefing', 'debrief']) $(p).classList.toggle('hidden', p !== id);
  }

  // The pause menu. Solo: EXIT TO MENU. Co-op: back to the lobby (the host's
  // button ends the mission for everyone, so the squad can change map or
  // settings), leave the game, and a chat box.
  function showPaused(title, button) {
    $('paused-title').textContent = title;
    $('resume').textContent = button;
    const online = coop.online;
    $('paused-note').classList.toggle('hidden', !online);
    $('to-menu').classList.toggle('hidden', online);
    $('to-lobby').classList.toggle('hidden', !online);
    $('leave-game').classList.toggle('hidden', !online);
    $('pause-chat').classList.toggle('hidden', !online);
    $('to-lobby').textContent = coop.isHost ? 'END MISSION · BACK TO LOBBY' : 'BACK TO LOBBY';
    showPanel('paused');
    const log = $('pause-chat-log');
    log.scrollTop = log.scrollHeight;
  }

  // Solo: the result screen (killed, or every wave survived; in the campaign,
  // killed or mission failed, with a retry from the last checkpoint)
  function showResult(title, why = '') {
    if (game.state === 'lost' || coop.online || !game.deployed || game.state === 'dead') return; // (not if you already left the mission)
    game.state = 'dead';
    document.exitPointerLock();
    radio.clear();
    const acc = weapons.shotsFired ? Math.round((stats.hits / weapons.shotsFired) * 100) : 0;
    const m = Math.floor(stats.time / 60), s = Math.floor(stats.time % 60);
    const camp = game.mode === 'campaign' && director.data;
    $('dead-title').textContent = title;
    $('stats').innerHTML = camp
      ? `${esc(director.data.title)} · ${enemies.difficulty.name}${why ? `<br>${esc(why)}` : ''}<br>Objective: ${esc(director.cur?.text || '')}<br>`
        + `Hostiles killed: ${stats.kills}<br>Accuracy: ${acc}%`
      : `Map: ${map.name} · ${enemies.difficulty.name}<br>Waves reached: ${game.wave}${game.maxWaves ? ` of ${game.maxWaves}` : ''}<br>`
        + `Hostiles killed: ${stats.kills}<br>Headshots: ${stats.headshots}<br>Accuracy: ${acc}%<br>Time survived: ${m}m ${s}s`;
    $('redeploy').textContent = camp ? 'RETRY FROM CHECKPOINT' : 'REDEPLOY';
    $('restart-mission').classList.toggle('hidden', !camp);
    showPanel('dead');
    hud.show(false);
  }
  // A bad fall: tell the player why they're limping (player.js _hardLanding)
  player.onFall = (damage) => hud.message(damage > 30 ? 'HARD LANDING — LEGS HURT<br><small>[H] Bandage to stop limping</small>' : 'HARD LANDING', damage > 30 ? 2.5 : 1.2);
  player.onDeath = () => {
    coop.noteDeath();
    if (coop.online) game.respawnT = NET.respawnTime; // respawnRules takes it from here
    else setTimeout(() => showResult('KILLED IN ACTION'), 2500);
  };

  // Solo: leave the mission for the main menu, to pick another map or change settings.
  function exitToMenu() {
    if (director.live) director.stop();
    radio.clear();
    chud.hideCard();
    chud.clearBanners();
    enemies.clear();
    ballistics.clear();
    grenades.reset();
    Object.assign(game, { deployed: false, state: 'menu', wave: 0, between: false, over: false, respawnT: 0, mode: 'waves' });
    renderCampaignMenu();
    player.reset(level.playerSpawn.pos, level.playerSpawn.yaw); // menu backdrop: back at the start
    player.update(0.016, IDLE_INPUT);
    document.exitPointerLock();
    hud.show(false);
    showPanel('menu');
    refreshGames();
  }
  $('to-menu').onclick = exitToMenu;
  $('to-menu-dead').onclick = exitToMenu;

  // The big button: COMBAT plays straight away; CAMPAIGN opens the mission's briefing first
  deployBtn.onclick = () => {
    audio.init();
    if (menuMode === 'campaign') { goMission(picked); return; }
    startGame();
    input.requestLock();
  };
  $('resume').onclick = () => { audio.init(); input.requestLock(); };
  $('redeploy').onclick = () => {
    audio.init();
    if (game.mode === 'campaign' && director.data && game.deployed) { game.state = 'paused'; retryCheckpoint(); } else startGame();
    input.requestLock();
  };
  $('restart-mission').onclick = () => { audio.init(); startGame(); input.requestLock(); };
  input.onLockChange = (locked) => {
    if (locked) {
      if (!game.deployed) { document.exitPointerLock(); return; } // the mission ended while we were clicking in
      game.state = 'playing';
      showPanel(null);
      hud.show(true);
      radio.resume();
    } else if (game.state === 'playing') {
      hud.closeChat();
      game.state = 'paused';
      if (!coop.online) radio.pause(); // solo pauses the world, and the radio with it
      showPaused('PAUSED', 'RESUME');
    }
  };

  // ------------------------------------------------------------ campaign: menu, briefing, debrief
  // The CAMPAIGN / COMBAT tabs on the main menu
  function setMenuMode(mode) {
    menuMode = mode;
    store.set('dustline.mode', mode);
    const camp = mode === 'campaign';
    for (const b of document.querySelectorAll('#mode-tabs button')) b.classList.toggle('on', b.dataset.mode === mode);
    $('campaign-box').classList.toggle('hidden', !camp);
    $('maps').classList.toggle('hidden', camp);
    $('length-row').classList.toggle('hidden', camp);
    $('menu').classList.toggle('campaign', camp);
    $('menu-sub').textContent = camp ? CAMPAIGN.intro : 'Take the objective. Hold it against the counterattacks.';
    renderCampaignMenu();
  }
  for (const b of document.querySelectorAll('#mode-tabs button')) b.onclick = () => setMenuMode(b.dataset.mode);

  function renderCampaignMenu() {
    renderMissionList($('missions'), picked.id, (m) => {
      picked = m;
      store.set('dustline.mission', m.id);
      if (m.map !== map.id) { goMission(m); return; } // another map: load it
      renderCampaignMenu();
    });
    if (deployBtn.disabled) return; // still loading
    deployBtn.textContent = menuMode !== 'campaign' ? 'PLAY SOLO' : picked.map === map.id ? `BRIEFING: ${picked.title} ▸` : `LOAD ${picked.title} ▸`;
  }

  // Open a mission's briefing; a mission on another map loads that map first
  function goMission(m) {
    picked = m;
    store.set('dustline.mission', m.id);
    store.set('dustline.mode', 'campaign');
    if (m.map !== map.id) {
      store.set('dustline.map', m.map);
      deployBtn.disabled = true;
      deployBtn.textContent = `LOADING ${getMap(m.map).name}…`;
      location.search = `?map=${m.map}&mission=${m.id}${keepParams()}`;
      return;
    }
    if (director.live) director.stop();
    director.load(m.id);
    openBriefing(false);
  }

  let briefFromLobby = false;
  function openBriefing(fromLobby) {
    if (!director.data) return;
    briefFromLobby = fromLobby;
    renderBriefing(director.data, { bg: tactical.bg, coop: fromLobby });
    showPanel('briefing');
  }
  $('brief-go').onclick = () => {
    if (briefFromLobby) { showPanel('lobby'); renderLobby(); return; }
    audio.init();
    startGame();
    input.requestLock();
  };
  $('brief-back').onclick = () => { showPanel('menu'); renderCampaignMenu(); };
  $('debrief-next').onclick = () => { const n = nextMission(director.data?.id); exitToMenu(); if (n) goMission(n); };
  $('debrief-replay').onclick = () => { audio.init(); startGame(); input.requestLock(); };
  $('debrief-menu').onclick = exitToMenu;
  const voiceSel = $('radio-voice');
  voiceSel.value = radio.voiceOn ? '1' : '0';
  voiceSel.onchange = () => radio.setVoice(voiceSel.value === '1');

  // ------------------------------------------------------------ co-op: main menu
  const coopStatus = (html) => { $('coop-status').innerHTML = html; };
  const callsign = $('callsign');
  callsign.value = store.get('dustline.name', '');
  callsign.oninput = () => store.set('dustline.name', callsign.value.trim());
  const myName = () => callsign.value.trim().slice(0, 12) || 'Soldier';
  const keepParams = () => (params.get('server') ? `&server=${encodeURIComponent(params.get('server'))}` : '');
  const noServer = () => '<span class="err">Couldn\'t reach the co-op server.</span><br>Start the game with <code>npm start</code> (not <code>npm run solo</code>). If it\'s already running, restart it (Ctrl+C, then <code>npm start</code>).';

  // The link friends open. "localhost" only works on this computer, so swap
  // in this computer's address on the local network (the server tells us it).
  // If the server also speaks HTTPS, invite friends there: browsers only allow
  // microphones (voice chat) on https:// pages.
  function inviteLink(code) {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const host = local && coop.addrs.length ? coop.addrs[0] : location.hostname;
    let origin = location.origin;
    if (location.protocol === 'http:' && coop.httpsPort) origin = `https://${host}:${coop.httpsPort}`;
    else if (local) origin = `${location.protocol}//${host}${location.port ? ':' + location.port : ''}`;
    return `${origin}${location.pathname}?map=${coop.room?.map || map.id}&join=${code}${keepParams()}`;
  }

  $('host-btn').onclick = async () => {
    coopStatus('Opening a lobby…');
    try {
      // In the campaign tab, the lobby starts on the mission you picked (its map is the one loaded)
      const camp = menuMode === 'campaign' && picked.map === map.id;
      await coop.host(myName(), { ...soloSettings(), listed: true, mode: camp ? 'campaign' : 'waves', ...(camp ? { mission: picked.id } : {}) }); // coop.onRoom opens the lobby
    } catch (err) {
      console.warn(err);
      // The server said no (full, too many games opened): show its reason
      coopStatus(err.fromServer ? `<span class="err">${esc(err.message)}</span>` : noServer());
    }
  };

  // token: our secret from an earlier visit, to get our old slot back
  async function joinGame(code, token = null) {
    code = code.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { coopStatus('<span class="err">Room codes are 4 letters.</span>'); return; }
    coopStatus(token ? 'Rejoining your squad…' : 'Joining…');
    let r;
    try { r = await coop.join(code, myName(), token); } catch (err) { console.warn(err); coopStatus(noServer()); return; }
    if (r.t === 'wrong-map') { switchMap(r.map, code); return; }
    if (r.t === 'error') {
      if (token) CoopSession.clearSession();
      coopStatus(`<span class="err">${esc(r.msg)}</span>`);
    }
    // 'welcome': coop.onRoom opens the lobby
  }
  $('join-btn').onclick = () => joinGame($('join-code').value);
  $('join-code').onkeydown = (e) => { if (e.key === 'Enter') joinGame($('join-code').value); };

  // Every player must have the room's map loaded. Maps are built when the page
  // loads, so switching map means reloading; our session token (kept in
  // sessionStorage) gets us straight back into our slot afterwards.
  function switchMap(id, code = coop.code) {
    if (!MAPS.some((m) => m.id === id)) return;
    lobby.loadingMap = getMap(id).name;
    renderLobby();
    coopStatus(`Loading ${esc(getMap(id).name)}…`);
    store.set('dustline.map', id);
    location.search = `?map=${id}&join=${code}${keepParams()}`;
  }

  // "Open games" on the menu: ask the server every few seconds. If it can't
  // answer, this page came from a server without co-op (npm run solo, or an
  // npm start from before the lobby existed), so say how to fix that.
  async function refreshGames() {
    if (game.state !== 'menu') return;
    let ok = false;
    try {
      const res = await fetch('api/rooms', { cache: 'no-store' });
      if (!res.ok) throw new Error(res.status);
      renderGameList(await res.json(), (code) => { $('join-code').value = code; joinGame(code); });
      ok = true;
    } catch { /* no co-op server */ }
    $('games-box').classList.toggle('hidden', !ok);
    $('coop-offline').classList.toggle('hidden', ok);
    $('coop-offline').innerHTML = ok ? '' : `Co-op is off: this page isn't coming from the game's co-op server.<br>In the terminal, stop the server (Ctrl+C) and run <code>npm start</code>, then open <b>http://localhost:${location.port || 8000}</b>.`;
    $('host-btn').disabled = $('join-btn').disabled = !ok;
  }

  // ------------------------------------------------------------ co-op: lobby
  const lobby = new LobbyUI({
    ready: (v) => coop.setReady(v),
    options: (o) => {
      // Campaign: picking a mode or a mission also picks its map (which reloads everyone onto it)
      if (o.mode === 'campaign' || o.mission) {
        const m = missionById(o.mission) || missionById(coop.room?.mission) || picked;
        o = { ...o, mode: 'campaign', mission: m.id, map: m.map };
      }
      coop.setOptions(o);
      if (o.difficulty) { store.set('dustline.difficulty', o.difficulty); diffSel.value = o.difficulty; }
      if (o.waves !== undefined) { store.set('dustline.waves', o.waves); lengthSel.value = o.waves; }
      if (o.radar) { store.set('dustline.radar', o.radar); radarSel.value = o.radar; }
    },
    start: () => coop.startMission(),
    join: () => deployNow(),
    leave: () => leaveGame(),
    kick: (id, name) => { if (confirm(`Remove ${name} from the game?`)) coop.kick(id); },
    say: (text) => coop.say(text),
    brief: () => openBriefing(true),
    next: (id) => lobby.a.options({ mission: id }),
  });
  const renderLobby = () => { if (coop.room) lobby.render(coop.room, coop.myId, (p) => coop._status(p), voice); };
  const voiceBars = new VoiceBars(voice, [$('lobby-voice'), $('pause-voice'), $('brief-voice')]);
  voice.onChange = () => { voiceBars.update(); renderLobby(); };

  function enterLobby() {
    game.state = 'lobby';
    const link = inviteLink(coop.code);
    lobby.setInvite(link);
    // a self-made certificate: warn the host that friends will see a browser warning once
    $('invite-note').classList.toggle('hidden', !(location.protocol === 'http:' && coop.httpsPort && link.startsWith('https:')));
    voice.restoreMic(); // after a reload, if you'd switched your mic on
    showPanel('lobby');
    hud.show(false);
    renderLobby();
  }

  // Back to the lobby screen. The mission may carry on without us (friends can rejoin it).
  function leaveMission() {
    clearInterval(countdownTimer);
    lobby.countdown = 0;
    game.deployed = false;
    game.respawnT = 0;
    hud.closeChat();
    enterLobby();
    document.exitPointerLock();
  }

  function leaveGame() {
    if (coop.isHost && !confirm('Leave and close the lobby for everyone?')) return;
    coop.leave();
    location.search = `?map=${map.id}`;
  }

  // Into the mission. Pointer lock needs a click, so if the browser refuses
  // it here (after the countdown), the panel's FIGHT button asks for one.
  function deployNow() {
    audio.init();
    startGame();
    game.state = 'paused';
    hud.show(true);
    showPaused('MISSION STARTED', 'FIGHT');
    input.requestLock();
  }

  // The host pressed START: a short countdown, then everyone who was ready deploys.
  let countdownTimer = null;
  coop.onStart = (deployIds) => {
    if (!deployIds.includes(coop.myId)) return; // not ready: stay in the lobby and JOIN MISSION later
    clearInterval(countdownTimer);
    lobby.countdown = NET.countdown;
    renderLobby();
    countdownTimer = setInterval(() => {
      if (--lobby.countdown > 0) { renderLobby(); return; }
      clearInterval(countdownTimer);
      lobby.countdown = 0;
      if (coop.missionRunning) deployNow(); else renderLobby();
    }, 1000);
  };

  // The server sent a new room state.
  coop.onRoom = (room, prev) => {
    if (room.map !== map.id) { switchMap(room.map); return; } // the host picked another map
    // Campaign: know which mission the room is on (for the briefing, and to draw it once deployed)
    if (room.mode === 'campaign' && missionById(room.mission)?.map === map.id && director.data?.id !== room.mission) director.load(room.mission);
    if (prev?.phase === 'playing' && room.phase === 'lobby') {
      // Mission over (won, failed, aborted, or the host dropped): everyone back to the lobby
      if (coop.isHost) { enemies.clear(); ballistics.clear(); Object.assign(game, { wave: 0, between: false, over: false }); }
      if (director.live) director.stop();
      radio.clear();
      chud.hideCard();
      chud.clearBanners();
      grenades.reset(); // no live grenades carried over into the next mission
      if (game.state !== 'menu') leaveMission();
    }
    if (game.state === 'menu') enterLobby(); // just joined
    else renderLobby();
  };
  coop.onPings = renderLobby;
  coop.onWrongMap = (id) => switchMap(id);
  // Chat: every message appears in the HUD, the lobby and the pause menu
  coop.onChat = (m) => {
    const line = { ...m, me: m.id === coop.myId };
    hud.chatLine(line);
    lobby.chatLine(line);
    chatLineTo($('pause-chat-log'), line);
  };
  $('pause-chat-input').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const text = e.target.value.trim();
    if (text) coop.say(text);
    e.target.value = '';
  };
  coop.onConnection = (state) => $('netbanner').classList.toggle('hidden', state !== 'reconnecting');
  coop.onClosed = (reason) => {
    clearInterval(countdownTimer);
    game.state = 'lost';
    game.deployed = false;
    document.exitPointerLock();
    $('netbanner').classList.add('hidden');
    $('netlost-msg').textContent = reason;
    showPanel('netlost');
    hud.show(false);
  };
  $('netlost-btn').onclick = () => { location.search = `?map=${map.id}`; };

  // Pause menu, co-op only
  $('to-lobby').onclick = () => {
    if (!coop.isHost) { leaveMission(); return; }
    if (confirm('End the mission for the whole squad?')) endMission('aborted');
  };
  $('leave-game').onclick = () => leaveGame();

  // In-game chat: Enter or Y opens it (see tick), Enter sends, Esc cancels
  $('chat-input').onkeydown = (e) => {
    if (e.key === 'Enter') {
      const text = e.target.value.trim();
      if (text) coop.say(text);
      hud.closeChat();
    } else if (e.key === 'Escape') hud.closeChat();
  };

  // Scoreboard (hold Tab)
  function scoreboardRows() {
    if (coop.online) return coop.scoreboard();
    return [{ name: `${myName()} (solo)`, cls: armory.kitInfo.cls, kills: stats.kills, deaths: player.alive ? 0 : 1, headshots: stats.headshots, ping: null, status: player.alive ? 'alive' : 'KIA', me: true }];
  }
  function scoreboardTitle() {
    if (game.mode === 'campaign' && director.data) return `${director.data.title} · ${enemies.difficulty.name.toUpperCase()} · OBJECTIVE ${Math.min(director.obj + 1, director.data.objectives.length)} / ${director.data.objectives.length}`;
    const wave = coop.isClient ? coop.remote.wave : game.wave;
    const max = coop.online ? coop.room?.waves : game.maxWaves;
    return `${map.name.toUpperCase()} · ${enemies.difficulty.name.toUpperCase()} · WAVE ${wave}${max ? ` / ${max}` : ''}`;
  }

  // ------------------------------------------------------------ settings
  const sens = $('sens'), fov = $('fov');
  sens.value = player.sensitivity = parseFloat(store.get('dustline.sens', 1)) || 1;
  fov.value = player.fov = parseFloat(store.get('dustline.fov', PLAYER.baseFov)) || PLAYER.baseFov;
  const showSettings = () => { $('sens-val').textContent = (+sens.value).toFixed(2); $('fov-val').textContent = fov.value; };
  sens.oninput = () => { player.sensitivity = +sens.value; store.set('dustline.sens', sens.value); showSettings(); };
  fov.oninput = () => { player.fov = +fov.value; store.set('dustline.fov', fov.value); showSettings(); };
  showSettings();

  function resize() {
    R.resize();
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    vm.setAspect(camera.aspect);
  }
  window.addEventListener('resize', resize);
  resize();

  // Menu backdrop: stand at the spawn looking at the objective
  player.reset(level.playerSpawn.pos, level.playerSpawn.yaw);
  player.update(0.016, input);

  // ------------------------------------------------------------ shader pre-warm
  // A material's shader is compiled the first time it's drawn, which can freeze
  // the game for a moment — e.g. on your first shot (tracer, flash, bullet hole,
  // brass). Compile everything now, during loading, by briefly showing all the
  // hidden pooled objects and an example soldier.
  tactical.bake(); // top-down photo of the level for the minimap
  deployBtn.textContent = 'COMPILING SHADERS…';
  await new Promise((r) => setTimeout(r, 0));
  {
    const hidden = [];
    const reveal = (root) => root.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
    reveal(scene);
    reveal(vm.scene);
    for (const m of Object.values(vm.models)) m.group.visible = true;
    const sample = factory.create(), friend = factory.create({ tint: NET.friendlyTint, avatar: armory.avatar }); // (a squadmate in your look: gear and painted uniform shaders)
    sample.root.position.set(level.playerSpawn.pos.x, level.playerSpawn.pos.y, level.playerSpawn.pos.z - 6);
    friend.root.position.set(level.playerSpawn.pos.x + 1, level.playerSpawn.pos.y, level.playerSpawn.pos.z - 6);
    scene.add(sample.root, friend.root);
    R.renderer.compile(scene, camera);
    R.renderer.compile(vm.scene, vm.camera);
    R.render(0, { showViewmodel: true });
    scene.remove(sample.root, friend.root);
    friend.setAvatar(null);
    for (const o of hidden) o.visible = false;
    vm.setWeapon(weapons.currentId);
    warmed = true;
  }

  const labelFps = () => {
    const sel = $('fpsmode');
    sel.options[0].textContent = `Auto (${refresh.hz} or ${Math.round(refresh.hz / 2)} FPS)`;
    sel.options[1].textContent = `Full (${refresh.hz} FPS)`;
    sel.options[2].textContent = `Half (${Math.round(refresh.hz / 2)} FPS, steadier)`;
  };
  if (refresh.known) labelFps(); else refresh.onKnown = labelFps;

  // ------------------------------------------------------------ the loop
  function objectiveHtml() {
    if (game.mode === 'campaign' && director.data) return director.hudHtml() + (coop.online ? coop.squadHtml() : '');
    const wave = coop.isClient ? coop.remote.wave : game.wave;
    const max = coop.online ? coop.room?.waves : game.maxWaves;
    let s = `<span class="title">${map.name} — WAVE ${wave}${max ? ` / ${max}` : ''}</span><br>`;
    s += coop.isClient && wave === 0 ? 'Mission starting…' : `Hostiles: ${enemies.aliveCount}<br>Kills: ${stats.kills}`;
    if (coop.online) s += coop.squadHtml();
    return s;
  }

  // One step of the game. draw = false when the tab is hidden (see below).
  function tick(rawDt, draw) {
    const dt = Math.min(rawDt, 0.05); // clamp: a hitch shouldn't teleport bullets
    const t = clock.elapsedTime;
    if (draw && game.state === 'playing' && rawDt < 0.25) {
      R.updateDynamicResolution(rawDt, (halfRate ? 2 : 1) / refresh.hz, t);
      // Auto: if even the lowest resolution can't hold full rate, lock to half rate
      if (fpsMode === 'auto' && !halfRate) {
        struggling = R.scale <= R.q.minScale + 0.001 && R._miss > 0.3 ? struggling + rawDt : 0;
        if (struggling > 3) { halfRate = true; R.setScale(1); R._lastChange = t; }
      }
    }

    // Solo pauses the world when you pause. Co-op can't: your squad is still fighting.
    const playing = game.state === 'playing';
    if (playing || coop.online) {
      const ctl = playing ? input : IDLE_INPUT;
      if (game.deployed) {
        stats.time += player.alive ? dt : 0;
        player.update(dt, ctl);
        weapons.update(dt, ctl, player, camera);
        grenades.updatePlayer(dt, ctl, playing);
      }
      if (!coop.isClient) enemies.update(dt, squadTargets()); // friends' enemies are puppets, moved by coop.update
      coop.update(dt);
      if (coop.online) voice.update(dt);
      ballistics.update(dt);
      effects.update(dt);
      grenades.update(dt);
      if (!coop.isClient) waveRules(dt);
      director.tick(dt); // campaign props, the escort on friends' screens
      respawnRules(dt);
      radio.update(dt);

      if (playing && coop.online && !hud.chatOpen && (input.wasPressed('Enter') || input.wasPressed('KeyY'))) {
        hud.openChat();
        input.releaseAll(); // stop walking while you type
      }

      // Campaign: hold F to use things, aim to observe (a mission's use comes before the ammo crate's)
      game.prompt = game.mode === 'campaign' ? director.interact(dt, ctl, playing && game.deployed) : '';
      if (!game.prompt && playing && game.deployed && player.alive && level.ammoCrates.some((c) => c.distanceTo(player.pos) < 2.4)) {
        game.prompt = '[F] RESUPPLY';
        if (input.wasPressed('KeyF')) {
          const newKit = pendingLoadout;
          if (newKit) applyLoadout();
          weapons.refill();
          grenades.refill();
          player.bandages = PLAYER.bandages;
          hud.message(newKit ? 'NEW LOADOUT ISSUED' : 'RESUPPLIED', 1.5);
        }
      }
      // Otherwise, what you can do right here: "[SPACE] VAULT", "[W] CLIMB LADDER"...
      if (!game.prompt && playing && game.deployed && player.alive) game.prompt = player.hint;
    }
    if (!playing) input.consumeMouse();
    audio.update(dt, player); // heartbeat, breathing (holding / gasping), indoor echo

    if (draw) {
      level.update(t, camera.position);
      R.updateShadow(player.pos);
      effects.setPixelScale((window.innerHeight * R.renderer.getPixelRatio() * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      audio.setListener(camera);

      hud.update(dt, {
        health: player.health, stamina: player.stamina, bandages: player.bandages,
        bandaging: player.bandaging, bandageLeft: PLAYER.bandageTime - player.bandageT,
        weapon: weapons.hudState(), fov: camera.fov, yaw: player.yaw, sprinting: player.sprintAmount > 0.3,
        prompt: game.prompt, renderScale: R.scale, halfRate, objective: objectiveHtml(),
        pos: player.pos, alive: player.alive,
      });
      hud.tags(coop.online ? coop.tags(camera) : []);
      hud.cls($('chat-hint'), 'hidden', !coop.online);
      hud.cls($('tx'), 'hidden', !voice.transmitting);
      hud.scoreboard(playing && input.isDown('Tab'), scoreboardTitle(), scoreboardRows());
      tactical.update(dt, playing ? input : IDLE_INPUT, playing && game.deployed);
      chud.markers(director.markers(), camera, game.mode === 'campaign' && game.deployed && !tactical.bigOpen);
      chud.update(dt);

      R.updateFlare(camera, world, dt);
      scope.update(dt, weapons, vm, player, playing && game.deployed);
      R.render(dt, { showViewmodel: player.alive && game.deployed && !weapons.scoped, hurt: player.alive ? Math.max(0, (35 - player.health) / 35) : 0 });
    }
    input.endFrame();
  }

  const clock = new THREE.Clock();
  let skip = false, struggling = 0;
  function frame() {
    requestAnimationFrame(frame);
    // Half rate: draw on every other display refresh. 50 even frames per second
    // feels smoother than a frame rate that keeps bouncing between 100 and 60.
    if (halfRate) { skip = !skip; if (skip) return; }
    tick(clock.getDelta(), true);
  }
  requestAnimationFrame(frame);

  // Browsers stop calling requestAnimationFrame in a hidden tab. In co-op that
  // would freeze the game for everyone (the host's tab IS the server), so keep
  // simulating on a timer, without drawing, while the tab is hidden. Timers in
  // background tabs can be slowed down, so catch up in small steps.
  setInterval(() => {
    if (!document.hidden || !coop.online) return;
    let left = Math.min(clock.getDelta(), 1);
    do { tick(Math.min(left, 0.05), false); left -= 0.05; } while (left > 0.001);
  }, 1000 / 30);

  deployBtn.disabled = false;
  setMenuMode(menuMode); // the tabs, the mission list and the big button's label
  // Picked a mission on another map (or came back from one)? Straight to its briefing.
  if (menuMode === 'campaign' && params.get('mission') === picked.id && picked.map === map.id && !params.get('join')) goMission(picked);
  const saved = CoopSession.savedSession();
  if (saved?.code && saved.token && (!joinParam || joinParam === saved.code)) {
    joinGame(saved.code, saved.token); // we reloaded (map change, refresh): back into our slot
  } else if (joinParam) {
    // Opened an invite link: join straight away if we know your callsign, otherwise ask first
    $('join-code').value = joinParam;
    if (callsign.value.trim()) joinGame(joinParam);
    else { coopStatus('Enter your callsign, then press JOIN.'); callsign.focus(); }
  }
  refreshGames();
  setInterval(refreshGames, 4000);

  // Handy for experimenting in the browser console: game.player.health = 1000
  window.game = {
    scene, camera, renderer: R, world, terrain, level, nav, player, weapons, enemies, ballistics, effects, audio, input, stats, map, coop, voice, rules: game, grenades, tactical, armory, applyLoadout, vm, builder,
    director, radio, chud, // campaign
    // Tests: start a campaign mission without the menus (pointer lock)
    debugMission(id) { menuMode = 'campaign'; director.load(id); startGame(); game.state = 'playing'; showPanel(null); hud.show(true); },
    debugStart() { startGame(); game.state = 'playing'; showPanel(null); hud.show(true); },
  };
}

init();

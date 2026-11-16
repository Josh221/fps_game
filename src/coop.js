// =============================================================================
// coop.js — co-op multiplayer: a lobby, then up to 4 players against the AI.
//
// TWO LAYERS:
//   • LOBBY (owned by the server, see server/server.mjs): who's in the room,
//     who's ready, the map and mission settings, chat, and whether a mission
//     is running. We get the whole room state in a 'room' message whenever it
//     changes and keep it in this.room.
//   • GAME (owned by the host's browser): the netcode below.
//
// WHO DECIDES WHAT ("authority" — the core question of all netcode):
//
//   • The HOST's browser runs the enemy AI, the waves and enemy health, using
//     exactly the same code as solo play. Twenty times a second it sends a
//     SNAPSHOT of every soldier to everyone else.
//   • Every player's own browser decides about THEIR OWN soldier: movement,
//     ammo and health. Friends send their state to the host, and the host
//     passes it on to everyone inside the snapshot.
//   • Bullets are simulated on EVERY computer, so everyone sees the tracers
//     and impacts. But exactly one computer decides what each bullet DID:
//       – Your bullets: your computer checks whether they hit an enemy, then
//         sends the host a "hit report". This is CLIENT-SIDE HIT DETECTION:
//         if your crosshair was on him on your screen, it's a hit, lag or no
//         lag. That's fine between friends, but a cheater could fake reports,
//         so competitive games check hits on the server instead (see
//         LEARNING.md, "lag compensation").
//       – Enemy bullets: each computer only applies damage to its OWN player.
//         If you ducked behind a wall on your screen, you're safe.
//   • Grenades are simulated everywhere too. The host applies their damage to
//     enemies; each computer applies it to its own player.
//
// On a friend's computer the enemies are PUPPETS: they don't think, they just
// copy the host's snapshots (blended smoothly; see net.js).
//
// GAME MESSAGES (JSON; `t` is the type, arrays keep them short):
//   friend -> host   st  my state     sh  I fired     ht  I hit enemy #id    nz  I made a noise
//   host -> friends  snap  every soldier's state     es  an enemy fired     kill  enemy down (who got him, which way he fell)
//                    ev  wave started / area secure / mission won           score  everyone's kills and deaths
//   both ways        sh  a squadmate fired     gr  a grenade was thrown     spot  an enemy was spotted
//
// CAMPAIGN missions (campaign/director.js) add three things:
//   • the host's snapshot carries the mission state in `x` (objective,
//     progress, bonus goals, the escort), so everyone's HUD matches;
//   • one-off mission moments go out as 'ev' messages with k: 'cm';
//   • friend -> host  act  "I'm holding F on site #i" / "I'm observing target #i".
// =============================================================================
import * as THREE from 'three';
import { NetClient, RemoteClock, Interpolator, LERP, ANGLE, STEP, now, r1, r2, r3, r4 } from './net.js';
import { Teammate, packPlayer } from './teammate.js';
import { NET, AI, WEAPONS, DIFFICULTY } from './config.js';
import { issueFor } from './enemy.js';

const _muz = new THREE.Vector3(), _off = new THREE.Vector3(), _v = new THREE.Vector3();
const vec = (a) => new THREE.Vector3(+a?.[0] || 0, +a?.[1] || 0, +a?.[2] || 0);
const arr2 = (v) => [r2(v.x), r2(v.y), r2(v.z)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SESSION_KEY = 'dustline.session';

// An enemy on the wire: [id, x, y, z, yaw, speed, crouch, aiming, aimPitch, alive, flinch, climb]
function packEnemy(e) {
  return [e.netId, r2(e.pos.x), r2(e.pos.y), r2(e.pos.z), r3(e.yaw), r2(e.speed || 0), r2(e.crouch), r2(e.aiming),
    r3(e.aimPitch), e.alive ? 1 : 0, r2(e.flinch), r2(e.climbT || 0)];
}
const ENEMY_MODES = [LERP, LERP, LERP, ANGLE, LERP, LERP, LERP, LERP, STEP, LERP, LERP];

// =============================================================================
// An enemy as seen on a FRIEND's computer: a body that follows the host's
// snapshots. It lives in EnemyManager.enemies alongside nothing else, so the
// bullet code (EnemyManager.raycast) and the HUD hostile count work unchanged.
class EnemyPuppet {
  constructor(session, netId, first) {
    this.session = session;
    this.netId = netId;
    this.body = session.factory.create({ seed: netId }); // the same soldier model the host picked for this id (enemy.js)
    this.issue = issueFor(netId);                          // and the same gun
    this.body.setGun(session.factory.issueGun(this.issue.gun));
    this.root = this.body.root;
    session.scene.add(this.root);
    for (const m of this.body.hitMeshes) m.userData.enemy = this;
    this.interp = new Interpolator(ENEMY_MODES);
    this.pos = new THREE.Vector3(first[1], first[2], first[3]);
    this.yaw = first[4];
    this.alive = first[9] === 1;
    this.deathT = this.alive ? -1 : 1; // joined after he fell: already on the ground
    this.walkPhase = 0;
    this.lastFiredAt = -99;            // for the radar (see minimap.js)
  }

  // The host's AI does the hearing, flinching and dodging; puppets ignore it.
  hear() {}
  suppress() {}
  dodge() {}

  // Our bullet hit this puppet: tell the host (see the top of this file).
  onBulletHit(info) { this.session._reportHit(this, info); }

  update(dt, t) {
    const s = this.interp.sample(t);
    if (!s) return;
    // On a ladder: the climbing pose steps one rung (30 cm) per half cycle
    this.climbPhase = (this.climbPhase || 0) + (Math.abs(s[1] - this.pos.y) * Math.PI) / 0.3;
    this.pos.set(s[0], s[1], s[2]);
    this.yaw = s[3];
    this.crouch = s[5]; // spotting (minimap.js) checks lower body points when he's crouched
    const alive = s[8] === 1;
    if (!alive && this.alive) this.deathT = 0; // just died
    this.alive = alive;
    if (!alive) this.deathT = Math.min(1, this.deathT + dt * 1.6);

    const speed = alive ? s[4] : 0;
    const before = Math.floor(this.walkPhase / Math.PI);
    this.walkPhase += (speed * dt * Math.PI) / 0.8;
    if (Math.floor(this.walkPhase / Math.PI) !== before && speed > 0.5) this.session.audio.enemyFootstep(this.pos, speed > 3 ? 1 : 0.5);

    this.root.position.copy(this.pos);
    this.root.rotation.y = this.yaw;
    this.body.animate(dt, {
      speed, crouch: s[5], aiming: alive ? s[6] : 0, aimPitch: s[7],
      deathT: alive ? -1 : this.deathT, flinch: s[9],
      climb: alive ? s[10] || 0 : 0, climbPhase: this.climbPhase, // (an older host sends no climb -> 0)
    });
  }

  dispose() { this.session.scene.remove(this.root); }
}

// =============================================================================
export class CoopSession {
  // sys = { scene, world, factory, player, weapons, enemies, ballistics, effects, audio, game, mapId }
  constructor(sys) {
    Object.assign(this, sys);
    this.mode = 'solo';            // 'solo' | 'host' | 'client'
    this.net = null;
    this.myId = 0;
    this.myName = '';
    this.code = '';
    this.token = null;             // our secret for getting our slot back after a reload
    this.addrs = [];               // the server's network addresses (for invite links)
    this.room = null;              // lobby state from the server (see view() in server.mjs)
    this.teammates = new Map();    // id -> Teammate (everyone online except us)
    this.puppets = new Map();      // friend only: enemy id -> EnemyPuppet
    this.hostClock = new RemoteClock();
    this.remote = { wave: 0, between: false }; // friend only: the host's game state
    this.scores = new Map();       // host: id -> { kills, deaths, headshots, shots, hits }
    this.scoreRows = [];           // friend: [[id, kills, deaths, headshots]] from the host
    this.sendTimer = 0;
    this.scoreTimer = 0;
    this.reconnecting = false;
    this.grenades = null;          // optional systems, see attachExtras()
    this.spotting = null;
    this.minimap = null;
    this.mission = null;           // the campaign's MissionDirector (main.js sets it)

    // main.js fills these in
    this.onRoom = null;            // (room, previousRoom) lobby state changed
    this.onPings = null;           // () pings updated
    this.onStart = null;           // (deployIds) the host started the mission
    this.onChat = null;            // ({ id, name, text, sys })
    this.onEvent = null;           // (msg) friend: a game event from the host
    this.onKill = null;            // (byMe, headshot, killerName)
    this.onConnection = null;      // ('reconnecting' | 'ok')
    this.onClosed = null;          // (reason) we're out of the room: kicked, room closed, connection lost
    this.onWrongMap = null;        // (mapId) the room's map changed while we were away
  }

  get online() { return this.mode !== 'solo'; }
  get isHost() { return this.mode === 'host'; }
  get isClient() { return this.mode === 'client'; }
  get missionRunning() { return this.room?.phase === 'playing'; }
  nameOf(id) { return this.room?.players.find((p) => p.id === id)?.name || 'Squadmate'; }

  // The relay lives on the same server as the game, unless ?server=wss://... says otherwise.
  serverUrl() {
    const custom = new URLSearchParams(location.search).get('server');
    if (custom) return custom;
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  // Grenades, spotting and the minimap (grenades.js, minimap.js) send their
  // events through here so the whole squad sees them.
  attachExtras({ grenades, spotting, minimap }) {
    Object.assign(this, { grenades, spotting, minimap });
    if (grenades) grenades.onThrow = (g) => this._sendGrenade(g);
    // Host: one of the squad's claymores was tripped; everyone else sets theirs off
    if (grenades) grenades.onMineFired = (pos) => { if (this.online && this.isHost) this.net?.send({ t: 'mx', p: arr2(pos) }); };
    if (spotting) spotting.onSpot = (e) => { if (this.online && e?.netId) this.net?.send({ t: 'spot', from: this.myId, e: e.netId }); };
  }

  // ------------------------------------------------------------------ session (survives a page reload)
  static savedSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } }
  static clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ } }
  _saveSession() { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code: this.code, token: this.token })); } catch { /* storage unavailable */ } }

  // ------------------------------------------------------------------ lobby: joining
  async host(name, settings) {
    await this._connect();
    const r = await this._ask({ t: 'host', name, map: this.mapId, ...settings }, ['welcome', 'error']);
    // fromServer: the server answered "no" (e.g. it's full), as opposed to not answering at all
    if (r.t !== 'welcome') { this.net.close(); throw Object.assign(new Error(r.msg), { fromServer: true }); }
    this._welcome(r);
    return r;
  }

  // Returns the server's reply: 'welcome', 'wrong-map' (load that map first) or 'error'.
  // With a token, it's a REjoin: we get our old slot back.
  async join(code, name, token = null) {
    await this._connect();
    const r = await this._ask({ t: 'join', code, name, map: this.mapId, token }, ['welcome', 'wrong-map', 'error']);
    if (r.t !== 'welcome') { this.net.close(); return r; }
    this._welcome(r);
    return r;
  }

  // A request that hangs up cleanly if the server never answers
  async _ask(msg, replies) {
    try { return await this.net.request(msg, replies); } catch (err) { this.net.onClose = null; this.net.close(); throw err; }
  }

  _welcome(w) {
    // ice: the voice relay (TURN) for voice.js, or null (see server.mjs iceConfig)
    Object.assign(this, { myId: w.id, token: w.token, myName: w.name, addrs: w.addrs || [], httpsPort: w.httpsPort || null, ice: w.ice || null, code: w.room.code });
    this._saveSession();
    if (this.myKit) this.net.send({ t: 'kit', ...this.myKit });
    if (this.micOn) this.net.send({ t: 'mic', v: true });
    this._setRoom(w.room);
  }

  async _connect() {
    if (this.net) { this.net.onClose = null; this.net.close(); }
    const net = (this.net = new NetClient(this.serverUrl()));
    await net.connect();
    net.onClose = () => this._dropped();
    // lobby (from the server)
    net.on('room', (m) => this._setRoom(m.room));
    net.on('pings', (m) => this._pings(m.p));
    net.on('start', (m) => this.onStart?.(Array.isArray(m.deploy) ? m.deploy : []));
    net.on('chat', (m) => this.onChat?.(m));
    net.on('sig', (m) => this.voice?.onSignal(m.from, m.d)); // voice chat setup (voice.js)
    net.on('kicked', () => this._closed('The host removed you from the game.'));
    net.on('closed', (m) => this._closed(m.reason || 'The game was closed.'));
    // game: host side
    net.on('st', (m) => this._friendState(m));
    net.on('ht', (m) => this._friendHit(m));
    net.on('nz', (m) => { if (this.isHost) this.enemies.hearNoise(vec(m.p), Math.min(20, +m.r || 0), 'footstep'); });
    net.on('act', (m) => { if (this.isHost) this.mission?.remoteAct(m.from, String(m.k), +m.i); }); // campaign: a friend is using / observing something
    // game: both sides
    net.on('sh', (m) => this._shotFrom(m));
    net.on('gr', (m) => this._grenadeFrom(m));
    net.on('mx', (m) => { if (!this.isHost) this.grenades?.mineFiredAt(vec(m.p)); }); // only the host trips claymores
    net.on('spot', (m) => this._spotFrom(m));
    // game: friend side
    net.on('snap', (m) => this._snapshot(m));
    net.on('es', (m) => this._enemyShot(m));
    net.on('kill', (m) => this._killFrom(m));
    net.on('ev', (m) => this.onEvent?.(m));
    net.on('score', (m) => { if (this.isClient && Array.isArray(m.s)) this.scoreRows = m.s; });
  }

  // The connection dropped by accident (Wi-Fi, sleep, server restart). Keep
  // trying to get our slot back; the server holds it for a minute.
  async _dropped() {
    if (!this.online || this.reconnecting) return;
    this.reconnecting = true;
    this.onConnection?.('reconnecting');
    for (let i = 0; i < 25 && this.reconnecting; i++) {
      await sleep(i === 0 ? 500 : 2000);
      let r;
      try { r = await this.join(this.code, this.myName, this.token); } catch { continue; } // server unreachable: try again
      if (r.t === 'welcome') { this.reconnecting = false; this.onConnection?.('ok'); return; }
      if (r.t === 'wrong-map') { this.reconnecting = false; this.onWrongMap?.(r.map); return; }
      break; // 'error': the room is gone
    }
    if (this.reconnecting) this._closed('Lost connection to the game.');
  }

  // We're out of the room for good.
  _closed(reason) {
    if (this.net) { this.net.onClose = null; this.net.close(); this.net = null; }
    CoopSession.clearSession();
    const wasOnline = this.online;
    this._shutdown();
    if (wasOnline) this.onClosed?.(reason);
  }

  _shutdown() {
    for (const tm of this.teammates.values()) tm.dispose();
    this.teammates.clear();
    if (this.isClient) this._clearPuppets();
    this.voice?.closeAll();
    this.mode = 'solo';
    this.room = null;
    this.reconnecting = false;
    if (this.grenades) this.grenades.damagesEnemies = true;
  }

  // ------------------------------------------------------------------ lobby: actions
  setReady(v) { this.net?.send({ t: 'ready', v: !!v }); }
  setOptions(opts) { this.net?.send({ t: 'set', ...opts }); }      // host: { map, difficulty, waves, radar, listed }
  startMission() { this.net?.send({ t: 'start' }); }               // host
  endMission(result, report) { this.net?.send({ t: 'end', result, report }); } // host: 'won' | 'failed' | 'aborted'
  say(text) { this.net?.send({ t: 'chat', text }); }
  // Our class and main weapon ({ cls, gun }), so the squad can see who's carrying what
  setKit(kit) { this.myKit = kit; this.net?.send({ t: 'kit', ...kit }); }
  // Voice chat: tell the room whether our mic is on, and pass setup messages to one player
  setMic(on) { this.micOn = on; this.net?.send({ t: 'mic', v: !!on }); }
  sendSignal(to, d) { this.net?.send({ t: 'sig', to, d }); }
  kick(id) { this.net?.send({ t: 'kick', id }); }                  // host

  leave() {
    this.net?.send({ t: 'leave' });
    if (this.net) { this.net.onClose = null; this.net.close(); this.net = null; }
    CoopSession.clearSession();
    this._shutdown();
  }

  _setRoom(room) {
    const prev = this.room;
    this.room = room;
    this.mode = room.hostId === this.myId ? 'host' : 'client';
    if (this.grenades) this.grenades.damagesEnemies = !this.isClient; // enemy health lives on the host
    // Difficulty matters on every computer: friends apply enemy damage to themselves
    this.enemies.difficulty = DIFFICULTY[room.difficulty] || DIFFICULTY.regular;
    // Same for the enemy radar: the host picks it in the lobby, and every
    // minimap in the squad follows the room's choice.
    if (this.minimap) this.minimap.mode = room.radar || 'fire';
    this._syncTeammates();
    this.voice?.sync(room);
    this.onRoom?.(room, prev);
  }

  _pings(list) {
    if (!this.room || !Array.isArray(list)) return;
    for (const [id, ms] of list) { const p = this.room.players.find((q) => q.id === id); if (p) p.ping = ms; }
    this.onPings?.();
  }

  // One Teammate per connected squadmate, straight from the room list.
  _syncTeammates() {
    const want = new Map(this.room.players.filter((p) => p.online && p.id !== this.myId).map((p) => [p.id, p]));
    for (const [id, tm] of this.teammates) {
      if (want.has(id)) continue;
      tm.dispose();
      this.teammates.delete(id);
    }
    for (const [id, p] of want) {
      let tm = this.teammates.get(id);
      if (!tm) {
        // The host hears from each friend directly, so needs a clock per friend.
        // Friends hear about everyone from the host, so share the host's clock.
        const clock = this.isHost ? new RemoteClock() : this.hostClock;
        tm = new Teammate({ scene: this.scene, factory: this.factory, audio: this.audio, id, name: p.name, clock });
        this.teammates.set(id, tm);
      }
      tm.name = p.name;
      tm.setKit?.(p.kit); // the guns they picked (rebuilt only when it changes)
    }
  }

  // ------------------------------------------------------------------ every frame
  update(dt) {
    if (!this.online) return;
    for (const tm of this.teammates.values()) tm.update(dt);
    if (this.isClient) {
      const t = this.hostClock.now() - NET.interpDelay;
      for (const p of this.puppets.values()) p.update(dt, t);
      if (this.game.deployed) this.enemies.pushPlayerOut(this.enemies.enemies, this.player);
    }
    // Send at a fixed rate, not every frame: 20 updates a second is plenty
    // when the other side blends between them.
    if ((this.sendTimer -= dt) <= 0) {
      this.sendTimer = Math.max(0, this.sendTimer + 1 / NET.sendRate);
      if (this.isHost) this._sendSnapshot();
      else this.net?.send({ t: 'st', T: r3(now()), s: packPlayer(this.player, this.game.deployed) });
    }
    if (this.isHost && this.missionRunning && (this.scoreTimer -= dt) <= 0) {
      this.scoreTimer = 1;
      this.net?.send({ t: 'score', s: [...this.scores].map(([id, s]) => [id, s.kills, s.deaths, s.headshots]) });
    }
  }

  // ------------------------------------------------------------------ host side
  _sendSnapshot() {
    const p = [[this.myId, ...packPlayer(this.player, this.game.deployed)]];
    for (const tm of this.teammates.values()) if (tm.latest) p.push([tm.id, ...tm.latest]);
    this.net?.send({
      t: 'snap', T: r3(now()),
      g: [this.game.wave, this.game.between ? 1 : 0],
      e: this.enemies.enemies.map(packEnemy),
      p,
      x: this.mission?.netState() || undefined, // campaign mission state (campaign/director.js)
    });
  }

  _friendState(m) {
    const tm = this.teammates.get(m.from);
    // 11 to 15 values: + prone, + gun in hand, + lean, + climbing a ladder (see packPlayer in teammate.js)
    if (!this.isHost || !tm || !Array.isArray(m.s) || m.s.length < 11 || m.s.length > 15) return;
    tm.clock.sample(m.T);
    const wasAlive = tm.alive;
    tm.push(m.T, m.s.map(Number));
    if (wasAlive && tm.deployed && !tm.alive) this._score(tm.id).deaths++;
  }

  // A friend says their bullet hit enemy #e. We trust them (see top of file),
  // but keep the numbers sane.
  _friendHit(m) {
    const tm = this.teammates.get(m.from);
    const e = this.enemies.byNetId(m.e);
    if (!this.isHost || !tm || !e || !e.alive) return;
    this._score(tm.id).hits++;
    const zone = ['head', 'torso', 'limb'].includes(m.z) ? m.z : 'torso';
    e.onBulletHit({
      damage: Math.min(150, Math.max(0, +m.dmg || 0)), zone,
      headMul: Math.min(5, +m.hm || 1), limbMul: Math.min(1, +m.lm || 1),
      point: e.pos.clone(), dir: new THREE.Vector3(), from: tm.pos.clone(), shooter: tm,
    });
  }

  // Everyone hears about every enemy shot, so they see the flash and tracer
  // and hear the crack. Each computer decides only whether it hit ITS player.
  sendEnemyShot(enemy, origin, dir, tracer) {
    this.net?.send({ t: 'es', e: enemy.netId, o: arr2(origin), d: [r4(dir.x), r4(dir.y), r4(dir.z)], tr: tracer ? 1 : 0 });
  }

  // An enemy died. d: which way the shot that killed him was going (x, z),
  // so friends' copies of him fall the same way as the host's (character.js)
  sendKill(shooter, headshot, enemy) {
    const by = !shooter || shooter === this.player ? this.myId : shooter.id;
    const s = this._score(by);
    s.kills++;
    if (headshot) s.headshots++;
    const k = enemy?.body.killDir;
    this.net?.send({ t: 'kill', by, hs: headshot ? 1 : 0, e: enemy?.netId, d: k ? [r3(k.x), r3(k.z)] : undefined });
  }

  broadcast(msg) { if (this.isHost) this.net?.send(msg); }

  // Everyone the AI can fight: you (once deployed) and every deployed friend.
  aiTargets(includeMe) {
    const list = includeMe ? [this.player] : [];
    for (const tm of this.teammates.values()) if (tm.deployed) list.push(tm);
    return list;
  }

  // Is anyone in the squad still standing? (host)
  squadAlive(meDeployed) {
    if (meDeployed && this.player.alive) return true;
    for (const tm of this.teammates.values()) if (tm.alive) return true;
    return false;
  }

  // How many players are fighting (the host scales wave sizes with it)
  squadSize(meDeployed) { return (meDeployed ? 1 : 0) + [...this.teammates.values()].filter((t) => t.deployed).length; }

  // ------------------------------------------------------------------ scores (host keeps them)
  _score(id) {
    let s = this.scores.get(id);
    if (!s) this.scores.set(id, (s = { kills: 0, deaths: 0, headshots: 0, shots: 0, hits: 0 }));
    return s;
  }
  resetScores() { this.scores.clear(); this.scoreRows = []; }
  noteHit() { if (this.isHost) this._score(this.myId).hits++; }     // the host's own hits
  noteDeath() { if (this.isHost) this._score(this.myId).deaths++; } // the host's own deaths

  // The after-action report the host sends when a mission ends.
  report(wave, time) {
    return {
      wave, time: Math.round(time),
      rows: (this.room?.players || []).map((p) => {
        const s = this._score(p.id);
        return { name: p.name, kills: s.kills, deaths: s.deaths, headshots: s.headshots, acc: s.shots ? Math.round((100 * s.hits) / s.shots) : 0 };
      }),
    };
  }

  // Rows for the Tab scoreboard: everyone in the room.
  scoreboard() {
    return (this.room?.players || []).map((p) => {
      let kills = 0, deaths = 0, headshots = 0;
      if (this.isHost) ({ kills, deaths, headshots } = this._score(p.id));
      else { const r = this.scoreRows.find((x) => x[0] === p.id); if (r) [, kills, deaths, headshots] = r; }
      return { id: p.id, name: p.name, cls: p.kit?.cls || '', kills, deaths, headshots, ping: p.ping, me: p.id === this.myId, host: p.host, status: this._status(p) };
    });
  }

  _status(p) {
    if (!p.online) return 'reconnecting';
    if (p.id === this.myId) return !this.game.deployed ? 'in lobby' : this.player.alive ? 'alive' : 'KIA';
    const st = this.teammates.get(p.id)?.latest;
    return !st || !st[10] ? 'in lobby' : st[8] ? 'alive' : 'KIA';
  }

  // ------------------------------------------------------------------ both sides
  // We fired: tell everyone, so they see and hear it.
  // (the server overwrites "from" on friends' messages, so nobody can fake it)
  sendShot(origin, dir, weaponId, tracer, suppressed = false) {
    if (!this.online) return;
    if (this.isHost) this._score(this.myId).shots++;
    this.net?.send({ t: 'sh', from: this.myId, o: arr2(origin), d: [r4(dir.x), r4(dir.y), r4(dir.z)], w: weaponId, tr: tracer ? 1 : 0, s: suppressed ? 1 : 0 });
  }

  // A squadmate fired. Replay the shot here: flash, sound and a "replica"
  // bullet that makes tracers and impacts but can't hurt anyone (their own
  // computer decides what it hit).
  _shotFrom(m) {
    const from = m.from;
    if (from === this.myId) return;
    const tm = this.teammates.get(from);
    const cfg = WEAPONS[m.w] || WEAPONS.rifle;
    const origin = vec(m.o), dir = vec(m.d).normalize();
    if (tm?.shown) { tm.muzzleWorld(_muz); tm.fired(); } else _muz.copy(origin);
    this.effects.muzzleFlash(_muz, !m.s, m.s ? 0.15 : 0.45); // suppressed: barely any flash
    this.audio.gunshot(_muz.clone(), cfg.id, false, !!m.s);
    this.ballistics.fire({
      origin, dir, speed: cfg.muzzleVelocity, damage: cfg.damage, team: 'player', penetration: cfg.penetration,
      tracer: !!m.tr, visualOffset: _off.subVectors(_muz, origin), replica: true, shooter: tm || null,
    });
    if (this.isHost) {
      this._score(from).shots++;
      this.enemies.hearNoise(origin, cfg.loudness * (m.s ? 0.3 : 1), 'gunshot'); // the AI hears friends' shots too
      this.net.send({ ...m, ex: from }); // pass it on to everyone else
    }
  }

  // A grenade was thrown on THIS computer (by us, or by an enemy on the host).
  _sendGrenade(g) {
    if (!this.online) return;
    if (g.team === 'enemy' && !this.isHost) return; // only the host's enemies are real
    this.net?.send({ t: 'gr', from: g.team === 'enemy' ? 0 : this.myId, o: arr2(g.origin), v: arr2(g.vel), f: r2(g.fuse), tm: g.team, k: g.kind });
  }

  // Someone else's grenade: simulate the same throw here. (grenades.js decides
  // what damage it does on this computer; see attachExtras.)
  _grenadeFrom(m) {
    if (m.from === this.myId || !this.grenades) return;
    const team = m.tm === 'enemy' ? 'enemy' : 'player';
    this.grenades.spawnRemote({ origin: vec(m.o), vel: vec(m.v), fuse: Math.min(10, Math.max(0, +m.f || 0)), team, shooter: team === 'player' ? this.teammates.get(m.from) || null : null, kind: Object.hasOwn(this.grenades.types || {}, m.k) ? m.k : 'frag' }); // unknown type -> frag
    if (this.isHost) this.net.send({ ...m, ex: m.from });
  }

  _spotFrom(m) {
    if (m.from === this.myId) return;
    const e = this.isHost ? this.enemies.byNetId(m.e) : this.puppets.get(m.e);
    if (e) this.minimap?.markSpotted(e);
    if (this.isHost) this.net.send({ ...m, ex: m.from });
  }

  // ------------------------------------------------------------------ friend side
  _snapshot(m) {
    if (!this.isClient || !Array.isArray(m.e) || !Array.isArray(m.p)) return;
    this.hostClock.sample(m.T);
    // .map(Number) / | 0 below: snapshots should only hold numbers, and some of
    // them are shown on the HUD as HTML (wave, squadmates' HP). A host who
    // sent text instead could otherwise run code in every friend's browser.
    this.remote.wave = Math.max(0, +m.g?.[0] | 0);
    this.remote.between = m.g?.[1] === 1;
    if (m.x) this.mission?.applyNetState(m.T, m.x);

    const seen = new Set();
    for (const a of m.e) {
      const id = a[0];
      seen.add(id);
      let pup = this.puppets.get(id);
      if (!pup) {
        pup = new EnemyPuppet(this, id, a);
        this.puppets.set(id, pup);
        this.enemies.enemies.push(pup);
      }
      pup.interp.push(m.T, a.slice(1).map(Number));
    }
    // Enemies missing from the snapshot were removed by the host (old bodies, new mission)
    for (const [id, pup] of this.puppets) {
      if (seen.has(id)) continue;
      pup.dispose();
      this.puppets.delete(id);
      this.enemies.enemies.splice(this.enemies.enemies.indexOf(pup), 1);
    }
    for (const a of m.p) {
      const tm = a[0] !== this.myId && this.teammates.get(a[0]);
      if (tm) tm.push(m.T, a.slice(1).map(Number));
    }
  }

  // The host says an enemy died. His puppet here hasn't fallen yet (we draw
  // everyone 100 ms in the past), so there's time to tell it which way to go.
  _killFrom(m) {
    const pup = this.isClient ? this.puppets.get(m.e) : null;
    if (pup && Array.isArray(m.d)) pup.body.killDir = new THREE.Vector3(+m.d[0] || 0, 0, +m.d[1] || 0);
    this.onKill?.(m.by === this.myId, !!m.hs, this.nameOf(m.by));
  }

  // An enemy fired on the host. Same bullet here, and it CAN hurt our player.
  _enemyShot(m) {
    if (!this.isClient) return;
    const pup = this.puppets.get(m.e);
    const origin = vec(m.o), dir = vec(m.d).normalize();
    const issue = pup?.issue || issueFor(+m.e); // what he's carrying: how it sounds and hits
    if (pup) { pup.body.muzzleWorld(_muz); pup.lastFiredAt = now(); } else _muz.copy(origin);
    this.effects.muzzleFlash(_muz, true, 0.4);
    this.audio.gunshot(_muz.clone(), issue.gun.id, false);
    this.ballistics.fire({
      origin, dir, speed: AI.muzzleVelocity, damage: AI.damage * issue.damage * this.enemies.difficulty.damage, team: 'enemy', penetration: 0.8,
      tracer: !!m.tr, visualOffset: _off.subVectors(_muz, origin), headMul: AI.headMul,
    });
  }

  _reportHit(pup, info) {
    if (!pup.alive) return;
    this.net?.send({ t: 'ht', e: pup.netId, z: info.zone, dmg: r1(info.damage), hm: info.headMul, lm: info.limbMul });
    // Hit marker right away. Whether it was a KILL, the host tells us.
    this.enemies.onHit?.(pup, info.zone, false, info);
  }

  sendNoise(pos, radius) { if (this.isClient) this.net?.send({ t: 'nz', p: [r1(pos.x), r1(pos.y), r1(pos.z)], r: radius }); }

  _clearPuppets() {
    for (const p of this.puppets.values()) p.dispose();
    this.puppets.clear();
    this.enemies.enemies.length = 0;
  }

  // ------------------------------------------------------------------ HUD
  squadHtml() {
    let s = '<br><span class="title">SQUAD</span>';
    for (const tm of this.teammates.values()) {
      const st = tm.latest;
      const status = !st || !st[10] ? 'in lobby' : !st[8] ? '<span class="kia">KIA</span>' : `${st[9]} HP`;
      s += `<br>${esc(tm.name)} — ${status}${this.voice?.isTalking(tm.id) ? ' <span class="vox">🔊</span>' : ''}`;
    }
    if (!this.teammates.size) s += '<br><span class="dim">No squadmates online</span>';
    return s;
  }

  // Screen positions for the name tags over squadmates' heads.
  tags(camera) {
    const out = [];
    const w = window.innerWidth, h = window.innerHeight;
    for (const tm of this.teammates.values()) {
      if (!tm.shown) continue;
      _v.copy(tm.root.position);
      _v.y += tm.shownAlive ? 2.0 - 0.5 * tm.crouchShown - 1.3 * (tm.proneShown || 0) : 0.5;
      const dist = Math.round(_v.distanceTo(camera.position));
      _v.project(camera);
      const visible = _v.z < 1 && Math.abs(_v.x) < 1.1 && Math.abs(_v.y) < 1.1;
      out.push({ id: tm.id, name: tm.name, dead: !tm.shownAlive, dist, visible, talking: !!this.voice?.isTalking(tm.id), x: Math.round((_v.x * 0.5 + 0.5) * w), y: Math.round((-_v.y * 0.5 + 0.5) * h) });
    }
    return out;
  }
}

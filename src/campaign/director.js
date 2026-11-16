// =============================================================================
// campaign/director.js — the MISSION DIRECTOR: runs a mission from story.js.
//
// Every frame it checks the current objective ("is anyone in the zone?",
// "are the checkpoint guards dead?"), and when the objective is complete it
// runs that objective's actions (spawn the next enemies, play a radio call)
// and moves on to the next one. Optional bonus goals are tracked alongside.
//
// CHECKPOINTS: when an objective begins, the director remembers the state of
// the mission. If the squad dies (or the escort is killed), retry() puts
// everything back the way it was and restarts that objective, at that
// objective's checkpoint. Enemies don't survive a retry: the objective's
// `retry` actions spawn the ones that matter.
//
// CO-OP: the same split as the waves (see coop.js).
//   • The HOST runs the director: objectives, spawns, the escort, triggers.
//   • Twenty times a second its mission state rides along in the snapshot
//     (netState), so a friend's HUD, markers and props always match, even if
//     they join halfway through.
//   • One-off moments (radio calls, explosions, "objective complete") go out
//     as 'ev' messages.
//   • Friends' interactions (holding F on a site, observing a target) come to
//     the host as 'act' messages: "I'm doing this, right now". The host
//     checks they're actually standing there.
// =============================================================================
import * as THREE from 'three';
import { AI, GAME } from '../config.js';
import { r1, r2 } from '../net.js';
import { missionById } from './story.js';
import { Escort, EscortPuppet } from './escort.js';
import { MissionProps } from './props.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const _f = new THREE.Vector3(), _d = new THREE.Vector3();
const flat = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const rand = (a, b) => a + Math.random() * (b - a);
const now = () => performance.now() / 1000;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STATES = ['idle', 'running', 'won', 'failed'];
const HVT = ['alive', 'surrendered', 'dead', 'captured'];
export const FAIL = 0, OK = 1, PENDING = 2; // bonus goal results
const ACT_TTL = 0.4;   // seconds a friend's "I'm holding F" stays true
const USE_RANGE = 2;  // metres from a site you can use it
const RESTRAIN_TIME = 2.5;

// A progress bar in text, for HUD prompts: ▮▮▮▯▯▯▯▯
const bar = (t, n = 10) => '▮'.repeat(Math.round(Math.min(1, t) * n)) + '▯'.repeat(n - Math.round(Math.min(1, t) * n));
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export class MissionDirector {
  // sys = { scene, world, nav, enemies, player, coop, grenades, effects, audio, factory, M, weapons, camera, game, R }
  constructor(sys) {
    Object.assign(this, sys);
    this.props = new MissionProps(sys);
    this.data = null;       // the mission (story.js), once one is picked
    this.live = false;      // mission running on THIS computer (props built, escort drawn)
    this.vip = null;
    this._reset();
    // UI hooks, filled in by main.js
    this.onRadio = null;    // (key, jammed)
    this.onBanner = null;   // ('new' | 'done' | 'step', objective, text)
    this.onWon = null;      // (result)
    this.onFailed = null;   // (reason)
    this.onRetry = null;    // () respawn the local player at the checkpoint
    // Enemy bullets can hit the escort (host / solo only; see ballistics.js)
    this.bulletTarget = { raycast: (o, d, max, team) => (team === 'enemy' && this.vip?.raycast && !this.coop.isClient ? this.vip.raycast(o, d, max) : null) };
  }

  _reset() {
    this.state = 'idle';
    this.obj = 0;           // index of the current objective
    this.prog = [];         // its progress (what's in it depends on the type)
    this.bonus = [];        // FAIL / OK / PENDING per bonus goal
    this.alarm = false;
    this.jammed = false;
    this.time = 0;
    this.objT = 0;
    this.hvts = new Map();  // key -> { key, def, e (enemy or puppet), netId, state, pos, restrain }
    this.groups = new Map();
    this.pending = [];      // delayed actions
    this.acts = new Map();  // player id -> { k, i, t } what each player is doing right now
    this.fired = new Set(); // triggers that already went off
    this.marked = [];       // enemies Raven has marked (the last stragglers)
    this.lastAlive = new Map();
    this.waveT = 0;
    this.halfDone = false;
    this.checkpoint = null;
    this._actT = 0;
  }

  get cur() { return this.data?.objectives[this.obj] || null; }
  get running() { return this.state === 'running'; }
  get _myId() { return this.coop.online ? this.coop.myId : 0; }

  // ------------------------------------------------------------------ setup
  // Pick a mission (from the menu or the co-op room). Nothing happens yet.
  load(id) {
    const m = missionById(id);
    if (m === this.data) return !!m;
    if (this.live) this.stop();
    this.data = m;
    this._reset();
    return !!m;
  }

  // Host / solo: the mission begins.
  start() {
    if (!this.data) return;
    if (this.live) this.stop();
    this._reset();
    this._goLive();
    this.state = 'running';
    this.bonus = this.data.bonus.map(() => PENDING);
    this.jammed = !!this.data.jammed;
    if (this.data.vip) this._makeVip(true);
    this._run(this.data.begin || []);
    this._begin(0);
    this._grace();
  }

  // For the first few seconds of a mission (or a retry) nobody notices you:
  // the title card is up, and you deserve a moment to get into cover.
  _grace(seconds = 5) {
    for (const e of this.enemies.enemies) e.perceptionTimer = Math.max(e.perceptionTimer, seconds + Math.random());
  }

  // Co-op friend: the host is running the mission; draw it here.
  join() {
    if (!this.data || this.live) return;
    this._goLive();
    if (this.data.vip) this._makeVip(false);
    if (this._lastNet) this.applyNetState(this._lastNetT, this._lastNet);
  }

  _goLive() {
    this.live = true;
    this.props.build(this.data.props || []);
    this._applyAtmosphere(this.data.atmosphere || {});
  }

  _makeVip(host) {
    const v = this.data.vip, sys = { scene: this.scene, world: this.world, nav: this.nav, factory: this.factory, audio: this.audio };
    this.vip = host ? new Escort(sys, v) : new EscortPuppet(sys, v, this.coop.hostClock);
    if (host) {
      this.vip.reset(this._at(v.at), v.at[2] || 0, 'captive');
      this.vip.onDeath = () => this._fail(`${v.name} WAS KILLED`);
    }
  }

  // Back to no mission running (the mission choice is kept).
  stop() {
    for (const h of this.hvts.values()) h.e?.body?.setAvatar?.(null);
    this.vip?.dispose();
    this.vip = null;
    this.props.clear();
    this._restoreAtmosphere();
    this.live = false;
    this._reset();
  }

  // ------------------------------------------------------------------ atmosphere
  // A mission can make its map darker, foggier, later in the day (story.js
  // `atmosphere`). Numbers multiply the map's own; `sight` is how far the enemy
  // can see (fog hides you from them too). Undone when the mission ends.
  _applyAtmosphere(a) {
    const R = this.R, sc = this.scene, u = R.grade?.uniforms;
    this._saved = {
      exposure: R.renderer.toneMappingExposure, fog: sc.fog?.density, sun: R.sun?.intensity, env: sc.environmentIntensity,
      grade: u && { s: u.uSaturation.value, c: u.uContrast.value, t: u.uTint.value.clone(), v: u.uVignette.value },
    };
    if (a.exposure) R.renderer.toneMappingExposure *= a.exposure;
    if (a.fog && sc.fog) sc.fog.density *= a.fog;
    if (a.sun && R.sun) R.sun.intensity *= a.sun;
    if (a.env) sc.environmentIntensity *= a.env;
    if (a.grade) R.setGrade(a.grade);
    this.enemies.sightRange = a.sight || undefined;
  }

  _restoreAtmosphere() {
    const s = this._saved;
    if (!s) return;
    const R = this.R, sc = this.scene, u = R.grade?.uniforms;
    R.renderer.toneMappingExposure = s.exposure;
    if (sc.fog) sc.fog.density = s.fog;
    if (R.sun) R.sun.intensity = s.sun;
    sc.environmentIntensity = s.env;
    if (u && s.grade) { u.uSaturation.value = s.grade.s; u.uContrast.value = s.grade.c; u.uTint.value.copy(s.grade.t); u.uVignette.value = s.grade.v; }
    this.enemies.sightRange = undefined;
    this._saved = null;
  }

  // ------------------------------------------------------------------ helpers
  _at(a, h = 0) { return V(a[0], this.world.groundHeight(a[0], a[1]) + h, a[1]); }
  _targetPos(t) { return V(t.at[0], this.world.groundHeight(t.at[0], t.at[1]) + t.at[2], t.at[1]); }

  // The squad: you (once deployed) plus every deployed friend
  members() {
    const list = [];
    if (this.game.deployed) list.push({ id: this._myId, pos: this.player.pos, alive: this.player.alive });
    for (const tm of this.coop.teammates.values()) if (tm.deployed) list.push({ id: tm.id, pos: tm.pos, alive: tm.alive });
    return list;
  }

  // More enemies on harder difficulties and for bigger squads (like the waves)
  _mul() {
    const squad = this.coop.online ? Math.max(1, (this.coop.room?.players || []).filter((p) => p.online).length) : 1;
    return (this.enemies.difficulty?.enemies ?? 1) * (1 + GAME.coopScale * (squad - 1));
  }

  // Where a site is right now: on the escort, on an HVT (alive or dead), on a prop, or a fixed spot
  _sitePos(s) {
    if (s.on === 'vip') return this.vip?.pos || null;
    if (s.on) { const h = this.hvts.get(s.on); return h ? h.e?.pos || h.pos : null; } // (his body, or where it fell)
    if (s.prop) return this.props.get(s.prop)?.pos || null;
    return s.at ? this._at(s.at) : null;
  }

  // Where to respawn: the current objective's checkpoint, or the last one before it
  spawnPoint() {
    const d = this.data;
    let cp = d.start;
    for (let i = Math.min(this.obj, d.objectives.length - 1); i >= 0; i--) if (d.objectives[i].checkpoint) { cp = d.objectives[i].checkpoint; break; }
    return { pos: this._at(cp), yaw: cp[2] || 0 };
  }

  // ------------------------------------------------------------------ actions
  _run(list) {
    for (const a of list) {
      if (a.after) this.pending.push({ t: a.after, a: { ...a, after: 0 } });
      else this._do(a);
    }
  }

  _do(a) {
    if (a.spawn) this._spawn(a.spawn, { assault: !!a.assault });
    if (a.radio) this._radio(a.radio);
    if (a.show) this.props.show(a.show, true);
    if (a.hide) this.props.show(a.hide, false);
    if (a.boom) { this.props.boom(a.boom); this._event({ a: 'boom', id: a.boom }); }
    if (a.vip === 'follow' && this.vip) this.vip.state = 'follow';
    if (a.jam !== undefined) this.jammed = !!a.jam;
    if (a.alarm) this.raiseAlarm();
  }

  _radio(key) {
    this.onRadio?.(key, this.jammed);
    this._event({ a: 'radio', key, j: this.jammed ? 1 : 0 });
  }

  _event(ev) { if (this.coop.isHost) this.coop.broadcast({ ...ev, t: 'ev', k: 'cm' }); } // (t and k last: nothing in ev can overwrite them)

  // ------------------------------------------------------------------ enemies
  _spawn(name, { assault = false } = {}) {
    const list = this.data.groups[name];
    if (!list) { console.warn('Mission has no enemy group', name); return []; }
    const n = Math.max(1, Math.round(list.length * this._mul()));
    const entries = list.slice(0, Math.min(n, list.length)); // fewer: the first ones in the list (the important posts)
    const spares = list.filter((s) => s.role !== 'sentry' && !s.hvt);
    for (let i = list.length; i < n && spares.length; i++) { // more: extra guards and patrols, a step to one side
      const s = spares[i % spares.length], p = this._freeNear(s.x, s.z);
      if (p) entries.push({ ...s, x: p.x, z: p.z });
    }
    return entries.map((s) => {
      const e = this._spawnOne(s, name);
      if (assault) this._sendTo(e, this._nearest(e.pos)?.pos);
      return e;
    });
  }

  _spawnOne(s, group) {
    const y = s.y ?? this.world.groundHeight(s.x, s.z);
    const e = this.enemies.spawn({ pos: V(s.x, y, s.z), role: s.role, yaw: s.yaw, keepY: s.role === 'sentry' });
    e.mgroup = group;
    if (s.to) e.home.set(s.to[0], this.world.groundHeight(s.to[0], s.to[1]), s.to[1]); // a guard walks to his post (enemy.js _idle)
    if (s.hvt) {
      e.health = e.maxHealth = AI.health * (s.hvt.hp || 1);
      if (s.hvt.look) e.body.setAvatar(s.hvt.look);
      this.hvts.set(s.hvt.key, { key: s.hvt.key, def: s.hvt, e, netId: e.netId, state: 'alive', pos: e.pos.clone(), restrain: 0 });
    }
    if (!this.groups.has(group)) this.groups.set(group, []);
    this.groups.get(group).push(e);
    return e;
  }

  // A free spot a metre or two from (x, z), for extra soldiers
  _freeNear(x, z) {
    for (let k = 0; k < 10; k++) {
      const a = Math.random() * Math.PI * 2, r = 1.4 + Math.random() * 1.6;
      const p = V(x + Math.cos(a) * r, 0, z + Math.sin(a) * r);
      p.y = this.world.groundHeight(p.x, p.z);
      if (this.nav.walkable(p.x, p.z) && !this.world.boxBlocked(p.x - 0.35, p.y + 0.45, p.z - 0.35, p.x + 0.35, p.y + 1.7, p.z + 0.35)) return p;
    }
    return null;
  }

  // Send a soldier to attack a place: he runs there and searches (enemy.js 'alert')
  _sendTo(e, point) {
    if (!point || !e.alive) return;
    e.state = 'alert';
    e.lastKnown = point.clone().add(V(rand(-4, 4), 0, rand(-4, 4)));
    e.awareness = Math.max(e.awareness, 0.6);
    e.alertTimer = 0;
    e.arrived = false;
    e.waitTimer = rand(0, 1.2);
    e.stopMoving();
  }

  _nearest(pos) {
    let best = null, bd = Infinity;
    for (const m of this.members()) if (m.alive && m.pos.distanceTo(pos) < bd) { best = m; bd = m.pos.distanceTo(pos); }
    return best;
  }

  get _missionAlive() { return this.enemies.enemies.reduce((n, e) => n + (e.alive && e.mgroup ? 1 : 0), 0); }

  // Who the enemy AI can shoot at, besides the squad: the escort, once she's moving
  extraTargets() { return this.vip?.targetable ? [this.vip] : []; }

  // ------------------------------------------------------------------ the alarm
  raiseAlarm() {
    if (this.alarm) return;
    this.alarm = true;
    const d = this.data;
    d.bonus.forEach((b, i) => {
      if (b.type === 'undetected' && this.bonus[i] === PENDING) this.bonus[i] = FAIL;
    });
    this._run(d.alarm || []);
  }

  // ------------------------------------------------------------------ objectives
  _begin(i, retry = false) {
    this.obj = i;
    const o = this.cur;
    if (!o) return;
    this.objT = 0;
    this.halfDone = false;
    this.waveT = o.waves?.first ?? 0;
    this.prog = o.type === 'observe' ? o.targets.map(() => 0) : o.type === 'use' ? o.sites.map(() => 0) : o.type === 'hold' ? [0, 0] : [0, 0];
    this.checkpoint = this._snapshot();
    if (retry && o.retry) this._run(o.retry);
    if (o.start) this._run(o.start);
    this.onBanner?.('new', o);
    this._event({ a: 'new', i });
  }

  _complete() {
    const o = this.cur;
    this.onBanner?.('done', o);
    this._event({ a: 'obj', i: this.obj });
    this.data.bonus.forEach((b, i) => { if (b.type === 'undetected' && b.until === o.id && this.bonus[i] === PENDING) this.bonus[i] = OK; });
    if (o.done) this._run(o.done);
    if (this.obj + 1 >= this.data.objectives.length) this._win();
    else this._begin(this.obj + 1);
  }

  // How many players are doing `kind` at #i right now (holding F at a site, observing a target)
  _holders(kind, i, pos, range) {
    let n = 0;
    const t = now();
    for (const [id, a] of this.acts) {
      if (a.k !== kind || a.i !== i || t - a.t > ACT_TTL) continue;
      const m = id === this._myId ? this.player : this.coop.teammates.get(id);
      if (!m?.alive) continue;
      if (pos && range && flat(m.pos, pos) > range + 1.5) continue; // not actually standing there
      n++;
    }
    return n;
  }

  // A friend says what they're doing (coop.js 'act')
  remoteAct(from, k, i) {
    if (!this.running || !['use', 'obs', 'cap'].includes(k)) return;
    this.acts.set(from, { k, i: i | 0, t: now() });
  }

  // ------------------------------------------------------------------ every frame (host / solo)
  update(dt) {
    if (!this.running || !this.data) return;
    this.time += dt;
    this.objT += dt;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if ((this.pending[i].t -= dt) > 0) continue;
      const { a } = this.pending.splice(i, 1)[0];
      this._do(a);
      if (!this.running) return;
    }
    const members = this.members();
    this._deaths(members);
    if (this.vip?.update) this.vip.update(dt, members);
    if (!this.running) return; // the escort died
    for (const h of this.hvts.values()) {
      if (h.e?.alive && h.state === 'alive') h.pos.copy(h.e.pos);
      if (h.state === 'alive' && h.e && !h.e.alive) h.state = 'dead';
      // Badly wounded: he gives up (enemy.js stops him fighting)
      if (h.state === 'alive' && h.def.surrender && h.e?.alive && h.e.health < h.e.maxHealth * h.def.surrender) {
        h.state = 'surrendered';
        h.e.surrendered = true;
      }
      if (h.state === 'surrendered' && !h.e?.alive) h.state = 'dead'; // shot after he gave up
    }
    if (!this.alarm && this.enemies.enemies.some((e) => e.alive && e.mgroup && e.state === 'combat')) this.raiseAlarm();
    this._triggers(members);
    this._objective(dt, members);
  }

  _deaths(members) {
    for (const m of members) {
      if (this.lastAlive.get(m.id) && !m.alive) {
        this.data.bonus.forEach((b, i) => { if (b.type === 'nodeaths') this.bonus[i] = FAIL; });
      }
      this.lastAlive.set(m.id, m.alive);
    }
  }

  _triggers(members) {
    (this.data.triggers || []).forEach((t, i) => {
      if (this.fired.has(i)) return;
      const w = t.when, v = this.vip;
      let go = false;
      if (w.near) go = members.some((m) => m.alive && Math.hypot(m.pos.x - w.near[0], m.pos.z - w.near[1]) < w.near[2]);
      if (w.vipNear) go = !!v && v.state === 'follow' && Math.hypot(v.pos.x - w.vipNear[0], v.pos.z - w.vipNear[1]) < w.vipNear[2];
      if (w.vipHurt) go = !!v && v.state === 'follow' && v.alive && v.health < 100;
      if (w.surrender) go = this.hvts.get(w.surrender)?.state === 'surrendered';
      if (w.hvtAlive && this.hvts.get(w.hvtAlive)?.state !== 'alive') go = false; // only while he's still fighting
      if (!go) return;
      this.fired.add(i);
      this._run(t.do);
    });
  }

  _objective(dt, members) {
    const o = this.cur;
    if (!o) return;
    const alive = members.filter((m) => m.alive);
    switch (o.type) {
      case 'goto': {
        const at = this._at(o.at);
        const inside = alive.filter((m) => flat(m.pos, at) < o.radius).length;
        if (o.who === 'all' ? alive.length > 0 && inside === alive.length : inside > 0) this._complete();
        break;
      }
      case 'clear': {
        const list = o.groups.flatMap((g) => this.groups.get(g) || []);
        const left = list.filter((e) => e.alive);
        this.prog = [left.length, list.length];
        // The last two hiding somewhere? After a while Raven marks them for you
        this.marked = !this.jammed && left.length <= 2 && this.objT > 25 ? left : [];
        if (!left.length && this.objT > 0.5) this._complete();
        break;
      }
      case 'observe': {
        o.targets.forEach((t, i) => {
          if (this.prog[i] >= 1 || !this._holders('obs', i)) return;
          this.prog[i] = Math.min(1, this.prog[i] + dt / (o.time || 1.5));
          if (this.prog[i] >= 1) { this.onBanner?.('step', o, `${t.label} OBSERVED`); this._event({ a: 'step', text: `${t.label} OBSERVED` }); if (t.radio) this._radio(t.radio); }
        });
        if (this.prog.every((p) => p >= 1)) this._complete();
        break;
      }
      case 'use': {
        o.sites.forEach((s, i) => {
          if (this.prog[i] >= 1) return;
          const p = this._sitePos(s);
          if (!p || !this._holders('use', i, p, s.range || USE_RANGE)) return;
          this.prog[i] = Math.min(1, this.prog[i] + dt / (s.time || 2));
        });
        if (this.prog.every((p) => p >= 1)) this._complete();
        break;
      }
      case 'hold': {
        const at = this._at(o.at);
        const inZone = alive.some((m) => flat(m.pos, at) < o.radius);
        if (inZone) this.prog[0] = Math.min(1, this.prog[0] + dt / o.time);
        this.prog[1] = inZone ? 1 : 0;
        if (!this.halfDone && this.prog[0] >= 0.5) { this.halfDone = true; if (o.halfway) this._run(o.halfway); }
        if (o.waves) this._waves(dt, o, at, alive);
        if (this.prog[0] >= 1) this._complete();
        break;
      }
      case 'timer':
        this.prog[0] = Math.min(1, this.prog[0] + dt / o.time);
        if (this.prog[0] >= 1) this._complete();
        break;
      case 'hvt': {
        const h = this.hvts.get(o.target);
        if (!h) break; // not spawned yet
        if (h.state === 'surrendered' && this._holders('cap', 0, h.pos, 2.2)) {
          h.restrain = Math.min(1, h.restrain + dt / RESTRAIN_TIME);
          if (h.restrain >= 1) h.state = 'captured';
        }
        this.prog = [h.restrain, 0];
        if (h.state === 'dead' || h.state === 'captured') this._complete();
        break;
      }
      case 'escort': {
        if (!this.vip) { this._complete(); break; }
        const d = flat(this.vip.pos, this._at(o.to));
        this.prog = [d, 0];
        if (this.vip.alive && d < o.radius) this._complete();
        break;
      }
      default: this._complete();
    }
  }

  // Counterattack waves while the squad holds a zone
  _waves(dt, o, at, alive) {
    if ((this.waveT -= dt) > 0) return;
    const w = o.waves;
    this.waveT = w.every;
    const mul = this._mul();
    // Two limits: this attack's own size (max), and how many soldiers the
    // computer runs at once (like the waves mode: GAME.maxAlive / coopMaxAlive)
    const waveAlive = (this.groups.get('wave') || []).filter((e) => e.alive).length;
    const cap = this.coop.online ? GAME.coopMaxAlive : GAME.maxAlive;
    const room = Math.min(Math.round(w.max * Math.min(1.5, mul)) - waveAlive, cap - this._missionAlive);
    const n = Math.min(Math.round(w.size * mul), room);
    if (n <= 0) return;
    // Come in from places nobody in the squad is standing near
    const from = w.from.filter(([x, z]) => alive.every((m) => Math.hypot(m.pos.x - x, m.pos.z - z) > 35));
    const pick = (from.length ? from : w.from).slice().sort(() => Math.random() - 0.5).slice(0, 2);
    for (let k = 0; k < n; k++) {
      const [x, z] = pick[k % pick.length];
      const p = this._freeNear(x, z) || V(x, 0, z);
      this._sendTo(this._spawnOne({ role: 'patrol', x: p.x, z: p.z }, 'wave'), at);
    }
  }

  // ------------------------------------------------------------------ win, fail, retry
  _win() {
    this.state = 'won';
    const d = this.data;
    d.bonus.forEach((b, i) => {
      let r = this.bonus[i];
      if (b.type === 'time') r = this.time < b.minutes * 60 ? OK : FAIL;
      if (b.type === 'vip') r = this.vip && this.vip.alive && this.vip.health >= b.min ? OK : FAIL;
      if (b.type === 'captured') r = this.hvts.get(b.target)?.state === 'captured' ? OK : FAIL;
      if (r === PENDING) r = OK; // nodeaths / undetected never failed
      this.bonus[i] = r;
    });
    const res = this.result();
    this._event({ a: 'won', b: this.bonus, tm: Math.round(this.time) }); // (not `t`: that's the message type)
    this.onWon?.(res);
  }

  result() {
    const d = this.data, bonus = {};
    d.bonus.forEach((b, i) => { bonus[b.id] = this.bonus[i] === OK; });
    const stars = 1 + d.bonus.filter((b, i) => this.bonus[i] === OK).length;
    return { id: d.id, title: d.title, stars, bonus, time: this.time, list: d.bonus.map((b, i) => ({ text: b.text, ok: this.bonus[i] === OK })), debrief: d.debrief({ bonus }) };
  }

  _fail(reason) {
    if (!this.running) return;
    this.state = 'failed';
    this._event({ a: 'fail', why: reason });
    this.onFailed?.(reason);
  }

  // The squad was wiped out, or the escort was killed. (main.js decides.)
  squadWiped() { this._fail('SQUAD WIPED OUT'); }

  // Remember the mission as it is now: a checkpoint
  _snapshot() {
    return {
      obj: this.obj, mask: this.props.mask, alarm: this.alarm, jammed: this.jammed,
      vip: this.vip ? { pos: this.vip.pos.clone(), yaw: this.vip.yaw, state: this.vip.state, health: this.vip.health } : null,
      hvts: [...this.hvts.values()].map((h) => ({ ...h, pos: h.pos.clone() })),
      fired: new Set(this.fired),
    };
  }

  // Host / solo: back to the start of the current objective. The caller
  // (main.js) clears bullets and grenades and respawns the players.
  retry() {
    const cp = this.checkpoint;
    if (!this.data || !cp) return;
    for (const h of this.hvts.values()) h.e?.body?.setAvatar?.(null);
    this.enemies.clear();
    this.groups.clear();
    this.pending = [];
    this.acts.clear();
    this.marked = [];
    this.props.mask = cp.mask;
    this.alarm = cp.alarm;
    this.jammed = cp.jammed;
    this.fired = new Set(cp.fired);
    this.hvts = new Map(cp.hvts.filter((h) => h.state !== 'alive').map((h) => [h.key, { ...h, e: null, pos: h.pos.clone() }])); // the dead stay dead
    if (this.vip && cp.vip) this.vip.reset(cp.vip.pos, cp.vip.yaw, cp.vip.state, Math.max(60, cp.vip.health));
    this.state = 'running';
    this._begin(cp.obj, true);
    this._grace();
    this._event({ a: 'retry', o: cp.obj });
  }

  // ------------------------------------------------------------------ the local player (every computer)
  // Holding F at a site, observing a target, restraining a prisoner. Returns
  // the HUD prompt. Friends tell the host what they're doing (see the top).
  interact(dt, input, active) {
    this._actT -= dt;
    if (!this.live || !this.running || !active || !this.player.alive) return '';
    const o = this.cur;
    if (!o) return '';
    let act = null, prompt = '';
    if (o.type === 'use') {
      let best = -1, bd = Infinity;
      o.sites.forEach((s, i) => {
        const p = this._sitePos(s);
        if (!p || this.prog[i] >= 1 || Math.abs(p.y - this.player.pos.y) > 2.5) return;
        const d = flat(p, this.player.pos);
        if (d < (s.range || USE_RANGE) && d < bd) { best = i; bd = d; }
      });
      if (best >= 0) {
        const s = o.sites[best];
        if (input.isDown('KeyF')) { act = { k: 'use', i: best }; prompt = `${s.verb}  ${bar(this.prog[best])}`; }
        else prompt = `[F] HOLD — ${s.verb}`;
      }
    } else if (o.type === 'observe') {
      const i = this._observing(o);
      if (i >= 0) { act = { k: 'obs', i }; prompt = `OBSERVING ${o.targets[i].label}  ${bar(this.prog[i])}`; }
      else if (this.weapons.ads > 0.7) prompt = 'AIM AT A MARKED TARGET TO OBSERVE IT';
    } else if (o.type === 'hvt' && o.capture) {
      const h = this.hvts.get(o.target);
      const p = h && (h.e?.pos || h.pos);
      if (h?.state === 'surrendered' && p && flat(p, this.player.pos) < 2.2) {
        if (input.isDown('KeyF')) { act = { k: 'cap', i: 0 }; prompt = `RESTRAINING ${h.def.name}  ${bar(h.restrain)}`; }
        else prompt = `[F] HOLD — RESTRAIN ${h.def.name}`;
      }
    }
    if (act) {
      if (!this.coop.isClient) this.acts.set(this._myId, { ...act, t: now() });
      else if (this._actT <= 0) { this._actT = 0.12; this.coop.net?.send({ t: 'act', k: act.k, i: act.i }); }
    }
    return prompt;
  }

  // Which target is the local player observing? (aiming down sights, on it, with a clear view)
  _observing(o) {
    if (this.weapons.ads < 0.7) return -1;
    const cam = this.camera, eye = cam.position;
    cam.getWorldDirection(_f);
    for (let i = 0; i < o.targets.length; i++) {
      const t = o.targets[i];
      if (this.prog[i] >= 1) continue;
      const p = this._targetPos(t), dist = p.distanceTo(eye);
      if (dist > (t.range || 100)) continue;
      const cone = Math.max(0.03, Math.atan(2.5 / dist));
      if (_d.subVectors(p, eye).normalize().angleTo(_f) > cone) continue;
      if (!this.world.lineOfSight(eye, p) || this.world.smokeBlocks(eye, p)) continue;
      return i;
    }
    return -1;
  }

  // ------------------------------------------------------------------ every frame (every computer)
  tick(dt) {
    if (!this.live) return;
    this.props.update(dt);
    if (this.coop.isClient) {
      this.vip?.update?.(dt);
      for (const h of this.hvts.values()) {
        const pup = this.coop.puppets.get(h.netId);
        if (pup && pup !== h.e) { h.e = pup; if (h.def.look) pup.body.setAvatar(h.def.look); } // dress the host's HVT the same here
        if (!pup) h.e = null;
      }
    }
  }

  // ------------------------------------------------------------------ co-op mission state
  netState() {
    if (!this.data || this.state === 'idle') return null;
    return {
      id: this.data.id, o: this.obj, s: STATES.indexOf(this.state), p: this.prog.map(r2), b: this.bonus,
      a: this.alarm ? 1 : 0, j: this.jammed ? 1 : 0, m: this.props.mask, t: Math.round(this.time),
      h: [...this.hvts.values()].map((h) => [h.key, h.netId, HVT.indexOf(h.state), r1(h.pos.x), r1(h.pos.y), r1(h.pos.z), r2(h.restrain)]),
      k: this.marked.map((e) => e.netId),
      v: this.vip?.pack ? this.vip.pack() : 0,
    };
  }

  // Friend: the host's mission state arrived (in a snapshot)
  applyNetState(T, x) {
    if (!x || typeof x !== 'object') return;
    this._lastNet = x; this._lastNetT = T;
    if (!this.data || x.id !== this.data.id) return;
    const o = Math.max(0, Math.min(this.data.objectives.length - 1, x.o | 0));
    this.obj = o;
    this.state = STATES[x.s] || 'running';
    if (Array.isArray(x.p)) this.prog = x.p.map(Number);
    if (Array.isArray(x.b)) this.bonus = x.b.map(Number);
    this.alarm = !!x.a;
    this.jammed = !!x.j;
    this.time = +x.t || 0;
    if (this.live) this.props.mask = x.m | 0;
    if (Array.isArray(x.h)) {
      for (const [key, netId, st, px, py, pz, rs] of x.h) {
        const def = Object.values(this.data.groups).flat().find((s) => s.hvt?.key === key)?.hvt;
        if (!def) continue;
        let h = this.hvts.get(key);
        if (!h || h.netId !== netId) this.hvts.set(key, (h = { key, def, netId, e: null, pos: V(0, 0, 0), restrain: 0 }));
        h.state = HVT[st] || 'alive';
        h.pos.set(+px, +py, +pz);
        h.restrain = +rs || 0;
      }
    }
    this.markedIds = Array.isArray(x.k) ? x.k : [];
    if (this.live && x.v && this.vip?.push) this.vip.push(T, x.v);
  }

  // Friend: a one-off moment from the host
  onEvent(ev) {
    if (!this.data) return;
    const o = this.data.objectives[ev.i];
    if (ev.a === 'radio') this.onRadio?.(ev.key, !!ev.j);
    else if (ev.a === 'new' && o) { this.obj = ev.i; this.onBanner?.('new', o); }
    else if (ev.a === 'obj' && o) this.onBanner?.('done', o);
    else if (ev.a === 'step') this.onBanner?.('step', this.cur, ev.text);
    else if (ev.a === 'boom' && this.live) this.props.boom(ev.id);
    else if (ev.a === 'won') {
      this.state = 'won';
      if (Array.isArray(ev.b)) this.bonus = ev.b.map(Number);
      this.time = +ev.tm || this.time;
      this.onWon?.(this.result());
    } else if (ev.a === 'fail') { this.state = 'failed'; this.onFailed?.(ev.why); }
    else if (ev.a === 'retry') { this.obj = ev.o | 0; this.state = 'running'; this.onRetry?.(); }
  }

  // ------------------------------------------------------------------ HUD
  // The top-left objective panel
  hudHtml() {
    const d = this.data, o = this.cur;
    if (!d) return '';
    const n = d.objectives.length;
    let s = `<span class="title">${esc(d.title)}</span> <span class="dim">${Math.min(this.obj + 1, n)}/${n}</span><br>`;
    if (this.state === 'won') return s + '<span class="obj-done">✓ MISSION ACCOMPLISHED</span>';
    if (this.state === 'failed') return s + '<span class="kia">✕ MISSION FAILED</span>';
    if (!o) return s;
    s += `<span class="obj">▸ ${esc(o.text)}</span>`;
    const p = this.prog;
    let sub = '';
    if (o.type === 'goto' || o.type === 'escort') {
      const at = this._at(o.type === 'goto' ? o.at : o.to);
      sub = `${Math.round(flat(o.type === 'escort' && this.vip ? this.vip.pos : this.player.pos, at))} m`;
      if (o.type === 'escort' && this.vip) sub = `${this.data.vip.name}: ${sub} to go · ${Math.max(0, Math.round(this.vip.health))}% health`;
      if (o.who === 'all' && this.coop.online) sub += ' · whole squad';
    } else if (o.type === 'clear') sub = p[1] ? `${p[0]} hostile${p[0] === 1 ? '' : 's'} left` : '';
    else if (o.type === 'observe') sub = o.targets.map((t, i) => (p[i] >= 1 ? `✓ ${t.label}` : t.label)).join(' · ');
    else if (o.type === 'use') sub = o.sites.length > 1 ? `${p.filter((v) => v >= 1).length}/${o.sites.length}` : p[0] > 0 ? `${Math.round(p[0] * 100)}%` : '';
    else if (o.type === 'hold') sub = p[1] ? `${clock(o.time * (1 - p[0]))} left` : '<span class="kia">GET BACK IN THE ZONE</span>';
    else if (o.type === 'timer') sub = `${Math.ceil(o.time * (1 - p[0]))} s`;
    else if (o.type === 'hvt') { const h = this.hvts.get(o.target); sub = h?.state === 'surrendered' ? 'HE\'S GIVEN UP — HOLD F ON HIM' : ''; }
    if (sub) s += `<br><span class="dim">&nbsp;&nbsp;${sub}</span>`;
    if (this.jammed) s += '<br><span class="kia">RADIO JAMMED</span>';
    if (d.bonus.length) {
      s += '<br><span class="dim">BONUS</span> ' + d.bonus.map((b, i) => {
        const r = this.bonus[i], name = b.text.split(':')[0];
        return r === OK ? `<span class="obj-done">✓ ${esc(name)}</span>` : r === FAIL ? `<span class="kia">✕ ${esc(name)}</span>` : `<span class="dim">○ ${esc(name)}</span>`;
      }).join(' ');
    }
    return s;
  }

  // Objective markers: on screen (campaign/hud.js) and on the minimap (minimap.js)
  // [{ pos, label, kind: 'obj' | 'zone' | 'look' | 'vip' | 'hvt' | 'enemy' | 'area', r }]
  markers() {
    const out = [];
    const o = this.cur;
    if (!this.live || !this.running || !o) return out;
    const add = (pos, label, kind = 'obj', r = 0) => pos && out.push({ pos, label, kind, r });
    switch (o.type) {
      case 'goto': add(this._at(o.at, 1.6), o.label || 'MOVE', 'obj', o.radius); break;
      case 'escort': add(this._at(o.to, 1.6), o.label || 'GOAL', 'obj', o.radius); break;
      case 'hold': add(this._at(o.at, 1.6), o.label || 'HOLD', 'zone', o.radius); break;
      case 'observe': o.targets.forEach((t, i) => { if (this.prog[i] < 1) add(this._targetPos(t), t.label, 'look'); }); break;
      case 'use': o.sites.forEach((s, i) => { const p = this._sitePos(s); if (p && this.prog[i] < 1) add(p.clone().setY(p.y + 1.3), s.label); }); break;
      case 'clear': {
        const ids = this.coop.isClient ? this.markedIds || [] : this.marked.map((e) => e.netId);
        if (ids.length) {
          for (const id of ids) { const e = this.coop.isClient ? this.coop.puppets.get(id) : this.enemies.byNetId(id); if (e?.alive) add(e.pos.clone().setY(e.pos.y + 2.1), 'HOSTILE', 'enemy'); }
        } else {
          // the middle of the area those soldiers were guarding
          const pts = o.groups.flatMap((g) => this.data.groups[g] || []).filter((s) => s.role !== 'patrol');
          if (pts.length) add(this._at([pts.reduce((a, s) => a + s.x, 0) / pts.length, pts.reduce((a, s) => a + s.z, 0) / pts.length], 2), o.label || 'CLEAR', 'area');
        }
        break;
      }
      case 'hvt': {
        const h = this.hvts.get(o.target);
        const p = h && (h.e?.pos || h.pos);
        if (h && p && (h.state === 'alive' || h.state === 'surrendered')) add(p.clone().setY(p.y + 2.2), h.state === 'surrendered' ? `${h.def.name} (SURRENDERED)` : h.def.name, 'hvt');
        break;
      }
      default:
    }
    if (this.vip?.alive && this.vip.state === 'follow') add(this.vip.pos.clone().setY(this.vip.pos.y + 2.1), this.data.vip.name, 'vip');
    return out;
  }

  // Every mission point on this map, so a test can check a soldier can stand on each
  pointsToCheck() {
    const d = this.data, out = [];
    if (!d) return out;
    out.push({ what: 'start', x: d.start[0], z: d.start[1] });
    for (const [g, list] of Object.entries(d.groups)) list.forEach((s, i) => {
      out.push({ what: `${g}[${i}] ${s.role}`, x: s.x, z: s.z, y: s.y });
      if (s.to) out.push({ what: `${g}[${i}] walks to`, x: s.to[0], z: s.to[1] });
    });
    d.objectives.forEach((o) => {
      if (o.checkpoint) out.push({ what: `${o.id} checkpoint`, x: o.checkpoint[0], z: o.checkpoint[1] });
      if (o.at && o.type !== 'observe') out.push({ what: `${o.id} zone`, x: o.at[0], z: o.at[1] });
      if (o.to) out.push({ what: `${o.id} goal`, x: o.to[0], z: o.to[1] });
      for (const s of o.sites || []) if (s.at) out.push({ what: `${o.id} site`, x: s.at[0], z: s.at[1] });
      for (const [x, z] of o.waves?.from || []) out.push({ what: `${o.id} wave from`, x, z });
    });
    if (d.vip) out.push({ what: 'vip', x: d.vip.at[0], z: d.vip.at[1] });
    return out;
  }
}

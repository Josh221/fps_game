// =============================================================================
// loot.js — taking what the fallen were carrying: their ammo and their guns.
//
// Walk up to a body and look at it:
//   [F]       take the ammo from his pouches that fits your guns
//   hold [F]  look at his gun on the ground instead and hold F to swap it for
//             yours. Yours drops where you stand, with the rounds you had for
//             it, so you (or a squadmate) can always swap back.
//
// CALIBRES: ammo only fits a gun of the same calibre (loadout.js GUNS `cal`).
// A dead SMG gunner's 9 mm feeds your sidearm, not your carbine; a marksman's
// 7.62 feeds a DMR or a bolt-action. What each enemy carries is rolled from
// his network id (enemy.js issueFor), so every co-op computer agrees on it.
//
// WHAT'S WHERE:
//   • a body's pouches: `bodies`, by the soldier's network id. Created the
//     first time we see him dead, from his issue: { rounds, mag, cal, gunTaken }.
//   • his gun: the model his body dropped (character.js, gundrop.js).
//   • guns players dropped: `dropped`, by an id the host hands out ("d7").
//
// CO-OP: two players reaching for the same rifle mustn't both get it, so the
// HOST decides who takes what (it's the "authority", as for enemy health):
//   friend -> host   lq { a: 'ammo' | 'gun', i: item id, n: rounds wanted, d: the gun I'm dropping }
//   host -> friends  lt { by, a, i, ... }  what happened, so everyone's world matches
//   host -> friend   lt { a: 'gone', i }   too late: somebody got there first
// A friend waits for the host's answer (a few hundredths of a second) before
// anything changes in their hands. The host's own grabs happen at once.
// =============================================================================
import * as THREE from 'three';
import { LOOT } from './config.js';
import { GUNS, buildWeapon, encodeGun, decodeGun } from './loadout.js';
import { GunDrop } from './gundrop.js';

const _eye = new THREE.Vector3(), _look = new THREE.Vector3(), _to = new THREE.Vector3(), _p = new THREE.Vector3();
const bar = (t, n = 10) => '▮'.repeat(Math.round(Math.min(1, t) * n)) + '▯'.repeat(n - Math.round(Math.min(1, t) * n));
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v) || 0));
const vec = (a, max) => new THREE.Vector3(+a?.[0] || 0, +a?.[1] || 0, +a?.[2] || 0).clampLength(0, max);
const r2 = (v) => Math.round(v * 100) / 100;
const gunName = (cfg) => (cfg.tag ? `${cfg.name} · ${cfg.tag}` : cfg.name);

export class Loot {
  // sys = { scene, world, factory, enemies, weapons, player, camera, coop, audio, hud }
  constructor(sys) {
    Object.assign(this, sys);
    this.bodies = new Map();  // enemy network id -> { rounds, mag, cal, gunTaken }
    this.dropped = new Map(); // id -> { id, spec, cfg, mag, reserve, obj, drop }
    this.nextId = 0;          // (host / solo) ids for dropped guns
    this.holdT = 0;           // how long F has been held on a gun...
    this.pressedOn = null;    // ...and which one it was pressed on (a hold only counts on the gun you pressed at,
                              //    so still holding F after a swap can't swap straight back to the gun you dropped)
    this.waitT = 0;           // (friend) waiting for the host to answer a request
    this.pruneT = 0;
    this.onEquip = null;      // () a different gun is in our hands (main.js: shaders, tell the squad)
  }

  // A new mission (or back to the menu): nothing on the ground
  clear() {
    for (const d of this.dropped.values()) this.scene.remove(d.obj);
    this.dropped.clear();
    this.bodies.clear();
    this.pressedOn = null;
    this.waitT = 0;
  }

  // ------------------------------------------------------------------ every frame
  // Moves the dropped guns, and (active = you're up and playing) works out
  // what you're looking at and what F does to it. Returns the prompt, or ''.
  update(dt, input, active) {
    for (const d of this.dropped.values()) d.drop.update(dt);
    if ((this.pruneT -= dt) <= 0) { this.pruneT = 3; this._prune(); }
    this.waitT = Math.max(0, this.waitT - dt);
    const it = active ? this._target() : null;
    if (input.wasPressed('KeyF')) { this.pressedOn = it?.id ?? null; this.holdT = 0; }
    if (!it) return '';
    if (it.kind === 'ammo') {
      const plan = this._ammoPlan(it.st.cal, it.st.rounds), cal = it.st.cal.toUpperCase();
      if (!plan.total) return `${cal} AMMO — ${plan.fits ? 'YOU\'RE FULL' : 'DOESN\'T FIT YOUR GUNS'}`;
      if (input.wasPressed('KeyF') && !this.waitT) this._ask({ a: 'ammo', i: it.id, n: plan.total });
      return `[F] TAKE ${cal} AMMO (+${plan.total})`;
    }
    // A gun: hold F to swap (a tap is too easy to do by accident)
    const name = gunName(it.cfg);
    if (!input.isDown('KeyF') || this.pressedOn !== it.id || this.waitT) return `HOLD [F] SWAP FOR ${name} (${it.mag}+${it.reserve})`;
    this.holdT += dt;
    if (this.holdT >= LOOT.holdTime) {
      this.pressedOn = null; // (let go of F before the next one)
      this._ask({ a: 'gun', i: it.id, d: this._myDrop(GUNS[it.spec.id].slot) });
    }
    return `SWAPPING FOR ${name}  ${bar(this.holdT / LOOT.holdTime)}`;
  }

  // What's in reach, and which of it you're looking at most directly
  _target() {
    const cam = this.camera, me = this.player.pos;
    cam.getWorldPosition(_eye);
    cam.getWorldDirection(_look);
    let best = null, bestScore = Infinity;
    const score = (pos) => { // lower = more what you mean; Infinity = out of reach or not looked at
      const flat = Math.hypot(pos.x - me.x, pos.z - me.z);
      if (flat > LOOT.reach || Math.abs(pos.y - me.y) > 1.8) return Infinity;
      const angle = _look.angleTo(_to.subVectors(pos, _eye));
      return angle > 0.6 && flat > 0.9 ? Infinity : angle + flat * 0.08; // (standing over it counts as looking at it)
    };
    const consider = (s, make) => { if (s < bestScore) { bestScore = s; best = make(); } };
    for (const e of this.enemies.enemies) {
      if (e.alive || !e.body.dead || !e.issue) continue;
      const near = score(e.body.bodyCenter(_p));
      const g = e.body.groundGun, gs = g ? score(g.getWorldPosition(_p)) : Infinity;
      if (near === Infinity && gs === Infinity) continue;
      const st = this._body(e);
      if (st.rounds > 0) consider(near, () => ({ kind: 'ammo', id: `b${e.netId}`, st }));
      if (!st.gunTaken) consider(gs, () => ({ kind: 'gun', id: `g${e.netId}`, spec: e.issue.gun, mag: st.mag, reserve: 0, cfg: (e.issue.cfg ??= buildWeapon(e.issue.gun)) }));
    }
    for (const d of this.dropped.values()) consider(score(d.obj.getWorldPosition(_p)), () => ({ kind: 'gun', id: d.id, spec: d.spec, mag: d.mag, reserve: d.reserve, cfg: d.cfg }));
    return best;
  }

  // A body's pouches, the first time we look: what his issue says he carried
  _body(e) {
    let st = this.bodies.get(e.netId);
    if (!st) this.bodies.set(e.netId, (st = { rounds: e.issue.spare, mag: e.issue.magLeft, cal: GUNS[e.issue.gun.id].cal, gunTaken: false }));
    return st;
  }

  // Forget bodies that have been cleared away
  _prune() {
    if (!this.bodies.size) return;
    const ids = new Set(this.enemies.enemies.map((e) => e.netId));
    for (const id of this.bodies.keys()) if (!ids.has(id)) this.bodies.delete(id);
  }

  // How much of `rounds` of calibre `cal` we can carry: the gun in our hands
  // first, then the other. Each gun's pouches hold its reserve (config.js).
  _ammoPlan(cal, rounds) {
    const W = this.weapons, order = W.currentId === 'primary' ? ['primary', 'secondary'] : ['secondary', 'primary'];
    const take = [];
    let left = rounds, fits = false;
    for (const slot of order) {
      const st = W.state[slot];
      if (GUNS[st.cfg.base]?.cal !== cal) continue;
      fits = true;
      const n = Math.min(left, Math.max(0, st.cfg.reserve - st.reserve));
      if (n > 0) { take.push([slot, n]); left -= n; }
    }
    return { take, total: rounds - left, fits };
  }

  // The gun we'd drop to make room: whatever's in that slot, with its rounds,
  // thrown down in front of us
  _myDrop(slot) {
    const st = this.weapons.state[slot], cam = this.camera;
    cam.getWorldDirection(_look).setY(0).normalize();
    const p = this.player.pos.clone().addScaledVector(_look, 0.45).setY(this.player.pos.y + Math.max(0.6, this.player.height - 0.6));
    const v = _look.clone().multiplyScalar(1.4).setY(0.9);
    const s = [(Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 10];
    return { w: encodeGun({ id: st.cfg.base, mods: st.cfg.attachments }), m: st.mag, r: st.reserve, p: [r2(p.x), r2(p.y), r2(p.z)], v: [r2(v.x), r2(v.y), r2(v.z)], s: s.map(r2), q: r2(this.player.yaw) };
  }

  // ------------------------------------------------------------------ taking
  // Ours to decide (solo, or the host): do it now. A friend asks the host.
  _ask(req) {
    if (!this.coop.isClient) { this._decide(this.coop.online ? this.coop.myId : 0, req); return; }
    this.waitT = 1;
    this.coop.net?.send({ t: 'lq', ...req });
  }

  // Host: a friend's request (the server stamped `from` on it, so it can't be faked)
  request(m) {
    if (!this.coop.teammates.has(m.from)) return;
    this._decide(m.from, { a: m.a, i: String(m.i), n: m.n, d: m.d });
  }

  // Solo / host: who gets what. Everything a friend sent is checked first.
  _decide(by, req) {
    const mine = !this.coop.online || by === this.coop.myId;
    if (req.a === 'ammo') {
      const e = this._enemyFor(req.i, 'b'), st = e && this._body(e);
      if (!st) return;
      const n = int(req.n, 0, st.rounds);
      st.rounds -= n;
      if (mine) this._giveAmmo(st.cal, n);
      this._broadcast({ by, a: 'ammo', i: req.i, n, left: st.rounds });
      return;
    }
    if (req.a !== 'gun') return;
    const got = this._remove(req.i);
    if (!got) { // gone already
      if (!mine) this.coop.net?.send({ t: 'lt', to: by, a: 'gone', i: req.i });
      else this.hud.message('SOMEONE GOT THERE FIRST', 1.5);
      return;
    }
    const nd = this._checkDrop(req.d, by);
    if (nd) { nd.i = `d${++this.nextId}`; this._spawnDrop(nd); }
    if (mine) this._equip(got.spec, got.mag, got.reserve);
    this._broadcast({ by, a: 'gun', i: req.i, w: encodeGun(got.spec), mag: got.mag, res: got.reserve, nd: nd || undefined });
  }

  // Friend: the host's answer, about us or about someone else
  result(m) {
    const me = m.by === this.coop.myId;
    if (m.a === 'ammo') {
      const e = this._enemyFor(String(m.i), 'b'), st = e && this._body(e);
      if (st) st.rounds = int(m.left, 0, st.rounds);
      if (me) { this.waitT = 0; this._giveAmmo(st?.cal, int(m.n, 0, 1000)); }
    } else if (m.a === 'gun') {
      this._remove(String(m.i));
      const nd = m.nd && this._checkDrop(m.nd, null);
      if (nd) { nd.i = String(m.nd.i); this._spawnDrop(nd); }
      const spec = decodeGun(m.w);
      if (me && spec) { this.waitT = 0; this._equip(spec, int(m.mag, 0, 500), int(m.res, 0, 2000)); }
    } else if (m.a === 'gone') {
      this._remove(String(m.i));
      this.waitT = 0;
      this.hud.message('SOMEONE GOT THERE FIRST', 1.5);
    }
  }

  _broadcast(msg) { if (this.coop.isHost) this.coop.net?.send({ t: 'lt', ...msg }); }

  // "b12" / "g12" -> enemy #12 (a body: dead, so not something to grab off a live one)
  _enemyFor(id, prefix) {
    if (!id.startsWith(prefix)) return null;
    const e = this.enemies.byNetId(+id.slice(1));
    return e && !e.alive && e.issue ? e : null;
  }

  // Take gun `id` out of the world. Returns what it was, or null if it's not there.
  _remove(id) {
    if (id.startsWith('g')) {
      const e = this._enemyFor(id, 'g');
      if (!e) return null;
      const st = this._body(e);
      if (st.gunTaken) return null;
      st.gunTaken = true;
      e.body.takeGun();
      return { spec: e.issue.gun, mag: st.mag, reserve: 0 };
    }
    const d = this.dropped.get(id);
    if (!d) return null;
    this.dropped.delete(id);
    this.scene.remove(d.obj);
    return { spec: d.spec, mag: d.mag, reserve: d.reserve };
  }

  // A dropped gun as sent over the network, made safe: a real gun, sensible
  // numbers, near the player who dropped it (by = their id; null = trust the host)
  _checkDrop(d, by) {
    const spec = d && decodeGun(d.w);
    if (!spec) return null;
    const cfg = buildWeapon(spec);
    let p = vec(d.p, 1e5);
    if (by !== null) {
      const who = by === this.coop.myId || !this.coop.online ? this.player : this.coop.teammates.get(by);
      if (!who || p.distanceTo(who.pos) > 3) p = (who?.pos || p).clone().setY((who?.pos || p).y + 1);
    }
    return { w: encodeGun(spec), m: int(d.m, 0, cfg.magSize + 1), r: int(d.r, 0, cfg.reserve * 2), p: [p.x, p.y, p.z], v: vec(d.v, 4).toArray().map(r2), s: vec(d.s, 15).toArray().map(r2), q: +d.q || 0 };
  }

  // Put a dropped gun in the world, thrown from where it was dropped
  _spawnDrop(nd) {
    const spec = decodeGun(nd.w), cfg = buildWeapon(spec), gun = this.factory.issueGun(spec);
    const obj = gun.group;
    obj.position.set(nd.p[0], nd.p[1], nd.p[2]);
    obj.rotation.set(0, nd.q, 0);
    this.scene.add(obj);
    obj.updateMatrixWorld(true);
    const drop = new GunDrop(obj, this.scene, this.world, { vel: new THREE.Vector3(...nd.v), spin: new THREE.Vector3(...nd.s) });
    this.dropped.set(nd.i, { id: nd.i, spec, cfg, mag: nd.m, reserve: nd.r, obj, drop });
    // Too many lying about: the oldest goes (Maps keep the order things were added)
    while (this.dropped.size > LOOT.maxDropped) {
      const [id, old] = this.dropped.entries().next().value;
      this.scene.remove(old.obj);
      this.dropped.delete(id);
    }
  }

  // ------------------------------------------------------------------ into our hands
  _giveAmmo(cal, n) {
    if (!cal || n <= 0) return;
    let left = n;
    for (const [slot, k] of this._ammoPlan(cal, n).take) { this.weapons.state[slot].reserve += k; left -= k; }
    this.audio.reload('magIn');
    this.hud.message(`+${n - left} ${cal.toUpperCase()}`, 1.2);
  }

  _equip(spec, mag, reserve) {
    const cfg = buildWeapon(spec);
    this.weapons.equip(GUNS[spec.id].slot, cfg, Math.min(mag, cfg.magSize + 1), reserve);
    this.audio.reload('switch');
    this.hud.message(gunName(cfg), 1.5);
    this.onEquip?.();
  }
}

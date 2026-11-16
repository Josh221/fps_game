// =============================================================================
// minimap.js — tactical HUD: minimap + radar, full map, spotting, grenade
// warnings. (Ideas from Call of Duty, Battlefield and Squad.)
//
//   Minimap (top right): rotates with you, so "up" is always where you face.
//   Its background is a real top-down photo of the level, rendered once while
//   the map loads, with the camera looking straight down.
//
//   RADAR — who shows up as a red dot (setting):
//     Always on     every enemy, all the time (like a UAV overhead)
//     When firing   enemies appear for a moment when they shoot
//     Spotted only  only enemies you or your squad have spotted with T
//     Off           hardcore: just the map, your squad and objectives
//   Enemies you spot with T are marked on everyone's minimap and on screen.
//
//   M   full tactical map with a grid (north up)
//   T / middle mouse   spot the enemy under your crosshair
// =============================================================================
import * as THREE from 'three';
import { RADAR } from './config.js';

const now = () => performance.now() / 1000;
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _f = new THREE.Vector3();
// The radar is a MISSION setting, like difficulty: solo picks it on the menu,
// co-op in the lobby (the host chooses; the server gives every player the same).
// main.js / coop.js set tactical.mode before the fight.
export const MODES = { always: 'Always on', fire: 'When firing', spotted: 'Spotted only', off: 'Off (hardcore)' };

const CSS = `
#mm { position: absolute; top: 14px; right: 16px; width: 210px; height: 210px; border-radius: 10px; overflow: hidden;
  background: #0d100c; box-shadow: 0 0 0 1px rgba(201,180,106,0.45), 0 2px 10px rgba(0,0,0,0.6); }
#mm canvas { width: 100%; height: 100%; display: block; }
#mm-label { position: absolute; left: 8px; bottom: 5px; font: 10px var(--mono); color: var(--hud-dim); letter-spacing: 1px; text-shadow: 0 1px 2px #000; }
#killfeed { top: 238px !important; }
#bigmap { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(8,10,7,0.55); pointer-events: none; }
#bigmap canvas { width: min(86vh, 92vw); height: min(86vh, 92vw); box-shadow: 0 0 0 1px rgba(201,180,106,0.6), 0 6px 30px rgba(0,0,0,0.7); }
.spot-mark { position: absolute; width: 0; height: 0; pointer-events: none; }
.spot-mark i { position: absolute; left: -7px; top: -14px; width: 14px; height: 14px; transform: rotate(45deg); border: 2px solid #ff4a3a;
  background: rgba(255,74,58,0.25); box-shadow: 0 0 4px rgba(0,0,0,0.8); }
.spot-mark span { position: absolute; left: 10px; top: -16px; font: 10px var(--mono); color: #ff8a7a; text-shadow: 0 1px 2px #000; white-space: nowrap; }
.nade-warn { position: absolute; width: 0; height: 0; pointer-events: none; }
.nade-warn svg { position: absolute; left: -18px; top: -18px; width: 36px; height: 36px; filter: drop-shadow(0 0 3px #000); }
.nade-warn.pulse svg { animation: nadepulse 0.5s infinite alternate; }
@keyframes nadepulse { from { transform: scale(1); } to { transform: scale(1.18); } }
#nade-info { position: absolute; left: 24px; bottom: 118px; font: 12px var(--mono); color: var(--hud-dim); text-shadow: 0 1px 2px #000; line-height: 1.6; }
#nade-info b { color: var(--hud); }
#nade-info .cook { color: #ff6a5a; font-weight: bold; }
#spot-msg { position: absolute; left: 50%; top: 56%; transform: translateX(-50%); font: 12px var(--mono); color: #ff8a7a; letter-spacing: 2px; opacity: 0; transition: opacity 0.2s; text-shadow: 0 1px 2px #000; }
`;

const NADE_SVG = '<svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="rgba(160,20,10,0.55)" stroke="#ff5a4a" stroke-width="2"/>' +
  '<ellipse cx="18" cy="20" rx="7" ry="8" fill="#e8e0c8"/><rect x="15" y="9" width="6" height="5" rx="1" fill="#e8e0c8"/>' +
  '<path d="M21 11 q6 1 6 7" stroke="#e8e0c8" stroke-width="2" fill="none"/></svg>';

export class Tactical {
  // sys = { R (GameRenderer), scene, world, level, player, enemies, coop, grenades, camera, audio, map, input }
  constructor(sys) {
    Object.assign(this, sys);
    this.half = 150;                 // the baked map covers -half..half metres in x and z
    this.mode = this._load('dustline.radar', 'fire'); // replaced by the mission's setting at deploy
    this.bigOpen = false;
    this.drawTimer = 0;
    this.spotCooldown = 0;
    this.onSpot = null;              // (enemy) co-op: tell the squad
    this.marks = new Map();          // enemy -> DOM marker
    this.mission = null;             // campaign/director.js, for objective markers (main.js sets it)
    this._buildDom();
    this._settingsUi();
  }

  _load(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } }

  _buildDom() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    const hud = document.getElementById('hud');
    this.box = document.createElement('div');
    this.box.id = 'mm';
    this.canvas = document.createElement('canvas');
    this.label = document.createElement('div');
    this.label.id = 'mm-label';
    this.box.append(this.canvas, this.label);
    hud.appendChild(this.box);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = this.canvas.height = Math.round(210 * dpr);
    this.ctx = this.canvas.getContext('2d');

    this.big = document.createElement('div');
    this.big.id = 'bigmap';
    this.big.classList.add('hidden');
    this.bigCanvas = document.createElement('canvas');
    this.bigCanvas.width = this.bigCanvas.height = 1100;
    this.big.appendChild(this.bigCanvas);
    hud.appendChild(this.big);

    this.layer = document.createElement('div'); // on-screen markers
    this.layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    hud.appendChild(this.layer);

    this.info = document.createElement('div');
    this.info.id = 'nade-info';
    hud.appendChild(this.info);
    this.spotMsg = document.createElement('div');
    this.spotMsg.id = 'spot-msg';
    hud.appendChild(this.spotMsg);

    this.warnEls = Array.from({ length: 4 }, () => {
      const el = document.createElement('div');
      el.className = 'nade-warn hidden';
      el.innerHTML = NADE_SVG;
      this.layer.appendChild(el);
      return el;
    });
  }

  // New key bindings in the menu (added from code so this module doesn't need
  // to edit index.html). The radar choice lives with the mission settings
  // (index.html #radar-mode and the lobby's #set-radar), not here.
  _settingsUi() {
    const controls = document.querySelector('.controls');
    if (controls && !controls.dataset.tactical) {
      controls.dataset.tactical = '1';
      controls.insertAdjacentHTML('beforeend', '<div><b>Z</b> prone (Space: get up)</div><div><b>Space</b> vault / climb at cover</div>' +
        '<div><b>G</b> lethal grenade (frag: hold to cook)</div><div><b>X</b> tactical grenade</div><div><b>T / MMB</b> spot enemy</div><div><b>M</b> tactical map</div>');
    }
  }

  // ------------------------------------------------------------------ the map photo
  // Render the whole level once from straight above into the visible canvas,
  // copy that square into a 2D canvas, and keep it as the map background.
  bake() {
    const R = this.R, r = R.renderer, scene = this.scene;
    const S = 1200, pr = r.getPixelRatio();
    const buf = r.getDrawingBufferSize(new THREE.Vector2());
    const px = Math.min(S, buf.x, buf.y);
    const cam = new THREE.OrthographicCamera(-this.half, this.half, this.half, -this.half, 1, 2000);
    cam.position.set(0, 900, 0);
    cam.up.set(0, 0, -1); // north (-z) at the top of the image
    cam.lookAt(0, 0, 0);
    // No fog from 900 m up; a shadow box big enough for the whole map
    const fog = scene.fog?.density;
    if (scene.fog) scene.fog.density = 0;
    const sc = R.sun.shadow.camera, saved = [sc.left, sc.right, sc.top, sc.bottom];
    Object.assign(sc, { left: -this.half * 1.2, right: this.half * 1.2, top: this.half * 1.2, bottom: -this.half * 1.2 });
    sc.updateProjectionMatrix();
    R.updateShadow(new THREE.Vector3());
    r.setRenderTarget(null);
    r.setScissorTest(true);
    r.setViewport(0, 0, px / pr, px / pr);
    r.setScissor(0, 0, px / pr, px / pr);
    r.clear();
    r.render(scene, cam);
    const img = document.createElement('canvas');
    img.width = img.height = S;
    const g = img.getContext('2d');
    g.drawImage(r.domElement, 0, buf.y - px, px, px, 0, 0, S, S);
    r.setScissorTest(false);
    r.setViewport(0, 0, buf.x / pr, buf.y / pr);
    Object.assign(sc, { left: saved[0], right: saved[1], top: saved[2], bottom: saved[3] });
    sc.updateProjectionMatrix();
    if (scene.fog) scene.fog.density = fog;

    // Military map look: slightly darker and cooler, with a 50 m grid
    g.fillStyle = 'rgba(10,16,12,0.28)';
    g.fillRect(0, 0, S, S);
    g.strokeStyle = 'rgba(220,230,210,0.16)';
    g.lineWidth = 1;
    for (let m = -this.half + 50; m < this.half; m += 50) {
      const p = this._px(m, S);
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    this.bg = img;
  }

  _px(m, size) { return ((m + this.half) / (2 * this.half)) * size; }

  // ------------------------------------------------------------------ radar rules
  _enemyShown(e, t) {
    if (!e.alive) return 0;
    const spotted = (e.spottedUntil || 0) > t;
    if (this.mode === 'off') return 0;
    if (this.mode === 'always') return 1;
    if (spotted) return 1;
    if (this.mode === 'fire') {
      const since = t - (e.lastFiredAt ?? -99);
      return since < RADAR.firedShowTime ? 1 - (since / RADAR.firedShowTime) ** 2 : 0;
    }
    return 0;
  }

  markSpotted(e) {
    if (!e?.alive) return;
    e.spottedUntil = now() + RADAR.spotTime;
  }

  // Spot the enemy closest to your crosshair. You only need to see PART of
  // him, like in real life: a head over a wall or a window ledge counts, a
  // man crouched fully behind cover doesn't. So we test three points on his
  // body (head, chest, hips), and they drop when he crouches.
  _spot() {
    const cam = this.camera, eye = cam.position;
    cam.getWorldDirection(_f);
    let best = null, bestAng = Infinity;
    for (const e of this.enemies.enemies) {
      if (!e.alive) continue;
      const dist = _v.set(e.pos.x, e.pos.y + 1.2, e.pos.z).distanceTo(eye);
      if (dist > RADAR.spotRange) continue;
      const cone = RADAR.spotCone + Math.min(0.08, 1.2 / dist); // a bit more forgiving up close
      const cr = e.crouch || 0;
      for (const h of [1.62 - 0.55 * cr, 1.3 - 0.45 * cr, 0.95 - 0.35 * cr]) { // head, chest, hips
        _v.set(e.pos.x, e.pos.y + h, e.pos.z);
        const ang = _d.subVectors(_v, eye).normalize().angleTo(_f);
        if (ang >= cone || ang >= bestAng) continue; // not near the crosshair, or someone closer to it already
        if (!this.world.lineOfSight(eye, _v) || this.world.smokeBlocks(eye, _v)) continue;
        best = e; bestAng = ang;
      }
    }
    if (!best) { this._spotText('NO TARGET', '#b8b4a8', 600); return; } // so you know the key worked
    this.markSpotted(best);
    this.audio.radio();
    this._spotText('ENEMY SPOTTED', '#ff8a7a', 900);
    this.onSpot?.(best);
  }

  _spotText(text, color, ms) {
    this.spotMsg.textContent = text;
    this.spotMsg.style.color = color;
    this.spotMsg.style.opacity = 1;
    clearTimeout(this._msgT);
    this._msgT = setTimeout(() => { this.spotMsg.style.opacity = 0; }, ms);
  }

  // ------------------------------------------------------------------ every frame
  update(dt, input, active) {
    const t = now();
    if (active) {
      if (input.wasPressed('KeyM')) { this.bigOpen = !this.bigOpen; this.big.classList.toggle('hidden', !this.bigOpen); }
      this.spotCooldown -= dt;
      if ((input.wasPressed('KeyT') || input.wasPressed('Mouse1')) && this.spotCooldown <= 0) { this.spotCooldown = 0.4; this._spot(); }
    } else if (this.bigOpen) { this.bigOpen = false; this.big.classList.add('hidden'); }

    this._screenMarkers(t);
    this._grenadeHud();
    if ((this.drawTimer -= dt) <= 0) { // 30 Hz is plenty for a map
      this.drawTimer = 1 / 30;
      this._drawMini(t);
      if (this.bigOpen) this._drawBig(t);
    }
  }

  _drawMini(t) {
    const g = this.ctx, W = this.canvas.width, p = this.player;
    const scale = W / (2 * RADAR.range); // px per metre
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#10140f';
    g.fillRect(0, 0, W, W);
    // world -> minimap: centre on you, rotate so you face up
    g.translate(W / 2, W / 2);
    g.rotate(p.yaw);
    g.translate(-p.pos.x * scale, -p.pos.z * scale);
    if (this.bg) g.drawImage(this.bg, -this.half * scale, -this.half * scale, 2 * this.half * scale, 2 * this.half * scale);
    this._drawMarkers(g, scale, t, W * 0.012, p.yaw);
    g.setTransform(1, 0, 0, 1, 0, 0);

    // view cone + your arrow
    const c = W / 2, s = W * 0.045;
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov) * this.camera.aspect * 0.5;
    const grad = g.createRadialGradient(c, c, 0, c, c, W * 0.45);
    grad.addColorStop(0, 'rgba(230,240,220,0.22)');
    grad.addColorStop(1, 'rgba(230,240,220,0)');
    g.fillStyle = grad;
    g.beginPath(); g.moveTo(c, c); g.arc(c, c, W * 0.45, -Math.PI / 2 - fovRad, -Math.PI / 2 + fovRad); g.closePath(); g.fill();
    g.fillStyle = '#f2f0e0';
    g.strokeStyle = '#000';
    g.lineWidth = Math.max(1, W / 210);
    g.beginPath(); g.moveTo(c, c - s); g.lineTo(c + s * 0.7, c + s * 0.8); g.lineTo(c, c + s * 0.35); g.lineTo(c - s * 0.7, c + s * 0.8); g.closePath();
    g.fill(); g.stroke();

    // north marker on the rim
    const na = -Math.PI / 2 + p.yaw, nr = W * 0.43;
    g.font = `bold ${Math.round(W * 0.06)}px ui-monospace, Menlo, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#c9b46a';
    g.fillText('N', c + Math.cos(na) * nr, c + Math.sin(na) * nr);
    this.label.textContent = `RADAR: ${MODES[this.mode].toUpperCase()}`;
  }

  // Draws everything that lives in world space. Icons are counter-rotated by
  // `spin` so they stay upright while the minimap turns.
  _drawMarkers(g, scale, t, dot, spin) {
    const at = (x, z) => [x * scale, z * scale];
    // ammo crates
    for (const c of this.level.ammoCrates || []) {
      const [x, y] = at(c.x, c.z);
      g.fillStyle = '#e0c040'; g.strokeStyle = '#000'; g.lineWidth = dot * 0.4;
      g.fillRect(x - dot, y - dot, dot * 2, dot * 2); g.strokeRect(x - dot, y - dot, dot * 2, dot * 2);
    }
    // squadmates (co-op)
    if (this.coop?.online) {
      for (const tm of this.coop.teammates.values()) {
        if (!tm.shown) continue;
        const [x, y] = at(tm.root.position.x, tm.root.position.z);
        g.fillStyle = tm.shownAlive ? '#5aa8ff' : '#6a7480';
        g.beginPath(); g.arc(x, y, dot * 1.25, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#000'; g.lineWidth = dot * 0.35; g.stroke();
      }
    }
    // enemies (radar rules)
    for (const e of this.enemies.enemies) {
      const a = this._enemyShown(e, t);
      if (a <= 0.02) continue;
      const [x, y] = at(e.pos.x, e.pos.z);
      const spotted = (e.spottedUntil || 0) > t;
      g.globalAlpha = a;
      g.fillStyle = '#ff3b2f';
      if (spotted) { // diamond
        g.save(); g.translate(x, y); g.rotate(-spin + Math.PI / 4);
        g.fillRect(-dot * 1.2, -dot * 1.2, dot * 2.4, dot * 2.4);
        g.strokeStyle = '#000'; g.lineWidth = dot * 0.35; g.strokeRect(-dot * 1.2, -dot * 1.2, dot * 2.4, dot * 2.4);
        g.restore();
      } else {
        g.beginPath(); g.arc(x, y, dot * 1.15, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
    }
    // live grenades
    const pulse = 0.6 + 0.4 * Math.sin(t * 12);
    for (const n of this.grenades.live) {
      const [x, y] = at(n.pos.x, n.pos.z);
      g.strokeStyle = `rgba(255,80,60,${pulse})`;
      g.lineWidth = dot * 0.5;
      g.beginPath(); g.arc(x, y, dot * 2.2, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#ffd0c0';
      g.beginPath(); g.arc(x, y, dot * 0.6, 0, Math.PI * 2); g.fill();
    }
    // campaign objectives (campaign/director.js): a ring round zones, then a diamond (gold = objective, blue = escort, red = target)
    for (const m of this.mission?.markers() || []) {
      const [x, y] = at(m.pos.x, m.pos.z);
      const col = m.kind === 'vip' ? '#6fb6ff' : m.kind === 'hvt' || m.kind === 'enemy' ? '#ff5a4a' : '#e8c547';
      if (m.r) { g.strokeStyle = 'rgba(232,197,71,0.55)'; g.lineWidth = dot * 0.4; g.beginPath(); g.arc(x, y, m.r * scale, 0, Math.PI * 2); g.stroke(); }
      g.save(); g.translate(x, y); g.rotate(-spin + Math.PI / 4);
      const s = dot * 1.5;
      g.fillStyle = col; g.fillRect(-s, -s, s * 2, s * 2);
      g.strokeStyle = '#000'; g.lineWidth = dot * 0.35; g.strokeRect(-s, -s, s * 2, s * 2);
      g.restore();
    }
    // the squad's claymores: a blue fan the size of the lethal zone (~10 m), pointing the way each one faces
    for (const m of this.grenades.mines || []) {
      const [x, y] = at(m.pos.x, m.pos.z), a = Math.atan2(m.dir.z, m.dir.x);
      g.fillStyle = 'rgba(90,168,255,0.35)';
      g.beginPath(); g.moveTo(x, y); g.arc(x, y, Math.max(dot * 3, 10 * scale), a - 0.55, a + 0.55); g.closePath(); g.fill();
      g.fillStyle = '#5aa8ff';
      g.beginPath(); g.arc(x, y, dot * 0.7, 0, Math.PI * 2); g.fill();
    }
  }

  _drawBig(t) {
    const g = this.bigCanvas.getContext('2d'), W = this.bigCanvas.width, p = this.player;
    const scale = W / (2 * this.half);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#10140f';
    g.fillRect(0, 0, W, W);
    g.translate(W / 2, W / 2);
    if (this.bg) g.drawImage(this.bg, -W / 2, -W / 2, W, W);
    this._drawMarkers(g, scale, t, W * 0.006, 0);
    // you
    const [x, y] = [p.pos.x * scale, p.pos.z * scale], s = W * 0.018;
    g.save(); g.translate(x, y); g.rotate(-p.yaw);
    g.fillStyle = '#f2f0e0'; g.strokeStyle = '#000'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.7, s * 0.8); g.lineTo(0, s * 0.35); g.lineTo(-s * 0.7, s * 0.8); g.closePath(); g.fill(); g.stroke();
    g.restore();
    // squad names
    if (this.coop?.online) {
      g.font = `${Math.round(W * 0.016)}px ui-monospace, Menlo, monospace`;
      g.fillStyle = '#a8d0ff'; g.textAlign = 'left';
      for (const tm of this.coop.teammates.values()) if (tm.shown) g.fillText(tm.name, tm.root.position.x * scale + 10, tm.root.position.z * scale - 8);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    // grid references for each 50 m square along the edges (A, B, C... across; 1, 2, 3... down)
    g.font = `bold ${Math.round(W * 0.018)}px ui-monospace, Menlo, monospace`;
    g.fillStyle = 'rgba(232,224,190,0.85)';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const cells = Math.round((2 * this.half) / 50);
    for (let i = 0; i < cells; i++) {
      const c = this._px(-this.half + 25 + i * 50, W);
      g.fillText(String.fromCharCode(65 + i), c, W * 0.02);
      g.fillText(String(i + 1), W * 0.015, c);
    }
    g.textAlign = 'left';
    g.fillText(`${this.map.name} — TACTICAL MAP`, W * 0.04, W * 0.965);
    g.textAlign = 'right';
    g.font = `${Math.round(W * 0.014)}px ui-monospace, Menlo, monospace`;
    g.fillText(`■ ammo   ● squad   ● enemy   ◆ spotted${this.mission?.live ? '   ◆ objective' : ''}   radar: ${MODES[this.mode].toLowerCase()}   [M] close`, W * 0.97, W * 0.965);
  }

  // Red diamonds over spotted enemies; grenade warning icons.
  _screenMarkers(t) {
    const cam = this.camera, w = window.innerWidth, h = window.innerHeight;
    for (const e of this.enemies.enemies) {
      const on = e.alive && (e.spottedUntil || 0) > t && !this.bigOpen;
      let el = this.marks.get(e);
      if (!on) { if (el) el.classList.add('hidden'); continue; }
      if (!el) {
        el = document.createElement('div');
        el.className = 'spot-mark';
        el.innerHTML = '<i></i><span></span>';
        this.layer.appendChild(el);
        this.marks.set(e, el);
      }
      _v.set(e.pos.x, e.pos.y + 2.1, e.pos.z);
      const dist = Math.round(_v.distanceTo(cam.position));
      _v.project(cam);
      const visible = _v.z < 1 && Math.abs(_v.x) < 1 && Math.abs(_v.y) < 1;
      el.classList.toggle('hidden', !visible);
      if (visible) {
        el.style.transform = `translate(${Math.round((_v.x * 0.5 + 0.5) * w)}px, ${Math.round((-_v.y * 0.5 + 0.5) * h)}px)`;
        el.lastChild.textContent = `${dist}m`;
      }
    }
    // forget markers for enemies that no longer exist
    for (const [e, el] of this.marks) if (!this.enemies.enemies.includes(e)) { el.remove(); this.marks.delete(e); }
  }

  _grenadeHud() {
    const cam = this.camera, p = this.player, w = window.innerWidth, h = window.innerHeight;
    const near = p.alive ? this.grenades.near(p.pos, 10).filter((g) => g.age > 0.4 || g.team !== 'player') : [];
    this.warnEls.forEach((el, i) => {
      const g = near[i];
      el.classList.toggle('hidden', !g);
      if (!g) return;
      _v.copy(g.pos).project(cam);
      let x = _v.x, y = _v.y;
      const behind = _v.z > 1;
      if (behind) { x = -x; y = -y; }
      const off = behind || Math.abs(x) > 0.9 || Math.abs(y) > 0.9;
      if (off) { // push to a ring around the crosshair, pointing at the grenade
        const a = Math.atan2(y, x);
        x = Math.cos(a) * 0.35 * (h / w);
        y = Math.sin(a) * 0.35;
      }
      el.classList.toggle('pulse', g.pos.distanceTo(p.pos) < 5);
      el.style.transform = `translate(${Math.round((x * 0.5 + 0.5) * w)}px, ${Math.round((-y * 0.5 + 0.5) * h)}px)`;
    });

    const gr = this.grenades;
    const stance = p.prone ? 'PRONE' : p.crouched ? 'CROUCHED' : 'STANDING';
    // "FRAG ×2 [G] · SMOKE ×1 [X]"; while one is in your hand, its fuse (if it's burning)
    const T = gr.types, key = gr.cookSlot === 'tactical' ? 'X' : 'G', left = gr.cookLeft;
    const nade = gr.cooking
      ? `<span class="cook">${T[gr.cookKind].label}${left !== null ? ` ${left.toFixed(1)}s` : ''} — RELEASE ${key}${T[gr.cookKind].placed ? ' TO PLANT' : ''}</span>`
      : `${T[gr.kit.lethal].label} <b>×${gr.counts.lethal}</b> [G] · ${T[gr.kit.tactical].label} <b>×${gr.counts.tactical}</b> [X]`;
    const html = `${nade}<br>${stance}`;
    if (html !== this._lastInfo) { this.info.innerHTML = html; this._lastInfo = html; }
  }
}

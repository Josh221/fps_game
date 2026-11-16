// =============================================================================
// armory.js — the loadout screen: pick a class, a gun, and mod it.
//
// Open it with the LOADOUT button on the main menu, in the co-op lobby, on the
// pause screen or after you die. Everything here edits ONE plain object, the
// loadout:
//
//   { cls: 'rifleman',
//     primary:   { id: 'rifle',  mods: { optic: 'reddot', muzzle: 'std', ... } },
//     secondary: { id: 'pistol', mods: { ... } },
//     lethal: 'frag', tactical: 'smoke', armor: 'light' }
//
// loadout.js turns that into real weapon stats (resolveLoadout) and gunsmith.js
// into 3D models. This file is only the UI: it never computes a stat itself,
// it asks loadout.js. That separation is why hovering an attachment can show
// exactly how it would change the gun — we just build the gun both ways and
// compare (see _statsHtml).
//
// The 3D preview uses its own small WebGLRenderer on its own canvas, so it can
// draw while the game renderer is busy with the menu backdrop.
//
// COSMETICS: the PAINT slots (finish, metal, reticle) change only how a gun
// looks, and each gun remembers its own paint job (this.paint). The SOLDIER
// tab edits a second plain object, your look (avatar.js), shown on the same
// animated soldier your squad sees in co-op.
// =============================================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ATTACHMENTS, SLOT_NAMES, COSMETIC, GUNS, EQUIPMENT, LETHAL_COUNT, TACTICAL_COUNT, CLASSES, normalizeLoadout, normalizeWeapon, classLoadout, buildWeapon, resolveLoadout, weaponStats, loadSaved, save, encodeWeapons } from './loadout.js';
import { buildGun } from './gunsmith.js';
import { AVATAR, AVATAR_SLOTS, DEFAULT_AVATAR, normalizeAvatar, encodeAvatar, randomAvatar, loadAvatar, saveAvatar } from './avatar.js';
import { PAINTS, swatchCss } from './paint.js';

// "2× Frag + 1× Smoke"
const nadesText = (L) => `${LETHAL_COUNT}× ${EQUIPMENT.lethal[L.lethal].name} + ${TACTICAL_COUNT}× ${EQUIPMENT.tactical[L.tactical].name}`;

const CSS = `
#armory { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column; color: var(--hud);
  background: #0b0d0a radial-gradient(ellipse at 50% 35%, #222a1e, #0b0d0a 75%); font-family: var(--sans); user-select: none; }
#armory.hidden { display: none; }
#armory button { font: bold 12px var(--sans); letter-spacing: 2px; padding: 8px 14px; }
.ar-head { display: flex; align-items: center; gap: 18px; padding: 14px 24px; border-bottom: 1px solid rgba(201,180,106,0.25); flex-wrap: wrap; }
.ar-head h2 { margin: 0; color: var(--accent); letter-spacing: 6px; font-size: 22px; }
.ar-classes { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; }
.ar-classes button { background: transparent; color: var(--hud-dim); border: 1px solid rgba(225,232,215,0.18); }
.ar-classes button.on { color: #11140f; background: var(--accent); border-color: var(--accent); }
.ar-classes .lbl { align-self: center; font: 11px var(--mono); color: var(--hud-dim); letter-spacing: 2px; margin-right: 4px; }
.ar-classes .custom { align-self: center; font: 11px var(--mono); color: var(--accent); letter-spacing: 2px; margin-left: 6px; }
.ar-body { flex: 1; display: grid; grid-template-columns: 230px minmax(0, 1fr) 320px; min-height: 0; }
.ar-nav { border-right: 1px solid rgba(201,180,106,0.15); padding: 14px 0; overflow-y: auto; }
.ar-nav h4 { margin: 14px 18px 6px; font: bold 11px var(--mono); letter-spacing: 3px; color: var(--accent); }
.ar-nav h4:first-child { margin-top: 0; }
.ar-nav button { display: block; width: 100%; text-align: left; background: transparent; color: var(--hud); border: 0; border-left: 3px solid transparent;
  padding: 8px 18px !important; letter-spacing: 1px !important; }
.ar-nav button small { display: block; font: 10px var(--mono); color: var(--hud-dim); letter-spacing: 1px; margin-top: 2px; font-weight: normal; }
.ar-nav button.on { border-left-color: var(--accent); background: rgba(201,180,106,0.12); color: var(--accent); }
.ar-nav button:hover { background: rgba(225,232,215,0.06); filter: none; }
.ar-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.ar-stage { position: relative; flex: 1; min-height: 200px; cursor: grab; }
.ar-stage:active { cursor: grabbing; }
.ar-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.ar-gunname { position: absolute; left: 22px; top: 16px; pointer-events: none; }
.ar-gunname b { display: block; font-size: 22px; letter-spacing: 4px; color: var(--hud); }
.ar-gunname span { font: 11px var(--mono); letter-spacing: 2px; color: var(--accent); }
.ar-hint { position: absolute; right: 18px; bottom: 10px; font: 10px var(--mono); color: var(--hud-dim); letter-spacing: 2px; pointer-events: none; }
.ar-slots { display: flex; gap: 4px; padding: 0 18px; flex-wrap: wrap; border-top: 1px solid rgba(201,180,106,0.15); }
.ar-slots button { background: transparent; color: var(--hud-dim); border: 0; border-bottom: 2px solid transparent; padding: 10px 10px 8px !important; text-align: left; }
.ar-slots button small { display: block; font: 10px var(--mono); letter-spacing: 1px; color: var(--hud); margin-top: 3px; font-weight: normal; max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ar-slots button.on { color: var(--accent); border-bottom-color: var(--accent); }
.ar-slots button:hover { filter: none; color: var(--hud); }
.ar-options { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 18px 18px; }
.ar-equip { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; padding: 12px 18px 18px; overflow-y: auto; }
.ar-equip h4 { grid-column: 1 / -1; margin: 6px 0 0; font: bold 11px var(--mono); letter-spacing: 3px; color: var(--accent); }
.ar-opt { flex: 1 1 150px; max-width: 230px; text-align: left; background: rgba(225,232,215,0.04) !important; color: var(--hud) !important; border: 1px solid rgba(225,232,215,0.14) !important;
  padding: 10px 12px !important; letter-spacing: 1px !important; display: flex; flex-direction: column; gap: 4px; }
.ar-opt.on { border-color: var(--accent) !important; background: rgba(201,180,106,0.13) !important; }
.ar-opt:hover { border-color: rgba(201,180,106,0.6) !important; filter: none !important; }
.ar-opt .nm { font-size: 12px; }
.ar-opt .ds { font: 10px/1.35 var(--sans); color: var(--hud-dim); letter-spacing: 0; font-weight: normal; }
.ar-opt .fx { font: 10px var(--mono); letter-spacing: 0; font-weight: normal; }
.ar-opt .sw { display: flex; gap: 3px; } .ar-opt .sw i { width: 22px; height: 12px; border: 1px solid rgba(255,255,255,0.15); }
.ar-opt .sw i.pat { width: 100%; height: 18px; }
.ar-sep { align-self: center; font: 10px var(--mono); letter-spacing: 2px; color: var(--accent); margin-left: 8px; padding: 0 4px 0 12px; border-left: 1px solid rgba(201,180,106,0.3); }
.ar-btns { display: flex; gap: 8px; margin: 16px 0 4px; }
.ar-btns button { flex: 1; }
.up { color: #8fd17a; } .dn { color: #e0715f; }
.ar-side { border-left: 1px solid rgba(201,180,106,0.15); padding: 18px 22px; overflow-y: auto; }
.ar-side h3 { margin: 0 0 4px; color: var(--accent); letter-spacing: 3px; font-size: 15px; }
.ar-side p { margin: 0 0 14px; color: var(--hud-dim); font-size: 12px; line-height: 1.45; }
.ar-stat { display: grid; grid-template-columns: 78px 1fr 34px; align-items: center; gap: 8px; margin: 6px 0; font: 11px var(--mono); }
.ar-stat .bar { position: relative; height: 6px; background: rgba(225,232,215,0.1); }
.ar-stat .bar i { position: absolute; top: 0; bottom: 0; left: 0; }
.ar-stat .bar .b { background: var(--hud); }
.ar-stat .bar .g { background: #8fd17a; } .ar-stat .bar .r { background: #e0715f; }
.ar-stat .v { text-align: right; }
.ar-nums { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; margin: 14px 0; font: 11px var(--mono); color: var(--hud-dim); }
.ar-nums b { color: var(--hud); font-weight: normal; float: right; }
.ar-kit { margin-top: 16px; padding-top: 12px; border-top: 1px solid rgba(201,180,106,0.2); font: 11px var(--mono); }
.ar-kit div { display: flex; justify-content: space-between; margin: 5px 0; color: var(--hud-dim); }
.ar-kit div b { color: var(--hud); font-weight: normal; }
.ar-kit .wbar { height: 6px; background: linear-gradient(90deg, #8fd17a, #c9b46a 55%, #e0715f); position: relative; margin: 8px 0 2px; opacity: 0.85; }
.ar-kit .wbar i { position: absolute; top: -3px; width: 2px; height: 12px; background: #fff; }
.ar-note { color: var(--accent) !important; font-size: 11px !important; margin-top: 14px !important; }
.ar-summary { margin: 4px 0 14px; display: flex; align-items: center; justify-content: center; gap: 12px; font: 11px var(--mono); color: var(--hud-dim); letter-spacing: 1px; }
.ar-summary b { color: var(--hud); font-weight: normal; }
@media (max-width: 1000px) {
  .ar-body { grid-template-columns: 1fr; overflow-y: auto; }
  .ar-nav { border-right: 0; display: flex; flex-wrap: wrap; padding: 8px; } .ar-nav h4 { display: none; } .ar-nav button { width: auto; }
  .ar-stage { min-height: 260px; } .ar-side { border-left: 0; }
}
`;

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PRIMARIES = Object.keys(GUNS).filter((id) => GUNS[id].slot === 'primary');
const SECONDARIES = Object.keys(GUNS).filter((id) => GUNS[id].slot === 'secondary');
const IDLE = { speed: 0, crouch: 0, prone: 0, aiming: 0, aimPitch: 0, deathT: -1, flinch: 0 }; // the soldier preview's pose

// Paint jobs, remembered per gun model (so the woodland carbine stays woodland)
const PAINT_KEY = 'dustline.paint';
function loadPaint() { try { const p = JSON.parse(localStorage.getItem(PAINT_KEY)); return p && typeof p === 'object' ? p : {}; } catch { return {}; } }
function savePaint(p) { try { localStorage.setItem(PAINT_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } }
const pickPaint = (w) => Object.fromEntries(COSMETIC.filter((k) => w.mods[k]).map((k) => [k, w.mods[k]]));

// The colour chip on an option card: the real camo pattern, or flat colours
function swatchHtml(a) {
  if (a.paint) return `<span class="sw"><i class="pat" style="background:${swatchCss(a.paint)}"></i></span>`;
  const cols = a.colors || (a.color !== undefined ? [a.color] : a.mirror !== undefined ? [a.mirror] : null);
  return cols ? `<span class="sw">${cols.map((c) => `<i style="background:${hex(c)}"></i>`).join('')}</span>` : '';
}

// A soft round shadow for the soldier to stand on
function floorShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.6)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class Armory {
  constructor(M, factory) {
    this.M = M;
    this.factory = factory;        // builds the soldier for the SOLDIER tab
    this.loadout = loadSaved();
    this.avatar = loadAvatar();    // your soldier's look (avatar.js)
    this.paint = loadPaint();      // each gun's paint job: { rifle: { camo, metal, reticle }, ... }
    for (const w of [this.loadout.primary, this.loadout.secondary]) this.paint[w.id] ??= pickPaint(w);
    this.onChange = null;          // (loadout) — main.js re-issues your kit
    this.onAvatar = null;          // () — your look changed: main.js redresses you
    this.canApplyNow = () => true; // false mid-mission: the change waits for a resupply/respawn
    this.isOpen = false;
    this.tab = 'primary';          // 'primary' | 'secondary' | 'equipment' | 'soldier'
    this.slot = 'optic';
    this.aslot = 'armour';         // the part of your look being edited
    this.hover = null;             // option under the mouse: previews its effect
    this._buildDom();
    this._injectButtons();
    this._refreshSummaries();
  }

  // ------------------------------------------------------------------ DOM
  _buildDom() {
    if (!document.getElementById('armory-css')) {
      const st = el('style'); st.id = 'armory-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    const root = this.root = el('div', 'hidden');
    root.id = 'armory';
    root.innerHTML = `
      <div class="ar-head"><h2>ARMORY</h2><div class="ar-classes"></div><button class="ar-done">DONE</button></div>
      <div class="ar-body">
        <nav class="ar-nav"></nav>
        <div class="ar-main">
          <div class="ar-stage"><canvas></canvas><div class="ar-gunname"></div><div class="ar-hint">DRAG TO ROTATE · SCROLL TO ZOOM · ESC TO CLOSE</div></div>
          <div class="ar-slots"></div>
          <div class="ar-options"></div>
        </div>
        <aside class="ar-side"></aside>
      </div>`;
    document.body.appendChild(root);
    this.$ = (s) => root.querySelector(s);
    this.optsEl = this.$('.ar-options'); // (its class switches between gun options and the equipment grid)
    this.$('.ar-done').onclick = () => this.close();
    addEventListener('keydown', (e) => { if (this.isOpen && e.code === 'Escape') { e.preventDefault(); this.close(); } });

    // drag to rotate the preview
    const stage = this.$('.ar-stage');
    this.view = { yaw: 0, pitch: 0.12, drag: false, idle: 0, zoom: 1 };
    stage.addEventListener('wheel', (e) => { e.preventDefault(); this.view.zoom = Math.max(0.35, Math.min(1.3, this.view.zoom * Math.exp(e.deltaY * 0.0012))); }, { passive: false });
    stage.addEventListener('pointerdown', (e) => { this.view.drag = true; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointerup', () => { this.view.drag = false; this.view.idle = 0; });
    stage.addEventListener('pointermove', (e) => {
      if (!this.view.drag) return;
      this.view.yaw += e.movementX * 0.008;
      this.view.pitch = Math.max(-0.6, Math.min(0.8, this.view.pitch + e.movementY * 0.006));
    });
  }

  // LOADOUT buttons on the menus (main menu, lobby, pause, death screen)
  _injectButtons() {
    this.summaries = [];
    const add = (anchorSel, where, cls = '') => {
      const anchor = document.querySelector(anchorSel);
      if (!anchor) return;
      const box = el('div', `ar-summary ${cls}`);
      const btn = el('button', 'ghost', 'LOADOUT');
      btn.onclick = () => this.open();
      const txt = el('span');
      box.append(btn, txt);
      anchor.insertAdjacentElement(where, box);
      this.summaries.push(txt);
    };
    add('#deploy', 'beforebegin');
    add('#lobby .lobby-actions', 'beforebegin');
    add('#paused .pause-actions', 'beforebegin');
    add('#dead .coop-row', 'beforebegin');
  }

  _refreshSummaries() {
    const L = this.loadout, cls = this._presetName();
    const p = GUNS[L.primary.id], s = GUNS[L.secondary.id];
    const tag = buildWeapon(L.primary).tag;
    const html = `<b>${cls}</b> · ${p.label}${tag ? ` (${tag})` : ''} · ${s.label} · ${nadesText(L)} · ${EQUIPMENT.armor[L.armor].name}`;
    for (const t of this.summaries) t.innerHTML = html;
  }

  // ------------------------------------------------------------------ open / close
  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.root.classList.remove('hidden');
    document.exitPointerLock?.();
    this._initPreview();
    this.render();
    this._loop();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.hover = null;
    this.root.classList.add('hidden');
    cancelAnimationFrame(this._raf);
  }

  // What other players see about your kit (co-op lobby list and scoreboard)
  // w: the guns you were actually issued (see markIssued), so squadmates can draw them
  // a: your look, so squadmates draw your soldier exactly as you dressed it
  get kitInfo() { return { cls: this._presetName(), gun: GUNS[this.loadout.primary.id]?.label || '', w: encodeWeapons(this.issued || this.loadout), a: encodeAvatar(this.avatar) }; }
  markIssued() { this.issued = clone(this.loadout); }

  // ------------------------------------------------------------------ editing
  // Which class this kit is (paint doesn't count: a woodland rifleman is still a rifleman)
  _presetName() {
    const bare = (w) => ({ id: w.id, mods: Object.fromEntries(Object.entries(w.mods).filter(([k]) => !COSMETIC.includes(k))) });
    const key = (L) => JSON.stringify({ ...L, cls: 0, primary: bare(L.primary), secondary: bare(L.secondary) });
    const mine = key(this.loadout);
    for (const [id, c] of Object.entries(CLASSES)) if (key(classLoadout(id)) === mine) return c.name;
    return 'Custom';
  }

  // Give a gun the paint job you last gave that model (if any)
  _repaint(w) {
    const p = this.paint[w.id];
    return p ? normalizeWeapon({ id: w.id, mods: { ...w.mods, ...p } }) : w;
  }

  _commit() {
    this.loadout = normalizeLoadout(this.loadout);
    save(this.loadout);
    this._refreshSummaries();
    this.onChange?.(this.loadout);
    this.render();
  }

  setClass(cls) {
    const L = classLoadout(cls);
    L.primary = this._repaint(L.primary);
    L.secondary = this._repaint(L.secondary);
    this.loadout = L;
    this.tab = 'primary';
    this._commit();
  }

  // Swap guns but keep any attachments the new gun also takes
  setGun(slot, id) {
    const old = this.loadout[slot];
    this.loadout[slot] = normalizeWeapon({ id, mods: id === old.id ? old.mods : { ...old.mods, optic: undefined, barrel: undefined, magazine: undefined, underbarrel: undefined } });
    if (id !== old.id && slot === 'primary') { // a new gun comes with a sensible optic for its role
      const preset = Object.values(CLASSES).find((c) => c.loadout.primary.id === id);
      if (preset) this.loadout[slot] = normalizeWeapon({ id, mods: { ...preset.loadout.primary.mods, ammo: old.mods.ammo } });
    }
    if (id !== old.id) this.loadout[slot] = this._repaint(this.loadout[slot]);
    this.tab = slot;
    if (!GUNS[id].allow[this.slot]) this.slot = 'optic';
    this._commit();
  }

  setMod(slot, part, choice) {
    const w = this.loadout[slot];
    w.mods[part] = choice;
    if (COSMETIC.includes(part)) { this.paint[w.id] = pickPaint(w); savePaint(this.paint); }
    this._commit();
  }

  // Your look: cosmetic only, so it never touches the loadout
  setLook(part, choice) { this._setAvatar({ ...this.avatar, [part]: choice }); }
  _setAvatar(a) {
    this.avatar = normalizeAvatar(a);
    saveAvatar(this.avatar);
    this.onAvatar?.(this.avatar);
    this.render();
  }
  setEquip(kind, id) { this.loadout[kind] = id; this._commit(); }

  // ------------------------------------------------------------------ drawing
  render() {
    if (!this.isOpen) return;
    this.hover = null; // the cards are rebuilt, so the one under the mouse never gets its mouseleave
    const L = this.loadout;
    // class presets
    const presetName = this._presetName();
    const classes = this.$('.ar-classes');
    classes.innerHTML = '<span class="lbl">CLASS</span>';
    for (const [id, c] of Object.entries(CLASSES)) {
      const b = el('button', c.name === presetName ? 'on' : '', c.name.toUpperCase());
      b.title = `Load the ${c.name} kit`;
      b.onclick = () => this.setClass(id);
      classes.appendChild(b);
    }
    if (presetName === 'Custom') classes.appendChild(el('span', 'custom', 'CUSTOM KIT'));

    // left: weapons and equipment
    const nav = this.$('.ar-nav');
    nav.innerHTML = '';
    const navBtn = (label, sub, on, fn) => { const b = el('button', on ? 'on' : '', `${label}<small>${sub}</small>`); b.onclick = fn; nav.appendChild(b); };
    nav.appendChild(el('h4', '', 'PRIMARY'));
    for (const id of PRIMARIES) navBtn(GUNS[id].label.toUpperCase(), GUNS[id].role, this.tab === 'primary' && L.primary.id === id, () => (L.primary.id === id ? (this.tab = 'primary', this.render()) : this.setGun('primary', id)));
    nav.appendChild(el('h4', '', 'SECONDARY'));
    for (const id of SECONDARIES) navBtn(GUNS[id].label.toUpperCase(), GUNS[id].role, this.tab === 'secondary' && L.secondary.id === id, () => (L.secondary.id === id ? (this.tab = 'secondary', this.render()) : this.setGun('secondary', id)));
    nav.appendChild(el('h4', '', 'EQUIPMENT'));
    navBtn('GRENADES & ARMOUR', `${nadesText(L)} · ${EQUIPMENT.armor[L.armor].name}`, this.tab === 'equipment', () => { this.tab = 'equipment'; this.render(); });
    nav.appendChild(el('h4', '', 'SOLDIER'));
    navBtn('APPEARANCE', `${PAINTS[this.avatar.armour].name} · ${PAINTS[this.avatar.uniform].name}`, this.tab === 'soldier', () => { this.tab = 'soldier'; this.render(); });

    if (this.tab === 'equipment') this._renderEquipment();
    else if (this.tab === 'soldier') this._renderSoldier();
    else this._renderGun();
    this._renderSide();
    this._updatePreview();
  }

  _renderGun() {
    const w = this.loadout[this.tab], gun = GUNS[w.id], cfg = buildWeapon(w);
    if (!gun.allow[this.slot]) this.slot = Object.keys(gun.allow)[0];
    this.$('.ar-gunname').innerHTML = `<b>${gun.label.toUpperCase()}</b><span>${gun.role.toUpperCase()}${cfg.tag ? ` · ${cfg.tag}` : ''}</span>`;
    const slots = this.$('.ar-slots');
    slots.innerHTML = '';
    slots.style.display = '';
    for (const part of Object.keys(gun.allow)) {
      if (part === COSMETIC[0]) slots.appendChild(el('span', 'ar-sep', 'PAINT')); // looks-only slots after this
      const b = el('button', part === this.slot ? 'on' : '', `${SLOT_NAMES[part].toUpperCase()}<small>${ATTACHMENTS[part][w.mods[part]].name}</small>`);
      b.onclick = () => { this.slot = part; this.render(); };
      slots.appendChild(b);
    }
    const opts = this.optsEl;
    opts.className = 'ar-options';
    opts.innerHTML = '';
    const base = weaponStats(cfg);
    for (const choice of gun.allow[this.slot]) {
      const a = ATTACHMENTS[this.slot][choice];
      const alt = buildWeapon({ id: w.id, mods: { ...w.mods, [this.slot]: choice } });
      const b = el('button', `ar-opt ${w.mods[this.slot] === choice ? 'on' : ''}`);
      let inner = `<span class="nm">${a.name}</span>`;
      inner += swatchHtml(a);
      if (a.desc) inner += `<span class="ds">${a.desc}</span>`;
      inner += `<span class="fx">${this._fx(base, weaponStats(alt), cfg, alt)}</span>`;
      b.innerHTML = inner;
      b.onclick = () => this.setMod(this.tab, this.slot, choice);
      b.onmouseenter = () => { this.hover = { slot: this.tab, part: this.slot, choice }; this._renderSide(); this._updatePreview(); };
      b.onmouseleave = () => { this.hover = null; this._renderSide(); this._updatePreview(); };
      opts.appendChild(b);
    }
  }

  // ------------------------------------------------------------------ soldier
  // Same layout as a gun: parts of your look along the bottom, choices below.
  _renderSoldier() {
    const a = this.avatar;
    if (!AVATAR[this.aslot]) this.aslot = AVATAR_SLOTS[0];
    const name = document.getElementById('callsign')?.value.trim() || 'Soldier';
    this.$('.ar-gunname').innerHTML = `<b>${esc(name.toUpperCase())}</b><span>YOUR SOLDIER · WHAT YOUR SQUAD SEES</span>`;
    const slots = this.$('.ar-slots');
    slots.innerHTML = '';
    slots.style.display = '';
    for (const k of AVATAR_SLOTS) {
      const b = el('button', k === this.aslot ? 'on' : '', `${AVATAR[k].name.toUpperCase()}<small>${AVATAR[k].options[a[k]].name}</small>`);
      b.onclick = () => { this.aslot = k; this.render(); };
      slots.appendChild(b);
    }
    const opts = this.optsEl;
    opts.className = 'ar-options';
    opts.innerHTML = '';
    for (const [id, o] of Object.entries(AVATAR[this.aslot].options)) {
      const b = el('button', `ar-opt ${a[this.aslot] === id ? 'on' : ''}`, `<span class="nm">${o.name}</span>${swatchHtml(o)}${o.desc ? `<span class="ds">${o.desc}</span>` : ''}`);
      b.onclick = () => this.setLook(this.aslot, id);
      b.onmouseenter = () => { this.hover = { look: this.aslot, choice: id }; this._updatePreview(); };
      b.onmouseleave = () => { this.hover = null; this._updatePreview(); };
      opts.appendChild(b);
    }
  }

  _renderSoldierSide() {
    const a = this.avatar, part = AVATAR[this.aslot];
    let html = `<h3>${part.name.toUpperCase()}</h3><p>${part.desc}</p><div class="ar-kit"><h3>YOUR LOOK</h3>`;
    for (const k of AVATAR_SLOTS) html += `<div>${AVATAR[k].name} <b>${AVATAR[k].options[a[k]].name}</b></div>`;
    html += '</div><div class="ar-btns"><button class="ghost ar-random">RANDOMISE</button><button class="ghost ar-reset">RESET</button></div>';
    html += '<p class="ar-note">Your squad sees this soldier in co-op, carrying the guns you picked. In first person you see your sleeves and gloves. Looks change straight away, even mid-mission.</p>';
    const side = this.$('.ar-side');
    side.innerHTML = html;
    side.querySelector('.ar-random').onclick = () => this._setAvatar(randomAvatar());
    side.querySelector('.ar-reset').onclick = () => this._setAvatar(DEFAULT_AVATAR);
  }

  // "+12 Control  −8 Handling": the biggest changes an option makes
  _fx(a, b, ca, cb) {
    const out = [];
    for (const k of Object.keys(a)) {
      const d = b[k] - a[k];
      if (Math.abs(d) >= 2) out.push([Math.abs(d), `<span class="${d > 0 ? 'up' : 'dn'}">${d > 0 ? '+' : '−'}${Math.abs(d)} ${k}</span>`]);
    }
    if (cb.magSize !== ca.magSize) out.push([99, `<span class="${cb.magSize > ca.magSize ? 'up' : 'dn'}">${cb.magSize} rds</span>`]);
    return out.sort((x, y) => y[0] - x[0]).slice(0, 3).map((x) => x[1]).join(' ');
  }

  _renderEquipment() {
    const L = this.loadout;
    this.$('.ar-gunname').innerHTML = `<b>${GUNS[L.primary.id].label.toUpperCase()}</b><span>YOUR PRIMARY</span>`;
    this.$('.ar-slots').style.display = 'none';
    const opts = this.optsEl;
    opts.className = 'ar-equip';
    opts.innerHTML = '';
    const group = (title, kind) => {
      opts.appendChild(el('h4', '', title));
      for (const [id, e] of Object.entries(EQUIPMENT[kind])) {
        const b = el('button', `ar-opt ${L[kind] === id ? 'on' : ''}`, `<span class="nm">${e.name}</span><span class="ds">${e.desc}</span><span class="fx">${e.weight ? `${e.weight} kg` : 'weightless'}</span>`);
        b.onclick = () => this.setEquip(kind, id);
        b.onmouseenter = () => { this.hover = { equip: kind, choice: id }; this._renderSide(); };
        b.onmouseleave = () => { this.hover = null; this._renderSide(); };
        opts.appendChild(b);
      }
    };
    group(`LETHAL GRENADES · CARRY ${LETHAL_COUNT} [G]`, 'lethal');
    group(`TACTICAL GRENADE · CARRY ${TACTICAL_COUNT} [X]`, 'tactical');
    group('BODY ARMOUR', 'armor');
  }

  // Right column: stats of the gun on show (with the hovered option's effect)
  // and your whole kit's weight.
  _renderSide() {
    if (this.tab === 'soldier') return this._renderSoldierSide();
    const side = this.$('.ar-side'), L = this.loadout, h = this.hover;
    const slot = this.tab === 'secondary' ? 'secondary' : 'primary';
    const w = L[slot], cfg = buildWeapon(w), gun = GUNS[w.id];
    let alt = null;
    if (h?.part && h.slot === slot) alt = buildWeapon({ id: w.id, mods: { ...w.mods, [h.part]: h.choice } });
    const s0 = weaponStats(cfg), s1 = alt ? weaponStats(alt) : s0;
    let html = `<h3>${gun.label.toUpperCase()}</h3><p>${gun.desc}</p>`;
    for (const k of Object.keys(s0)) {
      const a = s0[k], b = s1[k];
      const bar = b > a ? `<i class="b" style="width:${a}%"></i><i class="g" style="left:${a}%;width:${b - a}%"></i>`
        : b < a ? `<i class="b" style="width:${b}%"></i><i class="r" style="left:${b}%;width:${a - b}%"></i>` : `<i class="b" style="width:${a}%"></i>`;
      html += `<div class="ar-stat"><span>${k}</span><span class="bar">${bar}</span><span class="v ${b > a ? 'up' : b < a ? 'dn' : ''}">${b}</span></div>`;
    }
    const c = alt || cfg;
    const num = (label, v, base, fmt = (x) => x, lowerBetter = false) => {
      const better = lowerBetter ? v < base : v > base;
      const cls = alt && Math.abs(v - base) > 1e-6 ? (better ? 'up' : 'dn') : '';
      return `<div>${label}<b class="${cls}">${fmt(v)}</b></div>`;
    };
    html += '<div class="ar-nums">';
    html += num('Damage', c.damage, cfg.damage, (x) => Math.round(x));
    html += num('RPM', c.rpm, cfg.rpm, (x) => (c.base === 'bolt' ? 'bolt' : Math.round(x)));
    html += num('Magazine', c.magSize, cfg.magSize);
    html += num('Velocity', c.muzzleVelocity, cfg.muzzleVelocity, (x) => `${Math.round(x)} m/s`);
    html += num('Aim time', c.adsTime, cfg.adsTime, (x) => `${Math.round(x * 1000)} ms`, true);
    html += num('Reload', c.reloadTime, cfg.reloadTime, (x) => `${x.toFixed(1)} s`, true);
    // a variable scope shows its range ("3-12x"), compared by its top power
    const zoomTop = (o) => (o?.zoomSteps ? o.zoomSteps[o.zoomSteps.length - 1] : o?.zoom || 1);
    html += num('Zoom', zoomTop(c.optic), zoomTop(cfg.optic), () => (c.optic?.zoomSteps ? `${c.optic.zoomSteps[0]}-${zoomTop(c.optic)}x` : `${c.optic?.zoom || 1}x`));
    html += num('Weight', c.weight, cfg.weight, (x) => `${x.toFixed(1)} kg`, true);
    html += '</div>';

    // whole kit: weight -> speed and stamina
    const R = resolveLoadout(L);
    let alt2 = null;
    if (h?.equip) alt2 = resolveLoadout({ ...L, [h.equip]: h.choice });
    else if (alt) alt2 = resolveLoadout({ ...L, [slot]: { id: w.id, mods: { ...w.mods, [h.part]: h.choice } } });
    const K = alt2 || R;
    const arrow = (a, b, f, lowerBetter) => (alt2 && f(a) !== f(b) ? ` <span class="${(lowerBetter ? b < a : b > a) ? 'up' : 'dn'}">→ ${f(b)}</span>` : '');
    const pct = (x) => `${Math.round(x * 100)}%`;
    const pos = Math.max(0, Math.min(100, ((K.weight - 10) / 22) * 100));
    html += `<div class="ar-kit"><h3>KIT</h3>
      <div>Total weight <b>${R.weight.toFixed(1)} kg${arrow(R.weight, K.weight, (x) => `${x.toFixed(1)} kg`, true)}</b></div>
      <div class="wbar"><i style="left:${pos}%"></i></div>
      <div>Move speed <b>${pct(R.speedMul)}${arrow(R.speedMul, K.speedMul, pct)}</b></div>
      <div>Sprint stamina use <b>${pct(R.staminaMul)}${arrow(R.staminaMul, K.staminaMul, pct, true)}</b></div>
      <div>Torso damage taken <b>${pct(R.armor.torso)}${arrow(R.armor.torso, K.armor.torso, pct, true)}</b></div>
      <div>Grenades <b>${nadesText(K.loadout)}</b></div></div>`;
    if (!this.canApplyNow()) html += '<p class="ar-note">You\'re in a mission: your new kit is issued at the next ammo crate [F] or when you respawn.</p>';
    side.innerHTML = html;
  }

  // ------------------------------------------------------------------ 3D preview
  _initPreview() {
    if (this.renderer) return;
    const canvas = this.$('.ar-stage canvas');
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    r.setPixelRatio(Math.min(2, devicePixelRatio));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(r);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
    key.position.set(1.5, 2, 2.5);
    const rim = new THREE.DirectionalLight(0xbcd2ff, 1.4);
    rim.position.set(-2, 1, -2);
    this.scene.add(key, rim);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.model = null;
    this.modelKey = '';
    // The SOLDIER tab: a shadow to stand on (the soldier is made on the first visit)
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(0.7, 40), new THREE.MeshBasicMaterial({ map: floorShadow(), transparent: true, depthWrite: false }));
    this.floor.rotation.x = -Math.PI / 2;
    this.scene.add(this.floor);
    this.soldier = null;
  }

  // The soldier on show: your look (or the option under the mouse), holding your primary
  _updateSoldier() {
    if (!this.soldier) {
      this.soldier = this.factory.create();
      this.scene.add(this.soldier.root);
      this.soldierLook = this.soldierGun = '';
    }
    const look = { ...this.avatar };
    if (this.hover?.look) look[this.hover.look] = this.hover.choice;
    const key = encodeAvatar(look);
    if (key !== this.soldierLook) { this.soldierLook = key; this.soldier.setAvatar(look); }
    const gunKey = JSON.stringify(this.loadout.primary);
    if (gunKey !== this.soldierGun) {
      this.soldierGun = gunKey;
      const old = this.soldier.gun, cfg = buildWeapon(this.loadout.primary);
      const gun = buildGun(this.M, cfg, { hands: false });
      gun.kind = cfg.base === 'pistol' ? 'pistol' : 'long';
      this.soldier.setGun(gun);
      old.traverse((o) => o.geometry?.dispose());
    }
  }

  // Build the gun on show: the hovered option if any, else what you have
  _updatePreview() {
    if (!this.renderer) return;
    const soldier = this.tab === 'soldier';
    this.pivot.visible = !soldier;
    this.floor.visible = soldier;
    if (this.soldier) this.soldier.root.visible = soldier;
    if (soldier) { this._updateSoldier(); return; }
    const L = this.loadout, slot = this.tab === 'secondary' ? 'secondary' : 'primary';
    const w = clone(L[slot]);
    if (this.hover?.part && this.hover.slot === slot) w.mods[this.hover.part] = this.hover.choice;
    const key = JSON.stringify(w);
    if (key === this.modelKey) return;
    this.modelKey = key;
    if (this.model) {
      this.pivot.remove(this.model);
      this.model.traverse((o) => o.geometry?.dispose());
    }
    const built = buildGun(this.M, buildWeapon(w), { hands: false });
    const g = built.group;
    g.position.set(0, 0, 0);
    g.rotation.set(0, -Math.PI / 2, 0); // barrel to the right, right side facing you
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g), c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
    g.position.sub(c);
    const holder = new THREE.Group();
    holder.add(g);
    this.model = holder;
    this.pivot.add(holder);
    // Frame by the length of the gun with default parts, so the camera doesn't
    // jump when you fit a suppressor (you SEE the gun get longer instead)
    this._baseLen ??= {};
    if (!this._baseLen[w.id]) {
      const ref = buildGun(this.M, buildWeapon({ id: w.id }), { hands: false }).group;
      ref.updateMatrixWorld(true);
      this._baseLen[w.id] = new THREE.Box3().setFromObject(ref).getSize(new THREE.Vector3()).z;
      ref.traverse((o) => o.geometry?.dispose());
    }
    this.fitLen = Math.max(size.x, this._baseLen[w.id] * 1.2);
    this.fitH = size.y; // (a pistol is tall for its length: frame its height too)
  }

  _loop() {
    const tick = (now) => {
      if (!this.isOpen) return;
      this._raf = requestAnimationFrame(tick);
      const canvas = this.renderer.domElement, wpx = canvas.clientWidth, hpx = canvas.clientHeight;
      if (!wpx || !hpx) return;
      if (canvas.width !== Math.round(wpx * this.renderer.getPixelRatio()) || canvas.height !== Math.round(hpx * this.renderer.getPixelRatio())) {
        this.renderer.setSize(wpx, hpx, false);
        this.camera.aspect = wpx / hpx;
        this.camera.updateProjectionMatrix();
      }
      const v = this.view, dt = Math.min(0.05, (now - (this._last || now)) / 1000);
      this._last = now;
      if (!v.drag) v.idle += dt;
      const sway = v.idle > 2 ? Math.sin((v.idle - 2) * 0.35) * 0.45 : 0; // slow turntable when idle
      const soldierMode = this.tab === 'soldier' && this.soldier;
      // The room light flatters dark metal guns but washes out cloth: dim it for the soldier
      this.scene.environmentIntensity = soldierMode ? 0.4 : 1;
      this.renderer.toneMappingExposure = soldierMode ? 0.9 : 1.05;
      if (soldierMode) {
        // Face the camera, three-quarters on. Zooming in moves the view up to the head.
        this.soldier.root.rotation.y = Math.PI - 0.45 + v.yaw + sway;
        this.soldier.animate(dt, IDLE);
        const close = Math.min(1, Math.max(0, (1 - v.zoom) / 0.65)); // 0 = whole body .. 1 = head and shoulders
        const ty = 0.93 + close * 0.6;
        const dist = (0.98 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * Math.min(1.15, v.zoom) / Math.min(1, this.camera.aspect / 0.9);
        this.camera.position.set(0, ty + 0.1, dist);
        this.camera.lookAt(0, ty, 0);
        this.renderer.render(this.scene, this.camera);
        return;
      }
      this.pivot.rotation.set(v.pitch, v.yaw + sway - 0.35, 0, 'YXZ');
      // fit the gun's length to ~80% of the view width, and its height to ~65% of the view height
      const tanY = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)), tanX = tanY * this.camera.aspect;
      const fit = this.fitLen || 1;
      const dist = Math.max(fit / (1.9 * tanX), (fit * 0.27) / tanY, (this.fitH || 0) / (1.3 * tanY)) * v.zoom;
      this.camera.position.set(0, 0.04, dist);
      this.camera.lookAt(0, 0, 0);
      this.renderer.render(this.scene, this.camera);
    };
    this._last = 0;
    this._raf = requestAnimationFrame(tick);
  }
}

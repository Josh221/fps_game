// =============================================================================
// hud.js — the heads-up display, drawn with plain HTML/CSS on top of the 3D
// canvas. Cheap, crisp at any resolution, and easy to style.
// =============================================================================
const $ = (id) => document.getElementById(id);

// A blood splatter, painted once on a small canvas: a lumpy blob made of
// overlapping translucent circles (so it has darker and lighter patches),
// a spray of droplets thrown mostly one way, and a couple of drips running
// down. Used as a CSS background image (and only tilted a little on screen,
// so the drips still run downwards).
function paintSplat() {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const red = (a) => `rgba(${70 + Math.random() * 50 | 0},${Math.random() * 6 | 0},0,${a})`;
  const dot = (x, y, r, a) => { g.fillStyle = red(a); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
  const cx = S / 2, cy = S * 0.42;
  g.shadowColor = 'rgba(60,0,0,0.5)';
  g.shadowBlur = 5; // soft edges, like blood on a lens slightly out of focus
  for (let i = 0; i < 22; i++) { // main blob
    const a = Math.random() * Math.PI * 2, d = Math.random() ** 1.5 * 34;
    dot(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, 8 + Math.random() * 22, 0.18 + Math.random() * 0.25);
  }
  const dir = Math.random() * Math.PI * 2; // spray: droplets flung in one general direction
  for (let i = 0; i < 60; i++) {
    const a = dir + (Math.random() - 0.5) * (Math.random() < 0.7 ? 1.4 : 6), d = 34 + Math.random() ** 0.8 * 86;
    dot(cx + Math.cos(a) * d, cy + Math.sin(a) * d, Math.max(0.8, (1 - d / 125) * 5 * Math.random() + 0.6), 0.55 + Math.random() * 0.3);
  }
  for (let i = 0, n = 1 + (Math.random() * 3 | 0); i < n; i++) { // drips running down
    const x = cx + (Math.random() - 0.5) * 40, y0 = cy + 8, len = 30 + Math.random() * 70, w = 2 + Math.random() * 3;
    const grad = g.createLinearGradient(0, y0, 0, y0 + len);
    grad.addColorStop(0, 'rgba(95,0,0,0.6)'); grad.addColorStop(1, 'rgba(95,0,0,0.35)');
    g.fillStyle = grad;
    g.fillRect(x - w / 2, y0, w, len);
    dot(x, y0 + len, w * 0.8, 0.6); // the bead at the bottom of the run
  }
  return c.toDataURL();
}

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), vignette: $('vignette'), suppression: $('suppression'), hurtFlash: $('hurt-flash'), blood: $('blood'),
      compass: $('compass-strip'), objective: $('objective'), killfeed: $('killfeed'),
      crosshair: $('crosshair'), hitmarker: $('hitmarker'), damageDirs: $('damage-dirs'),
      prompt: $('prompt'), message: $('message'),
      hpFill: $('hp-fill'), hpNum: $('hp-num'), staFill: $('sta-fill'), bandages: $('bandages'),
      weaponName: $('weapon-name'), fireMode: $('fire-mode'), ammoMag: $('ammo-mag'), ammoRes: $('ammo-res'),
      fps: $('fps'), tags: $('tags'),
      chat: $('chat'), chatLog: $('chat-log'), chatInput: $('chat-input'), scoreboard: $('scoreboard'),
    };
    this._tags = new Map();
    this.hitT = 0;
    this.flash = 0;       // instant red flash when you're hit (fades in ~0.25 s)
    this.edge = 0;        // blood-red screen edges after a hit (fades over ~2 s)
    this.arrows = [];     // hit-direction arcs: { el, x, z, life }
    this._me = { x: 0, z: 0, yaw: 0 }; // where you are, for the arcs
    this._splats = null;  // painted on first hit
    this.suppress = 0;
    this.msgT = 0;
    this.fpsAcc = 0; this.fpsFrames = 0;
    this._buildCompass();
  }

  _buildCompass() {
    const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let rep = 0; rep < 3; rep++) {
      for (let d = 0; d < 360; d += 15) {
        html += names[d] ? `<span class="card">${names[d]}</span>` : `<span>${d}</span>`;
      }
    }
    this.el.compass.innerHTML = html;
  }

  show(v) { this.el.hud.classList.toggle('hidden', !v); }

  hitmarker(kill) {
    this.el.hitmarker.classList.toggle('kill', kill);
    this.hitT = kill ? 0.4 : 0.2;
  }

  // You got hit. from = world position it came from ({x, z}), or null when
  // there's no direction (a fall). Three layers of red:
  //  1. a quick full-screen flash (you KNOW you were hit), with the screen
  //     edges staying red for a couple of seconds,
  //  2. blood at the screen edge on the side the shot came from,
  //  3. an arc around the crosshair pointing at the shooter (it keeps
  //     pointing at them as you turn, so you can swing round onto them).
  damage(amount, from, kind = 'body') {
    const k = Math.min(1, amount / 35);
    this.flash = Math.min(0.9, this.flash + 0.3 + k * 0.5);
    this.edge = Math.min(1, this.edge + 0.35 + k * 0.6);
    const ang = from ? this._angleTo(from) : null;
    if (kind !== 'fall') this._splat(ang, k);
    if (from) this._arrow(from);
  }

  // Angle of a world point relative to where you're looking: 0 = straight
  // ahead (top of the screen), +PI/2 = to your right, PI = behind you.
  _angleTo(p) {
    const m = this._me;
    return -(Math.atan2(-(p.x - m.x), -(p.z - m.z)) - m.yaw);
  }

  _splat(ang, k) {
    this._splats ||= [0, 1, 2, 3, 4].map(paintSplat);
    const box = this.el.blood;
    if (!box) return;
    while (box.children.length >= 6) box.firstChild.remove();
    // Toward the side the shot came from (random edge if we don't know), pushed out to the edge.
    const a = (ang ?? Math.random() * Math.PI * 2) + (Math.random() - 0.5) * 0.7;
    const x = 50 + Math.sin(a) * 48, y = 50 - Math.cos(a) * 46, size = 26 + k * 26;
    const el = document.createElement('div');
    el.className = 'splat';
    el.style.cssText = `left:${x}%;top:${y}%;width:${size}vmin;height:${size}vmin;`
      + `background-image:url(${this._splats[(Math.random() * this._splats.length) | 0]});`
      + `transform:translate(-50%,-50%) rotate(${((Math.random() - 0.5) * 40) | 0}deg)`;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3600); // the CSS animation fades it out over 3.5 s
  }

  _arrow(from) {
    // Same shooter again (shots from within a few metres)? Refresh that arc rather than stacking another.
    let a = this.arrows.find((r) => Math.hypot(r.x - from.x, r.z - from.z) < 3);
    if (!a) {
      if (this.arrows.length >= 6) this.arrows.shift().el.remove();
      const el = document.createElement('div');
      el.className = 'arrow';
      this.el.damageDirs.appendChild(el);
      a = { el };
      this.arrows.push(a);
    }
    a.x = from.x; a.z = from.z; a.life = 2.4;
  }

  _updateDamage(dt, hp, alive) {
    const e = this.el;
    // The arcs swing round as you turn, and fade out
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      if ((a.life -= dt) <= 0) { a.el.remove(); this.arrows.splice(i, 1); continue; }
      a.el.style.transform = `rotate(${this._angleTo(a).toFixed(3)}rad)`;
      a.el.style.opacity = Math.min(1, a.life / 0.8).toFixed(2);
    }
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.edge = Math.max(0, this.edge - dt * 0.45);
    // Badly hurt: the edges stay red (more the lower you are) and pulse with
    // your heartbeat below 35 HP (same rate as the heartbeat you hear).
    const missing = alive ? Math.max(0, 1 - hp / 70) : 0;
    const bpm = 72 + Math.max(0, 35 - hp) * 2;
    const beat = alive && hp < 35 ? Math.max(0, Math.sin((performance.now() / 60000) * bpm * Math.PI * 2)) ** 3 : 0;
    const low = missing * 0.6 + beat * 0.25;
    this.style(e.vignette, 'opacity', Math.min(1, Math.max(this.edge, low)).toFixed(2));
    if (e.hurtFlash) this.style(e.hurtFlash, 'opacity', this.flash.toFixed(2));
  }

  suppressed(strength) { this.suppress = Math.min(1, this.suppress + strength); }

  killfeed(text, headshot) {
    const d = document.createElement('div');
    d.textContent = text;
    if (headshot) d.className = 'hs';
    this.el.killfeed.prepend(d);
    setTimeout(() => d.remove(), 5000);
  }

  // Co-op name tags over squadmates' heads. list = [{ id, name, dead, dist, visible, x, y }]
  // (screen pixels, worked out in coop.js). They show through walls, so you
  // always know where your squad is.
  tags(list) {
    const seen = new Set();
    for (const t of list) {
      seen.add(t.id);
      let el = this._tags.get(t.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'tag';
        this.el.tags.appendChild(el);
        this._tags.set(t.id, el);
      }
      const label = t.dead ? `✕ ${t.name}` : t.dist > 12 ? `${t.name} ${t.dist}m` : t.name;
      if (el._label !== label) { el.textContent = label; el._label = label; }
      if (el._dead !== t.dead) { el.classList.toggle('dead', t.dead); el._dead = t.dead; }
      if (el._talking !== !!t.talking) { el.classList.toggle('talking', !!t.talking); el._talking = !!t.talking; }
      el.style.display = t.visible ? '' : 'none';
      if (t.visible) el.style.transform = `translate(${t.x}px, ${t.y}px) translate(-50%, -100%)`;
    }
    for (const [id, el] of this._tags) if (!seen.has(id)) { el.remove(); this._tags.delete(id); }
  }

  // ---------------------------------------------------------------- chat
  // Lines fade out after a few seconds (CSS), but stay readable while the chat box is open.
  chatLine({ name, text, sys, me }) {
    const line = document.createElement('div');
    line.className = 'chat-line' + (sys ? ' sys' : '');
    if (!sys) {
      const who = document.createElement('b');
      who.className = me ? 'me' : '';
      who.textContent = `${name}: `;
      line.appendChild(who);
    }
    line.appendChild(document.createTextNode(text));
    this.el.chatLog.appendChild(line);
    while (this.el.chatLog.children.length > 8) this.el.chatLog.firstChild.remove();
  }

  get chatOpen() { return this.el.chat.classList.contains('open'); }

  openChat() {
    this.el.chat.classList.add('open');
    this.el.chatInput.value = '';
    this.el.chatInput.focus();
  }

  closeChat() {
    this.el.chat.classList.remove('open');
    this.el.chatInput.blur();
  }

  // ---------------------------------------------------------------- scoreboard (hold Tab)
  // rows = [{ name, cls, kills, deaths, headshots, ping, status, me, host }]
  scoreboard(show, title, rows) {
    const box = this.el.scoreboard;
    box.classList.toggle('hidden', !show);
    if (!show) return;
    const t = performance.now();
    if (t - (this._sbTime || 0) < 250) return; // 4 refreshes a second is plenty
    this._sbTime = t;
    const cell = (tag, text, cls) => { const c = document.createElement(tag); c.textContent = text; if (cls) c.className = cls; return c; };
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const h of ['SOLDIER', 'CLASS', 'KILLS', 'DEATHS', 'HEADSHOTS', 'PING', '']) head.appendChild(cell('th', h));
    table.appendChild(head);
    for (const r of rows) {
      const tr = document.createElement('tr');
      if (r.me) tr.className = 'me';
      tr.append(cell('td', r.name + (r.host ? ' ★' : '')), cell('td', r.cls || '–', 'cls'), cell('td', r.kills), cell('td', r.deaths), cell('td', r.headshots),
        cell('td', r.ping == null ? '–' : `${r.ping} ms`), cell('td', r.status, r.status === 'KIA' ? 'kia' : ''));
      table.appendChild(tr);
    }
    box.replaceChildren(cell('div', title, 'sb-title'), table);
  }

  message(text, seconds = 3) {
    this.el.message.innerHTML = text;
    this.el.message.style.opacity = 1;
    this.msgT = seconds;
  }

  // Touching the page (DOM) is slow compared with WebGL: every write can make
  // the browser redo style and layout work. So we only write a value when it
  // actually changed since last frame.
  _set(el, key, value, apply) {
    const k = el.id + key;
    if (this._last.get(k) === value) return;
    this._last.set(k, value);
    apply(value);
  }
  text(el, v) { this._set(el, 'text', v, (x) => { el.textContent = x; }); }
  html(el, v) { this._set(el, 'html', v, (x) => { el.innerHTML = x; }); }
  style(el, prop, v) { this._set(el, prop, v, (x) => { el.style[prop] = x; }); }
  cls(el, name, on) { this._set(el, 'c' + name, on, (x) => el.classList.toggle(name, x)); }

  update(dt, s) {
    const e = this.el;
    if (!this._last) this._last = new Map();
    // health / stamina
    const hp = Math.max(0, Math.round(s.health));
    this.style(e.hpFill, 'width', `${Math.min(100, hp)}%`);
    this.cls(e.hpFill, 'low', hp < 35);
    this.text(e.hpNum, String(hp));
    this.style(e.staFill, 'width', `${Math.round(s.stamina)}%`);
    this.text(e.bandages, s.bandaging ? `APPLYING BANDAGE… ${Math.ceil(s.bandageLeft)}s` : `BANDAGES ×${s.bandages}  [H]`);

    // weapon
    const w = s.weapon;
    this.text(e.weaponName, w.name);
    this.text(e.fireMode, w.mode);
    this.text(e.ammoMag, String(w.mag));
    this.cls(e.ammoMag, 'low', w.mag <= Math.max(3, w.magSize * 0.2));
    this.text(e.ammoRes, `/ ${w.reserve}`);

    // crosshair: hidden when aiming (you use the real sights), gap = spread in pixels
    const pxPerRad = (window.innerHeight / 2) / Math.tan((s.fov * Math.PI) / 360);
    this._set(e.crosshair, 'gap', Math.round(Math.max(3, w.spread * pxPerRad)), (g) => e.crosshair.style.setProperty('--gap', `${g}px`));
    this.style(e.crosshair, 'opacity', w.ads > 0.5 || s.sprinting ? '0' : '0.85');

    // compass: 15° per 40px, strip repeated 3× so it can scroll seamlessly
    const heading = ((-s.yaw * 180) / Math.PI % 360 + 360) % 360;
    const px = Math.round((210 - ((heading / 15) * 40 + 24 * 40) - 20) * 2) / 2;
    this.style(e.compass, 'transform', `translateX(${px}px)`);

    this.html(e.objective, s.objective);

    let prompt = '';
    if (s.prompt) prompt = s.prompt;
    else if (w.reloading) prompt = 'RELOADING';
    else if (w.mag === 0 && w.reserve > 0) prompt = '[R] RELOAD';
    else if (w.mag === 0) prompt = 'NO AMMO — [2] SIDEARM · AMMO CRATE · TAKE IT OFF THE FALLEN';
    this.text(e.prompt, prompt);

    // timed effects (opacities rounded so tiny changes don't count as "changed")
    if (this.hitT > 0) this.hitT -= dt;
    this.style(e.hitmarker, 'opacity', this.hitT > 0 ? '1' : '0');
    if (s.pos) { this._me.x = s.pos.x; this._me.z = s.pos.z; }
    this._me.yaw = s.yaw;
    this._updateDamage(dt, hp, s.alive !== false);
    this.suppress = Math.max(0, this.suppress - dt * 0.6);
    this.style(e.suppression, 'opacity', (this.suppress * 0.8).toFixed(2));
    if (this.msgT > 0 && (this.msgT -= dt) <= 0) e.message.style.opacity = 0;

    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      const scale = s.renderScale !== undefined && s.renderScale < 0.999 ? ` · ${Math.round(s.renderScale * 100)}% res` : '';
      e.fps.textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} FPS${s.halfRate ? ' (half rate)' : ''}${scale}`;
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
  }
}

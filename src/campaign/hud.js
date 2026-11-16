// =============================================================================
// campaign/hud.js — what a mission adds to the HUD:
//
//   markers     a diamond over each place you need to go or thing to use, with
//               its name and distance. Off screen, it slides to the edge of
//               the screen and points the way (like most modern shooters).
//   title card  "GHOST WALK / DAY 1 · 05:40 / Pinewood Ridge", typed out over
//               a fade from black as a mission starts.
//   banners     NEW OBJECTIVE / OBJECTIVE COMPLETE under the compass.
//
// The markers are DOM elements moved with CSS transforms, like the co-op name
// tags in hud.js: cheap, and always crisp.
// =============================================================================
import * as THREE from 'three';

const _v = new THREE.Vector3(), _c = new THREE.Vector3();
const ICON = { obj: '◆', zone: '◆', area: '◆', look: '◉', vip: '✚', hvt: '✖', enemy: '▼' };

export class CampaignHud {
  constructor(audio) {
    this.audio = audio;
    const hud = document.getElementById('hud');
    this.layer = document.createElement('div');
    this.layer.id = 'cm-marks';
    hud.appendChild(this.layer);
    this.pool = [];

    this.banner = document.createElement('div');
    this.banner.id = 'cm-banner';
    this.banner.innerHTML = '<div class="kind"></div><div class="text"></div>';
    hud.appendChild(this.banner);
    this.bannerT = 0;
    this.bannerQueue = [];

    // Over everything (not inside #hud, so it also covers the menus' backdrop)
    this.fade = document.createElement('div');
    this.fade.id = 'cm-fade';
    document.body.appendChild(this.fade);
    this.card = document.createElement('div');
    this.card.id = 'cm-card';
    document.body.appendChild(this.card);
    this.cardTimers = [];
  }

  // ------------------------------------------------------------------ markers
  // list = director.markers(): [{ pos, label, kind }]
  markers(list, camera, show) {
    const w = window.innerWidth, h = window.innerHeight;
    camera.getWorldDirection(_c);
    let n = 0;
    if (show) for (const m of list) {
      const el = this.pool[n] || this._mark();
      n++;
      const dist = Math.round(m.pos.distanceTo(camera.position));
      // Behind you, the projection flips: mirror it so the marker points the right way round
      const behind = _v.subVectors(m.pos, camera.position).dot(_c) < 0;
      _v.copy(m.pos).project(camera);
      let x = _v.x, y = _v.y;
      if (behind) { x = -x; y = -y; }
      // The box markers stay inside: clear of the bars, ammo and radio at the bottom
      const X = 0.9, TOP = 0.82, BOTTOM = -0.35;
      const off = behind || Math.abs(x) > X || y > TOP || y < BOTTOM;
      if (off) { // to the edge of that box, in the right direction
        if (behind && Math.hypot(x, y) < 0.05) y = BOTTOM; // straight behind you
        const k = 1 / Math.max(Math.abs(x) / X, y > 0 ? y / TOP : y / BOTTOM, 1e-6);
        x *= k; y *= k;
      }
      const px = Math.round((x * 0.5 + 0.5) * w), py = Math.round((-y * 0.5 + 0.5) * h);
      const key = `${m.kind}|${m.label}|${dist}|${off}`;
      if (el._key !== key) {
        el._key = key;
        el.className = `cm-mark ${m.kind}${off ? ' off' : ''}`;
        el.firstChild.textContent = ICON[m.kind] || '◆';
        el.children[1].textContent = m.label;
        el.children[2].textContent = `${dist} m`;
      }
      el.style.display = '';
      el.style.transform = `translate(${px}px, ${py}px)`;
      el.firstChild.style.transform = off ? `rotate(${Math.atan2(-y, x) * (180 / Math.PI) + 90}deg)` : '';
      if (off) el.firstChild.textContent = '▲';
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }

  _mark() {
    const el = document.createElement('div');
    el.className = 'cm-mark';
    el.innerHTML = '<i></i><b></b><span></span>';
    this.layer.appendChild(el);
    this.pool.push(el);
    return el;
  }

  // ------------------------------------------------------------------ banners
  announce(kind, text, seconds = 3.5) {
    this.bannerQueue.push({ kind, text, seconds });
  }

  update(dt) {
    if (this.bannerT > 0 && (this.bannerT -= dt) <= 0) this.banner.classList.remove('on');
    if (this.bannerT <= -0.35 && this.bannerQueue.length) {
      const b = this.bannerQueue.shift();
      this.banner.className = b.kind.includes('COMPLETE') || b.kind.includes('✓') ? 'done' : b.kind.includes('FAIL') ? 'fail' : '';
      this.banner.querySelector('.kind').textContent = b.kind;
      this.banner.querySelector('.text').textContent = b.text;
      void this.banner.offsetWidth; // restart the CSS transition
      this.banner.classList.add('on');
      this.bannerT = b.seconds;
      if (b.kind.includes('COMPLETE')) this._chime(true); else if (b.kind.includes('NEW')) this._chime(false);
    } else if (this.bannerT <= 0) this.bannerT -= dt;
  }

  clearBanners() { this.bannerQueue = []; this.bannerT = 0; this.banner.classList.remove('on'); }

  // Two soft tones: up for "done", a single blip for "new"
  _chime(done) {
    const a = this.audio;
    if (!a.ctx) return;
    const t = a.ctx.currentTime;
    a._tone(a.dry, t, { freq: done ? 660 : 520, dur: 0.12, gain: 0.05, type: 'triangle' });
    if (done) a._tone(a.dry, t + 0.12, { freq: 990, dur: 0.22, gain: 0.05, type: 'triangle' });
  }

  // ------------------------------------------------------------------ title card + fades
  // lines: ['GHOST WALK', 'DAY 1 · 05:40', 'Pinewood Ridge'] — typed out, one after another
  titleCard(lines, top = '') {
    for (const t of this.cardTimers) clearTimeout(t);
    this.cardTimers = [];
    this.card.innerHTML = `${top ? `<div class="top">${top}</div>` : ''}${lines.map((_, i) => `<div class="l${i}"></div>`).join('')}`;
    this.card.classList.add('on');
    let delay = 600;
    lines.forEach((text, i) => {
      const el = this.card.querySelector(`.l${i}`);
      for (let k = 1; k <= text.length; k++) this.cardTimers.push(setTimeout(() => { el.textContent = text.slice(0, k); }, delay + k * 38));
      delay += text.length * 38 + 350;
    });
    this.cardTimers.push(setTimeout(() => this.card.classList.remove('on'), delay + 3200));
  }

  hideCard() { for (const t of this.cardTimers) clearTimeout(t); this.card.classList.remove('on'); }

  // From black to the game over `seconds`
  fadeIn(seconds = 2.5) {
    this.fade.style.transition = 'none';
    this.fade.style.opacity = 1;
    void this.fade.offsetWidth;
    this.fade.style.transition = `opacity ${seconds}s ease-in`;
    this.fade.style.opacity = 0;
  }
}

// =============================================================================
// scope.js — the view through a magnified optic (3x prism, 3-12x sniper scope).
//
// Games don't render the inside of a real scope tube. When you're fully aimed
// in, they hide the gun, narrow the camera's field of view (that IS the zoom)
// and lay a flat picture over the screen: a black mask with a round hole and
// a reticle. weapon.js already narrows the FOV (and turns the sniper scope's
// zoom ring when you scroll); this file draws the picture.
//
// The mil-dot reticle stays the same size at every power, like most hunting
// and sniper scopes ("second focal plane"). On a "first focal plane" scope it
// would grow and shrink with the zoom instead.
//
// Two touches that make it read as a real scope:
//   - "scope shadow": the black ring slides a little as the gun sways or you
//     move, like when your eye isn't perfectly behind the eyepiece. The
//     reticle stays dead centre, because that's where the bullet goes.
//   - the lens darkens towards its edge (vignetting)
// =============================================================================
import { ATTACHMENTS } from './loadout.js';

const CSS = `
#scope { position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
#scope .tube { position: absolute; width: 96vmin; height: 96vmin; border-radius: 50%;
  box-shadow: 0 0 0 200vmax #000, inset 0 0 6vmin 3vmin rgba(0,0,0,0.95);
  background: radial-gradient(circle closest-side, transparent 72%, rgba(0,0,0,0.55) 96%, #000 100%); }
#scope svg { position: absolute; width: 96vmin; height: 96vmin; overflow: visible; }
#scope .mag { position: absolute; left: calc(50% + 35vmin); top: calc(50% + 35vmin); font: 600 2vmin/1.3 var(--mono, monospace);
  letter-spacing: 0.08em; color: #d9d3bf; opacity: 0.5; transition: opacity 0.6s; white-space: nowrap; }
#scope .mag.hot { opacity: 1; transition: none; }
#scope .mag small { display: block; font-size: 1.25vmin; font-weight: 400; letter-spacing: 0.12em; opacity: 0.75; }
`;
const HINT_KEY = 'dustline.zoomHintDone';

const NS = 'http://www.w3.org/2000/svg';

// Reticles drawn in a 200x200 box centred on (0,0). lit: CSS colour of the
// illuminated part (your Reticle paint choice); the black wires never change.
function reticle(type, lit = '#ff3b1f') {
  if (type === 'mildot') { // classic sniper mil-dot: thin wires, thick posts, dots every "mil"
    let s = '<g stroke="#050505" fill="#050505">';
    s += '<line x1="-62" y1="0" x2="62" y2="0" stroke-width="0.35"/><line x1="0" y1="-62" x2="0" y2="62" stroke-width="0.35"/>';
    for (const [x1, y1, x2, y2] of [[-100, 0, -62, 0], [62, 0, 100, 0], [0, 62, 0, 100], [0, -100, 0, -62]]) s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke-width="2.4"/>`;
    for (let i = 1; i <= 5; i++) {
      const d = i * 10;
      for (const [x, y] of [[d, 0], [-d, 0], [0, d], [0, -d]]) s += `<ellipse cx="${x}" cy="${y}" rx="${x ? 0.55 : 0.9}" ry="${x ? 0.9 : 0.55}"/>`;
    }
    return s + '</g>';
  }
  // 3x prism: lit red chevron with bullet-drop marks below it, and a thick black rim
  let s = '<circle r="99" fill="none" stroke="#000" stroke-width="7"/>';
  s += '<g stroke="#0a0a0a" stroke-width="0.55"><line x1="0" y1="7" x2="0" y2="46"/>';
  [[14, 7], [22, 5.5], [30, 4.5], [38, 3.5], [46, 2.5]].forEach(([y, w]) => { s += `<line x1="${-w}" y1="${y}" x2="${w}" y2="${y}"/>`; });
  s += '<line x1="-96" y1="0" x2="-40" y2="0" stroke-width="1.2"/><line x1="40" y1="0" x2="96" y2="0" stroke-width="1.2"/></g>';
  s += `<path d="M -5.5 6.5 L 0 0 L 5.5 6.5" fill="none" stroke="${lit}" stroke-width="1.3" stroke-linejoin="miter" style="filter: drop-shadow(0 0 1.5px ${lit})"/>`;
  return s;
}

export class ScopeOverlay {
  constructor() {
    if (!document.getElementById('scope-css')) {
      const st = document.createElement('style');
      st.id = 'scope-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.id = 'scope';
    this.tube = document.createElement('div');
    this.tube.className = 'tube';
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '-100 -100 200 200');
    // Magnification readout for variable scopes. It sits in the black mask
    // (bottom right of the lens), so it never covers what you're aiming at.
    this.mag = document.createElement('div');
    this.mag.className = 'mag';
    this.el.append(this.tube, this.svg, this.mag);
    // Inside #game so it sits under the HUD text but over the 3D view
    (document.getElementById('game') || document.body).appendChild(this.el);
    this.type = null;
    this.op = -1;
    this.ox = 0; this.oy = 0;
    this.shownZoom = null;  // the power the readout shows
    this.hotT = 0;          // seconds the readout stays bright after a change
    try { this.hintDone = localStorage.getItem(HINT_KEY) === '1'; } catch { this.hintDone = false; }
  }

  // "8x" plus, until you've zoomed once, a reminder that the wheel zooms
  _updateReadout(dt, st) {
    const steps = st.cfg.optic.zoomSteps;
    if (!steps) { if (this.shownZoom !== null) { this.mag.textContent = ''; this.shownZoom = null; } return; }
    if (st.zoom !== this.shownZoom) {
      if (this.shownZoom !== null && this.op > 0 && !this.hintDone) { // you've found the zoom: stop hinting
        this.hintDone = true;
        try { localStorage.setItem(HINT_KEY, '1'); } catch { /* storage unavailable */ }
      }
      if (this.shownZoom !== null) this.hotT = 1.2;
      this.shownZoom = st.zoom;
      this.mag.innerHTML = `${st.zoom}x<small>${this.hintDone ? `${steps[0]}-${steps[steps.length - 1]}x` : 'SCROLL TO ZOOM'}</small>`;
    }
    this.hotT -= dt;
    this.mag.classList.toggle('hot', this.hotT > 0);
  }

  // weapons: WeaponSystem, vm: ViewModel, player: Player
  update(dt, weapons, vm, player, visible) {
    const st = weapons.cur, cfg = st.cfg, zoom = cfg.optic?.zoom || 1;
    const on = visible && zoom > 1 && player.alive;
    const op = on ? Math.min(1, Math.max(0, (weapons.ads - 0.7) / 0.15)) : 0;
    if (op !== this.op) { this.el.style.opacity = op.toFixed(3); this.op = op; }
    if (op <= 0) return;
    this._updateReadout(dt, st);
    const type = cfg.optic.reticle || 'chevron', key = `${type}:${cfg.reticle}`;
    if (key !== this.type) {
      const lit = ATTACHMENTS.reticle[cfg.reticle]?.colors[0] ?? 0xff3b1f;
      this.svg.innerHTML = reticle(type, `#${lit.toString(16).padStart(6, '0')}`);
      this.type = key;
    }
    // scope shadow: follow the gun's sway and your movement. Turned up high, a
    // real scope's exit pupil shrinks and your eye has to be more exactly
    // behind it, so the shadow gets touchier as you zoom in.
    const eye = Math.sqrt(st.zoomNow / zoom), lim = 4 * eye; // 1 at the optic's starting power
    const move = Math.min(1, player.horizontalSpeed / 4);
    const tx = Math.max(-lim, Math.min(lim, vm.swayX * 70 * eye)) + Math.sin(vm.time * 7) * move * 1.6 * eye;
    const ty = Math.max(-lim, Math.min(lim, -vm.swayY * 70 * eye)) + Math.abs(Math.cos(vm.time * 7)) * move * 1.8 * eye;
    this.ox += (tx - this.ox) * Math.min(1, dt * 12);
    this.oy += (ty - this.oy) * Math.min(1, dt * 12);
    this.tube.style.transform = `translate(${this.ox.toFixed(2)}vmin, ${this.oy.toFixed(2)}vmin)`;
  }
}

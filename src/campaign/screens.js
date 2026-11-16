// =============================================================================
// campaign/screens.js — the campaign's menus: the mission list on the main
// menu, the BRIEFING before a mission (with a tactical map), the DEBRIEF after
// it, and your progress (saved in this browser).
//
// Missions unlock in order. Each one earns 1 star for finishing and 1 more
// for each bonus goal; your best result is kept. In co-op everyone in the
// squad gets the credit, so friends unlock missions by playing with you.
// =============================================================================
import { MISSIONS, CAMPAIGN, CAST, missionIndex } from './story.js';
import { getMap } from '../maps/index.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const KEY = 'dustline.campaign';
const stars = (n, of = 3) => '★'.repeat(n) + '☆'.repeat(Math.max(0, of - n));
const clock = (s) => `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`;

// ---------------------------------------------------------------- progress
export function loadProgress() {
  try { const p = JSON.parse(localStorage.getItem(KEY)); return p && typeof p.done === 'object' ? p : { done: {} }; } catch { return { done: {} }; }
}

// Keep the best: most stars, and fastest time
export function saveResult(r) {
  const p = loadProgress();
  const old = p.done[r.id];
  p.done[r.id] = { stars: Math.max(old?.stars || 0, r.stars), best: Math.min(old?.best ?? Infinity, Math.round(r.time)) };
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
  return p;
}

// Mission i is open once the one before it is done (the first is always open)
export const unlocked = (i, p = loadProgress()) => i <= 0 || !!p.done[MISSIONS[i - 1]?.id];
export const nextMission = (id) => MISSIONS[missionIndex(id) + 1] || null;
export const maxStars = (m) => 1 + m.bonus.length;

// ---------------------------------------------------------------- main menu: the mission list
export function renderMissionList(box, selectedId, onPick) {
  const p = loadProgress();
  box.replaceChildren();
  MISSIONS.forEach((m, i) => {
    const open = unlocked(i, p), done = p.done[m.id];
    const b = el('button', `mission-card${m.id === selectedId ? ' active' : ''}${open ? '' : ' locked'}`);
    b.append(el('span', 'num', String(i + 1).padStart(2, '0')));
    const mid = el('span', 'mid');
    mid.append(el('b', '', m.title), el('span', 'meta', `${getMap(m.map).name} · ${m.time}`), el('span', 'blurb', open ? m.blurb : 'Locked: finish the mission before it.'));
    b.append(mid);
    b.append(el('span', `stars${done ? ' got' : ''}`, done ? stars(done.stars, maxStars(m)) : open ? 'NEW' : '🔒'));
    b.disabled = !open;
    b.title = open ? m.blurb : 'Finish the mission before this one to unlock it';
    b.onclick = () => onPick(m);
    box.append(b);
  });
}

export const campaignIntro = () => CAMPAIGN.intro;

// ---------------------------------------------------------------- briefing
// opts = { bg (the minimap's baked top-down photo), coop, isHost, canDeploy }
export function renderBriefing(m, opts = {}) {
  const i = missionIndex(m.id);
  $('brief-op').textContent = `${CAMPAIGN.title} · MISSION ${i + 1} OF ${MISSIONS.length}`;
  $('brief-title').textContent = m.title;
  $('brief-meta').textContent = `${m.time} · ${m.place}`;
  const text = $('brief-text');
  text.replaceChildren();
  const section = (title, node) => { text.append(el('h3', '', title), node); };
  section('SITUATION', el('p', '', m.briefing.situation));
  section('MISSION', el('p', '', m.briefing.mission));
  const ol = el('ol');
  for (const o of m.objectives) ol.append(el('li', '', o.text));
  section('OBJECTIVES', ol);
  const bonus = el('ul', 'bonus');
  const best = loadProgress().done[m.id];
  for (const b of m.bonus) bonus.append(el('li', '', b.text));
  section(`BONUS GOALS${best ? ` · BEST ${stars(best.stars, maxStars(m))}` : ''}`, bonus);
  const notes = el('ul');
  for (const n of m.briefing.notes) notes.append(el('li', '', n));
  section('NOTES', notes);
  const who = new Set(Object.values(m.radio).flat().map(([w]) => w));
  section('ON THE RADIO', el('p', 'cast', [...who].map((w) => `${w}: ${CAST[w]?.name}, ${CAST[w]?.role}`).join(' · ')));
  drawMissionMap($('brief-map'), m, opts.bg);
  $('brief-go').textContent = opts.coop ? 'BACK TO LOBBY' : 'DEPLOY';
  $('brief-back').classList.toggle('hidden', !!opts.coop);
  $('brief-voice').classList.toggle('hidden', !opts.coop);
}

// The mission on the map: where you start, each numbered objective, and the
// enemy positions intelligence already knows about (the groups there at the start).
export function drawMissionMap(canvas, m, bg) {
  const g = canvas.getContext('2d'), W = canvas.width, HALF = 150;
  const pts = [], add = (x, z, kind, label) => {
    const same = kind === 'obj' && pts.find((p) => p.kind === 'obj' && Math.hypot(p.x - x, p.z - z) < 4); // two objectives in one place: "2·3"
    if (same) same.label += `·${label}`; else pts.push({ x, z, kind, label });
  };
  add(m.start[0], m.start[1], 'start', 'START');
  const groupCentre = (names) => {
    const list = names.flatMap((n) => m.groups[n] || []);
    return list.length ? [list.reduce((a, s) => a + s.x, 0) / list.length, list.reduce((a, s) => a + s.z, 0) / list.length] : null;
  };
  const siteAt = (s) => (s.at ? s.at : s.prop ? m.props?.find((p) => p.id === s.prop)?.at : s.on === 'vip' ? m.vip?.at
    : (() => { const h = Object.values(m.groups).flat().find((x) => x.hvt?.key === s.on); return h ? [h.to?.[0] ?? h.x, h.to?.[1] ?? h.z] : null; })());
  m.objectives.forEach((o, i) => {
    const n = String(i + 1);
    let at = null;
    if (o.type === 'goto' || o.type === 'hold') at = o.at;
    else if (o.type === 'escort') at = o.to;
    else if (o.type === 'use') at = siteAt(o.sites[0]);
    else if (o.type === 'clear') at = groupCentre(o.groups);
    else if (o.type === 'hvt') { const h = (m.groups[o.target] || []).find((s) => s.hvt); at = h ? [h.to?.[0] ?? h.x, h.to?.[1] ?? h.z] : null; }
    else if (o.type === 'observe') o.targets.forEach((t, k) => add(t.at[0], t.at[1], 'obj', `${n}${'abc'[k]}`));
    if (at) add(at[0], at[1], 'obj', n);
  });
  const known = new Set((m.begin || []).filter((a) => a.spawn).map((a) => a.spawn));
  const enemies = Object.entries(m.groups).filter(([name]) => known.has(name)).flatMap(([, list]) => list);

  // Frame the area that matters
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of [...pts, ...enemies]) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const half = Math.min(HALF, Math.max(45, (Math.max(x1 - x0, z1 - z0) / 2) + 22));
  const ox = Math.max(-HALF + half, Math.min(HALF - half, cx)), oz = Math.max(-HALF + half, Math.min(HALF - half, cz));
  const sx = (x) => ((x - (ox - half)) / (2 * half)) * W, sz = (z) => ((z - (oz - half)) / (2 * half)) * W;

  g.fillStyle = '#10140f';
  g.fillRect(0, 0, W, W);
  if (bg) {
    const S = bg.width, k = S / (2 * HALF);
    g.drawImage(bg, (ox - half + HALF) * k, (oz - half + HALF) * k, 2 * half * k, 2 * half * k, 0, 0, W, W);
  }
  // known enemy positions: small red crosses
  g.strokeStyle = 'rgba(255,80,60,0.85)'; g.lineWidth = 2;
  for (const s of enemies) {
    const x = sx(s.x), y = sz(s.z), r = 4;
    g.beginPath(); g.moveTo(x - r, y - r); g.lineTo(x + r, y + r); g.moveTo(x + r, y - r); g.lineTo(x - r, y + r); g.stroke();
  }
  // a dashed route through the objectives
  g.setLineDash([6, 6]); g.strokeStyle = 'rgba(232,197,71,0.7)'; g.lineWidth = 2;
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(sx(p.x), sz(p.z)) : g.moveTo(sx(p.x), sz(p.z))));
  g.stroke(); g.setLineDash([]);
  g.font = 'bold 13px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const p of pts) {
    const x = sx(p.x), y = sz(p.z);
    if (p.kind === 'start') {
      g.fillStyle = '#5aa8ff'; g.beginPath(); g.moveTo(x, y - 9); g.lineTo(x + 8, y + 7); g.lineTo(x - 8, y + 7); g.closePath(); g.fill();
      g.fillStyle = '#cfe4ff'; g.fillText('START', x, y + 18);
    } else {
      const r = Math.max(11, p.label.length * 4.4);
      g.fillStyle = 'rgba(16,20,15,0.85)'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#e8c547'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#e8c547'; g.fillText(p.label, x, y + 1);
    }
  }
  // scale bar + north
  const m50 = (50 / (2 * half)) * W;
  g.fillStyle = 'rgba(232,224,190,0.9)'; g.fillRect(14, W - 18, m50, 3);
  g.textAlign = 'left'; g.font = '11px ui-monospace, Menlo, monospace'; g.fillText('50 m', 14, W - 28);
  g.textAlign = 'right'; g.fillText('N ▲', W - 12, 16);
}

// ---------------------------------------------------------------- debrief
// r = director.result(); stats = { kills, acc, deaths }
export function renderDebrief(r, stats, { coop = false } = {}) {
  const i = missionIndex(r.id), last = i === MISSIONS.length - 1, m = MISSIONS[i];
  $('debrief-op').textContent = `${CAMPAIGN.title} · MISSION ${i + 1} OF ${MISSIONS.length} · ${r.title}`;
  $('debrief-title').textContent = last ? 'CAMPAIGN COMPLETE' : 'MISSION ACCOMPLISHED';
  $('debrief-stars').textContent = stars(r.stars, maxStars(m));
  const ul = $('debrief-bonus');
  ul.replaceChildren(el('li', 'ok', '✓ Mission complete'), ...r.list.map((b) => el('li', b.ok ? 'ok' : 'no', `${b.ok ? '✓' : '✕'} ${b.text}`)));
  $('debrief-stats').textContent = `Time ${clock(r.time)} · Hostiles killed ${stats.kills} · Accuracy ${stats.acc}%`;
  $('debrief-text').textContent = r.debrief;
  const next = MISSIONS[i + 1];
  $('debrief-next').classList.toggle('hidden', !next || coop);
  if (next) $('debrief-next').textContent = `NEXT: ${next.title} ▸`;
}

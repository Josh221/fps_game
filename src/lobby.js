// =============================================================================
// lobby.js — the co-op lobby screen, and the "open games" list on the menu.
//
// Pure UI: it draws the room state the server sends (see coop.js and
// server/server.mjs) and turns clicks into requests. It never changes the
// game itself. The server is the single source of truth, so every player sees
// the same lobby and nobody's screen can drift out of step.
// =============================================================================
import { MAPS, getMap } from './maps/index.js';
import { DIFFICULTY, GAME } from './config.js';
import { MODES as RADAR_MODES } from './minimap.js';
import { MISSIONS, missionById } from './campaign/story.js';
import { unlocked, maxStars } from './campaign/screens.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
export const lengthName = (w) => (w ? `${w} waves` : 'Endless');
// What each enemy-radar setting means (shown under the lobby's radar choice)
export const RADAR_BLURBS = {
  always: 'Every enemy is on the minimap, all the time, like a drone overhead.',
  fire: 'Enemies flash up on the minimap for a moment when they shoot.',
  spotted: 'Only enemies your squad has spotted (T) show up.',
  off: 'Hardcore: no enemy dots. Just the map, your squad and the ammo crates.',
};
const RESULTS = {
  won: 'MISSION ACCOMPLISHED', failed: 'MISSION FAILED', aborted: 'MISSION ABORTED', 'host-lost': 'HOST DISCONNECTED — MISSION LOST',
};
const clock = (s) => `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;

export class LobbyUI {
  // actions = { ready(v), options({ map, mode, mission, difficulty, waves, radar, listed }), start(), join(), leave(), kick(id, name), say(text),
  //             brief() (read the campaign mission's briefing), next(missionId) (host, after a win) }
  constructor(actions) {
    this.a = actions;
    this.countdown = 0;       // seconds left before deploying (0 = no countdown)
    this.loadingMap = null;   // a map name while we reload into the room's new map
    for (const m of MAPS) $('set-map').append(new Option(m.name, m.id));
    for (const [id, d] of Object.entries(DIFFICULTY)) $('set-diff').append(new Option(d.name, id));
    for (const w of GAME.missionLengths) $('set-waves').append(new Option(lengthName(w), w));
    for (const [id, name] of Object.entries(RADAR_MODES)) $('set-radar').append(new Option(name, id));
    MISSIONS.forEach((m, i) => $('set-mission').append(new Option(`${i + 1}. ${m.title} (${getMap(m.map).name})`, m.id)));

    $('set-map').onchange = () => actions.options({ map: $('set-map').value });
    $('set-mode').onchange = () => actions.options({ mode: $('set-mode').value });
    $('set-mission').onchange = () => actions.options({ mission: $('set-mission').value });
    $('lobby-brief').onclick = () => actions.brief?.();
    $('set-diff').onchange = () => actions.options({ difficulty: $('set-diff').value });
    $('set-waves').onchange = () => actions.options({ waves: +$('set-waves').value });
    $('set-radar').onchange = () => actions.options({ radar: $('set-radar').value });
    $('set-listed').onchange = () => actions.options({ listed: $('set-listed').checked });
    $('lobby-chat-input').onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const text = e.target.value.trim();
      if (text) actions.say(text);
      e.target.value = '';
    };
    $('lobby-main').onclick = () => this._mainAction?.();
    $('lobby-leave').onclick = () => actions.leave();
    $('copy-btn').onclick = () => {
      const box = $('invite-link');
      box.select();
      navigator.clipboard?.writeText(box.value).then(() => { $('copy-btn').textContent = 'COPIED'; }, () => {});
    };
  }

  setInvite(link) { $('invite-link').value = link; }

  // room: the server's room state. me: our player id.
  // statusOf(player): 'in lobby' | 'alive' | 'KIA' | 'reconnecting' (from coop.js)
  // voice: the VoiceChat (voice.js), for talking indicators and mute buttons
  render(room, me, statusOf, voice = null) {
    const isHost = room.hostId === me;
    const host = room.players.find((p) => p.host);
    const meP = room.players.find((p) => p.id === me);
    $('lobby-code').textContent = room.code;

    // --- squad
    const list = $('lobby-players');
    list.replaceChildren();
    for (const p of room.players) {
      const li = el('li', p.id === me ? 'me' : '');
      const who = el('div', 'who'), top = el('div');
      top.append(el('span', 'pname', p.name));
      if (p.host) top.append(el('span', 'badge', 'HOST'));
      // 🔊 talking right now · 🎙 mic on · 🔇 you muted them
      const talking = voice?.isTalking(p.id), muted = voice?.isMuted(p.id);
      if (muted) top.append(el('span', 'vox muted', '🔇'));
      else if (talking) top.append(el('span', 'vox talking', '🔊'));
      else if (p.mic) top.append(el('span', 'vox', '🎙'));
      who.append(top);
      if (p.kit) who.append(el('div', 'kit', p.kit.gun ? `${p.kit.cls} · ${p.kit.gun}` : p.kit.cls)); // class and main weapon
      li.append(who);
      let state, cls = '';
      if (!p.online) { state = 'RECONNECTING…'; cls = 'warn'; }
      else if (room.phase === 'playing') { const s = statusOf(p); state = s === 'in lobby' ? 'IN LOBBY' : 'IN MISSION'; cls = s === 'in lobby' ? '' : 'ok'; }
      else if (p.host || p.ready) { state = 'READY'; cls = 'ok'; }
      else state = 'NOT READY';
      li.append(el('span', `state ${cls}`, state));
      li.append(el('span', 'ping', p.online && p.ping != null ? `${p.ping} ms` : ''));
      if (voice && p.id !== me) {
        const mute = el('button', 'kick mute', voice.isMuted(p.id) ? 'UNMUTE' : 'MUTE');
        mute.title = `Mute or unmute ${p.name}'s voice (just for you)`;
        mute.onclick = () => voice.toggleMute(p.id);
        li.append(mute);
      }
      if (isHost && p.id !== me) {
        const kick = el('button', 'kick', '✕');
        kick.title = `Remove ${p.name} from the game`;
        kick.onclick = () => this.a.kick(p.id, p.name);
        li.append(kick);
      }
      list.append(li);
    }
    for (let i = room.players.length; i < room.max; i++) list.append(el('li', 'empty', 'open slot'));

    // --- mission settings (only the host can change them, and only between
    // missions). Everyone sees the same values: they come from the server.
    const canEdit = isHost && room.phase === 'lobby' && !this.countdown;
    const radar = room.radar || 'fire';
    // Campaign: the mission decides the map. (An old server without campaigns sends no mode.)
    const campaign = room.mode === 'campaign', mission = campaign ? missionById(room.mission) : null;
    $('set-mode').value = campaign ? 'campaign' : 'waves';
    $('set-mission').value = room.mission || MISSIONS[0].id;
    for (const o of $('set-mission').options) o.disabled = isHost && !unlocked(MISSIONS.findIndex((m) => m.id === o.value)); // the host's own progress
    $('set-mission-row').classList.toggle('hidden', !campaign);
    $('set-waves-row').classList.toggle('hidden', campaign);
    $('lobby-brief').classList.toggle('hidden', !mission);
    $('set-map').value = room.map;
    $('set-diff').value = room.difficulty;
    $('set-waves').value = String(room.waves);
    $('set-radar').value = radar;
    $('set-listed').checked = room.listed;
    for (const id of ['set-mode', 'set-mission', 'set-map', 'set-diff', 'set-waves', 'set-radar', 'set-listed']) $(id).disabled = !canEdit;
    if (campaign) $('set-map').disabled = true;
    $('set-map-blurb').textContent = mission ? `${mission.time} · ${mission.blurb}` : getMap(room.map).blurb;
    $('set-radar-blurb').textContent = RADAR_BLURBS[radar] + (isHost ? '' : ' (The host sets this for the whole squad.)');

    // --- after-action report from the last mission
    this._report(room, isHost);

    // --- the big button and the line above it
    const btn = $('lobby-main');
    const friends = room.players.filter((p) => !p.host && p.online);
    const ready = friends.filter((p) => p.ready).length;
    let note = '';
    btn.disabled = false;
    btn.classList.remove('armed');
    if (this.loadingMap) {
      btn.disabled = true; btn.textContent = 'LOADING…';
      note = `Switching to ${this.loadingMap}…`;
    } else if (this.countdown > 0) {
      btn.disabled = true; btn.textContent = `DEPLOYING IN ${Math.ceil(this.countdown)}`;
      note = 'Get ready…';
    } else if (room.phase === 'playing') {
      btn.textContent = 'JOIN MISSION';
      this._mainAction = () => this.a.join();
      note = `Mission in progress on ${getMap(room.map).name}. Drop in any time.`;
    } else if (isHost) {
      btn.textContent = 'START MISSION';
      this._mainAction = () => this.a.start();
      note = !friends.length ? 'Share the room code or invite link. You can also start alone.'
        : ready === friends.length ? 'Everyone is ready.' : `${ready} of ${friends.length} ready. Squadmates who aren't ready can join later.`;
    } else {
      btn.textContent = meP?.ready ? 'READY ✓' : 'READY UP';
      btn.classList.toggle('armed', !!meP?.ready);
      this._mainAction = () => this.a.ready(!meP?.ready);
      note = !host?.online ? `${host?.name || 'The host'} is reconnecting…` : `Waiting for ${host.name} to start the mission.`;
    }
    $('lobby-note').textContent = note;
  }

  _report(room, isHost) {
    const box = $('lobby-report');
    const r = room.last;
    box.classList.toggle('hidden', !r);
    if (!r) return;
    if (r.mission && missionById(r.mission)) { this._campaignReport(box, r, room, isHost); return; }
    const parts = [getMap(room.map).name, DIFFICULTY[room.difficulty]?.name];
    if (r.wave) parts.push(`reached wave ${r.wave}`);
    if (r.time) parts.push(clock(r.time));
    const table = el('table');
    if (r.rows?.length) {
      const head = el('tr');
      for (const h of ['SOLDIER', 'KILLS', 'DEATHS', 'HEADSHOTS', 'ACCURACY']) head.append(el('th', '', h));
      table.append(head);
      for (const row of r.rows) {
        const tr = el('tr');
        tr.append(el('td', '', row.name), el('td', '', row.kills), el('td', '', row.deaths), el('td', '', row.headshots), el('td', '', `${row.acc}%`));
        table.append(tr);
      }
    }
    box.replaceChildren(el('h3', r.result === 'won' ? 'won' : '', RESULTS[r.result] || 'MISSION OVER'), el('p', 'sub', parts.join(' · ')), table);
  }

  // After a campaign mission: stars, bonus goals, what happened next in the
  // story, and (host) a button for the next mission
  _campaignReport(box, r, room, isHost) {
    const m = missionById(r.mission), i = MISSIONS.indexOf(m), next = MISSIONS[i + 1];
    const won = r.result === 'won';
    const bonus = {};
    m.bonus.forEach((b, k) => { bonus[b.id] = !!r.bonus?.[k]; });
    const kids = [el('h3', won ? 'won' : '', `${RESULTS[r.result] || 'MISSION OVER'} · ${m.title}`),
      el('p', 'sub', [DIFFICULTY[room.difficulty]?.name, r.time ? clock(r.time) : ''].filter(Boolean).join(' · '))];
    if (won) {
      kids.push(el('div', 'stars', '★'.repeat(r.stars) + '☆'.repeat(Math.max(0, maxStars(m) - r.stars))));
      const ul = el('ul', 'bonus');
      m.bonus.forEach((b) => ul.append(el('li', bonus[b.id] ? 'ok' : 'no', `${bonus[b.id] ? '✓' : '✕'} ${b.text}`)));
      kids.push(ul, el('p', 'story', m.debrief({ bonus })));
    }
    const table = el('table');
    const head = el('tr');
    for (const h of ['SOLDIER', 'KILLS', 'DEATHS', 'HEADSHOTS', 'ACCURACY']) head.append(el('th', '', h));
    table.append(head);
    for (const row of r.rows || []) {
      const tr = el('tr');
      tr.append(el('td', '', row.name), el('td', '', row.kills), el('td', '', row.deaths), el('td', '', row.headshots), el('td', '', `${row.acc}%`));
      table.append(tr);
    }
    kids.push(table);
    if (won && next && isHost && room.phase === 'lobby') {
      const b = el('button', 'next', `NEXT MISSION: ${next.title} ▸`);
      b.onclick = () => this.a.next?.(next.id);
      kids.push(b);
    } else if (won && !next) kids.push(el('p', 'sub', 'That was the last mission. The campaign is complete.'));
    box.replaceChildren(...kids);
  }

  chatLine(msg) { chatLineTo($('lobby-chat-log'), msg); }
}

// Add one chat message to a scrolling chat box (the lobby's, or the pause menu's).
// textContent, never innerHTML: chat is typed by other people.
export function chatLineTo(box, { name, text, sys, me }) {
  const line = el('div', sys ? 'sys' : '');
  if (!sys) line.append(el('b', me ? 'me' : '', `${name}: `));
  line.append(document.createTextNode(text));
  box.append(line);
  while (box.children.length > 60) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

// Voice controls (mic on/off, push-to-talk or open mic, volume), in the
// lobby and in the pause menu. Built once; update() refreshes the labels.
export class VoiceBars {
  constructor(voice, boxes) {
    this.voice = voice;
    this.bars = boxes.map((box) => {
      const mic = el('button', 'ghost vb-mic');
      const mode = el('select', 'vb-mode');
      mode.append(new Option('Push-to-talk (hold B)', 'ptt'), new Option('Open mic', 'open'));
      const vol = el('input', 'vb-vol');
      Object.assign(vol, { type: 'range', min: 0, max: 1, step: 0.05 });
      const volLabel = el('label', 'vb-vol-label', 'Volume ');
      volLabel.append(vol);
      const status = el('div', 'vb-status');
      mic.onclick = () => (voice.micOn ? voice.disableMic() : voice.enableMic());
      mode.onchange = () => voice.setMode(mode.value);
      vol.oninput = () => voice.setVolume(+vol.value);
      const row = el('div', 'vb-row');
      row.append(el('span', 'vb-title', 'VOICE'), mic, mode, volLabel);
      box.replaceChildren(row, status);
      return { mic, mode, vol, status };
    });
    this.update();
  }

  update() {
    const v = this.voice;
    for (const b of this.bars) {
      b.mic.textContent = !v.micOn ? 'MIC OFF' : v.transmitting ? '🎙 TALKING' : '🎙 MIC ON';
      b.mic.classList.toggle('on', v.micOn);
      b.mic.classList.toggle('tx', v.transmitting);
      b.mic.disabled = !v.canTalk;
      if (document.activeElement !== b.mode) b.mode.value = v.mode;
      if (document.activeElement !== b.vol) b.vol.value = v.volume;
      b.status.textContent = v.error
        || (!v.canTalk ? 'You can hear your squad. To talk, open the game from its https:// address (the invite link).'
          : !v.micOn ? 'Press MIC OFF to switch your microphone on.'
          : v.mode === 'ptt' ? 'Hold B to talk.' : 'Your mic sends whenever you speak.');
    }
  }
}

// The "open games" list on the main menu: games on this server you can join.
export function renderGameList(games, onJoin) {
  const box = $('games');
  box.replaceChildren();
  if (!games.length) { box.append(el('div', 'empty', 'No open games right now. Host one!')); return; }
  for (const g of games) {
    const row = el('div', 'game-row');
    const info = el('div', 'game-info');
    info.append(el('b', '', `${g.host}'s squad`),
      el('span', '', `${g.mode === 'campaign' && missionById(g.mission) ? `Campaign: ${missionById(g.mission).title}` : `${getMap(g.map).name} · ${lengthName(g.waves)}`} · ${DIFFICULTY[g.difficulty]?.name || ''}` +
        `${g.radar ? ` · radar: ${RADAR_MODES[g.radar]?.toLowerCase()}` : ''} · ${g.phase === 'playing' ? 'in mission' : 'in lobby'}`));
    const join = el('button', 'ghost', g.players >= g.max ? 'FULL' : `JOIN ${g.players}/${g.max}`);
    join.disabled = g.players >= g.max;
    join.onclick = () => onJoin(g.code);
    row.append(info, join);
    box.append(row);
  }
}

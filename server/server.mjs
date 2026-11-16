// =============================================================================
// server.mjs — the game's web server, LOBBY server and co-op relay, in one.
//
//   npm start   ->  http://localhost:8000   (it also prints the address friends
//                                            on your Wi-Fi should open)
//
// 1. STATIC FILES. Serves index.html, src/ and assets/, the same job
//    `python3 -m http.server` did, so friends only need one address.
//
// 2. LOBBY. The server owns each room's lobby state: who's in it, who's ready,
//    the map and mission settings, and whether a mission is running. It has to
//    be the server, not the host's browser, because a lobby must survive a
//    player's page reloading. Changing map reloads every page (see coop.js),
//    and so do refreshes and Wi-Fi drops. Each player gets a secret TOKEN when
//    they join; coming back with it within GRACE_MS gives them their old slot.
//    Matchmaking services (Steam lobbies, Epic Online Services) do this job in
//    real games.
//
// 3. RELAY. During a mission, the host's browser runs the enemy AI and the
//    rules (a LISTEN SERVER). This server never simulates anything; it passes
//    game messages along:
//        friend --> server --> host           (server stamps "from": friend's id)
//        host   --> server --> every friend   (or one friend, if the host sets "to")
//    A DEDICATED server would run the simulation here instead, which stops
//    cheating but means porting the AI, bullets and collision to Node.
//
// 4. HTTPS. Browsers only allow the microphone (voice chat) on localhost or
//    over HTTPS. So we also serve everything over HTTPS, on HTTPS_PORT, with a
//    certificate we make ourselves (with openssl, kept in .certs/). Nobody
//    vouches for it, so friends' browsers warn once ("not private"): they
//    click Advanced -> Proceed. A tunnel (cloudflared, ngrok) or Tailscale
//    gives you a real certificate instead.
//
// 5. GOING PUBLIC. On the internet, strangers and scripts connect too, so
//    the server: only sends the game's own files (an allow-list), LIMITS
//    how much any one address can do, lets Cloudflare cache the big assets,
//    keeps your home network's addresses to itself, and can hand out a voice
//    relay (TURN). The README's "Hosting publicly" section has the setup.
// =============================================================================
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let WebSocketServer;
try {
  ({ WebSocketServer } = await import('ws'));
} catch {
  console.error('\n  The "ws" package is missing. Run  npm install  once, then  npm start  again.\n');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8000;
// 8443 next to 8000. HTTPS_PORT=0 turns it off (a tunnel already gives you HTTPS).
const HTTPS_PORT = process.env.HTTPS_PORT === undefined ? PORT + 443 : Number(process.env.HTTPS_PORT) || 0;
// Which network to listen on. Unset = every network this computer is on (friends
// on your Wi-Fi can connect). HOST=127.0.0.1 = only this computer, which is what
// you want when a tunnel on the same machine is the only way in.
const HOST = process.env.HOST || undefined;
const MAX_PLAYERS = 4;
// How many lobbies (games) can be open at once. Each full room in a heavy
// firefight needs about 0.7 Mbit/s of your upload, so 5 rooms (20 players)
// need about 3.5 Mbit/s. Measure your upload before raising it: MAX_ROOMS=10 npm start
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 5;

// ---------------------------------------------------------------- going public
// On the internet, anyone can connect, including people (and scripts) trying to
// break things. Every web service sets limits like these, so one visitor can't
// use up the server for everyone else. They're generous: normal play never
// gets near them. (README: "Hosting publicly".)
const LIMITS = {
  rooms: MAX_ROOMS,        // lobbies open at once, whole server
  // Open connections, whole server: every player in every full room, plus 10
  // spare. A player who reloads or whose Wi-Fi drops has a new connection
  // before the server notices the old one is gone (up to 10 s later).
  connections: MAX_ROOMS * MAX_PLAYERS + 10,
  connectionsPerIp: 12,    // one home's players, with room for reloads and a second tab
  // A connection must host or join a game this soon, or it's closed. The
  // game does it within a second; this stops idle connections from holding
  // the few places the server has.
  joinWithinMs: 15000,
  hostsPerIp: 10,          // new lobbies one address may open...
  badJoinsPerIp: 20,       // ...and wrong room codes it may try...
  window: 10 * 60000,      // ...every 10 minutes (stops scripts guessing codes)
  // Two TOKEN BUCKETS per connection, one counting messages and one counting
  // bytes. Each refills at its rate per second, up to its burst size, and a
  // message must be paid for from both. Measured worst case: the host of a
  // full squad against 20 enemies, everyone firing, sends 76 messages and
  // 24 KB a second on average, and at most ~290 messages / ~100 KB in any one
  // second. The limits are about twice that.
  msgRate: 600, msgBurst: 1200,                   // messages per second
  byteRate: 256 * 1024, byteBurst: 1024 * 1024,   // bytes per second (256 KB/s = 2 Mbit/s)
};

// Voice chat goes straight between players' browsers. Some home routers block
// that, and then only a TURN server (a relay on the internet) can connect them.
// Set ONE of these to give players a TURN relay (README: "Voice chat"):
//   Cloudflare's TURN service:  CF_TURN_KEY_ID and CF_TURN_API_TOKEN
//   your own (e.g. coturn):     TURN_URLS (comma-separated) and TURN_SECRET
// VOICE_RELAY_ONLY=1 sends ALL voice through the relay, so players never
// learn each other's home IP address (costs a little more relay traffic).
const TURN = {
  cfKey: process.env.CF_TURN_KEY_ID, cfToken: process.env.CF_TURN_API_TOKEN,
  urls: (process.env.TURN_URLS || '').split(',').map((u) => u.trim()).filter(Boolean), secret: process.env.TURN_SECRET,
  relayOnly: process.env.VOICE_RELAY_ONLY === '1',
  ttl: 6 * 3600,           // how long a player's relay password lasts (seconds)
};
const GRACE_MS = 60000;    // how long a dropped player's slot is kept for them
const DIFFICULTIES = ['recruit', 'regular', 'veteran'];
const MISSION_WAVES = [0, 5, 10]; // 0 = endless
// Enemy radar on the minimap (see src/minimap.js). It's a mission rule, like
// difficulty: the host picks it in the lobby and every player gets the same one.
const RADAR_MODES = ['always', 'fire', 'spotted', 'off'];
// Campaign (story missions, src/campaign/) or waves. The mission is just its id;
// the host's browser knows what it means and runs it.
const GAME_MODES = ['waves', 'campaign'];
const cleanMission = (m) => (/^[a-z0-9-]{1,32}$/.test(String(m)) ? String(m) : null);

// ---------------------------------------------------------------- static files
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.hdr': 'application/octet-stream',
  '.fbx': 'application/octet-stream', '.wasm': 'application/wasm', '.webp': 'image/webp', '.ktx2': 'image/ktx2',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};

// Only these are the game. Everything else in the folder (this server's code,
// node_modules, tools/, the .md notes, .certs/ with the HTTPS key) is never sent.
// An ALLOW-list is safer than a block-list: a file added later stays private
// until someone decides it should be public.
const PUBLIC_FILES = /^(index\.html|style\.css|src\/.+|assets\/.+)$/;

// Sent with every file. They tell the browser to be stricter with our pages:
// trust our Content-Type (don't guess "this .jpg is really a script"), don't let
// other websites show the game inside a frame (a trick for stealing clicks),
// don't tell other sites which page linked to them, and only let our own pages
// use the microphone.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
};

// Did this request come through a proxy (the Cloudflare tunnel, or CloudPanel's
// nginx)? Proxies add a header saying who the real visitor is.
const viaProxy = (req) => !!(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
const isPrivateIp = (ip) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd]|fe80:)/i.test(ip);

// The visitor's real address, used to apply LIMITS per person. Through a
// tunnel every connection comes from the tunnel program on this machine, so the
// real address is in the proxy's header. We only believe that header when the
// connection itself came from this machine or the local network (where our
// proxy runs): anyone on the internet could send a made-up one.
function clientIp(req) {
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!isPrivateIp(peer)) return peer;
  const told = req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
  return String(told || peer).trim().slice(0, 64);
}

function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }

  // The "open games" list on the main menu
  if (urlPath === '/api/rooms') {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(publicRooms()));
    return;
  }

  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.join(ROOT, urlPath);
  // Check the path AFTER resolving it: "/src/..%2Fserver/server.mjs" decodes
  // to "/src/../server/server.mjs", which looks like src/ but isn't. Also
  // never serve hidden files (".git"), even inside an allowed folder.
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  if (!PUBLIC_FILES.test(rel) || rel.split('/').some((p) => p.startsWith('.'))) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('Not found'); return; }
    // Code: browsers keep their copy but check it's current every time, so an
    // edit shows up on the next reload. Assets for INTERNET visitors: big and
    // rarely change, so let Cloudflare keep a copy for a week (s-maxage) and
    // browsers for an hour. Then each file leaves your home connection about
    // once a week instead of once per player. (Changed an asset? Purge the
    // Cloudflare cache.) On your own network they're checked every time, so
    // re-downloaded assets show up straight away while you work on the game.
    const shareable = rel.startsWith('assets/') && viaProxy(req);
    const modified = st.mtime.toUTCString();
    const headers = { ...SECURITY_HEADERS, 'Last-Modified': modified, 'Cache-Control': shareable ? 'public, max-age=3600, s-maxage=604800' : 'no-cache' };
    if (req.headers['if-modified-since'] === modified) { res.writeHead(304, headers).end(); return; }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size });
    if (req.method === 'HEAD') { res.end(); return; }
    // (If the file vanishes mid-send, end this one download; without the
    // handler, the error would crash the whole server.)
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}
const server = http.createServer(handleRequest);

// A self-made certificate for HTTPS, covering this computer's network addresses.
// Lives in .certs/ (hidden, so the file server above never hands out the key).
function certificate() {
  const dir = path.join(ROOT, '.certs'), keyFile = path.join(dir, 'key.pem'), certFile = path.join(dir, 'cert.pem'), forFile = path.join(dir, 'for.txt');
  const names = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)].join(',');
  try {
    // Make a new one the first time, or when this computer's addresses change
    if (!fs.existsSync(certFile) || fs.readFileSync(forFile, 'utf8') !== names) {
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
        '-keyout', keyFile, '-out', certFile, '-subj', '/CN=Operation Dustline (local game server)', '-addext', `subjectAltName=${names}`], { stdio: 'ignore' });
      fs.writeFileSync(forFile, names);
    }
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch {
    return null; // no openssl: HTTPS (and voice for friends) unavailable
  }
}
const tls = HTTPS_PORT ? certificate() : null;
const secureServer = tls ? https.createServer(tls, handleRequest) : null;

// ---------------------------------------------------------------- voice relay (TURN)
// Players get relay passwords in their 'welcome' message, so only people who
// are actually in a game get them. The passwords EXPIRE (TURN.ttl): a leaked
// one stops working, and your secret key never leaves this server.
let iceCache = null; // { servers, until } from Cloudflare

// Your own TURN server (coturn's "use-auth-secret" mode, the "TURN REST API"):
// the username is "<expiry time>:<anything>" and the password is an HMAC of
// it, made with the secret coturn also knows. coturn checks the maths and the
// time, with no list of users to keep.
function ownTurn() {
  const username = `${Math.floor(Date.now() / 1000) + TURN.ttl}:dustline`;
  const credential = crypto.createHmac('sha1', TURN.secret).update(username).digest('base64');
  return [{ urls: TURN.urls, username, credential }];
}

// Cloudflare's TURN service: ask its API for passwords that last TURN.ttl.
// We fetch one set an hour and hand the same set to everyone, so every
// player's set has at least TURN.ttl minus one hour left.
async function refreshCloudflareTurn() {
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(TURN.cfKey)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TURN.cfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN.ttl }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { iceServers } = await res.json();
    // Port 53 is blocked by browsers (Cloudflare's docs): drop it rather than wait for it to time out
    const servers = (Array.isArray(iceServers) ? iceServers : []).map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
    iceCache = { servers, until: Date.now() + 3600000 };
  } catch (err) {
    console.error(`  Couldn't get voice relay passwords from Cloudflare (${err.message}). Voice will try without a relay.`);
  }
}
if (TURN.cfKey && TURN.cfToken) {
  await refreshCloudflareTurn();
  setInterval(refreshCloudflareTurn, 3600000).unref();
}

// What goes in a player's 'welcome': the relay servers, or null for "no relay"
function iceConfig() {
  const servers = TURN.urls.length && TURN.secret ? ownTurn() : iceCache?.servers;
  return servers?.length ? { servers, relayOnly: TURN.relayOnly } : null;
}

// ---------------------------------------------------------------- helpers
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: easy to read out over voice chat
const rooms = new Map(); // code -> room

function newCode() {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[(Math.random() * LETTERS.length) | 0]).join('');
  while (rooms.has(code));
  return code;
}

const cleanName = (n) => String(n ?? '').replace(/[^\w .-]/g, '').trim().slice(0, 12) || 'Soldier';
const cleanMap = (m) => (/^[a-z0-9_-]{1,32}$/.test(String(m)) ? String(m) : 'dustline');
const cleanText = (t) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160);
const int = (v) => Math.max(0, Math.min(1e6, Math.round(+v || 0)));
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
}

// LIMITS bookkeeping: when did this address last do <kind>? ("host 1.2.3.4" -> [times])
const recent = new Map();
function tooMany(kind, ip, max) {
  const key = `${kind} ${ip}`, t = Date.now();
  const list = (recent.get(key) || []).filter((x) => t - x < LIMITS.window);
  if (list.length) recent.set(key, list); else recent.delete(key);
  return list.length >= max;
}
function remember(kind, ip) {
  const key = `${kind} ${ip}`;
  recent.set(key, [...(recent.get(key) || []), Date.now()]);
}

// Each message spends 1 message token and `bytes` byte tokens (see LIMITS).
// Not enough in either bucket = the message is dropped, like a router dropping
// packets. The byte bucket matters most: the server copies a host's message
// to every friend, so without it one room could use up your home upload.
function allowMessage(ws, bytes) {
  const t = Date.now(), dt = (t - ws.tokensT) / 1000;
  ws.tokensT = t;
  ws.msgTokens = Math.min(LIMITS.msgBurst, ws.msgTokens + dt * LIMITS.msgRate);
  ws.byteTokens = Math.min(LIMITS.byteBurst, ws.byteTokens + dt * LIMITS.byteRate);
  if (ws.msgTokens < 1 || ws.byteTokens < bytes) { ws.dropped++; return false; }
  ws.msgTokens -= 1;
  ws.byteTokens -= bytes;
  return true;
}

// ---------------------------------------------------------------- rooms
// room = { code, map, mode, mission, difficulty, waves, radar, listed, phase: 'lobby'|'playing', last, hostId, nextId, slots: Map<id, slot> }
// slot = { id, name, token, ws (null while disconnected), ready, ping, kit ({ cls, gun, w, a } or null), expire (timer) }

const hostSlot = (room) => room.slots.get(room.hostId);

// What every player is told about the room. Tokens stay secret.
function view(room) {
  return {
    code: room.code, map: room.map, mode: room.mode, mission: room.mission, difficulty: room.difficulty, waves: room.waves, radar: room.radar, listed: room.listed,
    phase: room.phase, hostId: room.hostId, last: room.last, max: MAX_PLAYERS,
    players: [...room.slots.values()].map((s) => ({ id: s.id, name: s.name, ready: s.ready, online: !!s.ws, ping: s.ping, kit: s.kit, mic: s.mic, host: s.id === room.hostId })),
  };
}

function toRoom(room, msg, exceptId) {
  const text = JSON.stringify(msg);
  for (const s of room.slots.values()) if (s.ws && s.id !== exceptId) send(s.ws, text);
}
const sync = (room) => toRoom(room, { t: 'room', room: view(room) });
const notice = (room, text) => toRoom(room, { t: 'chat', sys: 1, text });

function publicRooms() {
  return [...rooms.values()]
    .filter((r) => r.listed && hostSlot(r)?.ws)
    .map((r) => ({ code: r.code, host: hostSlot(r).name, map: r.map, mode: r.mode, mission: r.mission, difficulty: r.difficulty, waves: r.waves, radar: r.radar, phase: r.phase, players: r.slots.size, max: MAX_PLAYERS }));
}

function addSlot(room, ws, name) {
  const slot = { id: room.nextId++, name: cleanName(name), token: crypto.randomBytes(16).toString('hex'), ws: null, ready: false, ping: null, kit: null, mic: false, expire: null };
  room.slots.set(slot.id, slot);
  attach(room, slot, ws);
  return slot;
}

function attach(room, slot, ws) {
  clearTimeout(slot.expire);
  if (slot.ws && slot.ws !== ws) { slot.ws.room = null; slot.ws.close(); } // same player, newer connection (e.g. a second tab)
  slot.ws = ws;
  Object.assign(ws, { room, slot });
  // addrs/httpsPort build invite links for friends on the same Wi-Fi. Someone
  // who came in through the tunnel is on the internet: they use the public
  // https:// address, and don't need to know your home network's layout.
  const lan = !ws.proxied;
  send(ws, { t: 'welcome', id: slot.id, token: slot.token, name: slot.name, addrs: lan ? lanAddresses() : [], httpsPort: lan && secureServer ? HTTPS_PORT : null, ice: iceConfig(), room: view(room) });
}

// A connection dropped. Keep the slot for GRACE_MS in case they come back.
function dropped(ws) {
  const { room, slot } = ws;
  if (!room || slot.ws !== ws) return;
  slot.ws = null;
  slot.ready = false;
  slot.ping = null;
  slot.mic = false;
  if (slot.id === room.hostId && room.phase === 'playing') {
    // The host's browser WAS the game. Without it the mission can't go on.
    room.phase = 'lobby';
    room.last = { result: 'host-lost' };
  }
  notice(room, `${slot.name} lost connection…`);
  sync(room);
  slot.expire = setTimeout(() => removeSlot(room, slot, 'timed out'), GRACE_MS);
}

function removeSlot(room, slot, why) {
  clearTimeout(slot.expire);
  if (!room.slots.has(slot.id)) return;
  room.slots.delete(slot.id);
  if (slot.ws) slot.ws.room = null;
  if (slot.id === room.hostId) { closeRoom(room, why === 'left' ? 'The host closed the game.' : 'The host left the game.'); return; }
  notice(room, `${slot.name} ${why}`);
  sync(room);
  log(`room ${room.code}: ${slot.name} ${why}`);
}

function closeRoom(room, reason) {
  for (const s of room.slots.values()) {
    clearTimeout(s.expire);
    if (s.ws) { s.ws.room = null; send(s.ws, { t: 'closed', reason }); s.ws.close(); }
  }
  rooms.delete(room.code);
  log(`room ${room.code}: closed (${reason})`);
}

// Mission settings the host can change in the lobby
function applySettings(room, msg) {
  let changed = false;
  if (msg.map !== undefined && cleanMap(msg.map) !== room.map) {
    room.map = cleanMap(msg.map);
    room.last = null;
    for (const s of room.slots.values()) s.ready = false; // new map: everyone re-confirms
    changed = true;
  }
  if (GAME_MODES.includes(msg.mode) && msg.mode !== room.mode) { room.mode = msg.mode; room.last = null; changed = true; }
  if (msg.mission !== undefined && cleanMission(msg.mission) && cleanMission(msg.mission) !== room.mission) { room.mission = cleanMission(msg.mission); room.last = null; changed = true; }
  if (DIFFICULTIES.includes(msg.difficulty)) { room.difficulty = msg.difficulty; changed = true; }
  if (MISSION_WAVES.includes(msg.waves)) { room.waves = msg.waves; changed = true; }
  if (RADAR_MODES.includes(msg.radar)) { room.radar = msg.radar; changed = true; }
  if (typeof msg.listed === 'boolean') { room.listed = msg.listed; changed = true; }
  return changed;
}

// The host's after-action report: only keep what the lobby shows
function cleanReport(r, result) {
  return {
    result: ['won', 'failed', 'aborted'].includes(result) ? result : 'aborted',
    wave: int(r?.wave), time: int(r?.time),
    // campaign: which mission, its stars and which bonus goals were met
    mission: cleanMission(r?.mission), stars: Math.min(5, int(r?.stars)), bonus: (Array.isArray(r?.bonus) ? r.bonus : []).slice(0, 4).map((b) => (b ? 1 : 0)),
    rows: (Array.isArray(r?.rows) ? r.rows : []).slice(0, MAX_PLAYERS).map((x) => ({
      name: cleanName(x?.name), kills: int(x?.kills), deaths: int(x?.deaths), headshots: int(x?.headshots), acc: Math.min(100, int(x?.acc)),
    })),
  };
}

// ---------------------------------------------------------------- messages
// Before you're in a room: host one, or join one (with a token = rejoin).
function lobby(ws, msg) {
  if (msg.t === 'host') {
    if (rooms.size >= LIMITS.rooms) return send(ws, { t: 'error', msg: `All ${LIMITS.rooms} games on this server are taken. Join one from "Open games", or try again later.` });
    if (tooMany('host', ws.ip, LIMITS.hostsPerIp)) return send(ws, { t: 'error', msg: 'You opened a lot of games just now. Wait a few minutes, then try again.' });
    remember('host', ws.ip);
    const room = {
      code: newCode(), map: cleanMap(msg.map), mode: 'waves', mission: null, difficulty: 'regular', waves: 10, radar: 'fire', listed: true,
      phase: 'lobby', last: null, hostId: 1, nextId: 1, slots: new Map(),
    };
    applySettings(room, msg);
    rooms.set(room.code, room);
    const slot = addSlot(room, ws, msg.name);
    log(`room ${room.code}: opened by ${slot.name} on ${room.map}`);
  } else if (msg.t === 'join') {
    // There are only 24^4 = 331,776 codes, so a script trying them all would
    // find unlisted games. Counting wrong guesses per address stops that.
    if (tooMany('badjoin', ws.ip, LIMITS.badJoinsPerIp)) return send(ws, { t: 'error', msg: 'Too many wrong room codes. Wait a few minutes, then try again.' });
    const room = rooms.get(String(msg.code ?? '').trim().toUpperCase());
    if (!room) { remember('badjoin', ws.ip); return send(ws, { t: 'error', msg: 'No game with that code. It may have closed.' }); }
    // Every player has to load the room's map first.
    if (msg.map !== room.map) return send(ws, { t: 'wrong-map', map: room.map });
    const back = msg.token && [...room.slots.values()].find((s) => s.token === msg.token);
    if (back) {
      attach(room, back, ws);
      notice(room, `${back.name} is back`);
      sync(room);
      return;
    }
    if (room.slots.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: `That game is full (${MAX_PLAYERS} players).` });
    const slot = addSlot(room, ws, msg.name);
    notice(room, `${slot.name} joined`);
    sync(room);
    log(`room ${room.code}: ${slot.name} joined (${room.slots.size} players)`);
  }
}

// In a room: lobby actions are handled here; anything else is game traffic for the relay.
function inRoom(ws, msg) {
  const { room, slot } = ws;
  const isHost = slot.id === room.hostId;
  switch (msg.t) {
    case 'ready':
      slot.ready = !!msg.v;
      sync(room);
      return;
    case 'mic': // voice chat: is this player's microphone on?
      slot.mic = !!msg.v;
      sync(room);
      return;
    case 'sig': { // voice chat setup, from one player straight to another (see voice.js)
      const target = room.slots.get(msg.to);
      if (target && target !== slot) send(target.ws, { t: 'sig', from: slot.id, d: msg.d });
      return;
    }
    case 'kit': { // your class and main weapon, shown in the lobby and on the scoreboard
      // w: their guns + attachments + paint as text (loadout.js encodeWeapons)
      // a: their soldier's look as text (avatar.js encodeAvatar); each client re-checks both
      const kit = { cls: cleanText(msg.cls).slice(0, 20), gun: cleanText(msg.gun).slice(0, 24), w: cleanText(msg.w), a: cleanText(msg.a).slice(0, 100) }; // (w is at most ~135 chars)
      if (!kit.cls || JSON.stringify(kit) === JSON.stringify(slot.kit)) return;
      slot.kit = kit;
      sync(room);
      return;
    }
    case 'set':
      if (isHost && room.phase === 'lobby' && applySettings(room, msg)) sync(room);
      return;
    case 'start': {
      if (!isHost || room.phase !== 'lobby') return;
      room.phase = 'playing';
      room.last = null;
      // The host and everyone who's READY deploy; the rest can join from the lobby.
      const deploy = [...room.slots.values()].filter((s) => s.ws && (s.ready || s.id === room.hostId)).map((s) => s.id);
      toRoom(room, { t: 'start', deploy });
      sync(room);
      return;
    }
    case 'end':
      if (!isHost || room.phase !== 'playing') return;
      room.phase = 'lobby';
      room.last = cleanReport(msg.report, msg.result);
      for (const s of room.slots.values()) s.ready = false;
      sync(room);
      return;
    case 'chat': {
      // Rate limit: at most 5 messages every 5 seconds
      const t = Date.now();
      slot.chatTimes = (slot.chatTimes || []).filter((x) => t - x < 5000);
      const text = cleanText(msg.text);
      if (!text || slot.chatTimes.length >= 5) return;
      slot.chatTimes.push(t);
      toRoom(room, { t: 'chat', id: slot.id, name: slot.name, text });
      return;
    }
    case 'kick': {
      const target = room.slots.get(msg.id);
      if (!isHost || !target || target === slot) return;
      if (target.ws) { send(target.ws, { t: 'kicked' }); target.ws.close(); }
      removeSlot(room, target, 'was removed by the host');
      return;
    }
    case 'leave':
      removeSlot(room, slot, 'left');
      ws.close();
      return;
    default:
      relay(ws, msg);
  }
}

function relay(ws, msg) {
  const { room, slot } = ws;
  if (slot.id === room.hostId) {
    const { to, ex } = msg; // "to": only this player; "ex": everyone except this player
    delete msg.to;
    delete msg.ex;
    const text = JSON.stringify(msg); // encode once, send to many
    if (to !== undefined) send(room.slots.get(to)?.ws, text);
    else for (const s of room.slots.values()) if (s.id !== room.hostId && s.id !== ex) send(s.ws, text);
  } else {
    msg.from = slot.id; // stamped here, so a player can't pretend to be someone else
    send(hostSlot(room)?.ws, msg);
  }
}

// ---------------------------------------------------------------- websocket
const sockets = new Set(); // every connection, from either server
const perIp = new Map();   // address -> open connections
function onConnection(ws, req) {
  ws.on('error', () => {});
  ws.ip = clientIp(req);
  ws.proxied = viaProxy(req);
  // Over a LIMIT? Answer their first request (host / join) with the reason, so
  // the menu can show it, then hang up. Hang up after 5 s whatever happens.
  const full = sockets.size >= LIMITS.connections ? 'The server is full right now. Try again in a few minutes.'
    : (perIp.get(ws.ip) || 0) >= LIMITS.connectionsPerIp ? 'Too many connections from your network. Close some game tabs, then try again.' : null;
  if (full) {
    ws.once('message', () => { send(ws, { t: 'error', msg: full }); ws.close(1013); });
    setTimeout(() => ws.terminate(), 5000).unref();
    return;
  }
  sockets.add(ws);
  perIp.set(ws.ip, (perIp.get(ws.ip) || 0) + 1);
  Object.assign(ws, { since: Date.now(), msgTokens: LIMITS.msgBurst, byteTokens: LIMITS.byteBurst, tokensT: Date.now(), dropped: 0 });
  ws.on('close', () => {
    sockets.delete(ws);
    if (perIp.get(ws.ip) > 1) perIp.set(ws.ip, perIp.get(ws.ip) - 1); else perIp.delete(ws.ip);
  });
  ws.on('pong', () => {
    if (ws.slot && ws.pingSent) ws.slot.ping = Date.now() - ws.pingSent;
    ws.pingSent = 0;
  });
  ws.on('close', () => dropped(ws));
  ws.on('message', (data, isBinary) => {
    if (isBinary || !allowMessage(ws, data.length)) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    // One strange message must never take the server down for every other game
    try {
      if (ws.room) inRoom(ws, msg);
      else lobby(ws, msg);
    } catch (err) {
      log(`ignored a message from ${ws.ip} that broke something: ${err.message}`);
    }
  });
}
for (const s of [server, secureServer]) {
  if (!s) continue;
  const wss = new WebSocketServer({ server: s, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('error', () => {}); // listen errors are reported by the server's own 'error' handler below
  wss.on('connection', onConnection);
}

// Every 2 s: measure everyone's ping (a WebSocket ping frame; browsers answer
// it automatically) and drop connections that stopped answering, e.g. a
// laptop that went to sleep. Then tell each room everyone's ping.
setInterval(() => {
  const t = Date.now();
  for (const ws of sockets) {
    if (ws.pingSent && t - ws.pingSent > 10000) { ws.terminate(); continue; }
    if (!ws.room && t - ws.since > LIMITS.joinWithinMs) { ws.close(); continue; } // connected, but never joined a game
    if (!ws.pingSent) { ws.pingSent = t; ws.ping(); }
    // Messages dropped for coming too fast (LIMITS). A few is a burst; a
    // thousand in 2 s is a flood, and that connection is cut off.
    if (ws.dropped) {
      log(`${ws.ip}: dropped ${ws.dropped} messages (sending too fast)`);
      if (ws.dropped > 1000) ws.terminate();
      ws.dropped = 0;
    }
  }
  for (const room of rooms.values()) {
    toRoom(room, { t: 'pings', p: [...room.slots.values()].map((s) => [s.id, s.ping]) });
  }
  for (const [key, list] of recent) if (t - list[list.length - 1] > LIMITS.window) recent.delete(key);
}, 2000).unref();

// ---------------------------------------------------------------- start
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Is another copy of the game (or "npm run solo") still running?`);
    console.error(`  Stop it, or pick another port:  PORT=8001 npm start\n`);
  } else console.error(err);
  process.exit(1);
});

secureServer?.on('error', (err) => console.error(`  HTTPS on port ${HTTPS_PORT} is unavailable (${err.code}); voice chat will only work on this computer.`));

// Listening on one address (HOST=127.0.0.1) means the network list is useless
const onlyHere = HOST && !['0.0.0.0', '::'].includes(HOST);
server.listen(PORT, HOST, () => {
  console.log('\n  Operation Dustline is running.\n');
  console.log(`  On this computer:       http://localhost:${PORT}`);
  console.log(`  Games at once:          up to ${MAX_ROOMS} (${MAX_ROOMS * MAX_PLAYERS} players; change with MAX_ROOMS)`);
  if (onlyHere) console.log(`  Only reachable on ${HOST} (HOST is set): friends come in through your tunnel's https:// address.`);
  else for (const ip of lanAddresses()) console.log(`  Friends on your network: http://${ip}:${PORT}`);
  const turn = TURN.urls.length && TURN.secret ? 'your TURN server' : TURN.cfKey ? (iceCache ? 'Cloudflare TURN' : 'Cloudflare TURN (not working, see above)') : null;
  if (turn) console.log(`  Voice relay:            ${turn}${TURN.relayOnly ? ', relay only (players never see each other\'s IP)' : ''}`);
  if (secureServer) {
    secureServer.listen(HTTPS_PORT, HOST, () => {
      if (!onlyHere) for (const ip of lanAddresses()) console.log(`  ...with voice chat:      https://${ip}:${HTTPS_PORT}  (accept the one-time browser warning)`);
      console.log('\n  Press HOST GAME on the menu to open a lobby. Ctrl+C stops the server.\n');
    });
  } else {
    if (HTTPS_PORT) console.log('\n  (No openssl found, so no HTTPS: friends can hear voice chat but not talk.)');
    console.log('\n  Press HOST GAME on the menu to open a lobby. Ctrl+C stops the server.\n');
  }
});

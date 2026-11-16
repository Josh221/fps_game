// =============================================================================
// net.js — networking building blocks. No game rules in here.
//
//   NetClient     a WebSocket connection to the relay (server/server.mjs)
//   RemoteClock   estimates what time it is on another player's computer
//   Interpolator  stores timestamped updates and blends between them
//
// WHY INTERPOLATE? Updates arrive 20 times a second, and unevenly, because the
// network adds jitter. Drawing each update the moment it arrives would make
// other soldiers stutter. So we draw everyone else slightly IN THE PAST
// (NET.interpDelay = 100 ms). That way there are almost always two updates,
// one either side of the moment we're drawing, to blend between. Source calls
// this cl_interp; Quake 3 calls it snapshot interpolation. The cost is that
// you see other players 100 ms late.
// =============================================================================

export const now = () => performance.now() / 1000;
export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 100) / 100;
export const r3 = (v) => Math.round(v * 1000) / 1000;
export const r4 = (v) => Math.round(v * 10000) / 10000;

// ---------------------------------------------------------------- connection
export class NetClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.handlers = {};  // message type -> function(msg)
    this.waiting = {};   // message type -> one-off resolver (see request)
    this.onClose = null;
  }

  on(type, fn) { this.handlers[type] = fn; return this; }

  connect() {
    return new Promise((resolve, reject) => {
      let opened = false;
      const ws = (this.ws = new WebSocket(this.url));
      ws.onopen = () => { opened = true; resolve(); };
      ws.onclose = () => {
        this.ws = null;
        if (opened) this.onClose?.();
        else reject(new Error('Could not reach the co-op server'));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const wait = this.waiting[msg.t];
        if (wait) { wait(msg); return; }
        this.handlers[msg.t]?.(msg);
      };
    });
  }

  // Send a message and wait for the first reply of any of the given types.
  // No answer in time (e.g. an out-of-date server that doesn't know the
  // message) is an error, rather than waiting forever.
  request(msg, replyTypes, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { clear(); reject(new Error('No answer from the co-op server')); }, timeoutMs);
      const clear = () => { clearTimeout(timer); for (const t of replyTypes) delete this.waiting[t]; };
      for (const t of replyTypes) this.waiting[t] = (reply) => { clear(); resolve(reply); };
      this.send(msg);
    });
  }

  send(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  close() {
    this.onClose = null; // closing on purpose: not an error
    this.ws?.close();
  }
}

// ---------------------------------------------------------------- clock sync
// Each message carries the sender's clock reading `T`. Their clock and ours
// started at different moments, so we can't compare them directly. But
//     T - ourNow  =  (difference between the clocks) - (time the message took)
// so the LARGEST value we see belongs to the fastest message, and is the best
// guess at the clock difference. We let the estimate sink back slowly, so one
// lucky packet (or the clocks drifting apart) can't fool us forever.
export class RemoteClock {
  constructor() { this.offset = null; }

  sample(remoteT) {
    const o = remoteT - now();
    if (this.offset === null || o > this.offset) this.offset = o;
    else this.offset += (o - this.offset) * 0.002;
  }

  // The sender's clock right now (minus the fastest trip time we've seen).
  now() { return now() + (this.offset ?? 0); }
}

// ---------------------------------------------------------------- interpolation
// A state is a flat array of numbers, e.g. [x, y, z, yaw, ...]. `modes` says
// how to blend each slot.
export const LERP = 0;  // straight blend (positions)
export const ANGLE = 1; // blend the short way round (yaw: 359° -> 1° goes through 0°)
export const STEP = 2;  // don't blend; switch when we reach the newer update (alive, crouched)

const wrapAngle = (d) => { while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };

export class Interpolator {
  constructor(modes) {
    this.modes = modes;
    this.buf = []; // [{ t, v }] oldest first
    this.out = new Array(modes.length).fill(0);
  }

  push(t, values) {
    const b = this.buf;
    if (b.length && t <= b[b.length - 1].t) return; // duplicate or out of order
    b.push({ t, v: values });
    if (b.length > 40) b.shift();
  }

  get latest() { return this.buf.length ? this.buf[this.buf.length - 1].v : null; }

  // The state at time t, blended from the two updates either side of it.
  // Returns null until the first update arrives. If t is past the newest
  // update (a late packet), we hold the newest instead of guessing ahead.
  sample(t) {
    const b = this.buf, out = this.out, m = this.modes;
    if (!b.length) return null;
    while (b.length > 2 && b[1].t <= t) b.shift(); // drop updates we've moved past
    const a = b[0];
    if (b.length === 1 || t <= a.t) { for (let i = 0; i < m.length; i++) out[i] = a.v[i]; return out; }
    const c = b[1];
    if (t >= c.t) { for (let i = 0; i < m.length; i++) out[i] = c.v[i]; return out; }
    const k = (t - a.t) / (c.t - a.t);
    for (let i = 0; i < m.length; i++) {
      out[i] = m[i] === LERP ? a.v[i] + (c.v[i] - a.v[i]) * k
        : m[i] === ANGLE ? a.v[i] + wrapAngle(c.v[i] - a.v[i]) * k
        : a.v[i];
    }
    return out;
  }
}

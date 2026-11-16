// =============================================================================
// audio.js — every sound is SYNTHESISED with the Web Audio API (no files).
//
// A gunshot is layered like a sound designer would: a sharp high "crack", a
// mid "body", a low "thump", plus reverb for the echo off buildings. Distant
// sounds are realistic: they arrive LATE (speed of sound, 343 m/s), lose their
// high frequencies, and are positioned in 3D with HRTF panning (use headphones).
//
// Your own body has its own bus ("foley", the film term for footsteps, cloth
// and kit noises): footsteps per surface, left/right feet, gear rattle,
// breathing when you're out of breath, grunts when you're hit. Indoors, a
// small-room echo is added, so the same boots sound boxy inside a building.
// =============================================================================
import * as THREE from 'three';

const SPEED_OF_SOUND = 343;
const _p = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();
const rand = (a, b) => a + Math.random() * (b - a);

// Catching your breath after a gasp: [seconds after the gasp, inhale?, strength,
// length]. A big exhale, then short, deep breaths that slow and soften.
const RECOVERY_BREATHS = [
  [0.75, false, 1.5, 1.1],
  [1.3, true, 1.25, 0.75], [1.7, false, 1.3, 0.8],
  [2.3, true, 1.1, 0.75], [2.72, false, 1.1, 0.8],
  [3.45, true, 0.85, 0.8], [3.92, false, 0.85, 0.9],
];

// How loud each baked sample set plays (they are all normalised to the same
// peak, but a crunchy gravel step and a soft grass step don't FEEL the same).
const STEP_LEVEL = {
  dirt: 0.30, grass: 0.24, sand: 0.26, rock: 0.30, concrete: 0.30, asphalt: 0.30,
  wood: 0.34, metal: 0.30, cloth: 0.16, gear: 0.11,
};
const STEP_SETS = Object.keys(STEP_LEVEL);
const TAKES = 8; // variations "recorded" per surface

export class AudioSystem {
  // world (optional): lets the audio ask what's underfoot (enemy footsteps)
  // and what's overhead (indoors = small-room echo).
  constructor(world = null) {
    this.ctx = null;
    this.world = world;
    this.listenerPos = new THREE.Vector3();
    this.heartTimer = 0;
    this.bank = null;      // baked footstep samples: { dirt: [AudioBuffer x8], ... }
    this._lastTake = {};   // which take each set played last (never repeat one)
    this._side = 1;        // which foot (+1 right, -1 left)
    this._roomT = 0;       // seconds until we check for a roof again
    this._breathT = 0; this._inhaleNext = true; this._held = false;
    this._recovery = []; this._recoveryT = 0; // breaths still to come after a gasp
  }

  // Must be called from a click: browsers block audio until the user interacts.
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());

    this.master = ctx.createGain();
    this.master.gain.value = 0.75;
    const comp = ctx.createDynamicsCompressor(); // keeps loud gunfire from clipping
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 6;
    comp.attack.value = 0.002; comp.release.value = 0.25;
    // 'muffle' is a low-pass filter on everything: a nearby explosion closes it
    // down for a few seconds (shell-shocked hearing), then it opens back up.
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.master.connect(this.muffle).connect(comp).connect(ctx.destination);
    this.battleTimer = 8 + Math.random() * 10;

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(2.8);
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = 0.5;
    this.reverb.connect(this.reverbOut).connect(this.master);

    // "dry" bus for the player's own sounds (not positioned in 3D)
    this.dry = ctx.createGain();
    this.dry.connect(this.master);
    const drySend = ctx.createGain();
    drySend.gain.value = 0.55;
    this.dry.connect(drySend).connect(this.reverb);

    // "foley" bus: your boots, kit and breathing. Very close to your ears, so
    // only a touch of the big outdoor echo (footsteps don't echo off hills).
    this.foley = ctx.createGain();
    this.foley.connect(this.master);
    const foleySend = ctx.createGain();
    foleySend.gain.value = 0.08;
    this.foley.connect(foleySend).connect(this.reverb);

    // Small-room echo: short, dense reflections off nearby walls. It's fed by
    // your own sounds, and its level follows "is there a roof over my head?"
    // (see update), so walking into a building audibly changes the space.
    this.room = ctx.createConvolver();
    this.room.buffer = this._roomImpulse(0.8);
    this.roomSend = ctx.createGain();
    this.roomSend.gain.value = 0;
    this.dry.connect(this.roomSend);
    this.foley.connect(this.roomSend);
    this.roomSend.connect(this.room).connect(this.master);

    this.noise = this._noiseBuffer(3);
    this._ambience();
    this._bake().catch((e) => console.warn('footstep bake failed', e));
  }

  _noiseBuffer(sec) {
    const len = Math.floor(sec * this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Generated reverb impulse: discrete early echoes (walls) + a long outdoor tail.
  _impulse(sec) {
    const sr = this.ctx.sampleRate, len = Math.floor(sec * sr);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.5) * 0.35;
      for (const [t, a] of [[0.045, 0.5], [0.11, 0.38], [0.19, 0.3], [0.33, 0.22], [0.52, 0.15]]) {
        const at = Math.floor((t + ch * 0.007 + Math.random() * 0.01) * sr);
        for (let k = 0; k < 400 && at + k < len; k++) d[at + k] += (Math.random() * 2 - 1) * a * (1 - k / 400);
      }
    }
    return buf;
  }

  // A room's reverb: a cluster of hard early reflections (walls a few metres
  // away) and then a quick exponential decay (~0.8 s: a bare concrete room).
  _roomImpulse(sec) {
    const sr = this.ctx.sampleRate, len = Math.floor(sec * sr);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp((-9 * i) / sr) * 0.3;
      for (let k = 0; k < 10; k++) {
        const at = Math.floor(rand(0.003, 0.035) * sr);
        d[at] += (Math.random() < 0.5 ? -1 : 1) * (0.7 - k * 0.05);
      }
    }
    return buf;
  }

  // ---------------------------------------------------------------- baking
  // Footsteps play several times a second, so instead of building each one
  // from scratch we "record" a folder of takes once at load, like a sound
  // designer would: an OfflineAudioContext renders our synth recipes into
  // AudioBuffers as fast as the CPU can (no speakers involved). Playback then
  // picks a take (never the same one twice in a row) and nudges its pitch and
  // volume. That's exactly how games use recorded footstep samples, and why
  // they don't sound like a machine gun of identical clicks.
  async _bake() {
    const sr = this.ctx.sampleRate, SLOT = 0.9; // each take gets 0.9 s of tape
    const bank = {};
    await Promise.all(STEP_SETS.map(async (name) => {
      const oc = new OfflineAudioContext(1, Math.ceil(TAKES * SLOT * sr), sr);
      for (let v = 0; v < TAKES; v++) this._recipe(name, oc.destination, v * SLOT + 0.004);
      const tape = (await oc.startRendering()).getChannelData(0);
      bank[name] = [];
      for (let v = 0; v < TAKES; v++) {
        const take = tape.subarray(Math.floor(v * SLOT * sr), Math.floor((v + 1) * SLOT * sr));
        // normalise every take to the same peak, and trim the silent tail
        let peak = 1e-6, end = 0;
        for (let i = 0; i < take.length; i++) peak = Math.max(peak, Math.abs(take[i]));
        for (let i = 0; i < take.length; i++) if (Math.abs(take[i]) > peak * 0.002) end = i;
        const buf = this.ctx.createBuffer(1, end + 1, sr);
        const out = buf.getChannelData(0);
        for (let i = 0; i <= end; i++) out[i] = take[i] / peak;
        bank[name].push(buf);
      }
    }));
    this.bank = bank;
  }

  // Tiny random clicks spread over `spread` seconds: grit, gravel, sand grains
  // crushed under a boot. Most of them happen right at the impact.
  _grit(d, t, n, spread, lo, hi, gain) {
    for (let i = 0; i < n; i++) {
      this._burst(d, t + Math.random() ** 1.6 * spread, { dur: rand(0.004, 0.012), gain: gain * rand(0.3, 1), type: 'bandpass', freq: rand(lo, hi), q: 2.5 });
    }
  }

  // One footstep = HEEL strike, then the TOE rolls down 45–85 ms later, on
  // top of a low thud (your body weight through the sole). The surface adds
  // its own character: crunch, swish, knock, ring.
  _recipe(name, d, t) {
    const g = rand(0.045, 0.085); // heel-to-toe gap
    const thud = (gain, f = rand(75, 95)) => this._tone(d, t, { freq: f, freqEnd: 40, dur: 0.09, gain });
    switch (name) {
      case 'grass': // soft thud, blades swishing against the boot
        thud(0.35);
        this._burst(d, t, { dur: 0.06, gain: 0.35, type: 'lowpass', freq: 500 });
        this._burst(d, t, { dur: 0.16, gain: 0.22, type: 'bandpass', freq: rand(2500, 3800), q: 0.7, attack: 0.025 });
        this._burst(d, t + g, { dur: 0.1, gain: 0.12, type: 'bandpass', freq: rand(3000, 4500), q: 0.9, attack: 0.02 });
        this._grit(d, t, 6, 0.12, 4000, 8000, 0.08);
        break;
      case 'sand': // a soft, grainy crunch that keeps going as the sand settles
        thud(0.35);
        this._burst(d, t, { dur: 0.07, gain: 0.4, type: 'lowpass', freq: 400 });
        this._burst(d, t, { dur: 0.14, gain: 0.1, type: 'bandpass', freq: 2200, q: 0.6, attack: 0.02 });
        this._grit(d, t, 22, 0.16, 1200, 3200, 0.22);
        this._grit(d, t + g, 10, 0.08, 1500, 3500, 0.15);
        break;
      case 'rock': // hard click, a few loose stones
        thud(0.5);
        this._burst(d, t, { dur: 0.018, gain: 0.6, type: 'bandpass', freq: rand(1800, 2600), q: 1.4 });
        this._burst(d, t, { dur: 0.05, gain: 0.35, type: 'lowpass', freq: 700 });
        this._grit(d, t, 7, 0.07, 2500, 6000, 0.2);
        this._burst(d, t + g, { dur: 0.012, gain: 0.3, type: 'bandpass', freq: rand(2500, 3200), q: 2 });
        this._grit(d, t + g, 4, 0.04, 2500, 6000, 0.12);
        break;
      case 'concrete': // crisp heel-toe "tk-tak", sometimes a rubber-sole scuff
      case 'asphalt': { // asphalt: duller, with grit on top
        const asp = name === 'asphalt';
        thud(0.45);
        this._burst(d, t, { dur: 0.025, gain: 0.75, type: 'bandpass', freq: asp ? rand(1200, 1800) : rand(1500, 2200), q: 1.1 });
        this._burst(d, t, { dur: 0.045, gain: 0.4, type: 'lowpass', freq: 600 });
        this._burst(d, t + g, { dur: 0.016, gain: 0.4, type: 'bandpass', freq: rand(2400, 3200), q: 1.6 });
        if (Math.random() < 0.5) this._burst(d, t + g, { dur: 0.05, gain: 0.07, type: 'highpass', freq: 3500, attack: 0.015 });
        this._grit(d, t, asp ? 8 : 3, asp ? 0.08 : 0.05, asp ? 2500 : 4000, asp ? 7000 : 8000, asp ? 0.14 : 0.08);
        break;
      }
      case 'wood': { // hollow knock of the boards; old floors creak
        const f = rand(150, 230);
        thud(0.45, rand(90, 120));
        this._tone(d, t, { freq: f, dur: 0.14, gain: 0.32, type: 'triangle' });
        this._tone(d, t, { freq: f * 2.4, dur: 0.06, gain: 0.12 });
        this._burst(d, t, { dur: 0.06, gain: 0.5, type: 'bandpass', freq: rand(600, 900), q: 2.5 });
        this._burst(d, t + g, { dur: 0.04, gain: 0.3, type: 'bandpass', freq: rand(800, 1100), q: 2.5 });
        this._tone(d, t + g, { freq: f * 1.05, dur: 0.08, gain: 0.15, type: 'triangle' });
        if (Math.random() < 0.4) { // creak: wood rubbing on a nail is "stick-slip", a fast run of tiny clicks
          const n = 18 + ((Math.random() * 14) | 0), hz = rand(40, 90), cf = rand(700, 1100);
          for (let i = 0; i < n; i++) {
            const env = Math.sin((i / n) * Math.PI);
            this._burst(d, t + 0.06 + i / (hz * (1 + i / n * 0.3)), { dur: 0.006, gain: 0.06 * env, type: 'bandpass', freq: cf, q: 6 });
          }
        }
        break;
      }
      case 'metal': { // a steel plate rings with uneven ("inharmonic") overtones
        const f = rand(240, 380);
        this._tone(d, t, { freq: 85, dur: 0.18, gain: 0.35 }); // hollow boom of a container/deck
        [[1, 0.32, 0.1], [2.76, 0.2, 0.07], [5.4, 0.12, 0.045], [8.93, 0.07, 0.03]]
          .forEach(([m, dur, gain]) => this._tone(d, t, { freq: f * m, dur, gain, type: 'triangle' }));
        this._burst(d, t, { dur: 0.02, gain: 0.5, type: 'highpass', freq: 2500 });
        this._burst(d, t, { dur: 0.05, gain: 0.3, type: 'bandpass', freq: 1200, q: 2 });
        this._tone(d, t + g, { freq: f * 1.13, dur: 0.15, gain: 0.05, type: 'triangle' });
        this._burst(d, t + g, { dur: 0.012, gain: 0.3, type: 'highpass', freq: 3000 });
        break;
      }
      case 'cloth': // tarp, mattress, sandbags: a muffled pat
        thud(0.2);
        this._burst(d, t, { dur: 0.1, gain: 0.3, type: 'lowpass', freq: 600 });
        this._burst(d, t, { dur: 0.12, gain: 0.1, type: 'bandpass', freq: 1500, q: 0.6, attack: 0.02 });
        break;
      case 'gear': // your kit on each step: webbing rustle, mags knocking in pouches, sling clinks
        this._burst(d, t, { dur: rand(0.15, 0.25), gain: 0.25, type: 'bandpass', freq: rand(1000, 1800), q: 0.6, attack: 0.04 });
        this._burst(d, t + rand(0.01, 0.05), { dur: 0.03, gain: 0.2, type: 'bandpass', freq: rand(500, 800), q: 3 });
        this._burst(d, t + rand(0, 0.06), { dur: 0.008, gain: 0.15, type: 'bandpass', freq: 3000, q: 4 });
        for (let i = 2 + ((Math.random() * 3) | 0); i > 0; i--) {
          this._tone(d, t + rand(0, 0.08), { freq: rand(2600, 5200), dur: rand(0.03, 0.07), gain: rand(0.02, 0.05), type: 'triangle' });
        }
        break;
      default: // dirt / gravel: a dull thump with a gravelly crunch
        thud(0.45);
        this._burst(d, t, { dur: 0.09, gain: 0.55, type: 'lowpass', freq: rand(450, 650), freqEnd: 200 });
        this._grit(d, t, 9, 0.1, 1800, 5000, 0.17);
        this._burst(d, t + g, { dur: 0.05, gain: 0.3, type: 'lowpass', freq: 800 });
        this._grit(d, t + g, 5, 0.05, 2000, 5500, 0.12);
    }
  }

  // Play one baked take. rate < 1 = lower and slower (heavier); bright < 1
  // rolls off the top end (a careful, soft step); pan = which foot.
  _sample(dest, when, name, gain, { rate = 1, bright = 1, pan = 0 } = {}) {
    const takes = this.bank?.[name] || this.bank?.dirt;
    if (!takes) return; // still baking (first few milliseconds)
    let i = (Math.random() * takes.length) | 0;
    if (i === this._lastTake[name]) i = (i + 1) % takes.length;
    this._lastTake[name] = i;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = takes[i];
    src.playbackRate.value = rate * rand(0.94, 1.06);
    const g = ctx.createGain();
    g.gain.value = gain * (STEP_LEVEL[name] ?? 0.3) * rand(0.85, 1.15);
    let node = src;
    if (bright < 1) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1200 + 14000 * bright * bright;
      node = node.connect(f);
    }
    node = node.connect(g);
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node = node.connect(p);
    }
    node.connect(dest);
    src.start(when);
  }

  // Where should a sound at `pos` be plugged in? Returns { input, when }.
  _route(pos, ref = 4, rolloff = 1, reverb = 0.35) {
    const ctx = this.ctx;
    if (!pos) return { input: this.dry, when: ctx.currentTime, dist: 0 };
    const dist = pos.distanceTo(this.listenerPos);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(500, 18000 / (1 + dist / 22)); // air absorbs highs over distance
    const pan = new PannerNode(ctx, {
      panningModel: 'HRTF', distanceModel: 'inverse', refDistance: ref, rolloffFactor: rolloff, maxDistance: 2000,
      positionX: pos.x, positionY: pos.y, positionZ: pos.z,
    });
    lp.connect(pan).connect(this.master);
    const send = ctx.createGain();
    send.gain.value = Math.min(1.2, reverb * (1 + dist / 60));
    lp.connect(send).connect(this.reverb);
    return { input: lp, when: ctx.currentTime + dist / SPEED_OF_SOUND, dist };
  }

  // The two building blocks of every sound here. They use dest.context (not
  // this.ctx), so the same recipes can also render into an OfflineAudioContext.
  _burst(dest, when, { dur = 0.1, gain = 0.5, type = 'lowpass', freq = 1000, freqEnd = 0, q = 0.7, attack = 0.001 }) {
    const ctx = dest.context;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, when); f.Q.value = q;
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(when, Math.random() * 2);
    src.stop(when + dur + 0.05);
  }

  _tone(dest, when, { freq = 440, freqEnd = 0, dur = 0.1, gain = 0.3, type = 'sine' }) {
    const ctx = dest.context;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, when + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(gain, when + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    o.connect(g).connect(dest);
    o.start(when);
    o.stop(when + dur + 0.05);
  }

  // ---------------------------------------------------------------- weapons
  // Each gun has its own voice: [crack Hz, body Hz, thump Hz, body length s, loudness].
  // Bigger cartridges (7.62) are deeper and longer; 9 mm is snappier.
  gunshot(pos, kind = 'rifle', isPlayer = false, suppressed = false) {
    if (!this.ctx) return;
    const V = { rifle: [900, 1500, 100, 0.38, 1], pistol: [1300, 2000, 150, 0.3, 0.9], smg: [1200, 1800, 135, 0.28, 0.85],
      dmr: [700, 1200, 80, 0.5, 1.15], lmg: [850, 1400, 95, 0.4, 1.05], bolt: [600, 1000, 70, 0.6, 1.25] }[kind] || [900, 1500, 100, 0.38, 1];
    const [crack, body, thump, len, loud] = V;
    if (suppressed) {
      // No muzzle blast: a sharp "thwack" (the bullet's own supersonic crack is
      // still there downrange) plus the clatter of the action. Much less reverb.
      const { input, when } = this._route(isPlayer ? null : pos, 3, 1.4, 0.12);
      this._burst(input, when, { dur: 0.06, gain: 0.55 * loud, type: 'bandpass', freq: 1700, q: 1.1 });
      this._burst(input, when, { dur: 0.12, gain: 0.35 * loud, type: 'lowpass', freq: 700, freqEnd: 200 });
      if (isPlayer) this._burst(input, when + 0.03, { dur: 0.03, gain: 0.3, type: 'bandpass', freq: 3600, q: 3 });
      return;
    }
    const { input, when } = this._route(isPlayer ? null : pos, 8, 0.9, 0.45);
    this._burst(input, when, { dur: 0.07, gain: 1.0 * loud, type: 'highpass', freq: crack });               // crack
    this._burst(input, when, { dur: len, gain: 0.95 * loud, type: 'lowpass', freq: body, freqEnd: 260 });  // body
    this._tone(input, when, { freq: thump, freqEnd: 38, dur: 0.2 + len * 0.15, gain: 0.9 * loud });         // thump
    if (isPlayer) this._burst(input, when + 0.035, { dur: 0.03, gain: 0.22, type: 'bandpass', freq: 3600, q: 3 }); // action cycling
  }

  dryFire() { if (this.ctx) this._burst(this.dry, this.ctx.currentTime, { dur: 0.025, gain: 0.35, type: 'bandpass', freq: 4200, q: 6 }); }

  reload(part) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, d = this.dry;
    if (part === 'magOut') {
      this._burst(d, t, { dur: 0.06, gain: 0.4, type: 'bandpass', freq: 1800, q: 4 });
      this._burst(d, t + 0.05, { dur: 0.12, gain: 0.15, type: 'lowpass', freq: 900 });
    } else if (part === 'magIn') {
      this._burst(d, t, { dur: 0.05, gain: 0.35, type: 'lowpass', freq: 500 });
      this._burst(d, t + 0.02, { dur: 0.03, gain: 0.55, type: 'bandpass', freq: 2600, q: 5 });
    } else if (part === 'bolt') {
      this._burst(d, t, { dur: 0.035, gain: 0.5, type: 'bandpass', freq: 3000, q: 4 });
      this._burst(d, t + 0.07, { dur: 0.05, gain: 0.55, type: 'bandpass', freq: 1500, q: 3 });
    } else if (part === 'switch') {
      this._burst(d, t, { dur: 0.25, gain: 0.12, type: 'lowpass', freq: 1300 });
      this._burst(d, t + 0.18, { dur: 0.03, gain: 0.3, type: 'bandpass', freq: 2800, q: 5 });
    } else if (part === 'mode') {
      this._burst(d, t, { dur: 0.02, gain: 0.4, type: 'bandpass', freq: 3800, q: 6 });
    } else if (part === 'cloth') {
      this._burst(d, t, { dur: 0.4, gain: 0.1, type: 'bandpass', freq: 1500, q: 0.6 });
    }
  }

  shell(pos) {
    if (!this.ctx || pos.distanceTo(this.listenerPos) > 12) return;
    const { input, when } = this._route(pos, 1, 1.5, 0.1);
    const f = 3800 + Math.random() * 1800;
    this._tone(input, when, { freq: f, dur: 0.07, gain: 0.05, type: 'triangle' });
    this._tone(input, when + 0.08 + Math.random() * 0.05, { freq: f * 0.93, dur: 0.05, gain: 0.03, type: 'triangle' });
  }

  // ---------------------------------------------------------------- bullets
  impact(pos, surface) {
    if (!this.ctx || pos.distanceTo(this.listenerPos) > 90) return;
    const { input, when } = this._route(pos, 2, 1.3, 0.2);
    switch (surface) {
      case 'metal':
        this._tone(input, when, { freq: 1600 + Math.random() * 1600, dur: 0.3, gain: 0.22, type: 'triangle' });
        this._burst(input, when, { dur: 0.04, gain: 0.5, type: 'highpass', freq: 2500 });
        break;
      case 'wood':
        this._burst(input, when, { dur: 0.09, gain: 0.7, type: 'bandpass', freq: 650, q: 2 });
        break;
      case 'concrete':
      case 'rock':
      case 'asphalt':
        this._burst(input, when, { dur: 0.05, gain: 0.6, type: 'bandpass', freq: 2400, q: 1 });
        this._burst(input, when, { dur: 0.1, gain: 0.3, type: 'lowpass', freq: 700 });
        break;
      case 'flesh':
        this._burst(input, when, { dur: 0.1, gain: 0.8, type: 'lowpass', freq: 280 });
        break;
      case 'cloth':
        this._burst(input, when, { dur: 0.05, gain: 0.25, type: 'lowpass', freq: 1000 });
        break;
      default: // dirt / sand
        this._burst(input, when, { dur: 0.13, gain: 0.55, type: 'lowpass', freq: 520 });
    }
  }

  // Supersonic crack + whistle of a round passing close to your head.
  whiz(pos) {
    if (!this.ctx) return;
    const { input, when } = this._route(pos, 1, 1, 0.1);
    this._burst(input, when, { dur: 0.022, gain: 0.9, type: 'highpass', freq: 2600 });
    this._tone(input, when, { freq: 2400, freqEnd: 800, dur: 0.13, gain: 0.06 });
  }

  // ---------------------------------------------------------------- player
  // Footsteps sound like what you're standing on. intensity: ~0.35 crouched,
  // 0.75 walking, 1.2 sprinting. opt.side: which foot (-1 left, +1 right; it
  // alternates by itself if you leave it out). opt.gear: how much kit rattles
  // (1 = normal load, more when you carry more, 0 = none).
  footstep(intensity, surface = 'dirt', opt = {}) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = intensity;
    const side = opt.side ?? (this._side = -this._side);
    // Soft steps lose their top end (you place your foot); sprinting slams it down.
    const bright = Math.min(1, 0.3 + k * 0.6);
    this._sample(this.foley, t, surface, k, { pan: side * 0.15, bright, rate: k < 0.5 ? 0.92 : k > 1 ? 1.04 : 1 });
    const gear = (opt.gear ?? 1) * Math.max(0, k - 0.25);
    if (gear > 0) this._sample(this.foley, t + rand(0.01, 0.04), 'gear', gear, { pan: side * 0.08 });
  }

  // Hitting the ground after a jump or a fall: both boots at once, knees bend,
  // the whole kit slams down. speed = how fast you were falling (m/s).
  land(speed, surface = 'dirt') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = Math.min(1.8, 0.5 + speed / 7);
    this._sample(this.foley, t, surface, k, { pan: -0.15, rate: 0.9 });
    this._sample(this.foley, t + rand(0.012, 0.035), surface, k * 0.85, { pan: 0.15, rate: 0.88 });
    this._tone(this.foley, t, { freq: 70, freqEnd: 32, dur: 0.18, gain: 0.25 * k }); // body weight
    this._sample(this.foley, t + 0.03, 'gear', 1.2 * k);
    if (speed > 6) this.breath(false, 0.6); // the air gets knocked out of you
  }

  // Pushing off for a jump: a boot scuff, the kit lifts, a short "hup".
  jump(surface = 'dirt') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._sample(this.foley, t, surface, 0.55, { bright: 0.7, rate: 1.1 });
    this._sample(this.foley, t + 0.02, 'gear', 0.8);
    this._burst(this.foley, t + 0.03, { dur: 0.15, gain: 0.05, type: 'bandpass', freq: 900, q: 1, attack: 0.02 });
  }

  crawl() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._burst(this.foley, t, { dur: 0.3, gain: 0.07, type: 'bandpass', freq: 900 + Math.random() * 400, q: 0.7, attack: 0.05 });
    this._burst(this.foley, t + 0.05, { dur: 0.2, gain: 0.05, type: 'lowpass', freq: 400 });
    if (Math.random() < 0.5) this._sample(this.foley, t + rand(0.05, 0.15), 'gear', 0.35);
  }

  // One breath through the mouth. A breath is just shaped noise: the exhale
  // is a low "hhh" (mouth open, resonance around 700 Hz), the inhale is
  // shorter, higher and sharper. len stretches or shortens it.
  breath(inhale, strength = 1, len = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, d = this.foley, s = strength, L = len;
    if (inhale) {
      this._burst(d, t, { dur: 0.34 * L, gain: 0.13 * s, type: 'bandpass', freq: 1500, freqEnd: 2300, q: 0.9, attack: 0.15 * L });
      this._burst(d, t, { dur: 0.3 * L, gain: 0.06 * s, type: 'highpass', freq: 3500, attack: 0.13 * L });
    } else {
      this._burst(d, t, { dur: 0.45 * L, gain: 0.17 * s, type: 'bandpass', freq: 750, freqEnd: 500, q: 0.8, attack: 0.05 * L });
      this._burst(d, t, { dur: 0.35 * L, gain: 0.08 * s, type: 'bandpass', freq: 1700, q: 1.5, attack: 0.04 * L });
    }
  }

  // Held your breath until you couldn't any more: a deep, ragged gasp. It's
  // an inhale like the one above, but longer and much bigger: a sharp catch
  // in the throat, then a long pull of air that rises in pitch as the chest
  // fills. Under it, a breathy "ah" from the vocal cords (the throat catching).
  gasp() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, d = this.foley;
    this._burst(d, t, { dur: 0.28, gain: 0.2, type: 'bandpass', freq: 900, freqEnd: 1600, q: 1.1, attack: 0.03 }); // the catch
    this._burst(d, t + 0.06, { dur: 0.7, gain: 0.24, type: 'bandpass', freq: 1100, freqEnd: 2600, q: 0.8, attack: 0.3 }); // the pull
    this._burst(d, t + 0.06, { dur: 0.62, gain: 0.09, type: 'highpass', freq: 3200, attack: 0.28 });
    this._burst(d, t, { dur: 0.6, gain: 0.1, type: 'lowpass', freq: 380, attack: 0.12 }); // chest
    const voice = ctx.createOscillator(), env = ctx.createGain();
    voice.type = 'sawtooth';
    voice.frequency.setValueAtTime(rand(150, 175), t);
    voice.frequency.exponentialRampToValueAtTime(rand(225, 255), t + 0.3);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(0.035, t + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    voice.connect(env);
    for (const [f, q] of [[750, 6], [1250, 8]]) { // "ah" mouth shape
      const formant = ctx.createBiquadFilter();
      formant.type = 'bandpass'; formant.frequency.value = f; formant.Q.value = q;
      env.connect(formant).connect(d);
    }
    voice.start(t);
    voice.stop(t + 0.4);
  }

  // A pained "hnh" when you're hit. Mostly breath pushed out through an "uh"
  // mouth shape: two vocal-tract resonances (formants) at ~550 and ~1400 Hz,
  // with a quiet buzz of the vocal cords under it.
  _grunt(when, s) {
    const ctx = this.ctx;
    const f0 = rand(105, 135);
    const voice = ctx.createOscillator();
    voice.type = 'sawtooth';
    voice.frequency.setValueAtTime(f0 * 1.15, when);
    voice.frequency.exponentialRampToValueAtTime(f0 * 0.8, when + 0.22);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.linearRampToValueAtTime(0.05 * s, when + 0.025);
    env.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);
    voice.connect(env);
    for (const [f, q] of [[550, 5], [1400, 7]]) {
      const formant = ctx.createBiquadFilter();
      formant.type = 'bandpass'; formant.frequency.value = f; formant.Q.value = q;
      env.connect(formant).connect(this.foley);
    }
    voice.start(when);
    voice.stop(when + 0.3);
    this._burst(this.foley, when, { dur: 0.2, gain: 0.1 * s, type: 'bandpass', freq: 650, q: 1.4, attack: 0.02 });
    this._burst(this.foley, when, { dur: 0.16, gain: 0.05 * s, type: 'bandpass', freq: 1400, q: 2, attack: 0.02 });
  }

  // ---------------------------------------------------------------- grenades
  pin() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._burst(this.dry, t, { dur: 0.03, gain: 0.4, type: 'bandpass', freq: 3500, q: 5 });
    this._tone(this.dry, t + 0.12, { freq: 2600, freqEnd: 1800, dur: 0.15, gain: 0.05, type: 'triangle' }); // spoon flies off
  }

  throwWhoosh() {
    if (!this.ctx) return;
    this._burst(this.dry, this.ctx.currentTime, { dur: 0.25, gain: 0.18, type: 'bandpass', freq: 600, freqEnd: 1800, q: 1.2, attack: 0.05 });
  }

  grenadeBounce(pos) {
    if (!this.ctx || pos.distanceTo(this.listenerPos) > 40) return;
    const { input, when } = this._route(pos, 2, 1.3, 0.15);
    this._burst(input, when, { dur: 0.06, gain: 0.5, type: 'bandpass', freq: 1200 + Math.random() * 500, q: 3 });
    this._tone(input, when, { freq: 2100 + Math.random() * 600, dur: 0.1, gain: 0.05, type: 'triangle' });
  }

  // A smoke grenade igniting: a soft pop, then a long hiss as it pours out smoke.
  smokePop(pos) {
    if (!this.ctx || pos.distanceTo(this.listenerPos) > 60) return;
    const { input, when } = this._route(pos, 4, 1, 0.3);
    this._burst(input, when, { dur: 0.08, gain: 0.35, type: 'lowpass', freq: 700 });
    this._burst(input, when + 0.05, { dur: 2.8, gain: 0.22, type: 'highpass', freq: 2500, freqEnd: 1600, attack: 0.15 });
  }

  // A frag grenade going off: a sharp crack, a huge low boom, a long rumble
  // tail, then debris pattering down. Far away you hear mostly the rumble.
  explosion(pos) {
    if (!this.ctx) return;
    const dist = pos.distanceTo(this.listenerPos);
    const { input, when } = this._route(pos, 12, 0.8, 0.9);
    this._burst(input, when, { dur: 0.12, gain: 1.0, type: 'highpass', freq: 700 });
    this._burst(input, when, { dur: 1.6, gain: 1.0, type: 'lowpass', freq: 900, freqEnd: 120 });
    this._tone(input, when, { freq: 70, freqEnd: 25, dur: 0.9, gain: 1.0 });
    if (dist < 60) for (let i = 0; i < 7; i++) {
      this._burst(input, when + 0.4 + Math.random() * 1.2, { dur: 0.05, gain: 0.08, type: 'bandpass', freq: 1500 + Math.random() * 2000, q: 2 });
    }
    if (dist < 9) this.deafen(1 - dist / 9);
  }

  // A flashbang: no rumble or debris, just one enormous, bright CRACK. Close
  // by, it leaves you deaf and ringing for several seconds, even if you
  // weren't looking at it.
  flashbang(pos) {
    if (!this.ctx) return;
    const dist = pos.distanceTo(this.listenerPos);
    const { input, when } = this._route(pos, 14, 0.8, 0.8);
    this._burst(input, when, { dur: 0.09, gain: 1.0, type: 'highpass', freq: 1200 });
    this._burst(input, when, { dur: 0.5, gain: 0.8, type: 'bandpass', freq: 2200, freqEnd: 600, q: 0.6 });
    this._tone(input, when, { freq: 110, freqEnd: 40, dur: 0.3, gain: 0.6 });
    if (dist < 14) this.deafen(Math.min(1, 1.15 - dist / 14));
  }

  // Shell shock: muffle everything and ring, then recover over a few seconds.
  deafen(amount) {
    if (!this.ctx || amount <= 0) return;
    this._muffle(Math.max(300, 2000 * (1 - amount)), 2 + amount * 4);
    this._tone(this.dry, this.ctx.currentTime, { freq: 3800, dur: 2 + amount * 3, gain: 0.05 * amount });
  }

  // Close the "hearing" filter down to `freq` Hz, then open it again over
  // `seconds`. A small muffle never cuts short a bigger one already running.
  _muffle(freq, seconds) {
    const t = this.ctx.currentTime, f = this.muffle.frequency;
    const end = Math.max(this._muffleEnd || 0, t + seconds);
    const now = Math.min(f.value, freq);
    f.cancelScheduledValues(t);
    f.setValueAtTime(now, t);
    f.exponentialRampToValueAtTime(20000, end);
    this._muffleEnd = end;
  }

  // Radio blip when you spot an enemy
  radio() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._burst(this.dry, t, { dur: 0.08, gain: 0.08, type: 'bandpass', freq: 2000, q: 1 });
    this._tone(this.dry, t + 0.02, { freq: 1250, dur: 0.06, gain: 0.05, type: 'square' });
    this._tone(this.dry, t + 0.1, { freq: 1650, dur: 0.06, gain: 0.05, type: 'square' });
  }

  // Somewhere far away, someone else's war: a distant explosion or machine gun.
  _distantBattle() {
    const a = Math.random() * Math.PI * 2, r = 600 + Math.random() * 900;
    const pos = this.listenerPos.clone().add({ x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r });
    const { input, when } = this._route(pos, 40, 1, 1.2);
    if (Math.random() < 0.45) {
      this._burst(input, when, { dur: 2.2, gain: 0.9, type: 'lowpass', freq: 260, freqEnd: 80 });
      this._tone(input, when, { freq: 45, freqEnd: 25, dur: 1.2, gain: 0.6 });
    } else {
      const n = 4 + ((Math.random() * 8) | 0);
      for (let i = 0; i < n; i++) this._burst(input, when + i * 0.09, { dur: 0.18, gain: 0.6, type: 'lowpass', freq: 500 });
    }
  }

  // Other soldiers' boots (enemies and squadmates), in 3D, on whatever THEY
  // are standing on. Running soldiers also rattle their kit, so you can hear
  // someone charging round the corner.
  enemyFootstep(pos, intensity) {
    if (!this.ctx || pos.distanceTo(this.listenerPos) > 28) return;
    const surface = this.world ? this.world.surfaceUnder(pos) : 'dirt';
    const { input, when } = this._route(pos, 1.5, 1.6, 0.1);
    this._sample(input, when, surface, 1.6 * intensity, { bright: 0.55 + 0.4 * intensity });
    if (intensity > 0.8) this._sample(input, when + rand(0.01, 0.04), 'gear', 1.2 * intensity);
  }

  hitmarker(kill) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._burst(this.dry, t, { dur: 0.018, gain: 0.18, type: 'bandpass', freq: 5000, q: 4 });
    if (kill) this._burst(this.dry, t + 0.05, { dur: 0.06, gain: 0.25, type: 'lowpass', freq: 300 });
  }

  // You've been hit. kind: 'body' | 'armor' (a plate stopped part of it) |
  // 'head' | 'blast' (grenade) | 'fall'.
  hurt(amount = 20, kind = 'body') {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, d = this.dry, k = Math.min(1.4, 0.4 + amount / 30);
    if (kind === 'body' || kind === 'armor' || kind === 'head') {
      // The round arriving: a dull, heavy slap you feel more than hear
      this._burst(d, t, { dur: 0.09, gain: 0.75 * k, type: 'lowpass', freq: 650, freqEnd: 150 });
      this._tone(d, t, { freq: 115, freqEnd: 40, dur: 0.16, gain: 0.55 * k });
    }
    if (kind === 'armor') { // ceramic/steel plate: a hard "tok" with a short ring
      this._burst(d, t, { dur: 0.03, gain: 0.4, type: 'bandpass', freq: 2600, q: 2 });
      this._tone(d, t, { freq: rand(1550, 1900), dur: 0.18, gain: 0.06, type: 'triangle' });
    }
    if (kind === 'fall') this._burst(d, t, { dur: 0.05, gain: 0.25, type: 'bandpass', freq: 1800, q: 3 }); // knees/kit crack
    this._grunt(t + 0.03, Math.min(1, k));
    // The shock dulls your hearing for a moment; a hit to the head rings your bell.
    if (kind === 'head') this.deafen(0.55);
    else if (kind !== 'blast') this._muffle(Math.max(900, 6000 - amount * 140), 0.4 + amount / 45);
  }

  // Killed: hearing closes right down and one last slow heartbeat.
  death() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._muffle(320, 6);
    this._tone(this.dry, t + 0.3, { freq: 52, dur: 0.18, gain: 0.45 });
    this._tone(this.dry, t + 0.55, { freq: 45, dur: 0.15, gain: 0.3 });
  }

  // ---------------------------------------------------------------- loop
  _ambience() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    const lfo = ctx.createOscillator(); // slow gusts
    lfo.frequency.value = 0.08;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.035;
    lfo.connect(lfoGain).connect(g.gain);
    src.connect(lp).connect(g).connect(this.master);
    src.start();
    lfo.start();
  }

  setListener(camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    camera.getWorldPosition(_p);
    camera.getWorldDirection(_f);
    _u.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.listenerPos.copy(_p);
    if (l.positionX) {
      l.positionX.value = _p.x; l.positionY.value = _p.y; l.positionZ.value = _p.z;
      l.forwardX.value = _f.x; l.forwardY.value = _f.y; l.forwardZ.value = _f.z;
      l.upX.value = _u.x; l.upY.value = _u.y; l.upZ.value = _u.z;
    } else {
      l.setPosition(_p.x, _p.y, _p.z);
      l.setOrientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z);
    }
  }

  // p = the player ({ health, alive, stamina, holdingBreath, outOfBreath }). The old call
  // update(dt, health, alive) still works (just without breathing).
  update(dt, p, alive) {
    if (!this.ctx) return;
    const me = typeof p === 'number' ? { health: p, alive, stamina: 100 } : p;
    if ((this.battleTimer -= dt) <= 0) {
      this.battleTimer = 14 + Math.random() * 35;
      this._distantBattle();
    }
    this._room(dt);
    if (me.alive) this._breathing(dt, me);
    else { this._held = false; this._recovery.length = 0; }
    if (!me.alive || me.health >= 35) { this.heartTimer = 0; return; }
    this.heartTimer -= dt;
    if (this.heartTimer <= 0) {
      this.heartTimer = 60 / (72 + (35 - me.health) * 2);
      const t = this.ctx.currentTime; // "lub-dub": two thumps you feel in your chest
      this._tone(this.dry, t, { freq: 58, dur: 0.14, gain: 0.4 });
      this._burst(this.dry, t, { dur: 0.08, gain: 0.2, type: 'lowpass', freq: 120 });
      this._tone(this.dry, t + 0.2, { freq: 50, dur: 0.12, gain: 0.28 });
    }
  }

  // Indoors? Every quarter second, look for something solid over your head
  // (a roof or upper floor; tents and camo nets don't count), and fade the
  // small-room echo in or out smoothly so doorways don't "click".
  _room(dt) {
    if (!this.world || (this._roomT -= dt) > 0) return;
    this._roomT = 0.25;
    const p = this.listenerPos;
    let covered = false;
    for (const c of this.world._collect(p.x - 0.1, p.y + 0.3, p.z - 0.1, p.x + 0.1, p.y + 7, p.z + 0.1)) {
      if (c.solid && c.surface !== 'cloth') { covered = true; break; }
    }
    this.indoors = covered;
    this.roomSend.gain.setTargetAtTime(covered ? 0.5 : 0, this.ctx.currentTime, 0.25);
  }

  // Your own breathing. Sprinting doesn't make you pant (running out of
  // stamina just slows you to a jog). Holding your breath to aim (Shift while
  // aiming) is a sharp inhale, silence, then an exhale when you let go. Hold
  // it until it runs out and you gasp for air, then catch your breath with a
  // few short, deep breaths that ease off. Badly wounded, you breathe heavily.
  _breathing(dt, me) {
    const tired = 1 - Math.max(0, Math.min(1, (me.stamina ?? 100) / 100));
    if (me.holdingBreath) {
      if (!this._held) { this._held = true; this._recovery.length = 0; this.breath(true, 0.8); }
      this._breathT = 0.6;
      return;
    }
    if (this._held) { // let it out
      this._held = false;
      if (me.outOfBreath) {
        this.gasp();
        this._recovery = RECOVERY_BREATHS.slice();
        this._recoveryT = 0;
      } else {
        this.breath(false, 0.9 + tired);
        this._breathT = 0.7;
        this._inhaleNext = true;
      }
      return;
    }
    if (this._recovery.length) { // catching your breath after the gasp
      this._recoveryT += dt;
      while (this._recovery.length && this._recovery[0][0] <= this._recoveryT) {
        const [, inhale, strength, len] = this._recovery.shift();
        this.breath(inhale, strength, len);
      }
      this._breathT = 0.8;
      this._inhaleNext = true;
      return;
    }
    const effort = me.health < 35 ? 0.35 : 0;
    if (effort === 0) { this._breathT = Math.min(this._breathT, 0.3); return; }
    if ((this._breathT -= dt) > 0) return;
    const period = 3.2 - effort * 2.2; // seconds per breath (~2.4 s)
    this.breath(this._inhaleNext, 0.3 + effort);
    this._breathT = period * (this._inhaleNext ? 0.42 : 0.58);
    this._inhaleNext = !this._inhaleNext;
  }
}

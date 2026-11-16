// =============================================================================
// voice.js — squad voice chat, browser to browser (WebRTC).
//
// HOW IT WORKS:
//   • Every pair of players in the room gets one RTCPeerConnection: a direct
//     audio link between their two browsers (a "mesh"; with 4 players that's
//     6 links). Voice never goes through our server.
//   • To set a link up, the two browsers swap a few small messages: an
//     "offer", an "answer", and "ICE candidates", which are network addresses
//     to try. That's called SIGNALLING, and it goes through our lobby server
//     as 'sig' messages (see server/server.mjs). The player with the lower id
//     always makes the offer, so two offers never cross.
//   • A STUN server (config VOICE.iceServers) tells each browser its public
//     address, so links can cross home routers. Very strict networks also
//     need a TURN server: a relay on the internet that passes the audio
//     along. If the game server has one set up (README: "Voice chat"), its
//     address and a short-lived password arrive in the 'welcome' message as
//     coop.ice. With ice.relayOnly, ALL audio goes through the relay, so
//     players never learn each other's home IP address.
//   • The microphone needs a "secure context": localhost or https://. That's
//     why `npm start` also serves the game over HTTPS (see the README).
//
// Push-to-talk (hold B) or an open mic. Your mic only sends while you talk;
// the rest of the time the browser sends silence.
// =============================================================================
import { VOICE } from './config.js';

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const typing = (e) => e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);

export class VoiceChat {
  constructor(coop) {
    this.coop = coop;
    this.peers = new Map();        // player id -> { pc, audio, sender, meter, level, talking, quiet }
    this.mutedIds = new Set();     // players you've muted
    this.mic = null;               // the raw microphone track (always on, for the level meter)
    this.sendTrack = null;         // a copy of it that we switch on only while you talk
    this.micMeter = null;
    this.micLevel = 0;
    this.pttDown = false;
    this.transmitting = false;
    this.mode = store.get('dustline.voice.mode', 'ptt'); // 'ptt' | 'open'
    this.volume = parseFloat(store.get('dustline.voice.volume', '1')) || 1;
    this.ctx = null;               // an AudioContext, only for measuring levels
    this.error = '';
    this.onChange = null;          // UI refresh (someone started or stopped talking, mic on/off...)

    window.addEventListener('keydown', (e) => {
      if (e.code !== VOICE.pttKey || e.repeat || typing(e)) return;
      this.pttDown = true;
    });
    window.addEventListener('keyup', (e) => { if (e.code === VOICE.pttKey) this.pttDown = false; });
    window.addEventListener('blur', () => { this.pttDown = false; });
    // Browsers only let audio start after a click or key press
    const wake = () => { this._ensureContext(); window.removeEventListener('pointerdown', wake); };
    window.addEventListener('pointerdown', wake);
  }

  // Can this page use a microphone? (needs https:// or localhost)
  get canTalk() { return !!(window.isSecureContext && navigator.mediaDevices?.getUserMedia); }
  get micOn() { return !!this.mic; }
  isTalking(id) { return id === this.coop.myId ? this.transmitting : !!this.peers.get(id)?.talking; }
  isMuted(id) { return this.mutedIds.has(id); }

  // ------------------------------------------------------------------ settings
  setMode(mode) { this.mode = mode === 'open' ? 'open' : 'ptt'; store.set('dustline.voice.mode', this.mode); this._changed(); }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    store.set('dustline.voice.volume', String(this.volume));
    for (const p of this.peers.values()) p.audio.volume = this.volume;
  }

  toggleMute(id) {
    if (this.mutedIds.has(id)) this.mutedIds.delete(id); else this.mutedIds.add(id);
    const p = this.peers.get(id);
    if (p) p.audio.muted = this.mutedIds.has(id);
    this._changed();
  }

  // ------------------------------------------------------------------ microphone
  async enableMic() {
    if (this.mic) return true;
    if (!this.canTalk) { this.error = 'Voice needs the https:// address (or localhost).'; this._changed(); return false; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.mic = stream.getAudioTracks()[0];
    } catch (err) {
      this.error = err.name === 'NotAllowedError' ? 'Microphone blocked. Allow it in the address bar, then try again.' : 'No microphone found.';
      this._changed();
      return false;
    }
    this.error = '';
    this.sendTrack = this.mic.clone();
    this.sendTrack.enabled = false;
    this._ensureContext();
    this.micMeter = this._meter(new MediaStream([this.mic]));
    for (const p of this.peers.values()) p.sender?.replaceTrack(this.sendTrack);
    store.set('dustline.voice.mic', '1');
    this.coop.setMic(true);
    this._changed();
    return true;
  }

  disableMic() {
    for (const p of this.peers.values()) p.sender?.replaceTrack(null);
    this.mic?.stop();
    this.sendTrack?.stop();
    this.micMeter?.close();
    this.mic = this.sendTrack = this.micMeter = null;
    this.transmitting = false;
    store.set('dustline.voice.mic', '0');
    this.coop.setMic(false);
    this._changed();
  }

  // After a reload (e.g. the host changed map): switch the mic back on by
  // itself, but only if you'd turned it on and the browser remembers the
  // permission, so no surprise prompts.
  async restoreMic() {
    if (store.get('dustline.voice.mic', '0') !== '1' || !this.canTalk) return;
    try {
      const perm = await navigator.permissions?.query({ name: 'microphone' });
      if (perm?.state === 'granted') await this.enableMic();
    } catch { /* this browser can't tell us; wait for a click */ }
  }

  // ------------------------------------------------------------------ connections
  // Called whenever the room changes: one link per online squadmate.
  sync(room) {
    const me = this.coop.myId;
    const online = new Set(room.players.filter((p) => p.online && p.id !== me).map((p) => p.id));
    for (const id of [...this.peers.keys()]) if (!online.has(id)) this._close(id);
    for (const id of online) if (!this.peers.has(id) && me < id) this._call(id);
  }

  closeAll() { for (const id of [...this.peers.keys()]) this._close(id); }

  _peer(id) {
    this._close(id); // a fresh link replaces any old one (e.g. they reloaded)
    const ice = this.coop.ice; // TURN relay from the server, or null
    const pc = new RTCPeerConnection({
      iceServers: [...VOICE.iceServers, ...(ice?.servers || [])],
      iceTransportPolicy: ice?.relayOnly ? 'relay' : 'all',
    });
    const audio = new Audio();
    audio.autoplay = true;
    audio.volume = this.volume;
    audio.muted = this.mutedIds.has(id);
    const p = { id, pc, audio, sender: null, meter: null, level: 0, talking: false, quiet: 0, pendingIce: [] };
    pc.onicecandidate = (e) => { if (e.candidate) this.coop.sendSignal(id, { ice: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      audio.play().catch(() => {}); // starts once you've clicked anything on the page
      this._ensureContext();
      p.meter?.close();
      p.meter = this._meter(audio.srcObject);
    };
    pc.onconnectionstatechange = () => {
      // Lost the link (network change): the offering side dials again
      if (pc.connectionState === 'failed' && this.coop.myId < id && this.peers.get(id) === p) this._call(id);
    };
    this.peers.set(id, p);
    return p;
  }

  async _call(id) {
    const p = this._peer(id);
    const tr = p.pc.addTransceiver('audio', { direction: 'sendrecv' });
    p.sender = tr.sender;
    if (this.sendTrack) await tr.sender.replaceTrack(this.sendTrack);
    await p.pc.setLocalDescription(await p.pc.createOffer());
    this.coop.sendSignal(id, { sdp: p.pc.localDescription.toJSON() });
  }

  // A signalling message from another player (through the lobby server)
  async onSignal(from, d) {
    if (!d || !this.coop.room?.players.some((pl) => pl.id === from && pl.online)) return;
    try {
      if (d.sdp?.type === 'offer') {
        const p = this._peer(from);
        await p.pc.setRemoteDescription(d.sdp);
        const tr = p.pc.getTransceivers()[0];
        if (tr) { tr.direction = 'sendrecv'; p.sender = tr.sender; if (this.sendTrack) await tr.sender.replaceTrack(this.sendTrack); }
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        this.coop.sendSignal(from, { sdp: p.pc.localDescription.toJSON() });
        await this._flushIce(p);
      } else if (d.sdp?.type === 'answer') {
        const p = this.peers.get(from);
        if (!p || p.pc.signalingState !== 'have-local-offer') return;
        await p.pc.setRemoteDescription(d.sdp);
        await this._flushIce(p);
      } else if (d.ice) {
        const p = this.peers.get(from);
        if (!p) return;
        if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.ice);
        else p.pendingIce.push(d.ice); // arrived before the offer/answer was applied
      }
    } catch (err) {
      console.warn('voice signalling', err);
    }
  }

  async _flushIce(p) {
    for (const c of p.pendingIce.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
  }

  _close(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    p.meter?.close();
    p.pc.close();
    p.audio.srcObject = null;
    if (p.talking) this._changed();
  }

  // ------------------------------------------------------------------ levels
  _ensureContext() {
    if (!this.ctx) { try { this.ctx = new AudioContext(); } catch { return; } }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  // A level meter on a stream: how loud is it right now (RMS, 0..1)?
  _meter(stream) {
    if (!this.ctx) return null;
    const src = this.ctx.createMediaStreamSource(stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 512;
    const sink = this.ctx.createGain();
    sink.gain.value = 0; // keeps the analyser running without playing the sound twice
    src.connect(an).connect(sink).connect(this.ctx.destination);
    const buf = new Float32Array(an.fftSize);
    return {
      level() { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; return Math.sqrt(s / buf.length); },
      close() { src.disconnect(); an.disconnect(); sink.disconnect(); },
    };
  }

  // Every frame: decide whether we're transmitting, and who's talking.
  update(dt) {
    let changed = false;
    if (this.mic) {
      this.micLevel = this.micMeter ? this.micMeter.level() : 0;
      // Open mic: transmit while you're louder than the threshold, plus a short "hangover"
      // so words don't get clipped between syllables.
      if (this.micLevel > VOICE.talkThreshold) this.micQuiet = 0; else this.micQuiet = (this.micQuiet || 0) + dt;
      const tx = this.mode === 'ptt' ? this.pttDown : this.micQuiet < 0.4;
      if (tx !== this.transmitting) { this.transmitting = tx; this.sendTrack.enabled = tx; this._squelch(); changed = true; }
    }
    for (const p of this.peers.values()) {
      if (!p.meter) continue;
      p.level = p.meter.level();
      p.quiet = p.level > VOICE.talkThreshold ? 0 : p.quiet + dt;
      const talking = p.quiet < 0.3 && !p.audio.muted;
      if (talking !== p.talking) { p.talking = talking; if (talking) this._squelch(); changed = true; }
    }
    if (changed) this._changed();
  }

  // A short radio click when a transmission starts
  _squelch() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const len = Math.floor(ctx.sampleRate * 0.04), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf;
    bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.5;
    g.gain.value = 0.12 * this.volume;
    src.connect(bp).connect(g).connect(ctx.destination);
    src.start();
  }

  _changed() { this.onChange?.(); }
}

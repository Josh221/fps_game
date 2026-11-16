// =============================================================================
// campaign/radio.js — radio messages: subtitles, a click of static, and a
// spoken voice.
//
// The voices come from the browser's own text-to-speech (the Web Speech API,
// speechSynthesis). Every computer has a different set of voices, so each
// character (story.js CAST) asks for a male or female English voice, and we
// pick from whatever this browser has, then change its pitch and speed so
// the characters sound different from each other. A real game would record
// actors instead; this way the dialogue can be edited like any other text.
//
// Voices can be switched off on the main menu (subtitles always show).
// While a mission's radio is JAMMED, messages arrive broken up.
// =============================================================================
import { CAST } from './story.js';

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
const FEMALE = /samantha|karen|moira|tessa|serena|victoria|kate|fiona|susan|zira|martha|female|catherine|allison|ava|joanna|nicky|shelley|flo|sandy/i;
const MALE = /daniel|alex|fred|tom|oliver|arthur|rishi|aaron|male|david|mark|gordon|lee|james|ralph|eddy|reed|rocko|grandpa/i;

// "Sabre, Shepherd. The jammer is on the mast." -> "Sabre, Shep— …mmer is— …mast."
function garble(text) {
  const words = text.split(' ');
  let out = '', gap = false;
  for (const w of words) {
    if (Math.random() < 0.45) { if (!gap) out += ' …'; gap = true; continue; }
    out += ' ' + (Math.random() < 0.25 ? w.slice(0, Math.ceil(w.length / 2)) + '—' : w); // half a word, cut off
    gap = false;
  }
  return out.trim();
}

export class Radio {
  constructor(audio) {
    this.audio = audio;
    this.queue = [];
    this.cur = null;     // { who, text, t }
    this.gap = 0;        // a short pause between lines
    this.speaking = false;
    this.voiceOn = store.get('dustline.radiovoice', '1') !== '0';
    this.synth = window.speechSynthesis || null;
    this.voices = [];
    this.picked = new Map(); // speaker -> voice
    const load = () => { this.voices = (this.synth?.getVoices() || []).filter((v) => /^en/i.test(v.lang)); this.picked.clear(); };
    if (this.synth) { load(); this.synth.addEventListener?.('voiceschanged', load); }

    this.el = document.createElement('div');
    this.el.id = 'radio';
    this.el.innerHTML = '<div class="who"></div><div class="line"></div>';
    document.getElementById('hud').appendChild(this.el);
  }

  setVoice(on) {
    this.voiceOn = on;
    store.set('dustline.radiovoice', on ? '1' : '0');
    if (!on) this.synth?.cancel();
  }

  // Queue a mission's radio message (story.js `radio[key]`): one or more lines
  say(mission, key, jammed = false) {
    const lines = mission?.radio?.[key];
    if (!lines) return;
    for (const [who, text] of lines) this.queue.push({ who, text: jammed && who !== 'WARDEN' ? garble(text) : text, jammed });
  }

  // Wait this long before the next line starts
  hold(seconds) { this.gap = Math.max(this.gap, seconds); }

  // Solo pause: the speech waits with the game
  pause() { this.synth?.pause(); }
  resume() { this.synth?.resume(); }

  clear() {
    this.queue = [];
    this.cur = null;
    this.synth?.cancel();
    this.synth?.resume(); // (if we were paused, later lines would never play)
    this.el.classList.remove('on');
  }

  update(dt) {
    if (this.cur) {
      this.cur.t -= dt;
      // Next line once this one has been on screen long enough AND the voice has finished
      if (this.cur.t > 0 || (this.speaking && this.cur.t > -6)) return;
      this.cur = null;
      this.el.classList.remove('on');
      this.gap = 0.35;
    }
    if ((this.gap -= dt) > 0 || !this.queue.length) return;
    this._show(this.queue.shift());
  }

  _show(line) {
    const words = line.text.split(/\s+/).length;
    this.cur = { ...line, t: Math.max(2.2, 0.8 + words * 0.34) };
    const c = CAST[line.who];
    this.el.querySelector('.who').textContent = `${line.who}${c ? ` · ${c.name}` : ''}`;
    this.el.querySelector('.line').textContent = line.text;
    this.el.classList.toggle('enemy', line.who === 'WARDEN');
    this.el.classList.toggle('jammed', !!line.jammed);
    this.el.classList.add('on');
    this.audio.radio();
    if (line.jammed && this.audio.ctx) { // a hiss of static over the top
      this.audio._burst(this.audio.dry, this.audio.ctx.currentTime, { dur: Math.min(3, this.cur.t), gain: 0.05, type: 'bandpass', freq: 1700, q: 0.5, attack: 0.05 });
    }
    this._speak(line, c);
  }

  _speak(line, c) {
    this.speaking = false;
    if (!this.voiceOn || !this.synth || !window.SpeechSynthesisUtterance) return;
    const u = new SpeechSynthesisUtterance(line.text.replace(/[—…]/g, ' '));
    const v = this._voiceFor(line.who, c?.voice?.gender);
    if (v) u.voice = v;
    u.lang = v?.lang || 'en-GB';
    u.pitch = c?.voice?.pitch ?? 1;
    u.rate = c?.voice?.rate ?? 1.05;
    u.volume = 0.9;
    u.onend = u.onerror = () => { this.speaking = false; };
    this.synth.cancel(); // never let lines pile up in the browser's own queue
    this.speaking = true;
    this.synth.speak(u);
  }

  // A different voice for each character, as far as this browser's voices allow
  _voiceFor(who, gender) {
    if (this.picked.has(who)) return this.picked.get(who);
    const want = gender === 'f' ? FEMALE : MALE;
    const used = new Set(this.picked.values());
    const pool = this.voices.filter((v) => want.test(v.name));
    const v = pool.find((x) => !used.has(x) && x.localService) || pool.find((x) => !used.has(x)) || pool[0] || this.voices[0] || null;
    this.picked.set(who, v);
    return v;
  }
}

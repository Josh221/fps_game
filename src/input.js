// =============================================================================
// input.js — keyboard + mouse state.
//
// Games poll input once per frame instead of reacting inside event handlers.
// We record raw events into sets, then the game asks "is W down?" or
// "was R pressed THIS frame?" (an edge). Mouse buttons are stored as fake key
// codes ('Mouse0' = left, 'Mouse2' = right) so everything uses one API.
// =============================================================================

// Typing in a text box (chat, callsign) mustn't also walk your soldier around.
const typing = (e) => e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);

export class Input {
  constructor(element) {
    this.element = element;
    this.down = new Set();     // currently held
    this.pressed = new Set();  // went down this frame
    this.dx = 0;               // accumulated mouse movement since last frame
    this.dy = 0;
    this.wheel = 0;
    this.locked = false;
    this.onLockChange = null;

    window.addEventListener('keydown', (e) => {
      if (e.repeat || typing(e)) return;
      if (this.locked && ['Space', 'Tab'].includes(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear()); // avoid "stuck" keys

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      const code = 'Mouse' + e.button;
      this.down.add(code);
      this.pressed.add(code);
    });
    window.addEventListener('mouseup', (e) => this.down.delete('Mouse' + e.button));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) this.down.clear();
      if (this.onLockChange) this.onLockChange(this.locked);
    });
  }

  requestLock() {
    // Browsers require pointer lock to be requested from a click handler.
    const p = this.element.requestPointerLock();
    if (p && p.catch) p.catch(() => {}); // Chrome throws if re-locked too fast after Esc
  }

  isDown(code) { return this.down.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  consumeMouse() {
    const d = { dx: this.dx, dy: this.dy };
    this.dx = 0; this.dy = 0;
    return d;
  }

  consumeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  // Forget held keys (e.g. when the chat box opens, so you stop walking).
  releaseAll() { this.down.clear(); }

  // Call at the very end of every frame.
  endFrame() { this.pressed.clear(); }
}

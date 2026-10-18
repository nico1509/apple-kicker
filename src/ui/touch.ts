import type { Input } from '../entities/input';
import { T } from '../i18n';

/** Swipe pixels count this much more than mouse pixels: a phone screen is small. */
const SWIPE_SCALE = 1.7;
/** The finger this far past the stick's rim means sprint. */
const SPRINT_BEYOND = 1.2;
/** Sideways deflection below this does not turn, so walking straight stays straight. */
const TURN_DEAD_ZONE = 0.15;

interface Stick {
  base: HTMLElement;
  knob: HTMLElement;
  touchId: number | null;
  cx: number;
  cy: number;
  radius: number;
}

/**
 * On-screen controls for touch devices: a stick on the left (up/down walks,
 * left/right turns) with the chip button next to it, and a pause button.
 * A swipe anywhere else is a kick, like dragging with the left mouse button.
 */
export class TouchControls {
  /** True once the device has shown it has a touch screen. */
  enabled: boolean;
  private readonly layer: HTMLElement;
  private readonly move: Stick;
  private readonly chip: HTMLElement;
  private chipTouch: number | null = null;
  private kickTouch: number | null = null;
  private kickX = 0;
  private kickY = 0;
  private active = false;
  private enableHandler: (() => void) | null = null;

  constructor(
    private readonly input: Input,
    root: HTMLElement,
    onPause: () => void,
  ) {
    this.layer = document.createElement('div');
    this.layer.className = 'touch-layer';
    this.layer.hidden = true;
    this.layer.innerHTML = `
      <div class="touch-stick move"><div class="touch-knob"></div></div>
      <div class="touch-chip" aria-label="${T.chipButton}"></div>
      <button class="touch-pause" aria-label="${T.pauseButton}"></button>
    `;
    // Below the menu overlay, so menus stay tappable.
    root.insertBefore(this.layer, root.querySelector('.overlay'));
    const q = (sel: string): HTMLElement => this.layer.querySelector<HTMLElement>(sel)!;
    this.move = { base: q('.touch-stick.move'), knob: q('.touch-stick.move .touch-knob'), touchId: null, cx: 0, cy: 0, radius: 1 };
    this.chip = q('.touch-chip');
    q('.touch-pause').addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPause();
    });

    this.layer.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.layer.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.layer.addEventListener('touchend', this.onTouchEnd, { passive: false });
    this.layer.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
    this.layer.addEventListener('contextmenu', (e) => e.preventDefault());

    this.enabled = TouchControls.isTouchDevice();
    // A touch screen that did not say so up front (e.g. some tablets) switches on with the first touch.
    if (!this.enabled) window.addEventListener('touchstart', this.onFirstTouch, { passive: true, capture: true });
  }

  static isTouchDevice(): boolean {
    try {
      return window.matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && window.matchMedia('(hover: none)').matches);
    } catch {
      return false;
    }
  }

  /** Called once when touch controls switch on after the start. */
  onEnable(fn: () => void): void {
    this.enableHandler = fn;
  }

  private readonly onFirstTouch = (): void => {
    window.removeEventListener('touchstart', this.onFirstTouch, { capture: true });
    this.enabled = true;
    this.enableHandler?.();
  };

  /** Show the controls while playing; hiding them lets go of everything. */
  setActive(on: boolean): void {
    on = on && this.enabled;
    if (on === this.active) return;
    this.active = on;
    this.layer.hidden = !on;
    if (!on) this.releaseAll();
  }

  private releaseAll(): void {
    this.endStick(this.move);
    this.chipTouch = null;
    this.chip.classList.remove('pressed');
    if (this.kickTouch !== null) this.input.cancelDrag();
    this.kickTouch = null;
    this.input.resetTouch();
  }

  private static inside(el: HTMLElement, x: number, y: number, pad: number): boolean {
    const r = el.getBoundingClientRect();
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  private readonly onTouchStart = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      const x = t.clientX;
      const y = t.clientY;
      if (this.chipTouch === null && TouchControls.inside(this.chip, x, y, 10)) {
        this.chipTouch = t.identifier;
        this.input.chipButton = true;
        this.chip.classList.add('pressed');
      } else if (this.move.touchId === null && TouchControls.inside(this.move.base, x, y, 24)) {
        this.beginStick(this.move, t);
      } else if (this.kickTouch === null && this.input.startDrag()) {
        this.kickTouch = t.identifier;
        this.kickX = x;
        this.kickY = y;
      }
    }
  };

  private readonly onTouchMove = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.move.touchId) this.moveStick(this.move, t);
      else if (t.identifier === this.kickTouch) {
        this.input.dragBy((t.clientX - this.kickX) * SWIPE_SCALE, (t.clientY - this.kickY) * SWIPE_SCALE);
        this.kickX = t.clientX;
        this.kickY = t.clientY;
      }
    }
  };

  private readonly onTouchEnd = (e: TouchEvent): void => {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.move.touchId) this.endStick(this.move);
      else if (t.identifier === this.chipTouch) {
        this.chipTouch = null;
        this.input.chipButton = false;
        this.chip.classList.remove('pressed');
      } else if (t.identifier === this.kickTouch) {
        this.kickTouch = null;
        if (e.type === 'touchcancel') this.input.cancelDrag();
        else this.input.release();
      }
    }
  };

  private beginStick(s: Stick, t: Touch): void {
    const r = s.base.getBoundingClientRect();
    s.touchId = t.identifier;
    s.cx = r.left + r.width / 2;
    s.cy = r.top + r.height / 2;
    s.radius = r.width / 2;
    s.base.classList.add('held');
    this.moveStick(s, t);
  }

  private moveStick(s: Stick, t: Touch): void {
    const dx = t.clientX - s.cx;
    const dy = t.clientY - s.cy;
    const d = Math.hypot(dx, dy);
    const k = d > s.radius ? s.radius / d : 1;
    const x = (dx * k) / s.radius;
    const y = (dy * k) / s.radius;
    s.knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    // Up/down walks, left/right turns.
    this.input.moveStick.x = 0;
    this.input.moveStick.y = y;
    this.input.turnStick = Math.abs(x) < TURN_DEAD_ZONE ? 0 : (x - Math.sign(x) * TURN_DEAD_ZONE) / (1 - TURN_DEAD_ZONE);
    this.input.sprintStick = d > s.radius * SPRINT_BEYOND;
    s.base.classList.toggle('sprint', this.input.sprintStick);
  }

  private endStick(s: Stick): void {
    s.touchId = null;
    s.knob.style.transform = '';
    s.base.classList.remove('held', 'sprint');
    this.input.moveStick.x = this.input.moveStick.y = 0;
    this.input.turnStick = 0;
    this.input.sprintStick = false;
  }
}

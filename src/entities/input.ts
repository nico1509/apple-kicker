import type { Foot } from '../config';

export interface DragState {
  foot: Foot;
  dx: number;
  dy: number;
}

export interface KickRequest {
  foot: Foot;
  dx: number;
  dy: number;
  chip: boolean;
  tap: boolean;
}

/**
 * Keyboard + mouse input. Mouse movement rotates the view unless a mouse
 * button is held: then the movement is accumulated into a kick drag
 * (left button = left foot, right button = right foot).
 */
export class Input {
  enabled = false;
  readonly keys = new Set<string>();
  drag: DragState | null = null;
  readonly kicks: KickRequest[] = [];
  private lookDX = 0;
  private lookDY = 0;
  private lastClientX: number | null = null;
  private lastClientY: number | null = null;
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (!this.enabled) return;
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code === 'KeyQ') this.kicks.push({ foot: 'left', dx: 0, dy: 0, chip: this.keys.has('Space'), tap: true });
    if (e.code === 'KeyE') this.kicks.push({ foot: 'right', dx: 0, dy: 0, chip: this.keys.has('Space'), tap: true });
  };
  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
  private readonly onMouseMove = (e: MouseEvent): void => {
    let mx = e.movementX || 0;
    let my = e.movementY || 0;
    if (!document.pointerLockElement) {
      // Without pointer lock some environments report no movement deltas:
      // derive them from the client position instead.
      if (this.lastClientX !== null && this.lastClientY !== null) {
        mx = e.clientX - this.lastClientX;
        my = e.clientY - this.lastClientY;
      }
      this.lastClientX = e.clientX;
      this.lastClientY = e.clientY;
    } else {
      this.lastClientX = null;
      this.lastClientY = null;
    }
    if (!this.enabled) return;
    if (this.drag) {
      this.drag.dx += mx;
      this.drag.dy += my;
    } else {
      this.lookDX += mx;
      this.lookDY += my;
    }
  };
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (e.button !== 0 && e.button !== 2) return;
    e.preventDefault();
    if (this.drag) return; // one kick at a time
    this.drag = { foot: e.button === 0 ? 'left' : 'right', dx: 0, dy: 0 };
  };
  private readonly onMouseUp = (e: MouseEvent): void => {
    if (!this.drag) return;
    const foot: Foot = e.button === 0 ? 'left' : 'right';
    if (foot !== this.drag.foot) return;
    e.preventDefault();
    this.release();
  };
  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.drag = null;
  };

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Finish the current drag and turn it into a kick request. */
  release(): void {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.kicks.push({ foot: d.foot, dx: d.dx, dy: d.dy, chip: this.keys.has('Space'), tap: false });
  }

  /** Cancel any pending drag without kicking. */
  cancelDrag(): void {
    this.drag = null;
  }

  isDown(code: string): boolean {
    return this.keys.has(code);
  }

  /** Returns and clears the accumulated look delta. */
  consumeLook(): { dx: number; dy: number } {
    const r = { dx: this.lookDX, dy: this.lookDY };
    this.lookDX = 0;
    this.lookDY = 0;
    return r;
  }

  /** Programmatic kick (used by the debug API and tests). */
  injectKick(req: KickRequest): void {
    this.kicks.push(req);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('mousemove', this.onMouseMove);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
  }
}

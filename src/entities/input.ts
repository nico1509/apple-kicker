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
  /** Horizontal look movement that arrived after the release (undone when aiming). */
  lookAfter: number;
  /** Facing yaw at release, stamped by the player on the frame the request arrives. */
  yaw?: number;
}

/**
 * Keyboard + mouse input. Mouse movement rotates the view unless the left
 * mouse button is held: then the movement is accumulated into a kick drag
 * with the right foot.
 */
export class Input {
  enabled = false;
  readonly keys = new Set<string>();
  drag: DragState | null = null;
  readonly kicks: KickRequest[] = [];
  /** Touch movement, -1..1 each (y < 0 = forward). */
  readonly moveStick = { x: 0, y: 0 };
  /** Movement stick pushed past its rim: sprint. */
  sprintStick = false;
  /** Touch turning, -1..1 (> 0 = right): turns the view at a rate while held. */
  turnStick = 0;
  /** Touch chip button held. */
  chipButton = false;
  private lookDX = 0;
  private lookDY = 0;
  private lastClientX: number | null = null;
  private lastClientY: number | null = null;
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Track the physical key state always (also via auto-repeat events), so a
    // key held across the menu/pause is picked up once input is enabled.
    this.keys.add(e.code);
    if (!this.enabled) return;
    if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
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
      // Movement after a release belongs to the view, not to the kick's aim.
      for (const k of this.kicks) if (k.yaw === undefined) k.lookAfter += mx;
    }
  };
  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.enabled) return;
    if (e.button !== 0) return;
    e.preventDefault();
    if (this.drag) return; // one kick at a time
    this.drag = { foot: 'right', dx: 0, dy: 0 };
  };
  private readonly onMouseUp = (e: MouseEvent): void => {
    if (!this.drag || e.button !== 0) return;
    e.preventDefault();
    this.release();
  };
  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };
  private readonly onBlur = (): void => {
    this.keys.clear();
    this.drag = null;
    this.resetTouch();
  };
  private readonly onMouseLeave = (): void => {
    // Without pointer lock the cursor may re-enter anywhere: do not turn the
    // view by the jump.
    this.lastClientX = null;
    this.lastClientY = null;
  };

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('contextmenu', this.onContextMenu);
    target.addEventListener('mouseleave', this.onMouseLeave);
  }

  /** Finish the current drag and turn it into a kick request. */
  release(): void {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.kicks.push({ foot: d.foot, dx: d.dx, dy: d.dy, chip: this.chipHeld(), tap: false, lookAfter: 0 });
  }

  /** Start a kick drag from a touch swipe (like holding the left mouse button). */
  startDrag(): boolean {
    if (!this.enabled || this.drag) return false;
    this.drag = { foot: 'right', dx: 0, dy: 0 };
    return true;
  }

  /** Add swipe movement to the current kick drag. */
  dragBy(dx: number, dy: number): void {
    if (!this.drag) return;
    this.drag.dx += dx;
    this.drag.dy += dy;
  }

  /** True while a chip is asked for (space bar or the touch button). */
  chipHeld(): boolean {
    return this.keys.has('Space') || this.chipButton;
  }

  /** Let go of all touch controls (pause, game over, controls hidden). */
  resetTouch(): void {
    this.moveStick.x = this.moveStick.y = 0;
    this.turnStick = 0;
    this.sprintStick = false;
    this.chipButton = false;
  }

  /** Cancel any pending drag and queued kick requests (pause, game over). */
  cancelDrag(): void {
    this.drag = null;
    this.kicks.length = 0;
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
    this.target.removeEventListener('mouseleave', this.onMouseLeave);
  }
}

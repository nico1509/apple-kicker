import type { Foot } from '../config';

export type OverlayKind = 'start' | 'paused' | 'gameover' | null;

/** DOM-based heads-up display and menu overlays. */
export class Hud {
  readonly root: HTMLElement;
  private readonly distanceEl: HTMLElement;
  private readonly bestEl: HTMLElement;
  private readonly stormEl: HTMLElement;
  private readonly stormBar: HTMLElement;
  private readonly stormWrap: HTMLElement;
  private readonly staminaBar: HTMLElement;
  private readonly messageEl: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly arrowLine: HTMLElement;
  private readonly arrowLabel: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly indicatorLabel: HTMLElement;
  private readonly chevron: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly overlayContent: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly hint: HTMLElement;
  private messageTimer: number | null = null;
  private startHandler: (() => void) | null = null;
  private restartHandler: (() => void) | null = null;
  /** The game-over panel ignores clicks for a moment so the score can be read. */
  private armedAt = 0;
  private lastDistance = '';
  private lastBest = '';
  private lastStorm = '';
  private lastIndicatorVisible = false;
  private lastArrowVisible = false;
  overlayKind: OverlayKind = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="vignette"></div>
      <div class="hud-top">
        <div class="panel distance"><span class="label">Apfel</span><span class="value" data-distance>0 m</span><span class="best" data-best></span></div>
        <div class="panel storm" data-storm-wrap>
          <span class="label">Gewitter</span>
          <span class="value" data-storm>– m</span>
          <div class="bar"><div class="fill" data-storm-bar></div></div>
        </div>
      </div>
      <div class="crosshair"></div>
      <div class="kick-arrow" hidden>
        <div class="line"></div>
        <div class="arrow-label"></div>
      </div>
      <div class="apple-indicator" hidden><span class="chevron">➤</span><span class="ind-label"></span></div>
      <div class="message" hidden></div>
      <div class="bottom-stack">
        <div class="stamina"><div class="fill" data-stamina></div></div>
        <div class="hint">
          <span><b>WASD</b> laufen</span><span><b>Shift</b> sprinten</span>
          <span><b>Linke Maus</b> linker Fuß</span><span><b>Rechte Maus</b> rechter Fuß</span>
          <span><b>Ziehen</b> = Richtung &amp; Kraft</span><span><b>Leertaste</b> halten = Lupfer</span>
        </div>
      </div>
      <div class="overlay" hidden><div class="overlay-content"></div></div>
    `;
    const q = <T extends HTMLElement>(sel: string): T => {
      const el = root.querySelector<T>(sel);
      if (!el) throw new Error(`HUD element missing: ${sel}`);
      return el;
    };
    this.distanceEl = q('[data-distance]');
    this.bestEl = q('[data-best]');
    this.stormEl = q('[data-storm]');
    this.stormBar = q('[data-storm-bar]');
    this.stormWrap = q('[data-storm-wrap]');
    this.staminaBar = q('[data-stamina]');
    this.messageEl = q('.message');
    this.arrow = q('.kick-arrow');
    this.arrowLine = q('.kick-arrow .line');
    this.arrowLabel = q('.kick-arrow .arrow-label');
    this.crosshair = q('.crosshair');
    this.indicator = q('.apple-indicator');
    this.indicatorLabel = q('.apple-indicator .ind-label');
    this.chevron = q('.apple-indicator .chevron');
    this.overlay = q('.overlay');
    this.overlayContent = q('.overlay-content');
    this.vignette = q('.vignette');
    this.hint = q('.hint');
    this.overlay.addEventListener('click', (e) => {
      if (this.overlayKind === null) return;
      const target = e.target as HTMLElement;
      if (target.closest('[data-action="restart"]')) {
        this.restartHandler?.();
        return;
      }
      if (this.overlayKind === 'gameover' && performance.now() < this.armedAt) return;
      this.startHandler?.();
    });
  }

  onStart(cb: () => void): void {
    this.startHandler = cb;
  }

  onRestart(cb: () => void): void {
    this.restartHandler = cb;
  }

  setDistance(m: number, best: number): void {
    const txt = `${Math.floor(m)} m`;
    if (txt !== this.lastDistance) {
      this.lastDistance = txt;
      this.distanceEl.textContent = txt;
    }
    const bestTxt = best > 0 ? `Rekord ${Math.floor(best)} m` : '';
    if (bestTxt !== this.lastBest) {
      this.lastBest = bestTxt;
      this.bestEl.textContent = bestTxt;
    }
  }

  setStorm(dist: number, danger: number, apple: boolean): void {
    const d = Math.max(0, dist);
    const txt = window.innerWidth < 480 ? `${Math.round(d)} m` : `${Math.round(d)} m hinter ${apple ? 'dem Apfel' : 'dir'}`;
    if (txt !== this.lastStorm) {
      this.lastStorm = txt;
      this.stormEl.textContent = txt;
    }
    this.stormBar.style.width = `${Math.round(danger * 100)}%`;
    this.stormWrap.classList.toggle('danger', danger > 0.6);
    this.stormWrap.classList.toggle('critical', danger > 0.85);
  }

  setStamina(v: number): void {
    this.staminaBar.style.width = `${Math.round(v * 100)}%`;
    this.staminaBar.parentElement?.classList.toggle('low', v < 0.25);
  }

  setVignette(amount: number): void {
    this.vignette.style.opacity = String(Math.min(1, amount));
  }

  setDrag(dx: number, dy: number, power: number, foot: Foot, chip: boolean, tap: boolean): void {
    if (!this.lastArrowVisible) {
      this.lastArrowVisible = true;
      this.arrow.hidden = false;
      this.crosshair.classList.add('aiming');
    }
    const len = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    this.arrowLine.style.width = `${Math.min(len, 340)}px`;
    this.arrowLine.style.transform = `rotate(${angle}rad)`;
    const hue = 110 - power * 110;
    this.arrowLine.style.background = `linear-gradient(90deg, rgba(255,255,255,0.35), hsl(${hue} 90% 55%))`;
    const footName = foot === 'left' ? 'Linker Fuß' : 'Rechter Fuß';
    this.arrowLabel.textContent = tap ? `${footName} · Stupser` : `${footName} · ${Math.round(power * 100)} %${chip ? ' · Lupfer' : ''}`;
  }

  clearDrag(): void {
    if (!this.lastArrowVisible) return;
    this.lastArrowVisible = false;
    this.arrow.hidden = true;
    this.crosshair.classList.remove('aiming');
  }

  message(text: string, duration = 2200, kind: 'info' | 'bad' | 'good' = 'info'): void {
    this.messageEl.textContent = text;
    this.messageEl.hidden = false;
    this.messageEl.className = `message ${kind}`;
    if (this.messageTimer !== null) window.clearTimeout(this.messageTimer);
    this.messageTimer = window.setTimeout(() => {
      this.messageEl.hidden = true;
      this.messageTimer = null;
    }, duration);
  }

  setHintVisible(v: boolean): void {
    this.hint.classList.toggle('faded', !v);
  }

  /** Marker pointing to the apple (off screen, or in view when it is far away). */
  setAppleIndicator(visible: boolean, x: number, y: number, angle: number, distance: number, inView = false): void {
    this.indicator.classList.toggle('in-view', visible && inView);
    if (visible !== this.lastIndicatorVisible) {
      this.lastIndicatorVisible = visible;
      this.indicator.hidden = !visible;
    }
    if (!visible) return;
    this.indicator.style.left = `${x}px`;
    this.indicator.style.top = `${y}px`;
    this.chevron.style.transform = `rotate(${angle}rad)`;
    this.indicatorLabel.textContent = `Apfel ${Math.round(distance)} m`;
  }

  showStart(best: number): void {
    this.overlayKind = 'start';
    this.overlay.hidden = false;
    this.overlayContent.innerHTML = `
      <h1 class="logo" aria-label="Apple Kicker">
        <img class="logo-apple" src="./favicon.svg" alt="" />
        <span class="logo-words" aria-hidden="true"><span class="logo-apple-word">APPLE</span><span class="logo-kicker-word">KICKER</span></span>
      </h1>
      <p class="tagline">Goldener Oktober, ein Apfel, ein Feldweg – und ein Gewitter im Nacken.</p>
      <div class="rules">
        <p>Kicke deinen Apfel so weit wie möglich den Weg entlang. Gezählt werden die Meter, die der <b>Apfel</b> zurücklegt.</p>
        <p>Von hinten zieht eine Schlechtwetterfront heran. Holt sie dich ein, ist der Lauf vorbei.</p>
        <p>Wurzeln, Äste, Steine, Pfützen und Hügel werden mit der Zeit mehr – kick fester oder lupf drüber.</p>
      </div>
      <div class="controls">
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> laufen · <kbd>Shift</kbd> sprinten</div>
        <div><kbd>Linke Maustaste</kbd> halten &amp; ziehen = Kick mit dem linken Fuß</div>
        <div><kbd>Rechte Maustaste</kbd> halten &amp; ziehen = Kick mit dem rechten Fuß</div>
        <div>Zugrichtung = Schussrichtung, Zuglänge = Kraft · kurzer Klick = Stupser</div>
        <div><kbd>Leertaste</kbd> beim Loslassen halten = hoher Lupfer über Hindernisse</div>
        <div><kbd>Q</kbd> / <kbd>E</kbd> = kurzer Stupser links / rechts · <kbd>M</kbd> Ton an/aus</div>
      </div>
      ${best > 0 ? `<p class="best-line">Dein Rekord: <b>${Math.floor(best)} m</b></p>` : ''}
      <button class="start" data-action="start">Klicken zum Starten</button>
      <p class="small">Der Mauszeiger wird im Spiel eingefangen · <kbd>Esc</kbd> oder <kbd>P</kbd> pausiert</p>
    `;
  }

  showPaused(): void {
    this.overlayKind = 'paused';
    this.overlay.hidden = false;
    this.overlayContent.innerHTML = `
      <h2>Pause</h2>
      <p>Der Apfel wartet. Das Gewitter auch.</p>
      <button class="start" data-action="start">Weiter</button>
      <button class="start secondary" data-action="restart">Neustart</button>
      <p class="small"><kbd>Enter</kbd> / <kbd>P</kbd> = weiter · <kbd>R</kbd> = Neustart</p>
    `;
  }

  showGameOver(score: number, best: number, isRecord: boolean, apple: boolean): void {
    this.overlayKind = 'gameover';
    this.overlay.hidden = false;
    this.armedAt = performance.now() + 700;
    this.overlayContent.innerHTML = `
      <h2>${apple ? 'Das Gewitter hat deinen Apfel eingeholt!' : 'Vom Gewitter eingeholt!'}</h2>
      <p class="score">Dein Apfel kam <b>${Math.floor(score)} m</b> weit.</p>
      ${isRecord ? '<p class="record">Neuer Rekord!</p>' : `<p>Rekord: <b>${Math.floor(best)} m</b></p>`}
      <button class="start" data-action="start">Nochmal versuchen</button>
      <p class="small">oder <kbd>Enter</kbd> drücken</p>
    `;
  }

  hideOverlay(): void {
    this.overlayKind = null;
    this.overlay.hidden = true;
  }
}

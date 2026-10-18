import { T } from '../i18n';

export type OverlayKind = 'start' | 'paused' | 'lifelost' | 'gameover' | 'won' | null;
export type Difficulty = 'easy' | 'hard';
/** Story: every landscape once, then the way ends. Endless: the landscapes loop (unlocked by finishing the story). */
export type Mode = 'story' | 'endless';
/** What ended a life: the storm caught the player or the apple, or the thirst bar ran empty. */
export type Cause = 'player' | 'apple' | 'thirst' | 'gorge';

/** Lives in the easy mode. */
export const EASY_LIVES = 3;

const APPLE_ICON = './favicon.svg';
/** Running shoe with a speed line for the stamina bar. */
const STAMINA_ICON = `<svg class="meter-icon" viewBox="0 0 32 32" aria-hidden="true">
  <path d="M9 9h7l2 6c3 .6 6 1.6 8.5 3.2 1.6 1 2.5 2.4 2.5 4V25H3v-4.5L5 16z" fill="#9bd36a"/>
  <path d="M3 25h26v2.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="#f6f1e4"/>
  <path d="M12 15l3-1M13 18l3-1" stroke="#2f6b25" stroke-width="1.6" stroke-linecap="round"/>
  <path d="M1 12h5M0 16h4M1 20h3" stroke="#f6f1e4" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>
</svg>`;
/** Small apple-spritzer bottle for the thirst bar. */
const BOTTLE_ICON = `<svg class="meter-icon bottle-icon" viewBox="0 0 16 40" aria-hidden="true">
  <path d="M6 1h4v2l.3 7c3.2 2.4 4.7 4.6 4.7 8V38a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 38V18c0-3.4 1.5-5.6 4.7-8L6 3z" fill="#e0a83c"/>
  <rect x="5.6" y="0" width="4.8" height="2.4" rx="0.6" fill="#2f9a2c"/>
  <rect x="5.9" y="6" width="4.2" height="2.2" fill="#3fae35"/>
  <rect x="1" y="21" width="14" height="12" fill="#3aa832"/>
  <circle cx="5" cy="25" r="2.6" fill="#7ccf4c"/><circle cx="11.5" cy="30" r="2.2" fill="#7ccf4c"/>
</svg>`;

/** DOM-based heads-up display and menu overlays. */
export class Hud {
  readonly root: HTMLElement;
  private readonly distanceEl: HTMLElement;
  private readonly bestEl: HTMLElement;
  private readonly stormEl: HTMLElement;
  private readonly stormBar: HTMLElement;
  private readonly stormWrap: HTMLElement;
  private readonly staminaBar: HTMLElement;
  private readonly staminaWrap: HTMLElement;
  private readonly thirstBar: HTMLElement;
  private readonly thirstWrap: HTMLElement;
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
  private readonly livesEl: HTMLElement;
  private messageTimer: number | null = null;
  private startHandler: (() => void) | null = null;
  private restartHandler: (() => void) | null = null;
  private continueHandler: (() => void) | null = null;
  private menuHandler: (() => void) | null = null;
  private difficultyHandler: ((d: Difficulty) => void) | null = null;
  private modeHandler: ((m: Mode) => void) | null = null;
  private kickstartHandler: (() => void) | null = null;
  private lastLives = '';
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
        <div class="hud-left">
          <div class="panel distance"><span class="label">${T.apple}</span><span class="value" data-distance>0 m</span><span class="best" data-best></span></div>
          <div class="panel meter thirst" data-thirst-wrap>
            ${BOTTLE_ICON}
            <div class="meter-body"><span class="label">${T.thirst}</span><div class="bar"><div class="fill" data-thirst></div></div></div>
          </div>
          <div class="panel meter stamina" data-stamina-wrap>
            ${STAMINA_ICON}
            <div class="meter-body"><span class="label">${T.stamina}</span><div class="bar"><div class="fill" data-stamina></div></div></div>
          </div>
        </div>
        <div class="lives" data-lives hidden></div>
        <div class="panel storm" data-storm-wrap>
          <span class="label">${T.storm}</span>
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
    this.staminaWrap = q('[data-stamina-wrap]');
    this.thirstBar = q('[data-thirst]');
    this.thirstWrap = q('[data-thirst-wrap]');
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
    this.livesEl = q('[data-lives]');
    this.overlay.addEventListener('click', (e) => {
      if (this.overlayKind === null) return;
      const target = e.target as HTMLElement;
      const mode = target.closest<HTMLElement>('[data-mode]');
      if (mode) {
        if (mode.classList.contains('locked')) return;
        this.modeHandler?.(mode.dataset.mode === 'endless' ? 'endless' : 'story');
        return;
      }
      const choice = target.closest<HTMLElement>('[data-difficulty]');
      if (choice) {
        const d = choice.dataset.difficulty === 'hard' ? 'hard' : 'easy';
        this.selectDifficulty(d);
        this.difficultyHandler?.(d);
        return;
      }
      if (target.closest('[data-action="restart"]')) {
        this.restartHandler?.();
        return;
      }
      if (target.closest('[data-action="kickstart"]')) {
        this.kickstartHandler?.();
        return;
      }
      if (target.closest('[data-action="continue"]')) {
        this.continueHandler?.();
        return;
      }
      if (target.closest('[data-action="menu"]')) {
        this.menuHandler?.();
        return;
      }
      // After losing a life only the buttons count: a stray click must not decide.
      if (this.overlayKind === 'lifelost') return;
      if ((this.overlayKind === 'gameover' || this.overlayKind === 'won') && performance.now() < this.armedAt) return;
      this.startHandler?.();
    });
  }

  onStart(cb: () => void): void {
    this.startHandler = cb;
  }

  onRestart(cb: () => void): void {
    this.restartHandler = cb;
  }

  onContinue(cb: () => void): void {
    this.continueHandler = cb;
  }

  onMenu(cb: () => void): void {
    this.menuHandler = cb;
  }

  onKickstart(cb: () => void): void {
    this.kickstartHandler = cb;
  }

  onDifficulty(cb: (d: Difficulty) => void): void {
    this.difficultyHandler = cb;
  }

  onMode(cb: (m: Mode) => void): void {
    this.modeHandler = cb;
  }

  /** Lives as apple icons; hidden when `total` is 0 (hard mode). */
  setLives(left: number, total: number): void {
    const key = `${left}/${total}`;
    if (key === this.lastLives) return;
    this.lastLives = key;
    this.livesEl.hidden = total === 0;
    this.livesEl.innerHTML = Hud.livesHtml(left, total);
    this.livesEl.setAttribute('aria-label', T.livesOf(left, total));
  }

  private static livesHtml(left: number, total: number): string {
    let html = '';
    for (let i = 0; i < total; i++) html += `<img class="life${i < left ? '' : ' lost'}" src="${APPLE_ICON}" alt="" />`;
    return html;
  }

  setDistance(m: number, best: number): void {
    const txt = `${Math.floor(m)} m`;
    if (txt !== this.lastDistance) {
      this.lastDistance = txt;
      this.distanceEl.textContent = txt;
    }
    const bestTxt = best > 0 ? T.record(best) : '';
    if (bestTxt !== this.lastBest) {
      this.lastBest = bestTxt;
      this.bestEl.textContent = bestTxt;
    }
  }

  setStorm(dist: number, danger: number, apple: boolean): void {
    const d = Math.max(0, dist);
    const txt = window.innerWidth < 480 ? `${Math.round(d)} m` : T.stormBehind(d, apple);
    if (txt !== this.lastStorm) {
      this.lastStorm = txt;
      this.stormEl.textContent = txt;
    }
    this.stormBar.style.width = `${Math.round(danger * 100)}%`;
    this.stormWrap.classList.toggle('danger', danger > 0.6);
    this.stormWrap.classList.toggle('critical', danger > 0.85);
  }

  setStamina(v: number, exhausted = false, boosted = false): void {
    this.staminaBar.style.width = `${Math.round(v * 100)}%`;
    this.staminaWrap.classList.toggle('low', v < 0.25);
    this.staminaWrap.classList.toggle('exhausted', exhausted);
    this.staminaWrap.classList.toggle('boosted', boosted);
  }

  /** Thirst bar: 1 = quenched, 0 = parched (that costs a life). */
  setThirst(v: number, warnBelow: number): void {
    this.thirstBar.style.width = `${(Math.max(0, Math.min(1, v)) * 100).toFixed(1)}%`;
    this.thirstWrap.classList.toggle('low', v < warnBelow);
  }

  setVignette(amount: number): void {
    this.vignette.style.opacity = String(Math.min(1, amount));
  }

  setDrag(dx: number, dy: number, power: number, chip: boolean, tap: boolean): void {
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
    this.arrowLabel.textContent = tap ? T.tap : `${Math.round(power * 100)} %${chip ? ` · ${T.chip}` : ''}`;
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
    this.indicatorLabel.textContent = T.appleDistance(distance);
  }

  private selectDifficulty(d: Difficulty): void {
    for (const el of this.overlayContent.querySelectorAll<HTMLElement>('[data-difficulty]')) {
      const on = el.dataset.difficulty === d;
      el.classList.toggle('selected', on);
      el.setAttribute('aria-checked', String(on));
    }
    const kick = this.overlayContent.querySelector<HTMLElement>('[data-action="kickstart"]');
    if (kick) kick.hidden = d !== 'easy';
  }

  /** "Kickstart" button: start an easy run right at the record distance. Dev builds only. */
  private static kickstartHtml(record: number, hidden = false): string {
    if (!import.meta.env.DEV || record < 1) return '';
    return `<button class="start secondary" data-action="kickstart"${hidden ? ' hidden' : ''}>${T.kickstartAt(record)}</button>`;
  }

  private static recordHtml(best: number): string {
    return `<span class="choice-record">${best > 0 ? T.recordHtml(best) : T.noRecord}</span>`;
  }

  private static modeHtml(mode: Mode, endlessUnlocked: boolean): string {
    const on = (m: Mode): string => (m === mode ? ' selected' : '');
    return `
      <div class="difficulty mode" role="radiogroup" aria-label="${T.mode}">
        <button class="choice${on('story')}" role="radio" aria-checked="${mode === 'story'}" data-mode="story">
          <span class="choice-head"><span class="choice-title">${T.story}</span></span>
          <span class="choice-text">${T.storyText}</span>
        </button>
        <button class="choice${on('endless')}${endlessUnlocked ? '' : ' locked'}" role="radio" aria-checked="${mode === 'endless'}"${endlessUnlocked ? '' : ' aria-disabled="true"'} data-mode="endless">
          <span class="choice-head"><span class="choice-title">${endlessUnlocked ? '' : '🔒 '}${T.endless}</span></span>
          <span class="choice-text">${endlessUnlocked ? T.endlessText : T.endlessLocked}</span>
        </button>
      </div>`;
  }

  /** `bests` are the records of the chosen mode. */
  showStart(bests: Record<Difficulty, number>, difficulty: Difficulty, mode: Mode = 'story', endlessUnlocked = false): void {
    this.overlayKind = 'start';
    this.overlay.hidden = false;
    this.overlay.scrollTop = 0;
    this.overlayContent.innerHTML = `
      <h1 class="logo" aria-label="Apple Kicker">
        <img class="logo-apple" src="./favicon.svg" alt="" />
        <span class="logo-words" aria-hidden="true"><span class="logo-apple-word">APPLE</span><span class="logo-kicker-word">KICKER</span></span>
      </h1>
      <p class="tagline">${T.tagline}</p>
      <div class="rules">
        <p>${T.rulesGoal(mode === 'story')}</p>
        <p>${T.rulesStorm}</p>
        <p>${T.rulesThirst}</p>
        <p>${T.rulesObstacles}</p>
      </div>
      ${Hud.modeHtml(mode, endlessUnlocked)}
      <div class="difficulty" role="radiogroup" aria-label="${T.difficulty}">
        <button class="choice" role="radio" data-difficulty="easy">
          <span class="choice-head"><span class="choice-title">${T.easy}</span><span class="choice-lives">${Hud.livesHtml(EASY_LIVES, EASY_LIVES)}</span></span>
          <span class="choice-text">${T.easyText}</span>
          ${Hud.recordHtml(bests.easy)}
        </button>
        <button class="choice" role="radio" data-difficulty="hard">
          <span class="choice-head"><span class="choice-title">${T.hard}</span><span class="choice-lives">${Hud.livesHtml(1, 1)}</span></span>
          <span class="choice-text">${T.hardText}</span>
          ${Hud.recordHtml(bests.hard)}
        </button>
      </div>
      <div class="buttons">
        <button class="start" data-action="start">${T.startHtml}</button>
        ${Hud.kickstartHtml(bests.easy)}
      </div>
      <div class="hint only-touch">
        ${T.touchHelpHtml}
      </div>
      <div class="hint only-mouse">
        ${T.mouseHelpHtml}
      </div>
      <p class="small only-mouse">${T.mouseNoteHtml}</p>
    `;
    this.selectDifficulty(difficulty);
  }

  showPaused(): void {
    this.overlayKind = 'paused';
    this.overlay.hidden = false;
    this.overlay.scrollTop = 0;
    this.overlayContent.innerHTML = `
      <h2>${T.pause}</h2>
      <p>${T.pauseText}</p>
      <div class="buttons">
        <button class="start" data-action="start">${T.resume}</button>
        <button class="start secondary" data-action="restart">${T.restart}</button>
        <button class="start secondary" data-action="menu">${T.mainMenu}</button>
      </div>
      <p class="small only-mouse">${T.pauseKeysHtml}</p>
    `;
  }

  private static causeText(cause: Cause): string {
    if (cause === 'thirst') return T.causeThirst;
    if (cause === 'gorge') return T.causeGorge;
    return cause === 'apple' ? T.causeApple : T.causePlayer;
  }

  /** Easy mode: the storm (or the thirst) took a life but at least one is left. */
  showLifeLost(cause: Cause, left: number, total: number, score: number): void {
    this.overlayKind = 'lifelost';
    this.overlay.hidden = false;
    this.overlay.scrollTop = 0;
    this.overlayContent.innerHTML = `
      <h2>${T.lifeLost}</h2>
      <p>${Hud.causeText(cause)}</p>
      <div class="lives big" aria-label="${T.livesOf(left, total)}">${Hud.livesHtml(left, total)}</div>
      <p>${T.livesLeftHtml(left, score)}</p>
      <button class="start" data-action="continue">${T.continue}</button>
      <button class="start secondary" data-action="restart">${T.restartAll}</button>
      <p class="small only-mouse">${T.lifeLostKeysHtml(score)}</p>
    `;
  }

  /** `livesTotal` > 0 marks the easy mode (lives shown, Kickstart offered). */
  showGameOver(score: number, best: number, isRecord: boolean, cause: Cause, livesTotal = 0): void {
    this.overlayKind = 'gameover';
    this.overlay.hidden = false;
    this.overlay.scrollTop = 0;
    this.armedAt = performance.now() + 700;
    this.overlayContent.innerHTML = `
      <h2>${cause === 'thirst' ? T.overThirst : cause === 'gorge' ? T.overGorge : cause === 'apple' ? T.overApple : T.overPlayer}</h2>
      ${livesTotal > 0 ? `<div class="lives big" aria-label="${T.noLivesLeft}">${Hud.livesHtml(0, livesTotal)}</div><p>${T.allLivesUsed}</p>` : ''}
      <p class="score">${T.scoreHtml(score)}</p>
      ${isRecord ? `<p class="record">${T.newRecord}</p>` : `<p>${T.recordLineHtml(best)}</p>`}
      <div class="buttons">
        <button class="start" data-action="start">${T.tryAgain}</button>
        ${livesTotal > 0 ? Hud.kickstartHtml(best) : ''}
        <button class="start secondary" data-action="menu">${T.menu}</button>
      </div>
      <p class="small only-mouse">${T.orPressEnterHtml}</p>
    `;
  }

  /** Story mode won: the apple and the player made it home. */
  showWon(score: number, seconds: number, best: number, isRecord: boolean, unlockedNow: boolean): void {
    this.overlayKind = 'won';
    this.overlay.hidden = false;
    this.overlay.scrollTop = 0;
    this.armedAt = performance.now() + 900;
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    this.overlayContent.innerHTML = `
      <h2>${T.wonTitle}</h2>
      <p>${T.wonText}</p>
      <p class="score">${T.wonScoreHtml(score, `${min}:${String(sec).padStart(2, '0')}`)}</p>
      ${isRecord ? `<p class="record">${T.newRecord}</p>` : best > 0 ? `<p>${T.recordLineHtml(best)}</p>` : ''}
      ${unlockedNow ? `<p class="record">${T.endlessUnlocked}</p>` : ''}
      <div class="buttons">
        <button class="start" data-action="start">${T.playAgain}</button>
        <button class="start secondary" data-action="menu">${T.mainMenu}</button>
      </div>
      <p class="small only-mouse">${T.orPressEnterHtml}</p>
    `;
  }

  /** Touch screen: show the touch controls' help instead of keys and mouse. */
  setTouch(on: boolean): void {
    this.root.classList.toggle('touch', on);
  }

  hideOverlay(): void {
    this.overlayKind = null;
    this.overlay.hidden = true;
  }
}

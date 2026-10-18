import './style.css';
import { Game } from './game';
import { T, lang } from './i18n';
import { landscapeOfIndex, setFixedLandscapeOrder } from './world/landscape';

declare global {
  interface Window {
    __appleKicker?: {
      game: Game;
      lang: 'de' | 'en';
      start: () => void;
      restart: () => void;
      kickstart: () => void;
      setDifficulty: (d: 'easy' | 'hard') => void;
      setMode: (m: 'story' | 'endless') => void;
      unlockEndless: (on?: boolean) => void;
      fixedLandscapes: (on?: boolean) => void;
      landscapes: (count: number) => string[];
      kick: (dx: number, dy: number, foot: 'left' | 'right', chip?: boolean) => void;
      simulate: (seconds: number, keys?: string[]) => void;
      look: (yaw: number, pitch: number) => void;
      teleport: (progress: number) => void;
      state: () => Record<string, number | string | boolean>;
    };
  }
}

function boot(): void {
  document.documentElement.lang = lang;
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui');
  if (!canvas || !ui) throw new Error('Missing #game canvas or #ui element');
  try {
    const game = new Game(canvas, ui);
    game.run();
    window.__appleKicker = {
      game,
      lang,
      start: () => {
        if (game.state === 'menu') game.start();
        else if (game.state === 'paused') game.resume();
        else if (game.state === 'lifelost') game.continueRun();
        else if (game.state === 'over' || game.state === 'won') game.restart();
      },
      restart: () => game.restart(),
      kickstart: () => game.kickstart(),
      setDifficulty: (d) => game.setDifficulty(d),
      setMode: (m) => game.setMode(m),
      unlockEndless: (on = true) => game.debugUnlock(on),
      fixedLandscapes: (on = true) => setFixedLandscapeOrder(on),
      landscapes: (count) => Array.from({ length: count }, (_, k) => landscapeOfIndex(k)),
      kick: (dx, dy, foot, chip = false) => game.debugKick(dx, dy, foot, chip),
      simulate: (seconds, keys = []) => game.simulate(seconds, keys),
      look: (yaw, pitch) => game.debugLook(yaw, pitch),
      teleport: (progress) => game.debugTeleport(progress),
      state: () => game.debugState(),
    };
  } catch (err) {
    console.error(err);
    ui.innerHTML = `<div class="overlay"><div class="overlay-content"><h2>${T.bootFailed}</h2><p>${T.noWebgl}</p><p class="small">${String(err)}</p></div></div>`;
  }
}

boot();

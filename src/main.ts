import './style.css';
import { Game } from './game';

declare global {
  interface Window {
    __appleKicker?: {
      game: Game;
      start: () => void;
      kick: (dx: number, dy: number, foot: 'left' | 'right', chip?: boolean) => void;
      simulate: (seconds: number, keys?: string[]) => void;
      look: (yaw: number, pitch: number) => void;
      teleport: (progress: number) => void;
      state: () => Record<string, number | string | boolean>;
    };
  }
}

function boot(): void {
  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui');
  if (!canvas || !ui) throw new Error('Missing #game canvas or #ui element');
  try {
    const game = new Game(canvas, ui);
    game.run();
    window.__appleKicker = {
      game,
      start: () => {
        if (game.state === 'menu') game.start();
        else if (game.state === 'paused') game.resume();
        else if (game.state === 'over') game.restart();
      },
      kick: (dx, dy, foot, chip = false) => game.debugKick(dx, dy, foot, chip),
      simulate: (seconds, keys = []) => game.simulate(seconds, keys),
      look: (yaw, pitch) => game.debugLook(yaw, pitch),
      teleport: (progress) => game.debugTeleport(progress),
      state: () => game.debugState(),
    };
  } catch (err) {
    console.error(err);
    ui.innerHTML = `<div class="overlay"><div class="overlay-content"><h2>Konnte das Spiel nicht starten</h2><p>Dein Browser unterstützt vermutlich kein WebGL.</p><p class="small">${String(err)}</p></div></div>`;
  }
}

boot();

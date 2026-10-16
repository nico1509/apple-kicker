#!/usr/bin/env node
/**
 * Headless smoke test for Apple Kicker.
 *
 * Starts `vite preview` (unless GAME_URL is set), opens the game in headless
 * Chromium, plays deterministically through the debug API (window.__appleKicker)
 * and writes screenshots into ./screenshots. Fails on page errors or when the
 * gameplay checks do not hold.
 *
 * Environment:
 *   GAME_URL     use an already running server instead of starting vite preview
 *   CHROME_PATH  path to a Chrome/Chromium binary (default: Playwright's bundled chromium)
 *   QUALITY      low | medium | high (default low – software rendering is slow)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PORT = 4173;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const quality = process.env.QUALITY || 'low';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

let server = null;
let url = process.env.GAME_URL;
if (!url) {
  if (!fs.existsSync(path.join(root, 'dist', 'index.html'))) {
    console.error('dist/ is missing – run `npm run build` first.');
    process.exit(1);
  }
  // Run vite directly with node (no npx, no shell) so that kill() works everywhere.
  const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  server = spawn(process.execPath, [viteBin, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: 'ignore',
  });
  url = `http://127.0.0.1:${PORT}/`;
  if (!(await waitForServer(url))) {
    console.error('vite preview did not start');
    server.kill();
    process.exit(1);
  }
}
url += (url.includes('?') ? '&' : '?') + `quality=${quality}`;

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});

let failed = false;
const check = (cond, msg) => {
  if (!cond) {
    failed = true;
    console.error(`FAIL: ${msg}`);
  } else console.log(`ok: ${msg}`);
};
const state = () => page.evaluate(() => window.__appleKicker.state());
const simulate = (seconds, keys = []) => page.evaluate(([s, k]) => window.__appleKicker.simulate(s, k), [seconds, keys]);
const kick = (dx, dy, foot, chip = false) => page.evaluate(([a, b, f, c]) => window.__appleKicker.kick(a, b, f, c), [dx, dy, foot, chip]);
const look = (yaw, pitch) => page.evaluate(([y, p]) => window.__appleKicker.look(y, p), [yaw, pitch]);
/** Real mouse click in the middle of an overlay element. */
const clickEl = async (sel) => {
  const el = await page.waitForSelector(sel, { state: 'visible' });
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
};
const shot = (name) => page.screenshot({ path: path.join(shots, name) });

const wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

/**
 * Turn towards the apple, walk up to it and kick it along the track
 * (aimYaw = 0 is straight down the lane). Returns the states around the kick.
 */
async function walkAndKick(foot, powerPx, aimYaw = 0, chip = false, shotName = null) {
  // These runs are about kicking, not about drinking: keep the thirst bar full.
  await page.evaluate(() => window.__appleKicker.game.debugThirst(1));
  // Let the apple come to rest first (it may still be rolling from the last kick).
  for (let i = 0; i < 6; i++) {
    if ((await state()).appleResting) break;
    await simulate(0.5);
  }
  const s = await state();
  const ddx = s.applePx - s.playerX;
  const ddz = s.applePz - s.playerZ;
  let yaw = Math.atan2(-ddx, -ddz);
  await look(yaw, -0.55);
  const dist = Math.hypot(ddx, ddz);
  // Sprint when it is far (but never the stamina empty: that leaves the player
  // out of breath), walk the rest; re-aim and walk on if still too far.
  let d = dist;
  for (let leg = 0; leg < 8 && d > 6; leg++) {
    const c = await state();
    if (c.stamina > 0.15) await simulate(Math.min((d - 5) / 6.4, c.stamina * 6 - 0.3), ['KeyW', 'ShiftLeft']);
    else await simulate(Math.min((d - 5) / 4.2, 2), ['KeyW']);
    const n = await state();
    d = Math.hypot(n.applePx - n.playerX, n.applePz - n.playerZ);
    yaw = Math.atan2(-(n.applePx - n.playerX), -(n.applePz - n.playerZ));
    await look(yaw, -0.55);
  }
  const rest = Math.min(d, 5);
  const walkTime = Math.max(0, (rest - 1.05) / 4.2);
  if (walkTime > 0) await simulate(walkTime, ['KeyW']);
  // Aim at the track centre 12 m ahead of the apple (plus the requested offset).
  const toPath = Math.atan2(-(s.pathAheadX - s.applePx), 12);
  // Drag vector relative to the facing direction: up = ahead, right = right.
  const a = wrap(toPath + aimYaw - yaw);
  const dx = Math.sin(-a) * powerPx;
  const dy = -Math.cos(a) * powerPx;
  await kick(dx, dy, foot, chip);
  await simulate(0.19);
  if (shotName) {
    await look(yaw, -1.0);
    await simulate(0.02);
    await shot(shotName);
    await look(yaw, -0.55);
  }
  await simulate(0.2);
  const during = await state();
  await simulate(2.5);
  const after = await state();
  console.log(`  kick ${foot} ${powerPx}px: dist=${dist.toFixed(2)} launch=${during.appleSpeed.toFixed(1)} m/s, ${s.appleMax.toFixed(1)} → ${after.appleMax.toFixed(1)} m, storm ${after.stormDistance.toFixed(0)} m`);
  return { before: s, during, after };
}

try {
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__appleKicker), null, { timeout: 30000 });
  await sleep(500);
  await shot('01-menu.png');
  const s0 = await state();
  check(s0.state === 'menu', 'game boots into the menu');
  check(s0.chunks >= 5, `initial chunks generated (${s0.chunks})`);
  check(s0.difficulty === 'easy' && s0.lives === 3, `easy with 3 lives is the default (${s0.difficulty}, ${s0.lives})`);
  // The gameplay checks below run in the hard mode (one life, as before).
  await clickEl('[data-difficulty="hard"]');
  check((await state()).difficulty === 'hard', 'clicking "Schwer" selects the hard mode');
  check((await state()).state === 'menu', 'choosing a difficulty does not start the game');

  await page.evaluate(() => window.__appleKicker.start());
  await sleep(100);
  const s1 = await state();
  check(s1.state === 'playing', 'game starts');

  // Look down: legs and apple should be in view.
  await look(0, -0.8);
  await simulate(0.3);
  await shot('02-start-legs.png');

  await simulate(0.6, ['KeyW']);
  const s2 = await state();
  // The apple sits 1.2 m ahead: the body bumps it and is held back a little.
  check(s2.playerZ < s1.playerZ - 0.8, `player walks forward (${s2.playerZ.toFixed(2)} m)`);
  check(s2.appleProgress > 1.3 || !s2.appleResting, `walking into the apple nudges it (${s2.appleProgress.toFixed(2)} m)`);

  // Mouse deltas without pointer lock rotate the view.
  await page.mouse.move(640, 360);
  await page.mouse.move(700, 360, { steps: 3 });
  await simulate(0.05);
  const s2b = await state();
  check(Math.abs(s2b.playerYaw - s2.playerYaw) > 0.05, `mouse movement turns the view (${(s2b.playerYaw - s2.playerYaw).toFixed(3)} rad)`);
  await look(0, -0.55);

  // First kick: right foot, straight, full power.
  const k1 = await walkAndKick('right', 300, 0, false, '02b-kick-pose.png');
  check(k1.during.appleSpeed > 5, `apple is flying after the kick (${k1.during.appleSpeed.toFixed(1)} m/s)`);
  if (k1.during.appleSpeed <= 5) console.log('kick debug:', JSON.stringify(k1));
  check(k1.after.appleMax > k1.before.appleMax + 10, `apple travelled far (${k1.before.appleMax.toFixed(1)} → ${k1.after.appleMax.toFixed(1)} m)`);
  await shot('03-after-kick.png');

  // Whiff: kicking with the apple far away must not launch it.
  const sw = await state();
  await look(sw.playerYaw + Math.PI, -0.4);
  await kick(0, -200, 'left');
  await simulate(0.35);
  const sw2 = await state();
  check(sw2.appleSpeed <= sw.appleSpeed + 0.5, `kicking without the apple in reach does nothing (${sw.appleSpeed.toFixed(2)} → ${sw2.appleSpeed.toFixed(2)} m/s)`);
  await simulate(1.0);

  // A few more kicks, alternating feet and a chip.
  let last = sw2;
  for (let i = 0; i < 6; i++) {
    const r = await walkAndKick(i % 2 ? 'left' : 'right', 260, (i - 3) * 0.08, i === 3);
    last = r.after;
  }
  await look((await state()).playerYaw, -0.3);
  await simulate(0.1);
  await shot('04-later.png');
  check(last.appleMax > 60, `apple progressed over several kicks (${last.appleMax.toFixed(1)} m)`);
  check(last.chunks >= Math.floor(last.appleMax / 32) + 4, `chunks stream in ahead of the player (${last.chunks})`);
  check(last.stormDistance > 0 && last.state === 'playing', `storm has not caught up yet (${last.stormDistance.toFixed(1)} m)`);

  // Obstacles further down the track.
  await page.evaluate(() => window.__appleKicker.teleport(420));
  await look(0, -0.35);
  await simulate(0.5);
  await shot('05-obstacles.png');
  const r2 = await walkAndKick('right', 320, 0);
  check(r2.after.appleMax > 420, `apple still moves in the obstacle zone (${r2.after.appleMax.toFixed(1)} m)`);

  // Apple in view: marked once it is at least 5 m away.
  const placeApple = (progress) =>
    page.evaluate((p) => {
      const g = window.__appleKicker.game;
      g.apple.reset(g.world.terrain.pathCenterX(p), -p);
      g.apple.maxProgress = Math.max(g.apple.maxProgress, p);
    }, progress);
  const lookAtApple = async () => {
    const s = await state();
    const ddx = s.applePx - s.playerX;
    const ddz = s.applePz - s.playerZ;
    const flat = Math.hypot(ddx, ddz);
    await look(Math.atan2(-ddx, -ddz), Math.atan2(s.applePy - (s.playerY + 1.62), flat));
    await simulate(0.05);
  };
  await page.evaluate(() => window.__appleKicker.teleport(300));
  await simulate(0.3);
  await placeApple(303);
  await lookAtApple();
  const m1 = await state();
  check(!m1.appleIndicator, `apple 3 m away in view is not marked (indicator=${m1.appleIndicator})`);
  await placeApple(308);
  await lookAtApple();
  const m2 = await state();
  await shot('05b-apple-marked.png');
  check(m2.appleIndicator, `apple 8 m away in view is marked (indicator=${m2.appleIndicator})`);
  await placeApple(375);
  await lookAtApple();
  const m3 = await state();
  check(m3.appleIndicator, `apple 75 m away in view is marked (indicator=${m3.appleIndicator})`);

  // The landscape changes every 1000 m and loops back to the forest.
  for (const [at, expected, name] of [[1150, 'greece', '05c-greece.png'], [1620, 'greece', '05d-greece-later.png'], [2150, 'forest', '05e-forest-again.png']]) {
    await page.evaluate((p) => window.__appleKicker.teleport(p), at);
    await look(0, -0.12);
    await simulate(0.3);
    await shot(name);
    const sl = await state();
    check(sl.landscape === expected, `landscape at ${at} m is ${expected} (${sl.landscape})`);
  }
  const rg = await walkAndKick('right', 320, 0);
  check(rg.after.appleMax > 2150, `apple still moves after the landscapes looped (${rg.after.appleMax.toFixed(1)} m)`);
  await page.evaluate(() => window.__appleKicker.teleport(1300));
  const rg2 = await walkAndKick('right', 320, 0);
  check(rg2.after.appleMax > 1300, `apple moves through Greek obstacles (${rg2.after.appleMax.toFixed(1)} m)`);

  // Storm catches the player (apple far ahead) → game over.
  await page.evaluate(() => {
    const g = window.__appleKicker.game;
    g.storm.progress = g.player.progress - 0.5;
  });
  await simulate(1);
  const o1 = await state();
  check(o1.state === 'over' && o1.stormPlayerDistance <= 0 && o1.stormAppleDistance > 0, `storm catching the player ends the run (player ${o1.stormPlayerDistance.toFixed(1)} m, apple ${o1.stormAppleDistance.toFixed(1)} m)`);

  // Storm catches the apple (player far ahead) → game over.
  await page.evaluate(() => window.__appleKicker.start());
  await page.evaluate(() => window.__appleKicker.teleport(300));
  await simulate(0.3);
  await placeApple(260);
  await page.evaluate(() => {
    const g = window.__appleKicker.game;
    g.storm.progress = 250;
  });
  await simulate(10);
  const s3 = await state();
  await shot('06-storm.png');
  check(s3.state === 'over' && s3.stormAppleDistance <= 0 && s3.stormPlayerDistance > 0, `storm catching the apple ends the run (apple ${s3.stormAppleDistance.toFixed(1)} m, player ${s3.stormPlayerDistance.toFixed(1)} m)`);

  // Restart works.
  await page.evaluate(() => window.__appleKicker.start());
  await simulate(0.2);
  const s4 = await state();
  check(s4.state === 'playing' && s4.appleMax < 1, 'restart creates a fresh run');

  // Easy mode: three lives, continue at the distance reached, on the path.
  await page.evaluate(() => window.__appleKicker.game.toMenu());
  await clickEl('[data-difficulty="easy"]');
  await shot('07-menu-easy.png');
  await page.evaluate(() => window.__appleKicker.start());
  await simulate(0.2);
  const e0 = await state();
  check(e0.state === 'playing' && e0.difficulty === 'easy' && e0.lives === 3, `easy run starts with 3 lives (${e0.difficulty}, ${e0.lives})`);
  const catchPlayer = () =>
    page.evaluate(() => {
      const g = window.__appleKicker.game;
      g.storm.progress = g.player.progress - 0.5;
    });
  // Reached distance where an obstacle lies on the path, so the respawn has to dodge it.
  const blocked = await page.evaluate(() => {
    const g = window.__appleKicker.game;
    for (let p = 1240; p < 1400; p += 0.5) {
      g.debugTeleport(p);
      if (!g.respawnClear(p)) return p;
    }
    return 1240;
  });
  await page.evaluate((p) => window.__appleKicker.teleport(p), blocked);
  await simulate(0.2);
  await catchPlayer();
  await simulate(0.5);
  const e1 = await state();
  await shot('08-life-lost.png');
  check(e1.state === 'lifelost' && e1.lives === 2, `storm takes a life in the easy mode (${e1.state}, ${e1.lives} left)`);
  await simulate(2);
  check((await state()).stormProgress === e1.stormProgress, 'the storm waits while the life-lost panel is open');
  await clickEl('[data-action="continue"]');
  await simulate(0.05);
  const e2 = await state();
  await look(e2.playerYaw, -0.3);
  await simulate(0.05);
  await shot('09-continue.png');
  const clear = await page.evaluate(() => window.__appleKicker.game.respawnClear(window.__appleKicker.game.player.progress));
  check(e2.state === 'playing' && e2.lives === 2, `"Weitermachen" continues the run (${e2.state})`);
  check(e2.appleMax === e1.appleMax, `distance reached is kept (${e2.appleMax.toFixed(1)} m)`);
  const pp = -e2.playerZ;
  check(pp <= blocked && pp > blocked - 40, `respawn is at the distance reached (${blocked} m → ${pp.toFixed(1)} m)`);
  check(clear, 'respawn spot is clear of obstacles');
  check(Math.abs(e2.playerGroundGap) < 0.02 && Math.abs(e2.appleGroundGap) < 0.02, `player and apple stand on the ground (${e2.playerGroundGap.toFixed(3)}, ${e2.appleGroundGap.toFixed(3)})`);
  check(Math.abs(e2.playerPathOffset) < 0.05, `player stands on the path (${e2.playerPathOffset.toFixed(2)} m off centre)`);
  check(Math.abs(e2.stormPlayerDistance - 58) < 1, `storm is placed behind as at the start (${e2.stormPlayerDistance.toFixed(1)} m)`);
  await simulate(1.5);
  const e3 = await state();
  check(e3.state === 'playing' && Math.abs(e3.playerGroundGap) < 0.02 && Math.abs(e3.appleProgress - e2.appleProgress) < 0.3, `nothing falls or rolls away after the respawn (apple ${e2.appleProgress.toFixed(2)} → ${e3.appleProgress.toFixed(2)})`);
  const r3 = await walkAndKick('right', 300, 0);
  check(r3.after.appleProgress > e2.appleProgress + 5, `apple can be kicked on after the respawn (${r3.after.appleProgress.toFixed(1)} m)`);
  // Second life lost, then the last one ends the run.
  await catchPlayer();
  await simulate(0.5);
  check((await state()).lives === 1, 'second catch leaves one life');
  await page.keyboard.press('Enter');
  await simulate(0.1);
  check((await state()).state === 'playing', 'Enter continues');
  await catchPlayer();
  await simulate(0.5);
  const e4 = await state();
  await shot('10-easy-over.png');
  check(e4.state === 'over' && e4.lives === 0, `losing the last life ends the run (${e4.state})`);

  // Kickstart (easy only): a fresh run that starts at the easy record.
  const rec = e4.best;
  check(rec >= e2.appleMax, `easy record is saved (${rec.toFixed(0)} m)`);
  await clickEl('[data-action="kickstart"]');
  await simulate(0.1);
  const k0 = await state();
  await look(k0.playerYaw, -0.3);
  await simulate(0.05);
  await shot('11-kickstart.png');
  check(k0.state === 'playing' && k0.lives === 3, `Kickstart starts a run with all lives (${k0.state}, ${k0.lives})`);
  check(Math.abs(k0.appleMax - rec) < 1e-6 && -k0.playerZ <= rec && -k0.playerZ > rec - 40, `Kickstart starts at the record (${rec.toFixed(1)} m → player at ${(-k0.playerZ).toFixed(1)} m)`);
  check(Math.abs(k0.playerGroundGap) < 0.02 && Math.abs(k0.playerPathOffset) < 0.05, 'Kickstart puts the player on the path');
  await page.evaluate(() => window.__appleKicker.game.pause());
  await clickEl('[data-action="restart"]');
  await simulate(0.1);
  check((await state()).appleMax < 1, 'restart from the pause menu begins at 0 m again');
  await page.evaluate(() => window.__appleKicker.game.pause());
  await page.evaluate(() => window.__appleKicker.game.toMenu());
  await clickEl('[data-difficulty="hard"]');
  check(await page.isHidden('[data-action="kickstart"]'), 'Kickstart is not offered in the hard mode');
  await clickEl('[data-difficulty="easy"]');
  check(await page.isVisible('[data-action="kickstart"]'), 'Kickstart is offered in the easy mode once there is a record');
  await shot('12-menu-kickstart.png');
  await page.evaluate(() => window.__appleKicker.start());
  await page.evaluate(() => window.__appleKicker.start());
  await simulate(0.2);
  const e5 = await state();
  check(e5.state === 'playing' && e5.lives === 3 && e5.appleMax < 1, 'restart gives all lives back');

  // Thirst: the bar drains, bottles on the path refill half of it, empty costs a life.
  check(e5.thirst > 0.99, `a run starts quenched (${e5.thirst.toFixed(3)})`);
  await simulate(2);
  const t0 = await state();
  check(t0.thirst < 0.96 && t0.thirst > 0.9, `the thirst bar drains (${t0.thirst.toFixed(3)})`);
  await page.evaluate(() => window.__appleKicker.teleport(300));
  await simulate(0.1);
  const bottles = await page.evaluate(() => window.__appleKicker.game.debugBottles());
  const ahead = bottles.filter((b) => -b.z > 303).sort((a, b) => b.z - a.z);
  check(ahead.length >= 3, `bottles float along the path ahead (${ahead.length})`);
  const offPath = await page.evaluate(
    (list) => Math.max(...list.map((b) => Math.abs(b.x - window.__appleKicker.game.world.terrain.pathCenterX(-b.z)))),
    ahead,
  );
  check(offPath < 1, `bottles lie on the path (max ${offPath.toFixed(2)} m off centre)`);
  const b0 = ahead[0];
  await page.evaluate((b) => {
    const g = window.__appleKicker.game;
    g.player.reset(b.x, b.z + 2.2, 0);
    g.debugLook(0, -0.5);
    g.debugThirst(0.3);
  }, b0);
  await simulate(0.05);
  await shot('13-bottle.png');
  const drunk = (await state()).bottles;
  await page.evaluate((b) => window.__appleKicker.game.player.reset(b.x, b.z, 0), b0);
  await simulate(0.05);
  const t1 = await state();
  check(t1.bottles === drunk + 1 && t1.thirst > 0.78 && t1.thirst <= 0.8, `a bottle refills half of the bar (${t1.bottles - drunk}, ${t1.thirst.toFixed(3)})`);
  await simulate(0.5);
  const t1b = await state();
  check(t1b.bottles === drunk + 1, 'a bottle can only be drunk once');
  await page.evaluate(() => window.__appleKicker.game.debugThirst(0.005));
  await simulate(0.5);
  const t2 = await state();
  check(t2.state === 'lifelost' && t2.lives === 2, `dying of thirst costs a life (${t2.state}, ${t2.lives} left)`);
  check((await page.textContent('.overlay-content')).includes('verdurstet'), 'the panel says you died of thirst');
  await shot('14-thirst-lifelost.png');
  await page.evaluate(() => window.__appleKicker.start());
  await simulate(0.1);
  check((await state()).thirst > 0.99, 'continuing quenches the thirst again');

  // Sprinting the stamina empty stops the player for a second.
  await page.evaluate(() => {
    window.__appleKicker.game.player.stamina = 0.03;
  });
  await simulate(0.4, ['KeyW', 'ShiftLeft']);
  const x0 = await state();
  check(x0.exhausted > 0.5, `empty stamina leaves the player out of breath (${x0.exhausted.toFixed(2)} s)`);
  check((await page.textContent('.message')).includes('Puste'), 'a hint says the player is out of breath');
  await simulate(0.4, ['KeyW']);
  const x1 = await state();
  check(Math.abs(x1.playerZ - x0.playerZ) < 0.3, `out of breath the player cannot walk (${(x0.playerZ - x1.playerZ).toFixed(2)} m)`);
  await simulate(0.5);
  await simulate(0.6, ['KeyW']);
  const x2 = await state();
  check(x2.exhausted === 0 && x2.playerZ < x1.playerZ - 0.6, `after a second the player walks again (${(x1.playerZ - x2.playerZ).toFixed(2)} m)`);

  // Frame rate estimate (software rendering, so only a rough sanity figure).
  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
          else resolve((frames * 1000) / (performance.now() - t0));
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(`approx. fps (software rendering, quality=${quality}): ${fps.toFixed(1)}`);
  console.log('final state:', JSON.stringify(await state()));
} catch (e) {
  failed = true;
  console.error('test crashed:', e);
}

check(errors.length === 0, `no page errors${errors.length ? `: \n${errors.join('\n')}` : ''}`);
await browser.close();
if (server) server.kill();
console.log(failed ? 'SMOKE TEST FAILED' : 'SMOKE TEST PASSED');
process.exit(failed ? 1 : 0);

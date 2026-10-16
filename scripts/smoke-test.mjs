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
const shot = (name) => page.screenshot({ path: path.join(shots, name) });

const wrap = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

/**
 * Turn towards the apple, walk up to it and kick it along the track
 * (aimYaw = 0 is straight down the lane). Returns the states around the kick.
 */
async function walkAndKick(foot, powerPx, aimYaw = 0, chip = false, shotName = null) {
  // Let the apple come to rest first (it may still be rolling from the last kick).
  for (let i = 0; i < 6; i++) {
    if ((await state()).appleResting) break;
    await simulate(0.5);
  }
  const s = await state();
  const ddx = s.applePx - s.playerX;
  const ddz = s.applePz - s.playerZ;
  const yaw = Math.atan2(-ddx, -ddz);
  await look(yaw, -0.55);
  const dist = Math.hypot(ddx, ddz);
  // Sprint when it is far, walk the last bit.
  if (dist > 6) await simulate((dist - 5) / 6.4, ['KeyW', 'ShiftLeft']);
  const rest = Math.min(dist, 5);
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
  for (const [at, expected, name] of [[1150, 'greece', '05c-greece.png'], [1620, 'greece', '05d-greece-later.png'], [2150, 'desert', '05e-desert.png'], [3150, 'forest', '05f-forest-again.png']]) {
    await page.evaluate((p) => window.__appleKicker.teleport(p), at);
    await look(0, -0.12);
    await simulate(0.3);
    await shot(name);
    const sl = await state();
    check(sl.landscape === expected, `landscape at ${at} m is ${expected} (${sl.landscape})`);
  }
  const rg = await walkAndKick('right', 320, 0);
  check(rg.after.appleMax > 3150, `apple still moves after the landscapes looped (${rg.after.appleMax.toFixed(1)} m)`);
  await page.evaluate(() => window.__appleKicker.teleport(1300));
  const rg2 = await walkAndKick('right', 320, 0);
  check(rg2.after.appleMax > 1300, `apple moves through Greek obstacles (${rg2.after.appleMax.toFixed(1)} m)`);

  // Desert camel: within 10 m it spits at once and then every second; a hit pushes the player ~5 m.
  const camelAt = await page.evaluate(() => {
    const k = window.__appleKicker;
    for (let p = 2050; p < 2950; p += 120) {
      k.teleport(p);
      let best = null;
      for (const list of k.game.world.obstacles.camels.values()) {
        for (const c of list) {
          const q = -c.group.position.z;
          if (q > p + 8 && (best === null || q < best.q)) best = { q, x: c.group.position.x, z: c.group.position.z };
        }
      }
      if (best) return best;
    }
    return null;
  });
  check(camelAt !== null, `a camel lies on the desert track (${camelAt ? camelAt.q.toFixed(0) + ' m' : 'none'})`);
  if (camelAt) {
    const standAt = async (dist) => {
      await page.evaluate(([c, dist]) => {
        const g = window.__appleKicker.game;
        g.debugTeleport(c.q - dist);
        g.storm.progress = c.q - dist - 50;
        // Keep the apple out of the way.
        g.apple.reset(g.world.terrain.pathCenterX(c.q - dist - 3), -(c.q - dist - 3));
        const pz = -(c.q - dist);
        const px = g.world.terrain.pathCenterX(c.q - dist) - (c.x - g.world.terrain.pathCenterX(c.q)) ;
        g.player.reset(px, pz, 0);
        g.debugLook(Math.atan2(-(c.x - px), -(c.z - pz)), -0.1);
      }, [camelAt, dist]);
    };
    await standAt(14);
    const f0 = await page.evaluate(() => window.__appleKicker.game.spit.fired);
    await simulate(4);
    const f1 = await page.evaluate(() => window.__appleKicker.game.spit.fired);
    check(f1 === f0, `camel ignores a player 14 m away (${f1 - f0} spits)`);
    await standAt(6);
    const before = await state();
    await simulate(0.05);
    const f2 = await page.evaluate(() => window.__appleKicker.game.spit.fired);
    check(f2 - f1 === 1, `camel spits at once when the player steps within 10 m (${f2 - f1} spits)`);
    const timer = await page.evaluate((c) => {
      for (const list of window.__appleKicker.game.world.obstacles.camels.values()) {
        for (const k of list) if (Math.abs(k.group.position.z - c.z) < 0.01) return k.timer;
      }
      return -1;
    }, camelAt);
    check(timer > 0.9 && timer <= 1, `next spit follows 1 s later (timer ${timer.toFixed(2)} s)`);
    await simulate(0.5);
    await shot('05g-camel.png');
    await simulate(1.5);
    const after = await state();
    const moved = Math.hypot(after.playerX - before.playerX, after.playerZ - before.playerZ);
    check(moved > 3.5, `a spit pushes the player about 5 m (${moved.toFixed(2)} m)`);
  }
  // Back to the state the storm checks below expect: player at 300 m, apple far ahead.
  await page.evaluate(() => window.__appleKicker.teleport(300));
  await placeApple(375);

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

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

/** If a gnome has run off with the apple, catch it and kick it over. */
async function freeApple() {
  for (let i = 0; i < 80; i++) {
    const s = await state();
    if (!s.appleHeld) return;
    await page.evaluate(() => window.__appleKicker.game.debugThirst(1));
    const dx = s.holderX - s.playerX;
    const dz = s.holderZ - s.playerZ;
    await look(Math.atan2(-dx, -dz), -0.4);
    if (Math.hypot(dx, dz) < 1.4) {
      await kick(0, -200, 'right');
      await simulate(0.35);
    } else await simulate(0.1, ['KeyW']);
  }
}

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
  // A gnome may have grabbed it on the way.
  await freeApple();
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
    if (c.stamina > 0.15) await simulate(Math.min((d - 5) / 6.4, c.stamina * 3 - 0.3), ['KeyW', 'ShiftLeft']);
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
  // Modes: the story is the default; the endless mode is locked until the story is won.
  check(s0.mode === 'story' && !s0.endlessUnlocked, `story mode is the default, endless locked (${s0.mode}, ${s0.endlessUnlocked})`);
  await clickEl('[data-mode="endless"]');
  check((await state()).mode === 'story', 'the locked endless mode cannot be chosen');
  // The checks below run in the endless mode (the landscapes loop, as before).
  await page.evaluate(() => window.__appleKicker.unlockEndless());
  await clickEl('[data-mode="endless"]');
  const sm = await state();
  check(sm.mode === 'endless' && sm.state === 'menu', `once unlocked the endless mode can be chosen (${sm.mode})`);
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
  for (const [at, expected, name] of [[1150, 'greece', '05c-greece.png'], [1620, 'greece', '05d-greece-later.png'], [2150, 'desert', '05e-desert.png'], [3150, 'antarctic', '05f-antarctic.png'], [4150, 'town', '05g-town.png'], [5150, 'forest', '05h-forest-again.png']]) {
    await page.evaluate((p) => window.__appleKicker.teleport(p), at);
    await look(0, -0.12);
    await simulate(0.3);
    await shot(name);
    const sl = await state();
    check(sl.landscape === expected, `landscape at ${at} m is ${expected} (${sl.landscape})`);
  }
  const rg = await walkAndKick('right', 320, 0);
  check(rg.after.appleMax > 5150, `apple still moves after the landscapes looped (${rg.after.appleMax.toFixed(1)} m)`);
  await page.evaluate(() => window.__appleKicker.teleport(1300));
  const rg2 = await walkAndKick('right', 320, 0);
  check(rg2.after.appleMax > 1300, `apple moves through Greek obstacles (${rg2.after.appleMax.toFixed(1)} m)`);

  // Desert camel: within 20 m it spits at once and then every second; a hit pushes the player ~5 m.
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
    await standAt(24);
    const f0 = await page.evaluate(() => window.__appleKicker.game.spit.fired);
    await simulate(4);
    const f1 = await page.evaluate(() => window.__appleKicker.game.spit.fired);
    check(f1 === f0, `camel ignores a player 24 m away (${f1 - f0} spits)`);
    await standAt(6);
    const before = await state();
    await simulate(0.05);
    const f2 = await page.evaluate(() => window.__appleKicker.game.spit.fired);
    check(f2 - f1 === 1, `camel spits at once when the player steps within 20 m (${f2 - f1} spits)`);
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
    check(moved > 4.5, `a spit pushes the player at least 5 m (${moved.toFixed(2)} m)`);
  }
  // Antarctica: obstacles on the track, and the ice monster with its icicles.
  await page.evaluate(() => window.__appleKicker.teleport(3300));
  const ra = await walkAndKick('right', 320, 0);
  check(ra.after.appleMax > 3300, `apple moves through Antarctic obstacles (${ra.after.appleMax.toFixed(1)} m)`);
  const visits = await page.evaluate(() => {
    const m = window.__appleKicker.game.iceMonster;
    return [0, 1, 2, 3, 8, 4].map((k) => m.triggersIn(k).length);
  });
  check(visits[3] >= 3 && visits[3] <= 4 && visits[4] >= 3 && visits[4] <= 4, `the ice monster turns up 3–4 times per Antarctic landscape (${visits[3]}, ${visits[4]})`);
  check(visits[0] + visits[1] + visits[2] + visits[5] === 0, `no ice monster elsewhere (${[...visits.slice(0, 3), visits[5]].join(', ')})`);
  // One in the next Antarctic landscape (the one at 3000 m may already be behind us).
  const trigger = await page.evaluate(() => window.__appleKicker.game.iceMonster.triggersIn(8)[0]);
  await page.evaluate((t) => {
    const k = window.__appleKicker;
    k.teleport(t - 30);
    k.game.storm.progress = t - 120;
  }, trigger);
  await simulate(0.5);
  check((await state()).monster === 'idle', 'the ice monster waits until the player comes near');
  // Walk up to it (stepping round the apple), then stand and watch.
  await page.evaluate((t) => {
    const g = window.__appleKicker.game;
    g.debugTeleport(t - 17);
    g.storm.progress = t - 120;
    g.apple.reset(g.world.terrain.pathCenterX(t - 15), -(t - 15));
  }, trigger);
  await simulate(0.1);
  const im0 = await state();
  check(im0.monster === 'enter' && im0.monsterAppearances === 1, `the ice monster charges onto the track (${im0.monster})`);
  const lookAtMonster = () => page.evaluate(() => {
    const g = window.__appleKicker.game;
    const m = g.iceMonster.group.position;
    const p = g.player.pos;
    g.debugLook(Math.atan2(-(m.x - p.x), -(m.z - p.z)), -0.15);
  });
  let im1 = im0;
  for (let i = 0; i < 12 && im1.monster !== 'rage'; i++) {
    await simulate(0.5);
    im1 = await state();
  }
  check(im1.monster === 'rage', `it reaches the track and rages there (${im1.monster})`);
  await simulate(2.5);
  await lookAtMonster();
  await simulate(0.05);
  await shot('05i-ice-monster.png');
  let im2 = await state();
  for (let i = 0; i < 20 && im2.monster !== 'idle'; i++) {
    await simulate(0.5);
    im2 = await state();
  }
  check(im2.monster === 'idle', `after a few seconds it runs off again (${im2.monster})`);
  check(im2.icicles >= 3, `it leaves icicles on the track (${im2.icicles})`);
  const ice = await page.evaluate(() => {
    const g = window.__appleKicker.game;
    const t = g.world.terrain;
    let off = 0;
    let blocked = 0;
    let minGap = Infinity;
    const list = g.iceMonster.icicles;
    for (const ic of list) {
      off = Math.max(off, Math.abs(ic.x - t.pathCenterX(ic.p)));
      let hit = false;
      g.world.colliders.forEachNear(ic.z, (c) => {
        if (c === ic.collider) hit = true;
      });
      if (hit) blocked++;
      for (const o of list) if (o !== ic) minGap = Math.min(minGap, Math.hypot(o.x - ic.x, o.z - ic.z));
    }
    const ps = list.map((ic) => ic.p);
    // A respawn with player and apple right beside an icicle near the centre line is refused.
    const central = list.filter((ic) => Math.abs(ic.x - t.pathCenterX(ic.p)) < 0.9);
    const clear = central.some((ic) => g.respawnClear(ic.p - 0.6));
    return { off, blocked, n: list.length, minGap, central: central.length, clear, from: Math.min(...ps) };
  });
  check(ice.off < 6.7, `icicles stand on and beside the track (max ${ice.off.toFixed(2)} m off centre)`);
  check(ice.blocked === ice.n, `every icicle is an obstacle (${ice.blocked}/${ice.n} colliders)`);
  check(ice.minGap >= 1.5, `icicles leave room to get through (closest ${ice.minGap.toFixed(2)} m)`);
  check(!ice.clear, `nobody respawns among the icicles (${ice.central} near the centre line)`);
  await page.evaluate((from) => {
    const g = window.__appleKicker.game;
    g.player.reset(g.world.terrain.pathCenterX(from - 4), -(from - 4), 0);
    g.debugLook(0, -0.2);
  }, ice.from);
  await simulate(0.05);
  await shot('05j-icicles.png');

  // Town: obstacles on the road, and zombies that follow the player, hit and can be kicked over.
  await page.evaluate(() => window.__appleKicker.teleport(4300));
  const rt = await walkAndKick('right', 320, 0);
  check(rt.after.appleMax > 4300, `apple moves through the town (${rt.after.appleMax.toFixed(1)} m)`);
  const zcount = await page.evaluate(() => {
    const k = window.__appleKicker;
    const seen = new Set();
    for (let p = 4050; p < 4950; p += 150) {
      k.teleport(p);
      for (const z of k.game.debugZombies()) if (-z.z > 4000 && -z.z < 5000) seen.add(z.id);
    }
    let elsewhere = 0;
    for (const p of [5300, 5600]) {
      k.teleport(p);
      elsewhere += k.game.debugZombies().filter((z) => -z.z > 5100).length;
    }
    return { town: seen.size, elsewhere };
  });
  check(zcount.town >= 3, `zombies wander about the town (${zcount.town})`);
  check(zcount.elsewhere === 0, `no zombies outside the town (${zcount.elsewhere})`);
  // Put a zombie on a clear bit of road and the player 24 m behind it.
  const zsetup = async (gap) => page.evaluate((gap) => {
    const k = window.__appleKicker;
    const g = k.game;
    k.teleport(4500);
    const zs = [...g.world.obstacles.zombies.values()].flat().filter((z) => z.state !== 'down' && -z.group.position.z > 4520);
    const zb = zs[0];
    // Only this one is about: the others lie knocked over.
    for (const o of [...g.world.obstacles.zombies.values()].flat()) if (o !== zb) o.state = 'down';
    const t = g.world.terrain;
    const zp = -zb.group.position.z;
    zb.group.position.x = t.pathCenterX(zp);
    zb.state = 'wander';
    zb.cooldown = 0;
    zb.homeX = zb.targetX = zb.group.position.x;
    zb.homeZ = zb.targetZ = zb.group.position.z;
    zb.pause = 99;
    g.player.reset(t.pathCenterX(zp - gap), -(zp - gap), 0);
    g.storm.progress = zp - gap - 150;
    g.debugThirst(1);
    window.__zombie = zb;
    return { id: zb.id, zp };
  }, gap);
  const zstate = () => page.evaluate(() => {
    const g = window.__appleKicker.game;
    const zb = window.__zombie;
    const p = g.player.pos;
    return { game: g.state, state: zb.state, dist: Math.hypot(zb.group.position.x - p.x, zb.group.position.z - p.z), cooldown: zb.cooldown, hits: g.zombieHorde.hits, swings: g.zombieHorde.swings, knocked: g.zombieHorde.knocked, stamina: g.player.stamina, exhausted: g.player.exhausted };
  });
  await zsetup(24);
  await simulate(1);
  const z0 = await zstate();
  check(z0.game === 'playing' && z0.state === 'wander', `a zombie ignores a player 24 m away (${z0.game}, ${z0.state}, ${z0.dist.toFixed(1)} m)`);
  await page.evaluate(() => {
    const g = window.__appleKicker.game;
    const zb = window.__zombie;
    const t = g.world.terrain;
    const q = -zb.group.position.z - 15;
    g.player.reset(t.pathCenterX(q), -q, 0);
  });
  await simulate(1);
  const z1 = await zstate();
  check(z1.state === 'chase' && z1.dist < 14.5, `within 20 m it follows the player (${z1.state}, ${z1.dist.toFixed(1)} m)`);
  // Stand still: it comes close, draws back and hits; the blow takes all of the stamina.
  let z2 = z1;
  for (let i = 0; i < 40 && z2.hits === 0; i++) {
    await page.evaluate(() => window.__appleKicker.game.debugThirst(1));
    await simulate(0.25);
    z2 = await zstate();
  }
  check(z2.hits === 1 && z2.dist < 2.2, `standing close it hits the player (${z2.hits} hits in ${z2.swings} swings at ${z2.dist.toFixed(2)} m)`);
  check(z2.stamina < 0.3 && z2.exhausted > 0.7, `a hit takes all the stamina (${z2.stamina.toFixed(2)}, out of breath ${z2.exhausted.toFixed(2)} s)`);
  await simulate(2.6);
  const z3 = await zstate();
  check(z3.swings === z2.swings, `it hits at most every 3 s (${z3.swings - z2.swings} more swings after 2.6 s)`);
  for (let i = 0; i < 12 && z3.swings === z2.swings; i++) {
    await simulate(0.25);
    Object.assign(z3, await zstate());
  }
  check(z3.swings === z2.swings + 1 && z3.hits === 2, `after the pause it hits again (${z3.swings - z2.swings} more swings, ${z3.hits} hits)`);
  // Stepping back while it draws back makes it miss.
  for (let i = 0; i < 50 && (await zstate()).state !== 'windup'; i++) await simulate(0.1);
  await page.evaluate(() => {
    const g = window.__appleKicker.game;
    const zb = window.__zombie;
    g.player.pos.z = zb.group.position.z + 3.2;
    g.player.pos.x = zb.group.position.x;
  });
  await simulate(1);
  const z4 = await zstate();
  check(z4.swings === z3.swings + 1 && z4.hits === 2, `stepping out of reach makes it miss (${z4.swings - z3.swings} more swings, ${z4.hits} hits)`);
  // Kick it over before it can hit.
  await zsetup(6);
  await page.evaluate(() => {
    const g = window.__appleKicker.game;
    const zb = window.__zombie;
    g.apple.reset(zb.group.position.x + 2.5, zb.group.position.z + 6);
  });
  for (let i = 0; i < 80 && (await zstate()).dist > 2.1; i++) await simulate(0.05);
  await page.evaluate(() => {
    const k = window.__appleKicker;
    const g = k.game;
    const zb = window.__zombie;
    const p = g.player.pos;
    k.look(Math.atan2(-(zb.group.position.x - p.x), -(zb.group.position.z - p.z)), -0.3);
  });
  await shot('05l-zombie.png');
  const zk0 = await zstate();
  await kick(0, -200, 'right');
  await simulate(0.4);
  const zk1 = await zstate();
  check(zk1.state === 'down' && zk1.knocked === zk0.knocked + 1, `a kick knocks the zombie over (${zk1.state})`);
  await simulate(4);
  const zk2 = await zstate();
  check(zk2.hits === zk1.hits, `a zombie that was kicked over hits nobody (${zk2.hits - zk1.hits} hits)`);
  await simulate(0.2);
  await shot('05m-zombie-down.png');

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
  check(await page.evaluate(() => document.fullscreenElement === document.documentElement), 'starting a run with a click enters fullscreen');
  await look(k0.playerYaw, -0.3);
  await simulate(0.05);
  await shot('11-kickstart.png');
  check(k0.state === 'playing' && k0.lives === 3, `Kickstart starts a run with all lives (${k0.state}, ${k0.lives})`);
  check(Math.abs(k0.appleMax - rec) < 1e-6 && -k0.playerZ <= rec && -k0.playerZ > rec - 40, `Kickstart starts at the record (${rec.toFixed(1)} m → player at ${(-k0.playerZ).toFixed(1)} m)`);
  check(Math.abs(k0.playerGroundGap) < 0.02 && Math.abs(k0.playerPathOffset) < 0.05, 'Kickstart puts the player on the path');
  // The storm is slowest at the start of every landscape and fastest at its end,
  // also after a respawn further down the path.
  const stormSpeedAt = async (m) => {
    await page.evaluate((x) => window.__appleKicker.game.placeRunAt(x), m);
    await simulate(0.05);
    return (await state()).stormSpeed;
  };
  const vStart = await stormSpeedAt(60);
  const vEnd = await stormSpeedAt(990);
  const vNext = await stormSpeedAt(1060);
  const vNextEnd = await stormSpeedAt(1990);
  check(vStart < 2.4 && vEnd > 3.7 && vNext < 2.4 && vNextEnd > 3.7, `storm speed follows the position in the landscape (${vStart.toFixed(2)} → ${vEnd.toFixed(2)}, ${vNext.toFixed(2)} → ${vNextEnd.toFixed(2)} m/s)`);
  // Walking into the next landscape gives back one lost life, never above the maximum.
  const crossInto = async (lives, from, to) => {
    await page.evaluate(([l, f, t]) => {
      const g = window.__appleKicker.game;
      g.placeRunAt(f);
      g.lives = l;
      g.player.reset(g.world.terrain.pathCenterX(t), -t, 0);
    }, [lives, from, to]);
    await simulate(0.05);
    return (await state()).lives;
  };
  const l1 = await crossInto(1, 2990, 3004);
  const l1again = await crossInto(1, 3005, 3010);
  const l2 = await crossInto(2, 3990, 4004);
  const lFull = await crossInto(3, 4990, 5004);
  check(l1 === 2 && l1again === 1 && l2 === 3 && lFull === 3, `next landscape gives back a life, once per landscape, at most 3 (${l1}, ${l1again}, ${l2}, ${lFull})`);
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
  check(e5.thirst > 0.98, `a run starts quenched (${e5.thirst.toFixed(3)})`);
  await simulate(2);
  const t0 = await state();
  check(t0.thirst < 0.92 && t0.thirst > 0.85, `the thirst bar drains (${t0.thirst.toFixed(3)})`);
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
  const gaps = ahead.slice(1).map((b, k) => ahead[k].z - b.z);
  check(gaps.length >= 3 && Math.min(...gaps) >= 8 - 0.01 && Math.max(...gaps) <= 28 + 0.01, `bottles are 8–28 m apart (${gaps.map((g) => g.toFixed(1)).join(', ')} m)`);
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
  check(t1.bottles === drunk + 1 && t1.thirst > 0.98, `a bottle fills the bar completely (${t1.bottles - drunk}, ${t1.thirst.toFixed(3)})`);
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
  const breath = await page.textContent('.message');
  check(breath.includes('Puste'), `a hint says the player is out of breath (${breath})`);
  await simulate(0.4, ['KeyW']);
  const x1 = await state();
  check(Math.abs(x1.playerZ - x0.playerZ) < 0.3, `out of breath the player cannot walk (${(x0.playerZ - x1.playerZ).toFixed(2)} m)`);
  await simulate(0.5);
  await simulate(0.6, ['KeyW']);
  const x2 = await state();
  check(x1.stamina > 0.55 && x1.stamina < 0.85, `catching the breath refills the stamina (${x1.stamina.toFixed(2)})`);
  check(x2.exhausted === 0 && x2.stamina > 0.95 && x2.playerZ < x1.playerZ - 0.6, `after a second the player walks again (${(x1.playerZ - x2.playerZ).toFixed(2)} m)`);

  // Greek gorge: a steel bridge whose railing is open low down. The player
  // cannot fall in; an apple that drops into the gorge costs a life.
  const gorges = await page.evaluate(() => window.__appleKicker.game.debugGorges(9));
  const perSection = {};
  for (const g of gorges) {
    const k = Math.floor(g.p / 1000);
    perSection[k] = (perSection[k] ?? 0) + 1;
  }
  check(gorges.length > 0 && Object.keys(perSection).every((k) => k % 5 === 1 && perSection[k] <= 2), `gorges only in Greece, at most two per section (${JSON.stringify(perSection)})`);
  const gz = gorges[0];
  const onBridge = (g, x, p, yaw = 0) =>
    page.evaluate(([g, x, p, yaw]) => {
      const k = window.__appleKicker.game;
      k.debugThirst(1);
      k.storm.progress = g.p - 200;
      k.player.reset(x, -p, yaw);
    }, [g, x, p, yaw]);
  await page.evaluate((g) => {
    const k = window.__appleKicker.game;
    k.debugTeleport(g.p - 32);
    k.storm.progress = g.p - 200;
    k.debugLook(0, -0.12);
  }, gz);
  await simulate(0.1);
  await shot('15-gorge-bridge.png');
  await onBridge(gz, gz.x, gz.p, -Math.PI / 2);
  await page.evaluate((g) => window.__appleKicker.game.debugApple(g.x, -(g.p + 22)), gz);
  await simulate(0.05);
  const gb0 = await state();
  check(Math.abs(gb0.playerY - gz.h - 0.06) < 0.02, `the bridge deck carries the player (${(gb0.playerY - gz.h).toFixed(3)} m above the track height)`);
  await simulate(1.5, ['KeyW']);
  const gb1 = await state();
  await onBridge(gz, gz.x, gz.p, Math.PI / 2);
  await simulate(1.5, ['KeyW']);
  const gb2 = await state();
  check(gb1.playerX - gz.x < 1.25 && gz.x - gb2.playerX < 1.25 && gb1.playerY > gz.h - 0.1 && gb2.playerY > gz.h - 0.1, `invisible walls keep the player on the deck (${(gb1.playerX - gz.x).toFixed(2)} / ${(gb2.playerX - gz.x).toFixed(2)} m)`);
  await onBridge(gz, gz.x + 8, gz.p - 21, 0);
  await simulate(3, ['KeyW']);
  const gb3 = await state();
  check(-gb3.playerZ < gz.p - 17.3 && gb3.playerY > gz.h - 1.5, `the player cannot walk off the rim into the gorge (stops ${(gz.p + gb3.playerZ).toFixed(2)} m before its centre)`);
  // An apple rolling along the deck crosses the bridge.
  await onBridge(gz, gz.x, gz.p - 20, 0);
  await page.evaluate((g) => {
    const k = window.__appleKicker.game;
    k.debugApple(g.x + 0.2, -(g.p - 18));
    k.apple.vel.set(0, 0, -11);
    k.apple.resting = false;
  }, gz);
  await simulate(5);
  const gb4 = await state();
  check(gb4.state === 'playing' && gb4.appleProgress > gz.p + 18, `an apple rolling straight crosses the bridge (${(gb4.appleProgress - gz.p).toFixed(1)} m past the centre)`);
  // Kicked sideways it falls through the railing into the gorge: a life is lost.
  const livesBefore = gb4.lives;
  await onBridge(gz, gz.x - 0.6, gz.p - 1.5, 0);
  await page.evaluate((g) => {
    const k = window.__appleKicker.game;
    k.debugApple(g.x + 0.6, -(g.p - 0.6));
    k.apple.vel.set(4.5, 0.6, -0.4);
    k.apple.resting = false;
    k.debugLook(-0.9, -0.35);
  }, gz);
  await simulate(0.32);
  await shot('16-gorge-apple-falls.png');
  await simulate(1.5);
  const gb5 = await state();
  check(gb5.state === 'lifelost' && gb5.lives === livesBefore - 1, `the apple falling into the gorge costs a life (${gb5.state}, ${livesBefore} → ${gb5.lives})`);
  check((await page.textContent('.overlay-content')).includes('Schlucht'), 'the panel says the apple fell into the gorge');
  await shot('17-gorge-lifelost.png');
  await clickEl('[data-action="continue"]');
  await simulate(0.2);
  const gb6 = await state();
  const respawnP = -gb6.playerZ;
  check(gb6.state === 'playing' && Math.abs(respawnP - gz.p) > 20 && Math.abs(gb6.playerGroundGap) < 0.02, `the respawn is on firm ground away from the gorge (${(respawnP - gz.p).toFixed(1)} m from its centre)`);

  // Forest gnomes: one that touches the apple runs off with it at half the
  // walking speed until the player kicks it over.
  const gnome = await page.evaluate(() => {
    const k = window.__appleKicker;
    for (const p of [3300, 3450, 3600, 3750, 3900, 300, 450, 600, 750, 900]) {
      k.teleport(p);
      k.game.storm.progress = p - 150;
      const list = k.game.debugGnomes().filter((q) => q.state === 'walk' && -q.homeZ > p + 8 && -q.homeZ < p + 80);
      list.sort((a, b) => b.homeZ - a.homeZ);
      if (list.length) return list[0];
    }
    return null;
  });
  check(gnome !== null, `gnomes walk on the forest track (${gnome ? (-gnome.homeZ).toFixed(0) + ' m' : 'none'})`);
  if (gnome) {
    const findGnome = () => page.evaluate((n) => window.__appleKicker.game.debugGnomes().find((q) => q.id === n.id), gnome);
    await page.evaluate((n) => {
      const k = window.__appleKicker.game;
      k.player.reset(n.x - 0.3, n.homeZ + 2.8, 0);
      k.debugLook(0, -0.3);
      k.debugApple(n.homeX + 6, n.homeZ + 8);
    }, gnome);
    await simulate(0.05);
    await shot('18-gnome.png');
    // A free apple within 20 m draws the gnome off its patrol, wherever the player is;
    // further away it is left alone.
    const n00 = await findGnome();
    await page.evaluate((n) => {
      const k = window.__appleKicker.game;
      k.player.reset(n.x, n.z + 40, 0);
      k.debugApple(n.x, n.z - 24);
    }, n00);
    await simulate(1);
    const nf = await findGnome();
    check(Math.abs(nf.z - n00.z) < 0.3, `a gnome ignores an apple 24 m away (${(n00.z - nf.z).toFixed(2)} m towards it)`);
    await page.evaluate((n) => window.__appleKicker.game.debugApple(n.x, n.z - 12), nf);
    await simulate(1);
    const nc = await findGnome();
    check(nf.z - nc.z > 1.5, `a gnome runs after an apple 12 m away, with the player 40 m off (${(nf.z - nc.z).toFixed(2)} m in 1 s)`);
    const n0 = await findGnome();
    await page.evaluate((n) => {
      const k = window.__appleKicker.game;
      k.player.reset(n.x, n.z + 6, 0);
      k.debugApple(n.x, n.z + 0.25);
    }, n0);
    await simulate(0.1);
    const gn1 = await state();
    check(gn1.appleHeld && gn1.gnomeGrabs >= 1, `a gnome grabs the apple it touches (held=${gn1.appleHeld})`);
    const n1 = await findGnome();
    await simulate(1);
    const n2 = await findGnome();
    const gn2 = await state();
    const ran = Math.hypot(n2.x - n1.x, n2.z - n1.z);
    check(n2.state === 'carry' && ran > 1.7 && ran < 2.3, `the gnome runs off with it at half the walking speed (${ran.toFixed(2)} m/s)`);
    check(Math.hypot(gn2.applePx - n2.x, gn2.applePz - n2.z) < 0.6, 'the apple travels in its hands');
    await shot('19-gnome-steals.png');
    // Chase it down and kick it.
    await freeApple();
    const gn3 = await state();
    const n3 = await findGnome();
    check(!gn3.appleHeld && n3.state === 'down' && gn3.gnomeKnocked >= 1, `kicking the gnome knocks it over and frees the apple (${n3.state}, held=${gn3.appleHeld})`);
    await simulate(0.8);
    await look((await state()).playerYaw, -0.55);
    await simulate(0.05);
    await shot('20-gnome-down.png');
    const stars = await page.evaluate((n) => {
      for (const list of window.__appleKicker.game.world.obstacles.gnomes.values()) {
        for (const g of list) if (g.id === n.id) return g.stars.visible ? g.stars.children.length : 0;
      }
      return -1;
    }, gnome);
    check(stars >= 2 && stars <= 3, `the fallen gnome has ${stars} stars over its head`);
    const gn4 = await state();
    check(!gn4.appleHeld && gn4.state === 'playing', 'the fallen gnome does not take the apple again');
    // Stand right behind the freed apple and kick it on (other gnomes nearby lie down for this).
    await page.evaluate(() => {
      const k = window.__appleKicker.game;
      for (const list of k.world.obstacles.gnomes.values()) {
        for (const g of list) if (Math.abs(g.group.position.z - k.apple.pos.z) < 60) g.state = 'down';
      }
      k.player.reset(k.apple.pos.x, k.apple.pos.z + 1.1, 0);
    });
    const r4 = await walkAndKick('right', 300, 0);
    check(r4.after.appleProgress > gn3.appleProgress + 4, `the freed apple can be kicked on (${r4.after.appleProgress.toFixed(1)} m)`);
  }

  // Story mode: every landscape once, then the snowy home stretch where the
  // path ends at a cabin. Apple and player inside = won, endless unlocked.
  await page.evaluate(() => {
    const k = window.__appleKicker;
    k.game.toMenu();
    k.unlockEndless(false);
    k.setMode('story');
    k.setDifficulty('easy');
    k.start();
  });
  // Starting asks for the pointer lock; losing it again pauses, so start (resume) once more.
  await page.evaluate(() => window.__appleKicker.start());
  await simulate(0.2);
  const st0 = await state();
  check(st0.mode === 'story' && !st0.endlessUnlocked && st0.state === 'playing', `a story run starts with endless locked (${st0.mode})`);
  const hut = await page.evaluate(() => window.__appleKicker.game.world.terrain.hut());
  check(hut && Math.abs(hut.p - 5060) < 1, `the story ends at a cabin at 5060 m (${hut && hut.p})`);
  for (const [at, expected] of [[4500, 'town'], [5050, 'home'], [7000, 'home']]) {
    await page.evaluate((p) => window.__appleKicker.teleport(p), at);
    const sl = await state();
    check(sl.landscape === expected, `story: landscape at ${at} m is ${expected} (${sl.landscape})`);
  }
  await page.evaluate((h) => {
    const k = window.__appleKicker;
    k.teleport(h.p - 30);
    k.game.storm.progress = h.p - 200;
  }, hut);
  await look(0, -0.08);
  await simulate(0.3);
  await shot('21-cabin.png');
  // The invisible wall: the player cannot walk past the cabin, the apple is not kicked past it.
  const past = await page.evaluate((h) => {
    const g = window.__appleKicker.game;
    g.player.reset(h.cx + 8, -(h.p - 2), 0);
    g.debugApple(h.cx - 9, -(h.p - 1));
    g.apple.vel.set(0, 0, -12);
    g.apple.resting = false;
    g.storm.progress = h.p - 200;
    window.__appleKicker.simulate(3, ['KeyW']);
    return { player: -g.player.pos.z, apple: -g.apple.pos.z };
  }, hut);
  check(past.player < hut.p && past.apple < hut.p, `nobody gets past the cabin (player ${past.player.toFixed(1)}, apple ${past.apple.toFixed(1)}, front ${hut.p.toFixed(1)} m)`);
  // Kick the apple through the open door and walk in after it.
  await page.evaluate((h) => {
    const g = window.__appleKicker.game;
    g.player.reset(h.x, -(h.p - 5), 0);
    g.debugApple(h.x, -(h.p - 3.9));
    g.storm.progress = h.p - 200;
  }, hut);
  await page.evaluate(() => window.__appleKicker.start());
  await look(0, -0.5);
  await simulate(0.1);
  await kick(0, -110, 'right');
  await simulate(2.5);
  const sk = await state();
  check(-sk.applePz > hut.p + 0.4 && sk.state === 'playing', `the apple rolls into the cabin (${(-sk.applePz).toFixed(1)} m) and the run goes on until the player follows`);
  await look(0, -0.15);
  await shot('22-apple-in-cabin.png');
  await page.evaluate(() => window.__appleKicker.game.debugThirst(1));
  await simulate(1.6, ['KeyW']);
  const sw3 = await state();
  check(sw3.state === 'won', `walking in after the apple wins the story (${sw3.state})`);
  check(sw3.endlessUnlocked, 'winning the story unlocks the endless mode');
  await shot('23-won.png');
  check(await page.$('.overlay h2') !== null && (await page.textContent('.overlay h2')).includes('zuhause'), 'the win screen is shown');
  await page.evaluate(() => window.__appleKicker.game.toMenu());
  check((await page.$('[data-mode="endless"].locked')) === null, 'the menu offers the endless mode after the win');

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

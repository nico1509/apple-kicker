<p align="center"><img src="docs/logo.png" alt="Apple Kicker Logo" width="480"></p>

# Apple Kicker

A small 3D browser game: you stand on a procedurally generated country lane in a
golden October and kick your apple as far down the lane as you can – while a
thunderstorm front closes in from behind.

The game speaks German and English and picks the language from the browser's
preferred languages (German for any `de` locale such as de-DE, de-AT or de-CH,
English otherwise).

## Playing

Play here: https://nico-assfalg.de/apple-kicker/

All you need is Node.js (≥ 20.19 or ≥ 22.12) and a browser with WebGL.

```bash
npm install
npm run dev
```

Then open the address shown (usually <http://localhost:5173>) in the browser and
press **Click to start**. The mouse pointer is captured (Pointer Lock),
`Esc` or `P` pauses.

On slow machines, append `?quality=low` or `?quality=medium` to the address
(fewer or no shadows, no antialiasing).

### Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | walk |
| `Shift` | sprint (limited stamina; sprint it completely empty and you are out of breath for a second, then it is full again) |
| Mouse | look around |
| Hold the **left mouse button**, drag, release | kick |
| short click | small tap forward |
| hold `Space` while releasing | high chip (over roots and logs) |
| `M` | sound on/off |
| `P` / `Esc` | pause (in the pause menu: `R` = restart) |
| `Enter` / `R` | after losing a life: carry on / start over |

The **drag direction** sets the direction of the kick (drag up = straight ahead),
the **drag length** its power. The apple has to lie right in front of your feet.

#### Touch controls

On phones and tablets, semi-transparent controls appear automatically:

| Input | Action |
| --- | --- |
| stick up / down | walk forward / backward (pushed past the rim = sprint) |
| stick left / right | turn left / right |
| swipe (anywhere else on the screen) | kick, like with the mouse: swipe direction = kick direction, swipe length = power; a short tap = small tap |
| hold the red button next to the stick | high chip |
| pause button top right | pause |

### Rules

* What counts is the distance the **apple** travels along the path.
* A storm front with rain and thunder is closing in behind you. It gets faster
  along the way and eases off again now and then. If it catches **you or your
  apple**, you lose a life.
* Kicking makes you thirsty: the **thirst bar** drains fast. Bottles of apple
  spritzer float along the path, each one fills the bar and your stamina all the
  way up again. If it runs empty, you have died of thirst – that costs a life too.
* In the start menu you pick the mode:
  * **Story**: the path has a destination – every stage comes only once. Can you make it to the end?
  * **Endless**: the path never ends. This mode is unlocked once you have finished
    the story mode.
* You also pick the difficulty (in both modes):
  * **Hard**: one life – once caught, the run is over.
  * **Easy**: three lives (shown as apples at the top). After being caught you can
    **carry on** – player, apple and storm are then placed on the path as at the
    start, but at the distance you have already reached – or **start over** with all lives.
    In dev builds, **Kickstart** begins a new run right at your easy record.
* Once the apple is at least 5 m away from you, it is always marked, even when it
  is in view.
* More and more obstacles appear along the way: roots, branches, stones,
  puddles, fallen logs and hills. Kick harder, chip over them or find a way around.
* The apple rolls best in the wheel tracks; on grass and fields it slows down faster.
* The record is saved separately for every mode and difficulty in the browser
  (localStorage), as is the unlocked endless mode.

## Technology

* [three.js](https://threejs.org/) for the 3D rendering, [Vite](https://vite.dev/) + TypeScript for the build.
* Everything is procedural: the world grows from a seed (height field, course of the
  path, biomes such as forest, meadow, hedge, field and vineyard, trees, obstacles).
  No external assets are loaded – even the sounds are synthesised with the Web Audio API.
* The apple's physics is a small custom sphere-against-height-field simulation with
  capsule, sphere and cylinder colliders for roots, logs, stones and trees.
* Flat shading and few polygons give the stylised low-poly look.
* The in-game texts live in `src/i18n.ts`, one table per language.

### Scripts

```bash
npm run dev        # development server (with the Kickstart buttons)
npm run build      # type check + production build into dist/ (without the Kickstart buttons)
npm run preview    # view the production build locally
npm run smoke      # headless test with Chromium (point CHROME_PATH at a Chrome/Chromium)
```

The production build in `dist/` is fully static and runs from any web server
(also from a sub-directory, e.g. GitHub Pages).

### Logo

The logo uses the font [Luckiest Guy](https://fonts.google.com/specimen/Luckiest+Guy)
by Astigmatic (Apache License 2.0), bundled locally under `public/fonts/`.
The apple from the logo doubles as the favicon (`public/favicon.svg`).

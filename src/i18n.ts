/**
 * In-game texts in German and English. The language follows the browser's
 * preferred languages: the first one that is German (de, de-DE, de-AT, de-CH …)
 * or English decides; anything else falls back to English.
 */
export type Lang = 'de' | 'en';

export function pickLang(languages: readonly string[]): Lang {
  for (const l of languages) {
    const code = l.toLowerCase();
    if (code === 'de' || code.startsWith('de-')) return 'de';
    if (code === 'en' || code.startsWith('en-')) return 'en';
  }
  return 'en';
}

function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages && navigator.languages.length > 0) return [...navigator.languages];
  return navigator.language ? [navigator.language] : [];
}

export const lang: Lang = pickLang(browserLanguages());

const m = (x: number): string => `${Math.floor(x)} m`;

const de = {
  // HUD
  apple: 'Apfel',
  thirst: 'Durst',
  stamina: 'Ausdauer',
  storm: 'Gewitter',
  livesOf: (left: number, total: number) => `${left} von ${total} Leben`,
  record: (best: number) => `Rekord ${m(best)}`,
  stormBehind: (d: number, apple: boolean) => `${Math.round(d)} m hinter ${apple ? 'dem Apfel' : 'dir'}`,
  tap: 'Stupser',
  chip: 'Lupfer',
  appleDistance: (d: number) => `Apfel ${Math.round(d)} m`,

  // Main menu
  kickstartAt: (record: number) => `Kickstart bei ${m(record)}`,
  recordHtml: (best: number) => `Rekord <b>${m(best)}</b>`,
  noRecord: 'Noch kein Rekord',
  mode: 'Modus',
  story: 'Story',
  storyText: 'Ein Weg mit Ziel. Kommst du mit deinem Apfel an?',
  endless: 'Endlos',
  endlessText: 'Der Weg hört nie auf. Wie weit kommst du?',
  endlessLocked: 'Wird freigeschaltet, wenn du den Story-Modus geschafft hast.',
  tagline: 'Goldener Oktober, ein Apfel, ein Feldweg – und ein Gewitter im Nacken.',
  rulesGoal: (story: boolean) =>
    `${story ? 'Kicke deinen Apfel den Weg entlang, bis ans Ende.' : 'Kicke deinen Apfel so weit wie möglich den Weg entlang.'} Gezählt werden die Meter, die der <b>Apfel</b> zurücklegt.`,
  rulesStorm: 'Von hinten zieht eine Schlechtwetterfront heran. Holt sie dich oder deinen Apfel ein, kostet das ein Leben.',
  rulesThirst:
    'Kicken macht schnell durstig: Sammle die Apfelschorle-Flaschen auf dem Weg ein, sie füllen auch deine Ausdauer auf. Ist die Durst-Anzeige leer, kostet das ebenfalls ein Leben.',
  rulesObstacles: 'Wurzeln, Äste, Steine, Pfützen und Hügel werden mit der Zeit mehr – kick fester oder lupf drüber.',
  difficulty: 'Schwierigkeit',
  easy: 'Einfach',
  easyText: '3 Leben, danach geht es an der erreichten Stelle weiter',
  hard: 'Schwer',
  hardText: 'Ein Leben, eingeholt ist vorbei',
  startHtml: '<span class="only-mouse">Klicken</span><span class="only-touch">Tippen</span> zum Starten',
  touchHelpHtml: `<span><b>Stick</b> hoch/runter = laufen, links/rechts = drehen, über den Rand = sprinten</span>
        <span><b>Wischen</b> = Kick</span><span><b>Roter Knopf</b> halten = Lupfer</span>`,
  mouseHelpHtml: `<span><b>WASD</b> laufen</span><span><b>Shift</b> sprinten</span>
        <span><b>Maustaste</b> halten, ziehen, loslassen = Kick</span>
        <span><b>Leertaste</b> halten = Lupfer</span>`,
  mouseNoteHtml: 'Der Mauszeiger wird im Spiel eingefangen · <kbd>Esc</kbd> oder <kbd>P</kbd> pausiert · <kbd>M</kbd> Ton an/aus',

  // Pause
  pause: 'Pause',
  pauseText: 'Der Apfel wartet. Das Gewitter auch.',
  resume: 'Weiter',
  restart: 'Neustart',
  mainMenu: 'Hauptmenü',
  pauseKeysHtml: '<kbd>Enter</kbd> / <kbd>P</kbd> = weiter · <kbd>R</kbd> = Neustart',

  // Life lost / game over / won
  causeThirst: 'Du bist verdurstet. Unterwegs liegt Apfelschorle!',
  causeGorge: 'Dein Apfel ist in die Schlucht gefallen.',
  causeApple: 'Das Gewitter hat deinen Apfel eingeholt.',
  causePlayer: 'Das Gewitter hat dich eingeholt.',
  lifeLost: 'Ein Leben verloren!',
  livesLeftHtml: (left: number, score: number) => `Noch <b>${left} Leben</b> · dein Apfel ist bei <b>${m(score)}</b>.`,
  continue: 'Weitermachen',
  restartAll: 'Neu starten',
  lifeLostKeysHtml: (score: number) => `<kbd>Enter</kbd> = weitermachen bei ${m(score)} · <kbd>R</kbd> = neu starten mit allen Leben`,
  overThirst: 'Verdurstet!',
  overGorge: 'Der Apfel ist in die Schlucht gefallen!',
  overApple: 'Das Gewitter hat deinen Apfel eingeholt!',
  overPlayer: 'Vom Gewitter eingeholt!',
  noLivesLeft: 'Keine Leben mehr',
  allLivesUsed: 'Alle Leben sind verbraucht.',
  scoreHtml: (score: number) => `Dein Apfel kam <b>${m(score)}</b> weit.`,
  newRecord: 'Neuer Rekord!',
  recordLineHtml: (best: number) => `Rekord: <b>${m(best)}</b>`,
  tryAgain: 'Nochmal versuchen',
  menu: 'Menü',
  orPressEnterHtml: 'oder <kbd>Enter</kbd> drücken',
  wonTitle: 'Sicher zuhause angekommen!',
  wonText: 'Du hast deinen Apfel den ganzen Weg nach Hause gebracht. Drinnen ist es warm.',
  wonScoreHtml: (score: number, time: string) => `Dein Apfel kam <b>${m(score)}</b> weit, in <b>${time} min</b>.`,
  endlessUnlocked: 'Der Endlos-Modus ist jetzt freigeschaltet!',
  playAgain: 'Nochmal spielen',

  // Messages during a run
  highChip: 'Hoher Lupfer!',
  fullPower: 'Volle Kraft!',
  whiff: 'Verfehlt! Der Apfel muss dicht vor dem Fuß liegen.',
  exhausted: 'Aus der Puste! Kurz verschnaufen …',
  startTouch: 'Lauf zum Apfel. Wischen = Kick!',
  startMouse: 'Lauf zum Apfel. Maustaste halten, ziehen, loslassen = Kick!',
  continueAt: (reached: number) => `Weiter geht's bei ${m(reached)}!`,
  kickstartGo: (record: number) => `Kickstart bei ${m(record)}!`,
  soundOff: 'Ton aus',
  soundOn: 'Ton an',
  spat: 'Angespuckt!',
  gnomeGrab: 'Ein Wichtel hat deinen Apfel geklaut! Kick ihn um!',
  zombieChase: 'Ein Zombie! Kick ihn um, bevor er zuschlägt!',
  zombieHit: 'Ein Zombie hat dich erwischt! Keine Puste mehr …',
  iceMonster: 'Ein Eismonster! Vorsicht vor den Eiszapfen!',
  knockedOver: 'Umgerannt!',
  obstaclesAhead: (touch: boolean) => `Hindernisse voraus! Fester kicken – oder mit ${touch ? 'dem roten Knopf' : 'Leertaste'} lupfen.`,
  stormOnApple: 'Das Gewitter holt deinen Apfel ein – kick ihn weiter!',
  stormOnPlayer: 'Das Gewitter holt auf – lauf!',
  lifeBack: 'Ein Leben zurück!',
  energyDrink: 'Energydrink! Doppelt so schnell sprinten!',
  spritzer: 'Apfelschorle! Ahh …',
  thirsty: 'Durst! Schnapp dir eine Apfelschorle auf dem Weg.',
  gnomeDropped: 'Umgekickt! Der Wichtel lässt den Apfel fallen.',
  gnomeDown: 'Wichtel umgekickt!',
  zombieDown: 'Zombie umgekickt!',

  // Touch controls
  chipButton: 'Lupfer',
  pauseButton: 'Pause',

  // Boot failure
  bootFailed: 'Konnte das Spiel nicht starten',
  noWebgl: 'Dein Browser unterstützt vermutlich kein WebGL.',
};

export type Strings = typeof de;

const en: Strings = {
  apple: 'Apple',
  thirst: 'Thirst',
  stamina: 'Stamina',
  storm: 'Storm',
  livesOf: (left, total) => `${left} of ${total} lives`,
  record: (best) => `Record ${m(best)}`,
  stormBehind: (d, apple) => `${Math.round(d)} m behind ${apple ? 'the apple' : 'you'}`,
  tap: 'Tap',
  chip: 'Chip',
  appleDistance: (d) => `Apple ${Math.round(d)} m`,

  kickstartAt: (record) => `Kickstart at ${m(record)}`,
  recordHtml: (best) => `Record <b>${m(best)}</b>`,
  noRecord: 'No record yet',
  mode: 'Mode',
  story: 'Story',
  storyText: 'A path with a destination. Will you and your apple make it?',
  endless: 'Endless',
  endlessText: 'The path never ends. How far can you get?',
  endlessLocked: 'Unlocked once you have finished the story mode.',
  tagline: 'Golden October, an apple, a country lane – and a thunderstorm on your heels.',
  rulesGoal: (story) =>
    `${story ? 'Kick your apple down the path, all the way to the end.' : 'Kick your apple down the path as far as you can.'} What counts is the distance the <b>apple</b> travels.`,
  rulesStorm: 'A storm front is closing in from behind. If it catches you or your apple, you lose a life.',
  rulesThirst:
    'Kicking makes you thirsty fast: grab the apple spritzer bottles along the path, they refill your stamina too. If the thirst bar runs empty, that costs a life as well.',
  rulesObstacles: 'Roots, branches, stones, puddles and hills pile up over time – kick harder or chip over them.',
  difficulty: 'Difficulty',
  easy: 'Easy',
  easyText: '3 lives, then you carry on where you got to',
  hard: 'Hard',
  hardText: 'One life, caught means game over',
  startHtml: '<span class="only-mouse">Click</span><span class="only-touch">Tap</span> to start',
  touchHelpHtml: `<span><b>Stick</b> up/down = walk, left/right = turn, past the rim = sprint</span>
        <span><b>Swipe</b> = kick</span><span>Hold the <b>red button</b> = chip</span>`,
  mouseHelpHtml: `<span><b>WASD</b> walk</span><span><b>Shift</b> sprint</span>
        <span>Hold, drag, release the <b>mouse button</b> = kick</span>
        <span>Hold <b>Space</b> = chip</span>`,
  mouseNoteHtml: 'The mouse pointer is captured in the game · <kbd>Esc</kbd> or <kbd>P</kbd> pauses · <kbd>M</kbd> sound on/off',

  pause: 'Paused',
  pauseText: 'The apple is waiting. So is the storm.',
  resume: 'Resume',
  restart: 'Restart',
  mainMenu: 'Main menu',
  pauseKeysHtml: '<kbd>Enter</kbd> / <kbd>P</kbd> = resume · <kbd>R</kbd> = restart',

  causeThirst: 'You died of thirst. There is apple spritzer along the way!',
  causeGorge: 'Your apple fell into the gorge.',
  causeApple: 'The storm caught your apple.',
  causePlayer: 'The storm caught you.',
  lifeLost: 'You lost a life!',
  livesLeftHtml: (left, score) => `<b>${left} ${left === 1 ? 'life' : 'lives'}</b> left · your apple is at <b>${m(score)}</b>.`,
  continue: 'Carry on',
  restartAll: 'Start over',
  lifeLostKeysHtml: (score) => `<kbd>Enter</kbd> = carry on at ${m(score)} · <kbd>R</kbd> = start over with all lives`,
  overThirst: 'Died of thirst!',
  overGorge: 'The apple fell into the gorge!',
  overApple: 'The storm caught your apple!',
  overPlayer: 'Caught by the storm!',
  noLivesLeft: 'No lives left',
  allLivesUsed: 'All lives are used up.',
  scoreHtml: (score) => `Your apple made it <b>${m(score)}</b>.`,
  newRecord: 'New record!',
  recordLineHtml: (best) => `Record: <b>${m(best)}</b>`,
  tryAgain: 'Try again',
  menu: 'Menu',
  orPressEnterHtml: 'or press <kbd>Enter</kbd>',
  wonTitle: 'Safely home!',
  wonText: 'You brought your apple all the way home. It is warm inside.',
  wonScoreHtml: (score, time) => `Your apple made it <b>${m(score)}</b>, in <b>${time} min</b>.`,
  endlessUnlocked: 'The endless mode is now unlocked!',
  playAgain: 'Play again',

  highChip: 'High chip!',
  fullPower: 'Full power!',
  whiff: 'Missed! The apple has to be right in front of your foot.',
  exhausted: 'Out of breath! Catch your breath …',
  startTouch: 'Run to the apple. Swipe = kick!',
  startMouse: 'Run to the apple. Hold, drag, release the mouse button = kick!',
  continueAt: (reached) => `Carrying on at ${m(reached)}!`,
  kickstartGo: (record) => `Kickstart at ${m(record)}!`,
  soundOff: 'Sound off',
  soundOn: 'Sound on',
  spat: 'Spat at!',
  gnomeGrab: 'A gnome stole your apple! Kick it over!',
  zombieChase: 'A zombie! Kick it over before it strikes!',
  zombieHit: 'A zombie got you! Out of breath …',
  iceMonster: 'An ice monster! Watch out for the icicles!',
  knockedOver: 'Knocked over!',
  obstaclesAhead: (touch) => `Obstacles ahead! Kick harder – or chip over them with ${touch ? 'the red button' : 'Space'}.`,
  stormOnApple: 'The storm is catching your apple – keep kicking!',
  stormOnPlayer: 'The storm is catching up – run!',
  lifeBack: 'A life back!',
  energyDrink: 'Energy drink! Sprint twice as fast!',
  spritzer: 'Apple spritzer! Ahh …',
  thirsty: 'Thirsty! Grab an apple spritzer on the way.',
  gnomeDropped: 'Kicked over! The gnome drops the apple.',
  gnomeDown: 'Gnome kicked over!',
  zombieDown: 'Zombie kicked over!',

  chipButton: 'Chip',
  pauseButton: 'Pause',

  bootFailed: 'Could not start the game',
  noWebgl: 'Your browser probably does not support WebGL.',
};

/** The texts in the browser's language. */
export const T: Strings = lang === 'de' ? de : en;

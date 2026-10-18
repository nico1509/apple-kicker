/** Central place for all gameplay tunables. */
export const CFG = {
  chunk: {
    length: 32, // metres along the path per chunk
    halfWidth: 44, // metres of detailed terrain to each side of x = 0
    fineHalfWidth: 22, // |x| below this uses the fine grid
    fineStep: 0.5,
    coarseStep: 1,
    farExtent: 300, // coarse backdrop strips reach this far out
    farStep: 8,
    ahead: 6, // chunks kept ahead of the player
    behind: 2, // chunks kept behind the player
  },
  path: {
    halfWidth: 1.6,
    rutCenter: 0.85,
    maxWander: 12, // maximum lateral offset of the path centre line
    startLineZ: 2, // the player cannot walk back past this z; the apple stops 0.6 m before it
  },
  player: {
    eyeHeight: 1.62,
    radius: 0.32,
    walkSpeed: 4.2,
    sprintSpeed: 6.6,
    accel: 22,
    staminaMax: 3, // seconds of sprint
    staminaRegen: 0.3, // seconds of stamina regained per second (a tenth of the bar per second)
    exhaustedSeconds: 1, // sprinting the stamina empty stops the player for this long, then it is full again
    pitchMin: -1.5,
    pitchMax: 1.1,
    lookSensitivity: 0.0022,
  },
  apple: {
    radius: 0.085,
    gravity: 9.81,
    restitution: 0.36,
    airDrag: 0.06,
    maxSpeed: 30,
    markDistance: 5, // from this distance to the player on the apple is always marked
  },
  kick: {
    maxDragPx: 320,
    tapThresholdPx: 14,
    tapPower: 0.03,
    minSpeed: 2.6,
    maxSpeed: 17.5,
    minElevationDeg: 7,
    maxElevationDeg: 33,
    chipElevationDeg: 52,
    chipSpeedFactor: 0.78,
    reach: 1.85, // metres from the hips to the apple
  },
  thirst: {
    drainSeconds: 17.5, // a full thirst bar empties in this time
    refill: 1, // one bottle fills the bar completely
    warnBelow: 0.25,
    firstBottle: 20, // no bottles on the first metres
    minGap: 8, // metres between two bottles along the path, at least ...
    maxGap: 28, // ... and at most
    hoverHeight: 0.75, // centre of the bottle above the ground
    tilt: 0.35, // radians the floating bottle leans
    pickupRadius: 1.0,
  },
  energy: {
    seconds: 4, // an energy drink can in the subway doubles the sprint speed this long ...
    sprintFactor: 2, // ... by this factor; another can restarts the time, it does not add up
  },
  storm: {
    startBehind: 58, // metres behind the start line
    baseSpeed: 2.2, // at the start of every landscape ...
    topSpeed: 3.9, // ... rising linearly to this at its end
    rubberBandDistance: 140, // free lead at the start of every landscape ...
    rubberBandMin: 70, // ... shrinking linearly to this at its end
    rubberBandGain: 0.03,
    catchUpSpeed: 6, // extra m/s while the front catches up to startBehind at a landscape start ...
    catchUpGain: 0.5, // ... plus this per metre it is still too far back
    rainStart: 42, // rain becomes visible below this distance
    darkStart: 120, // the storm becomes visible in the sky behind the player below this distance
  },
  endless: {
    rampLength: 6000, // metres over which the endless mode keeps getting harder, then it stays at its cap
    stormBaseExtra: 0.6, // m/s added to the storm's baseSpeed at the cap ...
    stormTopExtra: 0.4, // ... and to its topSpeed
    densityMax: 1 / 1, // obstacles per metre at the cap (1 / 8.5 before)
    hillChanceMax: 1, // share of hill segments with a hill at the cap (0.7 before)
    hillHeightMax: 7, // metres, highest hill at the cap (4 before)
    hillSteepness: 1.25, // at the cap hills are this much shorter for their height
  },
  render: {
    fogNear: 70,
    fogFar: 230,
    cameraFar: 900,
    shadowMapSize: 2048,
    shadowExtent: 42,
  },
} as const;

export type Foot = 'left' | 'right';

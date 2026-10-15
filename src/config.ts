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
  },
  player: {
    eyeHeight: 1.62,
    radius: 0.32,
    walkSpeed: 4.2,
    sprintSpeed: 6.6,
    accel: 22,
    staminaMax: 6, // seconds of sprint
    staminaRegen: 0.6, // seconds of stamina regained per second
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
  },
  kick: {
    maxDragPx: 320,
    tapThresholdPx: 14,
    tapPower: 0.14,
    minSpeed: 2.6,
    maxSpeed: 17.5,
    minElevationDeg: 7,
    maxElevationDeg: 33,
    chipElevationDeg: 52,
    chipSpeedFactor: 0.78,
    reach: 1.85, // metres from the hips to the apple
    curl: 0.5,
  },
  storm: {
    startBehind: 58, // metres behind the start line
    baseSpeed: 2.2,
    accel: 0.0065, // m/s gained per second
    capBase: 3.7,
    capGrowth: 0.0011, // cap grows slowly so every run ends eventually
    rubberBandDistance: 140,
    rubberBandGain: 0.03,
    rainStart: 42, // rain becomes visible below this distance
    darkStart: 120, // sky starts darkening below this distance
  },
  render: {
    fogNear: 70,
    fogFar: 230,
    shadowMapSize: 2048,
    shadowExtent: 42,
  },
} as const;

export type Foot = 'left' | 'right';

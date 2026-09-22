'use strict';

/* ------------------------------------------------------------------ *
 * bot/profiles.js - the weight profiles, and nothing else.
 *
 * One reason to change: tuning how a play style values the board. No
 * search, no game state, no I/O - just numbers, so a profile can be
 * added or retuned without reading any other file.
 * ------------------------------------------------------------------ */

(function (root) {

  // The base profile is Dellacherie's evaluation function, whose published
  // weights are a strong Tetris player on their own. Each strategy is a
  // deliberate distortion of it, so "which strategy" is a real decision
  // with real consequences for which placement wins.
  const BASE = {
    landingHeight: -4.500158825082766,
    eroded: 3.4181268101392694,
    rowTransitions: -3.2178882868487753,
    colTransitions: -9.348695305445199,
    holes: -7.899265427351652,
    wells: -3.3855972247263626,
    maxHeight: 0,
    bumpiness: 0,
    aggHeight: 0,
    rightColumnOpen: 0,
    lineScore: [0, 0, 0, 0, 0]
  };

  function profile(over) { return Object.assign({}, BASE, over); }

  const PROFILES = {
    // Straight Dellacherie - efficient, no agenda.
    balanced: profile({}),

    // Buried holes are the thing to fix; clearing rows to expose them
    // is worth paying height for.
    downstack: profile({
      holes: -15.8,
      eroded: 4.6,
      colTransitions: -7.0,
      lineScore: [0, 30, 70, 120, 200]
    }),

    // Nine-wide stacking: keep the right column empty and refuse small
    // clears so a vertical I can cash in four rows at once.
    build_tetris: profile({
      rightColumnOpen: 14,
      wells: -1.2,
      lineScore: [0, -55, -25, 15, 480]
    }),

    // Trade a little efficiency for an even surface.
    flatten: profile({
      bumpiness: -3.2,
      maxHeight: -2.2,
      rowTransitions: -4.8
    }),

    // The stack is nearly out of room: clear now, at almost any cost.
    survive: profile({
      maxHeight: -9.0,
      aggHeight: -0.9,
      holes: -6.0,
      lineScore: [0, 110, 240, 380, 560]
    })
  };

  const STRATEGIES = Object.keys(PROFILES);

  const api = { BASE: BASE, profile: profile, PROFILES: PROFILES, STRATEGIES: STRATEGIES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else (root.TetrisBot = root.TetrisBot || {}).profiles = api;

})(typeof window !== 'undefined' ? window : globalThis);

// Placeholder. Replaced by `node eval/fit-calibration.mjs` once an eval run
// exists; until then this returns the model's own stated confidence unchanged,
// so the app behaves exactly as it did before the calibration work.
//
// Shipping real weights requires a real eval run — weights fitted on anything
// else would put a number on screen that means nothing.
globalThis.WB_CALIBRATION = (function () {
  'use strict';
  return {
    fitted: false,
    calibrate: function (p) { return Math.max(0, Math.min(100, p.confidence || 0)); }
  };
}());

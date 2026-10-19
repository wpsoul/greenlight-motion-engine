// Motion-blur strength levels for the render bar's Blur dropdown.
//
// Deliberately a separate, dependency-free module rather than living in
// ./motionBlur.js: that module pulls in three.js and allocates GPU targets, and is
// lazily imported ONLY when an export actually runs with blur on. The toolbar needs
// the level list on every render, so importing it from there would defeat the
// lazy-load and cost every user the accumulation pipeline at startup.
//
// Strength is the SHUTTER ANGLE in degrees — the film term for how long the
// exposure stays open within one frame interval. 180° is the classic "half the
// frame" look; wider means a longer exposure and therefore more blur.
//
// `samples` is the accumulation sub-frame count and is spelled out per level
// instead of derived, so the table is the single source of truth. The values match
// what the pipeline used to auto-derive (shutter / 360 × 32), which keeps Normal
// byte-identical to the behaviour before the dropdown existed.

export const DEFAULT_MOTION_BLUR_SHUTTER = 180;

export const MOTION_BLUR_LEVELS = [
  {
    key: 'subtle',
    label: 'Subtle',
    shutter: 90,
    samples: 8,
    hint: 'Takes the edge off fast moves',
  },
  {
    key: 'normal',
    label: 'Normal',
    shutter: 180,
    samples: 16,
    hint: 'Classic 180° shutter — cinematic default',
  },
  {
    key: 'strong',
    label: 'Strong',
    shutter: 270,
    samples: 24,
    hint: 'Heavier smear on whips and fast zooms',
  },
  {
    key: 'max',
    label: 'Max',
    shutter: 360,
    samples: 32,
    hint: 'Full-frame exposure — very soft, slowest',
  },
];

// Nearest level to a shutter angle. Projects store the angle (not the key) so the
// value stays meaningful to the API/agents and survives us retuning the table.
export function motionBlurLevelForShutter(shutter) {
  const s = Number.isFinite(shutter) ? shutter : DEFAULT_MOTION_BLUR_SHUTTER;
  let best = MOTION_BLUR_LEVELS[1];
  let bestGap = Infinity;
  for (const lvl of MOTION_BLUR_LEVELS) {
    const gap = Math.abs(lvl.shutter - s);
    if (gap < bestGap) { bestGap = gap; best = lvl; }
  }
  return best;
}

// Snap a persisted or hand-authored angle onto a known level, so the pipeline always
// gets a shutter/samples pair that belong together. Anything unusable falls back to
// the default rather than silently disabling blur.
export function sanitizeMotionBlurShutter(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MOTION_BLUR_SHUTTER;
  return motionBlurLevelForShutter(n).shutter;
}

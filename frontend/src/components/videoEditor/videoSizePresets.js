// Preview/render size model for the video editor.
//
// The project's `videoSize` {w,h} is the RENDER resolution (full output) and its
// aspect IS the preview canvas aspect — "preview is the working canvas". Two
// controls drive it:
//   • the Preview-ratio select (in the player bar) changes the ASPECT, keeping a
//     sensible resolution (long edge preserved);
//   • the Render-size select (in the toolbar) changes the RESOLUTION at the
//     current aspect (720p…4K), plus Custom for an arbitrary W×H.
// The preview always renders capped to PREVIEW_MAX_LONG_EDGE so a 4K render never
// slows the playhead; export bypasses the cap and renders the full videoSize.

// Never render the on-screen preview larger than this on its long edge.
export const PREVIEW_MAX_LONG_EDGE = 1920;

// Aspect-ratio presets for the preview canvas (CapCut-style). `w`/`h` are the
// ratio terms (not pixels); `group` drives the landscape/portrait/square icon.
export const RATIO_PRESETS = [
  { id: '16:9', label: '16:9', w: 16, h: 9, group: 'landscape' },
  { id: '4:3', label: '4:3', w: 4, h: 3, group: 'landscape' },
  { id: '2.35:1', label: '2.35:1', w: 2.35, h: 1, group: 'landscape' },
  { id: '2:1', label: '2:1', w: 2, h: 1, group: 'landscape' },
  { id: '1.85:1', label: '1.85:1', w: 1.85, h: 1, group: 'landscape' },
  { id: '9:16', label: '9:16', w: 9, h: 16, group: 'portrait' },
  { id: '4:5', label: '4:5', w: 4, h: 5, group: 'portrait' },
  { id: '3:4', label: '3:4', w: 3, h: 4, group: 'portrait' },
  { id: '1:1', label: '1:1', w: 1, h: 1, group: 'square' },
];

// Render-resolution tiers, expressed as the LONG edge in pixels.
const RENDER_TIER_LONG_EDGES = [
  { longEdge: 1280, tier: '720p' },
  { longEdge: 1920, tier: '1080p' },
  { longEdge: 2560, tier: '1440p' },
  { longEdge: 3840, tier: '4K' },
];

const evenRound = (n) => {
  const r = Math.round(n);
  return r % 2 ? r - 1 : r;
};

export function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

// Pretty ratio label for an arbitrary size (e.g. 1920×1080 → "16:9"). Falls back
// to a 1-decimal "x:1" form when the reduced terms get unwieldy.
export function ratioLabelForSize(w, h) {
  if (!w || !h) return '';
  for (const p of RATIO_PRESETS) {
    if (Math.abs((w / h) - (p.w / p.h)) < 0.01) return p.label;
  }
  const g = gcd(w, h);
  const rw = Math.round(w / g);
  const rh = Math.round(h / g);
  if (rw <= 50 && rh <= 50) return `${rw}:${rh}`;
  return `${(w / h).toFixed(2)}:1`;
}

// Build a {w,h} at aspect aw:ah, keeping `longEdge` as the longer side (even dims).
export function sizeForAspect(aw, ah, longEdge = PREVIEW_MAX_LONG_EDGE) {
  const L = Math.max(2, Math.round(longEdge));
  if (aw >= ah) return { w: evenRound(L), h: Math.max(2, evenRound((L * ah) / aw)) };
  return { w: Math.max(2, evenRound((L * aw) / ah)), h: evenRound(L) };
}

// Re-fit the current resolution to a new aspect, preserving the long edge so the
// quality tier roughly carries over (e.g. 1920×1080 → 1:1 → 1920×1920).
export function applyAspectToSize(size, aw, ah) {
  const longEdge = Math.max(size?.w || 0, size?.h || 0) || PREVIEW_MAX_LONG_EDGE;
  return sizeForAspect(aw, ah, longEdge);
}

// Resolution tiers (720p…4K) for the CURRENT aspect. EVERY tier is returned,
// including ones above the project's own size: rendering a 1080p project at 4K
// for a delivery spec is legitimate.
//
// Two consumers, and `upscale` is only meaningful to ONE of them:
//   • the Render Settings modal picks an OUTPUT size for one render while the
//     project canvas stays put — there a tier above the canvas really is an
//     upscale, so the modal labels it and warns;
//   • the toolbar's Render-size menu ASSIGNS videoSize, so the tier it picks
//     becomes the project size. Nothing is upscaled; ignore the flag there.
export function renderTiersForSize(size) {
  const aw = size?.w || 16;
  const ah = size?.h || 9;
  const projectLongEdge = Math.max(size?.w || 0, size?.h || 0);
  return RENDER_TIER_LONG_EDGES.map((t) => {
    const s = sizeForAspect(aw, ah, t.longEdge);
    return {
      ...s,
      tier: t.tier,
      label: `${s.w}×${s.h}`,
      key: `${s.w}x${s.h}`,
      upscale: projectLongEdge > 0 && t.longEdge > projectLongEdge,
    };
  });
}

// Is this render resolution larger than the project canvas? Custom sizes go
// through here too, so the modal can warn on a hand-typed 4K just the same.
export function isUpscaleSize(resolution, projectSize) {
  if (!resolution || !projectSize) return false;
  const out = Math.max(resolution.w || 0, resolution.h || 0);
  const project = Math.max(projectSize.w || 0, projectSize.h || 0);
  return project > 0 && out > project;
}

export function sizesEqual(a, b) {
  return !!a && !!b && a.w === b.w && a.h === b.h;
}

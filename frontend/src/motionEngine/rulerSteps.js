// A timeline ruler's numbers: how far apart, and what they read. The engine page's ruler (PlayerPage's Timeline) and the
// studio's Notes and Highlight ruler (studio/highlight.js) use these, so a long film reads the same on both.
const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

// gap: the px a number needs · least: the smallest step in seconds
export function rulerSteps(duration, width, { gap = 84, least = 0 } = {}) {
  const pxPerSec = width / Math.max(duration, 0.001);
  const major = STEPS.find((s) => s >= least && s * pxPerSec >= gap) || STEPS[STEPS.length - 1];
  const minor = major / (major === 0.25 || major === 2.5 ? 5 : major >= 1 && major % 5 === 0 ? 5 : 4);
  return { major, minor };
}

export function rulerLabel(s, major) {
  if (s < 60) return major < 1 ? `${+s.toFixed(2)}s` : `${Math.round(s)}s`;
  const part = major < 1 ? String(+(s % 1).toFixed(2)).slice(1) : '';   // '' on the second, '.5' between them
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${part}`;
}

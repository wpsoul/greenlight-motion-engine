// Audio intro/outro fade envelope, shared by the three places that must agree
// on the same curve: live preview (Player element volume), export (the PCM mix
// in videoExporter) and the timeline wedge drawing. Fade lengths live on the
// timeline item as `audioFadeIn` / `audioFadeOut` (seconds of the clip's placed
// span, 0 or absent = off) with one `audioFadeCurve` for both ends.

export const AUDIO_FADE_CURVES = ['linear', 'smooth', 'exponential'];

export function sanitizeAudioFadeCurve(value) {
  return AUDIO_FADE_CURVES.includes(value) ? value : 'smooth';
}

// Fade progress 0..1 (0 = silent end, 1 = full level) → gain 0..1.
export function audioFadeShape(p, curve) {
  const t = Math.max(0, Math.min(1, p));
  if (curve === 'linear') return t;
  if (curve === 'exponential') return t * t;
  return t * t * (3 - 2 * t); // smoothstep — the default
}

// Gain of a fade window at `local` seconds from the clip's placed start.
// Overlapping fades multiply (a short clip with long fades becomes a bump that
// never reaches full level), which is also what clamping-free dragging expects.
export function audioFadeGainWindow(fadeIn, fadeOut, curve, local, duration) {
  if (!(duration > 0)) return 1;
  const fIn = Math.min(Math.max(0, fadeIn || 0), duration);
  const fOut = Math.min(Math.max(0, fadeOut || 0), duration);
  let gain = 1;
  if (fIn > 0 && local < fIn) gain *= audioFadeShape(local / fIn, curve);
  if (fOut > 0 && local > duration - fOut) gain *= audioFadeShape((duration - local) / fOut, curve);
  return Math.max(0, Math.min(1, gain));
}

export function itemHasAudioFade(item) {
  return (Number(item?.audioFadeIn) || 0) > 0 || (Number(item?.audioFadeOut) || 0) > 0;
}

// Envelope gain for a timeline item at `local` seconds into its placed span.
export function audioFadeGainAt(item, local, duration) {
  if (!itemHasAudioFade(item)) return 1;
  return audioFadeGainWindow(
    Number(item.audioFadeIn) || 0,
    Number(item.audioFadeOut) || 0,
    sanitizeAudioFadeCurve(item.audioFadeCurve),
    local,
    duration
  );
}

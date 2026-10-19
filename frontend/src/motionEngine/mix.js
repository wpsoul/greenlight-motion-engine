/*
 * GreenLight Motion Engine — the page's sound mix (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 6).
 *
 *   mixProject(project, { volume, sfx })   → the project the Player plays AND renders
 *
 * `volume` (0–100, default 100) scales every layer that makes sound — audio layers and video layers, nested
 * sequences included — through the volume field the editor already reads, so the preview and the MP4 hear the same
 * mix and the editor's Player needs nothing new. `sfx: false` mutes the layers the sound cues became
 * (soundCues.js: the `sfx-cues-N` channels: muted for the preview, volume 0 for the export's mix), keeping the
 * timeline as it is. At 100 % with effects on the project comes
 * back as the SAME object: nothing is copied, nothing re-renders. Pure and dependency-free.
 */

export const SFX_CHANNEL = /^sfx-cues-\d+$/;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Does the project make any sound (audio or video layers, cues)? */
export function hasSound(project) {
  const audible = (clips) => (clips || []).some((c) => c?.mediaType === 'audio' || c?.mediaType === 'video' || audible(c?.sequence?.clips));
  return audible(project?.clips) || (project?.channels || []).some((ch) => SFX_CHANNEL.test(ch?.id || ''));
}

/** Does the project carry sound-cue layers? */
export function hasSoundEffects(project) {
  return (project?.channels || []).some((ch) => SFX_CHANNEL.test(ch?.id || '') && (ch.items || []).length > 0);
}

function mixChannels(channels, clipsById, gain, muteSfx) {
  return channels.map((ch) => {
    const sfx = muteSfx && SFX_CHANNEL.test(ch?.id || '');
    let changed = false;
    const items = (ch.items || []).map((it) => {
      const clip = clipsById.get(it.clipId);
      const type = clip?.mediaType;
      if (type !== 'audio' && type !== 'video') return it;
      // the editor's own reading: audio keeps a legacy volume in `opacity`, video defaults to 100
      const vol = type === 'audio' ? (it.volume ?? it.opacity ?? 100) : (it.volume ?? 100);
      const next = { ...it, volume: sfx ? 0 : Math.round(clamp(vol * gain, 0, 100) * 1000) / 1000 };
      // the preview reads `muted`; the export's mix reads only the volume — so both
      if (sfx) next.muted = true;
      changed = true;
      return next;
    });
    return changed ? { ...ch, items } : ch;
  });
}

function mixClips(clips, gain, muteSfx) {
  return clips.map((clip) => {
    const seq = clip?.sequence;
    if (!seq) return clip;
    const inner = mixClips(seq.clips || [], gain, muteSfx);
    const byId = new Map(inner.map((c) => [c.id, c]));
    return { ...clip, sequence: { ...seq, clips: inner, channels: mixChannels(seq.channels || [], byId, gain, false) } };
  });
}

export function mixProject(project, { volume = 100, sfx = true } = {}) {
  if (!project) return project;
  const v = clamp(Number.isFinite(Number(volume)) ? Number(volume) : 100, 0, 100);
  if (v === 100 && sfx !== false) return project;
  const gain = v / 100;
  const clips = mixClips(project.clips || [], gain, sfx === false);
  const byId = new Map(clips.map((c) => [c.id, c]));
  return { ...project, clips, channels: mixChannels(project.channels || [], byId, gain, sfx === false) };
}

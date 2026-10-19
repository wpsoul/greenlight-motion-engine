/*
 * GreenLight Motion Engine — any project in, the shape every player reads out.
 *
 * Accepts a saved GreenLight Dash project's `data`, a project an agent wrote by hand (any subset of
 * fields: the editor's own normalizeEditorState fills and sanitizes the rest — the same function the
 * editor runs when it opens a project), or one this module already produced (normalizing is
 * idempotent). `template`, `name` and the sound cues (`sounds`) ride along untouched; the cues also
 * come out as ordinary audio layers (soundCues.js) playing library sounds through the asset resolver.
 */
import { normalizeEditorState } from '../components/videoEditor/editorState';
import { migrateLegacyTextAnimation } from '../components/videoEditor/legacyTextAnimation';
import { materializeSoundCues } from './soundCues';

const engineShape = (s, extra) => ({
  channels: s.historyState.history[s.historyState.index] || [],
  clips: s.clips || [],
  videoSize: s.videoSize,
  background: s.background || null,
  motionBlurEnabled: s.motionBlurEnabled === true,
  markers: s.markers || [],
  textVariables: s.textVariables || [],
  ...extra,
});

export async function toEngineProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('GreenLightMotion: a project must be an object');
  // An engine-shaped project is persisted data already (channels + clips at the top).
  const { template = null, name, sounds = null, ...data } = raw;
  const { state: migrated } = await migrateLegacyTextAnimation(data);
  const extra = { name, template, ...(Array.isArray(sounds) && sounds.length ? { sounds } : {}) };
  const first = engineShape(normalizeEditorState(migrated), extra);
  if (!extra.sounds) return first;
  // cues → audio layers, timed on the normalized items; then the editor's defaults for the new layers too
  const { project: withCues } = materializeSoundCues(first);
  return engineShape(normalizeEditorState(withCues), extra);
}

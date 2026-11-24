/*
 * The project's render profile (`data.renderProfile`): the export settings a render of this project was last started with —
 * format, frame rate, output size, HDR, bitrates — kept in the project itself, so another machine, a teammate or an agent renders
 * it the same way. The 3D half of a profile already lives on each Scene layer (`rig.render`). The Render dialog opens with it and
 * writes it back when a render starts; a server render that is asked for something else says so (render_pro.profile_warnings).
 *
 * Also: where the editor's preview Final (the player bar's own options) and the render's `rig.render` differ, so the dialog and the
 * player bar can say the picture being judged is not the one the render will make.
 */

import { DENOISE_LOOK_DEFAULT } from '../../world3d/render/denoiseLook.js';

export const RENDER_PROFILE_FORMATS = Object.freeze(['mp4', 'webm', 'webm-alpha', 'mov-prores4444']);
export const RENDER_PROFILE_HDR = Object.freeze(['pq', 'hlg']);
// Formats an HDR encode exists for (render_pro.HDR_FORMATS).
export const HDR_FORMATS = Object.freeze(['mp4', 'mov-prores4444']);

const num = (v, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : null);

/** The stored profile, cleaned: unknown keys dropped, numbers in range, an HDR mode only on a format that has one. Null when empty. */
export function sanitizeRenderProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  if (RENDER_PROFILE_FORMATS.includes(raw.format)) out.format = raw.format;
  const fps = num(raw.fps, 1, 120);
  if (fps != null) out.fps = Math.round(fps * 1000) / 1000;
  const w = num(raw.width, 16, 16384), h = num(raw.height, 16, 16384);
  if (w != null && h != null) { out.width = Math.round(w); out.height = Math.round(h); }
  if (RENDER_PROFILE_HDR.includes(raw.hdr) && HDR_FORMATS.includes(out.format || 'mp4')) out.hdr = raw.hdr;
  const vb = num(raw.videoBitrate, 500000, 200000000);
  if (vb != null && Number(raw.videoBitrate) > 0) out.videoBitrate = Math.round(vb);
  const ab = num(raw.audioBitrate, 64000, 512000);
  if (ab != null && Number(raw.audioBitrate) > 0) out.audioBitrate = Math.round(ab);
  if (typeof raw.motionBlur === 'boolean') out.motionBlur = raw.motionBlur;
  return Object.keys(out).length ? out : null;
}

/** The profile a render started from the Render dialog's settings writes (resolution null = the project's own size, not stored). */
export function renderProfileFromSettings(settings, { hdr = null } = {}) {
  const s = settings || {};
  return sanitizeRenderProfile({
    format: s.format || 'mp4',
    fps: Number(s.fps) || 30,
    ...(s.resolution?.w && s.resolution?.h ? { width: s.resolution.w, height: s.resolution.h } : {}),
    hdr: hdr ?? s.hdr ?? null,
    videoBitrate: Number(s.videoBitrateMbps) > 0 ? Number(s.videoBitrateMbps) * 1_000_000 : null,
    audioBitrate: Number(s.audioBitrateKbps) > 0 ? Number(s.audioBitrateKbps) * 1000 : null,
  });
}

/** The Render dialog's settings with a stored profile laid over them (what the project says wins over this browser's last choice). */
export function settingsFromRenderProfile(settings, profile) {
  const p = sanitizeRenderProfile(profile);
  if (!p) return settings;
  // a field the profile leaves out is its default: the project's own size, an automatic video bitrate, SDR
  return {
    ...settings,
    ...(p.format ? { format: p.format } : {}),
    ...(p.fps ? { fps: p.fps } : {}),
    resolution: p.width && p.height ? { w: p.width, h: p.height } : null,
    hdr: p.hdr || null,
    videoBitrateMbps: p.videoBitrate ? p.videoBitrate / 1_000_000 : 0,
    ...(p.audioBitrate ? { audioBitrateKbps: p.audioBitrate / 1000 } : {}),
  };
}

export const sameRenderProfile = (a, b) => JSON.stringify(sanitizeRenderProfile(a)) === JSON.stringify(sanitizeRenderProfile(b));

// The trace settings the preview Final and a render both take, with the defaults each falls back to (fields.js RENDER, the
// player bar's own starting options).
const TRACE_KEYS = [
  ['spp', 32, 'samples'],
  ['bounces', 8, 'bounces'],
  ['transparentBounces', 5, 'transparent bounces'],
  ['diffuseBounces', null, 'diffuse bounces'],
  ['specularBounces', null, 'specular bounces'],
  ['transmissionBounces', null, 'transmission bounces'],
  ['volumeBounces', null, 'volume bounces'],
  ['glossy', 0.5, 'soften glossy'],
  ['clamp', 0, 'clamp'],
  ['denoise', true, 'denoise'],
  ['denoiseLook', DENOISE_LOOK_DEFAULT, 'denoise look'],
];

/** Where the preview's Final options and the render's `rig.render` differ: [{ key, label, preview, render }], empty when the preview
 *  shows what the render will make. A Draft render against a Final preview is one difference (`mode`). */
export function traceDifferences(preview, render) {
  if (!preview || !render) return [];
  if (render.mode !== 'final') return [{ key: 'mode', label: 'renderer', preview: 'Final 3D', render: 'Draft 3D' }];
  const out = [];
  for (const [key, def, label] of TRACE_KEYS) {
    let a = preview[key] ?? def, b = render[key] ?? def;
    if (key === 'denoiseLook' && (preview.denoise === false || render.denoise === false)) continue;
    if (key === 'denoiseLook') { a = a || DENOISE_LOOK_DEFAULT; b = b || DENOISE_LOOK_DEFAULT; }
    if (a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9)) continue;
    out.push({ key, label, preview: a ?? 'unset', render: b ?? 'unset' });
  }
  return out;
}

/** The differences in one short line, or '' when there are none. */
export function traceDifferencesText(diffs, max = 3) {
  if (!diffs?.length) return '';
  const fmt = (v) => (v === true ? 'on' : v === false ? 'off' : String(v));
  const shown = diffs.slice(0, max).map((d) => `${d.label} ${fmt(d.preview)} → ${fmt(d.render)}`);
  return shown.join(', ') + (diffs.length > max ? ` and ${diffs.length - max} more` : '');
}

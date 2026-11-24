// (chatswitch) Draft or Final for a film's 3D Scene on the engine's page, owner 2026-11-15: "same logic as in app. Draft in preview
// play. Final will show only if switcher is set to final and only on pause." — and 2026-11-24: the switch in the preview, Draft by
// default, the preview's only (the lab html/INTERFACE/standalone-3d-switch-lab, "A and 1").
//
// The film's own mode is its Scene's rig.render.mode (a chat's script sets it: world.render.mode, Draft by default). What the page
// renders (Render MP4, renderVideo, the Final cap), draws as stills (the chat's contact sheet) and critiques is the film in that mode,
// or in the one the viewer picked in the Render pane's 3D (withWorldMode). The preview's Draft 3D | Final 3D (studio/worldSwitch.js)
// is the app's own Final (world3dLayer setWorldFinal: it traces only on pause): it starts in Draft and changes nothing that renders.
// Pure data: Node runs it in the unit tests.
import { hasWorld } from './world3dContract.js';

export const WORLD_MODES = Object.freeze(['draft', 'final']);
const isMode = (m) => m === 'draft' || m === 'final';
const isScene = (it) => it?.rig?.renderer === 'world';

/** The film's own 3D mode: 'final' when a Scene layer (in its timeline or inside a sequence) asks for Final, 'draft' for any other
 *  Scene, null for a film with no 3D Scene. */
export function filmWorldMode(project) {
  if (!hasWorld(project)) return null;
  const walk = (channels, clips) => (channels || []).some((ch) => (ch?.items || []).some((it) => isScene(it) && it.rig.render?.mode === 'final'))
    || (clips || []).some((c) => c?.sequence && walk(c.sequence.channels, c.sequence.clips));
  return walk(project.channels, project.clips) ? 'final' : 'draft';
}

/** PROJECT with every Scene's rig.render.mode set to MODE ('draft' | 'final'). The same object when MODE is not a mode, the film has
 *  no Scene, or every Scene is in that mode already, so a page that memoizes on it draws nothing again. Nothing else is touched. */
export function withWorldMode(project, mode) {
  if (!project || !isMode(mode) || !hasWorld(project)) return project;
  const items = (list) => {
    let changed = false;
    const out = (list || []).map((it) => {
      if (!isScene(it) || (it.rig.render?.mode === 'final' ? 'final' : 'draft') === mode) return it;
      changed = true;
      return { ...it, rig: { ...it.rig, render: { ...(it.rig.render || {}), mode } } };
    });
    return changed ? out : list;
  };
  const channels = (list) => {
    let changed = false;
    const out = (list || []).map((ch) => { const next = items(ch?.items); if (next === ch?.items) return ch; changed = true; return { ...ch, items: next }; });
    return changed ? out : list;
  };
  const clips = (list) => {
    let changed = false;
    const out = (list || []).map((c) => {
      if (!c?.sequence) return c;
      const ch = channels(c.sequence.channels), cl = clips(c.sequence.clips);
      if (ch === c.sequence.channels && cl === c.sequence.clips) return c;
      changed = true;
      return { ...c, sequence: { ...c.sequence, channels: ch, clips: cl } };
    });
    return changed ? out : list;
  };
  const ch = channels(project.channels), cl = clips(project.clips);
  return ch === project.channels && cl === project.clips ? project : { ...project, channels: ch, clips: cl };
}

/** The first Scene's rig.render (its timeline first, then inside sequences), or null. */
export function sceneRender(project) {
  const find = (channels, clips) => {
    for (const ch of channels || []) for (const it of ch?.items || []) if (isScene(it)) return it.rig.render || {};
    for (const c of clips || []) if (c?.sequence) { const r = find(c.sequence.channels, c.sequence.clips); if (r) return r; }
    return null;
  };
  return project ? find(project.channels, project.clips) : null;
}

/** What the paused preview traces with under Final: the Scene's own render settings (rig.render, normalized by NORMALIZE: rig3d.js
 *  normalizeRigRender), so the picture on pause is the frame Render MP4 makes. As the app's "Preview as the render": the mode, the
 *  exposure (the world takes it from the rig itself), Draft's shadows, the radiance cache and the soft reuse stay out. */
export function worldTraceOptions(render, normalize) {
  const { mode: _m, exposure: _e, draftShadows: _d, radianceCache: _r, softReuse: _s, ...trace } = normalize(render || {});
  return trace;
}

/** The words for the trace's progress beside the preview's toggle (the app's player bar): "12 of 32 spp", then "32 spp · 3.2 s". */
export function traceProgressText(status) {
  if (!status) return '';
  return status.done ? `${status.target} spp · ${Number(status.seconds || 0).toFixed(1)} s` : `${status.spp} of ${status.target} spp`;
}

// The scene script → a full GreenLight Motion project. ONE converter for every way in: the connector's build_video
// (cloud/mcp-worker/src/core/motion.mjs, bundled into src/vendor/sceneScript.mjs) and the CLI's `script` command (the
// npm package's dist/greenlight-motion-script.mjs) — both bundled by motion-engine/scripts/build-script.mjs.
// The model writes a short script — scenes, their elements, preset names, transitions, sounds — and this expands it with
// the Video Editor's OWN preset code (text presets through presetPatch, entrances / exits through applyKeyframePreset,
// exactly as the engine page and the editor apply them). Layout rules follow the engine film kit: every element its own
// unsnapped channel inside its scene's sequence, positions as panX / panY % of the frame, scenes back to back on one
// track joined by cross transitions, sound cues on the scene items.
// Pictures, video and music: the caller resolves every `src` first (the connector: links it passes through and the
// user's files in their browser; the CLI: files in the project's assets/) and passes them as FILES
// (src → { url, kind, width, height, duration, type }). At zoom 1 a picture is drawn at its own pixel size, shrunk only
// to fit a frame it is bigger than, never enlarged (videoEditor/imagePlate.js), an SVG at its declared size, and a video
// letterbox-fitted to the frame — so the sizes a script asks for become a zoom from those.
import { PRESETS as TEXT_PRESETS } from '../components/videoEditor/textAnimatorPresets.js';
import { CLASSIC_PRESETS } from '../components/videoEditor/textAnimatorClassicPresets.js';
import { presetPatch } from '../components/videoEditor/textAnimatorPresetPatch.js';
import { KEYFRAME_PRESETS, KFP_DEFAULT_LENGTH, kfpVariants, resolvePresetVariant, applyKeyframePreset } from '../components/videoEditor/keyframePresetCatalog.js';
import { svgDataUrl } from './mediaProbe.js';

export const FORMATS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350] };
export const CROSS_TRANSITIONS = ['None', 'Cross Fade', 'Push', 'Parallax', 'Wipe', 'Zoom In', 'Zoom Out', 'Advanced Zoom', 'Advanced Movement',
  '3D Carousel', 'Louver Flip', 'Circular Wipe', 'Pixel Blocks', 'Camera Whip', 'Zoom Ruler', 'Gradient Glow Stack', 'Gradient Map',
  'Scale Swap', 'Side by Side', 'Dip to Black', 'Radial Wipe'];
export const SHADERS = ['silk', 'glowblobs', 'waves', 'plasma', 'mesh', 'fire', 'spacetravel', 'glitters', 'blueplanet', 'auroraridge', 'emberpool',
  'neonvignette', 'electricvignette', 'spectrumdrift', 'emberfacet', 'silkdrift', 'eclipseprism', 'glassreeds', 'staticfringe', 'ripplefold',
  'nightaurora', 'pixelbeams', 'petalgrid', 'amberblinds', 'icehalo', 'windowhaze'];
export const CAMERAS = ['none', 'push-in', 'pull-out', 'drift-left', 'drift-right', 'drift-up'];
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const TEXT = new Map([...TEXT_PRESETS, ...CLASSIC_PRESETS].map((p) => [p.id, p]));
// text animation ids the catalogue renamed: scripts written with the old id still build
const TEXT_RENAMED = { 'glide-soft': 'glide-continuous' };
const KF_IN = new Map(kfpVariants(KEYFRAME_PRESETS, 'in').map((p) => [p.id, p]));
const KF_OUT = new Map(kfpVariants(KEYFRAME_PRESETS, 'out').map((p) => [p.id, p]));
const ROLES = { headline: [0.11, 800], subhead: [0.05, 500], body: [0.036, 400], label: [0.028, 600] };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r3 = (v) => +(+v).toFixed(3);
const KF_TRACKS = { x: 'translateX', y: 'translateY', scale: 'scale', rotate: 'rotate', opacity: 'opacity' };

/** Every file a script names (element src, scene background image / video, music), for the caller to resolve. */
export function scriptSources(script) {
  const out = new Set();
  for (const sc of Array.isArray(script?.scenes) ? script.scenes : []) {
    for (const k of ['image', 'video']) if (sc?.background?.[k]) out.add(String(sc.background[k]));
    for (const el of Array.isArray(sc?.elements) ? sc.elements : []) if (el?.src) out.add(String(el.src));
  }
  const music = typeof script?.music === 'string' ? script.music : script?.music?.src;
  if (music) out.add(String(music));
  return [...out];
}

/** The preset catalogues the guide lists (id — name). */
export function presetCatalog() {
  const line = (p) => `\`${p.id}\` ${p.name}${p.inOut ? ' (in and out)' : ''}${p.directions ? ' · direction' : ''}`;
  return {
    text: [...TEXT_PRESETS, ...CLASSIC_PRESETS].filter((p) => !/^voice-/.test(p.id)).map((p) => `\`${p.id}\` ${p.name}`),
    enter: [...KF_IN.values()].map(line),
    exit: [...KF_OUT.values()].filter((p) => !p.inOut).map((p) => `\`${p.id}\` ${p.name}`),
  };
}

const near = (want, list) => {
  const w = String(want || '').toLowerCase();
  const hits = list.filter((x) => x.toLowerCase().includes(w.slice(0, 4)) || w.includes(x.toLowerCase().slice(0, 4)));
  return hits.length ? ` (did you mean ${hits.slice(0, 4).map((h) => `"${h}"`).join(', ')}?)` : '';
};

/** script → { project, problems, warnings, summary }. caps: the engine's capabilities.json (effects, sounds), or null. */
export function compileScript(script, caps, files = new Map()) {
  const problems = [];
  const warnings = [];
  const S = script && typeof script === 'object' && !Array.isArray(script) ? script : null;
  if (!S) return { problems: ['the script must be a JSON object'], warnings };
  const [W, H] = FORMATS[S.format || '16:9'] || [];
  if (!W) problems.push(`format must be one of ${Object.keys(FORMATS).join(', ')}`);
  const scenes = Array.isArray(S.scenes) ? S.scenes : [];
  if (!scenes.length) problems.push('scenes must be a non-empty array');
  if (scenes.length > 12) problems.push('at most 12 scenes');
  if (problems.length) return { problems, warnings };

  const style = S.style || {};
  const colors = { text: '#f4f4f2', accent: '#33EFAB', muted: '#9aa3a0', ...(style.colors || {}) };
  const font = typeof style.font === 'string' && style.font.trim() ? `${style.font}, ${FONT}` : FONT;
  if (style.font) warnings.push(`font "${style.font}" shows only where it is installed (the viewer's computer); the system font stands in elsewhere`);
  const paint = (c, fallback) => (c && colors[c] ? colors[c] : (typeof c === 'string' && c.trim() ? c : fallback));
  const effectsById = new Map([...(caps?.effects?.overlay || []).map((e) => [e.id, 'overlay']), ...(caps?.effects?.layer || []).map((e) => [e.id, 'layer'])]);
  const sounds = new Set(Object.keys(caps?.sounds?.library || {}));
  const soundOk = (id, where) => {
    if (!caps) return true;
    if (sounds.has(id)) return true;
    problems.push(`${where}: unknown sound "${id}"${near(id, [...sounds])}`);
    return false;
  };
  const easings = new Set(caps?.easings?.keyframe?.values || []);
  const fileFor = (src, where, want) => {
    const f = files.get(String(src));
    if (!f) { problems.push(`${where}: no file "${String(src).slice(0, 80)}" — a src is an https link, or asset:<file name> for the user's own file (they add it on the page); for art you draw use "svg"`); return null; }
    if (want && !want.includes(f.kind)) { problems.push(`${where}: "${f.name || src}" is ${f.kind === 'audio' ? 'a sound' : `a ${f.kind}`}, not ${want.join(' or ')}`); return null; }
    return f;
  };
  const background = (b, where) => {
    if (b == null) return null;
    if (b && typeof b === 'object' && (b.image || b.video)) return { type: 'media', kind: b.image ? 'image' : 'video', src: b.image || b.video, color: b.color || '#000000' };
    if (typeof b === 'string') {
      if (/gradient\(/i.test(b)) return { type: 'gradient', gradientCss: b, solidColor: (b.match(/#[0-9a-f]{3,8}/i) || ['#000000'])[0] };
      return { type: 'solid', solidColor: b };
    }
    if (b && typeof b === 'object' && b.shader) {
      if (!SHADERS.includes(b.shader)) { problems.push(`${where}: unknown shader "${b.shader}" (one of ${SHADERS.join(', ')})`); return null; }
      return { type: 'shader', shaderId: b.shader, ...(b.look ? { shaderLook: String(b.look) } : {}), shaderSpeed: clamp(num(b.speed, 1), 0, 4), solidColor: b.color || '#000000' };
    }
    if (b && typeof b === 'object' && b.gradient) return { type: 'gradient', gradientCss: String(b.gradient), gradientAnimated: !!b.animated, solidColor: '#000000' };
    problems.push(`${where}: background must be a colour, a CSS gradient, or { "shader": id, "look"? }`);
    return null;
  };
  const projectBg = background(style.background ?? '#0f1112', 'style') || { type: 'solid', solidColor: '#0f1112' };
  const at = (pos) => {
    if (Array.isArray(pos)) return [num(pos[0], 0), num(pos[1], 0)];
    const m = { center: [0, 0], top: [0, -0.3], bottom: [0, 0.3], left: [-0.3, 0], right: [0.3, 0], 'top-left': [-0.3, -0.3],
      'top-right': [0.3, -0.3], 'bottom-left': [-0.3, 0.3], 'bottom-right': [0.3, 0.3] }[pos || 'center'];
    return m ? [m[0] * W, m[1] * H] : [0, 0];
  };

  const project = { name: String(S.title || 'GreenLight Motion video').slice(0, 120), videoSize: { w: W, h: H }, background: projectBg,
    projectFps: 30, clips: [], channels: [{ id: 'ch-scenes', name: 'Scenes', items: [] }], sounds: [] };
  const fields = [];
  const accentTargets = [];
  const usedIds = new Set();
  const uid = (base) => { let id = String(base).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'el'; let k = id; let n = 2; while (usedIds.has(k)) k = `${id}-${n++}`; usedIds.add(k); return k; };
  const summary = [];
  let total = 0;

  scenes.forEach((sc, si) => {
    const where = `scene ${si + 1}`;
    const dur = num(sc?.duration, 3);
    if (!(dur >= 0.8 && dur <= 30)) problems.push(`${where}: duration must be 0.8–30 s`);
    const D = clamp(dur, 0.8, 30);
    const els = Array.isArray(sc?.elements) ? sc.elements : [];
    if (els.length > 40) problems.push(`${where}: at most 40 elements`);
    const seq = { clips: [], channels: [] };
    const sceneId = uid(`scene-${si + 1}`);
    const add = (kind, id, start, end, fields_) => {
      const len = Math.max(0.05, end - start);
      seq.clips.push({ id: `c-${id}`, source: 'LOCAL', mediaType: kind, url: '', proxyUrl: null, name: id, duration: r3(len) });
      const item = { id, clipId: `c-${id}`, freeStart: r3(start), trimStart: 0, trimEnd: r3(len), ...fields_ };
      seq.channels.push({ id: `ch-${id}`, name: id, visible: true, unsnapped: true, items: [item] });   // channel order = z-order: later on top
      return item;
    };
    // the scene's own backdrop (a full-frame rectangle, the first channel = the bottom): transitions then blend whole scenes
    const sceneBg = background(sc?.background, where);
    const bg = sceneBg && sceneBg.type !== 'media' ? sceneBg : (sceneBg ? { type: 'solid', solidColor: sceneBg.color } : projectBg);
    const bgItem = add('shape', uid(`${sceneId}-bg`), 0, D, { shapeType: 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: W, shapeHeightPx: H,
      shapeFillColor: bg.solidColor || '#000000', ...(bg.type !== 'solid' ? { shapeBackground: bg } : {}) });
    if (bg.type === 'solid' && !sceneBg) fields.push({ bg: true, itemId: bgItem.id, color: bg.solidColor });
    const media = (el, ew, id, start, end, pos) => {
      const type = el.type;
      let f;
      if (el.svg && type === 'image') {
        try { f = { ...svgDataUrl(el.svg), kind: 'image', type: 'svg', name: el.label || 'art.svg' }; } catch (e) { problems.push(`${ew}: ${e.message}`); return null; }
      } else f = fileFor(el.src, ew, [type]);
      if (!f) return null;
      const iw = f.width || W; const ih = f.height || H;
      if (!f.width) warnings.push(`${ew}: the size of "${f.name}" is unknown, so it is fitted to the frame`);
      const s0 = type === 'video' ? Math.min(W / iw, H / ih) : f.type === 'svg' ? 1 : Math.min(1, W / iw, H / ih);   // drawn size at zoom 1
      const bw = iw * s0; const bh = ih * s0;
      const fit = el.fit || (el.w || el.h ? null : type === 'video' ? 'cover' : 'contain');
      const zoom = el.w ? num(el.w, bw) / bw : el.h ? num(el.h, bh) / bh
        : fit === 'cover' ? Math.max(W / bw, H / bh) : fit === 'contain' ? Math.min(W / bw, H / bh) * (el.fit ? 1 : 0.7) : 1;
      const len = Math.max(0.05, end - start);
      const from = Math.max(0, num(el.startAt, 0));
      const srcLen = type === 'video' ? (f.duration || from + len) : len;
      if (type === 'video' && f.duration && from + len > f.duration + 0.05) warnings.push(`${ew}: "${f.name}" is ${f.duration} s; from ${from} s it ends before the element (it holds its last frame)`);
      seq.clips.push({ id: `c-${id}`, source: 'LOCAL', mediaType: type, url: f.url, proxyUrl: null, name: f.name || id, duration: r3(srcLen),
        ...(f.width ? { width: f.width, height: f.height } : {}) });
      const vol = clamp(num(el.volume, 0), 0, 100);
      const item = { id, clipId: `c-${id}`, freeStart: r3(start), trimStart: r3(from), trimEnd: r3(from + len), zoom: r3(clamp(zoom, 0.02, 20)), ...pos,
        ...(el.rotate ? { rotation: num(el.rotate, 0) } : {}), ...(el.opacity != null ? { opacity: r3(clamp(num(el.opacity, 1), 0, 1) * 100) } : {}),   // the item's opacity is 0–100 (its keyframe track 0–1)
        ...(type === 'video' ? (vol > 0 ? { volume: vol } : { volume: 0, muted: true }) : {}) };
      seq.channels.push({ id: `ch-${id}`, name: f.name || id, visible: true, unsnapped: true, items: [item] });
      return item;
    };
    if (sceneBg?.type === 'media') media({ type: sceneBg.kind, src: sceneBg.src, fit: 'cover' }, `${where}, background`, uid(`${sceneId}-bg-${sceneBg.kind}`), 0, D, {});

    let firstHeadline = null;
    els.forEach((el, ei) => {
      const ew = `${where}, element ${ei + 1}`;
      const type = el?.type || 'text';
      const start = clamp(num(el?.start, 0.1 + ei * 0.12), 0, D - 0.2);
      const end = clamp(num(el?.end, D), start + 0.2, D);
      const [x, y] = at(el?.at);
      const pos = { ...(x ? { panX: r3((x / W) * 100) } : {}), ...(y ? { panY: r3((y / H) * 100) } : {}) };
      const id = uid(el?.id || `${sceneId}-${type}-${ei + 1}`);
      let item;
      if (type === 'text') {
        const t = String(el?.text ?? '').slice(0, 400);
        if (!t.trim()) { problems.push(`${ew}: text is empty`); return; }
        const role = ROLES[el?.role] ? el.role : (ei === 0 ? 'headline' : 'subhead');
        const size = clamp(num(el?.size, Math.round(ROLES[role][0] * Math.min(W, H) * (W > H ? 1 : 1.25))), 8, 600);
        const weight = clamp(num(el?.weight, ROLES[role][1]), 100, 900);
        const width = clamp(num(el?.width, Math.min(W * 0.86, Math.max(...t.split('\n').map((l) => l.length)) * size * 0.62 + size)), 40, W);
        const color = paint(el?.color || (role === 'headline' ? 'text' : role === 'label' ? 'accent' : 'muted'), colors.text);
        item = add('text', id, start, end, { textContent: t, textFontFamily: font, textFontSize: size, textFontWeight: weight, textColor: color,
          textAlign: el?.align || 'center', textWidthUnit: 'px', textWidthPx: Math.round(width), textLineHeight: num(el?.lineHeight, 1.15),
          ...(el?.letterSpacing ? { textLetterSpacing: num(el.letterSpacing, 0) } : {}), ...(el?.uppercase ? { textLetterCase: 'uppercase' } : {}), ...pos });
        if (el?.color === 'accent' || (!el?.color && role === 'label')) accentTargets.push({ itemId: id, path: 'textColor' });
        if (fields.filter((f) => f.text).length < 10) fields.push({ text: true, key: id, label: el?.label || t.split(/\s+/).slice(0, 4).join(' '), itemId: id, value: t });
        const preset = el?.textAnimation ?? (role === 'headline' ? 'glide-text' : null);
        if (preset) {
          const p = TEXT.get(TEXT_RENAMED[preset] || preset);
          if (!p) problems.push(`${ew}: unknown text animation "${preset}"${near(preset, [...TEXT.keys()])}`);
          else {
            const patch = presetPatch(item, p, { clipSec: end - start, fontPx: size, mode: 'replace' });
            item.textAnimators = el?.textExit ? patch.textAnimators : patch.textAnimators.filter((a) => !(a.range?.drive === 'time' && a.range?.animate === 'out'));
            // a preset's colour band (a fill the letters pass through, e.g. Glide Text's blue) takes the video's accent and
            // follows the Accent option, so the animation stays in the video's palette
            item.textAnimators.forEach((a, ai) => (a.effects || []).forEach((fx, fi) => {
              if (fx.type === 'fill' && typeof fx.color === 'string') { fx.color = colors.accent; accentTargets.push({ itemId: id, path: `textAnimators.${ai}.effects.${fi}.color` }); }
            }));
            item.propertyKeyframes = { ...(item.propertyKeyframes || {}), ...patch.propertyKeyframes };
            if (patch.textAnimatorPivotX != null) { item.textAnimatorPivotX = patch.textAnimatorPivotX; item.textAnimatorPivotY = patch.textAnimatorPivotY; }
          }
        }
        if (role === 'headline' && !firstHeadline) firstHeadline = { id, start };
      } else if (['rect', 'pill', 'circle'].includes(type)) {
        const w = clamp(num(el?.w, type === 'circle' ? 200 : 400), 1, W * 4); const h = clamp(num(el?.h, type === 'circle' ? w : 120), 1, H * 4);
        const fillBg = typeof el?.color === 'object' || /gradient\(/i.test(String(el?.color || '')) ? background(el.color, ew) : null;
        const fill = fillBg ? fillBg.solidColor : paint(el?.color || 'accent', colors.accent);
        item = add('shape', id, start, end, { shapeType: type === 'circle' ? 'ellipse' : 'rectangle', shapeSizeUnit: 'px', shapeWidthPx: w, shapeHeightPx: h,
          shapeFillColor: fill, ...(fillBg && fillBg.type !== 'solid' ? { shapeBackground: fillBg } : {}),
          ...(type === 'pill' ? { borderRadius: h / 2 } : el?.radius ? { borderRadius: num(el.radius, 0) } : {}),
          ...(el?.border ? { borderWidth: num(el.border.width, 2), borderColor: paint(el.border.color, colors.text), borderStyle: 'solid' } : {}),
          ...(el?.shadow ? { shadows: [{ x: 0, y: 12, blur: 40, spread: 0, color: 'rgba(0,0,0,0.35)', inset: false }] } : {}), ...pos });
        if (!el?.color || el.color === 'accent') accentTargets.push({ itemId: id, path: 'shapeFillColor' });
      } else if (type === 'line') {
        const [x2, y2] = Array.isArray(el?.to) ? [num(el.to[0], 0), num(el.to[1], 0)] : [x + 300, y];
        const cx = (x + x2) / 2; const cy = (y + y2) / 2; const L = Math.max(4, Math.abs(x2 - x), Math.abs(y2 - y));
        const pts = [[x, y], [x2, y2]].map(([px, py]) => ({ x: (px - cx) / L, y: (py - cy) / L, hIn: { x: 0, y: 0 }, hOut: { x: 0, y: 0 }, manual: true }));
        item = add('shape', id, start, end, { shapeType: 'line', shapeSizeUnit: 'px', shapeWidthPx: L, shapeHeightPx: L, shapeFillColor: paint(el?.color || 'accent', colors.accent),
          shapePath: { points: pts, closed: false }, lineWidth: num(el?.width, 6), lineCap: 'round',
          ...(cx ? { panX: r3((cx / W) * 100) } : {}), ...(cy ? { panY: r3((cy / H) * 100) } : {}) });
        if (el?.draw !== false) item.propertyKeyframes = { lineTrimEnd: [{ position: 0, value: '0', easing: 'AE Out' }, { position: r3(Math.min(100, (0.7 / (end - start)) * 100)), value: '100', easing: 'Linear' }] };
        if (!el?.color || el.color === 'accent') accentTargets.push({ itemId: id, path: 'shapeFillColor' });
      } else if (type === 'image' || type === 'video') {
        item = media(el, ew, id, start, end, pos);
        if (!item) return;
      } else {
        problems.push(`${ew}: type must be text, rect, pill, circle, line, image or video`);
        return;
      }
      // entrance / exit: the editor's keyframe presets over the first / last stretch (In-and-Out: the whole layer)
      const len = Math.max(1e-3, end - start);
      const span = Math.min(100, (KFP_DEFAULT_LENGTH / len) * 100);
      const enter = el?.enter ?? (['text', 'image', 'video'].includes(type) ? null : 'pop-overshoot');
      if (enter && enter !== 'none') {
        const v = KF_IN.get(enter);
        if (!v) problems.push(`${ew}: unknown entrance "${enter}"${near(enter, [...KF_IN.keys()])}`);
        else Object.assign(item, applyKeyframePreset(item, resolvePresetVariant(v, el?.direction || null), v.inOut ? { startPct: 0, endPct: 100 } : { startPct: 0, endPct: span }));
      }
      if (el?.exit) {
        const v = KF_OUT.get(el.exit);
        if (!v) problems.push(`${ew}: unknown exit "${el.exit}"${near(el.exit, [...KF_OUT.keys()])}`);
        else Object.assign(item, applyKeyframePreset(item, resolvePresetVariant(v, el?.direction || null), { startPct: 100 - span, endPct: 100 }));
      }
      // the element's own keyframes: { x | y | scale | rotate | opacity: [[seconds into the element, value, easing?], …] }
      if (el?.keyframes && typeof el.keyframes === 'object') {
        for (const [name, keys] of Object.entries(el.keyframes)) {
          const track = KF_TRACKS[name];
          if (!track) { problems.push(`${ew}: keyframes "${name}" — one of ${Object.keys(KF_TRACKS).join(', ')}`); continue; }
          if (!Array.isArray(keys) || keys.length < 2) { problems.push(`${ew}: keyframes.${name} needs two or more [seconds, value] keys`); continue; }
          const list = [];
          for (const k of keys) {
            const [t, v, easing = 'AE Smooth'] = Array.isArray(k) ? k : [k?.t, k?.value, k?.easing];
            if (!Number.isFinite(Number(t)) || !Number.isFinite(Number(v))) { problems.push(`${ew}: keyframes.${name}: each key is [seconds, value, easing?]`); break; }
            if (easings.size && !easings.has(easing)) { problems.push(`${ew}: unknown easing "${easing}"${near(easing, [...easings])}`); break; }
            list.push({ position: r3(clamp((Number(t) / len) * 100, 0, 100)), value: String(name === 'opacity' ? clamp(Number(v), 0, 1) : Number(v)), easing });
          }
          if (list.length === keys.length) {
            if (item.propertyKeyframes?.[track]) warnings.push(`${ew}: keyframes.${name} replace the ${track} keys of its entrance / exit`);
            item.propertyKeyframes = { ...(item.propertyKeyframes || {}), [track]: list.sort((a, b) => a.position - b.position) };
          }
        }
      }
      for (const fx of Array.isArray(el?.effects) ? el.effects : []) {
        const kind = effectsById.get(fx?.id);
        if (caps && !kind) { problems.push(`${ew}: unknown effect "${fx?.id}"${near(fx?.id, [...effectsById.keys()])}`); continue; }
        const entry = { id: fx.id, eid: `${id}-${fx.id}`, enabled: true, ...(kind === 'overlay' ? { mix: 100 } : {}), params: fx.params && typeof fx.params === 'object' ? fx.params : {} };
        if (kind === 'layer') (item.layerEffects ||= []).push(entry); else (item.effects ||= []).push(entry);
      }
      if (el?.sound && soundOk(el.sound, ew)) project.sounds.push({ sfx: el.sound, on: sceneId, at: r3(start) });
    });

    project.clips.push({ id: `c-${sceneId}`, source: 'LOCAL', mediaType: 'sequence', url: '', proxyUrl: null, name: sc?.name || `Scene ${si + 1}`, duration: r3(D), sequence: seq });
    const sceneItem = { id: sceneId, clipId: `c-${sceneId}`, trimStart: 0, trimEnd: r3(D) };
    if (si > 0) {
      const tr = sc?.transition ?? 'Cross Fade';
      if (!CROSS_TRANSITIONS.includes(tr)) problems.push(`${where}: unknown transition "${tr}" (one of ${CROSS_TRANSITIONS.join(', ')})`);
      else if (tr !== 'None') {
        const prev = num(scenes[si - 1]?.duration, 3);
        sceneItem.transition = tr;
        sceneItem.transitionDuration = r3(clamp(num(sc?.transitionDuration, 0.6), 0.2, Math.min(prev, D) / 2));
        total -= sceneItem.transitionDuration;
        if ((S.sound ?? 'auto') === 'auto') project.sounds.push({ sfx: soundOk('soft-swoosh', where) ? 'soft-swoosh' : 'standard-swoosh', on: project.channels[0].items.at(-1).id, at: 'end' });
      }
    }
    const cam = sc?.camera ?? 'push-in';
    if (!CAMERAS.includes(cam)) problems.push(`${where}: camera must be one of ${CAMERAS.join(', ')}`);
    const k = (track, a, b) => [{ position: 0, value: String(a), easing: 'AE Smooth' }, { position: 100, value: String(b), easing: 'Linear' }];
    const camKeys = { 'push-in': { scale: k('scale', 1, 1.06) }, 'pull-out': { scale: k('scale', 1.06, 1) }, 'drift-left': { translateX: k('x', 0, -36) },
      'drift-right': { translateX: k('x', 0, 36) }, 'drift-up': { translateY: k('y', 0, -28) } }[cam];
    if (camKeys) sceneItem.propertyKeyframes = camKeys;
    for (const s of Array.isArray(sc?.sounds) ? sc.sounds : []) if (s?.sfx && soundOk(s.sfx, where)) project.sounds.push({ sfx: s.sfx, on: sceneId, at: r3(num(s.at, 0)), ...(s.gain ? { gain: num(s.gain, 0) } : {}) });
    if ((S.sound ?? 'auto') === 'auto' && si === 0 && firstHeadline && soundOk('whoosh-3', where)) project.sounds.push({ sfx: 'whoosh-3', on: sceneId, at: r3(firstHeadline.start) });
    project.channels[0].items.push(sceneItem);
    total += D;
    summary.push(`${si + 1}. ${sc?.name || 'scene'} — ${D} s, ${els.length} element(s)${sceneItem.transition ? `, enters with ${sceneItem.transition}` : ''}`);
  });

  // music: one track under the whole video
  const music = typeof S.music === 'string' ? { src: S.music } : S.music;
  if (music?.src) {
    const f = fileFor(music.src, 'music', ['audio', 'video']);
    if (f) {
      const len = Math.max(0.5, total); const from = Math.max(0, num(music.startAt, 0));
      if (f.duration && f.duration - from < len - 0.05) warnings.push(`music: "${f.name}" is ${f.duration} s, the video ${r3(len)} s — it ends early`);
      project.clips.push({ id: 'c-music', source: 'LOCAL', mediaType: 'audio', url: f.url, proxyUrl: null, name: f.name || 'music', duration: r3(f.duration || from + len) });
      project.channels.push({ id: 'ch-music', name: 'Music', items: [{ id: 'music', clipId: 'c-music', trimStart: r3(from), trimEnd: r3(from + Math.min(len, f.duration ? f.duration - from : len)),
        volume: clamp(num(music.volume, 80), 0, 100), audioFadeIn: r3(clamp(num(music.fadeIn, 0.3), 0, 10)), audioFadeOut: r3(clamp(num(music.fadeOut, 1.2), 0, 10)) }] });
    }
  }

  // the page's options: each text, the accent colour, the backdrop colour
  const tFields = fields.filter((f) => f.text).map((f) => ({ key: f.key, label: f.label, type: 'text', targets: [{ itemId: f.itemId, path: 'textContent' }] }));
  const values = Object.fromEntries(fields.filter((f) => f.text).map((f) => [f.key, f.value]));
  if (accentTargets.length) { tFields.push({ key: 'accent', label: 'Accent colour', type: 'color', targets: accentTargets }); values.accent = colors.accent; }
  const bgs = fields.filter((f) => f.bg);
  if (bgs.length) { tFields.push({ key: 'backdrop', label: 'Background', type: 'color', targets: bgs.map((b) => ({ itemId: b.itemId, path: 'shapeFillColor' })) }); values.backdrop = bgs[0].color; }
  project.template = { title: project.name, fields: tFields, values };
  if (!project.sounds.length) delete project.sounds;
  return { project, problems, warnings, summary, duration: r3(Math.max(0, total)) };
}

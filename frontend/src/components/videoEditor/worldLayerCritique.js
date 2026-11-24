/*
 * 2D layers over a 3D Scene, for the Scene's critique (render-still's in the app, the engine page's in the chat connector and the CLI).
 * A flat layer takes its place in the world by depth (world3dLayer.js: the world's picture comes with a depth in the compositor's
 * pixels), so an object standing in front of a title hides it, and a script's titles at z 0 stand about two metres from the camera:
 * behind any product filmed close. For every text, picture and HTML clip drawn at the frame's time this says where it stands, how much
 * of it the world's objects hide, its contrast against what is under it, whether it leaves the frame or the title-safe area, and which
 * texts overlap. From the frame already drawn and the world's own rays (worldPickAt): no extra render.
 */
import { activeLayers } from './PreviewTransformOverlay';
import { getTimelineLayout } from './speedUtils';
import { worldPickAt, worldCameraFacts, worldCoversFrame, worldObjectFacts } from './world3dLayer';
import { isPlateChannel, lockedLeadChannels } from './compositeSortDepth';
import { cameraPathCheck, cornersInFrame } from '../../world3d/cameraPath.js';
import { cameraLayerShot, cameraTimeline } from './cameraLayerShot';
import { sceneAtTime } from './cameraTargets';

const KINDS = { text: 'text', image: 'picture', html: 'html' };
export const TITLE_SAFE = 0.05;   // title-safe: 5 % in from each edge
const REST_FOV = 28;              // the editor camera's field of view at rest (projectCamera.js): where a layer at z 0 stands

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const relLum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const hexRgb = (hex) => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const s = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Every 2D layer drawn at `time`, sequences opened on their own clock, with the editor's own geometry (activeLayers). */
function layersAt(channels, clips, time, W, H, fps, out = [], level = 0) {
  const clipsMap = new Map((Array.isArray(clips) ? clips : Object.values(clips || {})).map((c) => [c.id, c]));
  for (const l of activeLayers(channels || [], clipsMap, time, W, H, fps)) {
    if (KINDS[l.clip.mediaType] || l.clip.htmlSource) out.push(level ? { ...l, nested: true } : l);
  }
  if (level > 3) return out;
  for (const ch of channels || []) {
    if (ch.visible === false) continue;
    const layout = getTimelineLayout(ch.items || [], { unsnapped: ch.unsnapped });
    (ch.items || []).forEach((item, i) => {
      const clip = clipsMap.get(item.clipId);
      const span = layout[i];
      if (!clip?.sequence || !span || time < span.startTime - 1e-6 || time > span.endTime + 1e-6) return;
      layersAt(clip.sequence.channels, clip.sequence.clips, time - span.startTime + (Number(item.trimStart) || 0), W, H, fps, out, level + 1);
    });
  }
  return out;
}

/** The box a layer covers on the frame, in px from the top left, its turn included. */
function boxOf(l) {
  const b = l.box || l;
  const t = Math.abs(((l.rotation || 0) * Math.PI) / 180);
  const w = Math.abs(b.width * Math.cos(t)) + Math.abs(b.height * Math.sin(t));
  const h = Math.abs(b.width * Math.sin(t)) + Math.abs(b.height * Math.cos(t));
  return [b.cx - w / 2, b.cy - h / 2, b.cx + w / 2, b.cy + h / 2];
}
const area = ([a, b, c, d]) => Math.max(0, c - a) * Math.max(0, d - b);
const clip4 = ([a, b, c, d], [e, f, g, h]) => [Math.max(a, e), Math.max(b, f), Math.min(c, g), Math.min(d, h)];

/** How much of the box the world's objects in front of the layer hide (depth: px from the editor camera), by what, and how near the
 *  nearest of them stands (px from the camera). `depth` null: the layer lies under the Scene's whole picture, so every object hides it. */
function hiddenShare(box, depth, W, H) {
  const inner = clip4(box, [0, 0, W, H]);
  const w = inner[2] - inner[0], h = inner[3] - inner[1];
  if (w <= 1 || h <= 1) return null;
  const nx = Math.max(3, Math.min(12, Math.round(w / 40))), ny = Math.max(3, Math.min(8, Math.round(h / 40)));
  let n = 0, hidden = 0, nearest = Infinity;
  const by = new Map();
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const x = inner[0] + ((i + 0.5) / nx) * w, y = inner[1] + ((j + 0.5) / ny) * h;
      const hit = worldPickAt(x / W, y / H);
      n += 1;
      // Letters the world lays out itself (`t:` 3D text, `f:` flat text as cards) are other layers: two texts are an overlap, not this.
      if (hit && (depth == null || hit.distance < depth - 0.5) && !/^[tf]:/.test(String(hit.id ?? ''))) {
        hidden += 1;
        if (hit.id != null) by.set(hit.id, (by.get(hit.id) || 0) + 1);
        nearest = Math.min(nearest, hit.distance);
      }
    }
  }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1])[0];
  return { share: r3(hidden / Math.max(1, n)), by: top ? top[0] : null, nearest: Number.isFinite(nearest) ? nearest : null };
}

/** A text's contrast against what is under it: the frame's pixels in its box, the half least like the text's colour taken as the ground
 *  (a hidden or vanished title leaves nothing unlike it, so it reads as no contrast). WCAG's ratio, 1 to 21. */
function contrastOf(box, rgb, rgba, fw, fh, W, H) {
  if (!rgb || !rgba) return null;
  const sx = fw / W, sy = fh / H;
  const inner = clip4([box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy], [0, 0, fw, fh]);
  const w = Math.floor(inner[2] - inner[0]), h = Math.floor(inner[3] - inner[1]);
  if (w < 2 || h < 2) return null;
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 4000)));
  const lt = relLum(...rgb);
  const px = [];
  for (let y = Math.floor(inner[1]); y < inner[1] + h; y += step) {
    for (let x = Math.floor(inner[0]); x < inner[0] + w; x += step) {
      const k = (y * fw + x) * 4;
      px.push([rgba[k], rgba[k + 1], rgba[k + 2], relLum(rgba[k], rgba[k + 1], rgba[k + 2])]);
    }
  }
  px.sort((a, b) => Math.abs(b[3] - lt) - Math.abs(a[3] - lt));
  const ground = px.slice(0, Math.max(1, Math.floor(px.length / 2)));
  const lb = ground[Math.floor(ground.length / 2)][3];
  const mean = [0, 1, 2].map((c) => ground.reduce((s, p) => s + p[c], 0) / ground.length);
  return { ratio: r2((Math.max(lt, lb) + 0.05) / (Math.min(lt, lb) + 0.05)), under: toHex(mean) };
}

/**
 * The 2D layers drawn at `time` over a Scene: `channels`/`clips` the project's, W×H its size, `rgba` the frame's pixels (fw×fh).
 * Returns { layers: [{ id, name, kind, box: [left, top, right, bottom] in % of the frame, depth, hidden, hiddenBy, contrast, color,
 * under, outside, outsideSafe }], overlaps: [{ a, b, share }] }, the shares 0..1. Call it right after the frame at `time` was drawn.
 */
export function layers2dReport({ channels, clips, time, width: W, height: H, fps = 30, rgba = null, frameWidth = W, frameHeight = H }) {
  const t0 = performance.now();
  const rest = (H * 0.5) / Math.tan(((REST_FOV / 2) * Math.PI) / 180);
  const layers = [];
  // (enginebugs) A camera-locked layer is flat: drawn over the Scene in stacking order and hidden by none of its objects, unless its channel
  // is part of the frame's background plate under the Scene (compositeSortDepth.js lockedLeadChannels), where the Scene's whole picture
  // covers it. Judged as the compositor judges it, from what each top-level channel shows at `time`.
  const top = Array.isArray(channels) ? channels : [];
  const clipsMap = new Map((Array.isArray(clips) ? clips : Object.values(clips || {})).map((c) => [c.id, c]));
  const shown = (ch) => {
    const layout = getTimelineLayout(ch.items || [], { unsnapped: ch.unsnapped });
    const i = layout.findIndex((s) => s && time >= s.startTime - 1e-6 && time <= s.endTime + 1e-6);
    return i >= 0 ? clipsMap.get(ch.items[i]?.clipId) : null;
  };
  const adjustments = new Map(top.filter((ch) => shown(ch)?.mediaType === 'adjustment').map((ch) => [ch.id, true]));
  const plate = new Set(lockedLeadChannels(top, adjustments, (ch) => isPlateChannel(ch, shown(ch), (it) => clipsMap.get(it.clipId))).map((ch) => ch.id));
  const lockedIds = new Set(top.filter((ch) => ch.cameraLocked).map((ch) => ch.id));
  for (const l of layersAt(channels, clips, time, W, H, fps)) {
    const kind = KINDS[l.clip.mediaType] || 'html';
    if (kind === 'text' && !l.box) continue;   // not laid out yet: its plate is the whole frame, which says nothing
    const box = boxOf(l);
    const a = Math.max(1e-6, area(box));
    const pz = Number(l.pz) || 0;
    const depth = rest - pz;
    const locked = !l.nested && lockedIds.has(l.channelId);
    const underScene = locked && plate.has(l.channelId);
    // over the Scene a locked layer is hidden by nothing; under it, by every object, and by all of the picture when that is opaque
    const hid = locked && !underScene ? { share: 0, by: null, nearest: null }
      : underScene && worldCoversFrame() ? { share: 1, by: null, nearest: null }
        : hiddenShare(box, underScene ? null : depth, W, H);
    const rgb = kind === 'text' ? hexRgb(l.item.textColor) : null;
    const c = kind === 'text' ? contrastOf(box, rgb, rgba, frameWidth, frameHeight, W, H) : null;
    const safe = [W * TITLE_SAFE, H * TITLE_SAFE, W * (1 - TITLE_SAFE), H * (1 - TITLE_SAFE)];
    const text = kind === 'text' ? String(l.item.textContent ?? l.item.text ?? '').replace(/\s+/g, ' ').trim() : '';
    layers.push({
      id: l.item.id, name: text ? text.slice(0, 40) : (l.item.name || l.clip.name || l.item.id), kind,
      box: [r2((box[0] / W) * 100), r2((box[1] / H) * 100), r2((box[2] / W) * 100), r2((box[3] / H) * 100)],
      ...(locked ? { locked: true, ...(underScene ? { underScene: true } : {}) } : { depth: Math.round(depth), z: Math.round(pz) }),
      ...(hid ? { hidden: hid.share, ...(hid.by != null && hid.share > 0 ? { hiddenBy: hid.by } : {}),
        ...(!locked && hid.share > 0 && hid.nearest != null ? { hiddenAt: Math.round(hid.nearest) } : {}) } : {}),
      ...(c ? { contrast: c.ratio, color: toHex(rgb), under: c.under } : {}),
      outside: r3(1 - area(clip4(box, [0, 0, W, H])) / a),
      outsideSafe: r3(1 - area(clip4(box, safe)) / a),
    });
  }
  const overlaps = [];
  const texts = layers.filter((l) => l.kind === 'text');
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      const A = texts[i].box, B = texts[j].box;
      const both = area(clip4(A, B));
      if (both <= 0) continue;
      overlaps.push({ a: texts[i].id, b: texts[j].id, share: r3(both / Math.max(1e-6, Math.min(area(A), area(B)))) });
    }
  }
  return { layers, overlaps, ms: Math.round((performance.now() - t0) * 10) / 10 };   // what it cost, picks and pixels
}

/** The Scene camera's move over the whole clip, checked with no render (world3d/cameraPath.js) against the world as it stands now:
 *  null when the world films from the editor's camera or has no frame yet. */
export function worldPathReport() {
  const t0 = performance.now();
  const facts = worldCameraFacts();
  const report = facts ? cameraPathCheck(facts) : null;
  if (report) report.ms = Math.round((performance.now() - t0) * 10) / 10;   // the boxes and the samples
  return report;
}

/**
 * (camlayer) The Camera layer's move over the Scene clip shown at `time`, checked with no render, as worldPathReport checks a Scene camera's:
 * the Camera layer's shot (cameraLayerShot.js) at `samples` times across the clip and at the still's own, against each object's box (where
 * its keys carry it then). Every object wholly in shot now that is not at some sample: when, and how much of its box stays in. Null when
 * there is no world yet. `camera: "layer"` says whose move it is.
 * (screensharp2) A Scene that films from its own camera is checked here too when a Camera layer clip steers it: cameraLayerShot then gives
 * that camera steered as the world films it (`camera: "steered"`). The Scene camera alone (worldPathReport) left the steer out, so the
 * check named a shot the render does not film.
 */
export function cameraLayerPathReport({ channels, clips, videoSize, time, samples = 17 }) {
  const t0 = performance.now();
  const facts = worldObjectFacts();
  if (!facts) return null;
  const data = { channels, clips, videoSize };
  const tl = cameraTimeline(data);
  // a Scene's own camera is the Camera layer's to check only while a camera clip steers it (else worldPathReport checks it alone)
  if (!facts.freeCamera && !cameraLayerShot(data, [time], { tl })[0]?.steered) return null;
  const at = sceneAtTime(tl.channels, tl.clipsMap, tl.layoutFor, time);
  if (!at) return null;
  const start = time - at.sceneTime, end = start + (at.span ?? at.sceneTime);
  const times = [...new Set([...Array.from({ length: samples }, (_, i) => start + ((end - start) * i) / Math.max(1, samples - 1)), time].map(r2))].sort((a, b) => a - b);
  const shots = new Map(cameraLayerShot(data, times, { tl }).map((sh) => [sh.t, sh]));
  const aspect = tl.width / tl.height;
  const view = (t) => { const sh = shots.get(t) || cameraLayerShot(data, [t], { tl })[0]; return { at: sh.at, target: sh.target, up: sh.up, fov: sh.fov, aspect }; };
  const boxAt = (o, t) => {
    const d = typeof o.shift === 'function' ? o.shift(Math.max(0, t - start)) : null;
    return d ? { min: o.bbox.min.map((v, i) => v + d[i]), max: o.bbox.max.map((v, i) => v + d[i]) } : o.bbox;
  };
  const vNow = view(r2(time));
  const moves = times.some((t) => { const v = view(t); return [...v.at, ...v.target, v.fov].some((x, i) => Math.abs(x - [...vNow.at, ...vNow.target, vNow.fov][i]) > 1e-4); });
  const shot = (facts.objects || []).filter((o) => o?.bbox && cornersInFrame(boxAt(o, time), vNow) === 1);
  const leaves = [];
  if (moves) {
    for (const o of shot) {
      let worst = null;
      for (const t of times) {
        const inside = cornersInFrame(boxAt(o, t), view(t));
        if (inside < 1 && (!worst || inside < worst.inside)) worst = { id: o.id, t, inside };
      }
      if (worst) leaves.push(worst);
    }
  }
  return { camera: facts.freeCamera ? 'layer' : 'steered', moves, now: r2(time), from: r2(start), to: r2(end), samples: times.length, checked: shot.map((o) => o.id), leaves,
    ms: Math.round((performance.now() - t0) * 10) / 10 };
}

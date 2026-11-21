// A still's critique in plain words, for hosts with no Python behind them (the motion engine's page, the chat connector): the same
// rules as backend/world3d_critique.py `hints` and `summarize_coverage`, over the same facts (the page's world3d/critique.js report and
// the picture's numbers). critiqueHints.test.mjs keeps the two saying the same.

export const DETAIL_OBJECTS = 12;   // up to this many objects, a critique reports each one without being asked
export const CAUSTIC_SPECKS = 12;   // (bottlefix) the caustic pass's specks a Final still may have before the critique says so

const pct = (x) => { const v = x * 100; return v < 10 ? `${v.toFixed(1)} %` : `${Math.round(v)} %`; };
const metres = (px) => Math.round((px || 0) / 10) / 100;

/**
 * (enginebugs) What to do about a 2D layer the Scene hides, exactly: [text, fix]. A layer on an ordinary channel stands in the world at its
 * depth (`depth`, px from the camera; panZ 0 is the composition's plane, H / 2 / tan 14° away), so anything nearer (`hiddenAt`) covers it,
 * whatever its channel's place: lock its channel to the camera (drawn flat over the Scene, in stacking order), or bring it in front with
 * the panZ that stands it 3 % nearer than what hides it (measured: its size on screen stays; tests/enginebugs/textwall.py). A camera-locked
 * one is hidden only as part of the background plate under the Scene (`underScene`).
 * backend/world3d_critique.py _layer_hidden_hint says the same, word for word.
 */
function layerHiddenHint(l, who) {
  const share = pct(l.hidden);
  if (l.underScene) {
    return [`${who} is ${share} hidden: its channel is camera-locked with only camera-locked channels under it (the Scene's own does not count), so it is the frame's background plate and lies under the Scene${l.hiddenBy ? `, behind "${l.hiddenBy}"` : ', under its whole picture'}. To show it over the Scene, put an ordinary channel under its channel, or move its channel above the camera-locked pictures (a camera-locked text there is drawn over the Scene).`,
      `layer ${l.id}: channel order`];
  }
  const by = l.hiddenBy ? `"${l.hiddenBy}"` : 'the 3D objects';
  const lock = l.kind === 'text' ? 'put it on a camera-locked channel (the channel\'s `cameraLocked: true`)' : 'put it on a camera-locked channel (the channel\'s `cameraLocked: true`) with an ordinary channel under it';
  if (!(l.hiddenAt > 0) || !(l.depth > 0)) {
    return [`${who} is ${share} hidden behind ${by}: over a Scene a 2D layer stands in the world at its depth (about ${metres(l.depth)} m from the camera), so an object in front of it covers it, whatever its channel's place. To keep it over the Scene, ${lock}: it is then drawn flat, in stacking order, and nothing in the Scene hides it. Or move it clear of the objects.`,
      `layer ${l.id}: cameraLocked channel`];
  }
  // 3 % in front of the nearest thing that hides it
  const front = 0.97 * l.hiddenAt;
  const panZ = Math.round((l.z || 0) + l.depth - front);
  return [`${who} is ${share} hidden behind ${by}: over a Scene a 2D layer stands in the world at its depth, about ${metres(l.depth)} m from the camera (panZ 0 is the composition's plane, H / 2 / tan 14° away), and ${by} stands nearer, about ${metres(l.hiddenAt)} m, so it covers the layer whatever its channel's place. To keep it over the Scene, ${lock}: it is then drawn flat, in stacking order, and nothing in the Scene hides it. To keep it in the world, bring it in front: panZ ${panZ} (about ${metres(front)} m from the camera), or move ${by} farther than ${metres(l.depth)} m.`,
    `layer ${l.id}: cameraLocked channel, or panZ`];
}
const inside = (a, b) => {
  try { return [0, 1].every((k) => b.min[k] - 0.01 <= a.min[k] && a.max[k] <= b.max[k] + 0.01); } catch { return false; }
};

/** (leftovers2) An object its `visible` keys hide at the still's time (world3d/critique.js `hiddenByKeys`: { id, at, until, by? }): hidden,
 *  with the key's time, not out of frame. backend/world3d_critique.py _key_hidden_text says the same, word for word. */
function keyHiddenText(h) {
  const when = `the key at ${h.at} s; ${h.until == null ? 'not shown again' : `shown again at ${h.until} s`}`;
  return h.by != null
    ? `"${h.id}" is hidden at this time with its parent "${h.by}", by the \`visible\` keys of "${h.by}" (${when}): it is not in the picture.`
    : `"${h.id}" is hidden at this time by its \`visible\` keys (${when}): it is not in the picture.`;
}

/** One sentence per problem, most important first: { kind, severity, text, fix? }. */
export function critiqueHints({ mode = 'draft', stats = null, scene = null, check = null, compare = null, wanted = null } = {}) {
  const out = [];
  const add = (kind, severity, text, fix = null, extra = {}) => out.push({ kind, severity, text, ...(fix ? { fix } : {}), ...extra });

  if (scene?.error) add('build', 'error', `The scene did not build, so none of rig.scene is in the picture: ${scene.error}`);
  if (check) {
    const errs = check.errors || [];
    for (const e of errs.filter((x) => x.code === 'missing_file').slice(0, 5)) add('texture', 'error', `Missing file ${e.value} at ${e.path}: the scene fails to build or shows nothing there.`, e.path);
    const other = errs.filter((x) => x.code !== 'missing_file');
    for (const e of other.slice(0, 6)) add('schema', 'error', `${e.path}: ${e.message}`, e.didYouMean?.[0] || null);
    if (other.length > 6) add('schema', 'error', `${other.length - 6} more scene errors.`);
  }

  const crit = scene?.critique || {};
  const cov = crit.coverage || {};
  if (stats && !scene?.error) {
    if ((stats.transparent ?? 0) > 0.98) add('empty', 'error', 'The frame is empty (see-through everywhere): nothing drew. Check scene.built and the camera.');
    else if ((stats.contrast ?? 99) < 3) add('flat', 'error', `The frame is one flat tone (mean ${stats.mean} of 255): nothing in shot, or no light reaches it.`);
    if ((stats.clipped ?? 0) > 0.03) add('exposure', 'warning', `${pct(stats.clipped)} of the frame is clipped white. Lower \`rig.exposure\`${mode === 'final' ? ' or `rig.render.exposure`' : ''}, the key light's intensity, or \`scene.env.intensity\`.`, 'rig.exposure');
    const bg = cov.background || 0;
    const env = crit.env || {};
    const emptyDark = bg > 0.15 && Math.abs((stats.crushed ?? 0) - bg) < 0.12 && env.background === 'env' && !env.opaque;
    if (emptyDark) {
      add('background', 'warning', `${pct(bg)} of the frame shows no object, so it shows the layers below (here near black), not the environment. To see the environment there (a sky through a window, a studio around a product), set \`scene.env.opaque: true\`, or add a backdrop.`, 'scene.env.opaque');
    } else if ((stats.crushed ?? 0) > 0.25 && (stats.transparent ?? 0) < 0.5) {
      add('exposure', 'warning', `${pct(stats.crushed)} of the frame is near black. Raise the lights, \`scene.env.intensity\` or \`rig.exposure\`.`, 'rig.exposure');
    } else if ((stats.mean ?? 128) < 40 && (stats.transparent ?? 0) < 0.5) {
      add('exposure', 'warning', `The frame is dark overall (mean ${stats.mean} of 255).`, 'rig.exposure');
    } else if ((stats.mean ?? 128) > 205) {
      add('exposure', 'warning', `The frame is very bright overall (mean ${stats.mean} of 255).`, 'rig.exposure');
    }
    if (mode === 'final' && (stats.speckles ?? 0) > 0.005) add('noise', 'warning', `${pct(stats.speckles)} of the pixels are speckles (fireflies). Raise \`rig.render.spp\`, set \`rig.render.clamp\` to 10-30, keep \`denoise\` on.`, 'rig.render.clamp');
    // (bottlefix) specks the caustic pass left (the page counts them in the pass's own light: render/causticTracer.js AddKernel); the picture
    // alone cannot tell such a soft white blob from a small light or a screen's dot, and the speckle share above misses it
    const cspecks = Math.trunc(crit.caustics?.specks || 0);
    if (mode === 'final' && cspecks >= CAUSTIC_SPECKS) add('noise', 'warning', `${cspecks} pixels of light focused through glass (the caustic pass) stand out as specks: a photon or two seen through a narrow highlight. \`clamp\` and \`spp\` do not reach them; \`scene.caustics: false\` shows the picture without the pass, and a rougher or a smoother surface under the glass takes them away.`, 'scene.caustics');
  }

  const objs = cov.objects || [];
  if (crit.error) add('critique', 'warning', `The shot could not be measured: ${crit.error}`);
  const named = new Set(wanted || []);
  const byId = new Map(objs.map((o) => [o.id, o]));
  const notMeasured = new Set(cov.notMeasured || []);
  const missing = Array.isArray(cov.notFound) ? cov.notFound : [...named].filter((id) => !byId.has(id) && !notMeasured.has(id));
  for (const id of [...missing].sort()) add('object', 'error', `There is no object "${id}" in the world.`);
  for (const id of [...named].filter((x) => notMeasured.has(x)).sort()) add('object', 'info', `"${id}" is drawn by something the shot's rays cannot see (a splat, a sim, points): judge it from the picture.`, null, { object: id });
  const props = objs.filter((o) => o.id !== 'backdrop' && !o.id.startsWith('~'));
  const detail = named.size > 0 || props.length <= DETAIL_OBJECTS;
  // (leftovers2) switched off by `visible` keys at this time: said so, with the key's time
  const keyHidden = (crit.hiddenByKeys || []).filter((h) => h.id !== 'backdrop' && !String(h.id).startsWith('~'));
  const offIds = new Set(keyHidden.map((h) => h.id));
  if (!detail && props.length) {
    const seen = props.filter((o) => (o.visible || 0) > 0);
    const outOf = props.filter((o) => (o.visible || 0) <= 0 && (o.hit || 0) <= 0 && o.outside).map((o) => o.id);
    const hiddenAll = props.filter((o) => (o.visible || 0) <= 0 && (o.hit || 0) > 0).map((o) => o.id);
    let line = `${seen.length} of ${props.length} objects are in shot (largest: ${seen.slice(0, 6).map((o) => `${o.id} ${pct(o.visible)}`).join(', ')})`;
    if (outOf.length) line += `; ${outOf.length} out of the camera (${outOf.slice(0, 6).join(', ')}${outOf.length > 6 ? ', …' : ''})`;
    if (hiddenAll.length) line += `; ${hiddenAll.length} fully hidden (${hiddenAll.slice(0, 6).join(', ')}${hiddenAll.length > 6 ? ', …' : ''})`;
    if (keyHidden.length) line += `; ${keyHidden.length} hidden by their \`visible\` keys at this time (${keyHidden.slice(0, 6).map((h) => h.id).join(', ')}${keyHidden.length > 6 ? ', …' : ''})`;
    add('shot', 'info', `${line}. Name the objects the shot is about in \`objects\` for a check of each.`);
  }
  for (const h of detail ? keyHidden : []) {
    if (named.size && !named.has(h.id)) continue;
    add('object', 'info', keyHiddenText(h), `objects[${h.by ?? h.id}].keys.visible`, { object: h.id });
  }
  for (const o of detail ? objs : []) {
    const id = o.id;
    if (id === 'backdrop' || id.startsWith('~')) continue;
    if (named.size && !named.has(id)) continue;
    if (offIds.has(id)) continue;
    if ((o.visible || 0) <= 0) {
      if ((o.hit || 0) > 0) add('object', 'error', `"${id}" is fully hidden behind "${o.hiddenBy?.[0]?.id ?? '?'}" (it would cover ${pct(o.hit)} of the frame).`, null, { object: id });
      else if (o.outside) {
        const where = { left: 'to the left of', right: 'to the right of', above: 'above', below: 'below', behind: 'behind', far: 'beyond the far end of' }[o.outside] || 'outside';
        add('object', 'error', `"${id}" is outside the camera: ${where} the frame.`, null, { object: id });
      } else if (o.bbox == null) add('object', 'warning', `"${id}" has no geometry the camera can see (an empty graph, or only points).`, null, { object: id });
      continue;
    }
    if (o.visible < 0.01 && (named.size || (o.hit || 0) < 0.01)) add('object', 'warning', `"${id}" is only ${pct(o.visible)} of the frame.`, null, { object: id });
    const by = o.hiddenBy?.[0] || {};
    if (inside(o.bbox, byId.get(by.id)?.bbox)) continue;   // a part inside another (a book's pages in its cover)
    const hidden = o.hidden || 0;
    if (hidden > 0 && (o.hit || 0) > 0 && hidden / o.hit > 0.5 && (named.size || o.hit > 0.02)) add('object', 'warning', `"${id}" is ${Math.round((100 * hidden) / o.hit)} % hidden, mostly by "${by.id ?? '?'}".`, null, { object: id });
    if (o.partlyOutside && named.has(id)) add('object', 'info', `"${id}" runs past the edge of the frame.`, null, { object: id });
  }
  // (camlayer) who films the still: the Scene's own camera, or the project's Camera layer (scene.view.films)
  const layerFilms = scene?.view?.films === 'cameraLayer' || crit.path?.camera === 'layer';
  if ((cov.background || 0) > 0.7 && objs.length) add('framing', 'warning', `${pct(cov.background)} of the frame shows no object: move the camera closer or widen the subject${layerFilms ? " (the Camera layer's place, a look-at on the subject, or its zoom)." : '.'}`, layerFilms ? 'Camera layer' : 'scene.camera');

  const visible = (id) => (byId.get(id)?.visible || 0) > 0;
  const clear = (id) => !!byId.get(id)?.seeThrough;
  for (const c of (crit.contacts || []).filter((x) => (visible(x.a) || visible(x.b)) && (clear(x.a) || clear(x.b) || x.sheet)).slice(0, 4)) {
    add('contact', 'warning', `"${c.a}" rests exactly on "${c.b}": their flat faces share the plane ${c.axis} = ${c.at}. In Final the two surfaces fight there (bands and blotches, plain to see through glass): move "${c.a}" 0.5 to 1 mm off it.`, `objects[${c.a}].at`, { object: c.a });
  }
  for (const m of (crit.media || []).slice(0, 4)) {
    if (m.inner) {
      const outer = m.inner === m.a ? m.b : m.a;
      add('glass', 'warning', `"${m.inner}" sits inside "${outer}", both see-through, with no \`priority\` telling them apart: give the inside one (the liquid) \`priority\` 2 and "${outer}" 1, and let it touch or overlap the inner wall by a millimetre so no air film shows.`, 'materials.priority', { object: m.inner });
    } else add('glass', 'warning', `see-through "${m.a}" and "${m.b}" overlap with equal or no \`priority\`: the higher one is what is there where they meet.`, 'materials.priority');
  }

  const lights = crit.lights || [];
  if (Object.keys(crit).length && !lights.length && (crit.env?.intensity ?? 1) < 0.3) add('light', 'warning', `No lights, and the environment is at ${crit.env.intensity}: the scene is lit only faintly.`, 'scene.lights');
  for (const l of lights) {
    const name = l.id;
    if (l.key && l.behindCamera) add('light', 'info', `The key light "${name}" is behind the camera: the subject gets flat front light. Move it 30-60 degrees to a side for shape.`, `scene.lights[${name}].at`);
    else if (l.key && l.side === 'front' && (l.frontness || 0) > 0.95) add('light', 'info', `The key light "${name}" comes straight from the camera: flat light. Move it to a side.`, `scene.lights[${name}]`);
    if (l.key && l.fromBelow) add('light', 'warning', `The key light "${name}" lights from below.`, `scene.lights[${name}]`);
    if (['spot', 'area'].includes(l.type) && (l.offAxis || 0) > Math.max(45, (l.cone || 0) + 10) && !l.aimsAt) add('light', 'warning', `${l.type} "${name}" points ${l.offAxis} degrees away from the subject and hits no object: aim \`target\` at the subject.`, `scene.lights[${name}].target`);
    if (l.type === 'sun' && (l.elevation || 0) < 0) add('light', 'warning', `Sun "${name}" is below the horizon (dir y < 0): it lights from underneath.`, `scene.lights[${name}].dir`);
    if (l.inShot && ['area', 'point', 'spot'].includes(l.type) && !l.insideObject) add('light', 'info', `Light "${name}" stands inside the frame (a light is not drawn: model the lamp if it should be seen).`);
  }

  // 2D layers over the Scene (components/videoEditor/worldLayerCritique.js): hidden behind the world's objects, too little contrast, out of
  // the frame or the title-safe area, texts on texts. backend/world3d_critique.py _layer_hints says the same.
  const l2 = crit.layers2d;
  if (l2 && !scene?.error) {
    const named = new Map((l2.layers || []).map((l) => [l.id, l.name]));
    for (const l of l2.layers || []) {
      const who = `${l.kind === 'text' ? 'The text' : l.kind === 'picture' ? 'The picture' : 'The HTML clip'} "${l.name}"`;
      if ((l.hidden || 0) >= 0.05) {
        const [text, fix] = layerHiddenHint(l, who);
        add('layerHidden', 'warning', text, fix, { layer: l.id });
      }
      if (l.contrast != null && l.contrast < 3 && (l.hidden || 0) < 0.5) {
        add('layerContrast', 'warning', `${who} has contrast ${l.contrast}:1 against what is under it (${l.color} on about ${l.under}; large text needs 3:1): change its colour, or move it where the frame is darker or lighter.`, `layer ${l.id}: textColor`, { layer: l.id });
      }
      if ((l.outside || 0) > 0.02) add('layerFrame', 'warning', `${who} leaves the frame (${pct(l.outside)} of it outside): move it in or make it smaller.`, `layer ${l.id}: position`, { layer: l.id });
      else if (l.kind === 'text' && (l.outsideSafe || 0) > 0.02) add('layerSafe', 'info', `${who} crosses the title-safe area (${pct(l.outsideSafe)} of it within 5 % of an edge): keep titles inside it.`, `layer ${l.id}: position`, { layer: l.id });
    }
    for (const o of l2.overlaps || []) {
      if (o.share > 0.1) add('layerOverlap', 'warning', `The texts "${named.get(o.a) || o.a}" and "${named.get(o.b) || o.b}" overlap (${pct(o.share)} of the smaller one): move one of them.`, `layer ${o.b}: position`, { layer: o.b });
    }
  }

  // The Scene camera's move, sampled from its first key to its last (world3d/cameraPath.js): an object wholly in shot in this frame that
  // the move takes out of the frame. backend/world3d_critique.py says the same.
  const path = crit.path;
  if (path?.leaves?.length && !scene?.error) {
    for (const o of path.leaves.slice(0, 3)) {
      const layer = path.camera === 'layer';
      add('pathFrame', 'warning', `The camera move takes "${o.id}" out of the frame: at ${o.t} s only ${Math.round(o.inside * 8)} of its box's 8 corners are in shot (all 8 are at ${path.now} s, this frame; the move runs ${path.from}–${path.to} s). Keep it in: ${layer ? `a smaller move, a wider lens (a lower camZoom), or the Camera layer's keys, path or rig that frame it (a look-at: cameraLookAt "@<id>").` : 'a smaller move (world.camera amount), a wider fov, or keys that frame it (scene.camera.keys).'}`, layer ? 'Camera layer' : 'scene.camera.keys', { object: o.id, t: o.t });
    }
  }

  // Draft draws glass and liquids roughly (seen on a perfume bottle: no liquid inside the glass at all), so what is see-through in shot
  // is judged in Final
  if (mode !== 'final' && !scene?.error) {
    const clear = (cov.objects || []).filter((o) => o.seeThrough && (o.visible || 0) + (o.hidden || 0) > 0.002).map((o) => `"${o.id}"`);
    if (clear.length) add('draftGlass', 'info', `${clear.slice(0, 4).join(', ')} ${clear.length > 1 ? 'are' : 'is'} see-through: Draft draws glass and liquids roughly (no liquid inside glass, no refraction). Judge ${clear.length > 1 ? 'them' : 'it'} in a Final still (\`rig.render.mode\` "final").`, 'rig.render.mode');
  }

  if (compare) {
    const d = compare.draft || {}, f = compare.final || {};
    if (d.mean && f.mean) {
      const ratio = f.mean / Math.max(1e-6, d.mean);
      if (Math.abs(ratio - 1) > 0.15) add('draftFinal', 'warning', `Final is ${Math.round(Math.abs(ratio - 1) * 100)} % ${ratio < 1 ? 'darker' : 'brighter'} than Draft (mean ${f.mean} against ${d.mean}): Draft's environment light ignores walls; judge interiors in Final, or match with \`rig.render.exposure\`.`, 'rig.render.exposure');
    }
  }
  const order = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
}

/** The objects in shot as short rows, the named ones first. */
export function coverageRows(scene, wanted = null, limit = 12) {
  const cov = scene?.critique?.coverage || {};
  // where it stands in the picture, in % of the frame from the top left (coverage gives NDC: x right, y up, -1..1): `at` the middle
  // of where it is seen, `span` [left, top, right, bottom] of its outline — what a title placed over the shot needs to keep clear of
  const pctX = (x) => Math.round(Math.min(100, Math.max(0, ((x + 1) / 2) * 100)));
  const pctY = (y) => Math.round(Math.min(100, Math.max(0, ((1 - y) / 2) * 100)));
  // (leftovers2) an object its `visible` keys hide now: { at, until, by? } of the key (world3d/critique.js hiddenByKeys)
  const off = new Map((scene?.critique?.hiddenByKeys || []).map(({ id, ...h }) => [id, h]));
  const rows = (cov.objects || []).map((o) => {
    const r = {};
    for (const k of ['id', 'visible', 'hit', 'hidden', 'outside', 'partlyOutside', 'seeThrough']) if (o[k] != null && o[k] !== false) r[k] = o[k];
    if (o.hiddenBy?.length) r.hiddenBy = o.hiddenBy[0].id;
    if (off.has(o.id)) r.hiddenByKeys = off.get(o.id);
    if (Array.isArray(o.center) && (o.visible || 0) > 0) r.at = [pctX(o.center[0]), pctY(o.center[1])];
    if (Array.isArray(o.bbox?.min) && Array.isArray(o.bbox?.max)) r.span = [pctX(o.bbox.min[0]), pctY(o.bbox.max[1]), pctX(o.bbox.max[0]), pctY(o.bbox.min[1])];
    return r;
  });
  const named = new Set(wanted || []);
  rows.sort((a, b) => (named.has(b.id) - named.has(a.id)) || ((b.visible || 0) - (a.visible || 0)));
  return rows.slice(0, Math.max(limit, named.size));
}

/** The picture's numbers from RGBA pixels (width × height): the same measures as the server's (PIL), on what the page drew. */
export function imageStats(rgba, width, height) {
  const n = width * height;
  const gray = new Uint8Array(n);
  let sum = 0, sum2 = 0, clipped = 0, crushed = 0, transparent = 0;
  const colour = [0, 0, 0];
  for (let i = 0, j = 0; i < n; i += 1, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b);   // PIL's "L"
    gray[i] = l; sum += l; sum2 += l * l;
    if (Math.max(r, g, b) >= 250) clipped += 1;
    if (l <= 6) crushed += 1;
    if (rgba[j + 3] < 8) transparent += 1;
    colour[0] += r; colour[1] += g; colour[2] += b;
  }
  // speckles: more than 40 levels above the 5 × 5 median around them (a sparse sample of rows keeps a 1080p frame cheap)
  let speckles = 0, sampled = 0;
  const win = new Uint8Array(25);
  const step = n > 600000 ? 2 : 1;
  for (let y = 2; y < height - 2; y += step) {
    for (let x = 2; x < width - 2; x += 1) {
      const v = gray[y * width + x];
      sampled += 1;
      if (v < 41) continue;
      let k = 0;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) win[k++] = gray[(y + dy) * width + x + dx];
      win.sort();
      if (v - win[12] > 40) speckles += 1;
    }
  }
  const mean = sum / n;
  const r4 = (x) => Math.round(x * 10000) / 10000;
  return { width, height, mean: Math.round(mean * 10) / 10, contrast: Math.round(Math.sqrt(Math.max(0, sum2 / n - mean * mean)) * 10) / 10,
    clipped: r4(clipped / n), crushed: r4(crushed / n), speckles: r4(sampled ? speckles / sampled : 0), transparent: r4(transparent / n),
    colour: colour.map((c) => Math.round((c / n) * 10) / 10) };
}

/** Mean brightness of the pixels where each object is the first thing seen, from the page's id grid (base64 uint16, row by row). */
export function objectBrightness(rgba, width, height, coverage) {
  const grid = coverage?.grid, objects = coverage?.objects;
  if (!grid || !objects || !coverage.idGrid) return {};
  const [gw, gh] = grid;
  const bin = typeof atob === 'function' ? atob(coverage.idGrid) : Buffer.from(coverage.idGrid, 'base64').toString('binary');
  const sums = new Map();
  for (let j = 0; j < gh; j += 1) {
    for (let i = 0; i < gw; i += 1) {
      const c = j * gw + i;
      const v = bin.charCodeAt(2 * c) | (bin.charCodeAt(2 * c + 1) << 8);
      if (!v || v === 0xffff || v > objects.length) continue;
      const x = Math.min(width - 1, Math.floor(((i + 0.5) / gw) * width)), y = Math.min(height - 1, Math.floor(((j + 0.5) / gh) * height));
      const p = (y * width + x) * 4;
      const l = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
      const id = objects[v - 1].id;
      const s = sums.get(id) || [0, 0];
      s[0] += l; s[1] += 1;
      sums.set(id, s);
    }
  }
  return Object.fromEntries([...sums].map(([id, [s, k]]) => [id, Math.round((s / k) * 10) / 10]));
}

// The Scene schema's strict check and one-field help in JavaScript, for hosts with no Python behind them: the motion engine's scene
// script (`greenlight-motion/script`, which the chat connector runs) checks a `world` with it. The same walk as
// backend/world3d_schema.py over the same built schema (world3d-schema.json, from build.mjs); validate.test.mjs holds the two to the
// same answers on the same cases.
//
//   validateRig(rig, { path, only: 'scene' | 'render', mediaExists }) → { ok, errors, warnings }
//   validateProject(data) → the same for every Scene layer of a project, plus `scenes`
//   fieldHelp({ path, op, q }) → type, range, default, what it does, an example, related fields
import { envStrengthShadowed } from './envStrength.js';
import SCHEMA from '../../../../skills/greenlight-dash/references/video/world3d-schema.json' with { type: 'json' };

export const schema = SCHEMA;

// ── names ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Ratcliff/Obershelp similarity, as Python's difflib.SequenceMatcher.ratio() measures it. */
function ratio(a, b) {
  const match = (s, t) => {
    if (!s.length || !t.length) return 0;
    let best = 0, bi = 0, bj = 0;
    for (let i = 0; i < s.length; i += 1) {
      for (let j = 0; j < t.length; j += 1) {
        let k = 0;
        while (i + k < s.length && j + k < t.length && s[i + k] === t[j + k]) k += 1;
        if (k > best) { best = k; bi = i; bj = j; }
      }
    }
    if (!best) return 0;
    return best + match(s.slice(0, bi), t.slice(0, bj)) + match(s.slice(bi + best), t.slice(bj + best));
  };
  const total = a.length + b.length;
  return total ? (2 * match(a, b)) / total : 0;
}

const close = (name, candidates, n = 3, cutoff = 0.6) => candidates.map((c) => [ratio(name, c), c]).filter(([r]) => r >= cutoff)
  .sort((x, y) => y[0] - x[0]).slice(0, n).map(([, c]) => c);

/** The closest real names: an alias first (a three.js or Blender name agents reach for), then case and spelling neighbours. */
export function didYouMean(name, candidates, aliases = null, n = 3) {
  const cands = [...candidates].filter((c) => typeof c === 'string');
  const out = [];
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, name)) out.push(aliases[name]);
  const low = new Map(cands.map((c) => [c.toLowerCase(), c]));
  const lname = String(name).toLowerCase();
  if (low.has(lname)) out.push(low.get(lname));
  out.push(...close(String(name), cands, n));
  out.push(...close(lname, [...low.keys()], n).map((m) => low.get(m)));
  return [...new Set(out)].filter((c) => c !== name).slice(0, n);
}

// ── types ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const KELVIN = /^\d+(\.\d+)?\s*[kK]$/;
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC = /^(rgb|rgba|hsl|hsla)\(\s*[-0-9.%\s,/]+\)$/i;
const CSS_NAMES = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue
chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen
mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid
palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue
saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle
tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(/\s+/));

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(isNum);
export const isColor = (v) => typeof v === 'string' && (HEX.test(v.trim()) || FUNC.test(v.trim()) || CSS_NAMES.has(v.trim().toLowerCase()));
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function typeOk(v, t) {
  switch (t) {
    case 'any': return true;
    case 'number': return isNum(v);
    case 'int': return isNum(v) && Number.isInteger(v);
    case 'bool': return typeof v === 'boolean';
    case 'string': case 'url': case 'color': return typeof v === 'string';
    case 'vec2': return isVec(v, 2);
    case 'vec3': return isVec(v, 3);
    case 'vec4': return isVec(v, 4);
    case 'object': case 'map': case 'keys': case 'keyed': return isObj(v);
    case 'array': return Array.isArray(v);
    case 'node': return Array.isArray(v) || isObj(v);
    case 'null': return v === null;
    default: return true;
  }
}
const TYPE_WORDS = { number: 'a number', int: 'a whole number', bool: 'true or false', string: 'a string', url: 'a media URL string',
  color: 'a colour string ("#rrggbb")', vec2: '[x, y]', vec3: '[x, y, z]', vec4: '[x, y, z, w]', object: 'an object', map: 'an object of named entries',
  keys: 'an object of key tracks', keyed: 'an object of fields', array: 'a list', null: 'null', any: 'anything' };
const typesOf = (spec) => (Array.isArray(spec.type) ? spec.type : [spec.type || 'any']);
const short = (v) => { const s = JSON.stringify(v) ?? String(v); return s.length <= 80 ? v : `${s.slice(0, 77)}...`; };

function join(path, key) {
  if (typeof key === 'number') return `${path}[${key}]`;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key))) return path ? `${path}.${key}` : String(key);
  return `${path}[${JSON.stringify(key)}]`;
}

// ── the walk ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function makeCtx(mediaExists = null) {
  const issues = [];
  return {
    issues, mediaExists, mediaSeen: new Set(),
    add(severity, code, path, message, extra = {}) {
      const issue = { path, code, severity, message };
      for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) issue[k] = v;
      issues.push(issue);
    },
  };
}

function check(ctx, value, spec, path, name = '', keyable = null) {
  if (spec.removed) { ctx.add('warning', 'removed_field', path, `\`${name}\` is gone and is ignored: ${spec.removed}`, { name }); return; }
  if (spec.ignored) { ctx.add('warning', 'ignored_field', path, `\`${name}\` does nothing here: ${spec.ignored}`, { name }); return; }
  if (spec.internal) return;
  if (spec.ref === 'procedural') { checkProcedural(ctx, value, path); return; }
  // a texture graph: its own fields as the schema lists them, then the engine's tables (a preset's numbers, each node's op and fields)
  if (spec.ref === 'textureGraph') { check(ctx, value, { ...spec, ref: null }, path, name, keyable); if (SCHEMA.textureGraph && isObj(value)) checkTexGraph(ctx, value, path); return; }
  if (spec.sim) { checkSim(ctx, value, path); return; }
  const types = typesOf(spec);
  const t = types.find((x) => typeOk(value, x));
  if (!t) {
    ctx.add('error', 'bad_type', path, `\`${name || path}\` must be ${types.map((x) => TYPE_WORDS[x] || x).join(' or ')}, not ${String(JSON.stringify(value)).slice(0, 60)}`,
      { name, expected: types, value: short(value) });
    return;
  }
  if (t === 'number' || t === 'int') {
    const lo = spec.min, hi = spec.max;
    if ((lo != null && value < lo) || (hi != null && value > hi)) {
      ctx.add('warning', 'out_of_range', path, `\`${name}\` is ${value}, outside ${lo ?? '-∞'}..${hi ?? '∞'}: it is clamped or misbehaves`, { name, value, min: lo, max: hi });
    }
    if (spec.values && !spec.values.includes(value)) ctx.add('error', 'bad_value', path, `\`${name}\` is ${value}; it takes ${JSON.stringify(spec.values)}`, { name, value, allowed: spec.values });
  } else if (t === 'color') {
    // (octane1) a light's or a glow's colour may be a colour temperature: "3200K"
    if (!isColor(value) && !(spec.kelvin && KELVIN.test(String(value).trim()))) ctx.add('error', 'bad_value', path, `\`${name}\` is "${value}", not a colour: write "#rrggbb"${spec.kelvin ? ' or a temperature such as "3200K"' : ''}`, { name, value });
  } else if (t === 'string') {
    const allowed = spec.values || (spec.valuesFrom ? SCHEMA.lists[spec.valuesFrom] : null);
    if (allowed && !allowed.includes(value)) {
      ctx.add('error', 'bad_value', path, `\`${name}\` is "${value}"; it takes ${allowed.join(', ')}`, { name, value, allowed, didYouMean: didYouMean(value, allowed) });
    }
  } else if (t === 'url') {
    checkMedia(ctx, value, path);
  } else if (t === 'object') {
    checkObject(ctx, value, spec, path);
  } else if (t === 'map') {
    const of = spec.of || { type: 'any' };
    for (const [k, v] of Object.entries(value)) check(ctx, v, of, join(path, k), String(k));
  } else if (t === 'array') {
    const items = spec.items;
    if (items?.type === 'node') checkGraph(ctx, value, path);
    else if (items) value.forEach((v, i) => check(ctx, v, items, join(path, i), name));
  } else if (t === 'keys') {
    checkKeys(ctx, value, path, keyable, spec.tracks);
  } else if (t === 'keyed') {
    checkKeyed(ctx, value, path, keyable, spec.of || { type: 'any' }, name);
  } else if (t === 'vec4' && spec.bezier) {
    checkBezier(ctx, value, path, name);
  }
  if (name === 'metal' && typeof value === 'string') {
    const names = [...SCHEMA.lists.metals, ...SCHEMA.lists.metalAliases];
    if (!names.includes(value.toLowerCase())) {
      ctx.add('error', 'bad_value', path, `\`metal\` "${value}" is not a metal it knows: ${SCHEMA.lists.metals.join(', ')}, or { n, k }`,
        { name, value, allowed: SCHEMA.lists.metals, didYouMean: didYouMean(value.toLowerCase(), names) });
    }
  }
}

function fieldsOf(spec, value) {
  const v = spec.variants;
  if (!v) return [spec.fields || {}, null];
  const kind = value[v.by] ?? v.common[v.by]?.default;
  let kase = typeof kind === 'string' ? v.cases[kind] : null;
  if (kase === 'placed') kase = Object.fromEntries(Object.entries(v.placed).filter(([, s]) => !s.only || s.only.includes(kind)));
  return [{ ...v.common, ...(kase || {}) }, kind];
}

const live = (fields) => Object.entries(fields).filter(([, s]) => !(isObj(s) && (s.internal || s.removed || s.ignored))).map(([k]) => k).sort();

function checkObject(ctx, value, spec, path) {
  if (!spec.fields && !spec.variants) return;   // an object the schema does not describe field by field
  const [fields, kind] = fieldsOf(spec, value);
  const v = spec.variants;
  const skip = new Set();
  if (v && value[v.by] !== undefined && !Object.prototype.hasOwnProperty.call(v.cases, value[v.by])) {
    skip.add(v.by);
    const allowed = Object.keys(v.cases);
    ctx.add('error', 'bad_value', join(path, v.by), `\`${v.by}\` is "${value[v.by]}"; it takes ${allowed.join(', ')}`,
      { name: v.by, value: value[v.by], allowed, didYouMean: didYouMean(String(value[v.by]), allowed, spec.valueAliases?.[v.by] || null) });
  }
  const aliases = spec.aliases || null;
  for (const [k, val] of Object.entries(value)) {
    if (skip.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(fields, k)) { check(ctx, val, fields[k], join(path, k), k, spec.keyable || null); continue; }
    if (spec.open) continue;
    // a field of another kind of this object (a sun's `at`): known, but nothing reads it on this one
    let other = null;
    if (v) {
      for (const [caseName, kase] of Object.entries(v.cases)) {
        const cf = kase === 'placed' ? v.placed : kase;
        if (isObj(cf) && cf[k] && (!cf[k].only || cf[k].only.includes(caseName))) { other = caseName; break; }
      }
    }
    if (other) {
      ctx.add('error', 'unknown_field', join(path, k), `\`${k}\` is a field of ${/^[aeiou]/.test(other) ? 'an' : 'a'} ${other} ${spec.noun || 'light'}, not of a ${kind}: it is ignored`,
        { name: k, didYouMean: didYouMean(k, Object.keys(fields), aliases) });
      continue;
    }
    const offered = live(fields);
    let hint = didYouMean(k, offered, aliases);
    const transmissive = 'transmission' in fields && isNum(value.transmission) && value.transmission > 0;
    if (transmissive && ['color', 'colour', 'tint', 'basecolor', 'albedo', 'diffuse', 'absorption', 'absorptioncolor'].includes(k.toLowerCase()) && offered.includes('attenuationColor')) {
      hint = ['attenuationColor', ...hint.filter((h) => h !== 'attenuationColor')];
      ctx.add('error', 'unknown_field', join(path, k), `\`${k}\` is not a field here, so it is ignored. On glass or a liquid (transmission > 0) the colour of the body is `
        + '`attenuationColor` with `attenuationDistance`; `base` only tints its surface.', { name: k, didYouMean: hint, allowed: offered });
      continue;
    }
    if (transmissive && ['opacity', 'transparent', 'transparency'].includes(k.toLowerCase()) && offered.includes('alpha')) {
      ctx.add('error', 'unknown_field', join(path, k), `\`${k}\` is not a field here, so it is ignored. Glass and liquids are see-through by \`transmission\` already; leave alpha out.`,
        { name: k, didYouMean: ['transmission'], allowed: offered });
      continue;
    }
    ctx.add('error', 'unknown_field', join(path, k), `\`${k}\` is not a field here, so it is ignored${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`,
      { name: k, didYouMean: hint, allowed: offered });
  }
}

const TRACK_ALIASES = { position: 'at', pos: 'at', rotation: 'rot', scaling: 'scale', lookAt: 'target', focusDistance: 'focus' };

// (smallfix) a cubic-bezier [x1, y1, x2, y2]: x is time, so outside 0..1 the curve is no ease; y outside -3..4 is clamped (the editor's range)
function checkBezier(ctx, value, path, name) {
  if (value.some((x, i) => i % 2 === 0 && (x < 0 || x > 1))) {
    ctx.add('error', 'bad_value', path, `\`${name}\` [x1, y1, x2, y2]: x1 and x2 are shares of the time between the keys, 0 to 1, not ${JSON.stringify(value)}`, { name, value });
  } else if (value.some((y, i) => i % 2 === 1 && (y < -3 || y > 4))) {
    ctx.add('warning', 'out_of_range', path, `\`${name}\` [x1, y1, x2, y2]: y1 and y2 are clamped to -3..4`, { name, value, min: -3, max: 4 });
  }
}

function checkKeys(ctx, value, path, keyable, tracks = null) {
  const kb = keyable || [];
  for (const [track, keys] of Object.entries(value)) {
    const tp = join(path, track);
    if (kb.length && !kb.some((k) => track === k || (k.endsWith(':*') && track.startsWith(k.slice(0, -1))))) {
      ctx.add('error', 'unknown_field', tp, `\`${track}\` cannot be keyed here; keyable: ${kb.join(', ')}`,
        { name: track, allowed: kb, didYouMean: didYouMean(track, kb.filter((k) => !k.endsWith(':*')), TRACK_ALIASES) });
      continue;
    }
    if (!Array.isArray(keys)) { ctx.add('error', 'bad_type', tp, `a track is a list of { t, v, ease }, not ${String(JSON.stringify(keys)).slice(0, 40)}`, { name: track }); continue; }
    let last = null;
    // (smallfix) a track whose keys hold another kind of value (an object's `visible`: true or false, switched at each key)
    const own = tracks && Object.hasOwn(tracks, track) ? tracks[track] : null;
    keys.forEach((key, i) => {
      check(ctx, key, SCHEMA.key, join(tp, i), track);
      if (own && isObj(key)) {
        if ('v' in key) check(ctx, key.v, own, join(join(tp, i), 'v'), track);
        if (own.step && 'ease' in key) ctx.add('warning', 'ignored_field', join(join(tp, i), 'ease'), `\`${track}\` switches at each key's time: \`ease\` does nothing here`, { name: 'ease' });
      }
      if (isObj(key) && isNum(key.t)) {
        if (last != null && key.t < last) ctx.add('warning', 'bad_value', join(tp, i), `keys of \`${track}\` must run in time order (${key.t} after ${last})`, { name: track });
        last = key.t;
      }
    });
  }
}

// (animtools) `drive` and `fx`: a map whose names are the object's keyable fields, each value checked against `of`
function checkKeyed(ctx, value, path, keyable, of, name) {
  const kb = (keyable || []).filter((k) => k !== 'visible');
  const verb = name === 'drive' ? 'driven' : 'given an ƒx';
  for (const [field, v] of Object.entries(value)) {
    const fp = join(path, field);
    if (kb.length && !kb.some((k) => field === k || (k.endsWith(':*') && field.startsWith(k.slice(0, -1))))) {
      ctx.add('error', 'unknown_field', fp, `\`${field}\` cannot be ${verb} here; it takes: ${kb.join(', ')}`,
        { name: field, allowed: kb, didYouMean: didYouMean(field, kb.filter((k) => !k.endsWith(':*')), TRACK_ALIASES) });
      continue;
    }
    check(ctx, v, of, fp, field);
  }
}

// ── (animtools) clocks, drives, ƒx and follow paths across the scene ────────────────────────────────────────────────────────

const VEC_FIELDS = { at: 3, rot: 3, target: 3, shift: 2 };

/** An ƒx (a field's or a clock's `filter`) names exactly one; Glide's `weight` is a percent. */
const fxNames = () => Object.keys(SCHEMA.roots.rig.fields.scene.fields.clocks.of.fields.filter.fields);
function checkFxOne(ctx, fx, path) {
  if (!isObj(fx)) return;
  const given = Object.keys(fx);
  if (given.length > 1) { ctx.add('error', 'bad_value', path, `one ƒx a field, not ${given.length}: ${given.join(', ')}`, { name: 'fx', allowed: fxNames() }); return; }
  if (!given.length) { ctx.add('error', 'missing_required', path, `an ƒx names one of ${fxNames().join(', ')}`, { name: 'fx' }); return; }
  const g = fx.glide;
  if (isObj(g) && isNum(g.weight) && g.weight > 0 && g.weight <= 1) {
    ctx.add('warning', 'out_of_range', join(join(path, 'glide'), 'weight'), `\`weight\` is the share of every move the tail carries, in percent (25 is a quarter): ${g.weight} is ${g.weight} %`, { name: 'weight', value: g.weight });
  }
}

/** One drive term: its clock is the scene's, its remap's points rise in u and carry the field's shape; an expression's variables likewise. */
function checkDriveTerm(ctx, term, path, field, clocks) {
  if (!isObj(term)) return;
  const names = Object.keys(clocks);
  if (typeof term.expr === 'string') {
    if (term.clock !== undefined) ctx.add('warning', 'ignored_field', join(path, 'clock'), 'a term with `expr` reads its clocks through `vars`: `clock` and `map` do nothing here', { name: 'clock' });
    if (isObj(term.vars)) for (const [k, v] of Object.entries(term.vars)) if (isObj(v)) checkDriveTerm(ctx, v, join(join(path, 'vars'), k), '', clocks);
    return;
  }
  if (typeof term.clock !== 'string') ctx.add('error', 'missing_required', path, 'a drive needs `clock`, the name of a clock in `scene.clocks` (or an `expr`)', { name: 'clock' });
  else if (!Object.hasOwn(clocks, term.clock)) {
    ctx.add('error', 'unknown_ref', join(path, 'clock'), names.length ? `no clock "${term.clock}" in scene.clocks (it has ${names.join(', ')}): the field keeps its keys or its value`
      : `no clock "${term.clock}": write it in scene.clocks`, { name: term.clock, didYouMean: didYouMean(term.clock, names.sort()) });
  }
  if (!Array.isArray(term.map)) return;
  const want = VEC_FIELDS[field] || 0;
  let last = null;
  term.map.forEach((e, i) => {
    const ep = join(join(path, 'map'), i);
    if (!Array.isArray(e) || e.length < 2 || e.length > 3) { ctx.add('error', 'bad_type', ep, `a remap point is [u, v] or [u, v, ease], not ${String(JSON.stringify(e)).slice(0, 40)}`, { name: 'map' }); return; }
    if (!isNum(e[0])) { ctx.add('error', 'bad_type', join(ep, 0), `u (the clock's value) is a number, not ${String(JSON.stringify(e[0])).slice(0, 40)}`, { name: 'map' }); return; }
    if (last != null && e[0] < last) ctx.add('warning', 'bad_value', join(ep, 0), `a remap's u must rise (${e[0]} after ${last})`, { name: 'map' });
    last = e[0];
    const v = e[1];
    // (a variable of an expression, field '': a number or a list of numbers)
    const okV = !field ? isNum(v) || (Array.isArray(v) && v.length > 0 && v.every(isNum))
      : want ? (isVec(v, want) || (field === 'scale' && isNum(v))) : (field === 'scale' ? isNum(v) || isVec(v, 3) : isNum(v));
    if (!okV) ctx.add('error', 'bad_type', join(ep, 1), `\`${field || 'v'}\` takes ${!field ? 'a number or a list of numbers' : want ? `[${want === 3 ? 'x, y, z' : 'x, y'}]` : field === 'scale' ? 'a number or [x, y, z]' : 'a number'} here, not ${String(JSON.stringify(v)).slice(0, 40)}`, { name: field || 'v' });
    if (e.length === 3) check(ctx, e[2], SCHEMA.key.fields.ease, join(ep, 2), 'ease');
  });
}

function checkMotion(ctx, scene, path) {
  const clocks = isObj(scene.clocks) ? scene.clocks : {};
  for (const [name, c] of Object.entries(clocks)) {
    const cp = join(join(path, 'clocks'), name);
    if (!isObj(c)) continue;
    if (!Array.isArray(c.keys) || !c.keys.length) ctx.add('error', 'missing_required', cp, `clock "${name}" needs \`keys\`: [{ t, v, ease }]`, { name: 'keys' });
    else c.keys.forEach((k, i) => { if (isObj(k) && 'v' in k && !isNum(k.v)) ctx.add('error', 'bad_type', join(join(join(cp, 'keys'), i), 'v'), `a clock's value is a number, not ${String(JSON.stringify(k.v)).slice(0, 40)}`, { name: 'v' }); });
    checkFxOne(ctx, c.filter, join(cp, 'filter'));
  }
  const items = [];
  (Array.isArray(scene.objects) ? scene.objects : []).forEach((o, i) => items.push([o, join(join(path, 'objects'), i)]));
  if (isObj(scene.camera)) items.push([scene.camera, join(path, 'camera')]);
  (Array.isArray(scene.layers2d) ? scene.layers2d : []).forEach((l, i) => items.push([l, join(join(path, 'layers2d'), i)]));
  for (const [item, ip] of items) {
    if (!isObj(item)) continue;
    if (isObj(item.drive)) {
      for (const [field, d] of Object.entries(item.drive)) {
        const dp = join(join(ip, 'drive'), field);
        if (Array.isArray(d)) d.forEach((term, i) => checkDriveTerm(ctx, term, join(dp, i), field, clocks));
        else checkDriveTerm(ctx, d, dp, field, clocks);
      }
    }
    if (isObj(item.fx)) {
      for (const [field, fx] of Object.entries(item.fx)) {
        const fp = join(join(ip, 'fx'), field);
        checkFxOne(ctx, fx, fp);
        const keys = isObj(item.keys) ? item.keys[field] : null;
        if (!(Array.isArray(keys) && keys.length)) ctx.add('warning', 'unused', fp, `an ƒx works on the field's keys: \`${field}\` has none, so it does nothing`, { name: field });
      }
    }
    const pathMoves = ['along', 'bank'].filter((f) => (isObj(item.keys) && item.keys[f]) || (isObj(item.drive) && item.drive[f] != null));
    if (pathMoves.length && !isObj(item.path)) ctx.add('warning', 'unused', join(ip, isObj(item.keys) && item.keys[pathMoves[0]] ? 'keys' : 'drive'), `\`${pathMoves[0]}\` moves an object along its \`path\`: this one has none`, { name: pathMoves[0] });
    if (isObj(item.path) && !(Array.isArray(item.path.points) && item.path.points.filter((p) => isVec(p, 3)).length >= 2)) {
      ctx.add('error', 'missing_required', join(join(ip, 'path'), 'points'), 'a path needs `points`, two [x, y, z] or more', { name: 'points' });
    }
  }
  const objectIds = new Set((Array.isArray(scene.objects) ? scene.objects : []).filter((o) => isObj(o) && o.id != null).map((o) => String(o.id)));
  (Array.isArray(scene.layers2d) ? scene.layers2d : []).forEach((l, i) => {
    if (!isObj(l) || l.parent == null) return;
    if (!objectIds.has(String(l.parent))) ctx.add('error', 'unknown_ref', join(join(join(path, 'layers2d'), i), 'parent'), `parent "${l.parent}" does not exist, so the card stands where it is written`, { name: l.parent, didYouMean: didYouMean(String(l.parent), [...objectIds].sort()) });
    else if (l.screen) ctx.add('warning', 'ignored_field', join(join(join(path, 'layers2d'), i), 'parent'), 'a card pinned to the frame (`screen`) rides no object', { name: 'parent' });
  });
}

// ── graphs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const refsOf = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const ALTERNATIVES = { svg: ['polygon', 'shape'], polygon: ['shape', 'svg'], shape: ['polygon', 'svg'], count: ['density', 'spacing'], density: ['count'], paths: ['points'], points: ['paths'], path: ['points'] };

function checkGraph(ctx, nodes, path, objectIds = null) {
  if (!Array.isArray(nodes)) { ctx.add('error', 'bad_type', path, '`graph` is a list of op nodes', { name: 'graph' }); return; }
  const ops = SCHEMA.ops;
  const nodeKeys = new Set(SCHEMA.nodeKeys);
  const ids = nodes.filter((n) => isObj(n) && n.id != null).map((n) => n.id);
  nodes.forEach((node, i) => {
    const np = join(path, i);
    if (!isObj(node)) { ctx.add('error', 'bad_type', np, 'a node is { "op": "…", …params }', { name: 'node' }); return; }
    const op = node.op;
    if (!Object.prototype.hasOwnProperty.call(ops, op)) {
      const hint = didYouMean(String(op), Object.keys(ops));
      ctx.add('error', 'unknown_op', join(np, 'op'), `unknown op "${op}"${hint.length ? `: did you mean "${hint[0]}"?` : ''}`, { name: op, didYouMean: hint });
      return;
    }
    const spec = ops[op];
    const params = spec.params || {};
    for (const [k, v] of Object.entries(node)) {
      if (nodeKeys.has(k)) continue;
      if (Object.prototype.hasOwnProperty.call(params, k)) { checkParam(ctx, op, k, v, params[k], join(np, k)); continue; }
      if (spec.open) continue;
      const hint = didYouMean(k, Object.keys(params));
      ctx.add('error', 'unknown_param', join(np, k), `${op} has no parameter \`${k}\`, so it is ignored${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`,
        { name: k, op, didYouMean: hint, allowed: Object.keys(params).sort() });
    }
    for (const [k, p] of Object.entries(params)) {
      if (p.required && !(k in node) && !(ALTERNATIVES[k] || []).some((a) => a in node)) ctx.add('error', 'missing_required', np, `${op} needs \`${k}\``, { name: k, op });
    }
    const groups = new Set(Object.values(params).filter((p) => p.requiredOneOf).map((p) => JSON.stringify(p.requiredOneOf)));
    for (const g of groups) {
      const list = JSON.parse(g);
      if (!list.some((k) => k in node)) ctx.add('error', 'missing_required', np, `${op} needs one of ${list.map((k) => `\`${k}\``).join(', ')}`, { name: list[0], op, allowed: list });
    }
    if (op === 'lathe' && Array.isArray(node.profile)) checkProfile(ctx, node.profile, join(np, 'profile'));
    for (const ref of [...refsOf(node.in), ...refsOf(node.sources)]) {
      if (typeof ref === 'string' && ref.startsWith('#') && !ids.includes(ref.slice(1))) {
        ctx.add('error', 'unknown_ref', join(np, 'in'), `no node with id "${ref.slice(1)}" in this graph`, { name: ref, didYouMean: didYouMean(ref.slice(1), ids) });
      } else if (typeof ref === 'string' && ref.startsWith('@') && objectIds && !objectIds.has(ref.slice(1))) {
        ctx.add('error', 'unknown_ref', join(np, 'in'), `no object with id "${ref.slice(1)}"`, { name: ref, didYouMean: didYouMean(ref.slice(1), [...objectIds].sort()) });
      } else if (typeof ref === 'string' && !['#', '@'].includes(ref[0])) {
        ctx.add('error', 'bad_value', join(np, 'in'), `a reference is "#nodeId" or "@objectId", not "${ref}"`, { name: ref });
      }
    }
    (Array.isArray(node.targets) ? node.targets : []).forEach((target, ti) => {
      if (isObj(target) && Array.isArray(target.graph)) checkGraph(ctx, target.graph, join(join(join(np, 'targets'), ti), 'graph'), objectIds);
      (isObj(target) && Array.isArray(target.frames) ? target.frames : []).forEach((frame, fi) => {
        if (isObj(frame) && Array.isArray(frame.graph)) checkGraph(ctx, frame.graph, join(join(join(join(join(np, 'targets'), ti), 'frames'), fi), 'graph'), objectIds);
      });
    });
  });
}

/** A lathe profile that crosses itself makes a solid whose inside pokes out through its outside (a broken bottle neck). */
function checkProfile(ctx, profile, path) {
  const pts = profile.filter((p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]));
  if (pts.length !== profile.length) { ctx.add('error', 'bad_value', path, 'a lathe profile is a list of [radius, y] points', { name: 'profile' }); return; }
  if (pts.some((p) => p[0] < 0)) ctx.add('error', 'bad_value', path, "a lathe profile's radius (the first number of each point) cannot be negative", { name: 'profile' });
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const segs = pts.slice(1).map((p, i) => [pts[i], p]);
  const closedLoop = pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 2; j < segs.length; j += 1) {
      if (i === 0 && j === segs.length - 1 && closedLoop) continue;
      const [a, b] = segs[i], [c, d] = segs[j];
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
      if ((d1 > 0) !== (d2 > 0) && (d3 > 0) !== (d4 > 0) && ![d1, d2, d3, d4].includes(0)) {
        ctx.add('error', 'bad_value', path, `the profile crosses itself: segment ${i} (${JSON.stringify(a)} to ${JSON.stringify(b)}) crosses segment ${j} `
          + `(${JSON.stringify(c)} to ${JSON.stringify(d)}); the solid turns inside out there. Keep the inner line inside the outer one.`, { name: 'profile', value: [i, j] });
        return;
      }
    }
  }
}

function checkParam(ctx, op, k, v, p, path) {
  if (p.values && typeof v === 'string' && !p.values.includes(v)) {
    ctx.add('error', 'bad_value', path, `${op}.${k} is "${v}"; it takes ${p.values.join(', ')}`, { name: k, op, value: v, allowed: p.values, didYouMean: didYouMean(v, p.values) });
  }
  // (bugsB) a parameter that says exactly what it takes (a box's `size`: a number or [x, y, z]): anything else is wrong
  if (Array.isArray(p.type) && !p.type.some((x) => typeOk(v, x))) {
    ctx.add('error', 'bad_type', path, `${op}.${k} is ${p.type.map((x) => TYPE_WORDS[x] || x).join(' or ')}, not ${String(JSON.stringify(v)).slice(0, 60)}`,
      { name: k, op, expected: p.type, value: short(v) });
    return;
  }
  checkParamRange(ctx, op, k, v, p, path);
  if (p.type === 'number' && typeof v === 'string') ctx.add('error', 'bad_type', path, `${op}.${k} is a number, not "${v}"`, { name: k, op, expected: ['number'], value: v });
  if (p.type === 'string' && isNum(v) && !['material', 'region', 'group'].includes(k)) {
    ctx.add('warning', 'bad_type', path, `${op}.${k} is text (default "${p.default}"), not ${v}`, { name: k, op, expected: ['string'], value: v });
  }
}

/** (bugsB) A value past the least or the most a parameter takes: a negative radius or size turns the mesh inside out. */
function checkParamRange(ctx, op, k, v, p, path) {
  const lo = p.min ?? null, hi = p.max ?? null;
  if (lo === null && hi === null) return;
  const nums = isNum(v) ? [v] : Array.isArray(v) ? v.filter(isNum) : [];
  if (!nums.some((x) => (lo !== null && x < lo) || (hi !== null && x > hi))) return;
  const message = lo === 0 && hi === null ? `${op}.${k} is ${JSON.stringify(v)}: a length cannot be negative (the mesh turns inside out)`
    : `${op}.${k} is ${JSON.stringify(v)}, outside ${lo ?? '-∞'}..${hi ?? '∞'}`;
  ctx.add('error', 'out_of_range', path, message, { name: k, op, value: short(v), min: lo, max: hi });
}

// ── procedural and sims ────────────────────────────────────────────────────────────────────────────────────────────────

// A material's texture graph against the engine's tables (schema.textureGraph, from render/texGraphPresets.js and texGraphNodes.js): what
// the graph itself refuses when the scene builds, said here, with the right name. backend/world3d_schema.py _check_tex_graph says the same.
function checkTexGraph(ctx, value, path) {
  const tg = SCHEMA.textureGraph;
  if (value.preset != null) {
    const preset = tg.presets[value.preset];
    if (!preset) return;   // the preset's own name check has said so
    const names = Object.keys(preset.params).filter((k) => !preset.params[k].internal);
    const allowed = [...Object.keys(preset.params), ...tg.common];
    for (const [k, v] of Object.entries(value)) {
      if (!allowed.includes(k)) {
        const hint = didYouMean(k, [...names, ...tg.common]);
        ctx.add('error', 'unknown_field', join(path, k), `preset ${value.preset} has no \`${k}\`, so it is ignored${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`,
          { name: k, didYouMean: hint, allowed: names });
        continue;
      }
      const p = preset.params[k];
      if (p && typeof v === 'number' && ((p.min != null && v < p.min) || (p.max != null && v > p.max))) {
        ctx.add('error', 'out_of_range', join(path, k), `\`${k}\` is ${v}; preset ${value.preset} takes ${p.min ?? '…'}–${p.max ?? '…'}`, { name: k, value: v, min: p.min, max: p.max });
      }
    }
    for (const k of Object.keys(isObj(value.keys) ? value.keys : {})) {
      if (preset.params[k]) continue;
      const hint = didYouMean(k, names);
      ctx.add('error', 'unknown_field', join(join(path, 'keys'), k), `preset ${value.preset} has no \`${k}\` to key${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`, { name: k, didYouMean: hint });
    }
    return;
  }
  for (const k of Object.keys(value)) {
    if (tg.custom.includes(k)) continue;
    const hint = didYouMean(k, tg.custom);
    ctx.add('error', 'unknown_field', join(path, k), `a texture graph takes \`preset\`, or ${tg.custom.join(', ')}: \`${k}\` is ignored${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`,
      { name: k, didYouMean: hint });
  }
  if (!Array.isArray(value.nodes) || !value.nodes.length) { ctx.add('error', 'missing_required', path, 'a texture graph needs `preset` or a `nodes` list', { name: 'nodes' }); return; }
  const ops = Object.keys(tg.nodes);
  value.nodes.forEach((node, i) => {
    const np = `${join(path, 'nodes')}[${i}]`;
    if (!isObj(node) || typeof node.op !== 'string') { ctx.add('error', 'bad_type', np, 'a texture node is { "op": …, "id"?: …, …its fields }', { name: 'op' }); return; }
    const def = tg.nodes[node.op];
    if (!def) {
      const hint = didYouMean(node.op, ops);
      ctx.add('error', 'unknown_op', join(np, 'op'), `unknown texture node "${node.op}"${hint.length ? `: did you mean "${hint[0]}"?` : ''}`, { name: node.op, didYouMean: hint, allowed: ops });
      return;
    }
    const fields = Object.keys(def.params).filter((k) => !def.params[k].internal);
    for (const k of Object.keys(node)) {
      if (tg.nodeKeys.includes(k) || Object.prototype.hasOwnProperty.call(def.params, k)) continue;
      const hint = didYouMean(k, fields);
      ctx.add('error', 'unknown_param', join(np, k), `${node.op} has no field \`${k}\`, so it is ignored${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`,
        { name: k, op: node.op, didYouMean: hint, allowed: fields });
    }
  });
}

/** A texture graph's preset or node, by name (and one of its fields): from schema.textureGraph. */
function texGraphHelp([name, field]) {
  const tg = SCHEMA.textureGraph;
  const kind = tg.presets[name] ? 'preset' : tg.nodes[name] ? 'node' : null;
  if (!kind) return { error: `no preset or node \`${name}\` in a texture graph`, didYouMean: didYouMean(String(name), [...Object.keys(tg.presets), ...Object.keys(tg.nodes)]), presets: Object.keys(tg.presets), nodes: Object.keys(tg.nodes) };
  const entry = kind === 'preset' ? tg.presets[name] : tg.nodes[name];
  const params = Object.fromEntries(Object.entries(entry.params).filter(([, p]) => !p.internal));
  if (field) return params[field] ? { path: `graph.${name}.${field}`, ...params[field] } : { error: `${kind} ${name} has no \`${field}\``, didYouMean: didYouMean(field, Object.keys(params)), fields: Object.keys(params) };
  return { path: `graph.${name}`, [kind]: name, ...(entry.doc ? { doc: entry.doc } : null), params, ...(kind === 'preset' ? { alsoTakes: tg.common.filter((k) => k !== 'preset') } : { alsoTakes: tg.nodeKeys }),
    example: kind === 'preset' ? { preset: name } : { op: name } };
}

function checkProcedural(ctx, value, path) {
  const proc = SCHEMA.procedural;
  if (!isObj(value)) { ctx.add('error', 'bad_type', path, '`procedural` is { "pattern": "wood", …params }', { name: 'procedural' }); return; }
  const names = Object.keys(proc.patterns);
  if (!names.includes(value.pattern)) {
    ctx.add('error', 'bad_value', join(path, 'pattern'), `unknown pattern "${value.pattern}"; it takes ${names.join(', ')}`,
      { name: 'pattern', value: value.pattern, allowed: names, didYouMean: didYouMean(String(value.pattern), names) });
    return;
  }
  const params = proc.patterns[value.pattern].params;
  for (const [k, v] of Object.entries(value)) {
    if (proc.shared[k]) check(ctx, v, proc.shared[k], join(path, k), k);
    else if (params[k]) check(ctx, v, params[k], join(path, k), k);
    else {
      const known = [...Object.keys(proc.shared), ...Object.keys(params)];
      const hint = didYouMean(k, known);
      ctx.add('error', 'unknown_field', join(path, k), `the ${value.pattern} pattern has no \`${k}\`, so it is ignored${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`,
        { name: k, didYouMean: hint, allowed: known.sort() });
    }
  }
}

/** (bugsB) A recipe's number given as text or true/false: the recipe computes with it, so its sim moves nothing or fails to build. A list (a
 *  range, one per axis) and a keyed value are the recipe's own business. */
function checkRecipeValue(ctx, recipe, k, v, def, path) {
  if (isNum(def) && (typeof v === 'string' || typeof v === 'boolean' || v === null)) {
    ctx.add('error', 'bad_type', path, `recipe ${recipe}'s \`${k}\` is a number (default ${JSON.stringify(def)}), not ${String(JSON.stringify(v)).slice(0, 60)}`,
      { name: k, expected: ['number'], value: short(v) });
  }
}

function checkSim(ctx, value, path) {
  const sims = SCHEMA.sims;
  if (!isObj(value)) { ctx.add('error', 'bad_type', path, 'a sim is { "recipe": name, …params } or a sim/1 graph', { name: 'sim' }); return; }
  if ('recipe' in value && value.schema !== 'sim/1') {
    const recipes = sims.recipes;
    if (!recipes[value.recipe]) {
      ctx.add('error', 'bad_value', join(path, 'recipe'), `unknown recipe "${value.recipe}"`, { name: 'recipe', value: value.recipe, allowed: Object.keys(recipes).sort(), didYouMean: didYouMean(String(value.recipe), Object.keys(recipes)) });
      return;
    }
    const params = recipes[value.recipe].params;
    for (const k of Object.keys(value)) {
      if (k in params && !sims.recipeKeys.includes(k)) checkRecipeValue(ctx, value.recipe, k, value[k], params[k], join(path, k));
      if (sims.recipeKeys.includes(k) || k in params) continue;
      const hint = didYouMean(k, Object.keys(params));
      ctx.add('error', 'recipe_param', join(path, k), `recipe ${value.recipe} has no \`${k}\` (the scene fails to build)${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`,
        { name: k, didYouMean: hint, allowed: Object.keys(params).sort() });
    }
    return;
  }
  if (value.schema !== 'sim/1') ctx.add('error', 'bad_value', join(path, 'schema'), 'a sim graph has "schema": "sim/1" (or name a `recipe`)', { name: 'schema', value: value.schema });
  for (const k of Object.keys(value)) {
    if (!sims.topKeys.includes(k)) {
      const hint = didYouMean(k, sims.topKeys);
      ctx.add('error', 'unknown_field', join(path, k), `a sim graph has no \`${k}\`${hint.length ? `: did you mean \`${hint[0]}\`?` : ''}`, { name: k, didYouMean: hint, allowed: sims.topKeys });
    }
  }
  (Array.isArray(value.ops) ? value.ops : []).forEach((op, i) => {
    if (isObj(op) && !sims.ops.includes(op.op)) ctx.add('error', 'unknown_op', join(join(join(path, 'ops'), i), 'op'), `unknown sim op "${op.op}"`, { name: op.op, didYouMean: didYouMean(String(op.op), sims.ops) });
  });
}

function checkMedia(ctx, value, path) {
  if (!value || !ctx.mediaExists || value.startsWith('tex:') || value.startsWith('data:')) return;
  if (ctx.mediaExists(value) === false && !ctx.mediaSeen.has(value)) {
    ctx.mediaSeen.add(value);
    ctx.add('error', 'missing_file', path, `no file at ${value}: the scene fails to build or shows nothing there`, { value });
  }
}

// ── references across the scene ────────────────────────────────────────────────────────────────────────────────────────

const LINK_FIELDS = ['lights', 'excludes', 'shadowFrom', 'shadowExcludes'];
const LINK_SLOTS = 15;

function checkRefs(ctx, scene, path, extraMaterials = []) {
  const objects = Array.isArray(scene.objects) ? scene.objects : [];
  const matNames = new Set([...Object.keys(isObj(scene.materials) ? scene.materials : {}), ...extraMaterials]);
  const ids = new Map();
  objects.forEach((o, i) => {
    if (!isObj(o)) return;
    const op = join(join(path, 'objects'), i);
    if (o.id == null) ctx.add('error', 'missing_required', op, 'every object needs an `id` (the scene fails to build)', { name: 'id' });
    else if (ids.has(o.id)) ctx.add('error', 'duplicate_id', join(op, 'id'), `two objects are called "${o.id}" (the scene fails to build)`, { name: o.id });
    else ids.set(o.id, o);
  });
  const objectIds = new Set(ids.keys());
  objects.forEach((o, i) => {
    if (!isObj(o)) return;
    const op = join(join(path, 'objects'), i);
    if (typeof o.material === 'string' && !matNames.has(o.material)) {
      ctx.add('error', 'unknown_ref', join(op, 'material'), `material "${o.material}" is not defined, so object "${o.id}" renders grey`, { name: o.material, didYouMean: didYouMean(o.material, [...matNames].sort()) });
    }
    (Array.isArray(o.materials) ? o.materials : []).forEach((slot, si) => {
      if (typeof slot === 'string' && !matNames.has(slot)) ctx.add('error', 'unknown_ref', join(join(op, 'materials'), si), `material "${slot}" is not defined, so that slot renders grey`, { name: slot, didYouMean: didYouMean(slot, [...matNames].sort()) });
    });
    if (o.parent != null && !objectIds.has(o.parent)) {
      ctx.add('error', 'unknown_ref', join(op, 'parent'), `parent "${o.parent}" does not exist, so "${o.id}" sits at the root`, { name: o.parent, didYouMean: didYouMean(String(o.parent), [...objectIds].sort()) });
    }
    if (Array.isArray(o.graph)) {
      const sub = makeCtx();
      checkGraph(sub, o.graph, join(op, 'graph'), objectIds);
      ctx.issues.push(...sub.issues.filter((x) => x.code === 'unknown_ref' && String(x.name || '').startsWith('@')));
    }
  });
  const seen = new Set();
  (Array.isArray(scene.lights) ? scene.lights : []).forEach((l, i) => {
    if (isObj(l) && l.id != null) {
      if (seen.has(l.id)) ctx.add('warning', 'duplicate_id', join(join(join(path, 'lights'), i), 'id'), `two lights are called "${l.id}": keys and reports mix them up`, { name: l.id });
      seen.add(l.id);
    }
  });
  // light and shadow linking: every tag a light names is some object's (a typo would light nothing, or shadow nothing), and only the
  // first LINK_SLOTS linked lights link
  const tags = new Set();
  for (const o of objects) if (isObj(o) && Array.isArray(o.tags)) for (const t of o.tags) if (typeof t === 'string') tags.add(t);
  let linked = 0;
  (Array.isArray(scene.lights) ? scene.lights : []).forEach((l, i) => {
    if (!isObj(l)) return;
    const lp = join(join(path, 'lights'), i);
    // an object a light follows, aims at, puts a highlight on or is sized to
    const named = [['at', l.at], ['target', l.target], ['highlight.object', isObj(l.highlight) ? l.highlight.object : null], ['subject', l.subject]];
    for (const [k, v] of named) {
      const id = typeof v === 'string' ? (k === 'subject' ? v.replace(/^@/, '') : v.startsWith('@') ? v.slice(1) : null) : isObj(v) ? v.object : null;
      if (typeof id === 'string' && !objectIds.has(id)) {
        ctx.add('error', 'unknown_ref', `${lp}.${k}`, `no object "${id}": the light stands where it was written`, { name: id, didYouMean: didYouMean(id, [...objectIds].sort()) });
      }
    }
    const fields = LINK_FIELDS.filter((k) => Array.isArray(l[k]));
    if (!fields.length) return;
    linked += 1;
    if (linked > LINK_SLOTS) {
      ctx.add('warning', 'ignored_field', join(lp, fields[0]), `only the first ${LINK_SLOTS} lights with link fields link: "${l.id}" lights every object and every object shadows it`, { name: fields[0] });
    }
    for (const k of fields) {
      l[k].forEach((t, ti) => {
        if (typeof t === 'string' && !tags.has(t)) {
          ctx.add('error', 'unknown_ref', join(join(lp, k), ti), `no object has the tag "${t}": give the objects it means \`tags\``, { name: t, didYouMean: didYouMean(t, [...tags].sort()) });
        }
      });
    }
  });
  // (animtools) clocks, drives, ƒx and paths
  checkMotion(ctx, scene, path);
  const cam = isObj(scene.camera) ? scene.camera : {};
  checkCameraAim(ctx, cam, join(path, 'camera'));
  const f = cam.focus;
  const target = typeof f === 'string' && f.startsWith('@') ? f.slice(1) : isObj(f) ? f.object : null;
  if (target != null && !objectIds.has(target)) {
    ctx.add('error', 'unknown_ref', join(join(path, 'camera'), 'focus'), `focus names object "${target}", which does not exist`, { name: target, didYouMean: didYouMean(String(target), [...objectIds].sort()) });
  }
}

/** (bugsB) A camera standing on its own target looks nowhere: the shot has no direction (a black or a random frame). At rest, and at every
 *  key of `at` against a resting `target` (and the other way round). */
function checkCameraAim(ctx, cam, path) {
  const same = (a, b) => isVec(a, 3) && isVec(b, 3) && a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0) < 1e-12;
  const msg = 'the camera stands on its own target, so it looks nowhere: move `at` or `target` apart';
  if (same(cam.at, cam.target)) ctx.add('error', 'bad_value', join(path, 'target'), msg, { name: 'target', value: cam.target });
  const keys = isObj(cam.keys) ? cam.keys : {};
  for (const [track, other] of [['at', cam.target], ['target', cam.at]]) {
    if (!Array.isArray(keys[track]) || Array.isArray(keys[track === 'at' ? 'target' : 'at'])) continue;
    keys[track].forEach((key, i) => {
      if (isObj(key) && same(key.v, other)) ctx.add('error', 'bad_value', join(join(join(join(path, 'keys'), track), i), 'v'), msg, { name: track, value: key.v });
    });
  }
}

// ── entry points ───────────────────────────────────────────────────────────────────────────────────────────────────────

const summary = (issues) => {
  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: !errors.length, errors, warnings: issues.filter((i) => i.severity !== 'error') };
};

/** Every problem in a Scene layer's `rig`. `only` 'scene' or 'render' checks just that part (the value is then that part). */
export function validateRig(rig, { path = 'rig', mediaExists = null, extraMaterials = [], only = null } = {}) {
  const ctx = makeCtx(mediaExists);
  const root = SCHEMA.roots.rig;
  if (only === 'scene') {
    if (!isObj(rig)) ctx.add('error', 'bad_type', path, '`scene` is an object');
    else { check(ctx, rig, root.fields.scene, path, 'scene'); checkRefs(ctx, rig, path, extraMaterials); }
    return summary(ctx.issues);
  }
  if (only === 'render') { check(ctx, rig, root.fields.render, path, 'render'); return summary(ctx.issues); }
  if (!isObj(rig)) { ctx.add('error', 'bad_type', path, '`rig` is an object'); return summary(ctx.issues); }
  check(ctx, rig, root, path, 'rig');
  if (isObj(rig.scene)) checkRefs(ctx, rig.scene, join(path, 'scene'), extraMaterials);
  checkEnvStrength(ctx, rig, path);
  return summary(ctx.issues);
}

/** (enginebugs) A Rig environment strength the Scene's own replaces with another value does nothing (envStrength.js). */
function checkEnvStrength(ctx, rig, path) {
  const message = envStrengthShadowed(rig);
  if (message) ctx.add('warning', 'unused', join(join(path, 'env'), 'intensity'), message, { name: 'intensity' });
}

/** [path, item] for every item with a `rig` in a project's data, sequences included. */
export function* rigItems(data) {
  if (!isObj(data)) return;
  for (const [ci, ch] of (data.channels || []).entries()) {
    if (!isObj(ch)) continue;
    for (const [ii, it] of (ch.items || []).entries()) if (isObj(it) && isObj(it.rig)) yield [`channels[${ci}].items[${ii}]`, it];
  }
  for (const [k, clip] of (data.clips || []).entries()) {
    const seq = isObj(clip) ? clip.sequence : null;
    if (isObj(seq)) for (const [p, it] of rigItems(seq)) yield [`clips[${k}].sequence.${p}`, it];
  }
}

/** (animtools) [path, item] for every top-level item that rides a Scene object (`worldParent`). */
export function* parentedItems(data) {
  if (!isObj(data)) return;
  for (const [ci, ch] of (data.channels || []).entries()) {
    if (!isObj(ch)) continue;
    for (const [ii, it] of (ch.items || []).entries()) if (isObj(it) && typeof it.worldParent === 'string' && it.worldParent) yield [`channels[${ci}].items[${ii}]`, it];
  }
}

/** [path, item] for every item whose `model3dConfig` has a `pose`, sequences included. */
export function* poseItems(data) {
  if (!isObj(data)) return;
  for (const [ci, ch] of (data.channels || []).entries()) {
    if (!isObj(ch)) continue;
    for (const [ii, it] of (ch.items || []).entries()) if (isObj(it) && isObj(it.model3dConfig) && it.model3dConfig.pose !== undefined) yield [`channels[${ci}].items[${ii}]`, it];
  }
  for (const [k, clip] of (data.clips || []).entries()) {
    const seq = isObj(clip) ? clip.sequence : null;
    if (isObj(seq)) for (const [p, it] of poseItems(seq)) yield [`clips[${k}].sequence.${p}`, it];
  }
}

/** (pose) Every problem in a model layer's `model3dConfig.pose`: the schema's fields, then what each control needs to name. `schema: false`
 *  skips the fields (a Scene object's pose, whose fields the Scene's own check has read). */
export function validatePose(pose, { path = 'model3dConfig.pose', sceneIds = null, schema = true } = {}) {
  const ctx = makeCtx(null);
  if (schema) check(ctx, pose, SCHEMA.roots.pose, path, 'pose');
  if (isObj(pose)) {
    const order = ['clips', 'morphs', 'bones', 'constraints', 'world'];
    if (Array.isArray(pose.order) && pose.order.join() !== order.join()) ctx.add('warning', 'bad_value', join(path, 'order'), `the pose's order is always ${order.join(', ')}; this one is ignored`, { name: 'order', allowed: order });
    const parts = [[pose, path], ...(Array.isArray(pose.layers) ? pose.layers.map((L, i) => [L, join(join(path, 'layers'), i)]) : [])];
    for (const [L, lp] of parts) {
      if (!isObj(L)) continue;
      (Array.isArray(L.clips) ? L.clips : []).forEach((c, i) => { if (isObj(c) && typeof c.clip !== 'string') ctx.add('error', 'missing_required', join(join(lp, 'clips'), i), 'a clip needs `clip`, the animation\'s name', { name: 'clip' }); });
      (Array.isArray(L.constraints) ? L.constraints : []).forEach((c, i) => {
        if (!isObj(c)) return;
        const cp = join(join(lp, 'constraints'), i);
        if (typeof c.bone !== 'string') ctx.add('error', 'missing_required', cp, `a ${c.type || 'constraint'} needs \`bone\``, { name: 'bone' });
        if (c.type === 'attach' && typeof c.object !== 'string') ctx.add('error', 'missing_required', cp, 'attach needs `object`, a Scene object\'s id', { name: 'object' });
        if (['lookAt', 'ik', 'parent'].includes(c.type) && c.target === undefined && !c.keys?.target) ctx.add('error', 'missing_required', cp, `${c.type} needs \`target\``, { name: 'target' });
        if (c.type === 'path' && !(Array.isArray(c.path) && c.path.length >= 2)) ctx.add('error', 'missing_required', cp, 'path needs `path`, two points or more', { name: 'path' });
        // a Scene object a constraint names must be in the project's Scene
        if (sceneIds) for (const ref of [c.target, c.pole, c.object, ...(Array.isArray(c.path) ? c.path : [])]) {
          if (typeof ref !== 'string') continue;
          const id = ref.replace(/^@/, '');
          if (!sceneIds.has(id)) ctx.add('error', 'unknown_ref', cp, `names Scene object "${id}", which does not exist`, { name: id, didYouMean: didYouMean(id, [...sceneIds].sort()) });
        }
      });
    }
  }
  return summary(ctx.issues);
}

/** [path, item] for every item whose `model3dConfig` has a `skeleton`, sequences included. */
export function* skeletonItems(data) {
  if (!isObj(data)) return;
  for (const [ci, ch] of (data.channels || []).entries()) {
    if (!isObj(ch)) continue;
    for (const [ii, it] of (ch.items || []).entries()) if (isObj(it) && isObj(it.model3dConfig) && it.model3dConfig.skeleton !== undefined) yield [`channels[${ci}].items[${ii}]`, it];
  }
  for (const [k, clip] of (data.clips || []).entries()) {
    const seq = isObj(clip) ? clip.sequence : null;
    if (isObj(seq)) for (const [p, it] of skeletonItems(seq)) yield [`clips[${k}].sequence.${p}`, it];
  }
}

/** (rigging) Every problem in a `skeleton`: its fields (unless `schema: false`), then the joints its parts name (a parent, a fix, a clip's
 *  tracks) against the template's joints and its own. */
export function validateSkeleton(spec, { path = 'skeleton', schema = true } = {}) {
  const ctx = makeCtx(null);
  if (schema) check(ctx, spec, SCHEMA.roots.skeleton, path, 'skeleton');
  if (isObj(spec)) {
    const names = [...((SCHEMA.lists.skeletonJoints || {})[spec.template] || []), ...(Array.isArray(spec.joints) ? spec.joints.filter(isObj).map((j) => j.name).filter((x) => typeof x === 'string') : [])];
    const known = new Set(names);
    const ref = (name, p, what, severity = 'error') => {
      if (typeof name !== 'string' || known.has(name)) return;
      ctx.add(severity, 'unknown_ref', p, `${what} "${name}" is not a joint of this skeleton`, { name, didYouMean: didYouMean(name, [...known].sort()) });
    };
    (Array.isArray(spec.joints) ? spec.joints : []).forEach((j, i) => { if (isObj(j) && j.parent != null) ref(j.parent, join(join(join(path, 'joints'), i), 'parent'), 'parent'); });
    (Array.isArray(spec.fixes) ? spec.fixes : []).forEach((f, i) => {
      if (!isObj(f)) return;
      const fp = join(join(path, 'fixes'), i);
      if (f.joint == null && f.smooth == null) ctx.add('error', 'missing_required', fp, 'a fix needs `joint` (and `value`), or `smooth`', { name: 'joint' });
      ref(f.joint, join(fp, 'joint'), 'joint');
      ref(f.of, join(fp, 'of'), 'of');
    });
    (Array.isArray(spec.clips) ? spec.clips : []).forEach((c, i) => {
      if (isObj(c) && isObj(c.bones)) for (const b of Object.keys(c.bones)) ref(b, join(join(join(join(path, 'clips'), i), 'bones'), b), 'track for', 'warning');
    });
    if (spec.template == null && !(Array.isArray(spec.joints) && spec.joints.length)) ctx.add('error', 'missing_required', path, 'a skeleton needs a `template` or `joints`', { name: 'template' });
  }
  return summary(ctx.issues);
}

/** (camlayer) [path, item] for every item on the project's camera channel (`kind: "camera"`). backend/world3d_schema.py camera_items */
export function* cameraItems(data) {
  if (!isObj(data)) return;
  for (const [ci, ch] of (data.channels || []).entries()) {
    if (!isObj(ch) || ch.kind !== 'camera') continue;
    for (const [ii, it] of (ch.items || []).entries()) if (isObj(it)) yield [`channels[${ci}].items[${ii}]`, it];
  }
}

/** (camlayer) [where, ref] for every target a camera item names: look-at, focus, a path's aim, a rig's centre and follow list, a zoom's. */
function* cameraRefs(item) {
  for (const k of ['cameraLookAt', 'cameraFocusOn']) if (item[k] !== undefined && item[k] !== null) yield [k, item[k]];
  const path = isObj(item.cameraPath) ? item.cameraPath : {};
  if (path.targetId) yield ['cameraPath.targetId', path.targetId];
  const rig = isObj(item.cameraRig) ? item.cameraRig : {};
  if (rig.center !== undefined && rig.center !== null) yield ['cameraRig.center', rig.center];
  for (const [i, t] of (Array.isArray(rig.targets) ? rig.targets : []).entries()) yield [`cameraRig.targets[${i}]`, t];
  const ranges = isObj(item.smartZoom) && Array.isArray(item.smartZoom.ranges) ? item.smartZoom.ranges : [];
  for (const [i, r] of ranges.entries()) if (isObj(r) && r.target !== undefined && r.target !== null) yield [`smartZoom.ranges[${i}].target`, r.target];
}

/** (camlayer) The Camera layer over a Scene: the Scene objects it names ("@<id>") exist, a rig or a path has a progress track to carry it,
 *  a path's anchors carry their handles; and a Scene that films from its own camera is named. backend/world3d_schema.py _check_camera_items */
function checkCameraItems(data, sceneIds, scenesWithCamera) {
  const issues = [];
  const itemIds = new Set();
  for (const ch of Array.isArray(data?.channels) ? data.channels : []) for (const it of isObj(ch) && Array.isArray(ch.items) ? ch.items : []) if (isObj(it)) itemIds.add(String(it.id));
  for (const [p, item] of cameraItems(data)) {
    for (const [where, ref] of cameraRefs(item)) {
      if (typeof ref === 'string' && ref.startsWith('@')) {
        const oid = ref.slice(1);
        if (sceneIds.size && !sceneIds.has(oid)) {
          const hint = didYouMean(oid, [...sceneIds].sort());
          issues.push({ path: `${p}.${where}`, code: 'unknown_ref', severity: 'error', name: ref, item: item.id,
            message: `no Scene object "${oid}": the camera aims at the comp centre (the world's origin) instead`, ...(hint.length ? { didYouMean: hint.map((h) => `@${h}`) } : {}) });
        }
      } else if (typeof ref === 'string' && ref && !itemIds.has(ref)) {
        issues.push({ path: `${p}.${where}`, code: 'unknown_ref', severity: 'warning', name: ref, item: item.id,
          message: `no timeline item "${ref}" (a Scene object is written "@<id>"): the camera aims at the comp centre instead` });
      } else if (!(typeof ref === 'string' || isObj(ref)) || (isObj(ref) && !['x', 'y', 'z'].every((k) => isNum(ref[k])))) {
        issues.push({ path: `${p}.${where}`, code: 'bad_value', severity: 'error', item: item.id,
          message: 'a camera target is "@<Scene object id>", a timeline item id, or a point { x, y, z } in world px (1000 a metre)' });
      }
    }
    const mode = item.cameraMoveMode;
    const path = isObj(item.cameraPath) ? item.cameraPath : null;
    const pts = Array.isArray(path?.points) ? path.points : [];
    const live = !!(path && path.follow && pts.length >= (path.aim === 'captured' ? 1 : 2));
    const keys = isObj(item.propertyKeyframes) && Array.isArray(item.propertyKeyframes.camPathT) ? item.propertyKeyframes.camPathT : [];
    const moving = mode === 'rig' || ((mode === 'path' || mode === undefined || mode === null) && live);
    const held = !!(path && path.aim === 'captured' && pts.length === 1);
    if (moving && !held && keys.filter(isObj).length < 2) {
      issues.push({ path: `${p}.propertyKeyframes.camPathT`, code: 'frozen_move', severity: 'warning', item: item.id,
        message: `a ${mode === 'rig' ? 'rig' : 'path'} moves the camera only through camPathT keys (0 to 100): without two it stands still` });
    }
    if (path && (mode === 'path' || mode === undefined || mode === null)) {
      const bare = pts.map((pt, i) => [pt, i]).filter(([pt]) => isObj(pt) && !(pt.hIn && pt.hOut)).map(([, i]) => i);
      if (bare.length && pts.length > 2) {
        issues.push({ path: `${p}.cameraPath.points`, code: 'corner', severity: 'warning', item: item.id,
          message: `anchors [${bare.slice(0, 6).join(', ')}] have no handles (hIn, hOut): the camera turns a sharp corner there; write both handles and manual: true` });
      }
    }
  }
  for (const p of scenesWithCamera) {
    issues.push({ path: `${p}.rig.scene.camera`, code: 'scene_camera', severity: 'warning',
      message: "the Scene films from its own camera, which the editor's Camera layer cannot show or edit (its keys, path, rig and zoom have no say). Film it with the Camera layer (POST /api/world3d/camera-layer turns this camera into one) unless the shot needs what only scene.camera has: an orthographic or fisheye projection, lens shift, tilt-shift, auto exposure and the camera-device fields." });
  }
  return issues;
}

export function validateProject(data, { mediaExists = null } = {}) {
  const issues = [];
  let scenes = 0;
  const sceneIds = new Set();
  for (const [p, item] of rigItems(data)) {
    scenes += 1;
    const r = validateRig(item.rig, { path: `${p}.rig`, mediaExists });
    for (const i of [...r.errors, ...r.warnings]) { if (i.item === undefined) i.item = item.id; issues.push(i); }
    for (const o of Array.isArray(item.rig?.scene?.objects) ? item.rig.scene.objects : []) if (isObj(o) && o.id != null) sceneIds.add(String(o.id));
  }
  // (rigging) a Scene object's skeleton and pose: their fields were read with the Scene, what they name is checked here
  let skeletons = 0;
  for (const [p, item] of rigItems(data)) {
    (Array.isArray(item.rig?.scene?.objects) ? item.rig.scene.objects : []).forEach((o, k) => {
      if (!isObj(o)) return;
      const op = `${p}.rig.scene.objects[${k}]`;
      const found = [];
      if (o.skeleton !== undefined) { skeletons += 1; const r = validateSkeleton(o.skeleton, { path: `${op}.skeleton`, schema: false }); found.push(...r.errors, ...r.warnings); }
      if (o.pose !== undefined) {
        const r = validatePose(o.pose, { path: `${op}.pose`, sceneIds, schema: false });
        found.push(...r.errors, ...r.warnings);
        if (o.skeleton === undefined && o.model === undefined) found.push({ path: `${op}.pose`, code: 'unused', severity: 'warning', message: 'a pose moves joints: give the object a `skeleton`' });
      }
      for (const i of found) { if (i.item === undefined) i.item = item.id; issues.push(i); }
    });
  }
  for (const [p, item] of skeletonItems(data)) {
    skeletons += 1;
    const r = validateSkeleton(item.model3dConfig.skeleton, { path: `${p}.model3dConfig.skeleton` });
    for (const i of [...r.errors, ...r.warnings]) { if (i.item === undefined) i.item = item.id; issues.push(i); }
  }
  // (animtools) a layer riding a Scene object (`worldParent`): the object is in the project's Scene, and the layer stands in the world
  for (const [p, item] of parentedItems(data)) {
    const id = String(item.worldParent);
    if (!sceneIds.has(id)) issues.push({ path: `${p}.worldParent`, code: 'unknown_ref', severity: 'error', message: `no Scene object "${id}": the layer stands where its own transform puts it`, name: id, ...(didYouMean(id, [...sceneIds].sort()).length ? { didYouMean: didYouMean(id, [...sceneIds].sort()) } : {}), item: item.id });
  }
  // (camlayer) the Camera layer over the Scene, and a Scene that films from its own camera
  issues.push(...checkCameraItems(data, sceneIds, [...rigItems(data)].filter(([, item]) => isObj(item.rig?.scene) && isObj(item.rig.scene.camera)).map(([p]) => p)));
  // (pose) every model layer's pose
  let poses = 0;
  for (const [p, item] of poseItems(data)) {
    poses += 1;
    const r = validatePose(item.model3dConfig.pose, { path: `${p}.model3dConfig.pose`, sceneIds });
    for (const i of [...r.errors, ...r.warnings]) { if (i.item === undefined) i.item = item.id; issues.push(i); }
  }
  return { ...summary(issues), scenes, ...(poses ? { poses } : {}), ...(skeletons ? { skeletons } : {}) };
}

// ── help for one field ─────────────────────────────────────────────────────────────────────────────────────────────────

const strip = (spec) => {
  const out = {};
  for (const k of ['type', 'doc', 'default', 'min', 'max', 'values', 'example', 'related', 'keyable', 'ignored', 'removed', 'internal', 'required']) if (k in spec) out[k] = spec[k];
  if (spec.valuesFrom) out.values = SCHEMA.lists[spec.valuesFrom];
  return out;
};

function children(spec) {
  if (spec.variants) {
    const v = spec.variants;
    const out = { ...v.common };
    for (const [caseName, kase] of Object.entries(v.cases)) {
      const fields = kase === 'placed' ? v.placed : kase;
      for (const [k, s] of Object.entries(fields || {})) {
        if (s.ignored && out[k]) continue;
        out[k] ||= { ...s, _types: [] };
        out[k]._types ||= [];
        if ((!s.only || s.only.includes(caseName)) && !s.ignored) out[k]._types = [...new Set([...out[k]._types, caseName])].sort();
      }
    }
    return out;
  }
  return spec.fields || {};
}

export function fieldHelp({ path = null, op = null, q = null } = {}) {
  if (op) { const [name, param] = String(op).split('.'); return opHelp(name, param || null); }
  if (q) return search(String(q));
  if (!path) return { error: 'give `path` (scene.materials.*.transmission), `op` (bevel or bevel.width) or `q` (a word)' };
  let tokens = String(path).split(/\.|\[|\]/).filter(Boolean);
  if (tokens[0] === 'rig') tokens = tokens.slice(1);
  // (pose) a model layer's pose: model3dConfig.pose.<...>
  if (tokens[0] === 'model3dConfig') tokens = tokens.slice(1);
  const poseRoot = tokens[0] === 'pose';
  // (rigging) model3dConfig.skeleton.<...> (a Scene object's skeleton is under rig.scene.objects.*.skeleton)
  const skeletonRoot = tokens[0] === 'skeleton' && !!SCHEMA.roots.skeleton;
  if (poseRoot || skeletonRoot) tokens = tokens.slice(1);
  if (['op', 'ops'].includes(tokens[0])) return opHelp(tokens[1] || '', tokens[2] || null);
  if (tokens[0] === 'procedural') return procHelp(tokens.slice(1));
  if (['sims', 'recipe', 'recipes'].includes(tokens[0])) return simHelp(tokens.slice(1));
  if (tokens[0] === 'scene' && tokens[1] === 'sims') return simHelp(tokens.slice(2).filter((t) => t !== '*' && !/^\d+$/.test(t)));
  let spec = poseRoot ? SCHEMA.roots.pose : skeletonRoot ? SCHEMA.roots.skeleton : SCHEMA.roots.rig;
  const walked = [poseRoot ? 'model3dConfig.pose' : skeletonRoot ? 'model3dConfig.skeleton' : 'rig'];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    const types = typesOf(spec);
    if (spec.ref === 'procedural') return procHelp(tokens.slice(i));
    // a texture graph's preset or node by name: its fields from the engine's tables (graph.wornPlanks, graph.voronoi.scale)
    if (spec.ref === 'textureGraph' && SCHEMA.textureGraph && !Object.prototype.hasOwnProperty.call(children(spec), tok)) return texGraphHelp(tokens.slice(i));
    if (types.includes('map') && spec.of) { spec = spec.of; walked.push('*'); continue; }
    if (types.includes('array') && spec.items && (tok === '*' || /^\d+$/.test(tok))) { spec = spec.items; walked.push('*'); continue; }
    if (spec.type === 'node' || spec.items?.type === 'node') {
      const rest = tok === '*' || /^\d+$/.test(tok) ? tokens.slice(i + 1) : tokens.slice(i);
      return opHelp(rest[0] || '', rest[1] || null);
    }
    const kids = children(spec);
    if (Object.prototype.hasOwnProperty.call(kids, tok)) { spec = kids[tok]; walked.push(tok); continue; }
    const offered = live(kids);
    return { error: `no field \`${tok}\` under ${walked.join('.')}`, didYouMean: didYouMean(tok, offered, spec.aliases || null), fields: offered };
  }
  const out = { path: walked.join('.'), ...strip(spec) };
  if (spec._types) out.lightTypes = spec._types;
  const kids = children(spec);
  const listed = Object.entries(kids).filter(([, v]) => isObj(v) && !v.internal && !v.removed);
  if (listed.length) out.fields = Object.fromEntries(listed.map(([k, v]) => [k, String(v.doc || '').slice(0, 120)]));
  // names that do NOT work here (three.js and Blender habits), each with the field that does — never one that is a field here (a
  // sun's `size` is real, though an area light's `size` means `width`)
  const wrong = Object.entries(spec.aliases || {}).filter(([k]) => !Object.prototype.hasOwnProperty.call(kids, k));
  if (wrong.length) out.wrongNames = Object.fromEntries(wrong);
  if (!('example' in out) && 'default' in out) out.example = out.default;
  return out;
}

function opHelp(name, param) {
  const ops = SCHEMA.ops;
  if (!ops[name]) return { error: `unknown op "${name}"`, didYouMean: didYouMean(name, Object.keys(ops)), ops: Object.keys(ops).sort() };
  const spec = ops[name];
  const params = spec.params || {};
  const pick = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => ['type', 'default', 'required', 'requiredOneOf', 'doc', 'values', 'min', 'max'].includes(k)));
  if (param) {
    if (!params[param]) return { error: `${name} has no parameter \`${param}\``, didYouMean: didYouMean(param, Object.keys(params)), params: Object.keys(params).sort() };
    return { op: name, param, ...pick(params[param]), opDoc: spec.doc, related: Object.keys(params).filter((k) => k !== param).sort().slice(0, 12), example: { op: name, [param]: params[param].default ?? '…' } };
  }
  const example = { op: name };
  for (const [k, p] of Object.entries(params)) if (p.required) example[k] = p.default ?? '…';
  for (const p of Object.values(params)) if (p.requiredOneOf && !p.requiredOneOf.some((k) => k in example)) example[p.requiredOneOf[0]] = '…';
  return { op: name, inputs: { 0: 'a source: no input', 1: 'the node before it (or `in`)', n: 'several: set `in`', any: 'any' }[spec.inputs] ?? spec.inputs,
    doc: spec.doc, open: !!spec.open, params: Object.fromEntries(Object.entries(params).sort().map(([k, p]) => [k, pick(p)])), example };
}

function procHelp(tokens) {
  const proc = SCHEMA.procedural;
  if (!tokens.length) return { path: 'procedural', doc: proc.doc, example: proc.example, shared: Object.fromEntries(Object.entries(proc.shared).map(([k, v]) => [k, v.doc])), patterns: Object.fromEntries(Object.entries(proc.patterns).map(([k, v]) => [k, v.doc])) };
  const tok = tokens[0];
  if (proc.shared[tok]) return { path: `procedural.${tok}`, ...strip(proc.shared[tok]) };
  if (proc.patterns[tok]) {
    const pat = proc.patterns[tok];
    if (tokens[1]) {
      const p = pat.params[tokens[1]] || proc.shared[tokens[1]];
      if (!p) return { error: `the ${tok} pattern has no \`${tokens[1]}\``, didYouMean: didYouMean(tokens[1], [...Object.keys(pat.params), ...Object.keys(proc.shared)]) };
      return { path: `procedural.${tok}.${tokens[1]}`, ...strip(p) };
    }
    return { path: `procedural.${tok}`, doc: pat.doc, unit: pat.unit, colorRoles: pat.colorRoles, defaults: pat.defaults, params: Object.fromEntries(Object.entries(pat.params).map(([k, v]) => [k, strip(v)])), example: { pattern: tok } };
  }
  return { error: `no pattern or field \`${tok}\``, didYouMean: didYouMean(tok, [...Object.keys(proc.patterns), ...Object.keys(proc.shared)]) };
}

function simHelp(tokens) {
  const sims = SCHEMA.sims;
  const recipes = sims.recipes;
  if (!tokens.length) {
    return { path: 'rig.scene.sims', doc: `Simulations: { "recipe": name, …params } or a sim/1 graph (sim.md). Every recipe also takes ${sims.recipeKeys.join(', ')}.`,
      recipes: Object.fromEntries(Object.entries(recipes).map(([k, v]) => [k, v.doc])), graphKeys: sims.topKeys, graphOps: sims.ops, example: { recipe: 'campfire', at: [0, 0, 0], size: 0.3 } };
  }
  const name = tokens[0];
  if (!recipes[name]) return { error: `no recipe \`${name}\``, didYouMean: didYouMean(name, Object.keys(recipes)), recipes: Object.keys(recipes).sort() };
  const r = recipes[name];
  if (tokens[1]) {
    if (!(tokens[1] in r.params)) return { error: `recipe ${name} has no \`${tokens[1]}\``, didYouMean: didYouMean(tokens[1], Object.keys(r.params)), params: Object.keys(r.params).sort() };
    return { path: `rig.scene.sims.*.${name}.${tokens[1]}`, recipe: name, param: tokens[1], default: r.params[tokens[1]], recipeDoc: r.doc };
  }
  return { path: `rig.scene.sims.*.${name}`, recipe: name, doc: r.doc, params: r.params, alsoTakes: sims.recipeKeys, example: { recipe: name } };
}

// Every field of that name, the ops of that name, and (a word such as "glass", 3 letters or more) the fields and ops whose
// doc mentions it — the same answer as backend/world3d_schema.py's _search.
function search(q) {
  const hits = [];
  const mentions = [];
  const names = new Set();
  const low = q.toLowerCase();
  const word = low.length >= 3;
  const walk = (spec, p) => {
    if (!isObj(spec)) return;
    for (const [k, v] of Object.entries(children(spec))) {
      if (!isObj(v)) continue;
      names.add(k);
      if (k.toLowerCase() === low) hits.push({ path: `${p}.${k}`, ...Object.fromEntries(Object.entries(strip(v)).filter(([kk]) => ['type', 'doc', 'default', 'min', 'max'].includes(kk))) });
      else if (word && typeof v.doc === 'string' && v.doc.toLowerCase().includes(low)) mentions.push({ path: `${p}.${k}`, doc: v.doc.slice(0, 200) });
      walk(v, `${p}.${k}`);
    }
    for (const key of ['of', 'items']) if (isObj(spec[key]) && spec[key].type !== 'node') walk(spec[key], `${p}.*`);
  };
  walk(SCHEMA.roots.rig, 'rig');
  const ops = Object.keys(SCHEMA.ops).filter((o) => o.toLowerCase() === low);
  const opMentions = word ? Object.entries(SCHEMA.ops).filter(([o, s]) => o.toLowerCase() !== low && String(s.doc || '').toLowerCase().includes(low)).map(([o]) => o) : [];
  const out = { q, fields: hits, ops };
  if (mentions.length) out.mentionedIn = mentions.slice(0, 15);
  if (opMentions.length) out.opsMentioning = opMentions.slice(0, 15);
  if (!hits.length && !ops.length && !mentions.length && !opMentions.length) out.didYouMean = didYouMean(q, [...names].sort().concat(Object.keys(SCHEMA.ops)));
  return out;
}

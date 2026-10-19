/*
 * GreenLight Motion Engine — a project's template: the options a viewer may change.
 *
 * A project carries them as `project.template`, written by an agent or exported from GLEA:
 *
 *   template: {
 *     title: 'Product teaser',
 *     fields: [
 *       { key: 'title', label: 'Title', type: 'text', default: 'GOLDEN',
 *         targets: [{ itemId: 'it1', path: 'textContent' }] },
 *       { key: 'accent', label: 'Accent', type: 'color', targets: [{ itemId: 'it4', path: 'shapeFillColor' }] },
 *       { key: 'photo', label: 'Product photo', type: 'image',
 *         targets: [{ clipId: 'c2', path: 'url' }, { clipId: 'c2', path: 'proxyUrl' }] },
 *       { key: 'size', label: 'Title size', type: 'number', min: 40, max: 200, step: 1,
 *         targets: [{ itemId: 'it1', path: 'textFontSize' }] },
 *       { key: 'font', label: 'Font', type: 'select', options: [{ value: 'Inter', label: 'Inter' }],
 *         targets: [{ itemId: 'it1', path: 'textFontFamily' }] },
 *     ],
 *     values: { title: 'Launch day' },   // optional: values chosen so far
 *   }
 *
 * A target names an item (`itemId`, found in any channel, nested sequences included), a clip
 * (`clipId`) or the project itself (neither), and a dot `path` inside it. Pure and dependency-free:
 * the page, the CLI and the tests share it.
 */

export const FIELD_TYPES = ['text', 'color', 'image', 'number', 'select', 'toggle'];

/** The fields with the values to show: values first, then each field's default, then what the project holds. */
export function fieldValues(project, template = project?.template, values = template?.values) {
  const out = {};
  for (const field of template?.fields || []) {
    if (values && Object.prototype.hasOwnProperty.call(values, field.key)) out[field.key] = values[field.key];
    else if (field.default !== undefined) out[field.key] = field.default;
    else {
      const first = (field.targets || [])[0];
      out[field.key] = first ? readTarget(project, first) : undefined;
    }
  }
  return out;
}

/** A copy of PROJECT with every field's value written into its targets (unknown keys ignored). */
export function applyTemplateValues(project, values, template = project?.template) {
  if (!project || !template?.fields?.length || !values) return project;
  let next = clone(project);
  for (const field of template.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
    const value = coerce(field, values[field.key]);
    if (value === undefined) continue;
    for (const target of field.targets || []) next = writeTarget(next, target, value);
  }
  next.template = { ...template, values: { ...(template.values || {}), ...values } };
  return next;
}

/** Problems an agent should fix before a viewer sees the page (empty when the template is sound). */
export function checkTemplate(project, template = project?.template) {
  const problems = [];
  const keys = new Set();
  for (const field of template?.fields || []) {
    if (!field.key) problems.push('a field has no key');
    else if (keys.has(field.key)) problems.push(`field "${field.key}" is defined twice`);
    keys.add(field.key);
    if (!FIELD_TYPES.includes(field.type)) problems.push(`field "${field.key}": unknown type "${field.type}"`);
    if (!field.targets?.length) problems.push(`field "${field.key}" changes nothing (no targets)`);
    for (const t of field.targets || []) {
      if (!t.path) problems.push(`field "${field.key}": a target has no path`);
      else if (t.itemId && !findItem(project, t.itemId)) problems.push(`field "${field.key}": no item "${t.itemId}"`);
      else if (t.clipId && !findClip(project, t.clipId)) problems.push(`field "${field.key}": no clip "${t.clipId}"`);
    }
  }
  return problems;
}

function coerce(field, value) {
  if (value === undefined || value === null) return undefined;
  switch (field.type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      const lo = Number.isFinite(field.min) ? field.min : -Infinity;
      const hi = Number.isFinite(field.max) ? field.max : Infinity;
      return Math.min(hi, Math.max(lo, n));
    }
    case 'toggle': return Boolean(value);
    default: return String(value);
  }
}

const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

// items and clips are found at any depth: the top level, then each sequence's (or grid's) own channels and clips
function findItem(project, itemId) {
  const search = (channels, clips) => {
    for (const ch of channels || []) for (const it of ch.items || []) if (it.id === itemId) return it;
    for (const clip of clips || []) {
      const hit = clip?.sequence ? search(clip.sequence.channels, clip.sequence.clips) : null;
      if (hit) return hit;
    }
    return null;
  };
  return search(project.channels, project.clips);
}

function findClip(project, clipId) {
  const search = (clips) => {
    for (const clip of clips || []) {
      if (clip?.id === clipId) return clip;
      const hit = clip?.sequence ? search(clip.sequence.clips) : null;
      if (hit) return hit;
    }
    return null;
  };
  return search(project.clips);
}

function holderFor(project, target) {
  if (target.itemId) return findItem(project, target.itemId);
  if (target.clipId) return findClip(project, target.clipId);
  return project;
}

function readTarget(project, target) {
  let node = holderFor(project, target);
  for (const key of String(target.path || '').split('.')) {
    if (node == null) return undefined;
    node = node[key];
  }
  return node;
}

function writeTarget(project, target, value) {
  const holder = holderFor(project, target);
  if (!holder || !target.path) return project;
  const keys = String(target.path).split('.');
  let node = holder;
  for (const key of keys.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
  return project;
}

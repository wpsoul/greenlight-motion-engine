// Advanced Animations ▸ Presets: the item patch that applies one preset to a text
// layer (one updateItem, so one undo step). Kept out of the modal's file so that file
// exports only its component.
import { build } from './textAnimatorPresets';
import { MAX_ANIMATORS, KF_PREFIX } from './textAnimators';

// The patch that applies a preset to a text item. Replace drops every animator and
// `txa:` track first; Add appends (new ids never collide, names stay unique) and
// keeps the layer's pivot.
export function presetPatch(item, preset, { clipSec, fontPx, duration = null, speed = 1, mode = 'replace' }) {
  const existing = Array.isArray(item?.textAnimators) ? item.textAnimators : [];
  const adding = mode === 'add' && existing.length > 0;
  const used = new Set(adding ? existing.flatMap((a) => [a.aid, ...(a.effects || []).map((e) => e.pid)]) : []);
  const built = build(preset, { clipSec, fontPx, duration, speed, used });
  const pk = { ...(item?.propertyKeyframes || {}) };
  if (!adding) for (const k of Object.keys(pk)) if (k.startsWith(KF_PREFIX)) delete pk[k];
  Object.assign(pk, built.tracks);
  let list = built.animators;
  if (adding) {
    const names = new Set(existing.map((a) => a.name));
    const renamed = built.animators.map((a) => {
      let name = a.name;
      for (let n = 2; names.has(name); n += 1) name = `${a.name} ${n}`;
      names.add(name);
      return { ...a, name };
    });
    list = [...existing, ...renamed].slice(0, MAX_ANIMATORS);
  }
  // A depth preset needs its shared camera (Text Animators ▸ More options ▸ Camera):
  // Replace sets the preset's camera (or puts the layer back on each unit's own); Add
  // turns a shared one on only when the layer has none yet.
  const shared = built.layer.camera && built.layer.camera !== 'unit';
  const camera = {
    textAnimatorCamera: shared ? built.layer.camera : null,
    textAnimatorPerspective: shared && built.layer.perspective > 0 ? built.layer.perspective : null,
  };
  const hasCamera = item?.textAnimatorCamera === 'layer' || item?.textAnimatorCamera === 'project';
  return {
    textAnimators: list,
    propertyKeyframes: pk,
    ...(adding ? null : {
      textAnimatorPivotX: built.layer.pivotX,
      textAnimatorPivotY: built.layer.pivotY,
      ...camera,
    }),
    ...(adding && shared && !hasCamera ? camera : null),
  };
}

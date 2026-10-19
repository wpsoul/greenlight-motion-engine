function cloneJson(value, fallback) {
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned === undefined ? fallback : cloned;
  } catch {
    return fallback;
  }
}

function serializableFields(fields, defaults, keyframable) {
  // `{ type: 'section' }` entries only group the inspector UI. They carry no
  // param, so they must not reach the catalog an agent reads to build
  // motionParams — otherwise it would try to set a key the template ignores.
  return (fields || []).filter((field) => field?.type !== 'section').map((field) => {
    const plain = cloneJson(field, {});
    return {
      ...plain,
      ...(field.showIf && !plain.showIf ? { showIf: true } : {}),
      default: cloneJson(defaults?.[field.key], null),
      keyframable: Boolean(keyframable?.(field)),
    };
  });
}

export function motionTemplateMetadata(template, isKeyframable) {
  const defaultParams = cloneJson(template?.defaultParams || {}, {});
  let defaultDuration = 5;
  try {
    const duration = Number(template?.getDuration?.(defaultParams));
    if (Number.isFinite(duration) && duration > 0) defaultDuration = duration;
  } catch { /* validation reports invalid duration separately */ }
  return {
    schemaVersion: 1,
    kind: 'motion-template',
    id: template.id,
    name: template.name || template.id,
    category: template.category || 'Other',
    color: template.color || null,
    pro: Boolean(template.pro),
    previewTime: Number.isFinite(Number(template.previewTime)) ? Number(template.previewTime) : null,
    thumbnail: typeof template.thumbnail === 'string' ? template.thumbnail : null,
    previewVideo: typeof template.previewVideo === 'string' ? template.previewVideo : null,
    defaultDuration,
    defaultParams,
    fields: serializableFields(
      template.fields,
      defaultParams,
      (field) => isKeyframable?.(template, field),
    ),
  };
}

export function advancedTransitionMetadata(descriptor) {
  return {
    schemaVersion: 1,
    kind: 'advanced-transition',
    id: descriptor.id,
    type: descriptor.type || `local:${descriptor.id}`,
    name: descriptor.name || descriptor.id,
    description: descriptor.description || '',
    category: 'advanced',
    defaultDuration: Number.isFinite(descriptor.defaultDuration) ? descriptor.defaultDuration : 1,
    optionDefaults: cloneJson(descriptor.optionDefaults || {}, {}),
    optionFields: cloneJson(descriptor.optionFields || [], []),
    hasAudio: Boolean(descriptor.audio),
    // 'webgl' | 'webgpu' | null — which renderer this package's shading is
    // written for, or null when it makes no claim. Every project renders on the
    // app-wide Video Editor engine, so this says whether the package can draw in it.
    renderer: descriptor.renderer === 'webgl' || descriptor.renderer === 'webgpu' ? descriptor.renderer : null,
  };
}

export function overlayEffectMetadata(definition, { defaultClip = false } = {}) {
  const params = (definition.params || []).map((param) => ({
    ...cloneJson(param, {}),
    type: param.type || 'number',
    // `static` params are bake-side (they shape an allocation or a baked
    // outline, not a per-frame value), and runEffectChain skips them when it
    // applies keyframe overrides — so reporting them as keyframable here told
    // an agent it could write a track the renderer would never read.
    keyframable: (!param.type || param.type === 'number') && !param.static,
  }));
  return {
    id: definition.id,
    name: definition.name || definition.id,
    group: definition.group || 'Other',
    scopes: Array.isArray(definition.scopes) ? [...definition.scopes] : ['layer', 'adjustment'],
    animated: Boolean(definition.animated),
    // PRO effects preview free and gate at render (Neon Glow) — advertised so
    // agents can warn before building a paywalled composition.
    pro: Boolean(definition.pro),
    defaultMix: 100,
    defaultClip: Boolean(defaultClip),
    params,
    defaultParams: Object.fromEntries(params.map((param) => [param.key, cloneJson(param.default, null)])),
  };
}

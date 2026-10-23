/*
 * The editor's project state: normalizeEditorState (a saved or agent-written project → the shape every
 * player reads, every field sanitized and defaulted) and createEmptyEditorState, with the sanitizers they use.
 * Moved verbatim out of VideoEditor.jsx (2026-10-15) so the headless render page and the GreenLight Motion
 * Engine can normalize a project without loading the editor UI. VideoEditor.jsx imports and re-exports it.
 */
import { normalizeMtimeNs } from "./mediaUrlVersion";
import { ClipSource, TransitionType, TransitionEasing, TransitionOrder, LayerTransitionType, SHAPE_TYPES, TEXT_FONT_SIZE_PX_MIN, TEXT_FONT_SIZE_PX_MAX, TEXT_FONT_SIZE_PCT_MIN, TEXT_FONT_SIZE_PCT_MAX, DEFAULT_TEXT_FONT_SIZE_PX, DEFAULT_TEXT_FONT_SIZE_PCT, DEFAULT_TEXT_FONT_FAMILY, DEFAULT_TEXT_FONT_WEIGHT, textFontSizeUnitOf, MODEL_CONFIG_DEFAULTS, resolveTransitionType, migrateDirectionalTransition, TEXT_BG_REVEAL_TYPES, TEXT_BORDER_STYLES, TEXT_BG_REVEAL_STYLES, TEXT_BG_GROW_APPEAR } from "./types";
import { BLEND_MODES } from "./clipShader";
import { isPrimitiveKind, PRIMITIVE_DEFAULT_COLOR, PRIMITIVE_DEFAULT_TEXT } from "./model3dPresets";
import { CAMERA_CHANNEL_KIND, CAMERA_KF_LABELS, CAMERA_MEDIA_TYPE, isCameraChannel, pinCameraChannelTop, sanitizeCameraPath } from "./projectCamera";
import { NULL_MEDIA_TYPE, NULL_CLIP_DURATION_SECONDS, NULL_DEFAULT_SIZE, NULL_SIZE_MIN, NULL_SIZE_MAX } from "./nullLayer";
import { sanitizeShapePath, coerceShapePathValue, isStrokeShape, lineKfMeta, LINE_CAPS, LINE_JOINS, LINE_DASHES, LINE_DEFAULTS, LINE_KF_KEYS, SHAPE_PATH_KF_KEY, SHAPE_SIZE_KF_PROPS } from "./shapePath";
import { sanitizeLineExtras, sanitizeLineStroke } from "./pathStroke";
import { sanitizeItemFields as sanitizeTextAnimatorFields, sanitizeAnimators as sanitizeTextAnimators, parseTrackKey as parseTxaTrackKey, channelInfo as txaChannelInfo } from "./textAnimators";
import { sanitizeVectorTrace } from "./imageVectorizer";
import { sanitizeRigAi } from "./rigAiVideo";
import { AI_FILL_PROMPT, restoreAiFillTakes } from "./aiFill";
import { resolveKeyEase } from "./gsapTransitions";
import { KF_PROP_LABELS } from "./keyframeProps";
import { COUNTER_DEFAULTS, COUNTER_STYLES } from "./textCounter";
import { CYCLE_DEFAULTS, CYCLE_STYLES, SCRAMBLE_CHARSETS, SCRAMBLE_DEFAULTS, sanitizeTextVariables } from "./textPlaceholders";
import { sanitizeKeyframeFxMap, hasAnyKeyframeFx } from "./keyframeFx";
import { sanitizeBezier, sanitizeEaseSlice } from "./easingCurves";
import { AUDIO_FADE_CURVES } from "./audioFade";
import { GIF_LOOP_MODES, GIF_LOOP_MODE_DEFAULT, GIF_SPEED_DEFAULT, GIF_SPEED_MIN, GIF_SPEED_MAX } from "./animatedImage";
import { sanitizeObjectMotionPath } from "./objectMotionPath";
import { getAdjustmentEffect, makeEid, parseEffectKfKey, effectParamKfMeta, sanitizeEffectLut, sanitizeEffectGradient, sanitizeEffectCurves, sanitizeEffectEasing, isLocalEffectId } from "./adjustmentEffects";
import { sanitizeObjectTrack } from "./objectTracking";
import { RUNNING_GLOW_LAYER_EFFECT_ID, GLOW_DEFAULTS, GLOW_NUMBER_FIELDS, GLOW_ENUM_FIELDS, GLOW_COLOR_FIELDS } from "./runningGlow";
import { DEPTH_PARALLAX_LAYER_EFFECT_ID, DEPTH_DEFAULTS, DEPTH_NUMBER_FIELDS } from "./depthParallax";
import { DEPTH_MAP_LAYER_EFFECT_ID, DEPTH_MAP_MAX_DATA, DM_DEFAULTS, DM_ENUM_FIELDS } from "./depthMapEffect";
import { DEPTH_SCAN_LAYER_EFFECT_ID, SCN_DEFAULTS, SCN_NUMBER_FIELDS, SCN_ENUM_FIELDS, SCN_COLOR_FIELDS, SCN_GRADIENT_FIELDS } from "./depthScanLayer";
import { FRESNEL_RIM_LAYER_EFFECT_ID, FR_DEFAULTS, FR_NUMBER_FIELDS, FR_ENUM_FIELDS, FR_COLOR_FIELDS } from "./fresnelRimLayer";
import { MOTION_BLUR_LAYER_EFFECT_ID, MBLUR_DEFAULTS, MBLUR_NUMBER_FIELDS, MBLUR_ENUM_FIELDS } from "./motionBlurLayer";
import { MOTION_TRAIL_LAYER_EFFECT_ID, TRAIL_DEFAULTS, TRAIL_NUMBER_FIELDS, TRAIL_ENUM_FIELDS, TRAIL_COLOR_FIELDS } from "./motionTrailLayer";
import { AUTOFILL_LAYER_EFFECT_ID, AF_DEFAULTS, AF_NUMBER_FIELDS, AF_ENUM_FIELDS, AF_COLOR_FIELDS, AF_GRADIENT_FIELDS, sanitizeAutoFillPoints, sanitizeAutoFillPoints3d } from "./autoFillLayer";
import { RIG_LAYER_EFFECT_ID, RIG_DEFAULTS, RIG_NUMBER_FIELDS, RIG_ENUM_FIELDS, RIG_PIN_CHANNELS, RIG_KF_CHAN_META, sanitizeRigPins, sanitizeRigChains, parseRigKfKey } from "./rigDeform";
import { LAYER_MASK_EFFECT_ID, MASK_DEFAULTS, MASK_NUMBER_FIELDS, MASK_ENUM_FIELDS, MASK_KF_CHAN_META, MASK_PATH_CHAN, sanitizeLayerMasks, parseMaskKfKey, coerceMaskPathValue } from "./layerMask";
import { REPETILE_LAYER_EFFECT_ID, REP_DEFAULTS, REP_NUMBER_FIELDS, REP_ENUM_FIELDS, REP_COLOR_FIELDS } from "./repetileLayer";
import { REGION_DISTORT_LAYER_EFFECT_ID, DS_DEFAULTS, DS_NUMBER_FIELDS, DS_ENUM_FIELDS } from "./regionDistort";
import { MOCKUP_FRAME_LAYER_EFFECT_ID, MF_DEFAULTS, MF_BOOL_KEYS, MF_NUMBER_FIELDS, MF_ENUM_FIELDS, MF_STRING_FIELDS, MF_DEVICES } from "./mockupFrame";
import { CORNER_PIN_LAYER_EFFECT_ID, CP_DEFAULTS, CP_IDENTITY, CP_NUMBER_FIELDS } from "./cornerPinLayer";
import { DROSTE_LAYER_EFFECT_ID, DRO_DEFAULTS, DRO_NUMBER_FIELDS, DRO_ENUM_FIELDS, DRO_COLOR_FIELDS } from "./drosteLayer";
import { PRYZM_LAYER_EFFECT_ID, PZ_DEFAULTS, PZ_NUMBER_FIELDS, PZ_ENUM_FIELDS, PZ_COLOR_FIELDS } from "./pryzmLayer";
import { CHROMA_KEY_LAYER_EFFECT_ID, CK_DEFAULTS, CK_NUMBER_FIELDS, CK_ENUM_FIELDS, CK_COLOR_FIELDS } from "./chromaKeyLayer";
import { BEND_LAYER_EFFECT_ID, BN_DEFAULTS, BN_NUMBER_FIELDS } from "./bendLayer";
import { MESH_WARP_LAYER_EFFECT_ID, MW_DEFAULTS, MW_ENUM_FIELDS, MW_POINT_FIELDS, getMeshWarpEffect, mwActiveKeys } from "./meshWarp";
import { BEZIER_WARP_LAYER_EFFECT_ID, BW_DEFAULTS, BW_NUMBER_FIELDS } from "./bezierWarp";
import { sanitizeCameraRig, sanitizeCameraMoveMode } from "./cameraRig";
import { sanitizeRig, sanitizeShadowPlate, rigKfKeysFor, buildRigKfPropsFor, isRigTrackKey, isRigColorTrackKey, RIG_MEDIA_TYPE, RIG_CHANNEL_KIND, pinRigChannelUnderCamera } from "./rig3d";
import { PARTICLE_MEDIA_TYPE, PARTICLE_CLIP_DURATION_SECONDS, sanitizeParticleSystem, particleProxKfField } from "../../sim/particles/schema.js";
import { DEFAULT_MOTION_BLUR_SHUTTER, sanitizeMotionBlurShutter } from "./motionBlurLevels";
import { DEFAULT_TEXTURE_QUALITY, sanitizeTextureQuality } from "./rasterDensity";
import { DEFAULT_PREVIEW_FPS, sanitizePreviewFps } from "./previewDeviceTier.js";
import { sanitizeColorTokens } from "../colorTokens";
import { getTimelineLayout, getTimelineEndTime, sanitizeSpeedPoints } from "./speedUtils";
import { SPEED_KF_KEY, SPEED_KF_PROP, deriveSpeedPoints } from "./speedKeyframes";
import { sanitizeParentingField, repairParentingReferences } from "./keyframeParenting";
import { sanitizeTrackMatteField, repairTrackMatteReferences } from "./trackMatte";
import { sanitizeMotionTracks, sanitizeMotionFollow } from "./motionTracking";
import { sanitizeColorCorrection, ccIsModified, parseCcKfKey, ccKfFieldMeta } from "./colorCorrection";
import { sanitizeVideoStabilization } from "./videoStabilization";
import { normalizeGridConfig, parseGridKfKey, gridKfFieldMeta } from "./gridLayout";
import { parseProxKfKey } from "./particleProxKf";
import { getMotionTemplate } from "./motionTemplates";
import { parseMotionKfKey } from "./motionKf";
import { ADVANCED_TRANSITION_MAX_DURATION, isLocalAdvancedTransitionType, sanitizePersistedTransitionOptions } from "./advancedTransitions";
import { HTML_MEDIA_TYPE, HTML_CLIP_DURATION_SECONDS } from "./htmlClips";
import { AE_MEDIA_TYPE, AE_CLIP_DURATION_SECONDS } from "./aeClips";
import { sanitizeVoiceSource } from "./voiceSync";
import { sanitizeWordTimings } from "./captionTimings";
import { GLASS_LAYER_EFFECT_ID, sanitizeGlassParams } from "./glassEffect";

export const FALLBACK_CLIP_DURATION_SECONDS = 5;

export const IMAGE_CLIP_DURATION_SECONDS = 3;

export const TEXT_CLIP_DURATION_SECONDS = 5;

export const ADJUSTMENT_CLIP_DURATION_SECONDS = 5;

export const SHAPE_CLIP_DURATION_SECONDS = 5;

// A dropped model has no intrinsic length unless its glTF carries an animation; the
// ingest path overrides this with the animation duration when there is one.
export const MODEL_CLIP_DURATION_SECONDS = 5;

export const AI_FILL_DEFAULT_SECONDS = 3;

export const DEFAULT_TEXT_LAYER_TEXT = 'Type your text';

export function createId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const AUDIO_FILE_RE = /\.(mp3|wav|ogg|aac|flac|m4a|wma|opus)(\?.*)?$/;

// An audio file must NEVER be typed as a video clip. The exporter routes video
// clips through the frame decoder; a WAV has no moov box to demux, so it drops
// to the <video> seek fallback — which loads fine (valid audio, readyState 2)
// but never produces a frame. Every seek then burns the full 3s safety timeout
// and the layer paints an opaque black plate over the composite: one mistyped 4s
// sound blacked out the last 4s of a 9s timeline AND took 6m33s to render it.
export function isAudioUrl(url) {
  return typeof url === 'string' && AUDIO_FILE_RE.test(url.toLowerCase());
}

export function sanitizeNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

// Per-property keyframe tracks ('properties' keyframe mode): keep only known
// property names, clamp positions, coerce values to strings, validate easing.
// Clamp one keyframe VALUE into a range.
//
// Keyframe values are stored as strings, and sanitizeNumber returns its fallback for
// anything that isn't already a number — so passing the raw value straight in reset
// every clamped track to its minimum on load. `title-push-3d`'s Size (min 1) turned
// into a flat 1 at every key, which is what made this visible.
export function clampKeyValue(value, min, max) {
  return String(sanitizeNumber(Number.parseFloat(value), min, { min, max }));
}

export function sanitizePropertyKeyframes(propertyKeyframes, effects = [], item = null) {
  if (!propertyKeyframes || typeof propertyKeyframes !== 'object') return {};
  const result = {};
  const cleanTrack = (track, coerceValue) => {
    if (!Array.isArray(track) || track.length === 0) return null;
    const seen = new Set();
    const keys = track
      .filter((key) => key && Number.isFinite(Number(key.position)))
      .map((key) => ({
        // Positions come back as numbers from JSON, but a string one would land
        // every key on 0 and collapse the track — parse for the same reason.
        position: sanitizeNumber(Number.parseFloat(key.position), 0, { min: 0, max: 100 }),
        value: coerceValue ? coerceValue(key.value) : String(key.value ?? ''),
        easing: Object.values(TransitionEasing).includes(key.easing) ? key.easing : TransitionEasing.EASE_IN_OUT,
        // A CUSTOM key's curve. This object literal is the whitelist — anything not
        // spelled out here is dropped on the next autosave, so the graph editor's
        // hand-shaped curves have to be carried explicitly. Kept only for CUSTOM so
        // switching a key back to a named easing really clears it.
        ...(key.easing === TransitionEasing.CUSTOM && sanitizeBezier(key.bezier)
          ? { bezier: sanitizeBezier(key.bezier) }
          : null),
        // The part of its easing a key cut by a split plays (easingCurves.js). Kept
        // only while it still matches the key's easing.
        ...(key.easeSlice && sanitizeEaseSlice(key) ? { easeSlice: sanitizeEaseSlice(key) } : null),
      }))
      .sort((a, b) => a.position - b.position)
      .filter((key) => (seen.has(key.position) ? false : (seen.add(key.position), true)));
    return keys.length > 0 ? keys : null;
  };
  // Static registry props, plus the camera-layer registry (camera clips keyframe
  // camZoom/camX/… instead — see projectCamera.js).
  for (const prop of [...KF_PROP_LABELS, ...CAMERA_KF_LABELS]) {
    const keys = cleanTrack(propertyKeyframes[prop]);
    if (keys) result[prop] = keys;
  }
  // Overlay Effect tracks (`fx:<eid>:<param>`): keep only those whose effect
  // still exists (by eid) and whose param is keyframable; clamp values to the range.
  // Orphan tracks (effect removed) are dropped here.
  if (Array.isArray(effects) && effects.length) {
    const byEid = new Map(effects.map((e) => [e.eid, e]));
    for (const [key, track] of Object.entries(propertyKeyframes)) {
      const parsed = parseEffectKfKey(key);
      if (!parsed) continue;
      const eff = byEid.get(parsed.eid);
      if (!eff) continue;
      const meta = effectParamKfMeta(eff, parsed.paramKey);
      if (!meta) {
        // An installed effect not loaded here can't describe its params yet; its
        // tracks are kept as stored, like the entry itself (sanitizeEffectChain).
        const def = getAdjustmentEffect(eff.id);
        if (isLocalEffectId(eff.id) && (!def || !def.ready)) {
          const keys = cleanTrack(track, (v) => {
            const n = Number.parseFloat(v);
            return String(Number.isFinite(n) ? n : 0);
          });
          if (keys) result[key] = keys;
        }
        continue;
      }
      const keys = cleanTrack(track, (v) => clampKeyValue(v, meta.min ?? 0, meta.max ?? Infinity));
      if (keys) result[key] = keys;
    }
  }
  // Motion-template option tracks (`mp:<param>` / `mpc:<param>`). Unlike effect tracks
  // these are NOT validated against the template: the registry chunk, template modules and
  // local templates all hydrate asynchronously, so a lookup-and-drop here would wipe the
  // user's tracks on every project load. Clamp numerics only when the template already
  // resolved; an unknown param is harmless (nothing reads it) and template swaps drop
  // these tracks explicitly in changeMotionTemplate.
  if (item?.motionTemplateId) {
    const template = getMotionTemplate(item.motionTemplateId);
    const fieldByKey = new Map((template?.fields || []).map((f) => [f.key, f]));
    for (const [key, track] of Object.entries(propertyKeyframes)) {
      const parsed = parseMotionKfKey(key);
      if (!parsed) continue;
      const field = fieldByKey.get(parsed.paramKey);
      const coerce = !parsed.isColor && field && Number.isFinite(field.min) && Number.isFinite(field.max)
        ? (v) => clampKeyValue(v, field.min, field.max)
        : undefined;
      const keys = cleanTrack(track, coerce);
      if (keys) result[key] = keys;
    }
  }
  // Color Correction tracks (`cc:<path>`). Validated against the static registry
  // (colorCorrection.js CC_KF_FIELDS) and clamped to each value's range. Kept even
  // while the item has no stored correction: animated values over the defaults ARE
  // a correction, and the layer's other sections can be at defaults.
  for (const [key, track] of Object.entries(propertyKeyframes)) {
    const path = parseCcKfKey(key);
    if (!path) continue;
    const meta = ccKfFieldMeta(path);
    const keys = cleanTrack(track, (v) => clampKeyValue(v, meta.min, meta.max));
    if (keys) result[key] = keys;
  }
  // Grid layout tracks (`gr:<key>`). Validated against the parameter registry
  // (gridLayout.js GRID_KF_FIELDS) — unlike motion-template tracks, that registry
  // is static and always loaded, so an unknown key really is junk and is dropped.
  if (item?.gridConfig) {
    for (const [key, track] of Object.entries(propertyKeyframes)) {
      const paramKey = parseGridKfKey(key);
      if (!paramKey) continue;
      const meta = gridKfFieldMeta(paramKey);
      const keys = cleanTrack(track, (v) => clampKeyValue(v, meta.min, meta.max));
      if (keys) result[key] = keys;
    }
  }
  // Text placeholder progress tracks (`ph:<id>`, 0–100 %) — a keyframed COUNTER /
  // TIMER names its track in its own token (`; kf=<id>`, textPlaceholders.js). Kept
  // even when no token names the id right now: text is edited all day, and a deleted
  // token that comes back with undo should find its keys.
  if (typeof item?.textContent === 'string') {
    for (const [key, track] of Object.entries(propertyKeyframes)) {
      if (!/^ph:[a-z0-9]{1,8}$/.test(key)) continue;
      const keys = cleanTrack(track, (v) => clampKeyValue(v, 0, 100));
      if (keys) result[key] = keys;
    }
  }
  // Particle proximity tracks (`px:<param>`). Validated like `gr:` — the parameter
  // registry (schema.js PARTICLE_PROX_KF_FIELDS) is static and always loaded, so an
  // unknown key really is junk. A track whose driven property has since been removed
  // is deliberately KEPT: `fx` entries are added and dropped from a dropdown all day,
  // and wiping a shaped curve because the property was toggled off for a minute is
  // the kind of data loss nobody forgives. Nothing reads it while the property is
  // gone (see proxCfgAt), so it costs a few bytes and restores the animation the
  // moment the property comes back.
  if (item?.particleSystem) {
    for (const [key, track] of Object.entries(propertyKeyframes)) {
      const paramKey = parseProxKfKey(key);
      if (!paramKey) continue;
      const meta = particleProxKfField(paramKey);
      const keys = cleanTrack(track, (v) => clampKeyValue(v, meta.min, meta.max));
      if (keys) result[key] = keys;
    }
  }
  // Rig (Puppet) tracks (`rig:<pid>:<chan>`). Validated like `gr:` — the channel
  // registry is static and always loaded, so junk is dropped; a track whose pin
  // no longer exists (pin deleted) is an orphan and dies here too.
  {
    const rigFx = Array.isArray(item?.layerEffects)
      ? item.layerEffects.find((e) => e?.id === RIG_LAYER_EFFECT_ID)
      : null;
    if (rigFx) {
      const pinsByPid = new Map((Array.isArray(rigFx.pins) ? rigFx.pins : []).map((p) => [p?.pid, p]));
      for (const [key, track] of Object.entries(propertyKeyframes)) {
        const parsed = parseRigKfKey(key);
        if (!parsed) continue;
        const pin = pinsByPid.get(parsed.pid);
        if (!pin) continue;
        const channels = RIG_PIN_CHANNELS[pin.type] || [];
        if (!channels.includes(parsed.chan)) continue;
        const meta = RIG_KF_CHAN_META[parsed.chan];
        const keys = cleanTrack(track, (v) => clampKeyValue(v, meta.min, meta.max));
        if (keys) result[key] = keys;
      }
    }
  }
  // Mesh Warp lattice tracks (`mwP<i>X` / `mwP<i>Y`). Plain numeric keys that live
  // OUTSIDE the static KF_PROPS registry on purpose: the channel COUNT depends on the
  // grid size, so 50 permanent rows would sit in every layer's property dropdown for an
  // effect almost no layer carries. Kept alive here instead, validated like `rig:` —
  // only the vertices the CURRENT grid actually reaches survive, because changing the
  // grid re-seeds the lattice and a track on a slot it no longer reaches is an orphan.
  {
    const meshFx = getMeshWarpEffect(item);
    if (meshFx) {
      const live = new Set(mwActiveKeys({ ...MW_DEFAULTS, ...(meshFx.params || {}) }));
      for (const key of live) {
        const keys = cleanTrack(propertyKeyframes[key], (v) => clampKeyValue(v, -100, 200));
        if (keys) result[key] = keys;
      }
    }
  }
  // 3D Rig tracks (`sc:<lid|cyc|env>:<chan>` numeric, `scc:<lid|cyc>:col` colour).
  // Validated like `gr:`/`rig:` rather than `mp:` — rig3d.js is a static leaf module
  // that is always loaded, so an unknown key really is junk. A track whose light was
  // deleted is an orphan and dies here too: rigKfKeysFor is the single authority for
  // what this rig can legitimately carry, and it is the same function the panel uses
  // to build its rows, so the two cannot drift apart.
  if (item?.rig) {
    const allowed = rigKfKeysFor(item.rig);
    const metaByKey = new Map(buildRigKfPropsFor(item.rig).map((p) => [p.label, p]));
    // A rig clip carries ONLY rig tracks. Its plate is reset to identity in the
    // compositor (the cyclorama is posed inside the rig pass by its own x/y/z), so a
    // `scale` or `opacity` track on it would animate nothing at all — and it cannot
    // even be selected in the panel, whose row list is the rig registry. Dropping the
    // generic tracks here is what keeps "what the panel offers" and "what the file
    // holds" the same set.
    for (const prop of Object.keys(result)) {
      if (!isRigTrackKey(prop)) delete result[prop];
    }
    for (const [key, track] of Object.entries(propertyKeyframes)) {
      if (!isRigTrackKey(key) || !allowed.has(key)) continue;
      const meta = metaByKey.get(key);
      const keys = isRigColorTrackKey(key)
        ? cleanTrack(track)
        : cleanTrack(track, (v) => clampKeyValue(v, meta?.min ?? -Infinity, meta?.max ?? Infinity));
      if (keys) result[key] = keys;
    }
  }
  // Layer Mask tracks (`msk:<mid>:<chan>` numeric, `msk:<mid>:path` non-scalar).
  // Validated like `rig:` — layerMask.js is a static leaf, so an unknown channel
  // is junk and a track whose mask was deleted is an orphan; both die here.
  //
  // MUST sit after the `item?.rig` block above, which deletes every non-`sc:` key
  // from `result` — anything written before it on a rig clip would be wiped.
  //
  // ⚠️ This function is handed the RAW item (see the sanitizeItem call site), so
  // the mask list is re-sanitized rather than trusted: a mask the chain sanitizer
  // is about to drop (bad mid, past MASK_MAX, under three points) must not keep
  // its tracks alive.
  {
    const maskFx = Array.isArray(item?.layerEffects)
      ? item.layerEffects.find((e) => e?.id === LAYER_MASK_EFFECT_ID)
      : null;
    if (maskFx) {
      const live = new Set(sanitizeLayerMasks(maskFx.masks).map((m) => m.mid));
      for (const [key, track] of Object.entries(propertyKeyframes)) {
        const parsed = parseMaskKfKey(key);
        if (!parsed || !live.has(parsed.mid)) continue;
        if (parsed.chan === MASK_PATH_CHAN) {
          // The outline is a point list, not a number — clampKeyValue would
          // parseFloat the JSON and collapse every key to the track minimum.
          // The mask coercer also caps the count at MAX_MASK_POINTS, matching
          // the static-path truncation so the two never disagree.
          const keys = cleanTrack(track, coerceMaskPathValue)?.filter((k) => k.value);
          if (keys?.length) result[key] = keys;
          continue;
        }
        const meta = MASK_KF_CHAN_META[parsed.chan];
        const keys = cleanTrack(track, (v) => clampKeyValue(v, meta.min, meta.max));
        if (keys) result[key] = keys;
      }
    }
  }
  // Text Animator tracks (`txa:<aid>:<chan>`). Validated against the item's own
  // animators, re-sanitized from the RAW item like the mask list above: a track whose
  // animator or effect is gone, or whose channel is not keyframable (rates, seeds),
  // dies here; values clamp to the channel's own range. AFTER the `item?.rig` block.
  if (Array.isArray(item?.textAnimators) && item.textAnimators.length) {
    const list = sanitizeTextAnimators(item.textAnimators);
    for (const [key, track] of Object.entries(propertyKeyframes)) {
      const parsed = parseTxaTrackKey(key);
      if (!parsed) continue;
      const info = txaChannelInfo(list, parsed.aid, parsed.chan);
      if (!info) continue;
      const keys = cleanTrack(track, (v) => clampKeyValue(v, info.spec.min, info.spec.max));
      if (keys) result[key] = keys;
    }
  }
  // The clip's own SPEED track (`speed`). Outside the static KF_PROPS registry on
  // purpose: it is not a per-frame layer property at all — it retimes the clip, and
  // `speedPoints` is derived from it (speedKeyframes.js). Kept alive here so a
  // keyframed speed survives a save/load round trip, and clamped to the same rate
  // range the curve editor enforces. AFTER the `item?.rig` block, which deletes
  // every non-`sc:` key from `result` — a rig clip is retimed like any other.
  {
    const keys = cleanTrack(
      propertyKeyframes[SPEED_KF_KEY],
      (v) => clampKeyValue(v, SPEED_KF_PROP.min, SPEED_KF_PROP.max),
    );
    if (keys) result[SPEED_KF_KEY] = keys;
  }
  // Keyframed shape size (Width / Height, or a circle's Radius), one track per unit
  // field it overrides (shapePath.js SHAPE_SIZE_KF_PROPS). Inert on other layers.
  for (const meta of SHAPE_SIZE_KF_PROPS) {
    const track = cleanTrack(propertyKeyframes[meta.label], (v) => clampKeyValue(v, meta.min, meta.max));
    if (track) result[meta.label] = track;
  }
  // Editable-path shape tracks. The outline snapshot is a point list rather than
  // a number or a colour (the layer-mask outlines above are the others), so it
  // gets its own coercer — clampKeyValue would parseFloat the JSON and collapse
  // every key to the track minimum. The stroke/trim tracks alongside it are
  // ordinary numbers.
  if (item?.shapeType === 'path' || item?.shapeType === 'line') {
    const keys = cleanTrack(propertyKeyframes[SHAPE_PATH_KF_KEY], coerceShapePathValue)
      ?.filter((key) => key.value);
    if (keys?.length) result[SHAPE_PATH_KF_KEY] = keys;
    if (isStrokeShape(item)) {
      for (const label of LINE_KF_KEYS) {
        const meta = lineKfMeta(label);
        // colour tracks keep their CSS colour strings; numbers clamp to the schema
        const track = meta.inputType === 'color'
          ? cleanTrack(propertyKeyframes[label])
          : cleanTrack(propertyKeyframes[label], (v) => clampKeyValue(v, meta.min, meta.max));
        if (track) result[label] = track;
      }
    }
  }
  return result;
}

export function lineStrokeField(raw) {
  const clean = sanitizeLineStroke(raw);
  return clean ? { lineStroke: clean } : {};
}

export const SYNTHETIC_MEDIA_TYPES = new Set(['text', 'adjustment', 'shape', 'sequence', 'grid', 'motion', CAMERA_MEDIA_TYPE, RIG_MEDIA_TYPE, PARTICLE_MEDIA_TYPE, NULL_MEDIA_TYPE]);

export function sanitizeClip(clip) {
  if (!clip || typeof clip !== 'object') return null;
  const declaredMediaType = clip.mediaType === 'image' ? 'image'
    : clip.mediaType === 'text' ? 'text'
    : clip.mediaType === 'audio' ? 'audio'
    : clip.mediaType === 'adjustment' ? 'adjustment'
    : clip.mediaType === 'shape' ? 'shape'
    : clip.mediaType === 'sequence' ? 'sequence'
    : clip.mediaType === 'grid' ? 'grid'
    : clip.mediaType === 'motion' ? 'motion'
    // A model layer carries a real .glb/.gltf/.obj url, so it is deliberately NOT in
    // SYNTHETIC_MEDIA_TYPES — a model clip with no url is as invalid as a video with none.
    : clip.mediaType === 'model3d' ? 'model3d'
    : clip.mediaType === CAMERA_MEDIA_TYPE ? CAMERA_MEDIA_TYPE
    // Missing from this chain, a rig clip falls through to 'video', and a video with
    // no url is dropped — silently taking the rig item (and its lights) with it.
    : clip.mediaType === RIG_MEDIA_TYPE ? RIG_MEDIA_TYPE
    // Same hazard as the rig above: without this a particle clip falls through to
    // 'video', and a video with no url is dropped — taking the whole system with it.
    : clip.mediaType === PARTICLE_MEDIA_TYPE ? PARTICLE_MEDIA_TYPE
    // An html clip's url is its .html file; fell through to 'video' it would be
    // loaded as a video texture and its bake/canvas fields dropped below.
    : clip.mediaType === HTML_MEDIA_TYPE ? HTML_MEDIA_TYPE
    // A null has no url; fell through to 'video' it would be dropped as invalid.
    : clip.mediaType === NULL_MEDIA_TYPE ? NULL_MEDIA_TYPE
    // An After Effects clip's url is its .aep; as a 'video' it would be loaded as one
    // and its analysis / replacements / render dropped below.
    : clip.mediaType === AE_MEDIA_TYPE ? AE_MEDIA_TYPE
    : 'video';
  // The 'video' fall-through above is a guess for anything unrecognised, so it is
  // also what a mistyped sound file lands on. Enforce the invariant here, at the
  // one place every clip passes through on load: a media file with an audio
  // extension is an audio clip, whatever the stored mediaType claims. This heals
  // boards already saved with the bad type, not just newly created clips.
  const mediaType = declaredMediaType === 'video' && isAudioUrl(clip.url)
    ? 'audio'
    : declaredMediaType;
  // Synthetic layers (text/adjustment/shape/sequence) carry no media of their own, so they don't require a url.
  if (!SYNTHETIC_MEDIA_TYPES.has(mediaType) && (typeof clip.url !== 'string' || !clip.url)) return null;
  const base = {
    id: typeof clip.id === 'string' && clip.id ? clip.id : createId(),
    source: clip.source === ClipSource.LOCAL ? ClipSource.LOCAL : ClipSource.REMOTE,
    mediaType,
    url: SYNTHETIC_MEDIA_TYPES.has(mediaType) ? '' : clip.url,
    proxyUrl: typeof clip.proxyUrl === 'string' && clip.proxyUrl ? clip.proxyUrl : null,
    thumbnailUrl:
      typeof clip.thumbnailUrl === 'string' && clip.thumbnailUrl
        ? clip.thumbnailUrl
        : typeof clip.thumbnail_url === 'string' && clip.thumbnail_url
          ? clip.thumbnail_url
          : null,
    name: typeof clip.name === 'string' && clip.name ? clip.name : mediaType === 'text' ? 'Text Layer' : mediaType === 'audio' ? 'Audio' : mediaType === 'adjustment' ? 'Adjustment' : mediaType === 'shape' ? 'Shape' : mediaType === 'sequence' ? 'Sequence' : mediaType === 'grid' ? 'Grid' : mediaType === 'motion' ? 'Motion' : mediaType === 'model3d' ? '3D Model' : mediaType === PARTICLE_MEDIA_TYPE ? 'Particle Solver' : mediaType === CAMERA_MEDIA_TYPE ? 'Camera' : mediaType === HTML_MEDIA_TYPE ? 'HTML' : mediaType === NULL_MEDIA_TYPE ? 'Null' : mediaType === AE_MEDIA_TYPE ? 'After Effects' : 'Untitled',
    duration: sanitizeNumber(
      clip.duration,
      mediaType === 'image' ? IMAGE_CLIP_DURATION_SECONDS : mediaType === 'text' ? TEXT_CLIP_DURATION_SECONDS : mediaType === 'adjustment' ? ADJUSTMENT_CLIP_DURATION_SECONDS : mediaType === 'shape' ? SHAPE_CLIP_DURATION_SECONDS : mediaType === 'model3d' ? MODEL_CLIP_DURATION_SECONDS : mediaType === PARTICLE_MEDIA_TYPE ? PARTICLE_CLIP_DURATION_SECONDS : mediaType === HTML_MEDIA_TYPE ? HTML_CLIP_DURATION_SECONDS : mediaType === NULL_MEDIA_TYPE ? NULL_CLIP_DURATION_SECONDS : mediaType === AE_MEDIA_TYPE ? AE_CLIP_DURATION_SECONDS : FALLBACK_CLIP_DURATION_SECONDS,
      { min: 0.1 }
    ),
  };
  // PROXY badge toggle: this clip previews from the original file instead of its
  // proxy (full-res detail when scale/crop keyframes zoom in). Export always uses
  // the original regardless.
  if (clip.previewOriginal === true) base.previewOriginal = true;
  // Render-time only: the segmented picture source the backend prepared for this
  // clip, and the record of why. Neither is ever authored or persisted by the
  // editor — the render snapshot is mutated on its way to the headless page —
  // but this sanitizer is what that snapshot passes through, and it builds `base`
  // from a whitelist. Without these two lines the descriptor is dropped in
  // transit and the render silently reads the whole original instead of the
  // segments that were just built for it, with nothing anywhere saying so.
  if (clip.renderVideoSource && typeof clip.renderVideoSource === 'object') {
    base.renderVideoSource = clip.renderVideoSource;
  }
  if (clip.renderSourceInfo && typeof clip.renderSourceInfo === 'object') {
    base.renderSourceInfo = clip.renderSourceInfo;
  }
  // Frame rate this clip was interpolated up to (slow-motion smoothing). Its
  // presence is also what stops the Speed Curve re-offering the conversion on
  // an already-smoothed clip, so it has to survive autosave.
  if (Number.isFinite(clip.interpolatedFps)) base.interpolatedFps = clip.interpolatedFps;
  // Source file mtime (st_mtime_ns) captured when the media was added. It only
  // versions derivative URLs (`&v=` on posters / waveform peaks), so a clip
  // without one is fine — but it must survive save/load or every reload goes
  // back to unversioned, revalidating requests. Kept in whichever shape it
  // arrived (number, or a digit string when the listing preserves precision).
  const mediaMtimeNs = normalizeMtimeNs(clip.mediaMtimeNs);
  if (mediaMtimeNs !== null) base.mediaMtimeNs = mediaMtimeNs;
  // Container clips (sequence + grid) embed their own nested editor state. Sanitize
  // it recursively so a loaded/pasted/preset container is always structurally valid.
  // A grid's channels are its cells (one member each), which is why the same
  // payload shape serves both.
  if (mediaType === 'sequence' || mediaType === 'grid') {
    const nested = clip.sequence && typeof clip.sequence === 'object' ? clip.sequence : {};
    const seqClips = (Array.isArray(nested.clips) ? nested.clips : []).map(sanitizeClip).filter(Boolean);
    const seqClipIds = new Set(seqClips.map((c) => c.id));
    const seqChannels = sanitizeChannels(Array.isArray(nested.channels) ? nested.channels : [], seqClipIds);
    base.sequence = { clips: seqClips, channels: seqChannels };
    base.duration = Math.max(0.1, getChannelsTotalDuration(seqChannels));
    // Prerender (SEQUENCE panel, sequencePrerender.js): the transparent WebM the
    // preview plays in place of the live inner timeline, with the fingerprint it
    // was rendered from. Kept verbatim — validity is decided against the current
    // sequence wherever it is used, never here.
    const pre = clip.prerender;
    if (pre && typeof pre === 'object' && typeof pre.url === 'string' && pre.url && typeof pre.hash === 'string' && pre.hash) {
      base.prerender = {
        url: pre.url, hash: pre.hash,
        fps: Number(pre.fps) || 0, width: Number(pre.width) || 0, height: Number(pre.height) || 0, at: Number(pre.at) || 0,
      };
    }
  }
  // Essential panel (EssentialPanel.jsx): what a built edit was made from (its kind and recipe — an AI Viral Edit's
  // settings, analysis and cut-out), on its camera clip (an older edit: its sequence), so its controls can rebuild
  // it. Kept verbatim, JSON-safe. `generatedBy` marks the clips such a build made: a superseded version's are not saved.
  if ((mediaType === 'sequence' || mediaType === CAMERA_MEDIA_TYPE) && clip.essential && typeof clip.essential === 'object' && typeof clip.essential.kind === 'string') {
    try { base.essential = JSON.parse(JSON.stringify(clip.essential)); } catch { /* not JSON-safe: dropped */ }
  }
  if (typeof clip.generatedBy === 'string' && clip.generatedBy) base.generatedBy = clip.generatedBy;
  // HTML clip (htmlClips.js): the page's canvas size and its bake — the WebM the
  // Player plays in its place. Validity is decided against the current file where
  // it is used, never here.
  if (mediaType === HTML_MEDIA_TYPE) {
    const hw = Math.round(Number(clip.html?.width) || 0);
    const hh = Math.round(Number(clip.html?.height) || 0);
    if (hw >= 16 && hh >= 16) base.html = { width: Math.min(hw, 7680), height: Math.min(hh, 7680) };
    const pre = clip.prerender;
    if (pre && typeof pre === 'object' && typeof pre.url === 'string' && pre.url && typeof pre.hash === 'string' && pre.hash) {
      base.prerender = {
        url: pre.url, hash: pre.hash,
        sourceSha1: typeof pre.sourceSha1 === 'string' ? pre.sourceSha1 : '',
        duration: Number(pre.duration) || 0,
        thumbnailUrl: typeof pre.thumbnailUrl === 'string' && pre.thumbnailUrl ? pre.thumbnailUrl : null,
        fps: Number(pre.fps) || 0, width: Number(pre.width) || 0, height: Number(pre.height) || 0, at: Number(pre.at) || 0,
      };
    }
    // A HyperFrames composition (hyperframesClips.js): marked when it was added, so the
    // HTML panel offers Convert to scenes without asking the backend first.
    const hf = clip.hyperframes;
    if (hf && typeof hf === 'object') {
      base.hyperframes = {
        runtime: typeof hf.runtime === 'string' ? hf.runtime : '',
        scenes: Math.max(0, Math.round(Number(hf.scenes) || 0)),
        compositionId: typeof hf.compositionId === 'string' ? hf.compositionId : '',
      };
      // Its declared variables (the HTML panel's fields); the VALUES ride in the url.
      if (Array.isArray(hf.variables) && hf.variables.length) {
        try { base.hyperframes.variables = JSON.parse(JSON.stringify(hf.variables.slice(0, 40))); } catch { /* not JSON-safe: dropped */ }
      }
    }
  }
  // After Effects clip (aeClips.js): the analysis, picked comp, output and the
  // replacements (JSON-safe, kept verbatim), and the render it plays. Whether the
  // render is current is decided against `ae` where it is used, never here.
  if (mediaType === AE_MEDIA_TYPE) {
    if (clip.ae && typeof clip.ae === 'object') {
      try {
        const ae = JSON.parse(JSON.stringify(clip.ae));
        base.ae = {
          ...(ae.inspection && Array.isArray(ae.inspection.compositions) ? { inspection: ae.inspection } : {}),
          comp: typeof ae.comp === 'string' ? ae.comp : '',
          output: typeof ae.output === 'string' && ae.output ? ae.output : 'auto',
          values: ae.values && typeof ae.values === 'object' ? ae.values : {},
          ...(Number.isFinite(ae.analyzedAt) ? { analyzedAt: ae.analyzedAt } : {}),
        };
      } catch { /* not JSON-safe: dropped, the clip analyzes again */ }
    }
    const pre = clip.prerender;
    if (pre && typeof pre === 'object' && typeof pre.url === 'string' && pre.url && typeof pre.hash === 'string' && pre.hash) {
      base.prerender = {
        url: pre.url, hash: pre.hash,
        proxyUrl: typeof pre.proxyUrl === 'string' && pre.proxyUrl ? pre.proxyUrl : null,
        thumbnailUrl: typeof pre.thumbnailUrl === 'string' && pre.thumbnailUrl ? pre.thumbnailUrl : null,
        duration: Number(pre.duration) || 0, width: Number(pre.width) || 0, height: Number(pre.height) || 0,
        comp: typeof pre.comp === 'string' ? pre.comp : '', name: typeof pre.name === 'string' ? pre.name : '',
        at: Number(pre.at) || 0,
      };
    }
  }
  if (clip.genMeta && typeof clip.genMeta === 'object') {
    const gm = clip.genMeta;
    base.genMeta = {
      kind: gm.kind === 'transition' ? 'transition' : 'generic',
      prompt: typeof gm.prompt === 'string' ? gm.prompt : '',
      modelId: typeof gm.modelId === 'string' ? gm.modelId : '',
      sourceImages: Array.isArray(gm.sourceImages) ? gm.sourceImages.filter((u) => typeof u === 'string' && u) : [],
      timestamp: typeof gm.timestamp === 'number' ? gm.timestamp : Date.now(),
    };
  }
  // Transcript editor: persist the word-level transcript attached to a clip so it
  // survives save/load (no re-transcribe on reopen). Validate the words array shape.
  if (clip.transcript && typeof clip.transcript === 'object' && Array.isArray(clip.transcript.words)) {
    const words = clip.transcript.words
      .filter((w) => w && typeof w.word === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
      .map((w) => ({ word: w.word, start: w.start, end: w.end }));
    const segments = Array.isArray(clip.transcript.segments)
      ? clip.transcript.segments
          .filter((s) => s && typeof s.text === 'string' && Number.isFinite(s.startMs) && Number.isFinite(s.endMs))
          .map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text }))
      : [];
    base.transcript = {
      language: typeof clip.transcript.language === 'string' ? clip.transcript.language : null,
      text: typeof clip.transcript.text === 'string' ? clip.transcript.text : '',
      words,
      ...(segments.length ? { segments } : {}),
    };
  }
  // Link to the agentic recording sidecar (transcript/events/frames), so the editor's
  // "AI captured data" panel + delete-with-cleanup keep working across save/load.
  if (typeof clip.recordingId === 'string' && clip.recordingId) {
    base.recordingId = clip.recordingId;
  }
  // Auto chapters/summary/title generated by the insights stage — persisted so the
  // timeline chapter markers survive save/load without re-polling the sidecar.
  if (clip.insights && typeof clip.insights === 'object') {
    const ins = clip.insights;
    base.insights = {
      title: typeof ins.title === 'string' ? ins.title : '',
      summary: typeof ins.summary === 'string' ? ins.summary : '',
      chapters: Array.isArray(ins.chapters)
        ? ins.chapters
            .filter((c) => c && Number.isFinite(c.startMs) && typeof c.title === 'string')
            .map((c) => ({ startMs: c.startMs, title: c.title, ...(typeof c.summary === 'string' && c.summary ? { summary: c.summary } : {}) }))
        : [],
      tags: Array.isArray(ins.tags) ? ins.tags.filter((t) => typeof t === 'string') : [],
    };
  }
  // Screen-recording cursor/click track (SCREENRECORD_V2_PLAN §3.3): persist it so
  // auto-zoom can be re-generated after the user trims the clip.
  if (clip.recordingMeta && typeof clip.recordingMeta === 'object') {
    const rm = clip.recordingMeta;
    const num = (v) => (Number.isFinite(v) ? v : null);
    const sanitizeArr = (arr, mapFn) => (Array.isArray(arr) ? arr.map(mapFn).filter(Boolean) : []);
    base.recordingMeta = {
      version: 1,
      fps: Number.isFinite(rm.fps) ? rm.fps : 60,
      durationSec: num(rm.durationSec),
      screen:
        rm.screen && typeof rm.screen === 'object'
          ? { width: num(rm.screen.width), height: num(rm.screen.height), scale: num(rm.screen.scale) }
          : null,
      cursor: sanitizeArr(rm.cursor, (p) =>
        p && Number.isFinite(p.t) && Number.isFinite(p.x) && Number.isFinite(p.y) ? { t: p.t, x: p.x, y: p.y } : null
      ),
      events: sanitizeArr(rm.events, (e) =>
        e && typeof e.type === 'string' && Number.isFinite(e.t)
          ? {
              t: e.t,
              type: e.type,
              x: Number.isFinite(e.x) ? e.x : null,
              y: Number.isFinite(e.y) ? e.y : null,
              ...(Number.isFinite(e.button) ? { button: e.button } : {}),
            }
          : null
      ),
    };
  }
  // AI Fill: an unapplied zone's spacer clip persists (the empty gap is saved);
  // keep its zone tag so the zone stays manipulable after reload.
  if (typeof clip.aiFillZoneId === 'string' && clip.aiFillZoneId) {
    base.aiFillZoneId = clip.aiFillZoneId;
  }
  return base;
}

// Shadow list for a timeline item (max 4 layers, CSS box-shadow-style). Items
// saved before multi-shadow support carry legacy single-shadow fields
// (shadowX/Y/Blur/Spread/Color) — converted into a one-entry list here.
export function sanitizeShadows(item) {
  let src;
  if (Array.isArray(item.shadows)) {
    src = item.shadows;
  } else {
    const x = sanitizeNumber(item.shadowX, 0, { min: -500, max: 500 });
    const y = sanitizeNumber(item.shadowY, 0, { min: -500, max: 500 });
    const blur = sanitizeNumber(item.shadowBlur, 0, { min: 0, max: 400 });
    const spread = sanitizeNumber(item.shadowSpread, 0, { min: 0, max: 400 });
    const on = blur > 0.01 || spread > 0.01 || Math.abs(x) > 0.01 || Math.abs(y) > 0.01;
    src = on ? [{ x, y, blur, spread, color: item.shadowColor, inset: false }] : [];
  }
  return src.slice(0, 4).map((s) => ({
    x: sanitizeNumber(s?.x, 0, { min: -500, max: 500 }),
    y: sanitizeNumber(s?.y, 0, { min: -500, max: 500 }),
    blur: sanitizeNumber(s?.blur, 0, { min: 0, max: 400 }),
    spread: sanitizeNumber(s?.spread, 0, { min: -400, max: 400 }),
    color: typeof s?.color === 'string' && s.color ? s.color : 'rgba(0,0,0,0.65)',
    inset: !!s?.inset,
  }));
}

// The generated depth plate, stored inline as a base64 PNG (same self-contained
// approach as a .cube LUT). The size cap is a sanity bound: a DEPTH_MAX_EDGE map
// is tens of KB, so anything near the limit is not something this app wrote.
export function sanitizeDepthMap(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { w, h, data, t, name } = raw;
  if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,')) return null;
  if (data.length > DEPTH_MAP_MAX_DATA) return null;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return null;
  /* `t` — the SOURCE second a VIDEO layer's map was frozen from. This function
     rebuilds the object key by key, so anything not named here is dropped on
     load: without this line the panel would name the frame until the project was
     reopened and then silently stop. Optional, and absent on an image map.

     `name` — the file a LOADED map came from, absent on an estimated one. Same
     rebuild trap: without it a loaded map would come back nameless and read as
     though it had been estimated here. */
  const label = typeof name === 'string' && name ? name.slice(0, 60) : '';
  return {
    w: Math.round(w),
    h: Math.round(h),
    data,
    ...(Number.isFinite(t) && t >= 0 ? { t } : {}),
    ...(label ? { name: label } : {}),
  };
}

// The Layer Effects section has its own typed array. These are structural effects
// with dedicated render paths, not entries in the Overlay Effects shader registry.
// Direct legacy glow*/depth* item fields are deliberately ignored: this data shape
// was not public, so layerEffects[] is the only accepted representation.
/* The Overlay Effects Active Range, reused verbatim on the Depth entries: the
   panel drives them through the same slider, so they must sanitize the same way
   or a window authored in one place would be dropped by the other. Written only
   when the user actually scoped the effect, so an un-windowed entry saves
   byte-identically to before the feature existed. */
export function applyEffectWindow(eff, raw) {
  if (Number.isFinite(raw.start)) eff.start = Math.max(0, Number(raw.start));
  if (Number.isFinite(raw.end)) eff.end = Math.max(0, Number(raw.end));
  // An inverted window would bypass the effect for the whole clip, which reads as
  // a broken render — drop both and fall back to "whole layer".
  if (Number.isFinite(eff.start) && Number.isFinite(eff.end) && eff.end <= eff.start) {
    delete eff.start;
    delete eff.end;
  }
  return eff;
}

export function sanitizeLayerEffectChain(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || seen.has(raw.id)) continue;
    if (raw.id === RUNNING_GLOW_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of GLOW_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], GLOW_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of GLOW_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : GLOW_DEFAULTS[f.key];
      }
      for (const f of GLOW_COLOR_FIELDS) {
        const value = raw.params?.[f.key];
        params[f.key] = typeof value === 'string' && value ? value : GLOW_DEFAULTS[f.key];
      }
      out.push({
        id: RUNNING_GLOW_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === DEPTH_PARALLAX_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of DEPTH_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], DEPTH_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      const depthMap = sanitizeDepthMap(raw.depthMap);
      out.push(applyEffectWindow({
        id: DEPTH_PARALLAX_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
        ...(depthMap ? { depthMap } : {}),
      }, raw));
      seen.add(raw.id);
    } else if (raw.id === DEPTH_MAP_LAYER_EFFECT_ID) {
      // The shared depth source. It carries the MAP (top-level, like depth3d's
      // own) plus the polarity flag every consumer agrees on.
      const params = {};
      for (const f of DM_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : DM_DEFAULTS[f.key];
      }
      const depthMap = sanitizeDepthMap(raw.depthMap);
      out.push({
        id: DEPTH_MAP_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
        ...(depthMap ? { depthMap } : {}),
      });
      seen.add(raw.id);
    } else if (raw.id === DEPTH_SCAN_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of SCN_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], SCN_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of SCN_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : SCN_DEFAULTS[f.key];
      }
      for (const f of SCN_COLOR_FIELDS) {
        const value = raw.params?.[f.key];
        params[f.key] = typeof value === 'string' && value ? value : SCN_DEFAULTS[f.key];
      }
      for (const f of SCN_GRADIENT_FIELDS) {
        params[f.key] = sanitizeEffectGradient(raw.params?.[f.key], SCN_DEFAULTS[f.key]);
      }
      // On a 3D model the scan can sweep a plane through the model instead of
      // camera depth (model3dFx.js). Kept only when set, so every scan saved
      // before it existed round-trips byte-identically.
      const scnSpace = Number(raw.params?.scnSpace);
      if ([1, 2, 3].includes(scnSpace)) params.scnSpace = scnSpace;
      out.push(applyEffectWindow({
        id: DEPTH_SCAN_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      }, raw));
      seen.add(raw.id);
    } else if (raw.id === FRESNEL_RIM_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of FR_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], FR_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of FR_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : FR_DEFAULTS[f.key];
      }
      for (const f of FR_COLOR_FIELDS) {
        const value = raw.params?.[f.key];
        params[f.key] = typeof value === 'string' && value ? value : FR_DEFAULTS[f.key];
      }
      out.push(applyEffectWindow({
        id: FRESNEL_RIM_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      }, raw));
      seen.add(raw.id);
    } else if (raw.id === MOTION_BLUR_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of MBLUR_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], MBLUR_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of MBLUR_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : MBLUR_DEFAULTS[f.key];
      }
      out.push({
        id: MOTION_BLUR_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === MOTION_TRAIL_LAYER_EFFECT_ID) {
      const params = {};
      // 9.6.35 stored Scale Decay as an 80–120% multiplier; it is now the signed
      // delta (0 = neutral, negative shrinks) so both directions are one control.
      // Anything above the new ceiling can only be a legacy multiplier.
      const legacyScale = Number(raw.params?.trailScale);
      const migrated = Number.isFinite(legacyScale) && legacyScale > 25
        ? { ...raw.params, trailScale: legacyScale - 100 }
        : raw.params;
      for (const f of TRAIL_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(migrated?.[f.key], TRAIL_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of TRAIL_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : TRAIL_DEFAULTS[f.key];
      }
      for (const f of TRAIL_COLOR_FIELDS) {
        const value = raw.params?.[f.key];
        params[f.key] = typeof value === 'string' && value ? value : TRAIL_DEFAULTS[f.key];
      }
      out.push({
        id: MOTION_TRAIL_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === AUTOFILL_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of AF_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], AF_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of AF_ENUM_FIELDS) {
        const value = Number(raw.params?.[f.key]);
        params[f.key] = f.options.some((o) => o.value === value) ? value : AF_DEFAULTS[f.key];
      }
      for (const f of AF_COLOR_FIELDS) {
        const c = raw.params?.[f.key];
        params[f.key] = typeof c === 'string' && c ? c : AF_DEFAULTS[f.key];
      }
      for (const f of AF_GRADIENT_FIELDS) {
        params[f.key] = sanitizeEffectGradient(raw.params?.[f.key], AF_DEFAULTS[f.key]);
      }
      // Manual infection points ride top-level on the entry (like depthMap):
      // `points` = 2D layer-box, `points3d` = root-local model-surface seeds.
      const points = sanitizeAutoFillPoints(raw.points);
      const points3d = sanitizeAutoFillPoints3d(raw.points3d);
      out.push({
        id: AUTOFILL_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
        ...(points.length ? { points } : {}),
        ...(points3d.length ? { points3d } : {}),
      });
      seen.add(raw.id);
    } else if (raw.id === RIG_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of RIG_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], RIG_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of RIG_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : RIG_DEFAULTS[f.key];
      }
      // Puppet pins and IK limbs ride top-level on the entry (the autoFill
      // points precedent) — this re-emit is what keeps them alive across
      // autosave round-trips. Chains referencing missing pins dissolve here.
      const pins = sanitizeRigPins(raw.pins);
      const chains = sanitizeRigChains(raw.chains, pins);
      out.push({
        id: RIG_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
        ...(pins.length ? { pins } : {}),
        ...(chains.length ? { chains } : {}),
      });
      seen.add(raw.id);
    } else if (raw.id === REPETILE_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of REP_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], REP_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of REP_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : REP_DEFAULTS[f.key];
      }
      for (const f of REP_COLOR_FIELDS) {
        const c = raw.params?.[f.key];
        params[f.key] = typeof c === 'string' && c ? c : REP_DEFAULTS[f.key];
      }
      out.push({
        id: REPETILE_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === REGION_DISTORT_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of DS_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], DS_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of DS_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : DS_DEFAULTS[f.key];
      }
      out.push({
        id: REGION_DISTORT_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === BEND_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of BN_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], BN_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      out.push({
        id: BEND_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === CORNER_PIN_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of CP_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], CP_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      out.push({
        id: CORNER_PIN_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === DROSTE_LAYER_EFFECT_ID) {
      // Every key is re-emitted from DRO_DEFAULTS, colours included: this list is a
      // per-id WHITELIST, and a key it does not name is dropped on the next load
      // even though autosave stored it happily.
      const params = {};
      for (const f of DRO_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], DRO_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of DRO_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : DRO_DEFAULTS[f.key];
      }
      for (const f of DRO_COLOR_FIELDS) {
        const c = raw.params?.[f.key];
        params[f.key] = typeof c === 'string' && c ? c : DRO_DEFAULTS[f.key];
      }
      out.push({
        id: DROSTE_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === PRYZM_LAYER_EFFECT_ID) {
      // Same per-id WHITELIST as Droste above: every key re-emitted from
      // PZ_DEFAULTS, colours included. A key this list does not name is dropped
      // on the next load even though autosave stored it happily.
      const params = {};
      for (const f of PZ_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], PZ_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of PZ_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : PZ_DEFAULTS[f.key];
      }
      for (const f of PZ_COLOR_FIELDS) {
        const c = raw.params?.[f.key];
        params[f.key] = typeof c === 'string' && c ? c : PZ_DEFAULTS[f.key];
      }
      out.push({
        id: PRYZM_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === GLASS_LAYER_EFFECT_ID) {
      // Glass (glassEffect.js). The whitelist lives beside the effect:
      // glassPreset plus every field, each a valid stored value or that
      // preset's own — so `params: { glassPreset: 'frosted' }` loads complete.
      out.push({
        id: GLASS_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params: sanitizeGlassParams(raw.params),
      });
      seen.add(raw.id);
    } else if (raw.id === CHROMA_KEY_LAYER_EFFECT_ID) {
      // Every key is re-emitted from CK_DEFAULTS, colours and enums included: this
      // list is a per-id WHITELIST, and a key it does not name is dropped on the
      // next load even though autosave stored it happily.
      const params = {};
      for (const f of CK_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], CK_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of CK_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : CK_DEFAULTS[f.key];
      }
      for (const f of CK_COLOR_FIELDS) {
        const c = raw.params?.[f.key];
        params[f.key] = typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : CK_DEFAULTS[f.key];
      }
      out.push({
        id: CHROMA_KEY_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === MOCKUP_FRAME_LAYER_EFFECT_ID) {
      // Every key is re-emitted from MF_DEFAULTS, strings included: this list is a
      // per-id WHITELIST, and a key it does not name is dropped on the next load even
      // though autosave stored it happily.
      const params = {};
      for (const f of MF_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], MF_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of MF_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : MF_DEFAULTS[f.key];
      }
      for (const key of MF_BOOL_KEYS) {
        // An ABSENT flag has to fall back to its default, not to 0: a partially specified
        // entry would otherwise lose the iMac's stand and the watch's band on first load.
        const raw01 = raw.params?.[key];
        params[key] = raw01 === undefined || raw01 === null ? MF_DEFAULTS[key] : (raw01 ? 1 : 0);
      }
      params.mfContentAspect = sanitizeNumber(raw.params?.mfContentAspect, MF_DEFAULTS.mfContentAspect, { min: 0, max: 8 });
      for (const key of MF_STRING_FIELDS) {
        const value = raw.params?.[key];
        params[key] = typeof value === 'string' && value ? value : MF_DEFAULTS[key];
      }
      if (!MF_DEVICES.some((d) => d.id === params.mfDevice)) params.mfDevice = MF_DEFAULTS.mfDevice;
      out.push({
        id: MOCKUP_FRAME_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === MESH_WARP_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of MW_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : MW_DEFAULTS[f.key];
      }
      // The whole lattice bank is re-emitted, live slots and all: an omitted slot would
      // read as its default the next time the grid grows into it.
      for (const f of MW_POINT_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], MW_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      out.push({
        id: MESH_WARP_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === BEZIER_WARP_LAYER_EFFECT_ID) {
      const params = {};
      for (const f of BW_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], BW_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      out.push({
        id: BEZIER_WARP_LAYER_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(raw.id);
    } else if (raw.id === 'distort') {
      // Legacy: the two warps shipped briefly as ONE `distort` entry with a `dsType`
      // selector. Without this branch the whitelist above would drop those entries on
      // load and the layer would silently lose its warp. Bend's params were `ds`-prefixed
      // then, so they are renamed on the way through; the region half kept its keys.
      const bend = Number(raw.params?.dsType) === 1;
      const id = bend ? BEND_LAYER_EFFECT_ID : REGION_DISTORT_LAYER_EFFECT_ID;
      if (seen.has(id)) continue;
      const params = {};
      if (bend) {
        const legacy = { bnAX: 'dsAX', bnAY: 'dsAY', bnBX: 'dsBX', bnBY: 'dsBY', bnAngle: 'dsAngle', bnStretch: 'dsStretch' };
        for (const f of BN_NUMBER_FIELDS) {
          params[f.key] = sanitizeNumber(raw.params?.[legacy[f.key]], BN_DEFAULTS[f.key], { min: f.min, max: f.max });
        }
      } else {
        for (const f of DS_NUMBER_FIELDS) {
          params[f.key] = sanitizeNumber(raw.params?.[f.key], DS_DEFAULTS[f.key], { min: f.min, max: f.max });
        }
        for (const f of DS_ENUM_FIELDS) {
          const allowed = f.options.map(([value]) => value);
          const value = Number(raw.params?.[f.key]);
          params[f.key] = allowed.includes(value) ? value : DS_DEFAULTS[f.key];
        }
      }
      out.push({
        id,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
      });
      seen.add(id);
      seen.add(raw.id);
    } else if (raw.id === LAYER_MASK_EFFECT_ID) {
      const params = {};
      for (const f of MASK_NUMBER_FIELDS) {
        params[f.key] = sanitizeNumber(raw.params?.[f.key], MASK_DEFAULTS[f.key], { min: f.min, max: f.max });
      }
      for (const f of MASK_ENUM_FIELDS) {
        const allowed = f.options.map(([value]) => value);
        const value = Number(raw.params?.[f.key]);
        params[f.key] = allowed.includes(value) ? value : MASK_DEFAULTS[f.key];
      }
      // The mask list rides top-level on the entry (the rig `pins` precedent) —
      // this re-emit is what keeps it alive across autosave round-trips.
      const masks = sanitizeLayerMasks(raw.masks);
      out.push({
        id: LAYER_MASK_EFFECT_ID,
        eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
        enabled: raw.enabled !== false,
        params,
        ...(masks.length ? { masks } : {}),
      });
      seen.add(raw.id);
    }
  }
  return out;
}

// A GPU effect chain (adjustmentEffects.js). A whitelist: unknown effect ids are
// dropped, the chain is capped at 4, each param is clamped to its registry min/max,
// and custom GLSL is length-capped. Returns [] when there's no chain so old projects
// (no `effects` field) round-trip byte-identically. Both Overlay Effect scopes use
// item.effects: adjustment layers affect the stack below, regular layers affect
// their own isolated plate.
export const MAX_ADJUSTMENT_EFFECTS = 4;

export const MAX_CUSTOM_EFFECT_CODE = 8192;

/*
 * AN INSTALLED EFFECT THIS SESSION CANNOT DESCRIBE IS KEPT, NOT DROPPED.
 *
 * A `local:` effect (Effects SDK) resolves only once its package is listed and
 * loaded — and on a machine without the package it never does. Dropping the
 * entry, as an unknown built-in id is dropped, would erase it from the project
 * on the next autosave. So it is kept as stored: the instance fields the chain
 * reads, and its params as plain values (the package that knows their ranges
 * re-clamps them once it loads). The chain skips it until then.
 */
export const MAX_UNRESOLVED_EFFECT_PARAMS = 32;

export function sanitizeUnresolvedLocalEffect(raw) {
  const params = {};
  for (const [key, value] of Object.entries(raw?.params || {}).slice(0, MAX_UNRESOLVED_EFFECT_PARAMS)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    else if (typeof value === 'string' && value.length <= 64) params[key] = value;
  }
  const eff = {
    id: raw.id,
    eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
    enabled: raw.enabled !== false,
    mix: sanitizeNumber(raw.mix, 100, { min: 0, max: 100 }),
    params,
  };
  if (raw.clip === true || raw.clip === false) eff.clip = raw.clip;
  if (Number.isFinite(raw.start)) eff.start = Math.max(0, Number(raw.start));
  if (Number.isFinite(raw.end)) eff.end = Math.max(0, Number(raw.end));
  if (Number.isFinite(eff.start) && Number.isFinite(eff.end) && eff.end <= eff.start) {
    delete eff.start;
    delete eff.end;
  }
  return eff;
}

export function sanitizeEffectChain(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= MAX_ADJUSTMENT_EFFECTS) break;
    const def = raw && getAdjustmentEffect(raw.id);
    if (!def || (def.isLocal && !def.ready)) {
      if (raw && isLocalEffectId(raw.id)) out.push(sanitizeUnresolvedLocalEffect(raw));
      continue;
    }
    const params = {};
    for (const p of def.params) {
      const rawValue = raw?.params?.[p.key] ?? (p.legacyKey ? raw?.params?.[p.legacyKey] : undefined);
      if (p.type === 'color') {
        const c = rawValue;
        params[p.key] = typeof c === 'string' && c ? c : p.default;
      } else if (p.type === 'gradient') {
        // A CSS gradient string from the shared picker; anything else falls back to
        // the registry default rather than reaching the ramp builder.
        params[p.key] = sanitizeEffectGradient(rawValue, p.default);
      } else if (p.type === 'curves') {
        // Four spline channels in the unit box; anything malformed falls back to
        // the identity curves rather than reaching the LUT bake.
        params[p.key] = sanitizeEffectCurves(rawValue, p.default);
      } else if (p.type === 'select') {
        const value = sanitizeNumber(rawValue, p.default);
        params[p.key] = p.options?.some((option) => Number(option.value) === value) ? value : p.default;
      } else if (p.type === 'layer') {
        // Another layer's item id (Copy Color Profile's reference). Kept as
        // written — a dangling id is an exact bypass at render time, and the
        // panel shows it as missing, so the user can re-point it.
        params[p.key] = typeof rawValue === 'string' ? rawValue.slice(0, 128) : '';
      } else if (p.type === 'text') {
        // Free text (ASCII's custom characters), capped at the field's maxLength.
        params[p.key] = typeof rawValue === 'string' ? rawValue.slice(0, p.maxLength || 200) : p.default;
      } else if (p.type === 'easing') {
        // A named easing (Strip's entrance/outro): one of the param's options, else its default.
        params[p.key] = sanitizeEffectEasing(rawValue, p);
      } else {
        params[p.key] = sanitizeNumber(rawValue, p.default, { min: p.min, max: p.max });
      }
    }
    const eff = {
      id: def.id,
      // Stable instance id (keyframe tracks reference it). Backfilled for projects
      // saved before effect keyframing shipped.
      eid: typeof raw.eid === 'string' && raw.eid ? raw.eid : makeEid(),
      enabled: raw.enabled !== false,
      mix: sanitizeNumber(raw.mix, 100, { min: 0, max: 100 }),
      params,
    };
    if (def.isCustom) {
      const code = typeof raw.code === 'string' ? raw.code.slice(0, MAX_CUSTOM_EFFECT_CODE) : '';
      eff.code = code;
    }
    // Layer scope only: "Clip to layer" is stored ONLY when the user overrode the
    // registry default, so an untouched effect entry keeps its exact saved shape and
    // a later change to that default still reaches existing projects.
    if (raw.clip === true || raw.clip === false) eff.clip = raw.clip;
    // Render this entry INSIDE a 3D model layer's own pass (model3dFx.js) instead
    // of on its flat picture. Written only when true, so a project that never used
    // it saves byte-identically; ignored on any other layer type.
    if (raw.real3d === true) eff.real3d = true;
    // Active range, in clip-local seconds. Same rule: written only when the user
    // actually scoped the effect, so an un-windowed effect saves byte-identically
    // to before this feature and keeps meaning "the whole layer".
    if (Number.isFinite(raw.start)) eff.start = Math.max(0, Number(raw.start));
    if (Number.isFinite(raw.end)) eff.end = Math.max(0, Number(raw.end));
    // An inverted window would bypass the effect for the entire clip, which reads
    // as a broken render — drop both and fall back to "whole layer".
    if (Number.isFinite(eff.start) && Number.isFinite(eff.end) && eff.end <= eff.start) {
      delete eff.start;
      delete eff.end;
    }
    /*
     * Object effects carry their OWN subject scan, TOP-LEVEL on the entry like
     * start/end — not in `params`, which the panel's projection and the keyframe
     * machinery both treat as scalars. Written only when a scan has been run, so
     * an un-scanned entry saves byte-identically to any other effect.
     *
     * The sanitizer VALIDATES every sample's field against w*h and drops the whole
     * track if any of them is short: half a track renders as a subject that
     * teleports, which reads as a render bug instead of "re-scan this".
     */
    if (def.usesTrack && raw.track) {
      const track = sanitizeObjectTrack(raw.track);
      if (track) eff.track = track;
    }
    out.push(eff);
  }
  return out;
}

// 3D model layers. Everything about how the asset is fitted, lit and animated lives in
// one block attached ONLY to model items, so every other layer keeps its exact saved
// shape (an always-present field would make the first save of an old project read as a
// real content change to every other open window).
export const MODEL_FITS = ['height', 'width', 'unit'];

// 'origin' keeps the asset's own origin as the pivot (no bbox recentring), so a GLB
// exported in scene coordinates lands exactly where its scene put it.
export const MODEL_ANCHORS = ['center', 'base', 'origin'];

// Media on named meshes of ANY model (model3dConfig.screens). 'stretch' fills the
// mesh's own UVs exactly; cover/contain fit the media into a canvas of `aspect`.
export const MODEL_SCREEN_FITS = ['stretch', 'cover', 'contain'];
export const MODEL_SCREEN_UVS = ['mesh', 'planar'];
export const MODEL_SCREEN_SHADING = ['screen', 'lit'];
export const MODEL_SCREENS_MAX = 8;

function sanitizeModelScreens(list) {
  if (!Array.isArray(list)) return [];
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const name = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 128) : null);
  return list.slice(0, MODEL_SCREENS_MAX).reduce((out, s) => {
    if (!s || typeof s !== 'object' || typeof s.url !== 'string' || !s.url) return out;
    const material = name(s.material);
    const node = name(s.node);
    if (!material && !node) return out;
    out.push({
      url: s.url.slice(0, 4096),
      ...(material ? { material } : {}),
      ...(node ? { node } : {}),
      fitMode: pick(s.fitMode, MODEL_SCREEN_FITS, 'stretch'),
      ...(Number.isFinite(s.aspect) && s.aspect > 0 ? { aspect: sanitizeNumber(s.aspect, 16 / 9, { min: 0.1, max: 10 }) } : {}),
      uv: pick(s.uv, MODEL_SCREEN_UVS, 'mesh'),
      shading: pick(s.shading, MODEL_SCREEN_SHADING, 'screen'),
      scale: sanitizeNumber(s.scale, 1, { min: 0.1, max: 5 }),
      offsetX: sanitizeNumber(s.offsetX, 0, { min: -1, max: 1 }),
      offsetY: sanitizeNumber(s.offsetY, 0, { min: -1, max: 1 }),
      rotation: sanitizeNumber(s.rotation, 0, { min: -180, max: 180 }),
      padding: sanitizeNumber(s.padding, 0, { min: 0, max: 0.45 }),
      borderRadius: sanitizeNumber(s.borderRadius, 0, { min: 0, max: 0.5 }),
      // Video: seconds into the media at the layer's first frame, and whether it loops.
      offset: sanitizeNumber(s.offset, 0, { min: -600, max: 600 }),
      loop: s.loop !== false,
      mirrorX: s.mirrorX === true,
      flipY: s.flipY === true,
      // A self-lit screen that still takes the Scene Rig's shadows. Only stored when on.
      ...(s.receiveShadow === true ? { receiveShadow: true } : {}),
    });
    return out;
  }, []);
}

export const MODEL_LOOPS = ['once', 'loop', 'pingpong'];

// Particle Solver layers. Like model3dConfig below, the whole block attaches ONLY
// to items that carry it: an always-present field would make the first save of an
// old project read as a real content change in every other open window.
//
// The bake cache, render targets and runtime hashes are deliberately NOT part of
// this — nothing derived from the simulation may reach project JSON, undo history,
// the clipboard or autosave.
export function sanitizeParticleSystemField(item) {
  const raw = item?.particleSystem;
  if (!raw || typeof raw !== 'object') return {};
  return { particleSystem: sanitizeParticleSystem(raw) };
}

export function sanitizeModel3dConfig(item) {
  const raw = item?.model3dConfig;
  if (!raw || typeof raw !== 'object') return {};
  const D = MODEL_CONFIG_DEFAULTS;
  const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const rot = raw.baseRotation && typeof raw.baseRotation === 'object' ? raw.baseRotation : {};
  const env = raw.env && typeof raw.env === 'object' ? raw.env : {};
  const lights = raw.lights && typeof raw.lights === 'object' ? raw.lights : {};
  const anim = raw.animation && typeof raw.animation === 'object' ? raw.animation : {};
  const shadow = raw.shadow && typeof raw.shadow === 'object' ? raw.shadow : {};
  return {
    model3dConfig: {
      // Where the geometry comes from: a bundled device, a procedural shape, or the
      // layer's own upload.
      source: raw.source === 'preset' || raw.source === 'primitive' ? raw.source : 'custom',
      preset: typeof raw.preset === 'string' && raw.preset ? raw.preset : null,
      // A procedural shape (model3dPrimitives.js): which one, its colour, and — for
      // Text — the string it spells.
      ...(raw.source === 'primitive'
        ? {
            primitive: {
              kind: isPrimitiveKind(raw.primitive?.kind) ? raw.primitive.kind : 'cube',
              color: typeof raw.primitive?.color === 'string' && raw.primitive.color.trim()
                ? raw.primitive.color.trim().slice(0, 64) : PRIMITIVE_DEFAULT_COLOR,
              text: typeof raw.primitive?.text === 'string' && raw.primitive.text.trim()
                ? raw.primitive.text.slice(0, 40) : PRIMITIVE_DEFAULT_TEXT,
            },
          }
        : {}),
      // Artwork on a preset device's screen: the media url plus the same framing
      // options the Mockup builder exposes. Only stored when there IS artwork.
      ...(typeof raw.screen?.url === 'string' && raw.screen.url
        ? {
            screen: {
              url: raw.screen.url,
              scale: sanitizeNumber(raw.screen.scale, 1, { min: 0.1, max: 5 }),
              offsetX: sanitizeNumber(raw.screen.offsetX, 0, { min: -1, max: 1 }),
              offsetY: sanitizeNumber(raw.screen.offsetY, 0, { min: -1, max: 1 }),
              rotation: sanitizeNumber(raw.screen.rotation, 0, { min: -180, max: 180 }),
              padding: sanitizeNumber(raw.screen.padding, 0, { min: 0, max: 0.45 }),
              fitMode: raw.screen.fitMode === 'contain' ? 'contain' : 'cover',
              borderRadius: sanitizeNumber(raw.screen.borderRadius, 0, { min: 0, max: 0.5 }),
            },
          }
        : {}),
      // Media on named meshes/materials of any model (preset or custom) — panels,
      // TVs, phones inside a scene. Only stored when there is at least one.
      ...(() => {
        const screens = sanitizeModelScreens(raw.screens);
        return screens.length ? { screens } : {};
      })(),
      fit: pick(raw.fit, MODEL_FITS, D.fit),
      // In 'unit' mode this is pixels-per-model-unit, which can legitimately be large.
      fitValue: sanitizeNumber(raw.fitValue, D.fitValue, { min: 0.01, max: 10000 }),
      anchor: pick(raw.anchor, MODEL_ANCHORS, D.anchor),
      placeOnRigFloor: raw.placeOnRigFloor !== false,
      // With a Scene Rig: whether the model casts into / receives from its shadow map.
      // Both default on, and are only stored when switched off.
      ...(raw.castShadow === false ? { castShadow: false } : {}),
      ...(raw.receiveShadow === false ? { receiveShadow: false } : {}),
      baseRotation: {
        x: sanitizeNumber(rot.x, 0, { min: -360, max: 360 }),
        y: sanitizeNumber(rot.y, 0, { min: -360, max: 360 }),
        z: sanitizeNumber(rot.z, 0, { min: -360, max: 360 }),
      },
      env: {
        hdr: typeof env.hdr === 'string' && env.hdr ? env.hdr : D.env.hdr,
        intensity: sanitizeNumber(env.intensity, D.env.intensity, { min: 0, max: 5 }),
        exposure: sanitizeNumber(env.exposure, D.env.exposure, { min: 0.05, max: 8 }),
        rotation: sanitizeNumber(env.rotation, D.env.rotation, { min: -360, max: 360 }),
      },
      lights: {
        key: sanitizeNumber(lights.key, D.lights.key, { min: 0, max: 10 }),
        fill: sanitizeNumber(lights.fill, D.lights.fill, { min: 0, max: 10 }),
        rim: sanitizeNumber(lights.rim, D.lights.rim, { min: 0, max: 10 }),
      },
      animation: {
        // null = "no clip chosen"; a name is whatever the glTF declared; '*' plays
        // every clip together (a scene exported with one action per object).
        clip: typeof anim.clip === 'string' && anim.clip ? anim.clip : null,
        speed: sanitizeNumber(anim.speed, D.animation.speed, { min: -8, max: 8 }),
        loop: pick(anim.loop, MODEL_LOOPS, D.animation.loop),
        offset: sanitizeNumber(anim.offset, D.animation.offset, { min: -600, max: 600 }),
      },
      shadow: {
        enabled: shadow.enabled === true,
        opacity: sanitizeNumber(shadow.opacity, D.shadow.opacity, { min: 0, max: 1 }),
        blur: sanitizeNumber(shadow.blur, D.shadow.blur, { min: 0, max: 10 }),
      },
    },
  };
}

// Grid layers: the layout rule. It lives on the ITEM rather than the clip for the
// same reason motionTemplateId/motionParams do — it must be per-instance and
// keyframable (`gr:<key>` tracks). normalizeGridConfig fills in every field and
// clamps every value, so a hand-edited or agent-authored config is always
// renderable. Only attached to items that actually carry one, so every other
// layer keeps its exact saved shape.
export function sanitizeGridConfig(item) {
  if (!item?.gridConfig || typeof item.gridConfig !== 'object') return {};
  return { gridConfig: normalizeGridConfig(item.gridConfig) };
}

// Motion-template params are an arbitrary flat bag of primitives (text/color/number/
// bool) declared by each template's `fields`. Keep only JSON-safe primitives so the
// value round-trips cleanly through save/reload.
export function sanitizeMotionParams(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  const isPrimitive = (x) => typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x));
  for (const [k, v] of Object.entries(raw)) {
    if (isPrimitive(v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter(isPrimitive); // e.g. selectedAnimations
  }
  return out;
}

// Saved AI-wizard analysis riding on the item (aiData.shorts/beats/reframe) —
// reopening the wizard offers "use saved or regenerate". JSON-guarded and
// size-capped so a corrupt or bloated blob can't poison the project state.
export const AI_DATA_KINDS = ['shorts', 'beats', 'reframe', 'transcribe', 'sound'];

export const AI_DATA_MAX_JSON = 2_000_000;

export function sanitizeAiData(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const kind of AI_DATA_KINDS) {
    const entry = raw[kind];
    if (!entry || typeof entry !== 'object') continue;
    try {
      const json = JSON.stringify(entry);
      if (json.length > AI_DATA_MAX_JSON) continue;
      out[kind] = JSON.parse(json);
    } catch { /* non-serializable — drop */ }
  }
  return Object.keys(out).length ? { aiData: out } : {};
}

export function sanitizeTimelineItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.clipId !== 'string' || !item.clipId) return null;

  // Builds a FRESH object — any key not listed here is silently dropped on the
  // next save/load round-trip, so every new builder field needs a line.
  const sanitizeCustomEnum = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
  const sanitizeCustomLayerConfig = (raw, { defaultOpacity = 0 } = {}) => ({
    moveX: sanitizeNumber(raw?.moveX, 0, { min: -200, max: 200 }),
    moveY: sanitizeNumber(raw?.moveY, 0, { min: -200, max: 200 }),
    scaleFrom: sanitizeNumber(raw?.scaleFrom, 1, { min: 0.1, max: 3 }),
    opacityFrom: sanitizeNumber(raw?.opacityFrom, defaultOpacity, { min: 0, max: 1 }),
    rotateX: sanitizeNumber(raw?.rotateX, 0, { min: -180, max: 180 }),
    rotateY: sanitizeNumber(raw?.rotateY, 0, { min: -180, max: 180 }),
    rotation: sanitizeNumber(raw?.rotation, 0, { min: -360, max: 360 }),
    originX: sanitizeNumber(raw?.originX, 50, { min: 0, max: 100 }),
    originY: sanitizeNumber(raw?.originY, 50, { min: 0, max: 100 }),
    tile: !!raw?.tile,
    // Per-layer builder effects (fx*). Amount 0 = OFF for every group, so a
    // config saved before these keys existed keeps behaving exactly as it did.
    fxZoom: sanitizeNumber(raw?.fxZoom, 0, { min: -300, max: 300 }),
    fxPointX: sanitizeNumber(raw?.fxPointX, 50, { min: 0, max: 100 }),
    fxPointY: sanitizeNumber(raw?.fxPointY, 50, { min: 0, max: 100 }),
    fxBlur: sanitizeNumber(raw?.fxBlur, 0, { min: 0, max: 60 }),
    fxBlurType: sanitizeCustomEnum(raw?.fxBlurType, ['gaussian', 'directional', 'radial'], 'gaussian'),
    fxRgbSplit: sanitizeNumber(raw?.fxRgbSplit, 0, { min: 0, max: 300 }),
    fxRgbAlong: sanitizeCustomEnum(raw?.fxRgbAlong, ['motion', 'horizontal', 'radial'], 'motion'),
    fxOptics: sanitizeNumber(raw?.fxOptics, 0, { min: -200, max: 200 }),
    fxOpticsFit: raw?.fxOpticsFit !== false,
    fxFisheye: sanitizeNumber(raw?.fxFisheye, 0, { min: -200, max: 200 }),
    fxFisheyeModel: sanitizeCustomEnum(raw?.fxFisheyeModel, ['spherical', 'barrel'], 'spherical'),
    fxFisheyeCentre: sanitizeCustomEnum(raw?.fxFisheyeCentre, ['point', 'frame'], 'point'),
    fxFisheyeFit: raw?.fxFisheyeFit !== false,
    fxFlash: sanitizeNumber(raw?.fxFlash, 0, { min: 0, max: 200 }),
    fxFlashColor: typeof raw?.fxFlashColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.fxFlashColor)
      ? raw.fxFlashColor.toLowerCase()
      : '#ffffff',
    fxOpacityDip: sanitizeNumber(raw?.fxOpacityDip, 0, { min: 0, max: 100 }),
    fxWiggle: sanitizeNumber(raw?.fxWiggle, 0, { min: 0, max: 100 }),
    fxWiggleFreq: sanitizeNumber(raw?.fxWiggleFreq, 14, { min: 1, max: 40 }),
    fxWiggleRotate: sanitizeNumber(raw?.fxWiggleRotate, 1.6, { min: 0, max: 8 }),
    fxWiggleSeed: sanitizeNumber(raw?.fxWiggleSeed, 7, { min: 1, max: 99 }),
    fxProfile: sanitizeCustomEnum(raw?.fxProfile, ['ramp', 'peak', 'constant'], 'ramp'),
  });

  const sanitizeCrossCustomConfig = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    // Backward compatibility: previous versions stored one flat custom config.
    if (!raw.prev && !raw.next) {
      return {
        prev: sanitizeCustomLayerConfig({}, { defaultOpacity: 0 }),
        next: sanitizeCustomLayerConfig(raw, { defaultOpacity: 0 }),
      };
    }
    return {
      prev: sanitizeCustomLayerConfig(raw.prev, { defaultOpacity: 0 }),
      next: sanitizeCustomLayerConfig(raw.next, { defaultOpacity: 0 }),
    };
  };

  // Voice-synced captions: one timing entry per whitespace word of textContent
  // (item-source-local ms). The Player ignores them unless the count still
  // matches the text, so a stale list is harmless — but it must persist.
  const wordTimings = sanitizeWordTimings(item.textWordTimings);

  // Overlay Effects use item.effects on both regular and adjustment layers. Layer
  // Effects (Running Glow / 3D Depth) have their own typed item.layerEffects array.
  // Neon Glow lived in layerEffects from 8.6.43 to 8.6.46 ('pathEffects', then
  // 'neonGlow'); it is an Overlay Effect now, so a legacy entry is lifted into
  // the chain (its pathAmount becomes the chain's per-effect mix) before both
  // arrays sanitize. sanitizeLayerEffectChain no longer knows the old ids, so
  // the source entry simply drops out of layerEffects.
  let rawEffects = item.effects;
  const legacyNeon = Array.isArray(item.layerEffects)
    ? item.layerEffects.find((e) => e && (e.id === 'neonGlow' || e.id === 'pathEffects'))
    : null;
  if (legacyNeon && !(Array.isArray(rawEffects) && rawEffects.some((e) => e?.id === 'neonGlow'))) {
    const migrated = {
      id: 'neonGlow',
      eid: typeof legacyNeon.eid === 'string' && legacyNeon.eid ? legacyNeon.eid : undefined,
      enabled: legacyNeon.enabled !== false,
      mix: sanitizeNumber(legacyNeon.params?.pathAmount, 100, { min: 0, max: 100 }),
      params: { ...(legacyNeon.params || {}) },
    };
    delete migrated.params.pathAmount;
    rawEffects = Array.isArray(rawEffects) ? [...rawEffects, migrated] : [migrated];
  }
  // Corner Pin shipped as an OVERLAY effect in 9.6.32 and became a typed Layer Effect
  // in 9.6.38 (it needed an on-canvas control, which the chain has no notion of). The
  // reverse of the neonGlow migration above: lift the entry out of `effects` into
  // `layerEffects`, rescaling its 0–1 corner fractions to the percent-of-box units every
  // other warp uses, and rename its `fx:<eid>:<param>` tracks to plain `cp*` ones so a
  // keyed pin keeps animating.
  let rawLayerEffects = item.layerEffects;
  let migratedPinKeyframes = item.propertyKeyframes;
  const legacyPin = Array.isArray(rawEffects) ? rawEffects.find((e) => e?.id === CORNER_PIN_LAYER_EFFECT_ID) : null;
  if (legacyPin && !(Array.isArray(rawLayerEffects) && rawLayerEffects.some((e) => e?.id === CORNER_PIN_LAYER_EFFECT_ID))) {
    rawEffects = rawEffects.filter((e) => e !== legacyPin);
    const OVERLAY_KEYS = { cpULX: 'ulX', cpULY: 'ulY', cpURX: 'urX', cpURY: 'urY', cpLRX: 'lrX', cpLRY: 'lrY', cpLLX: 'llX', cpLLY: 'llY' };
    const params = {};
    for (const f of CP_NUMBER_FIELDS) {
      const raw = Number(legacyPin.params?.[OVERLAY_KEYS[f.key]]);
      params[f.key] = Number.isFinite(raw) ? Math.max(f.min, Math.min(f.max, raw * 100)) : CP_IDENTITY[f.key];
    }
    const migrated = {
      id: CORNER_PIN_LAYER_EFFECT_ID,
      ...(typeof legacyPin.eid === 'string' && legacyPin.eid ? { eid: legacyPin.eid } : {}),
      enabled: legacyPin.enabled !== false,
      params,
    };
    rawLayerEffects = Array.isArray(rawLayerEffects) ? [...rawLayerEffects, migrated] : [migrated];
    // Keyed corners: `fx:<eid>:ulX` at 0–1 becomes `cpULX` at percent.
    const tracks = migratedPinKeyframes;
    if (legacyPin.eid && tracks && typeof tracks === 'object') {
      const next = { ...tracks };
      let changed = false;
      for (const [cpKey, overlayKey] of Object.entries(OVERLAY_KEYS)) {
        const old = next[`fx:${legacyPin.eid}:${overlayKey}`];
        if (!Array.isArray(old) || !old.length) continue;
        delete next[`fx:${legacyPin.eid}:${overlayKey}`];
        if (!Array.isArray(next[cpKey]) || !next[cpKey].length) {
          next[cpKey] = old.map((k) => ({ ...k, value: String((Number(k?.value) || 0) * 100) }));
        }
        changed = true;
      }
      if (changed) migratedPinKeyframes = next;
    }
  }
  const overlayEffects = sanitizeEffectChain(rawEffects);
  const sanitizedPropertyKeyframes = sanitizePropertyKeyframes(migratedPinKeyframes, overlayEffects, item);
  const sanitizedPropertyKeyframeFx = sanitizeKeyframeFxMap(item.propertyKeyframeFx, sanitizedPropertyKeyframes);
  // Hidden (Keyframe Builder "hide") tracks hold the same kind of keys, so the
  // same rules apply — including dropping orphans whose effect is gone.
  const sanitizedHiddenKeyframes = sanitizePropertyKeyframes(item.hiddenPropertyKeyframes, overlayEffects, item);
  const sanitizedHiddenKeyframeFx = sanitizeKeyframeFxMap(item.hiddenPropertyKeyframeFx, sanitizedHiddenKeyframes);
  const layerEffects = sanitizeLayerEffectChain(rawLayerEffects);
  const adjustmentLut = sanitizeEffectLut(item.lut);
  const keyframeParenting = sanitizeParentingField(item);
  const trackMatte = sanitizeTrackMatteField(item);
  const hasCameraFields = CAMERA_KF_LABELS.some((key) => Object.prototype.hasOwnProperty.call(item, key));
  // Renamed transitions resolve through the alias map FIRST. Without that, a
  // project saved under the old name fails the whitelist below and silently
  // loses its transition instead of being migrated.
  // The old per-direction names (Slide Left, Push Up, Wipe Down …) become the
  // merged type with its direction here; the next save writes the new shape.
  const crossSlot = migrateDirectionalTransition(resolveTransitionType(item.transition), item.transitionOptions);
  const inSlot = migrateDirectionalTransition(item.transitionInType, item.transitionInOptions, 'in');
  const outSlot = migrateDirectionalTransition(item.transitionOutType, item.transitionOutOptions, 'out');
  const savedTransition = crossSlot.type;
  const transitionType = Object.values(TransitionType).includes(savedTransition) || isLocalAdvancedTransitionType(savedTransition)
    ? savedTransition
    : TransitionType.NONE;
  const advancedTransitionOptions = sanitizePersistedTransitionOptions(transitionType, crossSlot.options);
  // Advanced Zoom / Advanced Movement / 3D Carousel are also layer entrances and
  // exits, and they carry the SAME option schema there as on the cross slot.
  // sanitizePersistedTransitionOptions returns null for every plain layer type,
  // so ordinary items keep their saved shape.
  const layerTransitionInType = Object.values(LayerTransitionType).includes(inSlot.type)
    ? inSlot.type
    : LayerTransitionType.NONE;
  const layerTransitionOutType = Object.values(LayerTransitionType).includes(outSlot.type)
    ? outSlot.type
    : LayerTransitionType.NONE;
  const transitionInOptions = sanitizePersistedTransitionOptions(layerTransitionInType, inSlot.options);
  const transitionOutOptions = sanitizePersistedTransitionOptions(layerTransitionOutType, outSlot.options);

  const rawTracks = Array.isArray(item.motionTracks) ? item.motionTracks : [];
  const motionTracks = sanitizeMotionTracks(rawTracks);
  const motionFollow = item.motionFollow ? sanitizeMotionFollow(item.motionFollow) : null;
  const videoStabilization = sanitizeVideoStabilization(item.videoStabilization);
  // Color Correction: kept only when something is off its default.
  const colorCorrection = sanitizeColorCorrection(item.colorCorrection);

  return {
    id: typeof item.id === 'string' && item.id ? item.id : createId(),
    clipId: item.clipId,
    // Free-position start time for items in unsnapped channels; only present
    // when the channel is unsnapped, so don't invent a default.
    ...(Number.isFinite(item.freeStart) ? { freeStart: Math.max(0, item.freeStart) } : {}),
    // Custom layer title (user- or agent-set), shown on the timeline clip in
    // place of the clip/media name. Empty means "use the default name".
    ...(typeof item.customName === 'string' && item.customName.trim() ? { customName: item.customName.trim().slice(0, 120) } : {}),
    // AI Fill: keep the zone tag on a persisted spacer item so a saved (unapplied)
    // zone stays selectable/manipulable after reload.
    ...(typeof item.aiFillZoneId === 'string' && item.aiFillZoneId ? { aiFillZoneId: item.aiFillZoneId } : {}),
    // Roto ▸ SAM 3 "Replace clip": the clip this layer played before, for Restore original.
    ...(typeof item.samSourceClipId === 'string' && item.samSourceClipId ? { samSourceClipId: item.samSourceClipId } : {}),
    // AI Reframe: the cut tag that links a materialized item back to its solved crop.
    ...(typeof item.aiReframeId === 'string' && item.aiReframeId ? { aiReframeId: item.aiReframeId } : {}),
    // AI Beats: sibling tag shared by the pieces of one cut-by-beats run.
    ...(typeof item.aiBeatsGroup === 'string' && item.aiBeatsGroup ? { aiBeatsGroup: item.aiBeatsGroup } : {}),
    // HyperFrames: the html item whose composition sound this audio layer was added with
    // (Convert to scenes replaces it; hyperframesClips.js hyperframesOwnSoundItems).
    ...(typeof item.hyperframesSoundOf === 'string' && item.hyperframesSoundOf ? { hyperframesSoundOf: item.hyperframesSoundOf } : {}),
    // Saved AI analysis (shorts/beats/reframe) for the reuse-or-regenerate flow.
    ...sanitizeAiData(item.aiData),
    transition: transitionType,
    transitionDuration: sanitizeNumber(item.transitionDuration, 1, {
      min: 0.05,
      max: isLocalAdvancedTransitionType(transitionType) ? ADVANCED_TRANSITION_MAX_DURATION : 4,
    }),
    transitionEasing: Object.values(TransitionEasing).includes(item.transitionEasing) ? item.transitionEasing : TransitionEasing.EASE_IN_OUT,
    // Which clip animates over which. Only written when it is off the default,
    // so a project that never touched it round-trips byte-identical.
    ...(item.transitionOrder === TransitionOrder.PREV_OVER_NEXT
      ? { transitionOrder: TransitionOrder.PREV_OVER_NEXT }
      : {}),
    ...(advancedTransitionOptions ? { transitionOptions: advancedTransitionOptions } : {}),
    trimStart: sanitizeNumber(item.trimStart, 0, { min: 0 }),
    trimEnd: sanitizeNumber(item.trimEnd, FALLBACK_CLIP_DURATION_SECONDS, { min: 0.1 }),
    // Derived from the `speed` track whenever the clip has one, so a hand-edited
    // (or older) file can never load a curve that disagrees with its keys.
    speedPoints: sanitizeSpeedPoints(
      deriveSpeedPoints({ propertyKeyframes: sanitizedPropertyKeyframes }, resolveKeyEase)
      || item.speedPoints,
    ),
    // 20x, matching the keyframable `scale` in keyframeProps.js — the two are the
    // same property, and a static Scale the sanitizer clipped back to 3 on the
    // next save could not reach what an animated one already could.
    zoom: sanitizeNumber(item.zoom, 1, { min: 0.1, max: 20 }),
    // Per-axis Scale X/Y ride ON TOP of the uniform Scale above, so both default
    // to 1 and an older project loads byte-identical. Same 0.1–20 range as `zoom`
    // and as the keyframable scaleX/scaleY in keyframeProps.js.
    scaleX: sanitizeNumber(item.scaleX, 1, { min: 0.1, max: 20 }),
    scaleY: sanitizeNumber(item.scaleY, 1, { min: 0.1, max: 20 }),
    // Position X/Y (% of the frame) are unbounded: a layer can legitimately sit
    // or travel any distance off-frame, and a clamp tighter than the gesture or
    // the typed number just snaps it back on the next save with no explanation.
    // Z keeps a range wide enough for a 3D-view drag far up/down the depth axis.
    panX: sanitizeNumber(item.panX, 0),
    panY: sanitizeNumber(item.panY, 0),
    panZ: sanitizeNumber(item.panZ, 0, { min: -3000, max: 3000 }),
    motionPathT: sanitizeNumber(item.motionPathT, 0, { min: 0, max: 100 }),
    // The path and its offsets travel together: with no path the offsets have
    // nothing to displace, so they are not worth storing on every other layer.
    ...(item.motionPath ? {
      motionPath: sanitizeObjectMotionPath(item.motionPath),
      motionPathOffsetX: sanitizeNumber(item.motionPathOffsetX, 0, { min: -10000, max: 10000 }),
      motionPathOffsetY: sanitizeNumber(item.motionPathOffsetY, 0, { min: -10000, max: 10000 }),
      motionPathOffsetZ: sanitizeNumber(item.motionPathOffsetZ, 0, { min: -10000, max: 10000 }),
    } : {}),
    rotateX: sanitizeNumber(item.rotateX, 0, { min: -180, max: 180 }),
    rotateY: sanitizeNumber(item.rotateY, 0, { min: -180, max: 180 }),
    rotateZ: sanitizeNumber(item.rotateZ, sanitizeNumber(item.rotation, 0, { min: -180, max: 180 }), { min: -180, max: 180 }),
    rotation: sanitizeNumber(item.rotation, 0, { min: -180, max: 180 }),
    filterBlur: sanitizeNumber(item.filterBlur, 0, { min: 0, max: 10 }),
    filterBrightness: sanitizeNumber(item.filterBrightness, 100, { min: 0, max: 200 }),
    filterContrast: sanitizeNumber(item.filterContrast, 100, { min: 0, max: 200 }),
    filterSaturation: sanitizeNumber(item.filterSaturation, 100, { min: 0, max: 200 }),
    filterHueRotate: sanitizeNumber(item.filterHueRotate, 0, { min: 0, max: 360 }),
    filterGrayscale: sanitizeNumber(item.filterGrayscale, 0, { min: 0, max: 100 }),
    filterSepia: sanitizeNumber(item.filterSepia, 0, { min: 0, max: 100 }),
    filterInvert: sanitizeNumber(item.filterInvert, 0, { min: 0, max: 100 }),
    opacity: sanitizeNumber(item.opacity, 100, { min: 0, max: 100 }),
    blendMode: BLEND_MODES.includes(item.blendMode) ? item.blendMode : 'normal',
    mirrorH: !!item.mirrorH,
    mirrorV: !!item.mirrorV,
    muted: !!item.muted,
    // Sound volume 0–100% (default 100). Applies to clips with audio (video + audio).
    volume: sanitizeNumber(item.volume, 100, { min: 0, max: 100 }),
    // Audio intro/outro fade (seconds of the placed span; 0 = off). Stored only
    // when set so untouched items keep their saved shape; the curve only exists
    // alongside a fade and only when it differs from the 'smooth' default.
    ...(Number(item.audioFadeIn) > 0 ? { audioFadeIn: sanitizeNumber(item.audioFadeIn, 0, { min: 0, max: 600 }) } : {}),
    ...(Number(item.audioFadeOut) > 0 ? { audioFadeOut: sanitizeNumber(item.audioFadeOut, 0, { min: 0, max: 600 }) } : {}),
    ...(AUDIO_FADE_CURVES.includes(item.audioFadeCurve) && item.audioFadeCurve !== 'smooth'
      ? { audioFadeCurve: item.audioFadeCurve } : {}),
    // Volume to restore when un-muting via the "M" shortcut; only present while muted.
    ...(Number.isFinite(item.preMuteVolume) ? { preMuteVolume: sanitizeNumber(item.preMuteVolume, 100, { min: 0, max: 800 }) } : {}),
    // Animated raster playback (GIF / animated WebP / APNG). Conditional spread so
    // the overwhelming majority of image layers — every still, and every GIF left on
    // its defaults — keep their saved shape byte for byte. WITHOUT these two lines
    // the fields survive in memory and are stripped on the next load, so the layer
    // silently reverts to looping at 1x with no error anywhere.
    ...(GIF_LOOP_MODES.includes(item.gifLoopMode) && item.gifLoopMode !== GIF_LOOP_MODE_DEFAULT
      ? { gifLoopMode: item.gifLoopMode } : {}),
    ...(Number.isFinite(Number(item.gifSpeed)) && Number(item.gifSpeed) !== GIF_SPEED_DEFAULT
      ? { gifSpeed: sanitizeNumber(item.gifSpeed, GIF_SPEED_DEFAULT, { min: GIF_SPEED_MIN, max: GIF_SPEED_MAX }) } : {}),
    propertyKeyframes: sanitizedPropertyKeyframes,
    // Track expressions (ƒx). Sanitized against the just-cleaned tracks, so a
    // config whose track was deleted dies here like orphaned effect tracks do;
    // conditional spread so the millions of items without one stay untouched.
    ...(hasAnyKeyframeFx(sanitizedPropertyKeyframeFx) ? { propertyKeyframeFx: sanitizedPropertyKeyframeFx } : {}),
    // Hidden tracks: parked outside propertyKeyframes, so nothing renders them.
    ...(Object.keys(sanitizedHiddenKeyframes).length ? { hiddenPropertyKeyframes: sanitizedHiddenKeyframes } : {}),
    ...(hasAnyKeyframeFx(sanitizedHiddenKeyframeFx) ? { hiddenPropertyKeyframeFx: sanitizedHiddenKeyframeFx } : {}),
    // Camera inspector base values. They are only written on camera items, so
    // ordinary media layers keep their saved shape; shared keyframe tracks with
    // these labels override the base values at render time.
    ...(hasCameraFields ? {
      camZoom: sanitizeNumber(item.camZoom, 1, { min: 0.1 }),
      camX: sanitizeNumber(item.camX, 0, { min: -200, max: 200 }),
      camY: sanitizeNumber(item.camY, 0, { min: -200, max: 200 }),
      camRoll: sanitizeNumber(item.camRoll, 0, { min: -180, max: 180 }),
      camDolly: sanitizeNumber(item.camDolly, 0, { min: -3000, max: 3000 }),
      camTiltX: sanitizeNumber(item.camTiltX, 0, { min: -60, max: 60 }),
      camTiltY: sanitizeNumber(item.camTiltY, 0, { min: -60, max: 60 }),
      camDofEnabled: item.camDofEnabled === true || Number(item.camDofEnabled) >= 0.5,
      camFocusDistance: sanitizeNumber(item.camFocusDistance, 0, { min: 0, max: 20000 }),
      camAperture: sanitizeNumber(item.camAperture, 24, { min: 0, max: 300 }),
      camBlurLevel: sanitizeNumber(item.camBlurLevel, 100, { min: 0, max: 300 }),
      camHighlightGain: sanitizeNumber(item.camHighlightGain, 0, { min: 0, max: 300 }),
      camFocusX: sanitizeNumber(item.camFocusX, 50, { min: 0, max: 100 }),
      camFocusY: sanitizeNumber(item.camFocusY, 50, { min: 0, max: 100 }),
      camFocusWidth: sanitizeNumber(item.camFocusWidth, 0, { min: 0, max: 200 }),
      camPathT: sanitizeNumber(item.camPathT, 0, { min: 0, max: 100 }),
      camPathOffsetX: sanitizeNumber(item.camPathOffsetX, 0, { min: -10000, max: 10000 }),
      camPathOffsetY: sanitizeNumber(item.camPathOffsetY, 0, { min: -10000, max: 10000 }),
      camPathOffsetZ: sanitizeNumber(item.camPathOffsetZ, 0, { min: -10000, max: 10000 }),
      camFollowTarget: sanitizeNumber(item.camFollowTarget, 1, { min: 1 }),
    } : {}),
    // The 3D camera path, when the clip has one. Points are world pixels, so it
    // has its own sanitizer rather than a numeric range.
    ...(item.cameraPath ? { cameraPath: sanitizeCameraPath(item.cameraPath) } : {}),
    // Motion tracking. Both fields are conditional spreads (absent by default,
    // like cameraPath) so nothing is added to the millions of items that have no
    // track. motionTracks is rebuilt from scratch — a malformed sample would
    // otherwise reach the transform chain as a NaN. motionFollow is deliberately
    // NOT checked for referential integrity: the target can be legitimately
    // missing mid-paste or mid-undo, and the resolver no-ops on a dangling link,
    // so verifying here would destroy intent a later edit would have restored.
    ...(motionTracks.length ? { motionTracks } : {}),
    ...(motionFollow ? { motionFollow } : {}),
    // Whole-shot stabilization is a private source-image warp. It is persisted
    // on the video item itself and intentionally has no migration or bridge to
    // motionTracks, motionFollow, cameraPath or a camera timeline item.
    ...(videoStabilization ? { videoStabilization } : {}),
    ...(colorCorrection && ccIsModified(colorCorrection) ? { colorCorrection } : {}),
    keyframeTransformOrigin: typeof item.keyframeTransformOrigin === 'string' && item.keyframeTransformOrigin.trim()
      ? item.keyframeTransformOrigin.trim()
      : 'center',
    transitionInType: layerTransitionInType,
    transitionInDuration: sanitizeNumber(item.transitionInDuration, 1, { min: 0.1, max: 3 }),
    transitionInEasing: Object.values(TransitionEasing).includes(item.transitionInEasing) ? item.transitionInEasing : TransitionEasing.EASE_IN_OUT,
    ...(transitionInOptions ? { transitionInOptions } : {}),
    customTransitionConfig: sanitizeCrossCustomConfig(item.customTransitionConfig),
    customTransitionInConfig: item.customTransitionInConfig ? sanitizeCustomLayerConfig(item.customTransitionInConfig, { defaultOpacity: 0 }) : null,
    transitionOutType: layerTransitionOutType,
    transitionOutDuration: sanitizeNumber(item.transitionOutDuration, 1, { min: 0.1, max: 3 }),
    transitionOutEasing: Object.values(TransitionEasing).includes(item.transitionOutEasing) ? item.transitionOutEasing : TransitionEasing.EASE_IN_OUT,
    ...(transitionOutOptions ? { transitionOutOptions } : {}),
    customTransitionOutConfig: item.customTransitionOutConfig ? sanitizeCustomLayerConfig(item.customTransitionOutConfig, { defaultOpacity: 0 }) : null,
    textContent: typeof item.textContent === 'string' ? item.textContent : DEFAULT_TEXT_LAYER_TEXT,
    textColor: typeof item.textColor === 'string' && item.textColor ? item.textColor : '#ffffff',
    textFontSize: sanitizeNumber(item.textFontSize, DEFAULT_TEXT_FONT_SIZE_PX, { min: TEXT_FONT_SIZE_PX_MIN, max: TEXT_FONT_SIZE_PX_MAX }),
    // Font size unit: absolute px (default) or % of the composition height.
    textFontSizeUnit: textFontSizeUnitOf(item),
    textFontSizePct: sanitizeNumber(item.textFontSizePct, DEFAULT_TEXT_FONT_SIZE_PCT, { min: TEXT_FONT_SIZE_PCT_MIN, max: TEXT_FONT_SIZE_PCT_MAX }),
    textFontFamily: typeof item.textFontFamily === 'string' && item.textFontFamily ? item.textFontFamily : DEFAULT_TEXT_FONT_FAMILY,
    textLineHeight: sanitizeNumber(item.textLineHeight, 1.15, { min: 0.7, max: 3 }),
    textLetterSpacing: sanitizeNumber(item.textLetterSpacing, 0, { min: -20, max: 80 }),
    textAlign: item.textAlign === 'left' || item.textAlign === 'right' ? item.textAlign : 'center',
    // Text box width (wrap width + left/right-align margin): % of the composition
    // width (default 86 — the legacy hard-coded box) or absolute composition px.
    textWidthUnit: item.textWidthUnit === 'px' ? 'px' : 'pct',
    textWidthPct: sanitizeNumber(item.textWidthPct, 86, { min: 5, max: 100 }),
    textWidthPx: Number.isFinite(item.textWidthPx) ? sanitizeNumber(item.textWidthPx, 40, { min: 40, max: 20000 }) : null,
    // white-space: nowrap — only explicit line breaks wrap.
    textNoWrap: !!item.textNoWrap,
    // Wrap ▸ Anywhere: a line may break between any two characters (mid-word).
    textWrapAnywhere: !!item.textWrapAnywhere,
    textFontWeight: sanitizeNumber(item.textFontWeight, DEFAULT_TEXT_FONT_WEIGHT, { min: 100, max: 900 }),
    textBgEnabled: !!item.textBgEnabled,
    textBgColor: typeof item.textBgColor === 'string' && item.textBgColor ? item.textBgColor : 'rgba(0,0,0,0.6)',
    textBgPadding: sanitizeNumber(item.textBgPadding, 16, { min: 0, max: 200 }),
    // Per-axis spacing; null inherits textBgPadding, so an agent that only sets
    // the legacy field still moves both axes.
    textBgPaddingX: Number.isFinite(item.textBgPaddingX) ? sanitizeNumber(item.textBgPaddingX, 16, { min: 0, max: 200 }) : null,
    textBgPaddingY: Number.isFinite(item.textBgPaddingY) ? sanitizeNumber(item.textBgPaddingY, 16, { min: 0, max: 200 }) : null,
    // null = automatic radius (min of padding, 40% of the font size, 40px) — the
    // look every project had before the field existed.
    textBgRadius: Number.isFinite(item.textBgRadius) ? sanitizeNumber(item.textBgRadius, 0, { min: 0, max: 200 }) : null,
    textBorderEnabled: !!item.textBorderEnabled,
    textBorderColor: typeof item.textBorderColor === 'string' && item.textBorderColor ? item.textBorderColor : '#ffffff',
    textBorderWidth: sanitizeNumber(item.textBorderWidth, 2, { min: 0.5, max: 40 }),
    textBorderStyle: TEXT_BORDER_STYLES.includes(item.textBorderStyle) ? item.textBorderStyle : 'solid',
    // Caption-bar reveal: In/Out animation for the background bars (type +
    // wipe/slide style + duration + easing each way). Easing stores the
    // TransitionEasing display value, same format as transitionInEasing.
    textBgInType: TEXT_BG_REVEAL_TYPES.includes(item.textBgInType) ? item.textBgInType : 'none',
    textBgInStyle: TEXT_BG_REVEAL_STYLES.includes(item.textBgInStyle) ? item.textBgInStyle : 'wipe',
    textBgInDelay: sanitizeNumber(item.textBgInDelay, 0, { min: 0, max: 4 }),
    textBgInGrowStart: sanitizeNumber(item.textBgInGrowStart, 0, { min: 0, max: 600 }),
    textBgInGrowAppear: TEXT_BG_GROW_APPEAR.includes(item.textBgInGrowAppear) ? item.textBgInGrowAppear : 'none',
    textBgInGrowAppearDuration: sanitizeNumber(item.textBgInGrowAppearDuration, 0.4, { min: 0.05, max: 4 }),
    textBgInGrowAppearEasing: Object.values(TransitionEasing).includes(item.textBgInGrowAppearEasing) ? item.textBgInGrowAppearEasing : TransitionEasing.EASE_OUT,
    textBgOutGrowStart: sanitizeNumber(item.textBgOutGrowStart, 0, { min: 0, max: 600 }),
    textBgOutGrowAppear: TEXT_BG_GROW_APPEAR.includes(item.textBgOutGrowAppear) ? item.textBgOutGrowAppear : 'none',
    textBgOutGrowAppearDuration: sanitizeNumber(item.textBgOutGrowAppearDuration, 0.4, { min: 0.05, max: 4 }),
    textBgOutGrowAppearEasing: Object.values(TransitionEasing).includes(item.textBgOutGrowAppearEasing) ? item.textBgOutGrowAppearEasing : TransitionEasing.EASE_IN,
    textBgInDuration: sanitizeNumber(item.textBgInDuration, 0.5, { min: 0.05, max: 4 }),
    textBgInEasing: Object.values(TransitionEasing).includes(item.textBgInEasing) ? item.textBgInEasing : TransitionEasing.EASE_OUT,
    textBgOutType: TEXT_BG_REVEAL_TYPES.includes(item.textBgOutType) ? item.textBgOutType : 'none',
    textBgOutStyle: TEXT_BG_REVEAL_STYLES.includes(item.textBgOutStyle) ? item.textBgOutStyle : 'wipe',
    textBgOutDuration: sanitizeNumber(item.textBgOutDuration, 0.4, { min: 0.05, max: 4 }),
    textBgOutEasing: Object.values(TransitionEasing).includes(item.textBgOutEasing) ? item.textBgOutEasing : TransitionEasing.EASE_IN,
    ...(wordTimings.length ? { textWordTimings: wordTimings } : {}),
    // Voice link (voiceSync.js): the layer whose speech the word times come from.
    ...(sanitizeVoiceSource(item.textVoiceSource) ? { textVoiceSource: sanitizeVoiceSource(item.textVoiceSource) } : {}),
    // Text doubles as a clipping mask: layers below only show inside the glyphs.
    textClipMask: !!item.textClipMask,
    // Text Randomizer — seeded per-word/letter/line variation of size, colour,
    // weight and italic. All plain fields (no keyframes); the seed keeps the
    // look stable across preview, scrubbing and out-of-order export frames.
    textRandomEnabled: !!item.textRandomEnabled,
    textRandomScope: ['words', 'lines', 'symbols'].includes(item.textRandomScope) ? item.textRandomScope : 'words',
    textRandomDist: ['uniform', 'gaussian', 'nth', 'wave'].includes(item.textRandomDist) ? item.textRandomDist : 'uniform',
    textRandomNth: sanitizeNumber(item.textRandomNth, 3, { min: 2, max: 12 }),
    textRandomSeed: sanitizeNumber(item.textRandomSeed, 7, { min: 0, max: 99999 }),
    textRandomSizeEnabled: item.textRandomSizeEnabled !== false,
    textRandomSizeMin: sanitizeNumber(item.textRandomSizeMin, 80, { min: 20, max: 300 }),
    textRandomSizeMax: sanitizeNumber(item.textRandomSizeMax, 145, { min: 20, max: 300 }),
    textRandomColorEnabled: item.textRandomColorEnabled !== false,
    textRandomColors: Array.isArray(item.textRandomColors)
      ? item.textRandomColors.filter((c) => typeof c === 'string' && c).slice(0, 12)
      : ['#33efab'],
    textRandomCoverage: sanitizeNumber(item.textRandomCoverage, 35, { min: 0, max: 100 }),
    textRandomWeightEnabled: item.textRandomWeightEnabled !== false,
    textRandomWeights: Array.isArray(item.textRandomWeights)
      ? item.textRandomWeights.map(Number).filter((w) => Number.isFinite(w) && w >= 100 && w <= 900).slice(0, 9)
      : [300, 700],
    textRandomItalicEnabled: !!item.textRandomItalicEnabled,
    textRandomItalicMode: item.textRandomItalicMode === 'all' ? 'all' : 'mix',
    textRandomItalicShare: sanitizeNumber(item.textRandomItalicShare, 30, { min: 0, max: 100 }),
    // Text on Path — glyphs distributed along the layer's motion path (the same
    // motionPath the object rides; Path Progress moves the run along the curve).
    textPathEnabled: !!item.textPathEnabled,
    textPathGrain: item.textPathGrain === 'words' ? 'words' : 'symbols',
    // Where the run sits and which way Path Progress carries it: 'center' is the
    // legacy middle anchor (follows textAlign), 'forward' starts on the first
    // point and travels to the last, 'backward' is the reverse.
    textPathDirection: ['forward', 'backward'].includes(item.textPathDirection) ? item.textPathDirection : 'center',
    // Where 100% leaves the run: 'fit' lands its far end on the far point (the
    // whole text stays on the path), 'through' carries its leading unit there.
    textPathTravel: item.textPathTravel === 'through' ? 'through' : 'fit',
    textPathSpacingMode: item.textPathSpacingMode === 'even' ? 'even' : 'natural',
    textPathSpread: sanitizeNumber(item.textPathSpread, 100, { min: 10, max: 400 }),
    textPathSpacing: sanitizeNumber(item.textPathSpacing, 0, { min: -200, max: 500 }),
    textPathTrimStart: sanitizeNumber(item.textPathTrimStart, 0, { min: 0, max: 100 }),
    textPathTrimEnd: sanitizeNumber(item.textPathTrimEnd, 100, { min: 0, max: 100 }),
    textPathOffsetY: sanitizeNumber(item.textPathOffsetY, 0, { min: -500, max: 500 }),
    textPathRotate: item.textPathRotate !== false,
    // Inline counters — {{{COUNTER:a-b}}} tokens in textContent (textCounter.js).
    // Percent fields (cascade, blur) are stored as the panel shows them.
    textCounterStyle: COUNTER_STYLES.includes(item.textCounterStyle) ? item.textCounterStyle : COUNTER_DEFAULTS.textCounterStyle,
    textCounterDelay: sanitizeNumber(item.textCounterDelay, COUNTER_DEFAULTS.textCounterDelay, { min: 0, max: 3600 }),
    textCounterDuration: sanitizeNumber(item.textCounterDuration, COUNTER_DEFAULTS.textCounterDuration, { min: 0.05, max: 600 }),
    // An enum KEY ('POWER3_OUT'); the keyframe-only curves have
    // no meaning for a timed count.
    textCounterEasing: typeof item.textCounterEasing === 'string' && TransitionEasing[item.textCounterEasing]
      && item.textCounterEasing !== 'CUSTOM' && item.textCounterEasing !== 'HOLD'
      ? item.textCounterEasing
      : COUNTER_DEFAULTS.textCounterEasing,
    textCounterStagger: sanitizeNumber(item.textCounterStagger, COUNTER_DEFAULTS.textCounterStagger, { min: 0, max: 10 }),
    textCounterWidth: item.textCounterWidth === 'fit' ? 'fit' : 'fixed',
    textCounterTabular: item.textCounterTabular !== false,
    textCounterTurns: Math.round(sanitizeNumber(item.textCounterTurns, COUNTER_DEFAULTS.textCounterTurns, { min: 0, max: 10 })),
    textCounterLand: ['left', 'right', 'together'].includes(item.textCounterLand) ? item.textCounterLand : COUNTER_DEFAULTS.textCounterLand,
    textCounterCascade: sanitizeNumber(item.textCounterCascade, COUNTER_DEFAULTS.textCounterCascade, { min: 0, max: 90 }),
    textCounterDirection: ['auto', 'up', 'down'].includes(item.textCounterDirection) ? item.textCounterDirection : COUNTER_DEFAULTS.textCounterDirection,
    textCounterBlur: sanitizeNumber(item.textCounterBlur, COUNTER_DEFAULTS.textCounterBlur, { min: 0, max: 100 }),
    // {{{CYCLE:a|b|c}}} — words taking turns (textPlaceholders.js).
    textCycleStyle: CYCLE_STYLES.includes(item.textCycleStyle) ? item.textCycleStyle : CYCLE_DEFAULTS.textCycleStyle,
    textCycleDelay: sanitizeNumber(item.textCycleDelay, CYCLE_DEFAULTS.textCycleDelay, { min: 0, max: 3600 }),
    textCycleHold: sanitizeNumber(item.textCycleHold, CYCLE_DEFAULTS.textCycleHold, { min: 0, max: 60 }),
    textCycleDuration: sanitizeNumber(item.textCycleDuration, CYCLE_DEFAULTS.textCycleDuration, { min: 0.05, max: 10 }),
    textCycleEasing: typeof item.textCycleEasing === 'string' && TransitionEasing[item.textCycleEasing]
      && item.textCycleEasing !== 'CUSTOM' && item.textCycleEasing !== 'HOLD'
      ? item.textCycleEasing
      : CYCLE_DEFAULTS.textCycleEasing,
    textCycleLoop: item.textCycleLoop !== false,
    textCycleWidth: item.textCycleWidth === 'fixed' ? 'fixed' : 'fit',
    textCycleDirection: item.textCycleDirection === 'down' ? 'down' : 'up',
    textCycleStagger: sanitizeNumber(item.textCycleStagger, CYCLE_DEFAULTS.textCycleStagger, { min: 0, max: 10 }),
    // {{{SCRAMBLE:text}}} — random characters decoding into the text.
    textScrambleDelay: sanitizeNumber(item.textScrambleDelay, SCRAMBLE_DEFAULTS.textScrambleDelay, { min: 0, max: 3600 }),
    textScrambleDuration: sanitizeNumber(item.textScrambleDuration, SCRAMBLE_DEFAULTS.textScrambleDuration, { min: 0.05, max: 60 }),
    textScrambleCharset: Object.hasOwn(SCRAMBLE_CHARSETS, item.textScrambleCharset) ? item.textScrambleCharset : SCRAMBLE_DEFAULTS.textScrambleCharset,
    textScrambleOrder: ['ltr', 'rtl', 'random'].includes(item.textScrambleOrder) ? item.textScrambleOrder : SCRAMBLE_DEFAULTS.textScrambleOrder,
    textScrambleRate: sanitizeNumber(item.textScrambleRate, SCRAMBLE_DEFAULTS.textScrambleRate, { min: 1, max: 60 }),
    shapeType: SHAPE_TYPES.includes(item.shapeType) ? item.shapeType : 'rectangle',
    shapeFillColor: typeof item.shapeFillColor === 'string' && item.shapeFillColor ? item.shapeFillColor : '#8b5cf6',
    shapeWidthPct: sanitizeNumber(item.shapeWidthPct, 40, { min: 1 }),
    shapeHeightPct: sanitizeNumber(item.shapeHeightPct, 40, { min: 1 }),
    // Size unit: '%' of the composition (legacy default) or absolute composition px.
    shapeSizeUnit: item.shapeSizeUnit === 'px' ? 'px' : 'pct',
    shapeWidthPx: Number.isFinite(item.shapeWidthPx) ? sanitizeNumber(item.shapeWidthPx, 1, { min: 1 }) : null,
    shapeHeightPx: Number.isFinite(item.shapeHeightPx) ? sanitizeNumber(item.shapeHeightPx, 1, { min: 1 }) : null,
    // Circle radius: % of the shorter composition side, or absolute px.
    shapeRadiusPct: sanitizeNumber(item.shapeRadiusPct, 20, { min: 1 }),
    shapeRadiusPx: Number.isFinite(item.shapeRadiusPx) ? sanitizeNumber(item.shapeRadiusPx, 1, { min: 1 }) : null,
    // Shape doubles as a clipping mask: layers below only show where the shape has coverage.
    shapeClipMask: !!item.shapeClipMask,
    // Shared by shape and text masks: flip the matte (knockout instead of reveal).
    clipMaskInvert: !!item.clipMaskInvert,
    // Custom shape: user-uploaded SVG stored as a data URI (travels with the project).
    shapeSvgUrl: typeof item.shapeSvgUrl === 'string' && item.shapeSvgUrl ? item.shapeSvgUrl : null,
    // Image → Vector workflow. Tracing is local and stateless, so only the user's
    // source, its silhouette preview and the editable outline travel with the project.
    shapeVectorSourceUrl: typeof item.shapeVectorSourceUrl === 'string' && item.shapeVectorSourceUrl ? item.shapeVectorSourceUrl : null,
    shapeVectorFileName: typeof item.shapeVectorFileName === 'string' ? item.shapeVectorFileName.slice(0, 240) : '',
    shapeVectorPathCount: sanitizeNumber(item.shapeVectorPathCount, 0, { min: 0, max: 100000 }),
    shapeVectorTrace: sanitizeVectorTrace(item.shapeVectorTrace),
    ...(item.shapeVectorEditablePath
      ? { shapeVectorEditablePath: sanitizeShapePath(item.shapeVectorEditablePath) }
      : {}),
    // Triangle: base direction + apex position along the opposite edge (50 = isosceles).
    shapeTriDirection: ['up', 'down', 'left', 'right'].includes(item.shapeTriDirection) ? item.shapeTriDirection : 'up',
    shapeTriApexPct: sanitizeNumber(item.shapeTriApexPct, 50, { min: 0, max: 100 }),
    // Arrow: head length + shaft thickness (% of the shape box).
    shapeArrowHeadPct: sanitizeNumber(item.shapeArrowHeadPct, 45, { min: 5, max: 90 }),
    shapeArrowShaftPct: sanitizeNumber(item.shapeArrowShaftPct, 42, { min: 2, max: 100 }),
    // Editable bezier outline ('path' / 'line'). Points are unit-box fractions, so
    // it has its own sanitizer rather than a numeric range — see shapePath.js.
    ...(item.shapePath ? { shapePath: sanitizeShapePath(item.shapePath) } : {}),
    // A closed editable path normally fills; vectorized outlines opt into Stroke
    // so Trim Paths can animate around a closed logo silhouette.
    shapePathRenderMode: item.shapePathRenderMode === 'stroke' ? 'stroke' : 'fill',
    // Stroke + Trim Paths, used by the Line shape and by any un-closed path.
    lineWidth: sanitizeNumber(item.lineWidth, LINE_DEFAULTS.lineWidth, { min: 0, max: 400 }),
    lineCap: LINE_CAPS.includes(item.lineCap) ? item.lineCap : LINE_DEFAULTS.lineCap,
    lineJoin: LINE_JOINS.includes(item.lineJoin) ? item.lineJoin : LINE_DEFAULTS.lineJoin,
    lineDash: LINE_DASHES.includes(item.lineDash) ? item.lineDash : LINE_DEFAULTS.lineDash,
    lineTrimStart: sanitizeNumber(item.lineTrimStart, 0, { min: 0, max: 100 }),
    lineTrimEnd: sanitizeNumber(item.lineTrimEnd, 100, { min: 0, max: 100 }),
    lineTrimOffset: sanitizeNumber(item.lineTrimOffset, 0, { min: -100, max: 100 }),
    // Path Stroke options (pathStroke.js): the flat line* extras only once set, and
    // `lineStroke` only while it holds a card — older items round-trip unchanged.
    ...sanitizeLineExtras(item),
    ...lineStrokeField(item.lineStroke),
    // Text Animators (textAnimators.js): the list plus its three layer fields, only
    // while it holds an animator — older items round-trip unchanged.
    ...sanitizeTextAnimatorFields(item),
    // Rich fill background (backgroundConfig object).
    shapeBackground: item.shapeBackground && typeof item.shapeBackground === 'object' ? item.shapeBackground : null,
    // Backdrop Blur (matte glass) — the Player runs it on shape layers only.
    // Spread only when off default so older projects round-trip byte-identically.
    ...(Number.isFinite(item.backdropBlur) && item.backdropBlur > 0
      ? { backdropBlur: sanitizeNumber(item.backdropBlur, 0, { min: 0, max: 200 }) } : {}),
    ...(Number.isFinite(item.backdropSaturation) && item.backdropSaturation !== 100
      ? { backdropSaturation: sanitizeNumber(item.backdropSaturation, 100, { min: 0, max: 300 }) } : {}),
    // The paint Blur's auto-glass replaced (backdropBlur.js glassFillPatch), so
    // Blur 0 can put it back after a save/reload. Only while it is set.
    ...(item.backdropGlassFill && typeof item.backdropGlassFill.glass === 'string'
      ? { backdropGlassFill: {
        glass: item.backdropGlassFill.glass,
        fill: typeof item.backdropGlassFill.fill === 'string' ? item.backdropGlassFill.fill : null,
        solid: typeof item.backdropGlassFill.solid === 'string' ? item.backdropGlassFill.solid : null,
      } } : {}),
    // Card framing (rounded corners / border / shadow), all in canvas px.
    borderRadius: sanitizeNumber(item.borderRadius, 0, { min: 0, max: 9999 }),
    // Per-corner radii (used when the panel's link toggle is off); each corner
    // falls back to the uniform radius so old projects stay identical.
    borderRadiusLinked: item.borderRadiusLinked !== false,
    borderRadiusTL: sanitizeNumber(item.borderRadiusTL, sanitizeNumber(item.borderRadius, 0, { min: 0, max: 9999 }), { min: 0, max: 9999 }),
    borderRadiusTR: sanitizeNumber(item.borderRadiusTR, sanitizeNumber(item.borderRadius, 0, { min: 0, max: 9999 }), { min: 0, max: 9999 }),
    borderRadiusBR: sanitizeNumber(item.borderRadiusBR, sanitizeNumber(item.borderRadius, 0, { min: 0, max: 9999 }), { min: 0, max: 9999 }),
    borderRadiusBL: sanitizeNumber(item.borderRadiusBL, sanitizeNumber(item.borderRadius, 0, { min: 0, max: 9999 }), { min: 0, max: 9999 }),
    // Rectangle shapes only: the radii above as % of the shape's shorter side
    // (shapePath.js shapeCornerRadii). Spread only when set, so px projects
    // round-trip byte-identically.
    ...(item.borderRadiusUnit === 'pct' ? { borderRadiusUnit: 'pct' } : {}),
    borderWidth: sanitizeNumber(item.borderWidth, 0, { min: 0, max: 200 }),
    borderStyle: ['solid', 'dashed', 'dotted', 'double'].includes(item.borderStyle) ? item.borderStyle : 'solid',
    borderColor: typeof item.borderColor === 'string' && item.borderColor ? item.borderColor : '#ffffff',
    // Shadow list (up to 4, each optionally inset). Items saved before
    // multi-shadow support carry single-shadow fields — converted here.
    shadows: sanitizeShadows(item),
    // Overlay Effects. The same array shape is used on regular and adjustment layers;
    // the clip type determines whether it processes one isolated layer or the stack below.
    ...(overlayEffects.length ? { effects: overlayEffects } : {}),
    // Structural per-layer effects with dedicated render paths.
    ...(layerEffects.length ? { layerEffects } : {}),
    // Adjustment-layer LUT (dedicated panel section, separate from the effect
    // chain): the parsed .cube lattice + intensity. Omitted when absent.
    ...(adjustmentLut ? { lut: adjustmentLut, lutAmount: sanitizeNumber(item.lutAmount, 100, { min: 0, max: 100 }) } : {}),
    // 3D model layers: fit, orientation, environment, lights and animation. Spreads
    // in only for items that actually carry it.
    ...sanitizeModel3dConfig(item),
    // 3D Rig layers: lights, cyclorama, environment. Like model3dConfig above, this
    // spreads in ONLY for items that carry it — an always-present field would make
    // the first save of an old project read as a real content change in every other
    // open window.
    ...sanitizeRig(item),
    // Scene Rig ▸ AI video: the prerendered source, the ready takes, the settings
    // (rigAiVideo.js sanitizeRigAi is the whitelist).
    ...(item.rigAi && typeof item.rigAi === 'object' ? (() => { const v = sanitizeRigAi(item.rigAi); return v ? { rigAi: v } : {}; })() : {}),
    // The rig look this item was last set from ({ id, name, hash } — rigPresets.js
    // rigLookHash), so the panel can tell "Studio Room" from "Studio Room · edited".
    ...(item.rigLook && typeof item.rigLook === 'object' && typeof item.rigLook.id === 'string' && item.rigLook.id
      ? { rigLook: {
        id: item.rigLook.id.slice(0, 80),
        name: typeof item.rigLook.name === 'string' ? item.rigLook.name.slice(0, 80) : '',
        hash: typeof item.rigLook.hash === 'string' ? item.rigLook.hash.slice(0, 24) : '',
      } }
      : {}),
    // The Motion preset this camera move was set from ({ id, name, hash } —
    // projectCamera.js cameraMoveHash), the camera twin of rigLook above.
    ...(item.cameraPreset && typeof item.cameraPreset === 'object' && typeof item.cameraPreset.id === 'string' && item.cameraPreset.id
      ? { cameraPreset: {
        id: item.cameraPreset.id.slice(0, 80),
        name: typeof item.cameraPreset.name === 'string' ? item.cameraPreset.name.slice(0, 80) : '',
        hash: typeof item.cameraPreset.hash === 'string' ? item.cameraPreset.hash.slice(0, 24) : '',
      } }
      : {}),
    // Camera Rig: the parametric move, plus which of the three movement modes the
    // camera is in. Both attach only to items that carry them.
    ...sanitizeCameraRig(item),
    ...(item.cameraMoveMode ? { cameraMoveMode: sanitizeCameraMoveMode(item.cameraMoveMode) } : {}),
    // Flat scene-shadow participation for text / shape / image / video plates.
    // The sanitizer also migrates and drops the removed `layer3d` block.
    ...sanitizeShadowPlate(item),
    // Grid layers: the layout rule (mode, spacing, fit, orientation, reveal).
    ...sanitizeGridConfig(item),
    // Particle Solver layers: seed, solver box, emitter, forces and look.
    ...sanitizeParticleSystemField(item),
    // Text shadow (text layers only): drawn on the text canvas via ctx.shadow*.
    textShadowX: sanitizeNumber(item.textShadowX, 0, { min: -200, max: 200 }),
    textShadowY: sanitizeNumber(item.textShadowY, 0, { min: -200, max: 200 }),
    textShadowBlur: sanitizeNumber(item.textShadowBlur, 0, { min: 0, max: 200 }),
    textShadowColor: typeof item.textShadowColor === 'string' && item.textShadowColor ? item.textShadowColor : 'rgba(0,0,0,0.75)',
    textShadowSpread: sanitizeNumber(item.textShadowSpread, 0, { min: 0, max: 50 }),
    // Text fill style: solid glyphs, hollow (outline) glyphs, or both, plus the
    // outline's width and colour. `textOutlineColor` is only attached when the user
    // picked one — absent means "match the text colour" at render time.
    textFillMode: ['fill', 'outline', 'both'].includes(item.textFillMode) ? item.textFillMode : 'fill',
    textOutlineWidth: sanitizeNumber(item.textOutlineWidth, 2, { min: 0, max: 60 }),
    ...(typeof item.textOutlineColor === 'string' && item.textOutlineColor
      ? { textOutlineColor: item.textOutlineColor }
      : {}),
    // Text decoration / letter-case / style (drawn on the text canvas by the Player).
    textDecoration: ['underline', 'line-through', 'overline'].includes(item.textDecoration) ? item.textDecoration : 'none',
    textLetterCase: ['lowercase', 'capitalize', 'uppercase'].includes(item.textLetterCase) ? item.textLetterCase : 'none',
    textFontStyle: item.textFontStyle === 'italic' ? 'italic' : 'normal',
    // Motion layer: which template + its per-instance option values. Only attached
    // to motion items so other layer types keep their exact shape.
    ...(typeof item.motionTemplateId === 'string' && item.motionTemplateId
      ? { motionTemplateId: item.motionTemplateId, motionParams: sanitizeMotionParams(item.motionParams) }
      : {}),
    // Mockup layer: the mockupConfig ({options, keyframes, animationDuration}) the
    // rendered clip was produced from, so a double-click can re-open the builder
    // and re-render. Stored opaquely — normalizeMockupProjectData re-validates it on
    // reopen. Only attached to mockup items so other layers keep their exact shape.
    ...(item.mockupConfig && typeof item.mockupConfig === 'object' && item.mockupConfig.options
      ? { mockupConfig: item.mockupConfig }
      : {}),
    // Layer parenting: this layer inherits another layer's effective Position,
    // Rotation and Scale. Only well-formedness can be checked here — whether the
    // parent still exists at this level, and whether the link closes a cycle, needs
    // the whole channel list, so sanitizeChannels runs repairParentingReferences
    // after every item is sanitized.
    ...(keyframeParenting ? { keyframeParenting } : {}),
    // Track matte: another layer's alpha/luma masks this layer at composite time.
    // Same split as parenting: only well-formedness here, cross-item validity
    // (source exists, no mutual pair) runs in sanitizeChannels via
    // repairTrackMatteReferences.
    ...(trackMatte ? { trackMatte } : {}),
    // Null layer look (nullLayer.js): the preview marker's colour and diameter in
    // composition px. Only written when present, so other layers keep their shape;
    // a null without them draws the defaults.
    ...(Number.isFinite(item.nullSize)
      ? { nullSize: sanitizeNumber(item.nullSize, NULL_DEFAULT_SIZE, { min: NULL_SIZE_MIN, max: NULL_SIZE_MAX }) }
      : {}),
    ...(typeof item.nullColor === 'string' && item.nullColor ? { nullColor: item.nullColor } : {}),
    // PRERENDER section (layerPrerender.js): the transparent WebM the player plays
    // in place of this layer, with the fingerprint it was rendered from. Kept
    // verbatim like a sequence clip's `prerender` — validity is decided against
    // the current item wherever it is used, never here — and it MUST be listed:
    // this builder whitelists, so without these lines the file pointer is dropped
    // on the next save/load with nothing anywhere saying so.
    ...(item.prerender && typeof item.prerender === 'object' && typeof item.prerender.url === 'string' && item.prerender.url
      && typeof item.prerender.hash === 'string' && item.prerender.hash
      ? {
        prerender: {
          url: item.prerender.url,
          hash: item.prerender.hash,
          proxyUrl: typeof item.prerender.proxyUrl === 'string' && item.prerender.proxyUrl ? item.prerender.proxyUrl : null,
          thumbnailUrl: typeof item.prerender.thumbnailUrl === 'string' && item.prerender.thumbnailUrl ? item.prerender.thumbnailUrl : null,
          duration: Number(item.prerender.duration) || 0,
          width: Number(item.prerender.width) || 0,
          height: Number(item.prerender.height) || 0,
          fps: Number(item.prerender.fps) || 0,
          at: Number(item.prerender.at) || 0,
          name: typeof item.prerender.name === 'string' ? item.prerender.name.slice(0, 160) : '',
        },
      }
      : {}),
  };
}

export function sanitizeTimeline(timeline, clipIds) {
  if (!Array.isArray(timeline)) return [];

  return timeline
    .map(sanitizeTimelineItem)
    .filter(Boolean)
    .filter((item) => clipIds.has(item.clipId))
    .map((item) => ({
      ...item,
      trimEnd: Math.max(item.trimStart + 0.1, item.trimEnd),
    }));
}

export function createDefaultChannel(name = 'Channel 1') {
  return { id: createId(), name, visible: true, items: [] };
}

export function pinSingletonChannels(channels) {
  // Camera to the top FIRST, then the rig immediately under wherever it landed —
  // the rig's slot is defined relative to the camera, so the order here matters.
  return pinRigChannelUnderCamera(pinCameraChannelTop(channels), isCameraChannel);
}

// Every channel kind that survives a save. Add new kinds HERE and nowhere else —
// this is one list rather than a chain of ternaries precisely so a new kind cannot
// be forgotten: the symptom is silent (the channel reloads generic), never an error.
export const CHANNEL_KINDS = new Set(['voice', 'avatar', 'audio', CAMERA_CHANNEL_KIND, RIG_CHANNEL_KIND]);

export function sanitizeChannel(channel, clipIds) {
  if (!channel || typeof channel !== 'object') return null;
  return {
    id: typeof channel.id === 'string' && channel.id ? channel.id : createId(),
    name: typeof channel.name === 'string' && channel.name ? channel.name : 'Channel',
    visible: channel.visible !== false,
    unsnapped: !!channel.unsnapped,
    // Opt this channel out of the project camera (overlays/watermarks that must
    // stay frame-locked). Only written when set, so projects round-trip unchanged.
    ...(channel.cameraLocked ? { cameraLocked: true } : {}),
    // Channel kind is a whitelist for the same reason sanitizeTimelineItem is one:
    // anything not listed here is dropped on the next save. A kind missing from this
    // set does not fail loudly — the channel simply comes back generic, which is how
    // a rig channel used to reload as a plain "C3 / video" row.
    ...(CHANNEL_KINDS.has(channel.kind) ? { kind: channel.kind } : {}),
    items: sanitizeTimeline(Array.isArray(channel.items) ? channel.items : [], clipIds),
  };
}

export function sanitizeChannels(channels, clipIds) {
  if (!Array.isArray(channels) || channels.length === 0) return [createDefaultChannel()];
  const result = channels.map((ch) => sanitizeChannel(ch, clipIds)).filter(Boolean);
  if (result.length === 0) return [createDefaultChannel()];
  // Parenting is a cross-item reference, so it can only be validated once every
  // item at this level is known: drop links to layers that aren't here (a clip that
  // was deleted, or a project edited by hand) and break any imported cycle.
  const repaired = repairTrackMatteReferences(repairParentingReferences(result));
  // Loading an older project (or one an agent authored) re-pins the camera on top.
  return pinSingletonChannels(repaired);
}

export function getChannelsTotalDuration(channels) {
  let maxDuration = 0;
  for (const ch of channels) {
    const layout = getTimelineLayout(ch.items, { unsnapped: ch.unsnapped });
    maxDuration = Math.max(maxDuration, getTimelineEndTime(layout));
  }
  return maxDuration;
}

// Exported for the headless /video-render page so it hydrates a saved project with
// the exact same sanitization the live editor uses (single source of truth).
// eslint-disable-next-line react-refresh/only-export-components
// Rebuild an in-memory AI Fill zone from persisted project data. Generated preview
// videos are never persisted, so every saved zone returns idle and regenerable.
export function sanitizePersistedAiFillZone(raw, channels, clips) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const spacerClipId = typeof raw.spacerClipId === 'string' ? raw.spacerClipId : '';
  if (!id || !spacerClipId) return null;
  const spacerClip = clips.find((c) => c.id === spacerClipId);
  const owner = channels.find((ch) => ch.items.some((it) => it.aiFillZoneId === id));
  if (!spacerClip || !owner) return null;
  const targetChannelId =
    typeof raw.targetChannelId === 'string' && channels.some((ch) => ch.id === raw.targetChannelId)
      ? raw.targetChannelId
      : owner.id;
  const str = (v) => (typeof v === 'string' && v ? v : undefined);
  return {
    id,
    startTime: sanitizeNumber(raw.startTime, 0, { min: 0 }),
    duration: sanitizeNumber(raw.duration, AI_FILL_DEFAULT_SECONDS, { min: 0.5, max: 30 }),
    spacerClipId,
    videoClipId: null,
    targetChannelId,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : AI_FILL_PROMPT,
    modelId: str(raw.modelId) || null,
    startImageUrl: str(raw.startImageUrl),
    endImageUrl: str(raw.endImageUrl),
    referenceImages: Array.isArray(raw.referenceImages)
      ? raw.referenceImages.filter((url) => typeof url === 'string' && url)
      : [],
    // Saved takes come back ready but not in use — the gap reopens empty at
    // the length it had, and Use puts one back.
    takes: restoreAiFillTakes(raw.takes),
    activeTakeId: null,
    nextTakeN: Math.max(1, Math.round(Number(raw.nextTakeN) || 1)),
    takeDuration: sanitizeNumber(raw.takeDuration, 0, { min: 0, max: 30 }) || undefined,
    extracting: false,
    status: 'idle',
    error: null,
  };
}

// Timeline markers: project-level colored pins on the time ruler. Times are
// absolute timeline seconds (not clamped to the current duration — a marker past
// the last clip is legal and stays put while clips are edited).
export const MARKER_DEFAULT_COLOR = '#8b5cf6';

export function sanitizeMarker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const time = sanitizeNumber(raw.time, NaN, { min: 0 });
  if (!Number.isFinite(time)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
    time,
    color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color) ? raw.color : MARKER_DEFAULT_COLOR,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
  };
}

export function sanitizeMarkers(rawMarkers) {
  if (!Array.isArray(rawMarkers)) return [];
  const seen = new Set();
  return rawMarkers
    .map(sanitizeMarker)
    .filter((m) => {
      if (!m || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    })
    .sort((a, b) => a.time - b.time);
}

// Layer markers: the same pin, but a note about ONE LAYER rather than about the
// project. It is anchored to the clip — `itemId` + a 0–100% offset inside it, the
// exact unit a keyframe uses — so it travels with its layer when the clip is
// moved, trimmed or re-timed, and a marker the user snapped to a keyframe stays
// on that keyframe. Absolute seconds are derived from the channel layout at
// render time; nothing stores them.
// Still kept flat (not on the item) so markers stay OUT of the undo history,
// exactly like the ruler markers — a note about the edit is not part of it.
// Teal by default so a layer pin can never be misread as the violet playhead /
// keyframe diamonds.
export const LAYER_MARKER_DEFAULT_COLOR = '#14b8a6';

export function sanitizeLayerMarker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.itemId !== 'string' || !raw.itemId) return null;
  const position = sanitizeNumber(Number.parseFloat(raw.position), NaN, { min: 0, max: 100 });
  if (!Number.isFinite(position)) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : createId(),
    itemId: raw.itemId,
    position,
    color: typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color) ? raw.color : LAYER_MARKER_DEFAULT_COLOR,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : '',
  };
}

// Pre-8.6.1 layer markers were pinned to a CHANNEL at an absolute timeline second,
// so they stayed behind when their clip moved. Convert each one to the clip it was
// standing on; a marker that sat over a gap has no layer to belong to and is dropped.
export function migrateLegacyLayerMarker(raw, channels) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.channelId !== 'string' || !raw.channelId) return null;
  const time = sanitizeNumber(raw.time, NaN, { min: 0 });
  if (!Number.isFinite(time)) return null;
  const channel = (channels || []).find((ch) => ch.id === raw.channelId);
  if (!channel) return null;
  const layout = getTimelineLayout(channel.items, { unsnapped: channel.unsnapped });
  for (let i = 0; i < channel.items.length; i += 1) {
    const l = layout[i];
    if (!l || !(l.duration > 0)) continue;
    if (time >= l.startTime && time <= l.endTime) {
      return sanitizeLayerMarker({
        ...raw,
        itemId: channel.items[i].id,
        position: ((time - l.startTime) / l.duration) * 100,
      });
    }
  }
  return null;
}

export function sanitizeLayerMarkers(rawMarkers, channels = []) {
  if (!Array.isArray(rawMarkers)) return [];
  const seen = new Set();
  return rawMarkers
    .map((raw) => sanitizeLayerMarker(raw) || migrateLegacyLayerMarker(raw, channels))
    .filter((m) => {
      if (!m || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
}

export function normalizeEditorState(rawState) {
  const parsedState = rawState && typeof rawState === 'object' ? rawState : {};
  const clips = Array.isArray(parsedState.clips) ? parsedState.clips.map(sanitizeClip).filter(Boolean) : [];
  const clipIds = new Set(clips.map((clip) => clip.id));

  let history = [];
  let index = 0;

  if (Array.isArray(parsedState.channels)) {
    // Template format: current channels only (no undo/redo history)
    history = [sanitizeChannels(parsedState.channels, clipIds)];
    index = 0;
  } else if (parsedState.version >= 2 && parsedState.historyState && Array.isArray(parsedState.historyState.history)) {
    // v2 format: history entries are channels arrays
    history = parsedState.historyState.history.map((entry) => sanitizeChannels(entry, clipIds));
    index = sanitizeNumber(parsedState.historyState.index, 0, { min: 0, max: Math.max(history.length - 1, 0) });
  } else if (parsedState.historyState && typeof parsedState.historyState === 'object' && Array.isArray(parsedState.historyState.history)) {
    // v1 format: history entries are flat timeline arrays -> migrate to single channel
    const sharedChannelId = createId();
    history = parsedState.historyState.history.map((entry) => {
      const items = sanitizeTimeline(entry, clipIds);
      return [{ id: sharedChannelId, name: 'Channel 1', visible: true, items }];
    });
    index = sanitizeNumber(parsedState.historyState.index, 0, { min: 0, max: Math.max(history.length - 1, 0) });
  } else if (Array.isArray(parsedState.timeline)) {
    // Legacy: bare timeline array
    const items = sanitizeTimeline(parsedState.timeline, clipIds);
    history = [[{ id: createId(), name: 'Channel 1', visible: true, items }]];
    index = 0;
  }

  if (history.length === 0) {
    history = [[createDefaultChannel()]];
    index = 0;
  }

  const activeChannels = history[index] || [createDefaultChannel()];

  let activeChannelId = parsedState.activeChannelId;
  if (!activeChannelId || !activeChannels.some((ch) => ch.id === activeChannelId)) {
    activeChannelId = activeChannels[0].id;
  }

  const allItems = activeChannels.flatMap((ch) => ch.items);
  const selectedTimelineId =
    typeof parsedState.selectedTimelineId === 'string' && allItems.some((item) => item.id === parsedState.selectedTimelineId)
      ? parsedState.selectedTimelineId
      : null;

  const totalDuration = getChannelsTotalDuration(activeChannels);
  const currentTime = sanitizeNumber(parsedState.currentTime, 0, { min: 0, max: totalDuration });

  const videoSize = parsedState.videoSize && typeof parsedState.videoSize === 'object'
    ? { w: sanitizeNumber(parsedState.videoSize.w, 1920, { min: 16, max: 7680 }), h: sanitizeNumber(parsedState.videoSize.h, 1080, { min: 16, max: 7680 }) }
    : { w: 1920, h: 1080 };
  const rawAiFillZones = Array.isArray(parsedState.aiFillZones)
    ? parsedState.aiFillZones
    : parsedState.aiFillZone
      ? [parsedState.aiFillZone]
      : [];
  const seenAiFillZoneIds = new Set();
  const aiFillZones = rawAiFillZones
    .map((zone) => sanitizePersistedAiFillZone(zone, activeChannels, clips))
    .filter((zone) => {
      if (!zone || seenAiFillZoneIds.has(zone.id)) return false;
      seenAiFillZoneIds.add(zone.id);
      return true;
    });
  // Clean undo/redo history on load/import: keep only latest snapshot.
  return {
    clips,
    historyState: { history: [activeChannels], index: 0 },
    activeChannelId,
    selectedTimelineId,
    currentTime,
    videoSize,
    motionBlurEnabled: parsedState.motionBlurEnabled === true,
    motionBlurShutter: sanitizeMotionBlurShutter(parsedState.motionBlurShutter),
    textureQuality: sanitizeTextureQuality(parsedState.textureQuality),
    previewFps: sanitizePreviewFps(parsedState.previewFps),
    colorTokens: sanitizeColorTokens(parsedState.colorTokens),
    // {{{VAR:name}}} values for text layers (textPlaceholders.js). Read at draw time.
    textVariables: sanitizeTextVariables(parsedState.textVariables),
    // A bare colour string (agents/API callers write `"background": "#3366cc"`)
    // is coerced to a solid config instead of being silently dropped — dropping
    // it renders a black stage with no error anywhere.
    background: parsedState.background && typeof parsedState.background === 'object'
      ? parsedState.background
      : typeof parsedState.background === 'string' && parsedState.background.trim()
        ? { type: 'solid', solidColor: parsedState.background.trim() }
        : null,
    aiFillZones,
    markers: sanitizeMarkers(parsedState.markers),
    layerMarkers: sanitizeLayerMarkers(parsedState.layerMarkers, activeChannels),
  };
}

// eslint-disable-next-line react-refresh/only-export-components
export function createEmptyEditorState() {
  const ch = createDefaultChannel();
  return {
    clips: [],
    historyState: { history: [[ch]], index: 0 },
    activeChannelId: ch.id,
    selectedTimelineId: null,
    currentTime: 0,
    videoSize: { w: 1920, h: 1080 },
    motionBlurEnabled: false,
    motionBlurShutter: DEFAULT_MOTION_BLUR_SHUTTER,
    textureQuality: DEFAULT_TEXTURE_QUALITY,
    previewFps: DEFAULT_PREVIEW_FPS,
    colorTokens: [],
    textVariables: [],
    background: null,
    aiFillZones: [],
    markers: [],
  };
}

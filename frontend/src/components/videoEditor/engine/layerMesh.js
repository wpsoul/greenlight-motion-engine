/*
 * A layer's mesh for one frame (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9 step 26 — moved verbatim out of
 * Player.jsx with tests/engine-extraction/tools/stage9_step.py): setupMesh gives a layer's plane its picture — video and
 * image textures, text and shapes painted to canvases (letter spacing, text animators, decorations, path text), the
 * placeholder while media loads — its shader uniforms (filters, blend, shadows, corners, masks) and its transform.
 *
 * `env` carries the live editor values it reads (`interactivePreviewEnabled`, `isPlaying`, and the raster density
 * readers getRasterBudget / getRasterCaps) and the project markers — which the old callback read without listing them, so
 * the env, memoized over exactly the old dependency list, keeps them as of its last re-creation, as before.
 */
import { PARTICLE_MEDIA_TYPE } from '../../../sim/particles/schema.js';
import { buildCanvasGradient, gradientFirstStopColor, isCssGradient } from '../../../utils/cssGradient';
import { effectWindowAt } from '../adjustmentEffects';
import { isAnimatedImageCandidate, requestAnimatedImageFrame } from '../animatedImage';
import { withBorderKeyframes } from '../borderKeyframes';
import { isChromaKeyEnabled } from '../chromaKeyLayer';
import { applyBlendMode, applyDepthUniforms, applyFilterUniforms, resetMaterialUniforms } from '../clipShader';
import { readTextureImagePixels } from '../colorCorrectionBroker';
import { canUseDepthParallax, getDepthParallaxEffect, getDepthTexture, getItemDepthMap, isDepthParallaxEnabled, resolveDepthParams } from '../depthParallax';
import { arcLengthToParam, contentRectInQuad, fitScaleForCell } from '../gridLayout';
import { applyGsapEasing, evaluatePropertyTrack, getItemKeyframeValues, itemHasKeyframes } from '../gsapTransitions';
import { imagePlateSize } from '../imagePlate';
import { htmlClipPlateSize } from '../htmlClips';
import { getInlineTextEditId } from '../inlineTextEdit';
import { localPrs, setLayerPivotBox } from '../keyframeParenting';
import { applyMotionParamKeyframes } from '../motionKf';
import { drawMotionFrame } from '../motionTemplates';
import { evaluateObjectMotionPath, liveObjectMotionPath, motionPathTrackReach, motionPathSignature, MOTION_PATH_KF_KEY } from '../objectMotionPath';
import { isPosterizeTimeEnabled } from '../posterizeTime';
import { normalizeTextPathCorners, sharpCornerPose } from '../textPathCorners';
import { isText3dLayer, resolveText3d } from '../text3d';
import { GLYPH_RASTER_PX } from '../text3dGlyphConstants';
import { strokeCopyDelays, strokeEngineMoves } from '../pathStroke';
import { densityBytes, RASTER_DENSITY_BUCKETS, resolveDensity, VECTOR_DENSITY_BUCKETS } from '../rasterDensity';
import { measureScreenScale } from '../rasterDensityProject';
import { isCameraBaked3dPlate, RIG_MEDIA_TYPE } from '../rig3d';
import { isStrokeShape, resolveLineSettings, SHAPE_PATH_KF_KEY, withShapeSizeKeyframes } from '../shapePath';
import { animatorsMove as txaAnimatorsMove, boxRects as txaBoxRects, caretRect as txaCaretRect, evaluate as txaEvaluate, glyphFor as txaGlyphFor, grainOf as txaGrainOf, groupBoxes as txaGroupBoxes, hToCanvas as txaHToCanvas, KF_PREFIX as TXA_KF_PREFIX, layerSettings as txaLayerSettings, liveAnimators as txaLiveAnimators, maskedXf as txaMaskedXf, motionKey as txaMotionKey, needsLayout as txaNeedsLayout, paintCss as txaPaintCss, rgbCss as txaRgbCss, unitTransform as txaUnitTransform, unitTransform3d as txaUnitTransform3d, m4Mul as txaM4Mul, warpBegin as txaWarpBegin, warpEnd as txaWarpEnd } from '../textAnimators';
import { clearTextFootprint, getTextFootprint, setTextFootprint } from '../textFootprint';
import { buildPlaceholderRun, expandStaticPlaceholders, parsePlaceholderText } from '../textPlaceholders';
import { DEFAULT_TEXT_FONT_FAMILY, DEFAULT_TEXT_FONT_WEIGHT, resolveTextFontSize, TEXT_BG_GROW_APPEAR, TEXT_BG_REVEAL_STYLES, TEXT_BG_REVEAL_TYPES, TEXT_BORDER_STYLES, TransitionEasing } from '../types';
import { getVectorAsset, isVectorMediaUrl } from '../vectorMedia';
import { setVideoPlate, videoPlateScale } from '../videoPlate';
import { selectedBackend } from '../videoRenderer';
import { inverseVideoStabilizationSample, sampleVideoStabilization } from '../videoStabilization';
import { ensureTextTexture } from './canvasHelpers';
import { calculateVideoTime, maskSilhouetteFraming } from './layerHelpers';
import { animatedFrameTexture as animatedFrameTextureInEngine, getClipPlaybackUrl, getImageTexture as getImageTextureInEngine, getVideoTexture as getVideoTextureInEngine, normalizeUrl } from './mediaTextures';
import { applyMeshTransform } from './meshTransform';
import { RECORDING_CURSOR_FLIP_ON_WEBGPU, bakeRecordingCursor } from './recordingCursorPass';
import { getShapeSvgImage, getShapeTextureLayout, MAX_SHAPE_TEXTURE_DIM } from './pathFx';
import { SHAPE_PAINT_KEY_RE, TEXT_PAINT_KEY_RE, activeTextRun, applyTextLetterCase, buildTextRandomPlan, buildWrappedTokens, clamp, densityMotionCtx, drawShapeToCanvas, drawTextBgRevealBar, drawTextDecorationLine, getPlaceholderTexture, getTextPathArcTable, itemPaintFieldSignature, kernBetween, measureTextWithLetterSpacing, motionCtmSafe, paintTextWithLetterSpacing, probeMotionCtx, setActiveTextRun, strokeTextWithLetterSpacing, txaBaseRgb, txaHasTrack, txaScratch } from './textPaint';

export function setupMesh(engine, env, mesh, material, item, clip, video, progress, durationSec = 0, cs = null, overrideTexture = null, parentXform = null, itemFollow = null) {
  if (mesh?.userData) { mesh.userData.cameraBaked3d = false; mesh.userData.particlePlate = false; mesh.userData.quadRect = null; mesh.userData.fxFrame = null; mesh.userData.mediaFrac = null; }
  if (!clip) {
    mesh.visible = false;
    return false;
  }
  if (clip._placeholder) {
    const { w: W, h: H } = engine.videoSize;
    const ph = getPlaceholderTexture();
    material.uniforms.uTexture.value = ph;
    material.userData.textureSource = '__placeholder__';
    material.uniforms.uResolution.value.set(ph.image.width, ph.image.height);
    mesh.visible = true;
    resetMaterialUniforms(material);
    material.uniforms.uCanvasSize.value.set(W, H);
    return false;
  }

  const { w: W, h: H } = engine.videoSize;
  const clipSource = normalizeUrl(getClipPlaybackUrl(clip));
  let texture = null;
  let cursorBaked = false; // a cursor-free recording drawn with its cursor (engine/recordingCursorPass.js)
  let layerWidth = W;
  let layerHeight = H;
  let textureRasterScale = 1;
  // An image clip whose source is an SVG: drawn on its own plate at adaptive
  // density, so it shares the text/shape geometry rules rather than the bitmap ones.
  let isVectorLayer = false;
  // A raster image draws on the PICTURE's own rect too (imagePlate.js) — its own
  // pixels up to the frame, shrunk to fit beyond it, always the artwork's aspect
  // ratio. Same geometry rule as a vector layer, no density probe: its texture is
  // already the artwork.
  let isNativeImageLayer = false;
  // An html clip whose page is not the frame's shape: its plate is the page (htmlClips.js).
  let isHtmlPagePlate = false;
  // A video draws on its own picture at its real size (videoPlate.js) — no letterbox
  // bars. Its effects keep the frame-shaped box (videoFrameW × videoFrameH) around it.
  let isVideoPlate = false;
  let videoFrameW = W;
  let videoFrameH = H;
  // Hoisted above the media branch: the adaptive raster density probe has to pose
  // the mesh before deciding how densely to rasterize it, and posing needs these.
  // Same expression as before, evaluated earlier — nothing between here and its old
  // site touches `item` or `progress`.
  const keyframeProps = getItemKeyframeValues(item, progress);
  if (overrideTexture) {
    texture = overrideTexture;
  } else if (clip.mediaType === 'text') {
    const { w: canvasW, h: canvasH } = engine.videoSize;
    // Reuse whatever canvas is cached for measuring — its size doesn't matter
    // for ctx.measureText, and forcing composition size here would thrash the
    // texture every frame for overflowing (nowrap) text. The canvas is resized
    // to its real size and cleared right before drawing, once layout is known.
    const cachedText = engine.textTextureCache.get(item.id);
    let { canvas, ctx, texture: textTexture } = cachedText || ensureTextTexture(engine.refObjects.textTextureCache, item.id, canvasW, canvasH);
    // px or % of the composition height — see resolveTextFontSize in types.js.
    const fontSize = resolveTextFontSize(item, canvasH);
    const lineHeight = clamp(Number(item.textLineHeight) || 1.15, 0.7, 3);
    // Letter spacing is animatable: a `letterSpacing` keyframe track OVERRIDES the
    // static Spacing field and re-lays the text out for real (wrapping + row widths
    // are measured with it), instead of the shader's UV stretch used by other layer
    // types — which is why the shader path is disabled for text below.
    const kfLetterSpacing = evaluatePropertyTrack(item.propertyKeyframes?.letterSpacing, clamp(progress, 0, 1) * 100);
    const letterSpacing = Number.isFinite(kfLetterSpacing)
      ? clamp(kfLetterSpacing, -80, 200)
      : clamp(Number(item.textLetterSpacing) || 0, -20, 80);
    const textAlign = item.textAlign === 'left' || item.textAlign === 'right' ? item.textAlign : 'center';
    // Clip-mask mode: only the glyph coverage may reach the canvas. The caption bar,
    // text shadow/spread and the highlight glow below are all suppressed — their soft
    // or boxy alpha would become mask coverage. Feathering is still available via the
    // FILTERS blur, which folds into the texture alpha downstream.
    const isMask = !!item.textClipMask;
    // Optional caption-style background drawn behind each line of text.
    // A `textBgColor` keyframe track overrides the static colour, same
    // pattern as the animated letterSpacing above.
    const bgEnabled = !!item.textBgEnabled && !isMask;
    const kfTextBgColor = evaluatePropertyTrack(item.propertyKeyframes?.textBgColor, clamp(progress, 0, 1) * 100, true);
    const bgColor = (typeof kfTextBgColor === 'string' && kfTextBgColor)
      ? kfTextBgColor
      : (typeof item.textBgColor === 'string' && item.textBgColor ? item.textBgColor : 'rgba(0,0,0,0.6)');
    const bgPad = clamp(Number.isFinite(item.textBgPadding) ? item.textBgPadding : 16, 0, 200);
    // Per-axis spacing falls back to the uniform value (null = inherit).
    const bgPadX = Number.isFinite(item.textBgPaddingX) ? clamp(item.textBgPaddingX, 0, 200) : bgPad;
    const bgPadY = Number.isFinite(item.textBgPaddingY) ? clamp(item.textBgPaddingY, 0, 200) : bgPad;
    // Explicit corner radius, or null for the automatic one (resolved where the
    // bar is drawn — it depends on the font size).
    const bgRadius = Number.isFinite(item.textBgRadius) ? clamp(item.textBgRadius, 0, 200) : null;
    // Caption-bar border: its own toggle, so a bar can be outline-only. It is
    // suppressed in clip-mask mode for the same reason the fill is.
    const borderEnabled = !!item.textBorderEnabled && !isMask;
    const bgBorder = borderEnabled ? {
      color: typeof item.textBorderColor === 'string' && item.textBorderColor ? item.textBorderColor : '#ffffff',
      width: clamp(Number(item.textBorderWidth) || 2, 0.5, 40),
      style: TEXT_BORDER_STYLES.includes(item.textBorderStyle) ? item.textBorderStyle : 'solid',
    } : null;
    // Caption-bar reveal (In/Out animation for the bars). Easing stores the
    // TransitionEasing display value, same format as transitionInEasing.
    const bgInType = TEXT_BG_REVEAL_TYPES.includes(item.textBgInType) ? item.textBgInType : 'none';
    const bgInStyle = TEXT_BG_REVEAL_STYLES.includes(item.textBgInStyle) ? item.textBgInStyle : 'wipe';
    const bgInDelay = clamp(Number(item.textBgInDelay) || 0, 0, 4);
    const bgInDuration = clamp(Number(item.textBgInDuration) || 0.5, 0.05, 4);
    const bgInEasing = item.textBgInEasing || TransitionEasing.EASE_OUT;
    // Grow Shape appearance (own clock; ignored by the other styles).
    const bgInGrowStart = clamp(Number(item.textBgInGrowStart) || 0, 0, 600);
    const bgInAppear = bgInStyle === 'grow' && TEXT_BG_GROW_APPEAR.includes(item.textBgInGrowAppear) ? item.textBgInGrowAppear : 'none';
    const bgInAppearDuration = clamp(Number(item.textBgInGrowAppearDuration) || 0.4, 0.05, 4);
    const bgInAppearEasing = item.textBgInGrowAppearEasing || TransitionEasing.EASE_OUT;
    const bgOutType = TEXT_BG_REVEAL_TYPES.includes(item.textBgOutType) ? item.textBgOutType : 'none';
    const bgOutStyle = TEXT_BG_REVEAL_STYLES.includes(item.textBgOutStyle) ? item.textBgOutStyle : 'wipe';
    const bgOutDuration = clamp(Number(item.textBgOutDuration) || 0.4, 0.05, 4);
    const bgOutEasing = item.textBgOutEasing || TransitionEasing.EASE_IN;
    const bgOutGrowStart = clamp(Number(item.textBgOutGrowStart) || 0, 0, 600);
    const bgOutAppear = bgOutStyle === 'grow' && TEXT_BG_GROW_APPEAR.includes(item.textBgOutGrowAppear) ? item.textBgOutGrowAppear : 'none';
    const bgOutAppearDuration = clamp(Number(item.textBgOutGrowAppearDuration) || 0.4, 0.05, 4);
    const bgOutAppearEasing = item.textBgOutGrowAppearEasing || TransitionEasing.EASE_IN;
    const fontWeight = clamp(Number(item.textFontWeight) || DEFAULT_TEXT_FONT_WEIGHT, 100, 900);
    const fontFamily = (item.textFontFamily || DEFAULT_TEXT_FONT_FAMILY).trim();
    // Letter case transforms the string BEFORE wrapping/measuring; decoration
    // lines are drawn after each glyph run. Both affect preview and export
    // identically — this is the single shared text draw path.
    const textLetterCase = ['lowercase', 'capitalize', 'uppercase'].includes(item.textLetterCase) ? item.textLetterCase : 'none';
    const textDecoration = ['underline', 'line-through', 'overline'].includes(item.textDecoration) ? item.textDecoration : 'none';
    const fontItalic = item.textFontStyle === 'italic';
    const rawText = typeof item.textContent === 'string' && item.textContent.length > 0 ? item.textContent : 'Type your text';
    // Dynamic placeholders (textPlaceholders.js), two passes. VAR and MARKER expand
    // to plain text first — they then wrap, split and style like typed words. Every
    // animated token (COUNTER, TIMER, CYCLE, SCRAMBLE, TIMECODE, FRAME) becomes ONE
    // sentinel character before anything measures or splits the text, so wrapping,
    // the split units, the randomizer and text on path treat it as a single glyph;
    // the measure/draw helpers hand sentinels to the run. The animation clock is the
    // item's SOURCE-local time (the transcript clocks below use the same), so a clip
    // split mid-count carries on in its second half.
    const placeholderEnv = engine.placeholderEnv;
    const staticText = expandStaticPlaceholders(rawText, {
      variables: placeholderEnv.textVariables,
      markers: placeholderEnv.markers,
      timeSec: engine.currentTime,
    });
    const placeholderParsed = parsePlaceholderText(staticText);
    setActiveTextRun(null);
    if (placeholderParsed) {
      // A keyframed placeholder reads its own progress track (`ph:<id>`), now and
      // one 60 fps frame earlier (the spin blur's trailing shutter).
      const prevProgress = durationSec > 0 ? progress - 1 / (60 * durationSec) : progress;
      const track = (key) => {
        const keys = item.propertyKeyframes?.[key];
        if (!Array.isArray(keys) || !keys.length) return null;
        return {
          now: evaluatePropertyTrack(keys, clamp(progress, 0, 1) * 100),
          prev: evaluatePropertyTrack(keys, clamp(prevProgress, 0, 1) * 100),
        };
      };
      setActiveTextRun(buildPlaceholderRun(placeholderParsed, item, {
        tSec: (Number(item.trimStart) || 0) + clamp(progress, 0, 1) * (durationSec || 0),
        clipSec: clamp(progress, 0, 1) * (durationSec || 0),
        rootSec: engine.currentTime,
        fps: placeholderEnv.fps,
        track,
        easeFor: (key) => (p) => applyGsapEasing(p, key),
        transform: (str) => applyTextLetterCase(str, textLetterCase),
      }));
    }
    const text = applyTextLetterCase(placeholderParsed ? placeholderParsed.text : staticText, textLetterCase);
    // The units a line may break between: words, or (Wrap ▸ Anywhere) characters.
    const splitMode = item.textWrapAnywhere ? 'symbols' : 'words';
    // Voice timing: one spoken-time window per whitespace word of the text, in
    // item-SOURCE-local seconds (Advanced Animations' Voice drive). Honoured only
    // while the timing count still matches the text — an edited caption falls back
    // to Time (the timings stay stored, so restoring the text restores the sync).
    const rawWordTimings = Array.isArray(item.textWordTimings) ? item.textWordTimings : null;
    const timingWordCount = (text.match(/\S+/g) || []).length;
    const wordWinSec = rawWordTimings && timingWordCount > 0 && rawWordTimings.length === timingWordCount
      ? rawWordTimings.map((tw) => {
        const s = Math.max(0, Number(tw?.startMs) || 0) / 1000;
        return { s, e: Math.max(s, (Number(tw?.endMs) || 0) / 1000) };
      })
      : null;
    // The clip clock (progress) excludes trimStart; word timings are stored
    // source-local, so evaluating them against trimStart + clip time keeps a
    // split/trimmed caption's words on-voice in both halves.
    const tSrcSec = (Number(item.trimStart) || 0) + clamp(progress, 0, 1) * (durationSec || 0);
    // A `textColor` keyframe track overrides the static paint. Keys may hold a
    // solid OR a full CSS gradient — the interpolator blends both, and every
    // downstream read (glyph paint, outline fallback, gradient detection)
    // already branches on isCssGradient, so the override slots in unchanged.
    const kfTextColor = evaluatePropertyTrack(item.propertyKeyframes?.textColor, clamp(progress, 0, 1) * 100, true);
    const textColor = (typeof kfTextColor === 'string' && kfTextColor)
      ? kfTextColor
      : (typeof item.textColor === 'string' && item.textColor ? item.textColor : '#ffffff');
    // Fill Style: solid glyphs, hollow (outline) glyphs, or both. Outline is what
    // lets an edge effect read on type — see paintTextWithLetterSpacing. The
    // outline colour falls back to the text colour so switching modes doesn't
    // silently change the layer's colour.
    const textFillMode = ['fill', 'outline', 'both'].includes(item.textFillMode) ? item.textFillMode : 'fill';
    const outlineWidth = clamp(Number(item.textOutlineWidth) || 0, 0, 60);
    // A zero-width outline would paint nothing at all in outline-only mode, which
    // reads as a broken layer rather than a setting, so it always keeps a hairline.
    const glyphLineWidth = textFillMode === 'fill' ? 0 : Math.max(0.5, outlineWidth);
    // Keyframed outline colour wins; then the static one; then follow textColor
    // (which may itself be keyframed — the fallback chain keeps that behaviour).
    const kfOutlineColor = evaluatePropertyTrack(item.propertyKeyframes?.textOutlineColor, clamp(progress, 0, 1) * 100, true);
    const textOutlineColor = (typeof kfOutlineColor === 'string' && kfOutlineColor)
      ? kfOutlineColor
      : (typeof item.textOutlineColor === 'string' && item.textOutlineColor
        ? item.textOutlineColor
        : textColor);
    const baseIsGradient = isCssGradient(textColor);
    // Text Randomizer: seeded per-unit variation of size/colour/weight/italic.
    // Its own scope gives the units; the animators run on the styled result.
    const rndEnabled = !!item.textRandomEnabled;
    const rndScope = ['words', 'lines', 'symbols'].includes(item.textRandomScope) ? item.textRandomScope : 'words';
    const rndDist = ['uniform', 'gaussian', 'nth', 'wave'].includes(item.textRandomDist) ? item.textRandomDist : 'uniform';
    const rndNth = clamp(Math.round(Number(item.textRandomNth) || 3), 2, 12);
    const rndSeed = Math.max(0, Math.round(Number(item.textRandomSeed) || 0));
    const rndSizeOn = item.textRandomSizeEnabled !== false;
    const rndSizeMin = clamp(Number(item.textRandomSizeMin) || 80, 20, 300);
    const rndSizeMax = clamp(Number(item.textRandomSizeMax) || 145, 20, 300);
    const rndColorOn = item.textRandomColorEnabled !== false && !isMask;
    const rndColors = Array.isArray(item.textRandomColors)
      ? item.textRandomColors.filter((c) => typeof c === 'string' && c)
      : [];
    const rndCoverage = clamp(Number.isFinite(item.textRandomCoverage) ? item.textRandomCoverage : 35, 0, 100);
    const rndWeightOn = item.textRandomWeightEnabled !== false;
    const rndWeights = Array.isArray(item.textRandomWeights)
      ? item.textRandomWeights.map(Number).filter((w) => Number.isFinite(w) && w >= 100 && w <= 900)
      : [];
    const rndItalicOn = !!item.textRandomItalicEnabled;
    const rndItalicMode = item.textRandomItalicMode === 'all' ? 'all' : 'mix';
    const rndItalicShare = clamp(Number.isFinite(item.textRandomItalicShare) ? item.textRandomItalicShare : 30, 0, 100);
    // Text on Path: the glyph run is laid out along the layer's motion path —
    // the same curve the object would ride (objectMotionPath.js: world pixels,
    // origin at the composition centre, +y up). Placement happens per draw
    // unit below; localPrs skips its Follow-Path position override while this
    // is live, so the curve is applied exactly once.
    // The path AT THIS FRAME: an animated path (a copied roto outline, a keyed
    // motion path) is the keyed snapshot, else the stored one.
    const textPathObj = liveObjectMotionPath(item, keyframeProps);
    const textPathKeyed = Array.isArray(keyframeProps?.[MOTION_PATH_KF_KEY]);
    const textPathOn = !!item.textPathEnabled
      && Array.isArray(textPathObj?.points) && textPathObj.points.length >= 2;
    const textPathGrainMode = item.textPathGrain === 'words' ? 'words' : 'symbols';
    // 3D Text (text3d.js): the letters are laid out and animated here as always,
    // then handed to the 3D pass as a run instead of being painted — per LETTER.
    const text3dOn = !isMask && isText3dLayer(item, clip);
    const textPathDir = ['forward', 'backward'].includes(item.textPathDirection) ? item.textPathDirection : 'center';
    const textPathTravel = item.textPathTravel === 'through' ? 'through' : 'fit';
    const textPathEven = item.textPathSpacingMode === 'even';
    const textPathRotate = item.textPathRotate !== false;
    // Corners (textPathCorners.js): 'sharp' keeps every letter wholly on one side of a bend.
    const textPathSharp = normalizeTextPathCorners(item.textPathCorners) === 'sharp';
    // Every distribution control is keyframable (registry tracks); a track
    // overrides the static field, same pattern as letterSpacing above.
    const textPathKfNum = (key, fallback, lo, hi) => {
      const kfVal = evaluatePropertyTrack(item.propertyKeyframes?.[key], clamp(progress, 0, 1) * 100);
      const v = Number.isFinite(kfVal) ? kfVal : Number(item[key]);
      return clamp(Number.isFinite(v) ? v : fallback, lo, hi);
    };
    const textPathSpread = textPathOn ? textPathKfNum('textPathSpread', 100, 10, 400) : 100;
    const textPathSpacingPx = textPathOn ? textPathKfNum('textPathSpacing', 0, -200, 500) : 0;
    const textPathTrimA = textPathOn ? textPathKfNum('textPathTrimStart', 0, 0, 100) : 0;
    const textPathTrimB = textPathOn ? textPathKfNum('textPathTrimEnd', 100, 0, 100) : 100;
    const textPathOffY = textPathOn ? textPathKfNum('textPathOffsetY', 0, -500, 500) : 0;
    // Progress reuses motionPathT + the Path Progress track, so the existing
    // stopwatch and keys slide the whole run along the curve.
    const textPathT = textPathOn ? textPathKfNum('motionPathT', 0, 0, 100) : 0;
    const baseFont = `${fontItalic ? 'italic ' : ''}${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.font = baseFont;
    ctx.textBaseline = 'top';
    ctx.fillStyle = baseIsGradient ? gradientFirstStopColor(textColor, '#ffffff') : textColor;
    // Text box width: % of the composition width (default 86 — the legacy
    // hard-coded box) or absolute composition px. It is the wrap width AND the
    // left/right-align margin. No Wrap disables auto wrapping entirely — only
    // explicit line breaks start a new row (white-space: nowrap) — and ignores
    // the custom width (the panel disables the field): margins fall back to
    // the default box.
    const textNoWrap = !!item.textNoWrap;
    const textWidthPct = textNoWrap ? 86 : clamp(Number(item.textWidthPct) || 86, 5, 100);
    const maxWidth = !textNoWrap && item.textWidthUnit === 'px' && Number.isFinite(item.textWidthPx) && item.textWidthPx > 0
      ? clamp(item.textWidthPx, 40, canvasW * 4)
      : canvasW * (textWidthPct / 100);
    const textMarginX = Math.max(0, (canvasW - maxWidth) / 2);
    const paragraphLines = text.replace(/\r/g, '').split('\n');
    const wrappedLines = [];
    for (const line of paragraphLines) {
      if (!line.trim()) {
        wrappedLines.push(['']);
        continue;
      }
      const tokenRows = buildWrappedTokens(line, splitMode, textNoWrap ? Infinity : maxWidth, ctx, letterSpacing);
      wrappedLines.push(...tokenRows);
    }
    const lineHeightPx = fontSize * lineHeight;
    // A CSS line box: the line height left over the font's content area (ascent + descent) splits evenly above and
    // below it, so text sits centred in its own box, where the inline editor's textarea puts it too. Glyphs are drawn
    // with textBaseline 'top' (the em top), so they go `glyphDrop` below their line-box top; the layout (line boxes,
    // footprint, animator pivots) stays on the line boxes. Before, glyphs hung from the line-box top with all the
    // leading below them: capitals sat 0.12–0.37 em above the box centre.
    ctx.font = baseFont;
    ctx.textBaseline = 'top';
    const fontBox = ctx.measureText('H');
    const glyphDrop = (lineHeightPx + (fontBox.fontBoundingBoxAscent || 0) - (fontBox.fontBoundingBoxDescent || fontSize)) / 2;
    // the content area's height: under a tight line height (< about 1.2) it reaches past the line box, both ways
    const glyphContentH = (fontBox.fontBoundingBoxAscent || 0) + (fontBox.fontBoundingBoxDescent || fontSize);
    const totalHeight = Math.max(lineHeightPx, wrappedLines.length * lineHeightPx);
    // canvasH, not canvas.height: this runs before the plate is (re)allocated, so
    // the cached canvas may still be at a previous frame's raster density.
    const blockTop = (canvasH - totalHeight) / 2;
    const rowMetrics = wrappedLines.map((row, idx) => {
      const rowText = row.join('');
      const rowWidth = measureTextWithLetterSpacing(ctx, rowText, letterSpacing);
      const rowX = textAlign === 'left'
        ? textMarginX
        : textAlign === 'right'
          ? canvasW - textMarginX - rowWidth
          : (canvasW - rowWidth) / 2;
      return { row, rowText, rowWidth, x: rowX, y: blockTop + idx * lineHeightPx };
    });
    const nonEmptyMetrics = rowMetrics.filter((m) => m.rowText.trim());
    const blockLeft = nonEmptyMetrics.length ? Math.min(...nonEmptyMetrics.map((m) => m.x)) : textMarginX;
    const blockRight = nonEmptyMetrics.length ? Math.max(...nonEmptyMetrics.map((m) => m.x + m.rowWidth)) : canvasW - textMarginX;
    const blockBox = { x: blockLeft, y: blockTop, w: Math.max(1, blockRight - blockLeft), h: totalHeight };
    let y = blockTop;
    // Randomizer style plan. The unit total is derived from the text itself (not
    // the build below) because the per-unit fonts must exist BEFORE measuring.
    // These counts match the build's counters exactly: words/symbols survive row
    // wrapping unchanged, lines = wrapped rows.
    const rndUnitsTotal = !rndEnabled ? 0
      : rndScope === 'lines' ? wrappedLines.length
        : rndScope === 'words' ? (text.match(/\S+/g) || []).length
          : Array.from(text).filter((c) => c.trim()).length;
    const rndStyles = rndEnabled && rndUnitsTotal > 0
      ? buildTextRandomPlan({
        dist: rndDist, nth: rndNth, seed: rndSeed,
        sizeOn: rndSizeOn, sizeMin: Math.min(rndSizeMin, rndSizeMax), sizeMax: Math.max(rndSizeMin, rndSizeMax),
        colorOn: rndColorOn, colors: rndColors, coverage: rndCoverage,
        weightOn: rndWeightOn, weights: [...rndWeights].sort((a, b) => a - b),
        italicOn: rndItalicOn, italicMode: rndItalicMode, italicShare: rndItalicShare,
      }, rndUnitsTotal)
      : null;
    const rndActive = !!(rndStyles && rndStyles.length);
    const rndFontFor = (style) => {
      const w = rndWeightOn && style.weight ? style.weight : fontWeight;
      const size = fontSize * (rndSizeOn ? style.sizeMul : 1);
      return `${fontItalic || (rndItalicOn && style.italic) ? 'italic ' : ''}${w} ${size}px ${fontFamily}`;
    };
    // Text Animators (textAnimators.js): each animator selects a range of units and
    // applies its effects to it. Null unless one would change something, so a layer
    // without animators runs exactly the code it ran before.
    const txaList = txaLiveAnimators(item.textAnimators);
    const txaActive = !!txaList;
    const txaMoves = txaActive && txaAnimatorsMove(txaList, (aid) => txaHasTrack(item.propertyKeyframes, aid));
    const layoutUnitsTotal = wrappedLines.reduce((sum, row) => sum + row.length, 0);
    // Flat draw plan: one entry per drawn token. The layout's tokens (words, or
    // characters with Wrap ▸ Anywhere) are subdivided to the FINEST grain any
    // consumer needs: the randomizer, text on path, the animators.
    const GRAIN = { lines: 0, words: 1, symbols: 2 };
    const rndGrainNeeded = rndActive ? GRAIN[rndScope] : GRAIN[splitMode];
    // Text on Path needs its own placement grain (letters or words) — every
    // unit gets an independent pose on the curve.
    const pathGrainNeeded = textPathOn ? GRAIN[textPathGrainMode] : GRAIN[splitMode];
    // Text Animators select by their finest "Based on" kind.
    const txaGrainNeeded = txaActive ? GRAIN[txaGrainOf(txaList)] : GRAIN[splitMode];
    const text3dGrainNeeded = text3dOn ? GRAIN.symbols : GRAIN[splitMode];
    const neededGrain = Math.max(GRAIN[splitMode], rndGrainNeeded, pathGrainNeeded, txaGrainNeeded, text3dGrainNeeded);
    const subdivide = neededGrain > GRAIN[splitMode];
    const subMode = neededGrain === 2 ? 'symbols' : 'words';
    const partsAreChars = subdivide ? subMode === 'symbols' : splitMode === 'symbols';
    const drawUnits = [];
    let txaCounts = null;
    if (rndActive || textPathOn || txaActive || text3dOn) {
      let wordCounter = 0;
      let symCounter = 0;
      // Every character, spaces included (Text Animators' "Characters").
      let charCounter = 0;
      // Word tracking survives row boundaries: in symbols mode a word can wrap
      // mid-word, and its continuation on the next row is still the same word.
      let inWord = false;
      let currentWordIdx = -1;
      rowMetrics.forEach((metric, rowIdx) => {
        const rowStart = drawUnits.length;
        let x = metric.x;
        const rowTokens = metric.row;
        const partsOf = (st) => (!subdivide
          ? [st]
          : subMode === 'symbols' ? Array.from(st) : (st.match(/\S+\s*/g) || [st]));
        // The row's units in order, to look one ahead: each unit advances by its own width PLUS
        // the letter spacing and the kerning to the next one — so the units add up to the same
        // width, glyph for glyph, as the whole row drawn in one piece (rowMetrics measures it so).
        const rowParts = rowTokens.flatMap(partsOf);
        let rowPartIdx = -1;
        for (const st of rowTokens) {
          const parts = partsOf(st);
          for (const part of parts) {
            rowPartIdx += 1;
            const isSpacePart = !part.trim();
            // Generic per-grain counters, shared by the randomizer and the
            // animators (each picks the index of its own granularity).
            let wIdx = -1;
            if (!isSpacePart) {
              if (partsAreChars) {
                if (!inWord) { currentWordIdx = wordCounter; wordCounter += 1; inWord = true; }
                wIdx = currentWordIdx;
              } else {
                wIdx = wordCounter;
                wordCounter += 1;
              }
            } else {
              inWord = false;
            }
            let sIdx = -1;
            if (!isSpacePart) { sIdx = symCounter; symCounter += 1; }
            const cIdx = partsAreChars ? charCounter++ : -1;
            const idxFor = (mode) => (mode === 'lines' ? rowIdx : mode === 'words' ? wIdx : sIdx);
            const rndIdx = rndActive ? idxFor(rndScope) : -1;
            const rndStyle = rndIdx >= 0 && rndStyles ? rndStyles[rndIdx] || null : null;
            const rndFont = rndStyle ? rndFontFor(rndStyle) : null;
            const tokSize = rndStyle && rndSizeOn ? fontSize * rndStyle.sizeMul : fontSize;
            // Measure with the unit's OWN font so the row re-flows around
            // randomized sizes/weights instead of overlapping.
            if (rndFont) ctx.font = rndFont;
            const w = measureTextWithLetterSpacing(ctx, part, letterSpacing);
            if (rndFont) ctx.font = baseFont;
            drawUnits.push({
              token: part,
              x,
              // Approximate baseline alignment: 'top' baseline + ~0.8em ascent,
              // so resized glyphs sit on the shared baseline instead of hanging
              // from the line-box top.
              y: metric.y + (fontSize - tokSize) * 0.8,
              w,
              wIdx,
              sIdx,
              cIdx,
              rowIdx,
              rndFont,
              rndColor: rndStyle && rndColorOn ? rndStyle.color : null,
              rndSize: tokSize,
            });
            const nextPart = rowParts[rowPartIdx + 1];
            x += w;
            if (nextPart != null && nextPart !== '') {
              x += letterSpacing;
              if (!rndActive) x += kernBetween(ctx, Array.from(part).pop(), Array.from(nextPart)[0]);
            }
          }
        }
        // Randomized fonts change the row's real width, so re-anchor it for the
        // alignment. Without the randomizer the loop above reproduces the
        // original absolute positions exactly — nothing to fix up.
        if (rndActive) {
          const styledWidth = x - metric.x;
          const newX = textAlign === 'left'
            ? textMarginX
            : textAlign === 'right'
              ? canvasW - textMarginX - styledWidth
              : (canvasW - styledWidth) / 2;
          const shift = newX - metric.x;
          if (Math.abs(shift) > 0.01) {
            for (let i = rowStart; i < drawUnits.length; i += 1) drawUnits[i].x += shift;
          }
          metric.x = newX;
          metric.rowWidth = styledWidth;
        }
      });
      txaCounts = { chars: charCounter, charsNoSpace: symCounter, words: wordCounter, lines: rowMetrics.length };
      // Keep the gradient/box math in sync with the re-anchored rows.
      if (rndActive) {
        const nem = rowMetrics.filter((m) => m.rowText.trim());
        blockBox.x = nem.length ? Math.min(...nem.map((m) => m.x)) : blockBox.x;
        const right = nem.length ? Math.max(...nem.map((m) => m.x + m.rowWidth)) : blockBox.x + blockBox.w;
        blockBox.w = Math.max(1, right - blockBox.x);
      }
    }
    // ── Text Animators ──
    // One evaluation per frame over the draw units: every unit carries its index for
    // each "Based on" kind, keyframed channels read their `txa:<aid>:<chan>` tracks.
    // Tracking reflows the rows HERE, before anything reads them (overflow plate,
    // path placement, footprint, caption bar, caret). Without a Tracking effect the
    // evaluation waits for the paint, so a cached plate costs nothing.
    let txaEval = null;
    // The engine's view of the units, built once per frame for the evaluation and
    // the plate's motion key. Voice animators read the caption's spoken windows
    // (wordWinSec: one per word, null when they don't fit the text) on the same
    // source-local clock as the split's transcript timing, so a trimmed or split
    // caption stays on the voice.
    let txaUnitList = null;
    const txaUnits = () => txaUnitList || (txaUnitList = drawUnits.map((du) => ({
      ch: du.token,
      space: !du.token.trim(),
      ci: du.cIdx,
      cn: du.sIdx,
      wi: du.wIdx,
      li: du.rowIdx,
      base: txaBaseRgb(du.rndColor || textColor),
    })));
    const txaVoice = wordWinSec ? { t: tSrcSec, wins: wordWinSec } : null;
    const txaRun = () => {
      const pk = item.propertyKeyframes;
      const pct = clamp(progress, 0, 1) * 100;
      return txaEvaluate({
        animators: txaList,
        units: txaUnits(),
        counts: txaCounts,
        time: clamp(progress, 0, 1) * (durationSec || 0),
        clipSec: durationSec || 0,
        voice: txaVoice,
        value: (aid, chan, stored) => {
          const track = pk?.[`${TXA_KF_PREFIX}${aid}:${chan}`];
          if (!Array.isArray(track) || !track.length) return stored;
          const v = evaluatePropertyTrack(track, pct);
          return Number.isFinite(v) ? v : stored;
        },
      });
    };
    if (txaActive && drawUnits.length && txaNeedsLayout(txaList)) {
      txaEval = txaRun();
      // Each unit pushes everything after it in its row (half of its own tracking
      // before it, half after), then the row re-anchors for its alignment.
      let row = -1;
      let cum = 0;
      let first = 0;
      const closeRow = (end) => {
        if (row < 0 || Math.abs(cum) < 0.01) return;
        const shift = textAlign === 'center' ? -cum / 2 : textAlign === 'right' ? -cum : 0;
        if (shift) for (let j = first; j < end; j += 1) drawUnits[j].x += shift;
        const metric = rowMetrics[row];
        if (metric) { metric.x += shift; metric.rowWidth += cum; }
      };
      for (let i = 0; i < drawUnits.length; i += 1) {
        const du = drawUnits[i];
        if (du.rowIdx !== row) { closeRow(i); row = du.rowIdx; cum = 0; first = i; }
        const tr = txaEval.states[i].track;
        du.x += cum + tr / 2;
        cum += tr;
      }
      closeRow(drawUnits.length);
      const nem = rowMetrics.filter((m) => m.rowText.trim());
      if (nem.length) {
        blockBox.x = Math.min(...nem.map((m) => m.x));
        blockBox.w = Math.max(1, Math.max(...nem.map((m) => m.x + m.rowWidth)) - blockBox.x);
      }
    }
    // Overflow texture: nowrap (or randomized sizes) can lay text wider than
    // the composition. Layout above is in composition coordinates; here the
    // texture canvas is sized to the content bounds — grown symmetrically, so
    // the composition centre stays the texture centre — and every position is
    // shifted into texture space. The mesh is scaled up by the same factor
    // after setup, so overflowing text isn't clipped at the layer edge and a
    // camera move can travel across it; the composition camera does the final
    // crop. Clip-mask text keeps the composition-sized plate (the matte
    // pipeline samples it 1:1). Capped at 4× the composition width.
    // LOGICAL plate width (composition units) and the adaptive raster density that
    // the backing canvas is allocated at. Everything the text draw does — layout,
    // glyph positions, gradients, path placement — stays in logical units; density
    // lives only in the canvas size and the ctx transform set below.
    let textLogicalW = canvasW;
    let textDensity = 1;
    // Static plate paint cache (see itemPaintFieldSignature): resolved once the
    // plate is allocated below, consumed by the `textPaint` block further down.
    let textPaintSkip = false;
    let textPaintSig = '';
    let textPaintPlate = null;
    {
      let contentLeft = Infinity;
      let contentRight = -Infinity;
      for (const m of rowMetrics) {
        if (!m.rowText.trim()) continue;
        contentLeft = Math.min(contentLeft, m.x);
        contentRight = Math.max(contentRight, m.x + m.rowWidth);
      }
      // A motion path can run far outside the composition; widen the plate to
      // cover its horizontal reach so path text isn't clipped at the layer
      // edge (same mechanism as the nowrap overflow). Vertical reach clips
      // like any tall text block — the composition camera crops there anyway.
      // A keyed path is sized from the reach of ALL its keys (cached per track), so
      // the plate keeps one width while the outline moves instead of reallocating.
      const textPathReach = textPathOn && !isMask && textPathKeyed
        ? motionPathTrackReach(item.propertyKeyframes?.[MOTION_PATH_KF_KEY], textPathObj.closed === true)
        : null;
      if (textPathReach) {
        const pad = fontSize * 2;
        contentLeft = Math.min(contentLeft, canvasW / 2 + textPathReach.min - pad);
        contentRight = Math.max(contentRight, canvasW / 2 + textPathReach.max + pad);
      } else if (textPathOn && !isMask) {
        const pad = fontSize * 2;
        for (let i = 0; i <= 64; i += 1) {
          const hit = evaluateObjectMotionPath(textPathObj, i / 64);
          if (!hit) break;
          contentLeft = Math.min(contentLeft, canvasW / 2 + hit.position.x - pad);
          contentRight = Math.max(contentRight, canvasW / 2 + hit.position.x + pad);
        }
      }
      const overhang = !isMask && Number.isFinite(contentLeft)
        ? Math.max(0, -contentLeft, contentRight - canvasW)
        : 0;
      const texW = overhang > 0.5 ? Math.min(Math.ceil(canvasW + 2 * overhang), canvasW * 4) : canvasW;
      textLogicalW = texW;
      // ── Adaptive raster density (continuous rasterization) ──
      // The logical plate is known now, so pose the mesh with the transform it will
      // really render with and measure how much the camera magnifies it. Grid
      // members render into a cell-sized target, so density beyond the cell buys
      // nothing and the cell transform isn't resolved yet here.
      //
      // NOTE the overhang already reaches 4x the composition width on its own; the
      // cap check below is fed texW (not canvasW) so the two cannot compound past
      // what the GPU can hold.
      if (engine.adaptiveRaster && !parentXform?.cell) {
        const densityCamera = cs?.rigged ? engine.posedCamera : engine.camera;
        const buffer = engine.renderer?.domElement;
        applyMeshTransform(mesh, item, keyframeProps, W, H, parentXform, clip, itemFollow);
        mesh.scale.x *= texW / W;
        mesh.updateWorldMatrix(true, false);
        const screenScale = measureScreenScale(
          mesh, densityCamera, W, H, texW, canvasH, buffer?.width || 0, buffer?.height || 0
        );
        const interactive = !engine.exporting;
        textDensity = resolveDensity({
          screenScale,
          logicalW: texW,
          logicalH: canvasH,
          caps: env.getRasterCaps(),
          previous: interactive ? engine.rasterDensity.get(item.id) : null,
          interactive,
          maxDensity: env.interactivePreviewEnabled ? 2 : Infinity,
          supersample: engine.rasterSupersample,
        });
        const budget = env.getRasterBudget();
        while (textDensity > 1) {
          if (budget.wouldFit(item.id, densityBytes(texW, canvasH, textDensity))) break;
          const idx = RASTER_DENSITY_BUCKETS.indexOf(textDensity);
          textDensity = idx > 0 ? RASTER_DENSITY_BUCKETS[idx - 1] : 1;
        }
        if (textDensity > 1) budget.note(item.id, densityBytes(texW, canvasH, textDensity));
        else budget.release(item.id);
        engine.rasterDensity.set(item.id, textDensity);
      }
      // Recreates the canvas + texture only when the size actually changed
      // (see ensureTextTexture); a stable overflow reuses last frame's canvas.
      textPaintPlate = ensureTextTexture(
        engine.refObjects.textTextureCache,
        item.id,
        Math.max(1, Math.round(texW * textDensity)),
        Math.max(1, Math.round(canvasH * textDensity)),
        engine.rasterSupersample && textDensity > 1
      );
      ({ canvas, ctx, texture: textTexture } = textPaintPlate);
      // The paint below reads the clock only through the caption-bar reveal (the
      // animators fold in their own motion key below); every other time-varying input
      // (keyframed paints, path distribution) is already resolved above and goes into
      // the signature as a value. So the clock is folded in only when the reveal is
      // live — a plain label's signature is the same on every frame and it never
      // repaints.
      const textPaintClock = bgInType !== 'none' || bgOutType !== 'none' ? progress : 0;
      // Text Animators only while they move (a track, Flow, Wiggle, a Scramble rate, a
      // blinking caret, a Time / Voice cascade in flight): the engine's motion key is the
      // time then, and a fixed token while a cascade rests, so a settled caption is a
      // cached plate again.
      const txaClock = txaMoves && drawUnits.length
        ? txaMotionKey(txaList, (aid) => txaHasTrack(item.propertyKeyframes, aid), {
          time: clamp(progress, 0, 1) * (durationSec || 0),
          clipSec: durationSec || 0,
          units: txaUnits(),
          counts: txaCounts,
          voice: txaVoice,
        })
        : null;
      textPaintSig = [
        itemPaintFieldSignature(item, TEXT_PAINT_KEY_RE),
        textPaintClock, txaClock === null ? '' : txaClock, durationSec || 0,
        letterSpacing, textColor, textOutlineColor, bgColor,
        textPathSpread, textPathSpacingPx, textPathTrimA, textPathTrimB, textPathOffY, textPathT,
        // The outline itself moves on a keyed path while the item object stays the same.
        textPathOn && textPathKeyed ? motionPathSignature(textPathObj.points) : '',
        textDensity, texW, canvasW, canvasH, canvas.width, canvas.height,
        isMask ? 1 : 0,
        (!engine.exporting && getInlineTextEditId() === item.id) ? 1 : 0,
        engine.fontLoadVersion,
        // Placeholders at this instant: the expanded VAR / MARKER text (project data,
        // not on the item) and each unit's key — constant once everything has landed.
        staticText !== rawText ? staticText : '',
        activeTextRun ? activeTextRun.sig : '',
      ].join('|');
      textPaintSkip = textPaintPlate.paintSig === textPaintSig;
      // Clear the whole BACKING STORE (physical), then put the context into logical
      // units so every draw below is written in composition coordinates unchanged.
      // A cached plate keeps its pixels: the clear is part of the skipped paint.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (!textPaintSkip) ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(textDensity, 0, 0, textDensity, 0, 0);
      ctx.font = baseFont;
      ctx.textBaseline = 'top';
      ctx.fillStyle = baseIsGradient ? gradientFirstStopColor(textColor, '#ffffff') : textColor;
      const dx = (texW - canvasW) / 2;
      if (dx > 0) {
        for (const m of rowMetrics) m.x += dx;
        for (const du of drawUnits) du.x += dx;
        blockBox.x += dx;
      }
    }
    // LOGICAL, never canvas.width. The plane's world size is scaled by
    // layerWidth / W below, so taking the physical backing-store width here would
    // make adaptive density ENLARGE the text layer instead of sharpening it.
    layerWidth = textLogicalW;
    textureRasterScale = textDensity;
    // The laid-out block, for the selection gizmo — this is the only place that
    // knows it (textFootprint.js). Plate units ARE composition units here: the
    // mesh is scaled by layerWidth / W right after, so the quad's world width is
    // the plate's. Path text publishes nothing: its glyphs ride a curve, so the
    // block box would describe a rectangle nothing is drawn in.
    if (textPathOn) {
      clearTextFootprint(item.id);
    } else {
      setTextFootprint(item.id, {
        width: blockBox.w,
        height: blockBox.h,
        offsetX: blockBox.x + blockBox.w / 2 - textLogicalW / 2,
        offsetY: blockBox.y + blockBox.h / 2 - canvasH / 2,
        plateWidth: textLogicalW,
        plateHeight: canvasH,
      });
    }
    // Everything from here to the upload is the PAINT: skipped wholesale while the
    // plate's last paint signature still matches (the layout above always runs —
    // the footprint, the plate size and the mesh geometry come from it).
    textPaint: {
    if (textPaintSkip) {
      engine.perfStats.textPaintSkips += 1;
      break textPaint;
    }
    const textPaintT0 = performance.now();
    // ── Text on Path placement ──
    // Arc-length parameterised, so glyph advances translate into real curve
    // distance and kerning survives corners. Each row restarts at the trim
    // window and stacks along the curve normal like line height; Align
    // anchors the run inside the window; Path Progress slides it along —
    // wrapping around a closed untrimmed loop (marquee), extrapolating
    // straight past the ends otherwise, so text can slide onto and off the
    // curve. Units without a pose keep their static layout position.
    if (textPathOn && drawUnits.length) {
      const arcTable = getTextPathArcTable(textPathObj);
      const totalLen = arcTable?.total || 0;
      if (totalLen > 1e-6) {
        const t0 = Math.min(textPathTrimA, textPathTrimB) / 100;
        const t1 = Math.max(textPathTrimA, textPathTrimB) / 100;
        const arc0 = t0 * totalLen;
        const arc1 = Math.max(arc0 + 1e-6, t1 * totalLen);
        const windowLen = arc1 - arc0;
        const wraps = textPathObj.closed === true && t0 <= 0.0001 && t1 >= 0.9999;
        const spreadMul = textPathSpread / 100;
        const poseAt = (arc) => {
          let a = arc;
          if (wraps) a = ((a % totalLen) + totalLen) % totalLen;
          const clamped = clamp(a, arc0, arc1);
          const hit = evaluateObjectMotionPath(textPathObj, arcLengthToParam(arcTable, clamped / totalLen));
          if (!hit) return null;
          const over = a - clamped;
          return {
            x: hit.position.x + hit.tangent.x * over,
            y: hit.position.y + hit.tangent.y * over,
            // World +y is up, canvas +y is down — flip the tangent for the
            // canvas rotation.
            ang: textPathRotate ? Math.atan2(-hit.tangent.y, hit.tangent.x) : 0,
            tang: Math.atan2(hit.tangent.y, hit.tangent.x),
          };
        };
        // Sharp corners: look past a rounded bend (¾ of the type size, or half the unit if wider) for the
        // straight sides, then lay the unit on the side its centre is on.
        // The unit keeps the side it RESTS on (homeArc: Path Progress 0) while it travels less than half its width.
        const sharpPoseAt = (arc, du, homeArc) => {
          const half = du.w * spreadMul * 0.5;
          const hit = sharpCornerPose(poseAt, arc, Math.max(half, fontSize * 0.75), homeArc, half);
          return hit ? { x: hit.x, y: hit.y, ang: textPathRotate ? -hit.tang : 0 } : null;
        };
        const rowCount = rowMetrics.length;
        const byRow = new Map();
        for (const du of drawUnits) {
          if (!byRow.has(du.rowIdx)) byRow.set(du.rowIdx, []);
          byRow.get(du.rowIdx).push(du);
        }
        for (const [rowIdx, units] of byRow) {
          const metric = rowMetrics[rowIdx];
          if (!metric) continue;
          const solids = units.reduce((sum, du) => sum + (du.token.trim() ? 1 : 0), 0);
          const n = Math.max(1, solids);
          // Arc offset of each unit's centre within the row's run, and the
          // run's total arc length (the alignment anchor). Natural spacing
          // keeps the measured advances (× Spread, + Spacing per gap); Even
          // ignores them and splits the trim window into equal slots.
          let runLen;
          let k = 0;
          if (textPathEven) {
            const slot = (windowLen * spreadMul) / n;
            runLen = windowLen * spreadMul + textPathSpacingPx * (n - 1);
            for (const du of units) {
              const idx = du.token.trim() ? k : Math.max(0, k - 0.5);
              du._pathArc = idx * (slot + textPathSpacingPx) + slot * 0.5;
              if (du.token.trim()) k += 1;
            }
          } else {
            for (const du of units) {
              du._pathArc = (du.x - metric.x + du.w * 0.5) * spreadMul + k * textPathSpacingPx;
              if (du.token.trim()) k += 1;
            }
            runLen = metric.rowWidth * spreadMul + textPathSpacingPx * Math.max(0, n - 1);
          }
          // Where the run rests at 0% progress. Forward parks it ON the first
          // point and Backward ends it on the last, so progress reads as travel
          // from one end of the curve to the other; Centred keeps the legacy
          // middle anchor and follows the layer's text align.
          const start = textPathDir === 'forward'
            ? arc0
            : textPathDir === 'backward'
              ? arc1 - runLen
              : textAlign === 'left'
                ? arc0
                : textAlign === 'right'
                  ? arc1 - runLen
                  : arc0 + (windowLen - runLen) / 2;
          // How far 100% carries the run. A wrapping loop always does a whole
          // lap. Otherwise: 'fit' stops when the run's FAR END reaches the far
          // point (the whole text lands on the path — the default), 'through'
          // keeps going until its LEADING unit gets there, sliding the text off
          // the end. Per row, because each row's run has its own length; a run
          // longer than the window has nowhere to travel under 'fit'.
          const travelSpan = wraps
            ? totalLen
            : textPathTravel === 'through'
              ? windowLen
              : Math.max(0, windowLen - runLen);
          const progressPx = (textPathT / 100)
            * (textPathDir === 'center' ? (wraps ? totalLen : windowLen) : travelSpan)
            * (textPathDir === 'backward' ? -1 : 1);
          const perp = textPathOffY + (rowIdx - (rowCount - 1) / 2) * lineHeightPx;
          for (const du of units) {
            const pose = textPathSharp
              ? sharpPoseAt(start + progressPx + du._pathArc, du, start + du._pathArc)
              : poseAt(start + progressPx + du._pathArc);
            if (!pose) continue;
            du._path = {
              cx: textLogicalW / 2 + pose.x,
              cy: canvasH / 2 - pose.y,
              ang: pose.ang,
              off: perp,
            };
          }
        }
      }
    }
    const tSecNow = clamp(progress, 0, 1) * (durationSec || 0);
    const fillForBox = (value, box, fallback) => (
      isCssGradient(value)
        ? (buildCanvasGradient(ctx, value, box) || gradientFirstStopColor(value, fallback))
        : (value || fallback)
    );
    // Set the glyph paint for one box: the fill, plus the outline when Fill Style
    // asks for one. Round joins because sharp corners on a heavy stroke throw
    // long spikes off the glyph, which no typeface wants.
    const setGlyphPaint = (value, box, fallback) => {
      ctx.fillStyle = fillForBox(value, box, fallback);
      if (glyphLineWidth > 0) {
        ctx.strokeStyle = fillForBox(textOutlineColor, box, fallback);
        ctx.lineWidth = glyphLineWidth;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
      }
    };
    // Text Animator light under a glyph: drop shadow and glow passes drawn as SHADOW
    // ONLY — the glyph goes far off the plate and only its shadow is pushed back
    // (shadow offsets are device px, untransformed) — so the glyph is never painted
    // twice. Then the stroke, under the fill, so it reads as an outline of the ink.
    // Clip-mask text gets neither light nor overlays: they would become coverage.
    // A unit's own Blur (drawToken's canvas filter) is folded into the shadow instead of
    // filtering it: the filter's layer would reach out to the glyph parked TXA_OFF px
    // away, and a blurred, glowing entrance (Smart Overshoot: ~5 passes a letter) fell
    // to ~25 fps. Both are device px (the filter ignores the transform); shadowBlur B is
    // a Gaussian of σ = B/2 and blur(r) one of σ = r, so together σ = √((B/2)² + r²).
    const TXA_OFF = 4096;
    const txaShadowOnly = (str, gx, gy, alpha, color, blur, ox, oy, unitBlur) => {
      const m = ctx.getTransform();
      ctx.save();
      if (unitBlur > 0.1) {
        ctx.filter = 'none';
        blur = Math.hypot(blur, 2 * unitBlur);
      }
      ctx.shadowColor = color;
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = m.a * TXA_OFF + ox;
      ctx.shadowOffsetY = m.b * TXA_OFF + oy;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#000';
      paintTextWithLetterSpacing(ctx, str, gx - TXA_OFF, gy, letterSpacing, 'fill');
      ctx.restore();
    };
    const txaStroke = (st, str, gx, gy, alpha, width) => {
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = txaRgbCss(st.stroke.c);
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      strokeTextWithLetterSpacing(ctx, str, gx, gy, letterSpacing);
      ctx.restore();
    };
    const txaDrawBehind = (st, str, gx, gy, alpha) => {
      if (!isMask) {
        if (st.shadow && st.shadow.alpha > 0.003) {
          txaShadowOnly(str, gx, gy, alpha, txaRgbCss(st.shadow.c, clamp(st.shadow.alpha, 0, 1)),
            st.shadow.blur * textDensity, st.shadow.x * textDensity, st.shadow.y * textDensity, st.blur);
        }
        if (st.glows) {
          for (const g of st.glows) {
            // Strength above 100 % adds passes (max 3), alternating wide and tight.
            const passes = clamp(Math.ceil(g.alpha), 1, 3);
            for (let p = 0; p < passes; p += 1) {
              txaShadowOnly(str, gx, gy, alpha, txaRgbCss(g.c, clamp(g.alpha / passes, 0, 1)),
                g.size * textDensity * (p % 2 ? 0.45 : 1), 0, 0, st.blur);
            }
          }
        }
      }
      if (st.stroke && st.stroke.w > 0.05 && !st.outlineK) txaStroke(st, str, gx, gy, alpha, st.stroke.w * 2);
    };
    const txaDrawOver = (du, st, str, gx, gy, alpha, blockLocal, unitLocal) => {
      if (du._txaOverlays && !isMask) {
        for (const o of du._txaOverlays) {
          if (!o.css || !(o.alpha > 0.002)) continue;
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0)';
          ctx.globalAlpha = alpha * clamp(o.alpha, 0, 1) * (1 - st.outlineK);
          ctx.fillStyle = fillForBox(o.css, o.unit ? unitLocal : blockLocal, '#ffffff');
          paintTextWithLetterSpacing(ctx, str, gx, gy, letterSpacing, 'fill');
          ctx.restore();
        }
      }
      if (st.stroke && st.stroke.w > 0.05 && st.outlineK > 0) txaStroke(st, str, gx, gy, alpha, st.stroke.w);
    };
    // 3D Text: every visible letter as { font, ch, color, alpha, index, m } where m
    // (row-major 4×4, plate px: x right, y DOWN, z AWAY) carries a glyph mesh —
    // built in raster px, y up, front on z = 0 (text3dGlyphs.js) — onto exactly
    // where drawToken would paint it: the animators' real 3D transform, the unit
    // centre (or its pose on the path), the glyph's draw origin, then the axis
    // flip and the raster → font-size scale.
    const buildText3dRun = () => {
      const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const T = (x, y) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0, 0, 0, 0, 1];
      const glyphs = [];
      const units = drawUnits.length ? drawUnits : [];
      for (const du of units) {
        const txa = du._txa || null;
        const alpha = txa ? txa.alpha : 1;
        if (alpha < 0.002) continue;
        const drawStr = txa ? txaGlyphFor(txa, du.token) : du.token;
        if (!drawStr || !drawStr.trim()) continue;
        const font = du.rndFont || baseFont;
        const tokFontSize = du.rndSize || fontSize;
        if (du.rndFont) ctx.font = du.rndFont;
        const drawW = measureTextWithLetterSpacing(ctx, drawStr, letterSpacing);
        let base;
        if (du._path) {
          const ca = Math.cos(du._path.ang || 0); const sa = Math.sin(du._path.ang || 0);
          base = txaM4Mul(
            txaM4Mul([ca, -sa, 0, du._path.cx, sa, ca, 0, du._path.cy, 0, 0, 1, 0, 0, 0, 0, 1], T(0, du._path.off || 0)),
            du._txaLocalM4 || I,
          );
        } else {
          base = txaM4Mul(du._txaM4 || I, T(du.x + du.w * 0.5, du.y + lineHeightPx * 0.5));
        }
        const k = tokFontSize / GLYPH_RASTER_PX;
        const color = du._txaPaint || du.rndColor || textColor;
        // One glyph per character (a symbol unit is one; a scrambled or word unit
        // lays its characters out by their own advances).
        let gx = -drawW * 0.5;
        const gy = -lineHeightPx * 0.5 + glyphDrop;
        for (const ch of Array.from(drawStr)) {
          const adv = measureTextWithLetterSpacing(ctx, ch, 0);
          if (ch.trim()) {
            const local = [k, 0, 0, gx, 0, -k, 0, gy, 0, 0, -k, 0, 0, 0, 0, 1];
            glyphs.push({ font, ch, color, alpha, index: Math.max(0, du.sIdx), fv: engine.fontLoadVersion, m: txaM4Mul(base, local) });
          }
          gx += adv + letterSpacing;
        }
        if (du.rndFont) ctx.font = baseFont;
      }
      return { plateW: textLogicalW, plateH: canvasH, settings: resolveText3d(item), glyphs };
    };
    const drawToken = (du) => {
      const { token, x: tokenX, y: tokenY, w: tokenWidth } = du;
      // Randomized units carry their own font size; everything sized off the
      // glyph (bars, decoration) follows it.
      const tokFontSize = du.rndSize || fontSize;
      let tokenAlpha = 1;
      let tokenBlur = 0;

      // Text Animator state (evaluated above): opacity and blur; its paint replaces
      // the unit's colour; scramble / character offset swap the text.
      const txa = du._txa || null;
      if (txa) {
        tokenAlpha *= txa.alpha;
        tokenBlur += txa.blur;
        if (tokenAlpha < 0.002) return;
        const m = du._txaM || du._txaLocal;
        if (m && Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-9) return;
      }
      const drawStr = txa ? txaGlyphFor(txa, token) : token;
      const tokenColor = du._txaPaint || du.rndColor || textColor;
      const tokenIsGradient = du._txaPaint ? isCssGradient(du._txaPaint) : baseIsGradient;
      const tokenCenterX = tokenX + tokenWidth * 0.5;
      const tokenCenterY = tokenY + lineHeightPx * 0.5;
      const localBlockBox = {
        x: blockBox.x - tokenCenterX,
        y: blockBox.y - tokenCenterY,
        w: blockBox.w,
        h: blockBox.h,
      };
      // A unit in perspective: the box around everything it paints (centred on cx, cy
      // in the frame its warp starts in, strokes included) and how far its light
      // reaches past that, device px.
      const txaContentBox = (cx, cy) => {
        const ex = Math.max(tokenWidth, drawW) * 0.5;
        const ey = Math.max(lineHeightPx, glyphContentH) * 0.5 + Math.max(0, tokFontSize - fontSize) * 1.6;
        const pad = lineHeightPx * 0.15 + tsSpread + glyphLineWidth + (txa?.stroke ? txa.stroke.w : 0) + 2;
        return { x0: cx - ex - pad, y0: cy - ey - pad, x1: cx + ex + pad, y1: cy + ey + pad };
      };
      const txaReachDev = () => {
        let r = 3 * tokenBlur + 1.5 * tsBlur + Math.max(Math.abs(tsX), Math.abs(tsY));
        if (txa?.shadow) r += (Math.abs(txa.shadow.x) + Math.abs(txa.shadow.y) + 1.5 * txa.shadow.blur) * textDensity;
        if (txa?.glows) r += 1.5 * Math.max(...txa.glows.map((g) => g.size)) * textDensity;
        return r;
      };
      ctx.save();
      if (du.rndFont) ctx.font = du.rndFont;
      const drawW = drawStr === token ? tokenWidth : measureTextWithLetterSpacing(ctx, drawStr, letterSpacing);
      // Text Animator transform: layout space, around each animator's unit (a path
      // unit gets it local to its pose instead, below). The mask box rides it.
      // With depth (Rotate 3D) the unit is painted flat into a scratch canvas from
      // here on (`ctx` points at it) and warped onto the plate after the restore.
      if (du._txaMaskBox) {
        const b = du._txaMaskBox;
        ctx.beginPath();
        ctx.rect(b.x0 - 2, b.y0, b.x1 - b.x0 + 4, b.y1 - b.y0);
        ctx.clip();
      }
      let txaWarp = null;
      if (du._txaH && !du._path) {
        txaWarp = txaWarpBegin(ctx, du._txaH, txaContentBox(
          tokenX + tokenWidth * 0.5,
          tokenY + lineHeightPx * 0.5,
        ), txaScratch(), txaReachDev());
        if (!txaWarp) { ctx.restore(); return; }
        ctx = txaWarp.ctx;
      } else if (du._txaM) { const m = du._txaM; ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]); }
      // Apply blur via canvas filter (per-unit)
      if (tokenBlur > 0.1) {
        ctx.filter = `blur(${tokenBlur}px)`;
      }
      if (du._path) {
        // Resting pose on the curve, then the animators' transform in the pose's
        // local frame — a slide-up slides "up" relative to the rotated glyph.
        ctx.translate(du._path.cx, du._path.cy);
        if (du._path.ang) ctx.rotate(du._path.ang);
        ctx.translate(0, du._path.off);
        if (du._txaLocalH) {
          txaWarp = txaWarpBegin(ctx, du._txaLocalH, txaContentBox(0, 0), txaScratch(), txaReachDev());
          if (!txaWarp) { ctx.restore(); return; }
          ctx = txaWarp.ctx;
        } else if (du._txaLocal) { const m = du._txaLocal; ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]); }
      } else {
        ctx.translate(tokenX + tokenWidth * 0.5, tokenY + lineHeightPx * 0.5);
      }
      ctx.globalAlpha = tokenAlpha;
      // A Text Animator gradient that spans each unit paints across the unit's own box.
      const unitLocalBox = { x: -tokenWidth * 0.5, y: -lineHeightPx * 0.5, w: tokenWidth, h: lineHeightPx };
      ctx.fillStyle = tokenIsGradient
        ? fillForBox(tokenColor, du._txaUnitSpan ? unitLocalBox : localBlockBox, '#ffffff')
        : tokenColor;
      if (glyphLineWidth > 0) {
        ctx.strokeStyle = fillForBox(textOutlineColor, localBlockBox, '#ffffff');
        ctx.lineWidth = glyphLineWidth;
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
      }
      const glyphX = -drawW * 0.5;
      const glyphY = -lineHeightPx * 0.5 + glyphDrop;
      if (txa) txaDrawBehind(txa, drawStr, glyphX, glyphY, tokenAlpha);
      drawShadowSpreadPass(drawStr, glyphX, glyphY);
      if (txa && txa.outlineK > 0) ctx.globalAlpha = tokenAlpha * (1 - txa.outlineK);
      paintTextWithLetterSpacing(ctx, drawStr, glyphX, glyphY, letterSpacing, textFillMode);
      if (txa) txaDrawOver(du, txa, drawStr, glyphX, glyphY, tokenAlpha, localBlockBox, unitLocalBox);
      if (token.trim()) drawTextDecorationLine(ctx, textDecoration, -tokenWidth * 0.5, glyphY, tokenWidth, tokFontSize, textFillMode);
      ctx.restore();
      if (txaWarp) {
        ctx = txaWarp.plate;
        txaWarpEnd(txaWarp);
        ctx.restore();
      }
    };
    // Text Animators: hand every draw unit its evaluated state, its transform (around
    // each animator's unit — letter, word, line or the whole text — over the units'
    // final layout, at the layer's Pivot X / Y) and its paint. A unit on a path turns
    // around its own pose, like the split's offsets. A transform with depth (Rotate
    // 3D) is a homography (_txaH / _txaLocalH, drawn by warp); any other an affine
    // (_txaM / _txaLocal). Runs only when the plate really repaints.
    if (txaActive && drawUnits.length) {
      if (!txaEval) txaEval = txaRun();
      const lay = txaLayerSettings(item);
      const pivot = { x: lay.pivotX / 100, y: lay.pivotY / 100 };
      // Pivot boxes span each unit's ink: a word unit's trailing space is not part of
      // what turns (drawn letter by letter, that space is a unit of its own).
      const boxOf = txaEval.states.some((st) => st.xf || st.mask)
        ? txaGroupBoxes(drawUnits.map((du) => {
          let ink = du.w;
          if (/\s$/.test(du.token)) {
            const t = du.token.replace(/\s+$/, '');
            if (!t) ink = 0;
            else {
              if (du.rndFont) ctx.font = du.rndFont;
              ink = measureTextWithLetterSpacing(ctx, t, letterSpacing);
              if (du.rndFont) ctx.font = baseFont;
            }
          }
          return { x0: du.x, y0: du.y, x1: du.x + ink, y1: du.y + lineHeightPx, wi: du.wIdx, li: du.rowIdx };
        }))
        : null;
      // Mask boxes hug the INK, not the line box: text hangs from the em top with all
      // the leading below, so a line box's bottom sat ~½ em under the baseline — the cut
      // floated below the letters and a rise shorter than a line never hid them. Down:
      // ONE band per row, its highest ink top to its lowest ink bottom (each unit in its
      // own font), so the cut runs straight along the line. Across: the unit's advance
      // plus any ink past it (italic overhang). Grown by the layer's resting paint —
      // outline, text shadow, under/overline — which the clip would otherwise cut.
      let maskBoxOf = null;
      if (txaEval.states.some((st) => st.mask)) {
        const sX = Number.isFinite(item.textShadowX) ? item.textShadowX : 0;
        const sY = Number.isFinite(item.textShadowY) ? item.textShadowY : 0;
        const sBlur = clamp(Number(item.textShadowBlur) || 0, 0, 200);
        const sSpread = clamp(Number(item.textShadowSpread) || 0, 0, 50);
        const lit = !isMask && (sBlur > 0.01 || Math.abs(sX) > 0.01 || Math.abs(sY) > 0.01 || sSpread > 0.01);
        // 2 device px keep the glyphs' antialiased fringe (and the clip's own) inside.
        const halo = 2 / Math.min(1, textDensity) + glyphLineWidth / 2 + (lit ? sSpread + 1.5 * sBlur : 0);
        const rows = new Map();
        const ink = drawUnits.map((du) => {
          const t = du._path ? '' : du.token.replace(/\s+$/, '');
          if (!t) return null;
          if (du.rndFont) ctx.font = du.rndFont;
          const m = ctx.measureText(t);
          if (du.rndFont) ctx.font = baseFont;
          const fs = du.rndSize || fontSize;
          const gy = du.y + glyphDrop;
          let y0 = gy - m.actualBoundingBoxAscent;
          let y1 = gy + m.actualBoundingBoxDescent;
          if (textDecoration === 'underline') y1 = Math.max(y1, gy + fs * 0.88 + Math.max(1, fs / 16));
          else if (textDecoration === 'overline') y0 = Math.min(y0, gy - fs * 0.15);
          const r = rows.get(du.rowIdx);
          if (r) { r.y0 = Math.min(r.y0, y0); r.y1 = Math.max(r.y1, y1); } else rows.set(du.rowIdx, { y0, y1 });
          return { x0: du.x - m.actualBoundingBoxLeft, x1: du.x + m.actualBoundingBoxRight };
        });
        // A space keeps x1 = x0, so it joins no word or line box.
        maskBoxOf = txaGroupBoxes(drawUnits.map((du, i) => {
          const adv = boxOf(i, 'char');
          const r = rows.get(du.rowIdx) || { y0: du.y, y1: du.y + lineHeightPx };
          const k = ink[i];
          return {
            x0: k ? Math.min(adv.x0, k.x0) - halo - (lit ? Math.max(0, -sX) : 0) : adv.x0,
            x1: k ? Math.max(adv.x1, k.x1) + halo + (lit ? Math.max(0, sX) : 0) : adv.x0,
            y0: r.y0 - halo - (lit ? Math.max(0, -sY) : 0),
            y1: r.y1 + halo + (lit ? Math.max(0, sY) : 0),
            wi: du.wIdx,
            li: du.rowIdx,
          };
        }));
      }
      drawUnits.forEach((du, i) => {
        const st = txaEval.states[i];
        du._txa = st;
        // Mask: the unit's resting ink box at its animator's unit; drawToken clips to it
        // before the transform.
        if (st.mask && maskBoxOf && !du._path) du._txaMaskBox = maskBoxOf(i, st.mask);
        if (st.xf) {
          if (du._path) {
            const own = { x0: -du.w / 2, y0: -lineHeightPx / 2, x1: du.w / 2, y1: lineHeightPx / 2 };
            const tf = txaUnitTransform(st.xf, () => own, pivot);
            if (tf.projective) du._txaLocalH = tf.H;
            else du._txaLocal = txaHToCanvas(tf.H);
            if (text3dOn) du._txaLocalM4 = txaUnitTransform3d(st.xf, () => own, pivot);
          } else {
            // Under a mask a rise travels at least the mask box, so it starts hidden.
            const mb = du._txaMaskBox;
            const tf = txaUnitTransform(mb ? txaMaskedXf(st, mb.y1 - mb.y0) : st.xf, (lv) => boxOf(i, lv), pivot);
            if (tf.projective) du._txaH = tf.H;
            else du._txaM = txaHToCanvas(tf.H);
            if (text3dOn) du._txaM4 = txaUnitTransform3d(st.xf, (lv) => boxOf(i, lv), pivot);
          }
        }
        if (st.touched) {
          const css = txaPaintCss(st.paint);
          if (css) {
            if (st.baseKnown) du._txaPaint = css;
            else du._txaOverlays = [{ css, alpha: st.paintK, unit: st.paint.type === 'grad' && st.paint.span === 'unit' }];
            du._txaUnitSpan = st.paint.type === 'grad' && st.paint.span === 'unit';
          }
        }
        if (st.overlays) {
          du._txaOverlays = (du._txaOverlays || []).concat(st.overlays.map((o) => ({ css: txaPaintCss(o), alpha: o.alpha, unit: o.span === 'unit' })));
        }
      });
    }
    // Background pass first, so every line's bar sits behind the glyphs.
    // On a path there is no straight row to bar — the caption background is
    // suppressed (the per-token highlight bar still follows the curve).
    if ((bgEnabled || borderEnabled) && !textPathOn) {
      // Reveal window: In plays over textBgInDuration seconds starting
      // textBgInDelay into the item (the bar is absent during the delay), Out
      // over the last textBgOutDuration — the same item-local clock (tSecNow)
      // the split reveal uses. Whichever window is active supplies the mask;
      // on an item shorter than both windows the Out wins so the bar still
      // clears the frame before the item ends.
      // Grow Shape's appearance runs on its own duration inside the same slot
      // (In: from the delay; Out: ending with the item), so a slot stays live
      // while EITHER its grow or its appearance is still moving.
      let bgRevealType = 'none';
      let bgRevealStyle = 'wipe';
      let bgRevealSlot = 'in';
      let bgReveal = 1;
      let bgAppear = null;
      if (bgOutType !== 'none' && durationSec > 0) {
        // Mirrored sequence on the way out: the bar retracts to its seed first,
        // then the seed zooms away over the item's last appear-duration seconds.
        const outSeq = bgOutStyle === 'grow' && bgOutAppear === 'scale-in';
        const q = clamp((tSecNow - Math.max(0, durationSec - bgOutDuration - (outSeq ? bgOutAppearDuration : 0))) / bgOutDuration, 0, 1);
        const aq = bgOutAppear !== 'none'
          ? clamp((tSecNow - Math.max(0, durationSec - bgOutAppearDuration)) / bgOutAppearDuration, 0, 1) : 0;
        if (q > 0 || aq > 0) {
          bgRevealType = bgOutType;
          bgRevealStyle = bgOutStyle;
          bgRevealSlot = 'out';
          bgReveal = 1 - applyGsapEasing(q, bgOutEasing);
          if (bgOutStyle === 'grow') bgAppear = { mode: bgOutAppear, q: bgOutAppear !== 'none' ? 1 - applyGsapEasing(aq, bgOutAppearEasing) : 1, start: bgOutGrowStart };
        }
      }
      if (bgRevealSlot === 'in' && bgInType !== 'none') {
        // Scale-in is SEQUENTIAL: the seed zooms in first, the extension follows.
        const inSeq = bgInStyle === 'grow' && bgInAppear === 'scale-in';
        const p = clamp((tSecNow - bgInDelay - (inSeq ? bgInAppearDuration : 0)) / bgInDuration, 0, 1);
        const ap = bgInAppear !== 'none' ? clamp((tSecNow - bgInDelay) / bgInAppearDuration, 0, 1) : 1;
        if (p < 1 || ap < 1) {
          bgRevealType = bgInType;
          bgRevealStyle = bgInStyle;
          bgReveal = applyGsapEasing(p, bgInEasing);
          if (bgInStyle === 'grow') bgAppear = { mode: bgInAppear, q: bgInAppear !== 'none' ? applyGsapEasing(ap, bgInAppearEasing) : 1, start: bgInGrowStart };
        }
      }
      if (bgRevealType === 'none' || bgReveal > 0.0005 || (bgAppear && bgAppear.q > 0.0005)) {
        ctx.save();
        ctx.fillStyle = bgColor;
        const radius = bgRadius != null ? bgRadius : Math.min(bgPadX, bgPadY, fontSize * 0.4, 40);
        const barPaint = { fill: bgEnabled, border: bgBorder };
        for (const metric of rowMetrics) {
          const { rowText, rowWidth, x: rx, y: by } = metric;
          if (rowText.trim()) {
            drawTextBgRevealBar(
              ctx,
              rx - bgPadX, by + glyphDrop - bgPadY, rowWidth + bgPadX * 2, fontSize + bgPadY * 2,
              radius, bgRevealType, bgRevealStyle, bgRevealSlot, bgReveal, barPaint, bgAppear,
            );
          }
        }
        ctx.restore();
      }
    }
    // Text Animator highlight boxes: one bar per run in a row (or one Block around
    // them all) at the units' layout position, behind the glyphs and free of the text
    // shadow. The geometry is the engine's boxRects, shared with the lab and the
    // preset tiles. Not on a path (no straight row to bar).
    // Units as the engine's box / caret cells. Word units carry their trailing space;
    // a finished bar (or a caret at the end) stops at the ink.
    const txaCells = () => drawUnits.map((du) => {
      let ink = du.w;
      if (/\s$/.test(du.token)) {
        const t = du.token.replace(/\s+$/, '');
        if (!t) ink = 0;
        else {
          if (du.rndFont) ctx.font = du.rndFont;
          ink = measureTextWithLetterSpacing(ctx, t, letterSpacing);
          if (du.rndFont) ctx.font = baseFont;
        }
      }
      return { row: du.rowIdx, x: du.x, w: du.w, ink, top: du.y + glyphDrop, bottom: du.y + glyphDrop + fontSize };
    });
    if (txaEval && txaEval.boxes.length && !isMask && !textPathOn) {
      const cells = txaCells();
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0)';
      for (const { v, amt, groups } of txaEval.boxes) {
        ctx.fillStyle = v.color;
        for (const q of txaBoxRects(v, amt, cells, groups)) {
          ctx.globalAlpha = q.alpha;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0, q.r);
          else ctx.rect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0);
          ctx.fill();
        }
      }
      ctx.restore();
    }
    // Text shadow: set on the context AFTER the background pass (bars stay
    // shadow-free) so every glyph fill below picks it up. Reset explicitly when
    // off — the canvas/context is reused across frames.
    // shadowOffsetX/Y and shadowBlur are NOT transformed by the CTM (per the canvas
    // spec), so unlike every other value here they have to carry the raster density
    // themselves — otherwise a shadow shrinks as the plate is drawn denser. The
    // shape path scales its shadows for the same reason. tsSpread is deliberately
    // NOT scaled: it becomes ctx.lineWidth, which the CTM does transform.
    const tsX = (Number.isFinite(item.textShadowX) ? item.textShadowX : 0) * textDensity;
    const tsY = (Number.isFinite(item.textShadowY) ? item.textShadowY : 0) * textDensity;
    const tsBlur = clamp(Number(item.textShadowBlur) || 0, 0, 200) * textDensity;
    const tsSpread = isMask ? 0 : clamp(Number(item.textShadowSpread) || 0, 0, 50);
    const tsColor = typeof item.textShadowColor === 'string' && item.textShadowColor ? item.textShadowColor : 'rgba(0,0,0,0.75)';
    if (!isMask && (tsBlur > 0.01 || Math.abs(tsX) > 0.01 || Math.abs(tsY) > 0.01 || tsSpread > 0.01)) {
      ctx.shadowColor = tsColor;
      ctx.shadowOffsetX = tsX;
      ctx.shadowOffsetY = tsY;
      ctx.shadowBlur = tsBlur;
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.shadowBlur = 0;
    }
    // Shadow SPREAD pass: stroke the glyph run in the shadow colour with
    // lineWidth = spread*2 while the same shadow offset/blur is active — the
    // stroke dilates the silhouette so its shadow reads as a spread shadow
    // (standard canvas approximation). Runs before each normal fill pass;
    // spread 0 skips it entirely, keeping today's behaviour bit-identical.
    const drawShadowSpreadPass = (str, sx, sy) => {
      if (!(tsSpread > 0.01) || !str) return;
      ctx.save();
      ctx.shadowColor = tsColor;
      ctx.shadowOffsetX = tsX;
      ctx.shadowOffsetY = tsY;
      ctx.shadowBlur = tsBlur;
      ctx.strokeStyle = tsColor;
      ctx.lineWidth = tsSpread * 2;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      strokeTextWithLetterSpacing(ctx, str, sx, sy, letterSpacing);
      ctx.restore();
    };
    if (text3dOn) {
      // 3D Text: no glyph is painted — the run carries every letter to the 3D
      // pass (model3dLayer.js renderText3dLayer), which films it.
      textPaintPlate.text3dRun = buildText3dRun();
    } else if (!rndActive && !textPathOn && !txaActive) {
      setGlyphPaint(textColor, blockBox, '#ffffff');
      for (const metric of rowMetrics) {
        const { rowText, rowWidth } = metric;
        const x = metric.x;
        y = metric.y + glyphDrop;
        drawShadowSpreadPass(rowText, x, y);
        paintTextWithLetterSpacing(ctx, rowText, x, y, letterSpacing, textFillMode);
        if (rowText.trim()) drawTextDecorationLine(ctx, textDecoration, x, y, rowWidth, fontSize, textFillMode);
      }
    } else {
      // The randomizer and text on path draw per unit even without animators — no
      // animation state applies then, so drawToken is a styled static draw.
      for (const du of drawUnits) drawToken(du);
    }
    // Advanced Animations ▸ Caret: a text cursor at its animator's reveal front (the
    // engine's caretRect), drawn over the glyphs.
    if (txaEval && txaEval.carets.length && drawUnits.length && !isMask && !textPathOn) {
      const cells = txaCells();
      const tNow = clamp(progress, 0, 1) * (durationSec || 0);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0)';
      for (const c of txaEval.carets) {
        const r = txaCaretRect(c, cells, tNow);
        if (!r) continue;
        ctx.globalAlpha = r.alpha;
        ctx.fillStyle = r.color || (isCssGradient(textColor) ? gradientFirstStopColor(textColor, '#ffffff') : textColor);
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
      ctx.restore();
    }
    if (layoutUnitsTotal === 0) {
      ctx.globalAlpha = 1;
      setGlyphPaint(textColor, blockBox, '#ffffff');
      const fallbackWidth = measureTextWithLetterSpacing(ctx, text, letterSpacing);
      const fallbackX = (textLogicalW - fallbackWidth) / 2;
      const fallbackY = (canvasH - lineHeightPx) / 2 + glyphDrop;
      drawShadowSpreadPass(text, fallbackX, fallbackY);
      paintTextWithLetterSpacing(ctx, text, fallbackX, fallbackY, letterSpacing, textFillMode);
      drawTextDecorationLine(ctx, textDecoration, fallbackX, fallbackY, fallbackWidth, fontSize, textFillMode);
    }
    // Inline preview editing: the DOM editor over the canvas is showing this
    // layer's text, so the plate goes up blank — everything above still ran
    // (the editor's box rides the footprint the layout publishes), only the
    // finished paint is wiped. Cheaper-looking gates on the paint calls above
    // would have to chase every pass (bars, shadow, highlight, tokens);
    // clearing once here cannot miss one.
    if (!engine.exporting && getInlineTextEditId() === item.id) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    textTexture.needsUpdate = true;
    textPaintPlate.paintSig = textPaintSig;
    engine.perfStats.textPaints += 1;
    engine.perfStats.textPaintMs += performance.now() - textPaintT0;
    }
    setActiveTextRun(null);
    texture = textTexture;
    // The run of the last paint (a skipped paint keeps the one it would have made).
    mesh.userData.text3dRun = text3dOn ? (textPaintPlate.text3dRun || null) : null;
  } else if (clip.mediaType === 'shape') {
    // Keyframed Width / Height / Radius (shapePath.js withShapeSizeKeyframes) and
    // Border width / colour (borderKeyframes.js) size the plate and the draw; the
    // same item object comes back when none is keyed.
    const shapeItem = withBorderKeyframes(withShapeSizeKeyframes(item, keyframeProps), keyframeProps);
    // A keyframed `shapePath` track carries a whole point list per key, morphed
    // point-by-point; it wins over the item's static path for this frame. Both it
    // and the stroke/trim tracks resolve BEFORE the layout, because the plate has
    // to be sized for the geometry and the stroke width actually about to be drawn.
    const isPathShape = item.shapeType === 'path' || item.shapeType === 'line';
    let pathPoints = isPathShape ? (item.shapePath?.points || null) : null;
    const shapeKf = isPathShape && itemHasKeyframes(item) ? keyframeProps : null;
    if (pathPoints && shapeKf) {
      const morphed = shapeKf[SHAPE_PATH_KF_KEY];
      if (Array.isArray(morphed) && morphed.length >= 2) pathPoints = morphed;
    }
    const shapeLine = isStrokeShape(item) ? resolveLineSettings(item, shapeKf) : null;
    // Copies with a trim stagger replay the keyframed trim late — one delay per
    // copy, resolved here because only the Player has the tracks and the clock.
    if (shapeLine) {
      const delays = strokeCopyDelays(shapeLine);
      const pk = item.propertyKeyframes;
      if (delays && (pk?.lineTrimStart?.length || pk?.lineTrimEnd?.length || pk?.lineTrimOffset?.length)) {
        const dur = Math.max(1e-6, durationSec || 0);
        const now = clamp(progress || 0, 0, 1) * dur;
        const at = (key, fallback, pct) => {
          const track = pk?.[key];
          if (!Array.isArray(track) || !track.length) return fallback;
          const v = evaluatePropertyTrack(track, pct, false);
          return Number.isFinite(v) ? v : fallback;
        };
        shapeLine.copyTrims = delays.map((d) => {
          const pct = clamp((now - d) / dur, 0, 1) * 100;
          return {
            start: at('lineTrimStart', shapeLine.trimStart, pct),
            end: at('lineTrimEnd', shapeLine.trimEnd, pct),
            offset: at('lineTrimOffset', shapeLine.trimOffset, pct),
          };
        });
      }
    }
    // ── Adaptive raster density (continuous rasterization) ──
    // The LOGICAL layout comes first: plate dimensions never depend on density.
    // Then pose the mesh with the transform it will really render with, project its
    // corners through the camera that films this channel, and rasterize at the
    // resolution the plate actually occupies on screen. The mesh is posed again for
    // real further down (with the grid-cell transform folded in), so this
    // provisional pose leaves nothing behind.
    const logicalLayout = getShapeTextureLayout(shapeItem, W, H, { pathPoints, line: shapeLine });
    let shapeDensity = 1;
    // Grid members render into a cell-sized target, so density beyond the cell's own
    // resolution buys nothing — and the cell transform isn't resolved yet here.
    if (engine.adaptiveRaster && !parentXform?.cell) {
      const densityCamera = cs?.rigged ? engine.posedCamera : engine.camera;
      const buffer = engine.renderer?.domElement;
      applyMeshTransform(mesh, item, keyframeProps, W, H, parentXform, clip, itemFollow);
      mesh.scale.x *= logicalLayout.plateWidth / W;
      mesh.scale.y *= logicalLayout.plateHeight / H;
      mesh.updateWorldMatrix(true, false);
      const screenScale = measureScreenScale(
        mesh,
        densityCamera,
        W,
        H,
        logicalLayout.plateWidth,
        logicalLayout.plateHeight,
        buffer?.width || 0,
        buffer?.height || 0
      );
      // Hysteresis is stateful, so it is preview-only: an export bucket must be a
      // pure function of the frame or a range render would not match a full one.
      const interactive = !engine.exporting;
      shapeDensity = resolveDensity({
        screenScale,
        logicalW: logicalLayout.plateWidth,
        logicalH: logicalLayout.plateHeight,
        caps: env.getRasterCaps(),
        previous: interactive ? engine.rasterDensity.get(item.id) : null,
        interactive,
        // Playback at "auto" quality holds back to protect frame rate; a paused
        // preview and every export get the full ladder.
        maxDensity: env.interactivePreviewEnabled ? 2 : Infinity,
        supersample: engine.rasterSupersample,
      });
      // Stay inside the texture-memory budget: step down until the plate fits
      // alongside everything else already magnified.
      const budget = env.getRasterBudget();
      while (shapeDensity > 1) {
        const bytes = densityBytes(logicalLayout.plateWidth, logicalLayout.plateHeight, shapeDensity);
        if (budget.wouldFit(item.id, bytes)) break;
        const idx = RASTER_DENSITY_BUCKETS.indexOf(shapeDensity);
        shapeDensity = idx > 0 ? RASTER_DENSITY_BUCKETS[idx - 1] : 1;
      }
      // Only MAGNIFIED plates are tracked — a layer back at 1x costs what it always
      // cost and drops out of the budget. Known gap: a plate that leaves the
      // playhead while still magnified keeps its entry until it renders again,
      // which overstates the total until then. Bounded, and it only ever makes the
      // budget more conservative.
      if (shapeDensity > 1) {
        budget.note(item.id, densityBytes(logicalLayout.plateWidth, logicalLayout.plateHeight, shapeDensity));
      } else {
        budget.release(item.id);
      }
      engine.rasterDensity.set(item.id, shapeDensity);
    }
    const layout = shapeDensity === 1
      ? logicalLayout
      : getShapeTextureLayout(shapeItem, W, H, {
        pathPoints,
        line: shapeLine,
        density: shapeDensity,
        maxRasterDim: env.getRasterCaps().maxDim,
      });
    const shapePlate = ensureTextTexture(
      engine.refObjects.textTextureCache,
      item.id,
      layout.rasterWidth,
      layout.rasterHeight,
      engine.rasterSupersample && shapeDensity > 1
    );
    const { canvas, ctx, texture: shapeTexture } = shapePlate;
    // Clip-local elapsed seconds drive animated shape backgrounds, so each
    // shape animates from its own start (deterministic in preview/export).
    // A `shapeFill` keyframe track overrides the background paint for this
    // frame — solid or gradient, applied only while the background type is
    // one of those two (shader/pattern/image fills keep their own pipeline).
    const kfShapeFill = evaluatePropertyTrack(item.propertyKeyframes?.shapeFill, clamp(progress || 0, 0, 1) * 100, true);
    const shapeFillOverride = typeof kfShapeFill === 'string' && kfShapeFill ? kfShapeFill : null;
    const shapeTime = Math.max(0, (progress || 0) * (durationSec || 0));
    // Static plate paint cache (see itemPaintFieldSignature). The painter reads the
    // clock only through an animated gradient pan or a shader/pattern/image fill
    // (drawEditorBackground), and its geometry moves only through a `shapePath`
    // morph track — everything else it draws is a field on the item, a resolved
    // keyframe value (fill, line settings) or the layout's numbers. A custom SVG
    // that has not decoded yet paints nothing, so its readiness is a key too.
    const shapeBgType = item.shapeBackground?.type || 'solid';
    const shapeFillMoves = (shapeBgType === 'gradient' && !!item.shapeBackground?.gradientAnimated)
      || (shapeBgType !== 'solid' && shapeBgType !== 'transparent' && shapeBgType !== 'gradient');
    const shapeGeomMoves = !!(shapeKf && Array.isArray(shapeKf[SHAPE_PATH_KF_KEY]))
      // dash march, flows, wiggle, boil… (pathStroke.js strokeEngineMoves)
      || (!!shapeLine && strokeEngineMoves(shapeLine));
    const shapeSvgEntry = (item.shapeType === 'custom' || item.shapeType === 'vector') && item.shapeSvgUrl
      ? getShapeSvgImage(item.shapeSvgUrl)
      : null;
    const shapePaintSig = [
      itemPaintFieldSignature(item, SHAPE_PAINT_KEY_RE),
      shapeFillMoves || shapeGeomMoves ? shapeTime : 0,
      shapeFillOverride || '',
      shapeLine ? JSON.stringify(shapeLine) : '',
      layout.rasterWidth, layout.rasterHeight, layout.rasterScale,
      layout.plateWidth, layout.plateHeight, layout.shapeWidth, layout.shapeHeight,
      // keyframed corner radius (withShapeSizeKeyframes) — not on the raw item
      shapeItem === item ? '' : `${shapeItem.borderRadius},${shapeItem.borderRadiusTL},${shapeItem.borderRadiusTR},${shapeItem.borderRadiusBR},${shapeItem.borderRadiusBL},${shapeItem.borderWidth},${shapeItem.borderColor}`,
      shapeSvgEntry ? (shapeSvgEntry.ready ? 1 : 0) : -1,
      canvas.width, canvas.height,
    ].join('|');
    if (shapePlate.paintSig === shapePaintSig) {
      engine.perfStats.shapePaintSkips += 1;
    } else {
      const shapePaintT0 = performance.now();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(layout.rasterScale, 0, 0, layout.rasterScale, 0, 0);
      drawShapeToCanvas(ctx, shapeItem, layout, shapeTime, shapeFillOverride);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      shapeTexture.needsUpdate = true;
      shapePlate.paintSig = shapePaintSig;
      engine.perfStats.shapePaints += 1;
      engine.perfStats.shapePaintMs += performance.now() - shapePaintT0;
    }
    texture = shapeTexture;
    layerWidth = layout.plateWidth;
    layerHeight = layout.plateHeight;
    textureRasterScale = layout.rasterScale;
  } else if (clip.mediaType === 'motion') {
    // Native animated template drawn per-frame into a transparent canvas texture,
    // then composited on top like a text/shape layer. Deterministic (pure function
    // of local time), so live preview and WebCodecs export produce identical frames.
    const { w: canvasW, h: canvasH } = engine.videoSize;
    // ── Adaptive raster density ──
    // Same measure-pose-project as text and shapes. A motion plate is always the
    // full composition, so the logical size is simply the composition and the mesh
    // needs no plate rescale before probing.
    let motionDensity = 1;
    // undefined = not probed yet -> must draw at 1 this frame; false = seizes the CTM.
    const motionCtmOk = motionCtmSafe.get(item.motionTemplateId);
    if (engine.adaptiveRaster && motionCtmOk === true && !parentXform?.cell) {
      const densityCamera = cs?.rigged ? engine.posedCamera : engine.camera;
      const buffer = engine.renderer?.domElement;
      applyMeshTransform(mesh, item, keyframeProps, W, H, parentXform, clip, itemFollow);
      mesh.updateWorldMatrix(true, false);
      const screenScale = measureScreenScale(
        mesh, densityCamera, W, H, canvasW, canvasH, buffer?.width || 0, buffer?.height || 0
      );
      const interactive = !engine.exporting;
      motionDensity = resolveDensity({
        screenScale,
        logicalW: canvasW,
        logicalH: canvasH,
        caps: env.getRasterCaps(),
        previous: interactive ? engine.rasterDensity.get(item.id) : null,
        interactive,
        maxDensity: env.interactivePreviewEnabled ? 2 : Infinity,
        supersample: engine.rasterSupersample,
      });
      const budget = env.getRasterBudget();
      while (motionDensity > 1) {
        if (budget.wouldFit(item.id, densityBytes(canvasW, canvasH, motionDensity))) break;
        const idx = RASTER_DENSITY_BUCKETS.indexOf(motionDensity);
        motionDensity = idx > 0 ? RASTER_DENSITY_BUCKETS[idx - 1] : 1;
      }
      if (motionDensity > 1) budget.note(item.id, densityBytes(canvasW, canvasH, motionDensity));
      else budget.release(item.id);
      engine.rasterDensity.set(item.id, motionDensity);
    }
    const { canvas, ctx, texture: motionTexture } = ensureTextTexture(
      engine.refObjects.textTextureCache,
      item.id,
      Math.max(1, Math.round(canvasW * motionDensity)),
      Math.max(1, Math.round(canvasH * motionDensity)),
      engine.rasterSupersample && motionDensity > 1
    );
    // Clear the physical backing store, then hand the template a context already in
    // COMPOSITION units — templates lay out against the width/height passed below,
    // so they must never see the denser pixel size or they would draw bigger
    // instead of sharper.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(motionDensity, 0, 0, motionDensity, 0, 0);
    textureRasterScale = motionDensity;
    let cacheEntry = engine.motionCache.get(item.id);
    if (!cacheEntry) { cacheEntry = {}; engine.motionCache.set(item.id, cacheEntry); }
    // The template's clock runs through the Speed Curve exactly like a video clip's:
    // timeline seconds in, source seconds out (calculateVideoTime). A Slow Mo curve
    // holds the middle of the animation, Whip snaps through it, and the clip length
    // on the timeline already follows the curve's area. Layer keyframes and `mp:`
    // option tracks stay in timeline time — only the animation itself is remapped.
    const timelineSec = Math.max(0, progress * durationSec);
    const remapped = calculateVideoTime(item, timelineSec);
    const localTime = Number.isFinite(remapped)
      ? Math.max(0, remapped)
      : Math.max(0, (Number(item.trimStart) || 0) + timelineSec);
    // Keyframed template options (`mp:`/`mpc:` tracks) override the static params for
    // this frame. With no such tracks this hands back the very same object, so the
    // stateful-instance cache in drawMotionFrame keeps its signature.
    const motionKf = itemHasKeyframes(item) ? getItemKeyframeValues(item, progress) : null;
    let seized = false;
    // The probe frame always runs at density 1, so the two wrappers never overlap.
    const drawCtx = motionCtmOk === undefined
      ? probeMotionCtx(ctx, () => { seized = true; })
      : densityMotionCtx(ctx, motionDensity);
    const motionDrew = drawMotionFrame(drawCtx, {
      templateId: item.motionTemplateId,
      params: applyMotionParamKeyframes(item.motionParams, motionKf),
      baseParams: item.motionParams,
      timeSec: localTime,
      // LOGICAL, not canvas.width/height. Templates size their layout from these,
      // so handing them the physical backing-store size would scale the artwork up
      // rather than sharpen it — the same trap as layerWidth on the text path.
      width: canvasW,
      height: canvasH,
      // Templates that route through their own offscreen buffers (createCanvas)
      // should size those by this to gain from the extra resolution; the ones that
      // draw straight to `ctx` need nothing.
      pixelScale: motionDensity,
      cacheEntry,
    });
    // Only a frame the template really drew is evidence (see motionCtmSafe).
    if (motionCtmOk === undefined && motionDrew) motionCtmSafe.set(item.motionTemplateId, !seized);
    motionTexture.needsUpdate = true;
    texture = motionTexture;
  } else if (clip.mediaType === 'image') {
    // ── SVG media is a VECTOR layer (vectorMedia.js) ──
    // Its plate is the artwork's own size rather than the composition frame, and it
    // is re-rasterized at the resolution it occupies on screen. Everything else
    // about the clip stays an image: same panel, filters, transitions and effects.
    const vector = isVectorMediaUrl(clip.url) ? getVectorAsset(clip.url) : null;
    if (vector && vector.status === 'ready') {
      isVectorLayer = true;
      const logicalW = Math.max(1, vector.width);
      const logicalH = Math.max(1, vector.height);
      // ── Adaptive raster density ── same probe as text and shapes: pose the mesh
      // with the transform it will really render with, project its corners through
      // the camera that films this channel, and rasterize at the size it covers.
      // The pose is provisional — it is applied again for real further down.
      let vectorDensity = 1;
      if (engine.adaptiveRaster && !parentXform?.cell) {
        const densityCamera = cs?.rigged ? engine.posedCamera : engine.camera;
        const buffer = engine.renderer?.domElement;
        applyMeshTransform(mesh, item, keyframeProps, W, H, parentXform, clip, itemFollow);
        mesh.scale.x *= logicalW / W;
        mesh.scale.y *= logicalH / H;
        mesh.updateWorldMatrix(true, false);
        const screenScale = measureScreenScale(
          mesh, densityCamera, W, H, logicalW, logicalH, buffer?.width || 0, buffer?.height || 0
        );
        const interactive = !engine.exporting;
        vectorDensity = resolveDensity({
          screenScale,
          logicalW,
          logicalH,
          caps: env.getRasterCaps(),
          previous: interactive ? engine.rasterDensity.get(item.id) : null,
          interactive,
          maxDensity: env.interactivePreviewEnabled ? 2 : Infinity,
          supersample: engine.rasterSupersample,
          buckets: VECTOR_DENSITY_BUCKETS,
        });
        const budget = env.getRasterBudget();
        while (vectorDensity > 1) {
          if (budget.wouldFit(item.id, densityBytes(logicalW, logicalH, vectorDensity))) break;
          const idx = VECTOR_DENSITY_BUCKETS.indexOf(vectorDensity);
          vectorDensity = idx > 0 ? VECTOR_DENSITY_BUCKETS[idx - 1] : 1;
        }
        if (vectorDensity > 1) budget.note(item.id, densityBytes(logicalW, logicalH, vectorDensity));
        else budget.release(item.id);
        engine.rasterDensity.set(item.id, vectorDensity);
      }
      const caps = env.getRasterCaps();
      const maxPlate = Math.max(logicalW, logicalH);
      // Artwork larger than a texture rasterizes BELOW 1x so it still fits, the same
      // legacy guard shapes use; density then rides on top and the hardware cap
      // clamps the product.
      const fitScale = Math.min(1, MAX_SHAPE_TEXTURE_DIM / maxPlate);
      const rasterScale = Math.min(fitScale * vectorDensity, Math.max(1, caps.maxDim) / maxPlate);
      const rasterW = Math.max(1, Math.round(logicalW * rasterScale));
      const rasterH = Math.max(1, Math.round(logicalH * rasterScale));
      const plate = ensureTextTexture(
        engine.refObjects.textTextureCache,
        item.id,
        rasterW,
        rasterH,
        engine.rasterSupersample && vectorDensity > 1
      );
      // Unlike text/shape/motion this plate is STATIC: rasterizing an SVG is
      // expensive and the result only changes when the source or the density
      // bucket does, so redraw is keyed rather than done every frame.
      const plateKey = `${vector.key}|${rasterW}x${rasterH}`;
      if (plate.vectorKey !== plateKey) {
        plate.ctx.setTransform(1, 0, 0, 1, 0, 0);
        plate.ctx.clearRect(0, 0, rasterW, rasterH);
        // Chromium rasterizes an SVG <img> at the DESTINATION rect, so this is a
        // fresh vector render at the new resolution, not an upscale of the last one.
        plate.ctx.drawImage(vector.img, 0, 0, rasterW, rasterH);
        plate.vectorKey = plateKey;
        plate.texture.needsUpdate = true;
      }
      texture = plate.texture;
      layerWidth = logicalW;
      layerHeight = logicalH;
      textureRasterScale = rasterScale;
    } else if (!vector || vector.status === 'failed') {
      // ── Animated raster (GIF / animated WebP / APNG) ──
      // Nothing else about the layer changes: same plate, same fit, same filters,
      // transitions, masks and effects. Only the pixels move, and they move as a
      // pure function of CLIP-LOCAL time — the same expression the motion branch
      // above uses — so a scrub, a preview play and a headless export all resolve
      // the same frame. Trimming the clip's left edge therefore offsets the
      // animation's start, which is what the trim handle means everywhere else.
      //
      // A file that has not decoded yet answers null and falls through to the
      // ordinary still texture, so a GIF never renders as a hole while it loads;
      // the pump below repaints it the moment the frames land.
      const lane = isAnimatedImageCandidate(clip.url)
        ? requestAnimatedImageFrame(
          clip.url,
          Math.max(0, (Number(item.trimStart) || 0) + progress * durationSec),
          item.id,
          { mode: item.gifLoopMode, speed: item.gifSpeed },
        )
        : null;
      texture = lane ? animatedFrameTextureInEngine(engine, lane) : getImageTextureInEngine(engine, clip.url, () => engine.renderFrame());
      // A texture still loading has no picture and no size. Drawn now, the shader
      // would fit an unknown aspect into the plate and paint the spare axis OPAQUE
      // BLACK: two bars and no picture, for every image that first appears
      // mid-timeline. Skip the layer this frame; the load callback repaints it, and
      // an export waits for the load before encoding (renderFrameAtTime).
      if (texture && !texture.image) texture = null;
      // The plate IS the picture, so the shader's fit-contain becomes an identity:
      // it can neither upscale a small photo nor letterbox a wide one into the
      // project's shape. Null (still decoding, or failed) leaves the
      // composition-sized plate and the fit exactly as they were.
      const nativePlate = imagePlateSize(clip, W, H);
      if (nativePlate) {
        layerWidth = nativePlate.width;
        layerHeight = nativePlate.height;
        isNativeImageLayer = true;
      }
    }
  } else if (clip.mediaType === PARTICLE_MEDIA_TYPE) {
    // Particle pixels arrive as `overrideTexture` (already short-circuited above).
    // This branch keeps a solver out of the video branch below, which would try to
    // build an HTMLVideoElement from its empty url — and it is reached often, since
    // a solver legitimately has no live particles at some times.
    texture = null;
  } else if (clip.mediaType === 'model3d' || clip.mediaType === RIG_MEDIA_TYPE) {
    // A model layer's pixels come from its own depth-buffered 3D pass, handed in as
    // `overrideTexture` (already short-circuited above). This branch exists so a model
    // can never reach the video branch below: there is no HTMLVideoElement for a .glb,
    // and falling through would try to build one from the asset url.
    //
    // A Rig clip lands here too, and reaches it far more often: its cyclorama
    // defaults to `shape: 'none'`, so the rig pass legitimately returns no texture
    // and there is no override to short-circuit on. Without this branch a rig added
    // purely for its lights would try to resolve a video from an empty url.
    texture = null;
  } else {
    // An html clip's page draws on a plate of the PAGE's shape (htmlClipPlateSize), not
    // letterboxed into a frame-shaped one whose bars the shader paints opaque black.
    const htmlPlate = clip.htmlSource ? htmlClipPlateSize(clip, W, H) : null;
    if (htmlPlate) {
      layerWidth = htmlPlate.width;
      layerHeight = htmlPlate.height;
      isHtmlPagePlate = true;
    }
    // Posterize Time while playing: the <video> runs on the real clock and the
    // texture holds its frame for the whole step (the held progress is the key).
    texture = getVideoTextureInEngine(engine, video,
      engine.isPlaying && !engine.exportActive && isPosterizeTimeEnabled(item) ? progress : null);
    // A screen recording with no cursor in its picture gets the drawn one stamped in. While playing, at the time of
    // the frame the texture really holds (the <video> free-runs ahead of the playhead); paused and in an export, at the
    // playhead (exact: a paused seek's stale frame is replaced moments later, and an export decodes exact frames).
    if (texture && clip.mediaType === 'video' && clip.recordingMeta?.cursorInVideo === false) {
      const clockTime = calculateVideoTime(item, Math.max(0, progress * durationSec));
      const presented = engine.isPlaying && video && !video.__decodeCanvas && !engine.exportActive ? engine.uploadedMediaTime.get(video) : null;
      const shownSrc = video ? (video.currentSrc || video.src || '') : '';
      const baked = bakeRecordingCursor(engine, item, clip, texture, presented && presented.src === shownSrc ? presented.time : clockTime);
      if (baked) {
        texture = baked;
        cursorBaked = true;
      }
    }
    if (!texture) {
      const fallbackTexture = material.uniforms.uTexture.value;
      const canReuseTexture =
        fallbackTexture &&
        material.userData.textureSource === clipSource &&
        video &&
        !env.isPlaying &&
        !video.seeking &&
        !engine.pendingSeek.has(video);
      if (canReuseTexture) {
        texture = fallbackTexture;
      }
    }
  }

  if (!texture) {
    if (clip.mediaType === 'model3d' || clip.mediaType === RIG_MEDIA_TYPE || clip.mediaType === PARTICLE_MEDIA_TYPE) {
      // A 3D asset can legitimately have no plate for a frame: it is still loading,
      // the model source changed, or the rig shape is None. Never bridge that gap
      // with the previous model/cyclorama texture — it makes switching look broken
      // and makes a removed screen/set appear to be a baked-in texture.
      material.uniforms.uTexture.value = null;
      material.userData.textureSource = '';
      if (cs) cs.lastGoodTexture = null;
      mesh.visible = false;
      resetMaterialUniforms(material);
      material.uniforms.uCanvasSize.value.set(layerWidth, layerHeight);
      return false;
    } else if (material.uniforms.uTexture.value) {
      // Keep showing whatever frame is currently on the material (prevents flash)
      mesh.visible = true;
    } else if (clip.mediaType === 'video') {
      // No video texture yet — prefer the clip thumbnail if present,
      // and only fall back to the "Processing video…" placeholder on hard error.
      const hasError = video && video.error;
      if (!hasError && clip.thumbnailUrl) {
        const thumb = getImageTextureInEngine(engine, clip.thumbnailUrl, () => engine.renderFrame());
        if (thumb) {
          material.uniforms.uTexture.value = thumb;
          material.userData.textureSource = normalizeUrl(clip.thumbnailUrl);
          if (thumb.image) {
            const tw = thumb.image.width || W;
            const th = thumb.image.height || H;
            material.uniforms.uResolution.value.set(tw, th);
          } else {
            material.uniforms.uResolution.value.set(W, H);
          }
          mesh.visible = true;
          resetMaterialUniforms(material);
          material.uniforms.uCanvasSize.value.set(W, H);
          return false;
        }
      }
      if (hasError) {
        const ph = getPlaceholderTexture('error');
        material.uniforms.uTexture.value = ph;
        material.userData.textureSource = '__placeholder__';
        material.uniforms.uResolution.value.set(ph.image.width, ph.image.height);
        mesh.visible = true;
        resetMaterialUniforms(material);
        material.uniforms.uCanvasSize.value.set(W, H);
        return false;
      }
      // No thumbnail and no error — bridge the gap with the channel's last good
      // frame so a shot boundary can never expose the black clear color. Only fall
      // through to black when this channel has genuinely never shown anything.
      if (cs?.lastGoodTexture) {
        material.uniforms.uTexture.value = cs.lastGoodTexture;
        if (cs.lastGoodTexture.image) {
          const tw = cs.lastGoodTexture.image.videoWidth || cs.lastGoodTexture.image.width || W;
          const th = cs.lastGoodTexture.image.videoHeight || cs.lastGoodTexture.image.height || H;
          material.uniforms.uResolution.value.set(tw, th);
        }
        mesh.visible = true;
        resetMaterialUniforms(material);
        material.uniforms.uCanvasSize.value.set(W, H);
        return false;
      }
      mesh.visible = false;
      return false;
    } else {
      mesh.visible = false;
      return false;
    }
  } else {
    mesh.visible = true;
    material.uniforms.uTexture.value = texture;
    material.userData.textureSource = clipSource;
    if (cs) cs.lastGoodTexture = texture; // remember the most recent on-screen frame

    if (texture.image) {
      let tw = texture.image.videoWidth || texture.image.width || W;
      let th = texture.image.videoHeight || texture.image.height || H;
      // Shape and SVG-vector plates are rasterized at round(plate × rasterScale). The
      // clip shader's fit-contain compares aspect ratios with an ABSOLUTE 0.01
      // tolerance, so on a thin plate that half-pixel rounding reads as a mismatch
      // and the plate gets letterboxed with ≤1px OPAQUE BLACK bars (shape framing is
      // off, so the bars are painted) — stray lines along the box edges whenever the
      // box size, stroke width or density changes. Report the unrounded raster size
      // so the aspect is exact; the ≤0.5px stretch this implies is invisible.
      if ((clip.mediaType === 'shape' || isVectorLayer) && textureRasterScale > 0) {
        const exactW = layerWidth * textureRasterScale;
        const exactH = layerHeight * textureRasterScale;
        if (Math.abs(exactW - tw) <= 1 && Math.abs(exactH - th) <= 1) {
          tw = exactW;
          th = exactH;
        }
      }
      material.uniforms.uResolution.value.set(tw, th);
    }
  }

  // A video draws on its own picture (videoPlate.js): the contain-fit rect the
  // shader used to letterbox into, at the clip's REAL size when that is smaller —
  // so no spare axis is left to paint opaque black. The aspect comes from the
  // texture (uResolution: this frame, or the last one while a seek is pending) so
  // the shader's fit is an exact identity; the size comes from the original file,
  // so a proxy in the preview draws exactly what the export draws.
  if (!overrideTexture && clip.mediaType === 'video' && !clip.htmlSource && !isHtmlPagePlate) {
    const res = material.uniforms.uResolution.value;
    if (res.x > 0 && res.y > 0) {
      const realSize = videoPlateScale(clip, W, H);
      const fitted = contentRectInQuad(W, H, res.x, res.y);
      layerWidth = fitted.w * realSize;
      layerHeight = fitted.h * realSize;
      videoFrameW = W * realSize;
      videoFrameH = H * realSize;
      isVideoPlate = true;
      setVideoPlate(item.id, { width: layerWidth, height: layerHeight, frameWidth: videoFrameW, frameHeight: videoFrameH });
    }
  }

  resetMaterialUniforms(material);
  material.uniforms.uCanvasSize.value.set(layerWidth, layerHeight);
  // EVERY override texture is one of this compositor's own render targets, so its
  // RGB is already multiplied by its coverage — a 3D pass writes `mapped * a`, a
  // sequence/grid accumulates premultiplied `over`, and the particle pass emits
  // `vec4(rgb * a, a)`. This material otherwise assumes straight-alpha media and
  // multiplies by alpha again on the way out, which darkens every antialiased edge
  // into a dirty outline and halves a translucent particle.
  //
  // Listing media types here instead missed both of the newer sources: a solver
  // exported to a transparent WebM came out at `colour x coverage` (a soft particle
  // at 50% alpha delivered half as bright as authored), and anything inside a
  // sequence picked up a fringe on every soft edge. Both are invisible in an opaque
  // MP4 — the second multiply lands on a background that is already black — which
  // is exactly why the alpha render is where it showed up.
  if (overrideTexture) {
    material.uniforms.uInputPremultiplied.value = 1;
    // This frame's picture IS a model / Rig 3D pass (a re-lit plate marks itself
    // in promotePlateMesh). Read by the composite's isBakedPass.
    if (clip?.mediaType === 'model3d' || clip?.mediaType === RIG_MEDIA_TYPE) mesh.userData.cameraBaked3d = true;
    // A particle plate is filmed through the project camera as well, but it is a
    // single-hop RT (below), so it carries its own flag: its identity quad must not
    // depth-test or write depth at the composition plane, and nothing else changes.
    mesh.userData.particlePlate = clip?.mediaType === PARTICLE_MEDIA_TYPE;
    // Particles and ordinary sequence plates are single-hop compositor RTs. On
    // WebGPU their V axis is opposite WebGL when sampled on this perspective
    // plane (lab pair 15; same defect as flipAdjustmentGeoV).
    //
    // model3d / Rig plates are exempt again, and this time for a REASON that was
    // measured rather than argued. The model pass's tone step now samples its
    // HDR source at `screenUV` (model3dNodes.js) — the GLSL's own
    // gl_FragCoord-derived read — which lands the plate upright in the LDR. A
    // flip here would be a second one. A grid is also exempt: its private camera
    // target is screen-aligned already, while each member is normalized at the
    // cell hop below. Flipping the completed grid target reverses the entire
    // arrangement, which is the upside-down Grid Builder failure.
    //
    // And a plate can say so for itself. A Tier 2 particle layer hands over a
    // CANVAS from the GPU engine's own device rather than one of this
    // compositor's render targets, so it is already screen-oriented — while
    // the SAME media type on the baked engine is a real RT that wants the
    // flip. Media type cannot distinguish them; the texture can.
    const plateAlreadyNormalized = clip?.mediaType === 'model3d'
      || clip?.mediaType === RIG_MEDIA_TYPE
      || clip?.mediaType === 'grid'
      || overrideTexture?.userData?.plateNormalized === true;
    if (selectedBackend() === 'webgpu' && material.uniforms.uInputFlipV && !plateAlreadyNormalized) {
      material.uniforms.uInputFlipV.value = 1;
    }
  }
  // The recording with its drawn cursor samples a pooled target, which on WebGPU runs opposite to an uploaded picture.
  if (cursorBaked && RECORDING_CURSOR_FLIP_ON_WEBGPU && selectedBackend() === 'webgpu' && material.uniforms.uInputFlipV) {
    material.uniforms.uInputFlipV.value = 1;
  }

  // A Grid Builder member is drawn into the grid's private camera target before
  // the finished grid is sampled as a plate. WebGPU uploaded media needs its V
  // correction at this INNER hop; applying it to the finished plate instead also
  // reverses cell positions and multi-line content. Direct layers and ordinary
  // sequences intentionally keep their existing upload/plate paths.
  if (selectedBackend() === 'webgpu' && parentXform?.cell && material.uniforms.uInputFlipV) {
    material.uniforms.uInputFlipV.value = 1;
  }

  // ── Grid cell: fit the DRAWN content into the cell box ──
  // `parentXform.cell` is only present for a member of a Grid layer. The cell
  // box arrives in composition pixels; what has to be fitted into it is the
  // media's content rect, which is only knowable here — the clip shader
  // letterboxes the media inside the quad (uCanvasSize = the quad in px,
  // uResolution = the media in px), and those uniforms were just bound.
  //
  // Note the quad and uCanvasSize agree in BOTH branches below: shape and text
  // layers draw on a plate of their own size and the mesh is rescaled by
  // layerWidth/W right after, so `content * scale` is the drawn size either way.
  let cellXform = parentXform;
  let cellCrop = null;
  if (parentXform?.cell) {
    const cell = parentXform.cell;
    const local = localPrs(item, keyframeProps, W, H);
    const content = contentRectInQuad(
      layerWidth, layerHeight,
      material.uniforms.uResolution.value.x, material.uniforms.uResolution.value.y,
    );
    const fitted = fitScaleForCell(cell.fit, {
      contentW: content.w,
      contentH: content.h,
      cellW: cell.w,
      cellH: cell.h,
      // "Keep original size" hands scale back to the layer, which turns the
      // grid into pure positioning.
      localScale: local.sx,
    });
    const prs = { ...parentXform.prs };
    prs.sx *= fitted.sx;
    prs.sy *= fitted.sy;
    prs.sz *= fitted.sx;
    // Orientation "Forward" means the layout itself does not aim the card, so
    // the member's own rotation is restored ON TOP of the pose — additive,
    // because the pose may still carry the grid's uniform Rotate X/Y/Z (and
    // jitter/reveal spin), which every card keeps under Forward too.
    if (cell.keepRotation) {
      prs.rx += local.rx;
      prs.ry += local.ry;
      prs.rz += local.rz;
    }
    cellXform = { prs, type: parentXform.type };
    if (fitted.cropX < 0.999 || fitted.cropY < 0.999) cellCrop = fitted;
  }
  // The box a Transform origin pivots on (keyframeParenting.js applyPivot): the plate this layer draws on, or for
  // text the laid-out block on its frame-wide plate. Published before the pose, which reads it.
  if (item?.keyframeTransformOrigin && item.keyframeTransformOrigin !== 'center') {
    const plated = clip.mediaType === 'shape' || clip.mediaType === 'text' || isVectorLayer || isNativeImageLayer || isHtmlPagePlate;
    const fp = clip.mediaType === 'text' ? getTextFootprint(item.id) : null;
    setLayerPivotBox(item.id, fp
      ? { w: fp.width, h: fp.height, cx: fp.offsetX, cy: -fp.offsetY }
      : { w: plated ? layerWidth : videoFrameW, h: plated ? layerHeight : videoFrameH, cx: 0, cy: 0 });
  }
  applyMeshTransform(mesh, item, keyframeProps, W, H, cellXform, clip, itemFollow);
  // The layer's own scale (item × parenting × cell), before the plate-size and
  // shadow-expand multipliers below. The silhouette framing pass converts its
  // authored px through this so a keyed clip keeps its shadow size at any scale.
  mesh.userData.layerScale = (Math.abs(mesh.scale.x) + Math.abs(mesh.scale.y)) * 0.5;
  // Shape textures use a local plate sized to the complete geometry instead
  // of the composition frame. Scale the shared W×H mesh to that logical plate
  // so oversized geometry survives pan/rotation and is cropped only by the
  // final composition camera. Text does the same when its overflow texture
  // grew wider than the composition (nowrap / randomized sizes) — normally
  // layerWidth === W and this is a no-op. An SVG media layer is the third case: its
  // plate is the artwork's own size, which is what makes it import at 1:1 instead
  // of being letterbox-fitted up to the frame — and a raster photo is the fourth,
  // for exactly the same reason: its plate is the picture, at the picture's ratio.
  // A video's fitted picture is the fifth (videoPlate.js).
  if (clip.mediaType === 'shape' || clip.mediaType === 'text' || isVectorLayer || isNativeImageLayer || isHtmlPagePlate || isVideoPlate) {
    mesh.scale.x *= layerWidth / W;
    mesh.scale.y *= layerHeight / H;
  }
  // Shape layers draw border/radius/shadows on their canvas texture along the
  // actual outline (drawShapeToCanvas) — the shader's box framing must not
  // double-apply around their bounding box. Text clip masks opt out too: their
  // plane is the full composition, so a border/shadow would rim the entire frame
  // and that alpha would land in the matte.
  // A keyed layer's border and shadows follow the keyed silhouette instead —
  // applySilhouetteFraming draws them on the isolate after the key, so the box
  // framing here is switched off (the corner radius stays: it clips the plate).
  // A masked media layer's follow the masked silhouette the same way.
  // A 3D model has no framing at all (the panel hides Border and Shadows): its
  // plate is the full frame and its depth composite cuts everything past the
  // silhouette, so a value saved before that would only leave a stray rim.
  const ccCompare = engine.ccCompare;
  const ccProbe = engine.ccProbe;
  applyFilterUniforms(material, item, keyframeProps, {
    reducedMotionPreview: env.interactivePreviewEnabled,
    disableFraming: clip.mediaType === 'shape' || clip.mediaType === 'model3d' || (clip.mediaType === 'text' && !!item?.textClipMask),
    silhouetteFraming: isChromaKeyEnabled(item) || maskSilhouetteFraming(item, clip),
    disableLetterSpacing: clip.mediaType === 'text',
    // Color Correction: preview-only Before/After split, and the pickers' probe.
    ccSplit: ccCompare.itemId && item?.id === ccCompare.itemId && !engine.exporting && !engine.exportActive
      ? ccCompare.split : -1,
    ccStage: ccProbe && item?.id === ccProbe.itemId ? ccProbe.stage : null,
  });
  // The panel's Auto / Levels histogram asked for this layer's source picture:
  // read the texture this material is about to sample.
  const ccReq = engine.ccSourceReq;
  if (ccReq && item?.id === ccReq.itemId) {
    ccReq.resolve(readTextureImagePixels(material.uniforms.uTexture?.value, ccReq.width));
  }
  // Stabilization is a source-image warp. It deliberately touches only clip
  // shader uniforms: the mesh's authored PRS, project camera and Motion
  // Tracking resolver above stay byte-for-byte unchanged. Because setupMesh is
  // shared, paused preview, playback, transitions and WebCodecs export sample
  // the identical frame-indexed correction.
  //
  // Which frame that is has to come from the PICTURE, not the playhead. Export
  // positions the decoder from the composition clock, so there the two agree by
  // construction. The preview does not: the element free-runs during playback
  // (0.5 s of allowed drift) and, while paused, only re-seeks once the playhead
  // has moved past 40 ms — so a frame step smaller than that advances the warp
  // index while the canvas still shows the previous picture. Warping frame f's
  // picture by frame f+k's correction ADDS the camera motion between them, which
  // is why a mis-sampled preview shakes harder than the untouched footage. Use
  // the mediaTime the element last confirmed it presented whenever there is one.
  if (clip.mediaType === 'video' && item?.videoStabilization?.enabled !== false) {
    const clockTime = calculateVideoTime(item, Math.max(0, progress * durationSec));
    const presented = video && !video.__decodeCanvas && !engine.exportActive
      ? engine.uploadedMediaTime.get(video)
      : null;
    const shownSrc = video ? (video.currentSrc || video.src || '') : '';
    const sourceTime = presented && presented.src === shownSrc ? presented.time : clockTime;
    const stable = inverseVideoStabilizationSample(sampleVideoStabilization(item.videoStabilization, sourceTime));
    const u = material.uniforms;
    if (stable && u.uStabilizeOn) {
      u.uStabilizeOn.value = 1.0;
      u.uStabilizeLinear.value.set(stable.a, stable.b, stable.c, stable.d);
      u.uStabilizeOffset.value.set(stable.tx, stable.ty);
      u.uStabilizeSize.value.set(stable.width, stable.height);
    }
  }
  // uBlur is a distance in LOGICAL pixels, but the shader spends it in texels
  // (`texelSize = uBlur / uResolution`, and uResolution is the physical texture).
  // So it has to be rescaled whenever the plate is not rasterized 1:1 — downscaled
  // (an oversized plate, the original case) OR upscaled by adaptive density, which
  // would otherwise make the blur progressively weaker as the camera pushes in.
  if ((clip.mediaType === 'shape' || clip.mediaType === 'text' || isVectorLayer) && textureRasterScale !== 1) {
    material.uniforms.uBlur.value *= textureRasterScale;
  }
  // Grid cell, part two — after applyFilterUniforms so neither is overwritten:
  // "Cover" crops the overflow to the cell (otherwise a covering cell paints
  // over its neighbours), and the per-cell reveal scales this layer's opacity.
  if (parentXform?.cell) {
    // Keep the letterbox bars of a mismatched member transparent — see
    // uGridCell in clipShader: a cell is not the frame, so the opaque
    // "video player bars" treatment would plate the backdrop.
    material.uniforms.uGridCell.value = 1.0;
    if (cellCrop) material.uniforms.uCellCrop.value.set(cellCrop.cropX, cellCrop.cropY);
    const revealOpacity = parentXform.cell.opacity;
    if (Number.isFinite(revealOpacity) && revealOpacity < 1) {
      material.uniforms.uOpacity.value *= Math.max(0, revealOpacity);
    }
    // Effector-driven filters. Deltas, not absolutes, so a cell keeps whatever
    // its own FILTERS section set and the effector adds on top of it.
    const cellFx = parentXform.cell.fx;
    if (cellFx) {
      const u = material.uniforms;
      if (Number.isFinite(cellFx.blur)) u.uBlur.value = Math.max(0, u.uBlur.value + cellFx.blur);
      if (Number.isFinite(cellFx.brightness)) u.uBrightness.value = Math.max(0, u.uBrightness.value + cellFx.brightness / 100);
      if (Number.isFinite(cellFx.contrast)) u.uContrast.value = Math.max(0, u.uContrast.value + cellFx.contrast / 100);
      if (Number.isFinite(cellFx.saturate)) u.uSaturation.value = Math.max(0, u.uSaturation.value + cellFx.saturate / 100);
      if (Number.isFinite(cellFx.hue)) u.uHueRotate.value += cellFx.hue;
      if (Number.isFinite(cellFx.grayscale)) u.uGrayscale.value = clamp(u.uGrayscale.value + cellFx.grayscale / 100, 0, 1);
      if (Number.isFinite(cellFx.sepia)) u.uSepia.value = clamp(u.uSepia.value + cellFx.sepia / 100, 0, 1);
    }
  }
  // Grow the quad by the shadow reach so drop shadows aren't clipped at the
  // layer boundary (applyFilterUniforms set uPlaneExpand; the shader remaps
  // UVs so the content itself keeps its exact size and position).
  const planeExpand = material.uniforms.uPlaneExpand.value;
  if (planeExpand > 0) {
    // Against the LAYER's box, not the composition: the shader remaps UVs against
    // uCanvasSize, so a plate that isn't frame-sized (an SVG layer, overflowing
    // text) needs the mesh grown by the same ratio or the two disagree.
    mesh.scale.x *= (layerWidth + 2 * planeExpand) / layerWidth;
    mesh.scale.y *= (layerHeight + 2 * planeExpand) / layerHeight;
  }
  // A video's masks, roto, effects, pins and AutoFill were all authored against the
  // frame-shaped box it used to draw on. computeLayerBox grows the drawn quad back to
  // that box, scaled with the picture (fxFrame), and mediaContentFrac reports where
  // the picture sits inside it (mediaFrac), so none of them moves off the footage.
  if (isVideoPlate) {
    const pad = Math.max(0, planeExpand);
    mesh.userData.fxFrame = [(videoFrameW + 2 * pad) / (layerWidth + 2 * pad), (videoFrameH + 2 * pad) / (layerHeight + 2 * pad)];
    mesh.userData.mediaFrac = { cw: layerWidth / videoFrameW, ch: layerHeight / videoFrameH };
  }
  // What the layer really draws, in the quad's own units, for the painter's plane test (compositeSortDepth.js
  // layerQuad): the plate without that shadow pad, and for text only the laid-out block — its plate is the whole
  // frame, so text standing on a page would otherwise reach through the page and never be sorted in front of it.
  {
    const pad = Math.max(0, planeExpand);
    const kx = W / (layerWidth + 2 * pad);
    const ky = H / (layerHeight + 2 * pad);
    const fp = clip.mediaType === 'text' ? getTextFootprint(item.id) : null;
    mesh.userData.quadRect = fp
      ? [(fp.offsetX - fp.width / 2) * kx, -(fp.offsetY + fp.height / 2) * ky, (fp.offsetX + fp.width / 2) * kx, -(fp.offsetY - fp.height / 2) * ky]
      : pad > 0 ? [-layerWidth / 2 * kx, -layerHeight / 2 * ky, layerWidth / 2 * kx, layerHeight / 2 * ky] : null;
  }
  // Per-layer blend mode: composites this clip against the layers below it
  // (framebuffer in the base pass, accumulated render-target in the adjustment
  // composite). Text layers keep normal compositing.
  applyBlendMode(material, clip.mediaType === 'text' ? 'normal' : item?.blendMode);

  // 3D Depth (still images): the depth-dependent residual of this frame's
  // camera move. cs.depthShiftBase is the pose contribution at strength 100 %,
  // resolved once per channel in renderChannel; scaling it here keeps the
  // keyframable strength/focus per item.
  if (isDepthParallaxEnabled(item) && canUseDepthParallax(clip) && !isCameraBaked3dPlate(clip, item)) {
    const dp = resolveDepthParams(item, keyframeProps);
    const base = cs?.depthShiftBase || null;
    /*
     * Active Range, the Overlay Effects window on the entry (`start`/`end` in
     * clip-local seconds), read through the same helper so the two features
     * cannot drift apart. Outside the window the strength is simply 0, which
     * for a UV displacement is an exact bypass — the plate reads unshifted.
     *
     * That is a HARD edge, exactly like the overlay chain's: parallax pops in
     * at the boundary rather than easing. Keyframe depthStrength if you want
     * it to arrive gently; the window is for "on here, off there".
     */
    const dWin = effectWindowAt(getDepthParallaxEffect(item), progress * durationSec, durationSec);
    const s = (dWin ? dWin.amount : 1) * dp.depthStrength / 100;
    applyDepthUniforms(material, {
      texture: getDepthTexture(getItemDepthMap(item)),
      shift: base ? { shiftX: base.shiftX * s, shiftY: base.shiftY * s, dolly: base.dolly * s } : null,
      focusPct: dp.depthFocus,
    });
  }


  return true;
}

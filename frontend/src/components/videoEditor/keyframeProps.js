import { STROKE_COLOR_KF_LABELS } from './pathStroke.js';
// Registry of animatable keyframe properties shared by the Keyframe Builder
// panel (EditorPanel), the timeline keyframe overlay, the interpolators in
// gsapTransitions.js, and the project sanitizer in VideoEditor.jsx.

export const KF_PROPS = [
  { label: 'opacity', group: 'Transform', placeholder: '1', unit: '', type: 'number', min: 0, max: 2, step: 0.01 },
  // Ceiling is 20, not 3: a punch-in from a full-frame logo to a single letter, or
  // a scale-through transition, both need well past 3x. The old 3 was clamping
  // legitimate animation, and clampKeyValue in the sanitizer enforces it on load.
  { label: 'scale', group: 'Transform', placeholder: '1', unit: '', type: 'number', min: 0.1, max: 20, step: 0.01 },
  // Per-axis stretch, multiplied ON TOP of `scale` (Transform's Scale X / Scale Y).
  // Same range as the uniform one: they are the same kind of number, and a squash
  // that a keyed uniform scale could reach must be reachable on one axis too.
  { label: 'scaleX', group: 'Transform', placeholder: '1', unit: '', type: 'number', min: 0.1, max: 20, step: 0.01 },
  { label: 'scaleY', group: 'Transform', placeholder: '1', unit: '', type: 'number', min: 0.1, max: 20, step: 0.01 },
  // `step` is the drag/arrow grain, `precision` how fine the stored value may be.
  // Position and rotation scrub in whole units (a keyed move is authored by
  // dragging, and 0.01 per pixel would never cross the range) but hold hundredths,
  // so a keyed transform can be as exact as the static one in the Transform panel
  // — and a key seeded from a preview-stage drag keeps the number it was given.
  { label: 'rotate', group: 'Transform', placeholder: '0', unit: 'deg', type: 'number', min: -1000, max: 1000, step: 1, precision: 2 },
  { label: 'rotateX', group: 'Transform', placeholder: '0', unit: 'deg', type: 'number', min: -180, max: 180, step: 1, precision: 2 },
  { label: 'rotateY', group: 'Transform', placeholder: '0', unit: 'deg', type: 'number', min: -180, max: 180, step: 1, precision: 2 },
  { label: 'translateX', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -1200, max: 1200, step: 1, precision: 2 },
  { label: 'translateY', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -1200, max: 1200, step: 1, precision: 2 },
  { label: 'xPercent', group: 'Transform', placeholder: '0', unit: '%', type: 'number', min: -200, max: 200, step: 1, precision: 2 },
  { label: 'yPercent', group: 'Transform', placeholder: '0', unit: '%', type: 'number', min: -200, max: 200, step: 1, precision: 2 },
  { label: 'translateZ', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -3000, max: 3000, step: 1, precision: 2 },
  { label: 'motionPathT', displayLabel: 'Path Progress', group: 'Transform', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 0.5 },
  // Distance from the motion path, in world axes (+X right, +Y down, +Z toward the
  // viewer). Only does anything while the layer is following a path — the layer
  // rides the curve offset by this much, so a copied path can carry a formation.
  { label: 'motionPathOffsetX', displayLabel: 'Path Offset X', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -10000, max: 10000, step: 5 },
  { label: 'motionPathOffsetY', displayLabel: 'Path Offset Y', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -10000, max: 10000, step: 5 },
  { label: 'motionPathOffsetZ', displayLabel: 'Path Offset Z', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -10000, max: 10000, step: 5 },
  { label: 'letterSpacing', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -80, max: 200, step: 1 },
  // Text on Path (text layers with textPathEnabled). Progress reuses motionPathT
  // above; these animate the glyph distribution itself — keyed trims move the
  // window the run is laid out in (letters are not hidden past it). No-ops elsewhere, like letterSpacing.
  { label: 'textPathSpread', displayLabel: 'Text Path Spread', group: 'Transform', placeholder: '100', unit: '%', type: 'number', min: 10, max: 400, step: 1 },
  { label: 'textPathSpacing', displayLabel: 'Text Path Spacing', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -200, max: 500, step: 1 },
  { label: 'textPathTrimStart', displayLabel: 'Text Path Trim Start', group: 'Transform', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 0.5 },
  { label: 'textPathTrimEnd', displayLabel: 'Text Path Trim End', group: 'Transform', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 0.5 },
  { label: 'textPathOffsetY', displayLabel: 'Text Path Offset', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: -500, max: 500, step: 1 },
  // Inline counters ({{{COUNTER:a-b}}} in a text layer, textCounter.js): 0 = the
  // start value, 100 = the end value. Keyed, it replaces the COUNTER section's
  // Start/Duration/Easing. No-op on text without a counter.
  { label: 'textCounterProgress', displayLabel: 'Counter Progress', group: 'Transform', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 0.5 },
  // Card framing border (every visual layer; the outline stroke on shapes) —
  // borderKeyframes.js applies both to the frame being drawn.
  { label: 'borderWidth', displayLabel: 'Border Width', group: 'Transform', placeholder: '0', unit: 'px', type: 'number', min: 0, max: 200, step: 0.5 },
  { label: 'clipPath', group: 'Transform', placeholder: '0', unit: '%', type: 'number', min: 0, max: 45, step: 1 },
  { label: 'color', group: 'Color', placeholder: '#ffffff', unit: '', inputType: 'color', hasAlpha: true },
  { label: 'backgroundColor', group: 'Color', placeholder: '#00000080', unit: '', inputType: 'color', hasAlpha: true },
  // Layer paints, promoted from the properties panel via the color-row stopwatch.
  // `gradient: true` means a key's value may be a full CSS gradient string, not
  // just a colour — lerpValue blends those stop-by-stop (see lerpGradientValue).
  // No-ops on layer kinds that don't draw them, mirroring letterSpacing/clipPath.
  { label: 'textColor', displayLabel: 'Text Color', group: 'Color', placeholder: '#ffffff', unit: '', inputType: 'color', hasAlpha: true, gradient: true },
  { label: 'textBgColor', displayLabel: 'Text Background', group: 'Color', placeholder: 'rgba(0,0,0,0.6)', unit: '', inputType: 'color', hasAlpha: true },
  { label: 'shapeFill', displayLabel: 'Shape Fill', group: 'Color', placeholder: '#8b5cf6', unit: '', inputType: 'color', hasAlpha: true, gradient: true },
  { label: 'textOutlineColor', displayLabel: 'Outline Color', group: 'Color', placeholder: '#ffffff', unit: '', inputType: 'color', hasAlpha: true },
  { label: 'borderColor', displayLabel: 'Border Color', group: 'Color', placeholder: '#ffffff', unit: '', inputType: 'color', hasAlpha: true },
  { label: 'blur', group: 'Filters', placeholder: '0', unit: 'px', type: 'number', min: 0, max: 40, step: 0.1 },
  { label: 'brightness', group: 'Filters', placeholder: '100', unit: '%', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'contrast', group: 'Filters', placeholder: '100', unit: '%', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'hue-rotate', group: 'Filters', placeholder: '0', unit: 'deg', type: 'number', min: 0, max: 360, step: 1 },
  { label: 'saturate', group: 'Filters', placeholder: '100', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'grayscale', group: 'Filters', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'sepia', group: 'Filters', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'invert', group: 'Filters', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Master intensity for the adjustment-layer GPU effect chain (each effect's Mix
  // is multiplied by this). No-op on layers without an effect chain, mirroring the
  // text-only letterSpacing/clipPath precedent above.
  { label: 'effectAmount', group: 'Filters', placeholder: '1', unit: '', type: 'number', min: 0, max: 1, step: 0.01 },
  // Intensity of the adjustment layer's LUT section (item.lut). Percent, matching
  // the panel slider; no-op on layers without a loaded LUT.
  { label: 'lutAmount', group: 'Filters', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Backdrop Blur (Design ▸ BACKDROP BLUR on shape layers): the stack behind the
  // shape, blurred inside its outline. No-op on every other layer kind.
  { label: 'backdropBlur', displayLabel: 'Backdrop Blur', group: 'Filters', placeholder: '0', unit: 'px', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'backdropSaturation', displayLabel: 'Backdrop Saturation', group: 'Filters', placeholder: '100', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  // Glass (the `glass` Layer Effect on shape layers, glassEffect.js): the
  // animation-worthy subset of its material — the rest are static look controls.
  // Ranges mirror GLASS_PARAMS (written out here so this leaf module stays
  // three-free). No-op on layers without glass; unkeyed, the entry's param rules.
  { label: 'glassIor', displayLabel: 'Glass IOR', group: 'Effects', placeholder: '', unit: '', type: 'number', min: 1, max: 2.4, step: 0.01 },
  { label: 'glassDispersion', displayLabel: 'Glass Dispersion', group: 'Effects', placeholder: '', unit: '', type: 'number', min: 0, max: 1, step: 0.01 },
  { label: 'glassMagnify', displayLabel: 'Glass Magnify', group: 'Effects', placeholder: '', unit: '', type: 'number', min: 0.5, max: 2.5, step: 0.01 },
  { label: 'glassFrost', displayLabel: 'Glass Frost', group: 'Effects', placeholder: '', unit: 'px', type: 'number', min: 0, max: 60, step: 0.5 },
  { label: 'glassTintAmount', displayLabel: 'Glass Tint amount', group: 'Effects', placeholder: '', unit: '', type: 'number', min: 0, max: 1, step: 0.01 },
  { label: 'glassMilk', displayLabel: 'Glass Milk', group: 'Effects', placeholder: '', unit: '', type: 'number', min: 0, max: 1, step: 0.01 },
  { label: 'glassLightAngle', displayLabel: 'Glass Light angle', group: 'Effects', placeholder: '', unit: '°', type: 'number', min: 0, max: 360, step: 1 },
  { label: 'glassShadow', displayLabel: 'Glass Shadow', group: 'Effects', placeholder: '', unit: '', type: 'number', min: 0, max: 0.8, step: 0.01 },
  // ── Layer Effects panel (EFFECTS section) ──
  // The animation-worthy subset of the per-layer effects; the rest are static
  // look controls. No-ops on layers where the effect is off, mirroring the
  // effectAmount/lutAmount precedent above.
  //
  // Running Glow. `glowSpeed` is deliberately NOT here: the runner's phase is
  // uTime * speed, so keying speed would jump the phase rather than accelerate
  // the light (a proper ramp needs the integral, which would break the
  // pure-function-of-time property preview and export rely on). To change pace
  // over a shot, cut to a second clip or key glowAmount instead.
  { label: 'glowAmount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'glowEdgeLevel', group: 'Effects', placeholder: '1.6', unit: '', type: 'number', min: 0, max: 3, step: 0.05 },
  { label: 'glowLevel', group: 'Effects', placeholder: '1.3', unit: '', type: 'number', min: 0, max: 3, step: 0.05 },
  { label: 'glowRadius', group: 'Effects', placeholder: '34', unit: 'px', type: 'number', min: 0, max: 160, step: 1 },
  { label: 'glowAngle', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: 0, max: 360, step: 1 },
  // The rest of the glow look — each is a straight per-frame uniform
  // (applyRunningGlowUniforms), so a keyed value just re-poses the light.
  // `glowCount` stays static alongside glowSpeed: an animated integer runner
  // count pops a whole light into existence on each step.
  { label: 'glowEdgeWidth', displayLabel: 'Glow Edge Width', group: 'Effects', placeholder: '4', unit: 'px', type: 'number', min: 0.5, max: 40, step: 0.5 },
  { label: 'glowOffset', displayLabel: 'Glow Edge Offset', group: 'Effects', placeholder: '0', unit: 'px', type: 'number', min: -40, max: 40, step: 1 },
  { label: 'glowStaticRim', displayLabel: 'Glow Static Rim', group: 'Effects', placeholder: '14', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'glowSoftness', displayLabel: 'Glow Softness', group: 'Effects', placeholder: '50', unit: '%', type: 'number', min: 0, max: 100, step: 2 },
  { label: 'glowSpread', displayLabel: 'Glow Spread', group: 'Effects', placeholder: '40', unit: '%', type: 'number', min: -100, max: 100, step: 5 },
  { label: 'glowHeadGlint', displayLabel: 'Glow Head Glint', group: 'Effects', placeholder: '60', unit: '%', type: 'number', min: 0, max: 200, step: 5 },
  { label: 'glowCenterX', displayLabel: 'Glow Centre X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -50, max: 50, step: 1 },
  { label: 'glowCenterY', displayLabel: 'Glow Centre Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -50, max: 50, step: 1 },
  { label: 'glowTrail', displayLabel: 'Glow Trail', group: 'Effects', placeholder: '52', unit: '%', type: 'number', min: 0, max: 100, step: 2 },
  { label: 'glowFlicker', displayLabel: 'Glow Flicker', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 2 },
  { label: 'glowMaskThreshold', displayLabel: 'Glow Threshold', group: 'Effects', placeholder: '8', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'glowSourceLevel', displayLabel: 'Glow Layer Opacity', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 2 },
  // 3D Depth (still images with a generated depth map).
  { label: 'depthStrength', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'depthFocus', group: 'Effects', placeholder: '45', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Depth Scan (depthScanLayer.js). The sweep is a pure function of clip time,
  // so `scnPhase` is the handle you key when you want the slice somewhere exact;
  // `scnSpeed` stays static because phase = start + speed x t and an animated
  // rate would teleport the slice (the glowSpeed precedent).
  { label: 'scnPhase', displayLabel: 'Scan Phase', group: 'Effects', placeholder: '4', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'scnWidth', displayLabel: 'Slice Width', group: 'Effects', placeholder: '1.1', unit: '%', type: 'number', min: 0.1, max: 10, step: 0.1 },
  { label: 'scnSplit', displayLabel: 'Scan Spread', group: 'Effects', placeholder: '2.4', unit: '%', type: 'number', min: 0, max: 12, step: 0.1 },
  { label: 'scnFeather', displayLabel: 'Scan Softness', group: 'Effects', placeholder: '0.35', unit: '%', type: 'number', min: 0, max: 5, step: 0.1 },
  { label: 'scnGrain', displayLabel: 'Point Noise', group: 'Effects', placeholder: '22', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'scnGamma', displayLabel: 'Depth Curve', group: 'Effects', placeholder: '1', type: 'number', min: 0.25, max: 3, step: 0.01 },
  { label: 'scnLow', displayLabel: 'Far Cut', group: 'Effects', placeholder: '1.5', unit: '%', type: 'number', min: 0, max: 40, step: 0.5 },
  { label: 'scnHigh', displayLabel: 'Near Cut', group: 'Effects', placeholder: '99.5', unit: '%', type: 'number', min: 60, max: 100, step: 0.5 },
  { label: 'scnBorder', displayLabel: 'Border Reject', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'scnBrightness', displayLabel: 'Scan Brightness', group: 'Effects', placeholder: '125', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'scnSource', displayLabel: 'Original Image', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'scnAmount', displayLabel: 'Scan Amount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Fresnel Rim (fresnelRimLayer.js) — the Depth pack's rim light. `frSpeed`
  // stays static for the same reason as scnSpeed: the sweep integrates it.
  { label: 'frIntensity', displayLabel: 'Rim Intensity', group: 'Effects', placeholder: '2.2', type: 'number', min: 0, max: 6, step: 0.05 },
  { label: 'frWidth', displayLabel: 'Rim Width', group: 'Effects', placeholder: '45', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'frHalo', displayLabel: 'Rim Halo', group: 'Effects', placeholder: '0.6', type: 'number', min: 0, max: 3, step: 0.05 },
  { label: 'frDirMix', displayLabel: 'Rim From a Side', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'frAngle', displayLabel: 'Rim Side Angle', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: 0, max: 360, step: 1 },
  { label: 'frPhase', displayLabel: 'Rim Position', group: 'Effects', placeholder: '30', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'frRimPx', displayLabel: 'Rim Reach', group: 'Effects', placeholder: '12', unit: 'px', type: 'number', min: 2, max: 40, step: 0.5 },
  { label: 'frWindow', displayLabel: 'Rim Depth Window', group: 'Effects', placeholder: '14', unit: '%', type: 'number', min: 1, max: 60, step: 0.5 },
  { label: 'frBody', displayLabel: 'Rim Body Light', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'frAmount', displayLabel: 'Rim Amount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Posterize Time (per-layer clock — posterizeTime.js). The rate is integrated,
  // so a keyed ramp speeds the steps up smoothly.
  { label: 'ptFps', displayLabel: 'Posterize Frame Rate', group: 'Effects', placeholder: '12', unit: 'fps', type: 'number', min: 1, max: 60, step: 1 },
  // Motion Blur (per-layer, transform-velocity driven — motionBlurLayer.js).
  { label: 'mblurShutter', group: 'Effects', placeholder: '180', unit: 'deg', type: 'number', min: 0, max: 720, step: 5 },
  { label: 'mblurAmount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Velocity-mode streak shaping — per-frame uniforms. `mblurSamples` stays
  // static: an animated tap count steps the kernel per integer.
  { label: 'mblurMaxBlur', displayLabel: 'Blur Max Length', group: 'Effects', placeholder: '120', unit: 'px', type: 'number', min: 8, max: 300, step: 1 },
  { label: 'mblurFalloff', displayLabel: 'Blur Falloff', group: 'Effects', placeholder: '250', unit: '%', type: 'number', min: 10, max: 300, step: 5 },
  // Motion Trail (per-layer transform repeats — motionTrailLayer.js). Spacing,
  // the two decays and the drift ARE keyframable: every tap is an evaluator
  // call, so a changing value re-poses the repeats rather than invalidating a
  // cache. `trailCount` is deliberately NOT here — an animated integer count
  // pops a whole copy into existence on each step.
  { label: 'trailSpacing', group: 'Effects', placeholder: '1.5', unit: 'f', type: 'number', min: 0.25, max: 8, step: 0.25 },
  { label: 'trailDecay', group: 'Effects', placeholder: '88', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'trailScale', group: 'Effects', placeholder: '-3', unit: '%', type: 'number', min: -25, max: 25, step: 0.5 },
  // Trail Buffer's two shape controls. Both are safe to animate: the accumulator
  // is rebuilt whenever they change, so a ramp re-derives the smear rather than
  // leaving a half-eroded buffer behind.
  { label: 'trailPersist', group: 'Effects', placeholder: '96', unit: '%', type: 'number', min: 50, max: 100, step: 0.5 },
  { label: 'trailTaper', group: 'Effects', placeholder: '1.6', unit: 'px', type: 'number', min: 0, max: 8, step: 0.1 },
  { label: 'trailRotate', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: -20, max: 20, step: 0.5 },
  { label: 'trailColorize', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'trailAmount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Transform Repeats' per-tap offset — evaluated per frame like the drifts.
  { label: 'trailOffsetX', displayLabel: 'Trail Offset X', group: 'Effects', placeholder: '0', unit: 'px', type: 'number', min: -60, max: 60, step: 1 },
  { label: 'trailOffsetY', displayLabel: 'Trail Offset Y', group: 'Effects', placeholder: '0', unit: 'px', type: 'number', min: -60, max: 60, step: 1 },
  // Grow Fill (autoFillLayer.js). `afSpeed` is a RATE (%/s) and — unlike
  // glowSpeed above — IS keyframable: the Player integrates the track
  // (integratePathRate), so a ramp accelerates the growth smoothly instead of
  // teleporting the front. `afProgress` is the start offset (hand-authored
  // timing goes here). Bake-side params (seeds, speed map, bridges) are
  // deliberately NOT keyframable: a keyed one would force a ~30 ms CPU rebake
  // of the arrival field every frame.
  { label: 'afSpeed', group: 'Effects', placeholder: '25', unit: '%/s', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'afProgress', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Grow Fill's render-side shaping — straight shader uniforms
  // (applyAutoFillUniforms) that never touch the CPU-baked arrival field, so
  // keying them costs nothing. The bake-side params stay static (see above).
  { label: 'afSoftness', displayLabel: 'Fill Softness', group: 'Effects', placeholder: '6', unit: 'px', type: 'number', min: 0, max: 40, step: 1 },
  { label: 'afWavAmp', displayLabel: 'Fill Waviness', group: 'Effects', placeholder: '8', unit: 'px', type: 'number', min: 0, max: 40, step: 1 },
  { label: 'afWavScale', displayLabel: 'Fill Wave Scale', group: 'Effects', placeholder: '60', unit: 'px', type: 'number', min: 10, max: 200, step: 2 },
  { label: 'afFeWidth', displayLabel: 'Front Edge Width', group: 'Effects', placeholder: '0', unit: 'px', type: 'number', min: 0, max: 40, step: 1 },
  { label: 'afFeGlowW', displayLabel: 'Front Glow Width', group: 'Effects', placeholder: '14', unit: 'px', type: 'number', min: 0, max: 80, step: 1 },
  { label: 'afFeGlowI', displayLabel: 'Front Glow Intensity', group: 'Effects', placeholder: '80', unit: '%', type: 'number', min: 0, max: 250, step: 2 },
  { label: 'afBeOffset', displayLabel: 'Back Edge Offset', group: 'Effects', placeholder: '60', unit: 'px', type: 'number', min: 4, max: 240, step: 2 },
  { label: 'afBeWidth', displayLabel: 'Back Edge Width', group: 'Effects', placeholder: '4', unit: 'px', type: 'number', min: 0, max: 40, step: 1 },
  { label: 'afBeGlowW', displayLabel: 'Back Glow Width', group: 'Effects', placeholder: '10', unit: 'px', type: 'number', min: 0, max: 80, step: 1 },
  { label: 'afBeGlowI', displayLabel: 'Back Glow Intensity', group: 'Effects', placeholder: '60', unit: '%', type: 'number', min: 0, max: 250, step: 2 },
  // Layer Mask master density (layerMask.js). The per-mask channels are dynamic
  // (`msk:<mid>:<chan>`, see MASK_KF_PREFIX below) so they cannot live in this
  // static registry, but the stack-wide Amount can.
  { label: 'mskAmount', displayLabel: 'Mask Amount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Repetile (repetileLayer.js). `repReveal` is the one people actually animate —
  // it drives the whole staggered entrance through the per-tile delays, so a
  // single 0 → 100 pair is a full grid build-on.
  { label: 'repReveal', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'repAmount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'repScale', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 1, max: 800, step: 1 },
  { label: 'repRotate', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: -180, max: 180, step: 1 },
  { label: 'repRotateStep', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: -90, max: 90, step: 0.5 },
  { label: 'repSpacingX', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 5, max: 1000, step: 1 },
  { label: 'repSpacingY', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 5, max: 1000, step: 1 },
  { label: 'repOpacityFall', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 100, step: 1 },
  { label: 'repWaveAmp', group: 'Effects', placeholder: '0', unit: '', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'repScaleFall', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -200, max: 500, step: 1 },
  { label: 'repScaleRnd', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'repRotateRnd', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: 0, max: 180, step: 1 },
  { label: 'repOpacityRnd', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'repJitterX', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'repJitterY', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Scroll X/Y are RATES: like afSpeed above, the Player INTEGRATES the track
  // (integratePathRate) so a ramp accelerates the field smoothly instead of
  // teleporting it the moment the rate changes.
  { label: 'repScrollX', group: 'Effects', placeholder: '0', unit: 'px/s', type: 'number', min: -400, max: 400, step: 1 },
  { label: 'repScrollY', group: 'Effects', placeholder: '0', unit: 'px/s', type: 'number', min: -400, max: 400, step: 1 },
  { label: 'repTintAmount', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // The grid COUNTS. They read fractionally in buildRepetileField — the field is
  // built to the ceiling and the outermost ring is faded by the fraction — so a
  // 0 → 5 ramp grows the grid ring by ring instead of stepping five times. What
  // used to make them unanimatable was the per-tile random TABLE, indexed by grid
  // position, which re-rolled every tile's draw whenever a column appeared; the
  // draws are hashed from each tile's own coordinate now, so they hold still.
  { label: 'repLeft', displayLabel: 'Expand Left', group: 'Effects', placeholder: '2', unit: '', type: 'number', min: 0, max: 20, step: 1, precision: 2 },
  { label: 'repRight', displayLabel: 'Expand Right', group: 'Effects', placeholder: '2', unit: '', type: 'number', min: 0, max: 20, step: 1, precision: 2 },
  { label: 'repUp', displayLabel: 'Expand Up', group: 'Effects', placeholder: '1', unit: '', type: 'number', min: 0, max: 20, step: 1, precision: 2 },
  { label: 'repDown', displayLabel: 'Expand Down', group: 'Effects', placeholder: '1', unit: '', type: 'number', min: 0, max: 20, step: 1, precision: 2 },
  // The rest of the tile look — all read live per tile per frame, nothing
  // cached. `repWaveSpeed` stays static (phase = t·speed jumps on a value
  // change; the scroll tracks above are integrated, the wave phase is not),
  // and so does `repSeed`: it IS the random draw, so keying it re-rolls the
  // whole field on every value between.
  { label: 'repBrick', displayLabel: 'Brick Offset', group: 'Effects', placeholder: '50', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'repBlendBorders', displayLabel: 'Blend Borders', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 60, step: 1 },
  { label: 'repWaveLength', displayLabel: 'Wave Length', group: 'Effects', placeholder: '60', unit: '%', type: 'number', min: 5, max: 300, step: 1 },
  { label: 'repSpread', displayLabel: 'Stagger Spread', group: 'Effects', placeholder: '60', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'repFromScale', displayLabel: 'From Scale', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'repFromRotate', displayLabel: 'From Rotate', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: -180, max: 180, step: 1 },
  { label: 'repFromOffset', displayLabel: 'From Offset Y', group: 'Effects', placeholder: '0', unit: 'px', type: 'number', min: -400, max: 400, step: 1 },
  // The layout figures (Radial / Wave / Spiral / Random tiling): size and coil.
  { label: 'repLayoutSpread', displayLabel: 'Layout Spread', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 400, step: 1 },
  { label: 'repLayoutTurns', displayLabel: 'Turns / Cycles', group: 'Effects', placeholder: '2.5', unit: '', type: 'number', min: -12, max: 12, step: 0.25, precision: 2 },
  // Region Distort (regionDistort.js) and Bend (bendLayer.js) — the two warps from the
  // distort lab. Every shaping channel animates, including the region rectangle and the
  // two bend handles: they are plain percent-of-box numbers rather than a points array
  // precisely so they can live in this static registry and be keyed from the canvas
  // control like any other field.
  { label: 'dsRegX', displayLabel: 'Region X', group: 'Effects', placeholder: '50', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'dsRegY', displayLabel: 'Region Y', group: 'Effects', placeholder: '19', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'dsRegW', displayLabel: 'Region Width', group: 'Effects', placeholder: '84', unit: '%', type: 'number', min: 1, max: 200, step: 0.5 },
  { label: 'dsRegH', displayLabel: 'Region Height', group: 'Effects', placeholder: '28', unit: '%', type: 'number', min: 1, max: 200, step: 0.5 },
  { label: 'dsScaleX', displayLabel: 'Stretch X', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 10, max: 400, step: 1 },
  { label: 'dsScaleY', displayLabel: 'Stretch Y', group: 'Effects', placeholder: '155', unit: '%', type: 'number', min: 10, max: 400, step: 1 },
  { label: 'dsFeather', displayLabel: 'Region Feather', group: 'Effects', placeholder: '3', unit: '%', type: 'number', min: 0.2, max: 35, step: 0.2 },
  { label: 'bnAX', displayLabel: 'Axis Start X', group: 'Effects', placeholder: '50', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'bnAY', displayLabel: 'Axis Start Y', group: 'Effects', placeholder: '72', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'bnBX', displayLabel: 'Axis End X', group: 'Effects', placeholder: '50', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'bnBY', displayLabel: 'Axis End Y', group: 'Effects', placeholder: '24', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'bnAngle', displayLabel: 'Bend Angle', group: 'Effects', placeholder: '45', unit: 'deg', type: 'number', min: -180, max: 180, step: 1 },
  { label: 'bnStretch', displayLabel: 'Bend Stretch', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 20, max: 300, step: 1 },
  // Corner Pin (cornerPinLayer.js). All four corners animate — that is how a pin
  // tracks a moving surface — and they are percent-of-box numbers for the same
  // reason the region rectangle is: a points array could not live in this static
  // registry.
  { label: 'cpULX', displayLabel: 'Pin UL X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'cpULY', displayLabel: 'Pin UL Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'cpURX', displayLabel: 'Pin UR X', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'cpURY', displayLabel: 'Pin UR Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'cpLRX', displayLabel: 'Pin LR X', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'cpLRY', displayLabel: 'Pin LR Y', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'cpLLX', displayLabel: 'Pin LL X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'cpLLY', displayLabel: 'Pin LL Y', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  // Droste (drosteLayer.js). The recursion's geometry animates as ordinary
  // percent-of-box numbers, so it lives in this static registry like the pin's
  // corners. `droZoomSpeed` / `droSpinSpeed` are deliberately ABSENT: they are
  // RATES, and a track on a rate makes the phase (t·speed) jump every time the
  // rate changes — animate `droZoom` / `droSpin` instead, which is what they are.
  { label: 'droR1', displayLabel: 'Droste Inner Radius', group: 'Effects', placeholder: '32', unit: '%', type: 'number', min: 2, max: 95, step: 0.5 },
  { label: 'droR2', displayLabel: 'Droste Outer Radius', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 20, max: 200, step: 0.5 },
  { label: 'droShape', displayLabel: 'Droste Shape', group: 'Effects', placeholder: '100', unit: '', type: 'number', min: -100, max: 100, step: 1 },
  { label: 'droStretch', displayLabel: 'Droste Stretch', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 250, step: 1 },
  { label: 'droCX', displayLabel: 'Droste Centre X', group: 'Effects', placeholder: '50', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'droCY', displayLabel: 'Droste Centre Y', group: 'Effects', placeholder: '50', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'droTwist', displayLabel: 'Droste Twist', group: 'Effects', placeholder: '0', unit: '', type: 'number', min: -3, max: 3, step: 0.05 },
  { label: 'droSpin', displayLabel: 'Droste Spin', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: -180, max: 180, step: 1 },
  { label: 'droZoom', displayLabel: 'Droste Zoom', group: 'Effects', placeholder: '0', unit: '', type: 'number', min: -4, max: 4, step: 0.01 },
  { label: 'droFade', displayLabel: 'Droste Depth Fade', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 90, step: 1 },
  { label: 'droTintAmount', displayLabel: 'Droste Depth Tint', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'droDepthLimit', displayLabel: 'Droste Copies', group: 'Effects', placeholder: '0', unit: '', type: 'number', min: 0, max: 20, step: 1 },
  { label: 'droVoidOpacity', displayLabel: 'Droste Void Opacity', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'droDetail', displayLabel: 'Droste Core Detail', group: 'Effects', placeholder: '0', unit: '', type: 'number', min: -2, max: 2, step: 0.1 },
  { label: 'droAmount', displayLabel: 'Droste Amount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Pryzm (pryzmLayer.js). Everything that describes the GLASS animates: cell
  // size, relief, IOR, dispersion, magnify, frost, the light, the look. Drift
  // and Flow are RATES and are deliberately absent — phase = t*rate jumps the
  // moment the rate changes, the same reason droZoomSpeed has no track. Taps is
  // an integer BUDGET, and ramping it would change the frost pattern as well as
  // the spectrum.
  { label: 'pzCell', displayLabel: 'Pryzm Cell Size', group: 'Effects', placeholder: '16', unit: '%', type: 'number', min: 1, max: 40, step: 0.5 },
  { label: 'pzStretch', displayLabel: 'Pryzm Stretch', group: 'Effects', placeholder: '44', unit: '%', type: 'number', min: 15, max: 500, step: 1 },
  { label: 'pzRot', displayLabel: 'Pryzm Rotation', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: 0, max: 180, step: 1 },
  { label: 'pzOX', displayLabel: 'Pryzm Origin X', group: 'Effects', placeholder: '46.16', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'pzOY', displayLabel: 'Pryzm Origin Y', group: 'Effects', placeholder: '45.61', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'pzWarpAmt', displayLabel: 'Pryzm Warp Amount', group: 'Effects', placeholder: '95', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'pzWarpScale', displayLabel: 'Pryzm Warp Scale', group: 'Effects', placeholder: '1.4', unit: '', type: 'number', min: 0.2, max: 8, step: 0.1 },
  { label: 'pzRelief', displayLabel: 'Pryzm Relief', group: 'Effects', placeholder: '1', unit: '%', type: 'number', min: 0, max: 400, step: 1 },
  { label: 'pzBevel', displayLabel: 'Pryzm Bevel Width', group: 'Effects', placeholder: '25', unit: '%', type: 'number', min: 2, max: 100, step: 1 },
  { label: 'pzTilt', displayLabel: 'Pryzm Facet Tilt', group: 'Effects', placeholder: '80', unit: '%', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'pzGroove', displayLabel: 'Pryzm Groove', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 40, step: 1 },
  { label: 'pzIor', displayLabel: 'Pryzm IOR', group: 'Effects', placeholder: '2.06', unit: '', type: 'number', min: 1, max: 2.8, step: 0.01 },
  { label: 'pzThick', displayLabel: 'Pryzm Thickness', group: 'Effects', placeholder: '188', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'pzDisp', displayLabel: 'Pryzm Dispersion', group: 'Effects', placeholder: '105', unit: '%', type: 'number', min: 0, max: 150, step: 1 },
  { label: 'pzMagnify', displayLabel: 'Pryzm Cell Magnify', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'pzFrost', displayLabel: 'Pryzm Frost', group: 'Effects', placeholder: '70', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'pzLightX', displayLabel: 'Pryzm Light X', group: 'Effects', placeholder: '19.96', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'pzLightY', displayLabel: 'Pryzm Light Y', group: 'Effects', placeholder: '48.11', unit: '%', type: 'number', min: -50, max: 150, step: 0.5 },
  { label: 'pzLightZ', displayLabel: 'Pryzm Light Height', group: 'Effects', placeholder: '65', unit: '%', type: 'number', min: 5, max: 300, step: 1 },
  { label: 'pzSpec', displayLabel: 'Pryzm Specular', group: 'Effects', placeholder: '26', unit: '%', type: 'number', min: 0, max: 400, step: 1 },
  { label: 'pzGloss', displayLabel: 'Pryzm Gloss', group: 'Effects', placeholder: '32', unit: '', type: 'number', min: 4, max: 256, step: 1 },
  { label: 'pzSheen', displayLabel: 'Pryzm Edge Sheen', group: 'Effects', placeholder: '21', unit: '%', type: 'number', min: 0, max: 300, step: 1 },
  { label: 'pzSheenFall', displayLabel: 'Pryzm Sheen Falloff', group: 'Effects', placeholder: '4.3', unit: '', type: 'number', min: 0.5, max: 10, step: 0.1 },
  { label: 'pzTintAmt', displayLabel: 'Pryzm Tint', group: 'Effects', placeholder: '70', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'pzAbsorb', displayLabel: 'Pryzm Absorption', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'pzSeam', displayLabel: 'Pryzm Seam Shade', group: 'Effects', placeholder: '24', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'pzSeamW', displayLabel: 'Pryzm Seam Width', group: 'Effects', placeholder: '1', unit: '%', type: 'number', min: 1, max: 40, step: 1 },
  { label: 'pzBloom', displayLabel: 'Pryzm Bloom', group: 'Effects', placeholder: '10', unit: '%', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'pzGrain', displayLabel: 'Pryzm Grain', group: 'Effects', placeholder: '12', unit: '%', type: 'number', min: 0, max: 60, step: 1 },
  { label: 'pzExposure', displayLabel: 'Pryzm Exposure', group: 'Effects', placeholder: '4', unit: '%', type: 'number', min: -100, max: 100, step: 1 },
  { label: 'pzAmount', displayLabel: 'Pryzm Effect Amount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Chroma Key (chromaKeyLayer.js). Matte levels, choke/feather, spill and wrap
  // animate as plain numbers — a key that tightens over a shot, a feather that
  // opens for a soft reveal. The key colour and the keyer choice are not tracks.
  { label: 'ckBalance', displayLabel: 'Key Screen Balance', group: 'Effects', placeholder: '40', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'ckAdapt', displayLabel: 'Key Brightness Adapt', group: 'Effects', placeholder: '40', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'ckTolerance', displayLabel: 'Key Tolerance', group: 'Effects', placeholder: '0.3', unit: '', type: 'number', min: 0.02, max: 1, step: 0.01 },
  { label: 'ckLumaWeight', displayLabel: 'Key Luma Weight', group: 'Effects', placeholder: '0.5', unit: '', type: 'number', min: 0, max: 2, step: 0.05 },
  { label: 'ckChromaGuard', displayLabel: 'Key Chroma Guard', group: 'Effects', placeholder: '1.8', unit: '', type: 'number', min: 0, max: 4, step: 0.1 },
  { label: 'ckGain', displayLabel: 'Key Screen Gain', group: 'Effects', placeholder: '115', unit: '%', type: 'number', min: 50, max: 300, step: 1 },
  { label: 'ckClipBlack', displayLabel: 'Key Clip Black', group: 'Effects', placeholder: '8', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'ckClipWhite', displayLabel: 'Key Clip White', group: 'Effects', placeholder: '70', unit: '%', type: 'number', min: 1, max: 100, step: 1 },
  { label: 'ckShrink', displayLabel: 'Key Choke', group: 'Effects', placeholder: '0', unit: 'px', type: 'number', min: -6, max: 6, step: 0.1 },
  { label: 'ckFeather', displayLabel: 'Key Feather', group: 'Effects', placeholder: '0', unit: 'px', type: 'number', min: 0, max: 12, step: 0.1 },
  { label: 'ckSpill', displayLabel: 'Key Spill Removal', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'ckSpillBias', displayLabel: 'Key Spill Bias', group: 'Effects', placeholder: '30', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'ckSpillLuma', displayLabel: 'Key Restore Luma', group: 'Effects', placeholder: '70', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'ckSpillTintAmt', displayLabel: 'Key Spill Tint', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'ckWrapAmt', displayLabel: 'Key Light Wrap', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'ckWrapWidth', displayLabel: 'Key Wrap Width', group: 'Effects', placeholder: '12', unit: 'px', type: 'number', min: 1, max: 40, step: 0.5 },
  { label: 'ckAmount', displayLabel: 'Key Amount', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  // Mockup Frame (mockupFrame.js). The chassis placement and the artwork's placement
  // inside its screen both animate — that is how a mockup pushes in or hands off between
  // shots — and they are plain percent-of-box numbers, so they live here like the pin's
  // corners rather than needing a dynamic prefix.
  { label: 'mfFit', displayLabel: 'Mockup Scale', group: 'Effects', placeholder: '70', unit: '%', type: 'number', min: 5, max: 200, step: 0.5 },
  { label: 'mfOffsetX', displayLabel: 'Mockup Offset X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 100, step: 0.5 },
  { label: 'mfOffsetY', displayLabel: 'Mockup Offset Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 100, step: 0.5 },
  { label: 'mfRot', displayLabel: 'Mockup Rotation', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: -180, max: 180, step: 0.5 },
  { label: 'mfMediaScale', displayLabel: 'Screen Scale', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: 10, max: 400, step: 0.5 },
  { label: 'mfMediaX', displayLabel: 'Screen X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 100, step: 0.5 },
  { label: 'mfMediaY', displayLabel: 'Screen Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 100, step: 0.5 },
  { label: 'mfMediaRot', displayLabel: 'Screen Rotation', group: 'Effects', placeholder: '0', unit: 'deg', type: 'number', min: -180, max: 180, step: 0.5 },
  { label: 'mfGlare', displayLabel: 'Mockup Glare', group: 'Effects', placeholder: '35', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'mfScrollSpeedX', displayLabel: 'Screen Scroll Speed X', group: 'Effects', placeholder: '10', unit: '%/s', type: 'number', min: -300, max: 300, step: 0.5 },
  { label: 'mfScrollSpeedY', displayLabel: 'Screen Scroll Speed Y', group: 'Effects', placeholder: '10', unit: '%/s', type: 'number', min: -300, max: 300, step: 0.5 },
  { label: 'mfShadow', displayLabel: 'Mockup Shadow', group: 'Effects', placeholder: '55', unit: '%', type: 'number', min: 0, max: 100, step: 1 },
  { label: 'mfShadowBlur', displayLabel: 'Mockup Shadow Blur', group: 'Effects', placeholder: '60', unit: '', type: 'number', min: 0, max: 200, step: 1 },
  { label: 'mfShadowY', displayLabel: 'Mockup Shadow Y', group: 'Effects', placeholder: '26', unit: '', type: 'number', min: -60, max: 160, step: 1 },
  { label: 'mfShadowSpread', displayLabel: 'Mockup Shadow Spread', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -20, max: 30, step: 0.5 },
  // Bezier Warp (bezierWarp.js) — the twelve ring points, clockwise from upper left:
  // corner, its two outgoing tangents, next corner, … Fixed in number, so they live in
  // this static registry like the pin's corners. Mesh Warp's lattice does NOT: its
  // channel count depends on the grid, so buildMeshWarpKfProps publishes those per item.
  { label: 'bwULX', displayLabel: 'Bezier UL X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwULY', displayLabel: 'Bezier UL Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwT1X', displayLabel: 'Bezier Top 1 X', group: 'Effects', placeholder: '33', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwT1Y', displayLabel: 'Bezier Top 1 Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwT2X', displayLabel: 'Bezier Top 2 X', group: 'Effects', placeholder: '67', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwT2Y', displayLabel: 'Bezier Top 2 Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwURX', displayLabel: 'Bezier UR X', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwURY', displayLabel: 'Bezier UR Y', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwR1X', displayLabel: 'Bezier Right 1 X', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwR1Y', displayLabel: 'Bezier Right 1 Y', group: 'Effects', placeholder: '33', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwR2X', displayLabel: 'Bezier Right 2 X', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwR2Y', displayLabel: 'Bezier Right 2 Y', group: 'Effects', placeholder: '67', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwLRX', displayLabel: 'Bezier LR X', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwLRY', displayLabel: 'Bezier LR Y', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwB1X', displayLabel: 'Bezier Bottom 1 X', group: 'Effects', placeholder: '67', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwB1Y', displayLabel: 'Bezier Bottom 1 Y', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwB2X', displayLabel: 'Bezier Bottom 2 X', group: 'Effects', placeholder: '33', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwB2Y', displayLabel: 'Bezier Bottom 2 Y', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwLLX', displayLabel: 'Bezier LL X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwLLY', displayLabel: 'Bezier LL Y', group: 'Effects', placeholder: '100', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwL1X', displayLabel: 'Bezier Left 1 X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwL1Y', displayLabel: 'Bezier Left 1 Y', group: 'Effects', placeholder: '67', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwL2X', displayLabel: 'Bezier Left 2 X', group: 'Effects', placeholder: '0', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
  { label: 'bwL2Y', displayLabel: 'Bezier Left 2 Y', group: 'Effects', placeholder: '33', unit: '%', type: 'number', min: -100, max: 200, step: 0.5 },
];

export const KF_GROUPS = ['Transform', 'Color', 'Filters', 'Effects'];

export const KF_PROP_LABELS = KF_PROPS.map((p) => p.label);

export const KF_COLOR_PROPS = new Set(['color', 'backgroundColor', 'textColor', 'textBgColor', 'shapeFill', 'textOutlineColor', 'borderColor']);

// Colour tracks whose keys may hold a CSS gradient string instead of a single
// colour (these paints have a gradient mode in the panel).
export const KF_GRADIENT_PROPS = new Set(['textColor', 'shapeFill']);

// Motion-template option tracks (`mp:<param>` numeric, `mpc:<param>` colour) live
// outside this static registry — see motionKf.js. The prefixes are declared here,
// in the leaf module, so the interpolator can tell a colour track from a numeric one
// without importing motionKf.js (which would pull the whole template registry in).
export const MOTION_KF_PREFIX = 'mp:';
export const MOTION_KF_COLOR_PREFIX = 'mpc:';

// Grid Builder layout parameters (`gr:<key>`, always numeric) animate through the
// same machinery — see gridLayout.js `GRID_KF_FIELDS`. Declared here beside the
// motion prefixes so the sanitizer and the interpolator can recognise the key
// shape without importing the layout engine.
export const GRID_KF_PREFIX = 'gr:';

// Rig (Puppet Pin) tracks (`rig:<pid>:<chan>`, always numeric) — per-pin pose
// channels of the rig layer effect; see rigDeform.js RIG_KF_CHAN_META. Declared
// here for the same reason as the prefixes above.
export const RIG_KF_PREFIX = 'rig:';

// Particle proximity effector tracks (`px:<param>`, always numeric) — the field
// shaping (range / falloff / depth) and every driven amount of a particle layer's
// PROXIMITY EFFECTORS block; see sim/particles/schema.js PARTICLE_PROX_KF_FIELDS.
// Declared here beside the prefixes above for the same reason: the sanitizer and
// the interpolator recognise the key shape without importing the particle schema.
//
// There is no `pxc:` colour namespace and there is not going to be one. The
// effector's colour is a RAMP keyed on distance, not on time — animating it would
// mean interpolating a stop list, which is what the ramp already is.
export const PROX_KF_PREFIX = 'px:';

// Layer Mask tracks (`msk:<mid>:<chan>`) — per-mask geometry channels of the
// layerMask layer effect; see layerMask.js MASK_KF_CHAN_META. Declared here for
// the same reason as the prefixes above.
//
// A mask is ALPHA ONLY: there is deliberately no `mskc:` colour namespace, so
// isColorTrackKey needs no branch for masks. Don't add one "just in case".
//
// One of these channels is NOT a number: `msk:<mid>:path` carries a JSON point
// list, exactly like the shape layer's own `shapePath` track. That is why the
// regex below exists separately from layerMask.js's full parser — shapePath.js
// needs to recognise it (isPathTrackKey) without importing the mask module.
export const MASK_KF_PREFIX = 'msk:';

// Color Correction tracks (`cc:<path>`, always numeric) — every number of an item's
// `colorCorrection` (mix, white balance, tone, levels per channel, wheels, HSL
// bands); see colorCorrection.js CC_KF_FIELDS. Declared here beside the prefixes
// above so the sanitizer and the labels recognise the key shape cheaply.
export const CC_KF_PREFIX = 'cc:';

const MASK_PATH_KF_RE = /^msk:[A-Za-z0-9_-]{1,24}:path$/;

export function isMaskPathTrackKey(prop) {
  return typeof prop === 'string' && MASK_PATH_KF_RE.test(prop);
}

// Does this track key interpolate in RGBA rather than numerically? Registry colour
// props plus motion-template colour params.
export function isColorTrackKey(prop) {
  return KF_COLOR_PROPS.has(prop)
    || STROKE_COLOR_KF_LABELS.has(prop)
    || (typeof prop === 'string' && prop.startsWith(MOTION_KF_COLOR_PREFIX));
}

export function kfPropMeta(label) {
  return KF_PROPS.find((p) => p.label === label) || null;
}

// First KF_PROPS-ordered property that has a non-empty track, else null. Falls back
// to any other non-empty track key — adjustment-layer effect tracks (`fx:<eid>:<param>`)
// and motion-template option tracks (`mp:`/`mpc:`), which live outside this static
// registry — so a layer whose ONLY tracks are those still counts as keyframed (and
// isn't clobbered by the builder's panel-apply, which writes {} when it thinks nothing
// is tracked).
export function firstTrackProp(propertyKeyframes) {
  if (!propertyKeyframes || typeof propertyKeyframes !== 'object') return null;
  for (const p of KF_PROPS) {
    if (Array.isArray(propertyKeyframes[p.label]) && propertyKeyframes[p.label].length > 0) return p.label;
  }
  for (const [key, track] of Object.entries(propertyKeyframes)) {
    if (Array.isArray(track) && track.length > 0) return key;
  }
  return null;
}

export function hasAnyTrack(propertyKeyframes) {
  return firstTrackProp(propertyKeyframes) != null;
}

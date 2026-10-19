import { TransitionType, LayerTransitionType } from './types';
import { advancedTransitionOptionFields, getAdvancedTransitionPreset } from './advancedTransitions';

export const TRANSITION_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'fade', name: 'Fade' }),
  Object.freeze({ id: 'slide', name: 'Slide & Push' }),
  Object.freeze({ id: 'wipe', name: 'Wipe' }),
  Object.freeze({ id: 'zoom', name: 'Zoom & Scale' }),
  Object.freeze({ id: 'advanced', name: 'Advanced' }),
  Object.freeze({ id: 'special', name: 'Special' }),
]);

// Agent discovery, the picker, and the generated capabilities catalog all read
// these descriptions. Adding an enum value without metadata remains visible as
// `special`, but the catalog generator's contract test will flag it.
export const CROSS_TRANSITION_META = Object.freeze({
  'Cross Fade': Object.freeze(['fade', 'Both clips blend through each other']),
  Push: Object.freeze(['slide', 'Both clips travel together — the next clip pushes the current one out, left, right, up or down']),
  Parallax: Object.freeze(['slide', 'The next clip slides in while the current one drifts back slower, left, right, up or down']),
  Wipe: Object.freeze(['wipe', 'A hard edge sweeps across the frame, left to right, right to left, up or down']),
  'Zoom In': Object.freeze(['zoom', 'Current clip flies past the camera']),
  'Zoom Out': Object.freeze(['zoom', 'Next clip settles back from oversize']),
  'Advanced Zoom': Object.freeze(['advanced', 'Both clips zoom through a point you choose, with rotation, radial blur, fisheye, exposure flash and camera shake']),
  'Advanced Movement': Object.freeze(['advanced', 'Both clips travel toward a point you choose, with directional blur, fisheye, exposure flash and camera shake']),
  '3D Carousel': Object.freeze(['advanced', 'Clips ride a turning 3D carousel, one panel after the other']),
  'Louver Flip': Object.freeze(['advanced', 'Staggered venetian-blind slats flip to the next clip']),
  'Circular Wipe': Object.freeze(['advanced', 'The next clip opens through a soft circle you aim, with a gradient beam on the edge']),
  'Pixel Blocks': Object.freeze(['advanced', 'The next clip arrives behind a front of pixel blocks that sweeps, bursts from a point or dissolves — or a colour wipes in first']),
  'Camera Whip': Object.freeze(['advanced', 'One camera whips off the outgoing clip and lands on the next, smeared by its own shutter']),
  'Zoom Ruler': Object.freeze(['advanced', 'The next clip opens inside a growing ruler box — full-frame guides and corner marks — with an optional zoom']),
  'Gradient Glow Stack': Object.freeze(['advanced', 'A stack of huge soft gradient glows sweeps through the frame; the next clip appears behind it']),
  'Gradient Map': Object.freeze(['advanced', 'The clip turns into a spinning gradient map of itself, then the next clip comes back through the shadows first']),
  'Scale Swap': Object.freeze(['zoom', 'Clips shrink, trade places and grow back']),
  'Side by Side': Object.freeze(['special', 'Clips park side by side, then the next takes over']),
  'Dip to Black': Object.freeze(['fade', 'Down to black, then up into the next clip']),
  'Radial Wipe': Object.freeze(['wipe', 'A circle opens out from the centre']),
  Custom: Object.freeze(['special', 'Built in the Transition Builder']),
});

export const LAYER_TRANSITION_META = Object.freeze({
  Fade: Object.freeze(['fade', 'Layer fades up into view', 'Layer fades away']),
  Slide: Object.freeze(['slide', 'Layer slides in from the left or right, or up or down into place', 'Layer slides out to the left or right, or up or down and out']),
  'Zoom In': Object.freeze(['zoom', 'Layer grows in from small', 'Layer pushes toward the camera']),
  'Zoom Out': Object.freeze(['zoom', 'Layer settles back from oversize', 'Layer shrinks away']),
  Wipe: Object.freeze(['wipe', 'Layer reveals behind a hard edge sweeping in the direction you pick', 'Layer clears behind a hard edge sweeping in the direction you pick']),
  'Dip to Black': Object.freeze(['fade', 'Layer fades up out of black', 'Layer fades down to black']),
  'Radial Wipe': Object.freeze(['wipe', 'A circle opens out from the centre', 'A circle closes in on the centre']),
  // The advanced trio, driven one-sided (see LayerTransitionType in types.js).
  // Same option schema as the cross transitions of the same name.
  'Advanced Zoom': Object.freeze(['advanced',
    'Layer zooms in through a point you choose, with rotation, radial blur, fisheye, exposure flash and camera shake',
    'Layer zooms away through a point you choose, with rotation, radial blur, fisheye, exposure flash and camera shake']),
  'Advanced Movement': Object.freeze(['advanced',
    'Layer travels in from a point you choose, with directional blur, fisheye, exposure flash and camera shake',
    'Layer travels off toward a point you choose, with directional blur, fisheye, exposure flash and camera shake']),
  '3D Carousel': Object.freeze(['advanced',
    'Layer swings in on a turning 3D carousel',
    'Layer swings away on a turning 3D carousel']),
  'Camera Whip': Object.freeze(['advanced',
    'The camera whips onto the layer and settles, smeared by its own shutter',
    'The camera whips off the layer, smeared by its own shutter']),
  'Gradient Glow Stack': Object.freeze(['advanced',
    'A stack of soft gradient glows sweeps through the frame and the layer appears behind it',
    'A stack of soft gradient glows sweeps through the frame and takes the layer away']),
  'Gradient Map': Object.freeze(['advanced',
    'The layer arrives as a spinning gradient map of itself, then its real picture comes back through the shadows first',
    'The layer turns into a spinning gradient map of itself, then dissolves away darkest first']),
  'Pixel Blocks': Object.freeze(['advanced',
    'The layer arrives behind a front of pixel blocks that sweeps, bursts from a point or dissolves — or a colour wipes in first',
    'The layer breaks into pixel blocks that sweep, burst or dissolve away — or a colour wipes over it first']),
  Custom: Object.freeze(['special', 'Built in the Transition Builder', 'Built in the Transition Builder']),
});

export function builtInCrossTransitionCapabilities() {
  return Object.values(TransitionType).map((value) => {
    const meta = CROSS_TRANSITION_META[value] || ['special', ''];
    const advanced = getAdvancedTransitionPreset(value);
    return {
      value,
      name: value,
      category: meta[0],
      description: meta[1] || '',
      // a `plain` preset (Push, Wipe …) only carries a direction: still a built-in
      kind: advanced && !advanced.plain ? 'advanced' : (value === TransitionType.CUSTOM ? 'builder' : 'built-in'),
      defaultDuration: Number.isFinite(advanced?.defaultDuration) ? advanced.defaultDuration : 1,
      optionDefaults: advanced?.optionDefaults || null,
      // `{ type: 'section' }` entries only group the inspector UI. They carry no
      // key, so they must not reach the catalog an agent reads to build
      // transitionOptions — it would try to set an option that does not exist.
      optionFields: (advanced?.optionFields || []).filter((field) => field?.type !== 'section'),
      hasAudio: Boolean(advanced?.audio),
    };
  });
}

export function builtInLayerTransitionCapabilities() {
  return Object.values(LayerTransitionType).map((value) => {
    const meta = LAYER_TRANSITION_META[value] || ['special', '', ''];
    // The advanced trio runs one-sided off the same descriptor the cross slot
    // uses, so its options belong in the catalog an agent reads — written into
    // transitionInOptions / transitionOutOptions rather than transitionOptions.
    const advanced = getAdvancedTransitionPreset(value);
    return {
      value,
      name: value,
      category: meta[0],
      descriptionIn: meta[1] || '',
      descriptionOut: meta[2] || meta[1] || '',
      slots: ['in', 'out'],
      // a `plain` preset (Push, Wipe …) only carries a direction: still a built-in
      kind: advanced && !advanced.plain ? 'advanced' : (value === LayerTransitionType.CUSTOM ? 'builder' : 'built-in'),
      defaultDuration: Number.isFinite(advanced?.defaultDuration) ? advanced.defaultDuration : 1,
      optionDefaults: advanced?.optionDefaults || null,
      // `{ type: 'section' }` groups the inspector UI and carries no key, and a
      // `crossOnly` field has no meaning on a one-sided slot — neither must
      // reach the catalog or an agent would try to set an option that is not there.
      optionFields: advancedTransitionOptionFields(advanced, 'in').filter((field) => field?.type !== 'section'),
      hasAudio: Boolean(advanced?.audio),
    };
  });
}

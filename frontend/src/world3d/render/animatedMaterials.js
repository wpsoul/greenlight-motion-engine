// (matpack) The animated material pack (plan stage 3, "пакет анимированных материалов"): four texture-graph presets alive in time.
// Each lies on the object as a material: baked in the object's own space on its atlas (render/texGraphNodes.js edgeGlow, fractal3d, beam,
// sweep), again on every frame its numbers change, into maps Draft and Final both read. Seen in reflections and through glass, and in Final
// a glow lights the set. Every number can be keyed (`keys`), and `hold` keeps the material at one moment while the shot runs on. The glow's
// strength is the material's emission strength: keying it bakes nothing.
// Plain data and pure functions: render/texGraphPresets.js adds them to the presets, and the editor reads their numbers for its keyframe
// tracks (components/videoEditor/rig3d.js), so this file imports nothing.

const N = (d, min, max, about) => ({ type: 'number', default: d, min, max, about });
const C = (d, about) => ({ type: 'color', default: d, about });
const R = (d, about) => ({ type: 'ramp', default: d, about });
const E = (options, about) => ({ type: 'enum', options, default: options[0], about });
const remap = (id, a, low, high) => ({ id, op: 'math', a, fn: 'remap', low, high });
const smooth = (id, a, low, high) => ({ id, op: 'math', a, fn: 'smoothstep', low, high });

const AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** The band's light as glow (emission) or as a sheen (glossy under the band, which glows a little). */
function bandOut(p, id) {
  const sheen = p.mode === 'sheen';
  return {
    emission: `#${id}`, emissionStrength: p.intensity * (sheen ? p.sheenGlow : 1),
    ...(sheen ? { roughness: `#${id}Rough` } : { roughness: p.roughness }),
  };
}
const surfaceParams = (base, roughness) => ({
  base: C(base, 'the surface\'s own colour'), roughness: N(roughness, 0, 1, 'the surface\'s roughness'), metalness: N(0, 0, 1, 'the surface\'s metalness'),
});

export const ANIMATED_PRESETS = {
  edgeGlow: {
    animated: true,
    about: 'Light along the edges of the shape, read from its curvature (not from the picture: the lines do not flicker as it turns), steady, pulsing, or a lit stretch running along an axis: neon edges on 3D text, a product, a wall. The material\'s emission: it shows in reflections and through glass, and lights the set in Final.',
    params: {
      color: C('#4de3ff', 'the glow\'s colour; its core goes toward white'), intensity: N(7, 0, 1000, 'how strongly it glows'),
      width: N(0.006, 0.0005, 0.2, 'metres the glow reaches from an edge'), core: N(0.3, 0.05, 1, 'the white-hot line, share of width'),
      edges: E(['convex', 'concave', 'both'], 'outer edges, inner corners or both'), threshold: N(22, 0, 89, 'degrees of bend before an edge glows'),
      anim: E(['steady', 'pulse', 'run'], 'steady, pulsing, or a lit stretch running along `axis`'), speed: N(1, 0, 20, 'pulses a second, or runs every two seconds at 1'),
      axis: E(['x', 'y', 'z'], 'the object\'s axis a run travels along'), run: N(0.25, 0.02, 2, 'length of the lit stretch, share of the object'),
      ...surfaceParams('#15171b', 0.32), metalness: N(0.3, 0, 1, 'the surface\'s metalness'),
    },
    build: (p) => ({
      nodes: [{ id: 'glow', op: 'edgeGlow', color: p.color, width: p.width, core: p.core, edges: p.edges, threshold: p.threshold, anim: p.anim, speed: p.speed, axis: p.axis, run: p.run }],
      out: { emission: '#glow', emissionStrength: p.intensity, base: p.base, roughness: p.roughness, metalness: p.metalness },
    }),
  },
  fractalNoise: {
    animated: true,
    about: 'Fractal noise in the object\'s own 3D space, alive in time: it boils in place and can flow through the object, and never slides over the surface as the object moves. Colours from a ramp, roughness from the noise, and a glow from its bright end if asked (lava, plasma, smoke on glass, living stone).',
    params: {
      colors: R(['#5a1e0c', '#d9743a', '#f3b48a', '#fff4ea'], 'the noise\'s colours, dark to light'),
      scale: N(14, 0.01, 2000, 'cells per metre'), octaves: N(5, 1, 8, 'layers of finer detail'), gain: N(0.5, 0, 1, 'strength of each finer layer'),
      type: E(['plain', 'turbulent', 'ridged'], 'plain clouds, folded (turbulent) or sharp crests (ridged)'),
      contrast: N(1.7, 0, 8, 'spreads it'), brightness: N(0, -1, 1, 'moves it up or down'),
      evolution: N(0.35, 0, 20, 'how fast it boils in place'),
      driftX: N(0, -10, 10, 'metres a second it flows along the object\'s x'), driftY: N(0.02, -10, 10, 'metres a second along its y'), driftZ: N(0, -10, 10, 'metres a second along its z'),
      roughLow: N(0.6, 0, 1, 'roughness at the dark end'), roughHigh: N(0.22, 0, 1, 'roughness at the light end'), metalness: N(0, 0, 1, 'the surface\'s metalness'),
      emission: N(0, 0, 1000, 'how strongly the light end glows (0: no glow)'), emissionFrom: N(0.62, 0, 1, 'where on the ramp the glow starts'),
      seed: N(0, 0, 1e6, 'another variant'),
    },
    build: (p) => {
      const nodes = [
        { id: 'n', op: 'fractal3d', scale: p.scale, octaves: p.octaves, gain: p.gain, type: p.type, contrast: p.contrast, brightness: p.brightness,
          evolution: p.evolution, drift: [p.driftX, p.driftY, p.driftZ], seed: p.seed },
        { id: 'col', op: 'gradientMap', in: '#n', colors: p.colors },
        remap('rough', '#n', p.roughLow, p.roughHigh),
      ];
      const out = { base: '#col', roughness: '#rough', metalness: p.metalness };
      if (p.emission > 0) {
        nodes.push(smooth('glowAt', '#n', p.emissionFrom, 1), { id: 'glow', op: 'math', a: '#col', b: '#glowAt', fn: 'multiply' });
        Object.assign(out, { emission: '#glow', emissionStrength: p.emission });
      }
      return { nodes, out };
    },
  },
  motionBeam: {
    animated: true,
    about: 'A band of light that travels along an axis of the object (Gradient Motion Beam): three colours head to tail, a fading trail, by speed or keyed by hand; as a glow, or as a sheen (the surface turns glossy under it). A glow lights the set in Final.',
    params: {
      axis: E(['x', 'y', 'z'], 'the object\'s axis it travels along'), width: N(0.22, 0.005, 4, 'share of the object\'s length'), soft: N(0.6, 0, 1, 'soft shoulders (1) or a hard band (0)'),
      speed: N(0.4, -20, 20, 'passes a second'), position: N(null, -3, 4, 'drive it by hand: its middle, 0 at the start of the object to 1 at its end; key it. Left out, it travels by speed'),
      trail: N(0.6, 0, 4, 'a fading tail behind it'), color1: C('#ffc93f', 'head colour'), color2: C('#2fd07a', 'middle colour'), color3: C('#3f7bff', 'tail colour'),
      intensity: N(6, 0, 1000, 'how strongly it glows'), mode: E(['glow', 'sheen'], 'a glow, or a glossy sheen under the band'),
      tint: N(0.4, 0, 1, 'how much the beam colours the surface under it'), sheenGlow: N(0.15, 0, 1, 'sheen: how much the band still glows'),
      glossRoughness: N(0.05, 0, 1, 'sheen: roughness under the band'), ...surfaceParams('#e9e6e1', 0.35),
    },
    build: (p) => {
      const nodes = [{ id: 'beam', op: 'beam', axis: AXIS[p.axis] || AXIS.x, width: p.width, soft: p.soft, speed: p.speed, position: p.position, trail: p.trail,
        c1: p.color1, c2: p.color2, c3: p.color3 }];
      let base = p.base;
      if (p.tint > 0) {
        nodes.push({ id: 'surface', op: 'constant', color: p.base }, { id: 'tinted', op: 'blend', a: '#surface', b: '#beam', mask: '#beam.a', opacity: p.tint });
        base = '#tinted';
      }
      if (p.mode === 'sheen') nodes.push({ id: 'beamRough', op: 'math', a: '#beam.a', fn: 'remap', low: p.roughness, high: p.glossRoughness });
      return { nodes, out: { base, metalness: p.metalness, ...bandOut(p, 'beam') } };
    },
  },
  sweep: {
    animated: true,
    about: 'A bright band that sweeps across the object once or again and again (Gradient Sweep): timed by start, duration and gap, or keyed by hand; as a glow, or as a sheen (a glint of gloss crossing a product). A glow lights the set in Final.',
    params: {
      angle: N(14, -360, 360, 'direction across the object, degrees in its own x-y plane (0 along x, 90 up y)'),
      width: N(0.16, 0.01, 2, 'the band\'s width, share of the object'), core: N(0.25, 0, 1, 'the bright core, share of the band'),
      color: C('#ffe2a4', 'the band\'s colour'), intensity: N(3.5, 0, 1000, 'how strongly it glows'),
      start: N(0.3, -1e4, 1e4, 'seconds: when the first sweep starts'), duration: N(1.4, 0.05, 60, 'seconds a sweep takes'), gap: N(0.6, 0, 60, 'seconds between sweeps'),
      repeat: E(['loop', 'once'], 'again and again, or once'), easing: E(['sine', 'linear', 'smooth', 'out'], 'how a sweep speeds up and slows down'),
      progress: N(null, -1, 2, 'drive it by hand: 0 before the object, 1 past it; key it. Left out, it runs by start, duration and gap'),
      mode: E(['glow', 'sheen'], 'a glow, or a glossy sheen under the band'), sheenGlow: N(0.15, 0, 1, 'sheen: how much the band still glows'),
      glossRoughness: N(0.05, 0, 1, 'sheen: roughness under the band'), ...surfaceParams('#e2673f', 0.5),
    },
    build: (p) => {
      const nodes = [{ id: 'band', op: 'sweep', angle: p.angle, width: p.width, core: p.core, color: p.color, start: p.start, duration: p.duration, gap: p.gap,
        loop: p.repeat !== 'once', easing: p.easing, progress: p.progress }];
      if (p.mode === 'sheen') nodes.push({ id: 'bandRough', op: 'math', a: '#band.a', fn: 'remap', low: p.roughness, high: p.glossRoughness });
      return { nodes, out: { base: p.base, metalness: p.metalness, ...bandOut(p, 'band') } };
    },
  },
};

/** The material library's animated entries (render/materialLibrary.js spreads them in; `{ "preset": "neonEdgesRun" }` on a material). */
const graph = (preset, params = {}) => ({ graph: { preset, ...params } });
export const ANIMATED_LIBRARY = {
  neonEdges: { group: 'animated', about: 'Cyan light along the edges of the shape, steady, on dark satin metal (animated: edgeGlow).', def: graph('edgeGlow') },
  neonEdgesRun: { group: 'animated', about: 'Edge light that runs along the object in a lit stretch, cyan (animated: edgeGlow).', def: graph('edgeGlow', { anim: 'run', speed: 0.5, run: 0.35 }) },
  neonEdgesPulse: { group: 'animated', about: 'Pink edge light that pulses, once a second (animated: edgeGlow).', def: graph('edgeGlow', { color: '#ff2a8a', anim: 'pulse', speed: 1 }) },
  lavaNoise: { group: 'animated', about: 'Molten lava: a dark crust whose cracks glow and boil on the surface (animated: fractalNoise, ridged).', def: graph('fractalNoise', { type: 'ridged', colors: ['#120403', '#3a0c05', '#d4420c', '#ffc04a'], contrast: 1.6, brightness: -0.1, scale: 10, evolution: 0.4, driftY: 0.01, emission: 6, emissionFrom: 0.55, roughLow: 0.9, roughHigh: 0.5 }) },
  plasmaNoise: { group: 'animated', about: 'Plasma: soft blue-violet clouds drifting through the object, glowing (animated: fractalNoise).', def: graph('fractalNoise', { colors: ['#05031a', '#2a1a7a', '#6a4dff', '#c9f2ff'], scale: 6, evolution: 0.6, driftX: 0.03, emission: 4, emissionFrom: 0.4, roughLow: 0.4, roughHigh: 0.2 }) },
  livingStone: { group: 'animated', about: 'Stone whose mottling slowly shifts in place, no glow (animated: fractalNoise).', def: graph('fractalNoise', { type: 'ridged', colors: ['#3b3a37', '#6e6a62', '#a39d91', '#d8d2c5'], scale: 8, evolution: 0.08, driftY: 0, contrast: 1.3, roughLow: 0.8, roughHigh: 0.55 }) },
  beamGlow: { group: 'animated', about: 'A band of light travelling along the object, gold to green to blue (animated: motionBeam).', def: graph('motionBeam') },
  beamSheen: { group: 'animated', about: 'A band of gloss travelling along the object: the surface turns glossy under it (animated: motionBeam).', def: graph('motionBeam', { mode: 'sheen', tint: 0, intensity: 3 }) },
  sweepGlow: { group: 'animated', about: 'A warm band of light sweeping across the object again and again (animated: sweep).', def: graph('sweep') },
  sweepGlint: { group: 'animated', about: 'A glint of gloss sweeping across a product, as in a packshot (animated: sweep).', def: graph('sweep', { mode: 'sheen', angle: 62, width: 0.14, sheenGlow: 0.3, base: '#1d1f24', roughness: 0.45 }) },
};

/** The few numbers the editor's Scene panel shows for each, with a stopwatch (every number is a track in the Keyframe Builder). */
export const ANIMATED_PANEL = {
  edgeGlow: ['intensity', 'width', 'speed'], fractalNoise: ['emission', 'scale', 'evolution'],
  motionBeam: ['intensity', 'speed', 'width'], sweep: ['intensity', 'duration', 'width'],
};
export const ANIMATED_NAMES = { edgeGlow: 'Edge glow', fractalNoise: 'Fractal noise', motionBeam: 'Motion beam', sweep: 'Sweep' };

/** The numbers of each animated preset an editor keyframe track can move: { preset: { param: { min, max, default, about } } }. */
export const ANIMATED_KEYABLE = Object.fromEntries(Object.entries(ANIMATED_PRESETS).map(([name, p]) => [name,
  Object.fromEntries(Object.entries(p.params).filter(([, q]) => q.type === 'number').map(([k, q]) => [k, { min: q.min, max: q.max, default: q.default, about: q.about }]))]));

// Materialised particle presets.
//
// Each `make(w, h)` returns a COMPLETE system, sized to the composition, which is
// written onto the item when the preset is applied. Nothing here is consulted again
// afterwards — see the note in schema.js about why presets must not be live
// references.
//
// The numbers are the ones tuned in html/particle-system-lab.html. Two rules came
// out of that look-dev and are worth keeping when adding a preset:
//
//   * an AMBIENT preset (dust, stars, snow, swirl) needs a pre-roll of one full
//     lifetime, or the box is visibly filling up during the first seconds;
//   * `maxParticles` must be >= rate x lifetime, or emission throttles at the cap
//     and the preset silently runs thinner than it was authored.

import { compScale, particleSystemDefaults } from './schema.js';

const R = Math.round;
// A radius or size in 1080p px, scaled to this composition by AREA (see compScale).
const RK = (w, h, px) => Math.round(px * compScale(w, h));

export const PARTICLE_PRESETS = [
  {
    id: 'dust',
    name: 'Dust',
    hint: 'Slow motes drifting through the frame',
    make: (w, h) => particleSystemDefaults(w, h),
  },

  {
    id: 'stars',
    name: 'Stars',
    hint: 'Twinkling additive star field',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'stars';
      c.seed = 20477;
      c.solver.maxParticles = 1250;
      c.solver.preRoll = 7;
      c.solver.bounds.size = { x: R(w * 1.3), y: R(h * 1.3), z: 1400 };
      // Pinned: this field was tuned against wrap, and at 6 px/s the teleport is
      // invisible while the box staying full is the whole look. The DEFAULT is
      // kill (schema.js) — an ambient preset opting out of it says so here.
      c.solver.bounds.behavior = 'wrap';
      Object.assign(c.emitters[0], {
        shape: 'box',
        size: { x: R(w * 1.25), y: R(h * 1.25), z: 1300 },
        rate: 150,
        lifetime: { value: 7, random: 2 },
        speed: { value: 6, random: 4 },
        spread: 180,
      });
      c.forces.wind = { x: 3, y: 0, z: 0 };
      c.forces.drag = 0.2;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 5, scale: 0.002, speed: 0.12 };
      Object.assign(c.render, {
        sprite: 'star',
        blend: 'additive',
        twinkle: 0.85,
        size: { start: 15, end: 13, random: 0.75 },
        colorOverLife: [
          { at: 0, color: '#9fd4ff00' },
          { at: 0.18, color: '#cfe9ffdd' },
          { at: 0.62, color: '#ffffffff' },
          { at: 1, color: '#8fbcff00' },
        ],
      });
      return c;
    },
  },

  {
    id: 'snow',
    name: 'Snow',
    hint: 'Wind-blown snowfall with depth',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'snow';
      c.seed = 55521;
      c.solver.maxParticles = 2000;
      c.solver.preRoll = 7;
      c.solver.bounds = {
        shape: 'box',
        size: { x: R(w * 1.3), y: R(h * 1.5), z: 1100 },
        behavior: 'wrap',
      };
      Object.assign(c.emitters[0], {
        shape: 'box',
        size: { x: R(w * 1.25), y: R(h * 1.4), z: 1000 },
        rate: 240,
        lifetime: { value: 7, random: 2 },
        speed: { value: 10, random: 8 },
        spread: 180,
      });
      c.forces.gravity = { x: 0, y: -70, z: 0 };
      c.forces.wind = { x: 34, y: 0, z: 0 };
      c.forces.drag = 1.5;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 42, scale: 0.004, speed: 0.5 };
      Object.assign(c.render, {
        sprite: 'soft-disc',
        blend: 'alpha',
        twinkle: 0.25,
        size: { start: 13, end: 11, random: 0.7 },
        colorOverLife: [
          { at: 0, color: '#ffffff00' },
          { at: 0.12, color: '#f2f9ffee' },
          { at: 0.8, color: '#dceaffcc' },
          { at: 1, color: '#ffffff00' },
        ],
      });
      return c;
    },
  },

  {
    id: 'sparks',
    name: 'Sparks',
    hint: 'Fountain of stretched embers',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'sparks';
      c.seed = 903117;
      c.solver.maxParticles = 900;
      // One lifetime, so the fountain is already running when the layer starts.
      // With no pre-roll the first frame holds four particles and reads as broken.
      c.solver.preRoll = 1.6;
      c.solver.bounds = {
        shape: 'box',
        size: { x: R(w * 1.4), y: R(h * 1.6), z: 1000 },
        behavior: 'kill',
      };
      Object.assign(c.emitters[0], {
        shape: 'point',
        position: { x: 0, y: -R(h * 0.12), z: 0 },
        size: { x: 10, y: 10, z: 10 },
        rate: 260,
        lifetime: { value: 1.6, random: 0.6 },
        speed: { value: 620, random: 260 },
        direction: { x: 0, y: 1, z: 0 },
        spread: 62,
      });
      c.forces.gravity = { x: 0, y: -620, z: 0 };
      c.forces.wind = { x: 8, y: 0, z: 0 };
      c.forces.drag = 0.75;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 60, scale: 0.005, speed: 1.1 };
      Object.assign(c.render, {
        sprite: 'spark',
        blend: 'additive',
        twinkle: 0.5,
        stretch: 0.05,
        onKill: { fade: 0.25, scale: 0.7 },
        size: { start: 26, end: 9, random: 0.5 },
        colorOverLife: [
          { at: 0, color: '#fffbe600' },
          { at: 0.06, color: '#fff6d0ff' },
          { at: 0.4, color: '#ffb648dd' },
          { at: 1, color: '#7a2a0000' },
        ],
      });
      return c;
    },
  },

  {
    id: 'bokeh',
    name: 'Bokeh',
    hint: 'A handful of huge out-of-focus lights drifting through frame',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'bokeh';
      c.seed = 128884;
      // A COUNT, not a rate: six discs this big are the whole picture, and one
      // more would cover the frame. Static emission fills them at t = 0 and the
      // 100 s lifetime keeps them for any clip length.
      c.solver.maxParticles = 6;
      c.solver.preRoll = 0;
      c.solver.bounds.size = { x: R(w * 1.3), y: R(h * 1.3), z: 1600 };
      // Bounce, not wrap: a disc wider than the frame cannot teleport across an
      // edge without the whole picture jumping.
      c.solver.bounds.behavior = 'bounce';
      Object.assign(c.emitters[0], {
        emit: 'static',
        shape: 'box',
        size: { x: R(w * 1.2), y: R(h * 1.2), z: 1500 },
        rate: 1,
        bursts: [{ time: 0, count: 4 }],
        lifetime: { value: 100, random: 3 },
        speed: { value: 30, random: 10 },
        spread: 180,
      });
      c.forces.wind = { x: 10, y: 4, z: 0 };
      c.forces.drag = 0.4;
      // Strong, slow, billowing turbulence is what makes them wander rather than
      // slide — at this size the drift IS the animation.
      c.forces.turbulence = { ...c.forces.turbulence, strength: 102, scale: 0.002, speed: 0.2, pattern: 'billow', complexity: 3 };
      Object.assign(c.render, {
        sprite: 'soft-disc',
        blend: 'additive',
        opacity: 1,
        // No twinkle: at this scale a pulse reads as the whole frame blinking.
        twinkle: 0,
        stretch: 0,
        // Wider than the frame on purpose — that is what out of focus looks like.
        size: { start: RK(w, h, 2590), end: RK(w, h, 1517), random: 0.4 },
        colorOverLife: [
          { at: 0.25, color: '#ffd0a035' },
          { at: 0.7, color: '#9fd8ff47' },
        ],
      });
      return c;
    },
  },

  // ── v3: the fluid presets, tuned in html/fluid-particles-lab.html ──────────
  // Every one of these turns the fluid field ON; the ones above leave it off and
  // are byte-identical to what they were before v3.

  {
    id: 'smoke',
    name: 'Rising Smoke',
    hint: 'Buoyant smoke on a fluid grid — it hits its own eddies',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'smoke';
      c.seed = 184729;
      c.solver.maxParticles = 4000;
      /*
       * RISING SMOKE IS ALREADY RISING WHEN THE CLIP STARTS.
       *
       * With no pre-roll this preset holds fifteen particles on the first frame
       * against roughly 2,700 three seconds later: the layer reads as empty for
       * the first second and then a column grows into frame, which is not what
       * "Rising Smoke" is a picture of. 2.5 s is one buoyant rise-time for this
       * emitter (lifetime 4 +/- 1.4, speed 180), so frame 0 opens on an
       * established plume with its own eddies already in the medium.
       *
       * 1.5 s rather than a full lifetime: pre-roll on a FLUID preset is not
       * free the way it is on dust or snow — every pre-rolled step is a whole
       * grid solve, so a 4 s pre-roll here quadrupled the bake. 1.5 s is about
       * 1,350 particles at frame 0 against 2,700 at three seconds, which is an
       * established plume rather than a growing one.
       */
      c.solver.preRoll = 1.5;
      c.solver.bounds.size = { x: R(w), y: R(h), z: 480 };
      Object.assign(c.emitters[0], {
        shape: 'sphere',
        position: { x: 0, y: -R(h * 0.37), z: 0 },
        size: { x: 52, y: 52, z: 52 },
        rate: 900,
        lifetime: { value: 4, random: 1.4 },
        speed: { value: 180, random: 45 },
        direction: { x: 0, y: 1, z: 0 },
        spread: 35,
        variance: 0.35,
        stir: { strength: 80, radius: RK(w, h, 120) },
      });
      c.forces.wind = { x: 0, y: 0, z: 0 };
      c.forces.drag = 0;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 0 };
      c.forces.fluid = { ...c.forces.fluid, model: 'smoke', force: 200, viscosity: 6, swirl: 80, fidelity: 'medium' };
      c.forces.draft = { strength: 30, direction: 15, gust: 0.7 };
      Object.assign(c.render, {
        sprite: 'soft-disc',
        blend: 'alpha',
        opacity: 0.85,
        twinkle: 0,
        size: { start: 14, end: 8, random: 0.4 },
        colorOverLife: [
          { at: 0, color: '#ffffff00' },
          { at: 0.14, color: '#e8e8e89e' },
          { at: 0.5, color: '#b9b9b980' },
          { at: 0.85, color: '#8a8a8a38' },
          { at: 1, color: '#78787800' },
        ],
      });
      return c;
    },
  },

  {
    id: 'cigarette',
    name: 'Cigarette',
    hint: 'A thin laminar column buckling into sheets as it climbs',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'cigarette';
      c.seed = 90211;
      // The sprites ARE the smoke here, so the count has to carry the volume:
      // this used to be 1500 stirrers under a baked density card, and without
      // that card 1500 of anything is a handful of dots. A thin column is also the
      // cheapest thing to fill — the particles stay inside a narrow ribbon.
      c.solver.maxParticles = 24000;
      // The column has to be ALREADY SMOKING at t=0 — you cut to a cigarette
      // mid-smoke, not to a bare filter. At this rate and lifetime it fills in
      // about three seconds, so the pre-roll buys roughly half of that.
      c.solver.preRoll = 1.6;
      c.solver.bounds.size = { x: R(w), y: R(h), z: 480 };
      Object.assign(c.emitters[0], {
        shape: 'sphere',
        position: { x: 0, y: -R(h * 0.37), z: 0 },
        size: { x: 5, y: 5, z: 5 },
        rate: 6400,
        lifetime: { value: 3.2, random: 0.9 },
        speed: { value: 120, random: 30 },
        direction: { x: 0, y: 1, z: 0 },
        spread: 3,
        variance: 0.55,
        stir: { strength: 90, radius: RK(w, h, 35) },
      });
      c.forces.wind = { x: 0, y: 0, z: 0 };
      c.forces.drag = 0;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 0 };
      c.forces.fluid = {
        ...c.forces.fluid,
        // A 3D grid now that nothing needs in-plane texel budget: the column is
        // seen in the round and 'flat-hd' spent its cells on a plane.
        model: 'smoke', force: 200, viscosity: 2, swirl: 45, swirlSize: 2, fidelity: 'high',
        pressureSteps: 26, fade: 0.04, bounds: 'open',
        smoke: { buoyancy: 260, weight: 30, heat: 55, cooling: 0.7, dissipate: 0.25 },
      };
      Object.assign(c.render, {
        sprite: 'soft-disc',
        blend: 'additive',
        // Low per-sprite opacity, many sprites: the sheets come from where the
        // flow folds them together, not from any one dot.
        opacity: 0.5,
        twinkle: 0,
        size: { start: 6, end: 18, random: 0.6 },
        colorOverLife: [
          { at: 0, color: '#ffffff00' },
          { at: 0.12, color: '#f2f6ff5c' },
          { at: 0.55, color: '#cdd6e83d' },
          { at: 0.85, color: '#98a3b81c' },
          { at: 1, color: '#7c869800' },
        ],
      });
      return c;
    },
  },

  {
    id: 'ink',
    name: 'Ink Drop',
    hint: 'Ink falling into still water — the pressure solve mushrooms it',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'ink';
      c.seed = 33107;
      c.solver.maxParticles = 3000;
      c.solver.preRoll = 0;
      c.solver.bounds.size = { x: R(w), y: R(h), z: 480 };
      Object.assign(c.emitters[0], {
        shape: 'sphere',
        position: { x: 0, y: R(h * 0.3), z: 0 },
        size: { x: 52, y: 52, z: 52 },
        rate: 260,
        lifetime: { value: 8, random: 2.5 },
        speed: { value: 420, random: 100 },
        direction: { x: 0, y: -1, z: 0 },
        spread: 12,
        variance: 0.3,
        stir: { strength: 160, radius: RK(w, h, 120) },
      });
      c.forces.gravity = { x: 0, y: -60, z: 0 };
      c.forces.wind = { x: 0, y: 0, z: 0 };
      c.forces.drag = 0;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 0 };
      c.forces.fluid = { ...c.forces.fluid, model: 'fluid', force: 320, viscosity: 10, swirl: 30, fidelity: 'high' };
      Object.assign(c.render, {
        sprite: 'soft-disc',
        blend: 'alpha',
        opacity: 0.7,
        twinkle: 0,
        size: { start: 18, end: 25, random: 0.4 },
        colorOverLife: [
          { at: 0, color: '#bfe9ff00' },
          { at: 0.1, color: '#7fd4ffe0' },
          { at: 0.55, color: '#2e7fd8b3' },
          { at: 1, color: '#12325e00' },
        ],
      });
      return c;
    },
  },

  {
    id: 'ember',
    name: 'Ember Swirl',
    hint: 'Vorticity confinement as the subject — additive embers',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'ember';
      c.seed = 77123;
      c.solver.maxParticles = 6000;
      /*
       * The swirl has to be ALREADY SWIRLING on frame 0 — 26 embers against
       * 4,400 three seconds later reads as the layer failing to start rather
       * than as a fire catching. Kept short because pre-roll on a fluid preset
       * costs a whole grid solve per step (see Rising Smoke): 1.2 s is roughly
       * 1,900 embers with the vorticity already established in the medium.
       */
      c.solver.preRoll = 1.2;
      c.solver.bounds.size = { x: R(w), y: R(h), z: 480 };
      Object.assign(c.emitters[0], {
        shape: 'sphere',
        position: { x: 0, y: -R(h * 0.2), z: 0 },
        size: { x: 52, y: 52, z: 52 },
        rate: 1600,
        lifetime: { value: 3, random: 1 },
        speed: { value: 300, random: 75 },
        direction: { x: 0, y: 1, z: 0 },
        spread: 60,
        variance: 0.35,
        stir: { strength: 80, radius: RK(w, h, 120) },
      });
      c.forces.wind = { x: 0, y: 0, z: 0 };
      c.forces.drag = 0;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 0 };
      c.forces.vortex = { strength: 230, scale: RK(w, h, 422), mode: 'vortex', axis: 'z', lift: 0.15 };
      c.forces.fluid = { ...c.forces.fluid, model: 'fluid', force: 150, swirl: 170, swirlSize: 2, fidelity: 'medium' };
      Object.assign(c.render, {
        sprite: 'soft-disc',
        blend: 'additive',
        opacity: 0.85,
        twinkle: 0,
        stretch: 0.3,
        size: { start: 8, end: 2, random: 0.4 },
        colorOverLife: [
          { at: 0, color: '#fff7d800' },
          { at: 0.1, color: '#ffd27aff' },
          { at: 0.42, color: '#ff7a2ed9' },
          { at: 0.78, color: '#7a1e0c66' },
          { at: 1, color: '#40100a00' },
        ],
      });
      return c;
    },
  },

  {
    id: 'shockwave',
    name: 'Shockwave',
    hint: 'A blast every 1.5 s — a ring bursts outward, punches the fluid and dies down in the wake',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'shockwave';
      c.seed = 51377;
      c.solver.maxParticles = 9000;
      c.solver.preRoll = 0;
      c.solver.bounds.size = { x: R(w), y: R(h), z: 300 };
      Object.assign(c.emitters[0], {
        emit: 'continuous',
        shape: 'ring',
        position: { x: 0, y: 0, z: 0 },
        ring: { radius: RK(w, h, 38), thickness: 12 },
        dirMode: 'outward',
        size: { x: RK(w, h, 77), y: RK(w, h, 77), z: 24 },
        rate: 0,
        // The pulses: a blast at 0 s and every 1.5 s after it.
        bursts: [{ time: 0, count: 2200 }, { time: 1.5, count: 2200 }, { time: 3, count: 2200 }, { time: 4.5, count: 2200 }],
        lifetime: { value: 1.4, random: 0.5 },
        speed: { value: 1500, random: 350 },
        direction: { x: 0, y: 1, z: 0 },
        spread: 8,
        variance: 0.2,
        // The burst is what stirs the field: each front punches it outward, and
        // the wake is what the slowing particles ride.
        stir: { strength: 100, radius: RK(w, h, 96) },
        detach: false,
      });
      c.forces.gravity = { x: 0, y: 0, z: 0 };
      c.forces.wind = { x: 0, y: 0, z: 0 };
      // Drag is the shockwave: violent at the front, dying off across the frame.
      c.forces.drag = 2.6;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 0 };
      c.forces.fluid = { ...c.forces.fluid, model: 'fluid', force: 60, swirl: 90, swirlSize: 2, fidelity: 'medium' };
      Object.assign(c.render, {
        sprite: 'spark',
        blend: 'additive',
        opacity: 0.95,
        twinkle: 0,
        stretch: 0.5,
        size: { start: 7, end: 1.5, random: 0.5 },
        colorOverLife: [
          { at: 0, color: '#ffffffff' },
          { at: 0.15, color: '#ffe1a3ff' },
          { at: 0.45, color: '#ff8a3ad9' },
          { at: 0.8, color: '#8a2a14aa' },
          { at: 1, color: '#3a100a00' },
        ],
      });
      return c;
    },
  },

  /*
   * SMOKE THROUGH LINES — ready-made lines bent by a plume (html/particle-trails-lab).
   *
   * Four pieces, each an ordinary setting: a ROWS emitter (the grid of tracers,
   * whole from frame 0), a smoke SOURCE under the centre (the only thing moving
   * the medium — rows never stir it), RETURN (so a row bulges where the plume
   * passes and settles behind it instead of being carried off the top of the
   * frame) and LINES connected along the rows, coloured by how far each point
   * has moved. Fluid detail is Medium: the grid is the whole bake cost, and the
   * row count barely matters next to it.
   */
  {
    id: 'smoke-lines',
    name: 'Smoke Lines',
    hint: '100 ready-made lines; a smoke plume rises through the middle and bends them',
    make: (w, h) => {
      const c = particleSystemDefaults(w, h);
      c.preset = 'smoke-lines';
      c.seed = 7;
      c.solver.preRoll = 0;
      // Bounce, not kill: a point that left the box would break its line.
      c.solver.bounds = { shape: 'box', size: { x: R(w * 1.2), y: R(h * 1.2), z: 240 }, behavior: 'bounce' };
      Object.assign(c.emitters[0], {
        emit: 'static',
        shape: 'rows',
        position: { x: 0, y: 0, z: 0 },
        size: { x: R(w), y: R(h * 0.9), z: 0 },
        rows: { count: 100, points: 160 },
        detach: true,
        stir: { strength: 0, radius: RK(w, h, 120) },
        variance: 0,
      });
      c.solver.maxParticles = 100 * 160;
      c.forces.gravity = { x: 0, y: 0, z: 0 };
      c.forces.wind = { x: 0, y: 0, z: 0 };
      c.forces.drag = 0;
      c.forces.turbulence = { ...c.forces.turbulence, strength: 0 };
      c.forces.fluid = {
        ...c.forces.fluid, model: 'smoke', force: 400, swirl: 80, viscosity: 4,
        fidelity: 'medium', bounds: 'open', reach: 'box',
        smoke: { ...c.forces.fluid.smoke, buoyancy: 300 },
      };
      c.forces.return = { strength: 2.5 };
      c.forceEmitters = [{
        id: 'force-1', kind: 'smoke', spin: 'ccw',
        position: { x: 0, y: -R(h * 0.42), z: 0 },
        radius: RK(w, h, 90), strength: 60, density: 2.2, heat: 70,
        pulseStart: 0, pulseEvery: 1.5, mode: 'vortex', lift: 0.5,
        push: 140, direction: 90, motion: 'hold', motionSpeed: 0.6, motionRadius: RK(w, h, 280),
        spinDrag: true,
      }];
      Object.assign(c.render, {
        mode: 'lines',
        blend: 'alpha',
        opacity: 1,
        lines: {
          ...c.render.lines,
          connect: 'rows',
          width: 1.2,
          widthRandom: 0,
          taperStart: 0,
          taperEnd: 0,
          pinEnds: 0.15,
          smooth: 2,
          colorMode: 'moved',
          colorStart: '#e6eceeff',
          colorEnd: '#ff6a3dff',
          movedRange: 160,
        },
      });
      return c;
    },
  },
];

export const DEFAULT_PARTICLE_PRESET = 'dust';

export function getParticlePreset(id) {
  return PARTICLE_PRESETS.find((p) => p.id === id) || null;
}

/** A complete, materialised system for `id`, sized to the composition. */
export function makeParticleSystem(id, compW, compH) {
  const preset = getParticlePreset(id) || PARTICLE_PRESETS[0];
  return preset.make(compW, compH);
}

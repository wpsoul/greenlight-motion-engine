> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Particle layers, fluid physics and emission

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Particle layers (`mediaType: "particles"`) — a simulated Solver Box filmed by the project camera](video-particles.md#particle-layers-mediatype-particles--a-simulated-solver-box-filmed-by-the-project-camera)

### Particle layers (`mediaType: "particles"`) — a simulated Solver Box filmed by the project camera

A particle clip carries no media. Its **item** owns a whole `particleSystem` — a seeded simulation of up to 8,000,000 particles inside a **Solver Box**, drawn as instanced billboards and filmed by the same camera as 3D models and the rig.

Two engines run these, chosen automatically per layer and never by the author:

- **Baked (Tier 1)** at or below 50,000, and at any count for a system using a
  feature the GPU engine does not implement — Grow Points, particle objects,
  colour taken at birth from a video source, collision or a container, Layer
  Velocity, force emitters, Path Follow, or `solver.engine: "baked"`. Off-thread,
  cached, scrubs backwards for free.
- **GPU (Tier 2)** above 50,000 on a machine with WebGPU. The system emits,
  simulates and draws entirely on the graphics card and is **never baked** — so
  `maxParticles` above the bake's ceiling is a real number of particles, not a
  clamped one. It re-simulates on a backward scrub rather than reading a cache.

The count is a **ceiling, not a request**: a system emitting 260/s with a 5 s
lifetime holds about 1,300 at once whatever the ceiling says, and the baked
solver now sizes itself to what the emitter can actually reach. Raising the
number "to be safe" costs nothing. Use it for dust / snow / sparks / bokeh ambience, and for **dissolving an image, text or shape layer into its own pixels**.

**Route "add falling snow", "dust motes", "sparks", "make the logo dissolve/disintegrate into particles" here.**

Rules:

- Clip is synthetic (`"url": ""`), default duration 6 s. The system lives on the **item** as `particleSystem`; the clip carries nothing but identity.
- Put it on its **own free channel** (`"unsnapped": true`) and place it with `freeStart`. It is **not** a singleton (a project may hold several) and its channel has no `kind` — ordinary z-order applies.
- **Only `emitters[0]` is simulated.** The array is capped at 8 for future use; anything after the first is ignored by the solver and by the inspector.
- **`preset` is metadata, not a reference.** Writing `"preset": "snow"` does **not** produce snow — the app materialises a complete system when the user clicks a preset. Author the actual values (start from the table below, or copy the preset numbers from `frontend/src/sim/particles/presets.js`).
- Everything is passed through a bounded, version-aware sanitizer (`sanitizeParticleSystem` in `frontend/src/sim/particles/schema.js`): missing fields fall back to the Dust defaults, out-of-range numbers clamp, unknown enum values revert. A partial system is therefore safe to write, but it will be Dust plus your overrides — not the preset you named.
- **Write `"schemaVersion": 4`.** A system with no `schemaVersion` is treated as version 1 and keeps `forces.turbulence.pattern: "smooth"` (the pre-v2 field), not the current `"billow"` default. Older payloads stay valid: every block added since defaults to OFF (`forces.fluid`, `forces.draft`, `forceEmitters`, `pathFollow`, `collision`, `render.dye`, `proximity`), so an earlier payload bakes exactly as it did. `packing` is the same: while `packing.enabled` is false it contributes nothing to the simulation identity and `render.size` stays a look-only field.
- **Solver values are NOT keyframable.** The item's own Position/Rotation/Scale keyframes move the whole box, but there is no `pt:`/`ptc:` property path for wind, rate, turbulence or anything else in the system — those hold one value for the clip. If asked to "animate the wind", say so rather than emitting a track that will be dropped.
- **Deterministic bake.** The whole clip is simulated once at a fixed 1/60 s step from `seed` and sampled by absolute clip-local time, so preview, Download, a **Time range** render and `/render-onserver` all agree, and export motion blur samples real motion.
- Rendered by **`/render-onserver`** and the desktop render (the export waits for the bake before frame one). The fast `/render` ignores particle layers like every other non-trivial type.
- `quality.previewFraction` (the panel's **Density**) draws a stable seeded subset while editing — but it is stored on the item and is read at render time too, so leave it at `1` unless the user explicitly wants a thinner system.

```json
{
  "clips": [
    { "id": "prt1", "source": "LOCAL", "mediaType": "particles", "url": "", "proxyUrl": null,
      "name": "Snow Solver", "duration": 6 }
  ],
  "channels": [
    { "id": "ch-prt", "name": "Snow Solver", "visible": true, "unsnapped": true,
      "items": [
        { "id": "prtitem1", "clipId": "prt1", "trimStart": 0, "trimEnd": 6, "freeStart": 0,
          "particleSystem": {
            "schemaVersion": 2,
            "preset": "snow",
            "seed": 55521,
            "solver": { "cacheHz": 30, "maxParticles": 2000, "preRoll": 7, "space": "local",
              "bounds": { "shape": "box", "size": { "x": 2496, "y": 1620, "z": 1100 }, "behavior": "wrap" } },
            "emitters": [
              { "id": "emitter-1", "emit": "continuous", "shape": "box",
                "position": { "x": 0, "y": 0, "z": 0 },
                "size": { "x": 2400, "y": 1512, "z": 1000 },
                "rate": 240, "bursts": [{ "time": 0, "count": 0 }], "start": 0, "end": 9999,
                "lifetime": { "value": 7, "random": 2 }, "speed": { "value": 10, "random": 8 },
                "direction": { "x": 0, "y": 1, "z": 0 }, "spread": 180 }
            ],
            "forces": {
              "gravity": { "x": 0, "y": -70, "z": 0 }, "wind": { "x": 34, "y": 0, "z": 0 }, "drag": 1.5,
              "turbulence": { "strength": 42, "scale": 0.004, "speed": 0.5, "pattern": "billow", "complexity": 3, "direction": 0 },
              "vortex": { "strength": 0, "scale": 700, "mode": "vortex", "axis": "y", "lift": 0.5 }
            },
            "activation": { "mode": "immediate", "inactive": "frozen" },
            "render": {
              "mode": "sprite", "sprite": "soft-disc", "blend": "alpha", "opacity": 1,
              "size": { "start": 13, "end": 11, "random": 0.7 },
              "colorOverLife": [
                { "at": 0, "color": "#ffffff00" }, { "at": 0.12, "color": "#f2f9ffee" },
                { "at": 0.8, "color": "#dceaffcc" }, { "at": 1, "color": "#ffffff00" }
              ],
              "twinkle": 0.25, "stretch": 0, "colorMode": "age", "onKill": { "fade": 0, "scale": 0 }
            },
            "objects": { "members": [], "pick": "cycle", "facing": "billboard", "size": 90, "sizeRandom": 0.35, "spin": 1, "keepRatio": true, "tint": false },
            "quality": { "previewFraction": 1 }
          } }
      ] }
  ]
}
```

**`solver`** — the box the particles live in. Its transform *is* the layer's, so moving/rotating/scaling/parenting the item moves the whole volume; V1 simulates in local space (`space` is always `"local"`), so particles travel with it. The box is centred on the layer's position (`panX`/`panY`/`panZ` and the PRS keyframes) in the same world as every other layer and is filmed once by the project camera, so a solver given a Shape's exact transform fills that Shape's rect under any camera — pan, zoom, roll, tilt, dolly, keyed moves and a Blender picture-plane world thousands of px down a page alike (versions up to 15.0.21 drew an off-centre solver at twice its offset, often out of frame under a moving camera). A camera-locked channel keeps it in frame space. To snow onto a rect, size `bounds.size`/the emitter to the rect and put the layer at its centre.

| Field | Range | Meaning |
| --- | --- | --- |
| `maxParticles` | 1–8000000 | Hard cap. At the cap emission **throttles** (new spawns skipped); a live particle is never cut short. Keep `≥ rate × lifetime` or the system silently runs thinner than authored. Above 50,000 the layer runs on the GPU engine (see above) unless it uses a baked-only feature. |
| `preRoll` | 0–30 s | Simulated before the clip starts so the box is populated at frame 0. Ambient looks want ~one full lifetime; a dissolve wants `0`. |
| `bounds.size` | px vec3 | Box width/height/depth, in composition pixels. |
| `bounds.behavior` | `kill` \| `wrap` \| `bounce` | `wrap` is a teleport (never interpolated across); `bounce` reflects keeping ~60% of speed and stays continuous. |
| `cacheHz` | fixed `30` | Snapshot rate. Forced by the sanitizer. |
| `engine` | `auto` (default) · `live` · `baked` | How the EDITOR previews the system — not a simulation input and never part of a render. `auto` reads the bake whenever it is complete for the current settings (smooth scrubbing) and draws the solver live on WebGPU in the gap after an edit, while the bake re-runs in the background — falling back to the bake outright when the live step cannot hold 60 fps; `live` always simulates live; `baked` always shows the bake. Exports and `/render-onserver` always use the bake. Omit it. |

**`emitters[0]`** — where particles are born.

| Field | Range | Meaning |
| --- | --- | --- |
| `emit` | `continuous` \| `static` | `static` fills the system to the cap once and never emits again (rate and bursts ignored) — the right mode for a shatter/dissolve or anything Particle Activation releases. |
| `shape` | `point` \| `box` \| `sphere` \| `cone` \| `ring` \| `path` \| `block` \| `layer` \| `rows` | `layer` fires from a picture's opaque pixels — see below. With `render.colorMode: "source"` and a VIDEO source, `render.colorSourceTime` decides when each colour is read: `"live"` (default) re-reads the frame playing now, so the cloud is the moving picture; `"birth"` keeps the colour each particle was emitted with and lets the video move on without it. Either way the emission SITES stay from the one snapshot they were picked in, so nothing re-simulates and neither value is in the sim hash. v3: `ring` is an annulus in the comp plane (`ring: {radius, thickness}` px), `path` births evenly along a spline (`path.anchors` in the emitter's unit space, −0.5..0.5), `block` is a filled slab — the "layer of particles" source (pair it with `emit: "static"`). `rows` is a grid of **ready-made lines** — see [Lines](#lines-rendermode-lines--trails-and-ready-made-lines). |
| `dirMode` | `cone` \| `outward` \| `tangent` | v3, `ring`/`path` only: launch along `direction`+`spread`, away from the ring / normal to the path, or along it. |
| `distribution` | `{mode, jitter, order, sites, rings, clusters, tightness, bias, thickness, sequence, relaxIters}` | **How spawn sites are SPREAD inside the emitter's shape** — orthogonal to the geometry, so `box`, `sphere`, `cone`, `ring`, `path` and `block` all get every mode (`layer` and `point` do not use it; see below). Omit the block (or `mode: "random"`) for the emitter's original three independent draws; that is the default and is byte-identical to a system authored without it. See the table below. |
| `variance` | 0–1 | v3, with the fluid on: wobble of emission direction/strength/heat on smooth time noise. `0` is a perfectly steady source, which reads as a uniform carpet of curls; ~0.35 gives billows at every scale. |
| `stir` / `detach` | `{strength 0–200, radius px}` / bool | v3: how hard emission stirs the fluid; `detach: true` makes emission deposit material only and hands the field's momentum to `forceEmitters`; `stir.strength: 0` then makes the emitter deposit nothing at all, which is how you get a layer whose only smoke comes from `kind: "smoke"` force emitters. |
| `position` / `size` | px vec3 | Placement and extent inside the box (`size.x` is the diameter for `sphere`/`cone`). |
| `rate` | 0–20000 /s | Continuous emission. |
| `bursts` | ≤8 × `{time, count}` | One-shot pops on top of the rate. This is how a shockwave / explosion / puff is built: a burst emits its whole count in one frame, `speed` throws the front outward (with `shape: "ring"` + `dirMode: "outward"` for a ring blast) and `forces.drag` is what makes it slam to a halt. Several entries = several pulses; ignored when `emit: "static"`. |
| `start` / `end` | s | Emission window inside the clip. |
| `lifetime` | `{value 0.05–600, random}` | Seconds, ± per particle. |
| `speed` | `{value, random}` | Launch speed in composition px/s. |
| `direction` / `spread` | vec3 / 0–180° | Aim, and the cone around it (180 = every direction). |

**`forces`** — a keyed block, not a list (`pt:forces.wind.x` is reserved as a future keyframe path). `gravity` and `wind` are accelerations in composition px/s²; `drag` bleeds speed away. `return: { strength }` (0–60 per second, default 0 = off) pulls every particle back toward the point it was born at: each step closes `1 − e^(−strength·dt)` of the gap after the particle moves, so in a flow of speed `v` it settles about `v / strength` px from home — lines bulge where smoke passes and relax behind it, and particles that formed a shape re-form after a gust. It is a simulation input.

| Field | Range | Meaning |
| --- | --- | --- |
| `turbulence.pattern` | `smooth` \| `billow` \| `ridged` \| `swirl` \| `wave` | Gain-matched, so switching keeps the amount of motion and changes only its character — do not re-tune `strength`. |
| `turbulence.strength` / `.scale` / `.speed` | 0–20000 / 1e-5–1 / 0–20 | Amount, pattern size in comp px (smaller = finer), and how fast the field itself evolves (`0` freezes it). |
| `turbulence.complexity` / `.direction` | 1–6 / 0–360° | Octaves; wavefront heading (`wave` only). |
| `vortex.mode` | `vortex` \| `orbit` \| `twist` \| `attract` \| `repel` | Second field's shape. |
| `vortex.strength` / `.axis` / `.scale` / `.lift` | 0–20000 / `x`\|`y`\|`z` / 1–100000 / 0–4 | `scale` is a falloff radius, not a boundary; `lift` sends part of the pull along the axis. |

#### Emission distribution (`emitters[0].distribution`)

`mode` chooses the sampler. The difference that matters when picking one is whether it needs to know how many sites there are: a lattice cannot be built without that number, and an emitter never knows how many particles it will ultimately make — so a set-based mode fixes a set of `sites` and the next particle lands on the first site again.

| `mode` | What it produces | Extra params |
| --- | --- | --- |
| `random` | Three independent draws per particle. Clumps and holes are not a defect — they are what independence looks like. The default. | — |
| `stratified` | One particle anywhere inside its own lattice cell. Keeps the organic look of `random` but cannot clump across a cell wall. The drop-in upgrade. | `sites`, `jitter` |
| `grid` | Exact cell centres. Perfectly regular and perfectly artificial: a dot matrix, a formation, beads threaded evenly along a path. | `sites` |
| `packed` | Rows offset by half a cell — hexagonal in plane, tetrahedral through depth. The densest arrangement that is still perfectly even, and the one that reads as a solid surface rather than a grid. | `sites` |
| `relaxed` | Dropped at random, then pushed off each other until nothing is clumped — blue noise. Even like a lattice but with no direction and no repeating cell. | `sites`, `relaxIters` |
| `lowdisc` | A quasi-random sequence: looks random, spaces like a lattice, and is even at ANY count without knowing the total. **The one to reach for on a continuously emitting system.** | `sequence`, `jitter` |
| `sunflower` | The golden angle, one turn per particle — the only closed form that fills a disc or sphere perfectly evenly. Fills CENTRE-OUTWARD, which is lovely as a growth and wrong if the shape is meant to be populated at once. | `sites` |
| `rings` | Concentric bands spaced by area, each offset from the last so the spokes never line up. Reads as designed rather than scattered: targets, radar, ripples. | `sites`, `rings` |
| `clustered` | Cluster seeds scattered first, then every particle born near one — clumping as a look. Sparks off an impact, embers, flocks, debris. | `clusters`, `tightness` |
| `falloff` | Random, with density biased along the shape's radial axis — packed into the core, or hollowed out toward the rim. | `bias` |
| `shell` | The skin only: a sphere becomes a bubble, a disc a rim, a box six faces. Every particle at the SAME depth rather than merely crowding near it. | `thickness` |

| Param | Range | Meaning |
| --- | --- | --- |
| `sites` | 0 = auto, else 1–8000000 | How many distinct places the pattern has before it repeats. **Auto tracks `solver.maxParticles`, which is the only value at which nothing doubles up.** Ignored by the modes that do not need it. |
| `jitter` | 0–1 | Softens a lattice back toward organic without giving up its coverage. On `lowdisc` it does something else useful: a per-seed rotation of the whole sequence, so two emitters with the same settings do not spawn in lockstep. |
| `order` | `scan` \| `scramble` (default) \| `shuffle` | The order a set-based mode walks its sites in, which only shows itself while the emitter is still FILLING. `scan` is reading order, so it fills one corner at a time on anything that emits over time; the other two reach the whole shape immediately. |
| `sequence` | `r2` (default) \| `halton` | `lowdisc` only. `r2` is three multiplies and no loop; `halton` is a shade more even but shows a faint lattice in the first few hundred particles. |
| `relaxIters` | 0–40 | `relaxed` only. Past about fifteen the set has converged and more only costs bake time. |
| `rings` | 1–512 | `rings` only: how many concentric bands. |
| `clusters` / `tightness` | 1–4096 / 0.001–0.5 | `clustered` only: how many clumps, and each clump's radius as a fraction of the emitter. Particles landing outside are folded back at the wall rather than clipped — clipping piles them onto the faces and reads as a crust. |
| `bias` | −1…1 | `falloff` only. Negative packs the core, positive hollows it toward the rim. A power on the area CDF, so it is an exact density ramp. |
| `thickness` | 0.002–0.5 | `shell` only: skin depth as a fraction of the shape. Never author `0` — a mathematically thin surface aliases into a flickering wire as the camera moves. |

Distribution is part of the simulation, so changing it re-bakes (a `mode` of `random` contributes nothing to the sim hash, so it is free). It shapes the **volumetric and geometric** emitters — `box`, `sphere`, `cone`, `ring`, `path`, `block` — which all map the sampler's unit-cube point through their own geometry. It does **not** apply to `shape: "layer"`, whose sites come from the artwork's opaque pixels rather than from the sampler, nor to `point`, which has no extent to spread anything across.

#### The fluid field (v3) — fluid and smoke physics, Particular-style

`forces.fluid` turns on a **simulated** force field: an incompressible velocity grid the size of the Solver Box that emission stirs and particles ride. Unlike turbulence (a formula in position and time) it has **memory** — a plume meets the eddies it left behind, smoke curls back on itself, ink mushrooms. It is stepped at 1/60 s with the particles and thrown away after the bake; only particle snapshots are cached. The fluid supplies **movement** — particles carried, swirled and lifted by a medium. It is not rendered itself: there is no volumetric or dye render mode, and particles are always drawn as particles. **Cost:** the grid steps 360× for a 6 s clip — `low` ≈ 4 ms/step, `medium` ≈ 10, `high` ≈ 30, `ultra`/`flat-hd` ≈ 80, `volume-hd` ≈ 250 — so a `flat-hd` preset bakes for ~30 s (in a worker, while the live GPU preview already shows the edit — see **Live preview** below).

**Live preview vs. the bake (10.4.37+).** In the desktop editor the whole solver — field and particles — also runs **live on WebGPU** (`frontend/src/sim/particles/gpuEngine.js`), so a change to any of these controls shows within a frame while the user edits; the bake above re-runs in the background after the edit and, once complete, is what the editor scrubs (any time is one read) and what **exports render**. Live is also the fallback-free path when the bake is not there yet; the bake is the fallback when live is not possible (Smoke Dye and Grow Points are bake-only) or when the live step cannot hold 60 fps on that machine. The bake itself is cancellable, debounced and streams in chunks, so even the fallback appears progressively. None of this changes the JSON: the bake is a pure function of the system and the live engine is only a preview of the same inputs. Route "smoke", "fluid", "ink in water", "cigarette smoke", "steam", "particles flowing like liquid" here. Ready-made presets: `smoke` (Rising Smoke), `cigarette`, `ink`, `ember`, `shockwave` (a ring blast every 1.5 s that punches the fluid). A `text-cage` preset id in older projects is just a label; the system it carries still bakes.

| Field | Range | Meaning |
| --- | --- | --- |
| `fluid.model` | `off` \| `fluid` \| `smoke` | `fluid` = velocity only; `smoke` adds a density/heat pair riding the same field (buoyancy, weight, cooling, dissipation). |
| `fluid.force` | 0–400 | How fast a particle trades its own velocity for the field's. High = a tracer; low = keeps its inertia. |
| `fluid.timeFactor` | 0.1–4 | The field's clock; particles keep real time. |
| `fluid.viscosity` / `.swirl` / `.swirlSize` | 0–100 / 0–200 / 1–6 cells | Thickness of the medium; vorticity confinement (feeds the small eddies back); the eddy size confinement reinforces. |
| `fluid.fidelity` | `low`\|`medium`\|`high`\|`ultra`\|`flat-hd`\|`volume-hd` | Grid resolution (48×27×12 … 192×108×48 at 16:9; the in-plane cell count is kept and laid out at the box's aspect, so a portrait box gets a tall grid, not a stretched one). `flat-hd` spends the budget in-plane for thin columns. |
| `fluid.pressureSteps` / `.fade` / `.sharp` | 4–60 / 0–1 / bool | Jacobi iterations; how fast the field calms; MacCormack advection (livelier, more detail). |
| `fluid.reach` | `box` (default) \| `sources` | Who rides the flow. `box` = every particle in the Solver Box (the field is the whole medium). `sources` = only particles inside a force emitter's `radius`, fading out with distance — the source as a LOCAL force, the rest of the layer keeps its own motion. Needs `emitters[0].detach: true` (the panel's **Driving fluid / smoke by ▸ Force emitters**, which sets both) and at least one entry in `forceEmitters`; ignored otherwise. |
| `fluid.bounds` | `closed` \| `open` | Walls (a plume pools under the top) or outflow (it leaves the box). |
| `fluid.smoke` | `{buoyancy −200–600, weight 0–400, heat 0–100, cooling 0–4, dissipate 0–4}` | Smoke model only. Emission deposits hot dye; heat lifts, weight pulls. |
| `forces.draft` | `{strength 0–300, direction 0–360°, gust 0–1}` | A gusting wind on the field. Its variation is in time only, so it reads as weather, never as a pattern. |
| `forceEmitters[]` | ≤3 × `{id, kind jet\|vortex\|smoke\|burst, mode vortex\|orbit\|twist\|attract\|repel, lift, pulseStart, pulseEvery, position, radius, strength 0–300, push px/s, direction °, spin ccw\|cw, density 0–8, heat 0–100, motion hold\|orbit\|sweep, motionSpeed, motionRadius}` | Forces placed in the box, with no particles of their own. `kind: "jet"` is a **Blower** in the UI — a fan: everything inside `radius` is blended toward `push` px/s along `direction` (0° = right, 90° = up) at a rate set by `strength`; `kind: "vortex"` is a whirlpool (`spin`). With `forces.fluid` on they drive the field and the particles ride it (the emitter's own stir keeps working unless `emitters[0].detach`); with the field off blowers and vortices act on the particles directly. `kind: "smoke"` is a **source**, not a push: it injects material (`density` per second, at `heat`) into the field at its point, so a layer can have several plumes coming from places you choose rather than one from the emitter — it needs `forces.fluid.model: "smoke"`, and `strength: 0` makes it pure material lifted by buoyancy. `kind: "burst"` is a **pulse force**: a radial blast from its point at `pulseStart`, repeating every `pulseEvery` seconds (0 = once), throwing what is inside `radius` outward at `push` px/s — a shockwave with no particles of its own. A `vortex`-kind emitter takes any of the five `forces.vortex` `mode`s, centred on itself. |
| `pathFollow` | `{enabled, attract 0–600, flow 0–600, proximity px, swirl 0–400, anchors[]}` | Particular's "move along path": attract toward the spline, flow along its tangent, braid around it, falling off past `proximity`. `anchors` are in the box's unit space; empty = the emitter's own `path`. |
| `collision` | `{source, faces outer\|inner, bounce 0–1, depth px, size px, position {x,y}}` | A layer's artwork (same `source` snapshot as a particle object) as a signed-distance collider extruded `depth` px. `outer` = obstacle (particles bounce, the flow routes around it); `inner` = container (emission is clipped to it, particles stay inside). A text source gives "particles inside letters". **`follow`** (default false, needs `fromItemId`) makes the collider track that layer's live ARTWORK and its position, scale and rotation every step — keyframes and parenting included — and turns `size`/`position`/`rotation` into the FALLBACK for a source that has been deleted. It also follows the layer's place on the TIMELINE: outside that clip's span, or while its channel is hidden, there is no collider at all (particles pass through and a container stops holding them). Without it the collider stands wherever `size`/`position` put it whatever the layer does, and those are filled in only at pick time. Two limits while following: a moving collider re-simulates every time its pose changes, and it steers the PARTICLES only — the fluid field's obstacle mask is a fixed grid over the Solver Box, so the flow passes straight through. **`releaseOutside`** (default false, container only) stops the container gathering particles that are already outside it — turn it on when the collider arrives part-way through a shot, or it inhales the cloud around it. **`open`** `{side none\|top\|bottom\|left\|right, spread 1–180°, at s, fade s}` (container only) lets particles OUT through one side at a chosen time — `at` is when it starts, `fade` how long it takes to open, `spread` how much of that wall becomes a doorway. It gates on the contact NORMAL, so `bottom` opens the floor of every stroke of a letter rather than cutting the shape in half, and what leaves stays out; sides are the FRAME's, so `bottom` is the bottom of the screen even under a rotating source. `side: 'none'` contributes nothing to the sim hash. Authoring note: the fixed collider's SDF is a 384x216 grid scaled from the box WIDTH, so keep `solver.bounds.size` near 16:9 or the field is distorted along the short axis. |
| `colliders[]` | up to **3** more, each the SAME shape as `collision` | The colliders past the first. `collision` stays the canonical FIRST one, so a project with a single collider is unchanged; four total. A particle stays OUTSIDE every obstacle and INSIDE every container, and emission is clipped to the INTERSECTION of the containers. Resolution is sequential rather than a joint solve, so two containers that do not overlap are unsatisfiable — visible on screen rather than averaged away. Only the first FIXED collider shapes the fluid field (one flow grid), and a system with more than one always previews from the bake. Because a `follow: true` collider stops existing outside its layer's span, two colliders on two spans give you DIFFERENT COLLISIONS OVER TIME with no keyframes. |
| `packing` | `{enabled false, shape circle\|object, substeps 1–8, iters 1–12, stiffness 0.05–1, gap px, friction 0–2, restitution 0–1, radiusScale 0.1–3, cohesion 0–2, cohesionRange, sleep true, sleepDrift, sleepFrames}` | Particle-to-**particle** collision — a pour, a pile, a jar of beads, a mould filling up. `collision` above is particle-to-object; this is the other half. **Off by default and it must stay off unless the look needs it**: with it on, `render.size` becomes a simulation input (the collision radius IS the drawn size × `radiusScale`), so resizing re-bakes. Runs on the baked solver only. Emission refuses births that have no room, so the particle count self-throttles to what physically fits and raising `rate` past that does nothing. Comfortable to about 6,000 particles; a flat solver box (`bounds.size.z` ≤ 1) packs in 2D at about a third of the cost. The fluid field pushes a pack but the pack does not push back on the fluid. **`shape: "object"`** (layer objects, `render.mode: "layers"`, flat box `bounds.size.z` ≤ 2) collides each object as its own artwork outline instead of a circle — letters stack, tip over and swirl without overlapping — and the simulation owns each object's angle: it starts at the object's usual random angle and `objects.spin`, contacts turn it, and `objects.facing: "velocity"` steers it into its travel (`"tumble"` reads as camera-facing). `radiusScale` is ignored in this mode (`gap` still pads the outline); `objects.pick`, `spin`, `keepRatio` and each member's `spinScale` become simulation inputs. Several times the cost of circles: use it for tens to a few hundred objects. With a 3D box it collides as circles. |
| `proximity` | `{enabled, sources[], measure shape\|edge\|inside\|centre\|x\|y, range px, falloff px, shape smooth\|linear\|sharp, combine max\|add\|average\|min, depth px, invert, fx{}, colorMode solid\|ramp, color, colorRamp[]}` | **Another layer's SHAPE drives this system.** Where the Grid Builder's Proximity measures distance to a layer's CENTRE, this measures distance to its SILHOUETTE, so a word or a logo drives the cloud along its own outline. Each entry in `sources` (≤4) is `{id, source, sourceName, fromItemId, follow, size px, position {x,y}, rotation, pickScale}` — a `follow: true` source also stops acting outside its layer's SPAN on the timeline (visibility is not read: hiding a donor layer is part of the dissolve recipe). With `packing.enabled`, `fx.size` additionally becomes a SIMULATION input — it is the contact radius — and re-bakes; without packing it stays drawn-only and free — `source` is the same artwork snapshot a particle object carries, and with `follow: true` the position, in-plane rotation and scale come live off `fromItemId` every frame (keyframes, motion paths and parenting included). `measure: "shape"` is the one to start from; `"inside"` plus `invert: true` is the core-only look. `depth: 0` keeps the field flat (z ignored); above 0 it is a slab of that half-thickness. |
| `proximity.fx` | `{size, opacity, color, spin, bright, stretch, twinkle, attract, flow, orbit, drag, speed, turb, freeze, life}` | What the field drives, as amounts (percentages except `attract`/`flow`/`orbit` in px/s² and `spin` in degrees). **The first seven are LOOK** — read at draw time, so they never re-bake. **The last eight are SIMULATION** — forces, so setting one re-bakes the clip. `attract` and `flow` push along the field's true surface normal (perpendicular to a letterform's edge, not radial from its centre); `freeze: 100` stops particles dead where the field is full, which paints the silhouette out of a passing cloud. Tune `falloff` against the artwork's THINNEST feature: a 300 px band around a word with 55 px strokes is a blob that happens to be word-shaped. Not read by the WebGPU runtime, so keep `solver.maxParticles` under 50,000 for it to have any effect. |
| **Animating the effector** | `propertyKeyframes: { "px:<param>": [...] }` on the PARTICLE ITEM | `range`, `falloff`, `depth` and every key present in `proximity.fx` take an ordinary numeric track, so a Range that opens over a shot or an Attract that lets go on a beat is authored with the normal keyframe machinery (easings, HOLD, the graph editor, `propertyKeyframeFx`). The stored value is the track's base. **A track on a LOOK amount never re-bakes** — it is read at draw time — while one on a SIM amount, or on `range`/`falloff`/`depth` while a force is driven, is a simulation input and re-bakes like editing that number statically does. An amount stored at 0 and keyed away from 0 DOES reach the solver. The enums (`measure`, `shape`, `combine`), `invert`, `colorMode`, `color` and `colorRamp` are deliberately not animatable; a source's pose is not either — set `follow: true` and keyframe the SOURCE LAYER, which is the whole design. |
| `render.dye` | `{mode off\|card, res 0–2, gain, contrast, edge, fade, useRamp}` | **The smoke itself**, rendered from the field's density instead of sprites. `card` is a 2D density field on the box's mid-plane (480×270 / 640×360 / 960×540), baked with the cache (~24 / 42 / 94 MB per 6 s) and drawn under the sprites with a "silk" edge term — the cigarette-smoke look. `mode`, `res` and `fade` re-bake; the rest is free. `volume` is reserved (needs WebGPU; not in the desktop editor yet). |

Physics that must hold when authoring by hand: with a `text` container, keep `fluid.force` low (≤ 20) and `collision.bounce` high — inside channels as thin as letter strokes a strongly coupled crossing flow presses everything against one wall; give the emitter its own `speed` instead. `open` bounds are safe (Dirichlet pressure + sponge + CFL clamp are built in).

**Starters you can write without the repo** — the overrides each preset applies on top of the sanitizer defaults, for a 1920×1080 composition (scale the px values with the frame). Everything not listed keeps its default (`forces.fluid.model` defaults to `off`, so the `fluid` block is what switches the physics on).

*Rising Smoke* (`preset: "smoke"`): a buoyant plume that meets its own eddies.

```json
"particleSystem": {
  "schemaVersion": 3, "preset": "smoke", "seed": 184729,
  "solver": { "maxParticles": 4000, "preRoll": 0, "bounds": { "size": { "x": 1920, "y": 1080, "z": 480 }, "behavior": "kill" } },
  "emitters": [{ "shape": "sphere", "position": { "x": 0, "y": -400, "z": 0 }, "size": { "x": 52, "y": 52, "z": 52 },
    "rate": 900, "lifetime": { "value": 4, "random": 1.4 }, "speed": { "value": 180, "random": 45 },
    "direction": { "x": 0, "y": 1, "z": 0 }, "spread": 35, "variance": 0.35, "stir": { "strength": 80, "radius": 120 } }],
  "forces": { "wind": { "x": 0, "y": 0, "z": 0 }, "drag": 0, "turbulence": { "strength": 0 },
    "fluid": { "model": "smoke", "force": 200, "viscosity": 6, "swirl": 80, "fidelity": "medium" },
    "draft": { "strength": 30, "direction": 15, "gust": 0.7 } },
  "render": { "sprite": "soft-disc", "blend": "alpha", "opacity": 0.85, "twinkle": 0, "size": { "start": 14, "end": 8, "random": 0.4 },
    "colorOverLife": [{ "at": 0, "color": "#ffffff00" }, { "at": 0.14, "color": "#e8e8e89e" }, { "at": 0.5, "color": "#b9b9b980" }, { "at": 0.85, "color": "#8a8a8a38" }, { "at": 1, "color": "#78787800" }] }
}
```

To bend that plume with a fan, add `"forceEmitters": [{ "id": "b1", "kind": "jet", "position": { "x": -150, "y": -300, "z": 0 }, "radius": 180, "strength": 200, "push": 600, "direction": 0, "motion": "hold" }]` — a blower left of the plume base blowing right. `"kind": "vortex"` with `"spin": "cw"` and `radius` ≈ 400 makes a whirlpool instead.

*Shockwave* (`preset: "shockwave"`): a ring blast every 1.5 s that punches the fluid and dies down in its own wake. Do not use it, burst blasts or heavy turbulence to open a film; see [Effects in an intro](video-effects.md#effects-in-an-intro).

```json
"particleSystem": {
  "schemaVersion": 3, "preset": "shockwave", "seed": 51377,
  "solver": { "maxParticles": 9000, "preRoll": 0, "bounds": { "size": { "x": 1920, "y": 1080, "z": 300 }, "behavior": "kill" } },
  "emitters": [{ "emit": "continuous", "shape": "ring", "position": { "x": 0, "y": 0, "z": 0 }, "ring": { "radius": 38, "thickness": 12 }, "dirMode": "outward",
    "size": { "x": 77, "y": 77, "z": 24 }, "rate": 0,
    "bursts": [{ "time": 0, "count": 2200 }, { "time": 1.5, "count": 2200 }, { "time": 3, "count": 2200 }, { "time": 4.5, "count": 2200 }],
    "lifetime": { "value": 1.4, "random": 0.5 }, "speed": { "value": 1500, "random": 350 }, "direction": { "x": 0, "y": 1, "z": 0 }, "spread": 8,
    "variance": 0.2, "stir": { "strength": 100, "radius": 96 }, "detach": false }],
  "forces": { "gravity": { "x": 0, "y": 0, "z": 0 }, "wind": { "x": 0, "y": 0, "z": 0 }, "drag": 2.6, "turbulence": { "strength": 0 },
    "fluid": { "model": "fluid", "force": 60, "swirl": 90, "swirlSize": 2, "fidelity": "medium" } },
  "render": { "sprite": "spark", "blend": "additive", "opacity": 0.95, "twinkle": 0, "stretch": 0.5, "size": { "start": 7, "end": 1.5, "random": 0.5 },
    "colorOverLife": [{ "at": 0, "color": "#ffffffff" }, { "at": 0.15, "color": "#ffe1a3ff" }, { "at": 0.45, "color": "#ff8a3ad9" }, { "at": 0.8, "color": "#8a2a14aa" }, { "at": 1, "color": "#3a100a00" }] }
}
```

The other fluid presets differ from these only in numbers: *Cigarette* is Rising Smoke with `fidelity: "flat-hd"`, a thin `point` source riding a `path` emitter, and `render.dye: { "mode": "card", "res": 1 }`; *Ink Drop* is `model: "fluid"`, a slow downward `sphere` source, high `swirl`, dark alpha sprites; *Ember Swirl* is `model: "fluid"` plus `forces.vortex: { "strength": 230, "scale": 420, "mode": "vortex", "axis": "z", "lift": 0.15 }` and additive orange embers.

**`render`** — evaluated while drawing, so **every field here is free**: changing it never re-bakes.

| Field | Range | Meaning |
| --- | --- | --- |
| `mode` | `sprite` \| `layers` | `layers` stamps `objects.members` instead of a procedural sprite. |
| `sprite` | `soft-disc` \| `star` \| `spark` | Procedural, resolution-independent. |
| `blend` | `alpha` \| `additive` | Alpha systems are depth-sorted back-to-front; additive is order-independent. |
| `size` | `{start, end, random}` px | Size over life, ± per particle. |
| `colorOverLife` | ≤16 stops `{at 0–1, color}` | Colours are stored `#rrggbbaa` (`rgba()` is accepted and normalised). **Alpha always comes from this ramp**, whatever `colorMode` says — end stops must be transparent or particles pop in/out. |
| `colorMode` | `age` \| `source` \| `velocity` | Where RGB comes from. `source` needs a `layer` emitter. (v1's `colorFrom: 'ramp'\|'source'` migrates to `age`/`source`.) |
| `velocityRamp` / `velocityRange` | ramp / `{min, max}` px/s | The `velocity` gradient and the speeds that read its ends (`max` is forced above `min`). |
| `twinkle` / `stretch` / `opacity` | 0–1 / 0–4 / 0–1 | Per-particle flicker (a ~1 Hz opacity pulse); how far a particle is smeared along its own velocity, 0 a dot and high values a streak; layer opacity. |
| `onKill` | `{fade 0–10 s, scale 0–1}` | How a particle **leaves**. Only possible because the clip is baked in advance: a particle knows a wall is coming and starts fading/shrinking before it goes. `scale` needs a non-zero `fade`. |

#### Emitting from a layer (`shape: "layer"`) — dissolve a picture into its own pixels

Particles are born on the artwork's opaque pixels and can keep the colour of the pixel they came from. The artwork is a **bounded snapshot on the emitter**, never a live reference — the source layer can be trimmed, hidden or deleted without breaking the system. `fromItemId` is only a hint so the editor's **Update artwork from layer** can find it again.

```json
{ "shape": "layer", "emit": "continuous", "rate": 0,
  "bursts": [{ "time": 0, "count": 1600 }],
  "speed": { "value": 0, "random": 0 },
  "size": { "x": 900, "y": 260, "z": 0 },
  "position": { "x": 0, "y": -120, "z": 0 },
  "sourceName": "Headline", "fromItemId": "<source item id>",
  "source": { "kind": "text", "text": "DISSOLVE", "fontFamily": "Inter", "fontWeight": 800,
              "fontSize": 96, "lineHeight": 1.15, "color": "#ffffff" } }
```

**Several layers.** `emitters[0].source` stays the canonical FIRST source and `emitters[0].sources[]` holds up to three more, each `{source, sourceName, fromItemId, size {x,y}, position {x,y}, followTimeline}` with its OWN rect — two layers do not share one. Sites are shared by ARTWORK AREA, not evenly, so a word and a full stop keep the same density instead of taking half the cloud each. `followTimeline` (per source, default false) stops that source emitting outside its layer's span. Grow Points is single-source: the front sweeps one artwork's arrival field.

`source` is one of:

- `{ "kind": "image", "url": "/media/admin/{board_id}/logo.png", "aspect": 1 }`
- `{ "kind": "text", "text", "fontFamily", "fontWeight" 100–1000, "fontSize" 4–2000, "lineHeight" 0.5–4, "color" }`
- `{ "kind": "shape", "points": [{x, y, hIn?, hOut?}] (2–256, unit space), "closed", "fill", "stroke", "strokeWidth", "aspect" }`

To match what the editor does when a user picks a layer (and what makes it read as a dissolve rather than a leak):

- `emitter.size` = the layer's real on-screen rect, `emitter.position` = its position — a fraction of the frame reproduces the shape at the wrong scale and in the wrong place;
- `solver.preRoll: 0` (the picture must be whole at frame 0, not already blown apart), `rate: 0`, one burst of the full `maxParticles` at `time: 0`, `speed: 0` — the forces do the moving;
- `render.colorMode: "source"` to keep each speck's own colour, with a `colorOverLife` that is opaque first and fades later (the ramp is then driving alpha alone);
- `render.size.start`/`.end` ≈ `2.6 × sqrt(rectW × rectH / maxParticles)`, so the picture reads solid before it breaks up.

The source layer itself does **not** disappear — a full dissolve transition still needs the layer hidden or faded separately.

#### Particle Activation (`activation`) — a sweep instead of a pop

`mode: "immediate"` (default) means rate and bursts decide everything and the rest of the block is inert. `mode: "grow"` hands the emission sites to the same arrival bake Grow Fill uses, so a front travels *through the artwork* and switches particles on as it passes. **It only does anything for a `layer` emitter.**

With `grow` on, emission stops being a rate and becomes a schedule: `rate`, `bursts` and `preRoll` are all ignored, `maxParticles` is clamped to the number of emission sites, and each site's particle is born (or released) at the instant the front reaches it.

| Field | Range | Meaning |
| --- | --- | --- |
| `inactive` | `frozen` \| `hidden` | `frozen` = every particle exists from frame 0 standing on its own pixel (the layer reads as the artwork until the front releases it; lifetime starts at release). `hidden` = nothing exists until the front arrives, so the layer builds up out of nothing. |
| `start` / `speed` | 0–100 % / 0–400 %/s | Where the front is on frame one, and how fast it travels (`0` never moves). |
| `reverse` | bool | Runs the sweep backwards. |
| `softness` | 0–60 % | Dithers the front into a band instead of a cut line. |
| `ignite` / `igniteBoost` / `igniteMode` / `igniteColor` / `igniteRamp` | 0–4 s / 0–400 % / `flash`\|`solid`\|`gradient` / colour / ramp | A flare on a just-released particle. **Drawn, not simulated** — tuning it never re-bakes. |
| `from` | `left`\|`right`\|`top`\|`bottom`\|`center`\|`scatter` | Where the front starts. |
| `seedCount` / `seedStagger` / `points` | 1–8 / 0–100 % / ≤8 `{x, y, delay}` | Number of start points, delay between them, or hand-placed seeds in the emitter's unit space (−0.5…0.5, +y up). |
| `speedMap` + `noiseScale`/`noiseContrast`/`noiseSeed` | `uniform`\|`turbulent` | An uneven front. |
| `bridges` / `bridgeReach` / `bridgeSlow` | bool / 1–80 px / 1–12× | Lets the front jump to a detached piece. **Reach must clear the gap between letters** or each glyph is its own island and only the seeded one ever activates. |

#### Particle objects (`objects`) — stamp layers instead of sprites

With `render.mode: "layers"`, each particle stamps one of up to 12 members. Objects are a **render-only** concern — the solver moves anonymous points — so adding, removing or resizing them never re-bakes.

`members[]`: `{ id, name, fromItemId?, source, included, weight 0–10, sizeScale 0.05–20, spinScale 0–20 }`, where `source` is the same snapshot shape as a layer emitter's. Block-level: `pick` (`cycle`\|`random`), `facing` (`billboard`\|`tumble`\|`velocity`), `size` px, `sizeRandom` 0–1, `spin` 0–20, `keepRatio`, `tint` (multiply the artwork by the life ramp). A member with no usable artwork is dropped rather than kept as a blank row. Stamped artwork needs far fewer particles than dots — the editor thins a system to ~260 on the first pick.

#### Lines (`render.mode: "lines"`) — trails and ready-made lines

`render.mode: "lines"` joins particles into ribbons instead of stamping each one. The simulation is unchanged — every force, the fluid and Return bend a line because they move its particles — and `render.lines` is draw-time only (never in the sim hash).

- **`connect: "time"` — trails.** Each particle draws its own recent path, read from the baked cache.
- **`connect: "rows"` — ready-made lines.** Needs `emitters[0].shape: "rows"`: `rows: { count 1–400, points 2–1000 }` tracers (count × points ≤ 50,000) spread over the emitter's `size`, all placed at `start`, at rest (row 0 is the top). Rows tracers never die of age and never stir the fluid, and the sanitiser sets `solver.maxParticles` to count × points. Each row is drawn whole from the first frame, bent by the forces. Give the box `bounds.behavior: "bounce"` so no point is killed at a wall (a missing point splits its row). With `connect: "rows"` and any other emitter shape, lines fall back to trails.

| `render.lines` field | Range | Meaning |
| --- | --- | --- |
| `width` / `widthRandom` | 0.1–400 px / 0–1 | Ribbon width at the comp plane; per-line jitter. |
| `taperStart` / `taperEnd` / `profile` | 0–1 / 0–1 / `linear`\|`smooth`\|`swell` | Thinning at the head / tail of a trail, the left / right end of a row. `swell` is fattest mid-line. |
| `speedWidth` / `movedWidth` | −1–1 / 0–3 | Width by speed (range = `render.velocityRange`); extra width by distance moved from birth (range = `movedRange`). |
| `length` / `shape` | 0.02–60 s / `trail`\|`full` | Seconds of path a trail shows; `full` = since birth. |
| `end` / `stayFade` | `cut`\|`retract`\|`stay` / 0–60 s | What a trail does when its particle dies; `stay` + `shape: "full"` turns particles into pens. `stayFade: 0` keeps a stayed line. |
| `share` | 0.01–1 | Fraction of particles that get a trail — keep dense systems near 1,500 trails. |
| `tailFade` / `fadeCurve` | 0–1 / 0.1–6 | Alpha falloff toward the tail. |
| `pinEnds` | 0–0.5 | Rows: share of each row's length, per end, held on its rest line. |
| `smooth` | 1 \| 2 \| 4 \| 8 | Maximum Catmull-Rom sub-samples between neighbouring points (only curved stretches use them). |
| `colorMode` | `particle` \| `along` \| `moved` | `particle` = `render.colorOverLife` / velocity ramp at each point; `along` = `colorStart` → `colorEnd` head → tail (rows: top row → bottom row); `moved` = `colorStart` at rest → `colorEnd` at `movedRange` px from birth. Colours are `#rrggbbaa`. |
| `showParticles` | bool | Also draw the sprites (with `render.size`) under the lines. |

`render.blend` and `render.opacity` apply to lines too. *Smoke Lines* (`preset: "smoke-lines"`) is the starter for "lines bent by smoke":

```json
{
  "schemaVersion": 4, "preset": "smoke-lines", "seed": 7,
  "solver": { "preRoll": 0, "bounds": { "shape": "box", "size": { "x": 2304, "y": 1296, "z": 240 }, "behavior": "bounce" } },
  "emitters": [{ "emit": "static", "shape": "rows", "position": { "x": 0, "y": 0, "z": 0 }, "size": { "x": 1920, "y": 972, "z": 0 }, "rows": { "count": 100, "points": 160 } }],
  "forces": {
    "wind": { "x": 0, "y": 0, "z": 0 }, "drag": 0, "turbulence": { "strength": 0 }, "return": { "strength": 2.5 },
    "fluid": { "model": "smoke", "force": 400, "swirl": 80, "viscosity": 4, "fidelity": "medium", "bounds": "open", "smoke": { "buoyancy": 300 } }
  },
  "forceEmitters": [{ "id": "force-1", "kind": "smoke", "position": { "x": 0, "y": -454, "z": 0 }, "radius": 90, "strength": 60, "density": 2.2, "heat": 70, "push": 140, "direction": 90, "motion": "hold" }],
  "render": {
    "mode": "lines", "blend": "alpha", "opacity": 1,
    "lines": { "connect": "rows", "width": 1.2, "taperStart": 0, "taperEnd": 0, "pinEnds": 0.15, "smooth": 2, "colorMode": "moved", "colorStart": "#e6eceeff", "colorEnd": "#ff6a3dff", "movedRange": 160 }
  }
}
```

Move the plume with the smoke source's `position` / `motion` (`sweep` ripples the rows); `return.strength` sets how far a row is pulled before it settles (0 = carried off with the smoke).

#### What re-bakes and what is free

Only simulation inputs invalidate the cache: `seed`, `solver`, `emitters[0]` (including `rows`), `forces` (including `return`), the layer emitter's artwork, and the *timing* parts of `activation` (`mode`, `inactive`, `start`, `speed`, `reverse`, `softness`). Everything in `render` (including `mode` and `lines`), `objects`, `quality`, plus `activation.ignite*`, is evaluated at draw time. Useful when a user asks for "the same motion, different colour" — that edit is instant and byte-identical in simulation.

> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GLEA — Particle layers: dust, snow, sparks, smoke, dissolves and lines

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

Read this to add or change a particle layer (`mediaType: "particles"`): a seeded simulation in a box, drawn as one layer of the
composition. Ambience (dust, snow, sparks, bokeh, stars), a picture or word that dissolves into its own pixels or builds out of them,
smoke and fluid made of particles, particles inside letters or flowing round a logo, layers stamped as particles, trails and lines.

## Contents

- [Particle layer or 3D Scene sim?](#particle-layer-or-3d-scene-sim)
- [The layer](#the-layer)
- [Which engine runs it](#which-engine-runs-it)
- [Presets, and the Snow example](#presets-and-the-snow-example)
- [`solver`: the box](#solver-the-box)
- [`emitters[0]`: where particles are born](#emitters0-where-particles-are-born)
  - [Emission distribution](#emission-distribution-emitters0distribution)
- [`forces`](#forces)
- [`render`: the look](#render-the-look)
- [Smoke and fluid (`forces.fluid`)](#smoke-and-fluid-forcesfluid)
  - [Force emitters (`forceEmitters`)](#force-emitters-forceemitters)
- [Emit from a layer: dissolve a picture into its pixels](#emit-from-a-layer-dissolve-a-picture-into-its-pixels)
- [Grow: a front that releases the picture (`activation`)](#grow-a-front-that-releases-the-picture-activation)
- [Layers as particles (`objects`)](#layers-as-particles-objects)
- [Lines: trails and ready-made rows](#lines-trails-and-ready-made-rows)
- [Collision and containers (`collision`, `colliders`)](#collision-and-containers-collision-colliders)
- [Particles that pile up (`packing`)](#particles-that-pile-up-packing)
- [Follow a path (`pathFollow`)](#follow-a-path-pathfollow)
- [Proximity: another layer's shape drives the cloud](#proximity-another-layers-shape-drives-the-cloud)
- [A logo made of particles, and a morph between shapes](#a-logo-made-of-particles-and-a-morph-between-shapes)
- [What re-bakes and what is free](#what-re-bakes-and-what-is-free)

## Particle layer or 3D Scene sim?

Use a **particle layer** for particles that belong to the flat composition: ambience over footage or a title, a layer that
dissolves into its pixels or builds out of them, particles held inside letters or flowing round a logo, a word or shape that
pulls the cloud (Proximity), layers stamped as particles, trails, lines bent by smoke, smoke made of particles. It works in any
project, is sized in composition pixels next to the other layers, and its bake needs no WebGPU. It is drawn as one flat picture:
not lit, no shadows, not traced in Final 3D, never hidden by a 3D Scene's objects (over a Scene it is drawn over the Scene's
picture). Use a **3D Scene sim** (`rig.scene.sims`, sim.md (GreenLight Dash only)) when the particles live among the Scene's objects: in front of
and behind them, lit by its lights, casting shadows, colliding with its objects, sparks that light the floor in Final, smoke as a
lit volume. The Scene has recipes for the same looks (`snow`, `dust_in_beam`, `smoke`, `sparks_in_wind`, `embers`, `bokeh`, `stars`,
`smoke_lines_grid`; [video-world3d.md](video-world3d.md#particles-snow-dust-smoke-sparks-bokeh-stars)). Volumetric smoke, fire and explosions
exist only as Scene sims ([video-world3d.md](video-world3d.md#smoke-and-fire)): a particle layer's fluid moves particles and is never drawn as
a volume.

## The layer

A particle clip carries no media. Its **item** owns the whole system as `particleSystem`.

- The clip is synthetic (`"url": ""`), default duration 6 s.
- Put it on its **own free channel** (`"unsnapped": true`) and place it with `freeStart`. A project may hold several; the channel has
  no `kind`, ordinary stacking applies. The editor's Add Layer ▸ Particle Solver does this with the Dust preset at the playhead.
- **Only `emitters[0]` is simulated.** The array keeps up to 8 entries; the rest are ignored.
- **`preset` is a label.** Writing `"preset": "snow"` does not make snow: the editor writes a complete system only when a preset is
  applied in the panel. Write the values ([Presets](#presets-and-the-snow-example)).
- Every load passes the system through a bounded sanitizer: a missing field takes the **Dust** default, a number out of range is
  clamped, an unknown enum reverts. A partial system is Dust plus what you wrote, so set what Dust has on that you do not want:
  `forces.wind.x` 8, `forces.turbulence.strength` 26, `forces.drag` 0.12, `render.twinkle` 0.2, `solver.preRoll` 5.5.
- **Write `"schemaVersion": 4`.** A system without it is read as version 1 and keeps `forces.turbulence.pattern: "smooth"` instead of
  the default `"billow"`. Optional blocks left out (`forces.fluid`, `forces.draft`, `forceEmitters`, `pathFollow`, `collision`,
  `colliders`, `packing`, `proximity`) are off.
- **Keyframes.** The item's Position / Rotation / Scale keyframes, parenting and Motion Follow move the whole box. Inside the system
  only the Proximity numbers take tracks (`px:`, [below](#proximity-another-layers-shape-drives-the-cloud)); wind, rate,
  turbulence and every other solver value hold one value for the clip. Asked to "animate the wind", say so instead of writing a
  track that is dropped.
- **Its clock** is the seconds since the layer starts on the timeline. `speedPoints` change only the layer's length, not the
  simulation's pace; trimming the head does not skip into it; Posterize Time ([effects-layer.md](video-effects.md#posterize-time-entry))
  steps it. Changing the layer's length re-bakes it.
- Rendered by `/render-onserver` and the desktop export. The fast ffmpeg `/render` does not draw particle layers.
- `quality.previewFraction` (0.05–1) draws a stable subset, and the export reads it too: leave it at `1`.

The inspector's groups and what they write: EMITTER `emitters[0]`; GROW / GROWTH FIELD `activation`; PARTICLE `render.mode`,
`objects`; LOOK and COLOUR `render`; GRAVITY & WIND `forces.gravity`, `wind`, `drag`, `return` ("Pull home"); TURBULENCE
`forces.turbulence`; FOLLOW A PATH `pathFollow`; FORCES `forces.vortex` ("Everywhere") and `forceEmitters` ("At a point"); COLLISION
`collision`, `colliders`; PILE UP `packing`; FLUID & SMOKE `forces.fluid`, `forces.draft`; PROXIMITY `proximity`; SOLVER `solver`,
`seed`, `quality`.

## Which engine runs it

The engine is chosen per layer from the system; the JSON is the same for all of them.

- **The bake**, at or below 50,000 `maxParticles`, and at any count for a system that uses a feature the GPU engine does not have
  (list below). Simulated once from `seed` at a fixed 1/60 s step, off the main thread, kept as 30 snapshots a second and read by
  clip time, so preview, scrubbing (backwards too), Download, a Time range render and `/render-onserver` show the same frame, and
  export motion blur samples real motion. An export waits for the bake. The bake simulates at most 100,000 particles whatever
  `maxParticles` says.
- **The GPU engine**, above 50,000 on a machine with WebGPU: emits, simulates and draws on the graphics card, up to 8,000,000, in
  the preview and in exports; it is never baked and re-simulates from the start when scrubbed back. Up to 1,000,000 holds 60 fps;
  8,000,000 is about 29 fps (an M-series Mac at 1080p). All particle layers share a 1.5 GB budget, and a layer refused falls back
  to the bake. Without WebGPU the system runs on the bake, clamped to 100,000. It does not read `proximity`.
- **Live preview** (the editor only, WebGPU): after an edit the editor shows a live simulation of the same inputs until the new bake
  lands, then reads the bake (`solver.engine: "auto"`). Exports never use it. Grow, packing, more than one collider and trails
  (`lines.connect: "time"`) always preview from the bake, and a step slower than a 60 fps frame hands the layer to the bake until
  the next edit.

A system stays on the bake at any count when it uses any of: `solver.engine: "baked"`, a collider or container, packing, any force
emitter (Layer Velocity included), Path Follow, Grow, particle objects (`render.mode: "layers"`), lines, a `rows` emitter,
`forces.return.strength` above 0, or colour taken at birth from a video source.

`maxParticles` is a **ceiling, not a request**: a system emitting 260/s that lives 5 s holds about 1,300 at once whatever the
ceiling says, and the bake sizes itself to what the emitter can reach. A ceiling below `rate × lifetime` makes the system thinner
than authored (new births are skipped at the cap; no living particle is cut short).

## Presets, and the Snow example

Applying a preset in the panel writes these systems, sized to the composition (numbers below are for 1920×1080):

| `preset` | Name | What it is |
| --- | --- | --- |
| `dust` | Dust | The defaults: a box 1.1× the frame emitting 260/s, life 5 ± 1.5 s, speed 22 ± 12, wind 8, turbulence 26, soft-disc 9 → 6 px, pre-roll 5.5 s, bounds `kill` |
| `stars` | Stars | `star` sprites, additive, `twinkle` 0.85, 150/s, life 7 ± 2 s, bounds `wrap` |
| `snow` | Snow | The example below |
| `sparks` | Sparks | A `point` emitter 130 px below centre, 260/s, life 1.6 ± 0.6 s, speed 620 ± 260 up, `spread` 62, gravity −620, `spark` sprites additive 26 → 9 px, `onKill` fade 0.25 / scale 0.7 |
| `bokeh` | Bokeh | Six discs: `static`, life 100 s, bounds `bounce`, additive soft discs 2590 → 1517 px, turbulence 102 at scale 0.002 |
| `smoke` | Rising Smoke | A buoyant plume on the fluid ([starter](#smoke-and-fluid-forcesfluid)) |
| `cigarette` | Cigarette | Rising Smoke as a thin column |
| `ink` | Ink Drop | Ink falling into still water |
| `ember` | Ember Swirl | Embers swirled by the fluid and a vortex |
| `shockwave` | Shockwave | A ring blast every 1.5 s ([starter](#smoke-and-fluid-forcesfluid)) |
| `smoke-lines` | Smoke Lines | 100 ready-made lines bent by a plume ([starter](#lines-trails-and-ready-made-rows)) |

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
            "schemaVersion": 4,
            "preset": "snow",
            "seed": 55521,
            "solver": { "cacheHz": 30, "maxParticles": 2000, "preRoll": 7, "space": "local",
              "bounds": { "shape": "box", "size": { "x": 2496, "y": 1620, "z": 1100 }, "behavior": "wrap" } },
            "emitters": [
              { "id": "emitter-1", "emit": "continuous", "shape": "box",
                "position": { "x": 0, "y": 0, "z": 0 },
                "size": { "x": 2400, "y": 1512, "z": 1000 },
                "rate": 240, "bursts": [], "start": 0, "end": 9999,
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

## `solver`: the box

The box the particles live in. Its transform is the layer's: moving, rotating, scaling or parenting the item moves the whole volume,
and particles travel with it (they simulate in the box's own space). The box is centred on the layer's position (`panX` / `panY` /
`panZ` and the PRS keyframes) in the same world as every other layer and is filmed by the project camera, so a box given a Shape's
exact transform fills that Shape's rect under any camera move. On a camera-locked channel it stays in frame space. To snow onto a
rect, size `bounds.size` and the emitter to the rect and put the layer at its centre.

| Field | Range | Meaning |
| --- | --- | --- |
| `maxParticles` | 1–8,000,000 | The ceiling (see [Which engine runs it](#which-engine-runs-it)). A `rows` emitter sets it to count × points. |
| `preRoll` | 0–30 s | Simulated before the clip starts so the box is full at frame 0. Ambience: about one lifetime. A dissolve: `0`. On the fluid each pre-rolled step is a grid solve, which is why the fluid presets use 1.2–1.6 s. |
| `bounds.size` | px `{x, y, z}` | Width, height, depth of the box, in composition px. |
| `bounds.behavior` | `kill` (default) \| `wrap` \| `bounce` | What a wall does. `wrap` teleports to the far side (visible on slow or big particles); `bounce` reflects keeping 60 % of the speed. |
| `engine` | `auto` (default) \| `live` \| `baked` | How the editor previews it, not a simulation input. `live` always simulates live; `baked` always shows the bake and keeps a system above 50,000 on the bake. Leave it out. |
| `cacheHz`, `space`, `bounds.shape` | `30`, `"local"`, `"box"` | Fixed. |

## `emitters[0]`: where particles are born

| Field | Range | Meaning |
| --- | --- | --- |
| `emit` | `continuous` \| `static` | `static` fills the system to the cap once, at clip time `max(0, start)` after the pre-roll, and never emits again (rate and bursts ignored): a shatter, a dissolve, anything Grow releases. Nothing it emits has a past at frame 0, so a trail that must already exist at frame 0 (a comet) needs `continuous` with a pre-roll. |
| `shape` | `point` \| `box` \| `sphere` \| `cone` \| `ring` \| `path` \| `block` \| `layer` \| `rows` | `ring`: an annulus in the frame plane, `ring: {radius, thickness}` px. `path`: births evenly along a spline, `path.anchors` (≤ 64) in the emitter's unit space (−0.5…0.5, +y up). `block`: a filled slab. `layer`: a picture's opaque pixels ([below](#emit-from-a-layer-dissolve-a-picture-into-its-pixels)). `rows`: ready-made lines ([Lines](#lines-trails-and-ready-made-rows)). |
| `dirMode` | `cone` \| `outward` \| `tangent` | `ring` and `path`: launch along `direction` + `spread`, away from the ring (normal to the path), or along it. |
| `position` / `size` | px `{x, y, z}` | Place and extent inside the box; `size.x` is the diameter of a `sphere` or `cone`. A `layer` emitter scatters its births over `size.z` in depth. |
| `rate` | 0–20,000 /s | Continuous emission. |
| `bursts` | ≤ 8 × `{time 0–3600 s, count}` | Pops on top of the rate, each at its `time`. A shockwave or puff: a burst, a high `speed`, and `forces.drag` to stop it (`shape: "ring"` + `dirMode: "outward"` for a ring blast). Ignored when `static`. |
| `start` / `end` | s | The rate's window. **The rate starts `preRoll` seconds before `start`**: to start a continuous emitter at 2 s, write `start: 2` with `preRoll: 0` (with `preRoll: 1.5` it starts at 0.5 s). |
| `lifetime` | `{value 0.05–600, random}` s | Per particle, ± `random`. |
| `speed` | `{value, random}` px/s | Launch speed. |
| `direction` / `spread` | vector / 0–180° | Aim, and the cone round it (180 = every direction). |
| `distribution` | block | How births are spread inside the shape ([below](#emission-distribution-emitters0distribution)). |
| `variance` | 0–1 | With the fluid on: wobble of emission direction, strength and heat over time. `0` is a steady source (a carpet of same-sized curls); about `0.35` gives billows at every scale. |
| `stir` | `{strength 0–200, radius px}` | With the fluid on: how hard emission stirs it, and over what radius. |
| `detach` | bool | With the fluid on: emission deposits material only and leaves the push to `forceEmitters`; with `stir.strength: 0` as well it deposits nothing, so the only smoke is from `kind: "smoke"` force emitters. |

### Emission distribution (`emitters[0].distribution`)

How spawn sites are spread inside `box`, `block`, `sphere`, `cone`, `ring` and `path` emitters (not `point`, `layer` or `rows`).
Leave the block out (or `mode: "random"`) for independent random draws; `random` costs nothing and changes nothing in the bake.
A set-based mode fixes `sites` places and starts again at the first when they run out.

| `mode` | What it makes | Params |
| --- | --- | --- |
| `random` | Independent draws; clumps and holes are part of the look. The default. | — |
| `stratified` | One particle anywhere inside its own lattice cell: organic but never clumped. | `sites`, `jitter` |
| `grid` | Exact cell centres: a dot matrix, a formation, beads evenly on a path. | `sites` |
| `packed` | Rows offset by half a cell (hexagonal in plane): the densest even arrangement; reads as a surface. | `sites` |
| `relaxed` | Random, then pushed apart until nothing clumps (blue noise). At most 8,192 sites. | `sites`, `relaxIters` |
| `lowdisc` | A quasi-random sequence: even at any count without knowing the total. **The one for a continuously emitting system.** | `sequence`, `jitter` |
| `sunflower` | The golden angle: fills a disc or sphere evenly, centre outward (reads as growth while filling). | `sites` |
| `rings` | Concentric bands spaced by area: targets, radar, ripples. | `sites`, `rings` |
| `clustered` | Clumps of births round scattered seeds: sparks off an impact, embers, debris. | `clusters`, `tightness` |
| `falloff` | Random, denser at the core or toward the rim. | `bias` |
| `shell` | The skin only: a sphere becomes a bubble, a box its six faces. | `thickness` |

| Param | Range | Meaning |
| --- | --- | --- |
| `sites` | `0` = auto, else 16–8,000,000 | Distinct places before the pattern repeats. Auto follows `maxParticles`, the only value at which nothing doubles up. |
| `jitter` | 0–1 | Softens a lattice toward organic. On `lowdisc`: turns the whole sequence per seed, so two emitters do not spawn in lockstep. |
| `order` | `scan` \| `scramble` (default) \| `shuffle` | The order sites are used while the emitter is still filling. `scan` fills one corner at a time; the others reach the whole shape at once. |
| `sequence` | `r2` (default) \| `halton` | `lowdisc` only. `halton` shows a faint lattice in its first few hundred particles. |
| `relaxIters` | 0–40 | `relaxed` only; past about 15 nothing changes but the bake time. |
| `rings` | 1–512 | `rings` only. |
| `clusters` / `tightness` | 1–4096 / 0.001–0.5 | `clustered` only: how many clumps, and each one's radius as a fraction of the emitter. |
| `bias` | −1…1 | `falloff` only: negative packs the core, positive hollows it. |
| `thickness` | 0.002–0.5 | `shell` only: skin depth as a fraction of the shape. Never `0` (a zero-thickness skin flickers as the camera moves). |

## `forces`

| Field | Range | Meaning |
| --- | --- | --- |
| `gravity` / `wind` | px/s² `{x, y, z}` | Accelerations on every particle (+y up). |
| `drag` | 0–20 /s | Bleeds speed away; what stops a wind accelerating for ever and a burst flying on. |
| `turbulence.pattern` | `smooth` \| `billow` (default) \| `ridged` \| `swirl` \| `wave` | The field's character. All move particles by the same amount, so switching does not need `strength` re-tuned. |
| `turbulence.strength` / `.scale` / `.speed` | 0–20,000 / 0.00001–1 / 0–20 | Amount; pattern size (smaller = finer); how fast the field changes (`0` freezes it). |
| `turbulence.complexity` / `.direction` | 1–6 / 0–360° | Octaves; the wavefront heading (`wave` only). |
| `vortex.mode` | `vortex` \| `orbit` \| `twist` \| `attract` \| `repel` | A second field centred on the box. |
| `vortex.strength` / `.axis` / `.scale` / `.lift` | 0–20,000 / `x` \| `y` \| `z` / 1–100,000 px / 0–4 | `scale` is a falloff radius, not a wall; `lift` sends part of the pull along the axis. |
| `return.strength` | 0–60 /s (0 = off) | Pulls every particle back toward where it was born. In a flow of speed `v` a particle settles about `v / strength` px from home: lines bulge where smoke passes and relax behind it, a shape made of particles re-forms after a gust. |

`forces.fluid` and `forces.draft` are in [Smoke and fluid](#smoke-and-fluid-forcesfluid).

## `render`: the look

Drawn, not simulated: changing anything here never re-bakes (except the size fields while `packing` is on).

| Field | Range | Meaning |
| --- | --- | --- |
| `mode` | `sprite` \| `layers` \| `lines` | `layers` stamps `objects.members` ([below](#layers-as-particles-objects)) and draws sprites while there are none; `lines` joins particles into ribbons ([Lines](#lines-trails-and-ready-made-rows)). |
| `sprite` | `soft-disc` \| `star` \| `spark` | Procedural, sharp at any size. |
| `blend` | `alpha` \| `additive` | Alpha particles are sorted back to front; additive ones add up and a dense cloud turns white. |
| `opacity` | 0–1 | The layer's. |
| `size` | `{start, end 0.1–4000, random 0–1}` px | Size over life, ± per particle. |
| `colorOverLife` | ≤ 16 stops `{at 0–1, color}` | Stored `#rrggbbaa` (`rgba()` is accepted). **Alpha always comes from this ramp**, whatever `colorMode` says: end stops must be transparent or particles pop in and out. |
| `colorMode` | `age` \| `source` \| `velocity` | Where RGB comes from: the ramp at the particle's age; the pixel it was born on (a `layer` emitter, sprites and lines only); or `velocityRamp` over `velocityRange` `{min, max}` px/s. |
| `colorSourceTime` | `live` (default) \| `birth` | A `layer` emitter on a VIDEO with `colorMode: "source"`: `live` re-reads the frame playing now (the cloud is the moving picture), `birth` keeps each particle's colour from when it was born (keeps the system on the bake). |
| `twinkle` | 0–1 | Per-particle flicker. |
| `stretch` | 0–4 | Smear along the particle's own velocity: 0 a dot, high values a streak. |
| `onKill` | `{fade 0–10 s, scale 0–1}` | How a particle leaves: it fades (and shrinks by `scale`) over its last `fade` seconds before it dies or hits a `kill` wall. `scale` needs a `fade` above 0. |

## Smoke and fluid (`forces.fluid`)

`forces.fluid` turns on a simulated force field: an incompressible velocity grid over the box that emission stirs and particles ride.
Unlike turbulence it has memory: a plume meets the eddies it left behind, smoke curls back on itself, ink mushrooms. It moves the
particles and is never drawn itself. It is the costliest part of the bake: the grid steps 360 times for a 6 s clip, about 4 ms a
step at `low`, 10 at `medium`, 30 at `high`, 80 at `ultra` / `flat-hd`, 250 at `volume-hd`. Route "smoke", "ink in water",
"cigarette smoke", "steam", "particles flowing like liquid" here when it is a layer of particles.

| Field | Range | Meaning |
| --- | --- | --- |
| `model` | `off` (default) \| `fluid` \| `smoke` | `fluid` is velocity only; `smoke` adds density and heat riding the same field (buoyancy, weight, cooling, dissipation). |
| `force` | 0–400 | How fast a particle trades its own velocity for the field's. High: a tracer. Low: keeps its inertia. |
| `timeFactor` | 0.1–4 | The field's clock; particles keep real time. |
| `viscosity` / `swirl` / `swirlSize` | 0–100 / 0–200 / 1–6 cells | Thickness of the medium; vorticity confinement (feeds small eddies back); the eddy size it reinforces. |
| `fidelity` | `low` \| `medium` (default) \| `high` \| `ultra` \| `flat-hd` \| `volume-hd` | Grid at 16:9: 48×27×12, 64×36×16, 96×54×24, 128×72×32, 256×144×8, 192×108×48. The in-plane cell count follows the box's aspect, so a portrait box gets a tall grid. `flat-hd` spends the cells in plane for thin columns. |
| `pressureSteps` / `fade` / `sharp` | 4–60 / 0–1 / bool | Pressure iterations; how fast the field calms; sharper advection (livelier, more detail). |
| `bounds` | `closed` (default) \| `open` | Walls (a plume pools under the top) or outflow (it leaves the box). |
| `reach` | `box` (default) \| `sources` | Who rides the flow: every particle, or only those inside a force emitter's `radius` (fading with distance), so the rest keep their own motion. `sources` needs `emitters[0].detach: true` (or a `rows` emitter) and at least one force emitter. |
| `smoke` | `{buoyancy −200–600, weight 0–400, heat 0–100, cooling 0–4, dissipate 0–4}` | `smoke` model only. Emission deposits hot material; heat lifts, weight pulls. |
| `forces.draft` | `{strength 0–300, direction 0–360°, gust 0–1}` | A gusting wind on the field, varying in time only, so it reads as weather. |

With a text container ([Collision](#collision-and-containers-collision-colliders)) keep `force` low (≤ 20) and the
collider's `bounce` high: in channels as thin as letter strokes a strongly coupled flow presses everything against one wall, so give
the emitter its own `speed` instead. `open` bounds are safe.

The fluid presets as overrides on the defaults (`model` defaults to `off`, so the `fluid` block is what turns the physics on), for
1920×1080 (scale px values with the frame):

*Rising Smoke* (`preset: "smoke"`): a buoyant plume that meets its own eddies.

```json
"particleSystem": {
  "schemaVersion": 4, "preset": "smoke", "seed": 184729,
  "solver": { "maxParticles": 4000, "preRoll": 1.5, "bounds": { "size": { "x": 1920, "y": 1080, "z": 480 }, "behavior": "kill" } },
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

To bend that plume with a fan, add `"forceEmitters": [{ "id": "b1", "kind": "jet", "position": { "x": -150, "y": -300, "z": 0 }, "radius": 180, "strength": 200, "push": 600, "direction": 0, "motion": "hold" }]`:
a blower left of the plume's base blowing right. `"kind": "vortex"` with `"spin": "cw"` and `radius` about 400 makes a whirlpool.

*Shockwave* (`preset: "shockwave"`): a ring blast every 1.5 s that punches the fluid and dies down in its own wake. Not in an intro;
see [Effects in an intro](video-effects.md#effects-in-an-intro).

```json
"particleSystem": {
  "schemaVersion": 4, "preset": "shockwave", "seed": 51377,
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

The other three differ in numbers: *Cigarette* is Rising Smoke as a thin column (a 5 px `sphere` source at 6,400/s, 24,000
particles, `spread: 3`, `fidelity: "high"`, `bounds: "open"`, faint additive sprites); *Ink Drop* is `model: "fluid"` (`force: 320`,
`swirl: 30`, `fidelity: "high"`) with a `sphere` source shooting down at 420 px/s under gravity −60 and blue alpha sprites; *Ember
Swirl* is `model: "fluid"` (`swirl: 170`) plus `forces.vortex: { "strength": 230, "scale": 422, "mode": "vortex", "axis": "z", "lift": 0.15 }`
and additive orange embers.

### Force emitters (`forceEmitters`)

Up to 3 forces placed in the box, with no particles of their own. Any of them keeps the layer on the bake.

| `kind` | What it does |
| --- | --- |
| `jet` | A **blower**: what is inside `radius` is blended toward `push` px/s along `direction` (0° = right, 90° = up) at a rate set by `strength`. With the fluid on it drives the field and the particles ride it; without, it pushes the particles directly. |
| `vortex` | A force round its own point in one of the five `forces.vortex` modes (`mode`, `lift`); `spin` `ccw` \| `cw`. Acts on the particles directly, and on the field when it is on. |
| `smoke` | A **source**: injects `density` (0–8 a second) at `heat` (0–100) into the field at its point, so smoke comes from places you choose. Needs `forces.fluid.model: "smoke"`. `strength: 0` makes it pure material lifted by buoyancy. |
| `burst` | A **pulse**: a radial blast at `pulseStart` s, repeating every `pulseEvery` s (`0` = once), throwing what is inside `radius` outward at `push` px/s, particles and field alike. `strength` is not read. |
| `layer` | **Layer Velocity**: another layer's own motion (keyframes, motion path, parenting, in 3D) drags the particles inside `radius`, and pushes the field. `fromItemId` names that layer (needed); `spinDrag` (default `true`) lets its rotation and scaling whip what is near it, `false` keeps only its travel. Moving that layer's keyframes re-bakes. |

Every entry: `id`, `position` px `{x, y, z}`, `radius` px, `strength` 0–2,000 (a `jet`, `vortex` or `layer` entry at `0` does nothing),
`motion` `hold` \| `orbit` \| `sweep` with `motionSpeed` 0.1–3 and `motionRadius` px (the point circles, or sweeps side to side).

## Emit from a layer: dissolve a picture into its pixels

With `shape: "layer"` particles are born on the opaque pixels of a picture and can keep each pixel's colour. The picture is drawn at
most 512 px on its long side (fine detail softens), every pixel with alpha above 8 counts, and a table of sites is picked from them:
`2 × maxParticles` sites, at least 1,024 and at most 8,192 (with Grow, exactly `maxParticles`). Births walk that table, so density
is the number of opaque pixels in an area (alpha does not weight it), and with more than 4,096 particles at once some share a
site. The artwork is a
**snapshot on the emitter**: the source layer can be trimmed, hidden or deleted; `fromItemId` and `sourceName` only find it again
to refresh the snapshot.

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

`source` is one of (the same snapshot shape is used by `objects.members`, `collision` and `proximity.sources`):

- `{ "kind": "image", "url": "/media/admin/{board_id}/logo.png", "aspect": 1 }`: a file or link (`asset:`, `/media/…`, https). `url`
  is cut at 2,048 characters, so a data URL does not fit.
- `{ "kind": "video", "url", "aspect", "poster" }`: sites come from the `poster` still (or the first frame); with
  `colorMode: "source"` the colours follow `render.colorSourceTime`.
- `{ "kind": "text", "text" (≤ 200 chars), "fontFamily", "fontWeight" 100–1000, "fontSize" 4–2000, "lineHeight" 0.5–4, "color" }`
- `{ "kind": "shape", "points": [{x, y, hIn?, hOut?}] (2–256, unit space), "closed", "fill", "stroke", "strokeWidth", "aspect" }`:
  `aspect` is the layer box's height ÷ width; `strokeWidth` is a fraction of the artwork's width (0.02 = 2 %); an empty `fill` draws
  white, so an outline only is `"fill": "transparent"` with a `stroke`.

What makes it read as a dissolve rather than a leak (the panel's Pick a layer writes the first four):

- `emitter.size` = the layer's on-screen rect and `emitter.position` = its position: anything else reproduces the shape at the wrong
  scale and place;
- `solver.preRoll: 0`, `rate: 0`, one burst of the full `maxParticles` at `time: 0`, `speed: 0`: the picture is whole at frame 0 and
  the forces take it apart;
- `render.size.start` / `.end` ≈ `2.6 × sqrt(rectW × rectH / maxParticles)`, so the picture reads solid before it breaks up;
- `render.colorMode: "source"`: each speck takes the colour of its pixel;
- a `colorOverLife` that is opaque first and fades late.

The source layer does not disappear: hide it, trim it or fade it out at the moment the particles take over.

**Several layers.** `emitters[0].source` is the first; `emitters[0].sources[]` holds up to three more, each `{source, sourceName,
fromItemId, size {x, y}, position {x, y}, followTimeline}` with its own rect. Sites are shared by artwork area, so a word and a full
stop keep the same density. `followTimeline` (on the first source: `emitters[0].followTimeline`; default `false`, needs `fromItemId`)
stops that source emitting outside its layer's span on the timeline. Grow uses the first source only.

## Grow: a front that releases the picture (`activation`)

`mode: "immediate"` (default): rate and bursts decide and the rest of the block is inert. `mode: "grow"` (a `layer` emitter only)
sweeps a front through the artwork, the same arrival field Grow Fill uses, and births or releases each site's particle as the front
reaches it: `rate`, `bursts` and `preRoll` are ignored and every particle has its own site.

| Field | Range | Meaning |
| --- | --- | --- |
| `inactive` | `frozen` (default) \| `hidden` | `frozen`: every particle stands on its pixel from frame 0 (the layer reads as the artwork) until the front releases it; its life starts then. `hidden`: nothing exists until the front arrives, so the picture builds out of nothing. |
| `start` / `speed` | 0–100 % / 0–400 %/s | Where the front is at frame 0, and how fast it travels (`0` never moves). |
| `reverse` | bool | Runs the sweep backwards. |
| `softness` | 0–60 % | Dithers the front into a band. |
| `from` | `left` \| `right` \| `top` \| `bottom` \| `center` \| `scatter` | Where it starts. |
| `seedCount` / `seedStagger` / `points` | 1–8 / 0–100 % / ≤ 8 `{x, y, delay 0–1}` | Start points, the delay between them, or hand-placed seeds in the emitter's unit space (−0.5…0.5, +y up). |
| `speedMap` + `noiseScale` / `noiseContrast` / `noiseSeed` | `uniform` \| `turbulent` | An uneven front. |
| `bridges` / `bridgeReach` / `bridgeSlow` | bool / 1–80 px / 1–12× | Lets the front jump to a detached piece. **The reach must clear the gap between letters**, or each glyph is an island and only the seeded one ever activates. |
| `ignite` / `igniteBoost` / `igniteMode` / `igniteColor` / `igniteRamp` | 0–4 s / 0–400 % / `flash` \| `solid` \| `gradient` / colour / ramp | A flare on a just-released particle. Drawn: tuning it never re-bakes. |

## Layers as particles (`objects`)

With `render.mode: "layers"` each particle stamps one of up to 12 members instead of a sprite. Drawn only: adding, removing or
resizing members never re-bakes (except with `packing` on). Stamped artwork needs far fewer particles than dots: the panel thins
a system to 260 when the first member is set.

`members[]`: `{ id, name, fromItemId?, source, included, weight 0–10, sizeScale 0.05–20, spinScale 0–20 }`, where `source` is the
snapshot shape above; a member without usable artwork is dropped. Block fields: `pick` `cycle` \| `random`; `facing` `billboard` \|
`tumble` \| `velocity`; `size` px (1–4000); `sizeRandom` 0–1; `spin` 0–20; `keepRatio`; `tint` (multiply the artwork by the life
ramp; `colorMode: "source"` does not apply to members); `playVideo` (default `false`: a video member is its still; `true`: every
particle shows the video's current frame).

## Lines: trails and ready-made rows

`render.mode: "lines"` joins particles into ribbons. The simulation is unchanged (every force, the fluid and Return bend a line by
moving its particles) and `render.lines` is drawn only. Lines keep the layer on the bake.

- **`connect: "time"`: trails.** Each particle draws its own recent path, read from the bake.
- **`connect: "rows"`: ready-made lines.** Needs `emitters[0].shape: "rows"` with `rows: { count 1–400, points 2–1000 }` (count ×
  points ≤ 50,000) spread over the emitter's `size`, all placed at `start`, at rest (row 0 is the top). Rows never die of age and
  never stir the fluid; `solver.maxParticles` becomes count × points. Each row is whole from the first frame and bent by the forces.
  Use `bounds.behavior: "bounce"`: a point killed at a wall splits its row. With any other emitter shape, `rows` draws trails.

| `render.lines` field | Range | Meaning |
| --- | --- | --- |
| `width` / `widthRandom` | 0.1–400 px / 0–1 | Ribbon width; per-line jitter. |
| `taperStart` / `taperEnd` / `profile` | 0–1 / 0–1 / `linear` \| `smooth` \| `swell` | Thinning at the head / tail of a trail, the left / right end of a row; `swell` is fattest mid-line. |
| `speedWidth` / `movedWidth` | −1–1 / 0–3 | Width by speed (over `render.velocityRange`); extra width by distance moved from birth (over `movedRange`). |
| `length` / `shape` | 0.02–60 s / `trail` \| `full` | Seconds of path a trail shows; `full` = since birth. |
| `end` / `stayFade` | `cut` \| `retract` \| `stay` / 0–60 s | What a trail does when its particle dies; `stay` with `shape: "full"` turns particles into pens; `stayFade: 0` keeps it. |
| `share` | 0.01–1 | Fraction of particles that get a trail; keep dense systems near 1,500 trails. |
| `tailFade` / `fadeCurve` | 0–1 / 0.1–6 | Alpha falloff toward the tail. |
| `pinEnds` | 0–0.5 | Rows: share of each row's length, per end, held on its rest line. |
| `smooth` | 1 \| 2 \| 4 \| 8 | Most curve sub-samples between neighbouring points. |
| `colorMode` | `particle` \| `along` \| `moved` | `particle`: the particle's colour at each point; `along`: `colorStart` → `colorEnd` head to tail (rows: top row to bottom row); `moved`: `colorStart` at rest → `colorEnd` at `movedRange` px from birth. |
| `showParticles` | bool | Also draw the sprites (`render.size`) under the lines. |

`render.blend` and `render.opacity` apply to lines. *Smoke Lines* (`preset: "smoke-lines"`), lines bent by a plume:

```json
{
  "schemaVersion": 4, "preset": "smoke-lines", "seed": 7,
  "solver": { "preRoll": 0, "bounds": { "shape": "box", "size": { "x": 2304, "y": 1296, "z": 240 }, "behavior": "bounce" } },
  "emitters": [{ "emit": "static", "shape": "rows", "position": { "x": 0, "y": 0, "z": 0 }, "size": { "x": 1920, "y": 972, "z": 0 },
    "rows": { "count": 100, "points": 160 }, "detach": true, "stir": { "strength": 0, "radius": 120 }, "variance": 0 }],
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

Move the plume with the smoke source's `position` / `motion` (`sweep` ripples the rows); `return.strength` sets how far a row is
pulled before it settles (0 = carried off with the smoke).

## Collision and containers (`collision`, `colliders`)

A layer's artwork as a solid, extruded `depth` px through the box. `collision` is the first collider; `colliders[]` holds up to 3
more of the same shape. Any collider keeps the layer on the bake.

| Field | Range | Meaning |
| --- | --- | --- |
| `source` | snapshot | The artwork (the [source shapes](#emit-from-a-layer-dissolve-a-picture-into-its-pixels)); `null` = no collider. With `sourceName` and `fromItemId`. |
| `faces` | `outer` (default) \| `inner` | `outer`: an obstacle (particles bounce, the flow routes round it). `inner`: a container (emission is clipped to it, particles stay inside): a text source gives particles inside letters. |
| `bounce` | 0–1 | Speed kept at a contact. |
| `depth` / `size` / `position` / `rotation` | px / px (width) / px `{x, y}` / ° | Where the artwork lies in the box. Filled in when the layer is picked; without `follow` they stay put whatever the layer does. |
| `follow` | bool (default `false`, needs `fromItemId`) | The collider tracks that layer's artwork, position, scale and rotation every step (keyframes and parenting included), and exists only inside that layer's span on the timeline (hiding the layer does not remove it). `size` / `position` / `rotation` become the fallback for a deleted layer. A moving collider re-bakes whenever its pose changes, and it steers the particles only: the fluid passes through it. |
| `releaseOutside` | bool (default `false`) | A container stops gathering particles already outside it. Turn it on when the collider arrives part-way through a shot, or it inhales the cloud. |
| `open` | `{side none \| top \| bottom \| left \| right, spread 1–180°, at s, fade s}` | A container lets particles out through one side from `at`, taking `fade` seconds to open; `spread` is how much of that wall becomes a doorway. Sides are the frame's; `bottom` opens the floor of every stroke of a letter, and what leaves stays out. |

Several colliders: a particle stays outside every obstacle and inside every container, and emission is clipped to the containers'
intersection (two containers that do not overlap cannot both be satisfied). Only the first fixed collider shapes the fluid. Two
`follow` colliders on two spans give different collisions over time with no keyframes. The collider's field is a 384×216 grid
scaled by the box's width: keep `bounds.size` near 16:9 or it is distorted along the short side.

## Particles that pile up (`packing`)

Particle-to-particle collision: a pour, a pile, a jar of beads, a mould filling up. **Off by default; leave it off unless the look
needs it.** With it on, the drawn size is the collision radius, so `render.size` (or `objects.size` for layer objects) re-bakes.
It keeps the layer on the bake. Emission refuses births with no room, so raising `rate` past what fits does nothing. Comfortable
to about 6,000 particles. The fluid pushes a pack; the pack does not push the fluid.

`{enabled, shape circle | object, substeps 1–8 (4), iters 1–12 (3), stiffness 0.05–1, gap px, friction 0–2 (0.45), restitution 0–1
(0.05), radiusScale 0.1–3, cohesion 0–2, cohesionRange 0–2, sleep (true), sleepDrift 0–1, sleepFrames 1–240}`

`shape: "object"` (layer objects, a flat box `bounds.size.z` ≤ 2) collides each object as its own outline: letters stack, tip over
and swirl without overlapping, the simulation owns each one's angle (`objects.facing: "velocity"` steers it into its travel), and
`objects.pick`, `spin`, `keepRatio` and each member's `spinScale` re-bake. Several times the cost of circles: tens to a few hundred
objects. In a deep box it collides as circles.

## Follow a path (`pathFollow`)

Particles are pulled onto a spline and flow along it. `{enabled, attract 0–600, flow 0–600, proximity px, swirl 0–400, anchors[]}`:
`attract` pulls toward the nearest point of the path, `flow` pushes along it, `swirl` braids round it, all fading past `proximity`
px. `anchors` (≤ 64) are in the box's unit space (−0.5…0.5); empty uses the emitter's own `path`. Keeps the layer on the bake.

## Proximity: another layer's shape drives the cloud

The distance from each particle to another layer's silhouette drives the particles' look and motion, so a word or logo shapes a
passing cloud along its outline. It acts only when `enabled: true`, at least one source is set and `fx` has at least one entry.
The GPU engine does not read it: keep `maxParticles` at 50,000 or below.

| Field | Range | Meaning |
| --- | --- | --- |
| `sources[]` | ≤ 4 × `{id, source, sourceName, fromItemId, follow, size px, position {x, y}, rotation, pickScale}` | `source` is a snapshot. `follow` (default `true`) takes position, rotation and scale live from `fromItemId` every frame (keyframes, paths, parenting) and acts only inside that layer's span (hiding it does not switch it off); `size` / `position` / `rotation` are the fallback. |
| `measure` | `shape` (default) \| `edge` \| `inside` \| `centre` \| `x` \| `y` | Which distance: to the silhouette from outside (solid inside); either side of the outline; depth into the shape (with `invert`: the core only); to the centre; along the source's own x or y axis (a band). |
| `range` / `falloff` | px | Full influence within `range` (default 90 at 1080p), fading out over `falloff` (340). Tune `falloff` against the artwork's thinnest feature: a 300 px band round 55 px strokes is a blob. |
| `shape` / `combine` | `smooth` \| `linear` \| `sharp` / `max` \| `add` \| `average` \| `min` | The falloff curve; how several sources combine. |
| `depth` | px | `0`: flat (the whole depth of the box). Above 0: a slab of that half-thickness. |
| `invert` | bool | Swaps near and far. |
| `colorMode` / `color` / `colorRamp` | `solid` \| `ramp` | What the `color` amount paints: one colour, or a ramp read by distance. |
| `fx` | `{ key: amount }` | What the field drives, below. |

| `fx` key | Range | Kind |
| --- | --- | --- |
| `size` / `opacity` / `color` / `spin` / `bright` / `stretch` / `twinkle` | % (`spin` in °) | **Look**: drawn, never re-bakes. With `packing` on, `size` re-bakes (it is the contact radius). |
| `attract` | −6000–6000 px/s² | **Sim**. Positive pulls particles onto the shape along its true outline normal; negative pushes them away (the panel adds it at −2200, a repel). |
| `flow` / `orbit` | −6000–6000 px/s² | **Sim**. Along the outline; round the source's centre. |
| `drag` / `speed` / `turb` / `life` | 0–24 / % / % / % | **Sim**. Extra drag; speed, turbulence and lifetime scaled where the field is full. |
| `freeze` | 0–100 % | **Sim**. `100` stops particles dead where the field is full, which paints the silhouette out of a passing cloud. |

**Animating it.** `propertyKeyframes: { "px:<param>": [...] }` on the particle item: `range`, `falloff`, `depth` and every key present
in `fx` take an ordinary numeric track (easings, HOLD, the graph editor, `propertyKeyframeFx`; [video-keyframes.md](video-keyframes.md)). A
track on a look amount never re-bakes; one on a sim amount, or on `range` / `falloff` / `depth` while a sim amount is set, re-bakes
like editing the number does. An amount stored at 0 and keyed away from 0 does reach the simulation. `measure`, `shape`, `combine`,
`invert` and the colour fields take no tracks; a source's pose is animated by keyframing the source layer with `follow: true`.

## A logo made of particles, and a morph between shapes

**A logo that holds, then comes apart.** A `layer` emitter on the logo with the dissolve settings
([above](#emit-from-a-layer-dissolve-a-picture-into-its-pixels)), `lifetime` longer than the layer, and every Dust motion
zeroed (`wind` 0, `turbulence.strength` 0, `drag` 0) so it stands still; then a `burst` force emitter, a keyed source layer for
Layer Velocity, or Grow (`inactive: "frozen"`) takes it apart. `forces.return` brings it back together after a gust.

**A logo that builds out of nothing.** Grow with `inactive: "hidden"`: the front births each particle on its pixel. Or an ambient
cloud and a Proximity source on the logo with `fx.attract` positive, then `fx.freeze: 100` once it has arrived.

**A morph between shapes** (galaxy → sphere → ring): one system, and one hidden guide layer per shape, placed one after another on
the timeline. Each guide is a `proximity.sources[]` entry with `follow: true` and its `fromItemId` (up to 4); a followed source acts
only inside its layer's span, so the pull changes shape at each cut with no keyframe. `measure: "shape"`, a positive `fx.attract`
with `fx.drag`, and `px:attract` / `px:drag` / `px:falloff` keys to ease each capture in and out; `px:size` / `px:bright` are free.
Shape guides are `kind: "shape"` sources (a ring is a stroke with `"fill": "transparent"`). Inside a filled shape the pull keeps
going toward its centreline and particles bead on it: ease `attract` down once the cloud has arrived and fill with `fx.turb` or
hold it with `fx.freeze`. Keep `bounds.size.z` small (about 140, `bounce`) so a flat shape stays flat when the camera tilts.

**The look.** Additive particles add up to white blobs and do not look clean: use `blend: "alpha"` with small round dots
(`stretch: 0`), and make the light with one Deep Glow on an adjustment layer above them (`glow` with `thresholdBy: 0`,
`glowThreshold` about 30 so the background stays dark, `tonemap: 2`; [effects-overlay.md](video-effects.md#deep-glow-glow)).

## What re-bakes and what is free

**Re-bakes** (simulation inputs): `seed`; the layer's length; `solver` except `engine`; all of `emitters[0]` (the layer artwork, the
other sources, `rows`, `distribution` unless it is `random`); all of `forces` (`fluid`, `draft`, `return` included);
`forceEmitters` and the animation of a Layer Velocity layer; `pathFollow`; `collision` and `colliders` and a followed collider's
layer animation; `packing` when enabled, with the sizes and object fields it reads; `activation.mode`, `inactive`, `start`, `speed`,
`reverse`, `softness`, and the front's seeds, map and bridges; Proximity when an `fx` sim amount is set (its field numbers, the sim
amounts, their `px:` tracks and the source layers' animation).

**Free** (drawn): all of `render` (`mode` and `lines` included), `objects`, `quality`, `solver.engine`, `activation.ignite*`, and
Proximity's look amounts and colour, all unless `packing` is on for the sizes. "The same motion, a different colour" is instant and
the same simulation.

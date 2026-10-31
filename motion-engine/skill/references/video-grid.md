> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GreenLight Dash — Grid layers

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts. Load only the sections needed for the task.

## Contents

- [Grid layers (`mediaType: "grid"`) — Grid Builder](video-grid.md#grid-layers-mediatype-grid--grid-builder)

### Grid layers (`mediaType: "grid"`) — Grid Builder

A **grid** is a container like a sequence — same `sequence: { clips, channels }` payload, same
offscreen pre-render, so it transforms, animates and takes effects **as one layer**. What differs
is that its inner channels are **cells**: exactly **one member per channel**, and the grid decides
where each one is drawn from a layout rule on the timeline **item** (`gridConfig`).

The grid owns **only PRS** (position / rotation / scale). A member keeps its own stored
`panX`/`panY`/`rotateZ`/`zoom` untouched — the layout replaces them at draw time — which is why
ungrouping restores every layer exactly as it was. Everything else about a member (text, colours,
filters, effects, opacity, timing) is still its own.

```json
// clip — one channel per cell, each holding exactly one item at freeStart 0
{
  "id": "grid1", "source": "REMOTE", "mediaType": "grid", "url": "", "proxyUrl": null,
  "name": "Grid", "duration": 6,
  "sequence": {
    "clips": [
      { "id": "gi1", "source": "REMOTE", "mediaType": "image", "url": "/media/admin/{board_id}/a.jpg", "name": "A", "duration": 6 },
      { "id": "gi2", "source": "REMOTE", "mediaType": "image", "url": "/media/admin/{board_id}/b.jpg", "name": "B", "duration": 6 }
    ],
    "channels": [
      { "id": "gc1", "name": "A", "visible": true, "unsnapped": true,
        "items": [{ "id": "gm1", "clipId": "gi1", "freeStart": 0, "trimStart": 0, "trimEnd": 6 }] },
      { "id": "gc2", "name": "B", "visible": true, "unsnapped": true,
        "items": [{ "id": "gm2", "clipId": "gi2", "freeStart": 0, "trimStart": 0, "trimEnd": 6 }] }
    ]
  }
}
```

The layout rule lives on the **parent timeline item** as `gridConfig` (every field is optional —
missing ones take the default shown, and out-of-range values are clamped on load):

```json
"gridConfig": {
  "version": 1,
  "mode": "current",           // current | rect | radial | spiral | wave | scatter | sphere | path

  // shared
  "order": "stack",            // stack | reverse | name | random — which member takes which cell
  "showGuide": false,          // dashed line through the cells in layout order — preview-only, never rendered into exports
  "seed": 1234,                // every random is SEEDED; the same seed always lays out the same way
  "fit": "contain",            // contain | cover | stretch | none ("none" = keep the layer's own size)
  "cellPadding": 6,            // % inset from the cell box, per side
  "cellScale": 100,            // % multiplier applied after the fit
  "cellSize": 0,               // non-rect modes: cell side as % of frame HEIGHT (0 = auto from member count + frame, NOT the arrangement's spread, so radius changes never rescale cells)
  "orient": "forward",         // forward (keep the member's own rotation) | center | screen | path
  "cellRotateX": 0, "cellRotateY": 0, "cellRotateZ": 0, // degrees — rotates EVERY card together, in each card's own frame, on top of orient; keyframable as gr:cellRotate*
  "scaleStagger": 0,           // % per cell — cell 0 keeps cellScale, cell j scales by 1 + j·stagger
  "rotateStaggerX": 0, "rotateStaggerY": 0, "rotateStaggerZ": 0, // degrees per cell, own-frame like cellRotate*: cell j turns by j·stagger
  "staggerBackward": {},       // { "<stagger key>": true } — that stagger walks from the LAST cell instead
  "jitterPos": 0, "jitterRot": 0, "jitterScale": 0,     // seeded; % of the cell / degrees / %

  // current — no parameters of its own: each cell is read from the member's OWN
  // stored position (panX/panY/panZ, or its live motionPath), so the grid moves
  // nothing. Paired with "fit": "none" it is a complete no-op, which is how a grid
  // is created from existing layers without disturbing them. `order` still decides
  // which member takes which cell, so "reverse" swaps layers between the spots
  // they were already in.

  // rect
  "cols": 0,                   // 0 = auto (ceil(sqrt(n)))
  "gapX": 4, "gapY": 4, "marginX": 8, "marginY": 8,     // % of the frame
  "fillOrder": "row",          // row | col | boustrophedon (snake)
  "rowOffset": 0, "colOffset": 0,                       // brick / honeycomb, % of a cell pitch
  "alignLast": "center",       // center | start — a short final row

  // radial
  "radius": 30, "rings": 1, "ringSpacing": 12,          // % of frame height
  "radiusStagger": 0,          // % of frame height added per cell: cell 0 on Radius, cell 1 at +stagger, cell 2 at +2·stagger … — the ring coils in/out
  "startAngle": -90, "sweep": 360, "spin": 0,           // degrees

  // spiral
  "spiralType": "phyllotaxis", // phyllotaxis (sunflower) | archimedean (coil)
  "spiralRadius": 35, "spiralTurns": 2.5,

  // wave
  "waveAmp": 12, "waveFreq": 1, "wavePhase": 0,

  // wave / spiral / path
  "twist": 0,                  // degrees — rolls cells about the direction of travel, spread over the run; 360 = one full ribbon twist

  // scatter
  "scatterDepth": 0,           // px of random z spread

  // sphere
  "sphereRadius": 300, "sphereSpinY": 0, "sphereTiltX": 0,

  // path — same point shape as item.motionPath (world pixels, centre origin).
  // Omit it and the grid rides the ITEM's own motionPath instead, which is what
  // the UI does: the shipped on-canvas path editor is the grid's path editor.
  "path": { "points": [{ "x": -400, "y": 0, "z": 0 }, { "x": 400, "y": 0, "z": 0 }], "closed": false },
  "pathSpacing": "arc",        // arc (equal distance along the curve) | segment
  "pathTrimStart": 0,          // % — the usable stretch of the curve
  "pathTrimEnd": 100,
  "pathProgress": 0,           // % into that stretch where the cells start (animate to travel; wraps on a closed curve)
  "pathSpread": 100,           // % of the trimmed stretch the cells occupy

  // depth + scale distribution (After Effects' Transform block). A 28° lens only
  // changes a cell's size by a few percent over a 600px shell, so Scale front /
  // Scale back is what actually sells a 3D arrangement.
  "zDepth": 0,                 // px spread through Z, front to back along the layout order
  "zAnchor": 0.5,              // 0..1 — which end of the run sits on the camera plane
  "scaleBy": "off",            // off | index | depth | distance
  "scaleFront": 0,             // % added at the near end
  "scaleBack": 0,              // % added at the far end (negative makes far cells recede)

  // ── effectors ──
  // One effector at a time: it produces an influence 0–1 per cell, and every key
  // in `fx` is blended from the cell's normal value toward that amount by it.
  "effector": "off",           // off | focus | proximity
  "effectorInvert": false,     // affect what is FAR instead (blur everything but the focus)
  // focus — an animatable cell index with a falloff around it
  "focusTarget": "index",      // index (animatable focusIndex) | first | last | center — the latter three follow the member count
  "focusIndex": 0, "focusFalloff": 3,
  "focusShape": "smooth",      // smooth | linear | ripple | step
  "focusMeasure": "index",     // index | row | column | distance
  "focusRipples": 2, "focusWrap": false,
  // proximity — distance to OTHER timeline layers, referenced not moved
  "proxSources": ["<timeline item id>"],   // max 8; they keep their channel and their own keyframes
  "proxRange": 260, "proxFalloff": 420,
  "proxShape": "smooth",       // smooth | linear | sharp
  "proxMeasure": "2d",         // 2d | 3d | x | y
  "proxCombine": "max",        // max | add | average
  // what the live effector drives — presence IS the on switch, the value is the
  // amount a FULLY effected cell gets, added on top of the layer's own value.
  // transform: scale % | opacity % | rotate ° | z px | lookAt % (proximity only)
  // filter:    blur px | brightness % | contrast % | saturate % | hue ° | grayscale % | sepia %
  "fx": { "scale": 60, "blur": 8 },

  // per-cell reveal — NOT keyframes: a pure function of this layer's own progress
  "revealPreset": "none",      // none | fade | pop | rise | spin | flyCenter | flyEdge | flyRandom
  "revealDuration": 0.6,       // seconds, for ONE cell
  "revealStagger": 0.05,       // seconds between cells (negative runs the wave backwards)
  "revealStaggerBy": "index",  // index | ring | distance | random
  "revealEase": "Power2 Out",
  "revealOut": false,          // cells leave again before the layer ends, in the same order

  // ── layout slots + morph (Grid Morph) ──
  // An ordered list of layout families; `layoutMix` travels it and the fractional
  // part morphs the two adjacent layouts PER CELL (cell i of the rect travels to
  // cell i of the sphere — order/seed are shared so the mapping is identical on
  // both sides). Each slot holds `mode` plus ONLY that mode's GRID/PATH-section
  // fields (same names/ranges as above); everything else — fit, orient, cells,
  // depth, effectors, reveal, order, seed, path.points — stays shared on this
  // config and rides continuously through a type change. Max 8 slots.
  "layouts": [
    { "mode": "rect", "cols": 0, "gapX": 4, "gapY": 4, "marginX": 8, "marginY": 8,
      "fillOrder": "row", "rowOffset": 0, "colOffset": 0, "alignLast": "center" },
    { "mode": "sphere", "sphereRadius": 420, "sphereSpinY": 0, "sphereTiltX": 0 }
  ],
  "layoutMix": 0,              // 0…layouts.length-1 — keyframe `gr:layoutMix` to morph; integer = exactly that slot (single layout evaluated); a Hold key hard-cuts
  "morphStagger": 0.35,        // 0–0.9 — spreads the move across cell ranks (0 = all cells slide together)
  "morphStaggerBy": "index",   // index | ring | distance | random — ranked on the layout being LEFT
  "morphEase": "Power2 Smooth",// per-cell ramp (TransitionEasing name)
  "morphArc": 60,              // px — bulges each cell's travel outward mid-move (negative implodes); exactly zero at both endpoints
  "morphSpin": 0               // whole turns added over the blend; integers land back on themselves
}
```

Rules:

- **One member per inner channel.** A channel with two items renders only the first; put every
  member on its own channel. Channel ORDER is cell order is z-order.
- **Exclude a member** by setting its channel's `"visible": false` — the layout closes up and the
  remaining cells renumber. The member stays inside the grid.
- **Cap: 64 members.** Every cell costs a channel state with two meshes and two `<video>` elements.
- **Grid parameters are keyframable** as `gr:<key>` tracks in the parent item's `propertyKeyframes`
  (numeric only) — e.g. `"gr:radius": [{ "position": 0, "value": "5" }, { "position": 100, "value": "40" }]`
  opens a ring. Only the keys the CURRENT `mode` reads have any effect; see the field list above.
  With `layouts` present, a keyframed geometry key overrides BOTH sides of the blend — use slot
  values for static differences between layouts and `gr:` tracks for animation over time.
- **Morphing the layout type**: set `layouts` (2+ slots) and keyframe `"gr:layoutMix"` — e.g.
  `[{ "position": 0, "value": "0" }, { "position": 50, "value": "1" }, { "position": 100, "value": "2" }]`
  travels rect → sphere → whatever slot 2 is, as one continuous per-cell morph. A key with
  `"easing": "Hold"` freezes the mix until the next key (a hard cut). `morphStagger`/`morphArc`/
  `morphSpin` are also `gr:` keyframable.
- **Even mix keys** are the convention for an N-slot morph: one `gr:layoutMix` key per slot every
  `100/N` percent (2 slots → 0/50 %, 3 → 0/33/67 %). Follow it unless the move needs its own rhythm.
- **`duration` is derived** from the nested channels on load, like a sequence. Members that end
  before the grid does simply leave their cell empty.
- **Deterministic.** `mode`, `seed`, the member list and the item's progress fully determine the
  frame, so preview, the editor's Download and `/render-onserver` are identical.
- **A member has NO usable PRS of its own:** its TRANSFORM fields, its PRS keyframe tracks
  (`scale`, `scaleX`, `scaleY`, `rotate`, `rotateX/Y`, `translateX/Y/Z`, `xPercent`, `yPercent`, `motionPathT`) and its
  `motionPath` are all inert — the layout replaces them. Writing them through the API is harmless
  but has no visible effect until the layer leaves the grid. The one exception is
  `mode: "current"`, which READS the member's stored `panX`/`panY`/`panZ` (or its live
  `motionPath`) — that is the whole layout — though still only as a static starting point, since
  the member's own keyframes are not evaluated for it.
- **`orient: "screen"`** squares each cell to the camera's real position, not just to +Z; it is the
  one to use once cells sit at different depths.
- **Mismatched aspect letterboxes transparently.** A member whose aspect ratio differs from its
  cell box letterboxes/pillarboxes with fully TRANSPARENT bars under `contain` (and under
  `none`/`stretch` where spare quad shows); `cover` fills the cell and crops. A member's own
  `backgroundColor` still paints its plate when set.
- **A grid is REAL 3D.** Its cells are filmed by the project camera itself: the inner
  scene is rendered through the posed camera moved into the grid's space (G⁻¹·C), and the result
  is composited screen-aligned. So the whole item transform (`panX/Y/Z`, `rotateX/Y/Z`, `zoom`,
  and their keyframes) moves the ARRANGEMENT in three dimensions, camera pans produce real
  parallax between cells at different z, a dolly travels *through* the arrangement (into a
  sphere's interior), and the 3D world view shows the member meshes in space rather than a plate.
  `orient: "screen"` aims each card at the lens's true position at any angle and follows camera
  roll. Cells clip against the real frustum like ordinary layers (there is no `overscan` field; a
  leftover one in an old config is ignored and dropped on the next save). The plate survives only
  as an intermediate, so the grid item's filters,
  opacity, blend mode, masks and transitions still apply to the flattened result — but motion
  blur on the grid item no longer sees the grid's own transform. `mirrorH/V` flip the picture,
  not the arrangement.
- **PRO at render.** Free to build and preview; a project containing a non-empty grid needs a PRO
  licence to render, the same policy as PRO motion templates and Running Glow.
- **Grouping existing layers is non-destructive** when the grid is created with `"mode": "current"`
  + `"fit": "none"` — nothing moves or resizes until a layout type is chosen. That pairing is also
  the natural slot 0 of a morph: `layouts: [{ "mode": "current" }, { "mode": "radial", … }]` plus a
  `gr:layoutMix` track travels the layers from where they are into a ring. A grid built empty has
  no arrangement to preserve, so `rect` is the sensible start there.
- **Dissolving a grid** is lossless: members carry the exact transform they went in with, because
  the layout only ever supplied PRS at draw time.

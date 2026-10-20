# Effect package runtime contract

## Contents

- [Package layout](#package-layout)
- [Descriptor](#descriptor)
- [Engines](#engines)
- [Params](#params)
- [GLSL shading (WebGL)](#glsl-shading-webgl)
- [TSL shading (WebGPU)](#tsl-shading-webgpu)
- [Passes](#passes)
- [Images](#images)
- [Orientation](#orientation)
- [Determinism and cost](#determinism-and-cost)
- [The check and its status](#the-check-and-its-status)
- [Limits](#limits)

## Package layout

A bare `<id>.js`, or a `.gleffect` (zip) holding `effect.js` at its root, an optional `assets/`
folder (the package's images) and an optional `manifest.json` (ignored on install: the editor
publishes the metadata itself once it has checked the package). One wrapper folder is accepted.
Source limit 512 KB. The module imports nothing: everything a package needs arrives in its shading
context, and the loader rejects any `import`.

## Descriptor

Named exports, also gathered in the default export:

| Export | Required | Meaning |
|---|---|---|
| `id` | yes | kebab-case; the effect's project id is `local:<id>`. Re-importing the same id replaces the install, and projects keep their entries. |
| `name` | yes | Display name, published in capabilities. |
| `params` | yes | Array, possibly empty — see [Params](#params). |
| `fragment` | for WebGL | GLSL string defining `vec4 fx(vec2 uv)`. |
| `fragmentNode` | for WebGPU | `fragmentNode(ctx)` returning a vec4 node. |
| `passes` | instead of the two above | Several shading passes — see [Passes](#passes). |
| `renderer` | no | `'webgl'`, `'webgpu'` or `'both'`; must agree with the exports. Omitted, it is derived from them. |
| `textures` | no | Package images — see [Images](#images). |
| `description` | no | One line, published in capabilities. |
| `animated` | no | `false` when the effect never reads time. Defaults to `true`. |
| `scopes` | no | `['layer']`, `['adjustment']` or both (the default). `layer` restyles one item; `adjustment` restyles everything below an adjustment item. |
| `layerMatte` | no | `'clip'` keeps the result inside the layer's silhouette by default (generators: scanlines, grain, tints); `'expand'` lets it draw outside (glows, displacement). Each instance can still override with its `clip` field. |

## Engines

| Exports | `renderer` | Draws on |
|---|---|---|
| `fragment` | `'webgl'` | WebGL only |
| `fragmentNode` | `'webgpu'` | WebGPU only |
| both | `'both'` | either engine — the editor uses the one matching its engine |

Nothing translates GLSL to TSL or back. A package with one shading is skipped on the other engine,
and its card says why. Ship `'both'` when the user may switch engines, or when a project should
render the same on any machine; the two shadings must draw the same picture, so port one from the
other line for line (the starters are written side by side for that) and check both stills.

## Params

| `type` | Fields | Value the shader reads |
|---|---|---|
| `range` / `number` | `min` < `max`, `default`, optional `step`, `suffix`, `static` | the number |
| `select` | `options: [{ value: number, label }]`, `default` | the chosen `value` |
| `switch` | `default: true/false` | `1` or `0` |
| `color` | `default: '#rrggbb'` | an RGB vector, 0–1 |

- Keys are letters, digits and `_`, starting with a letter — they are also GLSL names.
- At most **16** number-like params (`range`, `number`, `select`, `switch`) and **5** colours.
- Every `range`/`number` param is keyframable as `fx:<eid>:<key>` unless it is `static: true` (use
  that for values that would not make sense animated). Selects, switches and colours are static.
- Params are written to the shader every frame; the editor clamps them to `min`/`max`.

## GLSL shading (WebGL)

The `fragment` string defines `vec4 fx(vec2 uv)` and is compiled between the same prelude and wrapper
as every built-in effect.

- **Params:** `P_<key>` is the number, `C_<key>` the colour (`vec3`). Do not read `uParams` by index.
- **Uniforms:** `uTexture` (the layer, or the below-stack on an adjustment layer — premultiplied
  colour), `uResolution` (target size in px), `uTime` (clip-local seconds, restarting inside an
  active range), `uProgress` (0–1 across the clip), `uQuality` (1 when rendering, 0.5 while the
  preview plays — scale tap counts by it).
- **Images:** `T_<key>` (a `sampler2D`) — see [Images](#images).
- **Helpers:** `luma`, `hash21`, `unpremult(vec4) → vec3`, `premult(vec3, a) → vec4`,
  `sampleClamped`, `rot2`, `hueShift`, and the layer-box helpers `fxLocal`, `fxFrame`, `fxDir`,
  `fxRes`, `fxAspect`, `fxCoord`.
- **Return** premultiplied colour (`premult(rgb, a)` after working on `unpremult(sample)`). The
  editor blends the result with the input by the instance's Mix — never blend against the source
  yourself.
- Write GLSL ES 1.00 style, as the built-ins do: `texture2D`, no `out` variables, no `#version`.
  Do not redeclare prelude names.

## TSL shading (WebGPU)

`fragmentNode(ctx)` is called inside the effect material, as a built-in effect's body is. `ctx`:

| Field | What it is |
|---|---|
| `tsl` | The whole TSL namespace (`vec2`, `vec3`, `vec4`, `mix`, `sin`, `If`, `Loop`, `wgslFn`, …) |
| `uv` | Fragment uv, 0–1 — sample the layer with it |
| `geoUv` | The same position as GLSL's `uv` (y up) — for hash lattices, maths that must match GLSL, and images |
| `src` | The layer at `uv`, premultiplied (in a pass: the first input at `uv`) |
| `sample(uv)` | Sample the layer anywhere (in a pass: the first input) |
| `input(name)` | In a pass: a named input, `.sample(uv)` |
| `param(key)` | A number param as a float node |
| `color(key)` | A colour param as a vec3 node (0–1) |
| `texture(key, at?)` | A package image at a y-up position (default `geoUv`) — see [Images](#images) |
| `time`, `progress`, `resolution`, `quality` | As the GLSL uniforms |
| `fxLocal`, `fxFrame`, `fxDir`, `fxRes`, `fxAspect`, `fxCoord`, `fxGeoLocal`, `fxGeoCoord` | Layer-box helpers |

Return a premultiplied vec4 node; the editor applies Mix. Control flow (`If`, `Loop`) works, and so
does raw WGSL through `tsl.wgslFn` — the check compiles it on a real WebGPU device.

## Passes

Blurs, glows and anything that needs a result of the picture before drawing it are written as
`passes` instead of one `fragment`/`fragmentNode`:

```js
export const passes = [
  { key: 'bright', inputs: ['source'], scale: 0.5, fragment: `…`, fragmentNode: (ctx) => … },
  { key: 'blurX',  inputs: ['bright'], scale: 0.5, fragment: `…`, fragmentNode: … },
  { key: 'blurY',  inputs: ['blurX'],  scale: 0.5, fragment: `…`, fragmentNode: … },
  { key: 'composite', inputs: ['source', 'blurY'], fragment: `…`, fragmentNode: … },
];
```

- Each pass is the same `vec4 fx(vec2 uv)` / `fragmentNode(ctx)` as a single-pass effect, with the
  same params, images and helpers. The **last** pass draws the output; the editor applies Mix to it.
- `inputs` (1–4 names, default: the previous pass, or `'source'` for the first) are what the pass
  reads: `'source'` (the effect's input), `'matte'` (the layer's own silhouette in layer scope; the
  input in adjustment scope) or an earlier pass's `key`. GLSL reads them as `B_<name>`; TSL as
  `input('<name>').sample(uv)`. `uTexture` / `sample()` is the first input.
- `scale` (a number, or `[x, y]`, from 1/16 to 1) renders a pass smaller — soft intermediates at half
  size cost a quarter. `uResolution` / `resolution` is then that pass's own size. The last pass is
  always full size.
- Keys are GLSL-style names other than `main`, `source` and `matte`. Every pass carries the shading
  for each engine the package supports.
- Helpers built in JS (a `blur(dx, dy)` that returns a GLSL string or a node function) are fine: the
  module runs once when it loads.

See [starter-effect-passes.js](starter-effect-passes.js): a four-pass glow for both engines.

## Images

A `.gleffect` can carry images and bind them as samplers:

```js
export const textures = [{ key: 'grain', file: 'assets/grain.png', wrap: 'repeat', filter: 'linear' }];
```

- Up to **4**; `.png`, `.jpg` or `.webp` under `assets/` in the package. `wrap`: `clamp` (default),
  `repeat` or `mirror`; `filter`: `linear` (default) or `nearest`. A bare `.js` cannot carry images.
- Read with GLSL `texture2D(T_grain, at)` or TSL `texture('grain', at)`. Images arrive premultiplied,
  like the layer.
- **`at` is a y-up position**, the same on both engines: GLSL `uv` / TSL `geoUv` across the frame,
  `fxLocal(uv)` across the layer's box (the image then rides the layer). To tile a 256 px image
  across the layer, scale that position by its size with `wrap: 'repeat'`:
  `fxLocal(uv) * fxRes() / 256.0` (TSL `fxLocal(uv).mul(fxRes()).div(256)`).

## Orientation

A vertical flip is the commonest effect bug, and it hides in symmetric test content. The rule that
keeps both engines upright:

- **Directions and offsets:** build them y-up, exactly as in GLSL, and map them with `fxDir()`
  (pixels → uv, in the layer's own frame): `off = fxDir(dir * amountPx / fxRes())`. They then turn
  with the layer too.
- **Positions:** `fxLocal(uv)` (0–1 across the layer's box, oriented the same on both engines).
- **Lattices and hashes:** `fxCoord(uv)` / `geoUv` in TSL, so a noise field matches GLSL.
- **Images:** at y-up positions, as above.
- Never negate y by hand to "fix" one engine — that is how the two engines end up mirrored.

Check it with asymmetric content at a non-zero angle, in preview and in a render on each engine.

## Determinism and cost

- The shading is a pure function of `uv`, params, `time` and `progress`. The import gate rejects the
  network, DOM, storage, timers, `Date`, `performance`, `Math.random` and dynamic code; use `hash21`
  for randomness.
- One pass (or the declared passes) per frame while the effect is active. Mix 0, disabled, or outside
  the active range costs nothing — no pass runs. Keep tap counts modest, scale them by quality, and
  run soft intermediates at a smaller `scale`.

## The check and its status

The open Video Editor checks every new revision within seconds of the install (the import, an export
or bundle that carries it, a re-import): the import gate, the descriptor, a GLSL compile with line
numbers, then a real compile and render **on each engine the package supports** — a private WebGL2
context, a private WebGPU device — over a test picture with the default params. The result is the
package's `status`:

```
GET /api/effects/local/<id>
→ { "effect": { "id": "…", "modified_at": …, "thumbnail": "/media/effects/…?v=…",
      "status": { "state": "ok" | "error" | "unchecked", "error": "…", "stage": "…",
                  "engines": { "webgl": { "ok": true }, "webgpu": { "ok": false, "error": "WGSL: …", "stage": "wgsl" } },
                  "warnings": ["…"], "checkedOn": "webgl", "checkedAt": "…" } } }
```

- **`unchecked`** — no editor has checked this revision yet. It is checked while the Video Editor is
  open; if it stays unchecked, ask the user to open it.
- **`error`** — `error` is the first failure, `stage` where it happened: `gate`, `module`, `shape`,
  `glsl` (with the line of your `fragment`), `glsl-compile`, `tsl` (a JS error building the node
  graph — an unknown param name, a wrong call), `wgsl` (the WebGPU compiler, with the offending WGSL
  line), `textures`, `render`. `engines` says which engine failed; the other may still be fine. Fix,
  re-import with the same id, read the status again.
- **`ok`** — every engine the package supports compiled and drew. `thumbnail` is that picture.
- **`warnings`** come from the picture: it draws nothing (fully transparent output), it changes
  nothing at the defaults, or it is marked `animated` but never changes over time. Act on them.
- `skipped` on an engine means that machine could not run it (no WebGPU); another editor checks it.
- A package whose check failed on every engine is not offered in the editor; a project that already
  uses it keeps the entry and shows the error on its card.

## Limits

- Up to 8 passes, 4 inputs each; up to 4 images.
- No feedback from earlier frames: every frame is drawn from the current one, so seeking and export
  stay exact.
- Max 4 effects per item, as for built-ins.

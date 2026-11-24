# Executable Advanced Transition runtime contract

Read this before writing or fixing a package's `transition.js`: the package layout and its limits, what the source
may use, the descriptor, the lifecycle, the frame a package draws from, shading for each engine, output and blending,
layer order, media, audio, controls, timing and the checks. The workflow and the install API are in the skill's
SKILL.md.

## Contents

- [Package layout](#package-layout)
- [Imports and execution model](#imports-and-execution-model)
- [Descriptor](#descriptor)
- [Lifecycle](#lifecycle)
- [Frame object](#frame-object)
- [Shading: one engine, one language](#shading-one-engine-one-language)
- [Output and blending](#output-and-blending)
- [SDK surface](#sdk-surface)
- [Compositing and layer order](#compositing-and-layer-order)
- [Media and export](#media-and-export)
- [Audio](#audio)
- [Controls and gallery](#controls-and-gallery)
- [Default timing](#default-timing)
- [Verification](#verification)

## Package layout

```text
my-transition.gltransition
├── transition.js
├── manifest.json
└── assets/
    ├── preview.mp4
    ├── thumbnail.webp
    ├── effect.frag
    ├── object.glb
    ├── overlay.webm
    └── sound.wav
```

One wrapper folder is accepted. Only `transition.js`, `manifest.json` and `assets/` may be in the package; any other
file refuses the import. A bare `transition.js` with no assets also installs as a `.js` file.

Limits: `transition.js` 512 KB; the package 300 MB, 200 assets, 100 MB per asset. Asset types: images (`.png`,
`.jpg`, `.jpeg`, `.webp`, `.gif`, `.svg`), video (`.mp4`, `.webm`, `.mov`), audio (`.mp3`, `.wav`, `.ogg`, `.m4a`),
fonts (`.ttf`, `.otf`, `.woff`, `.woff2`), shader and data files (`.glsl`, `.frag`, `.vert`, `.json`, `.bin`,
`.cube`) and 3D scenes and environments (`.glb`, `.gltf`, `.obj`, `.mtl`, `.hdr`, `.exr`). Each part of an asset path
starts with a letter or digit and holds only letters, digits, `.`, `_`, `-` and spaces (121 characters at most).

`manifest.json` is optional on first import but recommended for immediate agent discovery. It is the
metadata-only descriptor described in the skill's SKILL.md, never shader/source code; an invalid one refuses the
import. The editor validates the executable module and creates or refreshes this manifest when it loads the package;
downloaded packages preserve it.

## Imports and execution model

`transition.js` is a self-contained executable ES module. The only import is the SDK, by name or as a namespace:

```js
import { THREE, createShaderMaterial, createRenderTarget, renderToTarget } from './transition-sdk';
import * as sdk from './transition-sdk';
```

All other functions belong inside the package source: any other `import`, and a dynamic `import()`, refuse the
package. Before it runs a package, the editor reads the source outside comments and strings and refuses it when any
of these words appears, even as a variable or property name: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
`importScripts`, `require`, `eval`, `Function`, `document`, `window`, `globalThis`, `localStorage`,
`sessionStorage`, `indexedDB`, `navigator`, `process`, `Worker`, `postMessage`, `setTimeout`, `setInterval`,
`requestAnimationFrame`, `Date`, `performance`, and `Math.random`. This keeps random-access export deterministic.
Use `frame.timeSec`, `frame.progress`, or deterministic `hashNoise(seed)`.

## Descriptor

```js
export const id = 'liquid-glass-cut';
export const name = 'Liquid Glass Cut';
export const renderer = 'webgpu';
export const defaultDuration = 6;
export const optionDefaults = { amount: 1, tint: '#ffffff', muteSound: false };
export const optionFields = [
  { key: 'amount', label: 'Amount', type: 'range', min: 0, max: 2, step: 0.01 },
  { key: 'tint', label: 'Tint', type: 'color' },
  { key: 'muteSound', label: 'Mute sound', type: 'switch' },
];

export default {
  id, name, renderer, defaultDuration,
  description: 'Package-owned multipass liquid refraction',
  optionDefaults,
  optionFields,
  media: [{ id: 'glass', type: 'video', src: TRANSITION_ASSETS['glass.webm'], trimStart: 0, trimEnd: 1 }],
  audio: { url: TRANSITION_ASSETS['sound.wav'], trimStart: 0, trimEnd: 0.8, volume: 1 },
  createInstance,
};
```

Required: `id`, `name`, a non-empty `description`, `optionDefaults`, `optionFields` and `createInstance`. `id` is
kebab-case (lowercase letters and digits in groups joined by single hyphens, 81 characters at most) and is written
literally as `export const id = '<id>'`: the install is named by it, and the default export's `id` must match. A
descriptor with a legacy `apply()` is refused. Optional: `renderer`, `defaultDuration`, `media` and `audio` (below),
and `thumbnail` / `previewVideo` (a `TRANSITION_ASSETS` URL each) to choose the gallery files instead of the
conventional names.

`renderer` is optional and is either `'webgl'` or `'webgpu'`: the engine this package's shading is
written for. Declaring it is what lets the editor refuse a mismatched project with a message naming
both engines, before the package builds anything. Left out, the engine is inferred from the shading
entry point the source calls — `createGlslMaterialForWebgl` means `'webgl'`, `createShaderMaterial`
means `'webgpu'`, and calling both or neither means no claim, which blocks nothing. Inference cannot
see a hand-built `sdk.THREE.ShaderMaterial`, so a package that builds its own materials should
declare the field rather than rely on it.

`defaultDuration` is optional and measured in seconds. It must be a finite number from `0.05` to
`30`; omitted packages use `1`. GreenLight applies it whenever the user newly selects the package,
then stores that duration on the transition so the user can freely change it. It does not force or
retime transitions that are already saved in a project, and an agent writing a project sets
`transitionDuration` itself. The actual cross-transition overlap is still limited by the available
duration of the two adjacent clips.

## Lifecycle

```js
export function createInstance(init) {
  // Build and cache package-owned scenes, meshes, ShaderMaterials, render targets,
  // loaders, lookup tables, and arbitrary helper functions here.
  return {
    resize({ width, height, renderer, camera }) {},
    render(frame) {},
    dispose() {},
  };
}
```

`createInstance(init)` receives:

- `runtimeVersion` — currently `3`
- `THREE` — core three.js on both engines. Use it for maths and constants; on the WebGPU engine make meshes,
  materials and render targets with the SDK helpers or `sdk.THREE`, which is the build the engine runs
- `sdk` — all SDK helpers
- `renderer` — the actual editor/export renderer: a `WebGLRenderer` on the classic engine, a
  `WebGPURenderer` on WebGPU (`renderer.isWebGPURenderer` tells them apart). A package that declared
  its own `renderer` never sees the wrong one — the runtime refuses the mismatch before this call
- `camera` — neutral composition camera for private passes
- `root` — package-owned `THREE.Group`, already attached above the two clips (see
  "Compositing and layer order")
- `width`, `height`
- `assets` — frozen relative-path → URL map
- `requestRender()` — repaint after async asset initialization

`createInstance` may be async, and must return an object with `render(frame)`. `render(frame)` must be synchronous: a
`render` that returns a promise is an error. A package that throws in `createInstance`, `resize` or `render` stops
drawing for that cut: the editor's console names it (`[transitions] Package "<name>" …`) and the cut plays without
the move. An instance whose package the project no longer uses, or whose package was re-imported, is disposed.

## Frame object

`render(frame)` receives:

- `progress` — eased 0..1 (the item's `transitionEasing`)
- `rawProgress` — linear 0..1
- `timeSec` (`rawProgress × duration`), `duration` — the overlap in seconds
- `options` — the item's `transitionOptions` resolved against `optionFields` (clamped, defaults filled in)
- `width`, `height` — the composition size in px
- `renderer`, `camera`, `root`
- `slot` — `"cross"` for an installed package (the app's own built-in packages also run as entrances `"in"` and
  exits `"out"`)
- `previous` / `current`:
  - `texture` — full-frame, fully composed clip plate including fitting, filters, and item transform. It is
    premultiplied: RGB is already multiplied by alpha, and what the clip does not cover is transparent black
  - `sourceTexture` — undecorated source media texture
  - `mesh`, `material`, `opacity` — raw editor objects when an effect deliberately needs them
  - `bounds` — where the clip sits in the plate, as an NDC box `{ minX, minY, maxX, maxY, width, height }`
    (−1…1, y up), or `null` when it cannot be measured
  - `pictureBounds` — the same box without the clip's letterbox / pillarbox bars (`null` when the clip is turned or
    it cannot be measured)
  - `contentBounds` — the box of the layer's content as its selection box shows it (a text layer's laid-out text
    block); `bounds` for every other layer
  - `empty` — `true` on a side that has no clip (only in the built-in entrances and exits)
- `media.get(id)` → `{ id, texture, ready, width, height, duration, type, src }`, and `media.has(id)`
- `isPlaying`, `exporting`
- `requestRender()`

The package decides whether to hide the supplied clip meshes and emit a finished full-frame mesh,
augment them with particles/3D objects, or render private multi-pass targets and display the result.

## Shading: one engine, one language

Which language a package's shader is written in follows the project's engine, and a package commits
to one of them (SKILL.md, "One package, one engine"). The two entry points are deliberately shaped
the same, so porting a transition between engines rewrites the shader body and nothing else: uniforms
are a plain object of named slots either way, and `render()` writes `.value` identically.

Each entry point refuses to build a material the live engine cannot draw, and says which language it
was handed and which engine is running. That check is the backstop; declaring `renderer` on the
descriptor is better, because it fires before the package builds anything.

### WebGPU projects — TSL

Shading is a **function that returns a node**, not a shader string:

```js
const fragment = ({ tsl, uniforms }) => {
  const { mix, uv, smoothstep } = tsl;
  return mix(uniforms.uPrevious.sample(uv()),
             uniforms.uCurrent.sample(uv()),
             smoothstep(0.0, 1.0, uniforms.uProgress));
};
const material = createShaderMaterial({ fragment, uniforms });
```

- `fragment` is called once, when `createShaderMaterial` runs inside `createInstance` (the first time the editor
  draws the transition), with the TSL builders and the uniforms. A mistake throws there with a message
  (`transition package fragment failed to build: …`) that the console prints with the package's name, instead of
  a silent empty frame during playback.
- Uniforms are TSL nodes (`uniform(0)`, `texture(null)`). `.value` assignment in
  `render()` is unchanged.
- `uv()` is the fullscreen quad's coordinate — there is no varying to declare.
- Sample a texture with `someTexture.sample(coord)`.
- The material comes back `transparent: true` with `NormalBlending`; set the premultiplied factors of
  "Output and blending" after creating it.

`createShaderMaterial` rejects a `fragmentShader` string: a GLSL string reaching WebGPU compiles
nowhere and would draw nothing, so it is refused where the cause is still visible.

### Classic WebGL projects — GLSL

Shading is a fragment source string against the SDK's fullscreen vertex shader, which supplies
`varying vec2 vUv`:

```js
const FRAGMENT = `
uniform sampler2D uPrevious;
uniform sampler2D uCurrent;
uniform float uProgress;
varying vec2 vUv;
void main(){
  gl_FragColor = mix(texture2D(uPrevious, vUv), texture2D(uCurrent, vUv),
                     smoothstep(0.0, 1.0, clamp(uProgress, 0.0, 1.0)));
}
`;
const material = createGlslMaterialForWebgl({
  fragmentShader: FRAGMENT,
  uniforms: { uPrevious: { value: null }, uCurrent: { value: null }, uProgress: { value: 0 } },
});
```

- Uniforms are ordinary `{ value }` slots, created by the package.
- The material comes back `transparent: false`; set the premultiplied factors of "Output and blending" after
  creating it.
- Anything beyond a fullscreen quad (a package-owned scene, its own geometry) can use
  `sdk.THREE.ShaderMaterial` directly with the same GLSL.

## Output and blending

The plates a package samples are premultiplied, and the editor composites every channel with the premultiplied
"over" (`src + dst × (1 − src.a)`). So a package outputs premultiplied colour with real alpha (a `mix` of two plates'
whole `vec4`s already is) and blends it with these factors, on either engine, after creating the material:

```js
const { THREE } = sdk;   // the `sdk` createInstance receives
material.transparent = true;
material.blending = THREE.CustomBlending;
material.blendEquation = THREE.AddEquation;
material.blendSrc = THREE.OneFactor;
material.blendDst = THREE.OneMinusSrcAlphaFactor;
material.blendSrcAlpha = THREE.OneFactor;
material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
```

- An opaque material (`transparent: false`, which `createGlslMaterialForWebgl` returns) writes black wherever
  neither clip covers the frame (around a text or motion layer, an alpha video, a letterboxed clip), so the project
  background disappears there for the overlap. It also draws before the lower channels' layers, which then land on
  top of it.
- `NormalBlending` (which `createShaderMaterial` sets) multiplies the premultiplied colour by alpha a second time and
  darkens every soft edge.
- Write the factors, not `premultipliedAlpha = true`: on a TSL node material that flag also multiplies the colour by
  alpha in the shader, the same double darkening.

## SDK surface

- `THREE` — geometry, scenes, cameras, lights, materials, textures, render targets, math, etc. It is
  the Three.js build the project's engine runs on, so compare with `.isMesh`-style flags rather than
  `instanceof` if a package ever needs to test one
- `GLTFLoader`, `OBJLoader`, `MTLLoader`, `RGBELoader`, `EXRLoader`, `FontLoader`, `TextGeometry`
  — bundled Three.js add-ons for packaged 3D objects, environments, and 3D text
- `createShaderMaterial({ fragment, uniforms, transparent, depthTest, depthWrite, blending, side })` — TSL;
  `fragment` is a FUNCTION returning a node
- `createGlslMaterialForWebgl({ fragmentShader, uniforms })` — GLSL; a fullscreen `ShaderMaterial`
- `createFullscreenPlane(width, height, material, z?)`
- `replacePlaneGeometry(mesh, width, height)`
- `createRenderTarget(width, height, options?)`
- `resizeRenderTarget(target, width, height)`
- `renderToTarget(renderer, { scene, camera, target, clear, clearColor, clearAlpha })` — preserves editor renderer state
- `setUniform(material, name, value)`
- `disposeObject3D(root)`
- `loadTextAsset(url)`, `loadBinaryAsset(url)`
- `clamp`, `clamp01`, `lerp`, `smoothstep`, `hashNoise`
- `TSL` — the Three Shading Language builders (`vec2`, `mix`, `uv`, `Fn`, `uniform`, `texture`, …); `null` on the
  classic engine

Raw `renderer` and `THREE` are intentionally available; these are trusted locally imported executable
packages, not declarative presets. Prefer SDK state-preserving helpers for render passes.

## Compositing and layer order

The package `root` lives inside the transition channel's group in the editor's single composition
scene. Timeline channels stack bottom-to-top by z in `0.1` steps, and clip materials disable depth
testing, so stacking is decided purely by the transparent painter sort (world z) — not the depth
buffer. The runtime places `root` at `+0.02` inside its channel, just above the outgoing (z `0`) and
incoming (z `0.01`) clip planes; `createFullscreenPlane`'s default `z = 0.02` is relative to `root`
and lands safely inside the band.

Rules that keep a transition scoped to its own channel:

- **Never set `renderOrder`** on `root`, package meshes, or groups added to `root`. In Three.js a
  `Group`'s `renderOrder` becomes the `groupOrder` of every descendant and sorts before depth, which
  hoists the transition above every other channel — layers on higher channels visibly drop behind
  the transition for its duration, then pop back.
- Keep package mesh z within roughly `±0.05` of `root`. Meshes beyond the channel's `0.1` z band
  composite above (or below) neighboring channels' layers.
- Draw transparent with the factors of "Output and blending": an opaque package mesh is drawn before every
  transparent layer and loses the painter sort.
- For real 3D depth (camera moves, particles flying toward the lens), build the effect in a private
  pass with `renderToTarget` and show the result on a fullscreen plane inside the band, instead of
  pushing geometry toward the shared camera.

## Media and export

Declare image/video sources in `media`. Player owns decoding and supplies textures to the package.
Each entry has a kebab-case `id` (unique in the package), `type` `video` or `image`, and a `src` taken from
`TRANSITION_ASSETS`; a video may set `trimStart` (≥ 0) and `trimEnd` (after `trimStart`; left out, the file's end).
Video time maps linearly from `rawProgress` across `trimStart..trimEnd`, whatever the transition's length; it plays
muted. WebM alpha is preserved, and export uses the same WebCodecs/WebM frame-cache path as timeline media.

## Audio

`audio: { url, trimStart, trimEnd, volume }`: `url` is a `TRANSITION_ASSETS` URL, `trimStart` ≥ 0, `trimEnd` after
`trimStart`, `volume` optional. The cue starts where the overlap starts and plays `trimStart..trimEnd` at its own
speed, in the preview and in full and partial exports; it is not stretched to the transition's length. A `switch`
option keyed `muteSound` silences it while it is on (both starters carry one). The metadata's `hasAudio` says a
package has a cue.

## Controls and gallery

Controls are package-owned via `optionDefaults` and `optionFields`: `switch`, `range`, `number`,
`select`, `text`, `textarea`, `color`. Every field needs a `key` (a letter, then up to 63 letters, digits, `_` or
`-`; no duplicates), a non-empty `label` and one of those types, and its `optionDefaults` value must fit it: a
boolean for `switch`; a finite number for `range` / `number`, whose `min` / `max` clamp the saved value; a string
for `text`, `textarea` and `color` (text is kept up to 10,000 characters); for `select`, `options` of string values
(plain strings or `{ value, label }`) that include the default. A package with a field that breaks this is refused.

Gallery preview/poster files are discovered by the conventional names anywhere under `assets/`: `preview.mp4`,
`.webm` or `.mov`, and `thumbnail.png`, `.jpg`, `.jpeg`, `.webp`, `.gif` or `.svg`, unless the descriptor sets
`previewVideo` / `thumbnail`.

## Default timing

Use descriptor-level `defaultDuration` for timing inherent to the transition itself—for example, a
six-second 3D camera move or a long packaged overlay. Do not model this as an `optionField`: the
editor's normal Length control remains the single saved duration, and `frame.timeSec`,
`frame.duration`, `progress`, and packaged media timing all follow the resolved overlap length.

## Verification

- Scrub forward/backward at 0, 0.25, 0.5, 0.75, 1.
- Change every control and resize to 16:9, 9:16, and 1:1.
- Test transformed/filtered incoming and outgoing clips; `previous.texture` and `current.texture` must
  retain the exact composed appearance.
- Test a clip that does not cover the frame (a text layer, a letterboxed clip) over a project background and a
  lower channel: the background and the lower layer show around it, and nothing turns black.
- Run the package with the editor on the engine it declares (`GET /api/video-editor/engine`), and
  once on the other engine when the user can switch it — the second must report the mismatch by
  name, not draw an empty frame.
- Compile every custom shader and inspect browser console for shader errors (`[transitions]` lines name the
  package that failed to load, build or render).
- Verify alpha media over a checkerboard and verify multi-pass target resizing/disposal.
- Export a short MP4 and alpha WebM when relevant; compare with settled preview.
- Re-import the same id and confirm projects retain `local:<id>` while the runtime revision refreshes.

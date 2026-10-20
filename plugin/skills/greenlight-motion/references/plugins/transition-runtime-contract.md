# Executable Advanced Transition runtime contract

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

One wrapper folder is accepted. Source limit: 512 KB. Package limit: 300 MB, 200 assets, 100 MB per
asset. Supported assets include images, video, audio, fonts, GLSL/JSON/binary/LUT files, and common
Three.js scene/environment formats.

`manifest.json` is optional on first import but recommended for immediate agent discovery. It is the
metadata-only descriptor described in the parent skill—never shader/source code. The app validates
the executable module and automatically creates or refreshes this manifest; downloaded packages
preserve it.

## Imports and execution model

`transition.js` is a self-contained executable ES module. The only external import is:

```js
import { THREE, createShaderMaterial, createRenderTarget, renderToTarget } from './transition-sdk';
```

All other functions belong inside the package source. The runtime blocks network/DOM/storage/timers,
dynamic imports/eval, wall-clock time, and `Math.random`. This keeps random-access export deterministic.
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
retime transitions that are already saved in a project. The actual cross-transition overlap is still
limited by the available duration of the two adjacent clips.

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
- `THREE` — the full installed Three.js namespace
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

`createInstance` may be async. `render(frame)` must be synchronous.

## Frame object

`render(frame)` receives:

- `progress` — eased 0..1
- `rawProgress` — linear 0..1
- `timeSec`, `duration`
- `options`
- `width`, `height`
- `renderer`, `camera`, `root`
- `previous` / `current`:
  - `texture` — full-frame, fully composed clip plate including fitting, filters, and item transform
  - `sourceTexture` — undecorated source media texture
  - `mesh`, `material`, `opacity` — raw editor objects when an effect deliberately needs them
- `media.get(id)` → `{ texture, ready, width, height, duration, type, src }`
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

- `fragment` is called ONCE, when the package is installed. A mistake surfaces
  there with a message, instead of drawing an empty frame during playback.
- Uniforms are TSL nodes (`uniform(0)`, `texture(null)`). `.value` assignment in
  `render()` is unchanged.
- `uv()` is the fullscreen quad's coordinate — there is no varying to declare.
- Sample a texture with `someTexture.sample(coord)`.
- The material comes back `transparent: true`.

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
- The material comes back `transparent: false`, which is what a full-frame cross wants. A package
  drawing over the frame — a layer-slot entrance/exit, an overlay, anything with soft edges — sets
  `material.transparent = true` and, for the premultiplied plates described under "Frame object",
  `material.premultipliedAlpha = true` after creating it.
- Anything beyond a fullscreen quad (a package-owned scene, its own geometry) can use
  `sdk.THREE.ShaderMaterial` directly with the same GLSL.

## SDK surface

- `THREE` — geometry, scenes, cameras, lights, materials, textures, render targets, math, etc. It is
  the Three.js build the project's engine runs on, so compare with `.isMesh`-style flags rather than
  `instanceof` if a package ever needs to test one
- `GLTFLoader`, `OBJLoader`, `MTLLoader`, `RGBELoader`, `EXRLoader`, `FontLoader`, `TextGeometry`
  — bundled Three.js add-ons for packaged 3D objects, environments, and 3D text
- `createShaderMaterial({ fragment, uniforms, ... })` — TSL; `fragment` is a FUNCTION returning a node
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
- `TSL` — the Three Shading Language builders (`vec2`, `mix`, `uv`, `Fn`, `uniform`, `texture`, …)

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
- For real 3D depth (camera moves, particles flying toward the lens), build the effect in a private
  pass with `renderToTarget` and show the result on a fullscreen plane inside the band, instead of
  pushing geometry toward the shared camera.

## Media and export

Declare image/video sources in `media`. Player owns decoding and supplies textures to the package.
Video time maps deterministically from transition progress across `trimStart..trimEnd`; WebM alpha is
preserved, and export uses the same WebCodecs/WebM frame-cache path as timeline media.

## Controls and gallery

Controls are package-owned via `optionDefaults` and `optionFields`: `switch`, `range`, `number`,
`select`, `text`, `textarea`, `color`. Gallery preview/poster files are discovered by the conventional
`preview.*` and `thumbnail.*` names.

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
- Run the package with the editor on the engine it declares (`GET /api/video-editor/engine`), and
  once on the other engine when the user can switch it — the second must report the mismatch by
  name, not draw an empty frame.
- Compile every custom shader and inspect browser console for shader errors.
- Verify alpha media over a checkerboard and verify multi-pass target resizing/disposal.
- Export a short MP4 and alpha WebM when relevant; compare with settled preview.
- Re-import the same id and confirm projects retain `local:<id>` while the runtime revision refreshes.

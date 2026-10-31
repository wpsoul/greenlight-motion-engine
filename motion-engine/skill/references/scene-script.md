# The scene script — the fast way to a video that looks made

A short JSON script — scenes, their texts and shapes, preset names, transitions, sounds — that
`npx greenlight-motion script <folder>` turns into a full project (`<folder>/project.json`) with the GreenLight Video
Editor's own animation presets: the same converter the GreenLight Motion connector's build_video uses in Claude and
ChatGPT. Write it as `<folder>/script.json`, run `script`, then `check` and `stills` and look at the contact sheet.
Change the SCRIPT and run `script` again (it rewrites project.json). For what a script can't say (3D, particles, motion
paths, masks, text animators by hand), go on from project.json with `apply` and the other references — and stop
running `script`, or it replaces those edits.

Pictures, video and music: put the files in `<folder>/assets/` and name them `asset:<file name>`; an https link
works too (it has to stay reachable). SVG you write: `{ "type": "image", "svg": "<svg …>…</svg>" }`.

## The scene script

**Before the script, a direction.** Presets make a video move; they don't give it an idea. Decide in a few lines first,
and keep them next to the script:
- **The idea**: ONE picture from the subject's own world (its object, place or action: a coffee shop's steam and cup rim,
  a budgeting app's receipt printing line by line, a running app's track the scenes run along), carried through every scene.
- **The palette**: background, text, one accent, plus only the colours that carry meaning (good / bad, before / after).
  Light or dark on purpose.
- **The type**: a big headline against a small support line; aligned left or centred on purpose, not by default.
- **Each scene**: what it SHOWS besides its words, built from shapes, lines, `svg` you write, keyframes and the camera.
The same line centred on a gradient in every scene reads as a template. Judge the stills against the direction, not
only for mistakes.
What a script can't say (a custom GLSL shader on a shape or the background, words dipping under a surface with a track
matte, masks, particles, 3D) goes on from `project.json`: SKILL.md, "Beyond the script".

```json
{
  "title": "Bean There — opening day",
  "format": "16:9",
  "style": { "background": "linear-gradient(160deg, #2b1a12, #0e0806)", "colors": { "text": "#f6efe7", "accent": "#d9a066", "muted": "#b8a594" } },
  "scenes": [
    { "name": "Hook", "duration": 2.6, "camera": "push-in",
      "elements": [
        { "type": "text", "text": "Bean There", "role": "headline", "textAnimation": "glide-text" },
        { "type": "line", "at": [-180, 92], "to": [180, 92], "start": 0.7 },
        { "type": "text", "text": "Coffee worth the detour", "role": "subhead", "at": [0, 150], "start": 0.9, "enter": "glide-soft-entry", "direction": "up" } ] },
    { "name": "Offer", "duration": 2.4, "transition": "Camera Whip", "camera": "drift-left",
      "elements": [
        { "type": "pill", "w": 560, "h": 116, "color": "accent", "start": 0.15 },
        { "type": "text", "text": "Opening day: 2 for 1", "role": "body", "color": "#1b120d", "start": 0.3, "enter": "pop-overshoot", "sound": "data-1" } ] },
    { "name": "Close", "duration": 2.4, "transition": "Gradient Glow Stack", "background": { "shader": "silk", "look": "sunset" },
      "camera": { "move": "cm-quiet-push", "dof": { "focus": "street", "aperture": 50 } },
      "elements": [
        { "type": "circle", "w": 420, "color": "#fff3e0", "opacity": 0.3, "at": [330, -60], "z": -700 },
        { "id": "street", "type": "text", "text": "12 Elm Street", "role": "headline", "textAnimation": "word-swing" },
        { "type": "text", "text": "OPEN 7 – 7", "role": "label", "at": [0, 130], "start": 0.8, "letterSpacing": 6 } ] }
  ]
}
```

- **format** 16:9 · 9:16 · 1:1 · 4:5 (16:9 = 1920×1080, 9:16 = 1080×1920, 1:1 = 1080×1080, 4:5 = 1080×1350). Sizes and positions are in those pixels.
- **at**: `center` `top` `bottom` `left` `right` `top-left` … or `[x, y]` px from the centre (+y is down). Keep text inside the middle 80 %.
- **text**: `role` headline | subhead | body | label sets size and weight (override with `size`, `weight`); `color` text | accent | muted | #hex |
  a CSS gradient; `width` (px, wraps), `align`, `uppercase`, `letterSpacing`, `lineHeight`. A headline gets `glide-text` unless you set `textAnimation`.
- **rect · pill · circle**: `w`, `h`, `color` (or a CSS gradient), `radius`, `border` {width, color}, `shadow`: true. They enter with `pop-overshoot` unless you set `enter`.
- **line**: from `at` to `to`, `width`, drawn on (`draw`: false to skip).
- **image · video**: `src` (a file in the folder's assets/ as `asset:<name>`, or an https link) or, for an image, `svg` (SVG markup you write); `w` or `h`
  (px; the other follows the file's shape) or `fit` cover | contain
  (default: a video covers the frame, a picture sits at 70 % of contain), `rotate` (deg). A video also takes
  `startAt` (s into the file) and `volume` (0–100, default muted). No entrance unless you set `enter`.
- **Keyframes on any element** — your own motion: `"keyframes": { "x": [[0, -400], [0.8, 0, "Smooth Glide"]], "scale": [[0, 0.9], [2, 1.05]] }`
  — tracks x, y (px offsets from `at`), scale, rotate (deg), opacity (0–1); each key [seconds into the element, value, easing of the
  segment after it — Smooth Glide, AE Smooth, Expo Out, Back Out, Elastic, Linear …]. They replace an entrance's keys on the same track.
- **Every element**: `start` / `end` (s within its scene; default: staggered 0.12 s, to the scene's end), `enter` / `exit` (keyframe presets, `direction` up | down | left | right
  for directional ones), `effects`: [{ "id", "params"? }], `sound` (played at its start), `id`, `label` (its name in the page's options), `opacity` (0–1),
  `z` (px of depth, + toward the viewer, default 0: a real camera's dolly, orbit and depth of field separate layers by it), `locked`: true
  (the scene's camera doesn't move it: a logo, a caption). Keyframes also take a `z` track.
- **Scene**: `duration` (s), `transition` into it (default Cross Fade, 0.6 s; `transitionDuration`), `camera` (below; default push-in),
  `background` (overrides style), `sounds`: [{ "sfx", "at" }]. Script-level `sound`: auto (default: a whoosh on each transition and on the first headline) | none.
  **A transition overlaps the scenes on both sides**, so the video lasts the scenes' durations added up MINUS every
  transition: five 3 s scenes with the default 0.6 s transitions run 15 − 4 × 0.6 = 12.6 s. To hit a length, add the
  transitions back to the scenes (`script` prints the total).
- **camera** — a quick move of the whole scene: none | push-in | pull-out | drift-left | drift-right | drift-up. Or a REAL camera that films the scene's elements in 3D (the
  Video Editor's own camera layer; the scene's backdrop stays put, so its edge never shows). One of:
  - `{ "move": id }` — a camera move from the catalogue (or just `"camera": "cm-quiet-push"`), spread over the scene;
  - `{ "rig": id }` or `{ "rig": { "preset"?: id, "type"?, …fields } }` — an orbit, crane, push-in, truck, spiral, handheld or follow move
    (`"camera": "heroOrbit"` works too). A `follow` rig rides elements: `"targets": [element ids]`. Layers are flat: keep an orbit within about
    ±70° of the front (heroOrbit, slowReveal) or they turn edge-on and read mirrored;
  - `{ "zooms": [{ "start", "end", "at"?, "zoom"? }], "feel"? }` — zoom in on spots and back out, like a screen recording's Smart Zoom: `at` as for
    elements (the spot to frame, clamped so the view stays inside the frame), `zoom` 1.05–4 (default the feel's, about 1.45), each zoom at least
    0.4 s and none overlapping; `feel` studio | calm | precise | lively | follow (the spring). Put a screen recording in as a video element (or the
    scene's video background) and zoom on what it shows;
  - `{ "keyframes": { zoom | x | y | roll | dolly | tiltX | tiltY | focusZ: [[seconds, value, easing?], …] } }` — your own move: zoom (×, 1 = none),
    x / y (px the camera pans right / down), roll / tilt (deg), dolly (px toward the scene: it changes perspective, so layers at different `z` part).
    With a `move` they replace its track; a rig drives x, y, roll, dolly and tilt itself and zooms drive zoom, x and y, so key only the others there.
  - plus `"dof": { "focus": element id | "focusZ": px, "aperture"?: 40, "blur"?: 100 }` (or `true`) — depth of field: what sits at another `z` blurs;
    the focus stays on its subject while the camera dollies or rides a rig. `focusZ` keys are a rack focus (measured from where the camera starts).
  - `start` / `end` (s in the scene; default the whole scene; outside them the camera rests). Keys and zooms count seconds into the camera.
- **background**: a colour, a CSS gradient, { "shader": id, "look"? } — shaders: silk, glowblobs, waves, plasma, mesh, fire, spacetravel, glitters, blueplanet, auroraridge, emberpool, neonvignette, electricvignette, spectrumdrift, emberfacet, silkdrift, eclipseprism, glassreeds, staticfringe, ripplefold, nightaurora, pixelbeams, petalgrid, amberblinds, icehalo, windowhaze (looks: references/video-backgrounds.md) — or { "image": src } / { "video": src } (covers the frame; b-roll behind the scene).
- **music** (script level): `"music": { "src": file, "volume": 80, "fadeIn": 0.3, "fadeOut": 1.2, "startAt": 0 }` — one track under the video.

## What makes it look made, not generated

references/video-design.md — the same design rules GreenLight Dash's agents and the chat connector use. Read it before
the first version and check every version against it.

## Catalogues

**Text animations** (`textAnimation`; ★ = preferred): ★ `glide-text` Glide Text · `glide-continuous` Glide Continuous · `smart-overshoot` Smart Overshoot · `glide-soft-stop` Glide Soft Stop · ★ `ember-type` Ember Type · `molten-edge` Molten Edge · `focus-type` Focus Type · `tumble-type` Tumble Type · `flap-down` Flap Down · `drop-swell` Drop Swell · `rain-type` Rain Type · `counter-sweep` Counter Sweep · `sunset-shrink` Sunset Shrink · `boomerang` Boomerang · ★ `swing-pop` Swing Pop · ★ `word-swing` Word Swing · ★ `letter-vortex` Letter Vortex · `center-burst` Center Burst · ★ `pendulum` Pendulum · `spin-pop` Spin Pop · `domino` Domino · `flip-pop` Flip Pop · `card-turn` Card Turn · `slam-zoom` Slam Zoom · `orbit` Orbit · ★ `fan-deal` Fan Deal · ★ `whip` Whip · `rubber-letters` Rubber Letters · `pop-letters` Pop Letters · `drop-swing` Drop Swing · `coin-spin` Coin Spin · `converge` Converge · `roll-in` Roll In · `door-swing` Door Swing · `pill-type` Pill Type · `card-type` Card Type · `word-bars` Word Bars · `line-stack` Word Stack · `marker-type` Marker Type · `card-erase` Card Erase · `colour-sweep` Colour Sweep · `glow-pass` Glow Pass · `wave-pass` Wave Pass · `pop-through` Pop Through · `shine` Shine · ★ `marker` Marker · ★ `outline-pass` Outline Pass · ★ `neon-flow` Neon Flow · `rainbow` Rainbow · `gradient-flow` Gradient Flow · `jitter` Jitter · `float` Float · `flicker` Flicker · `breathe` Breathing Wave · `shimmer` Shimmer · `decode` Decode · `binary` Binary Decode · `alphabet-roll` Alphabet Roll · ★ `glitch` Glitch · `classic-fade-up` Fade Up · `classic-fade-down` Fade Down · `classic-rise-mask` Rise (Mask) · `classic-blur-in` Blur In · `classic-slide-in` Slide In · `classic-side-mask` Side Mask · `classic-tilt-drop` Tilt Drop · `classic-flip-up` Flip Up · `classic-typewriter` Typewriter · `classic-wave-rise` Wave Rise · `classic-bounce-letters` Bounce Letters · `classic-materialize` Materialize · `classic-neon-runner` Neon Runner · `classic-ink-highlight` Ink Highlight · `classic-flash-type` Flash Type · `classic-karaoke-sweep` Karaoke Sweep · `classic-chase-loop` Chase Loop · `classic-sung-words` Sung Words · `classic-marker-lines` Marker Words · `classic-pill-grow` Pill Grow · `classic-lower-third` Lower Third · `classic-drop-bar` Drop Bar · `classic-outline-tag` Outline Tag · `classic-prompt-field` Prompt Field · `classic-random-pop` Random Pop · `classic-chaos-letters` Chaos Letters · `classic-random-rise` Random Rise · `classic-ransom-note` Ransom Note · `classic-editorial-typer` Editorial Typer

**Entrances** (`enter`): `slide` Slide · direction · `glide` Glide (in and out) · direction · `glide-stop` Glide Stop (in and out) · direction · `glide-floaty` Glide Floaty (in and out) · direction · `glide-endless` Glide Endless (in and out) · direction · `glide-diagonal` Glide Diagonal (in and out) · direction · `glide-arc` Glide Arc (in and out) · direction · `glide-close-pass` Glide Close Pass (in and out) · direction · `glide-fade-drift` Glide Fade Drift (in and out) · direction · `glide-bank` Glide Bank (in and out) · direction · `glide-swing-3d` Glide Swing 3D (in and out) · direction · `glide-linger` Glide Linger (in and out) · direction · `glide-soft-entry` Glide Soft Entry (in and out) · direction · `glide-blur` Glide Blur (in and out) · direction · `glide-spin-through` Glide Spin Through (in and out) · direction · `glide-depth-pass` Glide Depth Pass (in and out) · direction · `glide-tilt` Glide Tilt (in and out) · direction · `zoom-in` Zoom In · `mockup-close-up` Mockup Close-Up · `mockup-orbit-left` Orbit Left · `deck-drift` Deck Drift · `hero-punch` Hero Punch · `dark-spotlight` Dark Spotlight · `phone-app-swipe` Phone Swipe Reveal · `phone-app-punch` Phone App Punch In · `phone-app-tilt-drift` Phone Tilt Drift · `phone-app-cta-hold` CTA Hold Focus · `button-press` Button Press · `button-tap-flash` Tap Flash · `pop-overshoot` Pop Overshoot · `spring-in` Spring In · `rubber-wobble` Rubber Wobble · `tap-nudge` Tap Nudge · `whip-swing` Whip Swing · `flick-drop` Flick Drop · `jelly-shake` Jelly Shake · `heartbeat` Heartbeat · `impact-punch` Impact Punch · `pendulum-swing` Pendulum Swing · `loose-wiggle` Loose Wiggle · `shiver` Shiver · `float` Float · `flicker-in` Flicker In · `earthquake` Earthquake · `tumble-drop` Tumble Drop · `rubber-band` Rubber Band · `spring-twist` Spring Twist · `slingshot` Slingshot · `pendulum-in` Pendulum In · `smooth-overshoot-rise` Smooth Overshoot Rise · `spin-in` Spin In · `twist-in` Twist In · `roll-in` Roll In · `tilt-settle` Tilt Settle · `wind-up-spin` Wind-Up Spin

**Exits** (`exit`): `slide` Slide Out · `zoom-in` Zoom Out · `mockup-close-up` Mockup Close-Up · `mockup-orbit-left` Orbit Left · `deck-drift` Deck Drift · `hero-punch` Hero Punch · `dark-spotlight` Dark Spotlight · `phone-app-swipe` Phone Swipe Reveal · `phone-app-punch` Phone App Punch In · `phone-app-tilt-drift` Phone Tilt Drift · `phone-app-cta-hold` CTA Hold Focus · `button-press` Button Press · `button-tap-flash` Tap Flash · `pop-overshoot` Pop Out · `spring-in` Spring Out · `rubber-wobble` Rubber Wobble · `tap-nudge` Tap Nudge · `whip-swing` Whip Out · `flick-drop` Flick Up · `jelly-shake` Jelly Shake · `heartbeat` Heartbeat · `impact-punch` Impact Out · `pendulum-swing` Pendulum Swing · `loose-wiggle` Loose Wiggle Out · `shiver` Shiver Out · `float` Float Away · `flicker-in` Flicker Out · `earthquake` Earthquake Out · `tumble-drop` Tumble Up · `rubber-band` Rubber Band Out · `spring-twist` Spring Untwist · `slingshot` Slingshot Out · `pendulum-in` Pendulum Out · `smooth-overshoot-rise` Smooth Overshoot Drop · `spin-in` Spin Out · `twist-in` Twist Out · `roll-in` Roll Out · `tilt-settle` Tilt Away · `wind-up-spin` Wind-Up Spin Out

**Transitions** (★ = preferred): None · ★ Cross Fade · Push · Parallax · Wipe · Zoom In · Zoom Out · ★ Advanced Zoom · ★ Advanced Movement · 3D Carousel · Louver Flip · ★ Circular Wipe · ★ Pixel Blocks · ★ Camera Whip · ★ Zoom Ruler · ★ Gradient Glow Stack · ★ Gradient Map · Scale Swap · Side by Side · Dip to Black · Radial Wipe

**Camera moves** (`camera.move`; spread over the camera's length): `cm-quiet-push` Quiet Push (Cinematic) · `cm-swoop-dive` Swoop Dive (Cinematic) · `cm-corkscrew` Corkscrew (Cinematic) · `cm-fast-orbit` Fast Orbit (Cinematic) · `cm-lateral-glide` Lateral Glide (Cinematic) · `cm-parallax-arc` Parallax Arc (Cinematic) · `cm-arc-closeup` Arc Close-Up (Cinematic) · `cm-slingshot` Slingshot (Editorial) · `cm-step-zoom` Step Zoom (Editorial) · `cm-handheld-breath` Handheld Breath (Editorial) · `cm-soft-land` Soft Land (Editorial) · `cm-documentary-follow` Documentary Follow (Editorial) · `cm-weave-run` Weave Run (Energy) · `cm-s-curve-drift` S-Curve Drift (Energy) · `cm-macro-sweep` Macro Sweep (Energy) · `cm-punch-through` Punch Through (Energy) · `cm-orbit-pulse` Orbit Pulse (Loops) · `cm-float` Float (Loops) · `cm-figure-eight` Figure Eight (Loops) · `cm-rack-to-near` Rack to Near (Focus) · `cm-rack-to-far` Rack to Far (Focus) · `cm-focus-chase` Focus Chase (Focus) · `cm-macro-bloom` Macro Bloom (Focus) · `cm-grand-reveal` Grand Reveal (Cinematic)

**Camera rigs** (`camera.rig`; the fields you can override: type orbit | dolly | crane | pushIn | truck | spiral | handheld | follow, aim center | path, radius 100–20000, height -8000–8000, startAngle -360–360, sweep -720–720, rise -8000–8000, distance -20000–20000, turns 0.25–8, tilt -80–80, roll -180–180, amplitude 0–2000, frequency 0–40): `heroOrbit` Hero Orbit (orbit) · `slowReveal` Slow Reveal (orbit) · `turntable` Turntable (orbit) · `craneDown` Crane Down (crane) · `riseReveal` Rise & Reveal (crane) · `pushIn` Push In (pushIn) · `pullBack` Pull Back (dolly) · `truckLeft` Truck Left (truck) · `productSpiral` Product Spiral (spiral) · `handheldDrift` Handheld Drift (handheld) · `droneFollow` Drone Follow (follow) · `chaseCam` Chase Cam (follow)

**Zoom feels** (`camera.feel`): `studio` Studio · `calm` Calm · `precise` Precise · `lively` Lively · `follow` Follow. Full camera layers (paths, Smart Zoom on a recording's clicks, the drawn cursor): references/video-camera.md.

**Overlay effects** (`effects`): `glow`, ★ `bloom`, `auraBlur`, `gradientBeam`, ★ `gradientSweep`, `fractalNoise`, ★ `rgbSplit`, `glitch`, `scanlines`, `flashBlink`, `vhs`, `fisheye`, `opticsCompensation`, `vignette`, ★ `echo`, `timeshift`, `radialBlur`, ★ `radialFastBlur`, `sharpen`, `mirror`, `waveWarp`, `warpStyles`, `shockwave`, `waveLines`, `waveRipple`, `fill`, `shapeRulers`, `copyColor`, `curves`, `turbulentDisplace`, `alphaChoker`, `extract`, ★ `colorama`, `posterize`, ★ `halftone`, ★ `fastCameraWiggle`, ★ `lightRays`, `longShadow`, `outlineBands`, `kaleidoscope`, `crtMatrix`, `pixelate`, `vectorFieldWarp`, `pixelStretch`, `neonGlow`, `edgeDetect`, `doubleExposure`, ★ `filmStock`, `fastBlur`, `gridLines`, `strip`, `ascii`, `objectDither`, `objectIsolines`, `objectWindow`, `objectSlitScan`, `objectCurtain`, `objectGrid`, `objectContour`, `objectNodes`, `objectLinks`, `objectFacets`, `objectMeasure`

**Layer effects** (`effects`): `mockupFrame`, ★ `runningGlow`, `depthMap`, `depth3d`, `depthScan`, `fresnelRim`, ★ `motionBlur`, `posterizeTime`, ★ `motionTrail`, `autoFill`, ★ `repetile`, `regionDistort`, `bend`, `cornerPin`, `meshWarp`, `bezierWarp`, `rig`, ★ `droste`, `pryzm`, ★ `glass`, `chromaKey`, `layerMask`

Effect params: references/video-effects.md.

**Sounds** (`sound`, `sounds[].sfx`):
- Ambient Transition: ambient-transition-22 (5s)
- Bass Drop: cinematic-transition-13 (2.5s), sd-low-06 (8s), sd-low-hi-04 (8s)
- Bleep: digital-bleep-01 (0.286s)
- Bubble: bubble-07 (1.565s), bubble-08 (2.061s), bubble-10 (0.906s), bubble-23 (1.071s)
- Camera: camera-focus-and-shutter (1.022s), camera-focus-beep (0.283s), camera-power-switch (0.48s)
- Cartoon Sound: cartoon-sound-17 (4s)
- Click: keyboard-click-02 (0.294s), selection-data-click (0.68s)
- Crystal: crystal-swoosh (2.715s)
- Cyber Transition: cyber-transition-20 (1.353s)
- Data: data-1 (0.454s), data-6 (0.388s), data-8 (2.841s), data-9 (1.716s), data-11 (2.848s), data-12 (2.072s), data-14 (2.233s)
- Foley: disk-mechanism-close (0.939s), mechanical-insert (0.491s), metal-movement-low (1.022s), paper-flap-01 (1.278s), paper-flap-02 (0.929s), paper-turn-01 (0.672s), rustle-whoosh (0.971s), stretched-leather-02 (1.5s), tiny-mechanism-assembling-fast (0.789s)
- Foley & Ambience: flash (0.967s)
- Full Screen Transition: big-transition-whoosh (2.465s)
- Gears (single): small-gears-13 (1.5s), small-gears-16 (1.022s)
- Glitch: glitch-transition-06 (0.806s)
- Notifications and Buttons: notifications-and-buttons-16 (1s), sfx-confirmation (4s), sfx-failure (0.265s), sfx-message-01 (0.159s), sfx-message-05 (0.75s), sfx-notification-01 (2.4s), sfx-notification-08 (2.3s), sfx-payment (1.323s)
- SFX Transition: cinematic-rewind-short (1.056s), sfx-message-03 (0.174s), simple-transition-08 (3.557s), simple-transition-13 (3s)
- Strobe: strobe-transition-22 (1s)
- Swoosh: soft-swoosh (1.848s), standard-swoosh (1.335s)
- Text: keyboard-writing-02 (2.904s), machine-writing-01 (3.924s), pen-writing-tick (0.429s)
- Tiles: tiles-07 (1.473s), tiles-08 (0.979s)
- Whoosh: airy-whoosh-02 (2.944s), liquid-transition-whoosh (1.76s), resonant-light-whoosh (3.203s), whoosh-3 (0.469s), whoosh-13 (1.99s), whoosh-38 (1.263s)
- Whoosh / Additional: whoosh-05 (2.116s)


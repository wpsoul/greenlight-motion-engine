> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# Motion in code — an HTML page rendered frame by frame, and ffmpeg

How the motion grammar's rules ([video-design.md](video-design.md#motion-grammar): a move is its keys, one gesture, match velocity
at the cut, the twelve join types) are built in a film made in code: an HTML page (DOM, canvas or WebGL) rendered
frame by frame in a headless browser, and clips joined with ffmpeg. Every snippet and command below was run: headless
Chrome through puppeteer-core 25.16, ffmpeg 7.1.1, GSAP 3.14.2, with `seam_check` measuring the results. The neutral
recipes with their numbers and the measuring tools need Python: [seam-craft/seam-recipes.md](seam-craft/seam-recipes.md),
[seam-craft/seam-check.md](seam-craft/seam-check.md#in-code-a-page-rendered-frame-by-frame-clips-joined-with-ffmpeg).

## Contents

- [Terms](#terms)
- [The clock: draw(t), never the wall](#the-clock-drawt-never-the-wall)
- [Render frame by frame](#render-frame-by-frame)
- [Easing curves](#easing-curves)
- [Match velocity in code](#match-velocity-in-code)
- [Joining clips with ffmpeg](#joining-clips-with-ffmpeg)
- [Motion blur from sub-frames](#motion-blur-from-sub-frames)
- [Seam types here](#seam-types-here)
- [Recipes on a canvas](#recipes-on-a-canvas)
- [Checking](#checking)
- [Traps](#traps)
- [Sources](#sources)

## Terms

| Term | Here |
|---|---|
| shot | a clip file, or a time range of your page: `if (t < CUT) drawA(t); else drawB(t - CUT);` |
| layer | a draw call (on a canvas, later draws paint over earlier ones) or an element (in the DOM, `z-index`) |
| group / nested composition | a function that draws a sub-scene from its own local time, inside `ctx.save()` … `ctx.restore()` |
| time | `t = n / fps` for frame n: the only clock |
| key, segment, easing curve | `(t, value)` pairs and an easing function E(u): `tween(t, t0, dur, v0, v1, E)` |
| hold (step) key | a value that changes on one frame, with no interpolation |
| a move as a few keys ([video-design.md](video-design.md#a-move-is-two-keys-and-an-easing)) | a move is one `tween(…)` call: two values and a curve. Never a table of per-frame values; a measured curve is fitted first (with Python, `seam-craft/tools/lib/keyfit.py curve`) |
| transform origin | `ctx.translate(px, py); ctx.scale(s, s); ctx.translate(-px, -py)`; CSS `transform-origin` |
| motion path, its progress | a cubic bezier you evaluate at the eased progress: `p = bezier(P0, P1, P2, P3, E(u))`, one `E` for the whole curve |
| parent / null | a transform stack: `ctx.translate` / `rotate` / `scale` between `save` and `restore`; nested CSS transforms |
| camera | a transform applied to the whole world before it is drawn (canvas `translate` / `scale`, a CSS world wrapper, a three.js camera) |
| mask | canvas `clip()` with a path (`Path2D`, `roundRect`); CSS `clip-path` |
| matte | canvas `globalCompositeOperation = "destination-in"` with the matte drawn last; CSS `mask` with an image |
| motion blur | sub-frames averaged ([Motion blur from sub-frames](#motion-blur-from-sub-frames)) |
| corner pin | CSS `matrix3d()` or WebGL; a 2D canvas has no perspective transform |
| join two clips | ffmpeg: `trim` + `concat` for a cut, `xfade` for a transition |
| render a frame range | frames n0…n1 of the same page: `draw(t)` needs nothing from earlier frames |

## The clock: draw(t), never the wall

- **Expose one function, `window.draw(t)`, that sets the whole picture from t alone.** The renderer spends ~50–70 ms on
  each screenshot, so anything driven by the wall clock (a `requestAnimationFrame` loop, timers, `Date.now()`,
  `performance.now()`, a CSS `transition`) lands somewhere different on every run. A pure `draw(t)` renders in any
  order, re-renders one range, and gives the same pixels each time (two renders here matched PNG for PNG).
- **Take t from the frame number** (`t = n / fps`, the renderer does it). Don't round t to 30 fps inside `draw`: a
  sub-frame blur pass calls it at 240 fps ([Motion blur from sub-frames](#motion-blur-from-sub-frames)).
- **Seed randomness:** a small PRNG (mulberry32) with a fixed seed, and layouts built once at load from that seed.
- **Integrating simulations** (particles, springs stepped in time) carry state from frame to frame: step them through
  every frame from 0, in order, even for a range. A closed-form spring of t needs no stepping.
- **Pages built with CSS animations, the Web Animations API or GSAP: seek them from `draw(t)`.** Tested with
  out-of-order seeks and wall time passing in between; both landed exactly:

  ```js
  const tl = gsap.timeline({ paused: true });          // GSAP: build it paused, then seek it
  window.draw = (t) => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t * 1000; }  // CSS animations + WAAPI, delays included
    tl.seek(t, false);
  };
  ```

  `currentTime = t × 1000` holds for animations that exist from page load; one created later counts from its own
  start ([getAnimations](https://developer.mozilla.org/en-US/docs/Web/API/Document/getAnimations)).
- **Fonts before frame 0:** `await document.fonts.ready`, and first `document.fonts.load("700 64px Inter", text)` for a
  face that only script-made text uses. Measure text after that, or an anchor (SR-02) lands off its box.
- **Inside GreenLight Dash** an HTML clip already runs on the app's virtual clock (`requestAnimationFrame`, timers,
  `Date`, CSS animations and media follow the clip's time, and `Math.random` is seeded:
  html-clips.md (GreenLight Dash only)). These rules matter when you render the page yourself.

## Render frame by frame

`render.mjs`, with `puppeteer-core` (`npm install puppeteer-core`) and the local Chrome
([Puppeteer](https://pptr.dev/)):

```js
// node render.mjs PAGE.html OUT_DIR SECONDS [FPS=30] [START=0]  ->  OUT_DIR/f_00000.png …
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const [pagePath, out, seconds, fpsArg = "30", startArg = "0"] = process.argv.slice(2);
const fps = Number(fpsArg), n0 = Math.round(Number(startArg) * fps), N = Math.round(Number(seconds) * fps);
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(resolve(pagePath)).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);                  // every font in before frame 0
for (let i = 0; i < N; i++) {
  await page.evaluate((t) => window.draw(t), (n0 + i) / fps);       // time from the frame number, never a clock
  await page.screenshot({ path: `${out}/f_${String(i).padStart(5, "0")}.png` });
}
await browser.close();
```

```
node render.mjs film.html work/frames 4.5                      # 135 frames at 30 fps (~9 s here)
ffmpeg -framerate 30 -i work/frames/f_%05d.png -c:v libx264 -crf 16 -pix_fmt yuv420p work/film.mp4
```

**One still** of moment t: headless Chrome with no script, on a page that draws `?t=` at load
(`draw(Number(new URLSearchParams(location.search).get("t") || 0))`). Use the renderer's flags: a still taken with
`--disable-gpu` differed from the same frame on anti-aliased edges; with matching flags it was identical.

```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --force-color-profile=srgb --window-size=1920,1080 --screenshot=work/still.png "file:///…/film.html?t=2.9"
```

## Easing curves

A `cubic-bezier(x1, y1, x2, y2)` has `E'(0) = y1 / x1` and `E'(1) = (1 − y2) / (1 − x2)`
([the maths](seam-craft/match-velocity.md#the-maths), [the easing table](seam-craft/match-velocity.md#the-easing-table)).
The CSS keywords ([cubic-bezier](https://developer.mozilla.org/en-US/docs/Web/CSS/easing-function/cubic-bezier)),
measured with the solver below:

| CSS keyword | `cubic-bezier` | E'(0) / E'(1) | At a join |
|---|---|---|---|
| `linear` | `(0, 0, 1, 1)` | 1 / 1 | a constant drift |
| `ease` (the CSS default) | `(0.25, 0.1, 0.25, 1)` | 0.40 / 0 | never: a slow start that ends at rest |
| `ease-in` | `(0.42, 0, 1, 1)` | 0 / 1.72 | a weak exit (easeInCubic's end is 2.97) |
| `ease-out` | `(0, 0, 0.58, 1)` | 1.72 / 0 | a weak landing |
| `ease-in-out` | `(0.42, 0, 0.58, 1)` | 0 / 0 | never across a join |

- **Write the slope you need.** For end slope k keep x2 and set `y2 = 1 − k · (1 − x2)`; for start slope k set
  `y1 = k · x1`. `cubic-bezier(0.5, 0, 0.75, 0.25)` ends at 3 (an exit), `cubic-bezier(0.25, 0.75, 0.5, 1)` starts at 3
  (a landing).
- **GSAP in a page** plays the same eases and slopes as in HyperFrames (hyperframes.md (GreenLight Dash only);
  [GSAP eases](https://gsap.com/docs/v3/Eases/)).
- **Chained segments stop at the join.** A drift followed by an exit whose curve starts at slope 0 dips to zero speed
  between them. Start the exit at the drift's speed: for a drift of v0 px/f into an exit of Δ px over T frames, set
  `y1 / x1 = v0 · T / Δ`.

The solver (Newton on x, then bisection), used by every snippet on this page:

```js
const bezier = (x1, y1, x2, y2) => {               // CSS cubic-bezier as E(u), u in 0…1
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (s) => ((ax * s + bx) * s + cx) * s, Y = (s) => ((ay * s + by) * s + cy) * s;
  const dX = (s) => (3 * ax * s + 2 * bx) * s + cx;
  return (u) => {
    if (u <= 0) return 0; if (u >= 1) return 1;
    let s = u;
    for (let i = 0; i < 8; i++) { const e = X(s) - u; if (Math.abs(e) < 1e-7) return Y(s); const d = dX(s); if (Math.abs(d) < 1e-6) break; s -= e / d; }
    let lo = 0, hi = 1; s = u;
    for (let i = 0; i < 50; i++) { const x = X(s); if (Math.abs(x - u) < 1e-7) break; if (x < u) lo = s; else hi = s; s = (lo + hi) / 2; }
    return Y(s);
  };
};
const clamp01 = (u) => Math.min(1, Math.max(0, u));
const tween = (t, t0, dur, v0, v1, E) => v0 + (v1 - v0) * E(clamp01((t - t0) / dur));
```

## Match velocity in code

A segment of Δ px over T frames moves at `v(u) = Δ / T × E'(u)` px per frame
([match-velocity.md](seam-craft/match-velocity.md#the-maths)). Give A an exit that ends on the cut with an
accelerating end, and B a landing whose start speed is r × A's (aim 1.0–1.3): `Δ_B = r × v_out × T_B / E'(0)`.

```js
const CUT = 3.0;                                  // the cut on frame 90
const EXIT = bezier(0.5, 0, 0.75, 0.25);          // E'(1) = 0.75 / 0.25 = 3
const LAND = bezier(0.25, 0.75, 0.5, 1);          // E'(0) = 0.75 / 0.25 = 3
window.draw = (t) => {                            // drawA(x) / drawB(x) draw each world shifted by x
  if (t < CUT) drawA(tween(t, 1.8, 1.2, 0, -720, EXIT));   // 720 px / 36 f × 3 = 60 px/f on the cut
  else drawB(tween(t, CUT, 0.8, 552, 0, LAND));             // 552 = 1.15 × 60 × 24 f / 3
};
```

Measured on the render: out 52 → in 63 px/f, ratio 1.22, peak +1 f, PASS. `seam_check` averages three frames per side,
so a steep exit reads below its end slope (52 against 60) and the ratio reads above the plan (1.22 for 1.15): aim with
the formula, accept the measurement.

## Joining clips with ffmpeg

Filter reference: [ffmpeg-filters](https://ffmpeg.org/ffmpeg-filters.html) (`trim`, `concat`, `xfade`, `tmix`), or
`ffmpeg -h filter=xfade` for your build's options.

### A cut on the peak (SR-01)

The cut goes where A's move is fastest, onto a frame of B already moving the same way at 1.0–1.3 × that speed: keep A's
frames 0…p, where p is A's peak-speed frame (the frames before it still speeding up), and start B at a frame q whose
next frames move the same way at 1.0–1.3 × that speed. Find p and q by eye on a 2-frame contact sheet of each clip
([Check the motion](video-design.md#check-the-motion-before-delivery)), or, with Python, from each clip's motion profile
([seam-check.md](seam-craft/seam-check.md#in-code-a-page-rendered-frame-by-frame-clips-joined-with-ffmpeg)).

```
ffmpeg -i A.mp4 -i B.mp4 -filter_complex \
  "[0:v]trim=start_frame=0:end_frame=31,setpts=PTS-STARTPTS[a];[1:v]trim=start_frame=30,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1:a=0[v]" \
  -map "[v]" -r 30 -c:v libx264 -crf 16 -pix_fmt yuv420p join.mp4
```

`end_frame` is exclusive (31 keeps frames 0…30). Butting two clips whole, both at rest at the join, is the stop-start
the motion grammar forbids. Cut the sound with `atrim` / `asetpts` at the same times (frames / fps) and
`concat=…:a=1`, or lay the music over the joined picture.

### Transitions with `xfade`

- **Offset.** `xfade=transition=T:duration=d:offset=o`: o is the time in the first input where the transition starts.
  For two clips o = len_A − d; in a chain o_k = o_(k−1) + len_k − d_k; the output lasts o + len_B. Tested: three 2-s
  clips with 0.5-s transitions at 1.5 and 3.0 gave 5.0 s.
- **Both clips play through the overlap:** A's last d seconds under B's first d, each with its own motion.
- **No easing option** in ffmpeg 7.1's `xfade`: every transition runs linearly in time; only `custom` can ease.
- **Inputs must match** in size, pixel format, frame rate and timebase. Otherwise it fails with "First input link main
  timebase (1/15360) do not match the corresponding second input link xfade timebase (1/12800)". Normalise both first:
  `[0]fps=30,settb=AVTB,format=yuv420p[a];[1]fps=30,settb=AVTB,format=yuv420p[b]` (tested), scaled to one size.
- **Sound:** `acrossfade=d=D` on the two audio streams, with the same overlap.

What moves, measured with textured inputs. Every `…left` type brings B in from the right edge, running left; `right`,
`up` and `down` mirror them.

| Transition | What moves | Use |
|---|---|---|
| `slideleft` | A and B together, left, at a constant W / (d × fps) px/f from the first transition frame to the last | a push that continues a pan whose content moves left |
| `coverleft` | B slides in over a still A | an arrival over a held frame |
| `revealleft` | A slides off, a still B under it | an exit off a held frame |
| `wipeleft` | nothing: a hard edge runs right → left | SR-10 without the push |
| `smoothleft` | nothing: a soft edge from the right | a soft SR-10 |
| `circleopen` | nothing: B opens from the centre in a soft circle | SR-03 for a circle only |
| `fade`, `dissolve` | nothing: a mix | a dissolve while both sides keep moving |

- **Match a slide to the pan.** A slide moves W / (d × fps) px/f (640 px over 1 s = 21.3 px/f, measured). To continue a
  pan of v px/f choose `d = W / (v × fps)` (1920 px at 60 px/f → 1.07 s), on stretches of A and B that are still or move
  the same way, since their own motion adds during the overlap. The slide starts and stops at full speed, a step at
  each end: look at both on the contact sheet (with Python, measure them:
  [seam-check.md](seam-craft/seam-check.md#in-code-a-page-rendered-frame-by-frame-clips-joined-with-ffmpeg)).
- **An eased push between two still shots** (one continuous move, at rest at both ends, its peak in the middle):
  `transition=custom`. `P` runs from 1 at the start to 0 at the end (tested); the expression reads each plane of A
  (`a0`…`a2`) and B (`b0`…`b2`). This one is a cubic in-out on q = 1 − P:

  ```
  E="st(1,1-P);st(1,if(lt(ld(1),0.5),4*pow(ld(1),3),1-pow(2-2*ld(1),3)/2));st(2,X+ld(1)*W);\
  if(lt(ld(2),W),if(eq(PLANE,0),a0(ld(2),Y),if(eq(PLANE,1),a1(ld(2),Y),a2(ld(2),Y))),\
  if(eq(PLANE,0),b0(ld(2)-W,Y),if(eq(PLANE,1),b1(ld(2)-W,Y),b2(ld(2)-W,Y))))"
  ffmpeg -i A.mp4 -i B.mp4 -filter_complex "[0][1]xfade=transition=custom:duration=1:offset=1:expr='$E'" \
    -c:v libx264 -pix_fmt yuv420p push.mp4
  ```

  The cubic in-out peaks at slope 3, so the push peaks at 3 × W / (d × fps): 64 px/f for 640 px over 1 s, measured ~60.

## Motion blur from sub-frames

Render `draw(t)` at 8 sub-frames a frame (240 fps), then keep each frame as the mean of its first four sub-frames:

```
node render.mjs film.html work/sub 4.5 240
ffmpeg -framerate 240 -i work/sub/f_%05d.png -vf "tmix=frames=4,select='eq(mod(n\,8)\,3)',setpts=N/30/TB" -r 30 \
  -c:v libx264 -crf 16 -pix_fmt yuv420p work/film_blur.mp4
```

- **A 180° shutter that opens on the frame:** frame f = the mean of sub-frames 8f…8f+3 (checked on a numbered source:
  192 sub-frames → 24 frames, each the mean of its four).
- **Why this phase:** with the cut on a whole frame no output frame mixes A and B. A shutter centred on the frame would
  blend the two shots on the cut frame. Tested on the momentum cut above: the cut frame stayed pure B, and the join
  still passed (ratio 1.19).
- **Keep some layers sharp** (a smash-pan's UI, SR-09; type that must read mid-move): draw them from the frame's own time,
  `const tf = Math.floor(t * 30) / 30`, so all four sub-frames match and the average stays crisp.
- **Cost:** 8× the frames. Render the blurred film last, once the joins pass.

## Seam types here

The types: [video-design.md](video-design.md#the-twelve-join-types); the neutral recipes:
[seam-craft/seam-recipes.md](seam-craft/seam-recipes.md). In a page every type is buildable, because you draw every
layer; with clips and ffmpeg alone, only the ones that need no layers.

| SR | In a page (`draw(t)`) | ffmpeg only |
|---|---|---|
| SR-01 momentum cut | easy ([above](#match-velocity-in-code)) | a cut on the peak; a slide timed to the pan |
| SR-02 anchor match cut | easy: draw the anchor once, over both shots, on one box; fade the rest of A | no: it needs the layers |
| SR-03 shape window / iris | easy: clip to the mark's `Path2D` ([recipe](#sr-03-window-through-the-mark)) | `circleopen` / `circleclose`, a circle at the centre only |
| SR-04 morph in a blur valley | medium: canvas `ctx.filter = "blur(30px)"` for the valley; an organic merge needs blur + an alpha threshold (an SVG filter in the DOM) | no |
| SR-05 shared element | easy: a rounded-rect clip from the tile's box to the frame ([recipe](#sr-05-object-becomes-the-world)) | no |
| SR-06 screen ↔ device | hard: a 2D canvas has no perspective, so a turned screen needs WebGL or CSS `matrix3d()`; the page in both shots must show the same state on the cut | no |
| SR-07 shape / colour rhyme | easy | no |
| SR-08 type choreography | medium: you lay out the letters yourself (`measureText` per letter, or DOM spans) | no |
| SR-09 crisp smash-pan | easy: easeInExpo → 1–2 jump frames → easeOutExpo on the world, kept out of the blur pass | a hard cut between two pans |
| SR-10 push-wipe / light change | easy: a clip rect on the glide curve ([recipe](#sr-10-push-wipe-with-a-stall)) | `wipeleft` / `slideleft`, linear only (no stall) unless `custom` |
| SR-11 depth swap | easy | no |
| SR-12 mark lockup | easy: `ctx.rotate(dx / r)` (canvas turns in radians) in the same draw as the move | no |

## Recipes on a canvas

Each follows its neutral recipe and was rendered and checked on a contact sheet. `ctx` is the 1920×1080 canvas's 2D
context; `drawA(t)` and `drawB(t, scale)` draw the two shots full frame; `bezier`, `clamp01` and `tween` are from
[Easing curves](#easing-curves).

### SR-03 window through the mark

B shows inside the mark; the mark flies at the lens while B inside grows slower
([SR-03](seam-craft/seam-recipes.md#sr-03--shape-window--iris)).

```js
const MARK = new Path2D("M50 4 L61 38 L96 38 L68 59 L79 94 L50 72 L21 94 L32 59 L4 38 L39 38 Z");  // 100-unit box
const quartIn = (u) => u ** 4;
function windowSeam(t, t0, dur = 33 / 30) {
  const u = clamp01((t - t0) / dur);
  drawA(t);
  const size = 1920 * (0.06 + (30 - 0.06) * quartIn(u));        // 6 % → 3000 % of the frame width
  ctx.save();
  ctx.translate(960, 540); ctx.scale(size / 100, size / 100); ctx.translate(-50, -50);
  ctx.clip(MARK); ctx.setTransform(1, 0, 0, 1, 0, 0);            // the clip stays, the transform resets
  drawB(t, 0.5 + 0.5 * quartIn(u));
  ctx.restore();
}
```

### SR-05 object becomes the world

```js
const punch = bezier(0.7, 0, 0.1, 1);
function tileSeam(t, t0, dur = 20 / 30, box = { x: 800, y: 440, w: 320, h: 200, r: 24 }) {
  const e = punch(clamp01((t - t0) / dur)), L = (a, b) => a + (b - a) * e;
  drawA(t);
  ctx.save(); ctx.beginPath();
  ctx.roundRect(L(box.x, 0), L(box.y, 0), L(box.w, 1920), L(box.h, 1080), L(box.r, 0));   // radius → 0 at full frame
  ctx.clip(); drawB(t); ctx.restore();
}
```

### SR-10 push-wipe with a stall

B's edge runs fast, stalls as a split screen, runs fast again; A drifts with it at 40 % of the edge's travel, on the same
curve ([SR-10](seam-craft/seam-recipes.md#sr-10--push-wipe--light-change)).

```js
const glide = bezier(0.2111, 0.7721, 0.8541, 0.112);            // fast – stall – fast
function pushWipe(t, t0, dur = 40 / 30) {
  const e = glide(clamp01((t - t0) / dur)), edge = 1920 * (1 - e);   // the edge runs right → left
  ctx.save(); ctx.translate(-0.4 * 1920 * e, 0); drawA(t); ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.rect(edge, 0, 1920 - edge, 1080); ctx.clip(); drawB(t); ctx.restore();
}
```

Measured on the sheet: the edge at 86 %, 70 %, then 58–47 % over the stall, then 38 % and 20 %.

## Checking

- **Every join on a 2-f contact sheet** ([Check the motion](video-design.md#check-the-motion-before-delivery)): the cut
  frames are in your code (CUT × fps).
- **Determinism:** render twice and compare (`cmp a/f_00090.png b/f_00090.png`). A difference means something reads
  the wall clock or unseeded randomness.
- **With Python,** measure every join on the render, a range included:
  [seam-check.md](seam-craft/seam-check.md#in-code-a-page-rendered-frame-by-frame-clips-joined-with-ffmpeg).

## Traps

- **Wall-clock motion.** `requestAnimationFrame` loops, timers, `Date`, `performance.now()` and CSS `transition`s move
  with real time, not with t: the frames change from run to run.
- **t rounded to 30 fps inside `draw`** collapses a 240-fps blur pass into repeated frames. Round nowhere, or to the
  render's own rate.
- **Chained eases stop at the join** ([Easing curves](#easing-curves)).
- **Fonts after frame 0** shift every measured position on the first frames.
- **GPU and software rasterising differ** on anti-aliased edges: render every frame and still with the same Chrome flags.
- **An image sequence without `-framerate`** before `-i` is read at 25 fps.
- **`-pix_fmt yuv420p`** needs an even width and height.
- **`-c copy` cuts only on keyframes:** re-encode (the `concat` filter) for a frame-exact cut.
- **`xfade` inputs** must match in size, format, frame rate and timebase ([Transitions with xfade](#transitions-with-xfade)).
- **Slow drifts on hairlines and small type** can shimmer as sub-pixel positions are anti-aliased differently each
  frame. Look at a 2-f sheet; put slow drifts on the world or backdrop.
- **Frame rate.** The motion grammar's numbers are at 30 fps: at 60 fps per-frame speeds halve and frame counts double
  ([the units](video-design.md#motion-grammar)). `seam_check` reads the render's own fps.

## Sources

- Tested here: puppeteer-core 25.16 with the local Chrome, ffmpeg 7.1.1 (`ffmpeg -h filter=xfade`), GSAP 3.14.2, and
  `seam_check` / `film_profile` on every render. The external pages are linked where they are used.
- Canvas rounded clips: [roundRect](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/roundRect).

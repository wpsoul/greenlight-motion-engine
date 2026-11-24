// The scene script, explained — ONE text for every way in: the connector's get_motion_guide (cloud/mcp-worker motion.mjs:
// the chat's intro, files and review loop around these sections) and the npm package's skill/references/scene-script.md
// (motion-engine/scripts/prepare.mjs: the CLI's way around them). `host` is 'chat' or 'cli': where the reader finds a
// reference (a tool or a file) and where pictures come from.
import { FORMATS, CROSS_TRANSITIONS, SHADERS, CAMERAS, presetCatalog, cameraCatalog, WORLD_FIELDS, WORLD_MOVES } from './sceneScript.js';
// bundled as text (motion-engine/scripts/build-script.mjs)
import DESIGN from '../../../skills/greenlight-dash/references/video/design.md';

export const PREFERRED = {
  text: ['glide-text', 'ember-type', 'marker', 'outline-pass', 'neon-flow', 'glitch', 'swing-pop', 'pendulum', 'fan-deal', 'whip', 'word-swing', 'letter-vortex'],
  transitions: ['Cross Fade', 'Advanced Zoom', 'Advanced Movement', 'Circular Wipe', 'Pixel Blocks', 'Camera Whip', 'Zoom Ruler', 'Gradient Glow Stack', 'Gradient Map'],
  overlay: ['bloom', 'lightRays', 'gradientSweep', 'rgbSplit', 'halftone', 'colorama', 'fastCameraWiggle', 'radialFastBlur', 'echo', 'filmStock'],
  layer: ['runningGlow', 'motionBlur', 'motionTrail', 'glass', 'repetile', 'droste'],
};
const refOf = (host, topic) => (host === 'chat' ? `get_motion_reference "${topic}"` : `references/${topic}.md`);

/** "## The scene script": the format, with an example. */
export function scriptFormatGuide(host = 'chat') {
  return `## The scene script

**Before the script, a direction.** Presets make a video move; they don't give it an idea. Decide in a few lines first,
and keep them next to the script:
- **The idea**: ONE picture from the subject's own world (its object, place or action: a coffee shop's steam and cup rim,
  a budgeting app's receipt printing line by line, a running app's track the scenes run along), carried through every scene.
- **The palette**: background, text, one accent, plus only the colours that carry meaning (good / bad, before / after).
  Light or dark on purpose.
- **The type**: a big headline against a small support line; aligned left or centred on purpose, not by default.
- **Each scene**: what it SHOWS besides its words, built from shapes, lines, \`svg\` you write, keyframes and the camera.
The same line centred on a gradient in every scene reads as a template. Judge the stills against the direction, not
only for mistakes.${host === 'cli' ? `
What a script can't say (a custom GLSL shader on a shape or the background, words dipping under a surface with a track
matte, masks, particles, 3D) goes on from \`project.json\`: SKILL.md, "Beyond the script".` : ''}

\`\`\`json
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
        { "type": "text", "text": "Opening day: 2 for 1", "role": "body", "color": "#1b120d", "start": 0.3, "enter": "pop-overshoot" } ] },
    { "name": "Close", "duration": 2.4, "transition": "Gradient Glow Stack", "background": { "shader": "silk", "look": "sunset" },
      "camera": { "move": "cm-quiet-push", "dof": { "focus": "street", "aperture": 50 } },
      "elements": [
        { "type": "circle", "w": 420, "color": "#fff3e0", "opacity": 0.3, "at": [330, -60], "z": -700 },
        { "id": "street", "type": "text", "text": "12 Elm Street", "role": "headline", "textAnimation": "word-swing" },
        { "type": "text", "text": "OPEN 7 – 7", "role": "label", "at": [0, 130], "start": 0.8, "letterSpacing": 6 } ] }
  ]
}
\`\`\`

- **format** ${Object.keys(FORMATS).join(' · ')} (${Object.entries(FORMATS).map(([k, [w, h]]) => `${k} = ${w}×${h}`).join(', ')}). Sizes and positions are in those pixels.
- **style**: \`background\`, \`colors\` { text, accent, muted }, \`font\`: ${host === 'chat'
    ? 'a Google Fonts family (the page loads it from Google Fonts)'
    : 'a Google Fonts family (the page loads it from Google Fonts while online) or any font whose file you put in assets/ named after it (`Manrope.ttf`, .otf, .woff, .woff2: used offline)'}.
- **at**: \`center\` \`top\` \`bottom\` \`left\` \`right\` \`top-left\` … or \`[x, y]\` px from the centre (+y is down). Keep text inside the middle 80 %.
- **text**: \`role\` headline | subhead | body | label sets size and weight (override with \`size\`, \`weight\`); \`color\` text | accent | muted | #hex |
  a CSS gradient; \`width\` (px, wraps), \`align\`, \`uppercase\`, \`letterSpacing\`, \`lineHeight\`. A headline gets \`glide-text\` unless you set \`textAnimation\`.
  The text box is CENTRED on \`at\`: without \`width\` it is as wide as its words but stays inside the frame (off-centre text wraps
  sooner); for a left-aligned column give \`width\` and \`"align": "left"\` and put \`at\` at the column's centre.
- **rect · pill · circle**: \`w\`, \`h\`, \`color\` (or a CSS gradient), \`radius\`, \`border\` {width, color}, \`shadow\`: true. They enter with \`pop-overshoot\` unless you set \`enter\` (\`"none"\`: no entrance, it is simply there).
- **line**: from \`at\` to \`to\`, \`width\`, drawn on (\`draw\`: false to skip).
- **ring**: a circle drawn as a stroke from the top, clockwise (a timer, a status or focus ring): \`w\` (diameter), \`width\` (stroke),
  \`color\`, \`sweep\` (degrees, 360 = full), drawn on (\`draw\`: false to skip), \`drain\`: true empties it again by the element's
  end (a countdown) or \`[start, end]\` (s into the element) empties it then, \`ghost\` (0–100: a faint full track under it).
- **image · video**: \`src\` (${host === 'chat' ? "a link or the user's file — below" : "a file in the folder's assets/ as `asset:<name>`, or an https link"}) or, for an image, \`svg\` (SVG markup you write); \`w\` or \`h\`
  (px; the other follows the file's shape) or \`fit\` cover | contain
  (default: a video covers the frame, a picture sits at 70 % of contain), \`rotate\` (deg). A video also takes
  \`startAt\` (s into the file) and \`volume\` (0–100, default muted). No entrance unless you set \`enter\`.
- **html**: an HTML page as a layer — an interface (a product screen, an app window, a dashboard, a chat, a code editor) or a shot
  only code draws. The page: \`html\` (the whole document, written here: \`"<!doctype html><html>…</html>"\`, up to 512 KB) or \`src\`
  (${host === 'cli' ? "a page file in the folder's assets/ as `asset:<page>.html`" : "the user's own page file, `asset:<name>.html`, added on the page"}); \`page\`: its own size [width, height] in px (the frame's without
  it), which the layer fits into the frame; \`w\` or \`h\` (px) or \`fit\` cover | contain; \`startAt\` (s into the page), \`rotate\`.
  The engine draws the page itself, frame by frame on the video's clock: nothing is recorded first. It needs Chrome 157 or
  newer${host === 'cli' ? ' (`doctor` says)' : ': elsewhere the layer is empty, and look_at_video says so'}. ${host === 'cli'
    ? "The page's CSS animations, `requestAnimationFrame`, timers, `performance.now()` and videos follow the video's time. Its own files go beside it (`<img src=\"img/logo.png\">`), or name any file of the folder as `asset:<name>`."
    : "**No script runs in a page here** (in this chat and on a shared link alike): its motion is CSS `@keyframes` animations, SVG `<animate>` and `<video>`, all set to the video's time; JavaScript, `requestAnimationFrame` and timers do nothing. Pictures in it: inline SVG, CSS, or the user's files as `asset:<name>` (an https picture is blocked here: put it as an image element over or under the page)."}
  A transparent background lets the layers behind show; keep the words a person will change (titles, captions, a price) as
  text elements over the page, not in it. No entrance unless you set \`enter\`.
- **Keyframes on any element** — your own motion: \`"keyframes": { "x": [[0, -400], [0.8, 0, "Smooth Glide"]], "scale": [[0, 0.9], [2, 1.05]] }\`
  — tracks x, y (px offsets from \`at\`), scale, rotate (deg), opacity (0–1); each key [seconds into the element, value, easing of the
  segment after it — Smooth Glide, AE Smooth, Expo Out, Power, Punch, Apple Out, Back Out, Elastic, Linear …]. They replace an entrance's keys on the same track;
  one key holds that value for the whole element.
- **Every element**: \`start\` / \`end\` (s within its scene; default: staggered 0.12 s, to the scene's end), \`enter\` / \`exit\` (keyframe presets, \`direction\` up | down | left | right
  for directional ones), \`effects\`: [{ "id", "params"? }], \`id\`, \`label\` (its name in the page's options), \`opacity\` (0–1),
  \`z\` (px of depth, + toward the viewer, default 0: a real camera's dolly, orbit and depth of field separate layers by it), \`locked\`: true
  (the scene's camera doesn't move it: a logo, a caption). Keyframes also take a \`z\` track.
- **Scene**: \`duration\` (s), \`transition\` into it (default Cross Fade, 0.6 s; \`transitionDuration\`), \`transitionOptions\` (the
  transition's own settings, e.g. Circular Wipe's \`point\` { x, y } (% of the frame from its top-left: 50, 50 is the centre) and \`feather\`; ${host === 'chat' ? 'every option: get_motion_reference "video-transitions"' : 'every option: `npx greenlight-motion schema transitions`'}.
  A transition's vivid colours, such as Circular Wipe's beam, take the accent unless you set them; over a light backdrop Circular
  Wipe's glowing beam is off, since it flares there, unless you set \`beam\`), \`camera\` (below; default push-in),
  \`background\` (overrides style).
  **A transition overlaps the scenes on both sides**, so the video lasts the scenes' durations added up MINUS every
  transition: five 3 s scenes with the default 0.6 s transitions run 15 − 4 × 0.6 = 12.6 s. To hit a length, add the
  transitions back to the scenes (${host === 'chat' ? 'build_video' : '`script`'} prints the total).
- **Sound**: the script adds none and the engine has no sounds of its own. A film's sounds and music are files, chosen in the
  order the design rules give (${refOf(host, 'video-design')}, Sound): what the user gave or named, then their own library or
  files, then generated with a tool they have or found in an open source. Music goes in \`music\` (below); a sound effect is an
  audio clip at the second of its event, added after the script ${host === 'chat' ? 'with edit_video' : 'with \`apply\` (\`events\` gives the seconds)'}.
- **camera** — a quick move of the whole scene: ${CAMERAS.join(' | ')}. Or a REAL camera that films the scene's elements in 3D (the
  Video Editor's own camera layer; the scene's backdrop stays put, so its edge never shows). One of:
  - \`{ "move": id }\` — a camera move from the catalogue (or just \`"camera": "cm-quiet-push"\`), spread over the scene;
  - \`{ "rig": id }\` or \`{ "rig": { "preset"?: id, "type"?, …fields } }\` — an orbit, crane, push-in, truck, spiral, handheld or follow move
    (\`"camera": "heroOrbit"\` works too). A \`follow\` rig rides elements: \`"targets": [element ids]\`. Layers are flat: keep an orbit within about
    ±70° of the front (heroOrbit, slowReveal) or they turn edge-on and read mirrored;
  - \`{ "zooms": [{ "start", "end", "at"?, "zoom"? }], "feel"? }\` — zoom in on spots and back out, like a screen recording's Smart Zoom: \`at\` as for
    elements (the spot to frame, clamped so the view stays inside the frame), \`zoom\` 1.05–4 (default the feel's, about 1.45), each zoom at least
    0.4 s and none overlapping; \`feel\` studio | calm | precise | lively | follow (the spring). Put a screen recording in as a video element (or the
    scene's video background) and zoom on what it shows;
  - \`{ "keyframes": { zoom | x | y | roll | dolly | tiltX | tiltY | focusZ: [[seconds, value, easing?], …] } }\` — your own move: zoom (×, 1 = none),
    x / y (px the camera pans right / down), roll / tilt (deg), dolly (px toward the scene: it changes perspective, so layers at different \`z\` part).
    With a \`move\` they replace its track; a rig drives x, y, roll, dolly and tilt itself and zooms drive zoom, x and y, so key only the others there.
  - plus \`"dof": { "focus": element id | "focusZ": px, "aperture"?: 40, "blur"?: 100 }\` (or \`true\`) — depth of field: what sits at another \`z\` blurs;
    the focus stays on its subject while the camera dollies or rides a rig. \`focusZ\` keys are a rack focus (measured from where the camera starts).
  - \`start\` / \`end\` (s in the scene; default the whole scene; outside them the camera rests). Keys and zooms count seconds into the camera.
- **background**: a colour, a CSS gradient, { "shader": id, "look"? } — shaders: ${SHADERS.join(', ')} (looks: ${refOf(host, 'video-backgrounds')}) — or { "image": src } / { "video": src } (covers the frame; b-roll behind the scene).
- **music** (script level): \`"music": { "src": file, "volume": 80, "fadeIn": 0.3, "fadeOut": 1.2, "startAt": 0 }\` — one track under the video.${host === 'chat' ? '' : `
  The file must exist when you run \`script\` (it reads its length): write a sound you make in code before the first run.`}

`;
}

/** The design rules — the app skill's references/video/design.md, the ONE text the app's agents, the CLI's skill and the
 *  chat read — with its headings one level down, to sit inside a guide. */
export function designGuide() {
  return `${DESIGN.replace(/^(#+) /gm, '#$1 ').trim()}\n\n`;
}

/** "## Catalogues": text animations, entrances, exits, transitions, effects (caps = schema/capabilities.json). */
export function catalogueGuide(caps, host = 'chat') {
  const cat = presetCatalog();
  const cam = cameraCatalog();
  const star = (line, ids) => (ids.some((id) => line.startsWith(`\`${id}\``)) ? `★ ${line}` : line);
  const fx = (list) => (list || []).filter((e) => !['grain', 'lensPrism', 'linesDraw', 'sdfLensBlur'].includes(e.id)).map((e) => (PREFERRED.overlay.includes(e.id) || PREFERRED.layer.includes(e.id) ? `★ \`${e.id}\`` : `\`${e.id}\``)).join(', ');
  return `## Catalogues

**Text animations** (\`textAnimation\`; ★ = preferred): ${cat.text.map((l) => star(l, PREFERRED.text)).join(' · ')}

**Entrances** (\`enter\`): ${cat.enter.join(' · ')}

**Exits** (\`exit\`): ${cat.exit.join(' · ')}

**Transitions** (★ = preferred): ${CROSS_TRANSITIONS.map((t) => (PREFERRED.transitions.includes(t) ? `★ ${t}` : t)).join(' · ')}

**Camera moves** (\`camera.move\`; spread over the camera's length): ${cam.moves.join(' · ')}

**Camera rigs** (\`camera.rig\`; the fields you can override: type ${cam.rigTypes.join(' | ')}, aim ${cam.rigAims.join(' | ')}, ${cam.rigFields.join(', ')}): ${cam.rigs.join(' · ')}

**Zoom feels** (\`camera.feel\`): ${cam.feels.join(' · ')}. Full camera layers (paths, Smart Zoom on a recording's clicks, the drawn cursor): ${refOf(host, 'video-camera')}.

**Overlay effects** (\`effects\`): ${fx(caps?.effects?.overlay)}

**Layer effects** (\`effects\`): ${fx(caps?.effects?.layer)}

Effect params: ${refOf(host, 'video-effects')}.

`;
}

/** "## A 3D Scene: world": a real 3D scene (the Video Editor's Scene layer) in the script, checked field by field. */
export function worldGuide(host = 'chat') {
  const help = host === 'chat' ? 'get_motion_reference "world3d" (with `path`, `op` or `q` for one field)' : 'references/video-world3d.md and references/world3d-schema.json';
  // (engine056, owner 2026-11-19) the CLI's guide (skill/references/scene-script.md): 3D in a video IS the Scene, for any 3D shot; the
  // bundled devices may come ready-made as model3d layers added after \`script\`. The chat's text is unchanged.
  const intro = host === 'cli' ? `3D in a video is GreenLight Dash's own 3D Scene: give the script a \`world\` (the same \`rig.scene\` JSON its editor
stores), drawn in Draft as it plays and path traced in Final — for any shot that is 3D (a product, a device, a room, a logo
or title in depth, abstract forms, a camera moving through space), not only a product on a table. You model what the shot
needs yourself; keep it SIMPLE: objects built from ops (box, cylinder, lathe, extrude, bevel…), materials (glass, liquids,
metals, wood and other procedural patterns), up to a few lights, a bundled HDR environment, \`scene.camera\` or a ready move.
A device the brief names that is among the bundled presets (\`iphone_pro_max\`, \`iphone_air\`, \`double_iphone\`, \`ipad\`,
\`ipad_mini\`, \`macbook_pro\`, \`macbook_air\`, \`imac\`) may be taken ready-made: after \`script\`, add a \`model3d\` layer with
\`"url": "model-preset:<id>"\` to project.json (references/video-world3d.md, a device from the preset table: its own channel
and \`model3dConfig\`, with an example; its screen picture in \`screen\`, \`{ "url": "asset:<file>", "fitMode": "cover" }\`); it
stands in the Scene's world, lit by it, path traced in Final, its screen artwork kept. Model a device yourself, or use
another model, only when the brief asks. A \`model3d\` layer or a camera layer on a flat comp with no \`world\` is not how 3D is done. No files of your own in the
Scene's \`world\` here (big scenes with meshes and textures belong in GreenLight Dash).` : `For a real 3D shot — a product on a table, a bottle with liquid, a gadget turning under studio light — give the script a
\`world\`: GreenLight Dash's own 3D Scene (the same \`rig.scene\` JSON its editor stores), drawn in Draft as it plays and
path traced in Final. Keep it SIMPLE: objects built from ops (box, cylinder, lathe, extrude, bevel…), materials (glass,
liquids, metals, wood and other procedural patterns), up to a few lights, a bundled HDR environment. No files of your own
in a 3D Scene here (big scenes with meshes and textures belong in GreenLight Dash or a local run with the npm package).`;
  return `## A 3D Scene: \`world\`

${intro}
\`scenes\` become optional: 2D titles over the world, see-through unless a scene sets its own \`background\`.

\`\`\`json
{ "format": "16:9", "title": "Éclat", "world": {
    "duration": 4,
    "camera": { "move": "orbit", "amount": 30 },
    "render": { "mode": "draft" },
    "look": { "contrast": 1.15, "bloom": 0.06, "vignette": 0.2 },
    "scene": {
      "camera": { "at": [0, 0.2, 0.75], "target": [0, 0.1, 0], "fov": 30 },
      "env": { "intensity": 0.3, "opaque": true },
      "lights": [{ "id": "key", "type": "area", "at": [-0.5, 0.6, 0.5], "target": [0, 0.1, 0], "width": 0.5, "height": 0.5, "intensity": 6 },
                 { "id": "rim", "type": "spot", "at": [0.3, 0.5, -0.4], "target": [0, 0.1, 0], "angle": 25, "penumbra": 0.4, "intensity": 4 }],
      "materials": {
        "wood": { "procedural": { "pattern": "wood", "planks": 3 }, "uvScale": [2, 2] },
        "glass": { "roughness": 0.02, "transmission": 1, "ior": 1.5, "priority": 1 },
        "perfume": { "transmission": 1, "ior": 1.36, "attenuationColor": "#e8a440", "attenuationDistance": 0.3, "priority": 2 },
        "gold": { "metal": "gold", "roughness": 0.2 } },
      "objects": [
        { "id": "table", "material": "wood", "at": [0, -0.02, 0], "graph": [{ "op": "box", "size": [1.2, 0.04, 0.7], "bevel": 0.004 }, { "op": "uvBox" }] },
        { "id": "bottle", "material": "glass", "at": [0, 0.001, 0], "graph": [{ "op": "cylinder", "radiusTop": 0.045, "radiusBottom": 0.045, "height": 0.16, "bevel": 0.006 }, { "op": "transform", "at": [0, 0.08, 0] }] },
        { "id": "liquid", "material": "perfume", "at": [0, 0.001, 0], "graph": [{ "op": "cylinder", "radiusTop": 0.0395, "radiusBottom": 0.0395, "height": 0.11 }, { "op": "transform", "at": [0, 0.06, 0] }] },
        { "id": "cap", "material": "gold", "at": [0, 0.177, 0], "graph": [{ "op": "cylinder", "radiusTop": 0.02, "radiusBottom": 0.02, "height": 0.03, "bevel": 0.003 }] } ] } },
  "scenes": [{ "duration": 4, "elements": [{ "type": "text", "text": "ÉCLAT", "role": "headline", "at": "top" }] }] }
\`\`\`

- \`world\` takes ${WORLD_FIELDS.map((f) => `\`${f}\``).join(', ')}. \`scene\`, \`render\` and \`look\` are GreenLight Dash's
  \`rig.scene\`, \`rig.render\` and \`rig.look\`: every field, op and material is in ${help}. Units are metres (model things at their
  real size: the perfume bottle above is 16 cm tall), Y is up.
- **What \`world\` sets for you:** no Rig lights and no Rig backdrop (it writes \`renderer: "world"\`, \`lights: []\`,
  \`cyclorama: none\`): the light is \`scene.lights\` plus \`scene.env\` (a bundled HDRI, \`studio_small_03_1k\` unless
  \`env.hdri\` names another \`/hdr/<name>.hdr\` of the ten presets), and a floor, table or studio sweep is an object you model
  (a box; a sweep is an \`extrude\` of an L-shaped profile with a rounded corner).
- **Checked strictly.** A field the 3D engine would ignore (a typo, a three.js name such as \`emissive\`, \`position\`, \`color\` on a
  liquid) fails the build with its path and the right name (\`world.scene.materials.glass.transmision: … did you mean
  \`transmission\`?\`), as does an unknown op or parameter, a material or parent that is not there, a broken lathe profile.
  An op that fails only when the geometry is built (a boolean that cannot be made) shows in look_at_video's critique:
  "the scene did not build: …".
- **The camera:** \`scene.camera\` (\`at\`, \`target\`, \`fov\`, \`keys\` for your own moves) or a ready move in \`world.camera\`: one
  smooth in-out move over the whole clip, always looking at \`target\`. \`push-in\` starts at \`scene.camera.at\` and ends
  \`amount\` of the way to the target (0–0.9 [0.25]); \`pull-out\` is the same backwards. \`orbit\` turns around the target by
  \`amount\` degrees in all [40]; \`rise\` goes up by \`amount\` of the distance [0.25]; \`slide-left\` / \`slide-right\` move
  sideways by \`amount\` of the distance [0.25], the target with them. These three are centred on \`scene.camera.at\`: half
  the amount before it, half after, so frame the middle of the clip there. A scene's own 2D \`camera\` defaults to \`none\`
  over a world (titles hold still).
- **Camera moves, worked.** Frame the subject with room to spare: the critique samples the whole move (every key and evenly
  between them) and names an object the move takes out of the frame, and when.
  - *Orbit* around a product: \`"camera": { "move": "orbit", "amount": 40 }\` with \`"scene": { "camera": { "at": [0, 0.22, 0.8],
    "target": [0, 0.09, 0], "fov": 30 } }\`. The middle of the clip is shot from \`at\`; the turn goes 20° to each side, so a
    framing that is tight from the front clips a wide object at the ends: step back (a longer \`at\`) or turn less.
  - *Push-in* to a detail: \`"camera": { "move": "push-in", "amount": 0.35 }\` starts at \`scene.camera.at\` and ends 35 % of the
    way to \`target\`, so the last frame is the tightest: aim \`target\` at the detail (the label, the cap). Your own keys do the
    same with a lens change: \`"keys": { "at": [{ "t": 0, "v": [0, 0.2, 1], "ease": "inOut" }, { "t": 4, "v": [0, 0.14, 0.5] }],
    "fov": [{ "t": 0, "v": 30, "ease": "inOut" }, { "t": 4, "v": 24 }] }\`.
  - *Rack focus* (depth of field): \`"camera": { "at": [0.25, 0.12, 0.55], "target": [0, 0.08, 0], "fov": 28, "fStop": 2,
    "keys": { "focus": [{ "t": 0.8, "v": 0.42, "ease": "inOut" }, { "t": 2.2, "v": 0.78 }] } }\`: sharp on what stands 0.42 m from
    the camera, then on what stands 0.78 m away. \`focus\` is a distance in metres along the view (for an object at p:
    (p − at)·(target − at) / |target − at|); \`"@id"\` holds the focus on an object, but keys from one \`"@id"\` to another jump
    instead of racking, so key distances. A low \`fStop\` (1.4–2.8) makes the blur strong; leave \`fStop\` out for all sharp.
    Draft blurs roughly; judge it in Final. Focus keys go with a ready move too: a push-in with \`"focus": "@bottle"\` stays sharp on the bottle.
- **Titles over it:** \`scenes\` are 2D layers over the world, see-through unless a scene sets its own \`background\`
  (\`style.background\` does not cover the world). Keep a title clear of the objects: a 2D layer stands in the world's depth
  (about 2.2 m from the camera at 1080 px high), so an object nearer the camera that overlaps it hides its letters. Put it where
  the frame is calm and has the contrast its colour needs: a light title on a light set vanishes. The critique below gives each
  object's span in % of the frame and checks every 2D layer: how much of it the objects hide, its contrast against what is
  under it, whether it leaves the frame or the title-safe area (5 % in from each edge), and texts that overlap. The video is as long as the scenes and the world
  lasts all of it (\`world.duration\` counts only for a world with no scenes).
- **Draft and Final.** \`render.mode\` \`"draft"\` (default) plays live; \`"final"\` path traces every frame (\`spp\` 16–64 here):
  seconds per frame, so render Final only for the finished version, and short. Judge glass and liquids in Final: Draft shows no
  liquid inside glass and no refraction, and only a rough depth of field.
${host === 'chat' ? `- **How long a Final may be here.** A Final MP4 costs its seconds × \`spp\` (× fps / 30 × its pixels over 1080p). In this chat
  render_video renders up to **10 s at 64 samples per pixel** (1080p, 30 fps) at once; for anything costlier it answers with what
  it costs instead: tell the user and ask, and with their yes call render_video again with \`confirm_long_final: true\`. The
  page's own Render MP4 asks the same way (a second press renders). The contact sheet is six frames whatever the length.
- **A long render, and the user's own GPU farm.** The page measures how long the render would take on the user's computer; past 2
  minutes it shows that time ("this computer stays busy") and, where the user connects it on the page, their own GPU farm (e.g.
  RunPod): its time and price for this video, 1–10 pods, a spend cap — no length cap there. You may tell the user it exists; never ask
  for, repeat or handle their farm key (it is typed on the page and goes only to the farm), and never start a farm render yourself.
- **The page's 3D: preview and render.** A video with a \`world\` opens on its page with Draft 3D | Final 3D in the player bar,
  always on Draft: it is the preview's own (under Final the paused frame is path traced; playing stays Draft), never kept and never
  reported to you. Render MP4, render_video, the contact sheet and look_at_video follow your \`world.render.mode\`. The page's Render
  pane has Draft 3D | Final 3D too: when the user renders the other mode there, their review and look_at_video say so ("3D: Final —
  the user switched …"): keep their choice in \`world.render.mode\` when you build again. Final frames are drawn only when asked:
  look_at_video has the page trace them (about a minute) and may answer that it is drawing them — call it again then; never
  describe frames you haven't seen.
- **The 3D plugin.** The 3D engine is a plugin of GreenLight Motion (\`greenlight-motion-3d\`): the page downloads it in the
  user's browser the first time a video with a \`world\` opens (about 5 MB to start; physics, simulations and the denoiser
  only when a scene uses them), so the first 3D build takes a few seconds longer. The user can get it ahead with **Download 3D
  plugin** in the page's Project tab, for example before you build a 3D scene from zero. A browser without WebGPU cannot run it:
  the page says so.
` : `- **No length limit here** (the chat caps a Final MP4 at 10 s at 64 samples; locally the only limit is your GPU's time).
- **The 3D plugin.** The 3D engine is a separate package, \`greenlight-motion-3d\`: \`script\`, \`build\`, \`check\`, \`stills\`
  and \`render\` get it by themselves the first time a folder has a \`world\` (into the user's cache, once per version);
  \`npx greenlight-motion add-3d\` gets it now, \`doctor\` says which version is there. Offline, point
  \`GREENLIGHT_MOTION_3D\` at an unpacked copy or its .tgz.
`}- **Its critique.** look_at_video on a build with a world adds a critique of the middle frame: what the shot shows object by
  object (its share of the frame, where it stands, what hides it, what is out of the camera), where each light stands against
  the subject, the picture's numbers, and hints naming the field to change. Fix what it names, then build again.

`;
}

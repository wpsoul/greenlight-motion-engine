// The scene script, explained — ONE text for every way in: the connector's get_motion_guide (cloud/mcp-worker motion.mjs:
// the chat's intro, files and review loop around these sections) and the npm package's skill/references/scene-script.md
// (motion-engine/scripts/prepare.mjs: the CLI's way around them). `host` is 'chat' or 'cli': where the reader finds a
// reference (a tool or a file) and where pictures come from.
import { FORMATS, CROSS_TRANSITIONS, SHADERS, CAMERAS, presetCatalog, cameraCatalog } from './sceneScript.js';
// bundled as text (motion-engine/scripts/build-script.mjs)
import DESIGN from '../../../skills/greenlight-dash/references/video-design.md';

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
        { "type": "text", "text": "Opening day: 2 for 1", "role": "body", "color": "#1b120d", "start": 0.3, "enter": "pop-overshoot", "sound": "data-1" } ] },
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
- **rect · pill · circle**: \`w\`, \`h\`, \`color\` (or a CSS gradient), \`radius\`, \`border\` {width, color}, \`shadow\`: true. They enter with \`pop-overshoot\` unless you set \`enter\`.
- **line**: from \`at\` to \`to\`, \`width\`, drawn on (\`draw\`: false to skip).
- **ring**: a circle drawn as a stroke from the top, clockwise (a timer, a status or focus ring): \`w\` (diameter), \`width\` (stroke),
  \`color\`, \`sweep\` (degrees, 360 = full), drawn on (\`draw\`: false to skip), \`drain\`: true empties it again by the element's
  end (a countdown), \`ghost\` (0–100: a faint full track under it).
- **image · video**: \`src\` (${host === 'chat' ? "a link or the user's file — below" : "a file in the folder's assets/ as `asset:<name>`, or an https link"}) or, for an image, \`svg\` (SVG markup you write); \`w\` or \`h\`
  (px; the other follows the file's shape) or \`fit\` cover | contain
  (default: a video covers the frame, a picture sits at 70 % of contain), \`rotate\` (deg). A video also takes
  \`startAt\` (s into the file) and \`volume\` (0–100, default muted). No entrance unless you set \`enter\`.
- **Keyframes on any element** — your own motion: \`"keyframes": { "x": [[0, -400], [0.8, 0, "Smooth Glide"]], "scale": [[0, 0.9], [2, 1.05]] }\`
  — tracks x, y (px offsets from \`at\`), scale, rotate (deg), opacity (0–1); each key [seconds into the element, value, easing of the
  segment after it — Smooth Glide, AE Smooth, Expo Out, Back Out, Elastic, Linear …]. They replace an entrance's keys on the same track.
- **Every element**: \`start\` / \`end\` (s within its scene; default: staggered 0.12 s, to the scene's end), \`enter\` / \`exit\` (keyframe presets, \`direction\` up | down | left | right
  for directional ones), \`effects\`: [{ "id", "params"? }], \`sound\` (played at its start), \`id\`, \`label\` (its name in the page's options), \`opacity\` (0–1),
  \`z\` (px of depth, + toward the viewer, default 0: a real camera's dolly, orbit and depth of field separate layers by it), \`locked\`: true
  (the scene's camera doesn't move it: a logo, a caption). Keyframes also take a \`z\` track.
- **Scene**: \`duration\` (s), \`transition\` into it (default Cross Fade, 0.6 s; \`transitionDuration\`), \`transitionOptions\` (the
  transition's own settings, e.g. Circular Wipe's \`point\` { x, y } (% of the frame from its top-left: 50, 50 is the centre) and \`feather\`; ${host === 'chat' ? 'every option: get_motion_reference "video-transitions"' : 'every option: `npx greenlight-motion schema transitions`'}.
  A transition's vivid colours, such as Circular Wipe's beam, take the accent unless you set them), \`camera\` (below; default push-in),
  \`background\` (overrides style), \`sounds\`: [{ "sfx", "at" }]. Script-level \`sound\`: auto (default: a whoosh on each transition and
  on the first headline, from the GreenLight sound library${host === 'chat' ? '' : ', which the CLI downloads into assets/sounds/ when it builds'}) | none (nothing from the library: when
  nothing may be downloaded, use \`music\` with a file you made).
  **A transition overlaps the scenes on both sides**, so the video lasts the scenes' durations added up MINUS every
  transition: five 3 s scenes with the default 0.6 s transitions run 15 − 4 × 0.6 = 12.6 s. To hit a length, add the
  transitions back to the scenes (${host === 'chat' ? 'build_video' : '`script`'} prints the total).
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

/** The design rules — the app skill's references/video-design.md, the ONE text the app's agents, the CLI's skill and the
 *  chat read — with its headings one level down, to sit inside a guide. */
export function designGuide() {
  return `${DESIGN.replace(/^(#+) /gm, '#$1 ').trim()}\n\n`;
}

/** "## Catalogues": text animations, entrances, exits, transitions, effects, sounds (caps = schema/capabilities.json). */
export function catalogueGuide(caps, host = 'chat') {
  const cat = presetCatalog();
  const cam = cameraCatalog();
  const star = (line, ids) => (ids.some((id) => line.startsWith(`\`${id}\``)) ? `★ ${line}` : line);
  const sounds = {};
  for (const [id, sd] of Object.entries(caps?.sounds?.library || {})) if (sd.category !== 'Voice Clips & Memes') (sounds[sd.category] ||= []).push(`${id} (${sd.duration}s)`);
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

**Sounds** (\`sound\`, \`sounds[].sfx\`):
${Object.entries(sounds).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n')}

`;
}

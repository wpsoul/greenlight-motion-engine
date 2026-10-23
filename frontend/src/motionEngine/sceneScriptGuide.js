// The scene script, explained — ONE text for every way in: the connector's get_motion_guide (cloud/mcp-worker motion.mjs:
// the chat's intro, files and review loop around these sections) and the npm package's skill/references/scene-script.md
// (motion-engine/scripts/prepare.mjs: the CLI's way around them). `host` is 'chat' or 'cli': where the reader finds a
// reference (a tool or a file) and where pictures come from.
import { FORMATS, CROSS_TRANSITIONS, SHADERS, CAMERAS, presetCatalog } from './sceneScript.js';

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
      "elements": [
        { "type": "text", "text": "12 Elm Street", "role": "headline", "textAnimation": "word-swing" },
        { "type": "text", "text": "OPEN 7 – 7", "role": "label", "at": [0, 130], "start": 0.8, "letterSpacing": 6 } ] }
  ]
}
\`\`\`

- **format** ${Object.keys(FORMATS).join(' · ')} (${Object.entries(FORMATS).map(([k, [w, h]]) => `${k} = ${w}×${h}`).join(', ')}). Sizes and positions are in those pixels.
- **at**: \`center\` \`top\` \`bottom\` \`left\` \`right\` \`top-left\` … or \`[x, y]\` px from the centre (+y is down). Keep text inside the middle 80 %.
- **text**: \`role\` headline | subhead | body | label sets size and weight (override with \`size\`, \`weight\`); \`color\` text | accent | muted | #hex |
  a CSS gradient; \`width\` (px, wraps), \`align\`, \`uppercase\`, \`letterSpacing\`, \`lineHeight\`. A headline gets \`glide-text\` unless you set \`textAnimation\`.
- **rect · pill · circle**: \`w\`, \`h\`, \`color\` (or a CSS gradient), \`radius\`, \`border\` {width, color}, \`shadow\`: true. They enter with \`pop-overshoot\` unless you set \`enter\`.
- **line**: from \`at\` to \`to\`, \`width\`, drawn on (\`draw\`: false to skip).
- **image · video**: \`src\` (${host === 'chat' ? "a link or the user's file — below" : "a file in the folder's assets/ as `asset:<name>`, or an https link"}) or, for an image, \`svg\` (SVG markup you write); \`w\` or \`h\`
  (px; the other follows the file's shape) or \`fit\` cover | contain
  (default: a video covers the frame, a picture sits at 70 % of contain), \`rotate\` (deg), \`opacity\` (0–1). A video also takes
  \`startAt\` (s into the file) and \`volume\` (0–100, default muted). No entrance unless you set \`enter\`.
- **Keyframes on any element** — your own motion: \`"keyframes": { "x": [[0, -400], [0.8, 0, "Smooth Glide"]], "scale": [[0, 0.9], [2, 1.05]] }\`
  — tracks x, y (px offsets from \`at\`), scale, rotate (deg), opacity (0–1); each key [seconds into the element, value, easing of the
  segment after it — Smooth Glide, AE Smooth, Expo Out, Back Out, Elastic, Linear …]. They replace an entrance's keys on the same track.
- **Every element**: \`start\` / \`end\` (s within its scene; default: staggered 0.12 s, to the scene's end), \`enter\` / \`exit\` (keyframe presets, \`direction\` up | down | left | right
  for directional ones), \`effects\`: [{ "id", "params"? }], \`sound\` (played at its start), \`id\`, \`label\` (its name in the page's options).
- **Scene**: \`duration\` (s), \`transition\` into it (default Cross Fade, 0.6 s; \`transitionDuration\`), \`camera\` ${CAMERAS.join(' | ')} (default push-in),
  \`background\` (overrides style), \`sounds\`: [{ "sfx", "at" }]. Script-level \`sound\`: auto (default: a whoosh on each transition and on the first headline) | none.
- **background**: a colour, a CSS gradient, { "shader": id, "look"? } — shaders: ${SHADERS.join(', ')} (looks: ${refOf(host, 'video-backgrounds')}) — or { "image": src } / { "video": src } (covers the frame; b-roll behind the scene).
- **music** (script level): \`"music": { "src": file, "volume": 80, "fadeIn": 0.3, "fadeOut": 1.2, "startAt": 0 }\` — one track under the video.

`;
}

/** "## What makes it look made, not generated": the design rules. */
export function designGuide() {
  return `## What makes it look made, not generated

- **One idea per scene**, 3–6 scenes, 2–3 s each; at most ~8 words on screen at once, held ≥ 1 s (people read ~3 words a second).
- **Hierarchy**: one headline per scene; supporting text much smaller; one accent colour; strong contrast.
- **Timing**: stagger related elements 0.06–0.12 s; one focal move at a time — supporting elements move less and later; exits faster than entrances.
- **Text animation** moves words or letters, never whole lines (the presets do this). Keep one family per video; use calm presets (glide-text,
  classic-fade-up, classic-rise-mask) for long lines, punchy ones (swing-pop, whip, letter-vortex) for 1–3 words. glide-continuous and
  glide-soft-stop never let the text rest: only when the user asks for drifting text.
- **Transitions**: vary two or three kinds across the video; the camera stays subtle.
- **Sound**: auto is a good base; add \`data-1\` / \`selection-data-click\` for UI-like pops, \`cinematic-transition-13\` for a big reveal.
- **9:16**: bigger text, stacked vertically, everything in the middle 80 %.

`;
}

/** "## Catalogues": text animations, entrances, exits, transitions, effects, sounds (caps = schema/capabilities.json). */
export function catalogueGuide(caps, host = 'chat') {
  const cat = presetCatalog();
  const star = (line, ids) => (ids.some((id) => line.startsWith(`\`${id}\``)) ? `★ ${line}` : line);
  const sounds = {};
  for (const [id, sd] of Object.entries(caps?.sounds?.library || {})) if (sd.category !== 'Voice Clips & Memes') (sounds[sd.category] ||= []).push(`${id} (${sd.duration}s)`);
  const fx = (list) => (list || []).filter((e) => !['grain', 'lensPrism', 'linesDraw', 'sdfLensBlur'].includes(e.id)).map((e) => (PREFERRED.overlay.includes(e.id) || PREFERRED.layer.includes(e.id) ? `★ \`${e.id}\`` : `\`${e.id}\``)).join(', ');
  return `## Catalogues

**Text animations** (\`textAnimation\`; ★ = preferred): ${cat.text.map((l) => star(l, PREFERRED.text)).join(' · ')}

**Entrances** (\`enter\`): ${cat.enter.join(' · ')}

**Exits** (\`exit\`): ${cat.exit.join(' · ')}

**Transitions** (★ = preferred): ${CROSS_TRANSITIONS.map((t) => (PREFERRED.transitions.includes(t) ? `★ ${t}` : t)).join(' · ')}

**Overlay effects** (\`effects\`): ${fx(caps?.effects?.overlay)}

**Layer effects** (\`effects\`): ${fx(caps?.effects?.layer)}

Effect params: ${refOf(host, 'video-effects')}.

**Sounds** (\`sound\`, \`sounds[].sfx\`):
${Object.entries(sounds).map(([k, v]) => `- ${k}: ${v.join(', ')}`).join('\n')}

`;
}

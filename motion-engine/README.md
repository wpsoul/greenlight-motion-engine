# GreenLight Motion Engine

AI agents make motion-design videos with the engine of the
[GreenLight Dash](https://greenlightdash.pro/) Video Editor. The output goes beyond HTML animation:
3D models and lights, a 3D camera with depth of field, layer effects, real transitions, per-character
text animation, particles, masks, blend modes and motion blur, rendered on WebGPU in the user's own
browser.

The agent writes the video as data: a `project.json` and its files. The engine turns that into:

- **a page the user double-clicks.** It has a real-time preview, the video's layers on a timeline,
  the options the agent exposed (headline, colours, product photo…), and **Render MP4** at 30 or
  60 fps with motion blur. Nothing has to be installed for this.
- **one self-contained HTML file** to send around or put in a Claude artifact.
- **an MP4** the agent renders itself.

## Quick start

```bash
npx greenlight-motion@0.1.0 doctor          # Node 18+, Chrome or Edge, WebGPU, H.264: what's missing and how to fix it
npx greenlight-motion@0.1.0 init my-video   # a working starter: index.html, project.json, assets/
# edit my-video/project.json, put pictures / video / sound in my-video/assets/
npx greenlight-motion@0.1.0 check my-video  # what to fix: missing files, template mistakes, blank frames, broken plugins
npx greenlight-motion@0.1.0 stills my-video # frames + a labelled contact sheet, to look at
npx greenlight-motion@0.1.0 render my-video --fps 60 --motion-blur
npx greenlight-motion@0.1.0 pack my-video   # everything in ONE html file
npx greenlight-motion@0.1.0 pack my-video --glvideo   # ONE .glvideo: double-clicked, it opens in GreenLight Dash
```

Also: `trace` (every animated layer's values frame by frame, plus the layer's moments), `set key=value`
(template values), and `schema effects | transitions | easings | sounds | …` (the machine-readable
catalog).

## For AI agents

Read **[skill/SKILL.md](skill/SKILL.md)**. It covers the workflow, the project format, templates,
sound cues, plugins and how to make motion look made rather than generated. The format references
are in `skill/references/`. To install the skill for Claude Code:

```bash
mkdir -p ~/.claude/skills && cp -R node_modules/greenlight-motion/skill ~/.claude/skills/greenlight-motion
```

## In a web page or a Claude artifact

The engine is one classic script, so it runs from a double-clicked file, a CDN or an artifact:

```html
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/greenlight-motion@0.1.0/dist/greenlight-motion.js"></script>
<script>
  GreenLightMotion.mountPage(document.getElementById('app'), {
    project: { /* project.json */ },
    assets: { 'asset:photo.jpg': 'data:image/jpeg;base64,…' },   // ref → data: / blob: / https: URL or Blob
    theme: 'auto',                                                 // 'dark' (default) | 'light' | 'auto'
  });
</script>
```

Without the page UI (in the browser, through a bundler or the ESM build; Node runs only the CLI):

```js
import { create } from 'greenlight-motion';           // or the GreenLightMotion global
const engine = create(document.getElementById('stage'), { assets });
await engine.load(project);                           // → { missing: [refs nobody provided] }
const png = await engine.renderFrame(1.5);            // data URL
const { blob } = await engine.export({ format: 'mp4', fps: 60 });
```

In a Claude artifact a page can't start a download by itself, so the page saves the MP4 through the
artifact's `downloads` capability.

## Requirements

- **Viewing and rendering:** desktop Chrome or Edge with WebGPU (Chrome 113+).
- **The CLI:** Node 18+ and Chrome or Edge on the same machine. It drives the browser through
  `playwright-core` and downloads nothing.

## GreenLight Dash

A project made here opens in the desktop editor for full editing: the page's **Open in GreenLight
Dash** imports it as a new project. The editor's **Export for agents** works the other way and gives
an agent a ready folder. MotionFast templates and effect packages with their own image or video files
play in GreenLight Dash only. The page shows such layers but leaves them out.

## License

Open source under the [Apache License 2.0](LICENSE): free for any use — making videos, client work, building it
into your own app, website, service or bot, at any company size. Keep the [LICENSE](LICENSE) and [NOTICE](NOTICE)
with copies you share. Every effect and transition built into the engine is included, also the ones GreenLight
Dash lists as PRO. Library sounds and 3D files on the GreenLight CDN have their own terms
([legal/THIRD_PARTY_ASSETS.md](legal/THIRD_PARTY_ASSETS.md)); PRO templates and workflows from the MCP server are
separate ([legal/PRO_CONTENT_TERMS.md](legal/PRO_CONTENT_TERMS.md)). The videos you make are yours. More in
[legal/README.md](legal/README.md). Source and issues: [github.com/wpsoul/greenlight-motion-engine](https://github.com/wpsoul/greenlight-motion-engine);
contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Questions:
support@greenlightdash.pro.

© 2026 WPSOUL. GreenLight, GreenLight Dash, GLEA and GreenLight Motion are trademarks of WPSOUL
([policy](legal/TRADEMARKS.md)).

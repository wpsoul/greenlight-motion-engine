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
npx greenlight-motion@0.2.1 doctor          # Node 18+, Chrome or Edge, WebGPU, H.264: what's missing and how to fix it
npx greenlight-motion@0.2.1 init my-video   # a working starter: index.html, project.json, assets/
# edit my-video/project.json, put pictures / video / sound in my-video/assets/
# or: write my-video/script.json (a scene script, skill/references/scene-script.md), then
npx greenlight-motion@0.2.1 script my-video # script.json → project.json with the Video Editor's own presets
npx greenlight-motion@0.2.1 check my-video  # what to fix: missing files, template mistakes, blank frames, broken plugins
npx greenlight-motion@0.2.1 stills my-video # frames + a labelled contact sheet, to look at
npx greenlight-motion@0.2.1 render my-video --fps 60 --motion-blur
npx greenlight-motion@0.2.1 pack my-video   # everything in ONE html file
npx greenlight-motion@0.2.1 pack my-video --glvideo   # ONE .glvideo: double-clicked, it opens in GreenLight Dash
```

Also: `trace` (every animated layer's values frame by frame, plus the layer's moments), `set key=value`
(template values), and `schema effects | transitions | easings | sounds | …` (the machine-readable
catalog).

## For AI agents

Read **[skill/SKILL.md](skill/SKILL.md)**. It covers the workflow, the project format, templates,
sound cues, plugins and how to make motion look made rather than generated. The format references
are in `skill/references/`.

Setup for each agent is in the
[repository README](https://github.com/wpsoul/greenlight-motion-engine#ways-to-use-it):

- **Claude or ChatGPT:** add the connector `https://mcp.greenlightdash.pro/motion`. The video plays in the chat,
  and the model reviews the frames your browser renders.
- **Claude Code:**

  ```bash
  claude plugin marketplace add wpsoul/greenlight-motion-engine
  claude plugin install greenlight-motion@greenlight-motion-engine
  ```

- **Codex:**

  ```bash
  codex plugin marketplace add wpsoul/greenlight-motion-engine
  codex plugin add greenlight-motion@greenlight-motion-engine
  ```

- **Only the skill:**

  ```bash
  mkdir -p ~/.claude/skills && cp -R node_modules/greenlight-motion/skill ~/.claude/skills/greenlight-motion
  ```

  For Codex, copy it to `~/.agents/skills/greenlight-motion` instead.

## In a web page or a Claude artifact

The engine is one classic script, so it runs from a double-clicked file, a CDN or an artifact:

```html
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/greenlight-motion@0.2.1/dist/greenlight-motion.js"></script>
<script>
  GreenLightMotion.mountStudio(document.getElementById('app'), {
    project: { /* project.json */ },
    assets: { 'asset:photo.jpg': 'data:image/jpeg;base64,…' },   // ref → data: / blob: / https: URL or Blob
  });
</script>
```

`mountStudio` is the page every GreenLight surface shows (a project folder's page, a chat's GreenLight Motion page, a
shared link, a review card on a board): the preview with Edit · Notes · Highlight, the inspector, the layers and Render.
Its review (notes with drawings, highlights, changes) is text to copy for your agent; a host can send it elsewhere
(`config.save`). In a narrow frame — a chat's column, a card — pass `chat: { height, full, onExpand }`: up to 900 px
wide it becomes the mobile editor in a box `height` px tall (the whole frame with `full: true`), the timeline across the
width with its panels as sheets over it; wider, the full studio. `onExpand(full)` puts a Full screen button in the app
bar for a host that can go full screen; the returned studio's `chat.set({ height, full })` follows the host.
`GreenLightMotion.mountPage(el, { project, assets, theme })` is the plain page under it, without the review interface.

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
Dash** imports it as a new project. The editor's **Export for agents** works the other way: one
`.glvideo` file to open in a Claude chat, or a ready folder with this page for an agent. MotionFast templates and effect packages with their own image or video files
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

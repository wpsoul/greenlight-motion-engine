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
npx greenlight-motion@0.5.9 doctor          # Node 18+, Chrome or Edge, WebGPU, H.264: what's missing and how to fix it
npx greenlight-motion@0.5.9 init my-video   # a working starter: index.html, project.json, assets/
# edit my-video/project.json, put pictures / video / sound in my-video/assets/
# or: write my-video/script.json (a scene script, skill/references/scene-script.md), then
npx greenlight-motion@0.5.9 script my-video # script.json → project.json with the Video Editor's own presets
npx greenlight-motion@0.5.9 check my-video  # what to fix: missing files, template mistakes, blank frames, broken plugins
npx greenlight-motion@0.5.9 stills my-video # frames + a labelled contact sheet, to look at
npx greenlight-motion@0.5.9 render my-video --fps 60 --motion-blur
npx greenlight-motion@0.5.9 pack my-video   # everything in ONE html file
npx greenlight-motion@0.5.9 pack my-video --glvideo   # ONE .glvideo: double-clicked, it opens in GreenLight Dash
```

For the user's review, on this computer only (127.0.0.1):

```bash
npx greenlight-motion@0.5.9 review my-video          # the page with Edit, Notes and Highlight for one film; Save for
                                                     # agent writes my-video/review/ (NOTES.md, notes.json, pictures)
npx greenlight-motion@0.5.9 review v1 v2 v3 --titles "Bold,Calm,Neon"   # ONE page for several versions: Notes,
                                                     # Highlight and a Pick across them; Save writes v1/review/ (NOTES.md)
npx greenlight-motion@0.5.9 pick stills/             # choose among generated pictures (stills/<frame>/*.png):
                                                     # a take and extras per frame; Save writes stills/PICKS.md
```

Also: `trace` (every animated layer's values frame by frame, plus the layer's moments), `set key=value`
(template values), and `schema effects | transitions | easings | sounds | …` (the machine-readable
catalog). `npx greenlight-motion --help` lists every command and flag.

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

**The free film workflow.** The plugin also connects GreenLight's workflows server, `greenlight`
(`https://mcp.greenlightdash.pro/mcp`). A video you ask for in your own words then runs as the free **Motion Design ▸
Custom** workflow: its steps come from the server and drive this CLI, and the agent stops for your OK where the
workflow asks for it. No account and no sign-in. Only the PRO templates on the same server (Feature Overview, Logo
animation …) ask you to sign in, once, with a GreenLight Dash PRO account. With only the skill, add the server by hand:

```bash
claude mcp add --transport http greenlight https://mcp.greenlightdash.pro/mcp   # Claude Code, then a new session
codex mcp add greenlight --url https://mcp.greenlightdash.pro/mcp               # Codex
```

## In a web page or a Claude artifact

The engine is one classic script, so it runs from a double-clicked file, a CDN or an artifact:

```html
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/greenlight-motion@0.5.9/dist/greenlight-motion.js"></script>
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
bar for a host that can go full screen; the returned studio's `chat.set({ height, full })` follows the host. `camera: true`
gives a Camera layer GreenLight Dash's camera controls (Free · Path · Rig · Zoom with the camera map, Capture keys and Add
point, the lens and its focus, moving the camera in the preview, zooms on the camera layer) and draws the Camera and 3D
Scene rows in the app's colours; the page `greenlight-motion build` writes, the app's Export for agents and the CLI's
review page pass it. The timeline lists its rows in GreenLight Dash's order on every page: the top of the stack first,
the Camera and then the 3D Scene's row on top. The mobile
editor has Undo / Redo in its app bar and Go to start / end in its play row. On a touch device the page keeps memory low
(a preview at most 960 px long, pictures at the size they are drawn, only the scene on screen and the next held), renders
the seconds a phone plays too slowly into a cache of its own (a line over the ruler, a status beside the time; the files
stay in the browser), and asks before the first Play of a film too heavy for a phone. The page's `cache` API and
`memoryStats()` read all of it.
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

**A 3D Scene** (a layer with `rig.scene`, a scene script's `world`) is drawn by the **3D plugin**, a package of its own:
[`greenlight-motion-3d`](https://www.npmjs.com/package/greenlight-motion-3d) (GreenLight Dash's 3D engine: live Draft and
path-traced Final; not open source, see its licence). You never install it by hand:

- **In a browser** the engine fetches it from jsDelivr the first time a project has a Scene: the newest release of the range
  this engine takes (`peerDependencies`), read from its `manifest.json` and then pinned to that exact release. A 2D video
  never loads a byte of it. A page that serves the plugin's `dist/world3d/` itself names the folder before mounting:

```js
GreenLightMotion.setWorldBase('https://cdn.jsdelivr.net/npm/greenlight-motion-3d@0.1.5/dist/world3d/');   // or your own copy
await GreenLightMotion.world3d.load();          // a "Download 3D plugin" button: get it before any Scene
GreenLightMotion.world3d.status();              // { state: 'idle' | 'loading' | 'ready' | 'failed', version, bytes, error }
const { png, hints, objects, lights } = await engine.critique(2);   // the frame at 2 s and what its shot shows, with hints
```

- **The CLI** downloads it once into this computer's cache (`~/Library/Caches/greenlight-motion/` on a Mac,
  `%LOCALAPPDATA%\greenlight-motion\Cache` on Windows, `~/.cache/greenlight-motion` on Linux; `GREENLIGHT_MOTION_3D_CACHE`
  moves it) the first time a folder has a Scene, checks it against the registry's sha512 and copies its `dist/world3d/` beside
  the page. `npx greenlight-motion add-3d` gets it ahead; `doctor` says which release is there. Offline:
  `GREENLIGHT_MOTION_3D=<an unpacked copy or its .tgz>`; an installed `greenlight-motion-3d` next to the project is used as it is.

Its files load as modules, so a page that carries them in its own folder runs from a server (the CLI's `review` serves one),
not from a double-clicked file.

**Final in a page you host:** `GreenLightMotion.setFinalCap({ seconds: 10, spp: 64 })` makes a Final (path-traced) render costlier
than 10 s at 64 samples per pixel (1080p, 30 fps) wait for a second press of Render (or `page.renderVideo({ confirmLongFinal:
true })`); the GreenLight Motion connector sets that. No cap is the default; `GreenLightMotion.finalCost(project)` says what a render costs.

**Driving a page from code:** `GreenLightMotion.page.ready` says the page is up; its player follows a moment later (the GPU and
the project's first load): `page.player` is true then, and `await page.whenPlayer(ms)` waits for it or throws why it cannot
start. `renderVideo`, `renderAudio`, `renderFrame` and `critique` wait for the player themselves.

## Requirements

- **Viewing and rendering:** desktop Chrome or Edge with WebGPU (Chrome 113+).
- **The CLI:** Node 18+ and Chrome or Edge on the same machine. It drives the browser through
  `playwright-core` and downloads nothing.

## GreenLight Dash

A project made here opens in the desktop editor for full editing: the page's **Open in GreenLight
Dash** imports it as a new project. The editor's **Export for agents** works the other way: one
`.glvideo` file to open in a Claude chat, or a ready folder with this page for an agent. MotionFast templates and effect packages with their own image or video files
play in GreenLight Dash only. The page shows such layers but leaves them out.

## What's new in 0.5.9

- **HTML layers, drawn live:** an interface or any HTML page is a layer the engine draws itself on the video's clock
  (Chrome 157+), from a file in `assets/` or written into a scene script; no recording first.
- The Video Editor of GreenLight Dash 16.6.80: Font size, weight and italic in text animators, four more camera moves, the
  app's layer templates (carousels, card stacks, galleries), Depth Matte, motion blur by on-screen travel.
- A scene script adds no sound unless it names one.
- It takes the 3D plugin greenlight-motion-3d 0.1.5 (characters that speak, screens that look like their page).

## What's new in 0.5.8

- A video you ask for in your own words runs as the free **Motion Design ▸ Custom** workflow: the plugin connects
  GreenLight's workflows server, with no account and no sign-in (above). The engine is the same as 0.5.7's.

Every change: [CHANGELOG.md](CHANGELOG.md).

## Works with REA Viral

[REA Viral](https://github.com/wpsoul/rea-viral) is an open agent skill (Apache 2.0) that works out what goes viral:
why an account grows, why a post took off, which video formats work in a niche. When it finds a format worth making, it
can build it as an editable video with GreenLight Motion: the skill turns the format's beats, timing and hook into a
scene script for this engine, with your own footage and words. The skill calls the engine (through the connector's tools
or this CLI); the engine itself carries no REA Viral code.

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

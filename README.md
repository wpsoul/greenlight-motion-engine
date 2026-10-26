# GreenLight Motion Engine

AI agents make motion-design videos with the engine of the [GreenLight Dash](https://greenlightdash.pro/) Video
Editor: 3D models and a 3D camera, particles, shader effects and transitions, per-letter text animation, masks,
blend modes and motion blur. Everything renders on WebGPU in the user's own browser, and nothing renders on a server.

The agent writes the video as data (`project.json`). You get a page with a live preview, the options the agent
exposed (headline, colours, product photo …) and **Render MP4**, or an MP4 the agent renders itself. Open source,
[Apache-2.0](LICENSE).

## Ways to use it

| You work in | Add | You get |
|---|---|---|
| **Claude** (web, desktop app) or **ChatGPT** | the connector `https://mcp.greenlightdash.pro/motion` | the video in the chat: preview, options, notes, Render MP4 |
| **Claude Code** | the [plugin](#claude-code) (or only the skill) | a project folder the agent checks, looks at and renders to MP4 |
| **Codex** (CLI, IDE, app) | the [plugin](#codex) (or only the skill) | the same |
| **Any other agent** (Cursor, Gemini CLI …) | [`npx greenlight-motion`](#the-cli) + `SKILL.md` | the same |
| **Your own web page** or a **Claude artifact** | [one `<script>`](#in-a-web-page-or-a-claude-artifact) | the player page, or the engine without UI |
| **GreenLight Dash** | a `.glvideo` file | full editing in the desktop editor |

Viewing and rendering need desktop **Chrome or Edge with WebGPU** (Chrome 113+). The CLI also needs Node 18+.

## In Claude or ChatGPT

Add the connector once. It is free and needs no sign-in.

- **Claude** (claude.ai and the Claude desktop app):
  1. Go to **Customize → Connectors → + → Add custom connector**.
  2. Enter the name `GreenLight Motion` and the URL `https://mcp.greenlightdash.pro/motion`.
  3. Choose **No sign in**, then **Add**.
  - On Team and Enterprise plans, an owner adds it first under Organization settings → Connectors.
  - The Free plan allows one custom connector.
- **ChatGPT:**
  1. Turn on **Developer mode** under Settings → Apps → Advanced settings. The menu has moved between versions;
     on some it is Apps & Connectors.
  2. Create an app with the same URL and **No authentication**.
  - Whether you can add custom apps depends on your plan and workspace settings.

Then ask for a video, for example *"Make a 10-second opening-day video for my coffee shop Bean There, 9:16"*.

1. **Building.** The model reads the guide and writes a short scene script: scenes, texts, shapes, preset names,
   transitions, sounds. `build_video` turns the script into a full project with the Video Editor's own animation
   presets.
2. **In the chat.** The video opens with a live preview, its options (texts, colours) and Render MP4.
3. **Review.** Your browser renders six frames of the video. The model gets them with `look_at_video`, fixes what
   is weak and builds the next version. **Polish it** asks for another round.
4. **Your notes.** Press **Notes**, mark a spot on the frame and write what should change, then **Send to Claude**
   (or **Send N notes**). The model gets your words and a picture of each marked moment.
5. **Pictures, video, music.** Nothing you own is uploaded to or kept on the GreenLight Motion server.
   - **Your own files:** drop them on the page (or press **Add files**). They stay in your browser, and the next
     version finds them there. The model only learns their names and sizes.
   - **Links:** the model uses a link, such as an image or video from a generator it's connected to, or a link you
     gave it. The video plays the link through the server without keeping a copy, so the link has to stay reachable.
   - **Drawn art:** SVG the model draws goes into the project itself.

   The model then places and animates them: picture and video layers, a video behind a scene, a music track, its
   own keyframes.
6. **Saving.**
   - **Render MP4** saves the file through the chat app.
   - **Open in GreenLight Dash** gives a `.glvideo` file.
   - `share_video` makes a link that plays the video in any Chrome or Edge for 30 days.

| Tool | What it does |
|---|---|
| `get_motion_guide` | how to write a scene script, what makes a video look made, the catalogues of presets, transitions, effects and sounds |
| `build_video` | a scene script → a full project, opened in the chat; `replaces` makes the next version |
| `look_at_video` | the frames your browser rendered, your option changes, your notes and the names of the files you added, for the model to review |
| `show_video` / `check_video` | open or check a full project the model wrote by hand (3D mockups, particles, paths) |
| `share_video` | a link to the video and its `.glvideo` |
| `get_motion_reference` | the project format, topic by topic |

Limits:

- **Updates to the video page reach you by themselves.** Only when the tools themselves change (rarely) do you
  remove the connector and add it again: chat apps keep the tool list from the moment you added it.
- **The model only sees what your browser renders.** It has no screen of its own: it sees the frames the page in
  the chat rendered. With the page closed, there is nothing to look at.
- **Your files.** Your files never leave your browser. A share link, or another browser, asks for them again.
- **Frames.** The six frames the model reviews are kept for one hour, then deleted.
- **ChatGPT.**
  - Its chat can't show files from your computer, and the page can't save files there.
  - In ChatGPT the page opens the video in a browser tab instead, where it plays your files and Render MP4 saves it.
- **App-only layers.** HTML layers, MotionFast templates and effect packages with their own files play in
  GreenLight Dash only.

## Claude Code

Install the plugin. It adds the `greenlight-motion` skill. In Claude Code:

```text
/plugin marketplace add wpsoul/greenlight-motion-engine
/plugin install greenlight-motion@greenlight-motion-engine
```

or from a shell:

```sh
claude plugin marketplace add wpsoul/greenlight-motion-engine
claude plugin install greenlight-motion@greenlight-motion-engine
```

Then ask, for example: *"Make a 15-second product teaser in ./teaser with GreenLight Motion."*

1. **The agent's work.** It runs the CLI: `init`, writes `project.json` (your pictures, video and sound go in
   `teaser/assets/`), then `check`. It looks at the frames from `stills`, fixes what is weak, and runs `render`.
2. **Preview.** Double-click `teaser/index.html` for the preview with its options and Render MP4.
3. **Notes.** `npx greenlight-motion review teaser --open` opens the page with Notes. What you mark lands in
   `teaser/review/`; tell the agent you left notes.

To add only the skill, without the plugin:

```sh
git clone https://github.com/wpsoul/greenlight-motion-engine
mkdir -p ~/.claude/skills
cp -R greenlight-motion-engine/motion-engine/skill ~/.claude/skills/greenlight-motion
```

For one project only, copy it to `.claude/skills/greenlight-motion` in that project instead.

## Codex

Install the plugin:

```sh
codex plugin marketplace add wpsoul/greenlight-motion-engine
codex plugin add greenlight-motion@greenlight-motion-engine
```

You can also install it from the Plugins directory in the ChatGPT desktop app. The agent then works as in
[Claude Code](#claude-code): it uses the CLI on a project folder.

To add only the skill, without the plugin:

```sh
mkdir -p ~/.agents/skills
cp -R greenlight-motion-engine/motion-engine/skill ~/.agents/skills/greenlight-motion
```

For one repository only, copy it to `.agents/skills/greenlight-motion` in that repository instead.

## The MCP server in a coding agent

This is optional. A terminal has no in-chat page, so `look_at_video` has no frames there; `npx greenlight-motion
stills` is how a coding agent sees its video. The server is still useful:

- `build_video` turns a short scene script into a full project. The agent saves
  `https://mcp.greenlightdash.pro/motion/b/<build id>.json` as `project.json` and goes on with the CLI. The CLI's
  `script` command does the same on your computer, with the same converter.
- `share_video` makes a link you open in Chrome.

Claude Code:

```sh
claude mcp add --transport http greenlight-motion https://mcp.greenlightdash.pro/motion --scope user
```

Codex:

```sh
codex mcp add greenlight-motion --url https://mcp.greenlightdash.pro/motion
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.greenlight-motion]
url = "https://mcp.greenlightdash.pro/motion"
```

Any other client takes the same Streamable HTTP URL, with no auth.

## The CLI

```sh
npx greenlight-motion@0.1.4 doctor          # Node 18+, Chrome or Edge, WebGPU, H.264: what's missing and how to fix it
npx greenlight-motion@0.1.4 init my-video   # a working starter: index.html, project.json, assets/
npx greenlight-motion@0.1.4 script my-video # my-video/script.json (a scene script) → project.json, the Video Editor's presets
npx greenlight-motion@0.1.4 check my-video  # missing files, template mistakes, blank frames, broken plugins
npx greenlight-motion@0.1.4 stills my-video # frames and a labelled contact sheet, to look at
npx greenlight-motion@0.1.4 render my-video --fps 60 --motion-blur
npx greenlight-motion@0.1.4 review my-video --open   # the page with Notes; they land in my-video/review/
npx greenlight-motion@0.1.4 pack my-video   # everything in ONE html file
npx greenlight-motion@0.1.4 pack my-video --glvideo  # ONE .glvideo: double-clicked, it opens in GreenLight Dash
```

Other commands:

- `apply` makes a batch of validated edits.
- `set key=value` sets template values.
- `trace` gives every animated layer's values, frame by frame.
- `schema effects | transitions | easings | sounds | …` prints the machine-readable catalogue.

Agents read [`motion-engine/skill/SKILL.md`](motion-engine/skill/SKILL.md): the workflow, the project format,
templates, sound cues, plugins, and how to make motion look made rather than generated. The format references are in
[`motion-engine/skill/references/`](motion-engine/skill/references/).

## In a web page or a Claude artifact

The engine is one classic script, so it runs from a double-clicked file, a CDN or an artifact:

```html
<div id="app"></div>
<script src="https://cdn.jsdelivr.net/npm/greenlight-motion@0.1.4/dist/greenlight-motion.js"></script>
<script>
  GreenLightMotion.mountPage(document.getElementById('app'), {
    project: { /* project.json */ },
    assets: { 'asset:photo.jpg': 'data:image/jpeg;base64,…' },   // ref → data: / blob: / https: URL or Blob
  });
</script>
```

Without the page UI: `GreenLightMotion.create(el, { assets })` → `load(project)`, `renderFrame(t)`,
`export({ format: 'mp4' })`. See [`motion-engine/README.md`](motion-engine/README.md).

## Build from source

```sh
cd frontend && npm install && npm run build      # → motion-engine/dist/greenlight-motion.js + .mjs
cd ../motion-engine && npm install && node cli/index.mjs doctor
claude plugin validate ./plugin                  # the plugin, if you change it
```

What is where:

- `frontend/src/` holds every file the engine bundle is built from: the editor's compositor, effects,
  transitions, 3D, particles, text and the page.
- `motion-engine/` is the npm package: the CLI, the agent skill, the schema, examples and docs.
- `plugin/` is the Claude Code and Codex plugin: the same skill, with `.claude-plugin/` and `.codex-plugin/`
  manifests. Its marketplaces are `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`.

The repository is published from GreenLight Dash on each release. Pull requests map back to it file for file; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## GreenLight Dash

A video made here opens in the desktop editor for full editing. **Open in GreenLight Dash** on the page, or a
`.glvideo` file, imports it as a new project. The editor's **Export for agents** works the other way: it gives an
agent a ready project folder.

## Licence

[Apache License 2.0](LICENSE). See also [NOTICE](NOTICE) and [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

- Library sounds and 3D files on the GreenLight CDN have their own terms
  ([motion-engine/legal/](motion-engine/legal/README.md)).
- PRO templates and workflows from the MCP server are separate.
- The videos you make are yours.

GreenLight, GreenLight Dash, GLEA and GreenLight Motion are trademarks of WPSOUL
([policy](motion-engine/legal/TRADEMARKS.md)). Questions: support@greenlightdash.pro.

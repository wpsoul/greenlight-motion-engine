# Changelog

## 0.5.9 (2026-11-24)

The engine inside is the Video Editor of GreenLight Dash 16.6.80 (0.5.8's was 16.5.94's). It takes the 3D plugin
greenlight-motion-3d 0.1.5 (`~0.1.5`): characters that speak, screens that look like their page, Final at 32 samples.

**HTML layers, drawn live**
- **An HTML page is a layer the engine draws itself.** A clip `{ "mediaType": "html", "url": "asset:<page>.html" }`, or a
  scene script element of type `html`, runs the page inside the engine and the browser draws it into the layer
  (HTML-in-canvas). The page is stepped on the video's clock frame by frame: CSS animations, `requestAnimationFrame`,
  timers and `performance.now()` follow the playhead, so the preview, `stills` and `render` show the same picture. No
  recording of the page first, and no Python, Playwright or ffmpeg for it.
- **It needs Chrome 157 or newer** (HTML-in-canvas shipped there). `doctor` has a line for it; `check` reports a page
  that could not be drawn, or a browser that cannot draw pages.
- **A clip that carries a recording keeps playing it** (`prerender`: films made before, projects from GreenLight Dash):
  nothing changes for them. Only a clip with no recording is drawn live.
- **A page's own files** (pictures, scripts, styles beside it in `assets/`, named by a relative address, or any file of the
  folder as `asset:<name>`) are found. `pack --glvideo` and the page's Save for GreenLight Dash write them into the page, so
  it opens whole in GreenLight Dash.
- **A page written into the script**: `{ "type": "html", "html": "<!doctype html>…" }` (up to 512 KB) is kept in the
  project as a data: URL, the way SVG art is; a `.glvideo` carries it as a file (`assets/pages/<clip id>.html`).
- **Pages without scripts**: `GreenLightMotion.setHtmlPageScripts(false)` before mounting runs no script of any page (a
  page in a frame has its host page's origin: in a chat its script could speak to the chat as the video page). Its CSS
  animations, SVG animation and videos are then set to the video's time from outside. The GreenLight Motion connector's
  pages (the chat, a shared link) use it. `GreenLightMotion.htmlLayers()` says whether pages are drawn here, reachable and
  with scripts, and which failed.

**Scene scripts**
- **No sound unless the script names one.** `sound` defaults to `"none"` and the guide lists no library sounds: a film's
  sounds and music are files, chosen as the design rules say (the user's, their library, generated or from an open source).
  The cues of films made earlier keep playing.
- An element at a negative `z` in a scene with no camera of its own no longer disappears behind the scene's backdrop: the
  backdrop stays a 2D layer at the bottom, and a scene with depth gets a still camera.

**Text animators**
- **Font size, Font weight and Italic** are effects of their own (group Font): a word or a letter gets its own size, weight
  or slant, and the line makes room for it.
- **Wiggle ▸ Pick** selects an exact share of the units by its seed, so a colour, a weight or italic lands on chosen words.
- **Highlight box**: a border on the box's own radius, and a see-through colour.
- The classic presets that carry a plate (Pill Grow, Lower Third, Drop Bar …) grow it as a Highlight box under the words;
  the randomizer presets (Random Pop, Chaos Letters, Random Rise, Ransom Note, Editorial Typer) style words with the new
  effects.

**Camera**
- **Four more moves:** Push In, Orbit Hold, Rise & Reveal and Whip. Quiet Push and Corkscrew are on Smooth.
- Zooms on a camera ease in and out by their own times, and two zooms with targets no longer jump between targets.

**Layers made from templates**
- The layer templates of GreenLight Dash play here: Carousel, Image Trail, Tumble, Toss, 3D Grid, Media Orbit, Card Fan,
  Card Rail, Flicker, Stacking and Unstacking Cards, Scatter Cards, Tiled Gallery, and the text ones (Sliced Rolling Text,
  Kinetic Perspective Type, Cascading Ticker …), built from ordinary layers when the project opens.

**Pictures**
- **Depth Matte**: a layer cut by the depth of a video.
- Motion blur takes as many sub-frames as each frame's on-screen travel needs.
- A still shows the right frame of a video inside a sequence; a picture cut to a box by a plain Layer Mask is drawn in one
  pass.

**The film's page**
- Draft 3D | Final 3D is in the preview bar; the page opens in Draft, and Render, stills and the Final limit follow the
  film's own 3D mode.
- The Camera layer has the app's camera controls on the page (`build`, `review`); a Path camera has Add point; the
  Camera and 3D Scene rows come first, and the timeline lists rows in the app's order.
- Dragging a number in the inspector no longer stops after one step.
- `GL_PAGE_LOG=1` prints the page's own render lines (`render`, `stills`).

## 0.5.8 (2026-11-21)

**The free film workflow**
- **A video from the user's own words runs as the free Motion Design ▸ Custom workflow** (Build New Video by Prompt) on
  GreenLight's workflows server, `greenlight` (`https://mcp.greenlightdash.pro/mcp`). The skill's first section says how:
  its steps come from the server and drive this CLI, and the agent stops for the user's OK where the workflow asks. No
  account, no sign-in. Without the server, the agent makes the video with the skill alone, as before.
- **The plugin connects that server** (`plugin/.mcp.json`, its address only: no token, no header) for Claude Code and
  Codex. The ready templates on the same server are GreenLight Dash PRO workflows; only they ask for a sign-in, once.

The engine inside is the same as 0.5.7's. Only the effects catalogue changed: no effect is marked PRO any more
(`schema effects`, `pro: false`), as in GreenLight Dash 16.5.95, where every effect is free.

## 0.5.7 (2026-11-21)

0.5.6 was never published: 0.5.7 carries everything in it (listed at the end). The engine inside is the Video Editor of
GreenLight Dash 16.5.94.

**The user's review**
- **Several versions in ONE review page.** `review v1 v2 v3 --titles "Bold,Calm,Neon"` serves one page for all of them, the
  same review card GreenLight Dash shows on a board: Highlight the parts they like from any version (in the order of a new
  cut), Notes with drawings on any version's frames, and a Pick of the version to go on with (or a mix). **Save for agent**
  writes `v1/review/` (`NOTES.md`, `notes.json`, the note pictures).
- **One film goes through the same page.** `review <folder>` opens in Highlight, with Edit and Notes one click away, and its
  Save for agent writes `<folder>/review/` too. A folder with a render newer than its project plays the render.
- **A pick page for generated pictures.** `pick <folder>` (one subfolder of pictures per frame, or a `pick.json`) is GreenLight
  Dash's pick card: a take and extras per frame, a note each; Save writes `PICKS.md` and `PICKS.json`.
- `--help` lists every command and flag.

**3D Scenes and the Camera layer**
- **The Camera layer films a 3D Scene the way the Scene's own camera does.** It can look at a Scene object, orbit or follow
  one, ride a path aimed at one, keep it in focus and zoom onto it: the camera turns and the lens zooms, and the blur grows
  as a real lens's does. Depth of field looks the same in Draft and in Final. Zoom keeps the camera where it is.
- **Camera Rigs go the way their names say.** Crane Down rose, Rise & Reveal sank, and most rigs filmed a 3D Scene from
  under its floor; a positive Height is now above the subject. A rig shot made before 0.5.7 now films from the other side
  vertically. A rig's Roll cants the picture.
- **Titles and cards moving over a Final Scene render about ten times faster:** the Scene is traced once, with its own motion
  blur, and the 2D layers are blurred over it. A cut is never blurred, and frames with no 3D Scene are not traced.
- **The Scene's camera can act like a real device:** auto exposure that catches up a moment late, sensor noise that grows in
  the dark, wide-angle and fisheye lenses, and the Action cam, Phone and Cinema presets (drawn by the 3D plugin 0.1.4).
- **Several imported models in one Scene each show their own parts.**
- The 3D references (`video-world3d.md`, `video-world3d-notes.md`, `video-camera.md`, `world3d-schema.json`) teach filming a
  Scene with the Camera layer: four worked moves (free, path, rig, zoom).

**The 3D plugin**
- Takes **greenlight-motion-3d 0.1.4** (`~0.1.4`) and gets it by itself; a cached 0.1.3 or older is skipped. 0.1.4 is the 3D
  engine of GreenLight Dash 16.5.94: cloth tied to moving objects, cloth with a thickness, and the rest of its changelog.

**From 0.5.6 (never published on its own)**
- RunPod parts no longer come out transparent when a server's display is slow, and a pod's second part starts sooner.
- A ready-made iPhone 17 Pro Max shows its screen picture the right way up inside a 3D Scene, and Two iPhones shows its
  screens at all.
- The guide says 3D in a video is the 3D Scene, and how to stand a ready-made device in it.
- The design rules now include the motion grammar: how moves are written and how they meet across a cut, with the films
  behind it. On a computer with Python, Seam Craft measures the joins.

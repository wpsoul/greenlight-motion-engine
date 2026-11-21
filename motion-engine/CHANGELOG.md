# Changelog

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

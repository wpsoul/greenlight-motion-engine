> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# Motion films: field notes

What real films teach about layers, keyframes, text, camera, joins and sound: the way an agent naturally does it, what that
looks like or sounds like, and the fields and values that do it right. Read it before you build a film; the design floor is
[video-design.md](video-design.md), the format [video-projects.md](video-projects.md). Each note is **Wrong** (the natural way and what it gives),
**Right** (fields and values) and **Why** (the mechanism, with its measured number). 3D Scenes have their own page:
[video-world3d-notes.md](video-world3d-notes.md).

## Open notes

None at the moment: the notes this page held are rules now, on the page that owns each topic: sound cues in
sound.md (GreenLight Dash only), a hold that drags in [video-projects.md](video-projects.md#motion-critique--lockstep-retiming),
a film rendered in parts in rendering.md (GreenLight Dash only).

## Adding a note

- In the app this page is read-only: write a general lesson to your user's engine notes (`PUT /api/agent/engine-notes/motion`,
  or the file at the `path` it gives, engine notes (GreenLight Dash only)), and what
  holds for one board only to that board's memory.
- When: a project showed a wrong way, a right way, or a value worth keeping.
- Shape: a heading naming the situation, then **Wrong**, **Right** (fields, values, a JSON fragment) and **Why** (the mechanism and
  its measured number), 3–8 lines, under the group it belongs to (timing and easing, text, camera, joins, sound, rendering and checking).
- Write for an agent that writes JSON and calls endpoints, in the present tense: no UI words, versions, dates, history or project
  names, and link to [video-design.md](video-design.md) or the format's pages instead of repeating them.
- Only what the engine does now, checked on a render or in the code.
- Remove a note when the engine no longer behaves that way.
- A note that holds as a general rule moves to the page that owns its topic (design.md, sound.md, rendering.md, the format's
  page) and leaves this page.

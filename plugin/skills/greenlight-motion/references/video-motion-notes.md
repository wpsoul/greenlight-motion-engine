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

## Timing and easing

### A hold that drags
- **Wrong:** cutting frames out of a resting hold: whatever still moves there (a slow turn, a float, a slow camera push) jumps.
- **Right:** play the hold's middle faster: map every time through one piecewise time map (the middle 44 frames of a 48-frame hold
  at 2× make it 26): Scene keys, layer keyframes, items' `freeStart` and `trimEnd`, a sim's `clip.start`; leave the moves' own keys
  untouched, and compute what must keep its speed (a rest turn, a float) on the new time.
- **Why:** a 22-frame cut jumps a 24°/s turn by 17°; the warp only doubles the speed of the nearly still channels for those frames,
  and the moves before and after stay frame for frame what they were.

## Sound

The calls behind these notes are in sound.md (GreenLight Dash only): the event timeline (`GET …/video-projects/{id}/events`: each
move's fastest frame and its stop, from the project's own data), each sound's facts (`…/sound-facts`: its loudest moment,
onset, loudness, class) and the placement (`POST …/sound-place`, which does the arithmetic below and checks the mix). The
notes say why.

### A sound on a motion beat
- **Wrong:** starting a whoosh on the move's first frame: its loudest moment comes after the picture's, and the sound trails.
- **Right:** place a cue by its loudest moment: `freeStart` = the beat's time − the file's peak time. A whoosh peaking 0.31 s in
  starts 9 frames before the move's fastest frame; a pop (peak in its first 20 ms) on the frame things appear; a reversed riser
  peaking 1.67 s in starts 50 frames before the frame a gather ends. The beat is a `move` event's `t` (its fastest frame) or a
  `stop`'s; the peak is the sound's `peak` fact.
- **Why:** a whoosh is heard at its peak, not its start. Find the peak in the file (the loudest 10 ms window), not by its name.

### A landing sound on the last key
- **Wrong:** a snap on the frame of a move's last key: with a hard ease-out the thing has looked still for several frames by then,
  and the snap lands late.
- **Right:** the `stop` event's frame: the first frame from which it moves under half a pixel a frame. A card keyed over 30 frames
  with `Power` is at rest 7 frames before its last key (f38, key f45); a logo keyed a key a frame lands where its keys stop
  changing by half a pixel, not where they end.
- **Why:** an ease-out spends its last frames on sub-pixel steps (`Power` over 30 frames: its last 7 move 0.8 px in all, the
  first of them 0.43 px); the eye sees the landing where the motion stops, not where the key is.

### One clip per cue
- **Wrong:** one premixed sound bed under the whole film: no cue can follow when the picture moves.
- **Right:** each cue its own `audio` clip and item at its `freeStart`, overlapping cues on separate audio channels
  (`"kind": "audio"`, one live item per channel), each cut to what is used (`trimStart` / `trimEnd`) with short fades
  (`audioFadeIn` about 0.005 s, `audioFadeOut` 0.05–0.6 s: [sound and fades](video-projects.md#sound--audio-fades)).
- **Why:** the user moves a cue in the timeline and the mix follows; 17 cues of a 10.5 s film take 4 audio channels.

### Library sounds at full scale
- **Wrong:** dropping sound-pack effects in at `volume` 100: they peak just under full scale (the Candy pack's 176 files: sample
  peaks −5.1 to 0.0 dBFS, 101 of them at −0.1), so two that meet clip. Folding a stereo file to mono to measure it (ffmpeg
  `-ac 1`) reads a centred sound about 3 dB hot (+2.6 dBFS for a file that peaks at −0.3).
- **Right:** bring each cue to its level first, in its own file or with `volume` under 100 (`volume` only lowers: 0–100 %).
  Measure each cue's loudest 400 ms (`loudest400ms`) and keep cues of one role within about 1 dB of each other: accents (pops,
  snaps) 7–8 dB under the whooshes, ticks and soft beds 12–15 dB under. Read peaks on the file's own channels (`samplePeak`,
  `truePeak`).
- **Why:** a cue 4 dB over the others of its role jumps out of the film; `volume` cannot raise a quiet one.

### Loudness of a film with only effects
- **Wrong:** a limiter on the master only, or a mix at −1.0 dBTP: the project's clips no longer sum to the delivered sound, and AAC
  lifts the peak over −1 (−1.0 → −0.8 dBFS).
- **Right:** −16 LUFS integrated with the true peak at −1.5 dBTP in the WAV mix (−1.4 to −1.8 after AAC at 256 kb/s); when the peak
  stops the loudness short, lower the cues that stack on the loudest beat (a riser, a pluck and ticks on one frame: the risers
  −1.5 dB, the pluck −2 dB) rather than the master. The mix check's `loudestMoments` names the cues stacked there, and
  `sound-place` lowers them itself when the peak stops it (`lowered`).
- **Why:** the integrated loudness gates out the silence between cues, so a sparse mix reaches its target by gain, and the peaks come
  where cues overlap: lowering two stacked cues freed 0.7 dB of gain (−17.2 → −16.5 LUFS at the same peak).

## Rendering and checking

### A film rendered in parts
- **Wrong:** joining parts without checking their frame counts (a part one frame long moves every cut and cue after it off the
  sound), or re-encoding the joined film (a second generation of every frame).
- **Right:** `render-onserver-job` with `rangeStart` on a frame and `rangeEnd` half a frame before the next range's start; check
  each file's frame count and cut any extra frame; join by stream copy
  (concat (GreenLight Dash only), `reencode` false); mux the mixed sound onto the joined
  picture last. To change one window later, render only the ranges that hold it, at the same boundaries, and join again.
- **Why:** a range renders byte-identical to the same span of a full render
  (partial renders (GreenLight Dash only)), so the joins show no
  seam and the untouched ranges stay identical (0.00 levels).

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

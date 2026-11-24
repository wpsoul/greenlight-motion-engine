> **GreenLight Motion Engine:** this is the GreenLight Dash Video Editor's project format, which the engine reads as is.
> Ignore the `/api/...` routes and the app UI described here: in the engine you edit `project.json` (or `apply`) and run
> `npx greenlight-motion build`; what `GET /api/video-editor/capabilities` returns there is `npx greenlight-motion schema <topic>`
> here. `frontend/src/…` paths are files of the engine's public source repository. MotionFast templates (`mediaType: "motion"`)
> stay in GreenLight Dash.

# GLEA — Characters in the 3D Scene: pose, rig and speech

> Read [video-projects.md](video-projects.md) for the shared project, clip, channel, timing and versioned-write contracts, and [video-3d.md](video-3d.md) for
> putting a model into a 3D Scene. Load only the sections the task needs.

Read this page when a character moves or speaks in a 3D Scene ([video-world3d.md](video-world3d.md)): a person, an animal, a robot, anything with
joints. It covers the pose (the file's clips crossfaded, morphs, bones, hand shapes, look-at, IK, holding things, layers with masks),
speech, the routes that convert rotation keys, and a skeleton for a mesh that has none. The same `pose` and `skeleton` work in two places:

| Where | Pose | Skeleton | Its keys count |
| --- | --- | --- | --- |
| A model layer (a `model3d` clip) | `model3dConfig.pose`: the file's own clips, morphs, bones; speech with its morphs or jaw | `model3dConfig.skeleton`, for a file that has none | the layer's seconds (its clip's clock, like `animation`) |
| A Scene object (`rig.scene.objects[i]`) | the object's `pose`: only `skeleton.clips`, no morphs; speech with a jaw bone only | the object's `skeleton` (a mesh built by its `graph`, or a `model` file) | the Scene's seconds |

So a character whose file has its own animations (Idle, Walk, a Mixamo clip) or face morphs is a model layer ([which one](video-3d.md#model-layer-or-scene-object)).
Field help: `GET /api/world3d/help?path=model3dConfig.pose.<field>` (or `model3dConfig.skeleton.<field>`, `scene.objects.*.pose.<field>`);
`POST /api/world3d/validate` with `{ "data": <project> }` checks every pose and skeleton of a project.

## Contents

- [The pose pipeline (`pose`)](#the-pose-pipeline-pose): [keys](#every-number-is-keyable), [clips](#clips), [root motion](#root-motion), [morphs](#morphs), [speech](#speech), [bones](#bones), [hand shapes](#hand-shapes), [constraints](#constraints), [corrective morphs](#corrective-morphs), [layers](#layers), [what a file offers](#what-a-file-offers), [rotation tracks: convert, unwrap, world to local](#rotation-tracks-convert-unwrap-world-to-local), [worked example](#worked-example-a-character-waves-looks-and-reaches)
- [Skeletons for meshes that have none (`skeleton`)](#skeletons-for-meshes-that-have-none-skeleton): [fields](#skeleton-fields), [automatic weights](#automatic-weights), [fixes](#fixes), [a jaw that opens](#a-head-whose-jaw-opens), [clips](#skeleton-clips), [check before posing](#check-before-posing), [worked example](#worked-example-a-figure-built-rigged-and-walking)

## The pose pipeline (`pose`)

A `pose` animates a character: several clips crossfaded, morph targets, bones, constraints (look-at, two-bone
IK, attach, parent, follow path) and animation layers with masks. The file's clips are only read, never changed. Every frame runs one
fixed order, the same in the editor, Draft, Final, stills and exports:

1. **clips** — the first is the base; each next one lies over what is below by its weight (a crossfade is the next clip's `fadeIn` while
   the one before keeps playing);
2. **morphs** — morph target weights by name;
3. **bones** — the hand shapes, then local transform overrides by bone name;
4. **constraints** — solved against the layer's transform of this frame;
5. **world** — the layer's transform and floor (the floor is found on the pose before step 4, so an arm reaching down never lifts the feet).

`order` stores that list in the project (it is the only order; another is ignored with a warning). Layers (`layers`) run inside each
step after the pose's own entries, in their order. Names (clips, bones, morphs) are looked up in the file each frame, so a re-imported
file keeps the pose: a name it no longer has is skipped with a warning (`scene.warnings` of a still in a Scene). A bone's name as the file
writes it works (`"Palm2.L"`), and so does the loader's (`"Palm2L"`: it drops `.`, `:`, `/`, `[`, `]`). Nothing in a pose costs anything on
a layer without one: that layer plays `animation` exactly as before.

### Every number is keyable

`keys: { "<field>": [{ "t", "v", "ease" }] }` on the control itself, in the **layer's** seconds on a model layer (its clip's
clock, like `animation`) and the Scene's on a Scene object, holding before the first key and after the last, `ease` `inOut` by default (`linear`, `in`, `out`, `back`,
`bounce`, any keyframe easing of the editor by id or name such as `aeSmooth` / `AE Smooth`, `hold`, or a cubic-bezier `[x1, y1, x2, y2]`:
the same eases as a Scene's keys, [video-world3d.md](video-world3d.md#the-scene-format)).

### Clips

`clips: [...]`, the first one the base:

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `clip` | animation name | required | The GLB's animation (names exactly as in the file). |
| `start` / `end` | layer seconds | `0` / none | It lays nothing before `start` or after `end`. |
| `fadeIn` / `fadeOut` | seconds | `0` | Rises to its weight after `start` / falls to 0 before `end`, on an S-curve (the blend starts and ends gently: no pop). |
| `weight` | `0–1` | `1` | How much of it lies over what is below. Keyable. |
| `speed` / `offset` | `-8–8` / s | `1` / `0` | Playback rate; seconds into the clip at `start`. Keyable. |
| `time` | clip seconds | none | Set the clip's own time outright (key it to scrub by hand); `speed` and `offset` then do nothing. Keyable. |
| `loop` | `loop` \| `once` \| `pingpong` | `loop` | `once` holds the last frame. |
| `blend` | `over` \| `add` | `over` | `add` lays the clip's change from the file's rest pose on top (breathing over a walk). |

### Root motion

`root`: `"normal"` (the clip moves the character as it was made), `"inPlace"` (the root's travel along the ground taken
out, its up and down kept), `"accumulate"` (a looping walk carries on from where the last loop ended instead of jumping back). `{ "mode":
"inPlace", "bone": "Hips" }` names the root bone; left out, of the bones the clips move by translation the one with the most of the
skeleton under it (the hips, never a foot).

### Morphs

`morphs: { "<target>": 0.4 }` or `{ "value", "mode", "weight", "mesh", "keys" }`: `mode` `replace` (default) sets the weight
over what the clips made, `add` adds to it; `weight` (`0–1`, default 1, times the layer's) is how much of it applies; `mesh` limits it
to one mesh by node name (left out: every mesh with that target). Keys: `value`, `weight`. Draft and Final draw the mixed shape (Final
traces it).

### Speech

`speech: { "clock": "voice" }`: the character speaks the voice a Scene clock plays: its own jaw bone and mouth morphs, found
by their common names, follow the words, added on top of the morphs and bones ([video-world3d.md](video-world3d.md#a-character-speaks-posespeech):
the clock, `POST /api/world3d/lipsync`, the fields). The pose report's `mouth` says what the file speaks with.

- **A face that carries its own viseme shapes and ARKit's** (a Character Creator head: `p_b_m_21`, `aa_02`, `w_uw_07`, …): leave
  `morphs` out first, so its ARKit names are found by themselves, and render a still at a b, a vowel and an "oo" with each; map the
  file's own shapes only where its still beats ARKit's. On such a head ARKit's `mouthPress` / `mouthRoll` sealed every closure checked
  (18 stills of a 21 s clip), while its own `p_b_m_21` moved the lips 5.5 mm and left a line of teeth at all 9 b, p and m checked, and
  `w_uw_07` never rounded the lips on "who".
- **Check it** on a still at a closed lip and one at an open vowel (the voice item's start plus the word's time in the clock's
  `lipsync.words`): a still is the same frame a render draws at that time. For a whole render, count the dark mouth-inside pixels in
  each frame: in a pause over ~0.6 s the count returns to its rest value (a shorter pause holds the mouth part open, as a
  speaker's does), and at every b, p and m it is at or below rest.
- **Judge it at normal speed**, in Final, beside a reference (a real speaker, or Audio2Face-3D on the same sound), not on stills
  and not on one number alone: measure how often the mouth moves and how far.
  - Jaw: about 3–5 turns a second and under ~3 jumps a second (a jump = a third of its range in one frame).
  - Syllables: the jaw opens and closes visibly on about 70 % of them, and the mouth's open area goes back near its rest between them.
  - Blinks: 20–30 a minute, most at pauses. A face that never blinks reads dead.
  - Popping: a track that sealed every closure checked still gave the mouth a new whole shape every two frames (7.4 jaw turns and
    6.3 jumps a second, against two real speakers' 3.3 and 1.2).
  - Mumbling: the smoothed track that cured the popping melted the syllables (the jaw closed visibly on 41 % of a slow reading's
    syllables, against Audio2Face-3D's 71 %).
- **Judge the mouth's shape in Draft, its inside in Final:** Draft lights the inside of so small a cavity as an open surface (the
  tongue reads bright pink and seems to fill the opening: its area lights cast no shadows and its environment light is not occluded
  there); one Final still at an open vowel shades it dark, the tongue back behind the lower teeth. A speaking proof clip in Final:
  `spp` 8 is clean (denoised) at 1.75 s a frame for 960 × 1080, rendered in parts of 3–4 s.

### Bones

`bones: { "<bone>": { … } }`: a local transform over what the clips and morphs made. Any node of the file counts, not only bones.

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `rot` | `[x, y, z]` degrees | none | The turn, Euler order `XYZ`, in the bone's own frame. Keys blend each angle on its own: a key at 175 then one at −175 turns 350° the long way ([unwrap the track](#rotation-tracks-convert-unwrap-world-to-local)), and a turn whose middle angle passes ±90° can flip. |
| `quat` | `[x, y, z, w]` | none | The same turn as a quaternion (normalised; `w` left out is 1). Keys turn by the shortest arc between two keys, so nothing flips; two keys more than 180° apart turn the other way, so key a turn that large in steps. When `quat` or `keys.quat` is there, `rot` and its keys are ignored. |
| `at` | `[x, y, z]`, the parent's units | none | `add`: an offset; `replace`: the bone's place in its parent. |
| `scale` | number or `[x, y, z]` | none | `add`: multiplies; `replace`: sets. |
| `mode` | `add` \| `replace` | `add` | `add` turns, moves and scales on top of the animation; `replace` sets the local transform outright against the parent, not the rest pose (`quat: [0, 0, 0, 1]` lines the bone up with its parent's axes), by `weight`. |
| `weight` | `0–1` | `1` | How much of it applies (times the layer's `weight`). |
| `keys` | tracks | none | `rot`, `quat`, `at`, `scale`, `weight`. |

A layer's `mask.properties` lets `rot` / `quat` through as `rotation`, `at` as `position`, `scale` as `scale`.

### Hand shapes

`hands`: `{ "left": "pinch", "right": { "shape": "grip", "amount": 0.9 } }` (sides `left`, `right`, `L`, `R`) or a list
`[{ "side": "right", "shape": "point" }]` (no `side`: the left hand when the rig has both). Step 3 shapes the hands first (the pose's,
then each layer's, by the layer's `weight` and `mask`), then the `bones` overrides refine them. The finger bones are found by name
(`Thumb1.L`, Rigify `f_index.01.L`, Mixamo `LeftHandIndex1`, `index_01_l`, `thumb_1_r`, or chains under a palm, hand or wrist bone),
and each bone's curl, spread and thumb axes are worked out from the rest pose, so a finger bends toward the palm whatever the file's
bone axes. A hand without finger bones is skipped with the warning `unknown_hand` (a `biped` template has none: add finger `joints`).

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `shape` | `relaxed` \| `point` \| `pinch` \| `grip` \| `spread` | none | A preset (below): curl per finger, thumb opposition, spread. Left out, only `curl`, `spread` and `oppose` move the fingers. Its keys switch at their time. |
| `amount` | `0–1` | `1` | Scales the whole shape (curl, spread, opposition); 0 leaves the hand as the animation has it. |
| `curl` | one number, `[thumb, index, middle, ring, pinky]` or `{ "thumb": …, "index": … }` | the preset's | The bend of each finger it names, in place of the preset's: 1 bends a finger's three bones 78°, 95° and 65° (the thumb's 28°, 52°, 60°), times the preset's share for each bone. |
| `spread` | as `curl` | the preset's | Fans the fingers at their first bone: 1 turns the thumb 26°, index 14°, middle 2°, ring −12°, pinky −24° (positive toward the thumb). |
| `oppose` | number | the preset's; no `shape`: 0.55 × `curl` when `curl` is one number, else 0 | Turns the thumb's first bone across toward the palm: 1 is 46°. |
| `curlAxis` | `[x, y, z]` or `{ "<bone>": [x, y, z], "default": [x, y, z] }` | found from the rest pose | The axis the finger bones curl about, in each bone's own frame, for a finger the found axis bends sideways. The map names a bone as the file does or as the loader does (`Thumb1.L` or `Thumb1L`); `default` covers the others. Spread and opposition keep the found axes. |
| `mode` | `add` \| `replace` | `add` | `add` turns the finger bones on top of the animation; `replace` from their rest turn, by `weight`. |
| `weight` | `0–1` | `1` | How much of it applies (times the layer's `weight`). |
| `on` | bool | `true` | `false`: the hand stays as the pose has it. Its keys switch at their time. |
| `keys` | tracks | none | `shape`, `amount`, `curl`, `spread`, `oppose`, `weight`, `on`. `curl` and `spread` keys blend in all three forms. In the `{ "thumb": … }` form name the same fingers in every key: a finger named in only one of two neighbouring keys holds that key's value between them, and from the last key on (or before the first) a finger that key leaves out takes the preset's. |

| `shape` | `curl` thumb, index, middle, ring, pinky | `oppose` | Spread |
| --- | --- | --- | --- |
| `relaxed` | 0.22, 0.20, 0.24, 0.28, 0.32 | 0.25 | none |
| `point` | 0.55, 0.04, 0.86, 0.90, 0.92 | 0.65 | none |
| `pinch` | 0.45, 0.48, 0.58, 0.66, 0.74 | 0.85 | index −4° |
| `grip` | 0.76, 0.80, 0.84, 0.86, 0.88 | 0.80 | thumb 4°, index 3°, ring −3°, pinky −6° |
| `spread` | 0.02 each | 0 | the full fan (`spread` 1) |

On a model layer, `model3dConfig.skinning: "dualQuaternion"` skins the file's own skeleton by dual quaternions too (a bent elbow keeps
its thickness, a twisted wrist does not collapse); the file's skeleton skins `linear` unless it is set.

### Constraints

`constraints: [...]`, each with `type`, `bone`, `weight` (key it 0 → 1 to hand the bone from its animation to the
constraint: space switching) and `on`. A target is `"@id"` (a Scene object or timeline `model3d` layer), `[x, y, z]` (a point in the Scene's metres: the editor's 3D space, one composition pixel = 1 mm), `{ "bone": "<name>" }` (one of the character's own), or `{ "model": "<itemId|channelName>", "bone"?: "<name>", "point"?: [x, y, z] }`:

| `type` | Fields | What it does |
| --- | --- | --- |
| `lookAt` | `target`, `chain` [1, up to 4: the bone and its parents share the turn], `limit` [180 degrees from the animated pose], `axis` (the bone's front in its frame; default: the model's front, `forward`, as the bone holds it at rest), `forward` [`[0, 0, 1]`, +Z of the file] | Aims the bone at the target by the shortest turn. |
| `ik` | `target`, `pole`, `poleAngle` [deg, keyable], `minBend` / `maxBend` [deg], `limits` (`{ minBend, maxBend, top, mid, end }`), `tip`, `orient` (`true` \| `[rx, ry, rz]` \| `{ aim, up, axis, forward }`), `rot` (`[rx, ry, rz]`, keyable), `surface` (`true` \| `{ normal, clearance }`), `contact` (`"bone"` \| `"surface"`), `surfaceNormal`, `clearance` [m] | Two-bone IK: `bone` is the end (a wrist `Palm2.L`, an ankle); its parent and grandparent bend so it reaches the target, the middle joint toward `pole` rotated by `poleAngle`. `minBend` / `maxBend` prevent hyperextension and self-folding; `limits.{top,mid,end}` clamp local Euler `{ x, y, z: [min, max] }` or geodesic `{ swing, twist }` degrees. With `surface: true` / `contact: "surface"`, IK solves directly on the skinned surface. |
| `splineIk` | `bones` (root→tip list) \| `bone` + `chain` [4], `path` (2+ points/refs), `closed`, `start` / `end` [0–1], `progress` [0–1], `stretch` [bool\|0–1], `twist` [deg \| `{ start, end }`], `up`, `limit` [deg], `keepRoot` | Fits a spine, neck, tail, tentacle or cable bone chain along a smooth centripetal Catmull-Rom `path` with parallel-transport orientation. `bones` or tip `bone` + `chain`; keyable `start`, `end`, `progress`, `stretch`, `twist`. |
| `parent` | `target`, `at`, `rot`, `orient` [true] | The bone is held by the target (a hand on a wheel), offset by `at` (metres) / `rot` (degrees). |
| `path` | `path` (2+ points), `progress` [0–1, keyable], `closed`, `orient` [false: turn the bone's front along the path], `axis` (that front in the bone's frame; default from `forward`), `forward` [`[0, 0, 1]`] | The bone moves along a smooth curve through the points (a root along a route, a hand drawing a line). |
| `attach` | `object` (a Scene object id or timeline `model3d` layer id/name), `at`, `rot`, `point` (anchor offset on held object), `keep`, `grab` | The Scene object or timeline `model3d` layer is held by the bone (a cup or phone in a hand): Draft and Final draw it there; `weight` between 0 and 1 puts it part way from its own place (key 0 → 1 the moment the hand reaches it). `keep: true` holds it where it was against the bone at the pick-up (`grab` seconds; left out, where `weight` starts to rise) instead of at `at`/`rot`, so it never jumps. |
| `pinch` | `object` (a Scene object or model layer id, or `{ model, bone?, point? }`), `fingers` [`["thumb", "index"]`: a list of finger names], `side` (`left` \| `right` \| `L` \| `R`; left out: from `bone`'s name), `clearance` [0.0005 m], `maxCurl` [1.2, at least 0.2: the most a finger closes, in a hand's `curl` units], `spread` [0, as a hand's], `curlAxis` (as a hand's), `size` [m: one number a cube, `[x, y, z]` a box] / `thickness` [m: an 8 × 12 cm slab that thick] for an object with no shape of its own (neither: a 2 cm cube) | Relaxes/binary-searches finger curl so every skinned vertex along each finger maintains `clearance` against the whole held object's shape without skin penetration. |

`"@id"` targets stand where the Scene shows that object at the moment (keys, clocks and parents included): a model layer's pose asks
at the layer's seconds and the target is read at the matching Scene time, so the two clocks may differ.

### Corrective morphs

Corrective morph drivers, `correctives: [{ "bone", "morph", "axis"?, "from"?, "to"?, "min"?, "max"?, "curve"?, "mode"?, "mesh"?, "weight"?, "on"? }]`, on `pose` and `layers[]`: evaluated in step 4b after constraints, reading the final local delta of `bone` (`axis`: `"bend"` | `"twist"` | `"x"` | `"y"` | `"z"` | `[x, y, z]`) and smoothly driving morph `morph` (`from`→`to` degrees mapping to `min`→`max`, `curve`: `"smooth"` | `"linear"` | `"easeIn"`, `mode`: `"add"` | `"max"` | `"replace"`).

### Layers

`layers: [{ "id", "on", "weight", "mask", "clips", "morphs", "bones", "hands", "constraints", "correctives", "keys" }]`: each lies over the pose below,
in each step, by its `weight` (keyable), only where its `mask` lets it: `bones` and `objects` (names, with their children unless
`"children": false`), `exclude`, `properties` (`rotation`, `position`, `scale`, `morphs`), `morphs` (names). `"on": false` leaves a layer
out without deleting it.

### What a file offers

A still with `"inspect": true` answers, for each posed model layer in a Scene, `scene.poses["<item id>"]` (a Scene object's skeleton: `scene.skeletons`, below): its
`clips` (name, seconds), `morphs`, `nodes` (every node with its parent, `bone` and `mesh` flags) and `solved` (this frame's constraints:
`lookAt` `errorDeg`, `ik` `distance` from the target in mm with `reach` and `targetDistance`) plus the pose's `warnings`. Write a small pose
(one clip), render one still with `inspect`, then name what the file really has. `POST /api/world3d/validate` with `{ "data": <project> }`
checks every pose with the project (unknown fields, a constraint without its `bone` or `target`, a Scene object that does not exist).

### Rotation tracks: convert, unwrap, world to local

Two routes do the arithmetic of [`bones`](#bones) keys. They read neither the project nor the file: they answer keys, and you write
them into `pose.bones` yourself.

**`POST /api/world3d/pose/convert-rotation`** `{ "mode", "keys": [{ "t", "v", … }], "order" }` answers `{ "keys" }`, each key as
sent (`t`, `ease` and the rest) with its `v` replaced:

| `mode` | `v` sent | `v` answered | Use it when |
| --- | --- | --- | --- |
| `euler_to_quat` (default) | `[x, y, z]` degrees | `[x, y, z, w]`, a unit quaternion, each on the same side as the one before | a `rot` track flips near ±90° on its middle angle or wobbles on a large turn: write the answer to `keys.quat` and take `rot` out |
| `quat_to_euler` | `[x, y, z, w]` | `[x, y, z]` degrees, unwrapped as below | a `quat` track must be read or edited as angles, or written as `rot` |
| `unwrap_euler` | `[x, y, z]` degrees | each angle moved by whole turns (360°) to within 180° of the key before | a `rot` track jumps across ±180° (175 → −175 spins 350° the long way; unwrapped it is 175 → 185) |

- `order`: `XYZ` (default), `YXZ`, `ZXY`, `ZYX`, `YZX` or `XZY`, any case, with three.js's meaning (`XYZ` is the matrix R(X)·R(Y)·R(Z)).
  A pose reads `rot` as `XYZ`, so keep `XYZ` for `bones` keys; another order only for angles written in it elsewhere. `unwrap_euler`
  ignores it.
- A key that is not an object, or whose `v` has fewer than 3 numbers (4 for `quat_to_euler`), is left out of the answer.
- `quat` keys turn by the shortest arc, `rot` keys angle by angle: converted keys more than 180° apart turn the other way, so add keys in
  between before converting (one each 90° of the turn).
- At the gimbal (`quat_to_euler` with the middle angle at ±90°) one of the other two angles comes back 0; the turn is the same.
- Errors: 400 `Unknown Euler order …`; 400 `mode must be euler_to_quat, quat_to_euler, or unwrap_euler`; 400 when a `v` holds a `null`
  or a string that is not a number; 422 when `keys` is not a list of objects.

**`POST /api/world3d/pose/world-transfer`** `{ "samples", "useQuat", "order", "includePos", "includeRot" }` answers `{ "control" }`:
a bone's motion known in world space, with its parent's, made into a `bones` control in the bone's own local space. Use it when the
motion comes as world places and turns (a capture, a solve of your own) and the bone's parent moves too. To follow an object live, use
a `parent` or `ik` constraint; for a BVH or another skeleton's clip, `skeleton.retarget` or `POST /api/world3d/retarget`.

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `samples` | `[{ "t", "position", "quaternion", "parentPosition", "parentQuaternion", "parentScale" }]` | `[]` | One per key. `t` is in the pose's seconds (the layer's on a model layer, the Scene's on a Scene object), copied as is. `position` `[x, y, z]` and `quaternion` `[x, y, z, w]` are the bone's world place and turn; `parentPosition`, `parentQuaternion` and `parentScale` `[x, y, z]` its parent's, at the same moment. All in one frame and one unit. Left out: `[0, 0, 0]`, `[0, 0, 0, 1]`, `[1, 1, 1]` (a 0 scale counts as 1). |
| `useQuat` | bool | `true` | The turn as `quat` keys; `false`: `rot` keys in degrees, unwrapped. |
| `order` | as above | `XYZ` | The Euler order of `rot` (with `useQuat: false` only). Keep `XYZ`, the order a pose reads. |
| `includePos` | bool | `true` | Write `at`. |
| `includeRot` | bool | `true` | Write `quat` or `rot`. |

The answer, `{ "control": { "mode": "replace", "at", "quat" | "rot", "keys": { "at": [...], "quat" | "rot": [...] } } }`, goes in as
`pose.bones["<bone>"]`; `at`, `quat` and `rot` hold the first sample's values. `at` is `position − parentPosition` turned back by the
parent's turn and divided by `parentScale`, in the parent's own units (what `bones{}.at` takes); `quat` is `parentQuaternion⁻¹ ·
quaternion`, normalised, each on the same side as the one before. Every key carries `"ease": "linear"`, so the bone moves on through
each sample without slowing there. No samples: `{ "mode": "replace", "keys": {} }`.
Errors: 400 `Unknown Euler order …` (checked only with `useQuat: false`); 400 when a `t` or a vector holds a `null` or a string that is
not a number, or a vector is short (`position`, `parentPosition`, `parentScale` take 3 numbers, `quaternion`, `parentQuaternion` 4);
422 when `samples` is not a list of objects.

### Worked example: a character waves, looks and reaches

A character idles, waves, turns its head to a flying target on a layer of its own and reaches a ball with its left
hand (three.js's RobotExpressive.glb, CC0, on a model layer; placed by `fit: "unit"` and `anchor: "origin"`, so the file's origin stands at the layer's place; the targets, as always, are Scene metres; `fit: "height"` / `"width"` measure a skinned character as it stands too, its bones included):

```json
"model3dConfig": {
  "source": "custom", "fit": "unit", "fitValue": 160, "anchor": "origin", "placeOnRigFloor": false,
  "pose": {
    "order": ["clips", "morphs", "bones", "constraints", "world"],
    "clips": [
      { "clip": "Idle" },
      { "clip": "Wave", "start": 1.0, "fadeIn": 0.8, "end": 4.2, "fadeOut": 0.8 }
    ],
    "morphs": { "Surprised": { "value": 0, "keys": { "value": [{ "t": 0.9, "v": 0 }, { "t": 1.4, "v": 0.8 }, { "t": 2.4, "v": 0 }] } } },
    "bones": { "Torso": { "rot": [0, 0, 0], "keys": { "rot": [{ "t": 2.8, "v": [0, 0, 0] }, { "t": 3.8, "v": [0, 0, -10] }] } } },
    "layers": [
      { "id": "look", "mask": { "bones": ["Neck"] }, "weight": 0, "keys": { "weight": [{ "t": 0.5, "v": 0 }, { "t": 1.2, "v": 1 }] },
        "constraints": [{ "type": "lookAt", "bone": "Head", "chain": 2, "target": "@fly", "limit": 80 }] },
      { "id": "reach", "mask": { "bones": ["UpperArm.L"] },
        "constraints": [{ "type": "ik", "bone": "Palm2.L", "tip": "Middle2.L_end", "target": "@grip", "pole": [0.45, -0.3, -0.25],
          "weight": 0, "keys": { "weight": [{ "t": 3.2, "v": 0 }, { "t": 4.2, "v": 1 }] } }] }
    ]
  }
}
```

with `fly`, `ball` and `grip` as objects of the Scene (`rig.scene.objects`): `{ "id": "ball", "at": [0.24, -0.03, 0.17], "graph": [{ "op":
"sphere", "radius": 0.04 }] }`, the point the fingertips land on as an object with no graph on the ball's surface toward the shoulder
`{ "id": "grip", "parent": "ball", "at": [-0.027, -0.004, -0.032] }`, and `fly` keyed along `at`. The target must be within the arm's
reach of the shoulder (`solved` says `targetDistance` against `reach`). To pick the ball up afterwards add
`{ "type": "attach", "bone": "Palm2.L", "object": "ball", "keep": true, "weight": 0, "keys": { "weight": [{ "t": 4.3, "v": 0, "ease": "linear" }, { "t": 4.4, "v": 1 }] } }`
and key the IK's weight back to 0: the arm returns to its clip with the ball in its hand.

## Skeletons for meshes that have none (`skeleton`)

`skeleton` gives a mesh with no skeleton one: joints, skin weights, and clips made of keys on the joints. It goes on a model layer
(`model3dConfig.skeleton`, a GLB/GLTF without a skeleton) or on a Scene object (`rig.scene.objects[i].skeleton`, a mesh built by its
`graph`, or a `model` file). The mesh is then a skinned character like a file that came with one: a `pose` moves its joints (on a model
layer `model3dConfig.pose`, on a Scene object the object's own `pose`, on the Scene's clock), Draft skins it, Final traces it skinned,
stills and exports alike. A mesh without `skeleton` is untouched.

A file that already has a skeleton can carry one too: when every joint names a bone the file has (and there is no `template`), the
joints describe the file's own skeleton. Nothing is bound again; `skeleton.clips` play on its bones (a key turns a joint in the
skeleton's frame: its `rot`, or the mesh's axes when left out), and a plain mesh in the file keeps its place unless `parts` names it.
This is what `POST /api/world3d/prepare-asset` writes for a rigged model it retargeted a motion onto.

Points are in the **mesh's own space**: a Scene object's local metres (before its `at`/`rot`/`scale`); a model file's own units (before the
layer's fit). The figure stands up +Y, faces +Z, its left is +X (`.L` names).

### Skeleton fields

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `template` | `biped` \| `quadruped` | none | A ready joint tree placed by `landmarks`. biped: `hips` (root), `spine`, `chest`, `neck`, `head`; `upperArm`, `forearm`, `hand`; `thigh`, `shin`, `foot`, `toe` (each `.L` / `.R`). quadruped: `hips`, `spine`, `chest`, `neck`, `head`, `tail`; `upperArm`, `forearm`, `frontFoot`; `thigh`, `shin`, `hindFoot` (`.L` / `.R`). |
| `landmarks` | `{ name: [x, y, z] }` | `{}` | Points on the body. biped: `hips`, `spine`, `chest`, `neck` (foot of the neck), `head` (top of the neck), `headTop`, `shoulder`, `elbow`, `wrist`, `handTip`, `hip`, `knee`, `ankle`, `ball`, `toe` (the last ten `.L` / `.R`). quadruped: `hips`, `spine`, `chest`, `neck`, `head`, `nose`, `tail`, `tailTip`, `shoulder`, `elbow`, `wrist`, `frontFoot`, `hip`, `knee`, `hock`, `hindFoot`. **Every one left out is found from the mesh's shape** (cross-sections: the legs where a cut is two rings, a bent knee where the leg's line bends most; the neck at the narrowest cut; each arm, out in a T or A pose or hanging clear of the body at its side, followed from the fingertips by cuts square to it to where it meets the torso: the shoulder half the arm's radius past the armpit, an arm's radius under the shoulder's top; a flat hand's wrist where the round forearm turns into the palm (big cartoon hands included), else 0.76 of the way from the shoulder to the fingertips, the elbow 0.55 of the way to the wrist; a quadruped's four legs near the ground, a hind leg's hock and knee where it zigzags, its head and neck followed back from the nose: `head` at the narrowest of the neck behind the skull, `neck` where it meets the body). |
| `symmetric` | bool | `true` | A `.L` point (given or found) also places its `.R`, mirrored across the middle. |
| `joints` | `[{ name, parent, at, tail, rot }]` | none | Joints written out: the whole tree without a template, or ones that replace a template's joint of the same name or are added to it (fingers, ears, a tail). `at` is where it turns, `tail` where a joint with no children ends, `rot` its rest turn (degrees; left out, its axes are the mesh's). |
| `bind` | `skin` \| `rigid` | `skin` | `skin`: smooth weights that bend the surface. `rigid`: each connected part follows the one joint that holds most of it (a robot of separate parts). |
| `skinning` | `dualQuaternion` \| `linear` | `dualQuaternion` | How the joints move the skin. Dual quaternions: every point follows a rigid blend of its joints, so a 90-degree elbow keeps its full thickness and a wrist twisted half a turn stays round; a joint's `scale` (a pose's or a clip's) scales its part of the skin about the joint, as linear blending does. `linear`: the joints' matrices averaged, as a file's own skeleton is drawn: a 90-degree bend thins to 0.71 at the crease, a half-turn twist collapses. |
| `parts` | `{ "<mesh name>": "<joint>" }` | none | A model file's meshes by name, each following one joint whole. |
| `weights` | `{ smooth, threshold, visibility }` | `0`, `0.01`, `true` | Blur passes after the solve; the smallest share kept (four joints a vertex at most); whether heat reaches only the points that see a bone from inside the body. |
| `fixes` | list | none | Manual weight edits, in order — below. |
| `clips` | `[{ name, duration, bones }]` | none | Animations made of keys — below. |
| `retarget` | `{ bvh \| source, name?, scale?, inPlace?, map?, alignRest?, stride? }` or list | none | Retargets a BVH text or glTF/source skeleton clip onto this rig's joints cleanly at bind time (scales hip translation, strips horizontal root drift when `inPlace: true`, aligns limb rest poses). Or use `POST /api/world3d/retarget` / `POST /api/world3d/prepare-asset`. |

### Automatic weights

Automatic weights are heat diffusion over the surface (each joint's bone held hot, the surface's steady temperature is its weight):
smooth over every bend, never through the air, so two legs or two fingers that touch nothing but the body share nothing; a joint's heat
also stops where the nearest joint is neither it, its parent nor its child, so nothing creeps from one leg round the crotch into the other.
Four joints a vertex at most, adding up to exactly 1: the rest pose is the mesh itself (moves 0). Draft, Final and a model layer in its
own pass skin by the same dual quaternions.

### Fixes

`fixes: [...]`, each `{ "joint", "value", "mode": "set" | "add" | "multiply" | "max" | "min", "strength" }` over a region, or
`{ "smooth": passes }` that blurs every joint's weights there. The other joints share what the fixed one leaves as they did. Regions (all
given at once multiply): `group` (a vertex group the graph wrote: `weightGradient`, `weightProximity`, `weightMask`, `weightNoise`),
`mesh` (a model file's mesh by name), `of` (the points a joint holds most now), `box: { min, max }` and `sphere: { at, radius }` with
`soft` metres of fade, `near: { at, radius, inner, falloff: "smooth" | "linear" | "sharp" }` (a brush).

### A head whose jaw opens

Weight the lips' ring by its place round the mouth, not by height: the lower half on the jaw, the upper half on the head, the corners
shared over ±20°, and the inside of the mouth the same; cut the face's skin out round the lips with a collar of skin from the lip line
to the cut. Put the jaw's pivot below the ear, behind and above the mouth (a `skeleton` joint `Jaw` with a child at the chin). Weights
by height (everything under the lip line on the jaw) take the upper lip's underside with the jaw and stretch it into a sheet, and the
face's skin left across the mouth stretches over the opening: an 18° jaw moves the lower lip about 3 cm, and any point weighted across
the lip line spans that gap.

### Skeleton clips

`clips: [{ "name": "wave", "duration": 1, "bones": { "forearm.R": { "rot": [{ "t": 0, "v": [0, 0, -15] }, { "t": 0.5, "v": [0, 0, -55] }, { "t": 1, "v": [0, 0, -15] }] } } }]`:
`rot` turns from the joint's rest (degrees XYZ: the mesh's axes when the joint has no `rot`), `at` moves from it, `scale` multiplies;
keys in the clip's own seconds. A pose plays them like a file's own (`"clips": [{ "clip": "wave", "start": 2.8, "fadeIn": 0.6 }]`:
crossfades, loops, root motion), and its IK, look-at, bones and layers work on the joints by name (`"thigh.L"` or `"thighL"`).

### Check before posing

A still with `"inspect": true` answers `scene.skeletons["<id>"]`: the `joints` (name, parent, where), the
`landmarks` used and which were `found` from the shape, and a `report` (`vertices`, `parts`, `unseen` points no bone could see,
`neutralMaxMove` — 0 —, `ms`, the `fixes` with the points each touched). A landmark found in the wrong place: give it in `landmarks`.
A joint's region that bends wrong in a pose: fix it (`fixes`) and render again. `scene.warnings` names a landmark a template could not
find, a fix that touched nothing, a joint name that is not a joint. `POST /api/world3d/validate` checks the fields and every joint name
a part names (a parent, a fix, a clip's track).

### Worked example: a figure built, rigged and walking

A figure built from the graph, rigged, walking with its feet planted by IK, then waving (a Scene object; the walk's
clips are keys on the template's joints; each foot's IK target is a point keyed on the floor — held where the foot is planted for 60 % of
a step, then an arc (`ease: "linear"` keys, or one every 1/30 s) to the next plant one stride on; the pole moves with the body; the object's
own `at` keys carry it forward):

```json
{ "id": "walker", "at": [-1.8, -0.42, 0], "rot": [0, 90, 0], "material": "clay",
  "keys": { "at": [{ "t": 0, "v": [-1.8, -0.42, 0], "ease": "linear" }, { "t": 2.2, "v": [-0.48, -0.42, 0] }] },
  "graph": [{ "op": "skin", "blend": 0.03, "voxel": 0.012, "smooth": 2, "paths": [
    [[0, 0.93, 0, 0.15], [0, 1.1, 0.005, 0.135], [0, 1.3, 0, 0.155], [0, 1.47, 0, 0.06], [0, 1.53, 0.005, 0.065], [0, 1.635, 0.012, 0.11]],
    [[0.095, 0.9, 0, 0.085], [0.105, 0.5, 0.015, 0.06], [0.11, 0.085, 0, 0.045], [0.11, 0.035, 0.15, 0.035]],
    [[-0.095, 0.9, 0, 0.085], [-0.105, 0.5, 0.015, 0.06], [-0.11, 0.085, 0, 0.045], [-0.11, 0.035, 0.15, 0.035]],
    [[0.08, 1.36, 0, 0.09], [0.2, 1.4, 0, 0.055], [0.42, 1.24, 0, 0.045], [0.6, 1.1, 0.01, 0.035], [0.7, 1.02, 0.02, 0.028]],
    [[-0.08, 1.36, 0, 0.09], [-0.2, 1.4, 0, 0.055], [-0.42, 1.24, 0, 0.045], [-0.6, 1.1, 0.01, 0.035], [-0.7, 1.02, 0.02, 0.028]] ] }],
  "skeleton": { "template": "biped",
    "landmarks": { "hips": [0, 0.95, 0], "chest": [0, 1.3, 0], "neck": [0, 1.46, 0], "head": [0, 1.55, 0.005], "headTop": [0, 1.75, 0.012],
      "shoulder.L": [0.2, 1.4, 0], "elbow.L": [0.42, 1.24, 0], "wrist.L": [0.6, 1.1, 0.01], "handTip.L": [0.7, 1.02, 0.02],
      "hip.L": [0.095, 0.88, 0], "knee.L": [0.105, 0.5, 0.015], "ankle.L": [0.11, 0.085, 0], "toe.L": [0.11, 0.035, 0.185] },
    "clips": [
      { "name": "walk", "duration": 1.1, "bones": {
        "hips": { "at": [{ "t": 0, "v": [0, -0.038, 0] }, { "t": 0.275, "v": [0, -0.062, 0] }, { "t": 0.55, "v": [0, -0.038, 0] }, { "t": 0.825, "v": [0, -0.062, 0] }, { "t": 1.1, "v": [0, -0.038, 0] }] },
        "upperArm.L": { "rot": [{ "t": 0, "v": [22, 0, -50] }, { "t": 0.55, "v": [-22, 0, -50] }, { "t": 1.1, "v": [22, 0, -50] }] },
        "upperArm.R": { "rot": [{ "t": 0, "v": [-22, 0, 50] }, { "t": 0.55, "v": [22, 0, 50] }, { "t": 1.1, "v": [-22, 0, 50] }] } } },
      { "name": "wave", "duration": 1, "bones": {
        "upperArm.R": { "rot": [{ "t": 0, "v": [0, 0, -125] }] },
        "forearm.R": { "rot": [{ "t": 0, "v": [0, 0, -15] }, { "t": 0.5, "v": [0, 0, -55] }, { "t": 1, "v": [0, 0, -15] }] } } } ] },
  "pose": {
    "clips": [{ "clip": "walk", "end": 2.55, "fadeOut": 0.5 }, { "clip": "wave", "start": 2.8, "fadeIn": 0.6 }],
    "constraints": [
      { "type": "ik", "bone": "foot.L", "target": [-1.6, -0.335, -0.11], "pole": [-0.8, 0.08, -0.11],
        "keys": { "target": [{ "t": 0, "v": [-1.6, -0.335, -0.11] }, { "t": 0.66, "v": [-1.6, -0.335, -0.11], "ease": "linear" },
          { "t": 0.88, "v": [-1.28, -0.265, -0.11], "ease": "linear" }, { "t": 1.1, "v": [-0.96, -0.335, -0.11] }, { "t": 1.76, "v": [-0.96, -0.335, -0.11] }] } },
      { "type": "ik", "bone": "foot.R", "target": [-1.92, -0.335, 0.11], "pole": [-0.8, 0.08, 0.11], "keys": { "target": [ "… the same steps, half a cycle later" ] } }
    ],
    "layers": [{ "id": "look", "mask": { "bones": ["neck"] }, "weight": 0, "keys": { "weight": [{ "t": 2.6, "v": 0 }, { "t": 3.3, "v": 1 }] },
      "constraints": [{ "type": "lookAt", "bone": "head", "chain": 2, "target": [0.1, 1.08, 4], "limit": 75 }] }]
  } }
```

A model file without a skeleton is rigged the same way on its layer: `"model3dConfig": { "fit": "unit", "fitValue": 1000, "skeleton":
{ "template": "biped", "landmarks": { "shoulder.L": [0.16, 1.29, -0.06] }, "fixes": [{ "joint": "head", "value": 1, "box": { "min":
[-0.21, 1.4, -0.2], "max": [0.21, 1.76, 0.14] }, "soft": 0.03 }], "clips": [ … ] }, "pose": { … } }` — every other landmark found from its
shape, and one fix that gives the whole head to the head joint (its automatic weights left a flap at the back of the neck behind when
the head turned).

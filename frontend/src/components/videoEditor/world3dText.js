/*
 * 3D Text in the Scene's world.
 *
 * On a frame the world draws, a top-level 3D Text layer hands its letters to the world instead of filming them in a pass of its own:
 * the same run the 3D pass reads (layerMesh.js buildText3dRun), placed by the same quad transform (channelRender.js), so the letters
 * stand in the one lit world with the models. They cast and take its shadows, show in its reflections and are traced in Final, and
 * 2D layers and depth of field meet them by the world's depth. Glyph meshes are shared by every letter that uses one, the world keeps
 * them as it keeps a model's (frontend/src/world3d/render/letters.js), and a letter that moves or changes colour rebuilds nothing.
 *
 * The run is laid out while the channels draw, after the world has been prepared, so a frame with letters in the world is posed and
 * drawn once every channel has drawn (world3dLayer.js finishWorldFrame).
 *
 * Pure apart from the glyph ids, so the node tests can load it.
 */
import { isText3dLayer, isTextInWorldLayer } from './text3d.js';
import { WORLD_UNITS } from './world3dScene.js';
import { GLYPH_RASTER_PX } from './text3dGlyphConstants.js';

/** A picture layer that stands in a world Scene as a card (`inWorld`, as text's `textInWorld`): an HTML clip (drawn live), a video or an
 *  image, shown through liveLayers.js (pictureWorldRun). `inWorld: true` or `{ enabled, lit, castShadow, receiveShadow }`. */
export function isPictureInWorldLayer(item, clip) {
  const v = item?.inWorld;
  if (!(v === true || v?.enabled === true) || !clip) return false;
  return !!clip.htmlSource || ((clip.mediaType === 'video' || clip.mediaType === 'image') && !!clip.url);
}

/** How a picture card stands there: `{ lit, castShadow, receiveShadow }`, as text's (text3d.js resolveTextInWorld). */
export function resolvePictureInWorld(item) {
  const v = item?.inWorld && typeof item.inWorld === 'object' ? item.inWorld : {};
  return { lit: v.lit === true, castShadow: v.castShadow === true, receiveShadow: v.lit === true && v.receiveShadow !== false };
}

/** The channels whose 3D Text, or flat text with `textInWorld` (`flat: true`), joins the world at `time`: top level, shown, not locked to
 *  the camera, and with no effect that needs a pass of its own (`keepsOwnPass`: world3dLayer.js textKeepsOwnPass). `activeIndex` is
 *  compositeHelpers.js resolveActiveIndex. */
export function worldTextLayers(env, time, { keepsOwnPass = () => false, activeIndex }) {
  const out = [];
  for (const channel of env.channels || []) {
    if (channel.visible === false || channel.cameraLocked || !channel.items?.length) continue;
    const layout = env.layoutMap?.get(channel.id);
    const index = layout ? activeIndex(layout, time) : -1;
    if (index < 0) continue;
    const item = channel.items[index];
    const clip = env.clipsMap?.get(item?.clipId);
    // a picture layer with `inWorld` stands there as one flat card (isPictureInWorldLayer)
    const flat = isTextInWorldLayer(item, clip) || isPictureInWorldLayer(item, clip);
    if ((flat || isText3dLayer(item, clip)) && !keepsOwnPass(item)) out.push({ channelId: channel.id, itemId: item.id, item, flat });
  }
  return out;
}

const mul = (a, b) => {
  // Row-major 4×4.
  const o = new Array(16);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
    }
  }
  return o;
};

/**
 * The layer's frame in composition px, row-major, exactly as model3dLayer.js renderText3dLayer places it: the quad's position and turn,
 * its scale without the plate's width over the composition's (so letters keep their proportions), and plate px (x right, y DOWN,
 * z AWAY, origin at the plate's corner) turned into the layer's own frame (y up, z toward the viewer, centred).
 *
 * (text3dgaps) `sceneTurn`: the layer's turn as the world turns its objects. The editor writes a layer's Rotate X, Y and Z negated into
 * three's angles (keyframeParenting.js localPrs: Rotate Y +30 is a Scene object's rot [0, -30, 0]); a 3D Text layer standing in the world
 * turns about X and Y as a Scene object's `rot` does instead, and keeps the on-screen sense of its turn in the picture's plane (Rotation /
 * Rotate Z: clockwise, as the editor's rotate handle and selection box draw it). That is the whole turn seen from a frame half a turn
 * about z (x and y reversed), which leaves every turn about z as it is and reverses those about x and y: on the quaternion, x and y change
 * sign. It maps a product of turns to the product of the mapped turns, so a parent's, a path's and a transition's turns come along as
 * they compose (no angles are taken apart, nothing jumps at 90 degrees).
 */
export function text3dLayerMatrix(run, transform, W, H, { sceneTurn = false } = {}) {
  const t = transform || {};
  const p = t.position || {}, q = t.quaternion || {}, sc = t.scale || {};
  const plateW = Math.max(1, Number(run.plateW) || W);
  const plateH = Math.max(1, Number(run.plateH) || H);
  const zx = (Number.isFinite(sc.x) && sc.x !== 0 ? sc.x : 1) * (W / plateW);
  const zy = (Number.isFinite(sc.y) && sc.y !== 0 ? sc.y : 1) * (H / plateH);
  const zz = (Math.abs(zx) + Math.abs(zy)) / 2;
  let [x, y, z, w] = [q.x, q.y, q.z, q.w].every(Number.isFinite) ? [q.x, q.y, q.z, q.w] : [0, 0, 0, 1];
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  if (sceneTurn) { x = -x; y = -y; }
  const outer = [
    (1 - 2 * (y * y + z * z)) * zx, 2 * (x * y - z * w) * zy, 2 * (x * z + y * w) * zz, Number(p.x) || 0,
    2 * (x * y + z * w) * zx, (1 - 2 * (x * x + z * z)) * zy, 2 * (y * z - x * w) * zz, Number(p.y) || 0,
    2 * (x * z - y * w) * zx, 2 * (y * z + x * w) * zy, (1 - 2 * (x * x + y * y)) * zz, Number(p.z) || 0,
    0, 0, 0, 1,
  ];
  return mul(outer, [1, 0, 0, -plateW / 2, 0, -1, 0, plateH / 2, 0, 0, -1, 0, 0, 0, 0, 1]);
}

const cssFirstColour = (css) => {
  const m = String(css || '').match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/i);
  return m ? m[0] : (css || '#ffffff');
};

/**
 * One layer's letters for the world: each letter's glyph, its matrix in world units (column-major, as three stores it) and its colours,
 * and the layer's finish. `finishes` is model3dLayer.js TEXT3D_FINISH, `glyphOf(letter)` the glyph's id, or null for a blank one.
 * Colours are CSS, read by the world as the 3D pass reads them, and follow it: the face colour, else the palette by the letter's place, else the letter's own colour; the side colour,
 * else the face darkened by Side Shade; and the letter's own alpha. The world reads `side: null` as the face darkened by `shade`, in
 * linear light as the 3D pass darkens it.
 *
 * (text3dgaps) The layer turns as the world turns its objects (text3dLayerMatrix `sceneTurn`). `unit`: metres per glyph unit at the
 * letter's font size at rest (its own size, as an op's mesh is in metres before its object's scale): the world builds the glyph in metres
 * with a uv in metres (render/letters.js), so a Scene material's pattern has the size on a letter it has on an object, and the layer's
 * Scale and a Text Animator's Scale grow it with the letter as an object's scale does.
 */
export function worldTextLetters(run, transform, { W, H, finishes, glyphOf }) {
  const s = run.settings || {};
  const finish = finishes?.[s.material] || finishes?.plastic || { roughness: 0.32, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.2, opacity: 1 };
  const layer = text3dLayerMatrix(run, transform, W, H, { sceneTurn: true });
  const palette = Array.isArray(s.palette) && s.palette.length ? s.palette : null;
  const shade = Math.min(0.95, Math.max(0, (Number(s.sideShade) || 0) / 100));
  const letters = [];
  // (mblur5) each letter's name across times: its unit's index, its character and which of that pair it is (a shutter's poses of one letter)
  const seen = new Map();
  for (const g of run.glyphs || []) {
    const glyph = glyphOf(g);
    if (glyph == null) continue;
    const opacity = Math.max(0, Math.min(1, (g.alpha ?? 1) * (finish.opacity ?? 1)));
    if (opacity < 0.002) continue;
    const m = mul(layer, g.m);
    // Row-major px → column-major world units: every row scaled, as world3dScene.js worldMatrix scales a model's.
    const matrix = new Array(16);
    for (let r = 0; r < 4; r += 1) for (let c = 0; c < 4; c += 1) matrix[c * 4 + r] = r < 3 ? m[r * 4 + c] * WORLD_UNITS : m[r * 4 + c];
    // the letter's own size: its font size (a run without one: the size its matrix draws the glyph at)
    const px = Number(g.size) > 0 ? Number(g.size) / GLYPH_RASTER_PX : Math.hypot(g.m[0], g.m[4], g.m[8]);
    const name = `${g.index ?? 0}|${g.ch}`;
    const nth = seen.get(name) || 0;
    seen.set(name, nth + 1);
    letters.push({
      key: `${name}|${nth}`,
      glyph, matrix, unit: +((px > 0 ? px : 1) * WORLD_UNITS).toPrecision(6),
      face: s.faceColor || (palette ? palette[g.index % palette.length] : cssFirstColour(g.color)),
      side: s.sideColor || null,
      shade, opacity,
    });
  }
  // Solid glass is as thick as its letters are deep: a glyph is built GLYPH_RASTER_PX tall, its body `depth` of that behind its face.
  const z = letters[0]?.matrix;
  const thickness = z ? Math.hypot(z[8], z[9], z[10]) * Math.max(0.01, (Number(s.depth) || 0) / 100) * GLYPH_RASTER_PX : 0;
  return {
    finish: {
      roughness: finish.roughness, metalness: finish.metalness, clearcoat: finish.clearcoat, clearcoatRoughness: finish.clearcoatRoughness,
      glass: s.material === 'glass', ...(s.material === 'glass' ? { thickness } : {}),
      // (bugsB) the 3D TEXT section's shadow switches: off, the letters drop no shadow (raster and Final) / take none (raster)
      ...(s.castShadow === false ? { castShadow: false } : {}), ...(s.receiveShadow === false ? { receiveShadow: false } : {}),
      // (polish2) a Scene material by its id (`text3d.sceneMaterial`): the letters wear it in the world, an animated one included
      ...(typeof s.sceneMaterial === 'string' && s.sceneMaterial.trim() ? { material: s.sceneMaterial.trim() } : {}),
    },
    letters,
  };
}

/** (animtools) The Scene object a layer standing in the world rides (`worldParent`: its id), or null. */
export function worldParentOf(item) {
  const id = item?.worldParent;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * (animtools) A 3D Text layer's letters (worldTextLetters) riding a Scene object: every letter's matrix carried by the object's world
 * matrix `parent` (column-major, metres: modelPose.js sceneObjectMatrix), so the layer's own place, turn and size are an offset in the
 * object's space, as a scene object's child is placed (`worldParent`). The same layer when `parent` is null.
 */
export function lettersOnParent(layer, parent) {
  if (!parent || !layer?.letters) return layer;
  return { ...layer, letters: layer.letters.map((l) => ({ ...l, matrix: mulColumns(parent, l.matrix) })) };
}

/**
 * One flat text layer's cards for the world (text3d.js isTextInWorldLayer). `run` is layerMesh.js buildTextWorldRun's: per unit of the
 * layer's Text Animators (a letter, a word or a line, by Based On) a card `m` (row-major, plate px, a unit quad centred on the origin, x
 * right, y down), its cell in the layer's atlas (device px), the part of it a mask leaves (`poly`, card space 0..1, or null) and its
 * opacity. Placed by the layer's quad transform as 3D Text's letters are, then by `view` (column-major, world units) when the world
 * films from a camera of its own: the editor's frame carried onto that camera, so the letters keep their place in the picture.
 * `opacity` is the layer's own.
 */
export function worldFlatLetters(run, transform, { W, H, opacity = 1, view = null }) {
  const layer = text3dLayerMatrix(run, transform, W, H);
  const a = run.atlas;
  const cards = [];
  for (const c of run.cards || []) {
    const alpha = Math.max(0, Math.min(1, (c.alpha ?? 1) * opacity));
    if (alpha < 0.002) continue;
    const m = mul(layer, c.m);
    let matrix = new Array(16);
    for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) matrix[k * 4 + r] = r < 3 ? m[r * 4 + k] * WORLD_UNITS : m[r * 4 + k];
    if (view) matrix = mulColumns(view, matrix);
    const [x, y, w, h] = c.cell;
    // Texture space: a canvas goes up top row last (flipY), so v runs up from the atlas's bottom.
    cards.push({ matrix, uv: [x / a.width, 1 - (y + h) / a.height, (x + w) / a.width, 1 - y / a.height], poly: c.poly || null, opacity: alpha });
  }
  return { atlas: a.canvas, version: a.version, ...run.options, cards };
}

/**
 * What a Text Animator's mask leaves of a card: the 2D painter clips each unit, after its transform, to its resting box on the plate
 * (layerMesh.js drawToken), so the card is cut where its plate x, y leave `box` ({ x0, y0, x1, y1 }, plate px). `m` is the card's
 * row-major matrix over the unit quad. Returns the part left as [u, v, …] in card space (0..1, v down), null when nothing is cut, and
 * [] when nothing is left. A card turned out of the plate is cut where it stands over the box, as the plate shows it.
 */
export function maskedCard(m, box) {
  const at = (u, v) => [m[0] * (u - 0.5) + m[1] * (v - 0.5) + m[3], m[4] * (u - 0.5) + m[5] * (v - 0.5) + m[7]];
  let poly = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const inside = poly.every(([u, v]) => { const [x, y] = at(u, v); return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1; });
  if (inside) return null;
  // Sutherland–Hodgman against the box's four sides, each a linear test in (u, v).
  for (const side of [(p) => p[0] - box.x0, (p) => box.x1 - p[0], (p) => p[1] - box.y0, (p) => box.y1 - p[1]]) {
    const out = [];
    for (let i = 0; i < poly.length; i += 1) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const da = side(at(...a)), db = side(at(...b));
      if (da >= 0) out.push(a);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); }
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly.flat();
}

const mulColumns = (a, b) => {
  // Column-major 4×4.
  const o = new Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
};

/** A camera's frame, column-major: its turn (quaternion [x, y, z, w]) and its place, scaled by `scale` ([x, y, z]) in its own axes. */
const frameOf = (position, quaternion, scale = [1, 1, 1]) => {
  let [x, y, z, w] = quaternion;
  const n = Math.hypot(x, y, z, w) || 1;
  x /= n; y /= n; z /= n; w /= n;
  const [sx, sy, sz] = scale;
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    position[0], position[1], position[2], 1,
  ];
};

/** The inverse of a rigid frame (a turn and a place, no scale), column-major. */
const invertRigid = (m) => {
  const t = [m[12], m[13], m[14]];
  return [
    m[0], m[4], m[8], 0,
    m[1], m[5], m[9], 0,
    m[2], m[6], m[10], 0,
    -(m[0] * t[0] + m[1] * t[1] + m[2] * t[2]), -(m[4] * t[0] + m[5] * t[1] + m[6] * t[2]), -(m[8] * t[0] + m[9] * t[1] + m[10] * t[2]), 1,
  ];
};

/**
 * Where flat letters stand when the world films from a camera of its own (`scene.camera`): the editor's camera, which films the flat
 * layer, carried onto the world's, so every letter lands where the flat layer draws it. Column-major, world units.
 *
 * `editor`: { position (world units), quaternion, fov } of the editor's camera; `film`: the world's camera as it films, with `reach`, how
 * far the Scene's own camera stands from what it looks at (`scene.camera.at` to `target`, metres); `rest`: how far the editor's camera
 * stands from the composition when nothing moves it, in world units. The editor's frame is scaled about its camera by `reach / rest`: the
 * composition's plane (a layer at Z 0) lands on the plane the Scene's camera looks at, and a layer's Z moves it by the same share. The
 * Camera layer steers the Scene's camera by that same share (world3dScene.js worldSteer, WorldRenderer.applyTime), so a letter stays put in
 * the Scene while the Camera layer moves, as a model does. A scale about the camera leaves the picture as it was; only the depth the letters
 * stand at follows the Scene's units, whatever the composition's size (a 4096 px frame stood them 8 m off, behind a set 1.5 m deep).
 * The field of view's difference is taken up across the frame (`k`). An orthographic world camera (`film.ortho`) keeps the editor's depth.
 */
export function flatLettersViewMatrix(editor, film, rest) {
  const half = (fov) => Math.tan((fov * Math.PI) / 360);
  const k = half(film.fov) / half(editor.fov ?? 28);
  const s = !film.ortho && film.reach > 0 && rest > 0 ? film.reach / rest : 1;
  return mulColumns(frameOf(film.position, film.quaternion, [k * s, k * s, s]), invertRigid(frameOf(editor.position, editor.quaternion)));
}

// Glyph ids: one per shared glyph mesh of the 3D pass (text3dGlyphs.js), so the world keeps one copy of it however many letters use it.
const glyphIds = new WeakMap();
let nextGlyph = 0;

/** The world's id for one of the 3D pass's glyph meshes, and the arrays the world builds its own copy from. */
export function glyphIdOf(geometry) {
  if (!geometry) return null;
  let id = glyphIds.get(geometry);
  if (!id) { nextGlyph += 1; id = `g${nextGlyph}`; glyphIds.set(geometry, id); }
  return id;
}

export function glyphArrays(geometry) {
  const a = geometry.attributes;
  return {
    position: a.position.array, normal: a.normal?.array, uv: a.uv?.array, index: geometry.index?.array || null,
    groups: geometry.groups.map((g) => ({ start: g.start, count: g.count, materialIndex: g.materialIndex })),
  };
}

/*
 * The depth a layer is SORTED by when the compositor orders the stack back-to-front
 * (see orderChannelsForComposite below).
 *
 * It used to be the view depth of the layer's mesh centre. That is right while the
 * camera looks straight down the comp, and wrong the moment it tilts: every flat
 * layer then lies on one tilted plane, and the view depth of a point on that plane
 * depends on where the point is, so coplanar layers stop tying and re-sort by where
 * their centres sit on screen. The 0.1 px channel steps that encode stacking order
 * are swamped by hundreds of px of tilt, so a pill drawn on channel 1 painted over
 * every label, icon and cursor whose centre happened to fall on the far side of it —
 * left-aligned text worst of all, since its plane is centred half a text box away
 * from its glyphs. Yaw the camera 8° and the UI emptied out.
 *
 * Flat layers are parallel planes, and parallel planes have an exact painter's
 * order at any camera angle: by the plane itself, not by a point on it. So a layer
 * whose world normal is ±Z is sorted by where the camera's optical axis crosses its
 * plane. Coplanar layers tie exactly (channel order, and the 0.1 steps, decide
 * again), a nearer panZ still comes forward, and with an untilted camera the value
 * equals the old centre depth, so an unmoved or rolled/panned/dollied camera sorts
 * exactly as before. A layer genuinely rotated in 3D keeps the centre-depth
 * heuristic; so does a camera looking nearly edge-on at the comp.
 */
import * as THREE from 'three';
import { RIG_CHANNEL_KIND } from './rig3d.js';

const _normal = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _world = new THREE.Vector3();

// |normal.z| above this counts as a flat layer (rotateZ / mirror / 2D parenting only).
const FLAT_EPS = 1e-6;
// Below this |camDir.z| the axis runs (nearly) parallel to the comp plane and the
// crossing point is meaningless.
const EDGE_ON = 1e-3;

export function layerSortDepth(mesh, cam) {
  mesh.updateWorldMatrix(true, false);
  cam.updateMatrixWorld();
  const e = mesh.matrixWorld.elements;
  _normal.set(e[8], e[9], e[10]);
  const len = _normal.length();
  if (len > 1e-9 && Math.abs(_normal.z / len) > 1 - FLAT_EPS) {
    cam.getWorldDirection(_camDir);
    if (Math.abs(_camDir.z) > EDGE_ON) {
      cam.getWorldPosition(_camPos);
      return (e[14] - _camPos.z) / _camDir.z;
    }
  }
  return -_world.setFromMatrixPosition(mesh.matrixWorld).applyMatrix4(cam.matrixWorldInverse).z;
}

/*
 * A layer genuinely rotated in 3D (a card turned with rotateX / rotateY) has the same problem one level up: its
 * content — a title, a button, a picture parented to it — lies on the SAME tilted plane, so sorting each of them by
 * its centre's depth sends whatever sits on the far half of the card behind the card itself. Coplanar layers sort
 * as ONE: every layer of a plane takes the depth of the first of them in stacking order, so channel order (and the
 * 0.1 px steps) decides between them again, exactly as for flat layers. Different planes still sort by that depth.
 */
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
// The plane a layer lies on — { nx, ny, nz, off } (unit world normal, n·p) — or null for a flat layer (±Z normal,
// already sorted by its plane above).
export function layerPlane(mesh) {
  if (!mesh) return null;
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements;
  _n.set(e[8], e[9], e[10]);
  const len = _n.length();
  if (!(len > 1e-9)) return null;
  _n.multiplyScalar(1 / len);
  if (Math.abs(_n.z) > 1 - FLAT_EPS) return null;
  _p.setFromMatrixPosition(mesh.matrixWorld);
  return { nx: _n.x, ny: _n.y, nz: _n.z, off: _n.dot(_p) };
}
// entries in stacking order ({ d, plane, i }): coplanar ones take the first one's depth. Two layers share a plane
// when their normals agree (either side) and their offsets differ by no more than the channel steps between them.
export function tieCoplanar(entries) {
  const planes = [];
  for (const e of entries) {
    const q = e.plane; if (!q) continue;
    const hit = planes.find((g) => {
      const dot = g.q.nx * q.nx + g.q.ny * q.ny + g.q.nz * q.nz;
      if (Math.abs(dot) < 1 - 1e-5) return false;
      return Math.abs(q.off - Math.sign(dot) * g.q.off) <= 0.5 + 0.1 * Math.abs(e.i - g.i) * Math.abs(q.nz) + 1e-6;
    });
    if (hit) e.d = hit.d; else planes.push({ q, d: e.d, i: e.i });
  }
  return entries;
}

/*
 * A card turned in 3D against the planes around it. Depth alone cannot order them: a card standing on a flat layer
 * (a page, a floor) is entirely on the camera's side of that floor, so the floor must draw first — but the card's
 * CENTRE can be farther from the camera than the point where the camera's axis meets the floor, and then the floor
 * painted over the whole card. Text, whose plate is wider than its glyphs, and any card standing further from the
 * camera than its look-at point simply vanished; keying the card's angle made it pop in and out with the camera.
 *
 * The exact painter's rule for two quads is the separating plane: if every corner of B lies on the camera's side of
 * A's plane, B is in front of A; on the far side, behind it. layerQuad gives each layer's four world corners and its
 * plane; orderByPlanes keeps the depth order wherever that test cannot decide (coplanar layers, quads that cross)
 * and lifts every decided pair into place — a stable topological order, so a stack without a turned layer is
 * returned exactly as it came in.
 */
const _q = new THREE.Vector3();
// mesh.userData.quadRect ([x0, y0, x1, y1] in the geometry's units, set by the render) narrows the quad to what
// the layer draws: text's laid-out block on its frame-wide plate, a plate without its shadow pad.
export function layerQuad(mesh) {
  const g = mesh?.geometry;
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  const r = mesh.userData?.quadRect;
  const bb = Array.isArray(r) ? { min: { x: r[0], y: r[1] }, max: { x: r[2], y: r[3] } } : g.boundingBox;
  if (!bb || !(bb.max.x > bb.min.x) || !(bb.max.y > bb.min.y)) return null;
  mesh.updateWorldMatrix(true, false);
  const e = mesh.matrixWorld.elements;
  _n.set(e[8], e[9], e[10]);
  const len = _n.length();
  if (!(len > 1e-9)) return null;
  _n.multiplyScalar(1 / len);
  const c = new Float64Array(12);
  [[bb.min.x, bb.min.y], [bb.max.x, bb.min.y], [bb.max.x, bb.max.y], [bb.min.x, bb.max.y]].forEach(([x, y], k) => {
    _q.set(x, y, 0).applyMatrix4(mesh.matrixWorld);
    c[k * 3] = _q.x; c[k * 3 + 1] = _q.y; c[k * 3 + 2] = _q.z;
  });
  _p.setFromMatrixPosition(mesh.matrixWorld);
  return { c, nx: _n.x, ny: _n.y, nz: _n.z, off: _n.dot(_p), flat: Math.abs(_n.z) > 1 - FLAT_EPS };
}

// Where `b`'s corners lie against `a`'s plane: 1 all on the eye's side, -1 all on the far side, 0 across or on it.
function cornersSide(a, b, eye, eps) {
  const eyeSide = a.nx * eye.x + a.ny * eye.y + a.nz * eye.z - a.off;
  if (Math.abs(eyeSide) <= eps) return 0;
  const s = Math.sign(eyeSide);
  let near = 0;
  let far = 0;
  for (let k = 0; k < 4; k += 1) {
    const d = (a.nx * b.c[k * 3] + a.ny * b.c[k * 3 + 1] + a.nz * b.c[k * 3 + 2] - a.off) * s;
    if (d > eps) near += 1; else if (d < -eps) far += 1;
  }
  if (near && !far) return 1;
  if (far && !near) return -1;
  return 0;
}

// -1: a draws before b, 1: b draws before a, 0: undecided.
function planeOrder(a, b, eye, eps) {
  const ab = cornersSide(a.quad, b.quad, eye, eps);
  if (ab) return -ab;
  return cornersSide(b.quad, a.quad, eye, eps);
}

// entries in depth order ({ i, quad, plane }), eye = the filming camera's world position. Returns the entries
// reordered so every pair the plane test decides is in painter's order; the rest keep their depth order.
export function orderByPlanes(entries, eye) {
  const n = entries.length;
  if (n < 2 || !eye || !entries.some((e) => e.quad && !e.quad.flat)) return entries;
  const after = Array.from({ length: n }, () => []);
  const indeg = new Array(n).fill(0);
  for (let a = 0; a < n; a += 1) {
    const ea = entries[a];
    if (!ea.quad) continue;
    for (let b = a + 1; b < n; b += 1) {
      const eb = entries[b];
      if (!eb.quad || (ea.quad.flat && eb.quad.flat)) continue;
      // The channel steps (0.1 px a channel) keep layers lying on one plane apart by a hair; they stay undecided.
      const eps = 0.5 + 0.1 * Math.abs(ea.i - eb.i);
      const o = planeOrder(ea, eb, eye, eps);
      if (o < 0) { after[a].push(b); indeg[b] += 1; }
      else if (o > 0) { after[b].push(a); indeg[a] += 1; }
    }
  }
  if (!indeg.some(Boolean)) return entries;
  const out = [];
  const done = new Array(n).fill(false);
  for (let k = 0; k < n; k += 1) {
    // The first ready entry in depth order; a cycle (three cards each overlapping the next) takes the first left.
    let pick = -1;
    for (let j = 0; j < n; j += 1) if (!done[j] && indeg[j] === 0) { pick = j; break; }
    if (pick < 0) pick = done.indexOf(false);
    done[pick] = true;
    out.push(entries[pick]);
    for (const j of after[pick]) indeg[j] -= 1;
  }
  return out;
}

/*
 * 3D models against each other. A model sorts by its bounding box's CENTRE, and a big ground model — a 10 m page,
 * a floor — has its centre wherever the box's middle is, often nearer the camera than an object standing on it. The
 * page then composited AFTER the card floating above it, and anything that blends over what lies behind it (a soft
 * contact shadow on that card) was finished before the card was there to blend over.
 *
 * Two boxes that do not overlap along a world axis have a separating plane across it, and whichever box is on the
 * camera's side of that plane is in front: the page under a floating card, the card under a character standing on
 * it. orderByBoxes lifts every pair that test decides into place and keeps the depth order wherever it cannot
 * (boxes that overlap on every axis, or a camera that sees one box in front along one axis and behind along another).
 * entry.box = { box: [minX, minY, minZ, maxX, maxY, maxZ], eye: [x, y, z] } in the models' shared world (or null):
 * a model's bounds, or a particle layer's posed Solver Box — particle pictures neither test nor write depth, so a
 * particle layer ordered before the page under it was painted out entirely.
 */
// -1: a draws before b, 1: b draws before a, 0: undecided.
// Along an axis, `lo` is below `hi` when they are apart there (eps: interpenetrating by this much still counts — a
// foot sunk into the card it stands on) or when they merely graze: each centre lies outside the other box on its own
// side — a particle Solver Box whose floor sits on the page's keycaps, a model resting a little into the floor.
const below = (lo, hi, k, eps) => lo.box[k + 3] <= hi.box[k] + eps
  || ((lo.box[k] + lo.box[k + 3]) / 2 <= hi.box[k] && (hi.box[k] + hi.box[k + 3]) / 2 >= lo.box[k + 3]);
export function boxOrder(a, b, eps = 2) {
  const eye = a.eye || b.eye;
  if (!eye) return 0;
  let order = 0;
  for (let k = 0; k < 3; k += 1) {
    let s = null;
    let aLow = false;
    if (below(a, b, k, eps)) { s = (a.box[k + 3] + b.box[k]) / 2; aLow = true; }
    else if (below(b, a, k, eps)) s = (b.box[k + 3] + a.box[k]) / 2;
    if (s === null || Math.abs(eye[k] - s) <= eps) continue;
    // The box on the eye's side of the plane is in front, so it draws last.
    const aFront = (eye[k] > s) !== aLow;
    const o = aFront ? 1 : -1;
    if (order && order !== o) return 0;
    order = o;
  }
  return order;
}

// entries in composite order ({ box }). Returns them reordered so every pair of boxes boxOrder decides is in
// painter's order; the rest keep their order — a stack with fewer than two boxes comes back untouched.
export function orderByBoxes(entries) {
  const n = entries.length;
  if (n < 2 || entries.filter((e) => e.box).length < 2) return entries;
  const after = Array.from({ length: n }, () => []);
  const indeg = new Array(n).fill(0);
  for (let a = 0; a < n; a += 1) {
    if (!entries[a].box) continue;
    for (let b = a + 1; b < n; b += 1) {
      if (!entries[b].box) continue;
      const o = boxOrder(entries[a].box, entries[b].box);
      if (o < 0) { after[a].push(b); indeg[b] += 1; }
      else if (o > 0) { after[b].push(a); indeg[a] += 1; }
    }
  }
  if (!indeg.some(Boolean)) return entries;
  const out = [];
  const done = new Array(n).fill(false);
  for (let k = 0; k < n; k += 1) {
    let pick = -1;
    for (let j = 0; j < n; j += 1) if (!done[j] && indeg[j] === 0) { pick = j; break; }
    if (pick < 0) pick = done.indexOf(false);
    done[pick] = true;
    out.push(entries[pick]);
    for (const j of after[pick]) indeg[j] -= 1;
  }
  return out;
}

// Compositing order.
//
// Channel order is a TIMELINE concern; what occludes what is decided by depth. Visual
// layers are therefore composited back-to-front by their view-space distance, so a
// layer with a nearer panZ really does come forward past a layer on a higher channel.
//
// Adjustment layers and clip masks are the deliberate exception: they are defined as
// "everything BELOW me in the stack", so they act as barriers. Everything beneath one
// is flushed into the accumulation buffer before it runs, which keeps its meaning
// exactly as it is today. The consequence — two layers separated by an adjustment
// cannot sort against each other — is the direct price of that exception, and it
// matches how an adjustment layer behaves as a compositing boundary elsewhere.
//
// Ties keep channel order, and every layer defaults to panZ 0, so a project with no
// depth authored sorts precisely as it always has.
// The Rig channel is the one exception to the exception. It is pinned near the TOP of
// the stack (directly under the camera) because a set and its lens read as one block
// in the timeline — but a cyclorama is the BACKDROP, so it must composite first. Depth
// sorting would normally get that right on its own, since the cyclorama is the farthest
// thing in the frame; an adjustment layer or clip mask anywhere below it is a sort
// barrier, and the rig would then land on top of everything under that barrier and
// paint the comp out. Hoisting it here keeps its timeline position independent of what
// it draws behind.
// planeOf (optional): a channel → the plane its layer lies on (layerPlane) — layers sharing a tilted plane (a card
// rotated in 3D and what lies on it) sort as one, keeping their channel order (compositeSortDepth.js).
// quadOf + eye (optional): a channel → its layer's quad (layerQuad; null for a model / particle / grid plate, whose
// quad says nothing about where it draws) and the posed camera's world position — a card turned in 3D then lands
// on the right side of every plane it does not cross (orderByPlanes).
// boxOf (optional): a channel → its 3D model's world box and eye (null for anything else) — a model on the
// camera's side of another model's box draws after it (orderByBoxes).
export function orderChannelsForComposite(channels, adjById, depthOf, planeOf, quadOf = null, eye = null, boxOf = null) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const entries = run.map((channel, i) => ({ channel, i, d: depthOf(channel), plane: planeOf ? planeOf(channel) : null }));
      if (planeOf) tieCoplanar(entries);
      // Farthest first: later draws land on top.
      entries.sort((a, b) => (b.d - a.d) || (a.i - b.i));
      if (quadOf && eye && entries.some((e) => e.plane)) for (const e of entries) e.quad = quadOf(e.channel);
      let ordered = quadOf && eye ? orderByPlanes(entries, eye) : entries;
      if (boxOf) {
        for (const e of ordered) e.box = boxOf(e.channel);
        ordered = orderByBoxes(ordered);
      }
      run = ordered.map((e) => e.channel);
    }
    for (const c of run) out.push(c);
    run = [];
  };
  // …except under camera-locked layers at the very BOTTOM of the stack (a full-frame
  // background plate). A locked layer composites flat, in stacking order, without
  // depth (adjustmentComposite.js isLockedFlat), so a backdrop drawn after the rig
  // would paint over its cyclorama; under the rig it stays behind everything, as its
  // place in the stack says.
  const leading = new Set();
  for (const channel of channels) {
    if (channel.kind === RIG_CHANNEL_KIND || channel.visible === false) continue;
    if (!channel.cameraLocked || adjById.has(channel.id)) break;
    leading.add(channel);
    out.push(channel);
  }
  for (const channel of channels) {
    if (channel.kind === RIG_CHANNEL_KIND) out.push(channel);
  }
  for (const channel of channels) {
    if (channel.kind === RIG_CHANNEL_KIND || leading.has(channel)) continue;
    // A camera-LOCKED channel is a sort barrier for the same reason an adjustment
    // layer is, and this one is not a nicety — it is a correctness bug without it.
    //
    // cameraForChannel films a locked channel with the NEUTRAL camera and every
    // other channel with the POSED one. Their depths are therefore measured from
    // two different cameras, so sorting them against each other compares
    // distances that do not live in the same space. The moment the posed camera
    // dollies back (camDolly < 0) every layer that follows it sorts BEHIND a
    // locked layer that never moved — and a locked full-frame plate is opaque, so
    // everything else in the comp vanishes mid-shot. Exactly what a tracked
    // camera does: reproduce a shot that dollies, and the overlays disappear when
    // its dolly crosses zero.
    //
    // Treating it as a barrier gives After Effects' rule: a 2D layer breaks the
    // run of 3D layers and composites in STACKING order, while the 3D layers on
    // either side still sort among themselves.
    if (adjById.has(channel.id) || channel.cameraLocked) { flush(); out.push(channel); }
    else run.push(channel);
  }
  flush();
  return out;
}

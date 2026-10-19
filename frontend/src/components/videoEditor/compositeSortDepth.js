/*
 * The depth a layer is SORTED by when the compositor orders the stack back-to-front
 * (see orderChannelsForComposite in Player.jsx).
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

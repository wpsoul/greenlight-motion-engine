/*
 * Procedural 3D shapes for model layers (Scene Rig ▸ Objects) — the Flipbook's
 * blocking set, built in code instead of loaded from a file.
 *
 * They go through model3dLayer's ordinary asset cache: the asset URL is
 * `model-primitive:<kind>` (Text adds `?t=<text>`), so every URL-keyed path — the
 * render page's warm-up, asset state, triangle count — works unchanged. The scene
 * built here is the shared asset; each layer clones it and gets its own copies of
 * the materials marked `userData.tint`, so its colour is per layer.
 *
 * Sizes are in arbitrary units like any imported model — the layer's Fit setting
 * normalises them — but the PROPORTIONS between shapes match the Flipbook, so a
 * human beside a car beside a cube reads as a scene at default fit.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MODEL_PRIMITIVE_URL_PREFIX, PRIMITIVE_DEFAULT_TEXT } from './model3dPresets';

const tint = (color = '#d9d9d9', extra = {}) => {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...extra });
  m.userData.tint = true;
  return m;
};
const fixed = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0, ...extra });

function mesh(geometry, material, y = 0) {
  const m = new THREE.Mesh(geometry, material);
  m.position.y = y;
  return m;
}

function human() {
  const g = new THREE.Group();
  const m = tint('#d9d9d9', { roughness: 0.65 });
  const cap = (r, l) => new THREE.CapsuleGeometry(r, l, 6, 16);
  g.add(mesh(cap(0.105, 0.24), m, 0.62));
  g.add(mesh(new THREE.SphereGeometry(0.082, 32, 20), m, 0.88));
  for (const s of [-1, 1]) {
    const leg = mesh(cap(0.048, 0.34), m, 0.22); leg.position.x = s * 0.058; g.add(leg);
    const arm = mesh(cap(0.038, 0.28), m, 0.6); arm.position.x = s * 0.15; arm.rotation.z = s * 0.14; g.add(arm);
  }
  return g;
}

function car() {
  const g = new THREE.Group();
  const body = tint('#d9d9d9', { roughness: 0.3, metalness: 0.35 });
  const glass = fixed('#2a3038', { roughness: 0.15, metalness: 0.2 });
  const tyre = fixed('#1d1e22', { roughness: 0.8 });
  g.add(mesh(new RoundedBoxGeometry(0.64, 0.13, 0.29, 3, 0.04), body, 0.115));
  const cab = mesh(new RoundedBoxGeometry(0.34, 0.12, 0.25, 3, 0.04), glass, 0.225); cab.position.x = -0.03; g.add(cab);
  const wheel = new THREE.CylinderGeometry(0.062, 0.062, 0.045, 28).rotateX(Math.PI / 2);
  for (const [x, z] of [[-0.2, -0.135], [0.2, -0.135], [-0.2, 0.135], [0.2, 0.135]]) {
    const w = mesh(wheel, tyre, 0.062); w.position.x = x; w.position.z = z; g.add(w);
  }
  return g;
}

const BUILDERS = {
  cube: () => mesh(new RoundedBoxGeometry(0.3, 0.3, 0.3, 3, 0.014), tint()),
  sphere: () => mesh(new THREE.SphereGeometry(0.17, 48, 32), tint('#d9d9d9', { roughness: 0.4 })),
  // A standing card — the stand-in for a poster, a screen, a sign.
  card: () => mesh(new RoundedBoxGeometry(0.5, 0.34, 0.012, 2, 0.005), tint('#d9d9d9', { roughness: 0.7 })),
  torus: () => mesh(new THREE.TorusGeometry(0.13, 0.05, 24, 72), tint('#d9d9d9', { roughness: 0.35 })),
  cone: () => mesh(new THREE.ConeGeometry(0.15, 0.34, 48), tint()),
  cylinder: () => mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.32, 48), tint()),
  human,
  car,
};

// ── Text ────────────────────────────────────────────────────────────────────
// The font is ~60 kB of JSON and two modules; fetched the first time a Text shape is
// actually built, never with the editor.
let fontState = null; // { status, font, promise }
export function loadPrimitiveFont() {
  if (fontState) return fontState.promise;
  fontState = { status: 'loading', font: null, kit: null, promise: null };
  fontState.promise = Promise.all([
    import('three/examples/jsm/loaders/FontLoader.js'),
    import('three/examples/jsm/geometries/TextGeometry.js'),
    import('three/examples/fonts/helvetiker_bold.typeface.json?url'),
  ]).then(([{ FontLoader }, { TextGeometry }, { default: url }]) => new Promise((resolve, reject) => {
    new FontLoader().load(url, (font) => {
      fontState.status = 'ready';
      fontState.font = font;
      fontState.kit = { TextGeometry };
      resolve(fontState);
    }, undefined, reject);
  })).catch((err) => {
    fontState.status = 'error';
    throw err;
  });
  return fontState.promise;
}

function text(content) {
  const { font, kit } = fontState;
  const geo = new kit.TextGeometry(content || PRIMITIVE_DEFAULT_TEXT, {
    font, size: 0.15, depth: 0.04, curveSegments: 6,
    bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.004, bevelSegments: 2,
  });
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(-(bb.max.x + bb.min.x) / 2, -bb.min.y, -(bb.max.z + bb.min.z) / 2);
  return mesh(geo, tint('#d9d9d9', { roughness: 0.4 }));
}

/** `model-primitive:text?t=Hello` → { kind: 'text', text: 'Hello' }. */
export function parsePrimitiveUrl(url) {
  const rest = String(url || '').slice(MODEL_PRIMITIVE_URL_PREFIX.length);
  const [kind, query = ''] = rest.split('?');
  const t = new URLSearchParams(query).get('t');
  return { kind, text: t == null ? PRIMITIVE_DEFAULT_TEXT : t };
}

/**
 * The shape's scene, or null while Text waits for its font (call loadPrimitiveFont
 * and retry). Built standing on y = 0, centred on x/z, like an authored asset.
 */
export function buildPrimitiveScene(url) {
  const { kind, text: content } = parsePrimitiveUrl(url);
  let root;
  if (kind === 'text') {
    if (fontState?.status !== 'ready') return null;
    root = text(content);
  } else {
    root = (BUILDERS[kind] || BUILDERS.cube)();
  }
  const scene = new THREE.Group();
  scene.add(root);
  scene.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
  const box = new THREE.Box3().setFromObject(scene);
  if (!box.isEmpty()) {
    const c = box.getCenter(new THREE.Vector3());
    root.position.x -= c.x;
    root.position.z -= c.z;
    root.position.y -= box.min.y;
  }
  return scene;
}

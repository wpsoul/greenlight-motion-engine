// glTF KHR_gaussian_splatting & KHR_gaussian_splatting_compression_spz_2 loader plugin for Three's GLTFLoader.
// Decodes splat buffers into raw splat objects pushed to `outSplats`, placing ONLY a JSON-safe
// `userData.gltfSplatIndex` integer on the placeholder THREE.Group so SkeletonUtils.clone / Object3D.copy
// (which round-trips userData via JSON.stringify) never strips TypedArrays.
// The splat reader (readSplat.js) is imported the first time a file holds a splat: a loader that only registers this carries none of it.

import * as THREE from 'three';

export const GLTF_SPLAT_EXT = 'KHR_gaussian_splatting';
const SPZ_EXTS = [
  'KHR_gaussian_splatting_compression_spz_2',
  'KHR_gaussian_splatting_compression_spz',
  'KHR_spz_gaussian_splats_compression',
];
const FLOAT = 5126;

function findSpzExtension(primDef) {
  const top = primDef?.extensions || {};
  const khr = top[GLTF_SPLAT_EXT]?.extensions || {};
  for (const name of SPZ_EXTS) {
    if (khr[name]?.bufferView !== undefined) return khr[name];
    if (top[name]?.bufferView !== undefined) return top[name];
  }
  return null;
}

export function isGltfSplatPrimitive(primDef) {
  if (!primDef) return false;
  if (primDef.extensions?.[GLTF_SPLAT_EXT]) return true;
  if (findSpzExtension(primDef)) return true;
  const attrs = primDef.attributes || {};
  return Boolean(
    attrs['KHR_gaussian_splatting:ROTATION']
    || attrs['KHR_gaussian_splatting:SCALE']
    || attrs._ROTATION
    || attrs._SCALE
  );
}

function getAttr(attrs, khrName, legacyName) {
  return attrs[khrName] ?? (legacyName ? attrs[legacyName] : undefined);
}

function shAttrKey(attrs, deg, k) {
  const full = `KHR_gaussian_splatting:SH_DEGREE_${deg}_COEF_${k}`;
  if (attrs[full] !== undefined) return full;
  const short = `SH_DEGREE_${deg}_COEF_${k}`;
  if (attrs[short] !== undefined) return short;
  const legacy = `_${k + (deg === 1 ? 0 : deg === 2 ? 3 : 8)}`;
  if (attrs[legacy] !== undefined) return legacy;
  return null;
}

function linearToDisplay(v) {
  return v <= 0 ? 0 : Math.pow(v, 1 / 2.2);
}

/** Whether any of `count` values (sampled evenly, about 1024 of them) passes `test` on any of `itemSize` components. */
function anySampled(acc, count, itemSize, test) {
  const step = Math.max(1, Math.floor(count / 1024));
  const get = [(i) => acc.getX(i), (i) => acc.getY(i), (i) => acc.getZ(i)].slice(0, itemSize);
  for (let i = 0; i < count; i += step) for (const g of get) if (test(g(i))) return true;
  return false;
}

// The extension's `colorSpace` names the space of the colours its harmonics make (SH times 0.28209 plus 0.5, and the view's terms):
// "srgb_rec709_display" is display sRGB, as every splat here is drawn; "lin_rec709_display" is linear display light, made sRGB on load
// (readSplat.js linearColorsToSrgb) so the two draw the same picture.
const linearSpace = (primDef) => primDef?.extensions?.[GLTF_SPLAT_EXT]?.colorSpace === 'lin_rec709_display';

async function decodeRawGltfSplatPrimitive(parser, primDef) {
  const { splatSink, linearColorsToSrgb, SH_C0, SH_COEFF_COUNTS } = await import('./readSplat.js');
  const attrs = primDef.attributes || {};
  const posIdx = attrs.POSITION;
  if (posIdx === undefined) throw new Error('KHR_gaussian_splatting primitive missing POSITION attribute.');

  const loadAcc = async (idx) => (idx !== undefined ? parser.getDependency('accessor', idx) : null);

  const posAcc = await loadAcc(posIdx);
  const rotAcc = await loadAcc(getAttr(attrs, 'KHR_gaussian_splatting:ROTATION', '_ROTATION'));
  const scaleAcc = await loadAcc(getAttr(attrs, 'KHR_gaussian_splatting:SCALE', '_SCALE'));
  const opAcc = await loadAcc(getAttr(attrs, 'KHR_gaussian_splatting:OPACITY', '_OPACITY'));
  const sh0Acc = await loadAcc(getAttr(attrs, 'KHR_gaussian_splatting:SH_DEGREE_0_COEF_0', '_SH_0'));
  const colAcc = !sh0Acc ? await loadAcc(attrs.COLOR_0) : null;

  const restCoeffs = [];
  let shDegree = 0;
  for (const [deg, count] of [[1, 3], [2, 5], [3, 7]]) {
    const keys = [];
    for (let k = 0; k < count; k += 1) keys.push(shAttrKey(attrs, deg, k));
    if (keys.every(Boolean)) {
      shDegree = deg;
      for (const k of keys) restCoeffs.push(await loadAcc(attrs[k]));
    } else {
      break;
    }
  }

  const count = posAcc.count;
  // glTF coordinates are already right-handed Y-up -> flip = +1 (upright: false)
  const sink = splatSink(count, 1, shDegree);

  // KHR_gaussian_splatting:OPACITY is "a normalized linear value between 0.0 (transparent) and 1.0 (opaque)", used as it is. Values out
  // of that range are invalid there and are read as the training's logits; the underscore attributes of the drafts before the extension
  // were the training .ply's own, logits.
  let opacityIsLogit = false;
  if (opAcc && !opAcc.normalized && attrs['KHR_gaussian_splatting:OPACITY'] === undefined) {
    opacityIsLogit = true;
  } else if (opAcc && !opAcc.normalized) {
    opacityIsLogit = anySampled(opAcc, count, 1, (v) => v < 0 || v > 1);
  }
  // KHR_gaussian_splatting:SCALE is linear ("Scale values are linear and MUST NOT be negative", the ratified text). The text first merged
  // (January 2026) had it in log space, exp(scale), so a file written to that one holds negative values and is read as log. The underscore
  // `_SCALE` of the drafts before the extension is the training .ply's log scale.
  const scaleIsLog = !!scaleAcc && (attrs['KHR_gaussian_splatting:SCALE'] === undefined
    || anySampled(scaleAcc, count, 3, (v) => v < 0));

  const nRest = SH_COEFF_COUNTS[shDegree];
  const shTmp = shDegree ? new Float32Array(nRest * 3) : null;

  for (let i = 0; i < count; i += 1) {
    const px = posAcc.getX(i);
    const py = posAcc.getY(i);
    const pz = posAcc.getZ(i);

    let alpha = 1;
    if (opAcc) {
      const rawA = opAcc.getX(i);
      alpha = opacityIsLogit ? (1 / (1 + Math.exp(-rawA))) : Math.min(1, Math.max(0, rawA));
    } else if (colAcc && colAcc.itemSize >= 4) {
      alpha = Math.min(1, Math.max(0, colAcc.getW(i)));
    }

    let r = 0.5, g = 0.5, b = 0.5;
    if (sh0Acc) {
      r = 0.5 + SH_C0 * sh0Acc.getX(i);
      g = 0.5 + SH_C0 * sh0Acc.getY(i);
      b = 0.5 + SH_C0 * sh0Acc.getZ(i);
      if (!shDegree) { r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b); }
    } else if (colAcc) {
      r = linearToDisplay(colAcc.getX(i));
      g = linearToDisplay(colAcc.getY(i));
      b = linearToDisplay(colAcc.getZ(i));
    }

    let sx = 0.01, sy = 0.01, sz = 0.01;
    if (scaleAcc) {
      sx = scaleAcc.getX(i); sy = scaleAcc.getY(i); sz = scaleAcc.getZ(i);
      if (scaleIsLog) { sx = Math.exp(sx); sy = Math.exp(sy); sz = Math.exp(sz); }
    }

    let qx = 0, qy = 0, qz = 0, qw = 1;
    if (rotAcc) {
      // glTF attributes store quaternions as [x, y, z, w]
      qx = rotAcc.getX(i);
      qy = rotAcc.getY(i);
      qz = rotAcc.getZ(i);
      qw = rotAcc.getW(i);
    }

    sink.add(i, px, py, pz, alpha, r, g, b, sx, sy, sz, qw, qx, qy, qz);

    if (shDegree) {
      for (let k = 0; k < nRest; k += 1) {
        const acc = restCoeffs[k];
        shTmp[k * 3] = acc.getX(i);
        shTmp[k * 3 + 1] = acc.getY(i);
        shTmp[k * 3 + 2] = acc.getZ(i);
      }
      sink.addSh(i, shTmp);
    }
  }

  // COLOR_0 (the fallback with no harmonics) is linear by glTF's own rule, whatever the colour space, and was encoded above
  return sh0Acc && linearSpace(primDef) ? linearColorsToSrgb(sink.result()) : sink.result();
}

export async function decodeGltfSplatPrimitive(parser, primDef) {
  const spzExt = findSpzExtension(primDef);
  if (spzExt) {
    const { gunzip, readSplat, linearColorsToSrgb } = await import('./readSplat.js');
    const ab = await parser.getDependency('bufferView', spzExt.bufferView);
    const unzipped = await gunzip(new Uint8Array(ab));
    // KHR_gaussian_splatting SPZ is in glTF Y-up coordinates
    const splat = readSplat(unzipped, { upright: false });
    return linearSpace(primDef) ? linearColorsToSrgb(splat) : splat;
  }
  return decodeRawGltfSplatPrimitive(parser, primDef);
}

/** The box of a splat primitive's centres, without decoding it: POSITION's own min / max (glTF requires them), else its positions alone. */
export async function gltfSplatBox(parser, primDef) {
  const posIdx = primDef.attributes?.POSITION;
  const def = posIdx !== undefined ? parser.json.accessors?.[posIdx] : null;
  if (def && def.componentType === FLOAT && !def.normalized && def.min?.length >= 3 && def.max?.length >= 3) {
    return { min: def.min.slice(0, 3).map(Number), max: def.max.slice(0, 3).map(Number) };
  }
  const spzExt = findSpzExtension(primDef);
  if (spzExt) {
    const { gunzip, readSplatBox } = await import('./readSplat.js');
    return readSplatBox(await gunzip(new Uint8Array(await parser.getDependency('bufferView', spzExt.bufferView))), { upright: false });
  }
  if (posIdx === undefined) throw new Error('KHR_gaussian_splatting primitive missing POSITION attribute.');
  const pos = await parser.getDependency('accessor', posIdx);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i += 1) {
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    for (let k = 0; k < 3; k += 1) { if (p[k] < min[k]) min[k] = p[k]; if (p[k] > max[k]) max[k] = p[k]; }
  }
  return { min, max };
}

/**
 * Registers a GLTFLoader plugin that decodes `KHR_gaussian_splatting` & SPZ primitives.
 * Decoded splat datasets are appended to `outSplats`, while the returned `THREE.Group`
 * carries only `{ gltfSplatIndex }` in `userData` (so Object3D.copy/clone stays intact).
 * If `proxyBox` is true (e.g. model3dLayer sizing), an invisible bounding BoxGeometry mesh
 * is attached as child so bounding/selection helpers work automatically.
 * `boxOnly` (with `proxyBox`): the splats are not decoded and nothing is pushed, only each one's box is read (gltfSplatBox), for a
 * loader that sizes splats and never draws them (the editor's model layers: the world loads the file again with its own loader).
 */
export function registerGltfSplatPlugin(loader, outSplats = [], { proxyBox = false, boxOnly = false } = {}) {
  loader.register((parser) => ({
    name: GLTF_SPLAT_EXT,
    loadMesh(meshIndex) {
      const json = parser.json;
      const meshDef = json.meshes?.[meshIndex];
      const primitives = meshDef?.primitives || [];
      if (!primitives.some(isGltfSplatPrimitive)) return null;

      return (async () => {
        const makeHolder = (data, name) => {
          const g = new THREE.Group();
          if (boxOnly) {
            g.name = name || meshDef.name || 'gltf-splat';
          } else {
            const idx = outSplats.length;
            outSplats.push(data);
            g.name = name || meshDef.name || `gltf-splat-${idx}`;
            g.userData = { gltfSplatIndex: idx };
          }
          if ((proxyBox || boxOnly) && data?.box) {
            const size = new THREE.Vector3(...data.box.max).sub(new THREE.Vector3(...data.box.min));
            const box = new THREE.Mesh(
              new THREE.BoxGeometry(Math.max(1e-4, size.x), Math.max(1e-4, size.y), Math.max(1e-4, size.z)),
              new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }),
            );
            box.position.fromArray(data.box.min).addScaledVector(size, 0.5);
            box.userData.gltfSplatProxy = true;
            g.add(box);
          }
          return g;
        };

        const decoded = await Promise.all(primitives.map(async (prim) => {
          if (!isGltfSplatPrimitive(prim)) return null;
          return boxOnly ? { box: await gltfSplatBox(parser, prim) } : decodeGltfSplatPrimitive(parser, prim);
        }));

        if (decoded.length === 1 && decoded[0]) {
          return makeHolder(decoded[0], meshDef.name);
        }
        const root = new THREE.Group();
        root.name = meshDef.name || `gltf-splat-group-${meshIndex}`;
        for (let p = 0; p < decoded.length; p += 1) {
          if (decoded[p]) root.add(makeHolder(decoded[p], `${root.name}_p${p}`));
        }
        return root;
      })();
    },
  }));
}

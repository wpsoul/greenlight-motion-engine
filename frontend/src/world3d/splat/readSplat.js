// A Gaussian splat .ply: each point is a soft 3D blob with a position, a colour, an opacity, three sizes and a rotation. This turns
// the file's raw fields (Kerbl et al. 2023's training output) into what a renderer wants: linear-ish colours, real opacities and a
// covariance per splat. Plain arrays, so it needs no GPU and runs in node.

const SH_C0 = 0.28209479177387814;   // the first spherical harmonic, which is how the file stores colour
const TYPES = { float: 4, float32: 4, double: 8, float64: 8, uchar: 1, uint8: 1, char: 1, int8: 1, short: 2, int16: 2, ushort: 2, uint16: 2, int: 4, int32: 4, uint: 4, uint32: 4 };

export function parsePlyHeader(bytes) {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 16384)));
  const end = text.indexOf('end_header');
  if (!text.startsWith('ply') || end < 0) throw new Error('This is not a .ply file.');
  const lines = text.slice(0, end).split(/\r?\n/);
  const format = lines.find((l) => l.startsWith('format'))?.split(/\s+/)[1];
  if (format !== 'binary_little_endian') throw new Error(`This .ply is ${format}. Splats come as binary_little_endian.`);
  const newline = text.indexOf('\n', end);
  // A compressed file holds a table of chunks before its points, so each element knows where it starts.
  const elements = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'element') elements.push({ name: parts[1], count: Number(parts[2]), stride: 0, properties: [] });
    else if (parts[0] === 'property' && elements.length) {
      const size = TYPES[parts[1]];
      if (!size) throw new Error(`Unknown .ply type ${parts[1]}.`);
      const element = elements[elements.length - 1];
      element.properties.push({ name: parts[2], type: parts[1], offset: element.stride });
      element.stride += size;
    }
  }
  let start = newline + 1;
  for (const element of elements) { element.start = start; start += element.count * element.stride; }
  const vertex = elements.find((e) => e.name === 'vertex');
  if (!vertex) throw new Error('This .ply has no vertex element.');
  return { count: vertex.count, stride: vertex.stride, properties: vertex.properties, dataStart: vertex.start, elements };
}

/** Is this .ply a splat cloud, or an ordinary mesh or point cloud? */
export function isSplatPly(header) {
  const names = new Set(header.properties.map((p) => p.name));
  return ['f_dc_0', 'opacity', 'scale_0', 'rot_0'].every((n) => names.has(n));
}

export const isCompressedPly = (header) => header.elements.some((e) => e.name === 'chunk') && header.properties.some((p) => p.name === 'packed_position');

/** Fills the arrays a renderer wants, one splat at a time, whichever file it came from: opacity and colour as seen, sizes as lengths. */
function splatSink(count, flip) {
  const center = new Float32Array(count * 4);    // x, y, z, opacity
  const color = new Float32Array(count * 4);     // r, g, b, largest radius
  const cov = new Float32Array(count * 8);       // xx, xy, xz, yy, then yz, zz, unused, unused
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const add = (i, px, py, pz, opacity, r, g, b, sx, sy, sz, w, qx, qy, qz) => {
    const x = px, y = flip * py, z = flip * pz;
    center[i * 4] = x; center[i * 4 + 1] = y; center[i * 4 + 2] = z;
    center[i * 4 + 3] = opacity;
    if (x < box.min[0]) box.min[0] = x; if (y < box.min[1]) box.min[1] = y; if (z < box.min[2]) box.min[2] = z;
    if (x > box.max[0]) box.max[0] = x; if (y > box.max[1]) box.max[1] = y; if (z > box.max[2]) box.max[2] = z;
    color[i * 4] = r; color[i * 4 + 1] = g; color[i * 4 + 2] = b;
    color[i * 4 + 3] = Math.max(sx, sy, sz);
    const l = Math.hypot(w, qx, qy, qz) || 1;
    const qw = w / l, ax = qx / l, ay = qy / l, az = qz / l;
    // The rotation as a matrix, then Σ = R S² Rᵀ.
    const r00 = 1 - 2 * (ay * ay + az * az), r01 = 2 * (ax * ay - qw * az), r02 = 2 * (ax * az + qw * ay);
    const r10 = 2 * (ax * ay + qw * az), r11 = 1 - 2 * (ax * ax + az * az), r12 = 2 * (ay * az - qw * ax);
    const r20 = 2 * (ax * az - qw * ay), r21 = 2 * (ay * az + qw * ax), r22 = 1 - 2 * (ax * ax + ay * ay);
    const a2 = sx * sx, b2 = sy * sy, c2 = sz * sz;
    cov[i * 8] = r00 * r00 * a2 + r01 * r01 * b2 + r02 * r02 * c2;
    cov[i * 8 + 1] = flip * (r00 * r10 * a2 + r01 * r11 * b2 + r02 * r12 * c2);
    cov[i * 8 + 2] = flip * (r00 * r20 * a2 + r01 * r21 * b2 + r02 * r22 * c2);
    cov[i * 8 + 3] = r10 * r10 * a2 + r11 * r11 * b2 + r12 * r12 * c2;
    cov[i * 8 + 4] = r10 * r20 * a2 + r11 * r21 * b2 + r12 * r22 * c2;
    cov[i * 8 + 5] = r20 * r20 * a2 + r21 * r21 * b2 + r22 * r22 * c2;
  };
  return { add, result: () => ({ count, center, color, cov, box }) };
}

function readPlainPly(bytes, header, sink) {
  const { count, stride, dataStart, properties } = header;
  if (dataStart + count * stride > bytes.length) throw new Error('This .ply is cut short.');
  // Every field is a float in the files training writes, so the whole body can be one array, a good deal faster than a DataView.
  const f32 = stride % 4 === 0 && properties.every((p) => p.type === 'float' || p.type === 'float32');
  const at = Object.fromEntries(properties.map((p) => [p.name, f32 ? p.offset / 4 : p.offset]));
  const body = f32 ? new Float32Array(bytes.slice(dataStart, dataStart + count * stride).buffer) : null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart);
  const step = f32 ? stride / 4 : stride;
  const read = f32 ? (o) => body[o] : (o) => view.getFloat32(o, true);
  const [ax, ay, az, aOpacity] = ['x', 'y', 'z', 'opacity'].map((n) => at[n]);
  const [ar, ag, ab] = ['f_dc_0', 'f_dc_1', 'f_dc_2'].map((n) => at[n]);
  const [as0, as1, as2] = ['scale_0', 'scale_1', 'scale_2'].map((n) => at[n]);
  const [aq0, aq1, aq2, aq3] = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map((n) => at[n]);
  for (let i = 0; i < count; i += 1) {
    const o = i * step;
    sink.add(
      i, read(o + ax), read(o + ay), read(o + az), 1 / (1 + Math.exp(-read(o + aOpacity))),
      Math.max(0, 0.5 + SH_C0 * read(o + ar)), Math.max(0, 0.5 + SH_C0 * read(o + ag)), Math.max(0, 0.5 + SH_C0 * read(o + ab)),
      Math.exp(read(o + as0)), Math.exp(read(o + as1)), Math.exp(read(o + as2)),
      read(o + aq0), read(o + aq1), read(o + aq2), read(o + aq3),
    );
  }
}

// PlayCanvas's compressed .ply: 256 splats to a chunk, each packed into 16 bytes against its chunk's bounds.
const CHUNK_SIZE = 256;
const lerp = (a, b, t) => a + (b - a) * t;
const unit = (v, bits) => (v & ((1 << bits) - 1)) / ((1 << bits) - 1);

function readCompressedPly(bytes, header, sink) {
  const chunks = header.elements.find((e) => e.name === 'chunk');
  const { count, stride, dataStart, properties } = header;
  if (dataStart + count * stride > bytes.length) throw new Error('This .ply is cut short.');
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const field = Object.fromEntries(chunks.properties.map((p) => [p.name, p.offset]));
  const offset = Object.fromEntries(properties.map((p) => [p.name, p.offset]));
  const hasColorRange = 'min_r' in field;
  const bound = (c, name, fallback) => (name in field ? view.getFloat32(chunks.start + c * chunks.stride + field[name], true) : fallback);
  let chunk = -1;
  let box = [];
  for (let i = 0; i < count; i += 1) {
    const c = Math.floor(i / CHUNK_SIZE);
    if (c >= chunks.count) throw new Error('This .ply is cut short.');
    if (c !== chunk) {
      chunk = c;
      box = ['min_x', 'max_x', 'min_y', 'max_y', 'min_z', 'max_z', 'min_scale_x', 'max_scale_x', 'min_scale_y', 'max_scale_y', 'min_scale_z', 'max_scale_z'].map((n) => bound(c, n, 0));
      if (hasColorRange) box.push(...['min_r', 'max_r', 'min_g', 'max_g', 'min_b', 'max_b'].map((n) => bound(c, n, 0)));
    }
    const o = dataStart + i * stride;
    const position = view.getUint32(o + offset.packed_position, true);
    const rotation = view.getUint32(o + offset.packed_rotation, true);
    const scale = view.getUint32(o + offset.packed_scale, true);
    const packed = view.getUint32(o + offset.packed_color, true);
    const t = (v) => [unit(v >>> 21, 11), unit(v >>> 11, 10), unit(v, 11)];
    const [px, py, pz] = t(position), [ts, tu, tv] = t(scale);
    const r = unit(packed >>> 24, 8), g = unit(packed >>> 16, 8), b = unit(packed >>> 8, 8), a = unit(packed, 8);
    const q = [unit(rotation >>> 20, 10), unit(rotation >>> 10, 10), unit(rotation, 10)].map((v) => (v - 0.5) * Math.SQRT2);
    const rest = Math.sqrt(Math.max(0, 1 - q[0] * q[0] - q[1] * q[1] - q[2] * q[2]));
    q.splice(rotation >>> 30, 0, rest);
    sink.add(
      i, lerp(box[0], box[1], px), lerp(box[2], box[3], py), lerp(box[4], box[5], pz), a,
      Math.max(0, hasColorRange ? lerp(box[12], box[13], r) : r), Math.max(0, hasColorRange ? lerp(box[14], box[15], g) : g), Math.max(0, hasColorRange ? lerp(box[16], box[17], b) : b),
      Math.exp(lerp(box[6], box[7], ts)), Math.exp(lerp(box[8], box[9], tu)), Math.exp(lerp(box[10], box[11], tv)),
      q[0], q[1], q[2], q[3],
    );
  }
}

// The .splat of the first web viewers: 32 bytes each, with no header. Three floats of position, three of size, then bytes of colour, opacity and rotation.
const SPLAT_BYTES = 32;

function readDotSplat(bytes, sink, count) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  for (let i = 0; i < count; i += 1) {
    const o = i * SPLAT_BYTES;
    const rotation = (k) => (bytes[o + 28 + k] - 128) / 128;
    sink.add(
      i, view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true), bytes[o + 27] / 255,
      bytes[o + 24] / 255, bytes[o + 25] / 255, bytes[o + 26] / 255,
      view.getFloat32(o + 12, true), view.getFloat32(o + 16, true), view.getFloat32(o + 20, true),
      rotation(0), rotation(1), rotation(2), rotation(3),
    );
  }
}

// Niantic's .spz, once gunzipped: a 16-byte header, then every field of every splat in one run each. Rotation is three bytes up to version 2 and a
// packed four from version 3.
const SPZ_MAGIC = 0x5053474e;
const SPZ_COLOR_SCALE = 0.15;

export function spzCount(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  if (bytes.length < 16 || view.getUint32(0, true) !== SPZ_MAGIC) throw new Error('This is not a .spz file.');
  return view.getUint32(8, true);
}

function readSpz(bytes, sink) {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const version = view.getUint32(4, true), count = spzCount(bytes), bits = bytes[13];
  if (version < 2 || version > 3) throw new Error(`This .spz is version ${version}, and this app reads 2 and 3.`);
  const rotationBytes = version >= 3 ? 4 : 3;
  const positions = 16, alphas = positions + count * 9, colors = alphas + count, scales = colors + count * 3, rotations = scales + count * 3;
  if (rotations + count * rotationBytes > bytes.length) throw new Error('This .spz is cut short.');
  const fixed = 1 / (1 << bits);
  const coordinate = (o) => (((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8) >> 8) * fixed;
  const shade = (b) => Math.max(0, 0.5 + SH_C0 * ((b / 255 - 0.5) / SPZ_COLOR_SCALE));
  const size = (b) => Math.exp(b / 16 - 10);
  const q = [0, 0, 0, 0];
  for (let i = 0; i < count; i += 1) {
    const r = rotations + i * rotationBytes;
    if (version >= 3) {
      let packed = view.getUint32(r, true);
      const largest = packed >>> 30;
      let rest = 1;
      for (let k = 3; k >= 0; k -= 1) {
        if (k === largest) continue;
        const value = (Math.SQRT1_2 * (packed & 511)) / 511;
        q[k] = (packed >>> 9) & 1 ? -value : value;
        rest -= value * value;
        packed >>>= 10;
      }
      q[largest] = Math.sqrt(Math.max(0, rest));
    } else {
      q[0] = bytes[r] / 127.5 - 1; q[1] = bytes[r + 1] / 127.5 - 1; q[2] = bytes[r + 2] / 127.5 - 1;
      q[3] = Math.sqrt(Math.max(0, 1 - q[0] * q[0] - q[1] * q[1] - q[2] * q[2]));
    }
    const p = positions + i * 9, c = colors + i * 3, s = scales + i * 3;
    sink.add(
      i, coordinate(p), coordinate(p + 3), coordinate(p + 6), bytes[alphas + i] / 255,
      shade(bytes[c]), shade(bytes[c + 1]), shade(bytes[c + 2]),
      size(bytes[s]), size(bytes[s + 1]), size(bytes[s + 2]),
      q[3], q[0], q[1], q[2],
    );
  }
}

const GZIP = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Unpacks what a .spz is wrapped in. Apart so `readSplat` can stay synchronous; `DecompressionStream` is in browsers and node alike. */
export async function gunzip(input) {
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (!GZIP(bytes)) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads a splat file of any kind, told apart by what is inside it: a .ply and a .spz say what they are, and a .splat is what is left.
 *  Training works in a camera's axes, with y down, so `upright` (the default) stands a capture the right way up once, here. Every format keeps those
 *  axes in the files people have, .spz included, whatever its documentation says. */
export function readSplat(input, { upright = true } = {}) {
  // A plain view: node's Buffer has a slice that does not copy.
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  if (GZIP(bytes)) throw new Error('This file is still gzipped: pass it through gunzip first.');
  const text = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  const flip = upright ? -1 : 1;
  if (bytes.length >= 16 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === SPZ_MAGIC) {
    const sink = splatSink(spzCount(bytes), flip);
    readSpz(bytes, sink);
    return sink.result();
  }
  if (text === 'ply') {
    const header = parsePlyHeader(bytes);
    const compressed = isCompressedPly(header);
    if (!compressed && !isSplatPly(header)) throw new Error('This .ply has no splat fields (f_dc, opacity, scale, rot).');
    const sink = splatSink(header.count, flip);
    (compressed ? readCompressedPly : readPlainPly)(bytes, header, sink);
    return sink.result();
  }
  if (bytes.length === 0 || bytes.length % SPLAT_BYTES) throw new Error('This is not a splat file: a .ply, .splat or .spz.');
  const count = bytes.length / SPLAT_BYTES;
  const sink = splatSink(count, flip);
  readDotSplat(bytes, sink, count);
  return sink.result();
}

/** Back to front along `axis` (from the camera, in the splats' own space): a 16-bit counting sort, fast enough to run each view. */
export function sortSplats(center, count, eye, axis, out = new Uint32Array(count), keys = new Uint16Array(count), bins = new Uint32Array(65537), depth = new Float32Array(count)) {
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const d = (center[o] - eye[0]) * axis[0] + (center[o + 1] - eye[1]) * axis[1] + (center[o + 2] - eye[2]) * axis[2];
    depth[i] = d;
    if (d < low) low = d;
    if (d > high) high = d;
  }
  const scale = high > low ? 65535 / (high - low) : 0;
  bins.fill(0);
  // Farthest first, so the bin index runs the other way.
  for (let i = 0; i < count; i += 1) { const k = 65535 - Math.floor((depth[i] - low) * scale); keys[i] = k; bins[k + 1] += 1; }
  for (let b = 1; b < 65537; b += 1) bins[b] += bins[b - 1];
  for (let i = 0; i < count; i += 1) { out[bins[keys[i]]] = i; bins[keys[i]] += 1; }
  return out;
}

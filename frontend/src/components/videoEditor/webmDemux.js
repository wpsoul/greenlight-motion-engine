// A small WebM / Matroska demuxer for the export's frame-exact WebM decode
// (webmClipDecoder.js): the first video track's frames, keyframe flags, timestamps
// and — for VP8/VP9 with alpha — each frame's alpha stream (BlockAdditional,
// BlockAddID 1). Pure: no DOM, no WebCodecs, so node --test can run it.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  ContentEncodings: 0x6d80,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Colour: 0x55b0,
  MatrixCoefficients: 0x55b1,
  Range: 0x55b9,
  TransferCharacteristics: 0x55ba,
  Primaries: 0x55bb,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockAdditions: 0x75a1,
  BlockMore: 0xa6,
  BlockAddID: 0xee,
  BlockAdditional: 0xa5,
  ReferenceBlock: 0xfb,
  BlockDuration: 0x9b,
};
// Children a Cluster may hold. An unknown-size Cluster ends at the first element
// that is not one of them (the next Cluster, Cues, Tags...).
const CLUSTER_CHILDREN = new Set([0xe7, 0xa3, 0xa0, 0xa7, 0xab, 0x5854, 0xaf, 0xec, 0xbf]);

export class WebmUnsupported extends Error {}

function readVint(view, pos, keepMarker) {
  if (pos >= view.byteLength) return null;
  const first = view.getUint8(pos);
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len += 1; mask >>= 1; }
  if (len > 8 || pos + len > view.byteLength) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i += 1) {
    const b = view.getUint8(pos + i);
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readUint(view, pos, size) {
  let v = 0;
  for (let i = 0; i < size; i += 1) v = v * 256 + view.getUint8(pos + i);
  return v;
}

function readString(view, pos, size) {
  let s = '';
  for (let i = 0; i < size; i += 1) {
    const c = view.getUint8(pos + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// Calls fn(id, dataStart, size, unknownSize) for each child in [start, end).
// Returns the position where iteration stopped.
function eachChild(view, start, end, fn) {
  let pos = start;
  while (pos < end) {
    const id = readVint(view, pos, true);
    if (!id) break;
    const size = readVint(view, pos + id.len, false);
    if (!size) break;
    const dataStart = pos + id.len + size.len;
    const stop = fn(id.value, dataStart, size.unknown ? Infinity : size.value, size.unknown, pos);
    if (stop === true) return pos;
    if (size.unknown) return typeof stop === 'number' ? stop : end;
    pos = dataStart + size.value;
  }
  return pos;
}

// Block header: track number (vint), signed 16-bit timecode, flags.
function parseBlock(view, pos, size) {
  const track = readVint(view, pos, false);
  if (!track) throw new WebmUnsupported('bad block');
  const p = pos + track.len;
  const rel = view.getInt16(p);
  const flags = view.getUint8(p + 2);
  if (flags & 0x06) throw new WebmUnsupported('laced blocks');
  const dataStart = p + 3;
  return { track: track.value, rel, flags, dataStart, dataEnd: pos + size };
}

/**
 * Demux a WebM/Matroska file's first video track.
 * Returns { codecId, width, height, colour, color: Sample[], alpha: Sample[] | null } where
 * colour = the track's Colour element ({ matrix, range, transfer, primaries } code
 * points) or null, and
 * Sample = { ts (µs), dur (µs), key, data: Uint8Array } in decode order (VP8/VP9 have
 * no reordering, so that is also presentation order). Throws WebmUnsupported for
 * files this reader does not handle.
 */
export function demuxWebm(buffer) {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer,
    buffer instanceof ArrayBuffer ? 0 : buffer.byteOffset,
    buffer instanceof ArrayBuffer ? buffer.byteLength : buffer.byteLength);
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const end = view.byteLength;
  let timecodeScale = 1e6; // ns per timecode tick
  let track = null;
  const blocks = []; // { ts (ticks), key, data, alpha, durTicks }

  const parseTrackEntry = (start, stop) => {
    const t = { number: 0, type: 0, codecId: '', width: 0, height: 0, defaultDurationNs: 0, encoded: false, colour: null };
    eachChild(view, start, stop, (id, p, size) => {
      if (id === ID.TrackNumber) t.number = readUint(view, p, size);
      else if (id === ID.TrackType) t.type = readUint(view, p, size);
      else if (id === ID.CodecID) t.codecId = readString(view, p, size);
      else if (id === ID.DefaultDuration) t.defaultDurationNs = readUint(view, p, size);
      else if (id === ID.ContentEncodings) t.encoded = true;
      else if (id === ID.Video) {
        eachChild(view, p, p + size, (vid, vp, vsize) => {
          if (vid === ID.PixelWidth) t.width = readUint(view, vp, vsize);
          else if (vid === ID.PixelHeight) t.height = readUint(view, vp, vsize);
          else if (vid === ID.Colour) {
            // ISO/IEC 23091-4 code points, as stored; 2 = unspecified.
            const c = {};
            eachChild(view, vp, vp + vsize, (cid, cp, csize) => {
              if (cid === ID.MatrixCoefficients) c.matrix = readUint(view, cp, csize);
              else if (cid === ID.Range) c.range = readUint(view, cp, csize);
              else if (cid === ID.TransferCharacteristics) c.transfer = readUint(view, cp, csize);
              else if (cid === ID.Primaries) c.primaries = readUint(view, cp, csize);
            });
            t.colour = c;
          }
        });
      }
    });
    if (t.type === 1 && !track) track = t;
  };

  const addBlock = (clusterTc, blk, key, alpha, durTicks) => {
    if (!track || blk.track !== track.number) return;
    blocks.push({
      ts: clusterTc + blk.rel,
      key,
      data: bytes.subarray(blk.dataStart, blk.dataEnd),
      alpha,
      durTicks,
    });
  };

  const parseCluster = (start, stop, unknown) => {
    let clusterTc = 0;
    return eachChild(view, start, stop, (id, p, size) => {
      if (unknown && !CLUSTER_CHILDREN.has(id)) return true; // the next top-level element
      if (id === ID.Timecode) clusterTc = readUint(view, p, size);
      else if (id === ID.SimpleBlock) {
        const blk = parseBlock(view, p, size);
        addBlock(clusterTc, blk, !!(blk.flags & 0x80), null, 0);
      } else if (id === ID.BlockGroup) {
        let blk = null;
        let hasRef = false;
        let alpha = null;
        let durTicks = 0;
        eachChild(view, p, p + size, (gid, gp, gsize) => {
          if (gid === ID.Block) blk = parseBlock(view, gp, gsize);
          else if (gid === ID.ReferenceBlock) hasRef = true;
          else if (gid === ID.BlockDuration) durTicks = readUint(view, gp, gsize);
          else if (gid === ID.BlockAdditions) {
            eachChild(view, gp, gp + gsize, (aid, ap, asize) => {
              if (aid !== ID.BlockMore) return;
              let addId = 1;
              let data = null;
              eachChild(view, ap, ap + asize, (mid, mp, msize) => {
                if (mid === ID.BlockAddID) addId = readUint(view, mp, msize);
                else if (mid === ID.BlockAdditional) data = bytes.subarray(mp, mp + msize);
              });
              if (addId === 1 && data) alpha = data;
            });
          }
        });
        if (blk) addBlock(clusterTc, blk, !hasRef, alpha, durTicks);
      }
      return undefined;
    });
  };

  const parseSegment = (start, stop) => {
    eachChild(view, start, stop, (id, p, size, unknown) => {
      if (id === ID.Info) {
        eachChild(view, p, p + size, (iid, ip, isize) => {
          if (iid === ID.TimecodeScale) timecodeScale = readUint(view, ip, isize) || 1e6;
        });
      } else if (id === ID.Tracks) {
        eachChild(view, p, p + size, (tid, tp, tsize) => {
          if (tid === ID.TrackEntry) parseTrackEntry(tp, tp + tsize);
        });
      } else if (id === ID.Cluster) {
        // An unknown-size cluster runs until the next top-level element; carry on
        // from there.
        if (unknown) return parseCluster(p, end, true);
        parseCluster(p, p + size, false);
      }
      return undefined;
    });
  };

  eachChild(view, 0, end, (id, p, size, unknown) => {
    if (id === ID.Segment) parseSegment(p, unknown ? end : Math.min(end, p + size));
    return undefined;
  });

  if (!track) throw new WebmUnsupported('no video track');
  if (track.encoded) throw new WebmUnsupported('content encodings');
  if (track.codecId !== 'V_VP9' && track.codecId !== 'V_VP8') throw new WebmUnsupported(`codec ${track.codecId}`);
  if (!blocks.length) throw new WebmUnsupported('no frames');

  const toUs = (ticks) => Math.round((ticks * timecodeScale) / 1000);
  const defaultDurUs = track.defaultDurationNs ? Math.round(track.defaultDurationNs / 1000) : 0;
  const color = [];
  const alphaSamples = [];
  let alphaCount = 0;
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const ts = toUs(b.ts);
    const next = blocks[i + 1];
    const dur = b.durTicks ? toUs(b.durTicks)
      : next ? Math.max(0, toUs(next.ts) - ts)
        : (defaultDurUs || (color.length ? color[color.length - 1].dur : 0));
    color.push({ ts, dur, key: b.key, data: b.data });
    if (b.alpha) alphaCount += 1;
    alphaSamples.push(b.alpha ? { ts, dur, key: b.key, data: b.alpha } : null);
  }
  // Every frame carries its alpha, or none does. A partial alpha stream cannot be
  // decoded on its own (its frames reference each other).
  if (alphaCount && alphaCount !== blocks.length) throw new WebmUnsupported('alpha on some frames only');
  return {
    codecId: track.codecId,
    width: track.width,
    height: track.height,
    colour: track.colour,
    color,
    alpha: alphaCount ? alphaSamples : null,
  };
}

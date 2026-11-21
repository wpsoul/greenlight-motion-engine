/*
 * (chatfarm2) Join the parts of a render made on several machines into ONE MP4, by a remux — nothing is decoded or encoded again.
 *
 *   joinParts([{ bytes, start }, …], { sound }) → { bytes: Uint8Array, report }
 *
 * Each part is an MP4 of the film's frames [start, next part's start) made by the same engine (renderVideo({ range, audio: false })):
 * H.264 only, starting on a key frame. Their samples are read with mp4box (the engine's own demuxer) and written, shifted by the part's
 * start, into one file with mp4-muxer (the engine's own muxer). `sound`: ONE audio-only MP4 of the whole film (renderAudio()) put under
 * the joined frames with its own priming edit list — the parts carry no sound, because each part's own AAC would bring its own 2112
 * samples of encoder priming to the seam (measured: the sound misaligned after the join; one sound = bit-identical to a one-piece render).
 * Parts must share the H.264 settings (avcC) of the first: a remux cannot switch them mid-file, so a differing part is refused (the
 * report says which) rather than written into a file that would not play.
 */
import * as MP4Box from 'mp4box';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { insertAudioEditList } from '../components/videoEditor/mp4AudioPriming.js';

const same = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

/** One MP4's tracks: { video, audio } each { codec, timescale, width?, height?, sampleRate?, channels?, desc, samples, skip }. */
export function readMp4(buffer) {
  return new Promise((resolve, reject) => {
    const file = MP4Box.createFile();
    const out = { video: null, audio: null };
    const byId = {};
    file.onError = (e) => reject(new Error(`not an MP4 the join can read: ${e}`));
    file.onReady = (info) => {
      for (const t of info.tracks) {
        const trak = file.getTrackById(t.id);
        const entry = trak.mdia.minf.stbl.stsd.entries[0];
        let desc = null;
        if (entry.avcC) {
          const ds = new MP4Box.DataStream(undefined, 0, MP4Box.DataStream.BIG_ENDIAN);
          entry.avcC.write(ds);
          desc = new Uint8Array(ds.buffer, 8);   // the box's payload, without its 8-byte header
        } else if (entry.dOps) {
          // Opus (a browser without an AAC encoder): its pre-skip travels as an OpusHead, which mp4-muxer reads back into the dOps box
          const h = new Uint8Array(19), dv = new DataView(h.buffer);
          h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0);
          h[8] = 1; h[9] = entry.dOps.OutputChannelCount || t.audio?.channel_count || 2;
          dv.setUint16(10, entry.dOps.PreSkip || 0, true); dv.setUint32(12, entry.dOps.InputSampleRate || 48000, true); dv.setInt16(16, entry.dOps.OutputGain || 0, true);
          desc = h;
        } else if (entry.esds) {
          let d = entry.esds.esd.descs[0];
          while (d && d.tag !== 5) d = d.descs?.[0];
          desc = d ? new Uint8Array(d.data) : null;
        }
        const elst = trak.edts?.elst?.entries?.[0];
        const track = { id: t.id, codec: t.codec, timescale: t.timescale, desc, samples: [], skip: elst && elst.media_time > 0 ? elst.media_time : 0,
          ...(t.video ? { width: t.video.width, height: t.video.height } : {}), ...(t.audio ? { sampleRate: t.audio.sample_rate, channels: t.audio.channel_count } : {}) };
        byId[t.id] = track;
        if (t.video && !out.video) out.video = track;
        else if (t.audio && !out.audio) out.audio = track;
        file.setExtractionOptions(t.id, null, { nbSamples: 1e9 });
      }
      file.start();
    };
    file.onSamples = (id, _user, samples) => { byId[id]?.samples.push(...samples); };
    const buf = buffer instanceof ArrayBuffer ? buffer.slice(0) : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
    resolve(out);
  });
}

/** Contiguous frame ranges for `pods` parts of a film of `frames` frames at `fps`: [{ start, end }] in seconds, on the frame grid. */
export function partRanges(frames, fps, pods) {
  const n = Math.max(1, Math.min(Math.floor(pods) || 1, frames));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = Math.round((frames * i) / n), b = Math.round((frames * (i + 1)) / n);
    if (b > a) out.push({ index: i, from: a, to: b, start: a / fps, end: b / fps, frames: b - a });
  }
  return out;
}

export async function joinParts(parts, { sound = null } = {}) {
  if (!parts?.length) throw new Error('no parts to join');
  const sorted = [...parts].sort((a, b) => a.start - b.start);
  const read = [];
  for (const p of sorted) read.push(await readMp4(p.bytes));
  const v0 = read[0].video;
  if (!v0) throw new Error('part 1 has no video');
  const report = { parts: [], refused: null, sound: null };
  for (let i = 1; i < read.length; i += 1) {
    if (!read[i].video || !same(read[i].video.desc, v0.desc)) {
      report.refused = `part ${i + 1}: its H.264 settings differ from part 1's`;
      return { bytes: null, report };
    }
  }
  const snd = sound ? (await readMp4(sound)).audio : null;
  const muxer = new Muxer({ target: new ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'strict',
    video: { codec: 'avc', width: v0.width, height: v0.height },
    ...(snd ? { audio: { codec: /^opus/i.test(snd.codec) ? 'opus' : 'aac', sampleRate: snd.sampleRate, numberOfChannels: snd.channels } } : {}) });
  const vmeta = { decoderConfig: { codec: v0.codec, codedWidth: v0.width, codedHeight: v0.height, description: v0.desc } };
  let expected = 0;
  read.forEach((r, k) => {
    const off = Math.round(sorted[k].start * 1e6);
    const v = r.video;
    const pr = { start: sorted[k].start, frames: 0, firstUs: null, endUs: null };
    v.samples.forEach((s, i) => {
      if (i === 0 && !s.is_sync) throw new Error(`part ${k + 1} does not start on a key frame`);
      const ts = off + Math.round((s.cts / v.timescale) * 1e6);
      const du = Math.round((s.duration / v.timescale) * 1e6);
      muxer.addVideoChunkRaw(new Uint8Array(s.data), s.is_sync ? 'key' : 'delta', ts, du, k === 0 && i === 0 ? vmeta : undefined, Math.round(((s.cts - s.dts) / v.timescale) * 1e6));
      if (pr.firstUs === null) pr.firstUs = ts;
      pr.endUs = ts + du;
      pr.frames += 1;
    });
    // a gap or an overlap between parts would be a missing or a doubled frame: say so (the frames are written as they are)
    pr.gapUs = pr.firstUs - expected;
    expected = pr.endUs;
    report.parts.push(pr);
  });
  if (snd) {
    snd.samples.forEach((s, i) => {
      muxer.addAudioChunkRaw(new Uint8Array(s.data), 'key', Math.round((s.cts / snd.timescale) * 1e6), Math.round((s.duration / snd.timescale) * 1e6),
        i === 0 ? { decoderConfig: { codec: /^opus/i.test(snd.codec) ? 'opus' : snd.codec, sampleRate: snd.sampleRate, numberOfChannels: snd.channels, ...(snd.desc ? { description: snd.desc } : {}) } } : undefined);
    });
    report.sound = { frames: snd.samples.length, priming: snd.skip };
  }
  muxer.finalize();
  let bytes = new Uint8Array(muxer.target.buffer);
  if (snd?.skip > 0) bytes = insertAudioEditList(bytes, snd.skip);
  report.frames = report.parts.reduce((n, p) => n + p.frames, 0);
  report.bytes = bytes.length;
  return { bytes, report };
}

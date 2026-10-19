/**
 * GPU reset detection for the headless render page.
 *
 * When the GPU side of Chrome resets under load, every WebGL context in the page
 * is lost at once and the hardware VideoEncoder's input dies with them — but the
 * encoder never calls its error callback, it just stops draining. The exporter
 * could only report that as a 30-second "encoder stall" and blamed resolution and
 * 4K sources. Seen 2026-09-27 on a 170-layer motion-blurred timeline, seven times,
 * always at the same scene: 3–5 contexts lost in the same millisecond, then the
 * stall error exactly 30 s later. The WebGPU device survived every time.
 *
 * `webglcontextlost` does not bubble and fires on canvases that are usually not in
 * the document, so no single listener can see it. getContext is wrapped once,
 * before the Player mounts, and each WebGL canvas gets its own listener. It only
 * observes — no preventDefault — so every owner's loss/restore handling is as it
 * was.
 */

let lostCount = 0;
let installed = false;

export function installGpuResetWatch() {
  if (installed) return;
  installed = true;
  const watched = new WeakSet();
  const onLost = () => { lostCount += 1; };
  const hook = (Ctor) => {
    const proto = Ctor?.prototype;
    const original = proto?.getContext;
    if (typeof original !== 'function') return;
    proto.getContext = function getContextWatched(type, ...rest) {
      const ctx = original.call(this, type, ...rest);
      if (ctx && typeof type === 'string' && type.includes('webgl') && !watched.has(this)) {
        watched.add(this);
        this.addEventListener('webglcontextlost', onLost);
      }
      return ctx;
    };
  };
  if (typeof HTMLCanvasElement !== 'undefined') hook(HTMLCanvasElement);
  if (typeof OffscreenCanvas !== 'undefined') hook(OffscreenCanvas);
}

/** WebGPU raises no canvas event; the Player reports a lost device here. */
export function noteGpuReset() {
  lostCount += 1;
}

export function gpuResetCount() {
  return lostCount;
}

// What makes one layer expensive to draw. A rough rank, not a cost model: it only
// has to put the layer that took the GPU down near the top of a short list.
function layerLoad(item, clip) {
  const notes = [];
  let score = 0;
  const type = clip?.mediaType;
  if (type === 'grid' || type === 'sequence') {
    const n = Array.isArray(clip.sequence?.channels) ? clip.sequence.channels.length : 0;
    score += 2 + n / 16;
    notes.push(n ? `${type}, ${n} ${type === 'grid' ? 'cells' : 'layers'}` : type);
  } else if (type === 'model3d' || type === 'particles') {
    score += 3;
    notes.push(type === 'model3d' ? '3D model' : 'particles');
  } else if (type === 'motion' || type === 'html') {
    score += 2;
    notes.push(type === 'motion' ? 'motion template' : 'HTML');
  } else if (type === 'video') {
    score += 1;
    notes.push('video');
  }
  const fx = Array.isArray(item?.effects) ? item.effects.filter((e) => e && e.enabled !== false) : [];
  if (fx.length) {
    const custom = fx.some((e) => e.id === 'custom');
    score += fx.length + (custom ? 2 : 0);
    notes.push(`${fx.length} effect${fx.length > 1 ? 's' : ''}${custom ? ' incl. custom shader' : ''}`);
  }
  return { score, notes };
}

/**
 * One sentence on what was on screen when the GPU reset.
 *
 * @param {Array<{item: object, clip: object}>} active  visible layers at that time
 * @param {{label: string, samples: number}|null} motionBlur  set when that frame
 *   rendered as a motion-blur accumulation
 */
export function describeGpuLoad(active, motionBlur = null) {
  const ranked = active
    .filter(({ clip }) => clip && clip.mediaType !== 'audio' && clip.mediaType !== 'camera')
    .map(({ item, clip }) => ({ name: item?.customName || clip.name || clip.mediaType, ...layerLoad(item, clip) }))
    .filter((l) => l.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const parts = [];
  if (ranked.length) {
    parts.push('Heaviest layers here: '
      + ranked.map((l) => `"${l.name}" (${l.notes.join(', ')})`).join(', ') + '.');
  }
  if (motionBlur) {
    parts.push(`Motion blur renders this frame ${motionBlur.samples}× (${motionBlur.label}).`);
  }
  return parts.length ? parts.join(' ') : null;
}

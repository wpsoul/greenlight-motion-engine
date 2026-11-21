// (motion3d) What a Final (path-traced) 3D Scene costs to render, and the cap a host may set on it.
//
// A Final frame is traced to its samples: the cost of a video grows with its length, its samples per pixel, its frame rate and its
// pixels. One number for it: SAMPLE-SECONDS at 1080p and 30 fps = seconds × spp × (fps / 30) × (width × height) / (1920 × 1080) —
// 10 s at 64 spp in a 1080p, 30 fps video is 640. The chat connector caps a Final render at CHAT_FINAL_CAP (owner, 2026-11-14:
// "up to 10 s of video at 64 spp, a warning before anything longer"): over it, a render waits for a confirmation. No cap is the
// default (the desktop app, the npm engine's CLI, a page of one's own); a host sets one with setFinalCap. Pure data: the
// connector and the CLI run it in Node (greenlight-motion/script) on the same project the page renders.
export const CHAT_FINAL_CAP = Object.freeze({ seconds: 10, spp: 64 });
const DEFAULT_SPP = 64;   // rig.render.spp when unset (world3d-schema.json)

let cap = null;
/** { seconds, spp } (a Final render over seconds × spp sample-seconds at 1080p30 waits for a confirmation), or null for none. */
export function setFinalCap(next) {
  cap = next && Number(next.seconds) > 0 && Number(next.spp) > 0 ? { seconds: Number(next.seconds), spp: Number(next.spp) } : null;
  return cap;
}
export const getFinalCap = () => cap;

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const r1 = (v) => Math.round(v * 10) / 10;

/** The Final 3D Scenes of a project and what rendering them costs: { final, layers: [{ id, seconds, spp }], seconds, spp, cost }.
 *  `fps`: the render's frame rate (30 by default). A Draft-only project is { final: false, cost: 0 }. */
export function finalCost(project, { fps = 30 } = {}) {
  const W = num(project?.videoSize?.w, 1920), H = num(project?.videoSize?.h, 1080);
  const layers = [];
  const walk = (channels, clips) => {
    const byId = new Map((clips || []).map((c) => [c?.id, c]));
    for (const ch of channels || []) {
      for (const it of ch?.items || []) {
        if (it?.rig?.renderer !== 'world' || it.rig.render?.mode !== 'final') continue;
        const clip = byId.get(it.clipId);
        const span = Number.isFinite(Number(it.trimEnd)) && Number.isFinite(Number(it.trimStart)) ? Number(it.trimEnd) - Number(it.trimStart) : num(clip?.duration, 0);
        layers.push({ id: String(it.id), seconds: Math.max(0, span), spp: Math.max(1, Math.round(num(it.rig.render.spp, DEFAULT_SPP))) });
      }
    }
    for (const c of clips || []) if (c?.sequence) walk(c.sequence.channels, c.sequence.clips);
  };
  walk(project?.channels, project?.clips);
  if (!layers.length) return { final: false, layers, seconds: 0, spp: 0, cost: 0 };
  const scale = (Math.max(1, num(fps, 30)) / 30) * ((W * H) / (1920 * 1080));
  const cost = layers.reduce((sum, l) => sum + l.seconds * l.spp * scale, 0);
  return { final: true, layers, seconds: r1(Math.max(...layers.map((l) => l.seconds))), spp: Math.max(...layers.map((l) => l.spp)), fps: num(fps, 30), width: W, height: H, cost: Math.round(cost) };
}

/** Whether a render of `project` passes `limit` (default: the cap set here). { over, ratio, cost, budget, text } — `text` says it for
 *  people and agents; null when there is no cap or nothing Final. */
export function checkFinalCap(project, { fps = 30, limit = cap } = {}) {
  if (!limit) return null;
  const c = finalCost(project, { fps });
  if (!c.final) return null;
  const budget = limit.seconds * limit.spp;
  const ratio = c.cost / budget;
  const what = `${c.seconds} s of path-traced (Final) 3D at ${c.spp} samples per pixel, ${c.width}×${c.height}, ${c.fps} fps`;
  return {
    over: ratio > 1 + 1e-9, ratio: Math.round(ratio * 100) / 100, cost: c.cost, budget, layers: c.layers,
    text: ratio > 1 + 1e-9
      ? `${what}: ${Math.round(ratio * 10) / 10}× the limit here (${limit.seconds} s at ${limit.spp} samples, 1080p 30 fps). Final traces every frame on this computer's GPU: seconds a frame, so this takes a long while.`
      : `${what}: within the limit here (${limit.seconds} s at ${limit.spp} samples).`,
  };
}

/*
 * (chatfarm2) How long a render takes here, and on a GPU farm the user owns (e.g. RunPod): the numbers behind the Render pane's
 * "This computer · ≈ N min · busy | RunPod · ≈ N min · ≈ $X". Pure; the page measures, the host (the chat page) knows the farm.
 *
 *   estimateHere({ frames, probeMs, firstMs })   this computer, from a probe: the mean of frames drawn at 10 / 50 / 90 % of the film
 *                                                 (measured: −8 … +13 % against the real render), plus the first frame's extra
 *   planFarm({ frames, gpus, … })                 per GPU type: how many pods (1–10, picked so the job ends near `targetSec`, fewer
 *                                                 when more would not help), the time and the money, and the cap the job stops at
 *
 * Every pod time here is the CHAT PATH's own measured speed (the 2D page with its Scene, Chrome on Xvfb, the picture only), passed in
 * by the host per GPU type as `secPerFrame` at a reference (spp, pixels); it scales linearly with samples and pixels (the trace).
 */
export const FARM_LIMITS = { maxPods: 10, warnSec: 120, targetSec: 240 };

const REF_PIXELS = 1920 * 1080;

/** This computer's time for `frames` frames: { sec, low, high } (the probe's measured spread: −8 … +13 %), or null without a probe. */
export function estimateHere({ frames, probeMs = [], firstMs = 0 } = {}) {
  const ok = probeMs.filter((v) => Number.isFinite(v) && v > 0);
  if (!ok.length || !(frames > 0)) return null;
  const per = ok.reduce((s, v) => s + v, 0) / ok.length / 1000;
  const sec = Math.max(0, firstMs / 1000) + per * frames;
  return { sec, low: sec * 0.92, high: sec * 1.13, secPerFrame: per };
}

/** A pod's seconds per frame for this film: the measured reference speed scaled by samples and pixels (Draft: the reference as is). */
export function podSecPerFrame(gpu, { spp = 64, pixels = REF_PIXELS, mode = 'final' } = {}) {
  const ref = gpu.secPerFrame;   // measured on the chat path at gpu.refSpp, gpu.refPixels (Final), or Draft
  if (mode !== 'final') return gpu.draftSecPerFrame ?? ref;
  const fixed = gpu.fixedSecPerFrame ?? 0;   // the per-frame part that does not trace (composite, readback, encode)
  const trace = Math.max(0, ref - fixed) * (spp / (gpu.refSpp || 32)) * (pixels / (gpu.refPixels || REF_PIXELS));
  return fixed + trace;
}

/**
 * For each GPU type: { gpuId, name, pods, sec, usd, usdHigh, secPerFrame, stock, byPods: [{ pods, sec, usd }] } and the default pick.
 * frames, fps, spp, pixels, mode: the film. startSec: pod create → its first frame on this path (measured); uploadBytes: what the page
 * sends each pod (the project + the user's files); uplinkBps / downlinkBps: the user's line (measured by the page on the first job,
 * else 50 / 100 Mbit/s); targetSec: the wall time the pod count aims at; maxPods: the cap (owner: 1–10); pods: the user's own count.
 */
export function planFarm({ frames, fps = 30, spp = 64, pixels = REF_PIXELS, mode = 'final', gpus = [], startSec = 120, uploadBytes = 0,
  uplinkBps = 50e6 / 8, downlinkBps = 100e6 / 8, mp4BytesPerSec = 0.8e6, targetSec = FARM_LIMITS.targetSec, maxPods = FARM_LIMITS.maxPods,
  pods: asked = null, tailSec = 20 } = {}) {
  const seconds = frames / fps;
  const rows = gpus.filter((g) => g && g.secPerFrame > 0).map((g) => {
    const spf = podSecPerFrame(g, { spp, pixels, mode });
    const at = (n) => {
      const per = Math.ceil(frames / n);
      const upload = uploadBytes / uplinkBps;               // to each pod, one after the other: pod k starts k × upload later
      const download = (seconds * mp4BytesPerSec) / downlinkBps;
      const sec = startSec + upload * n + per * spf + download + 2;   // + the join (measured 155 ms for 60 frames) and the save
      const podSec = startSec + per * spf + tailSec + (upload * (n + 1)) / 2;   // a pod is paid from create to gone
      const usd = (n * podSec * (g.usdPerHr || 0)) / 3600;
      return { pods: n, sec, usd };
    };
    const byPods = Array.from({ length: Math.max(1, Math.min(maxPods, frames)) }, (_, i) => at(i + 1));
    // the fewest pods that end near the target; past the point where one more pod saves under 10 % of the time, stop adding
    let pick = byPods.find((r) => r.sec <= targetSec) || byPods[byPods.length - 1];
    for (let i = 1; i < byPods.length && byPods[i].pods <= pick.pods; i += 1) {
      if (byPods[i - 1].sec - byPods[i].sec < byPods[i - 1].sec * 0.1 && byPods[i - 1].sec <= targetSec * 1.25) { pick = byPods[i - 1]; break; }
    }
    const chosen = asked ? byPods[Math.max(1, Math.min(asked, byPods.length)) - 1] : pick;
    return { gpuId: g.id, name: g.name, stock: g.stock || null, usdPerHr: g.usdPerHr, secPerFrame: spf, pods: chosen.pods, sec: chosen.sec,
      usd: chosen.usd, usdHigh: chosen.usd * 1.3, suggestedPods: pick.pods, byPods };
  });
  const inStock = rows.filter((r) => r.stock !== 'NONE');
  // the default: the cheapest that ends within 1.25 × the fastest in stock
  const fastest = inStock.reduce((m, r) => Math.min(m, r.sec), Infinity);
  const def = inStock.filter((r) => r.sec <= fastest * 1.25).sort((a, b) => a.usd - b.usd)[0] || rows[0] || null;
  return { rows, pick: def ? def.gpuId : null, capUsd: def ? Math.max(0.25, Math.ceil(def.usdHigh * 2 * 20) / 20) : null };
}

/** The money a running job may spend: the plan's high estimate × 2, at least $0.25, in 5-cent steps. */
export const capFor = (usdHigh) => Math.max(0.25, Math.ceil((Number(usdHigh) || 0) * 2 * 20) / 20);

/**
 * What the Render pane shows (owner, 2026-11-18: "предупреждение написать, и если человеку нужен компьютер, то чтобы он использовал
 * ранпод" — the farm's value is a FREE computer, not only speed). Every render that needs ≥ FARM_LIMITS.warnSec here, Draft or Final,
 * shows both cards — this computer's time · busy, and the farm's time and price stated honestly, also when it is slower — unless there is
 * no farm host or the farm has no GPU in stock. Being ≥ 25 % sooner decides only the default pick (and so the button's label).
 * → { long, offer, row, sooner, defaultPick: 'here' | 'pod' }
 */
export function farmChoice({ here = null, plan = null, gpuId = null, hasHost = true } = {}) {
  const long = !!here && here.sec >= FARM_LIMITS.warnSec;
  const rows = plan?.rows || [];
  const stockKnown = rows.some((r) => r.stock);
  const anyStock = !stockKnown || rows.some((r) => r.stock && r.stock !== 'NONE');
  // (0.5.5) a GPU picked before connecting that turns out to be out of stock gives way to the plan's pick (the 0.5.5 live job: picked
  // RTX A5000, none free after connecting, the line said "2 × RTX A5000" while the pods were A40)
  const picked = gpuId ? rows.find((r) => r.gpuId === gpuId && r.stock !== 'NONE') : null;
  const row = plan ? (picked || rows.find((r) => r.gpuId === plan.pick) || rows[0] || null) : null;
  const offer = !!hasHost && long && anyStock;
  const sooner = !!(row && here && row.sec <= here.sec * 0.75);
  return { long, offer, row, sooner, defaultPick: offer && sooner ? 'pod' : 'here' };
}

// (0.5.5) a job's line: while its pods start, the count it starts (not the ones made so far: the live 0.5.4 job read "2 ×" under
// "Starting 3 pods"), with the type they really are once made (a type out of stock gives way to the next); once it renders, the
// job's pods (lost ones left out), by type (a job may mix GPU types)
export function podsLine(job, row, view) {
  const made = (job?.pods || []).filter((p) => p.state !== 'lost');
  const by = made.reduce((m, p) => { m[p.gpu] = (m[p.gpu] || 0) + 1; return m; }, {});
  const types = Object.keys(by);
  const each = () => types.map((t) => `${by[t]} × ${t}`).join(' · ');
  if (view === 'pod' && made.length) return each();
  if (types.length === 1) return `${Math.max(job?.planned || 0, made.length)} × ${types[0]}`;
  if (types.length > 1) return each();
  return `${job?.planned || row?.pods || 1} × ${job?.gpu || row?.name || 'GPU'}`;
}

// (0.5.6) the done receipt's "Pods N ended": the pods the job made, as its 'parts' event says (0.5.5 counted the parts: one more than
// the pods whenever a part was split between two pods, one fewer when a pod took a second part)
export const podsEnded = (e) => (Number(e?.pods) > 0 ? Math.round(Number(e.pods)) : (e?.parts?.length || 0));

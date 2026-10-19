/*
 * The pass pool: scratch render targets for declarative multi-pass effects and the persistent rings
 * (Echo, Motion Trail, TimeShift, Repetile), keyed per slot (PLANS/GREENLIGHT_MOTION_ENGINE_PLAN.md, Stage 9
 * step 3 — moved verbatim out of the Player, `xRef.current` → `engine.x`).
 *
 * Their intermediates can't reuse the compositor's a–f set: in the per-layer branch those are the isolate/matte,
 * the DOF result and the glow pair, all of which have to survive the chain. Allocated on first use, so a project
 * that never adds a multi-pass effect pays nothing. Keyed by slot rather than pooled as a uniform-size array
 * because passes may differ per target: pass.scale (a DOWNSAMPLED target), pass.nearest (a NEAREST-filtered one —
 * the jump-flood passes store packed coordinates) and pass.poolSlot (a ping-pong reused by a long chain).
 *
 * Pooled targets are RELEASED when unused, not held until renderer teardown. Every key is stamped with the
 * frame it was last ensured on; a key untouched for PASS_POOL_GRACE frames is disposed. Persistent rings
 * (Echo, Motion Trail, TimeShift, Repetile) are read back through pool.get() without being re-ensured, so they
 * are judged by their OWNER's `seen` stamp instead, and the owner state is dropped together with its targets
 * (a ring whose plates are gone must not keep a slot map). Per-item bakes (`rig:`, `af:`, `scn:`) are left to
 * their own lifecycles. The user's rule: an effect that is not in use costs nothing — a removed Echo held
 * ~47 MiB at 1080p before this.
 */
import * as THREE from 'three';

export const PASS_POOL_GRACE = 120;
// Idle sweep: the frame counter only advances while frames render, so an effect removed while PAUSED would
// keep its plates until playback resumed. After the last render a timer fires and frees whatever that last
// frame did NOT use, judged by wall-clock age — what the last frame did use stays.
export const PASS_POOL_IDLE_MS = 4000;
const PERSISTENT_BAKE_RE = /^(rig|af|scn):(?!norm:)/;

export function ensurePassTarget(engine, key, w, h, nearest) {
  const renderer = engine.renderer;
  if (!renderer) return null;
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const pool = engine.passPool;
  let target = pool.get(key);
  if (!target) {
    const filter = nearest ? THREE.NearestFilter : THREE.LinearFilter;
    target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: filter,
      magFilter: filter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    pool.set(key, target);
  }
  if (target.width !== width || target.height !== height) target.setSize(width, height);
  engine.passUse.set(key, { frame: engine.passFrame, at: performance.now() });
  return target;
}

export function releasePoolKey(engine, key) {
  const pool = engine.passPool;
  const target = pool.get(key);
  if (target) { target.dispose(); pool.delete(key); }
  engine.passUse.delete(key);
  if (key.startsWith('colorRef:item:')) engine.colorRefStatic.delete(key.slice('colorRef:item:'.length));
}

export function sweepPassPool(engine, idle = false) {
  const frame = engine.passFrame;
  const now = performance.now();
  // Rendering: unused for PASS_POOL_GRACE frames. Idle: not used by the LAST rendered frame and older than
  // PASS_POOL_IDLE_MS on the clock.
  const stale = (seenFrame, seenAt) => {
    if (!Number.isFinite(seenFrame)) return false;
    if (idle) return seenFrame < frame && now - (Number.isFinite(seenAt) ? seenAt : now) > PASS_POOL_IDLE_MS;
    return frame - seenFrame > PASS_POOL_GRACE;
  };
  const live = [];
  for (const [eid, st] of engine.echoState) {
    if (stale(st.seen, st.seenAt)) engine.echoState.delete(eid); else live.push(`echo:hist:${eid}:`);
  }
  for (const [ch, st] of engine.trailState) {
    if (stale(st.seen, st.seenAt)) engine.trailState.delete(ch); else live.push(`trail:hist:${ch}:`, `trail:buf:${ch}:`);
  }
  for (const [eid, st] of engine.timeshiftState) {
    if (stale(st.frame, st.frameAt)) engine.timeshiftState.delete(eid); else live.push(`ts:ring:${eid}`);
  }
  for (const [k, st] of engine.repetileHist) {
    if (stale(st.seen, st.seenAt)) engine.repetileHist.delete(k); else live.push(`rep:hist:${k}:`);
  }
  for (const [key, use] of engine.passUse) {
    if (!stale(use.frame, use.at)) continue;
    if (PERSISTENT_BAKE_RE.test(key)) continue;
    let owned = false;
    for (const prefix of live) if (key.startsWith(prefix)) { owned = true; break; }
    if (owned) continue;
    releasePoolKey(engine, key);
  }
}

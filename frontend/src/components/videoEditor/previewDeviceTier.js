/*
 * The preview pipeline's device tier — one object for every knob that differs
 * between a desktop browser and a tablet or phone reached over the network
 * (PLANS/TABLET_WEB_VIDEO_EDITOR_PERFORMANCE_PLAN.md §1, Part A).
 *
 * WHY ONE OBJECT. The touch-tier changes are scattered across the renderer's
 * context attributes (A4), the render buffer size (A5), the playback loop's fps
 * gate (A6), media preload (A7) and the texture budget (A8). Read as separate
 * `isTouchWeb()` checks they would be five places to forget, five places to
 * test and no way to A/B the tablet against the old behaviour. Here they are one
 * frozen record: one place to read, one place to test, and `?veTier=desktop|touch`
 * on the page URL to force either tier on any device.
 *
 * THE DESKTOP TIER IS TODAY'S CONSTANTS, EXACTLY. `preserveDrawingBuffer: true`,
 * no tier fps cap (the project's preview frame rate still applies — see
 * resolvePreviewFpsCap), a 4 s idle-channel lead, unlimited concurrent loads,
 * `preload = 'auto'` everywhere, the project-sized render buffer and the 512 MB
 * web budget. Electron returns `isTouchWeb() === false` by construction, so the
 * packaged app evaluates to this tier. Every touch-tier branch in the Player is a
 * no-op when the tier says desktop.
 *
 * The paused / pinch-zoom bucket is deliberately NOT a tier knob yet
 * (`pausedBucketDprCap` is 2 on both) — decision D1 in the plan is pending.
 */
import { isTouchWeb } from '../../platform/compact.js';
import { autoBudgetBytes } from './rasterDensity.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * Texture budget for a touch device, from the one RAM signal a browser gives.
 * `navigator.deviceMemory` (Chromium/Android) is the machine's RAM in GB, capped
 * at 8 by the browser; an eighth of it (the discrete-VRAM fraction desktop uses),
 * never above 512 MB. Safari exposes nothing, so an iPad gets a flat 192 MB — the
 * budget only bounds how far text/shape plates MAGNIFY (never below 1×), and the
 * ladder still self-corrects on context loss.
 */
export function touchTextureBudgetBytes(deviceMemoryGb) {
  const gb = Number(deviceMemoryGb);
  if (Number.isFinite(gb) && gb > 0) return Math.min((gb * GIB) / 8, 512 * MIB);
  return 192 * MIB;
}

/**
 * Build a tier record. Pure — takes the device signals as arguments so the two
 * tiers can be unit-tested without a browser (tests/ve-tier/test_budget.mjs).
 */
export function buildPreviewTier(name, { deviceMemoryGb = null } = {}) {
  if (name === 'touch') {
    return Object.freeze({
      name: 'touch',
      touch: true,
      // A5: while playing, never render more pixels than the frame × DPR shows.
      capRenderToViewport: true,
      // A4: tile-based GPUs pay a full framebuffer resolve+reload per frame for
      // preservation; every reader of the drawing buffer reads same-task instead.
      preserveDrawingBuffer: false,
      // A6: 'project' resolves to the project fps at use (resolvePreviewFpsCap).
      fpsCap: 'project',
      preloadPolicy: Object.freeze({
        idleLeadSec: 2,
        maxLoadingBuffers: 4,
        idlePreload: 'metadata',
      }),
      textureBudgetBytes: touchTextureBudgetBytes(deviceMemoryGb),
      pausedBucketDprCap: 2,
    });
  }
  return Object.freeze({
    name: 'desktop',
    touch: false,
    capRenderToViewport: false,
    preserveDrawingBuffer: true,
    fpsCap: null,
    preloadPolicy: Object.freeze({
      idleLeadSec: 4,
      maxLoadingBuffers: Infinity,
      idlePreload: 'auto',
    }),
    // The web build's budget when Electron's RAM report is absent: the same
    // 512 MB `autoBudgetBytes({})` returned before the tier existed.
    textureBudgetBytes: autoBudgetBytes({}),
    pausedBucketDprCap: 2,
  });
}

function tierFromQuery() {
  if (typeof window === 'undefined') return null;
  try {
    const param = new URLSearchParams(window.location.search).get('veTier');
    if (param === 'desktop' || param === 'touch') return param;
  } catch { /* not addressable */ }
  return null;
}

let memo = null;

/**
 * The tier this page runs on. Computed once — the pointer class does not change
 * under a running editor, and the renderer's context attributes cannot follow it
 * anyway. `?veTier=desktop|touch` wins over detection so the tablet can be A/B'd
 * against the old behaviour on the device itself.
 */
export function getPreviewTier() {
  if (memo) return memo;
  const name = tierFromQuery() || (isTouchWeb() ? 'touch' : 'desktop');
  const deviceMemoryGb = typeof navigator !== 'undefined' ? navigator.deviceMemory : null;
  memo = buildPreviewTier(name, { deviceMemoryGb });
  return memo;
}

/*
 * The project's preview frame rate (`previewFps`, PROJECT · PREVIEW): how often
 * playback redraws the preview. A number caps the redraw at that rate; 'project'
 * caps it at the export fps, so the preview shows exactly the frames a render
 * has. 60 by default — rendering every rAF tick on a 120 Hz display drew a 30 fps
 * project four times per frame it will ever export. Renders never read it.
 */
export const PREVIEW_FPS_PROJECT = 'project';
export const PREVIEW_FPS_RATES = Object.freeze([30, 60, 120]);
export const DEFAULT_PREVIEW_FPS = 60;

export function sanitizePreviewFps(value) {
  if (value === PREVIEW_FPS_PROJECT) return PREVIEW_FPS_PROJECT;
  const n = Number(value);
  return PREVIEW_FPS_RATES.includes(n) ? n : DEFAULT_PREVIEW_FPS;
}

/**
 * The fps the playback loop renders at: the project's preview frame rate. The
 * touch tier never goes above the project fps (A6 — a 120 Hz iPad Pro would
 * otherwise do 4× the GPU work of a 30 fps project), so there the lower wins.
 */
export function resolvePreviewFpsCap(tier, projectFps, previewFps = DEFAULT_PREVIEW_FPS) {
  const projectRate = Math.max(1, Number(projectFps) || 30);
  const setting = sanitizePreviewFps(previewFps);
  const wanted = setting === PREVIEW_FPS_PROJECT ? projectRate : setting;
  if (tier.fpsCap === 'project') return Math.min(wanted, projectRate);
  if (Number.isFinite(tier.fpsCap) && tier.fpsCap > 0) return Math.min(wanted, tier.fpsCap);
  return wanted;
}

/**
 * A8 — the adaptive raster budget. Electron reports installed RAM through the
 * preload bridge and keeps today's `autoBudgetBytes` path untouched; a browser
 * has no such report and takes the tier's figure.
 */
export function resolveTextureBudgetBytes({ systemMemory = null, tier }) {
  if (systemMemory) {
    return autoBudgetBytes({
      totalMemoryBytes: systemMemory.totalBytes || 0,
      unified: !!systemMemory.unified,
    });
  }
  return tier.textureBudgetBytes;
}

/**
 * A7 — what a channel buffer is allowed to download ahead of need.
 * Desktop: 'auto' for everything (today). Touch: 'auto' only for the buffer that
 * plays and the same-channel next clip inside NEXT_CLIP_PRELOAD_WINDOW; a buffer
 * staged for an IDLE channel fetches metadata only — it may be seconds away, and
 * on a shared Wi‑Fi link six of them fetching at once is what starves the one
 * that is on screen.
 */
export function preloadForPreviewBuffer(tier, { active = false, idleStaging = false } = {}) {
  if (!tier.touch) return 'auto';
  if (active) return 'auto';
  return idleStaging ? tier.preloadPolicy.idlePreload : 'auto';
}

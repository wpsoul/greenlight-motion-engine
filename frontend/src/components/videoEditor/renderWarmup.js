// Before a still or an export: every clip's media warmed (decoded), fonts ready and the 3D layers
// primed, so the first frames aren't blank. Shared by the headless render page
// (VideoProjectRenderPage.jsx) and the GreenLight Motion Engine (src/motionEngine/), so both
// open on the same frames — moved here verbatim from the render page.
import { flattenClips } from "./sequenceUtils";
import { isVectorMediaUrl, preloadVectorMedia } from "./vectorMedia";
import { preloadImagePlate } from "./imagePlate";
import { preloadVideoPlate } from "./videoPlate";
import { preloadAnimatedImage } from "./animatedImage";
import { getTimelineLayout } from "./speedUtils";
import { RIG_MEDIA_TYPE } from "./rig3d";
import { deriveTextFontLoadRequest } from "./engine/projectDerive";
import { ensureFontsLoaded } from "../../render-shims/FontFamilySelect";
import { loadRecordingCursorTrack } from "./recordingCursor";

export function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

// Where to prime the 3D layers: the render's first frame, and the first frame of
// each model / rig layer that is on screen inside the render. A prime only loads
// what that frame DRAWS, so priming at 0 alone left a set starting later (a rig at
// 0.5 s, or a range render opening inside one) to load during the encode — its
// opening frames came out as the bare background. Nested sequences fall back to
// the first frame.
export function model3dPrimeTimes(channels, clips, from = 0, to = Infinity) {
  const ids = new Set((clips || [])
    .filter((c) => c?.mediaType === "model3d" || c?.mediaType === RIG_MEDIA_TYPE)
    .map((c) => c.id));
  const times = new Set([from]);
  for (const ch of channels || []) {
    if (!ch?.items?.length || ch.visible === false) continue;
    const layout = getTimelineLayout(ch.items, { unsnapped: ch.unsnapped });
    ch.items.forEach((item, i) => {
      const at = layout[i];
      // 3D Text layers draw through the same lazily loaded pass (and its HDR).
      const text3d = item?.text3d?.enabled === true && (clips || []).some((c) => c?.id === item.clipId && c.mediaType === "text");
      if (!at || (!ids.has(item.clipId) && !text3d) || at.endTime <= from || at.startTime >= to) return;
      times.add(Math.max(from, at.startTime));
    });
  }
  return [...times].sort((a, b) => a - b).slice(0, 6);
}

// Warm + decode a single media URL so the export's per-frame seek (which only has
// a ~3s safety timeout) doesn't capture blank/stale opening frames on a cold page.
export function warmMediaUrl(url, mediaType, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!url) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      done();
    };
    try {
      if (mediaType === "image" && isVectorMediaUrl(url)) {
        // A vector layer is not warmed by decoding the file: it draws from its own
        // normalized document (vectorMedia.js), so wait on THAT decode instead.
        preloadVectorMedia(url, timeoutMs).then(finish);
      } else if (mediaType === "image") {
        // The pixels AND the plate: an image smaller than the frame draws at its own
        // size (imagePlate.js), and a plate resolved one frame late would export the
        // opening frames blown up to the composition. Both wait on the same HTTP
        // cache entry, so this is one fetch either way.
        const decoded = new Promise((done2) => {
          const img = new Image();
          img.onload = done2;
          img.onerror = done2;
          img.src = url;
          if (img.decode) img.decode().then(done2).catch(done2);
        });
        // ...and the frames, when the picture moves. A headless render encodes its
        // first frame the moment this gate opens, so a GIF still decoding then would
        // bake its static first frame into the opening seconds and never revisit them.
        Promise.all([
          decoded,
          preloadImagePlate(url, timeoutMs),
          preloadAnimatedImage(url, timeoutMs),
        ]).then(finish);
      } else if (mediaType === "audio") {
        const audio = document.createElement("audio");
        audio.preload = "auto";
        audio.onloadeddata = finish;
        audio.oncanplaythrough = finish;
        audio.onerror = finish;
        audio.src = url;
        audio.load();
      } else {
        // video (and anything else with a moving picture) — and, for a video, its
        // real size: a clip smaller than the frame draws at its own size
        // (videoPlate.js), and a size resolved one frame late would export the
        // opening frames blown up to the composition.
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        const decoded = new Promise((done2) => {
          video.onloadeddata = done2;
          video.onerror = done2;
        });
        video.src = url;
        video.load();
        Promise.all([
          decoded,
          mediaType === "video" ? preloadVideoPlate(url, timeoutMs) : null,
        ]).then(finish);
      }
    } catch {
      finish();
    }
  });
}

// Block until every clip's media is warmed (decoded) and fonts are ready, so the
// first encoded frames aren't blank and text clips use their real font. This is
// the /video-render analog of the mockup page's waitForScene gate.
// `range` = the timeline window about to be rendered ({ start, end }), so the 3D
// layers are primed where that window shows them.
// `getPlayer()` returns the mounted Player (its imperative handle).
export async function waitForMediaReady({ channels, clips, getPlayer, range = null }) {
  await nextPaint();
  await nextPaint();
  const seen = new Set();
  const warmups = [];
  // Include media nested inside sequence (compound) clips, recursively.
  let hasModel = false;
  for (const clip of flattenClips(clips)) {
    if (!clip) continue;
    // A model layer's asset is parsed by model3dLayer, not decoded as media — and a
    // preset's url is a sentinel, not a fetchable file. Warm it through that module
    // instead, or the opening frames of a render come out empty.
    if (clip.mediaType === "model3d") { hasModel = true; continue; }
    // A rig draws through the same lazily-loaded module (and loads an HDR
    // environment on its first frame) even with no model in the set.
    if (clip.mediaType === RIG_MEDIA_TYPE) { hasModel = true; continue; }
    // A cursor-free screen recording draws its cursor from the full-rate track beside it: frame one needs it.
    if (clip.mediaType === "video" && clip.recordingMeta?.cursorInVideo === false && clip.recordingTrackUrl) {
      warmups.push(Promise.race([loadRecordingCursorTrack(clip.recordingTrackUrl), new Promise((resolve) => setTimeout(resolve, 15000))]));
    }
    const url = clip.mediaType === "video" ? (clip.url || clip.proxyUrl) : (clip.proxyUrl || clip.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    warmups.push(warmMediaUrl(url, clip.mediaType));
  }
  // The text layers' web fonts. The Player requests them from an effect AFTER mount,
  // and document.fonts.ready below only covers loads that already started — so a
  // still / the first export frames came out in the fallback face whenever the
  // Google stylesheet had not arrived yet. Same request as the Player's (shared
  // stylesheet cache); when it lands the Player bumps fontLoadVersion → repaint.
  const fontRequest = deriveTextFontLoadRequest({
    channels: channels || [],
    clipsMap: new Map((clips || []).filter(Boolean).map((c) => [c.id, c])),
  });
  if (fontRequest.families.length > 0) {
    warmups.push(Promise.race([
      ensureFontsLoaded(fontRequest.families, {
        weights: fontRequest.weights.length > 0 ? fontRequest.weights : [400, 700],
        size: 72,
        sampleText: "Typography",
      }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]));
  }
  // Fresnel Rim on a picture draws through a pass module loaded on first use;
  // an export must not open on frames that rendered it plain.
  const usesFresnelRim = (channels || []).some((ch) => (ch?.items || [])
    .some((item) => (item?.layerEffects || []).some((e) => e?.id === "fresnelRim" && e.enabled !== false)));
  if (usesFresnelRim) {
    warmups.push(import("./fresnelRimLayer")
      .then((m) => m.preloadFresnelRimFx())
      .catch((err) => console.warn("[render] fresnel rim warm-up failed", err)));
  }
  if (hasModel) {
    warmups.push((async () => {
      try {
        const { preloadModel, preloadScreen, resolveModelUrlFor } = await import("./model3dLayer");
        const seenModels = new Set();
        for (const ch of channels || []) {
          for (const item of ch?.items || []) {
            const clip = (clips || []).find((c) => c.id === item.clipId);
            if (clip?.mediaType !== "model3d") continue;
            const url = resolveModelUrlFor(item, clip);
            if (!url || seenModels.has(url)) continue;
            seenModels.add(url);
            await preloadModel(url);
            // Screen artwork is a separate texture and warms separately.
            await preloadScreen(item?.model3dConfig?.screen?.url);
          }
        }
      } catch (err) {
        console.warn("[render] model warm-up failed", err);
      }
    })());
  }
  // 3D Text letters are filmed by the model pass: it, and the environment it
  // loads on first use, must be primed like a model before frame one.
  if (!hasModel && (channels || []).some((ch) => (ch?.items || []).some((item) => item?.text3d?.enabled === true
    && (clips || []).some((c) => c?.id === item.clipId && c.mediaType === "text")))) hasModel = true;
  await Promise.all(warmups);
  try {
    // Cap fonts.ready — in a headless render a never-completing @font-face load
    // would otherwise hang the whole export here, before any frame is produced.
    if (document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    }
  } catch {
    /* fonts.ready unsupported — ignore */
  }
  // A couple more paints so Three.js has initialized its renderer/canvas.
  await nextPaint();
  await nextPaint();
  // Model layers load a second wave of resources LAZILY on their first real
  // render (the Player's own model module import, per-entry environment PMREM,
  // screen artwork, first-use GPU texture uploads) — and each of those only
  // STARTS once the previous one landed. A single prime+settle pass therefore
  // "settles" before anything is pending (the first prime merely kicks the
  // module import), which is why range renders still opened on empty frames.
  // Prime and settle ITERATIVELY until a whole round finds nothing pending.
  if (hasModel) {
    try {
      const { modelResourcesSettled, modelResourcesPending } = await import("./model3dLayer");
      const primeAt = model3dPrimeTimes(channels, clips, Math.max(0, Number(range?.start) || 0),
        Number(range?.end) > 0 ? Number(range.end) : Infinity);
      for (let round = 0; round < 6; round += 1) {
        for (const t of primeAt) await getPlayer()?.captureFrameAtTime?.(t);
        // Give freshly-kicked dynamic imports / loaders a beat to register.
        await new Promise((resolve) => setTimeout(resolve, 150));
        const hadPending = modelResourcesPending();
        await modelResourcesSettled();
        if (!hadPending && round > 0) break;
      }
      await getPlayer()?.captureFrameAtTime?.(primeAt[0]);
    } catch (err) {
      console.warn("[render] model priming failed", err);
    }
  }
}

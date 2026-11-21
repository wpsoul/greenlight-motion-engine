/*
 * A <video>'s texture on the WebGPU engine: the frame goes through a 2D canvas of its own, and that canvas is the texture.
 *
 * Why (2026-11-10, measured: tests/video-levels/probe.mjs + app_levels.mjs). three's WebGPU backend uploads a <video> with
 * copyExternalImageToTexture, and Chrome colour-converts the frame on the way into the 'srgb' destination. On macOS a
 * hardware-decoded BT.709 frame is read as gamma 1.961 (Chromium's BT709_APPLE transfer) and written back with the sRGB
 * curve: mid-grey 132 became 143, a lift of up to 12 levels across the mid-tones (fit over 32 grey bands: within 1 level),
 * BT.601 clips also had their primaries converted, HDR clips were tone-mapped another way. The destination options
 * (colorSpace, premultipliedAlpha), a VideoFrame and importExternalTexture all give the same lift. WebGL's texImage2D and the
 * export (WebCodecs frames drawn into a 2D canvas) keep the file's levels; so does a <video> drawn into a 2D canvas. So the
 * WebGPU preview and /render-still now take each frame the export's way: preview = still = export = the file. Two kinds of
 * frame keep the direct upload, where it is already the exact one: alpha WebM frames on the BT.709 matrix, and frames tagged
 * sRGB such as our own renders (directUploadKeepsLevels).
 * Cost (M2 Max, measured in the editor): drawImage ~0.12 ms of main thread per uploaded frame whatever its size (the pixels move
 * in the GPU process; the direct upload was ~0.02), and while the texture lives one more frame-sized buffer in the GPU process
 * plus Chrome's own copy for drawing it (+21 MB for a playing 1080p video, +69 MB for 4K).
 *
 * It behaves like THREE.VideoTexture otherwise: its own requestVideoFrameCallback loop marks every presented frame (the gated
 * channel buffers cancel it through _requestVideoFrameCallbackId exactly as they cancel a VideoTexture's: getVideoTexture),
 * linear filtering, no mipmaps, flipY and byte pass-through as before, and it costs nothing until three uploads it: the frame is
 * drawn when three is about to upload the texture (it reads source.dataReady right then, only for textures it is drawing), so
 * a layer that is off screen, hidden or not drawn this frame never draws its video. A video with no frame leaves the texture as
 * it was.
 */
import * as THREE from 'three';

export class VideoCanvasTexture extends THREE.Texture {
  constructor(video, canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null) {
    super(canvas, THREE.UVMapping, THREE.ClampToEdgeWrapping, THREE.ClampToEdgeWrapping, THREE.LinearFilter, THREE.LinearFilter);
    this.isVideoCanvasTexture = true;
    this.generateMipmaps = false;
    this.video = video;
    this._ctx = null;
    this._pendingFrame = false;
    this._requestVideoFrameCallbackId = 0;
    if (canvas) {
      canvas.width = Math.max(1, video.videoWidth || 1);
      canvas.height = Math.max(1, video.videoHeight || 1);
    }
    // three asks its texture's source whether the data is ready right before it uploads (renderers/common/Textures.js
    // updateTexture; WebGL's uploadTexture too): the one moment the frame is needed. This source is the texture's own.
    Object.defineProperty(this.source, 'dataReady', {
      configurable: true,
      get: () => (this._pendingFrame ? this.drawFrame() : true),
      set: () => {},
    });
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        this.needsUpdate = true;
        this._requestVideoFrameCallbackId = video.requestVideoFrameCallback(onFrame);
      };
      this._requestVideoFrameCallbackId = video.requestVideoFrameCallback(onFrame);
    }
  }

  /** true: the video has a new frame for the next upload. A video with no frame yet is ignored (the texture keeps what it shows). */
  set needsUpdate(value) {
    if (value !== true) return;
    const video = this.video, canvas = this.image;
    if (video && canvas) {
      const w = video.videoWidth, h = video.videoHeight;
      if (video.readyState < 2 || !w || !h) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        this._ctx = null;
        // three keeps the size it first uploaded: let it make the GPU copy again at the new size (bindings follow its generation)
        if (this.version > 0) THREE.Texture.prototype.dispose.call(this);
      }
      this._pendingFrame = true;
    }
    super.needsUpdate = true;
  }

  /** The video's current frame into the canvas, upright, at the canvas's size (the video's, set when the frame was announced).
   *  False when the video has no frame to give: the upload is skipped and the texture keeps its last picture. */
  drawFrame() {
    this._pendingFrame = false;
    const video = this.video, canvas = this.image;
    if (!video || !canvas || video.readyState < 2) return false;
    if (!this._ctx) {
      this._ctx = canvas.getContext('2d');
      if (!this._ctx) return false;
      // the new frame replaces the last one: an alpha video's clear parts must not keep the previous frame
      this._ctx.globalCompositeOperation = 'copy';
    }
    this._ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return true;
  }

  dispose() {
    if (this._requestVideoFrameCallbackId !== 0) {
      try { this.video?.cancelVideoFrameCallback?.(this._requestVideoFrameCallbackId); } catch { /* detached */ }
      this._requestVideoFrameCallbackId = 0;
    }
    super.dispose();
    // the canvas's frame goes with the GPU copy, not whenever the garbage collector finds it (a 4K frame is 33 MB); a texture
    // used again draws its video at full size again
    if (this.image) { this.image.width = 1; this.image.height = 1; }
    this._ctx = null;
    this._pendingFrame = false;
  }
}

/** True for the frames that Chrome's WebGPU upload already keeps exact, so they need no canvas (asked once per texture):
 *  - a software-decoded frame with an alpha plane ('I420A': VP8/VP9 alpha WebM, our own transparent renders) on the BT.709
 *    matrix. The upload leaves it alone, while the canvas decodes an alpha frame's blue with BT.601's coefficient (2.017, not
 *    2.112): saturated colours up to 8 levels too blue against the export. An alpha frame on BT.601 (untagged VP9) is the other
 *    way round: the upload converts its primaries (red 255/0/0 → 247/36/0), the canvas is right.
 *  - a frame tagged sRGB (BT.709 matrix and primaries, sRGB transfer): our own MP4 renders brought back in. Nothing to convert,
 *    the upload is exact (measured), and the canvas would only cost time and memory. */
export function directUploadKeepsLevels(video) {
  if (typeof VideoFrame === 'undefined') return false;
  let frame = null;
  try {
    frame = new VideoFrame(video);
    const cs = frame.colorSpace || {};
    if (frame.format === 'I420A') return cs.matrix === 'bt709';
    return cs.matrix === 'bt709' && cs.primaries === 'bt709' && cs.transfer === 'iec61966-2-1';
  } catch {
    return false;
  } finally {
    try { frame?.close(); } catch { /* closed */ }
  }
}

/** The texture for a <video>, for `renderer`: on three's WebGPU backend through a 2D canvas (above) unless its frames are the
 *  kind the upload keeps exact; anywhere else three's own VideoTexture (WebGL's texImage2D keeps the file's levels already). */
export function createVideoTexture(video, renderer) {
  if (renderer?.backend?.isWebGPUBackend === true && typeof document !== 'undefined' && !directUploadKeepsLevels(video)) {
    return new VideoCanvasTexture(video);
  }
  return new THREE.VideoTexture(video);
}

/** The <video> a video texture shows, whichever kind it is (a VideoTexture's image IS the element; ours is its canvas). */
export function textureVideoOf(texture) {
  return texture?.isVideoCanvasTexture ? texture.video : texture?.image;
}

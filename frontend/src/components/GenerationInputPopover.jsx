import { useState, useRef, useEffect } from "react";
import { api } from "../api/client";
import { filterModelsForSurface } from "../ai/models";
import { Model3DThumbnail } from "./Model3DViewerLazy";
import AudioPlayButton from "./AudioPlayButton";
import { useHoverTip } from "../hooks/useHoverTip";
import { cachedAudioDuration, requestAudioDuration } from "../utils/audioDurationProbe";

const MEDIA_BASE = "";
const DEFAULT_UPSCALE_PROMPT = "Upscale this image while preserving composition, style, and details.";

function isModelFileUrl(url) {
  return !!url && /\.(glb|gltf|obj)(\?.*)?$/i.test(url);
}

function isVideoFileUrl(url) {
  return !!url && /\.(mp4|webm|mov|m4v|avi|mkv)(\?.*)?$/i.test(url);
}

function isAudioFileUrl(url) {
  return !!url && /\.(mp3|wav|m4a|aac|ogg|flac|opus|wma)(\?.*)?$/i.test(url);
}

// Video tile that shows its poster (or first frame) by default and plays the
// clip, muted and looping, while hovered. The <video> is only mounted on hover,
// so the grid doesn't eagerly load every clip.
function HoverVideo({ src, poster }) {
  const [active, setActive] = useState(false);
  return (
    <div
      className="generation-thumb-media"
      onMouseEnter={() => setActive(true)}
      onMouseLeave={() => setActive(false)}
    >
      {active ? (
        <video
          src={`${src}#t=0.1`}
          poster={poster || undefined}
          muted
          loop
          autoPlay
          playsInline
          preload="auto"
          draggable={false}
        />
      ) : poster ? (
        <img src={poster} alt="" draggable={false} />
      ) : (
        <video src={`${src}#t=0.1`} muted preload="metadata" playsInline draggable={false} />
      )}
      {!active && (
        <span className="generation-thumb-play" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20" /></svg>
        </span>
      )}
    </div>
  );
}

// Render seconds as m:ss (e.g. 0:07, 1:42). Returns "" for unknown/zero length.
function formatAudioDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Best display name for any media item: explicit filename/title, else the
// basename of its URL. Used for hover tooltips so truncated tiles show their
// full name.
function getItemName(item, url) {
  const d = item?.data || {};
  const raw = item?.filename || d.title || item?.title || item?.name || d.name;
  if (raw) return String(raw);
  try {
    return decodeURIComponent((url || "").split("?")[0].split("#")[0].split("/").pop() || "") || "";
  } catch {
    return "";
  }
}

// Every name the search row can find an item by. A canvas element is already
// named by its card title (getItemName reads `data.title`); a media-library FILE
// is named by what's on disk, which an import sanitizes and truncates — so it
// also carries `card_titles`, the titles of the cards that draw it, and the same
// search finds it either way. See _card_titles_by_media_path in the backend.
function matchesSearchName(item, url, term) {
  if (getItemName(item, url).toLowerCase().includes(term)) return true;
  return (item?.card_titles || []).some((title) => title.toLowerCase().includes(term));
}

// Best display name for an audio item (falls back to "Audio").
function getAudioName(item, url) {
  return getItemName(item, url) || "Audio";
}

// Audio clips have no visual thumbnail, so the tile shows a music-note icon, the
// file name (truncated to one line) and the clip's duration. The length is read
// only while the tile is on screen, through the shared queue in
// audioDurationProbe — never one media player per tile, which froze the window
// when a library folder put hundreds of tiles in the panel.
// `onPlay` hands the play button over to the host: the Media Manager opens its
// own inline player row instead of playing the clip inside the tile, so audio
// and video behave identically there. Without it the tile plays in place.
export function AudioTile({ src, name, onPlay }) {
  const tileRef = useRef(null);
  const [duration, setDuration] = useState(() => (src ? cachedAudioDuration(src) ?? null : null));
  useEffect(() => {
    if (!src) return undefined;
    const known = cachedAudioDuration(src);
    if (known !== undefined) {
      setDuration(known);
      return undefined;
    }
    const el = tileRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      return requestAudioDuration(src, setDuration);
    }
    let cancel = null;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (visible && !cancel) {
        cancel = requestAudioDuration(src, setDuration);
      } else if (!visible && cancel) {
        cancel();
        cancel = null;
      }
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancel?.();
    };
  }, [src]);
  const durationLabel = formatAudioDuration(duration);
  return (
    <div className="generation-thumb-audio" ref={tileRef}>
      {durationLabel && <span className="generation-thumb-audio-time">{durationLabel}</span>}
      <svg className="generation-thumb-audio-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
      </svg>
      {name && <span className="generation-thumb-audio-name" title={name}>{name}</span>}
      {onPlay ? (
        <button
          type="button"
          className="generation-audio-play-btn"
          onClick={(e) => { e.stopPropagation(); onPlay(); }}
          onMouseDown={(e) => e.stopPropagation()}
          title="Play"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="7,4 20,12 7,20" />
          </svg>
        </button>
      ) : (
        <AudioPlayButton src={src} />
      )}
    </div>
  );
}

// Human-readable nouns for titles/empty states, keyed by field type.
function fieldNounPlural(fieldType) {
  if (fieldType === "media") return "media items";
  if (fieldType === "model") return "models";
  if (fieldType === "audio") return "audio clips";
  return `${fieldType}s`;
}

function fieldNounSingular(fieldType) {
  if (fieldType === "media") return "media";
  if (fieldType === "audio") return "audio";
  return fieldType;
}

function onCanvasTitle(fieldType) {
  if (fieldType === "image") return "Images on canvas";
  if (fieldType === "video") return "Videos on canvas";
  if (fieldType === "model") return "Models on canvas";
  if (fieldType === "audio") return "Audio on canvas";
  return "Media on canvas";
}

function getImageField(model) {
  return (model?.fields || []).find((f) => f.field_type === "image");
}

// Upscalers name this either `resolution` or `target_resolution` — missing the
// latter silently dropped the chosen resolution for the Wavespeed upscalers.
function getResolutionField(model) {
  return (model?.fields || []).find(
    (f) => f.key === "resolution" || f.key === "target_resolution" || f.field_type === "resolution"
  );
}

function isUpscaleCapableModel(model) {
  return model.output_type === "image" && !!getImageField(model);
}

// Any image model can be driven with the upscale prompt, but a dedicated
// upscaler is what this control is for — list those first so the default pick
// (models[0]) is an actual upscaler rather than whatever sorts first.
function byUpscalerFirst(a, b) {
  return (b.model_type === "image_upscale") - (a.model_type === "image_upscale");
}

function normalizeMediaUrl(url) {
  if (!url) return "";
  return url.startsWith("http") ? url : `${MEDIA_BASE}${url}`;
}

function extractBoardIdFromMediaUrl(url) {
  if (!url) return null;
  const match = url.match(/\/media\/admin\/([^/]+)\//);
  return match?.[1] || null;
}

function toRelativeMediaPath(url) {
  if (!url) return null;
  const noOrigin = url.replace(/^https?:\/\/[^/]+/i, "");
  if (noOrigin.startsWith("/media/")) return noOrigin.slice("/media/".length);
  return null;
}

export default function GenerationInputPopover({ fieldType, elements, unsortedItems, onSelect, onClose, uploadBoardId = null, onRecorded, multiUpload = false, onSelectMany = null }) {
  const [mode, setMode] = useState(null);
  const [mediaLibrary, setMediaLibrary] = useState(null);
  const [upscaleModels, setUpscaleModels] = useState([]);
  const [upscaleLoadingModels, setUpscaleLoadingModels] = useState(false);
  const [upscaleTarget, setUpscaleTarget] = useState(null);
  const [upscaleModelId, setUpscaleModelId] = useState("");
  const [upscaleResolution, setUpscaleResolution] = useState("");
  const [upscalingByKey, setUpscalingByKey] = useState({});
  const [urlOverrides, setUrlOverrides] = useState({});
  // Multi-select basket for hosts that accept several items at once (image-list
  // fields): grid clicks toggle picks, the footer "Add" commits them together.
  const [picked, setPicked] = useState([]);
  // Live name filter over the grid sub-views — the same instant filename search
  // the media manager's per-board search box applies.
  const [searchQuery, setSearchQuery] = useState("");
  const fileRef = useRef(null);
  const ref = useRef(null);

  // "Soft Pill" hover tooltip — shows each thumbnail's name instantly above it.
  const { portal: hoverTipPortal, showTip, hideTip } = useHoverTip();

  useEffect(() => { setPicked([]); setSearchQuery(""); }, [mode]);

  // --- Parse images from a website (image-list fields) ---
  const [siteUrl, setSiteUrl] = useState("");
  const [siteMinWidth, setSiteMinWidth] = useState(500);
  const [siteParsing, setSiteParsing] = useState(false);
  const [siteError, setSiteError] = useState("");

  // --- Voice recording (audio fields) ---
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState("");
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordedUrl, setRecordedUrl] = useState(null);
  const [recordUploading, setRecordUploading] = useState(false);
  const recorderRef = useRef(null);
  const recordStreamRef = useRef(null);
  const recordChunksRef = useRef([]);
  const recordTimerRef = useRef(null);
  const recordedBlobRef = useRef(null);
  const recordExtRef = useRef("webm");

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Release the mic + timer + object URL if the popover unmounts mid-recording.
  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      try { recorderRef.current?.state === "recording" && recorderRef.current.stop(); } catch { /* ignore */ }
      recordStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickRecordingFormat = () => {
    const candidates = [
      { mime: "audio/mp4", ext: "m4a" },
      { mime: "audio/ogg;codecs=opus", ext: "ogg" },
      { mime: "audio/webm;codecs=opus", ext: "webm" },
      { mime: "audio/webm", ext: "webm" },
    ];
    const supported = typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported;
    for (const c of candidates) {
      if (!supported || MediaRecorder.isTypeSupported(c.mime)) return c;
    }
    return { mime: "", ext: "webm" };
  };

  const startRecording = async () => {
    setRecordError("");
    setRecordSeconds(0);
    if (recordedUrl) { URL.revokeObjectURL(recordedUrl); setRecordedUrl(null); }
    recordedBlobRef.current = null;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecordError("Recording isn't supported here.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordStreamRef.current = stream;
      const fmt = pickRecordingFormat();
      recordExtRef.current = fmt.ext;
      const mr = fmt.mime ? new MediaRecorder(stream, { mimeType: fmt.mime }) : new MediaRecorder(stream);
      recordChunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data && e.data.size) recordChunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(recordChunksRef.current, { type: mr.mimeType || "audio/webm" });
        recordedBlobRef.current = blob;
        setRecordedUrl(URL.createObjectURL(blob));
        recordStreamRef.current?.getTracks().forEach((t) => t.stop());
        recordStreamRef.current = null;
      };
      mr.start();
      recorderRef.current = mr;
      setRecording(true);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setRecordError("Microphone access was denied or unavailable.");
    }
  };

  const stopRecording = () => {
    if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
    setRecording(false);
    try { recorderRef.current?.stop(); } catch { /* ignore */ }
  };

  const enterRecordMode = () => {
    setMode("record");
    startRecording();
  };

  const useRecording = async () => {
    const blob = recordedBlobRef.current;
    if (!blob) return;
    setRecordUploading(true);
    try {
      const file = new File([blob], `recording-${recordSeconds}s.${recordExtRef.current}`, { type: blob.type });
      const result = await api.uploadFile(file, uploadBoardId || null);
      // Also drop the recording onto the board as a card (when the host supports it).
      onRecorded?.(result);
      onSelect(`${MEDIA_BASE}${result.url}`);
    } catch {
      setRecordError("Upload failed. Try again.");
      setRecordUploading(false);
    }
  };

  const filterMedia = (items) =>
    items.filter((el) => {
      const d = el.data || el;
      const url = d.localUrl || d.url;
      if (!url) return false;
      if (fieldType === "image") return el.type === "image" || d.platform === "image" || d.type === "image";
      if (fieldType === "video") return el.type === "video" || d.platform === "video" || d.type === "video";
      if (fieldType === "model") return el.type === "3d-model" || d.type === "3d-model" || isModelFileUrl(url);
      if (fieldType === "audio") return el.type === "audio" || d.type === "audio" || isAudioFileUrl(url);
      if (fieldType === "media") return el.type === "image" || el.type === "video" || d.platform === "image" || d.platform === "video" || d.type === "image" || d.type === "video";
      return false;
    });

  const boardMedia = filterMedia(elements.filter((el) => !el.data?.ai_generating && !el.data?.ai_failed));
  const unsortedMedia = filterMedia(unsortedItems || []);

  const getItemKey = (kind, item) => {
    if (kind === "media") return `media:${item.url}`;
    return `${kind}:${item.id || getMediaUrl(item)}`;
  };

  const closeUpscalePopover = () => {
    setUpscaleTarget(null);
    setUpscaleModelId("");
    setUpscaleResolution("");
  };

  const ensureUpscaleModels = async () => {
    if (upscaleModels.length > 0) return upscaleModels;
    if (upscaleLoadingModels) return [];
    setUpscaleLoadingModels(true);
    try {
      const models = filterModelsForSurface(await api.listAIModels(), "generate");
      const filtered = models.filter(isUpscaleCapableModel).sort(byUpscalerFirst);
      setUpscaleModels(filtered);
      return filtered;
    } catch {
      setUpscaleModels([]);
      return [];
    } finally {
      setUpscaleLoadingModels(false);
    }
  };

  // Load media library on demand
  const loadMediaLibrary = () => {
    if (mediaLibrary) { setMode("media"); return; }
    api.listMedia().then((data) => {
      setMediaLibrary(data);
      setMode("media");
    }).catch(() => setMode("media"));
  };

  const matchesMediaField = (f) =>
    fieldType === "media" ? (f.type === "image" || f.type === "video")
      : fieldType === "model" ? (f.type === "3d-model" || isModelFileUrl(f.url))
        : fieldType === "audio" ? (f.type === "audio" || isAudioFileUrl(f.url))
          : f.type === fieldType;

  // Keep the media library grouped by board (like the media manager) instead of one flat list.
  const mediaLibraryBoards = mediaLibrary
    ? mediaLibrary.boards
        .map((b) => ({ name: b.name, files: b.files.filter(matchesMediaField) }))
        .filter((b) => b.files.length > 0)
    : [];
  const mediaLibraryCount = mediaLibraryBoards.reduce((n, b) => n + b.files.length, 0);

  const getMediaUrl = (el) => {
    const d = el.data || el;
    const overrideKey = el.id ? `el:${el.id}` : null;
    if (overrideKey && urlOverrides[overrideKey]) return urlOverrides[overrideKey];
    if (d.localUrl) return d.localUrl.startsWith("http") ? d.localUrl : `${MEDIA_BASE}${d.localUrl}`;
    if (d.url) return d.url.startsWith("http") ? d.url : `${MEDIA_BASE}${d.url}`;
    return "";
  };

  const getThumb = (el) => {
    const d = el.data || el;
    return d.localThumbnail || d.thumbnail || getMediaUrl(el);
  };

  const resolveFileUrl = (url) => url?.startsWith("http") ? url : `${MEDIA_BASE}${url}`;

  const getSelectedUpscaleModel = () => upscaleModels.find((m) => m.id === upscaleModelId) || null;

  const getResolutionOptions = (model) => {
    const field = model ? getResolutionField(model) : null;
    return field?.options || [];
  };

  const openUpscale = async ({ key, sourceUrl, kind, mediaFile, elementId }) => {
    if (fieldType !== "image" && fieldType !== "media") return;
    const models = await ensureUpscaleModels();
    if (models.length === 0) return;
    const model = models[0];
    const options = getResolutionOptions(model);
    setUpscaleTarget({ key, sourceUrl, kind, mediaFile, elementId });
    setUpscaleModelId(model.id);
    setUpscaleResolution(options[0] || "");
  };

  const runUpscale = async () => {
    if (!upscaleTarget || !upscaleModelId) return;
    const model = getSelectedUpscaleModel();
    if (!model) return;
    const imageField = getImageField(model);
    if (!imageField) return;

    const targetKey = upscaleTarget.key;
    const sourceUrl = normalizeMediaUrl(upscaleTarget.sourceUrl);
    const resolutionField = getResolutionField(model);
    const params = { [imageField.key]: sourceUrl };
    // Dedicated upscalers take no prompt, and providers that reject unknown
    // parameters (Pika's schemas are additionalProperties:false) fail the call
    // outright if one is sent anyway.
    if ((model.fields || []).some((f) => f.key === "prompt")) {
      params.prompt = DEFAULT_UPSCALE_PROMPT;
    }
    if (resolutionField && upscaleResolution) {
      params[resolutionField.key] = upscaleResolution;
    }
    const boardId = extractBoardIdFromMediaUrl(sourceUrl) || uploadBoardId || null;

    setUpscalingByKey((prev) => ({ ...prev, [targetKey]: true }));
    closeUpscalePopover();
    try {
      const result = await api.aiGenerate(upscaleModelId, params, boardId);
      const nextUrlRaw = result?.results?.find((r) => r?.type === "image")?.url || result?.results?.[0]?.url;
      const nextUrl = normalizeMediaUrl(nextUrlRaw);
      if (!nextUrl) throw new Error("Upscale returned empty image URL");

      setUrlOverrides((prev) => ({
        ...prev,
        ...(upscaleTarget.elementId ? { [`el:${upscaleTarget.elementId}`]: nextUrl } : {}),
        [targetKey]: nextUrl,
      }));

      // Replace item in media library by deleting the old file then reloading list.
      if (upscaleTarget.kind === "media" && upscaleTarget.mediaFile?.url) {
        const oldPath = toRelativeMediaPath(upscaleTarget.mediaFile.url);
        if (oldPath) {
          try { await api.deleteMedia(oldPath); } catch { /* no-op */ }
        }
        try {
          const refreshed = await api.listMedia();
          setMediaLibrary(refreshed);
        } catch {
          // keep existing state if refresh fails
        }
      }
    } catch {
      // keep current image if upscale fails
    } finally {
      setUpscalingByKey((prev) => {
        const next = { ...prev };
        delete next[targetKey];
        return next;
      });
    }
  };

  const handleUpload = async (file) => {
    try {
      const result = await api.uploadFile(file, uploadBoardId || null);
      onSelect(`${MEDIA_BASE}${result.url}`);
    } catch {
      // upload failed
    }
  };

  // Parse images from a website: the backend scrapes the page, keeps images at
  // least `siteMinWidth` px wide, saves them into board media, and we add each
  // to the field via onSelect (the popover closes after the first add).
  const runWebsiteParse = async () => {
    const url = siteUrl.trim();
    if (!url || siteParsing) return;
    setSiteParsing(true);
    setSiteError("");
    try {
      const minW = Math.max(1, parseInt(siteMinWidth, 10) || 500);
      const result = await api.parseWebsiteImages(url, minW, uploadBoardId || null);
      const found = result?.images || [];
      if (found.length === 0) {
        setSiteError(`No images at least ${minW}px wide found on that page.`);
        setSiteParsing(false);
        return;
      }
      const urls = found.map((img) => (img.url?.startsWith("http") ? img.url : `${MEDIA_BASE}${img.url}`));
      if (onSelectMany) {
        // One batched add: image-list hosts rebuild state from the render the
        // popover captured, so N sequential onSelect calls through that stale
        // closure would each overwrite the previous — only the last survives.
        onSelectMany(urls);
      } else {
        for (const u of urls) {
          onSelect(u);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    } catch {
      setSiteError("Could not parse that page. Check the URL and try again.");
      setSiteParsing(false);
    }
  };

  // Multi-file upload (image-list fields): upload sequentially, then add all in
  // one batch — per-file onSelect through the popover's stale closure would
  // leave only the last file (see onSelectMany note in runWebsiteParse).
  const handleUploadMany = async (files) => {
    const uploaded = [];
    for (const file of files) {
      try {
        const result = await api.uploadFile(file, uploadBoardId || null);
        uploaded.push(`${MEDIA_BASE}${result.url}`);
      } catch {
        // skip failed file, keep going
      }
    }
    if (uploaded.length === 0) return;
    if (onSelectMany) onSelectMany(uploaded);
    else uploaded.forEach((u) => onSelect(u));
  };

  useEffect(() => {
    if (upscaleTarget && upscaleModelId) {
      const model = getSelectedUpscaleModel();
      const options = getResolutionOptions(model);
      if (options.length === 0) {
        setUpscaleResolution("");
      } else if (!options.includes(upscaleResolution)) {
        setUpscaleResolution(options[0]);
      }
    }
  }, [upscaleModelId, upscaleModels]);

  const renderUpscaleControls = () => {
    // The trigger also renders on "media" fields (for their image items), so the
    // popover has to open for those too — otherwise the click sets a target that
    // nothing ever renders and the thumb is stuck in its pending state.
    if (!upscaleTarget || (fieldType !== "image" && fieldType !== "media")) return null;
    const selectedModel = getSelectedUpscaleModel();
    const resolutionOptions = getResolutionOptions(selectedModel);
    return (
      <div className="generation-upscale-popover" onMouseDown={(e) => e.stopPropagation()}>
        <div className="generation-upscale-title">Upscale image</div>
        <label className="generation-upscale-label">Model</label>
        <select
          className="generation-upscale-select"
          value={upscaleModelId}
          onChange={(e) => setUpscaleModelId(e.target.value)}
        >
          {upscaleModels.map((model) => (
            <option key={model.id} value={model.id}>{model.name}</option>
          ))}
        </select>
        <label className="generation-upscale-label">Resolution</label>
        <select
          className="generation-upscale-select"
          value={upscaleResolution}
          onChange={(e) => setUpscaleResolution(e.target.value)}
          disabled={resolutionOptions.length === 0}
        >
          {resolutionOptions.length === 0 ? (
            <option value="">Default</option>
          ) : (
            resolutionOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))
          )}
        </select>
        <div className="generation-upscale-actions">
          <button className="generation-upscale-btn ghost" onClick={closeUpscalePopover}>Cancel</button>
          <button className="generation-upscale-btn" onClick={runUpscale}>Upscale</button>
        </div>
      </div>
    );
  };

  const renderThumb = ({ kind, item, sourceUrl, thumbnailUrl, title, elementId }) => {
    const key = getItemKey(kind, item);
    const resolvedUrl = normalizeMediaUrl(sourceUrl);
    const resolvedThumb = normalizeMediaUrl(thumbnailUrl || sourceUrl);
    const isBusy = !!upscalingByKey[key];
    const itemType = item.type || item.data?.type;
    const isModelItem = fieldType === "model" || itemType === "3d-model" || isModelFileUrl(resolvedUrl);
    const isAudioItem = !isModelItem && (fieldType === "audio" || itemType === "audio" || isAudioFileUrl(resolvedUrl));
    const isVideoItem = !isModelItem && !isAudioItem && (fieldType === "video" || itemType === "video" || isVideoFileUrl(resolvedUrl));
    // A real poster image to show for a video: the thumbnail differs from the
    // clip itself and isn't a video file. Otherwise fall back to a <video> seeked
    // to the first frame (the old code stuffed the poster into <video src>, which
    // renders blank).
    const videoPoster = isVideoItem && resolvedThumb && !isVideoFileUrl(resolvedThumb) ? resolvedThumb : null;
    const hasUpscale = fieldType === "image" || fieldType === "media";
    return (
      <div
        key={key}
        className={`generation-popover-thumb ${isBusy ? "upscaling" : ""} ${onSelectMany && picked.includes(urlOverrides[key] || resolvedUrl) ? "picked" : ""}`}
        onClick={() => {
          if (isBusy) return;
          const url = urlOverrides[key] || resolvedUrl;
          if (onSelectMany) {
            setPicked((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));
          } else {
            onSelect(url);
          }
        }}
        onMouseEnter={(e) => showTip(e.currentTarget, title)}
        onMouseLeave={hideTip}
        aria-label={title}
      >
        {onSelectMany && picked.includes(urlOverrides[key] || resolvedUrl) && (
          <span className="generation-thumb-picked-badge">{picked.indexOf(urlOverrides[key] || resolvedUrl) + 1}</span>
        )}
        {isModelItem ? (
          <Model3DThumbnail url={resolvedUrl} title={title} />
        ) : isAudioItem ? (
          <AudioTile src={resolvedUrl} name={getAudioName(item, resolvedUrl)} />
        ) : isVideoItem ? (
          <HoverVideo src={resolvedUrl} poster={videoPoster} />
        ) : (
          <img src={urlOverrides[key] || resolvedThumb} alt="" draggable={false} />
        )}
        {hasUpscale && !isVideoItem && !isModelItem && !isAudioItem && (
          <button
            className="generation-thumb-upscale-btn"
            onClick={(e) => {
              e.stopPropagation();
              openUpscale({ key, sourceUrl: urlOverrides[key] || resolvedUrl, kind, mediaFile: kind === "media" ? item : null, elementId });
            }}
            disabled={isBusy || upscaleLoadingModels}
            title="Upscale"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v8" />
              <path d="m8.5 6.5 3.5-3.5 3.5 3.5" />
              <path d="M5 13v5a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-5" />
            </svg>
          </button>
        )}
        {isBusy && (
          <div className="generation-thumb-upscale-loader">
            <div className="generation-thumb-upscale-shimmer" />
            <span>Upscaling…</span>
          </div>
        )}
      </div>
    );
  };

  const searchTerm = searchQuery.trim().toLowerCase();

  // The search row reuses the media manager's .media-board-search styling so
  // both pickers look and behave the same.
  const renderSearchRow = () => (
    <div className="media-board-search">
      <svg className="media-board-search-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        className="media-board-search-input"
        placeholder={`Filter ${fieldNounPlural(fieldType)}…`}
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        autoFocus
        autoComplete="off"
      />
      {searchTerm && (
        <button
          type="button"
          className="media-board-search-clear"
          onClick={() => setSearchQuery("")}
          title="Clear filter"
        >
          ×
        </button>
      )}
    </div>
  );

  // Footer for multi-capable hosts: commit every picked thumb in one batch.
  const renderPickedBar = () => {
    if (!onSelectMany || picked.length === 0) return null;
    return (
      <div className="generation-popover-addbar">
        <button className="generation-upscale-btn ghost" onClick={() => setPicked([])}>Clear</button>
        <button className="generation-upscale-btn" onClick={() => onSelectMany(picked)}>
          Add {picked.length} {picked.length === 1 ? "item" : "items"}
        </button>
      </div>
    );
  };

  // Sub-view: grid from board or unsorted
  if (mode === "board" || mode === "unsorted") {
    const items = mode === "board" ? boardMedia : unsortedMedia;
    const visibleItems = searchTerm
      ? items.filter((el) => matchesSearchName(el, getMediaUrl(el), searchTerm))
      : items;
    const title = mode === "board" ? onCanvasTitle(fieldType) : "Select from unsorted";
    return (
      <div className="generation-popover generation-popover-board" ref={ref}>
        <div className="generation-popover-header">
          <button className="generation-popover-back" onClick={() => setMode(null)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span>{title}</span>
        </div>
        {hoverTipPortal}
        {items.length > 0 && renderSearchRow()}
        {items.length === 0 ? (
          <div className="generation-popover-empty">No {fieldNounPlural(fieldType)} available</div>
        ) : visibleItems.length === 0 ? (
          <div className="generation-popover-empty">No {fieldNounPlural(fieldType)} match “{searchQuery.trim()}”</div>
        ) : (
          <div className="generation-popover-grid">
            {visibleItems.map((el) =>
              renderThumb({
                kind: mode,
                item: el,
                sourceUrl: getMediaUrl(el),
                thumbnailUrl: getThumb(el),
                title: getItemName(el, getMediaUrl(el)),
                elementId: el.id,
              })
            )}
          </div>
        )}
        {renderPickedBar()}
        {renderUpscaleControls()}
      </div>
    );
  }

  // Sub-view: media library grid
  if (mode === "media") {
    // A board whose name matches keeps all its files (like the media manager
    // keeps a whole subfolder whose name matches); otherwise only its matching
    // files survive, and emptied boards drop out of the list.
    const visibleLibraryBoards = searchTerm
      ? mediaLibraryBoards
          .map((board) => ((board.name || "").toLowerCase().includes(searchTerm)
            ? board
            : { ...board, files: board.files.filter((f) => matchesSearchName(f, f.url, searchTerm)) }))
          .filter((board) => board.files.length > 0)
      : mediaLibraryBoards;
    const visibleLibraryCount = visibleLibraryBoards.reduce((n, b) => n + b.files.length, 0);
    return (
      <div className="generation-popover generation-popover-board" ref={ref}>
        <div className="generation-popover-header">
          <button className="generation-popover-back" onClick={() => setMode(null)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span>Media library</span>
        </div>
        {hoverTipPortal}
        {mediaLibraryCount > 0 && renderSearchRow()}
        {mediaLibraryCount === 0 ? (
          <div className="generation-popover-empty">No {fieldNounPlural(fieldType)} in media library</div>
        ) : visibleLibraryCount === 0 ? (
          <div className="generation-popover-empty">No {fieldNounPlural(fieldType)} match “{searchQuery.trim()}”</div>
        ) : (
          <div className="generation-popover-board-list">
            {visibleLibraryBoards.map((board) => (
              <div className="generation-popover-board-group" key={board.name}>
                <div className="generation-popover-board-name">
                  {board.name}
                  <span className="generation-popover-board-count">{board.files.length}</span>
                </div>
                <div className="generation-popover-grid">
                  {board.files.map((file, i) =>
                    renderThumb({
                      kind: "media",
                      item: file,
                      sourceUrl: urlOverrides[`media:${file.url}`] || resolveFileUrl(file.url),
                      thumbnailUrl: urlOverrides[`media:${file.url}`] || resolveFileUrl(file.thumbnail_url || file.thumbnail || file.url),
                      title: `${file.filename} (${board.name})`,
                      elementId: null,
                      i,
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {renderPickedBar()}
        {renderUpscaleControls()}
      </div>
    );
  }

  // Sub-view: parse images from a website
  if (mode === "website") {
    return (
      <div className="generation-popover generation-popover-parse" ref={ref}>
        <div className="generation-popover-header">
          <button className="generation-popover-back" onClick={() => { setSiteError(""); setMode(null); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span>Parse from website</span>
        </div>
        <div className="generation-parse-body">
          <label className="generation-parse-label">Page URL</label>
          <input
            type="text"
            className="generation-parse-input"
            placeholder="https://example.com/page"
            value={siteUrl}
            autoFocus
            disabled={siteParsing}
            onChange={(e) => setSiteUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runWebsiteParse(); }}
            autoComplete="off"
          />
          <label className="generation-parse-label">Minimal image width (px)</label>
          <input
            type="number"
            className="generation-parse-input"
            min={1}
            step={50}
            value={siteMinWidth}
            disabled={siteParsing}
            onChange={(e) => setSiteMinWidth(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runWebsiteParse(); }}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          {siteError && <div className="generation-parse-error">{siteError}</div>}
          <button
            className="generation-parse-btn"
            onClick={runWebsiteParse}
            disabled={siteParsing || !siteUrl.trim()}
          >
            {siteParsing ? "Parsing images…" : "Parse images"}
          </button>
        </div>
      </div>
    );
  }

  // Sub-view: record voice
  if (mode === "record") {
    const mm = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
    const ss = String(recordSeconds % 60).padStart(2, "0");
    return (
      <div className="generation-popover generation-popover-record" ref={ref}>
        <div className="generation-popover-header">
          <button
            className="generation-popover-back"
            onClick={() => {
              stopRecording();
              recordStreamRef.current?.getTracks().forEach((t) => t.stop());
              recordStreamRef.current = null;
              if (recordedUrl) { URL.revokeObjectURL(recordedUrl); setRecordedUrl(null); }
              recordedBlobRef.current = null;
              setMode(null);
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span>Record voice</span>
        </div>
        <div className="generation-record-body">
          {recordError ? (
            <>
              <div className="generation-record-error">{recordError}</div>
              <button className="generation-record-btn" onClick={startRecording}>Try again</button>
            </>
          ) : recording ? (
            <>
              <div className="generation-record-timer"><span className="generation-record-dot" />{mm}:{ss}</div>
              <button className="generation-record-btn stop" onClick={stopRecording}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                Stop
              </button>
            </>
          ) : recordedUrl ? (
            <>
              <audio className="generation-record-preview" src={recordedUrl} controls />
              <div className="generation-record-actions">
                <button className="generation-record-btn ghost" onClick={startRecording} disabled={recordUploading}>Re-record</button>
                <button className="generation-record-btn" onClick={useRecording} disabled={recordUploading}>
                  {recordUploading ? "Saving…" : "Use recording"}
                </button>
              </div>
            </>
          ) : (
            <button className="generation-record-btn" onClick={startRecording}>
              <span className="generation-record-dot" /> Start recording
            </button>
          )}
        </div>
      </div>
    );
  }

  // Main menu
  return (
    <div className="generation-popover" ref={ref}>
      <button className="generation-popover-option" onClick={() => setMode("board")}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
        </svg>
        {onCanvasTitle(fieldType)}
        {boardMedia.length > 0 && <span className="generation-popover-count">{boardMedia.length}</span>}
      </button>
      {unsortedMedia.length > 0 && (
        <button className="generation-popover-option" onClick={() => setMode("unsorted")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
          Select from unsorted
          <span className="generation-popover-count">{unsortedMedia.length}</span>
        </button>
      )}
      <button className="generation-popover-option" onClick={loadMediaLibrary}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        Select from media library
      </button>
      <div className="generation-popover-divider" />
      <button className="generation-popover-option" onClick={() => fileRef.current?.click()}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        Upload {multiUpload ? `${fieldNounSingular(fieldType)}s` : fieldNounSingular(fieldType)}
      </button>
      {multiUpload && (fieldType === "image" || fieldType === "media") && (
        <button className="generation-popover-option" onClick={() => setMode("website")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          Parse from website
        </button>
      )}
      {fieldType === "audio" && (
        <button className="generation-popover-option" onClick={enterRecordMode}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
          Record voice
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept={fieldType === "image" ? "image/*" : fieldType === "video" ? "video/*" : fieldType === "audio" ? "audio/*" : fieldType === "model" ? ".glb,.gltf,.obj,model/gltf-binary,model/gltf+json" : "image/*,video/*"}
        multiple={multiUpload}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          if (files.length) { if (multiUpload) handleUploadMany(files); else handleUpload(files[0]); }
          e.target.value = "";
        }}
      />
    </div>
  );
}

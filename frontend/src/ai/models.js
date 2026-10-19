import { api } from "../api/client";

let cachedModels = null;

export async function getAIModels() {
  if (cachedModels) return cachedModels;
  cachedModels = await api.listAIModels();
  return cachedModels;
}

export function getModelById(models, id) {
  return models.find((m) => m.id === id);
}

// Model types visible in the main generation panel per output mode
const MAIN_IMAGE_TYPES = new Set([
  "text_to_image", "image_to_image", "text_to_vector",
  "background_removal", "image_upscale", "image_angles",
  // One picture in, a base image plus transparent layers out.
  "decomposition",
]);
const MAIN_VIDEO_TYPES = new Set([
  "text_to_video", "omni", "image_to_video", "references_to_video",
  "first_last_frame_to_video", "video_extend",
  "multi_elements_to_video", "video_to_video", "face_swap", "avatar", "multi_avatar",
  "video_upscale", "video_background_removal",
  "motion_control", "roto",
  // Utility passes over existing media (depth maps, object erasure, cutouts).
  "utility",
]);
const MAIN_AUDIO_TYPES = new Set([
  "text_to_speech", "text_to_audio", "speech_to_speech",
  // Music generation: text→music / music→music produce an audio card. music→text
  // (describe a song) drops a note, like the transcribers below.
  "text_to_music", "music_to_music", "music_to_text",
  // Transcription (audio/video → text). Lives in the voice panel; the result is
  // dropped on the board as a note.
  "speech_to_text", "video_to_text",
  // Sound for a picture: one category (video→audio, video→sound effects and
  // scoring are the same job). Dubbing is a voice job — re-voicing the speech
  // in another language — so it belongs with the voice models, not the video
  // ones, even though a dubbed result can come back as a picture.
  "video_to_audio", "video_to_music", "voice_isolation", "video_dubbing",
  // Clean an existing recording: noise suppression + loudness levelling.
  "clean",
]);

const TRANSITION_START_FIELD_KEYS = new Set([
  "start_image_url",
  "image_url",
  "image",
  "first_image",
  "start_frame",
  "first_frame_url",
]);

const TRANSITION_END_FIELD_KEYS = new Set([
  "end_image_url",
  "end_image",
  "last_image",
  "last_image_url",
  "end_frame",
  "last_frame_url",
]);

function supportsTransitionFrames(model) {
  if (model.model_type === "first_last_frame_to_video") return true;
  if (model.output_type !== "video") return false;
  const fieldKeys = new Set((model.fields || []).map((field) => field.key));
  const hasStartField = [...TRANSITION_START_FIELD_KEYS].some((key) => fieldKeys.has(key));
  const hasEndField = [...TRANSITION_END_FIELD_KEYS].some((key) => fieldKeys.has(key));
  return hasStartField && hasEndField;
}

// Custom-manifest models declare where the user allowed them to appear
// (`show_in`); built-in models carry no list and show everywhere. `surface` is
// "generate" (canvas + Generate panel), "video_editor" or "agent".
//
// EVERY place that shows a model picker must go through this — prefer
// getAIModelsFor(surface) over getAIModels() so a new picker cannot forget and
// silently offer a model the user excluded from that surface.
export function filterModelsForSurface(models, surface) {
  return (models || []).filter((m) => !Array.isArray(m.show_in) || m.show_in.includes(surface));
}

export async function getAIModelsFor(surface) {
  return filterModelsForSurface(await getAIModels(), surface);
}

export function getImageModels(models) {
  return models.filter((m) => MAIN_IMAGE_TYPES.has(m.model_type));
}

export function getVideoModels(models) {
  return models.filter((m) => MAIN_VIDEO_TYPES.has(m.model_type));
}

export function getFirstLastFrameVideoModels(models) {
  return models.filter((m) => supportsTransitionFrames(m));
}

// Resolve which of a first/last-frame model's fields carry the start and end
// frames, so a caller building params directly (e.g. AI Fill) can set the right
// keys regardless of the provider's naming. Falls back to the canonical keys.
export function getTransitionFrameKeys(model) {
  const fieldKeys = new Set((model?.fields || []).map((f) => f.key));
  const startKey = [...TRANSITION_START_FIELD_KEYS].find((k) => fieldKeys.has(k)) || "start_image_url";
  const endKey = [...TRANSITION_END_FIELD_KEYS].find((k) => fieldKeys.has(k)) || "end_image_url";
  return { startKey, endKey };
}

export function getAudioModels(models) {
  return models.filter((m) => MAIN_AUDIO_TYPES.has(m.model_type));
}

/** Filter models by a specific model_type string */
export function getModelsByType(models, modelType) {
  return models.filter((m) => m.model_type === modelType);
}

// Providers whose voice models cannot reproduce the voice of an existing take.
// Pika's speech line picks a voice from a bundled preset list rather than from
// a reference recording, so it has no way to match a take already on the
// timeline. The transcript and voice-clip panels exist to re-speak a take in
// its OWN voice, so they exclude it; Pika Speech stays available in the main
// generation panel, where any voice is a valid answer.
const NO_VOICE_REFERENCE_PROVIDERS = new Set(["pika"]);

/**
 * Voice models usable where the output must keep an existing take's voice.
 * Same shape as getModelsByType, minus providers with no voice reference.
 */
export function getVoiceCloneModels(models, modelType) {
  return getModelsByType(models, modelType).filter(
    (m) => !NO_VOICE_REFERENCE_PROVIDERS.has(m.provider)
  );
}

/**
 * The field a media card's own URL should be posted under.
 *
 * A model's source input is the media field it *requires*. Some models declare
 * extra optional media of another kind — wavespeed-ai/video-background-remover
 * takes a required `video_url` plus an optional `image_url` for the replacement
 * backdrop — and that optional slot must never be mistaken for the source, or
 * the card's media is posted into the wrong parameter and the required one is
 * left empty.
 */
export function getModelSourceField(model, mediaKind) {
  const fields = model?.fields || [];
  const required = fields.find((f) => f.field_type === mediaKind && f.required !== false);
  if (required) return required;
  // Fall back to an optional field of this kind only when the model requires no
  // media at all, so an optional extra can never shadow a required input.
  const requiresOtherMedia = fields.some(
    (f) => MEDIA_FIELD_TYPES.has(f.field_type) && f.required !== false
  );
  return requiresOtherMedia ? null : fields.find((f) => f.field_type === mediaKind) || null;
}

const MEDIA_FIELD_TYPES = new Set(["image", "video", "audio", "media"]);

function byTypeAndSource(models, modelType, mediaKind) {
  return (models || []).filter(
    (m) => m.model_type === modelType && !!getModelSourceField(m, mediaKind)
  );
}

/** Get upscaler models (image or video based on mediaKind) */
export function getUpscaleModels(models, mediaKind) {
  return mediaKind === "video"
    ? byTypeAndSource(models, "video_upscale", "video")
    : byTypeAndSource(models, "image_upscale", "image");
}

/** Get background removal models */
export function getBgRemoveModels(models, mediaKind) {
  return mediaKind === "video"
    ? byTypeAndSource(models, "video_background_removal", "video")
    : byTypeAndSource(models, "background_removal", "image");
}

/** Get unique model_type values present in a list of models */
export function getAvailableModelTypes(models) {
  return [...new Set(models.map((m) => m.model_type))];
}

/** Human-readable labels for model_type filter chips */
export const MODEL_TYPE_LABELS = {
  text_to_image: "Text to Image",
  image_to_image: "Image to Image (Edit)",
  image_angles: "Angles",
  background_removal: "Background Removal",
  image_upscale: "Image Upscale",
  decomposition: "Decomposition",
  text_to_vector: "Text to Vector",
  text_to_video: "Text to Video",
  omni: "Omni",
  image_to_video: "Image to Video",
  references_to_video: "References to Video",
  first_last_frame_to_video: "First-Last Frame",
  video_to_video: "Video to Video",
  video_dubbing: "Voice Dubbing",
  face_swap: "Face Swap",
  avatar: "Avatar",
  multi_avatar: "Multi Avatar",
  multi_elements_to_video: "Multi Elements",
  video_extend: "Video Extend",
  video_upscale: "Video Upscale",
  video_background_removal: "Video BG Removal",
  motion_control: "Motion Control",
  roto: "Roto",
  utility: "Utility",
  text_to_speech: "Text to Speech",
  text_to_audio: "Text to Audio",
  speech_to_speech: "Speech to Speech",
  text_to_music: "Text to Music",
  music_to_music: "Music to Music",
  music_to_text: "Music to Text",
  speech_to_text: "Transcribe (Audio)",
  video_to_text: "Transcribe (Video)",
  video_to_audio: "Video to Audio",
  video_to_music: "Video to Music",
  voice_isolation: "Voice Isolation",
  clean: "Clean",
};

export const PROVIDER_ICONS = {
  geminigen: { label: "SnapGen", color: "#7761f0" },
  google: { label: "Google", color: "#a0e515" },
  anthropic: { label: "Anthropic", color: "#d97757" },
  openai: { label: "OpenAI", color: "#10a37f" },
  replicate: { label: "Replicate", color: "#0ea5e9" },
  wavespeed: { label: "Wavespeed", color: "#10b981" },
  pika: { label: "Pika", color: "#ffe94a" },
  bytedance: { label: "ByteDance", color: "#325cff" },
  minimax: { label: "MiniMax", color: "#ff6b35" },
  elevenlabs: { label: "ElevenLabs", color: "#111111" },
  recraft: { label: "Recraft", color: "#ff4f8b" },
  sonilo: { label: "Sonilo", color: "#7761f0" },
  topaz: { label: "Topaz", color: "#22a6b3" },
  "x-ai": { label: "xAI", color: "#111111" },
  kling: { label: "Kling", color: "#f59e0b" },
  higgsfield: { label: "HiggsField", color: "#6366f1" },
  heygen: { label: "HeyGen", color: "#c026d3" },
};

export function clearModelCache() {
  cachedModels = null;
}

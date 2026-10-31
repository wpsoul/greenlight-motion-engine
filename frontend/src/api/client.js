const API = import.meta.env.VITE_API_BASE_URL || "/api";
// Exposed for the collaboration module's WebSocket URL (ws(s):// derives from it).
export const API_BASE = API;
const API_KEYS_STORAGE = "gl_api_keys";
// Stable per-tab identifier sent on every request. The backend records it as the
// "actor" of each board change, so this client can skip refetching changes it made
// itself (already applied locally) while still picking up external/API-driven changes.
export const CLIENT_ID =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const STARTUP_RETRY_STATUS_CODES = new Set([502, 504]);
const STARTUP_RETRY_LIMIT = 10;
const STARTUP_RETRY_DELAY_MS = 2000;

// --- Idempotency key -------------------------------------------------------
// `request` retries by itself: on 502/504 while the backend is warming up, and
// on a TypeError, which is what a request whose response never came back looks
// like from here. Those retries are the reason the backend grew receipts — a
// create that succeeded on the server but lost its reply used to be sent again
// and done twice, which for a card means two cards.
//
// The id is minted once per logical call and carried through THIS call's
// retries, so a retry is recognisably the same operation; a caller that decides
// to send again (a 409 rebase, a user clicking twice) goes through `request`
// afresh and gets a new id, which is correct — that is a second intent, not a
// retry. The backend ignores the header on operations that do not read it yet.
const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function newOpId() {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
let electronApiKeysCache = null;
let electronApiKeysPromise = null;

function normalizeApiKeys(value) {
  return value && typeof value === "object" ? value : {};
}

async function readStoredApiKeys() {
  if (typeof window === "undefined") {
    return {};
  }
  if (window.electronAPI?.isElectron) {
    if (electronApiKeysCache) {
      return electronApiKeysCache;
    }
    if (!electronApiKeysPromise) {
      electronApiKeysPromise = window.electronAPI.getSettings("backendEnv")
        .then((value) => {
          electronApiKeysCache = normalizeApiKeys(value);
          return electronApiKeysCache;
        })
        .catch(() => ({}))
        .finally(() => {
          electronApiKeysPromise = null;
        });
    }
    return electronApiKeysPromise;
  }
  try {
    return normalizeApiKeys(JSON.parse(localStorage.getItem(API_KEYS_STORAGE) || "{}"));
  } catch {
    return {};
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("gl:settings-saved", () => {
    electronApiKeysCache = null;
    electronApiKeysPromise = null;
  });
}

async function withRuntimeApiKeyHeaders(headers = {}) {
  const keys = await readStoredApiKeys();
  const filtered = Object.fromEntries(
    Object.entries(keys).filter(([, value]) => typeof value === "string" && value.trim())
  );
  if (Object.keys(filtered).length === 0) {
    return headers;
  }
  return {
    ...headers,
    "X-GL-API-KEYS": btoa(JSON.stringify(filtered)),
  };
}

// License headers for cloud-library calls. The desktop license carries the user's
// key + email; the backend forwards them to the WordPress plugin for auth/scoping.
async function getLicenseHeaders() {
  try {
    const info = await window.electronAPI?.getLicenseInfo?.();
    const headers = {};
    if (info?.licenseKey) headers["X-GL-License-Key"] = info.licenseKey;
    if (info?.email) headers["X-GL-Email"] = info.email;
    return headers;
  } catch {
    return {};
  }
}

// FastAPI's error `detail` can be a string, or (for validation errors) an array of
// {msg, loc, ...} objects. Flatten it to a readable message instead of "[object Object]".
function extractErrorDetail(detail) {
  if (!detail) return null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (typeof d === "string" ? d : (d?.msg || d?.message || JSON.stringify(d))))
      .filter(Boolean)
      .join("; ");
  }
  if (typeof detail === "object") return detail.msg || detail.message || JSON.stringify(detail);
  return String(detail);
}

// --- Canvas write tracking -------------------------------------------------
// A board refresh reads the whole element set and replaces local state with it.
// If that read lands while one of this client's own card writes is still in
// flight, the server answers with the PRE-edit row and the canvas visibly
// "undoes" the text you just typed or the card you just moved — and the edit is
// gone for good, because its save already left the queue. So every canvas write
// registers here, and the refresh path waits for them and keeps the local copy
// of any card still being written.
const CANVAS_WRITE_PATH = /^\/moodboards\/[^/]+\/(elements|arrows|media\/place)/;
const CANVAS_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
let canvasWritesInFlightCount = 0;
const canvasWriteIds = new Map(); // element/arrow id -> number of writes in flight
let canvasWriteSettleWaiters = [];

function canvasWriteIdFromPath(path) {
  // /moodboards/{board}/elements/{id}[/html] and the arrows equivalent.
  const match = path.match(/^\/moodboards\/[^/]+\/(?:elements|arrows)\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function beginCanvasWrite(path) {
  canvasWritesInFlightCount += 1;
  const id = canvasWriteIdFromPath(path);
  if (id) canvasWriteIds.set(id, (canvasWriteIds.get(id) || 0) + 1);
  return () => {
    canvasWritesInFlightCount = Math.max(0, canvasWritesInFlightCount - 1);
    if (id) {
      const remaining = (canvasWriteIds.get(id) || 1) - 1;
      if (remaining > 0) canvasWriteIds.set(id, remaining);
      else canvasWriteIds.delete(id);
    }
    if (canvasWritesInFlightCount === 0 && canvasWriteSettleWaiters.length) {
      const waiters = canvasWriteSettleWaiters;
      canvasWriteSettleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
}

/** Ids of cards with a write in flight right now — their local copy is newer than the server's. */
export function canvasWriteIdsInFlight() {
  return new Set(canvasWriteIds.keys());
}

/** Resolve once no canvas write is in flight (or after `timeoutMs`, so a hung request can't block refreshes). */
export function settleCanvasWrites(timeoutMs = 4000) {
  if (canvasWritesInFlightCount === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    canvasWriteSettleWaiters.push(finish);
    setTimeout(finish, timeoutMs);
  });
}

// While the open board is a shared board this machine only VIEWS, canvas
// writes are refused before they touch the network (the backend refuses them
// too — this just turns a request/rollback round-trip into an instant,
// friendly error). Set by the collab store; null for everyone else.
let readOnlyCollabBoard = null;
export function _setReadOnlyCollabBoard(boardId) {
  readOnlyCollabBoard = boardId || null;
}

async function request(path, options = {}, _retries = 0, _opId = null) {
  const method = (options.method || "GET").toUpperCase();
  if (
    readOnlyCollabBoard &&
    CANVAS_WRITE_METHODS.has(method) &&
    CANVAS_WRITE_PATH.test(path) &&
    path.startsWith(`/moodboards/${readOnlyCollabBoard}/`)
  ) {
    const viewerError = new Error(
      "You're a viewer on this shared board — editing is disabled."
    );
    viewerError.status = 403;
    viewerError.path = path;
    throw viewerError;
  }
  const endCanvasWrite =
    CANVAS_WRITE_METHODS.has(method) && CANVAS_WRITE_PATH.test(path) ? beginCanvasWrite(path) : null;
  const opId = _opId || (IDEMPOTENT_METHODS.has(method) ? newOpId() : null);
  try {
    // NOTE: headers must be set AFTER spreading options, otherwise an options.headers
    // (e.g. cloud license headers) would clobber the merged headers and drop
    // Content-Type: application/json — which makes JSON-body POSTs fail to parse.
    const res = await fetch(`${API}${path}`, {
      ...options,
      headers: await withRuntimeApiKeyHeaders({
        "Content-Type": "application/json",
        "X-GL-Client-Id": CLIENT_ID,
        ...(opId ? { "X-GL-Op-Id": opId } : {}),
        ...options.headers,
      }),
    });
    // Retry on gateway errors while the desktop backend is still warming up.
    if (STARTUP_RETRY_STATUS_CODES.has(res.status) && _retries < STARTUP_RETRY_LIMIT) {
      await new Promise((r) => setTimeout(r, STARTUP_RETRY_DELAY_MS));
      return request(path, options, _retries + 1, opId);
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      const requestError = new Error(extractErrorDetail(err.detail) || "Request failed");
      requestError.status = res.status;
      requestError.path = path;
      if (res.status === 423 && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("gl:folder-state-invalidated", { detail: { path } }));
      }
      throw requestError;
    }
    return res.json();
  } catch (err) {
    if (err?.name === "AbortError") {
      throw err;
    }
    if (err instanceof TypeError && _retries < STARTUP_RETRY_LIMIT) {
      // The dangerous retry: the request may well have been APPLIED and only
      // its response lost. Same op id, so the backend replays its receipt
      // instead of doing the work twice.
      await new Promise((r) => setTimeout(r, STARTUP_RETRY_DELAY_MS));
      return request(path, options, _retries + 1, opId);
    }
    if (err instanceof TypeError) {
      throw new Error("Fetch failed. The local backend may still be starting.");
    }
    throw err;
  } finally {
    endCanvasWrite?.();
  }
}

export const api = {
  // Moodboards
  listMoodboards: () => request("/moodboards"),
  getCurrentMoodboard: () => request("/moodboards/current"),
  setCurrentMoodboard: (id) => request("/moodboards/current", { method: "PUT", body: JSON.stringify({ id }) }),
  createMoodboard: (name, folderPath = null) =>
    request("/moodboards", { method: "POST", body: JSON.stringify({ name, folder_path: folderPath || undefined }) }),
  importBoardFolder: (path, onIdCollision = null) =>
    request("/board-folders/import", {
      method: "POST",
      body: JSON.stringify({ path, on_id_collision: onIdCollision || undefined }),
    }),
  getMoodboard: (id) => request(`/moodboards/${id}`),
  updateMoodboard: (id, data) => request(`/moodboards/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  reorderMoodboards: (items) => request("/moodboards/reorder", { method: "POST", body: JSON.stringify({ items }) }),
  // Board tags (the Boards panel's chips): a tag is { id, name, color }; a board carries tag ids in `tags`.
  listBoardTags: () => request("/board-tags"),
  createBoardTag: (name, color) => request("/board-tags", { method: "POST", body: JSON.stringify({ name, color }) }),
  updateBoardTag: (id, data) => request(`/board-tags/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteBoardTag: (id) => request(`/board-tags/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setBoardTags: (id, tags) => request(`/moodboards/${encodeURIComponent(id)}/tags`, { method: "PUT", body: JSON.stringify({ tags }) }),
  // What each top-level board is about (name, sub-boards, card text, previews, sig) — Sort with AI reads these.
  getBoardDigests: () => request("/board-digests"),
  // Search by picture: every picture card (with `indexed`), and the CLIP vectors kept for them.
  listIndexPictures: (model) => request(`/picture-index/pictures?model=${encodeURIComponent(model)}`),
  loadPictureVectors: (model) => request(`/picture-index/vectors?model=${encodeURIComponent(model)}`),
  savePictureVectors: (model, items) => request("/picture-index/vectors", { method: "POST", body: JSON.stringify({ model, items }) }),
  deleteMoodboard: (id, deleteFolder = false, force = false) =>
    request(
      `/moodboards/${id}?delete_folder=${deleteFolder ? "true" : "false"}${force ? "&force=true" : ""}`,
      { method: "DELETE" }
    ),
  duplicateMoodboard: (id) => request(`/moodboards/${id}/duplicate`, { method: "POST" }),
  // Board archive: a board (+ its sub-boards) zipped out of the list, and back.
  // Archive / restore return a job; poll it (or the list, which carries jobs too).
  getBoardArchiveInfo: (id) => request(`/moodboards/${id}/archive-info`),
  archiveBoard: (id) => request(`/moodboards/${id}/archive`, { method: "POST" }),
  listBoardArchives: () => request("/board-archives"),
  restoreBoardArchive: (archiveId) => request(`/board-archives/${archiveId}/restore`, { method: "POST" }),
  deleteBoardArchive: (archiveId) => request(`/board-archives/${archiveId}`, { method: "DELETE" }),
  cancelBoardArchiveJob: (jobId) => request(`/board-archive-jobs/${jobId}/cancel`, { method: "POST" }),
  getConnectedFolder: (id) => request(`/moodboards/${id}/connected-folder`),
  updateConnectedFolder: (id, connectedMediaDir, options = {}) =>
    request(`/moodboards/${id}/connected-folder`, {
      method: "PUT",
      body: JSON.stringify({
        connected_media_dir: connectedMediaDir,
        existing_files: options.existingFiles || undefined,
        destination_files: options.destinationFiles || undefined,
      }),
    }),
  scanBoardFolder: (id) => request(`/moodboards/${id}/folder-scan`),
  inspectBoardFolder: (path) => request(`/board-folders/inspect?path=${encodeURIComponent(path)}`),
  reconnectBoardFolder: (id, path) =>
    request(`/moodboards/${id}/reconnect-folder`, { method: "POST", body: JSON.stringify({ path }) }),
  recoverBoardFolderFromCache: (id) =>
    request(`/moodboards/${id}/recover-folder-from-cache`, { method: "POST" }),
  getBoardFolderState: (id) => request(`/moodboards/${id}/folder-state`),
  makeBoardSelfContained: (id) =>
    request(`/moodboards/${id}/make-self-contained`, { method: "POST" }),
  // Per-board agent memory file (the AI terminal's notes, memory/agent-memory.md).
  getAgentMemory: (id) => request(`/moodboards/${id}/agent-memory`),
  ensureAgentMemory: (id) => request(`/moodboards/${id}/agent-memory/ensure`, { method: "POST" }),
  saveAgentMemory: (id, content) =>
    request(`/moodboards/${id}/agent-memory`, { method: "PUT", body: JSON.stringify({ content }) }),
  // Copy a file from an arbitrary local folder (a Folder card) into the board
  // media folder; returns the canvas media descriptor (type/url/thumbnail/…).
  importLocalFile: (id, path) =>
    request(`/moodboards/${id}/import-local`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  // Copy or unpack an entire local folder into the board media folder.
  // mode "import" (default) → copy as a named subfolder, returns { folder_name };
  // mode "canvas" → unpack (subfolders copied in, top-level files placed as
  // cards), returns { items: [descriptor…] }.
  importLocalFolder: (id, path, mode = "import") =>
    request(`/moodboards/${id}/import-local-folder`, {
      method: "POST",
      body: JSON.stringify({ path, mode }),
    }),
  // Astro site cards (desktop): a board folder's Astro project run with its own `astro dev`.
  // status → { state: off|install|starting|live|failed|oldnode, running: {url, pid}, log?: {offset, route, error}, probe? };
  // `since` is a byte offset into Astro's dev log (-1 = from now on), `probe` a route the server GETs.
  astroStatus: (id, folder, { since, probe } = {}) => {
    const q = new URLSearchParams({ folder });
    if (since != null) q.set("since", String(since));
    if (probe) q.set("probe", probe);
    return request(`/moodboards/${id}/astro/status?${q}`);
  },
  astroStart: (id, folder) => request(`/moodboards/${id}/astro/start`, { method: "POST", body: JSON.stringify({ folder }) }),
  astroStop: (id, folder) => request(`/moodboards/${id}/astro/stop`, { method: "POST", body: JSON.stringify({ folder }) }),
  astroRoutes: (id, folder) => request(`/moodboards/${id}/astro/routes?${new URLSearchParams({ folder })}`),
  // the page's height at each width (the app's browser measures it): { widths, heights }
  astroMeasure: (id, folder, route, widths) => request(`/moodboards/${id}/astro/measure?${new URLSearchParams({ folder, route: route || "/", widths: widths.join(",") })}`),
  astroSource: (id, folder, file, line) => request(`/moodboards/${id}/astro/source?${new URLSearchParams({ folder, file, line: String(line || 1) })}`),
  astroProjects: (id) => request(`/moodboards/${id}/astro/projects`),
  astroInspectLocal: (path) => request(`/astro/inspect-local?${new URLSearchParams({ path })}`),
  astroImport: (id, path) => request(`/moodboards/${id}/astro/import`, { method: "POST", body: JSON.stringify({ path }) }),
  // Lightweight board info for sub-board cards: { id, name, parent_id,
  // element_count, thumbnail_url }.
  getMoodboardSummary: (id) => request(`/moodboards/${id}/summary`),
  // Create a child board and move the given elements (media + arrows) into it;
  // returns { board, moved_element_ids, moved_arrow_ids, removed_arrow_ids }.
  createSubBoard: (id, payload) =>
    request(`/moodboards/${id}/sub-boards`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  // Move elements to another existing board (used by Create Sub Board undo).
  moveElements: (id, payload) =>
    request(`/moodboards/${id}/move-elements`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  // Move cards' media OUT of the board and into an asset library section. The
  // files travel and the cards are DELETED — a library has nowhere to keep a
  // card's position or size. payload: {library_id, section|new_section, element_ids}.
  moveElementsToLibrary: (id, payload) =>
    request(`/moodboards/${id}/move-elements-to-library`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  // Folder-drop "Put as Sub Board": create a child board with the folder's
  // media laid out as cards; returns { board, created_elements, truncated }.
  importFolderAsSubBoard: (id, path, name = null) =>
    request(`/moodboards/${id}/folder-sub-board`, {
      method: "POST",
      body: JSON.stringify(name ? { path, name } : { path }),
    }),
  // Unzip a .zip that already lives in the board media folder. mode "reference"
  // → { folder_path, folder_name }; mode "canvas" → { items: [descriptor…] };
  // mode "subboard" → { board, truncated } (child board built from the archive).
  unzipArchive: (id, filename, mode = "reference") =>
    request(`/moodboards/${id}/unzip`, {
      method: "POST",
      body: JSON.stringify({ filename, mode }),
    }),

  // Elements
  getMoodboardRefreshRevision: (mbId) => request(`/moodboards/${mbId}/refresh-revision`),
  getMoodboardChanges: (mbId, since = 0, limit = 100) =>
    request(`/moodboards/${mbId}/changes?since=${encodeURIComponent(since)}&limit=${encodeURIComponent(limit)}`),
  listElements: (mbId) => request(`/moodboards/${mbId}/elements`),
  createElement: (mbId, data) => request(`/moodboards/${mbId}/elements`, { method: "POST", body: JSON.stringify(data) }),
  placeMediaOnCanvas: (mbId, data) => request(`/moodboards/${mbId}/media/place`, { method: "POST", body: JSON.stringify(data) }),
  // Folder-merge conflicts: durable, so they survive a restart and can be
  // resolved long after the sync that produced them.
  listSyncConflicts: (mbId) => request(`/moodboards/${mbId}/sync-conflicts`),
  resolveSyncConflict: (mbId, conflictId, resolution) =>
    request(`/moodboards/${mbId}/sync-conflicts/${conflictId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution }),
    }),
  getElement: (mbId, elId) => request(`/moodboards/${mbId}/elements/${elId}`),
  // Live: agents shown on the board like collaborators (backend/agent_live.py)
  getAgentLive: () => request("/agent-live"),
  setAgentLive: (sessionId, live, name) => request(`/agent-live/${encodeURIComponent(sessionId)}`, { method: "PUT", body: JSON.stringify({ live, ...(name ? { name } : {}) }) }),
  updateElement: (mbId, elId, data) => request(`/moodboards/${mbId}/elements/${elId}`, { method: "PUT", body: JSON.stringify(data) }),
  bulkUpdateElements: (mbId, elements) => request(`/moodboards/${mbId}/elements`, { method: "PUT", body: JSON.stringify({ elements }) }),
  deleteElement: (mbId, elId) => request(`/moodboards/${mbId}/elements/${elId}`, { method: "DELETE" }),
  bulkDeleteElements: (mbId, ids) => request(`/moodboards/${mbId}/elements/bulk-delete`, { method: "POST", body: JSON.stringify({ ids }) }),
  // Low-res preview generation for heavy boards (many local images).
  generatePreviews: (mbId) => request(`/moodboards/${mbId}/generate-previews`, { method: "POST" }),
  previewStatus: (mbId) => request(`/moodboards/${mbId}/preview-status`),
  // Write the body of an HTML element to its on-disk file. `kind` is a legacy
  // no-op (HTML is always saved to the element's flat htmlUrl).
  // `expectedHtmlVersion` = data.htmlVersion of the copy this content was built
  // from. Sent by the HTML editor so a save cannot silently erase an agent's
  // in-place file edit (409 instead). Omitted = write unconditionally.
  putElementHtml: (mbId, elId, html, kind = null, expectedHtmlVersion = null) =>
    request(`/moodboards/${mbId}/elements/${elId}/html`, {
      method: "PUT",
      body: JSON.stringify({
        html,
        ...(kind ? { kind } : {}),
        ...(expectedHtmlVersion != null ? { expected_html_version: expectedHtmlVersion } : {}),
      }),
    }),
  // Overwrite a markdown element's on-disk .md file with new content.
  putElementMarkdown: (mbId, elId, markdown) =>
    request(`/moodboards/${mbId}/elements/${elId}/markdown`, {
      method: "PUT",
      body: JSON.stringify({ markdown }),
    }),
  // Overwrite a csv element's on-disk .csv file (table editor save).
  // Rename a csv element's file (and title); the .csv extension is kept.
  renameElementCsv: (mbId, elId, name) =>
    request(`/moodboards/${mbId}/elements/${elId}/csv/name`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),
  putElementCsv: (mbId, elId, csv, header = null) =>
    request(`/moodboards/${mbId}/elements/${elId}/csv`, {
      method: "PUT",
      body: JSON.stringify({ csv, ...(header == null ? {} : { header }) }),
    }),

  // AI Social Trends frames (data.social.kind "trends") are laid out by the
  // backend; the canvas calls these after a drag, a delete or a frame menu pick.
  socialTrendsLayout: (mbId, frameId) =>
    request(`/moodboards/${mbId}/social/trends/${frameId}/layout`, { method: "POST", body: JSON.stringify({}) }),
  socialTrendsLook: (mbId, frameId, look) =>
    request(`/moodboards/${mbId}/social/trends/${frameId}/look`, { method: "PUT", body: JSON.stringify({ look }) }),
  // → { copy }: a plain copy of the card at x,y; the original goes back to its place.
  socialTrendsTakeOut: (mbId, frameId, cardId, x, y) =>
    request(`/moodboards/${mbId}/social/trends/${frameId}/items/${cardId}/take-out`, {
      method: "POST",
      body: JSON.stringify({ x, y }),
    }),
  // Records "not interested", removes the card and lays the frame out again.
  socialTrendsHide: (mbId, frameId, cardId) =>
    request(`/moodboards/${mbId}/social/trends/${frameId}/items/${cardId}/hide`, { method: "POST", body: JSON.stringify({}) }),

  // AI Social posting: the Posts frame (data.social.kind "posts") and its post cards
  // (data.social.kind "post"). Every change goes through these; the backend lays the
  // frame out again and the canvas reads the result back.
  // → { accounts, connections }: each account posts through one of the posting connections
  socialAccounts: () => request(`/social/accounts`),
  socialPutAccounts: (accounts) => request(`/social/accounts`, { method: "PUT", body: JSON.stringify({ accounts }) }),
  socialAllPosts: (limit = 50) => request(`/social/posts?limit=${limit}`),
  socialPostsCreate: (mbId, body = {}) =>
    request(`/moodboards/${mbId}/social/posts`, { method: "POST", body: JSON.stringify(body) }),
  socialPostsGet: (mbId, frameId) => request(`/moodboards/${mbId}/social/posts/${frameId}`),
  socialPostsLayout: (mbId, frameId) =>
    request(`/moodboards/${mbId}/social/posts/${frameId}/layout`, { method: "POST", body: JSON.stringify({}) }),
  socialPostsLook: (mbId, frameId, look) =>
    request(`/moodboards/${mbId}/social/posts/${frameId}/look`, { method: "PUT", body: JSON.stringify({ look }) }),
  socialPostsSettings: (mbId, frameId, settings) =>
    request(`/moodboards/${mbId}/social/posts/${frameId}/settings`, { method: "PUT", body: JSON.stringify(settings) }),
  // → { card_id, post, problems }
  socialPostAdd: (mbId, frameId, body) =>
    request(`/moodboards/${mbId}/social/posts/${frameId}/items`, { method: "POST", body: JSON.stringify(body) }),
  socialPostEdit: (mbId, frameId, cardId, body) =>
    request(`/moodboards/${mbId}/social/posts/${frameId}/items/${cardId}`, { method: "PUT", body: JSON.stringify(body) }),
  // action: approve | cancel | unschedule | retry | post-now | next-slot | remove
  socialPostAction: (mbId, frameId, cardId, action, body = {}) =>
    request(`/moodboards/${mbId}/social/posts/${frameId}/items/${cardId}/${action}`, { method: "POST", body: JSON.stringify(body) }),
  // Post it myself: the post's files in a folder of their own, shown selected (desktop); its words and files to Telegram
  socialPostFiles: (mbId, frameId, cardId, reveal = true) =>
    request(`/moodboards/${mbId}/social/posts/${frameId}/items/${cardId}/files`, { method: "POST", body: JSON.stringify({ reveal }) }),
  // Send to ▸ Social Post (nothing scheduled): these board files (/media/…) in a folder of their own, shown selected. Desktop only.
  socialFiles: (mbId, urls, title = "") =>
    request(`/moodboards/${mbId}/social/files`, { method: "POST", body: JSON.stringify({ urls, title }) }),
  socialPostSendToPhone: (mbId, frameId, cardId) =>
    request(`/moodboards/${mbId}/social/posts/${frameId}/items/${cardId}/send-to-phone`, { method: "POST", body: JSON.stringify({}) }),

  // Connections (Settings ▸ Social ▸ Accounts): named accounts and sites for posting and Support. Keys go in, never out.
  connectionsList: (type) => request(`/connections${type ? `?type=${encodeURIComponent(type)}` : ""}`),
  connectionCreate: (body) => request(`/connections`, { method: "POST", body: JSON.stringify(body) }),
  connectionUpdate: (id, body) => request(`/connections/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  connectionDelete: (id) => request(`/connections/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // → { ok, who?, channels?, abilities?, error? }
  connectionTest: (id) => request(`/connections/${encodeURIComponent(id)}/test`, { method: "POST", body: JSON.stringify({}) }),

  // WordPress export
  listWordpressSites: () => request("/wordpress/sites"),
  addWordpressSite: (site) => request("/wordpress/sites", { method: "POST", body: JSON.stringify(site) }),
  removeWordpressSite: (siteId) => request(`/wordpress/sites/${encodeURIComponent(siteId)}`, { method: "DELETE" }),
  testWordpressSite: (siteId) => request(`/wordpress/sites/${encodeURIComponent(siteId)}/test`, { method: "POST" }),
  listWordpressPages: (siteId, { target = "page", search = "" } = {}) => {
    const params = new URLSearchParams({ target });
    if (search) params.set("search", search);
    return request(`/wordpress/sites/${encodeURIComponent(siteId)}/pages?${params.toString()}`);
  },
  generateWordpressCode: (payload) => request("/wordpress/generate-code", { method: "POST", body: JSON.stringify(payload) }),
  exportWordpress: (payload) => request("/wordpress/export", { method: "POST", body: JSON.stringify(payload) }),

  // Bricks Builder export (shares the wordpress_sites credentials)
  probeBricksSite: (siteId) => request(`/bricks/sites/${encodeURIComponent(siteId)}/probe`, { method: "POST" }),
  listBricksPages: (siteId, { target = "page", search = "" } = {}) => {
    const params = new URLSearchParams({ target });
    if (search) params.set("search", search);
    return request(`/bricks/sites/${encodeURIComponent(siteId)}/pages?${params.toString()}`);
  },
  exportBricks: (payload) => request("/bricks/export", { method: "POST", body: JSON.stringify(payload) }),
  generateBricksFile: (payload) => request("/bricks/generate-file", { method: "POST", body: JSON.stringify(payload) }),
  previewBricks: (payload) => request("/bricks/preview", { method: "POST", body: JSON.stringify(payload) }),
  undoBricksPush: (payload) => request("/bricks/undo", { method: "POST", body: JSON.stringify(payload) }),

  // Frames
  createFrame: (mbId, data) => request(`/moodboards/${mbId}/frames`, { method: "POST", body: JSON.stringify(data) }),
  getFrame: (mbId, frameId) => request(`/moodboards/${mbId}/frames/${frameId}`),
  updateFrame: (mbId, frameId, data) => request(`/moodboards/${mbId}/frames/${frameId}`, { method: "PUT", body: JSON.stringify(data) }),

  // Pipelines
  pipelineRunPrompt: (mbId, frameId) => request(`/moodboards/${mbId}/pipelines/${frameId}/run-prompt`, { method: "POST" }),
  // A pipeline's Compare step: rank what the steps wired into it made (backend/compare.py). With an AI key it answers
  // the ranking (written into the step); without one, judge "agent" and the pictures for an agent to rank.
  compareStep: (mbId, stepId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/compare`, { method: "POST", body: JSON.stringify({ step: stepId, write: true }) }),
  resetPipelineRun: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/pipelines/${encodeURIComponent(frameId)}/reset-run`, { method: "POST" }),
  listPipelineScheduleHistory: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/pipelines/${encodeURIComponent(frameId)}/schedule-history`),
  savePipelineScheduleHistory: (mbId, frameId, data = {}) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/pipelines/${encodeURIComponent(frameId)}/schedule-history`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  placePipelineScheduleHistory: (mbId, frameId, historyId, data = {}) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/pipelines/${encodeURIComponent(frameId)}/schedule-history/${encodeURIComponent(historyId)}/place`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Scheduled tasks: a schedule on a board task frame or a pipeline frame.
  // The desktop app's scheduler runs them (see backend/schedules.py).
  listSchedules: (device) => request(device ? `/schedules?device=${encodeURIComponent(device)}` : "/schedules"),
  createSchedule: (mbId, data) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules`, { method: "POST", body: JSON.stringify(data) }),
  updateSchedule: (mbId, frameId, data) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteSchedule: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}`, { method: "DELETE" }),
  skipScheduleRun: (mbId, frameId, data = {}) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/skip`, { method: "POST", body: JSON.stringify(data) }),
  listScheduleRuns: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/runs`),
  getScheduleMemory: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/memory`),
  putScheduleMemory: (mbId, frameId, content) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/memory`, { method: "PUT", body: JSON.stringify({ content }) }),
  // A task's webhook: its public URL lives on the user's Cloudflare Share worker
  // and/or a GreenLight server (backend/schedule_hooks.py).
  listHookRelays: () => request("/schedules/hook-relays"),
  getScheduleHook: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/hook`),
  setScheduleHook: (mbId, frameId, data) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/hook`, { method: "POST", body: JSON.stringify(data) }),
  deleteScheduleHook: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/hook`, { method: "DELETE" }),
  // On a GreenLight Dash Server: run / stop a task made there, read a run's log.
  runScheduleNow: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/run-now`, { method: "POST" }),
  stopScheduleRunHere: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/stop`, { method: "POST" }),
  // ... and let a task an agent made run its agent here on its timer.
  allowScheduleAgentRuns: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/allow`, { method: "POST" }),
  // Desktop tasks asking this server to run them while their computer is off;
  // only the signed-in owner answers.
  listHookRunRequests: () => request("/hook-relay/requests"),
  answerHookRunRequest: (hookId, allow) =>
    request(`/hook-relay/hooks/${encodeURIComponent(hookId)}/approve`, { method: "POST", body: JSON.stringify({ allow }) }),
  getScheduleRunLog: (mbId, frameId, runId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/runs/${encodeURIComponent(runId)}/log`),
  testScheduleHook: (mbId, frameId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/schedules/${encodeURIComponent(frameId)}/hook/test`, { method: "POST" }),

  // Arrows
  listArrows: (mbId) => request(`/moodboards/${mbId}/arrows`),
  createArrow: (mbId, data) => request(`/moodboards/${mbId}/arrows`, { method: "POST", body: JSON.stringify(data) }),
  updateArrow: (mbId, arrowId, data) => request(`/moodboards/${mbId}/arrows/${arrowId}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteArrow: (mbId, arrowId) => request(`/moodboards/${mbId}/arrows/${arrowId}`, { method: "DELETE" }),

  // URL parsing & media
  parseURL: (url, boardId = null) => request("/parse-url", { method: "POST", body: JSON.stringify({ url, board_id: boardId }) }),
  // Scrape all images >= minWidth px wide from a web page into board media.
  parseWebsiteImages: async (url, minWidth = 500, boardId = null) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      return await request("/parse-website-images", {
        method: "POST",
        body: JSON.stringify({ url, min_width: minWidth, board_id: boardId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },
  downloadMedia: async (url, boardId = null, title = null) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 min timeout for video downloads
    try {
      const body = { url };
      if (boardId) body.board_id = boardId;
      if (title) body.title = title;
      return await request("/download", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Extract audio from YouTube/YouTube Music URL
  extractAudio: async (url, boardId = null, title = null) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    try {
      const body = { url };
      if (boardId) body.board_id = boardId;
      if (title) body.title = title;
      return await request("/extract-audio", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Extract audio from a local video file. opts.folder files the track in that
  // subfolder of the board media folder instead of its root.
  extractAudioLocal: async (videoPath, boardId = null, title = null, opts = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const body = { video_path: videoPath };
      if (boardId) body.board_id = boardId;
      if (title) body.title = title;
      if (opts.folder) body.folder = opts.folder;
      return await request("/extract-audio-local", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Capture frame from YouTube video server-side
  captureFrame: async (url, time = 5.0, boardId = null, title = null) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout
    try {
      const body = { url, time };
      if (boardId) body.board_id = boardId;
      if (title) body.title = title;
      return await request("/capture-frame", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Fetch a YouTube video's thumbnail server-side and save it into the board.
  getYouTubeThumbnail: async (url, boardId = null, title = null) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
    try {
      const body = { url };
      if (boardId) body.board_id = boardId;
      if (title) body.title = title;
      return await request("/youtube-thumbnail", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Detect scenes in a local video and lay their frames into a grid frame.
  // mode: "single" (middle frame per scene) | "first_last" (start+end per scene).
  extractSceneFrames: async (filePath, boardId, { mode = "single", x = 0, y = 0 } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 min
    try {
      return await request(`/moodboards/${boardId}/scene-frames`, {
        method: "POST",
        body: JSON.stringify({ file_path: filePath, mode, x, y }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Build a "Storyboard for ..." scaffold: nested Scene frames (first/central/last
  // frames + timecode note) plus a single agent-prompt note. No model runs.
  prepareStoryboardTemplate: async (filePath, boardId, { x = 0, y = 0, createAgentNote = true } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 min
    try {
      return await request(`/moodboards/${boardId}/storyboard-template`, {
        method: "POST",
        body: JSON.stringify({ file_path: filePath, x, y, create_agent_note: createAgentNote }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Build a Storyboard PIPELINE (container + Starter + one Step per scene).
  buildStoryboardPipeline: async (filePath, boardId, { x = 0, y = 0, title = null } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 min
    try {
      return await request(`/moodboards/${boardId}/storyboard-pipeline`, {
        method: "POST",
        body: JSON.stringify({ file_path: filePath, x, y, ...(title ? { title } : {}) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Trim video/audio into a NEW file beside the source (never overwrites it).
  // `outName` optionally names that file; the source extension always wins.
  trimMedia: async (filePath, start, end, boardId = null, outName = null) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const body = { file_path: filePath, start, end };
      if (boardId) body.board_id = boardId;
      if (outName) body.out_name = outName;
      return await request("/trim-media", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Crop a video to a region (fractions of the frame, 0..1) into a NEW file
  // beside the source (never overwrites it). Re-encodes, so the timeout is long.
  cropMedia: async (filePath, rect, boardId = null, outName = null) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000); // 10 min
    try {
      const body = { file_path: filePath, x: rect.x, y: rect.y, w: rect.w, h: rect.h };
      if (boardId) body.board_id = boardId;
      if (outName) body.out_name = outName;
      return await request("/crop-media", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  videoEdit: async (filePath, edits, boardId = null) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    try {
      const body = { file_path: filePath, ...edits };
      if (boardId) body.board_id = boardId;
      return await request("/video-edit", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  convertImage: async (filePath, format, boardId = null) => {
    const body = { file_path: filePath, format };
    if (boardId) body.board_id = boardId;
    return await request("/convert-image", {
      method: "POST",
      body: JSON.stringify(body),
    });
  },

  convertVideo: async (filePath, format, encoder = null, boardId = null, removeAudio = false) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);
    try {
      const body = removeAudio ? { file_path: filePath, remove_audio: true } : { file_path: filePath, format };
      if (encoder) body.encoder = encoder;
      if (boardId) body.board_id = boardId;
      return await request("/convert-video", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Frame rate of a /media/ video — drives the Speed Curve judder check.
  // Resolves to null (never throws) so a probe failure just hides the offer.
  getVideoFps: async (path) => {
    try {
      const res = await request(`/video-fps?path=${encodeURIComponent(path)}`);
      return Number.isFinite(res?.fps) ? res.fps : null;
    } catch {
      return null;
    }
  },

  // Hand the RIFE worker's encoded H.264 stream to ffmpeg for muxing into a
  // real file beside the source (audio is copied from the original).
  // Direct fetch, NOT request(): request() always sets
  // "Content-Type: application/json", which overrides the multipart boundary
  // the browser generates — the server then parses zero fields and answers 422
  // "field required" for every one of them. Same pattern as uploadFile/uploadHdri.
  finalizeInterpolatedVideo: async (boardId, { stream, sourcePath, fps, factor }) => {
    const form = new FormData();
    form.append("file", new Blob([stream], { type: "video/h264" }), "interpolated.h264");
    form.append("source_path", sourcePath);
    form.append("fps", String(fps));
    form.append("factor", String(factor));
    const res = await fetch(`${API}/moodboards/${boardId}/video-interpolate/finalize`, {
      method: "POST",
      body: form,
      headers: await withRuntimeApiKeyHeaders({ "X-GL-Client-Id": CLIENT_ID }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(extractErrorDetail(err.detail) || "Could not save the interpolated video");
    }
    return res.json();
  },

  // Upload
  uploadFile: async (file, boardId = null, opts = {}) => {
    const form = new FormData();
    form.append("file", file);
    const params = new URLSearchParams();
    if (boardId) params.set("board_id", boardId);
    // When deferred, the backend skips proxy/thumbnail generation for videos and
    // returns immediately with `derivatives_pending: true`. Generate them later
    // via generateVideoDerivatives() so the card can drop instantly.
    if (opts.deferDerivatives) params.set("defer_derivatives", "1");
    // Land the file in a named subfolder of the board media folder instead of
    // its root (e.g. "voices" for video editor voice takes).
    if (opts.folder) params.set("folder", opts.folder);
    let url = `${API}/upload`;
    const qs = params.toString();
    if (qs) url += `?${qs}`;
    const res = await fetch(url, { method: "POST", body: form, headers: await withRuntimeApiKeyHeaders() });
    if (!res.ok) throw new Error("Upload failed");
    return res.json();
  },

  // The user's own saved rigs, beside the ten built-ins in rigPresets.js.
  listRigPresets: () => request(`/rig-presets`),
  saveRigPreset: (name, rig) => request(`/rig-presets`, {
    method: "POST",
    body: JSON.stringify({ name, rig }),
  }),
  deleteRigPreset: (id) => request(`/rig-presets/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // Environment maps for the 3D Rig. NOT board-scoped: one rig lights the whole
  // project, and a board folder move would break a board-relative url.
  listHdri: () => request(`/hdri`),
  uploadHdri: async (file) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API}/hdri/upload`, {
      method: "POST", body: form, headers: await withRuntimeApiKeyHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Upload failed");
    }
    return res.json();
  },

  // Generate (or reuse) a video's proxy + thumbnail after a deferred upload.
  // Announced as `gl:video-derivatives-ready` once done: a clip the video editor
  // placed while these were still being made has none, and learns of them here.
  generateVideoDerivatives: async (boardId, filename) => {
    const result = await request(`/media/video-derivatives`, {
      method: "POST",
      body: JSON.stringify({ board_id: boardId, filename }),
    });
    if (result?.url && (result.proxy_url || result.thumbnail_url)) {
      window.dispatchEvent(new CustomEvent("gl:video-derivatives-ready", { detail: result }));
    }
    return result;
  },

  // Voice transcription
  // Pass { words: true } to get word-level timestamps for the transcript editor
  // ({ text, words:[{word,start,end}], language, duration }); otherwise returns { text }.
  // { verbatim: true } biases Whisper to keep filler words ("um", "uh") in the transcript.
  transcribeAudio: async (audioBlob, language = null, { words = false, verbatim = false, engine = null } = {}) => {
    const form = new FormData();
    form.append("file", audioBlob, "recording.webm");
    const params = new URLSearchParams();
    if (language) params.set("language", language);
    if (words) params.set("words", "1");
    if (verbatim) params.set("verbatim", "1");
    // a pinned engine ('local' | 'voicestudio' | 'openai' | 'wavespeed') — never silently another one
    if (engine) params.set("engine", engine);
    const qs = params.toString();
    const url = qs ? `${API}/ai/transcribe?${qs}` : `${API}/ai/transcribe`;
    const res = await fetch(url, { method: "POST", body: form, headers: await withRuntimeApiKeyHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Transcription failed");
    }
    return res.json();
  },

  // ── AI Shorts (PLANS/AI_SHORTS_PLAN.md §9) ──
  // Detection is a persistent background job, not a request: transcribing an
  // hour of speech and ranking it outlives any sane HTTP timeout, and the modal
  // has to survive being closed and reopened.
  aiShortsModels: () => request("/ai-shorts/models"),
  createAiShortsJob: (boardId, body) =>
    request(`/moodboards/${boardId}/ai-shorts/jobs`, { method: "POST", body: JSON.stringify(body) }),
  getAiShortsJob: (jobId) => request(`/ai-shorts/jobs/${jobId}`),
  cancelAiShortsJob: (jobId) => request(`/ai-shorts/jobs/${jobId}`, { method: "DELETE" }),
  listAiShortsJobs: (boardId, activeOnly = false) =>
    request(`/moodboards/${boardId}/ai-shorts/jobs${activeOnly ? "?active=true" : ""}`),

  // ── AI Reframe (PLANS/AI_REFRAME_PLAN.md §9) ──
  // Hybrid job: the server stops at 'awaiting_client' after scene cuts + frame
  // sampling; the modal's tracking worker PUTs the framing result back.
  aiReframeModels: () => request("/ai-reframe/models"),
  createAiReframeJob: (boardId, body) =>
    request(`/moodboards/${boardId}/ai-reframe/jobs`, { method: "POST", body: JSON.stringify(body) }),
  getAiReframeJob: (jobId) => request(`/ai-reframe/jobs/${jobId}`),
  cancelAiReframeJob: (jobId) => request(`/ai-reframe/jobs/${jobId}`, { method: "DELETE" }),
  putAiReframeResult: (jobId, body) =>
    request(`/ai-reframe/jobs/${jobId}/result`, { method: "PUT", body: JSON.stringify(body) }),
  listAiReframeJobs: (boardId, activeOnly = false) =>
    request(`/moodboards/${boardId}/ai-reframe/jobs${activeOnly ? "?active=true" : ""}`),

  // ── AI Beats (PLANS/AI_BEATS_PLAN.md §9) ──
  // Hybrid job: the server stops at 'awaiting_client' after extracting the trim
  // window as mono PCM WAV; the modal's detection worker PUTs the beat grid back.
  aiBeatsEngines: () => request("/ai-beats/engines"),
  createAiBeatsJob: (boardId, body) =>
    request(`/moodboards/${boardId}/ai-beats/jobs`, { method: "POST", body: JSON.stringify(body) }),
  getAiBeatsJob: (jobId) => request(`/ai-beats/jobs/${jobId}`),
  cancelAiBeatsJob: (jobId) => request(`/ai-beats/jobs/${jobId}`, { method: "DELETE" }),
  putAiBeatsResult: (jobId, body) =>
    request(`/ai-beats/jobs/${jobId}/result`, { method: "PUT", body: JSON.stringify(body) }),
  listAiBeatsJobs: (boardId, activeOnly = false) =>
    request(`/moodboards/${boardId}/ai-beats/jobs${activeOnly ? "?active=true" : ""}`),

  // Transcribe media that ALREADY lives on the server (a video or audio layer),
  // by /media-relative path. The backend extracts a compact speech track with
  // ffmpeg first, so unlike transcribeAudio() there is no 25MB upload ceiling —
  // this is the path every timeline layer should take. Same response shape.
  transcribeMedia: async (mediaPath, { language = null, words = false, verbatim = false, engine = null } = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900000); // extraction + Whisper on a long take
    try {
      return await request("/ai/transcribe-media", {
        method: "POST",
        body: JSON.stringify({ media_path: mediaPath, language, words, verbatim, engine }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Finalize a client-side face-mosaic render: uploads the video-only mp4 and
  // the backend remuxes the original file's audio track into it (stream copy).
  finalizeMosaicVideo: async (blob, sourcePath, boardId, title = null) => {
    const form = new FormData();
    form.append("file", blob, "mosaic.mp4");
    form.append("board_id", boardId);
    form.append("source_path", sourcePath);
    if (title) form.append("title", title);
    const res = await fetch(`${API}/mosaic-finalize`, {
      method: "POST",
      body: form,
      headers: await withRuntimeApiKeyHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Mosaic finalize failed");
    }
    return res.json();
  },

  // Media management. `boardId` lists that board in full (plus its ancestors
  // with `ancestors`, the rows the panel keeps expanded) and returns every other
  // board as a header-only stub — see list_media in backend/main.py. Omit it to
  // list the whole library, which is what a panel showing every board expanded
  // needs.
  listMedia: (boardId = null, { ancestors = false } = {}) => {
    if (!boardId) return request("/media/admin");
    const params = new URLSearchParams({ board_id: boardId });
    if (ancestors) params.set("ancestors", "1");
    return request(`/media/admin?${params.toString()}`);
  },
  // Reference folders: mint /media/ref/<token> prefixes for linked external files
  // (only for folders a canvas Folder card already references), and derive a
  // proxy/thumbnail for a linked video without copying anything into the board.
  resolveRefFolders: (paths) =>
    request("/media/ref-folders/resolve", { method: "POST", body: JSON.stringify({ paths }) }),
  deriveRefMedia: (path) =>
    request("/media/ref-folders/derive", { method: "POST", body: JSON.stringify({ path }) }),
  // COPIES linked files into a board's media folder, generating everything a
  // normal import gets (deduped name, proxy + thumbnail). Returns board media
  // descriptors; nothing is placed on the canvas.
  adoptRefMedia: (urls, boardId) =>
    request("/media/ref-folders/adopt", {
      method: "POST",
      body: JSON.stringify({ urls, board_id: boardId }),
    }),
  deleteMedia: (filePath) => request(`/media/admin/${filePath}`, { method: "DELETE" }),

  // Asset libraries (Sound / Assets / Music) — app-level media outside any
  // board. getLibrary returns ONE element of listMedia's board shape, so the
  // media panel renders it through the same tree.
  listLibraries: () => request("/libraries"),
  getLibrary: (libraryId) => request(`/libraries/${encodeURIComponent(libraryId)}`),
  uploadToLibrary: async (libraryId, file, folder = "") => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(
      `${API}/libraries/${encodeURIComponent(libraryId)}/upload?folder=${encodeURIComponent(folder)}`,
      { method: "POST", body: form, headers: await withRuntimeApiKeyHeaders() }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Upload failed");
    }
    return res.json();
  },
  importFolderToLibrary: (libraryId, payload) =>
    request(`/libraries/${encodeURIComponent(libraryId)}/import-folder`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  // Rename a section (a library's top-level folder) in place. Returns the path
  // it actually got — the name is sanitized and de-duped server-side.
  renameLibrarySection: (libraryId, path, name) =>
    request(`/libraries/${encodeURIComponent(libraryId)}/rename-section`, {
      method: "POST",
      body: JSON.stringify({ path, name }),
    }),
  deleteLibraryFile: (libraryId, path) =>
    request(`/libraries/${encodeURIComponent(libraryId)}/files/${path}`, { method: "DELETE" }),
  deleteLibraryFolder: (libraryId, path) =>
    request(`/libraries/${encodeURIComponent(libraryId)}/folders/${path}`, { method: "DELETE" }),
  getLibraryDownloadUrl: (libraryId, path = "") =>
    `${API}/libraries/${encodeURIComponent(libraryId)}/download?path=${encodeURIComponent(path)}`,
  // COPIES library files into a board's media folder and returns the new board
  // URLs. Nothing is placed on the canvas.
  adoptFromLibrary: (libraryId, paths, boardId) =>
    request(`/libraries/${encodeURIComponent(libraryId)}/adopt`, {
      method: "POST",
      body: JSON.stringify({ paths, board_id: boardId }),
    }),

  // Downloadable packs
  listAssetPacks: () => request("/asset-packs"),
  installAssetPack: (packId) =>
    request(`/asset-packs/${encodeURIComponent(packId)}/install`, { method: "POST" }),
  getAssetPackJob: (jobId) => request(`/asset-packs/jobs/${encodeURIComponent(jobId)}`),
  cancelAssetPackJob: (jobId) =>
    request(`/asset-packs/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" }),
  removeAssetPack: (packId) =>
    request(`/asset-packs/${encodeURIComponent(packId)}`, { method: "DELETE" }),
  getMediaBoardDownloadUrl: (boardId) => `${API}/media/admin/boards/${encodeURIComponent(boardId)}/download`,
  getExportBoardUrl: (boardId) => `${API}/moodboards/${encodeURIComponent(boardId)}/export`,
  importBoardArchive: async (boardId, file, mode = "replace") => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(
      `${API}/moodboards/${encodeURIComponent(boardId)}/import?mode=${encodeURIComponent(mode)}`,
      { method: "POST", body: form, headers: await withRuntimeApiKeyHeaders() }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Import failed");
    }
    return res.json();
  },

  // Share ▸ Sync with web (backend/web_sync.py). The servers ride in
  // X-GL-API-KEYS as GL_WEB_SERVERS (a JSON list) like every other key; `server`
  // on each call is one of their ids. check() can also test an address + token
  // before it is saved.
  webSyncCheck: (server, token) =>
    request("/web-sync/check", { method: "POST", body: JSON.stringify({ server, token }) }),
  webSyncServers: (localBoardId) =>
    request(`/web-sync/servers${localBoardId ? `?local_board=${encodeURIComponent(localBoardId)}` : ""}`),
  webSyncBoards: (server) =>
    request(`/web-sync/boards${server ? `?server=${encodeURIComponent(server)}` : ""}`),
  webSyncItems: (remoteBoardId, localBoardId, server) =>
    request(`/web-sync/boards/${encodeURIComponent(remoteBoardId)}/items?local_board=${encodeURIComponent(localBoardId)}${server ? `&server=${encodeURIComponent(server)}` : ""}`),
  webSyncPull: (payload) => request("/web-sync/pull", { method: "POST", body: JSON.stringify(payload) }),
  // The other direction: this board's items seen from the web's side, and the
  // push that sends the picked ones up. `remoteBoardId` omitted = a push to a
  // web board that doesn't exist yet, so everything counts as New.
  webSyncLocalItems: (localBoardId, remoteBoardId, server) =>
    request(`/web-sync/local-items?local_board=${encodeURIComponent(localBoardId)}${remoteBoardId ? `&remote_board=${encodeURIComponent(remoteBoardId)}` : ""}${server ? `&server=${encodeURIComponent(server)}` : ""}`),
  webSyncPush: (payload) => request("/web-sync/push", { method: "POST", body: JSON.stringify(payload) }),
  // Thumbnails need the token, which an <img> can't send — fetch through the
  // backend proxy and hand back an object URL (caller revokes it).
  webSyncMediaObjectUrl: async (path, signal, server) => {
    const url = `${API}/web-sync/media?path=${encodeURIComponent(path)}${server ? `&server=${encodeURIComponent(server)}` : ""}`;
    const res = await fetch(url, { headers: await withRuntimeApiKeyHeaders(), signal });
    if (!res.ok) throw new Error(`thumbnail ${res.status}`);
    return URL.createObjectURL(await res.blob());
  },

  // Pipeline Library (presets saved as self-contained .glpipe zips)
  listPipelinePresets: () => request("/pipelines/presets"),
  listPipelineCategories: () => request("/pipelines/categories"),
  getPipelinePresetThumbnailUrl: (presetId) => `${API}/pipelines/presets/${encodeURIComponent(presetId)}/thumbnail`,
  getPipelinePresetDownloadUrl: (presetId) => `${API}/pipelines/presets/${encodeURIComponent(presetId)}/download`,
  deletePipelinePreset: (presetId) => request(`/pipelines/presets/${encodeURIComponent(presetId)}`, { method: "DELETE" }),
  savePipelinePreset: (boardId, frameId, data) =>
    request(`/moodboards/${encodeURIComponent(boardId)}/pipelines/${encodeURIComponent(frameId)}/save-preset`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  // starterText (AI Workflows ▸ My workflows ▸ Run): the placed copy's Starter note says this instead
  importPipelinePreset: (boardId, presetId, position = null, starterText = null) =>
    request(`/moodboards/${encodeURIComponent(boardId)}/pipelines/import-preset`, {
      method: "POST",
      body: JSON.stringify({ preset_id: presetId, position, ...(starterText != null ? { starter_text: starterText } : {}) }),
    }),
  // what a local preset places: { steps: [{ name, role }], counts: { pictures, videos, notes, … }, starter: text | null }
  getPipelinePresetSummary: (presetId) => request(`/pipelines/presets/${encodeURIComponent(presetId)}/summary`),
  importPipelinePresetFile: async (boardId, file, position = null) => {
    const form = new FormData();
    form.append("file", file);
    if (position && typeof position.x === "number" && typeof position.y === "number") {
      form.append("position_x", String(position.x));
      form.append("position_y", String(position.y));
    }
    const res = await fetch(
      `${API}/moodboards/${encodeURIComponent(boardId)}/pipelines/import-preset-file`,
      { method: "POST", body: form, headers: await withRuntimeApiKeyHeaders() }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Pipeline import failed");
    }
    return res.json();
  },
  // Edit a local preset's metadata (title/description/category/tags/requirements/isPro/thumbnail).
  editPipelinePreset: (presetId, data) =>
    request(`/pipelines/presets/${encodeURIComponent(presetId)}/edit`, { method: "POST", body: JSON.stringify(data) }),

  // Pipeline Cloud Library (greenlightdash.pro)
  listCloudPresets: ({ page = 1, limit = 12, category = "", tag = "", search = "" } = {}) => {
    const p = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (category) p.set("category", category);
    if (tag) p.set("tag", tag);
    if (search) p.set("search", search);
    return request(`/pipelines/cloud/presets?${p.toString()}`);
  },
  listCloudCategories: () => request("/pipelines/cloud/categories"),
  getCloudPreset: async (cloudId) => request(`/pipelines/cloud/presets/${cloudId}`, { headers: await getLicenseHeaders() }),
  listMyCloudPresets: async () => request("/pipelines/cloud/mine", { headers: await getLicenseHeaders() }),
  uploadPresetToCloud: async (data) =>
    request("/pipelines/cloud/upload", { method: "POST", headers: await getLicenseHeaders(), body: JSON.stringify(data) }),
  editCloudPreset: async (cloudId, data) =>
    request(`/pipelines/cloud/presets/${cloudId}/edit`, { method: "POST", headers: await getLicenseHeaders(), body: JSON.stringify(data) }),
  requestCloudPublic: async (cloudId) =>
    request(`/pipelines/cloud/presets/${cloudId}/request-public`, { method: "POST", headers: await getLicenseHeaders() }),
  deleteCloudPreset: async (cloudId) =>
    request(`/pipelines/cloud/presets/${cloudId}`, { method: "DELETE", headers: await getLicenseHeaders() }),
  importCloudPreset: async (boardId, cloudId, position = null) =>
    request(`/moodboards/${encodeURIComponent(boardId)}/pipelines/cloud-import`, {
      method: "POST",
      headers: await getLicenseHeaders(),
      body: JSON.stringify({ cloud_id: cloudId, position }),
    }),

  // Self-hosted server: is there a newer release than the running image, and where
  // does the server run (picks the update instructions)? Owner session only.
  getServerUpdates: (refresh = false) => request(`/updates${refresh ? "?refresh=1" : ""}`),
  // Full backup in the background (202), then poll its status.
  startServerBackup: (force = false) =>
    request(`/admin/backup?background=1${force ? "&force=1" : ""}`, { method: "POST" }),
  getServerBackupStatus: () => request(`/admin/backup/status`),
  deleteServerBackup: (name) => request(`/admin/backups/${encodeURIComponent(name)}`, { method: "DELETE" }),
  // Railway: keep a token for this service, then redeploy it on the newest image.
  connectRailway: (token) => request(`/admin/railway/token`, { method: "POST", body: JSON.stringify({ token }) }),
  disconnectRailway: () => request(`/admin/railway/token`, { method: "DELETE" }),
  startRailwayUpdate: () => request(`/admin/railway/update`, { method: "POST" }),
  getRailwayDeployment: (id) => request(`/admin/railway/deployments/${encodeURIComponent(id)}`),

  // App-wide settings stored on the backend (read by shared-board exports)
  getAppSettings: () => request(`/app-settings`),
  updateAppSettings: (settings) => request(`/app-settings`, { method: "PUT", body: JSON.stringify(settings) }),

  // Share
  getShareStatus: (mbId) => request(`/moodboards/${mbId}/share`),
  createShare: (mbId, opts = {}) => request(`/moodboards/${mbId}/share`, { method: "POST", body: JSON.stringify(opts) }),
  updateShare: (mbId) => request(`/moodboards/${mbId}/share/update`, { method: "POST" }),
  setShareOgImage: (mbId, ogImage) =>
    request(`/moodboards/${mbId}/share/og-image`, { method: "POST", body: JSON.stringify({ og_image: ogImage }) }),
  // localOnly forgets the link without removing the page from its host.
  deleteShare: (mbId, localOnly = false) =>
    request(`/moodboards/${mbId}/share${localOnly ? "?local_only=1" : ""}`, { method: "DELETE" }),
  provisionShareHosting: (cfApiToken, accountId = null, rotateShareToken = false) =>
    request(`/share-hosting/provision`, {
      method: "POST",
      body: JSON.stringify({
        cf_api_token: cfApiToken,
        account_id: accountId,
        rotate_share_token: !!rotateShareToken,
      }),
    }),
  // Does this upload token belong to that worker? {ok, detail}
  verifyShareToken: (workerUrl, shareToken) =>
    request(`/share-hosting/verify-token`, {
      method: "POST",
      body: JSON.stringify({ worker_url: workerUrl, share_token: shareToken }),
    }),

  // GitHub connection (version control + agent-built boards)
  getGithubStatus: (mbId) => request(`/moodboards/${encodeURIComponent(mbId)}/github/status`),
  connectGithub: (mbId, body) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/github/connect`, { method: "POST", body: JSON.stringify(body) }),
  createGithubRepo: (mbId, body) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/github/create-repo`, { method: "POST", body: JSON.stringify(body) }),
  disconnectGithub: (mbId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/github/connect`, { method: "DELETE" }),
  saveGithubRelease: (mbId, body = {}) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/github/releases`, { method: "POST", body: JSON.stringify(body) }),
  listGithubReleases: (mbId) => request(`/moodboards/${encodeURIComponent(mbId)}/github/releases`),
  importGithubRelease: (mbId, releaseId, mode = "replace", force = false) =>
    request(
      `/moodboards/${encodeURIComponent(mbId)}/github/releases/${releaseId}/import?mode=${encodeURIComponent(mode)}&force=${force ? "true" : "false"}`,
      { method: "POST" }
    ),
  exportAgentSkill: (mbId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/github/export-skill`, { method: "POST" }),
  getAgentSkillDownloadUrl: () => `${API}/github/agent-skill`,

  // Screen-recording understanding (transcript + events + lazy frames)
  registerRecording: ({ boardId, videoUrl, durationSec, eventTrack, withUnderstanding = true, withInsights = false }) =>
    request(`/recordings/register`, {
      method: "POST",
      body: JSON.stringify({
        board_id: boardId,
        video_url: videoUrl,
        duration_sec: durationSec,
        event_track: eventTrack || null,
        with_understanding: withUnderstanding,
        with_insights: withInsights,
      }),
    }),
  // Re-run the auto chapters/summary/title stage (requires a finished transcript).
  regenerateRecordingInsights: (boardId, id) =>
    request(`/recordings/${encodeURIComponent(id)}/regenerate?board_id=${encodeURIComponent(boardId)}`, { method: "POST" }),
  getRecordingContext: (boardId, id) =>
    request(`/recordings/${encodeURIComponent(id)}/context.json?board_id=${encodeURIComponent(boardId)}`),
  getRecordingTranscript: (boardId, id) =>
    request(`/recordings/${encodeURIComponent(id)}/transcript.json?board_id=${encodeURIComponent(boardId)}`),
  recordingFrameUrl: (boardId, id, atMs) =>
    `${API}/recordings/${encodeURIComponent(id)}/frame.jpg?board_id=${encodeURIComponent(boardId)}&atMs=${Math.max(0, Math.round(atMs || 0))}`,
  // Remove a recording entirely: board card + source file (+proxy/thumb) + sidecar.
  deleteRecording: (boardId, id) =>
    request(`/recordings/${encodeURIComponent(id)}?board_id=${encodeURIComponent(boardId)}`, { method: "DELETE" }),
  // `activeDataOnly` omits the (large) timeline payload for every project except
  // the open one — the project menu only needs names. Projects come back with
  // `has_data: false`, so switching to one must fetch it with getVideoProject.
  listVideoProjects: (mbId, { activeDataOnly = false } = {}) =>
    request(`/moodboards/${mbId}/video-projects${activeDataOnly ? '?data=active' : ''}`),
  // No payloads at all: names, summaries and pictures (the canvas's Video Editor project picker).
  listVideoProjectCards: (mbId) => request(`/moodboards/${encodeURIComponent(mbId)}/video-projects?data=none`),
  // {counts: {boardId: n}} for the boards that have video projects.
  getVideoProjectCounts: () => request(`/video-projects/counts`),
  // What a Video Editor project card shows (name, board name, summary, pictures); 404 once the project is removed.
  getVideoProjectCard: (mbId, projectId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/video-projects/${encodeURIComponent(projectId)}/card`),
  getVideoProjectGlvideoUrl: (mbId, projectId) =>
    `${API}/moodboards/${encodeURIComponent(mbId)}/video-projects/${encodeURIComponent(projectId)}/glvideo`,
  getVideoProjectsRefreshRevision: (mbId) => request(`/moodboards/${mbId}/video-projects-refresh-revision`),
  getVideoProject: (mbId, projectId) => request(`/moodboards/${mbId}/video-projects/${projectId}`),
  // Search everything (⌘K): the cards on other boards whose title matches (the open board's own come from the canvas).
  searchCards: (q, exclude) =>
    request(`/search/cards?q=${encodeURIComponent(q)}&exclude=${encodeURIComponent(exclude || '')}`),
  // Variants (backend/variant_runs.py): N agents make N versions of a project at once, each on its own copy.
  variantDirections: (mbId, body) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs/directions`, { method: "POST", body: JSON.stringify(body) }),
  createVariantRun: (mbId, body) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs`, { method: "POST", body: JSON.stringify(body) }),
  listVariantRuns: (mbId, projectId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs?projectId=${encodeURIComponent(projectId || "")}`),
  getVariantRun: (mbId, runId) => request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs/${encodeURIComponent(runId)}`),
  setVariantSessions: (mbId, runId, sessions) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs/${encodeURIComponent(runId)}/sessions`, { method: "POST", body: JSON.stringify({ sessions }) }),
  variantAgain: (mbId, runId, key) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs/${encodeURIComponent(runId)}/variants/${encodeURIComponent(key)}/again`, { method: "POST" }),
  rankVariants: (mbId, runId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs/${encodeURIComponent(runId)}/rank`, { method: "POST", body: "{}" }),
  keepVariant: (mbId, runId, key, mode) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs/${encodeURIComponent(runId)}/keep`, { method: "POST", body: JSON.stringify({ key, mode }) }),
  discardVariantRun: (mbId, runId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/variant-runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),
  createVideoProject: (mbId, data) =>
    request(`/moodboards/${mbId}/video-projects`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateVideoProject: (mbId, projectId, data) =>
    request(`/moodboards/${mbId}/video-projects/${projectId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  activateVideoProject: (mbId, projectId) =>
    request(`/moodboards/${mbId}/video-projects/${projectId}/activate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  deleteVideoProject: (mbId, projectId) =>
    request(`/moodboards/${mbId}/video-projects/${projectId}`, {
      method: "DELETE",
    }),
  // Projects gallery picture: a small frame of the project as it was LEFT (never on
  // autosave). `keepalive` lets the request outlive a closing window.
  saveVideoProjectThumbnail: (mbId, projectId, { image, version }, { keepalive = false } = {}) =>
    request(`/moodboards/${mbId}/video-projects/${projectId}/thumbnail`, {
      method: "POST",
      body: JSON.stringify({ image, version }),
      keepalive,
    }),
  listMockupProjects: (mbId) => request(`/moodboards/${mbId}/mockup-projects`),
  getMockupProjectsRefreshRevision: (mbId) => request(`/moodboards/${mbId}/mockup-projects-refresh-revision`),
  getMockupProject: (mbId, projectId) => request(`/moodboards/${mbId}/mockup-projects/${projectId}`),
  createMockupProject: (mbId, data) =>
    request(`/moodboards/${mbId}/mockup-projects`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateMockupProject: (mbId, projectId, data) =>
    request(`/moodboards/${mbId}/mockup-projects/${projectId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  activateMockupProject: (mbId, projectId) =>
    request(`/moodboards/${mbId}/mockup-projects/${projectId}/activate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  deleteMockupProject: (mbId, projectId) =>
    request(`/moodboards/${mbId}/mockup-projects/${projectId}`, {
      method: "DELETE",
    }),
  // Video editor presets: JSON files on disk (media/video-presets), global to the install.
  listVideoPresets: () => request(`/video-presets`),
  saveVideoPreset: (data) =>
    request(`/video-presets`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getVideoPreset: (presetId) => request(`/video-presets/${encodeURIComponent(presetId)}`),
  updateVideoPreset: (presetId, data) =>
    request(`/video-presets/${encodeURIComponent(presetId)}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteVideoPreset: (presetId) =>
    request(`/video-presets/${encodeURIComponent(presetId)}`, {
      method: "DELETE",
    }),
  // Project-camera presets: saved camera moves (media/camera-presets), global to the
  // install. Their own directory, so names can't collide with sequence presets.
  listCameraPresets: () => request(`/camera-presets`),
  saveCameraPreset: (data) =>
    request(`/camera-presets`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteCameraPreset: (presetId) =>
    request(`/camera-presets/${encodeURIComponent(presetId)}`, {
      method: "DELETE",
    }),
  // Preset/project ZIP bundles: JSON + every /media file it references. Import
  // writes missing media into the target board's dir and remaps the URLs.
  getExportVideoPresetUrl: (presetId) => `${API}/video-presets/${encodeURIComponent(presetId)}/export`,
  importVideoPreset: async (file, boardId = null) => {
    const form = new FormData();
    form.append("file", file);
    const qs = boardId ? `?board_id=${encodeURIComponent(boardId)}` : "";
    const res = await fetch(`${API}/video-presets/import${qs}`, {
      method: "POST",
      body: form,
      headers: await withRuntimeApiKeyHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Preset import failed");
    }
    return res.json();
  },
  getExportVideoProjectUrl: (mbId, projectId) =>
    `${API}/moodboards/${encodeURIComponent(mbId)}/video-projects/${encodeURIComponent(projectId)}/export`,
  // Export job: the server writes the bundle ZIP in the background and reports
  // files/bytes packed; download the finished file from getVideoProjectExportDownloadUrl.
  createVideoProjectExportJob: (mbId, projectId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/video-projects/${encodeURIComponent(projectId)}/export-job`, {
      method: "POST",
    }),
  getVideoProjectExportJob: (jobId) => request(`/video-project-export-jobs/${encodeURIComponent(jobId)}`),
  deleteVideoProjectExportJob: (jobId) =>
    request(`/video-project-export-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" }),
  getVideoProjectExportDownloadUrl: (jobId) => `${API}/video-project-export-jobs/${encodeURIComponent(jobId)}/download`,
  // GreenLight Motion Engine (backend/motion_light.py): a project out as a page + folder an agent can
  // work on, and such a folder / page back in as a new project.
  getLightExportReport: (mbId, projectId) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/video-projects/${encodeURIComponent(projectId)}/light-report`),
  // where an export started with body.progressId is (Export for agents shows it while the files are copied / converted)
  exportLightProgress: (progressId) => request(`/video-projects/export-light/progress/${encodeURIComponent(progressId)}`),
  exportLightProject: (mbId, projectId, body) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/video-projects/${encodeURIComponent(projectId)}/export-light`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }),
  importLightProject: (mbId, path, { activate = true } = {}) =>
    request(`/moodboards/${encodeURIComponent(mbId)}/video-projects/import-light`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, activate }),
    }),
  importVideoProjectBundle: async (mbId, file) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API}/moodboards/${encodeURIComponent(mbId)}/video-projects/import`, {
      method: "POST",
      body: form,
      headers: await withRuntimeApiKeyHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Project import failed");
    }
    return res.json();
  },
  // Full headless server render (multi-channel, text, voice, animations) — the
  // "Render in Background" path. body: { format?: 'mp4'|'webm', fps?, width?, height? }
  renderVideoProjectOnServer: (mbId, projectId, body = {}) =>
    request(`/moodboards/${mbId}/video-projects/${projectId}/render-onserver`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // Non-blocking variant of the above: returns a job { id, status, progress, ... }
  // immediately; poll getVideoRenderJob(id) for real per-frame progress + result url.
  createVideoRenderJob: (mbId, projectId, body = {}) =>
    request(`/moodboards/${mbId}/video-projects/${projectId}/render-onserver-job`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getVideoRenderJob: (jobId) => request(`/video-render-jobs/${jobId}`),
  cancelVideoRenderJob: (jobId) => request(`/video-render-jobs/${jobId}`, { method: "DELETE" }),
  // HTML clips (videoEditor/htmlClips.js): ensure a transparent WebM bake of an
  // .html file. Idempotent — `status: "completed"` + `result` at once when a bake of
  // this content (size, fps, at least this long) exists, else a job to poll.
  ensureHtmlBake: (mbId, { url, width, height, fps, duration, force = false }) =>
    request(`/moodboards/${mbId}/html-bakes`, {
      method: "POST",
      body: JSON.stringify({ url, width, height, fps, duration, force }),
    }),
  getHtmlBake: (jobId) => request(`/html/bakes/${jobId}`),
  cancelHtmlBake: (jobId) => request(`/html/bakes/${jobId}`, { method: "DELETE" }),
  // Current sha1 of html clip source files — { sources: { [url]: { sha1 } | { error } } }.
  getHtmlSourceInfo: (mbId, urls) =>
    request(`/moodboards/${mbId}/html-source-info`, {
      method: "POST",
      body: JSON.stringify({ urls }),
    }),
  // A HyperFrames composition's size, length, fps, scenes, clips and sounds (read from its
  // runtime's manifest) — { hyperframes: false } for any other page (videoEditor/hyperframesClips.js).
  inspectHyperFrames: (mbId, url) =>
    request(`/moodboards/${mbId}/hyperframes/inspect`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  // Convert to scenes, planned but not applied: the editor JSON that replaces one html item of a
  // HyperFrames composition — { ok, reason?, clips, scenesChannel, overlayChannels, soundChannels, scenes, warnings }.
  hyperframesConvertPlan: (mbId, { url, at, trimStart, trimEnd, name }) =>
    request(`/moodboards/${mbId}/hyperframes/convert-plan`, {
      method: "POST",
      body: JSON.stringify({ url, at, trimStart, trimEnd, name }),
    }),
  // Convert to scenes, checked: the middle of each converted scene rendered and compared with the
  // running composition — { ok, scenes: [{ id, time, mad, ok }] }.
  hyperframesConvertCheck: (mbId, body) =>
    request(`/moodboards/${mbId}/hyperframes/convert-check`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // Save an html clip's page that no board card owns (Edit HTML on such a clip).
  // `expectedSha1` = its html-source-info sha1 when loaded → 409 if changed since.
  putHtmlFile: (mbId, url, html, expectedSha1 = null) =>
    request(`/moodboards/${mbId}/html-file`, {
      method: "PUT",
      body: JSON.stringify({ url, html, ...(expectedSha1 ? { expected_sha1: expectedSha1 } : {}) }),
    }),
  // Composite ONE frame of the project at body.time seconds into a PNG in the
  // board media dir (same headless full renderer as render-onserver). Synchronous.
  renderVideoProjectStill: (mbId, projectId, body = {}) =>
    request(`/moodboards/${mbId}/video-projects/${projectId}/render-still`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // List render jobs for a board (newest first). Opts: { projectId, active } —
  // active=true returns only queued/processing jobs. Used to reattach the
  // editor's progress bar to a render still running after a board/tab switch.
  listVideoRenderJobs: (mbId, { projectId, active } = {}) => {
    const qs = new URLSearchParams();
    if (projectId) qs.set("project_id", projectId);
    if (active) qs.set("active", "true");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request(`/moodboards/${mbId}/video-render-jobs${suffix}`);
  },
  // Non-blocking mockup render: returns a job { id, status, progress, ... }
  // immediately; poll getMockupRenderJob(id) for real per-frame progress + the
  // result url. Mirrors the video render job flow.
  createMockupRenderJob: (body = {}) =>
    request(`/mockup/render-job`, { method: "POST", body: JSON.stringify(body) }),
  getMockupRenderJob: (jobId) => request(`/mockup/render-jobs/${jobId}`),
  cancelMockupRenderJob: (jobId) => request(`/mockup/render-jobs/${jobId}`, { method: "DELETE" }),
  // List mockup render jobs for a board (newest first). active=true returns only
  // queued/processing jobs — used to reattach the progress bar after a tab switch.
  listMockupRenderJobs: (mbId, { active } = {}) => {
    const suffix = active ? "?active=true" : "";
    return request(`/moodboards/${mbId}/mockup-render-jobs${suffix}`);
  },
  transferMedia: (mode, filePaths, targetBoardId = null) =>
    request("/media/admin/transfer", {
      method: "POST",
      body: JSON.stringify({
        mode,
        file_paths: filePaths,
        target_board_id: targetBoardId,
      }),
    }),

  // Keys status
  getKeysStatus: () => request("/keys/status"),
  // On-device speech to text (backend/local_stt.py): the Fast / Best Whisper models a user downloads once.
  getLocalSpeechStatus: () => request("/local-stt/status"),
  downloadLocalSpeechModel: (id) => request(`/local-stt/models/${encodeURIComponent(id)}/download`, { method: "POST" }),
  cancelLocalSpeechDownload: (id) => request(`/local-stt/models/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  deleteLocalSpeechModel: (id) => request(`/local-stt/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  warmUpLocalSpeech: () => request("/local-stt/warm-up", { method: "POST" }),
  // App settings ▸ Speech: { voice?, captions? } each "local" | "cloud" (the backend merges; every transcription reads it)
  setSpeechEngines: (engines) => request("/local-stt/engines", { method: "POST", body: JSON.stringify(engines) }),

  // AI Generation
  listAIModels: () => request("/ai/models"),
  // Voice Studio bridge (the user's own local TTS app): {available, url, running, engines, voices, signature, error}
  getVoiceStudioStatus: (refresh = false) => request(`/voicestudio/status${refresh ? "?refresh=1" : ""}`),
  setVoiceStudioUrl: (url) => request("/voicestudio/settings", { method: "PUT", body: JSON.stringify({ url }) }),
  // Custom AI models (App settings ▸ Custom AI models): user-supplied provider manifests.
  listCustomModels: () => request("/custom-models"),
  validateCustomManifest: (manifest) => request("/custom-models/validate", { method: "POST", body: JSON.stringify({ manifest }) }),
  installCustomManifest: (id, manifest) => request(`/custom-models/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ manifest }) }),
  removeCustomManifest: (id) => request(`/custom-models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setCustomManifestKeys: (id, keys) => request(`/custom-models/${encodeURIComponent(id)}/keys`, { method: "POST", body: JSON.stringify({ keys }) }),
  verifyCustomManifest: (id, body = {}) => request(`/custom-models/${encodeURIComponent(id)}/verify`, { method: "POST", body: JSON.stringify(body) }),
  enableCustomManifest: (id, enabled) => request(`/custom-models/${encodeURIComponent(id)}/enable`, { method: "POST", body: JSON.stringify({ enabled }) }),
  listPromptEnhancerModels: () => request("/ai/prompt-enhancer/models"),
  listAgentModels: () => request("/agents/models"),
  createAgentSession: (payload = {}) =>
    request("/agents/session", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  agentChat: (payload) =>
    request("/agents/chat", {
      method: "POST",
      body: JSON.stringify({
        agent_id: payload.agentId,
        message: payload.message,
        session_id: payload.sessionId || null,
        board_id: payload.boardId || null,
        model_id: payload.modelId || null,
        messages: payload.messages || [],
        params: payload.params || {},
        media_urls: payload.mediaUrls || [],
        current_code: payload.currentCode || null,
        current_html: payload.currentHtml || null,
        context: payload.context || {},
      }),
    }),
  // Grammar / filler-word analysis for a transcript section. `text` should be a
  // numbered word list (`index: word` per line). Returns { issues, fillers, correctedText }.
  checkTranscriptGrammar: (text, modelId = null) =>
    api.agentChat({ agentId: "transcript-grammar", message: text, modelId }),
  applyAgentAction: (payload) =>
    request("/agents/apply-action", {
      method: "POST",
      body: JSON.stringify({
        board_id: payload.boardId,
        session_id: payload.sessionId || null,
        actions: payload.actions || [],
      }),
    }),
  analyzePromptFromMedia: (payload) =>
    request("/ai/prompt-enhancer/analyze", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  // opts.folder saves the results into that subfolder of the board media folder
  // instead of its root (e.g. "aivoices" for video editor voice generation).
  aiGenerate: async (modelId, params, boardId = null, opts = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900000);
    try {
      const body = { model_id: modelId, params };
      if (boardId) body.board_id = boardId;
      if (opts.folder) body.folder = opts.folder;
      return await request("/ai/generate", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new Error("Generation timed out. The provider took too long to respond.");
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  },
  // AI Viral Edits: what each type needs, and how a subject mask can be had for this clip —
  // boardMask (an earlier SAM 3 compose on the board) → maskModels (a key is set) → keyUrl.
  viralEditRequirements: (boardId, sourceUrl) => {
    const qs = new URLSearchParams();
    if (boardId) qs.set("board_id", boardId);
    if (sourceUrl) qs.set("source_url", sourceUrl);
    return request(`/video-editor/viral-edits/requirements?${qs.toString()}`);
  },
  // Roto ▸ SAM 3: a black/white matte + its source → the cut-out (alpha WebM /
  // PNG) and the matte scaled onto the source frame. Long clips encode for a while.
  segmentCompose: async ({ boardId = null, sourceUrl, matteUrl, folder = "Roto" }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1800000);
    try {
      return await request("/media/segment-compose", {
        method: "POST",
        body: JSON.stringify({ board_id: boardId, source_url: sourceUrl, matte_url: matteUrl, folder }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },
  // The Generation panel's history strip, stored server-side so generations made
  // outside the browser (agent, provider CLI) appear in it too.
  getGenerationHistory: (limit = 20, boardId = null) =>
    request(`/generation-history?limit=${limit}${boardId ? `&board_id=${encodeURIComponent(boardId)}` : ""}`),
  addGenerationHistory: (payload) =>
    request("/generation-history", { method: "POST", body: JSON.stringify(payload) }),
  attachGenerationMeta: (mbId, elementId, generation) =>
    request(`/moodboards/${mbId}/elements/${elementId}/generation-meta`, {
      method: "POST",
      body: JSON.stringify({ generation }),
    }),
  aiPricing: (modelId, params, signal) =>
    request("/ai/pricing", {
      method: "POST",
      body: JSON.stringify({ model_id: modelId, params }),
      signal,
    }),
  htmlRender: async ({ html, width, height, fps, duration, format, motionBlur, title, boardId, htmlUrl = null }) => {
    const controller = new AbortController();
    // Motion blur captures several moments per frame, so it gets a longer budget.
    const timeout = setTimeout(() => controller.abort(), 900000 * Math.min(3, Math.max(1, motionBlur || 1)));
    try {
      return await request("/html/render", {
        method: "POST",
        body: JSON.stringify({
          html,
          width: width || 1920,
          height: height || 1440,
          fps: fps || 30,
          duration: duration || 5,
          format: format || "mp4",
          motion_blur: motionBlur || 1,
          title: title || null,
          board_id: boardId || null,
          ...(htmlUrl ? { html_url: htmlUrl } : {}),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },
  htmlRenderFrame: async ({ html, width, height, fps, frame, title, boardId }) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    try {
      return await request("/html/render-frame", {
        method: "POST",
        body: JSON.stringify({
          html,
          width: width || 1920,
          height: height || 1440,
          fps: fps || 30,
          frame: frame || 0,
          title: title || null,
          board_id: boardId || null,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Screenshot / video capture
  screenshotCapture: async (url, mode = "photo", width = 1920, height = 1080, boardId = null, scrollSpeed = 2.0) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 min for video
    try {
      const body = { url, mode, width, height, scroll_speed: scrollSpeed };
      if (boardId) body.board_id = boardId;
      return await request("/screenshot", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  },

  // Find similar images (Google Vision + OpenAI)
  findSimilar: (imageUrl, criteria = "subject", boardId = null) => {
    const body = { image_url: imageUrl, criteria };
    if (boardId) body.board_id = boardId;
    return request("/find-similar", { method: "POST", body: JSON.stringify(body) });
  },

  greenlightRender: ({
    templateId,
    templateUrl,
    props,
    durationInFrames,
    fps = 120,
    width,
    height,
    boardId = null,
    format = "mp4",
  }) =>
    request("/greenlight/render", {
      method: "POST",
      body: JSON.stringify({
        templateId,
        templateUrl,
        props,
        duration: durationInFrames / fps,
        fps,
        width,
        height,
        board_id: boardId,
        format,
      }),
    }),

  greenlightRenderFrame: ({
    templateId,
    templateUrl,
    props,
    fps = 120,
    width,
    height,
    frame = 0,
    boardId = null,
  }) =>
    request("/greenlight/render-frame", {
      method: "POST",
      body: JSON.stringify({
        templateId,
        templateUrl,
        props,
        fps,
        width,
        height,
        frame,
        board_id: boardId,
      }),
    }),

  mockupRenderAlphaFrames: async (frames, { fps = 30, boardId = null, format = "webm" } = {}) => {
    const params = new URLSearchParams();
    params.set("fps", String(fps));
    params.set("format", format);
    if (boardId) params.set("board_id", boardId);

    const form = new FormData();
    frames.forEach((frame) => form.append("frames", frame, frame.name));

    const res = await fetch(`${API}/mockup/render-alpha?${params.toString()}`, {
      method: "POST",
      headers: await withRuntimeApiKeyHeaders(),
      body: form,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Mockup alpha render failed");
    }
    return res.json();
  },

  mockupRender: (payload, options = {}) =>
    request("/mockup/render", {
      method: "POST",
      body: JSON.stringify(payload),
      ...options,
    }),

  mockupRenderFrame: (payload, options = {}) =>
    request("/mockup/render-frame", {
      method: "POST",
      body: JSON.stringify(payload),
      ...options,
    }),

  // MotionFast rendering (returns raw Response for blob download)
  motionFastRender: (presetId, runtime, options, durationInFrames, width, height, fps = 30, sourceFps = null) =>
    fetch(`${API}/motionfast/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        presetId,
        runtime,
        options,
        durationInFrames,
        width,
        height,
        fps,
        sourceFps,
      }),
    }),

  motionFastRenderFrame: (presetId, runtime, options, durationInFrames, width, height, frame, fps = 30, sourceFps = null) =>
    fetch(`${API}/motionfast/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        presetId,
        runtime,
        options,
        durationInFrames,
        width,
        height,
        fps,
        sourceFps,
        renderType: "frame",
        frame,
      }),
    }),

  aeDetect: () => request("/ae/detect"),
  aeInspectProject: (payload) => request("/ae/projects/inspect", { method: "POST", body: JSON.stringify(payload) }),
  aeRenderProject: (payload) => request("/ae/projects/render", { method: "POST", body: JSON.stringify(payload) }),
  aeListInputPresets: ({ boardId, elementId } = {}) => {
    const params = new URLSearchParams();
    if (boardId) params.set("board_id", boardId);
    if (elementId) params.set("element_id", elementId);
    return request(`/ae/projects/presets?${params.toString()}`);
  },
  aeSaveInputPreset: (payload) => request("/ae/projects/presets", { method: "POST", body: JSON.stringify(payload) }),
  aeDeleteInputPreset: ({ presetId, boardId, elementId }) => {
    const params = new URLSearchParams();
    if (boardId) params.set("board_id", boardId);
    if (elementId) params.set("element_id", elementId);
    return request(`/ae/projects/presets/${encodeURIComponent(presetId)}?${params.toString()}`, { method: "DELETE" });
  },
  // Full URL for an <img> preview of an AE footage source (mediaLayers[].source.path).
  aeSourcePreviewUrl: (path) => `${API}/ae/source-preview?path=${encodeURIComponent(path || "")}`,
  aeCreateRenderJob: (payload) => request("/ae/render-jobs", { method: "POST", body: JSON.stringify(payload) }),
  aeGetRenderJob: (jobId) => request(`/ae/render-jobs/${jobId}`),
  // A project render as a job (the video editor's After Effects clips): payload as
  // aeRenderProject, plus url / require_running / frames_total. Poll aeGetRenderJob.
  aeCreateProjectRenderJob: (payload) => request("/ae/projects/render-jobs", { method: "POST", body: JSON.stringify(payload) }),
  aeCancelRenderJob: (jobId) => request(`/ae/render-jobs/${jobId}`, { method: "DELETE" }),

  // Play a short notification sound on the host machine ("notice" | "error" | "question").
  // Fire-and-forget; never let a failed sound break the calling flow.
  playSound: (sound = "notice") =>
    request("/sounds/play", { method: "POST", body: JSON.stringify({ sound }) }).catch(() => {}),

  blenderDetect: () => request("/blender/detect"),
  blenderInspectProject: (payload) => request("/blender/projects/inspect", { method: "POST", body: JSON.stringify(payload) }),
  blenderRenderProject: (payload) => request("/blender/projects/render", { method: "POST", body: JSON.stringify(payload) }),

  // DaVinci Resolve (.drp) canvas projects. Mirrors the AE methods above; render
  // is synchronous (like the AE inputs panel + Blender). External scripting needs
  // Resolve Studio + a running Resolve instance — detect() reports the gate, and
  // detect({ probe: true }) confirms Studio at runtime via a scriptapp ping.
  resolveDetect: ({ probe = false } = {}) => request(`/resolve/detect${probe ? "?probe=1" : ""}`),
  resolveInspectProject: (payload) => request("/resolve/projects/inspect", { method: "POST", body: JSON.stringify(payload) }),
  resolveRenderProject: (payload) => request("/resolve/projects/render", { method: "POST", body: JSON.stringify(payload) }),
  resolveListInputPresets: ({ boardId, elementId } = {}) => {
    const params = new URLSearchParams();
    if (boardId) params.set("board_id", boardId);
    if (elementId) params.set("element_id", elementId);
    return request(`/resolve/projects/presets?${params.toString()}`);
  },
  resolveSaveInputPreset: (payload) => request("/resolve/projects/presets", { method: "POST", body: JSON.stringify(payload) }),
  resolveDeleteInputPreset: ({ presetId, boardId, elementId }) => {
    const params = new URLSearchParams();
    if (boardId) params.set("board_id", boardId);
    if (elementId) params.set("element_id", elementId);
    return request(`/resolve/projects/presets/${encodeURIComponent(presetId)}?${params.toString()}`, { method: "DELETE" });
  },

  // --- collaboration (PLANS/CLOUDFLARE_COLLABORATIVE_EDITING_PLAN.md, Phase 3) ---
  collabStatus: (mbId) => request(`/moodboards/${mbId}/collaboration/status`),
  collabEnable: (mbId, body) =>
    request(`/moodboards/${mbId}/collaboration/enable`, { method: "POST", body: JSON.stringify(body) }),
  collabJoin: (body) =>
    request(`/collaboration/join`, { method: "POST", body: JSON.stringify(body) }),
  collabInvite: (mbId, body) =>
    request(`/moodboards/${mbId}/collaboration/invites`, { method: "POST", body: JSON.stringify(body) }),
  collabMembers: (mbId) => request(`/moodboards/${mbId}/collaboration/members`),
  collabConflicts: (mbId) => request(`/moodboards/${mbId}/collaboration/conflicts`),
  // /media/ URL of a room asset's cached copy on this computer (desktop file actions).
  collabAssetLocalMedia: (body) =>
    request(`/collab/assets/local-media`, { method: "POST", body: JSON.stringify(body) }),
  collabResolveConflict: (mbId, body) =>
    request(`/moodboards/${mbId}/collaboration/conflicts/resolve`, { method: "POST", body: JSON.stringify(body) }),
  collabDetach: (mbId) =>
    request(`/moodboards/${mbId}/collaboration/detach`, { method: "POST" }),
  collabDiagnostics: (mbId) => request(`/moodboards/${mbId}/collaboration/diagnostics`),
  collabSummary: () => request(`/collaboration/summary`),
  collabProvision: (cfApiToken, accountId = null) =>
    request(`/collab-hosting/provision`, {
      method: "POST",
      body: JSON.stringify({ cf_api_token: cfApiToken, account_id: accountId }),
    }),
  collabWorkerInfo: (workerUrl) =>
    request(`/collab-hosting/worker-info`, {
      method: "POST",
      body: JSON.stringify({ worker_url: workerUrl }),
    }),
};

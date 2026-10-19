// Versioned media URLs — `&v=<mtime_ns>` on a `/media/` request.
//
// The backend keys its derivative caches (`?thumb=`, `?audio=1`, `?peaks=`) on
// the source file's mtime+size, but the BROWSER sees the same URL before and
// after an in-place edit, so a derivative pinned `immutable` could be stale for
// a year. The server therefore serves derivatives immutable only when the
// request carries a `v=` that matches the source's `st_mtime_ns`, and
// `no-cache` + ETag otherwise. Every place that builds a derivative URL runs it
// through here; the value comes from the media listing (`mtime_ns`) or the clip
// the editor stored at add time (`mediaMtimeNs`) — it is never invented, an
// unknown mtime simply leaves the URL unversioned.
//
// The mtime is ~1.7e18 — beyond 2^53, so a JSON number loses its last digits
// on the way through `JSON.parse`. A string survives intact, which is why both
// shapes are accepted and a digit string is passed through verbatim.

export function isServedMediaUrl(url) {
  return typeof url === 'string' && url.startsWith('/media/');
}

// Normalise whatever a listing item / descriptor / clip carries to a value
// usable in a query string: a positive integer number, a digit string, or null.
export function normalizeMtimeNs(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  if (typeof value === 'string' && /^\d{1,24}$/.test(value)) return value;
  return null;
}

// The mtime carried by a media listing item, an imported descriptor or a clip,
// in whichever spelling that source uses.
export function mediaMtimeNsOf(item) {
  if (!item || typeof item !== 'object') return null;
  return normalizeMtimeNs(item.mtime_ns ?? item.mtimeNs ?? item.mediaMtimeNs);
}

// Append `v=<mtime>` to a `/media/` URL. Anything else — external, blob:,
// data:, an unknown mtime — comes back untouched.
export function withMediaVersion(url, mtimeNs) {
  if (!isServedMediaUrl(url)) return url;
  const v = normalizeMtimeNs(mtimeNs);
  if (v === null) return url;
  if (/[?&]v=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${v}`;
}

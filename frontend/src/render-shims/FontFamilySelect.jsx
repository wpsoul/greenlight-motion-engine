import { useEffect, useMemo, useRef, useState } from 'react';

const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];
const FONT_PREVIEW_TEXT = 'The quick brown fox';
const API_BASE = import.meta.env?.VITE_API_BASE_URL || '/api';
const fontStylesheetCache = new Map();
const customFontFaceCache = new Map();

function createFont(name, fallback, category) {
  return { name, css: `'${name}', ${fallback}`, category };
}

function createSystemFont(name, css, category) {
  return { name, css, category, system: true };
}

// --- User-uploaded fonts (stored on the backend, listed via /api/fonts) ---

let customFontsCache = [];
let customFontsPromise = null;
const customFontsListeners = new Set();

function createCustomFont(row) {
  return {
    name: row.family,
    css: `'${row.family}', sans-serif`,
    category: 'custom',
    id: row.id,
    url: row.url,
  };
}

export function getCustomFonts() {
  return customFontsCache;
}

export function loadCustomFonts(force = false) {
  if (customFontsPromise && !force) return customFontsPromise;
  customFontsPromise = fetch(`${API_BASE}/fonts`)
    .then((res) => (res.ok ? res.json() : { fonts: [] }))
    .then((data) => {
      customFontsCache = (Array.isArray(data?.fonts) ? data.fonts : []).map(createCustomFont);
      customFontsListeners.forEach((listener) => listener(customFontsCache));
      return customFontsCache;
    })
    .catch(() => customFontsCache);
  return customFontsPromise;
}

export function subscribeCustomFonts(listener) {
  customFontsListeners.add(listener);
  return () => customFontsListeners.delete(listener);
}

export async function uploadCustomFont(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(`${API_BASE}/fonts/upload`, { method: 'POST', body: formData });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail || 'Font upload failed');
  }
  const data = await res.json();
  customFontFaceCache.delete(data?.font?.family);
  await loadCustomFonts(true);
  return data.font;
}

export async function deleteCustomFont(fontId) {
  const res = await fetch(`${API_BASE}/fonts/${fontId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete font');
  await loadCustomFonts(true);
}

function ensureCustomFontFace(font) {
  if (typeof document === 'undefined' || !font?.url || !font?.name) return Promise.resolve();
  if (customFontFaceCache.has(font.name)) return customFontFaceCache.get(font.name);
  const promise = (async () => {
    const face = new FontFace(font.name, `url("${font.url}")`);
    const loaded = await face.load();
    document.fonts.add(loaded);
  })().catch(() => {});
  customFontFaceCache.set(font.name, promise);
  return promise;
}

export const FONT_FAMILIES = [
  createFont('Anton', 'sans-serif', 'display'),
  createFont('Bebas Neue', 'sans-serif', 'display'),
  createFont('Oswald', 'sans-serif', 'display'),
  createFont('Righteous', 'sans-serif', 'display'),
  createFont('Permanent Marker', 'cursive', 'display'),
  createFont('Bangers', 'cursive', 'display'),
  createFont('Passion One', 'sans-serif', 'display'),
  createFont('Black Ops One', 'sans-serif', 'display'),
  createFont('Lilita One', 'cursive', 'display'),
  createFont('Archivo Black', 'sans-serif', 'display'),
  createFont('Alfa Slab One', 'serif', 'display'),
  createFont('Rubik Mono One', 'sans-serif', 'display'),
  createFont('Fredoka', 'sans-serif', 'display'),
  createFont('Baloo 2', 'cursive', 'display'),
  createFont('DM Sans', 'sans-serif', 'sans-serif'),
  createFont('Inter', 'sans-serif', 'sans-serif'),
  createSystemFont('Helvetica', `'Helvetica Neue', Helvetica, Arial, sans-serif`, 'sans-serif'),
  createFont('Roboto', 'sans-serif', 'sans-serif'),
  createFont('Poppins', 'sans-serif', 'sans-serif'),
  createFont('Montserrat', 'sans-serif', 'sans-serif'),
  createFont('Open Sans', 'sans-serif', 'sans-serif'),
  createFont('Lato', 'sans-serif', 'sans-serif'),
  createFont('Raleway', 'sans-serif', 'sans-serif'),
  createFont('Source Sans 3', 'sans-serif', 'sans-serif'),
  createFont('Work Sans', 'sans-serif', 'sans-serif'),
  createFont('Nunito', 'sans-serif', 'sans-serif'),
  createFont('Rubik', 'sans-serif', 'sans-serif'),
  createFont('Manrope', 'sans-serif', 'sans-serif'),
  createFont('Outfit', 'sans-serif', 'sans-serif'),
  createFont('Mulish', 'sans-serif', 'sans-serif'),
  createFont('Plus Jakarta Sans', 'sans-serif', 'sans-serif'),
  createFont('Space Grotesk', 'sans-serif', 'sans-serif'),
  createFont('Urbanist', 'sans-serif', 'sans-serif'),
  createFont('Cabin', 'sans-serif', 'sans-serif'),
  createFont('Prompt', 'sans-serif', 'sans-serif'),
  createFont('Hind', 'sans-serif', 'sans-serif'),
  createFont('Sora', 'sans-serif', 'sans-serif'),
  createFont('Barlow', 'sans-serif', 'sans-serif'),
  createFont('Assistant', 'sans-serif', 'sans-serif'),
  createFont('Quicksand', 'sans-serif', 'sans-serif'),
  createFont('Playfair Display', 'serif', 'serif'),
  createFont('Merriweather', 'serif', 'serif'),
  createFont('Lora', 'serif', 'serif'),
  createFont('Libre Baskerville', 'serif', 'serif'),
  createFont('Crimson Text', 'serif', 'serif'),
  createFont('Cormorant Garamond', 'serif', 'serif'),
  createFont('Abril Fatface', 'serif', 'serif'),
  createFont('Bitter', 'serif', 'serif'),
  createFont('DM Serif Display', 'serif', 'serif'),
  createFont('Alegreya', 'serif', 'serif'),
  createFont('Fira Code', 'monospace', 'mono'),
  createFont('JetBrains Mono', 'monospace', 'mono'),
  createFont('Source Code Pro', 'monospace', 'mono'),
  createFont('IBM Plex Mono', 'monospace', 'mono'),
  createFont('Space Mono', 'monospace', 'mono'),
  createFont('Roboto Mono', 'monospace', 'mono'),
  createFont('Inconsolata', 'monospace', 'mono'),
];

function sanitizeFontName(value) {
  return String(value || '')
    .trim()
    .replace(/^['"]+|['"]+$/g, '');
}

function extractPrimaryFontName(value) {
  if (!value) return '';
  const primary = String(value).split(',')[0] || '';
  return sanitizeFontName(primary);
}

export function findFontFamily(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const primary = extractPrimaryFontName(raw).toLowerCase();
  const matches = (font) => {
    if (font.name.toLowerCase() === raw.toLowerCase()) return true;
    if (font.css.toLowerCase() === raw.toLowerCase()) return true;
    return extractPrimaryFontName(font.css).toLowerCase() === primary;
  };
  return customFontsCache.find(matches) || FONT_FAMILIES.find(matches) || null;
}

export function getFontCSS(fontValue = 'Inter') {
  const font = findFontFamily(fontValue);
  if (font) return font.css;
  if (!fontValue) return "'Inter', sans-serif";
  const raw = String(fontValue).trim();
  if (raw.includes(',')) return raw;
  return `'${sanitizeFontName(raw)}', sans-serif`;
}

export function getFontName(fontValue = 'Inter') {
  const font = findFontFamily(fontValue);
  if (font) return font.name;
  const primary = extractPrimaryFontName(fontValue);
  return primary || 'Inter';
}

function normalizeGoogleFontNames(fontValues) {
  return [...new Set(
    (Array.isArray(fontValues) ? fontValues : [fontValues])
      // A full CSS stack ('"Arial Black", Arial, sans-serif') must collapse to its
      // primary family: sanitizeFontName only strips the outermost quotes, so the
      // inner one used to survive into a `link[data-font-family="…"]` selector and
      // throw, and into a nonsense Google Fonts `family=` param.
      .map((value) => findFontFamily(value)?.name || extractPrimaryFontName(value))
      .filter(Boolean)
  )];
}

export function getGoogleFontsUrl(fontNames, allWeights = false) {
  const uniqueFonts = normalizeGoogleFontNames(fontNames);
  if (uniqueFonts.length === 0) return '';
  const weightSpec = allWeights ? `:wght@${FONT_WEIGHTS.join(';')}` : '';
  const fontParam = uniqueFonts
    .map((fontName) => `family=${encodeURIComponent(fontName).replace(/%20/g, '+')}${weightSpec}`)
    .join('&');
  return `https://fonts.googleapis.com/css2?${fontParam}&display=swap`;
}

function ensureFontStylesheet(fontName, allWeights) {
  if (typeof document === 'undefined' || !fontName) return Promise.resolve();
  const cacheKey = `${fontName}:${allWeights ? 'all' : 'default'}`;
  if (fontStylesheetCache.has(cacheKey)) return fontStylesheetCache.get(cacheKey);

  const href = getGoogleFontsUrl([fontName], allWeights);
  if (!href) return Promise.resolve();

  const existing = document.querySelector(`link[data-font-family="${fontName}"][data-font-weights="${allWeights ? 'all' : 'default'}"]`);
  if (existing) {
    const existingPromise = Promise.resolve();
    fontStylesheetCache.set(cacheKey, existingPromise);
    return existingPromise;
  }

  const promise = new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.fontFamily = fontName;
    link.dataset.fontWeights = allWeights ? 'all' : 'default';
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });

  fontStylesheetCache.set(cacheKey, promise);
  return promise;
}

export async function ensureFontsLoaded(fontValues, options = {}) {
  await loadCustomFonts().catch(() => {});
  const fontNames = normalizeGoogleFontNames(fontValues);
  if (fontNames.length === 0) return [];

  const customByName = new Map(customFontsCache.map((font) => [font.name.toLowerCase(), font]));
  const customFonts = fontNames
    .map((fontName) => customByName.get(fontName.toLowerCase()))
    .filter(Boolean);
  const systemFontNames = new Set(
    FONT_FAMILIES.filter((font) => font.system).map((font) => font.name.toLowerCase())
  );
  const googleFontNames = fontNames.filter((fontName) => (
    !customByName.has(fontName.toLowerCase()) && !systemFontNames.has(fontName.toLowerCase())
  ));

  const allWeights = options.allWeights !== false;
  const requestedWeights = Array.isArray(options.weights) && options.weights.length > 0
    ? [...new Set(options.weights.map((weight) => Number.parseInt(weight, 10)).filter(Number.isFinite))]
    : [400, 500, 600, 700, 800, 900];
  const size = Number.isFinite(options.size) ? Math.max(12, options.size) : 32;
  const sample = typeof options.sampleText === 'string' && options.sampleText ? options.sampleText : FONT_PREVIEW_TEXT;

  await Promise.all([
    ...customFonts.map((font) => ensureCustomFontFace(font)),
    ...googleFontNames.map((fontName) => ensureFontStylesheet(fontName, allWeights)),
  ]);
  if (typeof document === 'undefined' || !document.fonts?.load) return fontNames;

  await Promise.all(
    googleFontNames.flatMap((fontName) => {
      const css = getFontCSS(fontName);
      return requestedWeights.map((weight) => document.fonts.load(`${weight} ${size}px ${css}`, sample).catch(() => []));
    })
  );

  return fontNames;
}

function ChevronIcon({ open }) {
  return (
    <svg className={`ff-picker-chevron${open ? ' ff-picker-chevron-open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function FontFamilySelect({
  value,
  onChange,
  returnValue = 'name',
  className = '',
  triggerClassName = '',
  dropdownClassName = '',
  searchPlaceholder = 'Search fonts',
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [customFonts, setCustomFonts] = useState(getCustomFonts);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const wrapRef = useRef(null);
  const fileInputRef = useRef(null);
  const selectedFont = findFontFamily(value);
  const selectedLabel = selectedFont?.name || getFontName(value);
  const selectedCss = selectedFont?.css || getFontCSS(value);

  useEffect(() => {
    loadCustomFonts();
    return subscribeCustomFonts(setCustomFonts);
  }, []);

  const allFonts = useMemo(() => [...customFonts, ...FONT_FAMILIES], [customFonts]);

  const filteredFonts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return allFonts;
    return allFonts.filter((font) => (
      font.name.toLowerCase().includes(query) ||
      font.category.toLowerCase().includes(query)
    ));
  }, [allFonts, search]);

  useEffect(() => {
    ensureFontsLoaded([value], { weights: [400, 500, 600, 700, 800, 900], size: 28, sampleText: FONT_PREVIEW_TEXT });
  }, [value]);

  useEffect(() => {
    if (!isOpen) return undefined;
    ensureFontsLoaded(allFonts.map((font) => font.name), { weights: [400, 700], size: 22, sampleText: FONT_PREVIEW_TEXT });
    const handlePointerDown = (event) => {
      if (!wrapRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [isOpen, allFonts]);

  const handleSelect = (font) => {
    onChange?.(returnValue === 'css' ? font.css : font.name);
    setIsOpen(false);
    setSearch('');
  };

  const handleUploadFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadError('');
    setIsUploading(true);
    try {
      const uploaded = await uploadCustomFont(file);
      if (uploaded?.family) {
        await ensureFontsLoaded([uploaded.family], { size: 22, sampleText: FONT_PREVIEW_TEXT });
        onChange?.(returnValue === 'css' ? `'${uploaded.family}', sans-serif` : uploaded.family);
      }
    } catch (error) {
      setUploadError(error?.message || 'Font upload failed');
    } finally {
      setIsUploading(false);
    }
  };

  const handleDeleteCustomFont = async (event, font) => {
    event.stopPropagation();
    try {
      await deleteCustomFont(font.id);
      if (selectedFont?.name === font.name) {
        onChange?.(returnValue === 'css' ? "'Inter', sans-serif" : 'Inter');
      }
    } catch {
      // Keep the entry; the next list refresh will reconcile.
    }
  };

  return (
    <div ref={wrapRef} className={`ff-picker ${className}`.trim()}>
      <button
        type="button"
        className={`ff-picker-trigger ${triggerClassName}`.trim()}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="ff-picker-trigger-copy">
          <span className="ff-picker-trigger-preview" style={{ fontFamily: selectedCss }}>{selectedLabel}</span>
        </span>
        <ChevronIcon open={isOpen} />
      </button>
      {isOpen && (
        <div className={`ff-picker-dropdown ${dropdownClassName}`.trim()}>
          <div className="ff-picker-search-wrap">
            <input
              className="ff-picker-search"
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              autoFocus
              autoComplete="off"
            />
          </div>
          <div className="ff-picker-upload-wrap">
            <button
              type="button"
              className="ff-picker-upload"
              disabled={isUploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {isUploading ? 'Uploading font...' : '+ Upload own font'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              style={{ display: 'none' }}
              onChange={handleUploadFile}
            />
            {uploadError && <div className="ff-picker-upload-error">{uploadError}</div>}
          </div>
          <div className="ff-picker-list">
            {filteredFonts.map((font) => {
              const isSelected = selectedFont?.name === font.name || (!selectedFont && selectedLabel === font.name);
              return (
                <button
                  key={font.id || font.name}
                  type="button"
                  className={`ff-picker-option${isSelected ? ' ff-picker-option-selected' : ''}${font.category === 'custom' ? ' ff-picker-option-custom' : ''}`}
                  onClick={() => handleSelect(font)}
                >
                  <span className="ff-picker-option-preview" style={{ fontFamily: font.css }}>{font.name}</span>
                  {font.category === 'custom' && (
                    <span
                      className="ff-picker-option-delete"
                      title="Delete font"
                      role="button"
                      tabIndex={-1}
                      onClick={(event) => handleDeleteCustomFont(event, font)}
                    >
                      ×
                    </span>
                  )}
                </button>
              );
            })}
            {filteredFonts.length === 0 && (
              <div className="ff-picker-empty">No fonts found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

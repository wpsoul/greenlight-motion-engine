import { createContext, useContext } from 'react';

/* Project design tokens — the small set of colours a project reuses everywhere.
   They are saved with the video project (`data.colorTokens`) and surfaced as the
   FIRST row of swatches inside every ColorPicker, above the fixed 20-colour
   palette. Delivered by context rather than by prop because the pickers sit
   dozens of levels deep in the inspector, the background selector and the
   gradient editor — a prop would have to be threaded through all of them. */

export const MAX_COLOR_TOKENS = 24;

// A fresh "+" walks this ramp, so repeated clicks never stack identical chips.
export const COLOR_TOKEN_SEEDS = [
  '#8b5cf6', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4',
  '#ec4899', '#3b82f6', '#84cc16', '#f97316', '#14b8a6',
  '#a855f7', '#eab308',
];

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGBA_RE = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+|1\.0+)\s*)?\)$/i;

export function isColorTokenValue(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  return HEX_RE.test(v) || RGBA_RE.test(v);
}

/* Tolerant of both shapes an agent might write: a bare colour string (the
   canonical form) or `{ color }`. Anything unparseable is dropped rather than
   coerced — a silent `#ffffff` in a palette is worse than a missing chip.
   Duplicates are deliberately NOT collapsed: a token the user typed by hand
   should still be there after a reload. */
export function sanitizeColorTokens(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const value = typeof entry === 'string'
      ? entry
      : (entry && typeof entry === 'object' && typeof entry.color === 'string' ? entry.color : null);
    if (!isColorTokenValue(value)) continue;
    const v = value.trim();
    out.push(HEX_RE.test(v) ? v.toLowerCase() : v);
    if (out.length >= MAX_COLOR_TOKENS) break;
  }
  return out;
}

// Next seed colour not already in the list (falls back to the first seed once
// every seed is taken — duplicates are legal, just not the default).
export function nextColorToken(tokens) {
  const taken = new Set((Array.isArray(tokens) ? tokens : []).map((t) => String(t).toLowerCase()));
  return COLOR_TOKEN_SEEDS.find((c) => !taken.has(c)) || COLOR_TOKEN_SEEDS[0];
}

const EMPTY_TOKENS = [];

export const ColorTokensContext = createContext(EMPTY_TOKENS);

export function useColorTokens() {
  const tokens = useContext(ColorTokensContext);
  return Array.isArray(tokens) ? tokens : EMPTY_TOKENS;
}

/*
 * GreenLight Motion Engine — text that wraps onto more lines than it was written with (`npx greenlight-motion check`).
 *
 * The engine's own wrap, measured in this page with its fonts loaded: the same font string, letter spacing, letter case,
 * box width rule and buildWrappedTokens as the draw path (videoEditor/engine/layerMesh.js setupMesh). A line that breaks
 * where nobody broke it is usually a box too narrow for its font: a scene script guesses a text box's width from the
 * number of letters, and a wide bold face can need more. The stills show it; this names it, with the fix.
 */
import { applyTextLetterCase, buildWrappedTokens, setActiveTextRun } from '../components/videoEditor/engine/textPaint';
import { DEFAULT_TEXT_FONT_FAMILY, DEFAULT_TEXT_FONT_WEIGHT, resolveTextFontSize } from '../components/videoEditor/types';
import { walkLayers } from './trace';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** [{ id, text, written, rows, widthPx, fontPx }] — every text layer whose rows outnumber its written lines. */
export async function textWraps(project) {
  const W = Number(project?.videoSize?.w) || 1920;
  const H = Number(project?.videoSize?.h) || 1080;
  const texts = [];
  walkLayers(project, ({ item, clip }) => { if ((clip?.mediaType || item.mediaType) === 'text') texts.push(item); });
  if (!texts.length || typeof document === 'undefined') return [];
  const ctx = document.createElement('canvas').getContext('2d');
  const out = [];
  setActiveTextRun(null);
  for (const item of texts) {
    if (item.textNoWrap || item.textPathEnabled) continue;
    const raw = typeof item.textContent === 'string' ? item.textContent : '';
    if (!raw.trim() || /\{\{/.test(raw)) continue;   // empty, or a placeholder whose text is not known here
    const fontPx = resolveTextFontSize(item, H);
    const weight = clamp(Number(item.textFontWeight) || DEFAULT_TEXT_FONT_WEIGHT, 100, 900);
    const family = (item.textFontFamily || DEFAULT_TEXT_FONT_FAMILY).trim();
    const font = `${item.textFontStyle === 'italic' ? 'italic ' : ''}${weight} ${fontPx}px ${family}`;
    try { await document.fonts.load(font, raw); } catch { /* the system font stands in, as it does when drawn */ }
    ctx.font = font;
    const letterCase = ['lowercase', 'capitalize', 'uppercase'].includes(item.textLetterCase) ? item.textLetterCase : 'none';
    const text = applyTextLetterCase(raw, letterCase).replace(/\r/g, '');
    const widthPx = item.textWidthUnit === 'px' && Number(item.textWidthPx) > 0
      ? clamp(Number(item.textWidthPx), 40, W * 4)
      : W * (clamp(Number(item.textWidthPct) || 86, 5, 100) / 100);
    const spacing = clamp(Number(item.textLetterSpacing) || 0, -20, 80);
    const mode = item.textWrapAnywhere ? 'symbols' : 'words';
    const lines = text.split('\n');
    let rows = 0;
    for (const line of lines) rows += line.trim() ? buildWrappedTokens(line, mode, widthPx, ctx, spacing).length : 1;
    if (rows > lines.length) out.push({ id: item.id, text: raw.replace(/\s+/g, ' ').trim().slice(0, 60), written: lines.length, rows, widthPx: Math.round(widthPx), fontPx });
  }
  return out;
}

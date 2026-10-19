const GRADIENT_RE = /^\s*(linear|radial)-gradient\(/i;

function splitTopLevel(input) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter(Boolean);
}

function clampPercent(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

function normalizeStops(stops) {
  const safeStops = Array.isArray(stops) ? stops : [];
  const normalized = safeStops
    .map((stop, idx) => ({
      color: typeof stop?.color === 'string' && stop.color.trim() ? stop.color.trim() : '#ffffff',
      position: clampPercent(stop?.position, idx === 0 ? 0 : 100),
    }))
    .sort((a, b) => a.position - b.position);
  if (normalized.length >= 2) return normalized;
  if (normalized.length === 1) return [normalized[0], { color: '#000000', position: 100 }];
  return [{ color: '#ffffff', position: 0 }, { color: '#8b5cf6', position: 100 }];
}

function parseStop(part, fallbackPosition) {
  // Normalize grabient "hard stop" swatches: `calc(7.692% + 1px)` → `7.692%`
  // so the stepped multi-stop presets round-trip through the picker/canvas.
  const trimmed = part
    .trim()
    .replace(/calc\(\s*(-?\d*\.?\d+)%\s*[+-]\s*[\d.]+px\s*\)/gi, '$1%');
  // A stop is "<color> [pos%] [pos2%]" — peel trailing percentage tokens off the
  // end (a stop may carry two positions) and take the first as the position.
  const tokens = trimmed.split(/\s+/);
  const posTokens = [];
  while (tokens.length && /^-?\d*\.?\d+%$/.test(tokens[tokens.length - 1])) {
    posTokens.unshift(tokens.pop());
  }
  if (!posTokens.length || !tokens.length) {
    const m = trimmed.match(/(-?\d*\.?\d+)%/);
    return {
      color: tokens.join(' ') || trimmed,
      position: m ? clampPercent(m[1], fallbackPosition) : fallbackPosition,
    };
  }
  return {
    color: tokens.join(' '),
    position: clampPercent(posTokens[0].replace('%', ''), fallbackPosition),
  };
}

export function isCssGradient(value) {
  return typeof value === 'string' && GRADIENT_RE.test(value);
}

export function parseGradient(value) {
  if (!isCssGradient(value)) return null;
  const source = value.trim();
  const match = source.match(/^(linear|radial)-gradient\((.*)\)$/i);
  if (!match) return null;

  const type = match[1].toLowerCase();
  const parts = splitTopLevel(match[2]);
  if (parts.length < 2) return null;

  let angle = 90;
  let stopParts = parts;
  if (type === 'linear') {
    const angleMatch = parts[0].match(/^(-?\d*\.?\d+)deg$/i);
    if (angleMatch) {
      angle = Number(angleMatch[1]);
      stopParts = parts.slice(1);
    } else if (/^to\s+/i.test(parts[0])) {
      const dir = parts[0].toLowerCase().replace(/\s+/g, ' ').trim();
      const byDir = {
        'to top': 0,
        'to right': 90,
        'to bottom': 180,
        'to left': 270,
      };
      angle = byDir[dir] ?? 90;
      stopParts = parts.slice(1);
    }
  } else if (/^(circle|ellipse|at\s+|circle\s+at|ellipse\s+at)/i.test(parts[0])) {
    stopParts = parts.slice(1);
  }

  if (stopParts.length < 2) return null;
  const denom = Math.max(1, stopParts.length - 1);
  const stops = stopParts.map((part, idx) => parseStop(part, (idx / denom) * 100));
  return { type, angle, stops: normalizeStops(stops) };
}

export function buildGradient(type = 'linear', angle = 90, stops = []) {
  const safeType = type === 'radial' ? 'radial' : 'linear';
  const safeAngle = Number.isFinite(Number(angle)) ? Number(angle) : 90;
  const stopText = normalizeStops(stops)
    .map((stop) => `${stop.color} ${Number(stop.position.toFixed(2))}%`)
    .join(', ');
  return safeType === 'radial'
    ? `radial-gradient(circle, ${stopText})`
    : `linear-gradient(${Number(safeAngle.toFixed(2))}deg, ${stopText})`;
}

export function gradientFirstStopColor(value, fallback = '#ffffff') {
  const parsed = parseGradient(value);
  return parsed?.stops?.[0]?.color || fallback;
}

export function buildCanvasGradient(ctx, value, box) {
  const parsed = parseGradient(value);
  if (!parsed || !ctx || !box || box.w <= 0 || box.h <= 0) return null;
  let gradient = null;
  if (parsed.type === 'radial') {
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(box.w, box.h) / 2);
  } else {
    const rad = ((parsed.angle - 90) * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const length = Math.abs(box.w * dx) + Math.abs(box.h * dy);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    gradient = ctx.createLinearGradient(cx - dx * length / 2, cy - dy * length / 2, cx + dx * length / 2, cy + dy * length / 2);
  }
  try {
    parsed.stops.forEach((stop) => gradient.addColorStop(stop.position / 100, stop.color));
  } catch {
    return null;
  }
  return gradient;
}

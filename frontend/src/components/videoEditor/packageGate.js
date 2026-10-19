/*
 * The import gate for executable packages that install into the editor —
 * Advanced Transitions and effect packages (Effects SDK). One list, so the two
 * loaders can never disagree about what package code may touch.
 *
 * This is lint, not a sandbox: package code runs in the editor's own context.
 * What it buys is determinism and portability — a package that reads the wall
 * clock, the network or the DOM cannot render the same frame twice, and an
 * export seeks frames in any order.
 */

export const FORBIDDEN_TOKENS = [
  ['fetch', 'network access'], ['XMLHttpRequest', 'network access'], ['WebSocket', 'network access'],
  ['EventSource', 'network access'], ['importScripts', 'dynamic code loading'], ['require', 'module loading'],
  ['eval', 'dynamic code'], ['Function', 'dynamic code'], ['document', 'DOM access'],
  ['window', 'DOM access'], ['globalThis', 'global access'], ['localStorage', 'storage access'],
  ['sessionStorage', 'storage access'], ['indexedDB', 'storage access'], ['navigator', 'browser APIs'],
  ['process', 'process access'], ['Worker', 'worker spawning'], ['postMessage', 'messaging'],
  ['setTimeout', 'timers'], ['setInterval', 'timers'], ['requestAnimationFrame', 'timers'],
  ['Date', 'wall-clock time'], ['performance', 'wall-clock time'],
];

export function stripCommentsAndStrings(source) {
  let out = '';
  let mode = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (!mode) {
      if (char === "'" || char === '"' || char === '`') { mode = char; out += char; continue; }
      if (char === '/' && next === '/') { mode = '//'; index += 1; continue; }
      if (char === '/' && next === '*') { mode = '/*'; index += 1; continue; }
      out += char;
      continue;
    }
    if (mode === '//') { if (char === '\n') { mode = null; out += char; } continue; }
    if (mode === '/*') { if (char === '*' && next === '/') { mode = null; index += 1; } continue; }
    if (char === '\\') { index += 1; continue; }
    if (char === mode) { mode = null; out += char; }
  }
  return out;
}

export function runStaticGate(source) {
  const code = stripCommentsAndStrings(source);
  const violations = [];
  for (const [token, why] of FORBIDDEN_TOKENS) {
    if (new RegExp(`\\b${token}\\b`).test(code)) violations.push(`"${token}" (${why})`);
  }
  if (/\bMath\s*\.\s*random\b/.test(code)) violations.push('"Math.random" (derive values from progress/options)');
  if (/\bimport\s*\(/.test(code)) violations.push('dynamic import() (dynamic code loading)');
  return violations;
}

// `what` names the package kind in the error ("Transition", "Effect").
export async function importModuleFromSource(code, what = 'Package') {
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  try {
    return await import(/* @vite-ignore */ url);
  } catch (error) {
    throw new Error(`${what} module failed to load: ${error?.message || error}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

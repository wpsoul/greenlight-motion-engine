// ── Keyframe expression language (the ƒx "Custom" type) ─────────────────────
// An After Effects-flavoured expression language: math on `value`, `time`,
// `frame`, and on other layers' animated properties.
//
// Deliberately a hand-written tokenizer + Pratt parser + tree-walking evaluator
// rather than `eval` / `new Function`. Three reasons, in order of importance:
//   1. Safety — project files are shared and imported. An expression is DATA, and
//      data must never reach a JS compiler: `new Function` would hand a shared
//      board arbitrary code execution inside Electron.
//   2. Determinism — `random()` and `wiggle()` are seeded here, so the preview
//      and a re-render of the same frame agree. Real JS randomness would not.
//   3. Budgets — the parser and evaluator are bounded (node count, call depth,
//      step count), so no expression can hang the render loop. A language with
//      no loops and no assignment cannot express an infinite computation.
//
// Everything is a pure function of (source, context). No imports, so this module
// loads under `node --test` and inside a worker.

export class ExprError extends Error {
  constructor(message, pos = 0) {
    super(message);
    this.name = 'ExprError';
    this.pos = pos;
  }
}

// Budgets. Generous for hand-written expressions, tight enough that a pasted
// monster cannot stall a frame.
const MAX_NODES = 600;
const MAX_DEPTH = 40;
const MAX_STEPS = 20000;
export const MAX_EXPR_LENGTH = 4000;

// ── Tokenizer ───────────────────────────────────────────────────────────────

const PUNCT = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '**', '(', ')', '[', ']', ',', '.', '+', '-', '*', '/', '%', '^', '<', '>', '?', ':', '!'];

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    // Comments — // to end of line, /* … */
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // Number (leading digit or .digit)
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const start = i;
      while (i < n && src[i] >= '0' && src[i] <= '9') i += 1;
      if (src[i] === '.') { i += 1; while (i < n && src[i] >= '0' && src[i] <= '9') i += 1; }
      if (src[i] === 'e' || src[i] === 'E') {
        let j = i + 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        if (src[j] >= '0' && src[j] <= '9') {
          i = j;
          while (i < n && src[i] >= '0' && src[i] <= '9') i += 1;
        }
      }
      tokens.push({ type: 'num', value: Number.parseFloat(src.slice(start, i)), pos: start });
      continue;
    }
    // String
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i += 1;
      let out = '';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          const esc = src[i + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          i += 2;
          continue;
        }
        out += src[i];
        i += 1;
      }
      if (i >= n) throw new ExprError('Unterminated string', start);
      i += 1;
      tokens.push({ type: 'str', value: out, pos: start });
      continue;
    }
    // Identifier
    if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i += 1;
      tokens.push({ type: 'ident', value: src.slice(start, i), pos: start });
      continue;
    }
    // Punctuation / operators, longest match first
    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (punct) {
      tokens.push({ type: 'punct', value: punct, pos: i });
      i += punct.length;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}"`, i);
  }
  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}

// ── Parser ──────────────────────────────────────────────────────────────────
// Binary precedence, low binds loosest. `^` and `**` are right-associative.

const BINARY_PRECEDENCE = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3, '===': 3, '!==': 3,
  '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '^': 8, '**': 8,
};
const RIGHT_ASSOC = new Set(['^', '**']);

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
    this.nodes = 0;
  }

  peek() { return this.tokens[this.i]; }

  next() { return this.tokens[this.i++]; }

  isPunct(v) {
    const t = this.peek();
    return t.type === 'punct' && t.value === v;
  }

  expect(v) {
    if (!this.isPunct(v)) throw new ExprError(`Expected "${v}"`, this.peek().pos);
    return this.next();
  }

  node(obj) {
    this.nodes += 1;
    if (this.nodes > MAX_NODES) throw new ExprError('Expression is too long', 0);
    return obj;
  }

  parseExpression(depth = 0) {
    if (depth > MAX_DEPTH) throw new ExprError('Expression is nested too deeply', this.peek().pos);
    const test = this.parseBinary(0, depth + 1);
    if (this.isPunct('?')) {
      this.next();
      const then = this.parseExpression(depth + 1);
      this.expect(':');
      const other = this.parseExpression(depth + 1);
      return this.node({ kind: 'cond', test, then, other });
    }
    return test;
  }

  parseBinary(minPrec, depth) {
    if (depth > MAX_DEPTH) throw new ExprError('Expression is nested too deeply', this.peek().pos);
    let left = this.parseUnary(depth + 1);
    for (;;) {
      const t = this.peek();
      if (t.type !== 'punct') break;
      const prec = BINARY_PRECEDENCE[t.value];
      if (prec === undefined || prec < minPrec) break;
      this.next();
      const nextMin = RIGHT_ASSOC.has(t.value) ? prec : prec + 1;
      const right = this.parseBinary(nextMin, depth + 1);
      left = this.node({ kind: 'bin', op: t.value, left, right, pos: t.pos });
    }
    return left;
  }

  parseUnary(depth) {
    const t = this.peek();
    if (t.type === 'punct' && (t.value === '-' || t.value === '+' || t.value === '!')) {
      this.next();
      return this.node({ kind: 'un', op: t.value, arg: this.parseUnary(depth + 1), pos: t.pos });
    }
    return this.parsePostfix(depth);
  }

  parsePostfix(depth) {
    let target = this.parsePrimary(depth);
    for (;;) {
      if (this.isPunct('.')) {
        this.next();
        const name = this.next();
        if (name.type !== 'ident') throw new ExprError('Expected a property name after "."', name.pos);
        target = this.node({ kind: 'member', target, name: name.value, pos: name.pos });
      } else if (this.isPunct('[')) {
        const open = this.next();
        const index = this.parseExpression(depth + 1);
        this.expect(']');
        target = this.node({ kind: 'index', target, index, pos: open.pos });
      } else if (this.isPunct('(')) {
        const open = this.next();
        const args = [];
        if (!this.isPunct(')')) {
          for (;;) {
            args.push(this.parseExpression(depth + 1));
            if (this.isPunct(',')) { this.next(); continue; }
            break;
          }
        }
        this.expect(')');
        target = this.node({ kind: 'call', callee: target, args, pos: open.pos });
      } else break;
    }
    return target;
  }

  parsePrimary(depth) {
    const t = this.next();
    if (t.type === 'num') return this.node({ kind: 'num', value: t.value });
    if (t.type === 'str') return this.node({ kind: 'str', value: t.value });
    if (t.type === 'ident') return this.node({ kind: 'ident', name: t.value, pos: t.pos });
    if (t.type === 'punct' && t.value === '(') {
      const inner = this.parseExpression(depth + 1);
      this.expect(')');
      return inner;
    }
    if (t.type === 'punct' && t.value === '[') {
      const items = [];
      if (!this.isPunct(']')) {
        for (;;) {
          items.push(this.parseExpression(depth + 1));
          if (this.isPunct(',')) { this.next(); continue; }
          break;
        }
      }
      this.expect(']');
      return this.node({ kind: 'array', items });
    }
    throw new ExprError(t.type === 'eof' ? 'Expression is incomplete' : `Unexpected "${t.value}"`, t.pos);
  }
}

// Parse `src` into an AST. Throws ExprError with a character position.
export function parseExpression(src) {
  const text = String(src ?? '');
  if (text.length > MAX_EXPR_LENGTH) throw new ExprError('Expression is too long');
  // An expression may end with a trailing `;` (AE examples often do) and may be
  // written as a series of lines where only the last one is the result — but we
  // support neither statements nor assignment, so a bare `;` is just trimmed.
  const trimmed = text.trim().replace(/;+\s*$/, '');
  if (!trimmed) throw new ExprError('Expression is empty');
  const parser = new Parser(tokenize(trimmed));
  const ast = parser.parseExpression();
  const tail = parser.peek();
  if (tail.type !== 'eof') throw new ExprError(`Unexpected "${tail.value}"`, tail.pos);
  return ast;
}

// Compiled-AST cache: the same expression is evaluated on every frame, for every
// layer that uses it. Bounded so a project full of one-off expressions cannot
// grow it without limit.
const astCache = new Map();
const AST_CACHE_MAX = 200;

export function compileExpression(src) {
  const key = String(src ?? '');
  const hit = astCache.get(key);
  if (hit) return hit;
  let entry;
  try {
    entry = { ast: parseExpression(key), error: null };
  } catch (err) {
    entry = { ast: null, error: err instanceof ExprError ? err : new ExprError(String(err?.message || err)) };
  }
  if (astCache.size >= AST_CACHE_MAX) astCache.delete(astCache.keys().next().value);
  astCache.set(key, entry);
  return entry;
}

/**
 * Names of the layers an expression reads, in source order, deduped.
 *
 * Walks the AST rather than regexing the text, because only the *head* of a
 * chain names a layer on this timeline: in `layer("Seq").layer("Inner")` the
 * selectable layer is "Seq", and `thisLayer.layer("Inner")` names none at all.
 * A `layer(…)` written inside a string or comment is likewise invisible here,
 * which a regex could not tell apart.
 *
 * Returns [] for anything unparseable — a half-typed expression must not throw
 * at the panel that is rendering while you type.
 */
export function expressionLayerNames(src) {
  const { ast, error } = compileExpression(src);
  if (error || !ast) return [];
  const names = [];
  const seen = new Set();
  const add = (v) => {
    if (typeof v !== 'string') return;
    const name = v.trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'call') {
      const callee = node.callee;
      // `layer("X")` — the bare global.
      const bare = callee?.kind === 'ident' && callee.name === 'layer';
      // `thisComp.layer("X")` — same thing, AE spelling. Any other `.layer(…)`
      // is a drill-down into a container, whose head was already collected.
      const viaComp = callee?.kind === 'member' && callee.name === 'layer'
        && callee.target?.kind === 'ident' && callee.target.name === 'thisComp';
      if ((bare || viaComp) && node.args?.[0]?.kind === 'str') add(node.args[0].value);
    }
    for (const key of ['callee', 'target', 'left', 'right', 'arg', 'test', 'then', 'other', 'index']) {
      if (node[key]) walk(node[key]);
    }
    for (const key of ['args', 'items']) {
      if (Array.isArray(node[key])) node[key].forEach(walk);
    }
  };

  walk(ast);
  return names;
}

// ── Deterministic noise ─────────────────────────────────────────────────────
// Shared with keyframeFx's Wiggle type so both jitters come from one generator.

export function latticeNoise(i, seed) {
  let h = Math.imul(i | 0, 374761393) + Math.imul(seed | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h & 0x7fffffff) / 0x3fffffff) - 1;
}

export function stringSeed(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

// Value noise in [-1, 1]: smoothstep between integer lattice points.
export function smoothNoise(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return latticeNoise(i, seed) * (1 - u) + latticeNoise(i + 1, seed) * u;
}

// Fractal sum, the shape AE's wiggle() has: each octave doubles the frequency
// and halves the amplitude.
function fractalNoise(x, seed, octaves) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let freq = 1;
  const n = Math.max(1, Math.min(4, Math.round(octaves)));
  for (let o = 0; o < n; o += 1) {
    sum += smoothNoise(x * freq, seed + o * 1013) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

// ── Loops (After Effects' loopOut / loopIn) ─────────────────────────────────
// Repeat a track's keyframed animation beyond its last key (loopOut) or before
// its first (loopIn). The four types match AE:
//   cycle     start the segment again
//   pingpong  play it backwards, then forwards, …
//   offset    repeat it, each pass stacked on the end of the previous one
//   continue  no repeat — keep going at the velocity of the end key
//
// `n` counts KEYFRAMES of the looped segment the way AE does (0 = the whole
// track, 1 = the last segment, …); the *Duration variants take seconds instead.
// Every branch is continuous at the boundary key, so a loop never pops.

const LOOP_TYPES = new Set(['cycle', 'pingpong', 'offset', 'continue']);

function loopSegment(keyTimes, n, isOut, byDuration) {
  const first = keyTimes[0];
  const last = keyTimes[keyTimes.length - 1];
  if (byDuration) {
    const d = Math.abs(n);
    if (!(d > 0)) return [first, last];
    return isOut
      ? [Math.max(first, last - d), last]
      : [first, Math.min(last, first + d)];
  }
  const count = Math.max(0, Math.round(n));
  if (count <= 0) return [first, last];
  const idx = isOut
    ? Math.max(0, keyTimes.length - 1 - count)
    : Math.min(keyTimes.length - 1, count);
  return isOut ? [keyTimes[idx], last] : [first, keyTimes[idx]];
}

function loopValue(ctx, isOut, typeRaw, n, byDuration) {
  const keyTimes = ctx.keyTimes;
  const valueAt = ctx.valueAt;
  // Nothing to repeat: no track, a single key, or no sampler.
  if (typeof valueAt !== 'function' || !Array.isArray(keyTimes) || keyTimes.length < 2) return ctx.value;
  const type = String(typeRaw ?? 'cycle').toLowerCase();
  if (!LOOP_TYPES.has(type)) throw new ExprError(`Unknown loop type "${typeRaw}" — use cycle, pingpong, offset or continue`);

  const t = num(ctx.time);
  const [segStart, segEnd] = loopSegment(keyTimes, num(n), isOut, byDuration);
  const edge = isOut ? keyTimes[keyTimes.length - 1] : keyTimes[0];
  // Inside the animation itself the keyframes rule; a loop only extends beyond it.
  const delta = isOut ? t - edge : edge - t;
  if (delta <= 0) return ctx.value;

  const span = segEnd - segStart;
  if (!(span > 0)) return valueAt(edge);

  if (type === 'continue') {
    // Velocity at the boundary key, sampled just inside the animation.
    const h = Math.min(span * 0.25, 1 / 60);
    const vEdge = valueAt(edge);
    const slope = isOut
      ? (vEdge - valueAt(edge - h)) / h
      : (valueAt(edge + h) - vEdge) / h;
    return vEdge + slope * (isOut ? delta : -delta);
  }

  const cycles = Math.floor(delta / span);
  const phase = delta - cycles * span;

  if (type === 'pingpong') {
    // Even passes run away from the edge, odd ones run back toward it.
    const backwards = cycles % 2 === 0;
    const at = isOut
      ? (backwards ? segEnd - phase : segStart + phase)
      : (backwards ? segStart + phase : segEnd - phase);
    return valueAt(at);
  }

  const at = isOut ? segStart + phase : segEnd - phase;
  const v = valueAt(at);
  if (type === 'cycle') return v;
  // offset: each completed pass shifts by the segment's total value change, so
  // the animation accumulates instead of snapping back.
  const rise = valueAt(segEnd) - valueAt(segStart);
  return v + rise * (cycles + 1) * (isOut ? 1 : -1);
}

// ── glide() ─────────────────────────────────────────────────────────────────
// Inertia without spring-back: this track's own keyframed motion run through a
// causal filter whose weights are ALL positive — a fast exponential response
// (time constant `fast`) plus a slow exponential tail (`slow`) carrying `weight`
// of every move, optionally held back by `delay`. A move lands soft and keeps
// creeping on in the direction it travelled; it never passes the key and never
// reverses (a spring would lag, overshoot and come back — read as a wrong-way
// secondary motion). Exponential weights are integrated with a fixed tap count,
// so the cost per frame does not grow with the time constants.
const GLIDE_FAST_TAPS = 48;
const GLIDE_SLOW_TAPS = 64;

export function glideValue(ctx, fastArg, slowArg, weightArg, delayArg) {
  const valueAt = ctx.valueAt;
  if (typeof valueAt !== 'function') return num(ctx.value);
  const fast = clampNumber(fastArg === undefined ? 0.1 : num(fastArg), 0.005, 3);
  const slow = clampNumber(slowArg === undefined ? 0.6 : num(slowArg), 0.01, 8);
  const weight = clampNumber(weightArg === undefined ? 0.25 : num(weightArg), 0, 1);
  const delay = clampNumber(delayArg === undefined ? 0 : num(delayArg), 0, 3);
  const t = num(ctx.time);
  let acc = 0;
  let total = 0;
  const part = (share, tau0, timeConstant, taps) => {
    if (share <= 0) return;
    // Four time constants hold 98 % of an exponential; the tap at τ carries the
    // area of its own slice so the sum is a proper (normalized) integral.
    const span = 4 * timeConstant;
    const step = span / taps;
    for (let i = 0; i <= taps; i += 1) {
      const tau = i * step;
      const w = share * Math.exp(-tau / timeConstant) * step / timeConstant;
      acc += w * valueAt(t - tau0 - tau);
      total += w;
    }
  };
  part(1 - weight, 0, fast, GLIDE_FAST_TAPS);
  part(weight, delay, slow, GLIDE_SLOW_TAPS);
  return total > 0 ? acc / total : num(ctx.value);
}

// ── Evaluator ───────────────────────────────────────────────────────────────

const num = (v) => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const truthy = (v) => (typeof v === 'number' ? v !== 0 : !!v);

function clampNumber(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// AE's linear()/ease(): remap t from [tMin,tMax] onto [v1,v2], clamped at both
// ends. Also accepts the 3-argument form linear(t, v1, v2) with t in 0..1.
function remap(args, shape) {
  let t;
  let tMin;
  let tMax;
  let v1;
  let v2;
  if (args.length <= 3) {
    t = num(args[0]); tMin = 0; tMax = 1; v1 = num(args[1]); v2 = num(args[2]);
  } else {
    t = num(args[0]); tMin = num(args[1]); tMax = num(args[2]); v1 = num(args[3]); v2 = num(args[4]);
  }
  if (tMax === tMin) return t <= tMin ? v1 : v2;
  const raw = clampNumber((t - tMin) / (tMax - tMin), 0, 1);
  return v1 + (v2 - v1) * shape(raw);
}

const EASE_SHAPES = {
  linear: (u) => u,
  ease: (u) => u * u * u * (u * (u * 6 - 15) + 10),
  easeIn: (u) => u * u,
  easeOut: (u) => 1 - (1 - u) * (1 - u),
};

// The `Math` namespace, mirroring the JS one an AE user expects. Built as a null
// -prototype dictionary so member access can never reach Object.prototype.
function makeMathNamespace() {
  const ns = Object.create(null);
  const unary = ['abs', 'floor', 'ceil', 'round', 'sqrt', 'cbrt', 'exp', 'log', 'log2', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'sign', 'trunc'];
  for (const name of unary) ns[name] = (...a) => Math[name](num(a[0]));
  ns.pow = (a, b) => Math.pow(num(a), num(b));
  ns.atan2 = (a, b) => Math.atan2(num(a), num(b));
  ns.hypot = (...a) => Math.hypot(...a.map(num));
  ns.min = (...a) => (a.length ? Math.min(...a.map(num)) : 0);
  ns.max = (...a) => (a.length ? Math.max(...a.map(num)) : 0);
  ns.PI = Math.PI;
  ns.E = Math.E;
  return ns;
}
const MATH_NS = makeMathNamespace();

// Everything that does not depend on the moment being evaluated, built once.
// Each evaluation puts its own `value`/`time`/`wiggle`/… on an object whose
// PROTOTYPE is this one, so the hot path allocates a handful of closures rather
// than thirty. Null-prototype at the root, so the `in` lookups that resolve
// names still cannot walk out to Object.prototype.
const STATIC_GLOBALS = (() => {
  const g = Object.create(null);
  g.PI = Math.PI;
  g.E = Math.E;
  g.Math = MATH_NS;
  // Bare aliases for the everyday math, so `sin(time)` works like `Math.sin(time)`.
  for (const name of ['abs', 'floor', 'ceil', 'round', 'sqrt', 'exp', 'log', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow', 'min', 'max', 'sign', 'hypot']) {
    g[name] = MATH_NS[name];
  }
  g.clamp = (v, lo, hi) => clampNumber(num(v), num(lo), num(hi));
  g.lerp = (a, b, t) => num(a) + (num(b) - num(a)) * num(t);
  g.linear = (...a) => remap(a, EASE_SHAPES.linear);
  g.ease = (...a) => remap(a, EASE_SHAPES.ease);
  g.easeIn = (...a) => remap(a, EASE_SHAPES.easeIn);
  g.easeOut = (...a) => remap(a, EASE_SHAPES.easeOut);
  g.degrees = (r) => (num(r) * 180) / Math.PI;
  g.radians = (d) => (num(d) * Math.PI) / 180;
  g.seedRandom = () => 0; // accepted for AE-paste compatibility; seeding is automatic
  return g;
})();

/**
 * Evaluate a compiled AST.
 *
 * ctx:
 *   value      the property's keyframed value at this moment (AE's `value`)
 *   time       seconds since the start of the clip
 *   frame      whole frames since the start of the clip
 *   fps, duration, progress (0-1), index (layer's channel index)
 *   seed       integer; makes random()/wiggle() repeatable per layer+property
 *   resolveLayer(nameOrIndex) -> ({ get(prop) -> number }) | null
 *   resolveSelf() -> ({ get(prop) -> number }) | null
 */
export function evaluateAst(ast, ctx) {
  const state = { steps: 0 };
  // Distinct call sites of random() must not return the same number, and the
  // same call site must return the same number for the same frame.
  let randomCounter = 0;

  const seed = ctx.seed | 0;
  const timeSeed = () => Math.floor(num(ctx.time) * 1000);

  const layerRef = (ref) => {
    if (!ref) return null;
    const obj = Object.create(null);
    obj.__layer = ref;
    return obj;
  };

  const globals = Object.create(STATIC_GLOBALS);
  globals.value = ctx.value;
  globals.time = ctx.time;
  globals.frame = ctx.frame;
  globals.fps = ctx.fps;
  globals.duration = ctx.duration;
  globals.progress = ctx.progress;
  globals.index = ctx.index;
  globals.thisProperty = ctx.value;
  globals.noise = (t, octaves) => fractalNoise(num(t), seed, octaves === undefined ? 1 : num(octaves));
  // wiggle(freq, amp, octaves?) — amp is in the property's own units, like AE.
  globals.wiggle = (freq, amp, octaves) => num(ctx.value)
    + num(amp) * fractalNoise(num(ctx.time) * num(freq), seed, octaves === undefined ? 2 : num(octaves));
  globals.random = (...a) => {
    randomCounter += 1;
    const r = (latticeNoise(timeSeed() + randomCounter * 7919, seed) + 1) / 2; // 0..1
    if (a.length === 0) return r;
    if (a.length === 1) return r * num(a[0]);
    return num(a[0]) + r * (num(a[1]) - num(a[0]));
  };
  globals.loopOut = (type, n) => loopValue(ctx, true, type, n, false);
  globals.loopIn = (type, n) => loopValue(ctx, false, type, n, false);
  globals.loopOutDuration = (type, d) => loopValue(ctx, true, type, d, true);
  globals.loopInDuration = (type, d) => loopValue(ctx, false, type, d, true);
  globals.numKeys = Array.isArray(ctx.keyTimes) ? ctx.keyTimes.length : 0;
  // valueAtTime(t) — this property's own keyframed value at another moment.
  globals.valueAtTime = (t) => (typeof ctx.valueAt === 'function' ? ctx.valueAt(num(t)) : ctx.value);
  // glide(fast?, slow?, weight?, delay?) — soft landing that keeps sliding on; see glideValue.
  globals.glide = (fast, slow, weight, delay) => glideValue(ctx, fast, slow, weight, delay);
  globals.layer = (name) => {
    const ref = ctx.resolveLayer?.(typeof name === 'string' ? name : num(name));
    // Naming the wrong layer is the single most likely mistake in an expression,
    // so say so plainly instead of failing later on the property access.
    if (!ref) throw new ExprError(`No layer named ${JSON.stringify(String(name))} overlaps this clip`);
    return layerRef(ref);
  };
  globals.thisLayer = layerRef(ctx.resolveSelf?.());
  globals.thisComp = (() => {
    const ns = Object.create(null);
    ns.layer = globals.layer;
    ns.duration = ctx.duration;
    ns.frameDuration = ctx.fps > 0 ? 1 / ctx.fps : 1 / 30;
    return ns;
  })();

  const walk = (node) => {
    state.steps += 1;
    if (state.steps > MAX_STEPS) throw new ExprError('Expression is too slow to evaluate');
    switch (node.kind) {
      case 'num':
      case 'str':
        return node.value;
      case 'array':
        return node.items.map(walk);
      case 'ident': {
        if (!(node.name in globals)) throw new ExprError(`Unknown name "${node.name}"`, node.pos);
        return globals[node.name];
      }
      case 'un': {
        const v = walk(node.arg);
        if (node.op === '-') return -num(v);
        if (node.op === '+') return num(v);
        return truthy(v) ? 0 : 1;
      }
      case 'bin': {
        const op = node.op;
        // Short-circuit before evaluating the right side.
        if (op === '&&') { const l = walk(node.left); return truthy(l) ? walk(node.right) : l; }
        if (op === '||') { const l = walk(node.left); return truthy(l) ? l : walk(node.right); }
        const l = walk(node.left);
        const r = walk(node.right);
        switch (op) {
          // `+` concatenates when either side is a string, like JS.
          case '+': return (typeof l === 'string' || typeof r === 'string') ? `${l}${r}` : num(l) + num(r);
          case '-': return num(l) - num(r);
          case '*': return num(l) * num(r);
          case '/': { const d = num(r); return d === 0 ? 0 : num(l) / d; }
          case '%': { const d = num(r); return d === 0 ? 0 : num(l) % d; }
          case '^': case '**': return Math.pow(num(l), num(r));
          case '<': return num(l) < num(r) ? 1 : 0;
          case '>': return num(l) > num(r) ? 1 : 0;
          case '<=': return num(l) <= num(r) ? 1 : 0;
          case '>=': return num(l) >= num(r) ? 1 : 0;
          case '==': case '===': return l === r ? 1 : 0;
          case '!=': case '!==': return l !== r ? 1 : 0;
          default: throw new ExprError(`Unknown operator "${op}"`, node.pos);
        }
      }
      case 'cond':
        return truthy(walk(node.test)) ? walk(node.then) : walk(node.other);
      case 'index': {
        const target = walk(node.target);
        const idx = walk(node.index);
        if (Array.isArray(target)) return target[Math.trunc(num(idx))] ?? 0;
        if (target && typeof target === 'object' && target.__layer) return target.__layer.get(String(idx));
        // Refused rather than silently 0, so `value["constructor"]` reads as the
        // mistake it is instead of quietly becoming a number.
        throw new ExprError('Only layers and lists can be indexed', node.pos);
      }
      case 'member': {
        const target = walk(node.target);
        if (target && typeof target === 'object') {
          if (target.__layer) {
            // `.layer("Inner")` drills into a sequence/grid's own timeline;
            // chaining it walks nested containers level by level.
            if (node.name === 'layer') {
              return (inner) => {
                const child = target.__layer.child?.(String(inner));
                if (!child) throw new ExprError(`Cannot read layers inside ${JSON.stringify(String(inner))} here`, node.pos);
                return layerRef(child);
              };
            }
            // Any other name is a property, resolved through the scene.
            return target.__layer.get(node.name);
          }
          // Namespaces (Math, thisComp) are null-prototype dictionaries, so this
          // lookup can only ever see keys we put there.
          if (node.name in target) return target[node.name];
          throw new ExprError(`Unknown property "${node.name}"`, node.pos);
        }
        if (Array.isArray(target)) return node.name === 'length' ? target.length : 0;
        throw new ExprError(`"${node.name}" is not available here`, node.pos);
      }
      case 'call': {
        const fn = walk(node.callee);
        if (typeof fn !== 'function') throw new ExprError('Not a function', node.pos);
        const args = node.args.map(walk);
        return fn(...args);
      }
      default:
        throw new ExprError('Unsupported expression', node.pos);
    }
  };

  const out = walk(ast);
  return out;
}

/**
 * Compile + evaluate in one call. Returns { value, error }: `error` is a
 * human-readable string for the panel, and `value` falls back to ctx.value so a
 * broken expression never breaks the render.
 */
export function runExpression(src, ctx) {
  const { ast, error } = compileExpression(src);
  if (error) return { value: ctx.value, error: error.message };
  try {
    const raw = evaluateAst(ast, ctx);
    const v = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (!Number.isFinite(v)) return { value: ctx.value, error: 'Result is not a number' };
    return { value: v, error: null };
  } catch (err) {
    return { value: ctx.value, error: err instanceof ExprError ? err.message : String(err?.message || err) };
  }
}

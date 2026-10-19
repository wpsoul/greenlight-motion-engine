/*
 * TSL twins of the Object family (objectEffects.js).
 *
 * A missing WebGPU twin is a SILENT no-op — createEffectNodeMaterial returns null
 * and getEffectMaterial's caller does `if (!mat) continue` — so these ship in the
 * same commit as the GLSL, not after it.
 *
 * ORIENTATION, the family's one flip hazard, stated here as well as in
 * objectTracking.js: the field is read at `vec2(p.x, 1 - p.y)` where p is
 * `fxLocal()`. That expression is IDENTICAL in both backends and must stay that
 * way — fxLocal box-space positions port VERBATIM (project_fxlocal_orientation_parity),
 * and the y flip here is not a backend correction, it is the image-row-0-is-top
 * convention of the stored field. The same goes for the boxes: 1 - y - h, once.
 *
 * The four prelude helpers (luma / unpremult / premult / hash21) are re-declared
 * locally rather than imported from adjustmentEffectNodes.js, which imports THIS
 * file — a cycle for four one-line functions would be a bad trade.
 */

import {
  Fn, If, Loop, Break, int, vec2, vec3, vec4, float, dot, mix, clamp, smoothstep,
  abs, max, min, length, floor, fract, sqrt, sin, step, select, mod, normalize,
} from 'three/tsl';

const luma = Fn(([c]) => dot(c, vec3(0.2126, 0.7152, 0.0722)))
  .setLayout({ name: 'objLuma', type: 'float', inputs: [{ name: 'c', type: 'vec3' }] });

const unpremult = Fn(([c]) => c.rgb.div(max(c.a, 1e-4)))
  .setLayout({ name: 'objUnpremult', type: 'vec3', inputs: [{ name: 'c', type: 'vec4' }] });

const premult = Fn(([c, a]) => vec4(c.mul(clamp(a, 0.0, 1.0)), clamp(a, 0.0, 1.0)))
  .setLayout({
    name: 'objPremult', type: 'vec4',
    inputs: [{ name: 'c', type: 'vec3' }, { name: 'a', type: 'float' }],
  });

const hash21 = Fn(([pIn]) => {
  const p = fract(pIn.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
}).setLayout({ name: 'objHash21', type: 'float', inputs: [{ name: 'pIn', type: 'vec2' }] });

// The 2×2 ordered-dither base, folded into itself for 4×4 and 8×8 — the exact
// construction the GLSL prelude uses.
const bayer2 = Fn(([a]) => {
  const q = floor(a);
  return fract(q.x.mul(0.5).add(q.y.mul(q.y).mul(0.75)));
}).setLayout({ name: 'objBayer2', type: 'float', inputs: [{ name: 'a', type: 'vec2' }] });

const bayer4 = Fn(([a]) => bayer2(a.mul(0.5)).mul(0.25).add(bayer2(a)))
  .setLayout({ name: 'objBayer4', type: 'float', inputs: [{ name: 'a', type: 'vec2' }] });

const bayer8 = Fn(([a]) => bayer4(a.mul(0.5)).mul(0.25).add(bayer2(a)))
  .setLayout({ name: 'objBayer8', type: 'float', inputs: [{ name: 'a', type: 'vec2' }] });

/* The per-material kit: everything that reads a uniform has to be a plain closure
   (PORTING-GUIDE §2), so these are built per material rather than laid out. */
function objKit(u, helpers) {
  const P = u.uParams;
  const { fxLocal, fxFrame, fxRes, fxCoord, fxAspect } = helpers;

  const C = (i) => vec3(
    u.uColors.element(i * 3),
    u.uColors.element(i * 3 + 1),
    u.uColors.element(i * 3 + 2),
  );

  // The weight at a LAYER-space point. Slot 18 is the has-field flag; with no
  // field the sampler's white placeholder already reads 1.0, and the select keeps
  // that true even if a driver hands back something else.
  const fieldAt = (p) => {
    const fuv = vec2(clamp(p.x, 0.0, 1.0), clamp(float(1.0).sub(p.y), 0.0, 1.0));
    return select(P.element(18).lessThan(0.5), float(1.0), u.uTexture1.sample(fuv).r);
  };

  // Image-space box (x, y, w, h) → layer-local, +y up. Flipped ONCE, here.
  const faceBox = () => vec4(
    P.element(20), float(1.0).sub(P.element(21)).sub(P.element(23)), P.element(22), P.element(23),
  );
  const subjectBox = () => vec4(
    P.element(24), float(1.0).sub(P.element(25)).sub(P.element(27)), P.element(26), P.element(27),
  );

  const lumAt = (p) => {
    const f = fxFrame(p).toVar();
    const inside = f.x.greaterThanEqual(0.0).and(f.x.lessThanEqual(1.0))
      .and(f.y.greaterThanEqual(0.0)).and(f.y.lessThanEqual(1.0));
    const s = u.uTexture.sample(clamp(f, vec2(0.0), vec2(1.0))).toVar();
    return select(inside, luma(unpremult(s)).mul(step(0.004, s.a)), float(0.0));
  };

  const levelAt = (p, l, spread, contrast, on) => {
    const m = lumAt(p.add(vec2(spread, 0.0)))
      .add(lumAt(p.sub(vec2(spread, 0.0))))
      .add(lumAt(p.add(vec2(0.0, spread))))
      .add(lumAt(p.sub(vec2(0.0, spread))))
      .add(lumAt(p.add(vec2(spread, spread).mul(0.7))))
      .add(lumAt(p.sub(vec2(spread, spread).mul(0.7))))
      .add(lumAt(p.add(vec2(spread, spread.negate()).mul(0.7))))
      .add(lumAt(p.add(vec2(spread.negate(), spread).mul(0.7))))
      .div(8.0);
    const n = clamp(float(0.5).add(l.sub(m).div(0.84)), 0.0, 1.0);
    const auto = clamp(float(0.5).add(n.sub(0.5).mul(contrast)), 0.0, 1.0);
    const flat = clamp(float(0.5).add(l.sub(0.5).mul(contrast)), 0.0, 1.0);
    return select(on.lessThan(0.5), flat, auto);
  };

  const edgeAt = (p, e) => {
    const gx = lumAt(p.add(vec2(e, 0.0))).sub(lumAt(p.sub(vec2(e, 0.0))));
    const gy = lumAt(p.add(vec2(0.0, e))).sub(lumAt(p.sub(vec2(0.0, e))));
    return sqrt(gx.mul(gx).add(gy.mul(gy)));
  };

  const regionAt = (p, mode, soft) => {
    const w = fieldAt(p);
    const s = max(soft, 0.01);
    const inSubject = smoothstep(float(0.5).sub(s), float(0.5).add(s), w);
    return select(
      mode.lessThan(0.5),
      float(1.0),
      select(mode.lessThan(1.5), inSubject, float(1.0).sub(inSubject)),
    );
  };

  // The GLSL prelude's sampleClamped: outside the plate is transparent, not a
  // clamped edge smear (a smear would streak the curtain off the frame edge).
  const sampleAt = (p) => {
    const f = fxFrame(p).toVar();
    const inside = f.x.greaterThanEqual(0.0).and(f.x.lessThanEqual(1.0))
      .and(f.y.greaterThanEqual(0.0)).and(f.y.lessThanEqual(1.0));
    return select(inside, u.uTexture.sample(clamp(f, vec2(0.0), vec2(1.0))), vec4(0.0));
  };

  return {
    P, C, fieldAt, faceBox, subjectBox, lumAt, levelAt, edgeAt, regionAt, sampleAt,
    fxLocal, fxRes, fxCoord, fxAspect,
  };
}

/* ── Dither Print ─────────────────────────────────────────────────────────── */

const objectDither = ({ u, uvn, srcCol, helpers }) => {
  const k = objKit(u, helpers);
  const { P } = k;
  const lp = k.fxLocal(uvn).toVar();
  const res = k.fxRes();

  const pitchPx = max(P.element(0).mul(res.y.div(1080.0)), 1.0);
  const cellUv = vec2(pitchPx).div(max(res, vec2(1.0))).toVar();

  const coarse = floor(lp.div(cellUv));
  const coarseCentre = coarse.add(0.5).mul(cellUv);
  const wCell = k.fieldAt(coarseCentre);
  const sub = floor(float(1.0).add(P.element(7).div(100.0).mul(3.0).mul(wCell)).add(0.5));
  const fine = cellUv.div(sub).toVar();
  const cell = floor(lp.div(fine)).toVar();
  const centre = cell.add(0.5).mul(fine).toVar();

  const e = P.element(3).div(100.0);
  const l0 = clamp(k.lumAt(centre).add(k.edgeAt(centre, fine.x).mul(e).mul(1.4)), 0.0, 1.0);
  const contrast = mix(0.4, 3.2, clamp(P.element(2).div(100.0), 0.0, 1.0));
  const l = k.levelAt(centre, l0, max(fine.x, fine.y).mul(6.0), contrast, P.element(8)).toVar();

  const thr2 = P.element(1).div(100.0).mul(2.0).toVar();
  const algo = P.element(4);
  // The halftone screen is an amplitude-modulated dot inside the cell rather than
  // a per-cell threshold, exactly as in the GLSL.
  const d = lp.sub(centre).div(fine);
  const rr = length(d).mul(2.0);
  const halftoneT = rr.mul(rr).mul(max(thr2, 0.02));
  const t = select(
    algo.lessThan(0.5), thr2.mul(bayer4(cell)),
    select(
      algo.lessThan(1.5), thr2.mul(bayer8(cell)),
      select(algo.lessThan(2.5), thr2.mul(hash21(cell.mul(0.137).add(3.7))), halftoneT),
    ),
  );
  const on = step(t, l);

  const region = k.regionAt(centre, P.element(5), P.element(6).div(100.0));
  const paperA = clamp(P.element(9).div(100.0), 0.0, 1.0).mul(region);
  const inkA = on.mul(region);

  const straight = unpremult(srcCol);
  const col = mix(mix(straight, k.C(1), paperA), k.C(0), inkA);
  return premult(col, srcCol.a);
};

/* ── Field Isolines ───────────────────────────────────────────────────────── */

const objectIsolines = ({ u, uvn, srcCol, helpers }) => {
  const k = objKit(u, helpers);
  const { P } = k;
  const lp = k.fxLocal(uvn).toVar();
  const res = k.fxRes();

  // Smoothed field — the blur radius IS the ring spacing, in field cells.
  const r = max(P.element(1), 0.5).div(64.0).toVar();
  const smoothed = (p) => k.fieldAt(p)
    .add(k.fieldAt(p.add(vec2(r, 0.0))))
    .add(k.fieldAt(p.sub(vec2(r, 0.0))))
    .add(k.fieldAt(p.add(vec2(0.0, r))))
    .add(k.fieldAt(p.sub(vec2(0.0, r))))
    .add(k.fieldAt(p.add(vec2(r, r).mul(0.7071))))
    .add(k.fieldAt(p.sub(vec2(r, r).mul(0.7071))))
    .add(k.fieldAt(p.add(vec2(r, r.negate()).mul(0.7071))))
    .add(k.fieldAt(p.add(vec2(r.negate(), r).mul(0.7071))))
    .div(9.0);

  const f = smoothed(lp).toVar();
  const gx = smoothed(lp.add(vec2(r, 0.0))).sub(smoothed(lp.sub(vec2(r, 0.0))));
  const gy = smoothed(lp.add(vec2(0.0, r))).sub(smoothed(lp.sub(vec2(0.0, r))));
  const grad = vec2(gx, gy).div(r.mul(2.0)).toVar();
  const gl = max(length(grad), 1e-3).toVar();

  const rings = max(floor(P.element(0).add(0.5)), 1.0).toVar();
  const inward = floor(rings.mul(clamp(P.element(2).div(100.0), 0.0, 1.0)).add(0.5)).toVar();
  const halfW = max(P.element(3), 0.05).mul(0.5).div(max(res.y, 1.0)).toVar();
  const dashPx = max(P.element(4), 0.0).toVar();
  const fade = clamp(P.element(5).div(100.0), 0.0, 1.0).toVar();

  const acc = vec3(0.0).toVar();
  const cov = float(0.0).toVar();
  Loop({ start: int(0), end: int(24) }, ({ i }) => {
    const fi = float(i).toVar();
    If(fi.greaterThanEqual(rings), () => { Break(); });
    const outward = fi.greaterThanEqual(inward);
    const kk = select(
      outward,
      fi.sub(inward).add(1.0).div(rings.sub(inward).add(1.0)),
      inward.sub(fi).div(inward.add(1.0)),
    ).toVar();
    const level = select(outward, float(0.5).sub(kk.mul(0.46)), float(0.5).add(kk.mul(0.46)));
    const dist = abs(f.sub(level)).div(gl);
    const line = float(1.0).sub(smoothstep(halfW.mul(0.6), halfW.mul(1.4), dist)).toVar();
    If(line.greaterThan(0.0), () => {
      If(dashPx.greaterThan(0.0), () => {
        // Dashes march ALONG the contour: the tangent is the gradient's normal.
        const tangent = vec2(grad.y.negate(), grad.x).div(gl);
        const sPos = dot(lp.mul(res), tangent);
        line.mulAssign(step(0.35, fract(sPos.div(max(dashPx.mul(1.8), 1.0)))));
      });
      const a = line.mul(mix(1.0, max(float(1.0).sub(kk), 0.05), fade));
      const col = select(
        abs(fi.sub(inward)).lessThan(0.5),
        k.C(2),
        select(outward, k.C(0), k.C(1)),
      );
      acc.addAssign(col.mul(a));
      cov.addAssign(a);
    });
  });

  const region = k.regionAt(lp, P.element(6), P.element(7).div(100.0));
  const a = clamp(cov, 0.0, 1.0).mul(region).toVar();
  const ink = acc.div(max(cov, 1e-4));
  const straight = unpremult(srcCol);
  // No ring touched this fragment (or nothing was scanned) → the source, exactly.
  const out = mix(straight, ink, a);
  return premult(select(P.element(18).lessThan(0.5), straight, out), srcCol.a);
};

/* ── Portrait Window ──────────────────────────────────────────────────────── */

const objectWindow = ({ u, uvn, srcCol, helpers }) => {
  const k = objKit(u, helpers);
  const { P } = k;
  const lp = k.fxLocal(uvn).toVar();
  const res = k.fxRes();

  const target = P.element(0);
  const b = select(
    target.lessThan(0.5), k.faceBox(),
    select(target.lessThan(1.5), k.subjectBox(), vec4(0.0, 0.0, 1.0, 1.0)),
  ).toVar();
  const pad = P.element(1).div(100.0);
  const bo = vec2(b.x.sub(b.z.mul(pad).mul(0.5)), b.y.sub(b.w.mul(pad).mul(0.5))).toVar();
  const bs = max(vec2(b.z.mul(float(1.0).add(pad)), b.w.mul(float(1.0).add(pad))), vec2(0.01)).toVar();

  const q = lp.sub(bo).div(bs);
  const inside = q.x.greaterThan(0.0).and(q.x.lessThan(1.0))
    .and(q.y.greaterThan(0.0)).and(q.y.lessThan(1.0));

  const straight = unpremult(srcCol).toVar();
  const col = vec3(straight).toVar();

  const treat = P.element(3);
  const pitchPx = max(P.element(2).mul(res.y.div(1080.0)), 1.5);
  const cellUv = vec2(pitchPx).div(max(res, vec2(1.0))).toVar();

  If(inside, () => {
    If(treat.lessThan(0.5), () => {
      const cell = floor(lp.div(cellUv));
      const centre = cell.add(0.5).mul(cellUv);
      const l = clamp(k.lumAt(centre), 0.0, 1.0);
      const d = lp.sub(centre).div(cellUv);
      const rr = length(d).mul(2.0);
      const dotAmt = float(1.0).sub(smoothstep(sqrt(l).mul(0.98), sqrt(l).mul(1.12), rr));
      col.assign(mix(k.C(1), k.C(0), dotAmt));
    }).Else(() => {
      If(treat.lessThan(1.5), () => {
        const row = lp.y.div(cellUv.y);
        const l = clamp(k.lumAt(lp), 0.0, 1.0);
        const wob = sin(lp.x.mul(res.x).mul(0.25)).mul(float(1.0).sub(l)).mul(0.45);
        const dRow = abs(fract(row.add(wob)).sub(0.5)).mul(2.0);
        const line = float(1.0).sub(smoothstep(0.55, 0.95, dRow));
        col.assign(mix(k.C(1), k.C(0), line));
      });
      // treat >= 1.5 — Source: the window shows the picture untouched.
    });
  });

  const frameAmt = clamp(P.element(4).div(100.0), 0.0, 1.0).toVar();
  If(frameAmt.greaterThan(0.0), () => {
    const px = vec2(1.0).div(max(res, vec2(1.0))).toVar();
    const dEdge = min(abs(lp.sub(bo)), abs(lp.sub(bo.add(bs)))).toVar();
    const inRow = lp.y.greaterThan(bo.y.sub(px.y)).and(lp.y.lessThan(bo.y.add(bs.y).add(px.y)));
    const inCol = lp.x.greaterThan(bo.x.sub(px.x)).and(lp.x.lessThan(bo.x.add(bs.x).add(px.x)));
    const band = dEdge.x.lessThan(px.x.mul(1.4)).and(inRow)
      .or(dEdge.y.lessThan(px.y.mul(1.4)).and(inCol));
    const kk = min(bs.x, bs.y).mul(0.12);
    const nearCornerX = min(abs(lp.x.sub(bo.x)), abs(lp.x.sub(bo.x.add(bs.x)))).lessThan(kk);
    const nearCornerY = min(abs(lp.y.sub(bo.y)), abs(lp.y.sub(bo.y.add(bs.y)))).lessThan(kk);
    const bracket = dEdge.x.lessThan(px.x.mul(2.6)).and(nearCornerY)
      .or(dEdge.y.lessThan(px.y.mul(2.6)).and(nearCornerX))
      .and(inRow).and(inCol);
    If(band.or(bracket), () => { col.assign(mix(col, k.C(2), frameAmt)); });
  });

  return premult(col, srcCol.a);
};


/* ── Slit Scan ────────────────────────────────────────────────────────────── */

const objectSlitScan = ({ u, uvn, srcCol, helpers }) => {
  const k = objKit(u, helpers);
  const { P } = k;
  const lp = k.fxLocal(uvn).toVar();
  const res = k.fxRes();

  const vertical = P.element(0).lessThan(0.5);
  const n = max(floor(P.element(1).add(0.5)), 2.0).toVar();
  const a = select(vertical, lp.x, lp.y).toVar();
  const idx = floor(a.mul(n)).toVar();
  const mid = idx.add(0.5).div(n);
  const probe = select(vertical, vec2(mid, 0.5), vec2(0.5, mid)).toVar();

  const drive = P.element(3);
  const fSubject = k.fieldAt(probe).mul(2.0).sub(1.0);
  const fEdge = clamp(k.edgeAt(probe, float(2.0).div(max(res.y, 1.0))).mul(4.0), 0.0, 2.0).sub(1.0);
  const fWave = sin(idx.mul(0.35).add(u.uTime.mul(max(P.element(6), 0.0))));
  const fRand = hash21(vec2(idx.mul(0.013).add(P.element(7)), idx.mul(0.07))).mul(2.0).sub(1.0);
  const f = select(
    drive.lessThan(0.5), fSubject,
    select(drive.lessThan(1.5), fEdge, select(drive.lessThan(2.5), fWave, fRand)),
  ).toVar();

  const hold = float(1.0).sub(P.element(4).div(100.0).mul(clamp(k.fieldAt(probe), 0.0, 1.0)));
  const off = f.mul(P.element(2).div(100.0)).mul(hold).toVar();

  const sp = vec2(
    select(vertical, lp.x, fract(lp.x.add(off).add(2.0))),
    select(vertical, fract(lp.y.sub(off).add(2.0)), lp.y),
  ).toVar();
  const moved = k.sampleAt(sp);

  const gapUv = P.element(5).mul(res.y.div(1080.0)).div(max(select(vertical, res.x, res.y), 1.0));
  const inGap = step(float(1.0).sub(gapUv.mul(n)), fract(a.mul(n)));

  const region = k.regionAt(probe, P.element(8), P.element(9).div(100.0));
  const col = mix(unpremult(srcCol), unpremult(moved), region);
  return premult(col, srcCol.a.mul(float(1.0).sub(inGap.mul(region))));
};

/* ── Spectral Curtain ─────────────────────────────────────────────────────── */

const objectCurtain = ({ u, uvn, srcCol, helpers }) => {
  const k = objKit(u, helpers);
  const { P } = k;
  const lp = k.fxLocal(uvn).toVar();
  const res = k.fxRes();

  const bandPx = max(P.element(3), 0.5).mul(res.y.div(1080.0));
  const bandW = max(bandPx.div(max(res.x, 1.0)), 1e-4).toVar();
  const bi = floor(lp.x.div(bandW)).toVar();
  const centre = bi.add(0.5).mul(bandW).toVar();
  const density = clamp(P.element(1).div(400.0), 0.01, 1.0);

  const out = vec4(srcCol).toVar();
  If(hash21(vec2(bi, 7.3)).lessThanEqual(density), () => {
    const maxLen = clamp(P.element(2).div(100.0), 0.01, 1.0).toVar();
    const dirMode = P.element(4).toVar();
    const taps = select(u.uQuality.lessThan(0.75), float(24.0), float(48.0)).toVar();
    const thr = P.element(5).div(100.0).toVar();

    const hitT = float(-1.0).toVar();
    const hitE = float(0.0).toVar();
    const hitCol = vec3(0.0).toVar();

    // The two directional marches, unrolled in JS rather than looped: each is a
    // TSL Loop with its own Break, and nesting them would break the wrong one.
    for (const pass_ of [0, 1]) {
      const skip = pass_ === 0
        ? dirMode.greaterThan(0.5).and(dirMode.lessThan(1.5))   // Up only
        : dirMode.lessThan(0.5);                                // Down only
      If(skip.not(), () => {
        const sgn = pass_ === 0 ? float(1.0) : float(-1.0);
        const prev = k.lumAt(vec2(centre, lp.y)).toVar();
        Loop({ start: int(1), end: int(49) }, ({ i }) => {
          const fi = float(i);
          If(fi.greaterThan(taps), () => { Break(); });
          const t = fi.div(taps).mul(maxLen).toVar();
          const q = vec2(centre, lp.y.add(sgn.mul(t))).toVar();
          If(q.y.lessThan(0.0).or(q.y.greaterThan(1.0)), () => { Break(); });
          const l = k.lumAt(q).toVar();
          const e = abs(l.sub(prev)).mul(taps).mul(0.08).toVar();
          prev.assign(l);
          If(e.greaterThan(thr), () => {
            If(hitT.lessThan(0.0).or(t.lessThan(hitT)), () => {
              hitT.assign(t);
              hitE.assign(e);
              hitCol.assign(unpremult(k.sampleAt(q)));
            });
            Break();
          });
        });
      });
    }

    If(hitT.greaterThanEqual(0.0), () => {
      const straight = unpremult(srcCol);
      const band = select(P.element(6).greaterThan(0.5), k.C(0), hitCol);
      const fall = clamp(float(1.0).sub(hitT.div(maxLen)), 0.0, 1.0);
      const a = fall.mul(clamp(hitE, 0.0, 1.0))
        .mul(k.regionAt(vec2(centre, lp.y), P.element(7), P.element(8).div(100.0)));
      out.assign(premult(mix(straight, clamp(band, 0.0, 1.0), clamp(a, 0.0, 1.0)), srcCol.a));
    });
  });
  return out;
};

/* ── Grid System ──────────────────────────────────────────────────────────── */
/*
 * The rect is carried as four FLOAT vars rather than two vec2s: the descent
 * assigns to one axis at a time, and per-component assignment into a vec var is
 * the one place TSL and GLSL do not read alike.
 *
 * There is no early return in a node body either — a plain JS body returns one
 * node — so the GLSL's `return src` becomes an `alive` flag that gates the rest.
 */
const objectGrid = ({ u, uvn, srcCol, helpers }) => {
  const k = objKit(u, helpers);
  const { P } = k;
  const lp = k.fxLocal(uvn).toVar();
  const res = k.fxRes();
  const seed = P.element(8).toVar();
  const prog = P.element(0).toVar();
  const protect = clamp(P.element(2).div(100.0), 0.0, 1.0).toVar();
  const stopArea = float(1.0).div(max(P.element(1), 2.0)).toVar();

  const rox = float(0.0).toVar();
  const roy = float(0.0).toVar();
  const rsx = float(1.0).toVar();
  const rsy = float(1.0).toVar();
  const id = float(1.0).toVar();

  Loop({ start: int(0), end: int(12) }, () => {
    const c = vec2(rox.add(rsx.mul(0.5)), roy.add(rsy.mul(0.5)));
    const subj = k.fieldAt(c);
    If(rsx.mul(rsy).mul(float(1.0).sub(subj.mul(protect))).lessThanEqual(stopArea), () => { Break(); });
    If(rsx.lessThan(0.055).or(rsy.lessThan(0.035)), () => { Break(); });
    const h1 = hash21(vec2(id, seed));
    const h2 = hash21(vec2(id.mul(1.7).add(3.0), seed));
    const vertical = rsx.div(max(rsy, 1e-4)).greaterThan(float(0.75).add(h1.mul(0.8)));
    const t = float(0.3).add(h2.mul(0.4)).toVar();
    If(vertical, () => {
      If(lp.x.sub(rox).lessThan(rsx.mul(t)), () => {
        rsx.assign(rsx.mul(t));
        id.assign(id.mul(2.0));
      }).Else(() => {
        rox.addAssign(rsx.mul(t));
        rsx.assign(rsx.mul(float(1.0).sub(t)));
        id.assign(id.mul(2.0).add(1.0));
      });
    }).Else(() => {
      If(lp.y.sub(roy).lessThan(rsy.mul(t)), () => {
        rsy.assign(rsy.mul(t));
        id.assign(id.mul(2.0));
      }).Else(() => {
        roy.addAssign(rsy.mul(t));
        rsy.assign(rsy.mul(float(1.0).sub(t)));
        id.assign(id.mul(2.0).add(1.0));
      });
    });
  });

  const centre = vec2(rox.add(rsx.mul(0.5)), roy.add(rsy.mul(0.5))).toVar();
  const subj = k.fieldAt(centre).toVar();
  const region = k.regionAt(centre, P.element(9), P.element(10).div(100.0)).toVar();

  const gutPx = P.element(4).mul(res.y.div(1080.0));
  const gvx = gutPx.div(max(res.x, 1.0));
  const gvy = gutPx.div(max(res.y, 1.0));
  const iox = rox.add(gvx).toVar();
  const ioy = roy.add(gvy).toVar();
  const isx = max(rsx.sub(gvx.mul(2.0)), 0.002).toVar();
  const isy = max(rsy.sub(gvy.mul(2.0)), 0.002).toVar();
  const qx = lp.x.sub(iox).div(isx).toVar();
  const qy = lp.y.sub(ioy).div(isy).toVar();

  const alive = float(1.0).toVar();
  If(region.lessThanEqual(0.001), () => { alive.assign(0.0); });
  If(qx.lessThan(0.0).or(qx.greaterThan(1.0)).or(qy.lessThan(0.0)).or(qy.greaterThan(1.0)), () => {
    alive.assign(0.0);
  });
  If(prog.greaterThan(1.5).and(prog.lessThan(2.5))
    .and(hash21(vec2(id.mul(7.7), seed.add(5.0))).lessThan(0.3)), () => { alive.assign(0.0); });

  const col = vec3(unpremult(srcCol)).toVar();
  If(alive.greaterThan(0.5), () => {
    const open = float(0.0).toVar();
    If(hash21(vec2(id.mul(3.1), seed.add(11.0))).lessThan(P.element(5).div(100.0)), () => { open.assign(1.0); });
    If(prog.lessThan(0.5).and(subj.greaterThan(0.55))
      .and(hash21(vec2(id.mul(5.3), seed.add(2.0))).lessThan(0.85)), () => { open.assign(1.0); });

    const fill = P.element(3).div(100.0).toVar();
    If(open.lessThan(0.5).and(fill.greaterThan(0.0)), () => {
      const roll = hash21(vec2(id.mul(11.0), seed.add(23.0))).toVar();
      const tone = select(roll.lessThan(0.12), k.C(1), select(roll.lessThan(0.3), k.C(2), k.C(0)));
      const a = select(
        roll.lessThan(0.12), float(0.16),
        select(roll.lessThan(0.3), float(0.5), select(roll.lessThan(0.42), float(0.2), float(0.3))),
      ).mul(fill).mul(mix(1.0, 0.45, subj.mul(protect))).toVar();
      If(prog.greaterThan(2.5), () => {
        a.mulAssign(float(0.7).add(sin(u.uTime.mul(3.1).add(id)).mul(0.5).add(0.5).mul(0.45)));
      });
      col.assign(mix(col, tone, clamp(a, 0.0, 1.0).mul(region)));
    });

    const pxx = qx.mul(isx).mul(res.x).toVar();
    const pxy = qy.mul(isy).mul(res.y).toVar();
    const wModule = isx.mul(res.x).toVar();
    const hModule = isy.mul(res.y).toVar();
    const edge = min(min(pxx, pxy), min(wModule.sub(pxx), hModule.sub(pxy)));
    const wpx = P.element(6).mul(res.y.div(1080.0)).toVar();
    If(wpx.greaterThan(0.0).and(edge.lessThan(wpx)), () => {
      col.assign(mix(col, select(open.greaterThan(0.5), k.C(0), k.C(1)),
        select(open.greaterThan(0.5), float(0.28), float(0.22)).mul(region)));
    });

    If(prog.greaterThan(0.5).and(prog.lessThan(1.5)), () => {
      const kk = min(wModule, hModule).mul(0.16);
      const tickH = abs(pxy.sub(hModule.mul(0.5))).lessThan(max(wpx, 0.75))
        .and(pxx.lessThan(kk).or(pxx.greaterThan(wModule.sub(kk))));
      const tickV = abs(pxx.sub(wModule.mul(0.5))).lessThan(max(wpx, 0.75)).and(pxy.lessThan(kk));
      If(tickH.or(tickV), () => { col.assign(mix(col, k.C(0), region.mul(0.5))); });
    });
    If(prog.greaterThan(2.5).and(open.lessThan(0.5)), () => {
      const barW = wModule.sub(12.0).mul(float(0.2).add(float(1.0).sub(subj).mul(0.75)));
      If(pxy.greaterThan(hModule.sub(9.0)).and(pxy.lessThan(hModule.sub(6.0)))
        .and(pxx.greaterThan(6.0)).and(pxx.lessThan(barW.add(6.0))), () => {
        col.assign(mix(col, k.C(1), region.mul(0.35)));
      });
    });

    If(P.element(7).greaterThan(0.0).and(wModule.greaterThan(46.0)).and(hModule.greaterThan(22.0))
      .and(hash21(vec2(id.mul(13.0), seed.add(31.0))).lessThan(P.element(7).div(100.0))), () => {
      If(pxy.greaterThan(5.0).and(pxy.lessThan(11.0)).and(pxx.greaterThan(6.0)).and(pxx.lessThan(60.0)), () => {
        const slot = floor(pxx.sub(6.0).div(3.0));
        If(hash21(vec2(slot.add(id.mul(17.0)), seed.add(7.0))).greaterThan(0.45), () => {
          col.assign(mix(col, k.C(1), region.mul(0.55)));
        });
      });
    });
  });

  return premult(col, srcCol.a);
};

/* ── Contour Studio ───────────────────────────────────────────────────────── */

const objectContour = ({ u, uvn, srcCol, helpers }) => {
  const k = objKit(u, helpers);
  const { P } = k;
  const lp = k.fxLocal(uvn).toVar();
  const res = k.fxRes();

  const smoothR = mix(3.5, 0.0, clamp(P.element(2).div(100.0), 0.0, 1.0))
    .div(max(res.y, 1.0)).mul(3.0).toVar();
  const smoothLum = (p) => {
    const r = smoothR;
    return k.lumAt(p)
      .add(k.lumAt(p.add(vec2(r, 0.0))))
      .add(k.lumAt(p.sub(vec2(r, 0.0))))
      .add(k.lumAt(p.add(vec2(0.0, r))))
      .add(k.lumAt(p.sub(vec2(0.0, r))))
      .add(k.lumAt(p.add(vec2(r, r).mul(0.7071))))
      .add(k.lumAt(p.sub(vec2(r, r).mul(0.7071))))
      .add(k.lumAt(p.add(vec2(r, r.negate()).mul(0.7071))))
      .add(k.lumAt(p.add(vec2(r.negate(), r).mul(0.7071))))
      .div(9.0);
  };

  const f = smoothLum(lp).toVar();
  const texel = float(1.5).div(max(res.y, 1.0)).toVar();
  const gx = smoothLum(lp.add(vec2(texel, 0.0))).sub(smoothLum(lp.sub(vec2(texel, 0.0))));
  const gy = smoothLum(lp.add(vec2(0.0, texel))).sub(smoothLum(lp.sub(vec2(0.0, texel))));
  const grad = vec2(gx, gy).div(texel.mul(2.0)).toVar();
  const gl = max(length(grad), 1e-3).toVar();

  const halfW = max(P.element(3), 0.05).mul(0.5).div(max(res.y, 1.0)).toVar();
  const bias = clamp(P.element(6).div(100.0), 0.0, 1.0);
  const w = mix(1.0, clamp(k.fieldAt(lp), 0.0, 1.0), bias).toVar();
  const region = k.regionAt(lp, P.element(7), P.element(8).div(100.0)).toVar();

  const acc = vec3(0.0).toVar();
  const cov = float(0.0).toVar();

  If(P.element(0).lessThan(0.5), () => {
    const lv = max(floor(P.element(1).add(0.5)), 2.0).toVar();
    Loop({ start: int(1), end: int(40) }, ({ i }) => {
      const fk = float(i).toVar();
      If(fk.greaterThanEqual(lv), () => { Break(); });
      const level = fk.div(lv);
      const d = abs(f.sub(level)).div(gl);
      const line = float(1.0).sub(smoothstep(halfW.mul(0.6), halfW.mul(1.4), d)).toVar();
      If(line.greaterThan(0.0), () => {
        const a = line.mul(float(0.28).add(fk.div(lv).mul(0.5)));
        acc.addAssign(select(mod(fk, 2.0).lessThan(0.5), k.C(0), k.C(1)).mul(a));
        cov.addAssign(a);
      });
    });
  }).Else(() => {
    const tangent = normalize(vec2(grad.y.negate(), grad.x).add(vec2(1e-5)));
    const freq = max(P.element(4), 4.0);
    const phase = dot(lp.mul(vec2(k.fxAspect(), 1.0)), tangent).mul(freq)
      .add(sin(u.uTime.mul(0.9)).mul(P.element(5)).mul(0.02));
    const stripe = abs(fract(phase).sub(0.5)).mul(2.0);
    const line = float(1.0).sub(smoothstep(0.45, 0.95, stripe));
    const strength = clamp(gl.mul(0.35), 0.0, 1.0);
    const a = line.mul(strength);
    acc.addAssign(k.C(0).mul(a));
    cov.addAssign(a);
  });

  const straight = unpremult(srcCol);
  const ink = acc.div(max(cov, 1e-4));
  const a = clamp(cov, 0.0, 1.0).mul(w).mul(region);
  return premult(mix(straight, ink, a), srcCol.a);
};

/* ── The geometry plate composite ─────────────────────────────────────────── */
/*
 * ONE body, registered under all six geometry ids. What distinguishes those
 * programs happens on the CPU (objectPlate.js); the shader's whole job is to lay
 * the plate over the layer, so six copies of this would be six places for the
 * composite rule to drift apart.
 */
const objectPlateComposite = ({ u, uvn, srcCol, helpers }) => {
  const k = objKit(u, helpers);
  const { P } = k;
  const lp = k.fxLocal(uvn).toVar();
  const out = vec4(srcCol).toVar();
  If(P.element(16).greaterThanEqual(0.5), () => {
    const inside = lp.x.greaterThanEqual(0.0).and(lp.x.lessThanEqual(1.0))
      .and(lp.y.greaterThanEqual(0.0)).and(lp.y.lessThanEqual(1.0));
    If(inside, () => {
      const plate = u.uTexture2.sample(vec2(lp.x, float(1.0).sub(lp.y))).toVar();
      const pa = clamp(plate.a.mul(P.element(17).div(100.0)), 0.0, 1.0).toVar();
      If(pa.greaterThan(0.0), () => {
        out.assign(premult(mix(unpremult(srcCol), plate.rgb, pa), srcCol.a));
      });
    });
  });
  return out;
};

export const OBJECT_EFFECT_BODIES = {
  objectDither,
  objectIsolines,
  objectWindow,
  objectSlitScan,
  objectCurtain,
  objectGrid,
  objectContour,
  // The geometry family — one composite, six ids.
  objectNodes: objectPlateComposite,
  objectLinks: objectPlateComposite,
  objectFacets: objectPlateComposite,
  objectMeasure: objectPlateComposite,
};
